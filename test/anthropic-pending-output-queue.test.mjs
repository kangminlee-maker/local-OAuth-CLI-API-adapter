// The `/v1/messages` wire owes a client two things at once, and one turn shape
// used to force a choice between them:
//
//   (i)  two content blocks are never open simultaneously — a client assembling
//        by index cannot read a nested one
//   (ii) what a client accumulates from `input_json_delta` is the tool input
//        the turn actually made
//
// A tool block, once stopped, takes no more deltas. So when a call was still
// taking arguments and something else arrived, closing the unfinished block to
// keep (i) cost (ii):
//
//   unfinished call, narration, second call
//     streamed args ['{"city":', '{"city":"B"}']   <- the first is not JSON
//     buffered args ['{"city":"Seoul"}', '{"city":"B"}']
//
// and NOT closing it cost (i) — two calls in a row, neither declared final,
// nested with no narration involved at all:
//
//   unfinished call, unfinished call
//     blocks ['tool_use','tool_use']  maxOpen 2
//
// Both hold now. Anything that would need a NEW block waits in a queue while a
// call is open, the completed result reconciles that call before its block
// closes, and then the queue moves. Every case here reads the same turn twice —
// streamed and buffered — because one turn has one answer.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startLocalApiProxy } from '../dist/proxy/http-server.js';

const PARAMS = { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false };
const CALL_A = { id: 'call_a', name: 'get_weather', arguments: '{"city":"Seoul"}' };
const CALL_B = { id: 'call_b', name: 'get_weather', arguments: '{"city":"B"}' };
const CALL_C = { id: 'call_c', name: 'get_weather', arguments: '{"city":"C"}' };
const TOOLS = [{ name: 'get_weather', description: 'w', input_schema: PARAMS }];
const JSON_HEADERS = { 'content-type': 'application/json' };
const HEADERS = { ...JSON_HEADERS, 'x-api-key': 'local', 'anthropic-version': '2023-06-01' };

/** A delta the backend does NOT declare final — the reconcile-at-`completed` path. */
const partial = (index, call, chars = 8) => ({
  type: 'tool_call_delta', index, id: call.id, name: call.name,
  argumentsDelta: call.arguments.slice(0, chars),
});
/** The same call, declared final on the wire — nothing left to reconcile. */
const whole = (index, call) => ({
  type: 'tool_call_delta', index, id: call.id, name: call.name,
  argumentsDelta: call.arguments, argumentsDone: true,
});
/** The REST of a call's arguments, declared final — an interrupted call resuming. */
const resume = (index, call, chars = 8) => ({
  type: 'tool_call_delta', index, id: call.id, name: call.name,
  argumentsDelta: call.arguments.slice(chars), argumentsDone: true,
});
const say = (delta) => ({ type: 'text_delta', delta });

function backendFor({ steps, text = '', toolCalls = [], textOrdinal, ends = 'completed' }) {
  const result = {
    id: 'x', model: 'configured-model', text, toolCalls,
    ...(textOrdinal === undefined ? {} : { textOrdinal }),
    usage: { inputTokens: 1, outputTokens: 1, source: 'estimated' }, latencyMs: 1,
  };
  return {
    name: 'test', model: 'configured-model',
    async generate() {
      if (ends !== 'completed') throw new Error('this case is about the stream');
      return result;
    },
    async *stream() {
      for (const step of steps) yield step;
      if (ends === 'completed') { yield { type: 'completed', result }; return; }
      if (ends === 'throw') throw new Error('mid-stream boom');
    },
    async close() {},
  };
}

const sseFrames = (wire) => wire.split('\n')
  .filter((line) => line.startsWith('event: ')).map((line) => line.slice(7).trim());
const sseEvents = (wire) => wire.split('\n')
  .filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim())
  .filter((data) => data && data !== '[DONE]').map((data) => JSON.parse(data));

/**
 * Block accounting for one streamed turn. `maxOpen` is what says the wire never
 * nested; deltas are accumulated PER BLOCK, because joining them across blocks
 * would splice two calls' arguments together and report a defect that is not
 * there.
 */
function blockReading(events) {
  const blocks = new Map();
  const order = [];
  const stopped = new Set();
  const deltasAfterStop = [];
  let open = 0;
  let maxOpen = 0;
  for (const event of events) {
    if (event.type === 'content_block_start') {
      open += 1;
      maxOpen = Math.max(maxOpen, open);
      blocks.set(event.index, { index: event.index, type: event.content_block?.type, accumulated: '', deltas: 0 });
      order.push(event.index);
    }
    if (event.type === 'content_block_stop') { open -= 1; stopped.add(event.index); }
    if (event.type === 'content_block_delta') {
      // A block a client has already finalized. What lands here does not
      // extend anything — it appends to a value the client closed, which is
      // how an accumulator came to hold JSON that no longer parses.
      if (stopped.has(event.index)) deltasAfterStop.push(event.index);
      const block = blocks.get(event.index);
      if (!block) continue;
      block.accumulated += event.delta?.partial_json ?? event.delta?.text ?? '';
      if (event.delta?.type === 'input_json_delta') block.deltas += 1;
    }
  }
  const list = order.map((index) => blocks.get(index));
  return {
    maxOpen,
    leftOpen: open,
    deltasAfterStop,
    blocks: list,
    types: list.map((b) => b.type),
    toolArguments: list.filter((b) => b.type === 'tool_use').map((b) => b.accumulated),
    argumentDeltas: list.filter((b) => b.type === 'tool_use').map((b) => b.deltas),
    text: list.filter((b) => b.type === 'text').map((b) => b.accumulated),
  };
}

/** One turn, streamed and buffered through the same proxy. */
async function readings(backend, stopSequences) {
  const server = await startLocalApiProxy({ backend, host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000 });
  const body = (extra) => JSON.stringify({
    model: 'm', max_tokens: 64, tools: TOOLS, messages: [{ role: 'user', content: 'ping' }],
    ...(stopSequences ? { stop_sequences: stopSequences } : {}),
    ...extra,
  });
  try {
    const wire = await (await fetch(`${server.url}/v1/messages`, { method: 'POST', headers: HEADERS, body: body({ stream: true }) })).text();
    const buffered = await (await fetch(`${server.url}/v1/messages`, { method: 'POST', headers: HEADERS, body: body({}) })).json();
    return {
      ...blockReading(sseEvents(wire)),
      frames: sseFrames(wire),
      bufferedTypes: buffered.content?.map((c) => c.type) ?? [],
      bufferedInputs: buffered.content?.filter((c) => c.type === 'tool_use').map((c) => c.input) ?? [],
      bufferedText: buffered.content?.filter((c) => c.type === 'text').map((c) => c.text) ?? [],
    };
  } finally { await server.close(); }
}

/** The streamed reading only — for turns that never produce a finished result. */
async function streamOnly(backend) {
  const server = await startLocalApiProxy({ backend, host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000 });
  try {
    const wire = await (await fetch(`${server.url}/v1/messages`, {
      method: 'POST', headers: HEADERS,
      body: JSON.stringify({ model: 'm', max_tokens: 64, stream: true, tools: TOOLS, messages: [{ role: 'user', content: 'ping' }] }),
    })).text();
    return { ...blockReading(sseEvents(wire)), frames: sseFrames(wire) };
  } finally { await server.close(); }
}

/** The wire's own shape rules, asserted the same way for every turn. */
function assertWireShape(r, types, label) {
  assert.equal(r.maxOpen, 1, `${label}: two content blocks open at once — ${JSON.stringify(r.blocks.map((b) => [b.index, b.type]))}`);
  assert.equal(r.leftOpen, 0, `${label}: a block was left open`);
  assert.deepEqual(r.deltasAfterStop, [], `${label}: a delta was written past a block's content_block_stop`);
  assert.deepEqual(r.types, types, `${label}: production order`);
}

/** One turn, one answer: what the client accumulates is what the body reports. */
function assertReadingsAgree(r, label) {
  assert.deepEqual(r.types, r.bufferedTypes, `${label}: the two readings disagree about the blocks`);
  for (const [i, streamed] of r.toolArguments.entries()) {
    assert.deepEqual(JSON.parse(streamed), r.bufferedInputs[i], `${label}: call ${i} streamed ${streamed}`);
  }
  assert.deepEqual(r.text, r.bufferedText, `${label}: the two readings disagree about the text`);
}

test('a call interrupted by narration still carries the input the turn made', async () => {
  // F1. The narration and the second call both need a block of their own, and
  // the first call has not said where its arguments end — so both wait, and
  // `completed` writes the rest of `{"city":"Seoul"}` into the open block
  // BEFORE it stops. Closing that block to make room is what streamed
  // `{"city":` as a whole tool input.
  const r = await readings(backendFor({
    steps: [partial(0, CALL_A), say('narration'), whole(1, CALL_B)],
    toolCalls: [CALL_A, CALL_B], text: 'narration', textOrdinal: 1,
  }));
  assertWireShape(r, ['tool_use', 'text', 'tool_use'], 'unfinished call, narration, second call');
  assert.deepEqual(r.toolArguments, [CALL_A.arguments, CALL_B.arguments], 'both calls carry their whole input');
  assert.deepEqual(JSON.parse(r.toolArguments[0]), { city: 'Seoul' }, 'and the interrupted one parses');
  assert.deepEqual(r.text, ['narration'], 'the narration is written once, after the call it interrupted');
  assert.deepEqual(r.argumentDeltas, [2, 1], 'the interrupted call takes a second delta; the finished one does not');
  assertReadingsAgree(r, 'unfinished call, narration, second call');
});

test('CONTROL: the same turn with the first call declared final', async () => {
  // The opposite expected answer for the reconciliation: nothing was left
  // open, so nothing is reconciled and one delta carries each value.
  const r = await readings(backendFor({
    steps: [whole(0, CALL_A), say('narration'), whole(1, CALL_B)],
    toolCalls: [CALL_A, CALL_B], text: 'narration', textOrdinal: 1,
  }));
  assertWireShape(r, ['tool_use', 'text', 'tool_use'], 'finished call, narration, finished call');
  assert.deepEqual(r.toolArguments, [CALL_A.arguments, CALL_B.arguments]);
  assert.deepEqual(r.argumentDeltas, [1, 1], 'a call declared final takes exactly one arguments delta');
  assertReadingsAgree(r, 'finished call, narration, finished call');
});

test('the rest of an interrupted call\'s arguments still reach its open block', async () => {
  // The queue holds the narration, and then the SAME call sends more. That
  // delta belongs in a block the wire is still holding open for it, ahead of
  // everything waiting — queueing it behind the narration would deadlock both
  // until `completed` and then write it into a stopped block.
  const rest = { type: 'tool_call_delta', index: 0, id: CALL_A.id, name: CALL_A.name, argumentsDelta: CALL_A.arguments.slice(8), argumentsDone: true };
  const r = await readings(backendFor({
    steps: [partial(0, CALL_A), say('narration'), rest],
    toolCalls: [CALL_A], text: 'narration', textOrdinal: 1,
  }));
  assertWireShape(r, ['tool_use', 'text'], 'unfinished call, narration, the rest of the same call');
  assert.deepEqual(r.toolArguments, [CALL_A.arguments], 'the whole input, in one block');
  assert.deepEqual(r.argumentDeltas, [2], 'both deltas landed in it — the second was never reconciled in');
  assert.deepEqual(r.text, ['narration'], 'and the narration follows the call that finished');
  assertReadingsAgree(r, 'unfinished call, narration, the rest of the same call');
});

test('CONTROL: narration after a call that already declared its arguments final', async () => {
  // The opposite expected answer: nothing is open, so the narration never
  // waits and the block is never extended.
  const r = await readings(backendFor({
    steps: [whole(0, CALL_A), say('narration')], toolCalls: [CALL_A], text: 'narration', textOrdinal: 1,
  }));
  assertWireShape(r, ['tool_use', 'text'], 'finished call, then narration');
  assert.deepEqual(r.argumentDeltas, [1], 'one delta carried the whole value');
  assertReadingsAgree(r, 'finished call, then narration');
});

test('a second call still taking arguments does not open inside the first', async () => {
  // F2. No narration anywhere: two calls back to back, neither declared final,
  // nested block inside block. Nothing about the text was ever involved.
  const r = await readings(backendFor({
    steps: [partial(0, CALL_A), partial(1, CALL_B)], toolCalls: [CALL_A, CALL_B],
  }));
  assertWireShape(r, ['tool_use', 'tool_use'], 'two unfinished calls in a row');
  assert.deepEqual(r.toolArguments, [CALL_A.arguments, CALL_B.arguments], 'and both are reconciled in full');
  assert.deepEqual(r.argumentDeltas, [2, 2], 'each takes its streamed prefix and its reconciled tail');
  assertReadingsAgree(r, 'two unfinished calls in a row');
});

test('CONTROL: two calls the backend declared final', async () => {
  const r = await readings(backendFor({
    steps: [whole(0, CALL_A), whole(1, CALL_B)], toolCalls: [CALL_A, CALL_B],
  }));
  assertWireShape(r, ['tool_use', 'tool_use'], 'two finished calls in a row');
  assert.deepEqual(r.toolArguments, [CALL_A.arguments, CALL_B.arguments]);
  assert.deepEqual(r.argumentDeltas, [1, 1], 'nothing to reconcile');
  assertReadingsAgree(r, 'two finished calls in a row');
});

test('three calls in a row, none of them finished, still take one block at a time', async () => {
  // The queue releases one call, which is itself unfinished, so the rest keeps
  // waiting: settling has to repeat, not run once.
  const r = await readings(backendFor({
    steps: [partial(0, CALL_A), partial(1, CALL_B), partial(2, CALL_C, 1)],
    toolCalls: [CALL_A, CALL_B, CALL_C],
  }));
  assertWireShape(r, ['tool_use', 'tool_use', 'tool_use'], 'three unfinished calls');
  assert.deepEqual(r.toolArguments, [CALL_A.arguments, CALL_B.arguments, CALL_C.arguments]);
  assert.deepEqual(r.argumentDeltas, [2, 2, 2]);
  assertReadingsAgree(r, 'three unfinished calls');
});

test('CONTROL: three calls the backend declared final', async () => {
  const r = await readings(backendFor({
    steps: [whole(0, CALL_A), whole(1, CALL_B), whole(2, CALL_C)],
    toolCalls: [CALL_A, CALL_B, CALL_C],
  }));
  assertWireShape(r, ['tool_use', 'tool_use', 'tool_use'], 'three finished calls');
  assert.deepEqual(r.argumentDeltas, [1, 1, 1]);
  assertReadingsAgree(r, 'three finished calls');
});

// A call still taking arguments, and text the stop-sequence gate holds back
// until a later delta rules the sequence out. Two holders on one turn.
const GATED_TURN = {
  steps: [partial(0, CALL_A), say('Do'), say('gs')],
  toolCalls: [CALL_A], text: 'Dogs', textOrdinal: 1,
};

test('a stop-gated release still waits for the call that was taking arguments', async () => {
  const r = await readings(backendFor(GATED_TURN), ['Done']);
  assertWireShape(r, ['tool_use', 'text'], "unfinished call, text held by ['Done']");
  assert.deepEqual(r.toolArguments, [CALL_A.arguments], 'the call keeps its whole input');
  assert.deepEqual(r.text, ['Dogs'], 'and the released text takes one block behind it');
  assertReadingsAgree(r, "unfinished call, text held by ['Done']");
});

test('CONTROL: the same turn with a sequence that eats ALL of its text', async () => {
  // The opposite expected answer: the text never reaches the wire, so it opens
  // no block at all — and the call it was waiting on still carries its input.
  const r = await readings(backendFor(GATED_TURN), ['Dogs']);
  assertWireShape(r, ['tool_use'], "unfinished call, text eaten by ['Dogs']");
  assert.deepEqual(r.toolArguments, [CALL_A.arguments], 'the eaten text costs the call nothing');
  assert.deepEqual(r.text, [], 'and no stray empty text block');
  assertReadingsAgree(r, "unfinished call, text eaten by ['Dogs']");
});

test('CONTROL: the same turn with no stop sequence at all', async () => {
  const r = await readings(backendFor(GATED_TURN));
  assertWireShape(r, ['tool_use', 'text'], 'unfinished call, ungated text');
  assert.deepEqual(r.toolArguments, [CALL_A.arguments]);
  assert.deepEqual(r.text, ['Dogs']);
  assertReadingsAgree(r, 'unfinished call, ungated text');
});

test('a call the stream announced and one only the result carries split around the text', async () => {
  // `textOrdinal` on a turn that is half streamed and half delivered at
  // `completed`: the announced call is reconciled and closed, the text takes
  // the ordinal, and the call that was never announced opens behind it.
  const r = await readings(backendFor({
    steps: [partial(0, CALL_A)], toolCalls: [CALL_A, CALL_B], text: 'narration', textOrdinal: 1,
  }));
  assertWireShape(r, ['tool_use', 'text', 'tool_use'], 'announced call, text at ordinal 1, completion-only call');
  assert.deepEqual(r.toolArguments, [CALL_A.arguments, CALL_B.arguments]);
  assert.deepEqual(r.text, ['narration']);
  assertReadingsAgree(r, 'announced call, text at ordinal 1, completion-only call');
});

test('CONTROL: the same turn with the text reported after both calls', async () => {
  const r = await readings(backendFor({
    steps: [partial(0, CALL_A)], toolCalls: [CALL_A, CALL_B], text: 'narration', textOrdinal: 2,
  }));
  assertWireShape(r, ['tool_use', 'tool_use', 'text'], 'announced call, completion-only call, text last');
  assert.deepEqual(r.toolArguments, [CALL_A.arguments, CALL_B.arguments]);
  assertReadingsAgree(r, 'announced call, completion-only call, text last');
});

// Both calls wait behind the gate's slot, so NEITHER is announced when the
// result arrives — and the result puts the text between them.
const QUEUED_PAIR = {
  steps: [say('BETWEEN'), whole(0, CALL_A), whole(1, CALL_B)],
  toolCalls: [CALL_A, CALL_B], text: 'BETWEEN', textOrdinal: 1,
};

test('the text still lands AT its ordinal when the calls around it were all queued', async () => {
  // Releasing the whole queue first and then writing the text put both calls
  // ahead of it — [tool_use, tool_use, text] against a buffered [tool_use,
  // text, tool_use]. The queue stops at the ordinal instead.
  const r = await readings(backendFor(QUEUED_PAIR), ['BETWEENZ']);
  assertWireShape(r, ['tool_use', 'text', 'tool_use'], "two queued calls, text at ordinal 1, held by ['BETWEENZ']");
  assert.deepEqual(r.text, ['BETWEEN'], 'the held text is released, not dropped');
  assert.deepEqual(r.toolArguments, [CALL_A.arguments, CALL_B.arguments]);
  assertReadingsAgree(r, "two queued calls, text at ordinal 1, held by ['BETWEENZ']");
});

test('CONTROL: the same queued pair with the text reported before both calls', async () => {
  // The opposite expected answer for the same queue: ordinal 0 puts the text
  // first, so nothing may be released ahead of it.
  const r = await readings(backendFor({ ...QUEUED_PAIR, textOrdinal: 0 }), ['BETWEENZ']);
  assertWireShape(r, ['text', 'tool_use', 'tool_use'], "two queued calls, text at ordinal 0, held by ['BETWEENZ']");
  assert.deepEqual(r.text, ['BETWEEN']);
  assertReadingsAgree(r, "two queued calls, text at ordinal 0, held by ['BETWEENZ']");
});

test('a turn that just ends releases everything the queue was holding', async () => {
  // No `completed` event ever arrives, so there is no value to reconcile the
  // open call from — it closes on what it streamed. What waited behind it is
  // work the backend really did, and still reaches the wire.
  const r = await streamOnly(backendFor({
    steps: [partial(0, CALL_A), say('narration'), whole(1, CALL_B)], ends: 'return',
  }));
  assertWireShape(r, ['tool_use', 'text', 'tool_use'], 'unfinished call, narration, call, then EOF');
  assert.deepEqual(r.text, ['narration'], 'the queued narration is not dropped');
  assert.deepEqual(r.toolArguments, [CALL_A.arguments.slice(0, 8), CALL_B.arguments],
    'and the interrupted call carries what it streamed — no result exists to complete it from');
});

test('CONTROL: the same turn that reaches `completed` completes that call', async () => {
  // The opposite expected answer for the same first block: a turn WITH a
  // result reconciles it, which is what makes the reading above the absence of
  // a value rather than a truncation.
  const r = await readings(backendFor({
    steps: [partial(0, CALL_A), say('narration'), whole(1, CALL_B)],
    toolCalls: [CALL_A, CALL_B], text: 'narration', textOrdinal: 1,
  }));
  assert.deepEqual(r.toolArguments, [CALL_A.arguments, CALL_B.arguments]);
});

test('a turn that fails mid-stream writes the queue before the error frame', async () => {
  const r = await streamOnly(backendFor({
    steps: [partial(0, CALL_A), say('narration'), whole(1, CALL_B)], ends: 'throw',
  }));
  assertWireShape(r, ['tool_use', 'text', 'tool_use'], 'unfinished call, narration, call, then a throw');
  assert.deepEqual(r.text, ['narration'], 'work the backend already did is still the client\'s');
  assert.equal(r.frames.at(-1), 'error', 'and the error frame is the last thing on the wire');
  assert.equal(r.frames.filter((f) => f === 'error').length, 1, 'written exactly once');
});

test('CONTROL: a failure with nothing queued writes the error frame alone', async () => {
  const r = await streamOnly(backendFor({ steps: [], ends: 'throw' }));
  assert.deepEqual(r.frames, ['message_start', 'error'], 'nothing was produced, so nothing is released');
  assert.deepEqual(r.types, [], 'and no content block is opened');
});

// The writer refuses to extend a block that already closed.
//
// These turns are hand-built and no shipped backend emits one. The codex
// transport already refuses to forward a delta for a call it declared finished,
// and upstream streams measured for this repo open one `function_call` item at
// a time, so no call's deltas resume after another call's block has opened. A
// `LocalStreamEvent` sequence can express both orders, and the queue states the
// invariant about itself — a stopped block takes no more deltas — so these
// cases hold it to that rather than reproducing a failure clients are seeing.
//
// The queue advances by CLOSING the open call: a call still taking arguments
// blocks everything behind it, so settling reconciles it from the result and
// stops its block to let the queue move. A delta for that same call sitting
// further back in the queue therefore reaches the front addressing a block the
// wire has already stopped — its value long since reconciled in. Extending it
// there would append past the `content_block_stop`:
//
//   three calls opened with partial arguments, then the middle one resumes
//     streamed args ['{"city":"Seoul"}', '{"city":"B"}"B"}', '{"city":"C"}']
//     buffered args ['{"city":"Seoul"}', '{"city":"B"}',     '{"city":"C"}']
//
// What a client makes of that depends on how it accumulates: one that sums
// every `input_json_delta` holds JSON that no longer parses, while one that
// finalizes the block at `content_block_stop` ignores the extra delta and reads
// correctly. On a turn with no completed result the two swap — the summing
// client assembles the whole value from the late delta, the finalizing one
// keeps the prefix the block closed on. Refusing the write is what gives both
// the same value, and the case below the controls says what that costs.
//
// Every case here reads the turn twice, so the streamed accumulation is pinned
// against the value the body reports.
const RESUMED = [
  ['[P0 P1 P2 R1] three partial calls, the middle one resumes',
   [partial(0, CALL_A), partial(1, CALL_B), partial(2, CALL_C), resume(1, CALL_B)], [2, 2, 2]],
  ['[P0 P1 W2 R1] the last call is declared final before the middle one resumes',
   [partial(0, CALL_A), partial(1, CALL_B), whole(2, CALL_C), resume(1, CALL_B)], [2, 2, 1]],
  ['[P0 W1 P2 R1] the middle call is declared final and then resumes anyway',
   [partial(0, CALL_A), whole(1, CALL_B), partial(2, CALL_C), resume(1, CALL_B)], [2, 1, 2]],
];

for (const [label, steps, argumentDeltas] of RESUMED) {
  test(`the writer refuses to extend a block that already closed: ${label}`, async () => {
    const r = await readings(backendFor({ steps, toolCalls: [CALL_A, CALL_B, CALL_C] }));
    assertWireShape(r, ['tool_use', 'tool_use', 'tool_use'], label);
    assert.deepEqual(r.toolArguments, [CALL_A.arguments, CALL_B.arguments, CALL_C.arguments],
      `${label}: every call carries exactly its input`);
    assert.deepEqual(r.argumentDeltas, argumentDeltas,
      `${label}: the resumed delta added nothing to an already-reconciled block`);
    assertReadingsAgree(r, label);
  });
}

test('CONTROL: a call resumes while its own block is still OPEN', async () => {
  // The opposite expected answer: this delta is the one legitimate way the
  // rest of an interrupted call reaches a client, and dropping it is the
  // over-broad fix. Nothing was closed in between — the second call is still
  // queued behind it — so it extends the block it was streamed for.
  const label = '[P0 P1 R0] the FIRST call resumes, before anything closed it';
  const r = await readings(backendFor({
    steps: [partial(0, CALL_A), partial(1, CALL_B), resume(0, CALL_A)],
    toolCalls: [CALL_A, CALL_B],
  }));
  assertWireShape(r, ['tool_use', 'tool_use'], label);
  assert.deepEqual(r.toolArguments, [CALL_A.arguments, CALL_B.arguments]);
  assert.deepEqual(r.argumentDeltas, [2, 2], `${label}: the resume landed in the open block`);
  assertReadingsAgree(r, label);
});

test('CONTROL: the same resume is the ONLY source of that value when no result arrives', async () => {
  // The control above cannot tell a delivered resume from a dropped one that
  // `completed` reconciled back in. This turn has no result to reconcile from,
  // so the first call's whole input exists on the wire only if its resume was
  // really written into the open block.
  const r = await streamOnly(backendFor({
    steps: [partial(0, CALL_A), partial(1, CALL_B), resume(0, CALL_A)], ends: 'return',
  }));
  assertWireShape(r, ['tool_use', 'tool_use'], '[P0 P1 R0] then EOF');
  assert.deepEqual(r.toolArguments, [CALL_A.arguments, CALL_B.arguments.slice(0, 8)],
    'the resumed call is whole from its own deltas; the one that never resumed is not');
  assert.deepEqual(r.argumentDeltas, [2, 1], 'two deltas reached the first block, one the second');
});

test('CONTROL: three partial calls where the FIRST one resumes', async () => {
  // The same three-call queue as the defect cases, resuming the call whose
  // block is open rather than one already closed behind it.
  const label = '[P0 P1 P2 R0] three partial calls, the first one resumes';
  const r = await readings(backendFor({
    steps: [partial(0, CALL_A), partial(1, CALL_B), partial(2, CALL_C), resume(0, CALL_A)],
    toolCalls: [CALL_A, CALL_B, CALL_C],
  }));
  assertWireShape(r, ['tool_use', 'tool_use', 'tool_use'], label);
  assert.deepEqual(r.toolArguments, [CALL_A.arguments, CALL_B.arguments, CALL_C.arguments]);
  assert.deepEqual(r.argumentDeltas, [2, 2, 2], `${label}: each block took its prefix and one tail`);
  assertReadingsAgree(r, label);
});

test('CONTROL: three partial calls and no resume at all', async () => {
  // Nothing resumes, so nothing can be dropped: the baseline the three defect
  // cases are measured against.
  const label = '[P0 P1 P2] three partial calls, none of them resumes';
  const r = await readings(backendFor({
    steps: [partial(0, CALL_A), partial(1, CALL_B), partial(2, CALL_C)],
    toolCalls: [CALL_A, CALL_B, CALL_C],
  }));
  assertWireShape(r, ['tool_use', 'tool_use', 'tool_use'], label);
  assert.deepEqual(r.toolArguments, [CALL_A.arguments, CALL_B.arguments, CALL_C.arguments]);
  assert.deepEqual(r.argumentDeltas, [2, 2, 2]);
  assertReadingsAgree(r, label);
});

test('what refusing costs: a block closed with nothing to reconcile from keeps its prefix', async () => {
  // The same three-call interleave on a turn that never reaches `completed`.
  // Nothing reconciles the closed blocks, so the resumed delta was the only
  // copy of the rest of that call's arguments — and it is refused anyway,
  // because the block it addresses is closed and this wire cannot reopen one.
  // The client keeps the prefix the block closed on. That is the whole cost,
  // and it is a truncation the client can see rather than a value it cannot
  // parse; the turns that DO reach `completed` lose nothing at all.
  const r = await streamOnly(backendFor({
    steps: [partial(0, CALL_A), partial(1, CALL_B), partial(2, CALL_C), resume(1, CALL_B)],
    ends: 'return',
  }));
  assertWireShape(r, ['tool_use', 'tool_use', 'tool_use'], '[P0 P1 P2 R1] then EOF');
  assert.deepEqual(r.toolArguments,
    [CALL_A.arguments.slice(0, 8), CALL_B.arguments.slice(0, 8), CALL_C.arguments.slice(0, 8)],
    'every block carries what it streamed before it was closed, and nothing after');
  assert.deepEqual(r.argumentDeltas, [1, 1, 1], 'the resumed delta reached no block');
});
