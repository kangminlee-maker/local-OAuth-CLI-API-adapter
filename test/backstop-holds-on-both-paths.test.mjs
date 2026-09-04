import assert from 'node:assert/strict';
import { chmod } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, before, test } from 'node:test';
import { startLocalApiProxy } from '../dist/proxy/http-server.js';
import { ClaudeCodeBackend } from '../dist/proxy/claude-code-backend.js';
import { parseBackendOutput, outputSchemaFor } from '../dist/proxy/backend-contract.js';

/**
 * The response path refuses output that breaks the turn's contract. That
 * refusal is only worth something if the stream refuses it too.
 *
 * It did not. The backstop landed on the buffered reading alone, so the same
 * turn that returned `502` with no body when buffered streamed the ENTIRE
 * offending answer as content deltas and appended an error frame after it —
 * bytes the client has already read, next to a refusal it cannot act on. The
 * repo's own rule is that delivered bytes are final, so an error frame after
 * the answer is a retraction that does not work.
 *
 * Both decisions are knowable before any byte is released: whether the turn
 * requires a call, and whether its output has to be JSON.
 */

const here = dirname(fileURLToPath(import.meta.url));
const streamingClaude = resolve(here, 'fixtures/streaming-claude.cjs');

before(async () => { await chmod(streamingClaude, 0o755); });
afterEach(() => { delete process.env.WRAPPER_RAW; });

const TOOLS = [
  { type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } },
  { type: 'function', function: { name: 'get_time', parameters: { type: 'object', properties: { tz: { type: 'string' } } } } },
];

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
    const wire = await res.text();
    if (res.status !== 200) {
      // A held tool turn is refused before the response commits, so the
      // refusal is the response's own status and body — nothing was delivered.
      let json; try { json = JSON.parse(wire); } catch { json = {}; }
      return { delivered: '', error: json.error?.message ?? wire };
    }
    const frames = wire.split('\n')
      .filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim())
      .filter((c) => c && c !== '[DONE]')
      .flatMap((c) => { try { return [JSON.parse(c)]; } catch { return []; } });
    return {
      delivered: frames.flatMap((f) => (f.choices ?? []).map((c) => c.delta?.content).filter(Boolean)).join(''),
      error: frames.find((f) => f.error)?.error?.message,
    };
  } finally {
    await server.close();
    await backend.close();
  }
}

test('a required turn answered without a call delivers nothing before it is refused', async () => {
  const { delivered, error } = await streamed(
    '{"status":"message","text":"Seoul is sunny, 24C. No lookup needed.","toolCalls":[]}',
    { model: 'm', messages: [{ role: 'user', content: 'weather?' }], tool_choice: 'required', tools: TOOLS },
  );
  assert.equal(delivered, '', `the refused answer was already on the wire: ${JSON.stringify(delivered)}`);
  assert.match(error ?? '', /without calling a tool/);
});

test('a json-mode turn answered with prose delivers nothing before it is refused', async () => {
  const { delivered, error } = await streamed(
    'Sure! Here is the JSON you asked for.',
    { model: 'm', messages: [{ role: 'user', content: 'json' }], response_format: { type: 'json_object' } },
  );
  assert.equal(delivered, '', `the refused answer was already on the wire: ${JSON.stringify(delivered)}`);
  assert.match(error ?? '', /not a JSON object/);
});

test('CONTROL: an ordinary text turn still streams live', async () => {
  const { delivered, error } = await streamed('hello there', { model: 'm', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(delivered, 'hello there', 'holding output must be scoped to turns that can be refused');
  assert.equal(error, undefined);
});

/**
 * `json_object` means "any JSON object" and the object rule was measured for
 * it. `json_schema` means whatever root the CLIENT declared. Enforcing the
 * first against the second made a schema rooted at an array unanswerable: the
 * runtime was handed `{"type":"array"}` and then every array it produced was
 * refused, so the only replies that survived were the ones violating the
 * client's own schema.
 */
const arrayRooted = {
  model: 'm', shape: 'anthropic-messages', messages: [], tools: [], toolChoice: { type: 'auto' }, raw: {},
  jsonMode: true, jsonSchema: { type: 'array', items: { type: 'number' } },
};

test('a client schema rooted at an array is handed to the runtime AND accepted back', () => {
  assert.deepEqual(outputSchemaFor(arrayRooted), { type: 'array', items: { type: 'number' } });
  for (const conforming of ['[1,2,3]', '[]']) {
    assert.equal(parseBackendOutput(arrayRooted, conforming).text, conforming);
  }
});

test('CONTROL: json_object with no client schema still requires an object', () => {
  const jsonObject = { ...arrayRooted, jsonSchema: undefined };
  assert.throws(() => parseBackendOutput(jsonObject, '[1,2,3]'), (err) => err.statusCode === 502);
  assert.equal(parseBackendOutput(jsonObject, '{"a":1}').text, '{"a":1}');
});
