import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startLocalApiProxy } from '../dist/proxy/http-server.js';

// The Responses twin of `openai-chat-validation-parity.test.mjs`, and the same
// rule: every row is a DIRECT API observation taken 2026-08-30 against
// `gpt-5.6-terra`, recorded in `docs/conformance-matrix.md` §5.5.6. The bodies
// are literally the rows `scripts/e2e-text-surfaces-direct-parity.mjs` sends to
// both sides; this file is what protects them when no key is loaded, and the
// envelopes below were taken from the proxy on a run where that instrument
// reported ALL PASS against the live API.
//
// Three of this surface's rules are NOT Chat's, which is why the validators are
// separate: `model: null` is a type fault here, `reasoning.effort` answers in
// two layers with `max` inside its model set, and `prompt_cache_retention`
// outside the enum is an `invalid_value` here and a terse code-less sentence
// there.

const DELETE = Symbol('delete the key');
const M = [{ role: 'user', content: 'ping' }];
const I = 'ping';
const OUT = { input: I, max_output_tokens: 16 };
const RTOOL = { type: 'function', name: 'f', parameters: { type: 'object', properties: {} } };

function backend() {
  return {
    name: 'test',
    model: 'configured-model',
    // Every row here is a rejection, so a row that reaches the backend is a
    // broken row rather than a passing test.
    async generate() { throw new Error('a rejection case reached the backend'); },
    async *stream() { throw new Error('a rejection case reached the backend'); },
    async close() {},
  };
}

async function responses(extra) {
  const started = await startLocalApiProxy({ backend: backend(), host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000 });
  try {
    const body = { model: 'gpt-5.6-terra', ...extra };
    for (const key of Object.keys(body)) if (body[key] === DELETE) delete body[key];
    const res = await fetch(`${started.url}/v1/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, payload: await res.json() };
  } finally {
    await started.close();
  }
}

// [name, request fragment, {status = 400, param, code, message}]
const REJECTIONS = [
  // Keys this surface does not know — four of them are Chat's.
  ["unknown key", { ...OUT, zzz_unknown: 1 }, { param: "zzz_unknown", code: "unknown_parameter", message: "Unknown parameter: 'zzz_unknown'." }],
  ["n", { ...OUT, n: 2 }, { param: "n", code: "unknown_parameter", message: "Unknown parameter: 'n'." }],
  ["stop", { ...OUT, stop: ['ZZ'] }, { param: "stop", code: "unknown_parameter", message: "Unknown parameter: 'stop'. Did you mean 'store'?" }],
  ["seed", { ...OUT, seed: 1 }, { param: "seed", code: "unknown_parameter", message: "Unknown parameter: 'seed'." }],
  ["logprobs", { ...OUT, logprobs: true }, { param: "logprobs", code: "unknown_parameter", message: "Unknown parameter: 'logprobs'." }],
  ["max_tokens", { ...OUT, max_tokens: 16 }, { param: "max_tokens", code: "unknown_parameter", message: "Unknown parameter: 'max_tokens'." }],
  ["messages instead of input", { ...OUT, messages: M }, { param: null, code: "unsupported_parameter", message: "Unsupported parameter: 'messages'. In the Responses API, this parameter has moved to 'input'. Try again with the new parameter. See the API documentation for more information: https://platform.openai.com/docs/api-reference/responses/create." }],
  // model — measured as a different sentence from Chat's.
  ["model absent", { ...OUT, model: DELETE }, { param: "model", code: "missing_required_parameter", message: "Missing required parameter: 'model'." }],
  ["model null", { ...OUT, model: null }, { param: "model", code: "invalid_type", message: "Invalid type for 'model': expected a string, but got an object instead." }],
  ["model empty", { ...OUT, model: '' }, { param: "model", code: "model_not_found", message: "The requested model '' does not exist." }],
  ["model as an integer", { ...OUT, model: 7 }, { param: "model", code: "invalid_type", message: "Invalid type for 'model': expected a string, but got an integer instead." }],
  // input, and the item members inside it.
  ["input as an object", { ...OUT, input: { a: 1 } }, { param: "input", code: "invalid_type", message: "Invalid type for 'input': expected one of a string or array of input items, but got an object instead." }],
  ["input item unknown member", { ...OUT, input: [{ role: 'user', content: I, bogus: 1 }] }, { param: "input[0].bogus", code: "unknown_parameter", message: "Unknown parameter: 'input[0].bogus'." }],
  ["input item status", { ...OUT, input: [{ role: 'user', content: I, status: 'completed' }], temperature: 0.5 }, { param: "temperature", code: null, message: "Unsupported parameter: 'temperature' is not supported with this model." }],
  ["input item id", { ...OUT, input: [{ role: 'user', content: I, id: 'msg_x' }], temperature: 0.5 }, { param: "temperature", code: null, message: "Unsupported parameter: 'temperature' is not supported with this model." }],
  ["input item type", { ...OUT, input: [{ type: 'message', role: 'user', content: I }], temperature: 0.5 }, { param: "temperature", code: null, message: "Unsupported parameter: 'temperature' is not supported with this model." }],
  // reasoning — its own enum, wider than Chat's.
  ["reasoning as a string", { ...OUT, reasoning: 'low' }, { param: "reasoning", code: "invalid_type", message: "Invalid type for 'reasoning': expected an object, but got a string instead." }],
  ["reasoning.effort unknown", { ...OUT, reasoning: { effort: 'bogus' } }, { param: "reasoning.effort", code: "invalid_value", message: "Invalid value: 'bogus'. Supported values are: 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', and 'max'." }],
  ["reasoning.effort as an object", { ...OUT, reasoning: { effort: { __probe__: 'wrong type' } } }, { param: "reasoning.effort", code: "invalid_type", message: "Invalid type for 'reasoning.effort': expected one of one of 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', or 'max' or integer, but got an object instead." }],
  ["reasoning.summary unknown", { ...OUT, reasoning: { summary: 'bogus' } }, { param: "reasoning.summary", code: "invalid_value", message: "Invalid value: 'bogus'. Supported values are: 'concise', 'detailed', and 'auto'." }],
  ["reasoning.generate_summary", { ...OUT, reasoning: { generate_summary: 'concise' } }, { param: "reasoning.generate_summary", code: "unknown_parameter", message: "Unknown parameter: 'reasoning.generate_summary'." }],
  ["reasoning unknown member", { ...OUT, reasoning: { bogus: 1 } }, { param: "reasoning.bogus", code: "unknown_parameter", message: "Unknown parameter: 'reasoning.bogus'." }],
  // Sampling and penalties: refused by parameter, and by type before that.
  ["temperature 0.5", { ...OUT, temperature: 0.5 }, { param: "temperature", code: null, message: "Unsupported parameter: 'temperature' is not supported with this model." }],
  ["temperature as a string", { ...OUT, temperature: 'hot' }, { param: "temperature", code: "invalid_type", message: "Invalid type for 'temperature': expected a decimal, but got a string instead." }],
  ["top_p 0.5", { ...OUT, top_p: 0.5 }, { param: "top_p", code: null, message: "Unsupported parameter: 'top_p' is not supported with this model." }],
  ["top_p as a string", { ...OUT, top_p: 'wide' }, { param: "top_p", code: "invalid_type", message: "Invalid type for 'top_p': expected a decimal, but got a string instead." }],
  ["presence_penalty", { ...OUT, presence_penalty: 0.5 }, { param: "presence_penalty", code: null, message: "Unsupported parameter: 'presence_penalty' is not supported with this model." }],
  ["frequency_penalty", { ...OUT, frequency_penalty: 0.5 }, { param: "frequency_penalty", code: null, message: "Unsupported parameter: 'frequency_penalty' is not supported with this model." }],
  ["presence_penalty as a string", { ...OUT, presence_penalty: 'x' }, { param: "presence_penalty", code: "invalid_type", message: "Invalid type for 'presence_penalty': expected a decimal, but got a string instead." }],
  // logprobs, by either door.
  ["top_logprobs", { ...OUT, top_logprobs: 1 }, { param: "top_logprobs", code: "unsupported_parameter", message: "logprobs are not supported with reasoning models." }],
  ["top_logprobs as a string", { ...OUT, top_logprobs: 'x' }, { param: "top_logprobs", code: "invalid_type", message: "Invalid type for 'top_logprobs': expected an integer, but got a string instead." }],
  ["include logprobs", { ...OUT, include: ['message.output_text.logprobs'] }, { param: "include", code: "unsupported_parameter", message: "logprobs are not supported with reasoning models." }],
  // Server-side state this proxy holds none of.
  ["previous_response_id unknown", { ...OUT, previous_response_id: 'resp_probe_does_not_exist' }, { param: "previous_response_id", code: "previous_response_not_found", message: "Previous response with id 'resp_probe_does_not_exist' not found." }],
  ["previous_response_id as an object", { ...OUT, previous_response_id: { a: 1 } }, { param: "previous_response_id", code: "invalid_type", message: "Invalid type for 'previous_response_id': expected a string, but got an object instead." }],
  ["conversation unknown", { ...OUT, conversation: 'conv_probe_does_not_exist' }, { status: 404, param: null, code: null, message: "Conversation with id 'conv_probe_does_not_exist' not found." }],
  ["prompt id unknown", { ...OUT, prompt: { id: 'pmpt_probe_does_not_exist' } }, { status: 404, param: null, code: null, message: "Prompt with id 'pmpt_probe_does_not_exist' not found." }],
  ["prompt as a string", { ...OUT, prompt: 'x' }, { param: "prompt", code: "invalid_type", message: "Invalid type for 'prompt': expected an object, but got a string instead." }],
  // Enums and bounds.
  ["truncation unknown", { ...OUT, truncation: 'bogus' }, { param: "truncation", code: "invalid_value", message: "Invalid value: 'bogus'. Supported values are: 'auto' and 'disabled'." }],
  ["truncation as an object", { ...OUT, truncation: { a: 1 } }, { param: "truncation", code: "invalid_type", message: "Invalid type for 'truncation': expected one of 'auto' or 'disabled', but got an object instead." }],
  ["include unknown member", { ...OUT, include: ['bogus.thing'] }, { param: "include[0]", code: "invalid_value", message: "Invalid value: 'bogus.thing'. Supported values are: 'file_search_call.results', 'web_search_call.results', 'web_search_call.action.sources', 'message.input_image.image_url', 'computer_call_output.output.image_url', 'code_interpreter_call.outputs', 'reasoning.encrypted_content', and 'message.output_text.logprobs'." }],
  ["include as a string", { ...OUT, include: 'wrong type' }, { param: "include", code: "invalid_type", message: "Invalid type for 'include': expected an array of one of 'fil...lts', 'web...lts', 'web...ces', 'mes...url', 'com...url', 'cod...uts', 'rea...ent', or 'mes...obs', but got a string instead." }],
  ["max_tool_calls 0", { ...OUT, max_tool_calls: 0 }, { param: "max_tool_calls", code: "integer_below_min_value", message: "Invalid 'max_tool_calls': integer below minimum value. Expected a value >= 1, but got 0 instead." }],
  ["max_tool_calls as a string", { ...OUT, max_tool_calls: 'x' }, { param: "max_tool_calls", code: "invalid_type", message: "Invalid type for 'max_tool_calls': expected an integer, but got a string instead." }],
  ["max_output_tokens 0", { ...OUT, max_output_tokens: 0 }, { param: "max_output_tokens", code: "integer_below_min_value", message: "Invalid 'max_output_tokens': integer below minimum value. Expected a value >= 16, but got 0 instead." }],
  ["max_output_tokens as a string", { ...OUT, max_output_tokens: 'x' }, { param: "max_output_tokens", code: "invalid_type", message: "Invalid type for 'max_output_tokens': expected an integer, but got a string instead." }],
  ["metadata too many properties", { ...OUT, metadata: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, 'v'])) }, { param: "metadata", code: "object_above_max_properties", message: "Invalid 'metadata': too many properties. Expected an object with at most 16 properties, but got an object with 17 properties instead." }],
  ["metadata as a string", { ...OUT, metadata: 'x' }, { param: "metadata", code: "invalid_type", message: "Invalid type for 'metadata': expected a metadata object, but got a string instead." }],
  ["service_tier unknown", { ...OUT, service_tier: 'bogus' }, { param: "service_tier", code: "invalid_value", message: "Invalid value: 'bogus'. Supported values are: 'auto', 'default', 'fast', 'flex', and 'priority'." }],
  ["service_tier as an object", { ...OUT, service_tier: { a: 1 } }, { param: "service_tier", code: "invalid_type", message: "Invalid type for 'service_tier': expected one of 'auto', 'default', 'fast', 'flex', or 'priority', but got an object instead." }],
  ["prompt_cache_retention in_memory", { ...OUT, prompt_cache_retention: 'in_memory' }, { param: "prompt_cache_retention", code: "invalid_parameter", message: "This model is compatible only with 24h extended prompt caching" }],
  ["prompt_cache_retention as an object", { ...OUT, prompt_cache_retention: { a: 1 } }, { param: "prompt_cache_retention", code: "invalid_type", message: "Invalid type for 'prompt_cache_retention': expected one of 'in_memory' or '24h', but got an object instead." }],
  ["prompt_cache_options unknown member", { ...OUT, prompt_cache_options: { bogus: 1 } }, { param: "prompt_cache_options.bogus", code: "unknown_parameter", message: "Unknown parameter: 'prompt_cache_options.bogus'." }],
  ["prompt_cache_key as an object", { ...OUT, prompt_cache_key: { a: 1 } }, { param: "prompt_cache_key", code: "invalid_type", message: "Invalid type for 'prompt_cache_key': expected a string, but got an object instead." }],
  // stream_options: `include_usage` is a Chat key and unknown here (P-10).
  ["stream_options include_usage", { ...OUT, stream_options: { include_usage: true } }, { param: "stream_options.include_usage", code: "unknown_parameter", message: "Unknown parameter: 'stream_options.include_usage'." }],
  ["stream_options unknown member", { ...OUT, stream_options: { bogus: 1 } }, { param: "stream_options.bogus", code: "unknown_parameter", message: "Unknown parameter: 'stream_options.bogus'." }],
  ["stream_options as a string", { ...OUT, stream_options: 'x' }, { param: "stream_options", code: "invalid_type", message: "Invalid type for 'stream_options': expected an object, but got a string instead." }],
  // Plain type checks across the rest of the key set.
  ["stream as a string", { ...OUT, stream: 'yes' }, { param: "stream", code: "invalid_type", message: "Invalid type for 'stream': expected a boolean, but got a string instead." }],
  ["background as a string", { ...OUT, background: 'yes' }, { param: "background", code: "invalid_type", message: "Invalid type for 'background': expected a boolean, but got a string instead." }],
  ["store as a string", { ...OUT, store: 'yes' }, { param: "store", code: "invalid_type", message: "Invalid type for 'store': expected a boolean, but got a string instead." }],
  ["parallel_tool_calls as a string", { ...OUT, parallel_tool_calls: 'yes' }, { param: "parallel_tool_calls", code: "invalid_type", message: "Invalid type for 'parallel_tool_calls': expected a boolean, but got a string instead." }],
  ["instructions as an object", { ...OUT, instructions: { a: 1 } }, { param: "instructions", code: "invalid_type", message: "Invalid type for 'instructions': expected a string, but got an object instead." }],
  ["user as an object", { ...OUT, user: { a: 1 } }, { param: "user", code: "invalid_type", message: "Invalid type for 'user': expected a string, but got an object instead." }],
  ["safety_identifier as an object", { ...OUT, safety_identifier: { a: 1 } }, { param: "safety_identifier", code: "invalid_type", message: "Invalid type for 'safety_identifier': expected a string, but got an object instead." }],
  ["text as a string", { ...OUT, text: 'wrong type' }, { param: "text", code: "invalid_type", message: "Invalid type for 'text': expected an object, but got a string instead." }],
  ["tools as a string", { ...OUT, tools: 'wrong type' }, { param: "tools", code: "invalid_type", message: "Invalid type for 'tools': expected an array of tools, but got a string instead." }],
  ["context_management as a string", { ...OUT, context_management: 'wrong type' }, { param: "context_management", code: "invalid_type", message: "Invalid type for 'context_management': expected an array of objects, but got a string instead." }],
  ["moderation as a string", { ...OUT, moderation: 'wrong type' }, { param: "moderation", code: "invalid_type", message: "Invalid type for 'moderation': expected an object, but got a string instead." }],
  // tool_choice: a different sentence and a different object shape from Chat's.
  ["tool_choice as an integer", { ...OUT, tool_choice: 7 }, { param: "tool_choice", code: "invalid_type", message: "Invalid type for 'tool_choice': expected one of an object or 'none', 'auto', or 'required', but got an integer instead." }],
  ["tool_choice unknown string", { ...OUT, tools: [RTOOL], tool_choice: 'bogus' }, { param: "tool_choice", code: "invalid_value", message: "Invalid value: 'bogus'. Supported values are: 'none', 'auto', and 'required'." }],
  ["tool_choice object without a name", { ...OUT, tools: [RTOOL], tool_choice: { type: 'function' } }, { param: "tool_choice.name", code: "missing_required_parameter", message: "Missing required parameter: 'tool_choice.name'." }],
  ["chat-shaped tool_choice", { ...OUT, tools: [RTOOL], tool_choice: { type: 'function', function: { name: 'f' } } }, { param: "tool_choice.name", code: "missing_required_parameter", message: "Missing required parameter: 'tool_choice.name'." }],
  // Report order — this surface's own, nothing like Chat's (§5.5.6).
  ["order unknown key beats input item", { ...OUT, input: [{ role: 'user', content: I, bogus: 1 }], zzz_unknown: 1 }, { param: "zzz_unknown", code: "unknown_parameter", message: "Unknown parameter: 'zzz_unknown'." }],
  ["order model beats unknown key", { ...OUT, model: DELETE, zzz_unknown: 1 }, { param: "model", code: "missing_required_parameter", message: "Missing required parameter: 'model'." }],
  ["order input beats truncation", { ...OUT, input: 7, truncation: 'bogus' }, { param: "input", code: "invalid_type", message: "Invalid type for 'input': expected one of a string or array of input items, but got an integer instead." }],
  ["order input beats previous_response_id", { ...OUT, input: 7, previous_response_id: 'resp_x' }, { param: "input", code: "invalid_type", message: "Invalid type for 'input': expected one of a string or array of input items, but got an integer instead." }],
  ["order previous_response_id beats prompt", { ...OUT, previous_response_id: 'resp_x', prompt: { id: 'pmpt_x' } }, { status: 404, param: null, code: null, message: "Prompt with id 'pmpt_x' not found." }],
  ["order prompt beats include", { ...OUT, prompt: { id: 'pmpt_x' }, include: ['bogus.thing'] }, { param: "include[0]", code: "invalid_value", message: "Invalid value: 'bogus.thing'. Supported values are: 'file_search_call.results', 'web_search_call.results', 'web_search_call.action.sources', 'message.input_image.image_url', 'computer_call_output.output.image_url', 'code_interpreter_call.outputs', 'reasoning.encrypted_content', and 'message.output_text.logprobs'." }],
  ["order include beats tools", { ...OUT, include: ['bogus.thing'], tools: 'x' }, { param: "include[0]", code: "invalid_value", message: "Invalid value: 'bogus.thing'. Supported values are: 'file_search_call.results', 'web_search_call.results', 'web_search_call.action.sources', 'message.input_image.image_url', 'computer_call_output.output.image_url', 'code_interpreter_call.outputs', 'reasoning.encrypted_content', and 'message.output_text.logprobs'." }],
  ["order tools beats metadata", { ...OUT, tools: 'x', metadata: 'x' }, { param: "tools", code: "invalid_type", message: "Invalid type for 'tools': expected an array of tools, but got a string instead." }],
  ["order metadata beats text", { ...OUT, metadata: 'x', text: 'x' }, { param: "metadata", code: "invalid_type", message: "Invalid type for 'metadata': expected a metadata object, but got a string instead." }],
  ["order text beats temperature", { ...OUT, text: 'x', temperature: 'x' }, { param: "text", code: "invalid_type", message: "Invalid type for 'text': expected an object, but got a string instead." }],
  ["order temperature beats top_p", { ...OUT, temperature: 'x', top_p: 'x' }, { param: "temperature", code: "invalid_type", message: "Invalid type for 'temperature': expected a decimal, but got a string instead." }],
  ["order top_p beats presence_penalty", { ...OUT, top_p: 'x', presence_penalty: 'x' }, { param: "top_p", code: "invalid_type", message: "Invalid type for 'top_p': expected a decimal, but got a string instead." }],
  ["order parallel_tool_calls beats stream", { ...OUT, parallel_tool_calls: 'x', stream: 'x' }, { param: "parallel_tool_calls", code: "invalid_type", message: "Invalid type for 'parallel_tool_calls': expected a boolean, but got a string instead." }],
  ["order stream beats stream_options", { ...OUT, stream: 'x', stream_options: 'x' }, { param: "stream", code: "invalid_type", message: "Invalid type for 'stream': expected a boolean, but got a string instead." }],
  ["order stream_options beats background", { ...OUT, stream_options: 'x', background: 'x' }, { param: "stream_options", code: "invalid_type", message: "Invalid type for 'stream_options': expected an object, but got a string instead." }],
  ["order background beats max_output_tokens", { ...OUT, background: 'x', max_output_tokens: 'x' }, { param: "background", code: "invalid_type", message: "Invalid type for 'background': expected a boolean, but got a string instead." }],
  ["order max_output_tokens beats max_tool_calls", { ...OUT, max_output_tokens: 'x', max_tool_calls: 'x' }, { param: "max_output_tokens", code: "invalid_type", message: "Invalid type for 'max_output_tokens': expected an integer, but got a string instead." }],
  ["order max_tool_calls beats reasoning", { ...OUT, max_tool_calls: 'x', reasoning: 'x' }, { param: "max_tool_calls", code: "invalid_type", message: "Invalid type for 'max_tool_calls': expected an integer, but got a string instead." }],
  ["order reasoning beats user", { ...OUT, reasoning: 'x', user: 7 }, { param: "reasoning", code: "invalid_type", message: "Invalid type for 'reasoning': expected an object, but got a string instead." }],
  ["order user beats safety_identifier", { ...OUT, user: 7, safety_identifier: 7 }, { param: "user", code: "invalid_type", message: "Invalid type for 'user': expected a string, but got an integer instead." }],
  ["order safety_identifier beats prompt_cache_options", { ...OUT, safety_identifier: 7, prompt_cache_options: 'x' }, { param: "safety_identifier", code: "invalid_type", message: "Invalid type for 'safety_identifier': expected a string, but got an integer instead." }],
  ["order prompt_cache_options beats prompt_cache_key", { ...OUT, prompt_cache_options: 'x', prompt_cache_key: 7 }, { param: "prompt_cache_options", code: "invalid_type", message: "Invalid type for 'prompt_cache_options': expected an object, but got a string instead." }],
  ["order prompt_cache_key beats prompt_cache_retention", { ...OUT, prompt_cache_key: 7, prompt_cache_retention: 'x' }, { param: "prompt_cache_key", code: "invalid_type", message: "Invalid type for 'prompt_cache_key': expected a string, but got an integer instead." }],
  ["order prompt_cache_retention beats truncation", { ...OUT, prompt_cache_retention: 'x', truncation: 'x' }, { param: "prompt_cache_retention", code: "invalid_value", message: "Invalid value: 'x'. Supported values are: 'in_memory' and '24h'." }],
  ["order truncation beats instructions", { ...OUT, truncation: 'x', instructions: 7 }, { param: "truncation", code: "invalid_value", message: "Invalid value: 'x'. Supported values are: 'auto' and 'disabled'." }],
  ["order instructions beats store", { ...OUT, instructions: 7, store: 'x' }, { param: "instructions", code: "invalid_type", message: "Invalid type for 'instructions': expected a string, but got an integer instead." }],
  ["order store beats service_tier", { ...OUT, store: 'x', service_tier: 'bogus' }, { param: "store", code: "invalid_type", message: "Invalid type for 'store': expected a boolean, but got a string instead." }],
  ["order service_tier beats top_logprobs", { ...OUT, service_tier: 'bogus', top_logprobs: 'x' }, { param: "service_tier", code: "invalid_value", message: "Invalid value: 'bogus'. Supported values are: 'auto', 'default', 'fast', 'flex', and 'priority'." }],
  ["order top_logprobs beats context_management", { ...OUT, top_logprobs: 'x', context_management: 'x' }, { param: "top_logprobs", code: "invalid_type", message: "Invalid type for 'top_logprobs': expected an integer, but got a string instead." }],
  ["order moderation beats include", { ...OUT, moderation: 'x', include: ['bogus.thing'] }, { param: "moderation", code: "invalid_type", message: "Invalid type for 'moderation': expected an object, but got a string instead." }],
  // Spelling help, and its two measured limits: distance 2 suggests, 3 does
  // not, and a key already in the body is never suggested.
  ["unknown near store at 2", { ...OUT, sto: 1 }, { param: "sto", code: "unknown_parameter", message: "Unknown parameter: 'sto'. Did you mean 'store'?" }],
  ["unknown too far", { ...OUT, st: 1 }, { param: "st", code: "unknown_parameter", message: "Unknown parameter: 'st'." }],
  ["unknown near two keys", { ...OUT, stre: 1 }, { param: "stre", code: "unknown_parameter", message: "Unknown parameter: 'stre'. Did you mean 'store' or 'stream'?" }],
  ["unknown nearer one of two", { ...OUT, strem: 1 }, { param: "strem", code: "unknown_parameter", message: "Unknown parameter: 'strem'. Did you mean 'stream' or 'store'?" }],
  ["unknown near tools", { ...OUT, tool: 1 }, { param: "tool", code: "unknown_parameter", message: "Unknown parameter: 'tool'. Did you mean 'tools'?" }],
  ["unknown near user", { ...OUT, usr: 1 }, { param: "usr", code: "unknown_parameter", message: "Unknown parameter: 'usr'. Did you mean 'user'?" }],
  ["unknown near include", { ...OUT, inclde: 1 }, { param: "inclde", code: "unknown_parameter", message: "Unknown parameter: 'inclde'. Did you mean 'include'?" }],
  ["unknown near a key already sent", { ...OUT, inpu: 1 }, { param: "inpu", code: "unknown_parameter", message: "Unknown parameter: 'inpu'." }],
  ["unknown near model already sent", { ...OUT, modell: 1 }, { param: "modell", code: "unknown_parameter", message: "Unknown parameter: 'modell'." }],
  // reasoning.effort: the schema layer, the model layer, and two type branches.
  ["reasoning.effort minimal", { ...OUT, reasoning: { effort: 'minimal' } }, { param: "reasoning.effort", code: "unsupported_value", message: "Unsupported value: 'minimal' is not supported with the 'gpt-5.6-terra' model. Supported values are: 'none', 'low', 'medium', 'high', 'xhigh', and 'max'." }],
  ["reasoning.effort as an integer", { ...OUT, reasoning: { effort: 5 } }, { param: "reasoning.effort", code: "invalid_type", message: "Invalid type for 'reasoning.effort': expected one of 'minimal', 'low', 'medium', or 'high', but got an integer instead." }],
  ["reasoning.effort as an array", { ...OUT, reasoning: { effort: ['low'] } }, { param: "reasoning.effort", code: "invalid_type", message: "Invalid type for 'reasoning.effort': expected one of one of 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', or 'max' or integer, but got an array instead." }],
  // The floor, from both sides of it.
  ["max_output_tokens 15", { ...OUT, max_output_tokens: 15 }, { param: "max_output_tokens", code: "integer_below_min_value", message: "Invalid 'max_output_tokens': integer below minimum value. Expected a value >= 16, but got 15 instead." }],
  ["max_output_tokens 16 with a tripwire", { ...OUT, max_output_tokens: 16, top_p: 0.5 }, { param: "top_p", code: null, message: "Unsupported parameter: 'top_p' is not supported with this model." }],
  ["prompt_cache_retention outside the enum", { ...OUT, prompt_cache_retention: 'x' }, { param: "prompt_cache_retention", code: "invalid_value", message: "Invalid value: 'x'. Supported values are: 'in_memory' and '24h'." }],
  // The server-state phase: after every schema check, before the capability
  // pass, and internally ordered.
  ["state after schema (prompt)", { ...OUT, prompt: { id: 'pmpt_x' }, truncation: 'bogus' }, { param: "truncation", code: "invalid_value", message: "Invalid value: 'bogus'. Supported values are: 'auto' and 'disabled'." }],
  ["state after schema (previous)", { ...OUT, previous_response_id: 'resp_x', truncation: 'bogus' }, { param: "truncation", code: "invalid_value", message: "Invalid value: 'bogus'. Supported values are: 'auto' and 'disabled'." }],
  ["state before capability (prompt)", { ...OUT, prompt: { id: 'pmpt_x' }, temperature: 0.5 }, { status: 404, param: null, code: null, message: "Prompt with id 'pmpt_x' not found." }],
  ["state before capability (previous)", { ...OUT, previous_response_id: 'resp_x', temperature: 0.5 }, { param: "previous_response_id", code: "previous_response_not_found", message: "Previous response with id 'resp_x' not found." }],
  ["state before capability (conversation)", { ...OUT, conversation: 'conv_x', temperature: 0.5 }, { status: 404, param: null, code: null, message: "Conversation with id 'conv_x' not found." }],
  ["conversation beats prompt", { ...OUT, conversation: 'conv_x', prompt: { id: 'pmpt_x' } }, { status: 404, param: null, code: null, message: "Conversation with id 'conv_x' not found." }],
  ["conversation with previous_response_id", { ...OUT, conversation: 'conv_x', previous_response_id: 'resp_x' }, { param: null, code: "mutually_exclusive_parameters", message: "Mutually exclusive parameters: ''. Ensure you are only providing one of: 'pre..._id' or 'conversation'." }],
  ["include logprobs beats tools", { ...OUT, include: ['message.output_text.logprobs'], tools: 'x' }, { param: "tools", code: "invalid_type", message: "Invalid type for 'tools': expected an array of tools, but got a string instead." }],
  ["top_logprobs refusal vs a later field", { ...OUT, top_logprobs: 1, context_management: 'x' }, { param: "context_management", code: "invalid_type", message: "Invalid type for 'context_management': expected an array of objects, but got a string instead." }],
  ["top_logprobs refusal vs temperature", { ...OUT, top_logprobs: 1, temperature: 0.5 }, { param: "temperature", code: null, message: "Unsupported parameter: 'temperature' is not supported with this model." }],
  ["include logprobs vs temperature", { ...OUT, include: ['message.output_text.logprobs'], temperature: 0.5 }, { param: "temperature", code: null, message: "Unsupported parameter: 'temperature' is not supported with this model." }],
  ["include logprobs vs top_logprobs", { ...OUT, include: ['message.output_text.logprobs'], top_logprobs: 1 }, { param: "include", code: "unsupported_parameter", message: "logprobs are not supported with reasoning models." }],
];

for (const [name, fragment, expected] of REJECTIONS) {
  test(`/v1/responses rejects ${name} as the direct API does`, async () => {
    const { status, payload } = await responses(fragment);
    assert.equal(status, expected.status ?? 400, JSON.stringify(payload));
    assert.equal(payload.error.type, 'invalid_request_error');
    assert.equal(payload.error.message, expected.message);
    assert.equal(payload.error.param ?? null, expected.param);
    assert.equal(payload.error.code ?? null, expected.code);
  });
}

test('the rows cover every key this surface knows', () => {
  // A key that gains a validation rule and no row is the drift this catches.
  const sent = new Set();
  for (const [, fragment] of REJECTIONS) for (const key of Object.keys(fragment)) sent.add(key);
  const known = [
    'model', 'input', 'instructions', 'max_output_tokens', 'max_tool_calls', 'temperature', 'top_p',
    'top_logprobs', 'stream', 'stream_options', 'text', 'tools', 'tool_choice', 'parallel_tool_calls',
    'reasoning', 'include', 'store', 'background', 'previous_response_id', 'conversation',
    'truncation', 'metadata', 'user', 'safety_identifier', 'prompt_cache_key',
    'prompt_cache_retention', 'prompt_cache_options', 'service_tier', 'prompt', 'context_management',
    'moderation', 'presence_penalty', 'frequency_penalty',
  ];
  assert.deepEqual(known.filter((key) => !sent.has(key)), [], 'these known keys have no row');
});
