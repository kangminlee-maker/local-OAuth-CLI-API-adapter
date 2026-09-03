import assert from 'node:assert/strict';
import { chmod } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, before, test } from 'node:test';
import { startLocalApiProxy } from '../dist/proxy/http-server.js';
import { ClaudeCodeBackend } from '../dist/proxy/claude-code-backend.js';
import { textMayBeRefused } from '../dist/proxy/backend-contract.js';

/**
 * A member was removed from the tool wrapper; the gates written to protect it
 * were not.
 *
 * While the wrapper carried a `json` member, an answer turn's `text` was not
 * the answer and holding it back was right. With that member gone the wrapper's
 * only fields are `status`, `text` and `toolCalls`, and `parseToolDecision`
 * returns `text` as the answer — so the gate held back the only answer there
 * was. A client asking for JSON alongside tools received nothing for the whole
 * generation and then the entire answer in one frame.
 *
 * The gate was also spelled too widely. `!request.jsonMode` covers a client's
 * own `json_schema`, which the response path never refuses: those turns were
 * withheld against a rejection that cannot happen. `textMayBeRefused` is the
 * one predicate the backstop actually uses, so a gate cannot drift from it.
 */

const here = dirname(fileURLToPath(import.meta.url));
const streamingClaude = resolve(here, 'fixtures/streaming-claude.cjs');
const structuredClaude = resolve(here, 'fixtures/structured-claude.cjs');

before(async () => {
  await chmod(streamingClaude, 0o755);
  await chmod(structuredClaude, 0o755);
});
afterEach(() => {
  delete process.env.WRAPPER_RAW;
  delete process.env.STRUCTURED_RAW;
});

const TOOLS = [
  { type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } },
  { type: 'function', function: { name: 'get_time', parameters: { type: 'object', properties: { tz: { type: 'string' } } } } },
];

const JSON_SCHEMA = {
  type: 'json_schema',
  json_schema: { name: 'answer', strict: true, schema: { type: 'object', properties: { ok: { type: 'number' } } } },
};

async function streamed(raw, body) {
  process.env.WRAPPER_RAW = raw;
  const backend = new ClaudeCodeBackend({ command: streamingClaude, cwd: process.cwd(), model: 'sonnet', timeoutMs: 30_000 });
  const server = await startLocalApiProxy({ backend, host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000 });
  try {
    const res = await fetch(`${server.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer local' },
      body: JSON.stringify({ ...body, stream: true }),
    });
    const chunks = (await res.text()).split('\n')
      .filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim())
      .filter((c) => c && c !== '[DONE]')
      .flatMap((c) => { try { return [JSON.parse(c)]; } catch { return []; } })
      .flatMap((f) => (f.choices ?? []).map((c) => c.delta?.content).filter(Boolean));
    return { delivered: chunks.join(''), frames: chunks.length };
  } finally {
    await server.close();
    await backend.close();
  }
}

// The wrapper's `text` IS the answer, so it streams as it is produced. The
// answer is 24 characters and the fixture writes one per delta: a single frame
// means the whole generation was silent and the answer arrived at the end.
const ANSWER = 'Here is the verdict: Yes.';

for (const [label, format] of [
  ['json_object', { type: 'json_object' }],
  ['json_schema', JSON_SCHEMA],
]) {
  test(`an answer turn with tools and ${label} streams as it is produced`, async () => {
    const { delivered, frames } = await streamed(
      JSON.stringify({ status: 'message', text: ANSWER, toolCalls: [] }),
      { model: 'm', messages: [{ role: 'user', content: 'verdict?' }], tools: TOOLS, response_format: format },
    );
    assert.equal(delivered, ANSWER, 'the answer did not arrive');
    assert.ok(frames > 1, `the turn arrived in one piece (${frames} frame)`);
  });
}

test('CONTROL a required turn that answered instead of calling still delivers nothing', async () => {
  const { delivered, frames } = await streamed(
    JSON.stringify({ status: 'message', text: ANSWER, toolCalls: [] }),
    {
      model: 'm', messages: [{ role: 'user', content: 'weather?' }],
      tools: TOOLS, tool_choice: 'required', response_format: { type: 'json_object' },
    },
  );
  assert.equal(delivered, '', 'the refused answer reached the wire');
  assert.equal(frames, 0);
});

/**
 * Without tools the two JSON formats must behave DIFFERENTLY, which is the
 * whole point of the predicate: `json_object` can be refused for not being an
 * object, so its text is held until it is complete; a client's own schema is
 * exempt from that check, so holding it back bought nothing.
 */
test('without tools a client schema streams while a schemaless json_object is held', async () => {
  const body = { model: 'm', messages: [{ role: 'user', content: 'x' }] };
  const withSchema = await streamed('{"ok":1}', { ...body, response_format: JSON_SCHEMA });
  const schemaless = await streamed('{"ok":1}', { ...body, response_format: { type: 'json_object' } });

  assert.equal(withSchema.delivered, '{"ok":1}');
  assert.ok(withSchema.frames > 1, `a client schema was withheld (${withSchema.frames} frame)`);

  assert.equal(schemaless.delivered, '{"ok":1}', 'the held answer was lost rather than held');
  assert.equal(schemaless.frames, 1, 'a refusable answer was released before it was complete');
});

test('textMayBeRefused is true only for the format the backstop can refuse', () => {
  const base = { model: 'm', shape: 'openai-chat', messages: [], tools: [], toolChoice: { type: 'auto' }, raw: {} };
  assert.equal(textMayBeRefused({ ...base, jsonMode: true, jsonSchema: undefined }), true, 'json_object');
  assert.equal(textMayBeRefused({ ...base, jsonMode: true, jsonSchema: { type: 'object' } }), false, 'json_schema');
  assert.equal(textMayBeRefused({ ...base, jsonMode: false, jsonSchema: undefined }), false, 'no JSON format');
});

/**
 * A present `null` is an answer, not an absent member.
 *
 * `message.structured_output ?? waiter.structuredOutput` cannot tell them
 * apart, so a client whose schema is `{"type":"null"}` — satisfied by the
 * runtime, which returned exactly `null` — was handed the empty fallback text
 * instead of the bytes it asked for.
 */
for (const [label, raw, expected] of [
  ['a present null', 'null', 'null'],
  ['CONTROL a present object', '{"a":1}', '{"a":1}'],
  ['CONTROL a present false', 'false', 'false'],
  ['CONTROL a present zero', '0', '0'],
]) {
  test(`the Claude backend publishes ${label} as its own bytes`, async () => {
    process.env.STRUCTURED_RAW = raw;
    const backend = new ClaudeCodeBackend({ command: structuredClaude, cwd: process.cwd(), model: 'sonnet', timeoutMs: 30_000 });
    try {
      const result = await backend.generate({
        shape: 'openai-chat', model: 'sonnet', stream: false,
        streamOptions: { includeUsage: false, includeObfuscation: false },
        jsonMode: true, jsonSchema: { type: 'null' },
        tools: [], toolChoice: { type: 'auto' }, raw: {},
        messages: [{ role: 'user', content: 'x', images: [] }],
      });
      assert.equal(result.text, expected);
    } finally {
      await backend.close();
    }
  });
}
