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

test('a call held until after the narration is reported after it', async () => {
  // The order the client saw is the order it was TOLD, not the order the
  // backend opened state for. Held arguments arrive before any text, but they
  // are not announced until the call is named — by which time the narration has
  // already streamed — so a body claiming the tool came first contradicts the
  // stream that carried the same turn.
  const surfaces = await toolSurfaces([
    { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"city":' },
    { type: 'response.output_text.delta', delta: 'Let me check the weather. ' },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: '"Seoul"}' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"Seoul"}' } },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [] } },
  ]);
  assert.deepEqual(surfaces.messagesStreamBlocks.map((block) => block.type), ['text', 'tool_use']);
  assert.deepEqual(
    surfaces.messagesFinalBlocks.map((block) => block.type),
    surfaces.messagesStreamBlocks.map((block) => block.type),
  );
  assert.deepEqual(surfaces.responsesFinalTypes, surfaces.responsesStreamCompletedTypes);
});

test('an item that names nothing does not block the call that names its position', async () => {
  // `output_item.added` can open a function_call with neither id nor call_id.
  // Such an item holds the position on nothing but the position — like an
  // id-less delta — so the item that finally names the call owns it. Treating
  // it as a named holder minted a second ordinal: the phantom call again.
  const surfaces = await toolSurfaces([
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"city":' },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: '"Seoul"}' },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [] } },
  ]);
  assert.deepEqual(surfaces.chatFinal, [{ name: 'get_weather', arguments: '{"city":"Seoul"}' }]);
  assert.deepEqual(surfaces.chatStream, [{ name: 'get_weather', arguments: '{"city":"Seoul"}' }]);
});

test('a re-announcement without a call_id does not un-name an announced call', async () => {
  // `identified` is a latch: once the backend has supplied the `call_id` the
  // client echoes back, a later item that omits it cannot take the name away.
  // Assigning instead of latching stranded every following delta in the buffer,
  // because only an announced call is ever flushed.
  const surfaces = await toolSurfaces([
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: '{"city":' },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', name: 'get_weather' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: '"Seoul"}' },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [] } },
  ]);
  assert.deepEqual(surfaces.chatStream, [{ name: 'get_weather', arguments: '{"city":"Seoul"}' }]);
  assert.deepEqual(surfaces.chatFinal, [{ name: 'get_weather', arguments: '{"city":"Seoul"}' }]);
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
    { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_1' } },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id: 'rs_1' } },
    { type: 'response.output_text.delta', delta: 'Let me check the weather. ' },
    { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather' } },
    { type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'fc_1', delta: '{"city":"Seoul"}' },
    { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"Seoul"}' } },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [] } },
  ];
}

function callThenNarrateEvents() {
  return [
    // The reasoning item holds output_index 0, so the call takes 1 — a
    // preceding item shifts the backend's positions, and a fixture that gives
    // two items the same one exercises a wire the backend never produces.
    { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_1' } },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id: 'rs_1' } },
    { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather' } },
    { type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'fc_1', delta: '{"city":"Seoul"}' },
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
    assert.equal(itemsByIndex.get(0), 'reasoning', 'the reasoning item is announced first');
  });
});

/** A turn the model answered without reasoning: the backend opens no such item. */
function noReasoningEvents() {
  return [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: '{"city":"Seoul"}' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"Seoul"}' } },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [] } },
  ];
}

async function responsesSurfaces(url) {
  const stream = await realFetch(`${url}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer local' },
    body: JSON.stringify({
      model: 'gpt-5.5',
      stream: true,
      input: 'w',
      tools: [{ type: 'function', name: 'get_weather', description: 'w', parameters: WEATHER_PARAMETERS, strict: true }],
    }),
  });
  const announced = [];
  let streamCompleted = null;
  for (const event of sseEvents(await stream.text())) {
    if (event.type === 'response.output_item.added') announced.push({ index: event.output_index, type: event.item?.type, id: event.item?.id });
    if (event.type === 'response.completed') streamCompleted = event.response?.output ?? [];
  }
  const body = await (await realFetch(`${url}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer local' },
    body: JSON.stringify({
      model: 'gpt-5.5',
      input: 'w',
      tools: [{ type: 'function', name: 'get_weather', description: 'w', parameters: WEATHER_PARAMETERS, strict: true }],
    }),
  })).json();
  return { announced, streamCompleted, body };
}

test('the reasoning item leads the output, even when the tool call came first', async () => {
  // The proxy used to synthesize this item at the first TEXT delta, which put
  // it after a call the backend had put it before — and the direct API places
  // it first on every turn that reasons (measured 2026-08-26, gpt-5.5).
  await withProxy(callThenNarrateEvents(), async (url) => {
    const { announced, streamCompleted, body } = await responsesSurfaces(url);
    assert.deepEqual(announced.map((item) => item.type), ['reasoning', 'function_call', 'message']);
    assert.deepEqual(streamCompleted.map((item) => item.type), ['reasoning', 'function_call', 'message']);
    assert.deepEqual(body.output.map((item) => item.type), ['reasoning', 'function_call', 'message']);
  });
});

test('the reasoning item carries the id the backend gave it', async () => {
  // A minted `rs_...` names an item the runtime never produced, and a client
  // feeding `output` back as input echoes it.
  await withProxy(callThenNarrateEvents(), async (url) => {
    const { announced, body } = await responsesSurfaces(url);
    assert.equal(announced[0].id, 'rs_1');
    assert.equal(body.output[0].id, 'rs_1');
  });
});

test('a turn the backend never reasoned on reports no reasoning item', async () => {
  // The direct API omits the item entirely when `reasoning_tokens` is 0; it
  // does not send an empty one, and neither may a proxy that reports what its
  // runtime produced.
  await withProxy(noReasoningEvents(), async (url) => {
    const { announced, streamCompleted, body } = await responsesSurfaces(url);
    assert.deepEqual(announced.map((item) => item.type), ['function_call']);
    assert.deepEqual(streamCompleted.map((item) => item.type), ['function_call']);
    assert.deepEqual(body.output.map((item) => item.type), ['function_call']);
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

/** Narrate, call a tool, then narrate again — the model resuming after a call. */
function narrateCallNarrateEvents() {
  return [
    { type: 'response.output_text.delta', delta: 'Let me check. ' },
    { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather' } },
    { type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'fc_1', delta: '{"city":"Seoul"}' },
    { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"Seoul"}' } },
    { type: 'response.output_text.delta', delta: 'One moment.' },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [] } },
  ];
}

test('text resuming after a tool call opens a new block, never a stopped one', async () => {
  // A tool call stops the open text block, because two content blocks are never
  // open at once on this wire. The narration that follows is therefore a NEW
  // block — writing it to the stopped index left an SDK accumulator dropping
  // the text or throwing, since it had already finalized that block.
  await withProxy(narrateCallNarrateEvents(), async (url) => {
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
    const state = new Map();
    const order = [];
    let text = '';
    for (const event of sseEvents(await res.text())) {
      if (event.type === 'content_block_start') {
        assert.equal(state.get(event.index), undefined, `content block ${event.index} started twice`);
        state.set(event.index, 'open');
        order.push(event.content_block?.type);
      }
      if (event.type === 'content_block_delta') {
        assert.equal(state.get(event.index), 'open', `delta written to a ${state.get(event.index) ?? 'never opened'} content block ${event.index}`);
        text += event.delta?.text ?? '';
      }
      if (event.type === 'content_block_stop') {
        assert.equal(state.get(event.index), 'open', `stop for a ${state.get(event.index) ?? 'never opened'} content block ${event.index}`);
        state.set(event.index, 'stopped');
      }
    }
    assert.deepEqual(order, ['text', 'tool_use', 'text']);
    assert.equal(text, 'Let me check. One moment.');
    assert.deepEqual([...state.values()], ['stopped', 'stopped', 'stopped'], 'every block must be closed');
  });
});

/**
 * A call before any narration, finished the way the backend really finishes an
 * item. The sibling fixture above stops at the arguments, which is the OTHER
 * case — a call the backend never closes — and it is covered on its own below.
 */
function callThenNarrateFinishedEvents() {
  return [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: '{"city":"Seoul"}' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"Seoul"}' } },
    { type: 'response.output_text.delta', delta: 'Checking now.' },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [] } },
  ];
}

/** Two calls in a row, each finished by the backend before the next opens. */
function twoCallsEvents() {
  return [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: '{"city":"Seoul"}' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"Seoul"}' } },
    { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'get_weather' } },
    { type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'fc_2', delta: '{"city":"Busan"}' },
    { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'get_weather', arguments: '{"city":"Busan"}' } },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [] } },
  ];
}

/** A call the backend never finishes: no `output_item.done`, arguments cut off. */
function callNeverFinishedEvents() {
  return [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: '{"city":' },
    {
      type: 'response.completed',
      response: {
        id: 'r',
        model: 'gpt-5.5',
        output: [{ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"Seoul"}' }],
      },
    },
  ];
}

/** A call that takes no arguments, finished by the backend with an empty string. */
function callWithoutArgumentsEvents() {
  return [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'now' } },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'now', arguments: '' } },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [] } },
  ];
}

/** Every content block event of one `/v1/messages` stream, in order. */
async function messagesStreamBlocks(url, tools = [{ name: 'get_weather', description: 'w', input_schema: WEATHER_PARAMETERS }]) {
  const res = await realFetch(`${url}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'local', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'gpt-5.5',
      stream: true,
      max_tokens: 128,
      messages: [{ role: 'user', content: 'w' }],
      tools,
    }),
  });
  const opened = [];
  const arguments_ = new Map();
  let open = 0;
  let maxOpen = 0;
  for (const event of sseEvents(await res.text())) {
    if (event.type === 'content_block_start') {
      opened.push(event.content_block?.type);
      open += 1;
      maxOpen = Math.max(maxOpen, open);
    }
    if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') {
      arguments_.set(event.index, `${arguments_.get(event.index) ?? ''}${event.delta.partial_json}`);
    }
    if (event.type === 'content_block_stop') open -= 1;
  }
  return { opened, maxOpen, open, toolArguments: [...arguments_.values()] };
}

const SEQUENTIAL_BLOCK_CASES = [
  ['narration resuming after a call', narrateCallNarrateEvents(), ['text', 'tool_use', 'text']],
  ['a call before any narration', callThenNarrateFinishedEvents(), ['tool_use', 'text']],
  ['narration before a call', narrateThenCallEvents(), ['text', 'tool_use']],
  ['two calls in a row', twoCallsEvents(), ['tool_use', 'tool_use']],
];

for (const [label, events, expected] of SEQUENTIAL_BLOCK_CASES) {
  test(`messages blocks open and close one at a time with ${label}`, async () => {
    // The tool_use block used to stay open until the end of the turn, so the
    // narration that resumed after it — and the next call — opened INSIDE it.
    // A client that assembles content by index has nowhere to put a nested
    // block; this wire never has two open at once.
    await withProxy(events, async (url) => {
      const stream = await messagesStreamBlocks(url);
      assert.deepEqual(stream.opened, expected);
      assert.equal(stream.maxOpen, 1, 'two content blocks were open at the same time');
      assert.equal(stream.open, 0, 'every block must be closed');
    });
  });
}

/**
 * The backend closes the item but names no arguments there, and only the
 * completed output carries the finished value — the partial the stream sent is
 * not a prefix of what `toolCalls()` will normalize it to.
 */
function callFinishedWithoutArgumentsEvents() {
  return [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: '{"city":' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather' } },
    {
      type: 'response.completed',
      response: {
        id: 'r',
        model: 'gpt-5.5',
        output: [{ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"Seoul"}' }],
      },
    },
  ];
}

/** The backend finishes the item, then contradicts itself in the final output. */
function argumentsExtendedAfterDoneEvents() {
  return [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather' } },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"Seoul"}' } },
    {
      type: 'response.completed',
      response: {
        id: 'r',
        model: 'gpt-5.5',
        output: [{ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"Seoul","unit":"c"}' }],
      },
    },
  ];
}

test('a call finished without its arguments keeps the block open for them', async () => {
  // Closing on the signal is a promise that what was streamed is what the body
  // will report. When the finishing event names no arguments, that promise
  // cannot be made: the block has to stay open so the end of the turn can
  // still send the rest, which is where the completed output supplies it.
  await withProxy(callFinishedWithoutArgumentsEvents(), async (url) => {
    const stream = await messagesStreamBlocks(url);
    assert.deepEqual(stream.toolArguments, ['{"city":"Seoul"}']);
    assert.equal(stream.open, 0, 'every block must be closed by the end of the turn');
    const body = await (await realFetch(`${url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'local', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'gpt-5.5',
        max_tokens: 128,
        messages: [{ role: 'user', content: 'w' }],
        tools: [{ name: 'get_weather', description: 'w', input_schema: WEATHER_PARAMETERS }],
      }),
    })).json();
    assert.deepEqual(body.content.find((block) => block.type === 'tool_use')?.input, { city: 'Seoul' });
  });
});

test('a call announced as finished is not rewritten by the completed output', async () => {
  // The stream cannot take back a value it has already closed on, so the body
  // must not report a different one: what the client accumulated and what the
  // response says have to be the same call.
  await withProxy(argumentsExtendedAfterDoneEvents(), async (url) => {
    const stream = await messagesStreamBlocks(url);
    assert.deepEqual(stream.toolArguments, ['{"city":"Seoul"}']);
    const body = await (await realFetch(`${url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'local', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'gpt-5.5',
        max_tokens: 128,
        messages: [{ role: 'user', content: 'w' }],
        tools: [{ name: 'get_weather', description: 'w', input_schema: WEATHER_PARAMETERS }],
      }),
    })).json();
    assert.deepEqual(body.content.find((block) => block.type === 'tool_use')?.input, { city: 'Seoul' });
  });
});

/** A backend that keeps sending arguments after it said the call was finished. */
function argumentsAfterDoneEvents() {
  return [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: '{"city":"Seoul"}' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"Seoul"}' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: ' ' },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [] } },
  ];
}

test('nothing is written to a call the backend already finished', async () => {
  // The signal is what the Anthropic surface closes the block on, so anything
  // sent for that call afterwards lands in a block that has been stopped —
  // the one wire shape this whole change exists to prevent.
  await withProxy(argumentsAfterDoneEvents(), async (url) => {
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
    const stopped = new Set();
    const arguments_ = new Map();
    for (const event of sseEvents(await res.text())) {
      if (event.type === 'content_block_stop') stopped.add(event.index);
      if (event.type === 'content_block_delta') {
        assert.equal(stopped.has(event.index), false, `delta written to stopped block ${event.index}`);
        if (event.delta?.type === 'input_json_delta') {
          arguments_.set(event.index, `${arguments_.get(event.index) ?? ''}${event.delta.partial_json}`);
        }
      }
    }
    assert.deepEqual([...arguments_.values()], ['{"city":"Seoul"}']);
  });
});

/** A reasoning item the backend opens AFTER it has already produced text. */
function lateReasoningEvents() {
  return [
    { type: 'response.output_text.delta', delta: 'Thinking about it. ' },
    { type: 'response.output_item.added', output_index: 1, item: { type: 'reasoning', id: 'rs_late' } },
    { type: 'response.output_item.done', output_index: 1, item: { type: 'reasoning', id: 'rs_late' } },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [] } },
  ];
}

test('stream and body agree about the reasoning item when it does not come first', async () => {
  // The body places the item by rule and the stream by arrival, so a backend
  // that opens one late made the two surfaces describe different turns.
  await withProxy(lateReasoningEvents(), async (url) => {
    const { announced, streamCompleted, body } = await responsesSurfaces(url);
    assert.deepEqual(streamCompleted.map((item) => item.type), body.output.map((item) => item.type));
    assert.deepEqual(announced.map((item) => item.type), body.output.map((item) => item.type));
  });
});

test('a call the backend never finishes still delivers its arguments', async () => {
  // The other half of closing early: a backend that cannot say where a call's
  // arguments end keeps its block open to the end of the turn, where the
  // completed result supplies the tail the stream was cut off before sending.
  await withProxy(callNeverFinishedEvents(), async (url) => {
    const stream = await messagesStreamBlocks(url);
    assert.deepEqual(stream.toolArguments, ['{"city":"Seoul"}']);
    assert.equal(stream.open, 0, 'every block must be closed');
  });
});

test('a call closed with no arguments carries the same input as the body', async () => {
  // `{}` is what the completed body reports for a call that streamed nothing,
  // and it used to be sent as the turn ended. Closing the block at the
  // backend's own item boundary has to send it there instead, or a client
  // accumulating deltas finishes with an empty string that is not JSON.
  const tools = [{ name: 'now', description: 'n', input_schema: { type: 'object', properties: {}, additionalProperties: false } }];
  await withProxy(callWithoutArgumentsEvents(), async (url) => {
    const stream = await messagesStreamBlocks(url, tools);
    assert.deepEqual(stream.toolArguments, ['{}']);
    const body = await (await realFetch(`${url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'local', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'gpt-5.5',
        max_tokens: 128,
        messages: [{ role: 'user', content: 'w' }],
        tools,
      }),
    })).json();
    assert.deepEqual(body.content.find((block) => block.type === 'tool_use')?.input, {});
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

test('a codex tool result that carries an image still answers its call', async () => {
  // The tool history is what answers a `function_call`; an unanswered one is a
  // 400 from this API. An image used to disqualify the whole message from
  // being read as tool history, so the answer vanished and the `[tool result]`
  // marker went to the model as prose — the shape a consumer reported as a
  // broken image, on the runtime that was never checked.
  const px = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const codexHome = await createCodexHome();
  let sent = null;
  globalThis.fetch = async (_url, init) => {
    sent = JSON.parse(init.body);
    return new Response(sse([{ type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [] } }]), { status: 200 });
  };
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000, model: 'gpt-5.5' });
  const server = await startLocalApiProxy({ backend, host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000 });
  try {
    await realFetch(`${server.url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'local', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'gpt-5.5',
        max_tokens: 128,
        tools: [{ name: 'get_weather', description: 'w', input_schema: WEATHER_PARAMETERS }],
        messages: [
          { role: 'user', content: 'w' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'get_weather', input: { city: 'Seoul' } }] },
          {
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: 't1',
              content: [
                { type: 'text', text: '{"temp":3}' },
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: px } },
              ],
            }],
          },
        ],
      }),
    });
    const types = (sent?.input ?? []).map((item) => item.type);
    assert.ok(types.includes('function_call_output'), `the call was left unanswered: ${JSON.stringify(types)}`);
    const images = JSON.stringify(sent?.input ?? []).includes(px);
    assert.ok(images, 'the image the tool returned must still reach the model');
  } finally {
    await server.close();
    await backend.close();
    globalThis.fetch = realFetch;
  }
});

/** The shapes a real client sends once tools work across turns. */
const TOOL_HISTORY_SHAPES = [
  ['narration alongside the call', [
    { role: 'user', content: 'call echo' },
    { role: 'assistant', content: [{ type: 'text', text: '확인해 보겠습니다.' }, { type: 'tool_use', id: 'call_a1', name: 'echo', input: { s: 'hi' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_a1', content: 'hi' }] },
  ]],
  ['the call alone', [
    { role: 'user', content: 'call echo' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_b1', name: 'echo', input: { s: 'hi' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_b1', content: 'hi' }] },
  ]],
  ['two results answered in one turn', [
    { role: 'user', content: 'call echo twice' },
    { role: 'assistant', content: [
      { type: 'tool_use', id: 'call_c1', name: 'echo', input: { s: 'a' } },
      { type: 'tool_use', id: 'call_c2', name: 'echo', input: { s: 'b' } },
    ] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'call_c1', content: 'a' },
      { type: 'tool_result', tool_use_id: 'call_c2', content: 'b' },
    ] },
  ]],
  ['two results answered in separate turns', [
    { role: 'user', content: 'call echo twice' },
    { role: 'assistant', content: [
      { type: 'tool_use', id: 'call_d1', name: 'echo', input: { s: 'a' } },
      { type: 'tool_use', id: 'call_d2', name: 'echo', input: { s: 'b' } },
    ] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_d1', content: 'a' }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_d2', content: 'b' }] },
  ]],
];

for (const [label, messages] of TOOL_HISTORY_SHAPES) {
  test(`every tool call is answered when the history carries ${label}`, async () => {
    // This API rejects a `function_call` with no output and an output with no
    // call, both as 400. The narration a model writes beside its call used to
    // turn the whole message into prose — the call disappeared — and results
    // answered together in one turn produced a single output for however many
    // calls there were.
    const codexHome = await createCodexHome();
    let sent = null;
    globalThis.fetch = async (_url, init) => {
      sent = JSON.parse(init.body);
      return new Response(sse([{ type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [] } }]), { status: 200 });
    };
    const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000, model: 'gpt-5.5' });
    const server = await startLocalApiProxy({ backend, host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000 });
    try {
      await realFetch(`${server.url}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'local', 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'gpt-5.5',
          max_tokens: 128,
          tools: [{ name: 'echo', description: 'e', input_schema: { type: 'object', properties: { s: { type: 'string' } }, required: ['s'], additionalProperties: false } }],
          messages,
        }),
      });
      const items = sent?.input ?? [];
      const calls = items.filter((item) => item.type === 'function_call').map((item) => item.call_id);
      const outputs = items.filter((item) => item.type === 'function_call_output').map((item) => item.call_id);
      assert.deepEqual(outputs, calls, `calls and outputs must pair: ${JSON.stringify(items.map((i) => i.type))}`);
    } finally {
      await server.close();
      await backend.close();
      globalThis.fetch = realFetch;
    }
  });
}

// ---------------------------------------------------------------------------
// A tool-calling turn's narration, on a backend that streams none of it.
//
// Measured against the installed claude CLI (2.1.251, 2026-08-31) on the native
// `--json-schema` channel every tool-calling turn now takes: the content_block
// deltas carry the model's PROSE, and the wrapper object arrives only in the
// final `result` message as `structured_output`. The extractor reading those
// deltas as JSON finds neither a `text` property nor a tool call, so the turn
// streams NOTHING and the whole answer is first known at `completed`.
//
//   STREAMED TEXT     : "서울의 날씨를 확인해드리겠습니다."
//   RESULT.structured : {"status":"tool_calls","text":"서울의 날씨를 …",
//                        "toolCalls":[{"id":"call_1", …}]}
//
// So `result.text` is non-empty while nothing was streamed — the case the
// `missingTextTail` reconciliation exists for. Assert it on all three surfaces
// at once: the stream and the buffered body describe ONE turn.

function narratedToolCallBackend() {
  const result = {
    id: 'x',
    model: 'configured-model',
    text: '서울의 날씨를 확인해드리겠습니다.',
    toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: '{"city":"Seoul"}' }],
    usage: { inputTokens: 20, outputTokens: 8, source: 'provider' },
    latencyMs: 1,
  };
  return {
    name: 'test',
    model: 'configured-model',
    async generate() { return result; },
    async *stream() { yield { type: 'completed', result }; },
    async close() {},
  };
}

async function narratedToolSurfaces() {
  const backend = narratedToolCallBackend();
  const server = await startLocalApiProxy({ backend, host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000 });
  const post = (path, body, headers = {}) => realFetch(`${server.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer local', ...headers },
    body: JSON.stringify(body),
  });
  const chatTools = [{ type: 'function', function: { name: 'get_weather', description: 'w', parameters: WEATHER_PARAMETERS, strict: true } }];
  const responsesTools = [{ type: 'function', name: 'get_weather', description: 'w', parameters: WEATHER_PARAMETERS, strict: true }];
  const messagesTools = [{ name: 'get_weather', description: 'w', input_schema: WEATHER_PARAMETERS }];
  const anthropicHeaders = { 'x-api-key': 'local', 'anthropic-version': '2023-06-01' };
  try {
    const chatBuffered = await (await post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: 'w' }], tools: chatTools })).json();
    const chatStream = sseEvents(await (await post('/v1/chat/completions', { model: 'm', stream: true, messages: [{ role: 'user', content: 'w' }], tools: chatTools })).text());
    const responsesBuffered = await (await post('/v1/responses', { model: 'm', input: 'w', tools: responsesTools })).json();
    const responsesStream = sseEvents(await (await post('/v1/responses', { model: 'm', stream: true, input: 'w', tools: responsesTools })).text());
    const messagesBuffered = await (await post('/v1/messages', { model: 'm', max_tokens: 64, messages: [{ role: 'user', content: 'w' }], tools: messagesTools }, anthropicHeaders)).json();
    const messagesWire = await (await post('/v1/messages', { model: 'm', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'w' }], tools: messagesTools }, anthropicHeaders)).text();
    const messagesStream = [...messagesWire.matchAll(/^event: (\S+)\ndata: (.+)$/gm)].map(([, type, data]) => ({ type, data: JSON.parse(data) }));
    return {
      chat: {
        buffered: chatBuffered.choices?.[0]?.message?.content ?? '',
        streamed: chatStream.map((chunk) => chunk.choices?.[0]?.delta?.content ?? '').join(''),
        finishReason: chatStream.map((chunk) => chunk.choices?.[0]?.finish_reason).filter(Boolean),
        streamedCalls: chatStream.flatMap((chunk) => chunk.choices?.[0]?.delta?.tool_calls ?? [])
          .map((call) => call.function?.arguments).filter((value) => typeof value === 'string').join(''),
      },
      responses: {
        buffered: responsesBuffered.output ?? [],
        streamed: responsesStream.find((event) => event.type === 'response.completed')?.response?.output ?? [],
        deltas: responsesStream.filter((event) => event.type === 'response.output_text.delta').map((event) => event.delta).join(''),
      },
      messages: {
        buffered: messagesBuffered.content ?? [],
        streamedBlocks: messagesStream.filter((event) => event.type === 'content_block_start').map((event) => event.data.content_block),
        deltas: messagesStream.filter((event) => event.type === 'content_block_delta' && event.data.delta.type === 'text_delta')
          .map((event) => event.data.delta.text).join(''),
      },
    };
  } finally {
    await server.close();
  }
}

const NARRATION = '서울의 날씨를 확인해드리겠습니다.';

test('chat streams the narration a tool-calling turn carried', async () => {
  const surfaces = await narratedToolSurfaces();
  assert.equal(surfaces.chat.buffered, NARRATION, 'the buffered body is the reference');
  assert.equal(surfaces.chat.streamed, NARRATION, 'the stream must carry the same content the body reports');
  assert.deepEqual(surfaces.chat.finishReason, ['tool_calls'], 'and it is still a tool-call turn');
  assert.equal(surfaces.chat.streamedCalls, '{"city":"Seoul"}', 'the call still reaches the client once');
});

test('responses streams the message item a tool-calling turn carried', async () => {
  const surfaces = await narratedToolSurfaces();
  assert.deepEqual(
    surfaces.responses.buffered.map((item) => item.type),
    ['message', 'function_call'],
    'the buffered body is the reference',
  );
  assert.deepEqual(
    surfaces.responses.streamed.map((item) => item.type),
    ['message', 'function_call'],
    'the completed output must name the same items, at the same positions',
  );
  assert.equal(surfaces.responses.deltas, NARRATION, 'and the deltas must carry the text the item reports');
  const message = surfaces.responses.streamed.find((item) => item.type === 'message');
  assert.equal(message?.content?.[0]?.text, NARRATION);
});

test('messages streams the text block a tool-calling turn carried', async () => {
  const surfaces = await narratedToolSurfaces();
  assert.deepEqual(surfaces.messages.buffered.map((block) => block.type), ['text', 'tool_use']);
  assert.deepEqual(surfaces.messages.streamedBlocks.map((block) => block.type), ['text', 'tool_use']);
  assert.equal(surfaces.messages.deltas, NARRATION);
});

// The tail recovery has six relations between what streamed and what the turn
// finally reported, and the three tests above cover only one of them (nothing
// streamed). A one-line mutant changing the strict-prefix branch from
// `final.slice(streamed.length)` to `final` produced "helhello" on both OpenAI
// surfaces and no test noticed. Table-driven, both surfaces, asserting the
// aggregated deltas ONCE and the Responses message text against those deltas.
const TAIL_RELATIONS = [
  ['nothing streamed', [], 'hello', 'hello'],
  ['a strict prefix streamed', ['hel'], 'hello', 'hello'],
  ['everything streamed', ['hello'], 'hello', 'hello'],
  ['streamed in pieces', ['he', 'l'], 'hello', 'hello'],
  // Bytes already delivered cannot be retracted, so a final text that
  // contradicts or falls short of them leaves the client with what it received.
  ['a divergent final text', ['hello'], 'hullo', 'hello'],
  // Divergent AND longer, which is the case the prefix guard exists for:
  // without it the tail is spliced onto a prefix the model never wrote, and
  // the client assembles "Hxllo" — three characters of one string and two of
  // another.
  ['a divergent, longer final text', ['Hxl'], 'Hello', 'Hxl'],
  ['a shorter final text', ['hello'], 'hel', 'hello'],
  ['an empty final text', ['hello'], '', 'hello'],
  ['nothing at all', [], '', ''],
];

function tailBackend(deltas, text) {
  const result = {
    id: 'x', model: 'configured-model', text,
    toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: '{"city":"Seoul"}' }],
    usage: { inputTokens: 20, outputTokens: 8, source: 'provider' }, latencyMs: 1,
  };
  return {
    name: 'test', model: 'configured-model',
    async generate() { return result; },
    async *stream() {
      for (const delta of deltas) yield { type: 'text_delta', delta };
      yield { type: 'completed', result };
    },
    async close() {},
  };
}

for (const [label, deltas, text, expected] of TAIL_RELATIONS) {
  test(`chat streams the turn's text exactly once with ${label}`, async () => {
    const server = await startLocalApiProxy({ backend: tailBackend(deltas, text), host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000 });
    try {
      const res = await realFetch(`${server.url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer local' },
        body: JSON.stringify({
          model: 'm', stream: true, messages: [{ role: 'user', content: 'w' }],
          tools: [{ type: 'function', function: { name: 'get_weather', description: 'w', parameters: WEATHER_PARAMETERS, strict: true } }],
        }),
      });
      const chunks = sseEvents(await res.text());
      const streamed = chunks.map((chunk) => chunk.choices?.[0]?.delta?.content ?? '').join('');
      assert.equal(streamed, expected, 'the client assembles exactly the turn once');
      assert.deepEqual(chunks.map((chunk) => chunk.choices?.[0]?.finish_reason).filter(Boolean), ['tool_calls']);
    } finally {
      await server.close();
    }
  });

  test(`responses streams the turn's text exactly once with ${label}`, async () => {
    const server = await startLocalApiProxy({ backend: tailBackend(deltas, text), host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000 });
    try {
      const res = await realFetch(`${server.url}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer local' },
        body: JSON.stringify({
          model: 'm', stream: true, input: 'w',
          tools: [{ type: 'function', name: 'get_weather', description: 'w', parameters: WEATHER_PARAMETERS, strict: true }],
        }),
      });
      const events = sseEvents(await res.text());
      const streamed = events.filter((event) => event.type === 'response.output_text.delta').map((event) => event.delta).join('');
      assert.equal(streamed, expected, 'the client assembles exactly the turn once');
      const output = events.find((event) => event.type === 'response.completed')?.response?.output ?? [];
      const message = output.find((item) => item.type === 'message');
      // The completed summary has to agree with the deltas it sent, whichever
      // relation held: no message item at all when there was no text.
      assert.equal(message?.content?.[0]?.text ?? '', streamed, 'the message item is what the deltas said');
      assert.ok(output.some((item) => item.type === 'function_call'), 'and the call is still there');
    } finally {
      await server.close();
    }
  });
}

// The turn's text had two sources of truth: the streamed deltas went out as the
// model wrote them, and `completed()` handed the buffered path a TRIMMED copy.
// A narration ending in a space arrived as two different strings, and a
// whitespace-only one gave the stream a whole `message` item the buffered body
// did not have — one turn, two shapes. The vendor returns what the model
// emitted, so the trim is gone; these pin that it stays gone.
for (const [label, narration] of [
  ['whitespace only', '\n'],
  ['a trailing space', 'Let me check the weather. '],
  ['a leading newline', '\nLet me check the weather.'],
]) {
  test(`a narration that is ${label} reads the same streamed and buffered`, async () => {
    const events = [
      { type: 'response.output_text.delta', delta: narration },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather' } },
      { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: '{"city":"Seoul"}' },
      { type: 'response.function_call_arguments.done', output_index: 0, item_id: 'fc_1' },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"Seoul"}' } },
      { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [] } },
    ];
    await withProxy(events, async (url) => {
      const tools = [{ type: 'function', name: 'get_weather', description: 'w', parameters: WEATHER_PARAMETERS, strict: true }];
      const post = (body) => realFetch(`${url}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer local' },
        body: JSON.stringify({ model: 'gpt-5.5', input: 'w', tools, ...body }),
      });
      const buffered = await (await post({})).json();
      const events2 = sseEvents(await (await post({ stream: true })).text());
      const streamed = events2.find((event) => event.type === 'response.completed')?.response?.output ?? [];
      assert.deepEqual(
        streamed.map((item) => item.type),
        (buffered.output ?? []).map((item) => item.type),
        'the same turn has the same items on both paths',
      );
      const textOf = (output) => output.find((item) => item.type === 'message')?.content?.[0]?.text;
      assert.equal(textOf(streamed), textOf(buffered.output ?? []), 'and the same text, byte for byte');
      assert.equal(textOf(streamed), narration, 'which is what the model emitted');
    });
  });
}

// Output positions are allocated when an item is ANNOUNCED, so once both are
// announced the only thing left to decide is the order of the terminal frames —
// and that has to be the announced order. Ordering them by production instead
// closed item 2 before item 1, putting the `arguments.done` frame that promises
// a call is final after a whole other item had already closed.
test('items complete in the order the stream announced them', async () => {
  const events = [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_1' } },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id: 'rs_1' } },
    { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather' } },
    { type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'fc_1', delta: '{"city":"Seoul"}' },
    { type: 'response.output_text.delta', delta: 'checking' },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [] } },
  ];
  await withProxy(events, async (url) => {
    const res = await realFetch(`${url}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer local' },
      body: JSON.stringify({
        model: 'gpt-5.5', stream: true, input: 'w',
        tools: [{ type: 'function', name: 'get_weather', description: 'w', parameters: WEATHER_PARAMETERS, strict: true }],
      }),
    });
    const events2 = sseEvents(await res.text());
    const added = events2.filter((event) => event.type === 'response.output_item.added').map((event) => event.output_index);
    const done = events2.filter((event) => event.type === 'response.output_item.done').map((event) => event.output_index);
    assert.deepEqual(added, [0, 1, 2], 'announced in position order');
    assert.deepEqual(done, added, 'and completed in the same order');
    // The frame that promises a call is final may not arrive after a later
    // item has already closed.
    const argumentsDone = events2.findIndex((event) => event.type === 'response.function_call_arguments.done');
    const messageDone = events2.findIndex((event) => event.type === 'response.output_item.done' && event.output_index === 2);
    assert.ok(argumentsDone < messageDone, 'the call is finalized before a later item closes');
  });
});

// The completion-only turn: the backend announces NOTHING while it runs — no
// text delta, no tool item — and the entire answer first exists at `completed`.
// Both output positions are then allocated inside that terminal branch, so
// nothing has been "announced" to order them by and PRODUCTION order is the
// only thing left, read from `toolCallsBeforeText` exactly as the buffered body
// reads it. The narration tests above use this shape with the flag unset only;
// with it SET the branch was unprotected, and a mutant pinning it to
// message-first left every ordering suite green.
function completionOnlyBackend(toolCallsBeforeText) {
  const result = {
    id: 'x',
    model: 'configured-model',
    text: 'Checking the weather.',
    toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: '{"city":"Seoul"}' }],
    usage: { inputTokens: 20, outputTokens: 8, source: 'provider' },
    latencyMs: 1,
    ...(toolCallsBeforeText ? { toolCallsBeforeText: true } : {}),
  };
  return {
    name: 'test',
    model: 'configured-model',
    async generate() { return result; },
    async *stream() { yield { type: 'completed', result }; },
    async close() {},
  };
}

const COMPLETION_ONLY_ORDERS = [
  ['the turn narrated before it called', false, ['message', 'function_call']],
  ['the turn called before it narrated', true, ['function_call', 'message']],
];

for (const [label, toolCallsBeforeText, expected] of COMPLETION_ONLY_ORDERS) {
  test(`a responses stream that announced nothing orders its items by production when ${label}`, async () => {
    const server = await startLocalApiProxy({
      backend: completionOnlyBackend(toolCallsBeforeText),
      host: '127.0.0.1',
      port: 0,
      requestTimeoutMs: 30_000,
    });
    const post = (body) => realFetch(`${server.url}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer local' },
      body: JSON.stringify({
        model: 'm',
        input: 'w',
        tools: [{ type: 'function', name: 'get_weather', description: 'w', parameters: WEATHER_PARAMETERS, strict: true }],
        ...body,
      }),
    });
    try {
      const buffered = await (await post({})).json();
      const events = sseEvents(await (await post({ stream: true })).text());

      // Nothing reached the client before `completed`, so these added frames are
      // the terminal branch's own — their order IS the decision under test.
      const added = events.filter((event) => event.type === 'response.output_item.added');
      assert.deepEqual(added.map((event) => event.item.type), expected, 'items are announced in production order');
      assert.deepEqual(added.map((event) => event.output_index), [0, 1], 'taking the output positions in that order');

      const done = events.filter((event) => event.type === 'response.output_item.done');
      assert.deepEqual(done.map((event) => event.item.type), expected, 'the terminal frames follow the announced order');
      assert.deepEqual(done.map((event) => event.output_index), [0, 1], 'and close positions monotonically');

      const completed = events.find((event) => event.type === 'response.completed')?.response?.output ?? [];
      assert.deepEqual(completed.map((item) => item.type), expected, 'the completed output says the same thing the stream did');
      assert.deepEqual(
        (buffered.output ?? []).map((item) => item.type),
        expected,
        'which is the order the buffered body reports for this same turn',
      );

      // The frame that promises a call is final may not arrive after a later
      // item has already closed.
      const argumentsDone = events.findIndex((event) => event.type === 'response.function_call_arguments.done');
      const callDone = events.findIndex((event) => event.type === 'response.output_item.done' && event.item.type === 'function_call');
      assert.ok(argumentsDone >= 0, 'the call was finalized');
      assert.ok(argumentsDone < callDone, 'the call is finalized before its own item closes');

      // Reordering may not cost the turn its content.
      assert.equal(
        events.filter((event) => event.type === 'response.output_text.delta').map((event) => event.delta).join(''),
        'Checking the weather.',
        'the narration still reaches the client exactly once',
      );
      assert.equal(
        completed.find((item) => item.type === 'message')?.content?.[0]?.text,
        'Checking the weather.',
        'and the message item reports it',
      );
      assert.equal(
        completed.find((item) => item.type === 'function_call')?.arguments,
        '{"city":"Seoul"}',
        'and the call still carries its arguments',
      );
    } finally {
      await server.close();
    }
  });
}
