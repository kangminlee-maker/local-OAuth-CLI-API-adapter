import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startLocalApiProxy } from '../dist/proxy/http-server.js';
import { OPENAI_RESPONSES_KEYS, editDistanceCandidates } from '../dist/proxy/normalizers.js';

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
const ASSISTANT_ITEM = (phase = 'final_answer') => ({
  id: 'msg_probe', type: 'message', status: 'completed', role: 'assistant', phase,
  content: [{ type: 'output_text', annotations: [], logprobs: [], text: 'OK' }],
});

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
  // `input`, required. Absence outranks everything but `model`; present-but-empty
  // is a different sentence with no `param`, after the state phase and before
  // the capability pass.
  ["input absent", { ...OUT, input: DELETE }, { param: "input", code: "missing_required_parameter", message: "Missing required parameter: 'input'." }],
  ["input absent beats an unknown key", { ...OUT, input: DELETE, zzz_unknown: 1 }, { param: "input", code: "missing_required_parameter", message: "Missing required parameter: 'input'." }],
  ["input absent beats a bad field", { ...OUT, input: DELETE, truncation: 'bogus' }, { param: "input", code: "missing_required_parameter", message: "Missing required parameter: 'input'." }],
  ["input absent beats the state phase", { ...OUT, input: DELETE, previous_response_id: 'resp_x' }, { param: "input", code: "missing_required_parameter", message: "Missing required parameter: 'input'." }],
  ["input absent loses to a missing model", { ...OUT, input: DELETE, model: DELETE }, { param: "model", code: "missing_required_parameter", message: "Missing required parameter: 'model'." }],
  ["input empty array", { ...OUT, input: [] }, { param: null, code: "missing_required_parameter", message: "One of \"input\" or \"previous_response_id\" or 'prompt' or 'conversation' must be provided." }],
  ["input empty string", { ...OUT, input: '' }, { param: null, code: "missing_required_parameter", message: "One of \"input\" or \"previous_response_id\" or 'prompt' or 'conversation' must be provided." }],
  ["input empty loses to an unknown key", { ...OUT, input: [], zzz_unknown: 1 }, { param: "zzz_unknown", code: "unknown_parameter", message: "Unknown parameter: 'zzz_unknown'." }],
  ["input empty loses to a bad field", { ...OUT, input: [], truncation: 'bogus' }, { param: "truncation", code: "invalid_value", message: "Invalid value: 'bogus'. Supported values are: 'auto' and 'disabled'." }],
  ["input empty beats the capability pass", { ...OUT, input: [], temperature: 0.5 }, { param: null, code: "missing_required_parameter", message: "One of \"input\" or \"previous_response_id\" or 'prompt' or 'conversation' must be provided." }],
  ["input empty loses to the state phase", { ...OUT, input: [], previous_response_id: 'resp_x' }, { param: "previous_response_id", code: "previous_response_not_found", message: "Previous response with id 'resp_x' not found." }],
  ["input null", { ...OUT, input: null }, { param: "input", code: "invalid_type", message: "Invalid type for 'input': expected a string, but got an object instead." }],
  // input, and the item members inside it.
  ["input as an object", { ...OUT, input: { a: 1 } }, { param: "input", code: "invalid_type", message: "Invalid type for 'input': expected one of a string or array of input items, but got an object instead." }],
  ["input item unknown member", { ...OUT, input: [{ role: 'user', content: I, bogus: 1 }] }, { param: "input[0].bogus", code: "unknown_parameter", message: "Unknown parameter: 'input[0].bogus'." }],
  ["input item status", { ...OUT, input: [{ role: 'user', content: I, status: 'completed' }], temperature: 0.5 }, { param: "temperature", code: null, message: "Unsupported parameter: 'temperature' is not supported with this model." }],
  ["input item id", { ...OUT, input: [{ role: 'user', content: I, id: 'msg_x' }], temperature: 0.5 }, { param: "temperature", code: null, message: "Unsupported parameter: 'temperature' is not supported with this model." }],
  ["input item type", { ...OUT, input: [{ type: 'message', role: 'user', content: I }], temperature: 0.5 }, { param: "temperature", code: null, message: "Unsupported parameter: 'temperature' is not supported with this model." }],
  // `phase` is the assistant item's own member — the shape this proxy emits.
  ["input item phase on a user item", { ...OUT, input: [{ role: 'user', content: I, phase: 'final_answer' }] }, { param: "input[0].phase", code: "unknown_parameter", message: "Unknown parameter: 'input[0].phase'." }],
  ["input item phase unknown value", { ...OUT, input: [ASSISTANT_ITEM('bogus'), { role: 'user', content: I }] }, { param: "input[0].phase", code: "invalid_value", message: "Invalid value: 'bogus'. Supported values are: 'commentary' and 'final_answer'." }],
  ["input item assistant unknown member", { ...OUT, input: [{ ...ASSISTANT_ITEM(), zzz: 1 }, { role: 'user', content: I }] }, { param: "input[0].zzz", code: "unknown_parameter", message: "Unknown parameter: 'input[0].zzz'." }],
  ["input item assistant with input_text", { ...OUT, input: [{ role: 'assistant', content: [{ type: 'input_text', text: 'x' }] }, { role: 'user', content: I }] }, { param: "input[0].content[0]", code: "invalid_value", message: "Invalid value: 'input_text'. Supported values are: 'output_text' and 'refusal'." }],
  ["input item round trip", { ...OUT, input: [{ role: 'user', content: I }, ASSISTANT_ITEM(), { role: 'user', content: 'again' }], temperature: 0.5 }, { param: "temperature", code: null, message: "Unsupported parameter: 'temperature' is not supported with this model." }],
  // The item schema, at the `input` slot rather than after the whole walk.
  ["input item primitive", { ...OUT, input: [7] }, { param: "input[0]", code: "invalid_type", message: "Invalid type for 'input[0]': expected an input item, but got an integer instead." }],
  ["input item null", { ...OUT, input: [null] }, { param: "input[0]", code: "invalid_type", message: "Invalid type for 'input[0]': expected an input item, but got null instead." }],
  ["input item type not a string", { ...OUT, input: [{ type: 7, role: 'user', content: I }] }, { param: "input[0]", code: "invalid_value", message: "Invalid value: ''. Supported values are: 'additional_tools', 'agent_message', 'apply_patch_call', 'apply_patch_call_output', 'code_interpreter_call', 'compaction', 'compaction_trigger', 'computer_call', 'computer_call_output', 'custom_tool_call', 'custom_tool_call_output', 'file_search_call', 'function_call', 'function_call_output', 'image_generation_call', 'item_reference', 'local_shell_call', 'local_shell_call_output', 'mcp_approval_request', 'mcp_approval_response', 'mcp_call', 'mcp_list_tools', 'message', 'multi_agent_call', 'multi_agent_call_output', 'program', 'program_output', 'reasoning', 'shell_call', 'shell_call_output', 'tool_search_call', 'tool_search_output', and 'web_search_call'." }],
  ["input item type unknown", { ...OUT, input: [{ type: 'bogus_item' }] }, { param: "input[0]", code: "invalid_value", message: "Invalid value: 'bogus_item'. Supported values are: 'additional_tools', 'agent_message', 'apply_patch_call', 'apply_patch_call_output', 'code_interpreter_call', 'compaction', 'compaction_trigger', 'computer_call', 'computer_call_output', 'custom_tool_call', 'custom_tool_call_output', 'file_search_call', 'function_call', 'function_call_output', 'image_generation_call', 'item_reference', 'local_shell_call', 'local_shell_call_output', 'mcp_approval_request', 'mcp_approval_response', 'mcp_call', 'mcp_list_tools', 'message', 'multi_agent_call', 'multi_agent_call_output', 'program', 'program_output', 'reasoning', 'shell_call', 'shell_call_output', 'tool_search_call', 'tool_search_output', and 'web_search_call'." }],
  ["input item role unknown", { ...OUT, input: [{ role: 'bogus', content: I }] }, { param: "input[0]", code: "invalid_value", message: "Invalid value: 'bogus'. Supported values are: 'assistant', 'system', 'developer', and 'user'." }],
  ["input item empty object", { ...OUT, input: [{}] }, { param: "input[0]", code: "invalid_value", message: "Invalid value: ''. Supported values are: 'assistant', 'system', 'developer', and 'user'." }],
  ["input item without content", { ...OUT, input: [{ role: 'user' }] }, { param: "input[0].content", code: "missing_required_parameter", message: "Missing required parameter: 'input[0].content'." }],
  ["input item developer role", { ...OUT, input: [{ role: 'developer', content: I }, { role: 'user', content: I }], temperature: 0.5 }, { param: "temperature", code: null, message: "Unsupported parameter: 'temperature' is not supported with this model." }],
  ["input item beats a later field", { ...OUT, input: [{}], truncation: 'bogus' }, { param: "input[0]", code: "invalid_value", message: "Invalid value: ''. Supported values are: 'assistant', 'system', 'developer', and 'user'." }],
  ["input item beats the state phase", { ...OUT, input: [{}], previous_response_id: 'resp_x' }, { param: "input[0]", code: "invalid_value", message: "Invalid value: ''. Supported values are: 'assistant', 'system', 'developer', and 'user'." }],
  ["input item beats the capability pass", { ...OUT, input: [{}], temperature: 0.5 }, { param: "input[0]", code: "invalid_value", message: "Invalid value: ''. Supported values are: 'assistant', 'system', 'developer', and 'user'." }],
  ["content block unknown type", { ...OUT, input: [{ role: 'user', content: [{ type: 'bogus', text: 'x' }] }] }, { param: "input[0].content[0].type", code: "invalid_value", message: "Invalid value: 'bogus'. Supported values are: 'input_text', 'input_image', 'input_audio', 'output_text', 'refusal', 'input_file', 'computer_screenshot', 'summary_text', and 'encrypted_content'." }],
  ["content block wrong variant", { ...OUT, input: [{ role: 'user', content: [{ type: 'output_text', text: 'x' }] }] }, { param: "input[0].content[0]", code: "invalid_value", message: "Invalid value: 'output_text'. Supported values are: 'input_text', 'input_image', 'input_file', 'scoped_content', and 'input_audio'." }],
  ["content block without text", { ...OUT, input: [{ role: 'user', content: [{ type: 'input_text' }] }] }, { param: "input[0].content[0].text", code: "missing_required_parameter", message: "Missing required parameter: 'input[0].content[0].text'." }],
  ["content block refusal on assistant", { ...OUT, input: [{ role: 'assistant', content: [{ type: 'refusal', refusal: 'no' }] }, { role: 'user', content: I }], temperature: 0.5 }, { param: "temperature", code: null, message: "Unsupported parameter: 'temperature' is not supported with this model." }],
  // `text` and `tools`, which were array/object checks and nothing more.
  ["text unknown member", { ...OUT, text: { zzz: 1 } }, { param: "text.zzz", code: "unknown_parameter", message: "Unknown parameter: 'text.zzz'." }],
  ["text format unknown type", { ...OUT, text: { format: { type: 'bogus' } } }, { param: "text.format.type", code: "invalid_value", message: "Invalid value: 'bogus'. Supported values are: 'json_object', 'text', and 'json_schema'." }],
  ["text json_schema without a name", { ...OUT, text: { format: { type: 'json_schema' } } }, { param: "text.format.name", code: "missing_required_parameter", message: "Missing required parameter: 'text.format.name'." }],
  ["text verbosity unknown", { ...OUT, text: { verbosity: 'bogus' } }, { param: "text.verbosity", code: "invalid_value", message: "Invalid value: 'bogus'. Supported values are: 'low', 'medium', and 'high'." }],
  ["text beats a later field", { ...OUT, text: { verbosity: 'bogus' }, context_management: 'x' }, { param: "text.verbosity", code: "invalid_value", message: "Invalid value: 'bogus'. Supported values are: 'low', 'medium', and 'high'." }],
  ["text beats the capability pass", { ...OUT, text: { verbosity: 'bogus' }, temperature: 0.5 }, { param: "text.verbosity", code: "invalid_value", message: "Invalid value: 'bogus'. Supported values are: 'low', 'medium', and 'high'." }],
  ["tools member without a type", { ...OUT, tools: [{}] }, { param: "tools[0].type", code: "missing_required_parameter", message: "Missing required parameter: 'tools[0].type'." }],
  ["tools function without a name", { ...OUT, tools: [{ type: 'function' }] }, { param: "tools[0].name", code: "missing_required_parameter", message: "Missing required parameter: 'tools[0].name'." }],
  ["chat-shaped tool", { ...OUT, tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object', properties: {} } } }] }, { param: "tools[0].name", code: "missing_required_parameter", message: "Missing required parameter: 'tools[0].name'." }],
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

// The accepted half. Every row above is a rejection, so nothing pinned what a
// 200 carries — reverting each echo this surface gained left the suite green.
test('/v1/responses echoes the accepted keys it was sent', async () => {
  const started = await startLocalApiProxy({
    backend: {
      name: 'test', model: 'configured-model',
      async generate() {
        return { id: 'x', model: 'configured-model', text: 'pong', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, source: 'estimated' }, latencyMs: 1 };
      },
      async *stream() { throw new Error('unused'); },
      async close() {},
    },
    host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
  });
  try {
    const sent = {
      model: 'gpt-5.6-terra', input: 'ping', max_output_tokens: 16,
      background: true, max_tool_calls: 3, parallel_tool_calls: false, store: false,
      truncation: 'auto', instructions: 'be terse', user: 'probe', safety_identifier: 'probe',
      prompt_cache_key: 'probe-key', prompt_cache_options: { mode: 'implicit', ttl: '30m' },
      metadata: { a: 'b' }, service_tier: 'fast',
    };
    const res = await fetch(`${started.url}/v1/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sent),
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    // What the request said, read back — each of these was a constant before.
    assert.equal(body.background, true);
    assert.equal(body.max_tool_calls, 3);
    assert.equal(body.parallel_tool_calls, false);
    assert.equal(body.store, false);
    assert.equal(body.truncation, 'auto');
    assert.equal(body.instructions, 'be terse');
    assert.equal(body.user, 'probe');
    assert.equal(body.safety_identifier, 'probe');
    assert.equal(body.prompt_cache_key, 'probe-key');
    assert.deepEqual(body.prompt_cache_options, { mode: 'implicit', ttl: '30m' });
    assert.deepEqual(body.metadata, { a: 'b' });
    // The two that are NOT the request: the tier resolves, and sampling reports
    // the direct defaults rather than anything the caller could set.
    assert.equal(body.service_tier, 'priority');
    assert.equal(body.temperature, 1);
    assert.equal(body.top_p, 0.98);
    // And the two the direct API does not echo at all (measured 2026-08-31 —
    // §5.5.6's first draft said it did).
    assert.equal(body.include, undefined);
    assert.equal(body.context_management, undefined);
  } finally {
    await started.close();
  }
});

test('the rows cover every key this surface knows', () => {
  // A key that gains a validation rule and no row is the drift this catches.
  const sent = new Set();
  for (const [, fragment] of REJECTIONS) for (const key of Object.keys(fragment)) sent.add(key);
  // Imported, not copied: a hand-written duplicate of the key set cannot fail
  // when a key is ADDED to the source, which is the drift this claims to catch.
  const known = [...OPENAI_RESPONSES_KEYS];
  assert.ok(known.length >= 33, `the key set must actually load: ${known.length}`);
  assert.deepEqual(known.filter((key) => !sent.has(key)), [], 'these known keys have no row');
});

// The round trip the surface is built around: a client with nowhere to store
// state replays the previous turn's `output` as the next turn's `input`. The
// rejection row named "input item round trip" only proves such a body is
// ACCEPTED — it asserts the `temperature` envelope and nothing about what the
// model is then asked. What the backend receives is the promise.
test('replayed output reaches the model as the turn it was, not as its own JSON', async () => {
  let seen = null;
  const started = await startLocalApiProxy({
    backend: {
      name: 'test', model: 'configured-model',
      async generate(request) {
        seen = request;
        return { id: 'x', model: 'configured-model', text: 'pong', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, source: 'estimated' }, latencyMs: 1 };
      },
      async *stream() { throw new Error('unused'); },
      async close() {},
    },
    host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
  });
  const send = async (input) => {
    seen = null;
    const res = await fetch(`${started.url}/v1/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.6-terra', input, max_output_tokens: 16 }),
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    return seen.messages.map((message) => ({ role: message.role, content: message.content }));
  };
  try {
    const conversation = [{ role: 'user', content: 'ping' }, ASSISTANT_ITEM(), { role: 'user', content: 'again' }];
    const expected = [
      { role: 'user', content: 'ping' },
      { role: 'assistant', content: 'OK' },
      { role: 'user', content: 'again' },
    ];
    assert.deepEqual(await send(conversation), expected);
    // A reasoning item is in `output` on every reasoning model, and this proxy
    // emits one of its own. It replays as NOTHING: no backend takes a reasoning
    // summary, and it used to be stringified into a `user` turn — the model was
    // told `{"id":"rs_…","type":"reasoning","summary":[]}` in the user's voice.
    const withReasoning = [{ id: 'rs_abc', type: 'reasoning', summary: [] }, ...conversation];
    assert.deepEqual(await send(withReasoning), expected, 'a reasoning item must not become a turn');
    // A `reasoning` item's schema HAS a `content` member — `[{type:
    // 'reasoning_text'}]` — and the API's own description tells a client
    // managing context by hand to replay these items. Keying the drop on
    // "carries no content" instead of on the item's KIND read that member as a
    // message's and put the model's chain of thought in front of it in the
    // user's voice: the same corruption, with better grammar.
    for (const [label, content] of [
      ['the array form', [{ type: 'reasoning_text', text: 'CHAIN_OF_THOUGHT' }]],
      ['the string form', 'CHAIN_OF_THOUGHT'],
    ]) {
      const replayed = await send([{ id: 'rs_abc', type: 'reasoning', summary: [], content }, ...conversation]);
      assert.deepEqual(replayed, expected, `a reasoning item carrying ${label} must not become a turn`);
      assert.ok(
        !JSON.stringify(replayed).includes('CHAIN_OF_THOUGHT'),
        'and none of it may reach the model at all',
      );
    }
    // A hosted-tool item is NOT the same as a reasoning item, and treating it
    // as one erased results a client replayed on purpose: `program_output`
    // carries the output of work a previous turn did, which is exactly what
    // feeding `output` back as `input` is for. This runtime cannot re-run the
    // work, so the record goes in as tool history — present, and not in the
    // user's voice.
    const withProgramOutput = [
      { type: 'program_output', id: 'prog_out_1', call_id: 'call_prog_1', result: 'SECRET_RESULT', status: 'completed' },
      ...conversation,
    ];
    const replayedProgram = await send(withProgramOutput);
    assert.equal(replayedProgram.length, expected.length + 1, 'the record must survive as its own turn');
    assert.match(replayedProgram[0].content, /SECRET_RESULT/, 'and it must carry the result the client sent');
    assert.match(replayedProgram[0].content, /program_output/, 'named by the item type it came from');
    assert.deepEqual(replayedProgram.slice(1), expected, 'the conversation around it is untouched');
    // And the items that DO carry a turn still do.
    const withToolHistory = [
      { role: 'user', content: 'ping' },
      { type: 'function_call', call_id: 'call_1', name: 'f', arguments: '{"a":1}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'done' },
    ];
    const replayed = await send(withToolHistory);
    assert.equal(replayed.length, 3);
    assert.match(replayed[1].content, /name: f/);
    assert.match(replayed[2].content, /done/);
  } finally {
    await started.close();
  }
});

// The unknown-key suggester's length pre-filter is a COST promise: it changes
// no message, because `|len(a) - len(b)| <= distance` holds for unit-cost
// Levenshtein, so the keys it drops were never going to be within 2 anyway.
// Nothing about the output can catch its removal — measured, deleting the one
// `.filter(...)` line leaves the whole offline suite green while a 1M-char
// unknown key goes from ~2ms to ~1000ms of synchronous work, blocking the
// whole server for it.
//
// This asserted a WALL CLOCK until a reviewer named what that means: one
// delayed baseline sample makes a deleted filter pass, and a paused probe fails
// correct code. The filter's own output is the exact thing to assert instead.
test('a key no known key can be close to never reaches the distance routine', async () => {
  const longest = Math.max(...[...OPENAI_RESPONSES_KEYS].map((key) => key.length));
  for (const [label, unknown] of [
    ['a megabyte', 'z'.repeat(1_000_000)],
    ['just out of range', 'z'.repeat(longest + 3)],
    ['the empty key', ''],
  ]) {
    assert.deepEqual(
      editDistanceCandidates(unknown, OPENAI_RESPONSES_KEYS, {}),
      [],
      `${label}: no known key is within 2 edits of it, so none may be measured against it`,
    );
  }
  // The other side, or an empty return would pass this test for free: a key one
  // edit from a real one still reaches the routine.
  assert.ok(
    editDistanceCandidates('storee', OPENAI_RESPONSES_KEYS, {}).includes('store'),
    'a near miss must still be a candidate',
  );
  assert.ok(
    !editDistanceCandidates('storee', OPENAI_RESPONSES_KEYS, { store: 1 }).includes('store'),
    'a key the body already carries is never its own suggestion',
  );
  // And the promise end to end: a megabyte key still gets the ordinary answer.
  const { status, payload } = await responses({ ...OUT, ['z'.repeat(1_000_000)]: 1 });
  assert.equal(status, 400);
  assert.equal(payload.error.code, 'unknown_parameter');
});

// The test above asserts the pre-filter's OWN output. Nothing in it says the
// suggester calls it — and it does not have to: the filter changes no message,
// so the caller can drop it and every assertion in this file, that one
// included, still passes. Measured: bypassing it takes a 1,000,000-character
// unknown key on this route from 14 ms to 1112 ms of SYNCHRONOUS work, same
// status, same param, same sentence.
//
// So this asserts the caller instead, and counts rather than times: the
// distance routine allocates its first row with `Array.from({length: …})`
// exactly once per invocation, so an `Array.from` counter installed around the
// request IS an invocation counter for it. The count must equal the number of
// candidates the pre-filter yields for that body — not merely be small — which
// is the same statement as "the caller measures these keys and no others".
test('the suggester measures the pre-filter\'s candidates and no other key', async () => {
  const started = await startLocalApiProxy({ backend: backend(), host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000 });
  const realArrayFrom = Array.from;
  const countFor = async (unknown) => {
    const body = { model: 'gpt-5.6-terra', ...OUT, [unknown]: 1 };
    let calls = 0;
    // Installed only around the request: the server is already up, so nothing
    // else in this process is running while it is patched.
    Array.from = function patched(...args) { calls += 1; return realArrayFrom.apply(this, args); };
    let payload;
    try {
      const res = await fetch(`${started.url}/v1/responses`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      payload = await res.json();
    } finally {
      Array.from = realArrayFrom;
    }
    return { calls, expected: editDistanceCandidates(unknown, OPENAI_RESPONSES_KEYS, body).length, payload };
  };

  try {
    // A key one edit from a real one: the count is NONZERO, which is what makes
    // the counter an instrument rather than a constant zero.
    const near = await countFor('temperatur');
    assert.ok(near.expected > 0, 'the control must have candidates, or it proves nothing');
    assert.equal(near.calls, near.expected, 'every candidate is measured, and only candidates are');
    assert.equal(near.payload.error.message, "Unknown parameter: 'temperatur'. Did you mean 'temperature'?");

    // A second body whose candidate set is a DIFFERENT size, so a counter that
    // happened to match one number cannot match both.
    const other = await countFor('stor');
    assert.ok(other.expected > 0 && other.expected !== near.expected, 'the two controls must differ in size');
    assert.equal(other.calls, other.expected);

    // And the far side, which is the cost promise itself: a key no known key
    // can be within two edits of reaches the distance routine ZERO times. A
    // caller that skipped the pre-filter would measure every known key here —
    // the same answer, at 1,000,000 characters apiece.
    for (const [label, unknown] of [
      ['just out of range', 'z'.repeat(Math.max(...[...OPENAI_RESPONSES_KEYS].map((key) => key.length)) + 3)],
      ['a megabyte', 'z'.repeat(1_000_000)],
    ]) {
      const far = await countFor(unknown);
      assert.equal(far.expected, 0, `${label}: the pre-filter yields no candidate`);
      assert.equal(far.calls, 0, `${label}: so the distance routine must never run`);
      assert.equal(far.payload.error.code, 'unknown_parameter', `${label}: and the answer is unchanged`);
    }
  } finally {
    Array.from = realArrayFrom;
    await started.close();
  }
});
