import assert from 'node:assert/strict';
import { chmod } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, before, test } from 'node:test';
import { startLocalApiProxy } from '../dist/proxy/http-server.js';
import { ClaudeCodeBackend } from '../dist/proxy/claude-code-backend.js';

// A forced call the runtime reports as cut off by its output limit is
// delivered as the fragment it is, and every terminal field says so — the
// direct APIs answer `finish_reason: "length"` (Chat), `status: "incomplete"`
// with `incomplete_details.reason: "max_output_tokens"` and an item
// `status: "incomplete"` ending in `response.incomplete` (Responses), and
// `stop_reason: "max_tokens"` with the `tool_use` block present (Messages);
// measured 2026-09-04, `review-artifacts/stage2/report.md` M6. Round 18
// (codex C2) found the writers reported a completed call instead.

const here = dirname(fileURLToPath(import.meta.url));
const streamingClaude = resolve(here, 'fixtures/streaming-claude.cjs');
const WEATHER = { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] };
const FRAGMENT = '{"city":"Seo';

before(async () => { await chmod(streamingClaude, 0o755); });
afterEach(() => {
  delete process.env.WRAPPER_RAW;
  delete process.env.WRAPPER_STOP_REASON;
});

const SURFACES = {
  chat: {
    path: '/v1/chat/completions',
    headers: { 'content-type': 'application/json', authorization: 'Bearer local' },
    body: { model: 'm', messages: [{ role: 'user', content: 'w' }], tools: [{ type: 'function', function: { name: 'get_weather', parameters: WEATHER } }], tool_choice: { type: 'function', function: { name: 'get_weather' } } },
  },
  responses: {
    path: '/v1/responses',
    headers: { 'content-type': 'application/json', authorization: 'Bearer local' },
    body: { model: 'm', input: 'w', tools: [{ type: 'function', name: 'get_weather', parameters: WEATHER }], tool_choice: { type: 'function', name: 'get_weather' } },
  },
  messages: {
    path: '/v1/messages',
    headers: { 'content-type': 'application/json', 'x-api-key': 'local', 'anthropic-version': '2023-06-01' },
    body: { model: 'm', max_tokens: 64, messages: [{ role: 'user', content: 'w' }], tools: [{ name: 'get_weather', input_schema: WEATHER }], tool_choice: { type: 'tool', name: 'get_weather' } },
  },
};

async function withProxy(stopReason, run) {
  process.env.WRAPPER_RAW = FRAGMENT;
  process.env.WRAPPER_STOP_REASON = stopReason;
  const backend = new ClaudeCodeBackend({ command: streamingClaude, cwd: process.cwd(), model: 'sonnet', timeoutMs: 30_000 });
  const server = await startLocalApiProxy({ backend, host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000 });
  try {
    return await run(server.url);
  } finally {
    await server.close();
    await backend.close();
  }
}

async function call(url, surface, stream) {
  const { path, headers, body } = SURFACES[surface];
  const res = await fetch(`${url}${path}`, { method: 'POST', headers, body: JSON.stringify({ ...body, ...(stream ? { stream: true } : {}) }) });
  const text = await res.text();
  if (!stream) return { status: res.status, json: JSON.parse(text) };
  const events = text.split('\n').filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]').map((line) => JSON.parse(line.slice(6)));
  return { status: res.status, events };
}

test('chat: the fragment under finish_reason "length" on both paths', async () => {
  await withProxy('max_tokens', async (url) => {
    const buffered = await call(url, 'chat', false);
    assert.equal(buffered.status, 200);
    assert.equal(buffered.json.choices[0].finish_reason, 'length');
    assert.equal(buffered.json.choices[0].message.tool_calls[0].function.arguments, FRAGMENT);
    const streamed = await call(url, 'chat', true);
    assert.equal(streamed.status, 200);
    const finishes = streamed.events.flatMap((e) => e.choices ?? []).map((c) => c.finish_reason).filter(Boolean);
    assert.deepEqual(finishes, ['length']);
    const args = streamed.events.flatMap((e) => e.choices ?? []).flatMap((c) => c.delta?.tool_calls ?? []).map((t) => t.function?.arguments ?? '').join('');
    assert.equal(args, FRAGMENT);
  });
});

test('responses: status incomplete, incomplete_details, an incomplete item, and response.incomplete', async () => {
  await withProxy('max_tokens', async (url) => {
    const buffered = await call(url, 'responses', false);
    assert.equal(buffered.status, 200);
    assert.equal(buffered.json.status, 'incomplete');
    assert.deepEqual(buffered.json.incomplete_details, { reason: 'max_output_tokens' });
    assert.equal(buffered.json.completed_at, null);
    const item = buffered.json.output.find((o) => o.type === 'function_call');
    assert.equal(item.status, 'incomplete');
    assert.equal(item.arguments, FRAGMENT);
    const streamed = await call(url, 'responses', true);
    assert.equal(streamed.status, 200);
    const last = streamed.events.at(-1);
    assert.equal(last.type, 'response.incomplete');
    assert.equal(last.response.status, 'incomplete');
    assert.deepEqual(last.response.incomplete_details, { reason: 'max_output_tokens' });
    assert.equal(last.response.output.find((o) => o.type === 'function_call').status, 'incomplete');
    assert.equal(streamed.events.some((e) => e.type === 'response.completed'), false);
  });
});

test('messages: stop_reason max_tokens with the tool_use block present, on both paths', async () => {
  await withProxy('max_tokens', async (url) => {
    const buffered = await call(url, 'messages', false);
    assert.equal(buffered.status, 200);
    assert.equal(buffered.json.stop_reason, 'max_tokens');
    assert.equal(buffered.json.content.some((b) => b.type === 'tool_use'), true);
    const streamed = await call(url, 'messages', true);
    assert.equal(streamed.status, 200);
    const delta = streamed.events.find((e) => e.type === 'message_delta');
    assert.equal(delta.delta.stop_reason, 'max_tokens');
    assert.equal(streamed.events.some((e) => e.type === 'content_block_start' && e.content_block.type === 'tool_use'), true);
  });
});

test('CONTROL: the same fragment with no limit reported is refused, 502 on both paths', async () => {
  await withProxy('end_turn', async (url) => {
    for (const surface of Object.keys(SURFACES)) {
      const buffered = await call(url, surface, false);
      assert.equal(buffered.status, 502, surface);
      const streamed = await call(url, surface, true);
      assert.equal(streamed.status, 502, `${surface} stream`);
    }
  });
});

test('CONTROL: a whole call under end_turn reports a completed call', async () => {
  process.env.WRAPPER_RAW = '{"city":"Seoul"}';
  process.env.WRAPPER_STOP_REASON = 'end_turn';
  const backend = new ClaudeCodeBackend({ command: streamingClaude, cwd: process.cwd(), model: 'sonnet', timeoutMs: 30_000 });
  const server = await startLocalApiProxy({ backend, host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000 });
  try {
    assert.equal((await call(server.url, 'chat', false)).json.choices[0].finish_reason, 'tool_calls');
    const responses = await call(server.url, 'responses', false);
    assert.equal(responses.json.status, 'completed');
    assert.equal(responses.json.incomplete_details, null);
    assert.equal((await call(server.url, 'messages', false)).json.stop_reason, 'tool_use');
  } finally {
    await server.close();
    await backend.close();
  }
});
