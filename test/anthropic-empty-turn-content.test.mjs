// A turn that produced no text has NO content block, on both readings.
//
// Measured on the direct API 2026-09-02 with a stop sequence the model's very
// first token matches (`Reply with exactly: ZZDONE`, `stop_sequences: ['ZZ']`):
//
//   buffered  content: []                 stop_reason: stop_sequence
//   streamed  no content_block_start at all
//
// This proxy streamed nothing — right — and its buffered body answered
// `[{type:'text',text:''}]`, a block the vendor does not send. One turn, two
// readings, and the invented one was the buffered half.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startLocalApiProxy } from '../dist/proxy/http-server.js';

const HEADERS = { 'content-type': 'application/json', 'x-api-key': 'local', 'anthropic-version': '2023-06-01' };

function backendFor(result) {
  return {
    name: 'test', model: 'm',
    async generate() { return result; },
    async *stream() {
      if (result.text) yield { type: 'text_delta', delta: result.text };
      yield { type: 'completed', result };
    },
    async close() {},
  };
}

const usage = { inputTokens: 1, outputTokens: 1, source: 'estimated' };
const sse = (t) => t.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim())
  .filter((x) => x && x !== '[DONE]').map((x) => { try { return JSON.parse(x); } catch { return null; } }).filter(Boolean);

async function readings(result) {
  const server = await startLocalApiProxy({ backend: backendFor(result), host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000 });
  const body = { model: 'm', max_tokens: 64, messages: [{ role: 'user', content: 'w' }] };
  const post = (b) => fetch(`${server.url}/v1/messages`, { method: 'POST', headers: HEADERS, body: JSON.stringify(b) });
  try {
    const buffered = await (await post(body)).json();
    const events = sse(await (await post({ ...body, stream: true })).text());
    return {
      buffered: (buffered.content ?? []).map((c) => c.type),
      streamed: events.filter((e) => e.type === 'content_block_start').map((e) => e.content_block?.type),
      raw: buffered,
    };
  } finally { await server.close(); }
}

test('a turn with no text sends no content block on either reading', async () => {
  const r = await readings({ id: 'x', model: 'm', text: '', toolCalls: [], usage, latencyMs: 1 });
  assert.deepEqual(r.buffered, [], 'the buffered body carries no block, as the direct API answers');
  assert.deepEqual(r.streamed, [], 'and the stream announces none');
  assert.deepEqual(r.buffered, r.streamed, 'the two readings of one turn agree');
});

test('a turn WITH text still sends its block on both readings', async () => {
  // The control: without it, deleting the branch entirely would pass the test
  // above while destroying every ordinary answer.
  const r = await readings({ id: 'x', model: 'm', text: 'hi', toolCalls: [], usage, latencyMs: 1 });
  assert.deepEqual(r.buffered, ['text']);
  assert.deepEqual(r.streamed, ['text']);
  assert.equal(r.raw.content[0].text, 'hi', 'and it carries the turn\'s own text');
});

test('a turn with no text but a tool call sends only the tool block', async () => {
  const r = await readings({
    id: 'x', model: 'm', text: '', usage, latencyMs: 1,
    toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: '{}' }],
  });
  assert.deepEqual(r.buffered, ['tool_use'], 'no empty text block beside the call');
  assert.deepEqual(r.streamed, ['tool_use']);
});
