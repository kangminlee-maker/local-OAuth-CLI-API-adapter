// The completion-only turn, whose text sits BETWEEN two calls.
//
// A backend that announces nothing while it runs — no text delta, no tool
// item — and delivers the whole answer at `completed` has both output
// positions allocated inside that terminal branch. The decision there was a
// BINARY: `textOrdinal === 0` put the message first, anything else put every
// call first. That cannot express the one shape `textOrdinal` exists to carry,
// so a turn reporting `{text:'BETWEEN', toolCalls:[A,B], textOrdinal:1}` read:
//
//   /v1/responses buffered ['function_call','message','function_call']
//   /v1/responses streamed ['function_call','function_call','message']
//   /v1/messages  buffered ['tool_use','text','tool_use']
//   /v1/messages  streamed ['tool_use','tool_use','text']
//
// The buffered body already splices the text in at the ordinal, through
// `orderedByEmission`. These tests hold the two readings of ONE turn against
// each other at every ordinal — 0, 1 and 2 over two calls — so the middle case
// cannot be fixed by a rule that breaks an end case, and neither end case can
// pass by accident: each is the other's control.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startLocalApiProxy } from '../dist/proxy/http-server.js';

const PARAMS = { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false };
const CALL_A = { id: 'fc_1', name: 'get_weather', arguments: '{"city":"A"}' };
const CALL_B = { id: 'fc_2', name: 'get_weather', arguments: '{"city":"B"}' };
const RESPONSES_TOOLS = [{ type: 'function', name: 'get_weather', description: 'w', parameters: PARAMS, strict: true }];
const MESSAGES_TOOLS = [{ name: 'get_weather', description: 'w', input_schema: PARAMS }];
const JSON_HEADERS = { 'content-type': 'application/json' };
const ANTHROPIC_HEADERS = { ...JSON_HEADERS, 'x-api-key': 'local', 'anthropic-version': '2023-06-01' };

/**
 * A backend that streams NOTHING: the turn first exists at `completed`. This
 * is every tool call on the claude native-schema channel, and it is the only
 * shape where the stream has to derive its own order from `textOrdinal`.
 */
function completionOnlyBackend({ text, toolCalls, textOrdinal }) {
  const result = {
    id: 'x', model: 'configured-model', text, toolCalls,
    ...(textOrdinal === undefined ? {} : { textOrdinal }),
    usage: { inputTokens: 1, outputTokens: 1, source: 'estimated' }, latencyMs: 1,
  };
  return {
    name: 'test', model: 'configured-model',
    async generate() { return result; },
    async *stream() { yield { type: 'completed', result }; },
    async close() {},
  };
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
    };
  } finally { await server.close(); }
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
  const positions = responses.map((_, index) => index);
  assert.deepEqual(r.responsesAddedIndices, positions, `${label}: items take output positions in announced order`);
  assert.deepEqual(r.responsesDoneIndices, positions, `${label}: and close them monotonically`);
  assert.deepEqual(r.messagesStartIndices, positions, `${label}: content blocks open at ascending indices`);
}

// Two calls, one narration, every position the narration can occupy. The three
// cases are each other's controls: a rule that answers one of them by fiat
// gets the opposite answer on another.
const ORDINALS = [
  [0, ['message', 'function_call', 'function_call'], ['text', 'tool_use', 'tool_use']],
  [1, ['function_call', 'message', 'function_call'], ['tool_use', 'text', 'tool_use']],
  [2, ['function_call', 'function_call', 'message'], ['tool_use', 'tool_use', 'text']],
];

for (const [textOrdinal, responses, messages] of ORDINALS) {
  test(`a completion-only turn reads the same buffered and streamed at textOrdinal ${textOrdinal}`, async () => {
    const r = await readings(completionOnlyBackend({
      text: 'BETWEEN', toolCalls: [CALL_A, CALL_B], textOrdinal,
    }));
    assertAgree(r, { responses, messages }, `completion-only, textOrdinal ${textOrdinal}`);
    // Reordering may not cost the turn its narration.
    assert.equal(r.responsesText, 'BETWEEN', `textOrdinal ${textOrdinal}: the narration reaches the Responses client once`);
    assert.equal(r.messagesText, 'BETWEEN', `textOrdinal ${textOrdinal}: and the Messages client once`);
    assert.equal(r.messagesBufferedText, 'BETWEEN', `textOrdinal ${textOrdinal}: the buffered body carries the same text`);
  });
}

test('a completion-only turn with an ordinal past its own call count puts the text last', async () => {
  // Clamped, not trusted: the ordinal addresses calls that exist. Both
  // readings answer the same way, which is what makes it a clamp rather than
  // two independent guesses.
  const r = await readings(completionOnlyBackend({
    text: 'BETWEEN', toolCalls: [CALL_A, CALL_B], textOrdinal: 9,
  }));
  assertAgree(
    r,
    { responses: ['function_call', 'function_call', 'message'], messages: ['tool_use', 'tool_use', 'text'] },
    'completion-only, ordinal past the call count',
  );
});

test('CONTROL: a completion-only turn with no text at all opens no message item', async () => {
  // The splice must not invent an empty message where the buffered body
  // reports none — the opposite expected answer at the same ordinal.
  const r = await readings(completionOnlyBackend({
    text: '', toolCalls: [CALL_A, CALL_B], textOrdinal: 1,
  }));
  assertAgree(
    r,
    { responses: ['function_call', 'function_call'], messages: ['tool_use', 'tool_use'] },
    'completion-only, no text',
  );
  assert.equal(r.messagesText, '', 'and no stray empty text block');
});

test('CONTROL: a completion-only turn with no calls is one message', async () => {
  const r = await readings(completionOnlyBackend({ text: 'ONLY', toolCalls: [], textOrdinal: 0 }));
  assertAgree(r, { responses: ['message'], messages: ['text'] }, 'completion-only, no calls');
  assert.equal(r.messagesText, 'ONLY');
});
