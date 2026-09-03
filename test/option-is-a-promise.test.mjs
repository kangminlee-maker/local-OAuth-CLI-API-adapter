import test from 'node:test';
import assert from 'node:assert/strict';
import { outputSchemaFor, parseBackendOutput, buildPrompt } from '../dist/proxy/backend-contract.js';

/**
 * This proxy implements an accepted option through the environment, a runtime
 * knob, or the response path — never by asking the model in the prompt. An
 * option is a promise; a prompt is a request. The failures these tests pin all
 * had one shape: the option was accepted, a sentence asked for it, and a
 * backend that ignored the sentence produced a 200 that broke the promise.
 *
 * The reference behaviour is the direct API, measured 2026-09-02:
 *   - `tool_choice: "required"` called a tool against a prompt begging it not
 *     to, and called one again on a continuation that already had the answer.
 *   - `json_object` returned `{"response":"not json"}` for "reply with the
 *     plain sentence: not json", and `{"0":1,"1":2,"2":3}` when asked for the
 *     array `[1,2,3]` — the format forces a top-level OBJECT.
 */

const base = {
  model: 'm',
  shape: 'openai-responses',
  messages: [{ role: 'user', content: 'x', images: [] }],
  jsonMode: false,
  tools: [],
  toolChoice: { type: 'auto' },
  stream: false,
  raw: {},
};
const twoTools = [
  { name: 'f1', description: 'first', inputSchema: { type: 'object' } },
  { name: 'f2', description: 'second', inputSchema: { type: 'object' } },
];
const required = { ...base, tools: twoTools, toolChoice: { type: 'required' } };

test('tool_choice required cannot be answered without a call: the schema forbids it', () => {
  const schema = outputSchemaFor(required);
  assert.deepEqual(
    schema.properties.status.enum,
    ['tool_calls'],
    'a required turn must not be allowed to report status "message"',
  );
  assert.equal(schema.properties.toolCalls.minItems, 1, 'a required turn must call at least once');
});

test('a forced call may only name a tool the client actually declared', () => {
  const schema = outputSchemaFor(required);
  assert.deepEqual(schema.properties.toolCalls.items.properties.name.enum, ['f1', 'f2']);
});

test('CONTROL: tool_choice auto still permits an answer with no call', () => {
  const schema = outputSchemaFor({ ...base, tools: twoTools, toolChoice: { type: 'auto' } });
  assert.deepEqual(schema.properties.status.enum, ['message', 'tool_calls']);
  assert.equal(schema.properties.toolCalls.minItems, undefined);
});

test('Anthropic `any` is the same promise as OpenAI `required`', () => {
  // `any` normalizes to `required`, so one rule covers all three surfaces.
  const schema = outputSchemaFor({ ...required, shape: 'anthropic-messages' });
  assert.deepEqual(schema.properties.status.enum, ['tool_calls']);
});

for (const [label, raw] of [
  ['prose', 'NO_TOOL'],
  ['an explicit status:message', JSON.stringify({ status: 'message', text: 'no', toolCalls: [] })],
  ['an empty toolCalls array', JSON.stringify({ status: 'tool_calls', text: '', toolCalls: [] })],
]) {
  test(`a required turn answered with ${label} is rejected, never repaired`, () => {
    assert.throws(() => parseBackendOutput(required, raw), (err) => {
      assert.equal(err.statusCode, 502, 'a backend ignoring its schema is an upstream fault');
      assert.match(err.message, /without calling a tool/);
      return true;
    });
  });
}

test('CONTROL: a required turn that does call is passed through untouched', () => {
  const raw = JSON.stringify({ status: 'tool_calls', text: '', toolCalls: [{ id: 'c1', name: 'f1', arguments: '{}' }] });
  assert.deepEqual(parseBackendOutput(required, raw).toolCalls, [{ id: 'c1', name: 'f1', arguments: '{}' }]);
});

test('CONTROL: an auto turn answered with prose is an answer, not a violation', () => {
  const auto = { ...base, tools: twoTools, toolChoice: { type: 'auto' } };
  assert.equal(parseBackendOutput(auto, 'just an answer').text, 'just an answer');
});

test('json_object carries a runtime object schema, not a sentence', () => {
  assert.deepEqual(outputSchemaFor({ ...base, jsonMode: true }), { type: 'object' });
});

test('CONTROL: an explicit json_schema still wins over the generic object', () => {
  const jsonSchema = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] };
  assert.deepEqual(outputSchemaFor({ ...base, jsonMode: true, jsonSchema }), jsonSchema);
});

// Everything that is not a JSON object, including the shapes that ARE valid
// JSON. `json_object` means object: asked for `[1,2,3]` the direct API
// answered `{"0":1,"1":2,"2":3}`.
for (const [label, raw] of [
  ['prose', 'not json'],
  ['a JSON array', '[1,2,3]'],
  ['a bare number', '42'],
  ['a bare string', '"hello"'],
  ['null', 'null'],
]) {
  test(`json mode answered with ${label} is rejected`, () => {
    assert.throws(() => parseBackendOutput({ ...base, jsonMode: true }, raw), (err) => {
      assert.equal(err.statusCode, 502);
      assert.match(err.message, /not a JSON object/);
      return true;
    });
  });
}

// Deliberate, and checked here so it is not later "fixed" by stripping the
// fence. A fenced block is not JSON: before the runtime schema existed the
// client got it at HTTP 200 and its own `JSON.parse` failed on it, so no
// answer is lost by refusing — an unparseable 200 became a diagnosable 502.
// Stripping the fence would be repairing contract-failing output, which is the
// one thing the response path must not do. The `{type:'object'}` schema is
// what prevents the fence in the first place.
test('json mode answered inside a markdown fence is refused, not unwrapped', () => {
  assert.throws(
    () => parseBackendOutput({ ...base, jsonMode: true }, '```json\n{"a":1}\n```'),
    (err) => err.statusCode === 502,
  );
});

test('CONTROL: surrounding whitespace is not a fence and still parses', () => {
  assert.equal(parseBackendOutput({ ...base, jsonMode: true }, '  {"a":1}\n').text.trim(), '{"a":1}');
});

test('CONTROL: json mode answered with an object passes through', () => {
  assert.equal(parseBackendOutput({ ...base, jsonMode: true }, '{"a":1}').text, '{"a":1}');
});

test('CONTROL: without json mode, prose is just prose', () => {
  assert.equal(parseBackendOutput(base, 'not json').text, 'not json');
});

test('a rejection is reported in the shape of the surface that was called', () => {
  const anthropic = () => parseBackendOutput({ ...base, shape: 'anthropic-messages', jsonMode: true }, 'not json');
  assert.throws(anthropic, (err) => err.provider === 'anthropic' && err.type === 'api_error');
  const openai = () => parseBackendOutput({ ...base, jsonMode: true }, 'not json');
  assert.throws(openai, (err) => err.provider === 'openai' && err.type === 'api_error');
});

test('no option is implemented by talking to the model about it', () => {
  const prompt = buildPrompt({ ...required, maxTokens: 16, jsonMode: true });
  assert.doesNotMatch(prompt, /Output token limit/, 'the token cap is not a prompt instruction');
  assert.doesNotMatch(
    prompt,
    /unless prior tool results answer/,
    'the required-call rule lives in the schema, and this sentence contradicted the API',
  );
});

/**
 * A client that sends `tools` AND asks for JSON gets both, and its answer has
 * a namespace of its own.
 *
 * The tool wrapper used to occupy the single structured-output channel, so a
 * client schema was dropped in silence on the OpenAI surfaces (prose at 200,
 * with the format echoed back as applied) and refused outright on
 * `/v1/messages`. Both diverge from the provider, which serves the pair and
 * honours the schema — measured 2026-09-03: Responses answered
 * `{"verdict":"True","score":0.98}` and Anthropic `{"verdict": "True",
 * "score": 0.95}`, both with tools present.
 *
 * Sharing one namespace also made an ordinary client key ambiguous: a request
 * for literally `{"toolCalls":[]}` came back 502, read as a malformed wrapper.
 */
const CLIENT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { verdict: { type: 'string' }, score: { type: 'number' } },
  required: ['verdict', 'score'],
};
const withTools = { ...base, tools: twoTools, toolChoice: { type: 'auto' }, jsonMode: true };

// With tools present the one structured-output channel is carrying the tool
// wrapper, so the JSON format does not reach the runtime. That is declared in
// the conformance matrix rather than enforced by a check: enforcement and the
// knob travel together, and inventing a refusal for a promise the model was
// never asked to keep refuses turns the backend could serve.
test('with tools present, the JSON format is not carried to the runtime', () => {
  const schema = outputSchemaFor({ ...withTools, jsonSchema: CLIENT_SCHEMA });
  assert.deepEqual(schema.properties.status.enum, ['message', 'tool_calls'], 'the tool wrapper owns the channel');
  assert.equal(schema.properties.json, undefined, 'the wrapper does not carry client data');
});

test('CONTROL: without tools the client schema reaches the runtime unchanged', () => {
  assert.deepEqual(outputSchemaFor({ ...base, jsonMode: true, jsonSchema: CLIENT_SCHEMA }), CLIENT_SCHEMA);
});

test('CONTROL: a tools turn still answers and still calls', () => {
  const answer = JSON.stringify({ status: 'message', text: 'plain answer', toolCalls: [] });
  assert.equal(parseBackendOutput(withTools, answer).text, 'plain answer');
  const call = JSON.stringify({ status: 'tool_calls', text: '', toolCalls: [{ id: 'c1', name: 'f1', arguments: '{}' }] });
  assert.deepEqual(parseBackendOutput(withTools, call).toolCalls, [{ id: 'c1', name: 'f1', arguments: '{}' }]);
});

// `toolCalls` is a property name the CLIENT controls. In JSON mode an object
// carrying it is an answer, not this proxy's private wrapper.
for (const [label, raw] of [
  ['an object whose only key is `toolCalls`', '{"toolCalls":[]}'],
  ['an object mixing `toolCalls` with other keys', '{"toolCalls":[1,2],"note":"mine"}'],
  ['an ordinary object', '{"a":1}'],
]) {
  test(`json mode: ${label} is the client's answer`, () => {
    assert.equal(parseBackendOutput(withTools, raw).text, raw);
  });
}

test('CONTROL: outside JSON mode a wrapper-shaped object with no usable status is still refused', () => {
  const noJson = { ...base, tools: twoTools, toolChoice: { type: 'auto' } };
  assert.throws(
    () => parseBackendOutput(noJson, '{"text":"answer","toolCalls":[{"id":"c1","name":"f1","arguments":"{}"}]}'),
    (err) => err.statusCode === 502,
  );
});
