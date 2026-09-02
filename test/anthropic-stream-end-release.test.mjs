// What `/v1/messages` owes a client when the turn ends WITHOUT a `completed`
// event — because the backend failed, or because its iterator simply returned.
//
// `stop_sequences` makes the writer hold two things back: text that is still a
// live prefix of a sequence, and the tool calls produced behind that text,
// which cannot take a wire position until the text's is settled. Only
// `completed` resolved the gate, so both paths out of the loop dropped work the
// backend had really done:
//
//   backend: text_delta 'Do' (held by ['Done']), a complete tool delta, throw
//     frames ['message_start','error'] — 0 text deltas, 0 tool blocks
//   backend: the same, then RETURN instead of throwing
//     the tool_use block only; the withheld 'Do' — which never matched —
//     disappeared
//
// The contract the writer states is "a delta that reached this writer reaches
// the wire", and `StopSequenceGate.flush()` says that when the turn ends
// "whatever is held resolves now". These tests are that contract on both exits.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startLocalApiProxy } from '../dist/proxy/http-server.js';

const PARAMS = { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false };
const CALL_A = { id: 'call_a', name: 'get_weather', arguments: '{"city":"A"}' };
const TOOLS = [{ name: 'get_weather', description: 'w', input_schema: PARAMS }];
const HEADERS = { 'content-type': 'application/json', 'x-api-key': 'local', 'anthropic-version': '2023-06-01' };

/**
 * `steps` is what the backend produces: a string is a text delta, an object is
 * a tool call delta. `fail` decides the exit — throw, or just return. Neither
 * ends with `completed`, which is the whole point.
 */
function backendThatEndsWithout({ steps, fail }) {
  return {
    name: 'test', model: 'configured-model',
    async generate() { throw new Error('this test is about the stream'); },
    async *stream() {
      for (const step of steps) {
        if (typeof step === 'string') { yield { type: 'text_delta', delta: step }; continue; }
        yield {
          type: 'tool_call_delta', index: 0, id: step.id, name: step.name,
          argumentsDelta: step.arguments, argumentsDone: true,
        };
      }
      if (fail) throw new Error('mid-stream boom');
    },
    async close() {},
  };
}

const sseFrames = (wire) => wire.split('\n')
  .filter((line) => line.startsWith('event: '))
  .map((line) => line.slice(7).trim());
const sseEvents = (wire) => wire.split('\n')
  .filter((line) => line.startsWith('data: '))
  .map((line) => line.slice(6).trim())
  .filter((data) => data && data !== '[DONE]')
  .map((data) => JSON.parse(data));

async function streamOnce(backend, stopSequences) {
  const server = await startLocalApiProxy({ backend, host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000 });
  try {
    const res = await fetch(`${server.url}/v1/messages`, {
      method: 'POST', headers: HEADERS,
      body: JSON.stringify({
        model: 'm', max_tokens: 64, stream: true, tools: TOOLS,
        messages: [{ role: 'user', content: 'ping' }],
        ...(stopSequences ? { stop_sequences: stopSequences } : {}),
      }),
    });
    const wire = await res.text();
    const events = sseEvents(wire);
    const starts = events.filter((e) => e.type === 'content_block_start');
    return {
      status: res.status,
      frames: sseFrames(wire),
      blocks: starts.map((e) => e.content_block?.type),
      blockIndices: starts.map((e) => e.index),
      stops: events.filter((e) => e.type === 'content_block_stop').map((e) => e.index),
      text: events
        .filter((e) => e.type === 'content_block_delta' && e.delta?.type === 'text_delta')
        .map((e) => e.delta.text).join(''),
      toolArguments: events
        .filter((e) => e.type === 'content_block_delta' && e.delta?.type === 'input_json_delta')
        .map((e) => e.delta.partial_json).join(''),
      toolNames: starts.filter((e) => e.content_block?.type === 'tool_use').map((e) => e.content_block.name),
    };
  } finally { await server.close(); }
}

// The turn that produced text the gate was still holding, plus a call waiting
// behind it, and then failed. Both are work the backend really did.
const HELD_THEN_TOOL = ['Do', CALL_A];

test('a mid-stream failure still puts the gated text and the held call on the wire', async () => {
  const s = await streamOnce(backendThatEndsWithout({ steps: HELD_THEN_TOOL, fail: true }), ['Done']);
  assert.equal(s.status, 200, 'headers were committed by message_start');
  assert.equal(s.text, 'Do', '"Do" is not "Done" — nothing matched, so the text is the caller\'s');
  assert.deepEqual(s.blocks, ['text', 'tool_use'], 'text first: it was produced first');
  assert.deepEqual(s.toolNames, ['get_weather'], 'and the call the client was never told about');
  assert.equal(s.toolArguments, CALL_A.arguments, 'with the arguments the backend sent');
});

test('a mid-stream failure closes what it opened and ends on the error frame', async () => {
  const s = await streamOnce(backendThatEndsWithout({ steps: HELD_THEN_TOOL, fail: true }), ['Done']);
  assert.deepEqual(s.frames.at(-1), 'error', `the stream must end on the failure: ${s.frames.join(',')}`);
  assert.ok(!s.frames.includes('message_stop'), `a failed turn must not report a normal stop: ${s.frames.join(',')}`);
  assert.deepEqual(s.stops, s.blockIndices, `every block opened here is closed: ${s.frames.join(',')}`);
  const errorFrame = s.frames.indexOf('error');
  assert.ok(
    s.frames.lastIndexOf('content_block_stop') < errorFrame,
    'the content the turn produced is written BEFORE the error, not after it',
  );
});

test('CONTROL: a mid-stream failure after a sequence really matched writes no text block', async () => {
  // The other half: text the gate ATE is not the caller's, so the failure path
  // may not resurrect it — the opposite expected answer on the same exit.
  const s = await streamOnce(
    backendThatEndsWithout({ steps: ['Do', CALL_A, 'ne'], fail: true }),
    ['Done'],
  );
  assert.equal(s.text, '', 'the sequence matched, so nothing before it survives');
  assert.deepEqual(s.blocks, ['tool_use'], 'and no stray empty text block is opened');
  assert.deepEqual(s.frames.at(-1), 'error');
});

test('CONTROL: a mid-stream failure with no gate at all is unchanged', async () => {
  const s = await streamOnce(backendThatEndsWithout({ steps: HELD_THEN_TOOL, fail: true }), null);
  assert.equal(s.text, 'Do', 'nothing was ever held');
  assert.deepEqual(s.blocks, ['text', 'tool_use']);
  assert.deepEqual(s.frames.at(-1), 'error');
});

test('a stream that just ends releases the text the gate was still holding', async () => {
  // `StopSequenceGate.flush()`: the turn is over, so nothing outstanding can
  // beat the non-match any more and the held text resolves to itself.
  const s = await streamOnce(backendThatEndsWithout({ steps: HELD_THEN_TOOL, fail: false }), ['Done']);
  assert.equal(s.text, 'Do', 'the withheld text never matched, so it is the caller\'s');
  assert.deepEqual(s.blocks, ['text', 'tool_use'], 'and it keeps the position it was produced at');
  assert.ok(!s.frames.includes('error'), `a clean end is not a failure: ${s.frames.join(',')}`);
});

test('a stream that just ends still writes the call that waited behind the gate', async () => {
  // The held-tool flush on the normal exit, on its own: a turn whose ONLY
  // output was held reached the client as `message_start` and nothing else.
  const s = await streamOnce(backendThatEndsWithout({ steps: HELD_THEN_TOOL, fail: false }), ['Done']);
  assert.deepEqual(s.toolNames, ['get_weather'], `the held call must reach the wire: ${s.frames.join(',')}`);
  assert.equal(s.toolArguments, CALL_A.arguments, 'with its arguments');
  assert.ok(s.frames.length > 1, `message_start alone is not the turn: ${s.frames.join(',')}`);
});

test('CONTROL: a stream that just ends after a sequence matched writes no text block', async () => {
  const s = await streamOnce(
    backendThatEndsWithout({ steps: ['Do', CALL_A, 'ne'], fail: false }),
    ['Done'],
  );
  assert.equal(s.text, '', 'the sequence matched, so nothing survives it');
  assert.deepEqual(s.blocks, ['tool_use'], 'and no stray empty text block is opened');
});

test('CONTROL: a stream that just ends with nothing held writes nothing extra', async () => {
  const s = await streamOnce(backendThatEndsWithout({ steps: [], fail: false }), ['Done']);
  assert.deepEqual(s.frames, ['message_start'], 'an empty turn stays empty');
});
