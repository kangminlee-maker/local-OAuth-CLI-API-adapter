import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startLocalApiProxy } from '../dist/proxy/http-server.js';
import { StopSequenceGate, matchStopSequence, truncateAtStopSequence } from '../dist/proxy/stop-sequences.js';

// Measured on the direct API (probe P-8, 2026-08-30): a turn told to say
// `AAZZBB` with `stop_sequences: ["ZZ"]` answers `AA`, `stop_reason:
// "stop_sequence"`, `stop_sequence: "ZZ"`. No Claude CLI flag carries the
// option, so the proxy realizes it on the response path — and a realization
// only counts if it is checked on the bytes a client receives.

function backend({ text = 'AAZZBB', deltas = null, toolCalls = [] } = {}) {
  const result = {
    id: 'x', model: 'configured-model', text, toolCalls,
    usage: { inputTokens: 20, outputTokens: 4, source: 'provider' }, latencyMs: 1,
  };
  return {
    name: 'test', model: 'configured-model',
    async generate() { return result; },
    async *stream() {
      for (const delta of deltas ?? [text]) yield { type: 'text_delta', delta };
      yield { type: 'completed', result };
    },
    async close() {},
  };
}

async function messages(be, body) {
  const started = await startLocalApiProxy({ backend: be, host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000 });
  try {
    const res = await fetch(`${started.url}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'a-model', max_tokens: 64, messages: [{ role: 'user', content: 'ping' }], ...body }),
    });
    const text = await res.text();
    return { status: res.status, text, json: text.startsWith('{') ? JSON.parse(text) : null };
  } finally {
    await started.close();
  }
}

function events(wire) {
  return [...wire.matchAll(/^event: (\S+)\ndata: (.+)$/gm)].map(([, type, data]) => ({ type, data: JSON.parse(data) }));
}
const streamedText = (wire) => events(wire)
  .filter((event) => event.type === 'content_block_delta')
  .map((event) => event.data.delta.text)
  .join('');

test('the unit: the earliest sequence wins, and the caller order breaks a tie', () => {
  assert.deepEqual(matchStopSequence('AAZZBB', ['ZZ']), { index: 2, sequence: 'ZZ' });
  assert.deepEqual(matchStopSequence('AABBZZ', ['ZZ', 'BB']), { index: 2, sequence: 'BB' }, 'earliest, not first-listed');
  assert.deepEqual(matchStopSequence('AAZZZ', ['ZZ', 'ZZZ']), { index: 2, sequence: 'ZZ' }, 'same index → the caller order');
  assert.equal(matchStopSequence('AABB', ['ZZ']), null);
  assert.deepEqual(truncateAtStopSequence('AAZZBB', ['ZZ']), { text: 'AA', sequence: 'ZZ' });
  assert.deepEqual(truncateAtStopSequence('AABB', ['ZZ']), { text: 'AABB', sequence: null });
});

test('the gate holds back a tail that could still become a sequence', () => {
  const gate = new StopSequenceGate(['ZZ']);
  assert.equal(gate.push('AA'), 'AA');
  assert.equal(gate.push('Z'), '', 'a lone Z might be the first half of ZZ, so it waits');
  assert.equal(gate.stopped, null);
  assert.equal(gate.push('Z'), '', 'and the second half completes the match');
  assert.equal(gate.stopped, 'ZZ');
  assert.equal(gate.push('BB'), '', 'nothing after the match is written');
  assert.equal(gate.flush(), '');
});

test('the gate releases a held tail that turns out not to be a sequence', () => {
  const gate = new StopSequenceGate(['ZZ']);
  assert.equal(gate.push('AZ'), 'A');
  assert.equal(gate.push('B'), 'ZB', 'the Z is released once a B rules the sequence out');
  assert.equal(gate.stopped, null);
  assert.equal(gate.flush(), '');
});

test('the gate keeps a trailing partial for the flush', () => {
  const gate = new StopSequenceGate(['ZZ']);
  assert.equal(gate.push('AAZ'), 'AA');
  assert.equal(gate.flush(), 'Z', 'a turn that ended mid-partial still owes the client that text');
});

test('a gate with no sequences is a pass-through', () => {
  const gate = new StopSequenceGate([]);
  assert.equal(gate.active, false);
  assert.equal(gate.push('AAZZBB'), 'AAZZBB');
});

test('a buffered turn is cut before the sequence and reports it', async () => {
  const { status, json } = await messages(backend(), { stop_sequences: ['ZZ'] });
  assert.equal(status, 200);
  assert.deepEqual(json.content, [{ type: 'text', text: 'AA' }]);
  assert.equal(json.stop_reason, 'stop_sequence');
  assert.equal(json.stop_sequence, 'ZZ');
});

test('a buffered turn that never emits a sequence is untouched', async () => {
  const { json } = await messages(backend({ text: 'AABB' }), { stop_sequences: ['ZZ'] });
  assert.deepEqual(json.content, [{ type: 'text', text: 'AABB' }]);
  assert.equal(json.stop_reason, 'end_turn');
  assert.equal(json.stop_sequence, null);
});

test('no stop_sequences means the text arrives whole', async () => {
  const { json } = await messages(backend(), {});
  assert.deepEqual(json.content, [{ type: 'text', text: 'AAZZBB' }]);
  assert.equal(json.stop_reason, 'end_turn');
});

test('a streamed turn stops carrying output at the sequence', async () => {
  const { status, text } = await messages(backend({ deltas: ['AA', 'ZZ', 'BB'] }), { stop_sequences: ['ZZ'], stream: true });
  assert.equal(status, 200);
  assert.equal(streamedText(text), 'AA');
  const delta = events(text).find((event) => event.type === 'message_delta');
  assert.equal(delta.data.delta.stop_reason, 'stop_sequence');
  assert.equal(delta.data.delta.stop_sequence, 'ZZ');
  assert.ok(events(text).some((event) => event.type === 'message_stop'));
});

test('a sequence split across two deltas is still caught, and its halves never reach the client', async () => {
  // The case the hold-back exists for: without it the client reads `AAZ`
  // before the match is even found.
  const { text } = await messages(backend({ deltas: ['AA', 'Z', 'Z', 'BB'] }), { stop_sequences: ['ZZ'], stream: true });
  assert.equal(streamedText(text), 'AA');
  const delta = events(text).find((event) => event.type === 'message_delta');
  assert.equal(delta.data.delta.stop_sequence, 'ZZ');
});

test('a streamed turn whose text arrives only in the result is gated too', async () => {
  // A schema or refusal result carries no live deltas; the gate has to see the
  // result's own text before it is flushed to the client.
  const { text } = await messages(backend({ text: 'AAZZBB', deltas: [] }), { stop_sequences: ['ZZ'], stream: true });
  assert.equal(streamedText(text), 'AA');
  const delta = events(text).find((event) => event.type === 'message_delta');
  assert.equal(delta.data.delta.stop_reason, 'stop_sequence');
  assert.equal(delta.data.delta.stop_sequence, 'ZZ');
});

test('a streamed turn with no match keeps every character, held tail included', async () => {
  const { text } = await messages(backend({ text: 'AAZB', deltas: ['AA', 'Z', 'B'] }), { stop_sequences: ['ZZ'], stream: true });
  assert.equal(streamedText(text), 'AAZB');
  const delta = events(text).find((event) => event.type === 'message_delta');
  assert.equal(delta.data.delta.stop_reason, 'end_turn');
  assert.equal(delta.data.delta.stop_sequence, null);
});

test('a tool-call turn keeps tool_use as its reason, and its narration is still cut', async () => {
  const be = backend({ text: 'AAZZBB', toolCalls: [{ id: 'c1', name: 'f', arguments: '{}' }] });
  const { json } = await messages(be, { stop_sequences: ['ZZ'], tools: [{ name: 'f', input_schema: { type: 'object' } }] });
  assert.equal(json.stop_reason, 'tool_use');
  assert.equal(json.stop_sequence, null);
  assert.deepEqual(json.content.filter((block) => block.type === 'text'), [{ type: 'text', text: 'AA' }]);
});

// The validation half, measured the same day.
const REJECTIONS = [
  ['stop_sequences as a string', { stop_sequences: 'ZZ' }, 'stop_sequences: Input should be a valid array'],
  ['a non-string stop sequence', { stop_sequences: [1] }, 'stop_sequences.0: Input should be a valid string'],
  ['an unknown metadata member', { metadata: { bogus: 'x' } }, 'metadata.bogus: Extra inputs are not permitted'],
  ['a non-string metadata.user_id', { metadata: { user_id: 7 } }, 'metadata.user_id: Input should be a valid string'],
  ['an unknown service_tier', { service_tier: 'bogus' }, "service_tier: Input should be 'auto' or 'standard_only'"],
  ['an unknown inference_geo', { inference_geo: 'bogus-geo' }, "inference_geo: must be one of ['global', 'us']"],
  ['a container without the code execution tool', { container: 'container_x' }, 'container: Container identifier can only be provided when using the code execution tool'],
];

for (const [name, body, message] of REJECTIONS) {
  test(`/v1/messages rejects ${name} with the direct API's sentence`, async () => {
    const { status, json } = await messages(backend(), body);
    assert.equal(status, 400, JSON.stringify(json));
    assert.equal(json.type, 'error');
    assert.equal(json.error.type, 'invalid_request_error');
    assert.equal(json.error.message, message);
    assert.equal(json.error.param, undefined, 'the Anthropic envelope carries no param');
  });
}

test('/v1/messages accepts the values the direct API accepts and does not apply', async () => {
  const { status } = await messages(backend(), {
    stop_sequences: [], metadata: { user_id: 'probe' }, service_tier: 'standard_only', inference_geo: 'us',
  });
  assert.equal(status, 200);
});
