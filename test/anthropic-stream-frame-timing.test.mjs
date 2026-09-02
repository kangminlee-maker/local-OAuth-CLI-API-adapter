// WHEN a frame reaches a `/v1/messages` client, as opposed to which frames the
// turn produces.
//
// Two questions, both about the queue that holds output back until the wire can
// take it — one content block at a time, in production order:
//
//   1. Nothing may follow the terminal frames. A call the backend announced and
//      its `completed` result then did NOT report is the one block the completed
//      handler left open: `settlePending` stops an open block only to let
//      something waiting through, and on that turn nothing is waiting. The
//      release after the loop then wrote its `content_block_stop` AFTER
//      `message_delta` and `message_stop` — a frame for a message an SDK that
//      finalizes there has already closed.
//
//   2. Held output is delivered the moment the block that held it closes, not
//      at the end of the turn. The delta that carries `argumentsDone` frees the
//      queue, so the drain that follows it is what puts the narration on the
//      wire while the backend is still working. Deleting that drain changes not
//      one byte of the finished stream — the next event drains anyway — so only
//      a client reading INCREMENTALLY can tell the difference, which is exactly
//      what streaming is for.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startLocalApiProxy } from '../dist/proxy/http-server.js';

const PARAMS = { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false };
const CALL_A = { id: 'call_a', name: 'get_weather', arguments: '{"city":"Seoul"}' };
const PARTIAL = '{"city":';
const TOOLS = [{ name: 'get_weather', description: 'w', input_schema: PARAMS }];
const HEADERS = { 'content-type': 'application/json', 'x-api-key': 'local', 'anthropic-version': '2023-06-01' };
const USAGE = { inputTokens: 1, outputTokens: 1, source: 'estimated' };
const result = (over) => ({ id: 'r', model: 'm', text: '', toolCalls: [], textOrdinal: 0, usage: USAGE, latencyMs: 1, ...over });

// The call whose arguments the backend starts and never declares finished: its
// block is open, and only something else can close it.
const OPENS_A_CALL = { type: 'tool_call_delta', index: 0, id: CALL_A.id, name: CALL_A.name, argumentsDelta: PARTIAL };
const FINISHES_A_CALL = { type: 'tool_call_delta', index: 0, argumentsDelta: '"Seoul"}', argumentsDone: true };
const NARRATES = { type: 'text_delta', delta: 'narration' };

const sseFrames = (wire) => wire.split('\n')
  .filter((line) => line.startsWith('event: '))
  .map((line) => line.slice(7).trim());
const sseEvents = (wire) => wire.split('\n')
  .filter((line) => line.startsWith('data: '))
  .map((line) => line.slice(6).trim())
  .filter((data) => data && data !== '[DONE]')
  .map((data) => JSON.parse(data));

function backendOf(steps, completed) {
  return {
    name: 'test', model: 'configured-model',
    async generate() { return completed; },
    async *stream() {
      for (const step of steps) yield step;
      if (completed) yield { type: 'completed', result: completed };
    },
    async close() {},
  };
}

async function withProxy(backend, run) {
  const server = await startLocalApiProxy({ backend, host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000 });
  try { return await run(server); } finally { await server.close(); }
}

const body = (over) => JSON.stringify({
  model: 'm', max_tokens: 64, tools: TOOLS, messages: [{ role: 'user', content: 'ping' }], ...over,
});

async function streamOnce(backend) {
  return withProxy(backend, async (server) => {
    const res = await fetch(`${server.url}/v1/messages`, { method: 'POST', headers: HEADERS, body: body({ stream: true }) });
    const wire = await res.text();
    const events = sseEvents(wire);
    const starts = events.filter((e) => e.type === 'content_block_start');
    return {
      frames: sseFrames(wire),
      blocks: starts.map((e) => e.content_block?.type),
      blockIndices: starts.map((e) => e.index),
      stops: events.filter((e) => e.type === 'content_block_stop').map((e) => e.index),
      stopReason: events.find((e) => e.type === 'message_delta')?.delta?.stop_reason,
      toolArguments: events
        .filter((e) => e.type === 'content_block_delta' && e.delta?.type === 'input_json_delta')
        .map((e) => e.delta.partial_json).join(''),
    };
  });
}

async function bufferedOnce(backend) {
  return withProxy(backend, async (server) => {
    const res = await fetch(`${server.url}/v1/messages`, { method: 'POST', headers: HEADERS, body: body({}) });
    return res.json();
  });
}

// --- 1. nothing after the terminal frames ------------------------------------

// A backend that announces a call and then reports a turn without it. No
// shipped backend does this — the codex transport can never report fewer calls
// than it announced — so this is the writer's own contract, held against an
// input it must not be able to mishandle.
const DISCLAIMED = [OPENS_A_CALL];
const NO_CALLS = result({});
const REPORTS_THE_CALL = result({ toolCalls: [CALL_A] });

test('a completed turn writes nothing after message_stop', async () => {
  const s = await streamOnce(backendOf(DISCLAIMED, NO_CALLS));
  // The denominator: this says nothing unless a block really opened and the
  // turn really terminated.
  assert.deepEqual(s.blocks, ['tool_use'], `the announced call took a block: ${s.frames.join(',')}`);
  assert.equal(s.frames.filter((f) => f === 'message_stop').length, 1, `one terminal frame: ${s.frames.join(',')}`);
  assert.equal(s.frames.at(-1), 'message_stop', `the turn must END there: ${s.frames.join(',')}`);
  assert.ok(
    s.frames.lastIndexOf('content_block_stop') < s.frames.indexOf('message_delta'),
    `every content frame belongs to the message, so it precedes message_delta: ${s.frames.join(',')}`,
  );
  assert.deepEqual(s.stops, s.blockIndices, `and the block is closed, not merely left behind: ${s.frames.join(',')}`);
});

test('a call the completed result does not report is closed on exactly what was streamed', async () => {
  // What the wire owes for a call the backend announced and the result then
  // disclaims. The result is the turn's authority: it reports no call, so the
  // stop reason is the one the buffered body gives the same result, and the
  // wire invents no argument bytes to make the block look finished. The block
  // itself was announced before the result existed and cannot be retracted on
  // this wire, so it is closed on the bytes the backend actually sent.
  const s = await streamOnce(backendOf(DISCLAIMED, NO_CALLS));
  assert.equal(s.toolArguments, PARTIAL, 'exactly the streamed bytes — nothing completed, nothing invented');
  assert.equal(s.stopReason, 'end_turn', 'the result reports no call, so neither does the stop reason');
  const buffered = await bufferedOnce(backendOf(DISCLAIMED, NO_CALLS));
  assert.deepEqual(
    (buffered.content ?? []).filter((block) => block.type === 'tool_use'),
    [],
    'and the buffered body reports the same result the same way: no call',
  );
  assert.equal(buffered.stop_reason, 'end_turn', 'both readings answer the result, not the announcement');
});

test('CONTROL: a call the completed result DOES report is completed from it', async () => {
  // The opposite answer on the same readings, from the same partial delta: the
  // result carries the call, so the wire finishes the value and both readings
  // report it.
  const s = await streamOnce(backendOf(DISCLAIMED, REPORTS_THE_CALL));
  assert.equal(s.toolArguments, CALL_A.arguments, 'the rest of the value goes in before the stop');
  assert.notEqual(s.toolArguments, PARTIAL);
  assert.equal(s.stopReason, 'tool_use');
  assert.equal(s.frames.at(-1), 'message_stop', `still nothing after the terminal frame: ${s.frames.join(',')}`);
  const buffered = await bufferedOnce(backendOf(DISCLAIMED, REPORTS_THE_CALL));
  assert.deepEqual(
    (buffered.content ?? []).filter((block) => block.type === 'tool_use').map((block) => JSON.stringify(block.input)),
    [CALL_A.arguments],
    'and the buffered body carries the same arguments the stream did',
  );
});


// --- 2. held output is delivered as soon as the block frees -------------------
//
// A CAUSAL question, and it used to be asked with a clock: the test sampled the
// wire for up to 3s and called the sample "during the pause", so a runner busy
// enough to be judged before the frame was even scheduled turned correct code
// red, and the control burned its whole window on every green run. A red that
// means "the machine was busy" teaches people to re-run reds.
//
// Nothing below waits for a duration. The backend stops at a barrier only the
// test lifts, so every frame the client has before the lift arrived with no
// further backend event to carry it — which is the property itself. Each wait
// resolves on the bytes, so a slow machine makes this file slower and never
// redder.

const textOf = (events) => events
  .filter((e) => e.type === 'content_block_delta' && e.delta?.type === 'text_delta')
  .map((e) => e.delta.text).join('');
const argumentsOf = (events) => events
  .filter((e) => e.type === 'content_block_delta' && e.delta?.type === 'input_json_delta')
  .map((e) => e.delta.partial_json).join('');
const firstTextDeltaAt = (events) => events
  .findIndex((e) => e.type === 'content_block_delta' && e.delta?.type === 'text_delta');
const lastArgumentsDeltaAt = (events) => events
  .reduce((at, e, i) => (e.type === 'content_block_delta' && e.delta?.type === 'input_json_delta' ? i : at), -1);

/**
 * What a client has assembled from the bytes it has so far: whole SSE events
 * only, since the last one may still be arriving. Reading the wire as a string
 * instead put an escaped `partial_json` past a substring check that was looking
 * for the raw arguments — an instrument that answers "no" for the wrong reason.
 */
const received = (events) => ({
  events: [...events],
  types: events.map((e) => e.type),
  toolBlocks: events.filter((e) => e.type === 'content_block_start' && e.content_block?.type === 'tool_use').length,
  toolArguments: argumentsOf(events),
  text: textOf(events),
});

/**
 * The only deadline in this file, and it judges nothing: every wait below ends
 * on the bytes themselves, so this exists so that a stream which will NEVER
 * deliver fails with a sentence instead of hanging until the runner is killed.
 * A run that reaches it has found a real delivery failure — the backend is
 * parked at the barrier, so there is nothing else the client could be waiting
 * for, however loaded the machine is.
 */
const HANG_GUARD_MS = 15_000;

async function guarded(work, what) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(
        `HANG GUARD (${HANG_GUARD_MS}ms): ${what} never reached the client while the backend sat at the barrier. `
        + 'Nothing further was coming, so this is a delivery failure, not a slow machine.',
      )),
      HANG_GUARD_MS,
    );
  });
  try {
    return await Promise.race([work, guard]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The client's side of a live stream: every whole event it has received, and a
 * wait that ends the moment those events answer a question — never after a
 * duration. `read()` resolves when bytes arrive, so no assertion here can be
 * decided by how long anything took.
 */
function liveWire(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = '';
  let ended = false;
  const readMore = async () => {
    const { value, done } = await reader.read();
    if (done) { ended = true; return; }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    // The last line may still be arriving. A whole event never spans two lines:
    // JSON escapes every newline inside it.
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (!data || data === '[DONE]') continue;
      events.push(JSON.parse(data));
    }
  };
  return {
    /** Reads until the events answer `answered` — or the stream ends without it. */
    async until(answered, what) {
      while (!answered(events)) {
        assert.ok(!ended, `the stream ENDED before ${what}: ${events.map((e) => e.type).join(',')}`);
        await guarded(readMore(), what);
      }
      return received(events);
    },
    async toEnd() {
      while (!ended) await guarded(readMore(), 'the rest of the turn');
      return received(events);
    },
  };
}

/**
 * A turn whose backend produces `steps` and then STOPS, at a barrier only the
 * test lifts. Everything the client holds before the lift reached it with no
 * further backend event to carry it, which is exactly what "delivered when the
 * block frees, not at the end of the turn" means — and it is decided by the
 * barrier, not by elapsed time.
 */
async function atTheBarrier(steps, run) {
  let lift;
  const barrier = new Promise((resolve) => { lift = resolve; });
  const turn = { advanced: false, release: () => { lift(); } };
  const backend = {
    name: 'test', model: 'configured-model',
    async generate() { return result({}); },
    async *stream() {
      for (const step of steps) yield step;
      await barrier;
      // Read by the tests: the frames they assert on were on the wire while
      // this was still false.
      turn.advanced = true;
      yield { type: 'completed', result: result({ text: 'narration', toolCalls: [CALL_A], textOrdinal: 1 }) };
    },
    async close() {},
  };
  return withProxy(backend, async (server) => {
    const res = await fetch(`${server.url}/v1/messages`, { method: 'POST', headers: HEADERS, body: body({ stream: true }) });
    const wire = liveWire(res);
    try {
      return await run(wire, turn);
    } finally {
      // A failed assertion must not leave the generator parked and the socket
      // open behind it: the turn is let go and read out either way.
      turn.release();
      await wire.toEnd().catch(() => {});
    }
  });
}

test('narration held behind an open call is delivered when the call closes, not when the turn ends', async () => {
  // The queue held 'narration' because a call was still taking arguments. The
  // delta carrying `argumentsDone` closes that block, and the drain that
  // follows it is what puts the text on the wire — while the backend is still
  // working, which is the whole difference between streaming and buffering.
  // The backend is parked, so the client can only be holding text that the
  // block closing delivered.
  await atTheBarrier([OPENS_A_CALL, NARRATES, FINISHES_A_CALL], async (wire, turn) => {
    const held = await wire.until((events) => textOf(events).includes('narration'), 'the held narration');
    // The denominator: the reader is live and the wire is flowing.
    assert.equal(held.toolBlocks, 1, `the client is reading a live stream: ${held.types.join(',')}`);
    assert.equal(held.toolArguments, CALL_A.arguments, 'the call\'s own arguments arrived and finished');
    assert.equal(
      held.text,
      'narration',
      `the held text must reach the client when its block frees, not at the end of the turn: ${held.types.join(',')}`,
    );
    // And it was the block closing that delivered it: the backend has produced
    // nothing since, and the turn has not ended.
    assert.equal(turn.advanced, false, `the backend is still parked at the barrier: ${held.types.join(',')}`);
    assert.ok(
      !held.types.includes('message_stop'),
      `so this is mid-turn delivery, not the end of the turn: ${held.types.join(',')}`,
    );

    turn.release();
    const whole = await wire.toEnd();
    assert.ok(whole.types.includes('message_stop'), 'and the turn still completes normally');
    assert.equal(whole.text, 'narration', `written once, not again as a missing tail: ${whole.types.join(',')}`);
  });
});

test('CONTROL: narration behind a call that is STILL open is not delivered early', async () => {
  // The opposite answer through the same instrument: nothing closed the call,
  // so the text is still held — one block open at a time. Nothing CAN close it
  // while the barrier holds, so a client that has the text here is reading a
  // wire that let held output past an open block; no longer wait would make
  // that answer truer, and a run that reports nothing at all is not reading a
  // live stream.
  await atTheBarrier([OPENS_A_CALL, NARRATES], async (wire, turn) => {
    const held = await wire.until((events) => argumentsOf(events) === PARTIAL, 'the open call\'s arguments');
    assert.equal(held.toolBlocks, 1, `the client is reading a live stream: ${held.types.join(',')}`);
    assert.equal(held.toolArguments, PARTIAL, 'the open call\'s arguments arrived');
    assert.equal(held.text, '', `the text waits for the call to settle: ${held.types.join(',')}`);
    assert.equal(turn.advanced, false, `and the backend has produced nothing further: ${held.types.join(',')}`);

    turn.release();
    const whole = await wire.toEnd();
    assert.equal(whole.text, 'narration', 'and it is delivered by the end of the turn, never dropped');
    // The same answer once more, read off the finished wire, where nothing at
    // all depends on when anything was sampled: the narration sits behind the
    // arguments that settled the call it was waiting for.
    assert.equal(whole.toolArguments, CALL_A.arguments, `the result finished the call: ${whole.types.join(',')}`);
    assert.ok(
      firstTextDeltaAt(whole.events) > lastArgumentsDeltaAt(whole.events),
      `the narration follows the call it was held behind: ${whole.types.join(',')}`,
    );
  });
});
