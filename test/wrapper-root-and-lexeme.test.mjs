import assert from 'node:assert/strict';
import { chmod } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, before, test } from 'node:test';
import { ClaudeCodeBackend } from '../dist/proxy/claude-code-backend.js';
import { ToolCallDeltaExtractor, rawTopLevelValue } from '../dist/proxy/tool-call-stream.js';
import { parseBackendOutput } from '../dist/proxy/backend-contract.js';

const here = dirname(fileURLToPath(import.meta.url));
const structuredClaude = resolve(here, 'fixtures/structured-claude.cjs');
before(async () => { await chmod(structuredClaude, 0o755); });
afterEach(() => { delete process.env.STRUCTURED_RAW; });

const request = {
  model: 'm', shape: 'openai-chat', messages: [], jsonMode: false,
  tools: [{ name: 'get_weather', inputSchema: { type: 'object' } }],
  toolChoice: { type: 'auto' }, raw: {},
};

/**
 * The wrapper is an OBJECT, and only its own top level is the wrapper.
 *
 * The buffered reader checks the parsed root and hands back anything else as
 * the answer. The streamed reader had no root notion at all: given
 * `[{"status":"tool_calls",…}]` it read the object INSIDE the array and
 * announced a real, executable tool call that the buffered reading of the same
 * bytes said never happened.
 */
for (const [label, raw] of [
  ['an array wrapping the wrapper', '[{"status":"tool_calls","toolCalls":[{"id":"call_1","name":"get_weather","arguments":"{}"}],"text":"answer"}]'],
  ['an array of two wrappers', '[{"status":"message","text":"a","toolCalls":[]},{"status":"tool_calls","toolCalls":[{"id":"c","name":"get_weather","arguments":"{}"}],"text":""}]'],
  ['a bare string that merely contains wrapper text', '"status tool_calls toolCalls"'],
]) {
  test(`${label} is not read as a wrapper by either reader`, () => {
    const parsed = parseBackendOutput(request, raw);
    const events = new ToolCallDeltaExtractor({}).push(raw);
    assert.deepEqual(parsed.toolCalls, [], 'the body invented a call');
    assert.deepEqual(events, [], `the stream emitted ${JSON.stringify(events)} for a non-wrapper`);
    assert.equal(parsed.text, raw, 'a non-wrapper is the answer, verbatim');
  });
}

test('CONTROL: a real wrapper object is still read as one', () => {
  const raw = '{"status":"tool_calls","toolCalls":[{"id":"c1","name":"get_weather","arguments":"{}"}],"text":"answer"}';
  assert.deepEqual(parseBackendOutput(request, raw).toolCalls.map((c) => c.name), ['get_weather']);
  const names = new ToolCallDeltaExtractor({}).push(raw)
    .filter((e) => e.type === 'tool_call_delta').map((e) => e.name);
  assert.deepEqual([...new Set(names)], ['get_weather']);
});

// Numbers survive as written. Re-serializing a parsed value rounds every one of
// them through IEEE-754 first.
const LEXEMES = [
  ['an integer above 2^53', '{"id":9007199254740993}'],
  ['a twenty-digit integer', '{"id":12345678901234567890}'],
  ['a decimal with more digits than a double holds', '{"v":0.1000000000000000055511151231257827}'],
  ['an exponent form', '{"v":1e400}'],
  ['CONTROL an ordinary number', '{"id":42}'],
];

for (const [label, answer] of LEXEMES) {
  test(`the Claude backend carries ${label} through without rounding it`, async () => {
    // A plain `json_schema` turn: the CLI's `structured_output` IS the client's
    // object, and it used to be re-serialized from a parsed value on the way
    // out — so every number went through IEEE-754 first and an id of
    // `9007199254740993` reached the client as `…992`.
    process.env.STRUCTURED_RAW = answer;
    const backend = new ClaudeCodeBackend({ command: structuredClaude, cwd: process.cwd(), model: 'sonnet', timeoutMs: 30_000 });
    try {
      const result = await backend.generate({
        shape: 'openai-chat', model: 'sonnet', stream: false,
        streamOptions: { includeUsage: false, includeObfuscation: false },
        jsonMode: true, jsonSchema: { type: 'object' },
        tools: [], toolChoice: { type: 'auto' }, raw: {},
        messages: [{ role: 'user', content: 'x', images: [] }],
      });
      assert.equal(result.text, answer, 'the lexeme was lost before the response path saw it');
    } finally {
      await backend.close();
    }
  });
}

test('rawTopLevelValue reads only the top level', () => {
  // Used to lift `structured_output` out of the CLI's NDJSON line verbatim.
  assert.equal(rawTopLevelValue('{"a":1,"structured_output":{"a":2},"b":3}', 'structured_output'), '{"a":2}');
  assert.equal(rawTopLevelValue('{"outer":{"structured_output":{"a":2}}}', 'structured_output'), undefined, 'it descended');
  assert.equal(rawTopLevelValue('[{"structured_output":{"a":2}}]', 'structured_output'), undefined, 'it read a non-object root');
  assert.equal(rawTopLevelValue('{"structured_output":{"a":2}', 'structured_output'), '{"a":2}');
  assert.equal(rawTopLevelValue('{"structured_output":{"a":', 'structured_output'), undefined, 'an unfinished value is not a value');
});
