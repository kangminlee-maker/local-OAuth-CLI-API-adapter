import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { CodexBackendTransport } from '../dist/proxy/codex-backend-transport.js';
import { startLocalApiProxy } from '../dist/proxy/http-server.js';

// The tool-call index invariant is established in the backend but CONSUMED by
// the HTTP server, which pairs streamed deltas with the completed result and
// re-emits whatever it believes was not sent. That re-emission is what reached
// clients as duplicated arguments, and it happens on all three surfaces —
// including `/v1/messages`, which no benchmark row exercises against a Codex
// backend. These tests assert at the layer the client actually reads.

const realFetch = globalThis.fetch;
after(() => { globalThis.fetch = realFetch; });

const b64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

async function createCodexHome() {
  const dir = await mkdtemp(join(tmpdir(), 'tool-stream-surface-'));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'auth.json'), JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: {
      id_token: `${b64url({ alg: 'none' })}.${b64url({ 'https://api.openai.com/auth': { chatgpt_account_id: 'a1' } })}.s`,
      access_token: 't',
      refresh_token: 'r',
      account_id: 'a1',
    },
    last_refresh: new Date().toISOString(),
  }));
  return dir;
}

const sse = (events) => events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');

/** Captured shape: a reasoning item takes output_index 0, so the call sits at 1. */
function terraToolEvents(finalOutput) {
  return [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_1' } },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id: 'rs_1' } },
    { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather' } },
    { type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'fc_1', delta: '{"city":' },
    { type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'fc_1', delta: '"Seoul"}' },
    { type: 'response.function_call_arguments.done', output_index: 1, item_id: 'fc_1' },
    { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"Seoul"}' } },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.6-terra', output: finalOutput } },
  ];
}

const WEATHER_PARAMETERS = {
  type: 'object',
  properties: { city: { type: 'string' } },
  required: ['city'],
  additionalProperties: false,
};

function sseEvents(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try { out.push(JSON.parse(payload)); } catch { /* non-JSON data line */ }
  }
  return out;
}

async function withProxy(events, run) {
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse(events), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });
  const server = await startLocalApiProxy({ backend, host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000 });
  try {
    await run(server.url);
  } finally {
    await server.close();
    await backend.close();
    globalThis.fetch = realFetch;
  }
}

const FINAL_OUTPUTS = [
  ['no function_call in the completed output', []],
  // The reasoning item makes the completed array's positions disagree with the
  // stream's dense tool positions, which is the case positional alignment gets
  // wrong; without it the two coincide at 0 and the check proves nothing.
  ['an id-less function_call after a reasoning item in the completed output', [
    { type: 'reasoning', id: 'rs_1' },
    { type: 'function_call', name: 'get_weather', arguments: '{"city":"Seoul"}' },
  ]],
];

for (const [label, finalOutput] of FINAL_OUTPUTS) {
  test(`chat stream sends each tool argument once with ${label}`, async () => {
    await withProxy(terraToolEvents(finalOutput), async (url) => {
      const res = await realFetch(`${url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer local' },
        body: JSON.stringify({
          model: 'gpt-5.6-terra',
          stream: true,
          messages: [{ role: 'user', content: 'w' }],
          tools: [{ type: 'function', function: { name: 'get_weather', description: 'w', parameters: WEATHER_PARAMETERS, strict: true } }],
          tool_choice: 'required',
        }),
      });
      const perIndex = new Map();
      for (const chunk of sseEvents(await res.text())) {
        for (const call of chunk.choices?.[0]?.delta?.tool_calls ?? []) {
          if (typeof call.function?.arguments === 'string') {
            perIndex.set(call.index, `${perIndex.get(call.index) ?? ''}${call.function.arguments}`);
          }
        }
      }
      assert.deepEqual([...perIndex.values()], ['{"city":"Seoul"}']);
    });
  });

  test(`responses stream sends each tool argument once with ${label}`, async () => {
    await withProxy(terraToolEvents(finalOutput), async (url) => {
      const res = await realFetch(`${url}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer local' },
        body: JSON.stringify({
          model: 'gpt-5.6-terra',
          stream: true,
          input: 'w',
          tools: [{ type: 'function', name: 'get_weather', description: 'w', parameters: WEATHER_PARAMETERS, strict: true }],
          tool_choice: 'required',
        }),
      });
      const perItem = new Map();
      for (const event of sseEvents(await res.text())) {
        if (event.type === 'response.function_call_arguments.delta' && typeof event.delta === 'string') {
          const key = event.item_id ?? event.output_index ?? 0;
          perItem.set(key, `${perItem.get(key) ?? ''}${event.delta}`);
        }
      }
      assert.deepEqual([...perItem.values()], ['{"city":"Seoul"}']);
    });
  });

  test(`messages stream sends each tool input once with ${label}`, async () => {
    await withProxy(terraToolEvents(finalOutput), async (url) => {
      const res = await realFetch(`${url}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'local', 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'gpt-5.6-terra',
          stream: true,
          max_tokens: 128,
          messages: [{ role: 'user', content: 'w' }],
          tools: [{ name: 'get_weather', description: 'w', input_schema: WEATHER_PARAMETERS }],
          tool_choice: { type: 'any' },
        }),
      });
      const perBlock = new Map();
      for (const event of sseEvents(await res.text())) {
        if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') {
          perBlock.set(event.index, `${perBlock.get(event.index) ?? ''}${event.delta.partial_json ?? ''}`);
        }
      }
      assert.deepEqual([...perBlock.values()], ['{"city":"Seoul"}']);
    });
  });

  test(`non-streaming chat reports one tool call with ${label}`, async () => {
    await withProxy(terraToolEvents(finalOutput), async (url) => {
      const res = await realFetch(`${url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer local' },
        body: JSON.stringify({
          model: 'gpt-5.6-terra',
          messages: [{ role: 'user', content: 'w' }],
          tools: [{ type: 'function', function: { name: 'get_weather', description: 'w', parameters: WEATHER_PARAMETERS, strict: true } }],
          tool_choice: 'required',
        }),
      });
      const body = await res.json();
      const calls = (body.choices?.[0]?.message?.tool_calls ?? []).map((call) => call.function?.arguments);
      assert.deepEqual(calls, ['{"city":"Seoul"}']);
    });
  });
}

/**
 * Every surface's view of one turn's tool calls, so a scenario can assert that
 * the stream and the completed body say the same thing rather than checking one
 * surface and hoping.
 */
async function toolSurfaces(events) {
  const surfaces = {};
  await withProxy(events, async (url) => {
    const chatStream = await realFetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer local' },
      body: JSON.stringify({
        model: 'gpt-5.5',
        stream: true,
        messages: [{ role: 'user', content: 'w' }],
        tools: [{ type: 'function', function: { name: 'get_weather', description: 'w', parameters: WEATHER_PARAMETERS, strict: true } }],
      }),
    });
    const chatCalls = new Map();
    for (const chunk of sseEvents(await chatStream.text())) {
      for (const call of chunk.choices?.[0]?.delta?.tool_calls ?? []) {
        const seen = chatCalls.get(call.index) ?? { name: undefined, arguments: '' };
        chatCalls.set(call.index, {
          name: call.function?.name ?? seen.name,
          arguments: `${seen.arguments}${call.function?.arguments ?? ''}`,
        });
      }
    }
    surfaces.chatStream = [...chatCalls.values()];

    const responsesStream = await realFetch(`${url}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer local' },
      body: JSON.stringify({
        model: 'gpt-5.5',
        stream: true,
        input: 'w',
        tools: [{ type: 'function', name: 'get_weather', description: 'w', parameters: WEATHER_PARAMETERS, strict: true }],
      }),
    });
    const responseCalls = new Map();
    const announcedTypes = new Map();
    let completedOutput = [];
    for (const event of sseEvents(await responsesStream.text())) {
      if (event.type === 'response.output_item.added') {
        announcedTypes.set(event.output_index, event.item?.type);
        if (event.item?.type === 'function_call') {
          responseCalls.set(event.item_id ?? event.item?.id, { name: event.item?.name, arguments: '' });
        }
      }
      if (event.type === 'response.function_call_arguments.delta' && typeof event.delta === 'string') {
        const seen = responseCalls.get(event.item_id) ?? { name: undefined, arguments: '' };
        responseCalls.set(event.item_id, { name: seen.name, arguments: `${seen.arguments}${event.delta}` });
      }
      if (event.type === 'response.completed') completedOutput = event.response?.output ?? [];
    }
    surfaces.responsesStream = [...responseCalls.values()];
    surfaces.responsesAnnouncedTypes = announcedTypes;
    surfaces.responsesStreamCompletedTypes = completedOutput.map((item) => item.type);

    const messagesStream = await realFetch(`${url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'local', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'gpt-5.5',
        stream: true,
        max_tokens: 128,
        messages: [{ role: 'user', content: 'w' }],
        tools: [{ name: 'get_weather', description: 'w', input_schema: WEATHER_PARAMETERS }],
      }),
    });
    const blocks = new Map();
    for (const event of sseEvents(await messagesStream.text())) {
      if (event.type === 'content_block_start') {
        blocks.set(event.index, { type: event.content_block?.type, name: event.content_block?.name, json: '' });
      }
      if (event.type === 'content_block_delta') {
        const block = blocks.get(event.index);
        if (block) block.json += event.delta?.partial_json ?? event.delta?.text ?? '';
      }
    }
    surfaces.messagesStreamBlocks = [...blocks.entries()].sort(([a], [b]) => a - b).map(([, block]) => block);

    const chatFinal = await (await realFetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer local' },
      body: JSON.stringify({
        model: 'gpt-5.5',
        messages: [{ role: 'user', content: 'w' }],
        tools: [{ type: 'function', function: { name: 'get_weather', description: 'w', parameters: WEATHER_PARAMETERS, strict: true } }],
      }),
    })).json();
    surfaces.chatFinal = (chatFinal.choices?.[0]?.message?.tool_calls ?? [])
      .map((call) => ({ name: call.function?.name, arguments: call.function?.arguments }));

    const responsesFinal = await (await realFetch(`${url}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer local' },
      body: JSON.stringify({
        model: 'gpt-5.5',
        input: 'w',
        tools: [{ type: 'function', name: 'get_weather', description: 'w', parameters: WEATHER_PARAMETERS, strict: true }],
      }),
    })).json();
    surfaces.responsesFinalTypes = (responsesFinal.output ?? []).map((item) => item.type);

    const messagesFinal = await (await realFetch(`${url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'local', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'gpt-5.5',
        max_tokens: 128,
        messages: [{ role: 'user', content: 'w' }],
        tools: [{ name: 'get_weather', description: 'w', input_schema: WEATHER_PARAMETERS }],
      }),
    })).json();
    surfaces.messagesFinalBlocks = (messagesFinal.content ?? []).map((block) => ({
      type: block.type,
      name: block.name,
      input: block.input,
    }));
  });
  return surfaces;
}

/**
 * Captured shape: argument deltas can arrive BEFORE the item that names the
 * call. The transport holds them until the call has a `call_id` worth
 * announcing — the client cannot rename a call it was already told about.
 */
function earlyArgumentEvents({ anonymousPrefix }) {
  return [
    {
      type: 'response.function_call_arguments.delta',
      output_index: 0,
      ...(anonymousPrefix ? {} : { item_id: 'fc_1' }),
      delta: '{"city":',
    },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: '"Seoul"}' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"Seoul"}' } },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [] } },
  ];
}

test('arguments held until the call is named still reach the client', async () => {
  // The held prefix was never flushed when `output_item.added` announced the
  // call, so the client assembled `"Seoul"}` — a fragment it cannot parse — and
  // the completed body disagreed with the stream it had just sent.
  const surfaces = await toolSurfaces(earlyArgumentEvents({ anonymousPrefix: false }));
  assert.deepEqual(surfaces.chatStream, [{ name: 'get_weather', arguments: '{"city":"Seoul"}' }]);
  assert.deepEqual(surfaces.responsesStream, [{ name: 'get_weather', arguments: '{"city":"Seoul"}' }]);
  assert.deepEqual(surfaces.messagesStreamBlocks, [{ type: 'tool_use', name: 'get_weather', json: '{"city":"Seoul"}' }]);
  assert.deepEqual(surfaces.chatFinal, [{ name: 'get_weather', arguments: '{"city":"Seoul"}' }]);
  assert.deepEqual(surfaces.messagesFinalBlocks, [{ type: 'tool_use', name: 'get_weather', input: { city: 'Seoul' } }]);
});

test('an id-less early argument delta does not become a second tool call', async () => {
  // Anonymous deltas are correlated by output position. Splitting them onto
  // their own ordinal invented a call named `tool` that the model never made,
  // and the client would execute it.
  const surfaces = await toolSurfaces(earlyArgumentEvents({ anonymousPrefix: true }));
  assert.deepEqual(surfaces.chatFinal, [{ name: 'get_weather', arguments: '{"city":"Seoul"}' }]);
  assert.deepEqual(surfaces.chatStream, [{ name: 'get_weather', arguments: '{"city":"Seoul"}' }]);
  assert.deepEqual(surfaces.messagesFinalBlocks, [{ type: 'tool_use', name: 'get_weather', input: { city: 'Seoul' } }]);
});

test('a truncated streamed prefix is repaired by the completed item', async () => {
  // The stream stopped mid-argument and the completed output names no id, so
  // position is the only correlation. Refusing it left the client with
  // `{"city":` — unparseable, and surfaced as `{"input":"<partial>"}`.
  const surfaces = await toolSurfaces([
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: '{"city":' },
    {
      type: 'response.completed',
      response: {
        id: 'r',
        model: 'gpt-5.5',
        output: [{ type: 'function_call', name: 'get_weather', arguments: '{"city":"Seoul"}' }],
      },
    },
  ]);
  assert.deepEqual(surfaces.chatFinal, [{ name: 'get_weather', arguments: '{"city":"Seoul"}' }]);
  assert.deepEqual(surfaces.messagesFinalBlocks, [{ type: 'tool_use', name: 'get_weather', input: { city: 'Seoul' } }]);
  assert.deepEqual(surfaces.chatStream, [{ name: 'get_weather', arguments: '{"city":"Seoul"}' }]);
});

test('the completed output array agrees with the indices its items were announced at', async () => {
  // `output_index` is allocated in emission order, but the completed array was
  // assembled in a fixed one: with the call ahead of the narration, position 0
  // named the function_call on the wire and the reasoning item in the summary.
  const surfaces = await toolSurfaces(callThenNarrateEvents());
  const announced = [...surfaces.responsesAnnouncedTypes.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, type]) => type);
  assert.deepEqual(surfaces.responsesStreamCompletedTypes, announced);
});

test('messages blocks come in the same order streamed and not', async () => {
  // Same turn, two surfaces: the stream opened tool_use first because that is
  // when the call arrived, while the non-streaming body always put text first.
  const surfaces = await toolSurfaces(callThenNarrateEvents());
  assert.deepEqual(
    surfaces.messagesFinalBlocks.map((block) => block.type),
    surfaces.messagesStreamBlocks.map((block) => block.type),
  );
  assert.deepEqual(surfaces.responsesFinalTypes, surfaces.responsesStreamCompletedTypes);
});

// A turn that narrates and then calls a tool exercises the wire positions:
// output items and content blocks are addressed by index, and two items at the
// same index make an SDK accumulator overwrite one with the other.
function narrateThenCallEvents() {
  return [
    { type: 'response.output_text.delta', delta: 'Let me check the weather. ' },
    { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather' } },
    { type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'fc_1', delta: '{"city":"Seoul"}' },
    { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"Seoul"}' } },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [] } },
  ];
}

function callThenNarrateEvents() {
  return [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: '{"city":"Seoul"}' },
    { type: 'response.output_text.delta', delta: 'Checking now.' },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [] } },
  ];
}

test('responses stream gives every output item its own index', async () => {
  await withProxy(narrateThenCallEvents(), async (url) => {
    const res = await realFetch(`${url}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer local' },
      body: JSON.stringify({
        model: 'gpt-5.5',
        stream: true,
        input: 'w',
        tools: [{ type: 'function', name: 'get_weather', description: 'w', parameters: WEATHER_PARAMETERS, strict: true }],
      }),
    });
    const itemsByIndex = new Map();
    for (const event of sseEvents(await res.text())) {
      if (event.type !== 'response.output_item.added') continue;
      const seen = itemsByIndex.get(event.output_index);
      assert.ok(
        seen === undefined || seen === event.item?.type,
        `output_index ${event.output_index} used by both ${seen} and ${event.item?.type}`,
      );
      itemsByIndex.set(event.output_index, event.item?.type);
    }
    assert.deepEqual([...itemsByIndex.values()].sort(), ['function_call', 'message', 'reasoning']);
  });
});

test('messages stream opens each content block once and stops only what it opened', async () => {
  await withProxy(callThenNarrateEvents(), async (url) => {
    const res = await realFetch(`${url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'local', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'gpt-5.5',
        stream: true,
        max_tokens: 128,
        messages: [{ role: 'user', content: 'w' }],
        tools: [{ name: 'get_weather', description: 'w', input_schema: WEATHER_PARAMETERS }],
      }),
    });
    const opened = new Set();
    const stopped = [];
    for (const event of sseEvents(await res.text())) {
      if (event.type === 'content_block_start') {
        assert.ok(!opened.has(event.index), `content block ${event.index} started twice`);
        opened.add(event.index);
      }
      if (event.type === 'content_block_delta') {
        assert.ok(opened.has(event.index), `delta for unopened content block ${event.index}`);
      }
      if (event.type === 'content_block_stop') {
        assert.ok(opened.has(event.index), `stop for unopened content block ${event.index}`);
        stopped.push(event.index);
      }
    }
    assert.deepEqual([...opened].sort(), [0, 1]);
    assert.deepEqual(stopped.sort(), [0, 1]);
  });
});

test('narration accompanying a tool call survives on every surface', async () => {
  await withProxy(narrateThenCallEvents(), async (url) => {
    const chat = await (await realFetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer local' },
      body: JSON.stringify({
        model: 'gpt-5.5',
        messages: [{ role: 'user', content: 'w' }],
        tools: [{ type: 'function', function: { name: 'get_weather', description: 'w', parameters: WEATHER_PARAMETERS, strict: true } }],
      }),
    })).json();
    assert.match(chat.choices[0].message.content ?? '', /Let me check the weather/);
    assert.equal(chat.choices[0].message.tool_calls.length, 1);

    const messages = await (await realFetch(`${url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'local', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'gpt-5.5',
        max_tokens: 128,
        messages: [{ role: 'user', content: 'w' }],
        tools: [{ name: 'get_weather', description: 'w', input_schema: WEATHER_PARAMETERS }],
      }),
    })).json();
    assert.deepEqual(messages.content.map((block) => block.type), ['text', 'tool_use']);
  });
});
