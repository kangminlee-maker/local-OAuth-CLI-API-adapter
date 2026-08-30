import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startLocalApiProxy } from '../dist/proxy/http-server.js';

// Every row below is a DIRECT API observation, taken 2026-08-30 against
// `gpt-5.6-terra` and recorded in `docs/conformance-matrix.md` §5.5.5. The
// proxy answers the same body with the same envelope — status, type, param,
// code and message — and in the same order when a body carries two faults.
// Nothing here is inferred from documentation: a row with no capture behind it
// does not belong in this file.

function backend() {
  return {
    name: 'test',
    model: 'configured-model',
    async generate() {
      return { id: 'x', model: 'configured-model', text: 'pong', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, source: 'estimated' }, latencyMs: 1 };
    },
    async *stream() {
      yield { type: 'completed', result: { id: 'x', model: 'configured-model', text: 'pong', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, source: 'estimated' }, latencyMs: 1 } };
    },
    async close() {},
  };
}

async function chat(extra, path = '/v1/chat/completions') {
  const started = await startLocalApiProxy({ backend: backend(), host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000 });
  try {
    const body = { model: 'a-model', messages: [{ role: 'user', content: 'ping' }], ...extra };
    for (const key of Object.keys(body)) if (body[key] === '__delete__') delete body[key];
    const res = await fetch(`${started.url}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, payload: await res.json() };
  } finally {
    await started.close();
  }
}

// [name, request fragment, {status, param, code, message}]
const REJECTIONS = [
  // Unknown top-level keys — the strict schema P-5 found and §5.5.5 enumerated.
  ['an invented key', { zzz_unknown: 1 }, { param: 'zzz_unknown', code: 'unknown_parameter', message: "Unknown parameter: 'zzz_unknown'." }],
  ['audio', { audio: { voice: 'alloy', format: 'wav' } }, { param: 'audio', code: 'unknown_parameter', message: "Unknown parameter: 'audio'." }],
  ['modalities', { modalities: ['text', 'audio'] }, { param: 'modalities', code: 'unknown_parameter', message: "Unknown parameter: 'modalities'." }],
  ['web_search_options', { web_search_options: {} }, { param: 'web_search_options', code: 'unknown_parameter', message: "Unknown parameter: 'web_search_options'." }],
  ['the Responses-shaped reasoning', { reasoning: { effort: 'low' } }, { param: 'reasoning', code: 'unknown_parameter', message: "Unknown parameter: 'reasoning'." }],
  ['the Responses-shaped text', { text: { verbosity: 'low' } }, { param: 'text', code: 'unknown_parameter', message: "Unknown parameter: 'text'." }],

  // Refused by this model family whatever the value.
  ['stop', { stop: ['ZZ'] }, { param: 'stop', code: 'unsupported_parameter', message: "Unsupported parameter: 'stop' is not supported with this model." }],
  ['max_tokens', { max_tokens: 32 }, { param: 'max_tokens', code: 'unsupported_parameter', message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." }],
  ['logit_bias', { logit_bias: { 1: 1 } }, { param: 'logit_bias', code: 'unsupported_parameter', message: "Unsupported parameter: 'logit_bias' is not supported with this model." }],
  ['prediction', { prediction: { type: 'content', content: 'pong' } }, { param: 'prediction', code: 'unsupported_parameter', message: "Unsupported parameter: 'prediction' is not supported with this model." }],

  // Refused only while the model reasons; accepted at `reasoning_effort: none`.
  ['frequency_penalty while reasoning', { frequency_penalty: 0.5 }, { param: 'frequency_penalty', code: 'unsupported_parameter', message: "Unsupported parameter: 'frequency_penalty' is not supported with this model." }],
  ['presence_penalty while reasoning', { presence_penalty: 0.5 }, { param: 'presence_penalty', code: 'unsupported_parameter', message: "Unsupported parameter: 'presence_penalty' is not supported with this model." }],
  ['logprobs while reasoning', { logprobs: true }, { param: 'logprobs', code: 'unsupported_parameter', message: "Unsupported parameter: 'logprobs' is not supported with this model." }],

  // Types.
  ['a string n', { n: '2' }, { param: 'n', code: 'invalid_type', message: "Invalid type for 'n': expected an integer, but got a string instead." }],
  ['a string temperature', { temperature: 'hot' }, { param: 'temperature', code: 'invalid_type', message: "Invalid type for 'temperature': expected a decimal, but got a string instead." }],
  ['a string top_p', { top_p: 'wide' }, { param: 'top_p', code: 'invalid_type', message: "Invalid type for 'top_p': expected a decimal, but got a string instead." }],
  ['a string store', { store: 'yes' }, { param: 'store', code: 'invalid_type', message: "Invalid type for 'store': expected a boolean, but got a string instead." }],
  ['a decimal seed', { seed: 1.5 }, { param: 'seed', code: 'invalid_type', message: "Invalid type for 'seed': expected an integer, but got a decimal number instead." }],
  ['an object user', { user: { a: 1 } }, { param: 'user', code: 'invalid_type', message: "Invalid type for 'user': expected a string, but got an object instead." }],
  ['a string tools', { tools: 'none' }, { param: 'tools', code: 'invalid_type', message: "Invalid type for 'tools': expected an array of objects, but got a string instead." }],
  ['an integer tool_choice', { tool_choice: 7 }, { param: 'tool_choice', code: 'invalid_type', message: "Invalid type for 'tool_choice': expected one of one of 'none', 'auto', or 'required' or object, but got an integer instead." }],
  ['a string response_format', { response_format: 'json' }, { param: 'response_format', code: 'invalid_type', message: "Invalid type for 'response_format': expected an object, but got a string instead." }],
  ['a string messages', { messages: 'ping' }, { param: 'messages', code: 'invalid_type', message: "Invalid type for 'messages': expected an array of objects, but got a string instead." }],
  ['a non-object message item', { messages: ['ping'] }, { param: 'messages[0]', code: 'invalid_type', message: "Invalid type for 'messages[0]': expected an object, but got a string instead." }],
  ['a numeric message content', { messages: [{ role: 'user', content: 7 }] }, { param: 'messages[0].content', code: 'invalid_type', message: "Invalid type for 'messages[0].content': expected one of a string or array of objects, but got an integer instead." }],
  ['an object prompt_cache_retention', { prompt_cache_retention: { a: 1 } }, { param: 'prompt_cache_retention', code: 'invalid_type', message: "Invalid type for 'prompt_cache_retention': expected one of 'in_memory' or '24h', but got an object instead." }],
  ['an object service_tier', { service_tier: { a: 1 } }, { param: 'service_tier', code: 'invalid_type', message: "Invalid type for 'service_tier': expected one of 'auto', 'default', 'fast', 'flex', or 'priority', but got an object instead." }],

  // Bounds.
  ['n below the floor', { n: 0 }, { param: 'n', code: 'integer_below_min_value', message: "Invalid 'n': integer below minimum value. Expected a value >= 1, but got 0 instead." }],
  ['n above the ceiling', { n: 64 }, { param: 'n', code: 'integer_above_max_value', message: "Invalid 'n': integer above maximum value. Expected a value <= 8, but got 64 instead." }],
  ['max_completion_tokens below the floor', { max_completion_tokens: 0 }, { param: 'max_completion_tokens', code: 'integer_below_min_value', message: "Invalid 'max_completion_tokens': integer below minimum value. Expected a value >= 1, but got 0 instead." }],
  ['top_logprobs below the floor', { logprobs: true, reasoning_effort: 'none', top_logprobs: -1 }, { param: 'top_logprobs', code: 'integer_below_min_value', message: "Invalid 'top_logprobs': integer below minimum value. Expected a value >= 0, but got -1 instead." }],
  ['top_logprobs above the ceiling', { logprobs: true, reasoning_effort: 'none', top_logprobs: 21 }, { param: 'top_logprobs', code: null, message: "Invalid value for 'top_logprobs': must be less than or equal to 5." }],
  ['top_logprobs without logprobs', { reasoning_effort: 'none', top_logprobs: 1 }, { param: 'top_logprobs', code: null, message: "The 'top_logprobs' parameter is only allowed when 'logprobs' is enabled." }],
  ['metadata with too many properties', { metadata: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, 'v'])) }, { param: 'metadata', code: 'object_above_max_properties', message: "Invalid 'metadata': too many properties. Expected an object with at most 16 properties, but got an object with 17 properties instead." }],
  ['a metadata value over 512 characters', { metadata: { k: 'x'.repeat(600) } }, { param: 'metadata.k', code: 'string_above_max_length', message: "Invalid 'metadata.k': string too long. Expected a string with maximum length 512, but got a string with length 600 instead." }],
  ['a metadata key over 64 characters', { metadata: { ['k'.repeat(70)]: 'v' } }, { param: `metadata.${'k'.repeat(70)}`, code: 'property_name_above_max_length', message: "Invalid property name in 'metadata': 'kkk...kkk' is too long. Expected a string with maximum length 64, but got a string with length 70 instead." }],
  ['a non-string metadata value', { metadata: { k: 7 } }, { param: 'metadata.k', code: 'invalid_type', message: "Invalid type for 'metadata.k': expected a string, but got an integer instead." }],

  // Enums.
  ['an unknown service_tier', { service_tier: 'bogus' }, { param: 'service_tier', code: 'invalid_value', message: "Invalid value: 'bogus'. Supported values are: 'auto', 'default', 'fast', 'flex', and 'priority'." }],
  ['an unknown verbosity', { verbosity: 'bogus' }, { param: 'verbosity', code: 'invalid_value', message: "Invalid value: 'bogus'. Supported values are: 'low', 'medium', and 'high'." }],
  ['an unknown response_format type', { response_format: { type: 'bogus' } }, { param: 'response_format.type', code: 'invalid_value', message: "Invalid value: 'bogus'. Supported values are: 'json_object', 'json_schema', and 'text'." }],
  ['an unknown message role', { messages: [{ role: 'bogus', content: 'ping' }] }, { param: 'messages[0].role', code: 'invalid_value', message: "Invalid value: 'bogus'. Supported values are: 'system', 'assistant', 'user', 'function', 'tool', and 'developer'." }],
  ['an unknown tool_choice', { tools: [{ type: 'function', function: { name: 'f', parameters: {} } }], tool_choice: 'bogus' }, { param: 'tool_choice', code: 'invalid_value', message: "Invalid value: 'bogus'. Supported values are: 'none', 'auto', and 'required'." }],
  ['reasoning_effort max', { reasoning_effort: 'max' }, { param: 'reasoning_effort', code: 'unsupported_value', message: "Unsupported value: 'reasoning_effort' does not support 'max' with this model. Supported values are: 'none', 'low', 'medium', 'high', and 'xhigh'." }],
  ['reasoning_effort as an object', { reasoning_effort: { __probe__: 'wrong type' } }, { param: 'reasoning_effort', code: 'unsupported_value', message: "Unsupported value: 'reasoning_effort' does not support {'__probe__': 'wrong type'} with this model. Supported values are: 'none', 'low', 'medium', 'high', and 'xhigh'." }],

  // Missing members.
  ['response_format with no type', { response_format: {} }, { param: 'response_format.type', code: 'missing_required_parameter', message: "Missing required parameter: 'response_format.type'." }],
  ['a function with no name', { functions: [{ parameters: {} }] }, { param: 'functions[0].name', code: 'missing_required_parameter', message: "Missing required parameter: 'functions[0].name'." }],
  ['a tool with no function', { tools: [{ type: 'function' }] }, { param: 'tools[0].function', code: 'missing_required_parameter', message: "Missing required parameter: 'tools[0].function'." }],
  ['a tool function with no name', { tools: [{ type: 'function', function: { parameters: {} } }] }, { param: 'tools[0].function.name', code: 'missing_required_parameter', message: "Missing required parameter: 'tools[0].function.name'." }],
  ['a tool_choice object with no function', { tools: [{ type: 'function', function: { name: 'f', parameters: {} } }], tool_choice: { type: 'bogus' } }, { param: 'tool_choice.function', code: 'missing_required_parameter', message: "Missing required parameter: 'tool_choice.function'." }],
  ['a tool_choice function with no name', { tools: [{ type: 'function', function: { name: 'f', parameters: {} } }], tool_choice: { type: 'function', function: {} } }, { param: 'tool_choice.function.name', code: 'missing_required_parameter', message: "Missing required parameter: 'tool_choice.function.name'." }],
  ['a function_call object with no name', { functions: [{ name: 'f', parameters: {} }], function_call: { __probe__: 'wrong type' } }, { param: 'function_call.name', code: 'missing_required_parameter', message: "Missing required parameter: 'function_call.name'." }],
  ['no messages at all', { messages: '__delete__' }, { param: 'messages', code: 'missing_required_parameter', message: "Missing required parameter: 'messages'." }],
  ['an empty messages array', { messages: [] }, { param: 'messages', code: 'empty_array', message: "Invalid 'messages': empty array. Expected an array with minimum length 1, but got an empty array instead." }],
  ['a message with no role', { messages: [{ content: 'ping' }] }, { param: 'messages[0].role', code: 'missing_required_parameter', message: "Missing required parameter: 'messages[0].role'." }],
  ['a moderation object with no model', { moderation: {} }, { param: 'moderation.model', code: 'missing_required_parameter', message: "Missing required parameter: 'moderation.model'." }],

  // Values this family refuses although the key is known and well-typed.
  ['prompt_cache_retention in_memory', { prompt_cache_retention: 'in_memory' }, { param: 'prompt_cache_retention', code: null, message: 'This model is compatible only with 24h extended prompt caching' }],
  ['an unknown prompt_cache_options member', { prompt_cache_options: { bogus: 1 } }, { param: 'prompt_cache_options.bogus', code: 'unknown_parameter', message: "Unknown parameter: 'prompt_cache_options.bogus'." }],
];

for (const [name, fragment, expected] of REJECTIONS) {
  test(`chat rejects ${name} with the direct API's envelope`, async () => {
    const { status, payload } = await chat(fragment);
    assert.equal(status, 400, JSON.stringify(payload));
    assert.equal(payload.error.type, 'invalid_request_error');
    assert.equal(payload.error.param, expected.param);
    assert.equal(payload.error.code, expected.code);
    assert.equal(payload.error.message, expected.message);
  });
}

// The order two faults are reported in, each pair measured 2026-08-30. The
// order is the fact here: every one of these bodies is invalid twice, and a
// client fixing them one at a time walks the same path against either API.
const ORDER = [
  ['a missing model beats an unknown key', { model: '__delete__', zzz_unknown: 1 }, { param: null, message: 'you must provide a model parameter' }],
  ['a missing messages beats an unknown key', { messages: '__delete__', zzz_unknown: 1 }, { param: 'messages', message: "Missing required parameter: 'messages'." }],
  ['an unknown key beats a bad type', { zzz_unknown: 1, n: 'abc' }, { param: 'zzz_unknown', message: "Unknown parameter: 'zzz_unknown'." }],
  ['an unknown key beats an empty messages array', { zzz_unknown: 1, messages: [] }, { param: 'zzz_unknown', message: "Unknown parameter: 'zzz_unknown'." }],
  ['an unknown key beats a refused parameter', { zzz_unknown: 1, stop: ['ZZ'] }, { param: 'zzz_unknown', message: "Unknown parameter: 'zzz_unknown'." }],
  ['an unknown key beats a bad enum', { zzz_unknown: 1, service_tier: 'bogus' }, { param: 'zzz_unknown', message: "Unknown parameter: 'zzz_unknown'." }],
  ['n is reported before stop', { n: 'abc', stop: ['ZZ'] }, { param: 'n', message: "Invalid type for 'n': expected an integer, but got a string instead." }],
  ['n is reported before temperature', { n: 'abc', temperature: 0.5 }, { param: 'n', message: "Invalid type for 'n': expected an integer, but got a string instead." }],
  ['n is reported before stop even as a bound fault', { n: 0, stop: ['ZZ'] }, { param: 'n', message: "Invalid 'n': integer below minimum value. Expected a value >= 1, but got 0 instead." }],
  ['stop is reported before temperature', { stop: ['ZZ'], temperature: 0.5 }, { param: 'stop', message: "Unsupported parameter: 'stop' is not supported with this model." }],
];

for (const [name, fragment, expected] of ORDER) {
  test(`chat reports faults in the direct API's order: ${name}`, async () => {
    const { status, payload } = await chat(fragment);
    assert.equal(status, 400, JSON.stringify(payload));
    assert.equal(payload.error.param, expected.param);
    assert.equal(payload.error.message, expected.message);
  });
}

// The keys the direct API takes and this proxy cannot act on. Accepting them is
// the contract; what must never happen is an echo claiming they were applied.
test('chat accepts the keys the direct API accepts and does not apply', async () => {
  const { status } = await chat({
    metadata: { a: 'b' }, store: false, user: 'probe', safety_identifier: 'probe',
    seed: 1, prompt_cache_key: 'probe-key', prompt_cache_options: { ttl: '30m' },
    prompt_cache_retention: '24h', parallel_tool_calls: false,
    moderation: { model: 'omni-moderation-latest' }, verbosity: 'low',
  });
  assert.equal(status, 200);
});

test('chat accepts the penalties and logprobs once the model stops reasoning', async () => {
  const { status } = await chat({ reasoning_effort: 'none', frequency_penalty: 0.5, presence_penalty: 0.5, logprobs: true, top_logprobs: 5 });
  assert.equal(status, 200);
});

test('chat accepts a message with no content, and one with null content', async () => {
  const { status } = await chat({ messages: [{ role: 'user' }, { role: 'assistant', content: null }, { role: 'user', content: 'ping' }] });
  assert.equal(status, 200);
});

// `service_tier` is echoed, so it is the one accepted-and-not-applied key with
// a visible answer: the direct API returns the tier the caller asked for
// (`flex` in, `flex` out, measured), and `auto`/absent resolve to `default`.
for (const [sent, echoed] of [[undefined, 'default'], ['auto', 'default'], ['default', 'default'], ['flex', 'flex'], ['priority', 'priority'], ['fast', 'fast']]) {
  test(`chat echoes service_tier ${sent ?? '(absent)'} as ${echoed}`, async () => {
    const { status, payload } = await chat(sent === undefined ? {} : { service_tier: sent });
    assert.equal(status, 200);
    assert.equal(payload.service_tier, echoed);
  });
}

test('the chat stream reports the same service_tier as the body', async () => {
  const started = await startLocalApiProxy({ backend: backend(), host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000 });
  try {
    const res = await fetch(`${started.url}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'a-model', messages: [{ role: 'user', content: 'ping' }], service_tier: 'flex', stream: true }),
    });
    const wire = await res.text();
    const chunks = [...wire.matchAll(/^data: (\{.+)$/gm)].map(([, data]) => JSON.parse(data));
    assert.ok(chunks.length > 0, wire);
    for (const chunk of chunks) assert.equal(chunk.service_tier, 'flex');
  } finally {
    await started.close();
  }
});

// The Responses surface echoes it too, and shares the resolver.
test('responses echoes the requested service_tier', async () => {
  const { status, payload } = await chat({ input: 'ping', messages: '__delete__', service_tier: 'flex' }, '/v1/responses');
  assert.equal(status, 200);
  assert.equal(payload.service_tier, 'flex');
});
