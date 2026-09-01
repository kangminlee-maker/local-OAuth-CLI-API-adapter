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

test('the gate never commits a match a later delta could beat', () => {
  // Found by review: `["abc","ab"]` over `Xab` + `cY` committed `ab` on the
  // stream while the buffered path answered `abc` — the same turn reporting a
  // different `stop_sequence` depending on how the caller read it.
  const gate = new StopSequenceGate(['abc', 'ab']);
  assert.equal(gate.push('Xab'), 'X', 'ab matches, but abc is listed first and still possible');
  assert.equal(gate.stopped, null);
  assert.equal(gate.push('cY'), '');
  assert.equal(gate.stopped, 'abc');
  assert.deepEqual(truncateAtStopSequence('XabcY', ['abc', 'ab']), { text: 'X', sequence: 'abc' });
});

test('a shorter sequence that starts earlier still wins as it arrives', () => {
  // The mirror case: nothing pending beats it, so it commits immediately.
  const gate = new StopSequenceGate(['abcd', 'c']);
  assert.equal(gate.push('abc'), '', 'c matched at 2, but abcd could still match at 0 — nothing is safe yet');
  assert.equal(gate.stopped, null);
  assert.equal(gate.push('d'), '');
  assert.equal(gate.stopped, 'abcd');
  // And when the turn ends before `abcd` completes, the deferred `c` is the
  // answer after all — the flush is what resolves it.
  const ended = new StopSequenceGate(['abcd', 'c']);
  assert.equal(ended.push('abc'), '');
  assert.equal(ended.flush(), 'ab');
  assert.equal(ended.stopped, 'c');
});

test('the stream and the buffer agree on every split of every case', () => {
  // The property the two paths owe each other. Exhaustive over a small
  // alphabet: every text of length <= 5 over {a,b,c}, every split into deltas,
  // against sequence sets chosen for overlap, prefixes and ties.
  const SEQUENCE_SETS = [['ab'], ['abc', 'ab'], ['ab', 'abc'], ['abcd', 'c'], ['a', 'ab'], ['ab', 'ba'], ['aa', 'a'], ['b', 'ab', 'aab']];
  const texts = [''];
  for (let length = 1; length <= 5; length += 1) {
    for (const text of texts.filter((candidate) => candidate.length === length - 1)) {
      for (const letter of 'abc') texts.push(text + letter);
    }
  }
  const splits = (text) => {
    if (text.length === 0) return [[]];
    const out = [];
    for (let cut = 1; cut <= text.length; cut += 1) {
      for (const rest of splits(text.slice(cut))) out.push([text.slice(0, cut), ...rest]);
    }
    return out;
  };
  let checked = 0;
  for (const sequences of SEQUENCE_SETS) {
    for (const text of texts) {
      const expected = truncateAtStopSequence(text, sequences);
      for (const deltas of splits(text)) {
        const gate = new StopSequenceGate(sequences);
        let streamed = '';
        for (const delta of deltas) streamed += gate.push(delta);
        streamed += gate.flush();
        checked += 1;
        assert.deepEqual(
          { text: streamed, sequence: gate.stopped },
          expected,
          `${JSON.stringify(sequences)} over ${JSON.stringify(deltas)}`,
        );
      }
    }
  }
  assert.ok(checked > 5000, `the enumeration must actually run: ${checked} cases`);
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

test('a tool-first turn streams its blocks in production order, not text first', async () => {
  // The streamed and buffered readings of ONE turn have to agree. A completion
  // -only result that says its tools came before any text was answered
  // [text, tool_use] on the wire and [tool_use, text] in the body.
  const result = {
    id: 'x', model: 'configured-model', text: 'AAZZBB',
    toolCalls: [{ id: 'c1', name: 'f', arguments: '{"a":1}' }],
    textOrdinal: 1,
    usage: { inputTokens: 20, outputTokens: 4, source: 'provider' }, latencyMs: 1,
  };
  const be = {
    name: 'test', model: 'configured-model',
    async generate() { return result; },
    async *stream() { yield { type: 'completed', result }; },
    async close() {},
  };
  const streamed = await messages(be, { stop_sequences: ['ZZ'], stream: true, tools: [{ name: 'f', input_schema: { type: 'object' } }] });
  const opened = events(streamed.text)
    .filter((event) => event.type === 'content_block_start')
    .map((event) => event.data.content_block.type);
  assert.deepEqual(opened, ['tool_use', 'text'], 'the wire reports the tools first');
  const buffered = await messages(be, { stop_sequences: ['ZZ'], tools: [{ name: 'f', input_schema: { type: 'object' } }] });
  assert.deepEqual(buffered.json.content.map((block) => block.type), opened, 'and the body reads the same turn the same way');
  assert.deepEqual(streamedText(streamed.text), 'AA', 'the narration is still cut at the sequence');
});

test('no content block ever opens inside another', async () => {
  // A tool block whose arguments the backend never declares finished stays
  // open; the text that follows used to open at a new index inside it.
  const result = {
    id: 'x', model: 'configured-model', text: 'tail',
    toolCalls: [{ id: 'c1', name: 'f', arguments: '{"a":1}' }],
    usage: { inputTokens: 1, outputTokens: 1, source: 'provider' }, latencyMs: 1,
  };
  const be = {
    name: 'test', model: 'configured-model',
    async generate() { return result; },
    async *stream() {
      // No `argumentsDone`, so the block is left open on purpose.
      yield { type: 'tool_call_delta', index: 0, id: 'c1', name: 'f', argumentsDelta: '{"a":1}' };
      yield { type: 'completed', result };
    },
    async close() {},
  };
  const { text } = await messages(be, { stream: true, tools: [{ name: 'f', input_schema: { type: 'object' } }] });
  const open = new Set();
  const overlaps = [];
  for (const event of events(text)) {
    if (event.type === 'content_block_start') {
      if (open.size > 0) overlaps.push(`${event.data.index} opened while ${[...open].join(',')} was open`);
      open.add(event.data.index);
    }
    if (event.type === 'content_block_stop') open.delete(event.data.index);
  }
  assert.deepEqual(overlaps, []);
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
