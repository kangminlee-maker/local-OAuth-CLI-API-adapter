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
  ['an id-less function_call in the completed output', [
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
