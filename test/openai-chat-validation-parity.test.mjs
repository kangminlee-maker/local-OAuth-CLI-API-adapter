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
  // `content` required-ness, measured 2026-08-31. `developer` is its own schema
  // and answers in its own words; a substitute that is present but NULL is not
  // a substitute; `tool_calls: []` is its own refusal in the messages phase.
  ['content absent on a developer item', { messages: [{ role: 'user', content: 'a' }, { role: 'developer' }] }, { param: 'messages[1].content', code: 'missing_required_parameter', message: "Missing required parameter: 'messages[1].content'." }],
  ['content null on a developer item', { messages: [{ role: 'user', content: 'a' }, { role: 'developer', content: null }] }, { param: 'messages[1].content', code: 'invalid_type', message: "Invalid type for 'messages[1].content': expected one of a string or array of objects, but got null instead." }],
  ['a null refusal is no substitute', { messages: [{ role: 'user', content: 'a' }, { role: 'assistant', refusal: null }] }, { param: 'messages.[1].content', code: null, message: "Invalid value for 'content': expected a string, got null." }],
  ['a null tool_calls is no substitute', { messages: [{ role: 'user', content: 'a' }, { role: 'assistant', tool_calls: null }] }, { param: 'messages.[1].content', code: null, message: "Invalid value for 'content': expected a string, got null." }],
  ['a null function_call is no substitute', { messages: [{ role: 'user', content: 'a' }, { role: 'assistant', function_call: null }] }, { param: 'messages.[1].content', code: null, message: "Invalid value for 'content': expected a string, got null." }],
  ['an empty tool_calls', { messages: [{ role: 'user', content: 'a' }, { role: 'assistant', tool_calls: [] }] }, { param: 'messages[1].tool_calls', code: 'empty_array', message: "Invalid 'messages[1].tool_calls': empty array. Expected an array with minimum length 1, but got an empty array instead." }],
  ['an empty tool_calls beside content', { messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'x', tool_calls: [] }] }, { param: 'messages[1].tool_calls', code: 'empty_array', message: "Invalid 'messages[1].tool_calls': empty array. Expected an array with minimum length 1, but got an empty array instead." }],
  ['an empty tool_calls beats the capability pass', { messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'x', tool_calls: [] }], temperature: 0.5 }, { param: 'messages[1].tool_calls', code: 'empty_array', message: "Invalid 'messages[1].tool_calls': empty array. Expected an array with minimum length 1, but got an empty array instead." }],
  ['an empty tool_calls loses to a content type fault', { messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 7, tool_calls: [] }] }, { param: 'messages[1].content', code: 'invalid_type', message: "Invalid type for 'messages[1].content': expected one of a string or array of objects, but got an integer instead." }],
  ['a tool_calls of the wrong type', { messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'x', tool_calls: 'x' }] }, { param: 'messages[1].tool_calls', code: 'invalid_type', message: "Invalid type for 'messages[1].tool_calls': expected an array of objects, but got a string instead." }],

  // WHERE the content check sits: last of all. The docstring on
  // `refuseOpenAiChatMissingContent` says it loses to the content TYPE check at
  // any index, to a bad role at any index, and to the capability pass — and
  // until these rows nothing under `test/` saw it. Moving the check to the
  // front of the field walk changed all three answers with the suite green,
  // because every earlier row carries exactly one fault. Each row here is
  // invalid TWICE and its control below is the same body with the earlier
  // fault removed, so the two answers are opposites rather than one repeated.
  ['a content type fault at a LATER index beats a missing content at an earlier one', { messages: [{ role: 'user' }, { role: 'user', content: 7 }] }, { param: 'messages[1].content', code: 'invalid_type', message: "Invalid type for 'messages[1].content': expected one of a string or array of objects, but got an integer instead." }],
  ['CONTROL: with a valid content at index 1 the missing one at index 0 answers', { messages: [{ role: 'user' }, { role: 'user', content: 'a' }] }, { param: 'messages.[0].content', code: null, message: "Invalid value for 'content': expected a string, got null." }],
  ['a refused temperature VALUE beats a missing content', { messages: [{ role: 'user' }], temperature: 0.5 }, { param: 'temperature', code: 'unsupported_value', message: "Unsupported value: 'temperature' does not support 0.5 with this model. Only the default (1) value is supported." }],
  ['CONTROL: at the default temperature the missing content answers', { messages: [{ role: 'user' }], temperature: 1 }, { param: 'messages.[0].content', code: null, message: "Invalid value for 'content': expected a string, got null." }],
  ['a bad role at a LATER index beats a missing content at an earlier one', { messages: [{ role: 'user' }, { role: 'bogus', content: 'a' }] }, { param: 'messages[1].role', code: 'invalid_value', message: "Invalid value: 'bogus'. Supported values are: 'system', 'assistant', 'user', 'function', 'tool', and 'developer'." }],
  ['CONTROL: with a known role at index 1 the missing content at index 0 answers', { messages: [{ role: 'user' }, { role: 'assistant', content: 'a' }] }, { param: 'messages.[0].content', code: null, message: "Invalid value for 'content': expected a string, got null." }],

  // WHOSE content the substitutes stand in for: the assistant's alone.
  // `tool_calls`, `function_call`, `refusal` and `audio` are the assistant
  // schema's own one-of, so on any other role they are ordinary extra members
  // and the message still needs content. Relaxing the check's `role ===
  // 'assistant'` to `role !== undefined` turned every row here into a 200 with
  // the suite green. The opposite answer for the identical substitute — an
  // assistant message that carries it and is accepted — is the paired loop in
  // `chat requires content, and the assistant schema says what stands in for it`.
  ['a tool message carrying a refusal still needs content', { messages: [{ role: 'user', content: 'a' }, { role: 'tool', tool_call_id: 'c', refusal: 'no' }] }, { param: 'messages.[1].content', code: null, message: "Invalid value for 'content': expected a string, got null." }],
  ['a system message carrying audio still needs content', { messages: [{ role: 'system', audio: { id: 'a' } }, { role: 'user', content: 'a' }] }, { param: 'messages.[0].content', code: null, message: "Invalid value for 'content': expected a string, got null." }],
  ['a user message carrying tool_calls still needs content', { messages: [{ role: 'user', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] }] }, { param: 'messages.[0].content', code: null, message: "Invalid value for 'content': expected a string, got null." }],
  // `developer` keeps its own schema's words even here: the plain
  // `messages[i].content` param and a missing-parameter code, not the
  // dotted-bracket sentence every other role gets.
  ['a developer message carrying a refusal still needs content, in its own words', { messages: [{ role: 'user', content: 'a' }, { role: 'developer', refusal: 'no' }] }, { param: 'messages[1].content', code: 'missing_required_parameter', message: "Missing required parameter: 'messages[1].content'." }],

  // Unknown top-level keys — the strict schema P-5 found and §5.5.5 enumerated.
  ['an invented key', { zzz_unknown: 1 }, { param: 'zzz_unknown', code: 'unknown_parameter', message: "Unknown parameter: 'zzz_unknown'." }],
  ['audio', { audio: { voice: 'alloy', format: 'wav' } }, { param: 'audio', code: 'unknown_parameter', message: "Unknown parameter: 'audio'." }],
  ['modalities', { modalities: ['text', 'audio'] }, { param: 'modalities', code: 'unknown_parameter', message: "Unknown parameter: 'modalities'." }],
  ['web_search_options', { web_search_options: {} }, { param: 'web_search_options', code: 'unknown_parameter', message: "Unknown parameter: 'web_search_options'." }],
  ['the Responses-shaped reasoning', { reasoning: { effort: 'low' } }, { param: 'reasoning', code: 'unknown_parameter', message: "Unknown parameter: 'reasoning'." }],
  ['the Responses-shaped text', { text: { verbosity: 'low' } }, { param: 'text', code: 'unknown_parameter', message: "Unknown parameter: 'text'." }],

  // Spelling help on an unknown key, and its two measured limits. The six rows
  // above all use keys far from every known one, so they pass with or without
  // suggestions — reverting the whole feature left this file green.
  ['an unknown key near store', { stor: 1 }, { param: 'stor', code: 'unknown_parameter', message: "Unknown parameter: 'stor'. Did you mean 'stop' or 'store'?" }],
  ['an unknown key near temperature', { temperatur: 1 }, { param: 'temperatur', code: 'unknown_parameter', message: "Unknown parameter: 'temperatur'. Did you mean 'temperature'?" }],
  ['an unknown key near a key the body already sent', { messagess: 1 }, { param: 'messagess', code: 'unknown_parameter', message: "Unknown parameter: 'messagess'." }],
  // Chat's own terse sentence, which Responses answers as an `invalid_value`.
  ['prompt_cache_retention outside the enum', { prompt_cache_retention: 'x' }, { param: 'prompt_cache_retention', code: null, message: 'Invalid prompt_cache_retention argument' }],

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
  // Conformance matrix §7 rows 11–12, measured live 2026-09-04 (`e2e:text:parity`).
  ['a tool function with a blank name', { tools: [{ type: 'function', function: { name: '', parameters: {} } }] }, { param: 'tools[0].function.name', code: 'empty_string', message: "Invalid 'tools[0].function.name': empty string. Expected a string with minimum length 1, but got an empty string instead." }],
  ['a tool_choice naming an undeclared function', { tools: [{ type: 'function', function: { name: 'f', parameters: {} } }], tool_choice: { type: 'function', function: { name: 'never_declared' } } }, { param: 'function_call', code: null, message: "Invalid value for 'function_call': no function named 'never_declared' was specified in the 'functions' parameter." }],
  ['a function_call object with no name', { functions: [{ name: 'f', parameters: {} }], function_call: { __probe__: 'wrong type' } }, { param: 'function_call.name', code: 'missing_required_parameter', message: "Missing required parameter: 'function_call.name'." }],
  ['no messages at all', { messages: '__delete__' }, { param: 'messages', code: 'missing_required_parameter', message: "Missing required parameter: 'messages'." }],
  ['an empty messages array', { messages: [] }, { param: 'messages', code: 'empty_array', message: "Invalid 'messages': empty array. Expected an array with minimum length 1, but got an empty array instead." }],
  ['a message with no role', { messages: [{ content: 'ping' }] }, { param: 'messages[0].role', code: 'missing_required_parameter', message: "Missing required parameter: 'messages[0].role'." }],
  ['a moderation object with no model', { moderation: {} }, { param: 'moderation.model', code: 'missing_required_parameter', message: "Missing required parameter: 'moderation.model'." }],

  // Ranges and nested unions.
  ['frequency_penalty above its range', { reasoning_effort: 'none', frequency_penalty: 3 }, { param: 'frequency_penalty', code: 'decimal_above_max_value', message: "Invalid 'frequency_penalty': decimal above maximum value. Expected a value <= 2, but got 3 instead." }],
  ['presence_penalty below its range', { reasoning_effort: 'none', presence_penalty: -3 }, { param: 'presence_penalty', code: 'decimal_below_min_value', message: "Invalid 'presence_penalty': decimal below minimum value. Expected a value >= -2, but got -3 instead." }],
  ['a json_schema format with no schema member', { response_format: { type: 'json_schema' } }, { param: 'response_format.json_schema', code: 'missing_required_parameter', message: "Missing required parameter: 'response_format.json_schema'." }],
  ['a json_schema member with no name', { response_format: { type: 'json_schema', json_schema: {} } }, { param: 'response_format.json_schema.name', code: 'missing_required_parameter', message: "Missing required parameter: 'response_format.json_schema.name'." }],
  ['an unknown stream_options member', { stream_options: { bogus: 1 } }, { param: 'stream_options.bogus', code: 'unknown_parameter', message: "Unknown parameter: 'stream_options.bogus'." }],

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
  // The order is measured, not alphabetical: each of these pairs was sent to
  // the direct API and the winner recorded (§5.5.5). They are here because a
  // hand-picked subset let a reordering of two checks pass unnoticed.
  ['seed before service_tier', { seed: 1.5, service_tier: 'bogus' }, { param: 'seed', message: "Invalid type for 'seed': expected an integer, but got a decimal number instead." }],
  ['n before metadata', { metadata: { k: 7 }, n: 0 }, { param: 'n', message: "Invalid 'n': integer below minimum value. Expected a value >= 1, but got 0 instead." }],
  ['max_completion_tokens before logprobs', { logprobs: 'x', max_completion_tokens: 0 }, { param: 'max_completion_tokens', message: "Invalid 'max_completion_tokens': integer below minimum value. Expected a value >= 1, but got 0 instead." }],
  ['messages before metadata', { messages: [7], metadata: { k: 7 } }, { param: 'messages[0]', message: "Invalid type for 'messages[0]': expected an object, but got an integer instead." }],
  ['n before moderation', { moderation: {}, n: 0 }, { param: 'n', message: "Invalid 'n': integer below minimum value. Expected a value >= 1, but got 0 instead." }],
  ['stream before store', { store: 'x', stream: 'y' }, { param: 'stream', message: "Invalid type for 'stream': expected a boolean, but got a string instead." }],
  ['tools before top_logprobs', { tools: 'x', top_logprobs: -1 }, { param: 'tools', message: "Invalid type for 'tools': expected an array of objects, but got a string instead." }],
  ['user before verbosity', { user: 7, verbosity: 'bogus' }, { param: 'user', message: "Invalid type for 'user': expected a string, but got an integer instead." }],
  ['functions before function_call', { function_call: {}, functions: 'x' }, { param: 'functions', message: "Invalid type for 'functions': expected an array of function definitions, but got a string instead." }],
  ['prompt_cache_options before prompt_cache_key', { prompt_cache_key: 7, prompt_cache_options: 'x' }, { param: 'prompt_cache_options', message: "Invalid type for 'prompt_cache_options': expected an object, but got a string instead." }],
  ['max_tokens before store', { max_tokens: 32, store: 'x' }, { param: 'max_tokens', message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." }],
  ['stop before stream_options', { stop: ['ZZ'], stream_options: 'x' }, { param: 'stop', message: "Unsupported parameter: 'stop' is not supported with this model." }],
  ['stop before verbosity', { stop: ['ZZ'], verbosity: 'bogus' }, { param: 'stop', message: "Unsupported parameter: 'stop' is not supported with this model." }],
  ['metadata before prediction', { prediction: { type: 'content', content: 'p' }, metadata: 'x' }, { param: 'metadata', message: "Invalid type for 'metadata': expected a metadata object, but got a string instead." }],
  ['logit_bias before verbosity', { logit_bias: { 1: 1 }, verbosity: 'bogus' }, { param: 'logit_bias', message: "Unsupported parameter: 'logit_bias' is not supported with this model." }],
  ['metadata before a refused temperature value', { temperature: 0.5, metadata: 'x' }, { param: 'metadata', message: "Invalid type for 'metadata': expected a metadata object, but got a string instead." }],
  ['verbosity before a refused logprobs', { logprobs: true, verbosity: 'bogus' }, { param: 'verbosity', message: "Invalid value: 'bogus'. Supported values are: 'low', 'medium', and 'high'." }],
];

// Every ADJACENT edge of the measured order, derived from one list rather than
// hand-picked. The old table paired `store` with `stream` and `max_tokens` and
// `metadata` with `prediction` — but never `store` with `metadata`, and
// swapping exactly those two adjacent checks changed the reported fault with
// no test noticing (found by mutation). Keys whose wrong-type value is refused
// for another reason are absent here on purpose: fault kind changes the order,
// so a mixed-kind pair tests nothing. Each row sends the LATER key first.
const WRONG = { __probe__: 'wrong type' };
const ADJACENT = [
  ['messages before functions, the adjacent edge', { functions: 'wrong type', messages: 'wrong type' }, { param: 'messages', message: "Invalid type for 'messages': expected an array of objects, but got a string instead." }],
  ['functions before tools, the adjacent edge', { tools: 'wrong type', functions: 'wrong type' }, { param: 'functions', message: "Invalid type for 'functions': expected an array of function definitions, but got a string instead." }],
  ['tools before parallel_tool_calls, the adjacent edge', { parallel_tool_calls: WRONG, tools: 'wrong type' }, { param: 'tools', message: "Invalid type for 'tools': expected an array of objects, but got a string instead." }],
  ['parallel_tool_calls before max_completion_tokens, the adjacent edge', { max_completion_tokens: WRONG, parallel_tool_calls: WRONG }, { param: 'parallel_tool_calls', message: "Invalid type for 'parallel_tool_calls': expected a boolean, but got an object instead." }],
  ['max_completion_tokens before n, the adjacent edge', { n: WRONG, max_completion_tokens: WRONG }, { param: 'max_completion_tokens', message: "Invalid type for 'max_completion_tokens': expected an integer, but got an object instead." }],
  ['n before temperature, the adjacent edge', { temperature: WRONG, n: WRONG }, { param: 'n', message: "Invalid type for 'n': expected an integer, but got an object instead." }],
  ['temperature before top_p, the adjacent edge', { top_p: WRONG, temperature: WRONG }, { param: 'temperature', message: "Invalid type for 'temperature': expected a decimal, but got an object instead." }],
  ['top_p before presence_penalty, the adjacent edge', { presence_penalty: WRONG, top_p: WRONG }, { param: 'top_p', message: "Invalid type for 'top_p': expected a decimal, but got an object instead." }],
  ['presence_penalty before frequency_penalty, the adjacent edge', { frequency_penalty: WRONG, presence_penalty: WRONG }, { param: 'presence_penalty', message: "Invalid type for 'presence_penalty': expected a decimal, but got an object instead." }],
  ['frequency_penalty before logprobs, the adjacent edge', { logprobs: WRONG, frequency_penalty: WRONG }, { param: 'frequency_penalty', message: "Invalid type for 'frequency_penalty': expected a decimal, but got an object instead." }],
  ['logprobs before top_logprobs, the adjacent edge', { top_logprobs: WRONG, logprobs: WRONG }, { param: 'logprobs', message: "Invalid type for 'logprobs': expected a boolean, but got an object instead." }],
  ['top_logprobs before user, the adjacent edge', { user: WRONG, top_logprobs: WRONG }, { param: 'top_logprobs', message: "Invalid type for 'top_logprobs': expected an integer, but got an object instead." }],
  ['user before seed, the adjacent edge', { seed: WRONG, user: WRONG }, { param: 'user', message: "Invalid type for 'user': expected a string, but got an object instead." }],
  ['seed before safety_identifier, the adjacent edge', { safety_identifier: WRONG, seed: WRONG }, { param: 'seed', message: "Invalid type for 'seed': expected an integer, but got an object instead." }],
  ['safety_identifier before prompt_cache_key, the adjacent edge', { prompt_cache_key: WRONG, safety_identifier: WRONG }, { param: 'safety_identifier', message: "Invalid type for 'safety_identifier': expected a string, but got an object instead." }],
  ['prompt_cache_key before prompt_cache_retention, the adjacent edge', { prompt_cache_retention: WRONG, prompt_cache_key: WRONG }, { param: 'prompt_cache_key', message: "Invalid type for 'prompt_cache_key': expected a string, but got an object instead." }],
  ['prompt_cache_retention before service_tier, the adjacent edge', { service_tier: WRONG, prompt_cache_retention: WRONG }, { param: 'prompt_cache_retention', message: "Invalid type for 'prompt_cache_retention': expected one of 'in_memory' or '24h', but got an object instead." }],
  ['service_tier before stream, the adjacent edge', { stream: WRONG, service_tier: WRONG }, { param: 'service_tier', message: "Invalid type for 'service_tier': expected one of 'auto', 'default', 'fast', 'flex', or 'priority', but got an object instead." }],
  ['stream before store, the adjacent edge', { store: WRONG, stream: WRONG }, { param: 'stream', message: "Invalid type for 'stream': expected a boolean, but got an object instead." }],
  ['store before metadata, the adjacent edge', { metadata: 'wrong type', store: WRONG }, { param: 'store', message: "Invalid type for 'store': expected a boolean, but got an object instead." }],
  ['metadata before verbosity, the adjacent edge', { verbosity: WRONG, metadata: 'wrong type' }, { param: 'metadata', message: "Invalid type for 'metadata': expected a metadata object, but got a string instead." }],
];

for (const [name, fragment, expected] of [...ORDER, ...ADJACENT]) {
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

// A rejection table proves the far side of a bound; without the near side, a
// `>` that became a `>=` refuses a valid request and every rejection still
// passes. These are the exact boundaries.
for (const [name, fragment] of [
  ['n at 1', { n: 1 }],
  ['n at 8', { n: 8 }],
  ['max_completion_tokens at 1', { max_completion_tokens: 1 }],
  ['top_logprobs at 0', { reasoning_effort: 'none', logprobs: true, top_logprobs: 0 }],
  ['top_logprobs at 5', { reasoning_effort: 'none', logprobs: true, top_logprobs: 5 }],
  ['metadata with exactly 16 properties', { metadata: Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`k${i}`, 'v'])) }],
  ['a metadata key of exactly 64 characters', { metadata: { ['k'.repeat(64)]: 'v' } }],
  ['a metadata value of exactly 512 characters', { metadata: { k: 'x'.repeat(512) } }],
  ['penalties at their bounds', { reasoning_effort: 'none', frequency_penalty: 2, presence_penalty: -2 }],
]) {
  test(`chat accepts ${name} — the valid side of the bound`, async () => {
    const { status, payload } = await chat(fragment);
    assert.equal(status, 200, JSON.stringify(payload));
  });
}

test('chat accepts the penalties and logprobs once the model stops reasoning', async () => {
  const { status } = await chat({ reasoning_effort: 'none', frequency_penalty: 0.5, presence_penalty: 0.5, logprobs: true, top_logprobs: 5 });
  assert.equal(status, 200);
});

test('chat requires content, and the assistant schema says what stands in for it', async () => {
  // This test asserted the opposite until 2026-08-31. Re-measured on
  // gpt-5.6-terra, gpt-5.5 and gpt-5.6-sol, with `content:"hi"` as the positive
  // control: an absent or null `content` is 400 on every role, and only an
  // assistant message carrying one of the schema's substitutes is exempt.
  const missing = await chat({ messages: [{ role: 'user' }, { role: 'assistant', content: null }, { role: 'user', content: 'ping' }] });
  assert.equal(missing.status, 400);
  assert.equal(missing.payload.error.param, 'messages.[0].content');
  assert.equal(missing.payload.error.code, null);
  assert.equal(missing.payload.error.message, "Invalid value for 'content': expected a string, got null.");
  // The empty string and the empty array are CONTENT — present, and accepted.
  for (const content of ['', []]) {
    const { status } = await chat({ messages: [{ role: 'user', content }] });
    assert.equal(status, 200, `content ${JSON.stringify(content)} is present`);
  }
  // Each substitute alone stands in for content on an assistant message.
  for (const [label, extra] of [
    ['tool_calls', { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] }],
    ['function_call', { function_call: { name: 'f', arguments: '{}' } }],
    ['refusal', { refusal: 'no' }],
    ['audio', { audio: { id: 'a1' } }],
  ]) {
    const { status } = await chat({ messages: [{ role: 'user', content: 'a' }, { role: 'assistant', ...extra }] });
    assert.equal(status, 200, `an assistant carrying ${label} needs no content`);
    // The same substitute on a role that is not `assistant` is no substitute at
    // all — it is the assistant schema's own one-of. This is the opposite
    // answer for the identical member, and the pair is what pins the scoping:
    // widening the check's `role === 'assistant'` makes the 400 a 200 and every
    // assertion above still passes.
    const other = await chat({ messages: [{ role: 'user', content: 'a' }, { role: 'user', ...extra }] });
    assert.equal(other.status, 400, `a user message carrying ${label} still needs content`);
    assert.equal(other.payload.error.param, 'messages.[1].content');
    assert.equal(other.payload.error.code, null);
    assert.equal(other.payload.error.message, "Invalid value for 'content': expected a string, got null.");
  }
  // And an assistant carrying none of them does need it.
  const bare = await chat({ messages: [{ role: 'user', content: 'a' }, { role: 'assistant' }] });
  assert.equal(bare.status, 400);
  assert.equal(bare.payload.error.param, 'messages.[1].content');
});

// `service_tier` is echoed, so it is the one accepted-and-not-applied key with
// a visible answer — and the answer is NOT the request: `fast` comes back as
// `priority`, `auto` and an omitted value as `default` (measured 2026-08-30 on
// both surfaces).
for (const [sent, echoed] of [[undefined, 'default'], ['auto', 'default'], ['default', 'default'], ['flex', 'flex'], ['priority', 'priority'], ['fast', 'priority']]) {
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

test('chat runs function tools with a reasoning effort, the one declared divergence', async () => {
  // `spec/declared-divergences.json` says this proxy accepts a combination the
  // direct API refuses for the gpt-5.6 family. A declaration nothing exercises
  // is a claim: this asserts the request reaches the backend, so a cross-field
  // rejection added later fails here instead of quietly making the
  // declaration false.
  const { readFile } = await import('node:fs/promises');
  const declared = JSON.parse(await readFile(new URL('../spec/declared-divergences.json', import.meta.url), 'utf8'));
  assert.ok(
    declared.divergences.some((entry) => entry.claim === 'chat-function-tools-with-reasoning-effort'),
    'the declaration this test guards is missing; remove the test with it',
  );
  let reached = false;
  const started = await startLocalApiProxy({
    backend: {
      name: 'test', model: 'configured-model',
      async generate() {
        reached = true;
        return { id: 'x', model: 'configured-model', text: 'ok', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, source: 'estimated' }, latencyMs: 1 };
      },
      async close() {},
    },
    host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
  });
  try {
    const res = await fetch(`${started.url}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'a-model', messages: [{ role: 'user', content: 'ping' }],
        reasoning_effort: 'high',
        tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object', properties: {} } } }],
      }),
    });
    assert.equal(res.status, 200);
    assert.ok(reached, 'the turn must reach the backend, which is what the divergence claims');
  } finally {
    await started.close();
  }
});

test('chat runs a function-role turn, the second declared divergence', async () => {
  // `spec/declared-divergences.json` says this proxy accepts a role the direct
  // API refuses outright for `gpt-5.6-terra` — 400 `unsupported_value` at
  // `messages[2].role`, "does not support 'function' with this mode", with any
  // content. The sentence names the MODE, so it is that vendor model's
  // capability rather than this surface's rule, and refusing a turn the
  // backends serve would be the violation. Same guard as the row above: a
  // declaration nothing exercises is a claim.
  const { readFile } = await import('node:fs/promises');
  const declared = JSON.parse(await readFile(new URL('../spec/declared-divergences.json', import.meta.url), 'utf8'));
  assert.ok(
    declared.divergences.some((entry) => entry.claim === 'chat-function-role-is-not-refused'),
    'the declaration this test guards is missing; remove the test with it',
  );
  let reached = null;
  const started = await startLocalApiProxy({
    backend: {
      name: 'test', model: 'configured-model',
      async generate(request) {
        reached = request.messages;
        return { id: 'x', model: 'configured-model', text: 'ok', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, source: 'estimated' }, latencyMs: 1 };
      },
      async close() {},
    },
    host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
  });
  try {
    const res = await fetch(`${started.url}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'a-model',
        messages: [
          { role: 'user', content: 'weather?' },
          { role: 'assistant', content: 'checking' },
          { role: 'function', name: 'f', content: '23C' },
        ],
      }),
    });
    assert.equal(res.status, 200, await res.text());
    assert.ok(reached, 'the turn must reach the backend, which is what the divergence claims');
    assert.ok(
      reached.some((message) => String(message.content).includes('23C')),
      "the function turn's content must reach the backend, not just the request",
    );
  } finally {
    await started.close();
  }
  // The other half of the same declaration, and the opposite answer: the role
  // is accepted, but it is NOT exempt from the content rule — a null content on
  // it is this proxy's ordinary missing-content sentence, not the direct API's
  // role refusal. Both were measured 2026-09-01.
  const nulled = await chat({
    messages: [
      { role: 'user', content: 'weather?' },
      { role: 'assistant', content: 'checking' },
      { role: 'function', name: 'f', content: null },
    ],
  });
  assert.equal(nulled.status, 400);
  assert.equal(nulled.payload.error.param, 'messages.[2].content');
  assert.equal(nulled.payload.error.code, null);
  assert.equal(nulled.payload.error.message, "Invalid value for 'content': expected a string, got null.");
});

test('the Python-style rendering of a refused value is Python, not string surgery', async () => {
  // A caller's apostrophe used to come back as `{'k': 'a'b'}`, which says
  // something the value does not.
  const { payload } = await chat({ reasoning_effort: { k: "a'b" } });
  assert.match(payload.error.message, /\{'k': "a'b"\}/);
});

// The Responses surface echoes it too, and shares the resolver.
test('responses echoes the resolved service_tier', async () => {
  const { status, payload } = await chat({ input: 'ping', messages: '__delete__', service_tier: 'flex' }, '/v1/responses');
  assert.equal(status, 200);
  assert.equal(payload.service_tier, 'flex');
});

test('responses refuses an unknown service_tier instead of echoing it', async () => {
  // The echo made an unvalidated request value visible in the response; the
  // direct API answers this body with `invalid_value` (measured 2026-08-30).
  const { status, payload } = await chat({ input: 'ping', messages: '__delete__', service_tier: 'bogus' }, '/v1/responses');
  assert.equal(status, 400);
  assert.equal(payload.error.param, 'service_tier');
  assert.equal(payload.error.code, 'invalid_value');
  assert.equal(payload.error.message, "Invalid value: 'bogus'. Supported values are: 'auto', 'default', 'fast', 'flex', and 'priority'.");
});

test('responses resolves fast to priority, as the direct API does', async () => {
  const { status, payload } = await chat({ input: 'ping', messages: '__delete__', service_tier: 'fast' }, '/v1/responses');
  assert.equal(status, 200);
  assert.equal(payload.service_tier, 'priority');
});
