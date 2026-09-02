// One turn, read twice, at the surface a client actually reads.
//
// The backends that speak the decision wrapper give the SAME string to two
// readers: `ToolCallDeltaExtractor` decodes it into live stream events, and
// `parseBackendOutput` parses all of it for the buffered body. The buffered
// reader takes the turn's order from the wrapper's key order; the streamed
// reader used to take it from whatever its incremental decoder produced first,
// which depends on where the backend cut its deltas. A backend that delivered
// the whole wrapper in one delta therefore streamed `[message, function_call]`
// while its own buffered body reported `[function_call, message]` — the same
// turn, two contradictory orders, on `/v1/responses` and `/v1/messages` alike.
//
// These tests assert the agreement end to end, because the extractor and the
// contract each having a defensible rule is exactly how the two surfaces came
// to disagree. The chunkings below bracket the failure: ONE delta is where it
// showed, and eight characters is where the unit guard was looking when it did
// not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startLocalApiProxy } from '../dist/proxy/http-server.js';
import { ToolCallDeltaExtractor } from '../dist/proxy/tool-call-stream.js';
import { parseBackendOutput } from '../dist/proxy/backend-contract.js';

const PARAMS = { type: 'object', properties: { n: { type: 'number' } }, required: ['n'], additionalProperties: false };
const CALL = (n) => `{"id":"c${n}","name":"get","arguments":"{\\"n\\":${n}}"}`;

const CALLS_FIRST = `{"status":"tool_calls","toolCalls":[${CALL(1)}],"text":"AFTER"}`;
const TEXT_FIRST = `{"status":"tool_calls","text":"BEFORE","toolCalls":[${CALL(1)}]}`;

/**
 * A backend that speaks the wrapper, wired the way `ClaudeCodeBackend` and
 * `CodexAppServerBackend` wire it: the shipped extractor over the deltas, the
 * shipped parse over the whole string. Nothing here decides the order — both
 * readings come from the code under test.
 */
function wrapperBackend(raw, chunkSize) {
  const resultFor = (request) => {
    const parsed = parseBackendOutput(request, raw);
    return {
      id: 'x',
      model: 'm',
      text: parsed.text,
      toolCalls: parsed.toolCalls,
      ...(parsed.textOrdinal ? { textOrdinal: parsed.textOrdinal } : {}),
      usage: { inputTokens: 1, outputTokens: 1, source: 'estimated' },
      latencyMs: 1,
    };
  };
  return {
    name: 't',
    model: 'm',
    async generate(request) { return resultFor(request); },
    async *stream(request) {
      const extractor = new ToolCallDeltaExtractor();
      for (let at = 0; at < raw.length; at += chunkSize) {
        for (const event of extractor.push(raw.slice(at, at + chunkSize))) yield event;
      }
      yield { type: 'completed', result: resultFor(request) };
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
  const rTools = [{ type: 'function', name: 'get', description: 'g', parameters: PARAMS, strict: true }];
  const mTools = [{ name: 'get', description: 'g', input_schema: PARAMS }];
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
      messagesStarts: mStr.filter((e) => e.type === 'content_block_start').map((e) => e.content_block?.type),
    };
  } finally { await server.close(); }
}

// A single delta is the arrangement that broke, and eight characters is the one
// the old unit guard fed. `CALLS_FIRST.length` and `TEXT_FIRST.length` deliver
// the wrapper whole.
const CHUNKINGS = [
  ['the whole wrapper in ONE delta', (raw) => raw.length],
  ['eight characters at a time', () => 8],
  ['one character at a time', () => 1],
];

for (const [chunkLabel, sizeOf] of CHUNKINGS) {
  test(`a calls-before-text wrapper reads [call, text] on both Responses surfaces: ${chunkLabel}`, async () => {
    const s = await surfaces(wrapperBackend(CALLS_FIRST, sizeOf(CALLS_FIRST)));
    const produced = ['function_call', 'message'];
    assert.deepEqual(s.responsesAdded, produced, 'the stream announces the turn in the wrapper\'s order');
    assert.deepEqual(s.responsesBuffered, produced, 'the buffered body must report the order the stream announced');
    assert.deepEqual(s.responsesCompleted, produced, 'response.completed carries the same order');
    assert.deepEqual(s.responsesDoneIndices, [0, 1], 'no client is told a later item finished first');
  });

  test(`a calls-before-text wrapper reads [tool_use, text] on both Messages surfaces: ${chunkLabel}`, async () => {
    const s = await surfaces(wrapperBackend(CALLS_FIRST, sizeOf(CALLS_FIRST)));
    const produced = ['tool_use', 'text'];
    assert.deepEqual(s.messagesStarts, produced, 'the stream announces the turn in the wrapper\'s order');
    assert.deepEqual(s.messagesBuffered, produced, 'the buffered body must report the order the stream announced');
  });

  // CONTROL: the opposite key order, whose expected answer is the reverse. A
  // surface stuck on one order would satisfy the case above and fail here.
  test(`CONTROL: a text-before-calls wrapper reads the OTHER way on both surfaces: ${chunkLabel}`, async () => {
    const s = await surfaces(wrapperBackend(TEXT_FIRST, sizeOf(TEXT_FIRST)));
    assert.deepEqual(s.responsesAdded, ['message', 'function_call']);
    assert.deepEqual(s.responsesBuffered, ['message', 'function_call']);
    assert.deepEqual(s.responsesCompleted, ['message', 'function_call']);
    assert.deepEqual(s.responsesDoneIndices, [0, 1]);
    assert.deepEqual(s.messagesStarts, ['text', 'tool_use']);
    assert.deepEqual(s.messagesBuffered, ['text', 'tool_use']);
  });
}

// The point of the sweep, stated as its own claim: the client's reading of the
// turn must not depend on how the backend chose to cut its output.
test('the same wrapper reads identically however the backend chunks it', async () => {
  const readings = [];
  for (const size of [1, 2, 3, 7, 8, 16, 32, CALLS_FIRST.length]) {
    const s = await surfaces(wrapperBackend(CALLS_FIRST, size));
    readings.push(JSON.stringify([s.responsesAdded, s.responsesBuffered, s.messagesStarts, s.messagesBuffered]));
  }
  assert.equal(readings.length, 8, 'every chunking was measured');
  assert.equal(new Set(readings).size, 1, `chunk boundaries changed what the client reads: ${[...new Set(readings)].join(' vs ')}`);
  assert.deepEqual(JSON.parse(readings[0])[0], ['function_call', 'message']);
});

// A turn with SEVERAL calls before its narration is where the ordinal stops
// being a boolean in disguise. `textOrdinal` is how many calls came first, and
// with one call in the wrapper that number and the constant 1 are the same —
// so a rule that reported 1 for every turn was indistinguishable from the
// correct one on every fixture this repo had. On a two-call turn it is not:
// the buffered body splits the calls around the text and reports
// [call, text, call], an order the stream never announced.
const CALLS_FIRST_N = (n) => `{"status":"tool_calls","toolCalls":[${Array.from({ length: n }, (_, i) => CALL(i + 1)).join(',')}],"text":"AFTER"}`;
const TEXT_FIRST_N = (n) => `{"status":"tool_calls","text":"BEFORE","toolCalls":[${Array.from({ length: n }, (_, i) => CALL(i + 1)).join(',')}]}`;

for (const count of [2, 3]) {
  for (const [chunkLabel, sizeOf] of CHUNKINGS) {
    test(`${count} calls before the narration read the same on both Responses surfaces: ${chunkLabel}`, async () => {
      const raw = CALLS_FIRST_N(count);
      const s = await surfaces(wrapperBackend(raw, sizeOf(raw)));
      const produced = [...Array.from({ length: count }, () => 'function_call'), 'message'];
      assert.deepEqual(s.responsesAdded, produced, 'the stream announces every call before the message');
      assert.deepEqual(s.responsesBuffered, produced, 'the buffered body must not split the calls around the text');
      assert.deepEqual(s.responsesCompleted, produced, 'response.completed carries the same order');
      assert.deepEqual(s.responsesDoneIndices, [...Array(count + 1).keys()], 'items close in ascending announced index');
    });

    test(`${count} calls before the narration read the same on both Messages surfaces: ${chunkLabel}`, async () => {
      const raw = CALLS_FIRST_N(count);
      const s = await surfaces(wrapperBackend(raw, sizeOf(raw)));
      const produced = [...Array.from({ length: count }, () => 'tool_use'), 'text'];
      assert.deepEqual(s.messagesStarts, produced, 'the stream announces every call before the text');
      assert.deepEqual(s.messagesBuffered, produced, 'the buffered body must not split the calls around the text');
    });

    // CONTROL: the same calls with the narration in front, whose expected
    // answer is the reverse. A surface that had simply stopped splitting would
    // pass the cases above and fail here.
    test(`CONTROL: ${count} calls AFTER the narration read the other way: ${chunkLabel}`, async () => {
      const raw = TEXT_FIRST_N(count);
      const s = await surfaces(wrapperBackend(raw, sizeOf(raw)));
      const produced = ['message', ...Array.from({ length: count }, () => 'function_call')];
      assert.deepEqual(s.responsesAdded, produced);
      assert.deepEqual(s.responsesBuffered, produced);
      assert.deepEqual(s.messagesStarts, ['text', ...Array.from({ length: count }, () => 'tool_use')]);
      assert.deepEqual(s.messagesBuffered, ['text', ...Array.from({ length: count }, () => 'tool_use')]);
    });
  }
}

test('a multi-call wrapper reads identically however the backend chunks it', async () => {
  const raw = CALLS_FIRST_N(3);
  const readings = [];
  for (const size of [1, 2, 3, 7, 8, 16, 32, raw.length]) {
    const s = await surfaces(wrapperBackend(raw, size));
    readings.push(JSON.stringify([s.responsesAdded, s.responsesBuffered, s.messagesStarts, s.messagesBuffered]));
  }
  assert.equal(readings.length, 8, 'every chunking was measured');
  assert.equal(new Set(readings).size, 1, `chunk boundaries changed what the client reads: ${[...new Set(readings)].join(' vs ')}`);
  assert.deepEqual(JSON.parse(readings[0])[1], ['function_call', 'function_call', 'function_call', 'message']);
});
