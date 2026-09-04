import assert from 'node:assert/strict';
import { chmod } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, before, test } from 'node:test';
import { startLocalApiProxy } from '../dist/proxy/http-server.js';
import { ClaudeCodeBackend } from '../dist/proxy/claude-code-backend.js';

// The two `/v1/messages` writers must publish the same bytes for a call's
// arguments. Round 21 (Fable F1): the buffered body parsed and re-serialized
// them — `9007199254740993` went out as `…992` and `1e999` as `null` — while
// the stream's `input_json_delta` carried the runtime's bytes. The body is
// read here as TEXT, so the test itself cannot round.

const here = dirname(fileURLToPath(import.meta.url));
const streamingClaude = resolve(here, 'fixtures/streaming-claude.cjs');
const HEADERS = { 'content-type': 'application/json', 'x-api-key': 'local', 'anthropic-version': '2023-06-01' };
const TOOLS = [{ name: 'get_weather', input_schema: { type: 'object' } }, { name: 'get_time', input_schema: { type: 'object' } }];
const BODY = { model: 'm', max_tokens: 64, messages: [{ role: 'user', content: 'w' }], tools: TOOLS, tool_choice: { type: 'any' } };

before(async () => { await chmod(streamingClaude, 0o755); });
afterEach(() => {
  delete process.env.WRAPPER_RAW;
  delete process.env.WRAPPER_STOP_REASON;
});

async function withProxy(raw, stopReason, run) {
  process.env.WRAPPER_RAW = raw;
  if (stopReason) process.env.WRAPPER_STOP_REASON = stopReason;
  const backend = new ClaudeCodeBackend({ command: streamingClaude, cwd: process.cwd(), model: 'sonnet', timeoutMs: 30_000 });
  const server = await startLocalApiProxy({ backend, host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000 });
  try {
    return await run(server.url);
  } finally {
    await server.close();
    await backend.close();
  }
}

async function bothPaths(url) {
  const buffered = await fetch(`${url}/v1/messages`, { method: 'POST', headers: HEADERS, body: JSON.stringify(BODY) });
  const bodyText = await buffered.text();
  const streamed = await fetch(`${url}/v1/messages`, { method: 'POST', headers: HEADERS, body: JSON.stringify({ ...BODY, stream: true }) });
  const events = (await streamed.text()).split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)));
  const partialJson = events
    .filter((event) => event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta')
    .map((event) => event.delta.partial_json)
    .join('');
  return { status: buffered.status, bodyText, partialJson };
}

function wrapper(args) {
  return JSON.stringify({ status: 'tool_calls', text: '', toolCalls: [{ id: 'c1', name: 'get_weather', arguments: args }] });
}

test('messages: a completed call\'s arguments reach the body byte for byte, and the stream carries the same bytes', async () => {
  const ARGS = '{"id":9007199254740993,"w":1e999, "s":"x"}';
  await withProxy(wrapper(ARGS), undefined, async (url) => {
    const { status, bodyText, partialJson } = await bothPaths(url);
    assert.equal(status, 200, bodyText);
    assert.ok(bodyText.includes(`"input":${ARGS}`), bodyText);
    assert.ok(!bodyText.includes('9007199254740992') && !/"w":\s*null/.test(bodyText), bodyText);
    assert.equal(partialJson, ARGS);
    const body = JSON.parse(bodyText);
    assert.equal(body.content[0].type, 'tool_use');
    assert.equal(body.stop_reason, 'tool_use');
  });
});

test('messages: a cut-off call\'s complete members reach the body as the runtime wrote them; the stream carries the fragment', async () => {
  const FRAGMENT = '{"id": 9007199254740993, "w": 1e999, "cut": "Ko';
  await withProxy(wrapper(FRAGMENT), 'max_tokens', async (url) => {
    const { status, bodyText, partialJson } = await bothPaths(url);
    assert.equal(status, 200, bodyText);
    assert.ok(bodyText.includes('"input":{"id":9007199254740993,"w":1e999}'), bodyText);
    assert.equal(partialJson, FRAGMENT);
    assert.equal(JSON.parse(bodyText).stop_reason, 'max_tokens');
  });
});
