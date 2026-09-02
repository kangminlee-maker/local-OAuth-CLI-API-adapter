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

/**
 * What a client has assembled from the bytes it has so far: whole SSE events
 * only, since the last one may still be arriving. Reading the wire as a string
 * instead put an escaped `partial_json` past a substring check that was looking
 * for the raw arguments — an instrument that answers "no" for the wrong reason.
 */
function partOfTheWire(wire) {
  const events = wire.split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice(6).trim())
    .filter((data) => data && data !== '[DONE]')
    .flatMap((data) => { try { return [JSON.parse(data)]; } catch { return []; } });
  return {
    types: events.map((e) => e.type),
    toolBlocks: events.filter((e) => e.type === 'content_block_start' && e.content_block?.type === 'tool_use').length,
    toolArguments: events
      .filter((e) => e.type === 'content_block_delta' && e.delta?.type === 'input_json_delta')
      .map((e) => e.delta.partial_json).join(''),
    text: events
      .filter((e) => e.type === 'content_block_delta' && e.delta?.type === 'text_delta')
      .map((e) => e.delta.text).join(''),
  };
}

/**
 * Runs a turn whose backend PAUSES after `steps`, and reports what the client
 * has received by then. The pause is the point: it is the window in which the
 * queue's own drain is the only thing that can deliver anything, because no
 * further event will arrive to drain it.
 */
async function receivedWhilePaused(steps, windowMs) {
  let release;
  const paused = new Promise((resolve) => { release = resolve; });
  const backend = {
    name: 'test', model: 'configured-model',
    async generate() { return result({}); },
    async *stream() {
      for (const step of steps) yield step;
      await paused;
      yield { type: 'completed', result: result({ text: 'narration', toolCalls: [CALL_A], textOrdinal: 1 }) };
    },
    async close() {},
  };
  return withProxy(backend, async (server) => {
    const res = await fetch(`${server.url}/v1/messages`, { method: 'POST', headers: HEADERS, body: body({ stream: true }) });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let wire = '';
    const pump = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        wire += decoder.decode(value, { stream: true });
      }
    })().catch(() => {});
    const deadline = Date.now() + windowMs;
    while (Date.now() < deadline && !wire.includes('narration')) {
      await new Promise((resolve) => { setTimeout(resolve, 5); });
    }
    const duringPause = wire;
    release();
    await pump;
    return { duringPause: partOfTheWire(duringPause), whole: partOfTheWire(wire) };
  });
}

test('narration held behind an open call is delivered when the call closes, not when the turn ends', async () => {
  // The queue held 'narration' because a call was still taking arguments. The
  // delta carrying `argumentsDone` closes that block, and the drain that
  // follows it is what puts the text on the wire — while the backend is still
  // working, which is the whole difference between streaming and buffering.
  // The window only elapses on failure.
  const { duringPause, whole } = await receivedWhilePaused([OPENS_A_CALL, NARRATES, FINISHES_A_CALL], 3_000);
  // The denominator: the reader is live and the wire is flowing.
  assert.equal(duringPause.toolBlocks, 1, `the client is reading a live stream: ${duringPause.types.join(',')}`);
  assert.equal(duringPause.toolArguments, CALL_A.arguments, 'the call\'s own arguments arrived and finished');
  assert.equal(
    duringPause.text,
    'narration',
    `the held text must reach the client when its block frees, not at the end of the turn: ${duringPause.types.join(',')}`,
  );
  assert.ok(whole.types.includes('message_stop'), 'and the turn still completes normally');
});

test('CONTROL: narration behind a call that is STILL open is not delivered early', async () => {
  // The opposite answer through the same instrument: nothing closed the call,
  // so the text is still held — one block open at a time. A run that reports
  // the narration here is reading a wire that broke the queue's invariant, and
  // a run that reports nothing at all is not reading a live stream.
  const { duringPause, whole } = await receivedWhilePaused([OPENS_A_CALL, NARRATES], 400);
  assert.equal(duringPause.toolBlocks, 1, `the client is reading a live stream: ${duringPause.types.join(',')}`);
  assert.equal(duringPause.toolArguments, PARTIAL, 'the open call\'s arguments arrived');
  assert.equal(duringPause.text, '', `the text waits for the call to settle: ${duringPause.types.join(',')}`);
  assert.equal(whole.text, 'narration', 'and it is delivered by the end of the turn, never dropped');
});
