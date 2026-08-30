import { ASSISTANT_TOOL_CALL_MARKER, TOOL_RESULT_MARKER } from './tool-history-markers.js';
import { fileURLToPath } from 'node:url';
import type {
  NormalizedAnthropicEffort,
  NormalizedImage,
  NormalizedImageDetail,
  NormalizedMessage,
  NormalizedRequest,
  NormalizedReasoningEffort,
  NormalizedThinking,
  NormalizedTool,
  NormalizedToolChoice,
  NormalizedVerbosity,
} from './types.js';
import { ProxyRequestError } from './types.js';

interface NormalizedContent {
  readonly text: string;
  readonly images: readonly NormalizedImage[];
  /** True when this text is a tool turn this normalizer flattened. */
  readonly toolHistory?: boolean;
}

// The top-level keys the direct Chat Completions API knows, measured
// 2026-08-30 on `gpt-5.6-terra` by sending each with a value of a type it
// cannot take (§5.5.5): a known key answers about its own type or value, an
// unknown one is `unknown_parameter`. `audio`, `modalities` and
// `web_search_options` are unknown there and unknown here; so are the
// Responses-shaped `reasoning` and `text`, which used to be accepted as
// alternate sources for `reasoning_effort`/`verbosity` — a body the direct API
// refuses must not succeed here.
const OPENAI_CHAT_KEYS: ReadonlySet<string> = new Set([
  'model', 'messages', 'frequency_penalty', 'function_call', 'functions', 'logit_bias', 'logprobs',
  'max_completion_tokens', 'max_tokens', 'metadata', 'moderation', 'n', 'parallel_tool_calls',
  'prediction', 'presence_penalty', 'prompt_cache_key', 'prompt_cache_options',
  'prompt_cache_retention', 'reasoning_effort', 'response_format', 'safety_identifier', 'seed',
  'service_tier', 'stop', 'store', 'stream', 'stream_options', 'temperature', 'tool_choice',
  'tools', 'top_logprobs', 'top_p', 'user', 'verbosity',
]);
const OPENAI_SERVICE_TIERS = ['auto', 'default', 'fast', 'flex', 'priority'] as const;
const OPENAI_CHAT_REASONING_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh'] as const;
const OPENAI_CHAT_VERBOSITIES = ['low', 'medium', 'high'] as const;
const OPENAI_CHAT_RESPONSE_FORMATS = ['json_object', 'json_schema', 'text'] as const;
const OPENAI_TOOL_CHOICE_MODES = ['none', 'auto', 'required'] as const;
const OPENAI_CHAT_ROLES = ['system', 'assistant', 'user', 'function', 'tool', 'developer'] as const;
const OPENAI_PROMPT_CACHE_OPTION_KEYS: ReadonlySet<string> = new Set(['ttl', 'mode']);
const OPENAI_METADATA_MAX_PROPERTIES = 16;
const OPENAI_METADATA_MAX_KEY_LENGTH = 64;
const OPENAI_METADATA_MAX_VALUE_LENGTH = 512;
// Measured, not assumed: `n: 64` answers "Expected a value <= 8".
const OPENAI_CHAT_MAX_CHOICES = 8;
const OPENAI_CHAT_MAX_TOP_LOGPROBS = 5;

export function normalizeOpenAiChatRequest(body: unknown): NormalizedRequest {
  const input = objectBody(body);
  // The order the direct API reports faults in, measured 2026-08-30 with
  // two-fault bodies (§5.5.5): the REQUIRED parameters' presence first (`model`
  // beats an unknown key, and so does a missing `messages`), then unknown keys,
  // then every other field in key order (`n` before `stop` before
  // `temperature`).
  const model = readRequiredOpenAiModel(input.model, 'openai-chat');
  requireOpenAiChatMessages(input.messages);
  rejectUnknownOpenAiKeys(input, OPENAI_CHAT_KEYS);
  const { messages, reasoningEffort } = validateOpenAiChatFields(input);
  return {
    shape: 'openai-chat',
    model,
    messages,
    maxTokens: readOptionalNumber(input.max_completion_tokens),
    reasoningEffort,
    verbosity: readOpenAiChatVerbosity(input.verbosity),
    stream: input.stream === true,
    streamOptions: readStreamOptions(input.stream_options),
    jsonMode: isOpenAiJsonMode(input.response_format),
    jsonSchema: readOpenAiJsonSchema(input.response_format),
    jsonSchemaName: readOpenAiJsonSchemaName(input.response_format),
    jsonSchemaStrict: readOpenAiJsonSchemaStrict(input.response_format),
    // The deprecated `functions`/`function_call` pair is VALIDATED as the
    // direct API validates it and then not applied — the same standing as
    // before this change, now with the direct envelopes. Carrying it into
    // `tools` would run the tools but answer in the modern shape, and a legacy
    // client reads `message.function_call`.
    tools: readOpenAiTools(input.tools),
    toolChoice: readOpenAiToolChoice(input.tool_choice),
    ...(typeof input.n === 'number' && input.n !== 1 ? { choices: input.n } : {}),
    raw: body,
  };
}

/**
 * Every Chat Completions field the direct API validates, in the key order it
 * reports them in, with its measured envelopes (§5.5.5, `gpt-5.6-terra`,
 * 2026-08-30). Null is omission for every optional field, as it is there.
 *
 * What is refused is as measured as what is accepted. `stop`, `max_tokens`,
 * `logit_bias` and `prediction` are refused by the direct API on this model
 * family whatever their value, so they are refused with its envelope instead
 * of being realized; `frequency_penalty`, `presence_penalty` and `logprobs`
 * are refused only while the model reasons and are accepted — and not applied,
 * as the contract says — when `reasoning_effort` is `none`.
 */
function validateOpenAiChatFields(
  input: Record<string, unknown>,
): { messages: NormalizedMessage[]; reasoningEffort: NormalizedReasoningEffort | undefined } {
  const present = (key: string): boolean => input[key] !== undefined && input[key] !== null;
  // A plain read, not the validated one: `reasoning_effort` reports its own
  // fault at its own position, and the three fields below are checked before
  // it. An absent effort means the model reasons.
  const reasons = input.reasoning_effort !== 'none';

  if (present('frequency_penalty')) {
    if (typeof input.frequency_penalty !== 'number') throw invalidType('frequency_penalty', 'a decimal', input.frequency_penalty);
    if (reasons) throw unsupportedParameter('frequency_penalty');
  }
  if (present('function_call')) readOpenAiLegacyFunctionCall(input.function_call);
  if (present('functions')) {
    if (!Array.isArray(input.functions)) throw invalidType('functions', 'an array of function definitions', input.functions);
    input.functions.forEach((fn, index) => {
      if (typeof asRecord(fn)?.name !== 'string') throw missingRequiredParameter(`functions[${index}].name`);
    });
  }
  if (present('logit_bias')) throw unsupportedParameter('logit_bias');
  if (present('logprobs')) {
    if (typeof input.logprobs !== 'boolean') throw invalidType('logprobs', 'a boolean', input.logprobs);
    if (input.logprobs && reasons) throw unsupportedParameter('logprobs');
  }
  if (present('max_completion_tokens')) {
    if (!Number.isInteger(input.max_completion_tokens)) throw invalidType('max_completion_tokens', 'an integer', input.max_completion_tokens);
    if ((input.max_completion_tokens as number) < 1) throw integerBelowMin('max_completion_tokens', input.max_completion_tokens as number, 1);
  }
  if (present('max_tokens')) {
    throw unsupportedParameter('max_tokens', "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.");
  }
  const messages = readOpenAiMessages(input.messages);
  if (present('metadata')) validateOpenAiMetadata(input.metadata);
  if (present('moderation')) {
    // Validated as the direct API validates it, then not applied: the local
    // runtimes moderate nothing, so the response carries no `moderation`
    // object (the contract's Chat row says so).
    const moderation = asRecord(input.moderation);
    if (!moderation) throw invalidType('moderation', 'an object', input.moderation);
    if (typeof moderation.model !== 'string') throw missingRequiredParameter('moderation.model');
  }
  if (present('n')) {
    if (!Number.isInteger(input.n)) throw invalidType('n', 'an integer', input.n);
    const n = input.n as number;
    if (n < 1) throw integerBelowMin('n', n, 1);
    if (n > OPENAI_CHAT_MAX_CHOICES) throw integerAboveMax('n', n, OPENAI_CHAT_MAX_CHOICES);
  }
  if (present('parallel_tool_calls') && typeof input.parallel_tool_calls !== 'boolean') {
    throw invalidType('parallel_tool_calls', 'a boolean', input.parallel_tool_calls);
  }
  if (present('prediction')) throw unsupportedParameter('prediction');
  if (present('presence_penalty')) {
    if (typeof input.presence_penalty !== 'number') throw invalidType('presence_penalty', 'a decimal', input.presence_penalty);
    if (reasons) throw unsupportedParameter('presence_penalty');
  }
  if (present('prompt_cache_key') && typeof input.prompt_cache_key !== 'string') {
    throw invalidType('prompt_cache_key', 'a string', input.prompt_cache_key);
  }
  if (present('prompt_cache_options')) {
    const options = asRecord(input.prompt_cache_options);
    if (!options) throw invalidType('prompt_cache_options', 'an object', input.prompt_cache_options);
    for (const key of Object.keys(options)) {
      if (!OPENAI_PROMPT_CACHE_OPTION_KEYS.has(key)) throw unknownParameter(`prompt_cache_options.${key}`);
    }
  }
  if (present('prompt_cache_retention')) {
    const retention = input.prompt_cache_retention;
    if (retention !== 'in_memory' && retention !== '24h') {
      throw invalidType('prompt_cache_retention', "one of 'in_memory' or '24h'", retention);
    }
    if (retention === 'in_memory') {
      // Not an enum fault: the value is valid and this model family refuses it.
      throw new ProxyRequestError('This model is compatible only with 24h extended prompt caching', 400, 'openai', 'invalid_request_error', 'prompt_cache_retention');
    }
  }
  const reasoningEffort = readOpenAiChatReasoningEffort(input.reasoning_effort);
  if (present('response_format')) validateOpenAiChatResponseFormat(input.response_format);
  if (present('safety_identifier') && typeof input.safety_identifier !== 'string') {
    throw invalidType('safety_identifier', 'a string', input.safety_identifier);
  }
  if (present('seed') && !Number.isInteger(input.seed)) throw invalidType('seed', 'an integer', input.seed);
  if (present('service_tier')) readOpenAiServiceTier(input.service_tier);
  if (present('stop')) throw unsupportedParameter('stop');
  if (present('store') && typeof input.store !== 'boolean') throw invalidType('store', 'a boolean', input.store);
  if (present('stream') && typeof input.stream !== 'boolean') throw invalidType('stream', 'a boolean', input.stream);
  if (present('stream_options') && !asRecord(input.stream_options)) {
    throw invalidType('stream_options', 'an object', input.stream_options);
  }
  rejectUnsupportedOpenAiSampling(input, 'openai-chat', 'temperature');
  if (present('tool_choice')) readOpenAiToolChoice(input.tool_choice);
  if (present('tools')) {
    if (!Array.isArray(input.tools)) throw invalidType('tools', 'an array of objects', input.tools);
    input.tools.forEach((tool, index) => {
      const fn = asRecord(asRecord(tool)?.function);
      if (!fn) throw missingRequiredParameter(`tools[${index}].function`);
      if (typeof fn.name !== 'string') throw missingRequiredParameter(`tools[${index}].function.name`);
    });
  }
  if (present('top_logprobs')) {
    if (!Number.isInteger(input.top_logprobs)) throw invalidType('top_logprobs', 'an integer', input.top_logprobs);
    const top = input.top_logprobs as number;
    if (top < 0) throw integerBelowMin('top_logprobs', top, 0);
    if (top > OPENAI_CHAT_MAX_TOP_LOGPROBS) {
      // The one bound the direct API reports with no code (measured).
      throw new ProxyRequestError(`Invalid value for 'top_logprobs': must be less than or equal to ${OPENAI_CHAT_MAX_TOP_LOGPROBS}.`, 400, 'openai', 'invalid_request_error', 'top_logprobs');
    }
    if (input.logprobs !== true) {
      throw new ProxyRequestError("The 'top_logprobs' parameter is only allowed when 'logprobs' is enabled.", 400, 'openai', 'invalid_request_error', 'top_logprobs');
    }
  }
  rejectUnsupportedOpenAiSampling(input, 'openai-chat', 'top_p');
  if (present('user') && typeof input.user !== 'string') throw invalidType('user', 'a string', input.user);
  if (present('verbosity')) readOpenAiChatVerbosity(input.verbosity);
  return { messages, reasoningEffort };
}

function validateOpenAiMetadata(value: unknown): void {
  const metadata = asRecord(value);
  if (!metadata) throw invalidType('metadata', 'a metadata object', value);
  const keys = Object.keys(metadata);
  if (keys.length > OPENAI_METADATA_MAX_PROPERTIES) {
    throw new ProxyRequestError(
      `Invalid 'metadata': too many properties. Expected an object with at most ${OPENAI_METADATA_MAX_PROPERTIES} properties, but got an object with ${keys.length} properties instead.`,
      400, 'openai', 'invalid_request_error', 'metadata', 'object_above_max_properties',
    );
  }
  for (const key of keys) {
    if (key.length > OPENAI_METADATA_MAX_KEY_LENGTH) {
      throw new ProxyRequestError(
        `Invalid property name in 'metadata': '${elideLongName(key)}' is too long. Expected a string with maximum length ${OPENAI_METADATA_MAX_KEY_LENGTH}, but got a string with length ${key.length} instead.`,
        400, 'openai', 'invalid_request_error', `metadata.${key}`, 'property_name_above_max_length',
      );
    }
    const entry = metadata[key];
    if (typeof entry !== 'string') throw invalidType(`metadata.${key}`, 'a string', entry);
    if (entry.length > OPENAI_METADATA_MAX_VALUE_LENGTH) {
      throw new ProxyRequestError(
        `Invalid 'metadata.${key}': string too long. Expected a string with maximum length ${OPENAI_METADATA_MAX_VALUE_LENGTH}, but got a string with length ${entry.length} instead.`,
        400, 'openai', 'invalid_request_error', `metadata.${key}`, 'string_above_max_length',
      );
    }
  }
}

// The direct API shortens an over-long property NAME in its message while the
// `param` carries it whole (measured on a 70-character key: `'kkk...kkk'`).
// Fitted to that one observation; the parity instrument re-checks it.
function elideLongName(name: string): string {
  return name.length > 6 ? `${name.slice(0, 3)}...${name.slice(-3)}` : name;
}

function validateOpenAiChatResponseFormat(value: unknown): void {
  const format = asRecord(value);
  if (!format) throw invalidType('response_format', 'an object', value);
  if (format.type === undefined || format.type === null) throw missingRequiredParameter('response_format.type');
  if (!OPENAI_CHAT_RESPONSE_FORMATS.some((candidate) => candidate === format.type)) {
    throw invalidValue('response_format.type', String(format.type), OPENAI_CHAT_RESPONSE_FORMATS);
  }
}

function invalidType(field: string, expected: string, value: unknown): ProxyRequestError {
  return new ProxyRequestError(
    `Invalid type for '${field}': expected ${expected}, but got ${jsonTypeName(value)} instead.`,
    400, 'openai', 'invalid_request_error', field, 'invalid_type',
  );
}

function invalidValue(field: string, value: string, supported: readonly string[]): ProxyRequestError {
  return new ProxyRequestError(
    `Invalid value: '${value}'. Supported values are: ${listOfQuoted(supported, 'and')}.`,
    400, 'openai', 'invalid_request_error', field, 'invalid_value',
  );
}

function unsupportedParameter(field: string, message?: string): ProxyRequestError {
  return new ProxyRequestError(
    message ?? `Unsupported parameter: '${field}' is not supported with this model.`,
    400, 'openai', 'invalid_request_error', field, 'unsupported_parameter',
  );
}

function unknownParameter(field: string): ProxyRequestError {
  return new ProxyRequestError(`Unknown parameter: '${field}'.`, 400, 'openai', 'invalid_request_error', field, 'unknown_parameter');
}

function missingRequiredParameter(field: string): ProxyRequestError {
  return new ProxyRequestError(`Missing required parameter: '${field}'.`, 400, 'openai', 'invalid_request_error', field, 'missing_required_parameter');
}

function integerBelowMin(field: string, value: number, min: number): ProxyRequestError {
  return new ProxyRequestError(
    `Invalid '${field}': integer below minimum value. Expected a value >= ${min}, but got ${value} instead.`,
    400, 'openai', 'invalid_request_error', field, 'integer_below_min_value',
  );
}

function integerAboveMax(field: string, value: number, max: number): ProxyRequestError {
  return new ProxyRequestError(
    `Invalid '${field}': integer above maximum value. Expected a value <= ${max}, but got ${value} instead.`,
    400, 'openai', 'invalid_request_error', field, 'integer_above_max_value',
  );
}

/** "'a', 'b', or 'c'" — the direct API's own list punctuation. */
function listOfQuoted(values: readonly string[], conjunction: 'or' | 'and'): string {
  const quoted = values.map((value) => `'${value}'`);
  if (quoted.length <= 1) return quoted.join('');
  return `${quoted.slice(0, -1).join(', ')}, ${conjunction} ${quoted[quoted.length - 1]}`;
}

/** The direct API's own type words for its "got X instead" messages. */
export function jsonTypeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'an integer' : 'a decimal number';
  if (typeof value === 'boolean') return 'a boolean';
  if (typeof value === 'object') return 'an object';
  return `a ${typeof value}`;
}

// Strict top-level schema, as the direct OpenAI surfaces have (P-5, §5.5.5):
// an unknown key is `unknown_parameter`, reported after the required
// parameters' presence and before every other field's validation.
function rejectUnknownOpenAiKeys(input: Record<string, unknown>, known: ReadonlySet<string>): void {
  for (const key of Object.keys(input)) {
    if (!known.has(key)) throw unknownParameter(key);
  }
}

function readRequiredOpenAiModel(value: unknown, shape: 'openai-chat' | 'openai-responses'): string {
  // Two surfaces, two sentences (measured): Chat answers with neither `param`
  // nor `code`, Responses names the parameter. An empty string is the same
  // fault as an absent one on Chat, also measured.
  const missing = (): never => {
    if (shape === 'openai-chat') {
      throw new ProxyRequestError('you must provide a model parameter', 400, 'openai', 'invalid_request_error', null, null);
    }
    throw missingRequiredParameter('model');
  };
  if (value === undefined || value === null) missing();
  if (typeof value !== 'string') throw invalidType('model', 'a string', value);
  if (!value.trim()) missing();
  return value as string;
}

function requireOpenAiChatMessages(value: unknown): void {
  if (value === undefined || value === null) throw missingRequiredParameter('messages');
}

function readOpenAiChatReasoningEffort(value: unknown): NormalizedReasoningEffort | undefined {
  if (value === undefined || value === null) return undefined;
  const effort = OPENAI_CHAT_REASONING_EFFORTS.find((candidate) => candidate === value);
  if (effort) return effort;
  // Any non-member — a string outside the set or another type entirely — gets
  // the same `unsupported_value` with the supported list. `minimal` and `max`
  // are outside it on this family, both measured.
  const shown = typeof value === 'string' ? `'${value}'` : jsonValueForMessage(value);
  throw new ProxyRequestError(
    `Unsupported value: 'reasoning_effort' does not support ${shown} with this model. Supported values are: ${listOfQuoted(OPENAI_CHAT_REASONING_EFFORTS, 'and')}.`,
    400, 'openai', 'invalid_request_error', 'reasoning_effort', 'unsupported_value',
  );
}

// The direct API prints a rejected non-string value Python-style in this one
// message — `{'__probe__': 'wrong type'}`, quotes and spacing included, which
// is what a client sees. Fitted to that measurement; only the shapes that can
// reach an enum field are rendered.
function jsonValueForMessage(value: unknown): string {
  if (value === null) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (typeof value === 'string') return `'${value}'`;
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return `[${value.map(jsonValueForMessage).join(', ')}]`;
  if (typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).map(([key, member]) => `'${key}': ${jsonValueForMessage(member)}`).join(', ')}}`;
  }
  return String(value);
}

function readOpenAiChatVerbosity(value: unknown): NormalizedVerbosity | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === 'low' || value === 'medium' || value === 'high') return value;
  if (typeof value !== 'string') throw invalidType('verbosity', `one of ${listOfQuoted(OPENAI_CHAT_VERBOSITIES, 'or')}`, value);
  throw invalidValue('verbosity', value, OPENAI_CHAT_VERBOSITIES);
}

function readOpenAiServiceTier(value: unknown): void {
  if (typeof value !== 'string') throw invalidType('service_tier', `one of ${listOfQuoted(OPENAI_SERVICE_TIERS, 'or')}`, value);
  if (!OPENAI_SERVICE_TIERS.some((tier) => tier === value)) throw invalidValue('service_tier', value, OPENAI_SERVICE_TIERS);
}

function readOpenAiLegacyFunctionCall(value: unknown): NormalizedToolChoice {
  if (value === undefined || value === null || value === 'auto') return { type: 'auto' };
  if (value === 'none') return { type: 'none' };
  const call = asRecord(value);
  if (!call || typeof call.name !== 'string') throw missingRequiredParameter('function_call.name');
  return { type: 'tool', name: call.name };
}

export function normalizeOpenAiResponsesRequest(body: unknown): NormalizedRequest {
  const input = objectBody(body);
  const messages: NormalizedMessage[] = [];
  if (typeof input.instructions === 'string' && input.instructions.trim()) {
    messages.push({ role: 'system', content: input.instructions, images: [] });
  }
  messages.push(...readResponsesInput(input.input));
  const text = asRecord(input.text);
  const format = asRecord(text?.format);
  const reasoning = asRecord(input.reasoning);
  rejectUnsupportedOpenAiSampling(input, 'openai-responses');
  return {
    shape: 'openai-responses',
    model: readRequiredModel(input.model, 'openai'),
    messages,
    maxTokens: readOptionalNumber(input.max_output_tokens),
    reasoningEffort: readOpenAiReasoningEffort(reasoning?.effort),
    verbosity: readOpenAiVerbosity(text?.verbosity),
    stream: input.stream === true,
    streamOptions: readStreamOptions(input.stream_options),
    jsonMode: format?.type === 'json_object' || format?.type === 'json_schema',
    jsonSchema: format?.schema,
    jsonSchemaName: format?.type === 'json_schema' ? readOptionalString(format.name) : undefined,
    jsonSchemaStrict: format?.type === 'json_schema' ? readOptionalBoolean(format.strict) : undefined,
    tools: readOpenAiTools(input.tools),
    toolChoice: readOpenAiToolChoice(input.tool_choice),
    ...(typeof input.n === 'number' && input.n !== 1 ? { choices: input.n } : {}),
    raw: body,
  };
}

/**
 * No backend behind the OpenAI surfaces applies `temperature` or `top_p`: the
 * Codex backend refuses both in the request body outright, and the CLIs have
 * no such knob. The proxy used to accept any value, forward none, and echo the
 * caller's `temperature` back from `/v1/responses` as if it had run — an
 * option accepted and not delivered. The direct API on the same model family
 * (measured on `gpt-5.6-terra`, 2026-08-29) rejects everything but the
 * default, with envelopes that differ by surface; those are mirrored here
 * verbatim. Null is omission, as on the direct API.
 */
function rejectUnsupportedOpenAiSampling(
  input: Record<string, unknown>,
  shape: 'openai-chat' | 'openai-responses',
  only?: 'temperature' | 'top_p',
): void {
  if (only !== 'top_p') rejectUnsupportedOpenAiTemperature(input, shape);
  if (only !== 'temperature') rejectUnsupportedOpenAiTopP(input, shape);
}

function rejectUnsupportedOpenAiTemperature(
  input: Record<string, unknown>,
  shape: 'openai-chat' | 'openai-responses',
): void {
  const temperature = input.temperature;
  if (temperature !== undefined && temperature !== null && typeof temperature !== 'number') {
    throw invalidType('temperature', 'a decimal', temperature);
  }
  if (temperature !== undefined && temperature !== null && temperature !== 1) {
    if (shape === 'openai-chat') {
      throw new ProxyRequestError(
        `Unsupported value: 'temperature' does not support ${JSON.stringify(temperature)} with this model. Only the default (1) value is supported.`,
        400,
        'openai',
        'invalid_request_error',
        'temperature',
        'unsupported_value',
      );
    }
    throw new ProxyRequestError(
      "Unsupported parameter: 'temperature' is not supported with this model.",
      400,
      'openai',
      'invalid_request_error',
      'temperature',
    );
  }
}

function rejectUnsupportedOpenAiTopP(
  input: Record<string, unknown>,
  shape: 'openai-chat' | 'openai-responses',
): void {
  const topP = input.top_p;
  if (topP !== undefined && topP !== null && typeof topP !== 'number') {
    throw invalidType('top_p', 'a decimal', topP);
  }
  // Chat accepts the default `top_p: 1`; Responses rejects the parameter even
  // at its default. Both measured, neither guessed.
  if (topP !== undefined && topP !== null && (shape === 'openai-responses' || topP !== 1)) {
    throw new ProxyRequestError(
      "Unsupported parameter: 'top_p' is not supported with this model.",
      400,
      'openai',
      'invalid_request_error',
      'top_p',
      shape === 'openai-chat' ? 'unsupported_parameter' : null,
    );
  }
}

function readOpenAiReasoningEffort(value: unknown): NormalizedReasoningEffort | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    value === 'none'
    || value === 'minimal'
    || value === 'low'
    || value === 'medium'
    || value === 'high'
    || value === 'xhigh'
  ) {
    return value;
  }
  throw new ProxyRequestError('reasoning effort must be one of none, minimal, low, medium, high, or xhigh.', 400);
}

function readOpenAiVerbosity(value: unknown): NormalizedVerbosity | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === 'low' || value === 'medium' || value === 'high') return value;
  throw new ProxyRequestError('verbosity must be one of low, medium, or high.', 400);
}

export function normalizeAnthropicMessagesRequest(body: unknown): NormalizedRequest {
  const input = objectBody(body);
  const messages: NormalizedMessage[] = [];
  const system = flattenAnthropicSystem(input.system);
  if (system) messages.push({ role: 'system', content: system, images: [] });
  messages.push(...readAnthropicMessages(input.messages));
  // The CONTAINER is not nullable on the direct API — its leaves are. A
  // present non-object here silently disabled every output control.
  if (input.output_config !== undefined && !asRecord(input.output_config)) {
    throw new ProxyRequestError('output_config must be an object.', 400, 'anthropic');
  }
  const outputConfig = asRecord(input.output_config);
  const maxTokens = readRequiredMaxTokens(input.max_tokens);
  rejectInvalidAnthropicSampling(input);
  const outputFormat = readAnthropicOutputFormat(outputConfig?.format);
  const tools = readAnthropicTools(input.tools);
  const toolChoice = readAnthropicToolChoice(input.tool_choice);
  // ...unless the turn has taken the tools off. There is one structured-output
  // channel, so a tool schema and a format schema would collide — but with
  // `tool_choice: "none"` no tool schema is built, and refusing anyway left a
  // client that asked for its own format on such a turn with nowhere to go.
  if (outputFormat !== undefined && tools.length > 0 && toolChoice.type !== 'none') {
    // The proxy has a single structured-output channel (claude --json-schema); a
    // forced/decision tool schema and output_config.format would collide, so the
    // user's format schema would be silently dropped. Reject instead.
    throw new ProxyRequestError(
      'output_config.format is not supported together with tools.',
      400,
      'anthropic',
    );
  }
  // Every known field is validated before an unknown key is reported — the
  // order the direct API reports in (measured with `max_tokens` and
  // `temperature` faults beside an unknown key).
  const model = readRequiredModel(input.model, 'anthropic');
  const effort = readAnthropicEffort(outputConfig?.effort);
  const taskBudgetTokens = readAnthropicTaskBudget(outputConfig?.task_budget);
  const thinking = readAnthropicThinking(input.thinking, maxTokens);
  rejectUnknownAnthropicKeys(input);
  return {
    shape: 'anthropic-messages',
    model,
    messages,
    maxTokens,
    effort,
    taskBudgetTokens,
    thinking,
    stream: input.stream === true,
    streamOptions: readStreamOptions(undefined),
    jsonMode: outputFormat !== undefined,
    jsonSchema: outputFormat,
    tools,
    toolChoice,
    raw: body,
  };
}

// The top-level keys the direct Messages API accepts, measured 2026-08-30 by
// sending each with a wrong type: a known key answers about its type, an
// unknown one "Extra inputs are not permitted". Keys the SDK types list but
// the API refused without a beta header (`user_profile_id`, `mcp_servers`,
// `context_management`, `betas`) are unknown here too. Several known keys are
// accepted by this proxy and not applied (`metadata`, `service_tier`,
// `stop_sequences`, `container`, `inference_geo`, `cache_control`); refusing
// them would put this surface behind the direct one.
const ANTHROPIC_MESSAGES_KEYS: ReadonlySet<string> = new Set([
  'model', 'messages', 'max_tokens', 'cache_control', 'container', 'inference_geo',
  'metadata', 'output_config', 'service_tier', 'stop_sequences', 'stream', 'system',
  'temperature', 'thinking', 'tool_choice', 'tools', 'top_k', 'top_p',
]);
const ANTHROPIC_MESSAGE_ITEM_KEYS: ReadonlySet<string> = new Set(['role', 'content']);

// Strict schema, as the direct API's is: an unknown key is refused by name,
// at the top level and on a message item (`messages.0.bogus`), a present null
// included. Reported after every field's own validation, which is the order
// the direct API reports in (a body with a bad `temperature` and an unknown
// key is answered about `temperature`).
function rejectUnknownAnthropicKeys(input: Record<string, unknown>): void {
  for (const key of Object.keys(input)) {
    if (!ANTHROPIC_MESSAGES_KEYS.has(key)) {
      throw new ProxyRequestError(`${key}: Extra inputs are not permitted`, 400, 'anthropic');
    }
  }
  if (Array.isArray(input.messages)) {
    input.messages.forEach((item, index) => {
      const record = asRecord(item);
      if (!record) return;
      for (const key of Object.keys(record)) {
        if (!ANTHROPIC_MESSAGE_ITEM_KEYS.has(key)) {
          throw new ProxyRequestError(`messages.${index}.${key}: Extra inputs are not permitted`, 400, 'anthropic');
        }
      }
    });
  }
}

/**
 * `temperature`, `top_p` and `top_k` are validated exactly as the direct
 * Messages API validates them (measured 2026-08-30) and then NOT applied: the
 * Claude CLI has no sampling control, and the response carries no such field
 * to echo them as applied. Refusing a valid value would put this surface
 * behind the direct one, which accepts it — the contract says the values are
 * accepted and inert. Note null is not omission here, unlike the OpenAI
 * surfaces: the direct API answers "Input should be a valid number".
 */
function rejectInvalidAnthropicSampling(input: Record<string, unknown>): void {
  for (const field of ['temperature', 'top_p'] as const) {
    const value = input[field];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new ProxyRequestError(`${field}: Input should be a valid number`, 400, 'anthropic');
    }
    if (value < 0 || value > 1) {
      throw new ProxyRequestError(`${field}: range: 0..1`, 400, 'anthropic');
    }
  }
  if (input.top_k !== undefined && !Number.isInteger(input.top_k)) {
    throw new ProxyRequestError('top_k: Input should be a valid integer', 400, 'anthropic');
  }
}

// Anthropic structured outputs: `output_config.format = {type:'json_schema', schema}`
// (accepts a nested `json_schema.schema` variant). A json_schema format with no
// resolvable schema is malformed input, not absence — reject it (fail-loud).
function readAnthropicOutputFormat(value: unknown): unknown {
  // `format?: JSONOutputFormat | null` on the direct API: null IS omission for
  // this LEAF (the output_config container is what rejects null). A non-null
  // non-object is malformed.
  if (value === undefined || value === null) return undefined;
  const format = asRecord(value);
  // `"json_schema"` the STRING is a present, malformed value — treating it as
  // omission executed the request without the structured output it asked for.
  if (!format) {
    throw new ProxyRequestError(
      'output_config.format must be an object.',
      400,
      'anthropic',
    );
  }
  if (format.type !== 'json_schema') {
    throw new ProxyRequestError(
      'output_config.format.type must be json_schema.',
      400,
      'anthropic',
    );
  }
  const nested = asRecord(format.json_schema);
  const schema = format.schema ?? nested?.schema;
  if (schema === undefined || schema === null) {
    throw new ProxyRequestError(
      'output_config.format of type json_schema requires a schema.',
      400,
      'anthropic',
    );
  }
  return schema;
}

function readAnthropicEffort(value: unknown): NormalizedAnthropicEffort | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    value === 'low'
    || value === 'medium'
    || value === 'high'
    || value === 'xhigh'
    || value === 'max'
  ) {
    return value;
  }
  throw new ProxyRequestError(
    'output_config.effort must be one of low, medium, high, xhigh, or max.',
    400,
    'anthropic',
  );
}

// Anthropic task budget is token-denominated with a 20,000-token minimum. A present
// but malformed/non-token/sub-minimum budget is rejected rather than mis-forwarded.
const ANTHROPIC_TASK_BUDGET_MIN_TOKENS = 20_000;

function readAnthropicTaskBudget(value: unknown): number | undefined {
  // A proxy/CLI extension field; its null rule follows its nullable siblings
  // (`effort`, `format`) so one output_config rule holds for every leaf.
  if (value === undefined || value === null) return undefined;
  const budget = asRecord(value);
  const total = budget?.total;
  const invalid = (message: string): never => {
    throw new ProxyRequestError(message, 400, 'anthropic');
  };
  if (!budget || budget.type !== 'tokens') {
    invalid('output_config.task_budget.type must be tokens.');
  }
  if (typeof total !== 'number' || !Number.isInteger(total)) {
    invalid('output_config.task_budget.total must be an integer number of tokens.');
  }
  if ((total as number) < ANTHROPIC_TASK_BUDGET_MIN_TOKENS) {
    invalid(`output_config.task_budget.total must be at least ${ANTHROPIC_TASK_BUDGET_MIN_TOKENS}.`);
  }
  return total as number;
}

function readAnthropicThinking(value: unknown, maxTokens: number): NormalizedThinking | undefined {
  if (value === undefined) return undefined;
  const thinking = asRecord(value);
  // The container is `thinking?: ThinkingConfigParam` on the direct API — the
  // union has no null member, so `thinking: null` is malformed input, not
  // omission. (Its LEAF `display` is declared nullable; the container is not.)
  if (!thinking) {
    throw new ProxyRequestError('thinking must be an object.', 400, 'anthropic');
  }
  const type = thinking.type;
  if (type !== 'adaptive' && type !== 'enabled' && type !== 'disabled') {
    throw new ProxyRequestError(
      'thinking.type must be one of adaptive, enabled, or disabled.',
      400,
      'anthropic',
    );
  }
  // `display?: 'summarized' | 'omitted' | null` — null IS omission here, per
  // the direct type. A defined non-null value outside the enum is invalid.
  const display = thinking.display === null ? undefined : thinking.display;
  if (display !== undefined && display !== 'summarized' && display !== 'omitted') {
    throw new ProxyRequestError(
      'thinking.display must be summarized or omitted.',
      400,
      'anthropic',
    );
  }
  // The `enabled` variant requires budget_tokens: ≥ 1024 and less than
  // max_tokens, per the direct schema. The number is validated for parity and
  // then deliberately NOT carried on the normalized request: no backend
  // consumes it. The local runtime governs its own thinking budget — the
  // pinned CLI registers numeric budget controls (`--max-thinking-tokens`,
  // the `MAX_THINKING_TOKENS` variable) but both are inert at runtime, probed
  // with values the direct API would reject (100 and 10^7) executing while
  // thinking engages. Carrying the number would let a mock assert a delivery
  // no real backend performs; the contract's `thinking` row documents the
  // divergence instead.
  if (type === 'enabled') {
    const budget = thinking.budget_tokens;
    if (typeof budget !== 'number' || !Number.isInteger(budget)) {
      throw new ProxyRequestError(
        'thinking.budget_tokens is required for enabled thinking.',
        400,
        'anthropic',
      );
    }
    if (budget < 1024) {
      throw new ProxyRequestError('thinking.budget_tokens must be at least 1024.', 400, 'anthropic');
    }
    if (budget >= maxTokens) {
      throw new ProxyRequestError(
        'thinking.budget_tokens must be less than max_tokens.',
        400,
        'anthropic',
      );
    }
  }
  return {
    type,
    display: type !== 'disabled' && (display === 'summarized' || display === 'omitted')
      ? display
      : undefined,
  };
}

function objectBody(body: unknown): Record<string, unknown> {
  const input = asRecord(body);
  if (!input) throw new ProxyRequestError('Request body must be a JSON object.', 400);
  return input;
}

function readOpenAiMessages(value: unknown): NormalizedMessage[] {
  if (!Array.isArray(value)) throw invalidType('messages', 'an array of objects', value);
  // `minItems: 1` on the direct API, with its own code (measured 2026-08-30).
  if (value.length === 0) {
    throw new ProxyRequestError(
      "Invalid 'messages': empty array. Expected an array with minimum length 1, but got an empty array instead.",
      400, 'openai', 'invalid_request_error', 'messages', 'empty_array',
    );
  }
  return value.map((item, index) => {
    const msg = asRecord(item);
    if (!msg) throw invalidType(`messages[${index}]`, 'an object', item);
    const role = readOpenAiChatRole(msg.role, index);
    requireOpenAiChatContent(msg, index);
    const content = flattenOpenAiMessage(msg, role);
    return {
      role,
      content: content.text,
      images: content.images,
      ...(content.toolHistory ? { toolHistory: true } : {}),
    };
  });
}

/**
 * The direct API's role set, enforced as it enforces it: `role` is the
 * discriminator of every message schema, so a missing or unknown role is a 400
 * there — never a silent rewrite. The proxy used to normalize unknowns to
 * `user`, which turned a typo'd `assistantt` into a user turn: no error
 * anywhere, just a conversation whose meaning quietly changed.
 *
 * `function` is deprecated on the direct API but still in its schema; it
 * carries a tool result, which is what `tool` means here.
 */
function readOpenAiChatRole(value: unknown, index: number): NormalizedMessage['role'] {
  if (
    value === 'system'
    || value === 'developer'
    || value === 'user'
    || value === 'assistant'
    || value === 'tool'
  ) {
    return value;
  }
  if (value === 'function') return 'tool';
  if (value === undefined || value === null) throw missingRequiredParameter(`messages[${index}].role`);
  // The direct API's own list, in its own order (measured 2026-08-30).
  if (typeof value !== 'string') throw invalidType(`messages[${index}].role`, `one of ${listOfQuoted(OPENAI_CHAT_ROLES, 'or')}`, value);
  throw invalidValue(`messages[${index}].role`, value, OPENAI_CHAT_ROLES);
}

/**
 * `content` as the direct API accepts it: a string or an array of parts, on
 * any role — and ABSENT or `null` on any role too, measured 2026-08-30
 * (`{"role":"user"}` and `{"role":"user","content":null}` both pass its
 * validation). The proxy used to require it except on an assistant turn
 * carrying `tool_calls`, so a body the direct API runs was a 400 here. A
 * defined value of another type keeps the direct envelope.
 */
function requireOpenAiChatContent(msg: Record<string, unknown>, index: number): void {
  const content = msg.content;
  if (content === undefined || content === null) return;
  if (typeof content === 'string' || Array.isArray(content)) return;
  throw invalidType(`messages[${index}].content`, 'one of a string or array of objects', content);
}

function readResponsesInput(value: unknown): NormalizedMessage[] {
  if (typeof value === 'string') return [{ role: 'user', content: value, images: [] }];
  // Omission is one thing; a defined value of the wrong shape is another. The
  // direct API takes a string or an array — a number or `null` used to be
  // silently replaced with an empty user message, which committed a 200 for a
  // request the direct API rejects.
  if (value === undefined) return [{ role: 'user', content: '', images: [] }];
  if (!Array.isArray(value)) {
    throw new ProxyRequestError(
      'input must be a string or an array of input items.',
      400,
      'openai',
      'invalid_request_error',
      'input',
    );
  }
  return value.map((item, index) => {
    const msg = asRecord(item);
    if (!msg) {
      throw new ProxyRequestError(`input[${index}] must be an object.`, 400);
    }
    const content = flattenResponsesMessage(msg);
    return {
      role: readResponsesRole(msg, index),
      content: content.text,
      images: content.images,
      ...(content.toolHistory ? { toolHistory: true } : {}),
    };
  });
}

/**
 * Responses input items are polymorphic: typed items (`function_call`,
 * `function_call_output`, `reasoning`, ...) have no `role` and are valid
 * without one. Only a message item — no `type`, or `type: "message"` — carries
 * a role, and there the direct API requires it. So absence of `role` is only an
 * error where the item claims to be a message.
 */
function readResponsesRole(msg: Record<string, unknown>, index: number): NormalizedMessage['role'] {
  // `type` is the item discriminator and the direct API only accepts strings
  // there — `type: null` is not a typed item, it is malformed input, and
  // letting it take the typed-item exemption skipped role validation entirely.
  // Unknown STRING types are deliberately not rejected: the direct item union
  // grows with the API, and pinning it here would 400 tomorrow's valid items.
  if (msg.type !== undefined && typeof msg.type !== 'string') {
    throw new ProxyRequestError(
      `input[${index}].type must be a string.`,
      400,
      'openai',
      'invalid_request_error',
      `input[${index}].type`,
    );
  }
  const isMessage = msg.type === undefined || msg.type === 'message';
  if (!isMessage) return msg.role === 'assistant' ? 'assistant' : 'user';
  const value = msg.role;
  if (
    value === 'system'
    || value === 'developer'
    || value === 'user'
    || value === 'assistant'
  ) {
    return value;
  }
  const missing = value === undefined || value === null;
  throw new ProxyRequestError(
    missing
      ? `input[${index}].role is required.`
      : `input[${index}].role must be one of system, developer, user or assistant.`,
    400,
    'openai',
    'invalid_request_error',
    `input[${index}].role`,
    missing ? 'missing_required_parameter' : null,
  );
}

function readAnthropicMessages(value: unknown): NormalizedMessage[] {
  if (!Array.isArray(value)) {
    throw new ProxyRequestError('messages must be an array.', 400, 'anthropic');
  }
  if (value.length === 0) {
    throw new ProxyRequestError('messages must contain at least one message.', 400, 'anthropic');
  }
  return value.map((item, index) => {
    const msg = asRecord(item);
    if (!msg) throw new ProxyRequestError('Each message must be an object.', 400, 'anthropic');
    const role = msg.role;
    if (role !== 'user' && role !== 'assistant') {
      // The direct API's whole role set for messages[]; `system` in particular
      // is a top-level field there, not a role, and rewriting it to `user`
      // hid that mistake instead of reporting it.
      throw new ProxyRequestError(
        role === undefined || role === null
          ? `messages.${index}.role is required.`
          : `messages.${index}.role must be user or assistant.`,
        400,
        'anthropic',
      );
    }
    const content = msg.content;
    if (typeof content !== 'string' && !Array.isArray(content)) {
      throw new ProxyRequestError(
        content === undefined || content === null
          ? `messages.${index}.content is required.`
          : `messages.${index}.content must be a string or an array of content blocks.`,
        400,
        'anthropic',
      );
    }
    const flattened = flattenAnthropicMessage(msg);
    return {
      role,
      content: flattened.text,
      images: flattened.images,
      ...(flattened.toolHistory ? { toolHistory: true } : {}),
    };
  });
}

function flattenOpenAiMessage(msg: Record<string, unknown>, role: NormalizedMessage['role']): NormalizedContent {
  const content = flattenOpenAiContent(msg.content);
  const toolCalls = Array.isArray(msg.tool_calls)
    ? msg.tool_calls.map((toolCall) => {
        const call = asRecord(toolCall);
        const fn = asRecord(call?.function);
        return [
          ASSISTANT_TOOL_CALL_MARKER,
          `id: ${readString(call?.id, 'tool_call')}`,
          `name: ${readString(fn?.name, 'tool')}`,
          `arguments: ${typeof fn?.arguments === 'string' ? fn.arguments : JSON.stringify(fn?.arguments ?? {})}`,
        ].join('\n');
      }).join('\n')
    : '';
  if (role === 'tool') {
    const toolCallId = typeof msg.tool_call_id === 'string' ? msg.tool_call_id : 'tool_call';
    return {
      text: [`[tool result]`, `tool_call_id: ${toolCallId}`, content.text].join('\n'),
      images: content.images,
      toolHistory: true,
    };
  }
  return {
    text: [content.text, toolCalls].filter(Boolean).join('\n\n'),
    images: content.images,
    ...(toolCalls ? { toolHistory: true } : {}),
  };
}

function flattenResponsesMessage(msg: Record<string, unknown>): NormalizedContent {
  if (msg.type === 'function_call_output') {
    const output = flattenOpenAiContent(msg.output);
    return {
      text: [
        TOOL_RESULT_MARKER,
        `tool_call_id: ${readString(msg.call_id, 'tool_call')}`,
        output.text || (typeof msg.output === 'string' ? msg.output : JSON.stringify(msg.output ?? '')),
      ].join('\n'),
      images: output.images,
      toolHistory: true,
    };
  }
  if (msg.type === 'function_call') {
    return {
      text: [
        ASSISTANT_TOOL_CALL_MARKER,
        `id: ${readString(msg.call_id, 'tool_call')}`,
        `name: ${readString(msg.name, 'tool')}`,
        `arguments: ${typeof msg.arguments === 'string' ? msg.arguments : JSON.stringify(msg.arguments ?? {})}`,
      ].join('\n'),
      images: [],
      toolHistory: true,
    };
  }
  return flattenOpenAiContent(msg.content ?? msg);
}

function flattenAnthropicMessage(msg: Record<string, unknown>): NormalizedContent {
  const value = msg.content;
  if (!Array.isArray(value)) return flattenAnthropicContent(value);
  const images: NormalizedImage[] = [];
  const text = value.map((part) => {
    const block = asRecord(part);
    if (!block) return String(part ?? '');
    if (block.type === 'text' && typeof block.text === 'string') return block.text;
    if (block.type === 'image') {
      const image = readAnthropicImage(block);
      if (image) images.push(image);
      return '';
    }
    if (block.type === 'tool_use') {
      return [
        ASSISTANT_TOOL_CALL_MARKER,
        `id: ${readString(block.id, 'tool_call')}`,
        `name: ${readString(block.name, 'tool')}`,
        `arguments: ${JSON.stringify(block.input ?? {})}`,
      ].join('\n');
    }
    if (block.type === 'tool_result') {
      const resultContent = flattenAnthropicContent(block.content);
      images.push(...resultContent.images);
      return [
        TOOL_RESULT_MARKER,
        `tool_call_id: ${readString(block.tool_use_id, 'tool_call')}`,
        resultContent.text,
      ].join('\n');
    }
    return '';
  }).filter(Boolean).join('\n\n');
  // Same rule as the OpenAI shapes: the flag is set where THIS function wrote a
  // marker, so a caller who types the same characters is never mistaken for a
  // tool turn. Checking the blocks rather than the rendered text keeps the two
  // from drifting apart.
  const wroteToolHistory = value.some((block) => {
    const record = asRecord(block);
    return record?.type === 'tool_use' || record?.type === 'tool_result';
  });
  return { text, images, ...(wroteToolHistory ? { toolHistory: true } : {}) };
}

function flattenOpenAiContent(value: unknown): NormalizedContent {
  if (typeof value === 'string') return { text: value, images: [] };
  if (!Array.isArray(value)) {
    const block = asRecord(value);
    if (block) {
      const image = readOpenAiImage(block);
      if (image) return { text: '', images: [image] };
      if (typeof block.text === 'string') return { text: block.text, images: [] };
      if (typeof block.input_text === 'string') return { text: block.input_text, images: [] };
      if (typeof block.content === 'string') return { text: block.content, images: [] };
    }
    return { text: value == null ? '' : JSON.stringify(value), images: [] };
  }
  const images: NormalizedImage[] = [];
  const text = value.map((part) => {
    const block = asRecord(part);
    if (!block) return String(part ?? '');
    if (typeof block.text === 'string') return block.text;
    if (typeof block.input_text === 'string') return block.input_text;
    if (typeof block.content === 'string') return block.content;
    const image = readOpenAiImage(block);
    if (image) images.push(image);
    return '';
  }).filter(Boolean).join('\n');
  return { text, images };
}

function flattenAnthropicSystem(value: unknown): string {
  if (typeof value === 'string') return value;
  return flattenAnthropicContent(value).text;
}

function flattenAnthropicContent(value: unknown): NormalizedContent {
  if (typeof value === 'string') return { text: value, images: [] };
  if (!Array.isArray(value)) {
    return { text: value == null ? '' : JSON.stringify(value), images: [] };
  }
  const images: NormalizedImage[] = [];
  const text = value.map((part) => {
    const block = asRecord(part);
    if (!block) return String(part ?? '');
    if (block.type === 'text' && typeof block.text === 'string') return block.text;
    if (block.type === 'image') {
      const image = readAnthropicImage(block);
      if (image) images.push(image);
    }
    return '';
  }).filter(Boolean).join('\n');
  return { text, images };
}

function readOpenAiImage(block: Record<string, unknown>): NormalizedImage | null {
  const detail = readImageDetail(block.detail);
  if (block.type === 'image_url') {
    const imageUrl = asRecord(block.image_url);
    const url = typeof imageUrl?.url === 'string'
      ? imageUrl.url
      : typeof block.image_url === 'string'
      ? block.image_url
      : '';
    return imageFromUrlLike(url, readImageDetail(imageUrl?.detail) ?? detail, block);
  }
  if (block.type === 'input_image') {
    if (typeof block.file_id === 'string' && block.file_id.trim()) {
      return {
        source: { type: 'file_id', fileId: block.file_id },
        detail,
        raw: block,
      };
    }
    const url = typeof block.image_url === 'string'
      ? block.image_url
      : typeof asRecord(block.image_url)?.url === 'string'
      ? String(asRecord(block.image_url)?.url)
      : '';
    return imageFromUrlLike(url, detail, block);
  }
  return null;
}

function readAnthropicImage(block: Record<string, unknown>): NormalizedImage | null {
  const source = asRecord(block.source);
  if (!source) return null;
  if (source.type === 'base64') {
    const data = typeof source.data === 'string' ? source.data : '';
    const mediaType = typeof source.media_type === 'string' && source.media_type.trim()
      ? source.media_type
      : 'image/png';
    if (!data.trim()) return null;
    return {
      source: {
        type: 'base64',
        mediaType,
        data: data.replace(/\s/g, ''),
      },
      raw: block,
    };
  }
  if (source.type === 'url') {
    return imageFromUrlLike(typeof source.url === 'string' ? source.url : '', undefined, block);
  }
  if (source.type === 'file' && typeof source.file_id === 'string' && source.file_id.trim()) {
    return {
      source: { type: 'file_id', fileId: source.file_id },
      raw: block,
    };
  }
  return null;
}

function imageFromUrlLike(
  value: string,
  detail: NormalizedImageDetail | undefined,
  raw: unknown,
): NormalizedImage | null {
  const url = value.trim();
  if (!url) return null;
  const dataUrl = parseImageDataUrl(url);
  if (dataUrl) {
    return {
      source: {
        type: 'base64',
        mediaType: dataUrl.mediaType,
        data: dataUrl.data,
      },
      detail,
      raw,
    };
  }
  const path = filePathFromUrl(url);
  if (path) {
    return {
      source: {
        type: 'path',
        path,
        mediaType: mediaTypeFromPath(path),
      },
      detail,
      raw,
    };
  }
  return {
    source: { type: 'url', url },
    detail,
    raw,
  };
}

function parseImageDataUrl(value: string): { mediaType: string; data: string } | null {
  const match = value.match(/^data:([^;,]+);base64,(.*)$/s);
  if (!match) return null;
  const mediaType = match[1]?.trim() || 'image/png';
  const data = match[2]?.replace(/\s/g, '') ?? '';
  if (!mediaType.startsWith('image/') || !data) return null;
  return { mediaType, data };
}

function filePathFromUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'file:' ? fileURLToPath(url) : null;
  } catch {
    return null;
  }
}

function mediaTypeFromPath(path: string): string | undefined {
  const lower = path.toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  return undefined;
}

function readImageDetail(value: unknown): NormalizedImageDetail | undefined {
  if (value === 'low' || value === 'high' || value === 'auto' || value === 'original') {
    return value;
  }
  return undefined;
}

function readOpenAiTools(value: unknown): NormalizedTool[] {
  if (!Array.isArray(value)) return [];
  return value.map((tool) => {
    const item = asRecord(tool);
    const fn = asRecord(item?.function);
    const directName = typeof item?.name === 'string' ? item.name : undefined;
    const directDescription = typeof item?.description === 'string'
      ? item.description
      : undefined;
    return {
      name: readString(fn?.name ?? directName, 'tool'),
      description: typeof fn?.description === 'string'
        ? fn.description
        : directDescription,
      inputSchema: fn?.parameters ?? item?.parameters,
      raw: tool,
    };
  });
}

function readAnthropicTools(value: unknown): NormalizedTool[] {
  if (!Array.isArray(value)) return [];
  return value.map((tool) => {
    const item = asRecord(tool);
    return {
      name: readString(item?.name, 'tool'),
      description: typeof item?.description === 'string' ? item.description : undefined,
      inputSchema: item?.input_schema,
      raw: tool,
    };
  });
}

// The forms the direct API takes, with its measured envelopes for the rest
// (2026-08-30): a string outside the three modes is `invalid_value` with the
// list, a non-string non-object is `invalid_type`, and an object is required
// to carry `function` and then `function.name` — whatever its `type` says.
// The proxy used to read everything else as `auto`.
function readOpenAiToolChoice(value: unknown): NormalizedToolChoice {
  if (value === undefined || value === null || value === 'auto') return { type: 'auto' };
  if (value === 'none') return { type: 'none' };
  if (value === 'required') return { type: 'required' };
  if (typeof value === 'string') throw invalidValue('tool_choice', value, OPENAI_TOOL_CHOICE_MODES);
  const choice = asRecord(value);
  if (!choice) {
    throw invalidType('tool_choice', `one of one of ${listOfQuoted(OPENAI_TOOL_CHOICE_MODES, 'or')} or object`, value);
  }
  const fn = asRecord(choice.function);
  if (!fn) throw missingRequiredParameter('tool_choice.function');
  if (typeof fn.name !== 'string') throw missingRequiredParameter('tool_choice.function.name');
  return { type: 'tool', name: fn.name };
}

function readStreamOptions(value: unknown) {
  const options = asRecord(value);
  return {
    includeUsage: options?.include_usage === true,
    includeObfuscation: options?.include_obfuscation !== false,
  };
}

function readAnthropicToolChoice(value: unknown): NormalizedToolChoice {
  const choice = asRecord(value);
  if (!choice) return { type: 'auto' };
  if (choice.type === 'none') return { type: 'none' };
  if (choice.type === 'any') return { type: 'required' };
  if (choice.type === 'tool' && typeof choice.name === 'string') {
    return { type: 'tool', name: choice.name };
  }
  return { type: 'auto' };
}

function isOpenAiJsonMode(value: unknown): boolean {
  const format = asRecord(value);
  return format?.type === 'json_object' || format?.type === 'json_schema';
}

function readOpenAiJsonSchema(value: unknown): unknown {
  const format = asRecord(value);
  if (format?.type !== 'json_schema') return undefined;
  const jsonSchema = asRecord(format.json_schema);
  return jsonSchema?.schema;
}

// B1 fidelity: preserve the client-supplied json_schema name/strict (Chat shape
// nests them under response_format.json_schema) so the codex runtime forwards them
// verbatim instead of a fixed name + strict:true.
function readOpenAiJsonSchemaName(value: unknown): string | undefined {
  const format = asRecord(value);
  if (format?.type !== 'json_schema') return undefined;
  return readOptionalString(asRecord(format.json_schema)?.name);
}

function readOpenAiJsonSchemaStrict(value: unknown): boolean | undefined {
  const format = asRecord(value);
  if (format?.type !== 'json_schema') return undefined;
  return readOptionalBoolean(asRecord(format.json_schema)?.strict);
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function readOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * `model` is required on every provider surface, so an absent or empty value is
 * a client error rather than something to substitute a default for. Matching the
 * providers here keeps the proxy's input contract identical to theirs: a request
 * that direct APIs reject must not quietly succeed against the proxy.
 */
/**
 * `max_tokens` on `/v1/messages`, which the direct Anthropic API requires — the
 * proxy accepts exactly what it accepts. `0` is a documented value there (it
 * pre-warms the prompt cache without generating), so the floor is 0, not 1.
 */
function readRequiredMaxTokens(value: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  const message = value === undefined || value === null
    ? 'max_tokens is required.'
    : 'max_tokens must be a non-negative integer.';
  throw new ProxyRequestError(message, 400, 'anthropic');
}

function readRequiredModel(value: unknown, provider: 'openai' | 'anthropic'): string {
  if (typeof value === 'string' && value.trim()) return value;
  const message = value === undefined || value === null
    ? 'model is required.'
    : 'model must be a non-empty string.';
  throw new ProxyRequestError(
    message,
    400,
    provider,
    'invalid_request_error',
    'model',
    provider === 'openai' ? 'missing_required_parameter' : null,
  );
}

function readString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function readOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
