import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startLocalApiProxy } from '../dist/proxy/http-server.js';
import { ToolCallDeltaExtractor } from '../dist/proxy/tool-call-stream.js';
import { parseBackendOutput } from '../dist/proxy/backend-contract.js';

/**
 * The decision wrapper has TWO readers — `ToolCallDeltaExtractor` for the live
 * stream and `parseBackendOutput` for the buffered body — and they must agree
 * about what the backend said.
 *
 * They did not. The extractor read `toolCalls` whatever `status` said, and it
 * withheld any call whose `id`/`name` never closed, while the parse keyed
 * everything on `status` and substituted `call_N` / `tool` for a missing
 * identity. Each reader was defensible alone; together they told one client
 * two different stories about the same turn.
 */

const PARAMS = { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false };
const CALL = (id) => `{"id":${JSON.stringify(id)},"name":"get_weather","arguments":"{\\"city\\":\\"A\\"}"}`;

function backendFor(raw) {
  const resultFor = (request) => {
    const parsed = parseBackendOutput(request, raw);
    return {
      id: 'x', model: 'm', text: parsed.text, toolCalls: parsed.toolCalls,
      ...(parsed.textRuns ? { textRuns: parsed.textRuns } : {}),
      usage: { inputTokens: 1, outputTokens: 1, source: 'estimated' }, latencyMs: 1,
    };
  };
  return {
    name: 't', model: 'm',
    async generate(request) { return resultFor(request); },
    async *stream(request) {
      const extractor = new ToolCallDeltaExtractor();
      for (const event of extractor.push(raw)) yield event;
      yield { type: 'completed', result: resultFor(request) };
    },
    async close() {},
  };
}

function sse(body) {
  return body.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim())
    .filter((c) => c && c !== '[DONE]').map((c) => JSON.parse(c));
}

async function bothReadings(raw) {
  const server = await startLocalApiProxy({ backend: backendFor(raw), host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000 });
  try {
    const headers = { 'content-type': 'application/json', 'x-api-key': 'local', 'anthropic-version': '2023-06-01' };
    const body = { model: 'm', max_tokens: 64, messages: [{ role: 'user', content: 'w' }], tools: [{ name: 'get_weather', description: 'w', input_schema: PARAMS }] };
    const post = (extra) => fetch(`${server.url}/v1/messages`, { method: 'POST', headers, body: JSON.stringify({ ...body, ...extra }) });
    const buffered = await (await post({})).json();
    const events = sse(await (await post({ stream: true })).text());
    return {
      buffered: (buffered.content ?? []).map((block) => (block.type === 'text' ? 'text' : `tool_use:${block.id}`)),
      streamed: events.filter((e) => e.type === 'content_block_start')
        .map((e) => (e.content_block.type === 'text' ? 'text' : `tool_use:${e.content_block.id}`)),
      stopReason: buffered.stop_reason,
      status: buffered.type === 'error' ? 'error' : 'ok',
    };
  } finally {
    await server.close();
  }
}

test('a call whose identity the wrapper never gave is announced by BOTH readers', async () => {
  // The body substitutes `call_1`; the stream used to announce nothing, which
  // moved the narration in front of a call the body put behind it.
  const { buffered, streamed } = await bothReadings(`{"status":"tool_calls","toolCalls":[${CALL('')}],"text":"hi"}`);
  assert.deepEqual(buffered, ['tool_use:call_1', 'text']);
  assert.deepEqual(streamed, buffered);
});

test('CONTROL: the same wrapper with a real id already agreed', async () => {
  const { buffered, streamed } = await bothReadings(`{"status":"tool_calls","toolCalls":[${CALL('c1')}],"text":"hi"}`);
  assert.deepEqual(buffered, ['tool_use:c1', 'text']);
  assert.deepEqual(streamed, buffered);
});

test('a wrapper that says `message` streams no tool call, however many it lists', async () => {
  // The stream used to hand the client a `tool_use` block — which it executes
  // and echoes a `tool_result` for — that the buffered body denied, alongside
  // `stop_reason: "end_turn"`, a pairing the direct API never sends.
  const { buffered, streamed, stopReason } = await bothReadings(`{"status":"message","text":"answer","toolCalls":[${CALL('c1')}]}`);
  assert.deepEqual(buffered, ['text']);
  assert.deepEqual(streamed, ['text']);
  assert.equal(stopReason, 'end_turn');
});

test('CONTROL: a `message` wrapper with no calls is unchanged', async () => {
  const { buffered, streamed } = await bothReadings('{"status":"message","text":"answer","toolCalls":[]}');
  assert.deepEqual(buffered, ['text']);
  assert.deepEqual(streamed, ['text']);
});

for (const [label, raw] of [
  ['no status at all', `{"text":"answer","toolCalls":[${CALL('c1')}]}`],
  ['a status outside the schema', `{"status":"tool_call","text":"answer","toolCalls":[${CALL('c1')}]}`],
]) {
  test(`a wrapper with ${label} is refused, not handed to the client`, async () => {
    // The buffered body used to return the wrapper JSON itself as the
    // assistant's answer — this proxy's internal grammar, delivered verbatim.
    const { status, buffered } = await bothReadings(raw);
    assert.equal(status, 'error', `the wrapper leaked to the client as: ${JSON.stringify(buffered)}`);
  });
}

test('CONTROL: an object that is not wrapper-shaped is still the answer', async () => {
  const request = {
    model: 'm', shape: 'openai-chat', messages: [], jsonMode: false,
    tools: [{ name: 'get_weather', inputSchema: PARAMS }], toolChoice: { type: 'auto' }, raw: {},
  };
  assert.equal(parseBackendOutput(request, '{"my":"object"}').text, '{"my":"object"}');
  assert.equal(parseBackendOutput(request, 'plain prose').text, 'plain prose');
});

/**
 * The two readers must also agree when a call's `arguments` is an OBJECT — a
 * shape the buffered parse deliberately tolerates (`normalizeToolCall`
 * serialises it), so the streamed reader has to survive it too.
 *
 * It did not. `readStringProperty` stepped over string values and merely
 * advanced past the key of any other value, so the scan walked INSIDE nested
 * structures: an `arguments` payload carrying a `text` field was streamed as
 * the turn's narration, and one carrying a `name` field became the CALL'S
 * NAME — a tool the client has no handler for, latched so nothing corrects it.
 * Both are swept here across the key orders that decide which one wins.
 */
const ARGUMENT_SHAPES = [
  ['a string payload', '"{\\"city\\":\\"Seoul\\"}"'],
  ['an object payload', '{"city":"Seoul"}'],
  ['an object payload carrying a `text` key', '{"text":"Seoul"}'],
  ['an object payload carrying a `name` key', '{"name":"Ada"}'],
  ['an object payload carrying both', '{"text":"Seoul","name":"Ada"}'],
];

for (const [shapeLabel, args] of ARGUMENT_SHAPES) {
  for (const [orderLabel, wrapper] of [
    ['calls before text', `{"status":"tool_calls","toolCalls":[{"id":"c1","name":"get_weather","arguments":${args}}],"text":"looking"}`],
    ['text before calls', `{"status":"tool_calls","text":"looking","toolCalls":[{"id":"c1","name":"get_weather","arguments":${args}}]}`],
    ['arguments written first', `{"status":"tool_calls","toolCalls":[{"arguments":${args},"id":"c1","name":"get_weather"}],"text":"looking"}`],
  ]) {
    test(`both readers agree: ${shapeLabel}, ${orderLabel}`, () => {
      const request = {
        model: 'm', shape: 'openai-chat', messages: [], jsonMode: false,
        tools: [{ name: 'get_weather', inputSchema: PARAMS }], toolChoice: { type: 'auto' }, raw: {},
      };
      const parsed = parseBackendOutput(request, wrapper);
      const events = new ToolCallDeltaExtractor(false).push(wrapper);
      const streamedText = events.filter((e) => e.type === 'text_delta').map((e) => e.delta).join('');
      const streamedNames = [...new Set(events.filter((e) => e.type === 'tool_call_delta').map((e) => e.name))];
      assert.equal(streamedText, parsed.text, 'the streamed narration is not the turn\'s narration');
      assert.deepEqual(streamedNames, parsed.toolCalls.map((c) => c.name), 'the streamed call identity is not the turn\'s');
      // The narration is the wrapper's own `text`, never anything lifted out
      // of a call's arguments.
      assert.equal(parsed.text, 'looking');
      assert.deepEqual(streamedNames, ['get_weather']);
    });
  }
}
