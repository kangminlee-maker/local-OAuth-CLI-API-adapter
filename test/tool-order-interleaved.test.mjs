// A turn whose parts arrive CALL, TEXT, CALL.
//
// The order used to be carried as one boolean, `toolCallsBeforeText`. That
// boolean can only say "all calls before the text" or "all calls after it", so
// this turn — the one shape that is neither — came out of the buffered body in
// an order the stream never announced:
//
//   /v1/responses buffered  ['function_call','function_call','message']
//   /v1/responses streamed  ['function_call','message','function_call']
//   /v1/messages  buffered  ['tool_use','tool_use','text']
//   /v1/messages  streamed  ['tool_use','text','tool_use']
//
// and `response.output_item.done` arrived [0,2,1] — a client told that a later
// item finished before an earlier one, which is the exact promise the ordering
// work claims to keep. The order is carried as a COUNT instead: how many of the
// turn's tool calls came before its text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startLocalApiProxy } from '../dist/proxy/http-server.js';

const PARAMS = { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false };
const CALL_A = { id: 'fc_1', name: 'get_weather', arguments: '{"city":"A"}' };
const CALL_B = { id: 'fc_2', name: 'get_weather', arguments: '{"city":"B"}' };

function backendFor({ toolCalls, text, textOrdinal, order }) {
  const result = {
    id: 'x', model: 'm', text, toolCalls,
    ...(textOrdinal === undefined ? {} : { textOrdinal }),
    usage: { inputTokens: 1, outputTokens: 1, source: 'estimated' }, latencyMs: 1,
  };
  return {
    name: 't', model: 'm',
    async generate() { return result; },
    async *stream() {
      for (const step of order) {
        if (step === 'text') { yield { type: 'text_delta', delta: text }; continue; }
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

const sse = (t) => t.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim())
  .filter((x) => x && x !== '[DONE]').map((x) => { try { return JSON.parse(x); } catch { return null; } }).filter(Boolean);

async function surfaces(backend) {
  const server = await startLocalApiProxy({ backend, host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000 });
  const post = (p, b, h = {}) => fetch(`${server.url}${p}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify(b),
  });
  const rTools = [{ type: 'function', name: 'get_weather', description: 'w', parameters: PARAMS, strict: true }];
  const mTools = [{ name: 'get_weather', description: 'w', input_schema: PARAMS }];
  const ah = { 'x-api-key': 'local', 'anthropic-version': '2023-06-01' };
  try {
    const rBuf = await (await post('/v1/responses', { model: 'm', input: 'w', tools: rTools })).json();
    const rStr = sse(await (await post('/v1/responses', { model: 'm', input: 'w', stream: true, tools: rTools })).text());
    const mBuf = await (await post('/v1/messages', { model: 'm', max_tokens: 64, messages: [{ role: 'user', content: 'w' }], tools: mTools }, ah)).json();
    const mStr = sse(await (await post('/v1/messages', { model: 'm', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'w' }], tools: mTools }, ah)).text());
    return {
      responsesBuffered: rBuf.output?.map((o) => o.type),
      responsesAdded: rStr.filter((e) => e.type === 'response.output_item.added').map((e) => e.item?.type),
      responsesDoneIndices: rStr.filter((e) => e.type === 'response.output_item.done').map((e) => e.output_index),
      responsesCompleted: rStr.find((e) => e.type === 'response.completed')?.response?.output?.map((o) => o.type),
      messagesBuffered: mBuf.content?.map((c) => c.type),
      messagesStarts: rStrBlocks(mStr),
    };
  } finally { await server.close(); }
}
const rStrBlocks = (events) => events.filter((e) => e.type === 'content_block_start').map((e) => e.content_block?.type);

test('a call/text/call turn reads the same on the buffered and streamed Responses surface', async () => {
  const s = await surfaces(backendFor({
    toolCalls: [CALL_A, CALL_B], text: 'BETWEEN', textOrdinal: 1, order: [0, 'text', 1],
  }));
  const announced = ['function_call', 'message', 'function_call'];
  assert.deepEqual(s.responsesAdded, announced, 'the stream announces the turn in emission order');
  assert.deepEqual(s.responsesBuffered, announced, 'the buffered body must report the order the stream announced');
  assert.deepEqual(s.responsesCompleted, announced, 'response.completed carries the same order');
});

test('a call/text/call turn closes Responses items in ascending announced index', async () => {
  const s = await surfaces(backendFor({
    toolCalls: [CALL_A, CALL_B], text: 'BETWEEN', textOrdinal: 1, order: [0, 'text', 1],
  }));
  assert.deepEqual(s.responsesDoneIndices, [0, 1, 2],
    'a client must never be told a later item finished before an earlier one');
});

test('a call/text/call turn reads the same on the buffered and streamed Messages surface', async () => {
  const s = await surfaces(backendFor({
    toolCalls: [CALL_A, CALL_B], text: 'BETWEEN', textOrdinal: 1, order: [0, 'text', 1],
  }));
  const announced = ['tool_use', 'text', 'tool_use'];
  assert.deepEqual(s.messagesStarts, announced, 'the stream announces the turn in emission order');
  assert.deepEqual(s.messagesBuffered, announced, 'the buffered body must report the order the stream announced');
});

// The two shapes the boolean COULD express must not regress.
test('text first still reads text first on both surfaces', async () => {
  const s = await surfaces(backendFor({
    toolCalls: [CALL_A], text: 'FIRST', textOrdinal: 0, order: ['text', 0],
  }));
  assert.deepEqual(s.responsesBuffered, ['message', 'function_call']);
  assert.deepEqual(s.responsesAdded, ['message', 'function_call']);
  assert.deepEqual(s.messagesBuffered, ['text', 'tool_use']);
  assert.deepEqual(s.responsesDoneIndices, [0, 1]);
});

test('every call before the text still reads that way on both surfaces', async () => {
  const s = await surfaces(backendFor({
    toolCalls: [CALL_A, CALL_B], text: 'AFTER', textOrdinal: 2, order: [0, 1, 'text'],
  }));
  assert.deepEqual(s.responsesBuffered, ['function_call', 'function_call', 'message']);
  assert.deepEqual(s.responsesAdded, ['function_call', 'function_call', 'message']);
  assert.deepEqual(s.messagesBuffered, ['tool_use', 'tool_use', 'text']);
  assert.deepEqual(s.responsesDoneIndices, [0, 1, 2]);
});
