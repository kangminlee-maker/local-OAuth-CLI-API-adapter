// Where the text block lands on `/v1/messages` when `stop_sequences` is set.
//
// The gate withholds text that is still a live PREFIX of a stop sequence. While
// it is withheld `writeText('')` opens no content block, so a tool call that
// arrives next took block 0 and the text opened a NEW block behind it when the
// gate finally let go. The wire position was decided by WHEN THE GATE RELEASED
// the bytes rather than by when the turn produced them, and the same turn read:
//
//   stop_sequences ['Done'], text 'Do' before one call
//     buffered ['text','tool_use']   streamed ['tool_use','text']
//   stop_sequences ['BETWEENZ'], call/text/call
//     buffered ['tool_use','text','tool_use']
//     streamed ['tool_use','tool_use','text']
//
// Both controls — no stop sequence, and one that cannot match — already agreed,
// which is what pins the cause on the gate rather than on the ordering.
//
// The gate can merge as well as move. A turn that narrates on BOTH SIDES of a
// call, with the first run still a live prefix, had both runs released at one
// slot: one text block on the wire against the buffered body's two. The gate
// decides WHAT the caller may see and never how many blocks the turn had, so
// it holds one slot per RUN and releases each where that run was produced.
// Every row here that splits its text carries a no-stop-sequence control, for
// the same reason the two above do: a merged wire agreeing with a merged body
// is what hid this for two rounds.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startLocalApiProxy } from '../dist/proxy/http-server.js';

const PARAMS = { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false };
const CALL_A = { id: 'fc_1', name: 'get_weather', arguments: '{"city":"A"}' };
const CALL_B = { id: 'fc_2', name: 'get_weather', arguments: '{"city":"B"}' };
const TOOLS = [{ name: 'get_weather', description: 'w', input_schema: PARAMS }];
const HEADERS = { 'content-type': 'application/json', 'x-api-key': 'local', 'anthropic-version': '2023-06-01' };

// `steps` is the production order the backend streams: a number is that tool
// call, a string is a text delta. `text` is what the finished turn reports,
// which is the concatenation of the text deltas — the same turn, twice.
//
// `textRuns` is DERIVED from `steps`, because the runs ARE the production
// order and a fixture that stated them separately could say two things about
// one turn — which is how a wire shape came to be asserted against a result
// that did not describe it.
function runsFrom(steps) {
  const runs = [];
  let calls = 0;
  for (const step of steps) {
    if (typeof step !== 'string') { calls += 1; continue; }
    const open = runs[runs.length - 1];
    if (open && open.afterCalls === calls) open.text += step;
    else runs.push({ text: step, afterCalls: calls });
  }
  return runs;
}

function backendFor({ toolCalls = [], text = '', steps }) {
  const textRuns = runsFrom(steps);
  assert.equal(
    textRuns.map((run) => run.text).join(''),
    text,
    'the fixture must report the text its own steps produce',
  );
  const result = {
    id: 'x', model: 'configured-model', text, toolCalls,
    ...(textRuns.length > 0 ? { textRuns } : {}),
    usage: { inputTokens: 1, outputTokens: 1, source: 'estimated' }, latencyMs: 1,
  };
  return {
    name: 'test', model: 'configured-model',
    async generate() { return result; },
    async *stream() {
      for (const step of steps) {
        if (typeof step === 'string') { yield { type: 'text_delta', delta: step }; continue; }
        const call = toolCalls[step];
        yield {
          type: 'tool_call_delta', index: step, id: call.id, name: call.name,
          argumentsDelta: call.arguments, argumentsDone: true,
        };
      }
      yield { type: 'completed', result };
    },
    async close() {},
  };
}

const sseEvents = (wire) => wire.split('\n')
  .filter((line) => line.startsWith('data: '))
  .map((line) => line.slice(6).trim())
  .filter((data) => data && data !== '[DONE]')
  .map((data) => JSON.parse(data));

/** One turn, read both ways through the same proxy. */
async function bothReadings(backend, stopSequences) {
  const started = await startLocalApiProxy({ backend, host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000 });
  const body = (extra) => JSON.stringify({
    model: 'a-model', max_tokens: 64, tools: TOOLS,
    messages: [{ role: 'user', content: 'ping' }],
    ...(stopSequences ? { stop_sequences: stopSequences } : {}),
    ...extra,
  });
  try {
    const bufRes = await fetch(`${started.url}/v1/messages`, { method: 'POST', headers: HEADERS, body: body({}) });
    const buffered = await bufRes.json();
    const strRes = await fetch(`${started.url}/v1/messages`, {
      method: 'POST', headers: HEADERS, body: body({ stream: true }),
    });
    const events = sseEvents(await strRes.text());
    const messageDelta = events.find((e) => e.type === 'message_delta');
    return {
      bufferedStatus: bufRes.status,
      streamedStatus: strRes.status,
      bufferedBlocks: buffered.content?.map((c) => c.type),
      streamedBlocks: events.filter((e) => e.type === 'content_block_start').map((e) => e.content_block?.type),
      bufferedText: buffered.content?.filter((c) => c.type === 'text').map((c) => c.text).join(''),
      // Per BLOCK. The joined text cannot tell one block carrying 'Dogs' from
      // two carrying 'Do' and 'gs', which is the whole difference here.
      bufferedTexts: buffered.content?.filter((c) => c.type === 'text').map((c) => c.text) ?? [],
      streamedTexts: streamedBlockTexts(events),
      streamedText: events
        .filter((e) => e.type === 'content_block_delta' && e.delta?.type === 'text_delta')
        .map((e) => e.delta.text).join(''),
      bufferedStopReason: buffered.stop_reason,
      streamedStopReason: messageDelta?.delta?.stop_reason,
      bufferedStopSequence: buffered.stop_sequence ?? null,
      streamedStopSequence: messageDelta?.delta?.stop_sequence ?? null,
      ...blockNesting(events),
    };
  } finally { await started.close(); }
}

/** The text each streamed content block carried, in the order the blocks opened. */
function streamedBlockTexts(events) {
  const texts = new Map();
  const order = [];
  for (const event of events) {
    if (event.type === 'content_block_start') {
      order.push(event.index);
      if (event.content_block?.type === 'text') texts.set(event.index, event.content_block.text ?? '');
    }
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      texts.set(event.index, `${texts.get(event.index) ?? ''}${event.delta.text}`);
    }
  }
  return order.filter((index) => texts.has(index)).map((index) => texts.get(index));
}

/**
 * How deep the wire ever nested. This surface has no nesting: a block opens
 * only while nothing else is open, which is what lets a client assemble content
 * by index. The suite read `content_block_start` and never counted a single
 * stop, so `flushHeldToolEvents` could write a tool call INSIDE the text block
 * it was supposed to close first and every case here stayed green.
 */
function blockNesting(events) {
  let open = 0;
  let maxOpen = 0;
  const trace = [];
  for (const event of events) {
    if (event.type === 'content_block_start') {
      open += 1;
      maxOpen = Math.max(maxOpen, open);
      trace.push(`start#${event.index}:${event.content_block?.type}`);
    }
    if (event.type === 'content_block_stop') {
      open -= 1;
      trace.push(`stop#${event.index}`);
    }
  }
  return { streamedMaxOpen: maxOpen, streamedLeftOpen: open, streamedTrace: trace.join(' | ') };
}

/** The two readings of ONE turn, held against each other and against `blocks`. */
function assertAgree(s, blocks, label) {
  assert.equal(s.bufferedStatus, 200, `${label}: the buffered read answered ${s.bufferedStatus}`);
  assert.equal(s.streamedStatus, 200, `${label}: the streamed read answered ${s.streamedStatus}`);
  assert.deepEqual(s.streamedBlocks, blocks, `${label}: the stream must announce production order`);
  assert.deepEqual(s.bufferedBlocks, blocks, `${label}: the buffered body must report the same order`);
  assert.deepEqual(s.streamedBlocks, s.bufferedBlocks, `${label}: one turn, two readings`);
  assert.equal(s.streamedText, s.bufferedText, `${label}: both readings carry the same text`);
  assert.deepEqual(s.streamedTexts, s.bufferedTexts, `${label}: and the same runs in the same blocks`);
  assert.equal(s.streamedStopReason, s.bufferedStopReason, `${label}: both readings report the same stop`);
  assert.equal(s.streamedStopSequence, s.bufferedStopSequence, `${label}: and the same stop_sequence`);
  assert.equal(s.streamedMaxOpen <= 1, true, `${label}: two blocks open at once — ${s.streamedTrace}`);
  assert.equal(s.streamedLeftOpen, 0, `${label}: a block was left open — ${s.streamedTrace}`);
  assert.equal(
    s.streamedTrace.split(' | ').filter((f) => f.startsWith('stop#')).length,
    blocks.length,
    `${label}: every block opened is closed — ${s.streamedTrace}`,
  );
}

test('a stop sequence the text is still a live prefix of does not move the text behind the call', async () => {
  const s = await bothReadings(
    backendFor({ toolCalls: [CALL_A], text: 'Do', steps: ['Do', 0] }),
    ['Done'],
  );
  assertAgree(s, ['text', 'tool_use'], "text first, held by ['Done']");
  assert.equal(s.bufferedText, 'Do', 'the text survives — "Do" is not "Done"');
  assert.equal(s.bufferedStopReason, 'tool_use', 'nothing matched, so the turn still stopped on its tools');
});

test('CONTROL: with no stop sequence at all the same turn already agreed', async () => {
  const s = await bothReadings(
    backendFor({ toolCalls: [CALL_A], text: 'Do', steps: ['Do', 0] }),
    null,
  );
  assertAgree(s, ['text', 'tool_use'], 'text first, no gate');
});

test('CONTROL: a stop sequence that cannot match holds nothing back', async () => {
  const s = await bothReadings(
    backendFor({ toolCalls: [CALL_A], text: 'Do', steps: ['Do', 0] }),
    ['ZZZZ'],
  );
  assertAgree(s, ['text', 'tool_use'], "text first, non-matching ['ZZZZ']");
});

test('a call/text/call turn keeps its text between the calls when the gate holds it', async () => {
  const s = await bothReadings(
    backendFor({ toolCalls: [CALL_A, CALL_B], text: 'BETWEEN', steps: [0, 'BETWEEN', 1] }),
    ['BETWEENZ'],
  );
  assertAgree(s, ['tool_use', 'text', 'tool_use'], "call/text/call, held by ['BETWEENZ']");
  assert.equal(s.bufferedText, 'BETWEEN');
});

test('CONTROL: the same call/text/call turn with no stop sequence', async () => {
  const s = await bothReadings(
    backendFor({ toolCalls: [CALL_A, CALL_B], text: 'BETWEEN', steps: [0, 'BETWEEN', 1] }),
    null,
  );
  assertAgree(s, ['tool_use', 'text', 'tool_use'], 'call/text/call, no gate');
});

test('a turn whose text a stop sequence eats entirely opens no text block at all', async () => {
  // The other half of the fix: the position may not be reserved by opening an
  // empty text block, because a turn whose text really did match reports
  // content:[tool_use] buffered and must stream exactly that.
  const s = await bothReadings(
    backendFor({ toolCalls: [CALL_A], text: 'DONE', steps: ['DONE', 0] }),
    ['DONE'],
  );
  assertAgree(s, ['tool_use'], "text fully eaten by ['DONE']");
  assert.equal(s.bufferedText, '', 'nothing before the sequence, so no text survives');
  assert.equal(s.streamedText, '', 'and no stray empty text block either');
});

test('CONTROL: the same turn with a sequence that misses keeps its text block', async () => {
  const s = await bothReadings(
    backendFor({ toolCalls: [CALL_A], text: 'DONE', steps: ['DONE', 0] }),
    ['NOPE'],
  );
  assertAgree(s, ['text', 'tool_use'], "text kept, missed by ['NOPE']");
  assert.equal(s.bufferedText, 'DONE');
});

// A turn that narrates on BOTH SIDES of a call, with and without a gate.
//
// The gate holds 'Do' — still a live prefix of 'Done' — and lets go only after
// the call, when 'gs' rules the sequence out. Releasing everything it held at
// one slot MERGED the two runs into one block, so the wire read
// ['text','tool_use'] while the buffered body, reporting the runs, read
// ['text','tool_use','text']. The gate decides WHAT the caller may see, never
// how many blocks the turn had: it releases each run at the slot that run was
// produced at.
//
// This row and its control are each other's proof. Without the control, the
// merged wire agreed with a buffered body that merged too, and the whole
// defect sat inside a passing test.
const SPLIT_TEXT = { toolCalls: [CALL_A], text: 'Dogs', steps: ['Do', 0, 'gs'] };

test('a held prefix that a later delta rules out keeps its runs in their own blocks', async () => {
  const s = await bothReadings(backendFor(SPLIT_TEXT), ['Done']);
  assertAgree(s, ['text', 'tool_use', 'text'], "prefix released late, ['Done']");
  assert.equal(s.bufferedText, 'Dogs', 'the whole text survives, split across the call');
  assert.deepEqual(s.bufferedTexts, ['Do', 'gs'], 'each run is its own block, carrying its own half');
  assert.deepEqual(s.streamedTexts, s.bufferedTexts, 'and the wire carries the same two');
});

test('CONTROL: the same text/call/text turn with no stop sequence at all', async () => {
  // Nothing is held, so nothing can be merged by being held — the block shape
  // is the writer's alone. The row above must not be able to pass by the gate
  // doing the splitting, nor this one by the gate doing the merging.
  const s = await bothReadings(backendFor(SPLIT_TEXT), null);
  assertAgree(s, ['text', 'tool_use', 'text'], 'text/call/text, no gate');
  assert.deepEqual(s.bufferedTexts, ['Do', 'gs']);
  assert.deepEqual(s.streamedTexts, s.bufferedTexts);
});

test('CONTROL: the same turn with a stop sequence that cannot match', async () => {
  const s = await bothReadings(backendFor(SPLIT_TEXT), ['ZZZZ']);
  assertAgree(s, ['text', 'tool_use', 'text'], "text/call/text, non-matching ['ZZZZ']");
  assert.deepEqual(s.bufferedTexts, ['Do', 'gs']);
});

test('a stop sequence that lands in the SECOND run cuts only that run', async () => {
  // The opposite expected answer for the same shape: the first run is already
  // the caller's, and the cut takes the second one's tail. A rule that cut the
  // turn's text as one string would have taken the first run with it.
  const s = await bothReadings(
    backendFor({ toolCalls: [CALL_A], text: 'DoXXgs', steps: ['Do', 0, 'XXgs'] }),
    ['XX'],
  );
  assertAgree(s, ['text', 'tool_use'], "second run cut by ['XX']");
  assert.deepEqual(s.bufferedTexts, ['Do'], 'the first run survives whole');
  assert.equal(s.bufferedStopReason, 'tool_use', 'a turn with tools still stops on its tools');
});

test('a turn with no text at all is unchanged by the gate', async () => {
  const s = await bothReadings(
    backendFor({ toolCalls: [CALL_A], text: '', steps: [0] }),
    ['Done'],
  );
  assertAgree(s, ['tool_use'], 'call only');
});

test('a text-only turn cut by a stop sequence still reports the match on both surfaces', async () => {
  const s = await bothReadings(
    backendFor({ text: 'AAZZBB', steps: ['AA', 'ZZ', 'BB'] }),
    ['ZZ'],
  );
  assertAgree(s, ['text'], "text only, cut by ['ZZ']");
  assert.equal(s.bufferedText, 'AA');
  assert.equal(s.bufferedStopReason, 'stop_sequence');
  assert.equal(s.bufferedStopSequence, 'ZZ');
});
