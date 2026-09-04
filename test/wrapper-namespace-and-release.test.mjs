import assert from 'node:assert/strict';
import { chmod } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, before, test } from 'node:test';
import { startLocalApiProxy } from '../dist/proxy/http-server.js';
import { ClaudeCodeBackend } from '../dist/proxy/claude-code-backend.js';
import { wrapperCallsPrecedeText } from '../dist/proxy/tool-wrapper.js';
import { parseBackendOutput } from '../dist/proxy/backend-contract.js';

/**
 * The wrapper carries a member whose keys the CLIENT chooses, and the stream
 * may release only what the response path will accept. Those two facts meet
 * here, and every case below is one turn read twice from ONE set of backend
 * bytes.
 *
 * Giving the wrapper a `json` member let a client's own schema put a
 * `"toolCalls":[…]` or a `"text"` INSIDE it. The incremental reader of that
 * time walked at any depth, so the stream announced a tool call assembled out
 * of the client's answer — its name, its id, its arguments — and read the
 * turn's block order off the client's data. The reader that reads a parsed
 * object was right throughout; it is now the only reader, and the key walk in
 * `tool-wrapper.ts` is held to the same rule here.
 *
 * Separately, the stream's release gate restated the backstop's conditions
 * instead of sharing them, so a `status:"tool_calls"` with an empty array and
 * a status outside the schema both streamed a full answer that was then
 * refused.
 */

const here = dirname(fileURLToPath(import.meta.url));
const streamingClaude = resolve(here, 'fixtures/streaming-claude.cjs');

before(async () => { await chmod(streamingClaude, 0o755); });
afterEach(() => { delete process.env.WRAPPER_RAW; });

const TOOLS = [
  { type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } },
  { type: 'function', function: { name: 'get_time', parameters: { type: 'object', properties: { tz: { type: 'string' } } } } },
];
const schemaFor = (properties) => ({
  type: 'json_schema',
  json_schema: { name: 'v', strict: true, schema: { type: 'object', additionalProperties: false, properties, required: Object.keys(properties) } },
});

async function bothReadings(raw, body) {
  process.env.WRAPPER_RAW = raw;
  const backend = new ClaudeCodeBackend({ command: streamingClaude, cwd: process.cwd(), model: 'sonnet', timeoutMs: 30_000 });
  const server = await startLocalApiProxy({ backend, host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000 });
  try {
    const post = (extra) => fetch(`${server.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer local' },
      body: JSON.stringify({ ...body, ...extra }),
    });
    const bufferedRes = await post({});
    const buffered = await bufferedRes.json();
    const streamedRes = await post({ stream: true });
    const wire = await streamedRes.text();
    // A held tool turn is refused before the response commits: the refusal is
    // then the stream response's own status and body, not a frame.
    let refusal;
    if (streamedRes.status !== 200) { try { refusal = JSON.parse(wire).error?.message; } catch { refusal = wire; } }
    const frames = wire.split('\n')
      .filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim())
      .filter((c) => c && c !== '[DONE]')
      .flatMap((c) => { try { return [JSON.parse(c)]; } catch { return []; } });
    const call = (t) => ({ id: t.id, name: t.function?.name });
    return {
      status: bufferedRes.status,
      bufferedText: buffered.choices?.[0]?.message?.content ?? '',
      bufferedCalls: (buffered.choices?.[0]?.message?.tool_calls ?? []).map((c) => ({ id: c.id, name: c.function.name })),
      streamedText: frames.flatMap((f) => (f.choices ?? []).map((c) => c.delta?.content).filter(Boolean)).join(''),
      streamedCalls: [...new Map(frames
        .flatMap((f) => (f.choices ?? []).flatMap((c) => c.delta?.tool_calls ?? []))
        .filter((t) => t.id || t.function?.name).map((t) => [t.index, call(t)])).values()],
      error: refusal ?? frames.find((f) => f.error)?.error?.message,
    };
  } finally {
    await server.close();
    await backend.close();
  }
}

test("a client schema's own `toolCalls` does not become the turn's tool call", async () => {
  const r = await bothReadings(
    '{"status":"tool_calls","json":{"toolCalls":[{"id":"CLIENT","name":"get_time","arguments":"{}"}]},"text":"","toolCalls":[{"id":"c1","name":"get_weather","arguments":"{\\"city\\":\\"Seoul\\"}"}]}',
    { model: 'm', messages: [{ role: 'user', content: 'q' }], tools: TOOLS, response_format: schemaFor({ toolCalls: { type: 'array' } }) },
  );
  assert.deepEqual(r.bufferedCalls, [{ id: 'c1', name: 'get_weather' }]);
  assert.deepEqual(r.streamedCalls, r.bufferedCalls, 'the stream announced a call built from the client\'s answer');
});

for (const [label, raw, extra] of [
  ['a required turn whose `toolCalls` array is empty',
    '{"status":"tool_calls","text":"Seoul is sunny. No lookup needed.","toolCalls":[]}', { tool_choice: 'required' }],
  ['a status the schema does not allow',
    '{"status":"done","text":"Seoul is sunny.","toolCalls":[]}', {}],
]) {
  test(`${label} is refused on BOTH paths, with nothing delivered first`, async () => {
    const r = await bothReadings(raw, { model: 'm', messages: [{ role: 'user', content: 'q' }], tools: TOOLS, ...extra });
    assert.equal(r.status, 502, 'the buffered reading must refuse it');
    assert.equal(r.streamedText, '', `the stream delivered ${JSON.stringify(r.streamedText)} before refusing`);
    assert.ok(r.error, 'the stream must still say why');
  });
}

test('CONTROL: an ordinary narrated tool call is unaffected', async () => {
  const r = await bothReadings(
    '{"status":"tool_calls","text":"looking","toolCalls":[{"id":"c1","name":"get_weather","arguments":"{\\"city\\":\\"Seoul\\"}"}]}',
    { model: 'm', messages: [{ role: 'user', content: 'q' }], tools: TOOLS },
  );
  assert.equal(r.status, 200);
  assert.equal(r.streamedText, 'looking');
  assert.deepEqual(r.streamedCalls, [{ id: 'c1', name: 'get_weather' }]);
  assert.deepEqual(r.bufferedCalls, r.streamedCalls);
});

// Block order is read off the WRAPPER's keys, never off the client's data.
for (const [label, raw, callsFirst] of [
  ["a client `text` property, wrapper's calls first", '{"status":"tool_calls","json":{"text":"x"},"toolCalls":[{"id":"c1","name":"g","arguments":"{}"}],"text":"AFTER"}', true],
  ["a client `toolCalls` property, wrapper's text first", '{"status":"tool_calls","json":{"toolCalls":["a"]},"text":"BEFORE","toolCalls":[{"id":"c1","name":"g","arguments":"{}"}]}', false],
  ['CONTROL no json member, calls first', '{"status":"tool_calls","toolCalls":[{"id":"c1","name":"g","arguments":"{}"}],"text":"AFTER"}', true],
  ['CONTROL no json member, text first', '{"status":"tool_calls","text":"BEFORE","toolCalls":[{"id":"c1","name":"g","arguments":"{}"}]}', false],
]) {
  test(`wrapper key order: ${label}`, () => {
    assert.equal(wrapperCallsPrecedeText(raw), callsFirst);
  });
}

/**
 * The generalizing guard: no data the CLIENT controls may change how the
 * wrapper is read, whatever it is named or wherever it sits.
 *
 * A tool call's `arguments` is client-shaped — a JSON STRING whose content is
 * the client's own object — so it is the nested place a client's own keys
 * actually reach, escaped inside that string. Sweeping the wrapper's own key
 * names through it catches the next reader that walks at any depth, without
 * anyone having to think of it again. This class of defect was fixed in one
 * reader per round for three rounds while the others kept their own walk; the
 * wrapper now has one reader and one key walk, and this sweep holds both to it.
 * An `arguments` member that is an OBJECT is not the schema's shape and is
 * refused (round 20), so a client's keys can no longer sit there unescaped.
 */
const WRAPPER_KEYS = ['status', 'text', 'toolCalls'];
const DECOYS = {
  status: '"message"',
  text: '"DECOY NARRATION"',
  toolCalls: '[{"id":"DECOY","name":"get_time","arguments":"{}"}]',
};

for (const key of WRAPPER_KEYS) {
  for (const [orderLabel, build] of [
    ['the call before the narration', (decoyArgs) => `{"status":"tool_calls","toolCalls":[{"id":"c1","name":"get_weather","arguments":${decoyArgs}}],"text":"REAL"}`],
    ['the narration before the call', (decoyArgs) => `{"status":"tool_calls","text":"REAL","toolCalls":[{"id":"c1","name":"get_weather","arguments":${decoyArgs}}]}`],
  ]) {
    test(`a client \`arguments\` key named \`${key}\` (${orderLabel}) cannot change how the wrapper reads`, () => {
      const clientObject = `{"${key}":${DECOYS[key]}}`;
      const raw = build(JSON.stringify(clientObject));
      const request = {
        model: 'm', shape: 'openai-chat', messages: [], jsonMode: false,
        tools: [{ name: 'get_weather', inputSchema: { type: 'object' } }, { name: 'get_time', inputSchema: { type: 'object' } }],
        toolChoice: { type: 'auto' }, raw: {},
      };
      const parsed = parseBackendOutput(request, raw);
      assert.deepEqual(parsed.toolCalls.map((c) => c.name), ['get_weather'], 'the reader took the decoy for a call');
      assert.equal(parsed.toolCalls[0].arguments, clientObject, 'the client object reaches the call byte for byte');
      assert.equal(parsed.text, 'REAL', 'the reader narrated the decoy');
      assert.equal(wrapperCallsPrecedeText(raw), orderLabel.startsWith('the call'), 'the decoy moved the block order');
      // The same client object as an unescaped OBJECT member is the wrong
      // shape for the wrapper, and is refused rather than re-serialized.
      assert.throws(() => parseBackendOutput(request, build(clientObject)), (e) => e.statusCode === 502 && /not a string/.test(e.message));
    });
  }
}
