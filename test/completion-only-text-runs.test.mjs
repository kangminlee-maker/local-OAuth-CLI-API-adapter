// The completion-only turn, and every layout its text and calls can take.
//
// A backend that announces nothing while it runs — no text delta, no tool
// item — and delivers the whole answer at `completed` has both output
// positions allocated inside that terminal branch, so PRODUCTION order is the
// only thing left to order them by and `textRuns` is where it is read.
//
// Twice the representation held exactly the case that had just failed. A
// BOOLEAN put every call before the text or every call after it, so
// [call, text, call] streamed one way and buffered another. A COUNT said how
// many calls preceded THE text — one position — so [text, call, text] streamed
// three blocks and buffered two:
//
//   /v1/messages buffered ['text','tool_use']         texts ['BEFORE AFTER']
//   /v1/messages streamed ['text','tool_use','text']  texts ['BEFORE ','AFTER']
//
// A turn's layout is an INTERLEAVING, so the field is one: the text as the
// sequence of runs it was produced in. These tests enumerate what that
// interleaving can be — no text, a run before, a run after, a run between,
// runs on both sides, several runs among several calls — and hold the two
// readings of ONE turn against each other on both surfaces at every one of
// them. Each layout is the others' control: a rule that answers one of them by
// fiat gets the opposite answer on another.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startLocalApiProxy } from '../dist/proxy/http-server.js';

const PARAMS = { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false };
const CALL_A = { id: 'fc_1', name: 'get_weather', arguments: '{"city":"A"}' };
const CALL_B = { id: 'fc_2', name: 'get_weather', arguments: '{"city":"B"}' };
const CALL_C = { id: 'fc_3', name: 'get_weather', arguments: '{"city":"C"}' };
const CALLS = [CALL_A, CALL_B, CALL_C];
const RESPONSES_TOOLS = [{ type: 'function', name: 'get_weather', description: 'w', parameters: PARAMS, strict: true }];
const MESSAGES_TOOLS = [{ name: 'get_weather', description: 'w', input_schema: PARAMS }];
const JSON_HEADERS = { 'content-type': 'application/json' };
const ANTHROPIC_HEADERS = { ...JSON_HEADERS, 'x-api-key': 'local', 'anthropic-version': '2023-06-01' };

/**
 * A backend that streams NOTHING: the turn first exists at `completed`. This
 * is every tool call on the claude native-schema channel, and it is the only
 * shape where the stream has to derive its own order from `textRuns`.
 */
function completionOnlyBackend({ text, toolCalls, textRuns }) {
  const result = {
    id: 'x', model: 'configured-model', text, toolCalls,
    ...(textRuns === undefined ? {} : { textRuns }),
    usage: { inputTokens: 1, outputTokens: 1, source: 'estimated' }, latencyMs: 1,
  };
  return {
    name: 'test', model: 'configured-model',
    async generate() { return result; },
    async *stream() { yield { type: 'completed', result }; },
    async close() {},
  };
}

/**
 * A turn written as the order it was produced in: a string is a run of text, a
 * number is that call. One layout, so the fixture cannot say two things.
 */
function turnFor(layout) {
  const toolCalls = [];
  const textRuns = [];
  for (const step of layout) {
    if (typeof step === 'string') textRuns.push({ text: step, afterCalls: toolCalls.length });
    else toolCalls.push(CALLS[toolCalls.length]);
  }
  return completionOnlyBackend({
    text: textRuns.map((run) => run.text).join(''),
    toolCalls,
    ...(textRuns.length > 0 ? { textRuns } : {}),
  });
}

const sseEvents = (wire) => wire.split('\n')
  .filter((line) => line.startsWith('data:'))
  .map((line) => line.slice(5).trim())
  .filter((data) => data && data !== '[DONE]')
  .map((data) => JSON.parse(data));

/** One turn, read four ways: buffered and streamed on both surfaces. */
async function readings(backend) {
  const server = await startLocalApiProxy({ backend, host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000 });
  const post = (path, body, headers) => fetch(`${server.url}${path}`, {
    method: 'POST', headers, body: JSON.stringify(body),
  });
  try {
    const responsesBody = (extra) => ({ model: 'm', input: 'w', tools: RESPONSES_TOOLS, ...extra });
    const messagesBody = (extra) => ({
      model: 'm', max_tokens: 64, tools: MESSAGES_TOOLS,
      messages: [{ role: 'user', content: 'w' }], ...extra,
    });
    const responsesBuffered = await (await post('/v1/responses', responsesBody({}), JSON_HEADERS)).json();
    const responsesStreamed = sseEvents(await (await post('/v1/responses', responsesBody({ stream: true }), JSON_HEADERS)).text());
    const messagesBuffered = await (await post('/v1/messages', messagesBody({}), ANTHROPIC_HEADERS)).json();
    const messagesStreamed = sseEvents(await (await post('/v1/messages', messagesBody({ stream: true }), ANTHROPIC_HEADERS)).text());
    return {
      responsesBuffered: responsesBuffered.output?.map((item) => item.type),
      responsesAdded: responsesStreamed.filter((e) => e.type === 'response.output_item.added').map((e) => e.item?.type),
      responsesAddedIndices: responsesStreamed.filter((e) => e.type === 'response.output_item.added').map((e) => e.output_index),
      responsesDoneIndices: responsesStreamed.filter((e) => e.type === 'response.output_item.done').map((e) => e.output_index),
      responsesCompleted: responsesStreamed.find((e) => e.type === 'response.completed')?.response?.output?.map((item) => item.type),
      responsesText: responsesStreamed.filter((e) => e.type === 'response.output_text.delta').map((e) => e.delta).join(''),
      messagesBuffered: messagesBuffered.content?.map((block) => block.type),
      messagesStarts: messagesStreamed.filter((e) => e.type === 'content_block_start').map((e) => e.content_block?.type),
      messagesStartIndices: messagesStreamed.filter((e) => e.type === 'content_block_start').map((e) => e.index),
      messagesText: messagesStreamed
        .filter((e) => e.type === 'content_block_delta' && e.delta?.type === 'text_delta')
        .map((e) => e.delta.text).join(''),
      messagesBufferedText: messagesBuffered.content?.filter((b) => b.type === 'text').map((b) => b.text).join('') ?? '',
      // Per BLOCK, in block order. The joined text above cannot tell one text
      // block carrying 'AB' from two carrying 'A' and 'B', which is exactly the
      // difference between the two readings of a turn that narrates on both
      // sides of a call.
      messagesBufferedTexts: messagesBuffered.content?.filter((b) => b.type === 'text').map((b) => b.text) ?? [],
      messagesStreamedTexts: streamedBlockTexts(messagesStreamed),
    };
  } finally { await server.close(); }
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

/** The two readings of one turn, held against each other and against `order`. */
function assertAgree(r, { responses, messages }, label) {
  assert.deepEqual(r.responsesAdded, responses, `${label}: the Responses stream announces production order`);
  assert.deepEqual(r.responsesBuffered, responses, `${label}: the buffered body must report the order the stream announced`);
  assert.deepEqual(r.responsesCompleted, responses, `${label}: response.completed says the same thing the deltas did`);
  assert.deepEqual(r.responsesAdded, r.responsesBuffered, `${label}: one turn, two readings of /v1/responses`);
  assert.deepEqual(r.messagesStarts, messages, `${label}: the Messages stream announces production order`);
  assert.deepEqual(r.messagesBuffered, messages, `${label}: the buffered body must report the same blocks`);
  assert.deepEqual(r.messagesStarts, r.messagesBuffered, `${label}: one turn, two readings of /v1/messages`);
  // Positions are allocated in the order the items go out, so a client
  // assembling by index reads the same sequence the frames arrived in.
  const outputPositions = responses.map((_, index) => index);
  assert.deepEqual(r.responsesAddedIndices, outputPositions, `${label}: items take output positions in announced order`);
  assert.deepEqual(r.responsesDoneIndices, outputPositions, `${label}: and close them monotonically`);
  // Counted against the MESSAGES list: this surface gives every run its own
  // block, so its block count is not the Responses item count.
  assert.deepEqual(
    r.messagesStartIndices,
    messages.map((_, index) => index),
    `${label}: content blocks open at ascending indices`,
  );
  // Not just the same block TYPES: the same text in the same blocks. Merging
  // two runs into one block is a shape the block list alone cannot see.
  assert.deepEqual(
    r.messagesBufferedTexts,
    r.messagesStreamedTexts,
    `${label}: each text block carries the same run on both readings`,
  );
  assert.equal(r.responsesText, r.messagesText, `${label}: and both surfaces carry the turn's whole text`);
}

// Every layout a turn's text and calls can take, each read four ways. The
// LAYOUT is production order — a string is a run of text, a number is that
// call — and the expected item lists are that same order projected onto each
// surface, so a fixture cannot claim one thing and assert another.
//
// The Messages surface reports every run as its own block, because its stream
// does: a tool call stops the open text block, so text that resumes after one
// is a NEW block. The Responses surface reports the turn's text as ONE message
// item, because its stream does: one item id, one content part, however many
// runs the turn produced. Each surface's buffered body follows its own wire.
//
// Neither shape is a vendor mirror. Measured 2026-09-02 on the direct
// Anthropic API, a turn told to narrate, call a tool, then narrate again comes
// back `[text, tool_use]` buffered and streams the same two blocks: the vendor
// ends the turn at the call and never emits text after a `tool_use` block. So
// there is no vendor answer to copy — the turn exists only because a backend
// here produces it — and what these pin is the pair of rules that hold without
// one: every byte the backend produced still reaches the client, and the two
// readings of a surface agree with EACH OTHER about where it sits.
const LAYOUTS = [
  ['a run before the calls', ['BEFORE', 0, 1],
    ['message', 'function_call', 'function_call'], ['text', 'tool_use', 'tool_use']],
  ['a run between the calls', [0, 'BETWEEN', 1],
    ['function_call', 'message', 'function_call'], ['tool_use', 'text', 'tool_use']],
  ['a run after the calls', [0, 1, 'AFTER'],
    ['function_call', 'function_call', 'message'], ['tool_use', 'tool_use', 'text']],
  // The shape a COUNT could not carry: one position cannot be on both sides.
  ['runs on BOTH SIDES of a call', ['BEFORE ', 0, 'AFTER'],
    ['message', 'function_call'], ['text', 'tool_use', 'text']],
  ['runs on both sides of two calls', ['A', 0, 'B', 1, 'C'],
    ['message', 'function_call', 'function_call'], ['text', 'tool_use', 'text', 'tool_use', 'text']],
  ['several runs among several calls', ['A', 0, 'B', 1, 'C', 2, 'D'],
    ['message', 'function_call', 'function_call', 'function_call'],
    ['text', 'tool_use', 'text', 'tool_use', 'text', 'tool_use', 'text']],
  ['runs between calls with none at either end', [0, 'B', 1, 'C', 2],
    ['function_call', 'message', 'function_call', 'function_call'],
    ['tool_use', 'text', 'tool_use', 'text', 'tool_use']],
  ['two calls, then a run, then a call', [0, 1, 'MID', 2],
    ['function_call', 'function_call', 'message', 'function_call'],
    ['tool_use', 'tool_use', 'text', 'tool_use']],
];

for (const [label, layout, responses, messages] of LAYOUTS) {
  test(`a completion-only turn reads the same buffered and streamed with ${label}`, async () => {
    const r = await readings(turnFor(layout));
    assertAgree(r, { responses, messages }, `completion-only, ${label}`);
    // Reordering may not cost the turn its narration, nor duplicate it.
    const whole = layout.filter((step) => typeof step === 'string').join('');
    assert.equal(r.responsesText, whole, `${label}: the narration reaches the Responses client once`);
    assert.equal(r.messagesText, whole, `${label}: and the Messages client once`);
    assert.equal(r.messagesBufferedText, whole, `${label}: the buffered body carries the same text`);
    // The runs land in their own blocks, in order — the assertion the block
    // TYPE list cannot make, since two runs merged into one block still reads
    // as one 'text' entry there.
    assert.deepEqual(
      r.messagesBufferedTexts,
      layout.filter((step) => typeof step === 'string'),
      `${label}: every run is its own block, carrying its own text`,
    );
  });
}

test('a completion-only turn with a run past its own call count puts the text last', async () => {
  // Clamped, not trusted: a run addresses calls that exist. Both readings
  // answer the same way, which is what makes it a clamp rather than two
  // independent guesses.
  const r = await readings(completionOnlyBackend({
    text: 'BETWEEN', toolCalls: [CALL_A, CALL_B], textRuns: [{ text: 'BETWEEN', afterCalls: 9 }],
  }));
  assertAgree(
    r,
    { responses: ['function_call', 'function_call', 'message'], messages: ['tool_use', 'tool_use', 'text'] },
    'completion-only, a run past the call count',
  );
});

test('a completion-only turn whose runs go BACKWARDS still reads the same both ways', async () => {
  // Runs are produced in order, so `afterCalls` never decreases. A backend
  // that says otherwise gets one answer, not two: the second run is held at
  // the first's position rather than moving text behind a block already
  // written.
  const r = await readings(completionOnlyBackend({
    text: 'AB', toolCalls: [CALL_A, CALL_B],
    textRuns: [{ text: 'A', afterCalls: 2 }, { text: 'B', afterCalls: 0 }],
  }));
  assertAgree(
    r,
    { responses: ['function_call', 'function_call', 'message'], messages: ['tool_use', 'tool_use', 'text'] },
    'completion-only, runs out of order',
  );
  assert.equal(r.messagesBufferedText, 'AB', 'and no byte of the turn is lost to the clamp');
});

test('a completion-only turn whose runs do not add up to its text still carries every byte', async () => {
  // `text` is the bytes and `textRuns` is the positions. A backend whose runs
  // are short must not have the rest cut off here: the last run takes it, so
  // both readings still deliver the whole turn.
  const r = await readings(completionOnlyBackend({
    text: 'ABCDEF', toolCalls: [CALL_A], textRuns: [{ text: 'AB', afterCalls: 1 }],
  }));
  assertAgree(
    r,
    { responses: ['function_call', 'message'], messages: ['tool_use', 'text'] },
    'completion-only, runs shorter than the text',
  );
  assert.equal(r.messagesBufferedText, 'ABCDEF');
  assert.equal(r.messagesText, 'ABCDEF');
});

test('CONTROL: a completion-only turn with no text at all opens no message item', async () => {
  // The interleave must not invent an empty message where the buffered body
  // reports none — the opposite expected answer at the same position.
  const r = await readings(completionOnlyBackend({
    text: '', toolCalls: [CALL_A, CALL_B], textRuns: [{ text: '', afterCalls: 1 }],
  }));
  assertAgree(
    r,
    { responses: ['function_call', 'function_call'], messages: ['tool_use', 'tool_use'] },
    'completion-only, no text',
  );
  assert.equal(r.messagesText, '', 'and no stray empty text block');
});

test('CONTROL: a completion-only turn with no calls is one message', async () => {
  const r = await readings(completionOnlyBackend({ text: 'ONLY', toolCalls: [] }));
  assertAgree(r, { responses: ['message'], messages: ['text'] }, 'completion-only, no calls');
  assert.equal(r.messagesText, 'ONLY');
});
