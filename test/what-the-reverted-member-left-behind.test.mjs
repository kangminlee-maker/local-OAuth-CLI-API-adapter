import assert from 'node:assert/strict';
import { chmod } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, before, test } from 'node:test';
import { startLocalApiProxy } from '../dist/proxy/http-server.js';
import { ClaudeCodeBackend } from '../dist/proxy/claude-code-backend.js';
import { textMayBeRefused, declaredToolNames, parseBackendOutput } from '../dist/proxy/backend-contract.js';

/**
 * What a turn's answer channel is, and what may be released before it arrives.
 *
 * Round 14 removed a gate on the ground that it protected a wrapper member the
 * revert before it had deleted. The gate was doing a second job nobody had
 * written down: when the CLI is handed an output schema it answers through
 * `structured_output`, and the streamed prose is then not the answer at all.
 * Removing the gate made a `json_schema` turn stream `Here you go: {...}` while
 * its own body published `{...}` — the two readings of one turn disagreeing,
 * which is the defect this repo produces most.
 *
 * The tests that shipped with that change could not fail: they drove
 * `streaming-claude.cjs`, whose result carries the text and no
 * `structured_output` — the one artefact shape where the bug cannot appear.
 * `schema-stream-claude.cjs` exists so the shape under test is the shape a
 * schema turn actually produces.
 */

const here = dirname(fileURLToPath(import.meta.url));
const streamingClaude = resolve(here, 'fixtures/streaming-claude.cjs');
const structuredClaude = resolve(here, 'fixtures/structured-claude.cjs');
const schemaStreamClaude = resolve(here, 'fixtures/schema-stream-claude.cjs');

before(async () => {
  for (const f of [streamingClaude, structuredClaude, schemaStreamClaude]) await chmod(f, 0o755);
});
afterEach(() => {
  delete process.env.WRAPPER_RAW;
  delete process.env.STRUCTURED_RAW;
  delete process.env.SCHEMA_PROSE;
  delete process.env.SCHEMA_STRUCTURED;
});

const TOOLS = [
  { type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } },
  { type: 'function', function: { name: 'get_time', parameters: { type: 'object', properties: { tz: { type: 'string' } } } } },
];

const JSON_SCHEMA = {
  type: 'json_schema',
  json_schema: { name: 'answer', strict: true, schema: { type: 'object', properties: { ok: { type: 'number' } } } },
};

async function chat(command, body, env = {}) {
  Object.assign(process.env, env);
  const backend = new ClaudeCodeBackend({ command, cwd: process.cwd(), model: 'sonnet', timeoutMs: 30_000 });
  const server = await startLocalApiProxy({ backend, host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000 });
  try {
    const res = await fetch(`${server.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer local' },
      body: JSON.stringify(body),
    });
    if (!body.stream) {
      const json = await res.json();
      return {
        status: res.status,
        content: json.choices?.[0]?.message?.content ?? '',
        calls: (json.choices?.[0]?.message?.tool_calls ?? []).map((c) => c.function.name),
        error: json.error?.message,
      };
    }
    const wire = await res.text();
    if (res.status !== 200) {
      // A held tool turn is refused before the response commits, so the
      // refusal is the response's own status and body — no frame carries it.
      let json; try { json = JSON.parse(wire); } catch { json = {}; }
      return { status: res.status, content: '', frames: 0, calls: [], error: json.error?.message ?? wire };
    }
    const frames = wire.split('\n')
      .filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim())
      .filter((c) => c && c !== '[DONE]')
      .flatMap((c) => { try { return [JSON.parse(c)]; } catch { return []; } });
    const chunks = frames.flatMap((f) => (f.choices ?? []).map((c) => c.delta?.content).filter(Boolean));
    return {
      status: res.status,
      content: chunks.join(''),
      frames: chunks.length,
      calls: frames.flatMap((f) => (f.choices ?? []).flatMap((c) => (c.delta?.tool_calls ?? []).map((t) => t.function?.name).filter(Boolean))),
      error: frames.find((f) => f.error)?.error?.message,
    };
  } finally {
    await server.close();
    await backend.close();
  }
}

/**
 * The regression this file exists for: with an output schema the CLI answers
 * through `structured_output`, so its prose must not be published as the answer.
 */
for (const [label, prose, structured] of [
  ['prose wrapping the object', 'Here you go:\n{"ok": 1}', '{"ok":1}'],
  ['a fenced block', '```json\n{"ok":1}\n```', '{"ok":1}'],
  ['CONTROL prose that is already the answer', '{"ok":1}', '{"ok":1}'],
]) {
  test(`a json_schema turn answers from structured_output on both paths: ${label}`, async () => {
    const body = { model: 'm', messages: [{ role: 'user', content: 'x' }], response_format: JSON_SCHEMA };
    const env = { SCHEMA_PROSE: prose, SCHEMA_STRUCTURED: structured };
    const buffered = await chat(schemaStreamClaude, body, env);
    const streamed = await chat(schemaStreamClaude, { ...body, stream: true }, env);
    assert.equal(buffered.content, structured, 'the body did not publish the structured answer');
    assert.equal(streamed.content, buffered.content, 'the stream published the prose, not the answer');
  });
}

test('a schema turn does not stream its prose as it is produced', async () => {
  // Held, not lost: the answer still arrives, in one frame at the end.
  const streamed = await chat(schemaStreamClaude,
    { model: 'm', messages: [{ role: 'user', content: 'x' }], response_format: JSON_SCHEMA, stream: true },
    { SCHEMA_PROSE: 'Here you go:\n{"ok": 1}', SCHEMA_STRUCTURED: '{"ok":1}' });
  assert.equal(streamed.content, '{"ok":1}');
  assert.equal(streamed.frames, 1, 'the prose reached the client as it was produced');
});

test('CONTROL a turn with no output schema still streams as it is produced', async () => {
  const streamed = await chat(streamingClaude,
    { model: 'm', messages: [{ role: 'user', content: 'x' }], stream: true },
    { WRAPPER_RAW: 'Here is a sentence in many pieces.' });
  assert.equal(streamed.content, 'Here is a sentence in many pieces.');
  assert.ok(streamed.frames > 1, `a plain turn was withheld (${streamed.frames} frame)`);
});

/**
 * A tools turn's answer is held for a different reason: this reader stops at a
 * wrapper's FIRST member while `JSON.parse` keeps the LAST, so a released
 * prefix can be contradicted by the completed body — and a released byte
 * cannot be retracted.
 */
test('duplicate wrapper keys cannot make the two readings disagree in JSON mode', async () => {
  const raw = '{"status":"message","text":"FIRST","toolCalls":[],"text":"SECOND"}';
  const body = { model: 'm', messages: [{ role: 'user', content: 'x' }], tools: TOOLS, response_format: { type: 'json_object' } };
  const buffered = await chat(streamingClaude, body, { WRAPPER_RAW: raw });
  const streamed = await chat(streamingClaude, { ...body, stream: true }, { WRAPPER_RAW: raw });
  assert.equal(streamed.content, buffered.content, 'the stream committed a value the body then contradicted');
});

/** A call naming a tool the request never declared is refused on both paths. */
for (const [label, name, expectRefusal] of [
  ['an undeclared name', 'never_declared', true],
  ['CONTROL a declared name', 'get_weather', false],
]) {
  test(`${label} is treated the same by both readers`, async () => {
    const raw = JSON.stringify({ status: 'tool_calls', text: '', toolCalls: [{ id: 'c1', name, arguments: '{}' }] });
    const body = { model: 'm', messages: [{ role: 'user', content: 'x' }], tools: TOOLS, tool_choice: 'required' };
    const buffered = await chat(streamingClaude, body, { WRAPPER_RAW: raw });
    const streamed = await chat(streamingClaude, { ...body, stream: true }, { WRAPPER_RAW: raw });
    if (expectRefusal) {
      assert.equal(buffered.status, 502, 'the body published an undeclared call');
      assert.deepEqual(streamed.calls, [], 'the stream published an undeclared call');
      assert.match(streamed.error ?? '', /never declared/);
    } else {
      assert.deepEqual(buffered.calls, ['get_weather']);
      assert.deepEqual([...new Set(streamed.calls)], ['get_weather']);
    }
  });
}

test('declaredToolNames is the set the runtime schema was given', () => {
  const base = { model: 'm', shape: 'openai-chat', messages: [], jsonMode: false, raw: {} };
  const tools = [{ name: 'a', inputSchema: {} }, { name: 'b', inputSchema: {} }];
  assert.deepEqual([...declaredToolNames({ ...base, tools, toolChoice: { type: 'auto' } })], ['a', 'b']);
  assert.equal(declaredToolNames({ ...base, tools: [], toolChoice: { type: 'auto' } }), null, 'no tools constrains nothing');
  assert.equal(declaredToolNames({ ...base, tools, toolChoice: { type: 'none' } }), null, 'a `none` turn has no wrapper');
});

/**
 * `skipWhitespace` decides whether an artefact is a wrapper at all, so it has
 * to answer the same question `JSON.parse` answers. JavaScript's `\s` also
 * matches BOM and NBSP, which `JSON.parse` rejects.
 */
for (const [label, prefix] of [
  ['a BOM', '﻿'],
  ['a non-breaking space', ' '],
  ['CONTROL an ordinary newline', '\n'],
]) {
  test(`${label} before the wrapper reads the same to both readers`, async () => {
    const raw = prefix + JSON.stringify({ status: 'tool_calls', text: '', toolCalls: [{ id: 'c1', name: 'get_weather', arguments: '{"city":"Seoul"}' }] });
    const body = { model: 'm', messages: [{ role: 'user', content: 'x' }], tools: TOOLS, tool_choice: 'required' };
    const buffered = await chat(streamingClaude, body, { WRAPPER_RAW: raw });
    const streamed = await chat(streamingClaude, { ...body, stream: true }, { WRAPPER_RAW: raw });
    const bufferedCalls = buffered.status === 502 ? [] : buffered.calls;
    assert.deepEqual([...new Set(streamed.calls)], bufferedCalls,
      'the stream published a call the body denied');
  });
}

test('textMayBeRefused is true for every format the backstop can refuse', () => {
  // `json_object` is refused by the object rule and `json_schema` by the
  // client-schema assertion (matrix §7 row 10), so a streaming gate that
  // released either turn's text early would release bytes the completion may
  // refuse. A turn with no JSON format has nothing to be refused for.
  const base = { model: 'm', shape: 'openai-chat', messages: [], tools: [], toolChoice: { type: 'auto' }, raw: {} };
  assert.equal(textMayBeRefused({ ...base, jsonMode: true, jsonSchema: undefined }), true, 'json_object');
  assert.equal(textMayBeRefused({ ...base, jsonMode: true, jsonSchema: { type: 'object' } }), true, 'json_schema');
  assert.equal(textMayBeRefused({ ...base, jsonMode: false, jsonSchema: undefined }), false, 'no JSON format');
});

/**
 * A present `null` is an answer, not an absent member. `??` cannot tell them
 * apart, so a client whose schema is `{"type":"null"}` was handed the empty
 * fallback text instead of the `null` its runtime returned.
 */
// Each answer is published under a client schema it conforms to: since
// matrix §7 row 10 the response path refuses text outside the client's
// `json_schema`, so a control that answered `{"a":1}` to `{"type":"null"}`
// would now measure that refusal, not the `??`.
for (const [label, raw, expected, jsonSchema] of [
  ['a present null', 'null', 'null', { type: 'null' }],
  ['CONTROL a present object', '{"a":1}', '{"a":1}', { type: 'object' }],
  ['CONTROL a present false', 'false', 'false', { type: 'boolean' }],
  ['CONTROL a present zero', '0', '0', { type: 'integer' }],
]) {
  test(`the Claude backend publishes ${label} as its own bytes`, async () => {
    process.env.STRUCTURED_RAW = raw;
    const backend = new ClaudeCodeBackend({ command: structuredClaude, cwd: process.cwd(), model: 'sonnet', timeoutMs: 30_000 });
    try {
      const result = await backend.generate({
        shape: 'openai-chat', model: 'sonnet', stream: false,
        streamOptions: { includeUsage: false, includeObfuscation: false },
        jsonMode: true, jsonSchema,
        tools: [], toolChoice: { type: 'auto' }, raw: {},
        messages: [{ role: 'user', content: 'x', images: [] }],
      });
      assert.equal(result.text, expected);
    } finally {
      await backend.close();
    }
  });
}

test('an undeclared call is refused at the response path too, not only in the stream', () => {
  const request = {
    model: 'm', shape: 'openai-chat', messages: [], jsonMode: false,
    tools: [{ name: 'get_weather', inputSchema: {} }],
    toolChoice: { type: 'auto' }, raw: {},
  };
  const undeclared = '{"status":"tool_calls","text":"","toolCalls":[{"id":"c1","name":"nope","arguments":"{}"}]}';
  assert.throws(() => parseBackendOutput(request, undeclared), (err) => err.statusCode === 502);
  const declared = '{"status":"tool_calls","text":"","toolCalls":[{"id":"c1","name":"get_weather","arguments":"{}"}]}';
  assert.deepEqual(parseBackendOutput(request, declared).toolCalls.map((c) => c.name), ['get_weather']);
});

/**
 * Round 16: the declared-name check tested the raw name in one reader and the
 * substituted `tool` in the other, so a call with no usable name was refused
 * by the body and published by the stream. One rule, `callNameIsDeclared`, on
 * the raw value, in both.
 */
for (const [label, call] of [
  ['a call with no name', { id: 'c1', arguments: '{"city":"Seoul"}' }],
  ['a call whose name is not a string', { id: 'c1', name: 7, arguments: '{"city":"Seoul"}' }],
  ['a call whose name is blank', { id: 'c1', name: '   ', arguments: '{"city":"Seoul"}' }],
]) {
  test(`${label} is refused by both readers, not repaired into \`tool\``, async () => {
    const raw = JSON.stringify({ status: 'tool_calls', text: '', toolCalls: [call] });
    const body = { model: 'm', messages: [{ role: 'user', content: 'x' }], tools: TOOLS, tool_choice: 'required' };
    const buffered = await chat(streamingClaude, body, { WRAPPER_RAW: raw });
    const streamed = await chat(streamingClaude, { ...body, stream: true }, { WRAPPER_RAW: raw });
    assert.equal(buffered.status, 502, 'the body published a call with no usable name');
    assert.deepEqual(streamed.calls, [], `the stream announced ${JSON.stringify(streamed.calls)}`);
    assert.match(streamed.error ?? '', /never declared/);
  });
}

/**
 * The raw-name rule is only distinguishable from "substitute `tool`, then
 * check" when the request does NOT declare a tool literally named `tool`. A
 * client that does declare one is the case that separates the two: a call
 * with no name must still be refused, not repaired into that client's tool.
 */
test('a nameless call is refused even when the client declared a tool named `tool`', async () => {
  const tools = [...TOOLS, { type: 'function', function: { name: 'tool', parameters: { type: 'object' } } }];
  const raw = JSON.stringify({ status: 'tool_calls', text: '', toolCalls: [{ id: 'c1', arguments: '{}' }] });
  const body = { model: 'm', messages: [{ role: 'user', content: 'x' }], tools, tool_choice: 'required' };
  const buffered = await chat(streamingClaude, body, { WRAPPER_RAW: raw });
  const streamed = await chat(streamingClaude, { ...body, stream: true }, { WRAPPER_RAW: raw });
  assert.equal(buffered.status, 502, 'the body repaired a nameless call into the client\'s `tool`');
  assert.deepEqual(streamed.calls, [], `the stream announced ${JSON.stringify(streamed.calls)}`);
});
