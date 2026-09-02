import { TOOL_RESULT_MARKER } from './tool-history-markers.js';
import { fileURLToPath } from 'node:url';
import type {
  LocalToolCall,
  NormalizedAnthropicEffort,
  NormalizedImage,
  NormalizedImageDetail,
  NormalizedMessage,
  NormalizedRequest,
  NormalizedReasoningEffort,
  NormalizedThinking,
  NormalizedTool,
  NormalizedToolChoice,
  NormalizedToolPart,
  NormalizedToolResult,
  NormalizedToolTurn,
  NormalizedVerbosity,
} from './types.js';
import { ProxyRequestError } from './types.js';

interface NormalizedContent {
  readonly text: string;
  readonly images: readonly NormalizedImage[];
  /**
   * The tool turn this normalizer flattened into `text`, as structure. Present
   * only where THIS module wrote the markers, and carrying the calls and
   * results it wrote them from, so a backend never has to read them back out.
   */
  readonly tool?: NormalizedToolTurn;
}

/**
 * The two prompt literals this module is the only writer of.
 *
 * `tool-history-markers.ts` holds the one literal that TWO writers have to
 * agree on — this normalizer and the image labeller in `multimodal.ts` both
 * write `[tool result]`. These have exactly one writer each, so they live with
 * that writer. `ASSISTANT_TOOL_CALL_MARKER` moved here when the last reader of
 * the grammar was removed and `multimodal.ts` turned out never to have written
 * it; a shared module for a literal nobody else writes is a shared name for a
 * private thing.
 *
 * `ASSISTANT_TOOL_CALL_MARKER` opens a turn's tool CALL; `REPLAYED_ITEM_LABEL`
 * opens a replayed Responses item that is not a message, a `function_call`, a
 * `function_call_output` or a `reasoning` item. Nothing parses either back,
 * which is what keeps a record's own text from forging a tool-result boundary.
 */
const ASSISTANT_TOOL_CALL_MARKER = '[assistant tool_call]';
const REPLAYED_ITEM_LABEL = '[replayed item]';

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
const OPENAI_STREAM_OPTION_KEYS: ReadonlySet<string> = new Set(['include_usage', 'include_obfuscation']);
const OPENAI_PROMPT_CACHE_RETENTIONS = ['in_memory', '24h'] as const;
const OPENAI_METADATA_MAX_PROPERTIES = 16;
const OPENAI_METADATA_MAX_KEY_LENGTH = 64;
const OPENAI_METADATA_MAX_VALUE_LENGTH = 512;
// Measured, not assumed: `n: 64` answers "Expected a value <= 8".
const OPENAI_CHAT_MAX_CHOICES = 8;
const OPENAI_CHAT_MAX_TOP_LOGPROBS = 5;

export function normalizeOpenAiChatRequest(body: unknown): NormalizedRequest {
  const input = objectBody(body);
  // The order the direct API reports faults in, measured 2026-08-30 (§5.5.5):
  // the REQUIRED parameters' presence first (`model` beats an unknown key, and
  // so does a missing `messages`), then unknown keys, then the fields in the
  // order `validateOpenAiChatFields` walks — which is measured, not
  // alphabetical, and not one order per key.
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
 * Every Chat Completions field the direct API validates, in the order it
 * reports them in, with its measured envelopes (§5.5.5, `gpt-5.6-terra`,
 * 2026-08-30). Null is omission for every optional field, as it is there.
 *
 * The ORDER is measured, not derived from a rule. It is not alphabetical —
 * `stream` is reported before `store`, `prompt_cache_options` before
 * `prompt_cache_key` — and it is not one order per key either: `stop` beats
 * `temperature: 0.5` but loses to `temperature: 'x'`, because the value the
 * model family refuses is checked in a later pass than the type. The sequence
 * below is the one that reproduces every measured pair: a comparison sort over
 * 27 same-kind faults (107 calls, antisymmetry-checked in both body orders,
 * every adjacent pair re-verified), the refusals placed against the pairs that
 * pin them, and the model-capability VALUE checks last. Nothing beyond those
 * pairs is claimed; `pnpm e2e:text:parity` carries them as rows so a drift
 * fails loudly rather than quietly.
 *
 * What is refused is as measured as what is accepted. `stop`, `max_tokens`,
 * `logit_bias` and `prediction` are refused by the direct API on this model
 * family whatever their value; `frequency_penalty`, `presence_penalty` and
 * `logprobs` are refused only while the model reasons and are accepted — and
 * not applied, as the contract says — when `reasoning_effort` is `none`.
 */
function validateOpenAiChatFields(
  input: Record<string, unknown>,
): { messages: NormalizedMessage[]; reasoningEffort: NormalizedReasoningEffort | undefined } {
  const present = (key: string): boolean => input[key] !== undefined && input[key] !== null;
  // A plain read, not the validated one: `reasoning_effort` reports its own
  // fault at its own position, and the fields whose acceptance depends on it
  // are checked before it. An absent effort means the model reasons.
  const reasons = input.reasoning_effort !== 'none';

  const messages = readOpenAiMessages(input.messages);
  if (present('functions')) {
    if (!Array.isArray(input.functions)) throw invalidType('functions', 'an array of function definitions', input.functions);
    input.functions.forEach((fn, index) => {
      if (typeof asRecord(fn)?.name !== 'string') throw missingRequiredParameter(`functions[${index}].name`);
    });
  }
  if (present('function_call')) readOpenAiLegacyFunctionCall(input.function_call);
  if (present('tools')) {
    if (!Array.isArray(input.tools)) throw invalidType('tools', 'an array of objects', input.tools);
    input.tools.forEach((tool, index) => {
      const fn = asRecord(asRecord(tool)?.function);
      if (!fn) throw missingRequiredParameter(`tools[${index}].function`);
      if (typeof fn.name !== 'string') throw missingRequiredParameter(`tools[${index}].function.name`);
    });
  }
  if (present('tool_choice')) readOpenAiToolChoice(input.tool_choice);
  if (present('parallel_tool_calls') && typeof input.parallel_tool_calls !== 'boolean') {
    throw invalidType('parallel_tool_calls', 'a boolean', input.parallel_tool_calls);
  }
  if (present('max_completion_tokens')) {
    if (!Number.isInteger(input.max_completion_tokens)) throw invalidType('max_completion_tokens', 'an integer', input.max_completion_tokens);
    if ((input.max_completion_tokens as number) < 1) throw integerBelowMin('max_completion_tokens', input.max_completion_tokens as number, 1);
  }
  if (present('n')) {
    if (!Number.isInteger(input.n)) throw invalidType('n', 'an integer', input.n);
    const n = input.n as number;
    if (n < 1) throw integerBelowMin('n', n, 1);
    if (n > OPENAI_CHAT_MAX_CHOICES) throw integerAboveMax('n', n, OPENAI_CHAT_MAX_CHOICES);
  }
  if (present('temperature') && typeof input.temperature !== 'number') {
    throw invalidType('temperature', 'a decimal', input.temperature);
  }
  if (present('top_p') && typeof input.top_p !== 'number') {
    throw invalidType('top_p', 'a decimal', input.top_p);
  }
  for (const key of ['presence_penalty', 'frequency_penalty'] as const) {
    if (!present(key)) continue;
    if (typeof input[key] !== 'number') throw invalidType(key, 'a decimal', input[key]);
    const value = input[key] as number;
    if (value < -2) throw decimalBelowMin(key, value, -2);
    if (value > 2) throw decimalAboveMax(key, value, 2);
  }
  if (present('logprobs') && typeof input.logprobs !== 'boolean') {
    throw invalidType('logprobs', 'a boolean', input.logprobs);
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
  if (present('user') && typeof input.user !== 'string') throw invalidType('user', 'a string', input.user);
  if (present('seed') && !Number.isInteger(input.seed)) throw invalidType('seed', 'an integer', input.seed);
  if (present('moderation')) {
    // Validated as the direct API validates it, then not applied: the local
    // runtimes moderate nothing, so the response carries no `moderation`
    // object (the contract's Chat row says so).
    const moderation = asRecord(input.moderation);
    if (!moderation) throw invalidType('moderation', 'an object', input.moderation);
    if (typeof moderation.model !== 'string') throw missingRequiredParameter('moderation.model');
  }
  if (present('safety_identifier') && typeof input.safety_identifier !== 'string') {
    throw invalidType('safety_identifier', 'a string', input.safety_identifier);
  }
  if (present('prompt_cache_options')) {
    const options = asRecord(input.prompt_cache_options);
    if (!options) throw invalidType('prompt_cache_options', 'an object', input.prompt_cache_options);
    for (const key of Object.keys(options)) {
      if (!OPENAI_PROMPT_CACHE_OPTION_KEYS.has(key)) throw unknownParameter(`prompt_cache_options.${key}`);
    }
  }
  if (present('prompt_cache_key') && typeof input.prompt_cache_key !== 'string') {
    throw invalidType('prompt_cache_key', 'a string', input.prompt_cache_key);
  }
  if (present('prompt_cache_retention')) {
    const retention = input.prompt_cache_retention;
    if (typeof retention !== 'string') {
      throw invalidType('prompt_cache_retention', `one of ${listOfQuoted(OPENAI_PROMPT_CACHE_RETENTIONS, 'or')}`, retention);
    }
    if (retention !== 'in_memory' && retention !== '24h') {
      // Chat's own sentence for this one field: no code, no list, no period.
      // Responses answers the same input with a standard `invalid_value`.
      throw new ProxyRequestError('Invalid prompt_cache_retention argument', 400, 'openai', 'invalid_request_error', 'prompt_cache_retention');
    }
    if (retention === 'in_memory') {
      // Not an enum fault: the value is valid and this model family refuses it.
      throw new ProxyRequestError('This model is compatible only with 24h extended prompt caching', 400, 'openai', 'invalid_request_error', 'prompt_cache_retention');
    }
  }
  if (present('response_format')) validateOpenAiChatResponseFormat(input.response_format);
  if (present('service_tier')) readOpenAiServiceTier(input.service_tier);
  if (present('max_tokens')) {
    throw unsupportedParameter('max_tokens', "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.");
  }
  const reasoningEffort = readOpenAiChatReasoningEffort(input.reasoning_effort);
  if (present('logit_bias')) throw unsupportedParameter('logit_bias');
  if (present('stop')) throw unsupportedParameter('stop');
  if (present('stream') && typeof input.stream !== 'boolean') throw invalidType('stream', 'a boolean', input.stream);
  if (present('stream_options')) {
    const options = asRecord(input.stream_options);
    if (!options) throw invalidType('stream_options', 'an object', input.stream_options);
    for (const key of Object.keys(options)) {
      if (!OPENAI_STREAM_OPTION_KEYS.has(key)) throw unknownParameter(`stream_options.${key}`);
    }
  }
  if (present('store') && typeof input.store !== 'boolean') throw invalidType('store', 'a boolean', input.store);
  if (present('metadata')) validateOpenAiMetadata(input.metadata);
  if (present('prediction')) throw unsupportedParameter('prediction');
  if (present('verbosity')) readOpenAiChatVerbosity(input.verbosity);

  // The model-capability VALUE checks, measured to run after every field
  // check above: `stop` (refused outright) is reported before
  // `temperature: 0.5`, while `temperature: 'x'` is reported before `stop`.
  rejectUnsupportedOpenAiSampling(input, 'openai-chat', 'temperature');
  rejectUnsupportedOpenAiSampling(input, 'openai-chat', 'top_p');
  if (reasons) {
    if (present('presence_penalty')) throw unsupportedParameter('presence_penalty');
    if (present('frequency_penalty')) throw unsupportedParameter('frequency_penalty');
    if (input.logprobs === true) throw unsupportedParameter('logprobs');
  }
  refuseOpenAiChatMissingContent(input.messages);
  return { messages, reasoningEffort };
}

/**
 * `content` is REQUIRED on every message, and this is the last check of all.
 *
 * Measured 2026-08-31 on gpt-5.6-terra, gpt-5.5 and gpt-5.6-sol alike, with
 * `{"role":"user","content":"hi"}` as the positive control: `{"role":"user"}`
 * and `{"role":"user","content":null}` both answer 400 `Invalid value for
 * 'content': expected a string, got null.` at param `messages.[<i>].content` —
 * the dotted-bracket form, and no `code` at all, neither of which any other
 * fault on this surface uses. This file's previous note recorded the opposite
 * ("ABSENT or `null` on any role too, measured 2026-08-30") and removed the
 * check on that reading, which turned a 400 into a 200.
 *
 * The exemption is the assistant schema's own: an assistant message needs at
 * least ONE of content, `tool_calls`, `function_call`, `refusal` or `audio`, so
 * any of those stands in for content (each measured to answer 200, or to answer
 * about something other than content). Every other role needs content itself.
 *
 * Last of all: it loses to the content TYPE check at any index, to a bad role
 * at any index, to `n`, `stop`, `temperature` and an unknown key.
 */
const OPENAI_CHAT_ASSISTANT_CONTENT_SUBSTITUTES = ['tool_calls', 'function_call', 'refusal', 'audio'] as const;

function refuseOpenAiChatMissingContent(value: unknown): void {
  if (!Array.isArray(value)) return;
  for (const [index, item] of value.entries()) {
    const msg = asRecord(item);
    if (!msg || (msg.content !== undefined && msg.content !== null)) continue;
    if (
      msg.role === 'assistant'
      // A substitute that is present but NULL is not a substitute: every one of
      // `tool_calls`, `function_call`, `refusal` and `audio` set to null falls
      // through to the content fault (measured).
      && OPENAI_CHAT_ASSISTANT_CONTENT_SUBSTITUTES.some((key) => msg[key] !== undefined && msg[key] !== null)
    ) continue;
    // `developer` is its own schema and answers in its own words: a missing
    // parameter for an absent value, a type fault for `null`, and the plain
    // `messages[i].content` param where every other role gets the
    // dotted-bracket `messages.[i].content` (all measured).
    if (msg.role === 'developer') {
      if (msg.content === undefined) throw missingRequiredParameter(`messages[${index}].content`);
      throw invalidType(`messages[${index}].content`, 'one of a string or array of objects', msg.content);
    }
    throw new ProxyRequestError(
      "Invalid value for 'content': expected a string, got null.",
      400, 'openai', 'invalid_request_error', `messages.[${index}].content`, null,
    );
  }
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

/**
 * The direct API shortens a long name to its first and last three characters
 * in a message while the `param` carries it whole. The threshold is bracketed
 * by measurement rather than assumed: `'conversation'` (12) is printed whole
 * and `'previous_response_id'` (20) is elided in the same sentence, the
 * `include` members (24+) are elided in their type message, and a 70-character
 * metadata key came back as `'kkk...kkk'`. Everything shorter that has been
 * measured — `'detailed'`, `'in_memory'`, `'priority'` — is printed whole.
 */
function elideLongName(name: string): string {
  return name.length > 12 ? `${name.slice(0, 3)}...${name.slice(-3)}` : name;
}

function validateOpenAiChatResponseFormat(value: unknown): void {
  const format = asRecord(value);
  if (!format) throw invalidType('response_format', 'an object', value);
  if (format.type === undefined || format.type === null) throw missingRequiredParameter('response_format.type');
  if (!OPENAI_CHAT_RESPONSE_FORMATS.some((candidate) => candidate === format.type)) {
    throw invalidValue('response_format.type', String(format.type), OPENAI_CHAT_RESPONSE_FORMATS);
  }
  // `json_schema` carries the schema and its name, both required (measured):
  // the proxy used to accept `{type:"json_schema"}` alone and run the turn in
  // JSON mode with no schema at all — structured output the caller asked for
  // and never got.
  if (format.type !== 'json_schema') return;
  const jsonSchema = asRecord(format.json_schema);
  if (!jsonSchema) throw missingRequiredParameter('response_format.json_schema');
  if (typeof jsonSchema.name !== 'string') throw missingRequiredParameter('response_format.json_schema.name');
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

/**
 * An unknown key, with the direct API's spelling help. The suggestion rule is
 * measured, not guessed: candidates are known keys within an edit distance of
 * 2 (`'sto'`→`'store'` suggests, `'st'` does not) that the body does NOT
 * already carry (`'modell'` suggests nothing while `model` is present, and
 * `'inpu'` nothing while `input` is), nearest first (`'strem'` answers
 * `'stream' or 'store'`, so the order is by distance and not alphabetical),
 * ties alphabetical (`'stor'` on Chat answers `'stop' or 'store'`).
 */
function unknownParameter(field: string, suggestions: readonly string[] = []): ProxyRequestError {
  const help = suggestions.length ? ` Did you mean ${listOfQuoted(suggestions, 'or')}?` : '';
  return new ProxyRequestError(`Unknown parameter: '${field}'.${help}`, 400, 'openai', 'invalid_request_error', field, 'unknown_parameter');
}

/**
 * The keys whose edit distance will actually be COMPUTED.
 *
 * Exported because the pre-filter is a cost promise and nothing about the
 * output can catch its removal: `|len(a) - len(b)| <= distance` holds for
 * unit-cost Levenshtein, so the keys it drops were never going to be within 2.
 * A wall-clock test of that is a verdict on the scheduler, not on the code —
 * this is the seam an assertion can be exact about.
 */
export function editDistanceCandidates(
  unknown: string,
  known: ReadonlySet<string>,
  body: Record<string, unknown>,
): string[] {
  return [...known]
    .filter((key) => !(key in body))
    // A length gap over 2 IS a distance over 2 — each edit changes the length
    // by at most one — so this drops candidates without computing anything.
    // Without it the cost is the unknown key's length times every known key's,
    // synchronously: a 45 MB key inside the body cap held the whole server for
    // 50 seconds, and every other client with it.
    .filter((key) => Math.abs(key.length - unknown.length) <= 2);
}

function spellingSuggestions(unknown: string, known: ReadonlySet<string>, body: Record<string, unknown>): string[] {
  return editDistanceCandidates(unknown, known, body)
    .map((key) => ({ key, distance: editDistance(unknown, key) }))
    .filter((candidate) => candidate.distance <= 2)
    .sort((a, b) => a.distance - b.distance || (a.key < b.key ? -1 : 1))
    .map((candidate) => candidate.key);
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
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

function decimalBelowMin(field: string, value: number, min: number): ProxyRequestError {
  return new ProxyRequestError(
    `Invalid '${field}': decimal below minimum value. Expected a value >= ${min}, but got ${value} instead.`,
    400, 'openai', 'invalid_request_error', field, 'decimal_below_min_value',
  );
}

function decimalAboveMax(field: string, value: number, max: number): ProxyRequestError {
  return new ProxyRequestError(
    `Invalid '${field}': decimal above maximum value. Expected a value <= ${max}, but got ${value} instead.`,
    400, 'openai', 'invalid_request_error', field, 'decimal_above_max_value',
  );
}

function integerAboveMax(field: string, value: number, max: number): ProxyRequestError {
  return new ProxyRequestError(
    `Invalid '${field}': integer above maximum value. Expected a value <= ${max}, but got ${value} instead.`,
    400, 'openai', 'invalid_request_error', field, 'integer_above_max_value',
  );
}

/**
 * "'a', 'b', or 'c'" — the direct API's own list punctuation, including its
 * serial comma, which it drops for a two-member list: `'auto' and 'disabled'`,
 * not `'auto', and 'disabled'` (measured on `truncation`, and on
 * `prompt_cache_retention`'s two-member type message).
 */
function listOfQuoted(values: readonly string[], conjunction: 'or' | 'and'): string {
  const quoted = values.map((value) => `'${value}'`);
  if (quoted.length <= 1) return quoted.join('');
  if (quoted.length === 2) return `${quoted[0]} ${conjunction} ${quoted[1]}`;
  return `${quoted.slice(0, -1).join(', ')}, ${conjunction} ${quoted[quoted.length - 1]}`;
}

/** The direct API's own type words for its "got X instead" messages. */
export function jsonTypeName(value: unknown): string {
  // `null` here, not "an object": the Images surface words a JSON null that way
  // (measured on `model` and `prompt`, 2026-08-30). Responses words the SAME
  // value as "an object" — see `readRequiredOpenAiModel`, where that one
  // surface's wording is kept local rather than generalized from it.
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
    if (!known.has(key)) throw unknownParameter(key, spellingSuggestions(key, known, input));
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
  if (value === undefined) missing();
  // Chat treats `null` and `''` as an absent model; Responses treats neither
  // that way. `null` is a TYPE fault there — and the direct API words JSON
  // null as "an object" in that sentence — while `''` is a model that does not
  // exist. Both measured 2026-08-30; neither was mirrored before.
  if (value === null) {
    if (shape === 'openai-chat') missing();
    // Responses alone words a JSON null as "an object" — measured against the
    // Images surface, which words the identical fault as "null". One surface's
    // phrasing is not the API's phrasing.
    throw new ProxyRequestError(
      "Invalid type for 'model': expected a string, but got an object instead.",
      400, 'openai', 'invalid_request_error', 'model', 'invalid_type',
    );
  }
  if (typeof value !== 'string') throw invalidType('model', 'a string', value);
  if (!value.trim()) {
    if (shape === 'openai-chat') missing();
    throw new ProxyRequestError(
      `The requested model '${value}' does not exist.`,
      400, 'openai', 'invalid_request_error', 'model', 'model_not_found',
    );
  }
  return value as string;
}

function requireOpenAiChatMessages(value: unknown): void {
  // Only ABSENCE is a missing parameter here. `messages: null` is a wrong TYPE
  // and gets the type sentence (measured 2026-08-31: "Invalid type for
  // 'messages': expected an array of objects, but got null instead."), which
  // `readOpenAiMessages` already writes — this used to answer both the same way.
  if (value === undefined) throw missingRequiredParameter('messages');
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

/**
 * The direct API prints a rejected non-string value Python-style in this one
 * message — `{'__probe__': 'wrong type'}`, quotes and spacing included, which
 * is what a client sees. Python's own `repr` rules are followed rather than
 * guessed at from the single observation: a string containing an apostrophe is
 * quoted with double quotes instead of escaping it, a string containing both
 * kinds escapes the apostrophe, and backslashes and control characters are
 * escaped. Without that, a caller's `{"k": "a'b"}` came back as `{'k': 'a'b'}`
 * — a message that says something the value does not.
 */
function jsonValueForMessage(value: unknown): string {
  if (value === null) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (typeof value === 'string') return pythonReprString(value);
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return `[${value.map(jsonValueForMessage).join(', ')}]`;
  if (typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).map(([key, member]) => `${pythonReprString(key)}: ${jsonValueForMessage(member)}`).join(', ')}}`;
  }
  return String(value);
}

function pythonReprString(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, (char) => `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`);
  // Python prefers single quotes and switches to double quotes rather than
  // escaping an apostrophe — unless the string carries both.
  if (escaped.includes("'") && !escaped.includes('"')) return `"${escaped}"`;
  return `'${escaped.replace(/'/g, "\\'")}'`;
}

function readOpenAiChatVerbosity(value: unknown): NormalizedVerbosity | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === 'low' || value === 'medium' || value === 'high') return value;
  if (typeof value !== 'string') throw invalidType('verbosity', `one of ${listOfQuoted(OPENAI_CHAT_VERBOSITIES, 'or')}`, value);
  throw invalidValue('verbosity', value, OPENAI_CHAT_VERBOSITIES);
}

/**
 * The tier the response reports, which is not always the tier the caller sent:
 * `fast` and `priority` both come back as `priority`, and `auto`, `default`
 * and an omitted value all come back as `default` (measured 2026-08-30 on both
 * surfaces). Echoing the request verbatim reported a tier the direct API never
 * reports.
 */
export function resolvedOpenAiServiceTier(value: unknown): string {
  if (value === 'fast' || value === 'priority') return 'priority';
  if (value === 'flex') return 'flex';
  return 'default';
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

// The top-level keys the direct Responses API knows, measured 2026-08-30
// (§5.5.6). `n`, `stop`, `seed`, `logprobs` and `max_tokens` are Chat keys and
// unknown here; `messages` is unknown with a sentence of its own.
export const OPENAI_RESPONSES_KEYS: ReadonlySet<string> = new Set([
  'model', 'input', 'instructions', 'max_output_tokens', 'max_tool_calls', 'temperature', 'top_p',
  'top_logprobs', 'stream', 'stream_options', 'text', 'tools', 'tool_choice', 'parallel_tool_calls',
  'reasoning', 'include', 'store', 'background', 'previous_response_id', 'conversation',
  'truncation', 'metadata', 'user', 'safety_identifier', 'prompt_cache_key',
  'prompt_cache_retention', 'prompt_cache_options', 'service_tier', 'prompt', 'context_management',
  'moderation', 'presence_penalty', 'frequency_penalty',
]);
/**
 * Two enums, because the direct API answers in two layers (measured):
 *
 *   `'bogus'`   → `invalid_value`, listing the SCHEMA set (with `minimal`)
 *   `'minimal'` → `unsupported_value`, naming the model and listing the set
 *                 that model takes (without `minimal`)
 *
 * and `max` — refused on Chat — is in both here. A single list would have to
 * answer one of those two wrongly.
 */
const OPENAI_RESPONSES_EFFORT_SCHEMA = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const OPENAI_RESPONSES_REASONING_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
/** The narrower list the direct API prints when the value is an integer. */
const OPENAI_RESPONSES_EFFORT_INTEGER_BRANCH = ['minimal', 'low', 'medium', 'high'] as const;
const OPENAI_RESPONSES_REASONING_SUMMARIES = ['concise', 'detailed', 'auto'] as const;
const OPENAI_RESPONSES_REASONING_KEYS: ReadonlySet<string> = new Set(['effort', 'summary']);
const OPENAI_RESPONSES_TRUNCATIONS = ['auto', 'disabled'] as const;
const OPENAI_RESPONSES_MIN_OUTPUT_TOKENS = 16;
// Only `include_obfuscation` — `include_usage` is a Chat key and unknown here
// (P-10), which this proxy used to accept as an extension.
const OPENAI_RESPONSES_STREAM_OPTION_KEYS: ReadonlySet<string> = new Set(['include_obfuscation']);
const OPENAI_RESPONSES_INCLUDES = [
  'file_search_call.results', 'web_search_call.results', 'web_search_call.action.sources',
  'message.input_image.image_url', 'computer_call_output.output.image_url',
  'code_interpreter_call.outputs', 'reasoning.encrypted_content', 'message.output_text.logprobs',
] as const;

export function normalizeOpenAiResponsesRequest(body: unknown): NormalizedRequest {
  const input = objectBody(body);
  // Same three-step order as Chat, with this surface's own sentences: the
  // required parameter first, then unknown keys, then the fields in the order
  // measured for THIS surface — which is nothing like Chat's, because each
  // surface reports in its own schema order (§5.5.6).
  const model = readRequiredOpenAiModel(input.model, 'openai-responses');
  // `input` is required, and its absence outranks everything but `model` —
  // measured 2026-08-31: an unknown key, a bad `truncation`, a
  // `previous_response_id` and a `conversation` all lose to it. The proxy used
  // to substitute an empty user turn and answer 200.
  if (input.input === undefined) throw missingRequiredParameter('input');
  rejectUnknownOpenAiResponsesKeys(input);
  validateOpenAiResponsesFields(input, model);

  const messages: NormalizedMessage[] = [];
  if (typeof input.instructions === 'string' && input.instructions.trim()) {
    messages.push({ role: 'system', content: input.instructions, images: [] });
  }
  messages.push(...readResponsesInput(input.input));
  const text = asRecord(input.text);
  const format = asRecord(text?.format);
  const reasoning = asRecord(input.reasoning);
  return {
    shape: 'openai-responses',
    model,
    messages,
    maxTokens: readOptionalNumber(input.max_output_tokens),
    reasoningEffort: readOpenAiResponsesReasoningEffort(reasoning?.effort, model),
    verbosity: readOpenAiVerbosity(text?.verbosity),
    stream: input.stream === true,
    streamOptions: readStreamOptions(input.stream_options),
    jsonMode: format?.type === 'json_object' || format?.type === 'json_schema',
    jsonSchema: format?.schema,
    jsonSchemaName: format?.type === 'json_schema' ? readOptionalString(format.name) : undefined,
    jsonSchemaStrict: format?.type === 'json_schema' ? readOptionalBoolean(format.strict) : undefined,
    tools: readOpenAiTools(input.tools),
    toolChoice: readOpenAiToolChoice(input.tool_choice, 'openai-responses'),
    raw: body,
  };
}

function rejectUnknownOpenAiResponsesKeys(input: Record<string, unknown>): void {
  for (const key of Object.keys(input)) {
    if (OPENAI_RESPONSES_KEYS.has(key)) continue;
    // The one unknown key with a sentence of its own, and no `param` at all.
    if (key === 'messages') {
      throw new ProxyRequestError(
        "Unsupported parameter: 'messages'. In the Responses API, this parameter has moved to 'input'. Try again with the new parameter. See the API documentation for more information: https://platform.openai.com/docs/api-reference/responses/create.",
        400, 'openai', 'invalid_request_error', null, 'unsupported_parameter',
      );
    }
    throw unknownParameter(key, spellingSuggestions(key, OPENAI_RESPONSES_KEYS, input));
  }
}

/**
 * The Responses fields, in the order this surface reports them (§5.5.6: 31
 * keys, comparison sort, 124 calls, antisymmetry checked, adjacent pairs
 * re-verified). Three of its rules differ from Chat's and are the reason a
 * shared validator would be wrong: `reasoning.effort: "max"` is accepted here,
 * `prompt_cache_retention: "in_memory"` carries a code here, and `model: null`
 * is a type fault here.
 *
 * Server-side state is where this surface diverges on purpose. The direct API
 * refuses an unknown `previous_response_id`, `conversation` or `prompt.id`;
 * this proxy stores none of them, so EVERY id is unknown and every one of
 * those requests is refused with the direct envelope. That is the honest
 * answer: the alternative — the previous behaviour — was to echo the id back
 * and run the turn with no prior context at all.
 */
function validateOpenAiResponsesFields(input: Record<string, unknown>, model: string): void {
  const present = (key: string): boolean => input[key] !== undefined && input[key] !== null;

  if (input.input === null) {
    // The same quirk `model: null` has on this surface: null is described as a
    // failed STRING and worded "an object", where every other wrong type gets
    // the union's own sentence and its own type name.
    throw new ProxyRequestError(
      "Invalid type for 'input': expected a string, but got an object instead.",
      400, 'openai', 'invalid_request_error', 'input', 'invalid_type',
    );
  }
  if (present('input')) {
    if (typeof input.input !== 'string' && !Array.isArray(input.input)) {
      throw invalidType('input', 'one of a string or array of input items', input.input);
    }
    // Inside the item, at the `input` position of the order — a fault here
    // beats every later field's, which is what the measurement shows.
    if (Array.isArray(input.input)) {
      input.input.forEach((item, index) => validateOpenAiResponsesInputItem(item, index));
    }
  }
  if (present('previous_response_id') && typeof input.previous_response_id !== 'string') {
    throw invalidType('previous_response_id', 'a string', input.previous_response_id);
  }
  if (present('prompt') && !asRecord(input.prompt)) throw invalidType('prompt', 'an object', input.prompt);
  if (present('moderation') && !asRecord(input.moderation)) {
    throw invalidType('moderation', 'an object', input.moderation);
  }
  if (present('include')) {
    if (!Array.isArray(input.include)) {
      // The type message abbreviates each member to its first and last three
      // characters (`'fil...lts'`); the VALUE message spells them out. Both
      // are measured — the abbreviation is not a formatting choice of ours.
      throw invalidType('include', `an array of one of ${listOfQuoted(OPENAI_RESPONSES_INCLUDES.map(elideLongName), 'or')}`, input.include);
    }
    input.include.forEach((member, index) => {
      if (!OPENAI_RESPONSES_INCLUDES.some((candidate) => candidate === member)) {
        throw invalidValue(`include[${index}]`, String(member), OPENAI_RESPONSES_INCLUDES);
      }
    });

  }
  if (present('tools')) {
    if (!Array.isArray(input.tools)) throw invalidType('tools', 'an array of tools', input.tools);
    input.tools.forEach((tool, index) => {
      const record = asRecord(tool);
      if (!record) throw invalidType(`tools[${index}]`, 'an object', tool);
      if (record.type === undefined) throw missingRequiredParameter(`tools[${index}].type`);
      // A function tool with no name used to be run under the invented name
      // `tool` — a tool the caller never asked for.
      if (record.type === 'function' && typeof record.name !== 'string') {
        throw missingRequiredParameter(`tools[${index}].name`);
      }
    });
  }
  if (present('tool_choice')) readOpenAiToolChoice(input.tool_choice, 'openai-responses');
  if (present('metadata')) validateOpenAiMetadata(input.metadata);
  if (present('text')) validateOpenAiResponsesText(input.text);
  if (present('temperature') && typeof input.temperature !== 'number') {
    throw invalidType('temperature', 'a decimal', input.temperature);
  }
  if (present('top_p') && typeof input.top_p !== 'number') {
    throw invalidType('top_p', 'a decimal', input.top_p);
  }
  for (const key of ['presence_penalty', 'frequency_penalty'] as const) {
    if (present(key) && typeof input[key] !== 'number') throw invalidType(key, 'a decimal', input[key]);
  }
  if (present('parallel_tool_calls') && typeof input.parallel_tool_calls !== 'boolean') {
    throw invalidType('parallel_tool_calls', 'a boolean', input.parallel_tool_calls);
  }
  if (present('stream') && typeof input.stream !== 'boolean') throw invalidType('stream', 'a boolean', input.stream);
  if (present('stream_options')) {
    const options = asRecord(input.stream_options);
    if (!options) throw invalidType('stream_options', 'an object', input.stream_options);
    for (const key of Object.keys(options)) {
      if (!OPENAI_RESPONSES_STREAM_OPTION_KEYS.has(key)) throw unknownParameter(`stream_options.${key}`);
    }
  }
  if (present('background') && typeof input.background !== 'boolean') {
    throw invalidType('background', 'a boolean', input.background);
  }
  if (present('max_output_tokens')) {
    if (!Number.isInteger(input.max_output_tokens)) throw invalidType('max_output_tokens', 'an integer', input.max_output_tokens);
    // 16, not 1 — measured at 1, 15 and 16. `max_tool_calls`'s floor IS 1.
    if ((input.max_output_tokens as number) < OPENAI_RESPONSES_MIN_OUTPUT_TOKENS) {
      throw integerBelowMin('max_output_tokens', input.max_output_tokens as number, OPENAI_RESPONSES_MIN_OUTPUT_TOKENS);
    }
  }
  if (present('max_tool_calls')) {
    if (!Number.isInteger(input.max_tool_calls)) throw invalidType('max_tool_calls', 'an integer', input.max_tool_calls);
    if ((input.max_tool_calls as number) < 1) throw integerBelowMin('max_tool_calls', input.max_tool_calls as number, 1);
  }
  if (present('reasoning')) validateOpenAiResponsesReasoning(input.reasoning, model);
  if (present('user') && typeof input.user !== 'string') throw invalidType('user', 'a string', input.user);
  if (present('safety_identifier') && typeof input.safety_identifier !== 'string') {
    throw invalidType('safety_identifier', 'a string', input.safety_identifier);
  }
  if (present('prompt_cache_options')) {
    const options = asRecord(input.prompt_cache_options);
    if (!options) throw invalidType('prompt_cache_options', 'an object', input.prompt_cache_options);
    for (const key of Object.keys(options)) {
      if (!OPENAI_PROMPT_CACHE_OPTION_KEYS.has(key)) throw unknownParameter(`prompt_cache_options.${key}`);
    }
  }
  if (present('prompt_cache_key') && typeof input.prompt_cache_key !== 'string') {
    throw invalidType('prompt_cache_key', 'a string', input.prompt_cache_key);
  }
  if (present('prompt_cache_retention')) {
    const retention = input.prompt_cache_retention;
    if (typeof retention !== 'string') {
      throw invalidType('prompt_cache_retention', `one of ${listOfQuoted(OPENAI_PROMPT_CACHE_RETENTIONS, 'or')}`, retention);
    }
    if (retention !== 'in_memory' && retention !== '24h') {
      throw invalidValue('prompt_cache_retention', retention, OPENAI_PROMPT_CACHE_RETENTIONS);
    }
    if (retention === 'in_memory') {
      // The same sentence Chat gives, with a code Chat does not carry.
      throw new ProxyRequestError(
        'This model is compatible only with 24h extended prompt caching',
        400, 'openai', 'invalid_request_error', 'prompt_cache_retention', 'invalid_parameter',
      );
    }
  }
  if (present('truncation')) {
    if (typeof input.truncation !== 'string') throw invalidType('truncation', `one of ${listOfQuoted(OPENAI_RESPONSES_TRUNCATIONS, 'or')}`, input.truncation);
    if (!OPENAI_RESPONSES_TRUNCATIONS.some((candidate) => candidate === input.truncation)) {
      throw invalidValue('truncation', input.truncation, OPENAI_RESPONSES_TRUNCATIONS);
    }
  }
  if (present('instructions') && typeof input.instructions !== 'string') {
    throw invalidType('instructions', 'a string', input.instructions);
  }
  if (present('store') && typeof input.store !== 'boolean') throw invalidType('store', 'a boolean', input.store);
  if (present('service_tier')) readOpenAiServiceTier(input.service_tier);
  if (present('top_logprobs') && !Number.isInteger(input.top_logprobs)) {
    throw invalidType('top_logprobs', 'an integer', input.top_logprobs);
  }
  if (present('context_management') && !Array.isArray(input.context_management)) {
    throw invalidType('context_management', 'an array of objects', input.context_management);
  }
  refuseOpenAiResponsesServerState(input);
  // Present but carrying nothing. Measured: it loses to the state phase above
  // and beats the capability pass below, and it names no `param` — the sentence
  // is about the request as a whole, not about one field.
  if (Array.isArray(input.input) ? input.input.length === 0 : input.input === '') {
    throw new ProxyRequestError(
      'One of "input" or "previous_response_id" or \'prompt\' or \'conversation\' must be provided.',
      400, 'openai', 'invalid_request_error', null, 'missing_required_parameter',
    );
  }

  // The model-capability value checks, after every field check — the same
  // second pass Chat has. Logprobs live here rather than at their fields'
  // slots: a later field's type fault beats them, so the refusal is about what
  // the model can do and not about the shape of the body. Both doors to them
  // are refused; the proxy used to accept the `include` member and run the
  // turn, answering with no logprobs in it at all.
  rejectUnsupportedOpenAiSampling(input, 'openai-responses', 'temperature');
  rejectUnsupportedOpenAiSampling(input, 'openai-responses', 'top_p');
  // `include` first: sent together, the direct API names that door (measured).
  if (Array.isArray(input.include) && input.include.includes('message.output_text.logprobs')) {
    throw unsupportedParameter('include', 'logprobs are not supported with reasoning models.');
  }
  if (present('top_logprobs')) {
    throw unsupportedParameter('top_logprobs', 'logprobs are not supported with reasoning models.');
  }
  for (const key of ['presence_penalty', 'frequency_penalty'] as const) {
    // Chat carries `unsupported_parameter` here; Responses carries no code at
    // all for the same sentence (measured on both).
    if (present(key)) {
      throw new ProxyRequestError(
        `Unsupported parameter: '${key}' is not supported with this model.`,
        400, 'openai', 'invalid_request_error', key,
      );
    }
  }
}

/**
 * Server-side state, which this proxy holds none of. The direct API resolves
 * these three ids after it has validated the whole body and before it checks
 * what the model supports — measured on both sides of that boundary: a bad
 * `truncation` beats an unknown `prompt`, and an unknown `prompt` beats a
 * refused `temperature`. Their own order is `conversation`, then `prompt`,
 * then `previous_response_id`, and the first two pair is refused as mutually
 * exclusive before either is looked up.
 *
 * Every id is unknown here, so every one of these requests is refused. That is
 * the honest answer: the alternative — the previous behaviour — was to echo
 * the id back and run the turn with no prior context at all.
 */
function refuseOpenAiResponsesServerState(input: Record<string, unknown>): void {
  const has = (key: string): boolean => input[key] !== undefined && input[key] !== null;
  if (has('previous_response_id') && has('conversation')) {
    throw new ProxyRequestError(
      `Mutually exclusive parameters: ''. Ensure you are only providing one of: ${listOfQuoted(['previous_response_id', 'conversation'].map(elideLongName), 'or')}.`,
      400, 'openai', 'invalid_request_error', null, 'mutually_exclusive_parameters',
    );
  }
  if (has('conversation')) {
    const conversation = asRecord(input.conversation);
    if (conversation && typeof conversation.id !== 'string') throw missingRequiredParameter('conversation.id');
    const id = typeof input.conversation === 'string' ? input.conversation : String(conversation?.id ?? '');
    throw new ProxyRequestError(`Conversation with id '${id}' not found.`, 404, 'openai', 'invalid_request_error', null, null);
  }
  if (has('prompt')) {
    throw new ProxyRequestError(
      `Prompt with id '${String(asRecord(input.prompt)?.id ?? '')}' not found.`,
      404, 'openai', 'invalid_request_error', null, null,
    );
  }
  if (has('previous_response_id')) {
    throw new ProxyRequestError(
      `Previous response with id '${String(input.previous_response_id)}' not found.`,
      400, 'openai', 'invalid_request_error', 'previous_response_id', 'previous_response_not_found',
    );
  }
}

function validateOpenAiResponsesReasoning(value: unknown, model: string): void {
  const reasoning = asRecord(value);
  if (!reasoning) throw invalidType('reasoning', 'an object', value);
  for (const key of Object.keys(reasoning)) {
    if (!OPENAI_RESPONSES_REASONING_KEYS.has(key)) throw unknownParameter(`reasoning.${key}`);
  }
  const summary = reasoning.summary;
  if (summary !== undefined && summary !== null && !OPENAI_RESPONSES_REASONING_SUMMARIES.some((candidate) => candidate === summary)) {
    throw invalidValue('reasoning.summary', String(summary), OPENAI_RESPONSES_REASONING_SUMMARIES);
  }
  readOpenAiResponsesReasoningEffort(reasoning.effort, model);
}

function readOpenAiResponsesReasoningEffort(value: unknown, model: string): NormalizedReasoningEffort | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    // An integer gets the narrow branch's list; anything else gets the whole
    // union, integer included. Two sentences for one field, both measured.
    const expected = typeof value === 'number' && Number.isInteger(value)
      ? `one of ${listOfQuoted(OPENAI_RESPONSES_EFFORT_INTEGER_BRANCH, 'or')}`
      : `one of one of ${listOfQuoted(OPENAI_RESPONSES_EFFORT_SCHEMA, 'or')} or integer`;
    throw invalidType('reasoning.effort', expected, value);
  }
  if (!OPENAI_RESPONSES_EFFORT_SCHEMA.some((candidate) => candidate === value)) {
    throw invalidValue('reasoning.effort', value, OPENAI_RESPONSES_EFFORT_SCHEMA);
  }
  if (!OPENAI_RESPONSES_REASONING_EFFORTS.some((candidate) => candidate === value)) {
    throw new ProxyRequestError(
      `Unsupported value: '${value}' is not supported with the '${model}' model. Supported values are: ${listOfQuoted(OPENAI_RESPONSES_REASONING_EFFORTS, 'and')}.`,
      400, 'openai', 'invalid_request_error', 'reasoning.effort', 'unsupported_value',
    );
  }
  // `max` is in this surface's enum and outside the normalized set the
  // backends take; it runs at the highest effort they have.
  return value === 'max' ? 'xhigh' : (value as NormalizedReasoningEffort);
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


const ANTHROPIC_ROLES = ['user', 'assistant'] as const;
const ANTHROPIC_TOOL_CHOICE_TYPES = ['auto', 'any', 'tool', 'none'] as const;
const ANTHROPIC_SERVICE_TIERS = ['auto', 'standard_only'] as const;
const ANTHROPIC_INFERENCE_GEOS = ['global', 'us'] as const;

function anthropicFault(message: string): ProxyRequestError {
  return new ProxyRequestError(message, 400, 'anthropic');
}

/**
 * Every known field, in the order the direct Messages API reports it, derived
 * the same way the OpenAI orders were: a comparison sort over SAME-KIND (type)
 * faults — 18 keys, 137 calls, antisymmetry 51/51 in both body orders, all 17
 * adjacent pairs re-verified (2026-08-31, `claude-sonnet-5`). It is not
 * alphabetical and it is not the documented parameter listing:
 *
 *   model → tool_choice → tools → messages → system → thinking → output_config
 *   → cache_control → max_tokens → metadata → stop_sequences → temperature
 *   → service_tier → top_k → top_p → stream → container → inference_geo
 *
 * Then unknown keys, and only then the `container` refusal — which loses to an
 * unknown key, so it is a phase of its own rather than a check at container's
 * slot, exactly as the OpenAI surfaces put capability refusals last.
 *
 * `null` is NOT uniformly omission on this surface, unlike the OpenAI ones:
 * `metadata`, `inference_geo`, `stop_sequences`, `cache_control` and
 * `container` take it as absence, and every other field answers about its
 * type. Each of those was measured one at a time.
 */
function validateAnthropicMessagesFields(input: Record<string, unknown>): void {
  const sent = (key: string): boolean => input[key] !== undefined;
  const set = (key: string): boolean => input[key] !== undefined && input[key] !== null;

  if (!sent('model')) throw anthropicFault('model: Field required');
  if (typeof input.model !== 'string') throw anthropicFault('model: Input should be a valid string');
  if (input.model.length === 0) throw anthropicFault('model: String should have at least 1 character');
  // A whitespace-only name is a NAME to the direct API — it answers 404 model
  // not found, as it does for any name it does not know. This proxy runs every
  // name on its configured backend and so cannot mirror that 404; it keeps its
  // own 400 rather than dispatching a turn for a name that is plainly a slip.
  if (!input.model.trim()) throw anthropicFault('model: String should have at least 1 character');

  if (sent('tool_choice')) validateAnthropicToolChoice(input.tool_choice);
  if (sent('tools')) {
    if (!Array.isArray(input.tools)) throw anthropicFault('tools: Input should be a valid array');
    input.tools.forEach((tool, index) => {
      if (!asRecord(tool)) throw anthropicFault(`tools.${index}: Input should be an object`);
    });
  }

  if (!sent('messages')) throw anthropicFault('messages: Field required');
  if (!Array.isArray(input.messages)) throw anthropicFault('messages: Input should be a valid array');
  if (input.messages.length === 0) throw anthropicFault('messages: at least one message is required');
  input.messages.forEach((item, index) => validateAnthropicMessageItem(item, index));

  // A string is accepted too; the type sentence names only the array branch.
  if (sent('system')) {
    if (typeof input.system !== 'string' && !Array.isArray(input.system)) {
      throw anthropicFault('system: Input should be a valid array');
    }
    if (Array.isArray(input.system)) {
      input.system.forEach((block, index) => {
        if (!asRecord(block)) throw anthropicFault(`system.${index}: Input does not match the expected shape.`);
      });
    }
  }
  if (sent('thinking')) {
    if (!asRecord(input.thinking)) throw anthropicFault('thinking: Input should be an object');
    if (asRecord(input.thinking)?.type === undefined) throw anthropicFault('thinking.type: Field required');
  }
  if (sent('output_config') && !asRecord(input.output_config)) {
    throw anthropicFault('output_config: Input does not match the expected shape.');
  }
  if (set('cache_control') && !asRecord(input.cache_control)) {
    throw anthropicFault('cache_control: Input should be an object');
  }

  if (!sent('max_tokens')) throw anthropicFault('max_tokens: Field required');
  if (!Number.isInteger(input.max_tokens)) throw anthropicFault('max_tokens: Input should be a valid integer');
  // 0 is accepted by the direct API, measured; the floor is 0, not 1.
  if ((input.max_tokens as number) < 0) throw anthropicFault('max_tokens: must be greater than or equal to 0');

  if (set('metadata')) {
    const metadata = asRecord(input.metadata);
    if (!metadata) throw anthropicFault('metadata: Input does not match the expected shape.');
    for (const key of Object.keys(metadata)) {
      if (key !== 'user_id') throw anthropicFault(`metadata.${key}: Extra inputs are not permitted`);
    }
    if (metadata.user_id !== undefined && metadata.user_id !== null && typeof metadata.user_id !== 'string') {
      throw anthropicFault('metadata.user_id: Input should be a valid string');
    }
  }
  if (set('stop_sequences')) {
    if (!Array.isArray(input.stop_sequences)) throw anthropicFault('stop_sequences: Input should be a valid array');
    input.stop_sequences.forEach((member, index) => {
      if (typeof member !== 'string') throw anthropicFault(`stop_sequences.${index}: Input should be a valid string`);
    });
  }
  for (const field of ['temperature'] as const) {
    if (!sent(field)) continue;
    if (typeof input[field] !== 'number' || !Number.isFinite(input[field])) {
      throw anthropicFault(`${field}: Input should be a valid number`);
    }
    if ((input[field] as number) < 0 || (input[field] as number) > 1) throw anthropicFault(`${field}: range: 0..1`);
  }
  if (sent('service_tier') && !ANTHROPIC_SERVICE_TIERS.some((tier) => tier === input.service_tier)) {
    throw anthropicFault(`service_tier: Input should be ${listOfQuoted(ANTHROPIC_SERVICE_TIERS, 'or')}`);
  }
  if (sent('top_k') && !Number.isInteger(input.top_k)) throw anthropicFault('top_k: Input should be a valid integer');
  if (sent('top_p')) {
    if (typeof input.top_p !== 'number' || !Number.isFinite(input.top_p)) {
      throw anthropicFault('top_p: Input should be a valid number');
    }
    if (input.top_p < 0 || input.top_p > 1) throw anthropicFault('top_p: range: 0..1');
  }
  if (sent('stream') && typeof input.stream !== 'boolean') throw anthropicFault('stream: Input should be a valid boolean');
  if (set('container') && typeof input.container !== 'string' && !asRecord(input.container)) {
    throw anthropicFault('container.ContainerParams: Input does not match the expected shape.');
  }
  if (set('inference_geo')) {
    if (typeof input.inference_geo !== 'string') throw anthropicFault('inference_geo: Input should be a valid string');
    if (!ANTHROPIC_INFERENCE_GEOS.some((geo) => geo === input.inference_geo)) {
      throw anthropicFault("inference_geo: must be one of ['global', 'us']");
    }
  }

}

/**
 * The two phases that follow every known field's validation, in the order they
 * were measured: an unknown key beats the `container` refusal, and every known
 * field's fault beats them both — which is why the nested readers
 * (`readAnthropicThinking`, `readAnthropicEffort`, ...) run before this.
 */
function refuseAnthropicUnknownAndContainer(input: Record<string, unknown>): void {
  rejectUnknownAnthropicKeys(input);
  // Measured 2026-08-31: the conversation-shape rules below sit HERE — after
  // every field's type check and after the unknown-key refusal, and before the
  // container one. `messages: [{role:'user',content:[]}]` with `temperature:
  // 'x'` answers about `temperature`; with `zzz_unknown: 1` it answers about
  // the unknown key; with `container: 'x'` it answers about the messages.
  refuseAnthropicMessageShape(input.messages);
  // The direct API allows a container only alongside the code execution tool,
  // which this proxy does not serve, so every value gets that refusal.
  if (input.container !== undefined && input.container !== null) {
    throw anthropicFault('container: Container identifier can only be provided when using the code execution tool');
  }
}

/** A message's content counted the way the non-empty rules count it. */
function anthropicContentLength(value: unknown): number | null {
  if (typeof value === 'string') return value.length;
  if (Array.isArray(value)) return value.length;
  return null;
}

/** Every text this item contributes, so a whitespace-only item can be spotted. */
function anthropicItemTexts(content: unknown): string[] {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    const block = asRecord(part);
    return block?.type === 'text' && typeof block.text === 'string' ? [block.text] : [];
  });
}

const SYSTEM_ITEM_SUFFIX = '; the directive-only form (content: [] with output_config) is accepted at any position';

/** A system item takes these blocks and no others (measured 2026-08-31). */
const ANTHROPIC_SYSTEM_ITEM_BLOCKS = ['text', 'tool_addition', 'tool_removal'] as const;

/**
 * The rules about the conversation's SHAPE rather than any one item's schema:
 * where a `system` item may sit, and which turns may be empty. All measured on
 * the direct API 2026-08-31, all in this phase.
 *
 * - A `system` item at index 0 is refused with guidance toward the top-level
 *   parameter.
 * - A `system` item's content must be non-empty and must carry non-whitespace
 *   text, at EVERY index — including the one at 0, whose emptiness is reported
 *   before the top-level-parameter guidance.
 * - The last `system` item of a consecutive run must precede an `assistant`
 *   message or end the array. (`[user, system, user]` is refused; `[user,
 *   system]`, `[user, system, system]` and `[user, system, assistant, user]`
 *   are not.)
 * - A `user` turn may be empty as long as the consecutive run it belongs to is
 *   not: `[user:[], user:'ping']` is accepted and `[user:'ping', assistant,
 *   user:[]]` is not, reported at the run's first empty item.
 *
 * NOT mirrored, and why: a `system` item must also FOLLOW a user message or an
 * assistant message ending in a SERVER TOOL RESULT (`[user, assistant, system]`
 * is refused). The exemption turns on server-side tool results this proxy never
 * produces, so refusing on the rule's main clause would refuse bodies the
 * direct API accepts — the one failure this surface must not have. Recorded in
 * §5.5.7 instead.
 */
function refuseAnthropicMessageShape(value: unknown): void {
  if (!Array.isArray(value)) return;
  const roleAt = (index: number): unknown => asRecord(value[index])?.role;
  for (const [index, item] of value.entries()) {
    const message = asRecord(item);
    if (!message) continue;
    const length = anthropicContentLength(message.content);
    if (message.role === 'system') {
      // Measured order within one system item: empty content, then the block
      // types, then the index-0 guidance, then position, then whitespace.
      // `[user, system([image]), user]` answers about the BLOCK where the
      // position is also wrong, and `[user, system('  '), user]` answers about
      // POSITION where only the whitespace is.
      if (length === 0) {
        throw anthropicFault(`messages.${index}: system content must contain at least one block`);
      }
      if (Array.isArray(message.content) && message.content.some((part) => {
        const type = asRecord(part)?.type;
        return type !== undefined && !ANTHROPIC_SYSTEM_ITEM_BLOCKS.some((allowed) => allowed === type);
      })) {
        throw anthropicFault(
          `messages.${index}: role 'system' supports ${listOfQuoted(ANTHROPIC_SYSTEM_ITEM_BLOCKS, 'and').replace(/'/g, '')} blocks only`,
        );
      }
      if (index === 0) {
        throw anthropicFault(
          `messages.0: use the top-level 'system' parameter for the initial system prompt${SYSTEM_ITEM_SUFFIX}`,
        );
      }
      // A run of system items is one block; only where it ENDS is constrained.
      const next = roleAt(index + 1);
      if (next !== undefined && next !== 'system' && next !== 'assistant') {
        throw anthropicFault(
          `messages.${index}: role 'system' must precede an 'assistant' message or end the array${SYSTEM_ITEM_SUFFIX}`,
        );
      }
      if (length !== null && anthropicItemTexts(message.content).some((text) => !text.trim())) {
        throw anthropicFault(`messages.${index}: system text blocks must contain non-whitespace text`);
      }
      continue;
    }
    if (message.role !== 'user' || length !== 0) continue;
    // The run this empty item belongs to. Consecutive same-role items are one
    // turn, so `[user:[], user:'ping']` has content and is accepted.
    let end = index;
    while (roleAt(end + 1) === 'user') end += 1;
    const runHasContent = value.slice(index, end + 1)
      .some((sibling) => (anthropicContentLength(asRecord(sibling)?.content) ?? 1) > 0);
    if (runHasContent) continue;
    // Reported at the run's FIRST empty item, which is where the scan is only
    // when nothing before it in the run had content.
    const startsRun = roleAt(index - 1) !== 'user';
    if (startsRun) {
      throw anthropicFault(`messages.${index}: user messages must have non-empty content`);
    }
  }
}

function validateAnthropicToolChoice(value: unknown): void {
  const choice = asRecord(value);
  if (!choice) throw anthropicFault('tool_choice: Input should be an object');
  if (choice.type === undefined) throw anthropicFault('tool_choice.type: Field required');
  if (!ANTHROPIC_TOOL_CHOICE_TYPES.some((type) => type === choice.type)) {
    throw anthropicFault(
      `tool_choice: Input tag '${String(choice.type)}' found using 'type' does not match any of the expected tags: ${listOfQuoted(ANTHROPIC_TOOL_CHOICE_TYPES, 'or').replace(" or ", ", ")}`,
    );
  }
}

function validateAnthropicMessageItem(item: unknown, index: number): void {
  const message = asRecord(item);
  if (!message) throw anthropicFault(`messages.${index}: Input should be an object`);
  if (message.role === undefined) throw anthropicFault(`messages.${index}.role: Field required`);
  // `system` is a recognized role with a rule of its own, and only at index 0:
  // there it is refused with guidance toward the top-level parameter, and
  // ANYWHERE ELSE it is accepted (measured — a system message at index 1
  // returns 200). This proxy used to refuse it at every position.
  // `system` is a recognized role whose rules are POSITIONAL, and positional
  // rules are decided in a later phase (`refuseAnthropicMessageShape`) — a
  // `temperature` type fault and an unknown top-level key both beat them
  // (measured). Everything else about the item is this phase's business, and
  // applies to a system item exactly as it does to a user one.
  if (message.role !== 'system' && !ANTHROPIC_ROLES.some((role) => role === message.role)) {
    throw anthropicFault(`messages: Unexpected role "${String(message.role)}". Allowed roles are "user" or "assistant"`);
  }
  if (message.content === undefined) throw anthropicFault(`messages.${index}.content: Field required`);
  // A string is accepted; the type sentence names only the array branch, as
  // `system`'s does. `null`, a number and an object all get it (measured).
  if (typeof message.content !== 'string' && !Array.isArray(message.content)) {
    throw anthropicFault(`messages.${index}.content: Input should be a valid array`);
  }
  if (Array.isArray(message.content)) {
    message.content.forEach((block, at) => {
      if (!asRecord(block)) throw anthropicFault(`messages.${index}.content.${at}: Input should be an object`);
      if (asRecord(block)?.type === undefined) {
        throw anthropicFault(`messages.${index}.content.${at}.type: Field required`);
      }
    });
  }
  for (const key of Object.keys(message)) {
    if (!ANTHROPIC_MESSAGE_ITEM_KEYS.has(key)) {
      throw anthropicFault(`messages.${index}.${key}: Extra inputs are not permitted`);
    }
  }
}

export function normalizeAnthropicMessagesRequest(body: unknown): NormalizedRequest {
  const input = objectBody(body);
  // One walk, in the measured order, before any of the body is read: the
  // checks used to be spread through the normalization below, which reported
  // an optional field's fault ahead of a missing `model` and let several known
  // fields through unvalidated (`stream: "yes"` became buffered mode).
  validateAnthropicMessagesFields(input);
  const messages: NormalizedMessage[] = [];
  const system = flattenAnthropicSystem(input.system);
  if (system) messages.push({ role: 'system', content: system, images: [] });
  messages.push(...readAnthropicMessages(input.messages));
  const outputConfig = asRecord(input.output_config);
  const maxTokens = input.max_tokens as number;
  const stopSequences = Array.isArray(input.stop_sequences) ? (input.stop_sequences as string[]) : [];
  // `thinking` is read before any `output_config` leaf: measured, a bad
  // `thinking.type` beats a bad `output_config.effort`.
  const thinking = readAnthropicThinking(input.thinking, maxTokens);
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
  const model = input.model as string;
  const effort = readAnthropicEffort(outputConfig?.effort);
  const taskBudgetTokens = readAnthropicTaskBudget(outputConfig?.task_budget);
  refuseAnthropicUnknownAndContainer(input);
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
    ...(stopSequences.length > 0 ? { stopSequences } : {}),
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
 * `stop_sequences` as the direct API takes them (measured 2026-08-30): an
 * array of strings, empty allowed. A non-array is `Input should be a valid
 * array`, a non-string member names its own index. Unlike every other key on
 * this surface these are REALIZED — see `stop-sequences.ts`.
 */
function readAnthropicStopSequences(value: unknown): readonly string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ProxyRequestError('stop_sequences: Input should be a valid array', 400, 'anthropic');
  }
  value.forEach((member, index) => {
    if (typeof member !== 'string') {
      throw new ProxyRequestError(`stop_sequences.${index}: Input should be a valid string`, 400, 'anthropic');
    }
  });
  return value as string[];
}

/**
 * The keys the direct Messages API accepts, validated as it validates them and
 * then NOT applied — no local runtime has a tier, a region or a code-execution
 * container. Measured 2026-08-30; the sentences are the direct API's own.
 *
 * `container` is the one that is always refused: the direct API allows it only
 * alongside the code execution tool, which this proxy does not serve, so every
 * value gets the refusal the direct API gives for a container without it.
 */
function validateAnthropicAcceptedFields(input: Record<string, unknown>): void {
  if (input.metadata !== undefined && input.metadata !== null) {
    const metadata = asRecord(input.metadata);
    if (!metadata) {
      throw new ProxyRequestError('metadata: Input should be a valid dictionary', 400, 'anthropic');
    }
    for (const key of Object.keys(metadata)) {
      if (key !== 'user_id') {
        throw new ProxyRequestError(`metadata.${key}: Extra inputs are not permitted`, 400, 'anthropic');
      }
    }
    if (metadata.user_id !== undefined && metadata.user_id !== null && typeof metadata.user_id !== 'string') {
      throw new ProxyRequestError('metadata.user_id: Input should be a valid string', 400, 'anthropic');
    }
  }
  if (input.service_tier !== undefined && input.service_tier !== 'auto' && input.service_tier !== 'standard_only') {
    throw new ProxyRequestError("service_tier: Input should be 'auto' or 'standard_only'", 400, 'anthropic');
  }
  if (input.inference_geo !== undefined && input.inference_geo !== 'global' && input.inference_geo !== 'us') {
    throw new ProxyRequestError("inference_geo: must be one of ['global', 'us']", 400, 'anthropic');
  }
  if (input.container !== undefined && input.container !== null) {
    throw new ProxyRequestError(
      'container: Container identifier can only be provided when using the code execution tool',
      400,
      'anthropic',
    );
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
    validateOpenAiChatToolCalls(msg, index, role);
    const content = flattenOpenAiMessage(msg, role);
    return {
      role,
      content: content.text,
      images: content.images,
      ...(content.tool ? { tool: content.tool } : {}),
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
 * `content`'s TYPE, at the `messages` position: a string or an array of parts,
 * on any role. Absence and `null` are not this check's business — they are
 * required-ness, decided last, in `refuseOpenAiChatMissingContent`.
 */
function requireOpenAiChatContent(msg: Record<string, unknown>, index: number): void {
  const content = msg.content;
  if (content === undefined || content === null) return;
  if (typeof content === 'string' || Array.isArray(content)) return;
  throw invalidType(`messages[${index}].content`, 'one of a string or array of objects', content);
}

/**
 * An assistant message's `tool_calls`, at the `messages` position.
 *
 * Measured 2026-08-31: an empty array is its own refusal with its own code, and
 * it fires even when the message also carries content — so it is not part of
 * the content rules and cannot be read as one of their substitutes. It is
 * assistant-only: `tool_calls: []` on a user message is a 200, because the user
 * schema has no such member and this surface ignores members it does not know.
 * Within the item it comes after the role and the content TYPE, and before the
 * required-ness check that runs last of all.
 */
function validateOpenAiChatToolCalls(
  msg: Record<string, unknown>,
  index: number,
  role: NormalizedMessage['role'],
): void {
  const calls = msg.tool_calls;
  if (role !== 'assistant' || calls === undefined || calls === null) return;
  if (!Array.isArray(calls)) throw invalidType(`messages[${index}].tool_calls`, 'an array of objects', calls);
  if (calls.length === 0) {
    throw new ProxyRequestError(
      `Invalid 'messages[${index}].tool_calls': empty array. Expected an array with minimum length 1, but got an empty array instead.`,
      400, 'openai', 'invalid_request_error', `messages[${index}].tool_calls`, 'empty_array',
    );
  }
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
  return value.flatMap((item, index) => {
    const msg = asRecord(item);
    if (!msg) {
      throw new ProxyRequestError(`input[${index}] must be an object.`, 400);
    }
    const content = flattenResponsesMessage(msg);
    // An item this runtime cannot replay carries nothing a turn can be built
    // from. It used to fall through to stringifying the ITEM, which put
    // `{"id":"rs_…","type":"reasoning","summary":[]}` in front of the model as
    // a USER message — and feeding `output` back as `input` is the documented
    // way to hold a conversation on a surface that stores none, so the proxy
    // was corrupting its own round trip.
    if (content === null) return [];
    return [{
      role: readResponsesRole(msg, index),
      content: content.text,
      images: content.images,
      ...(content.tool ? { tool: content.tool } : {}),
    }];
  });
}

/**
 * The direct API is strict inside an input item too, not only at the top level
 * (measured: `input[0].bogus` answers `unknown_parameter` with that exact
 * param). Only MESSAGE items are checked here — a typed item belongs to a
 * union that grows with the API, and pinning its members would 400 tomorrow's
 * valid items for no measurement's sake.
 */
const OPENAI_RESPONSES_MESSAGE_KEYS: ReadonlySet<string> = new Set(['type', 'role', 'content', 'status', 'id']);
/**
 * `phase` belongs to an ASSISTANT message item and to no other (measured): the
 * direct API emits it on the items it produces and takes them back verbatim,
 * while the same member on a user item is `unknown_parameter`. Refusing it
 * everywhere made this proxy reject its own output — and feeding `output` back
 * as input is how a client holds a conversation on a surface that stores none.
 */
const OPENAI_RESPONSES_ASSISTANT_KEYS: ReadonlySet<string> = new Set(['phase']);
const OPENAI_RESPONSES_PHASES = ['commentary', 'final_answer'] as const;
const OPENAI_RESPONSES_ROLES = ['assistant', 'system', 'developer', 'user'] as const;
/** The item union the direct API prints when `type` is not one of them. */
const OPENAI_RESPONSES_ITEM_TYPES = [
  'additional_tools', 'agent_message', 'apply_patch_call', 'apply_patch_call_output',
  'code_interpreter_call', 'compaction', 'compaction_trigger', 'computer_call',
  'computer_call_output', 'custom_tool_call', 'custom_tool_call_output', 'file_search_call',
  'function_call', 'function_call_output', 'image_generation_call', 'item_reference',
  'local_shell_call', 'local_shell_call_output', 'mcp_approval_request', 'mcp_approval_response',
  'mcp_call', 'mcp_list_tools', 'message', 'multi_agent_call', 'multi_agent_call_output',
  'program', 'program_output', 'reasoning', 'shell_call', 'shell_call_output', 'tool_search_call',
  'tool_search_output', 'web_search_call',
] as const;
/**
 * Content blocks answer in two steps (measured): a type outside the WHOLE union
 * names `content[N].type` and lists all nine, while a type inside the union but
 * outside this role's variant names `content[N]` and lists that variant's own.
 */
const OPENAI_RESPONSES_CONTENT_TYPES = [
  'input_text', 'input_image', 'input_audio', 'output_text', 'refusal', 'input_file',
  'computer_screenshot', 'summary_text', 'encrypted_content',
] as const;
const OPENAI_RESPONSES_INPUT_BLOCKS = ['input_text', 'input_image', 'input_file', 'scoped_content', 'input_audio'] as const;
const OPENAI_RESPONSES_OUTPUT_BLOCKS = ['output_text', 'refusal'] as const;
const OPENAI_RESPONSES_TEXT_KEYS: ReadonlySet<string> = new Set(['format', 'verbosity']);
// This surface lists the three formats in its own order — not Chat's.
const OPENAI_RESPONSES_FORMATS = ['json_object', 'text', 'json_schema'] as const;

/**
 * A whole input item, at the `input` slot of the measured order. All of this
 * used to live in `readResponsesInput`, which runs AFTER the field walk, the
 * server-state phase and the capability pass — so a malformed item lost to a
 * bad `truncation`, to an unknown `previous_response_id`, and to a refused
 * `temperature`, and answered in five sentences no measurement backs.
 */
function validateOpenAiResponsesInputItem(item: unknown, index: number): void {
  const msg = asRecord(item);
  if (!msg) throw invalidType(`input[${index}]`, 'an input item', item);
  const shown = (value: unknown): string => (typeof value === 'string' ? value : '');
  if (msg.type !== undefined && !OPENAI_RESPONSES_ITEM_TYPES.some((type) => type === msg.type)) {
    throw invalidValue(`input[${index}]`, shown(msg.type), OPENAI_RESPONSES_ITEM_TYPES);
  }
  // A typed item that is not a message belongs to a union that grows with the
  // API; pinning its members here would refuse tomorrow's valid items.
  if (msg.type !== undefined && msg.type !== 'message') return;
  if (!OPENAI_RESPONSES_ROLES.some((role) => role === msg.role)) {
    throw invalidValue(`input[${index}]`, shown(msg.role), OPENAI_RESPONSES_ROLES);
  }
  if (msg.content === undefined) throw missingRequiredParameter(`input[${index}].content`);
  rejectUnknownResponsesMessageKeys(msg, index);
  if (!Array.isArray(msg.content)) return;
  const allowed = msg.role === 'assistant' ? OPENAI_RESPONSES_OUTPUT_BLOCKS : OPENAI_RESPONSES_INPUT_BLOCKS;
  msg.content.forEach((part, at) => {
    const block = asRecord(part);
    const where = `input[${index}].content[${at}]`;
    if (!block) throw invalidType(where, 'a content block', part);
    if (!OPENAI_RESPONSES_CONTENT_TYPES.some((type) => type === block.type)) {
      throw invalidValue(`${where}.type`, shown(block.type), OPENAI_RESPONSES_CONTENT_TYPES);
    }
    if (!allowed.some((type) => type === block.type)) {
      throw invalidValue(where, shown(block.type), allowed);
    }
    if (block.type === 'input_text' && block.text === undefined) {
      throw missingRequiredParameter(`${where}.text`);
    }
  });
}

/** The `text` slot: its member set, its format union and its verbosity enum. */
function validateOpenAiResponsesText(value: unknown): void {
  const text = asRecord(value);
  if (!text) throw invalidType('text', 'an object', value);
  for (const key of Object.keys(text)) {
    if (!OPENAI_RESPONSES_TEXT_KEYS.has(key)) throw unknownParameter(`text.${key}`);
  }
  if (text.format !== undefined && text.format !== null) {
    const format = asRecord(text.format);
    if (!format) throw invalidType('text.format', 'an object', text.format);
    if (!OPENAI_RESPONSES_FORMATS.some((type) => type === format.type)) {
      throw invalidValue('text.format.type', typeof format.type === 'string' ? format.type : '', OPENAI_RESPONSES_FORMATS);
    }
    // The proxy used to run a `json_schema` format with no schema and no name
    // at all — structured output the caller asked for and never got.
    if (format.type === 'json_schema' && typeof format.name !== 'string') {
      throw missingRequiredParameter('text.format.name');
    }
  }
  if (text.verbosity !== undefined && text.verbosity !== null
      && !OPENAI_CHAT_VERBOSITIES.some((level) => level === text.verbosity)) {
    throw invalidValue('text.verbosity', typeof text.verbosity === 'string' ? text.verbosity : '', OPENAI_CHAT_VERBOSITIES);
  }
}

function rejectUnknownResponsesMessageKeys(msg: Record<string, unknown>, index: number): void {
  if (msg.type !== undefined && msg.type !== 'message') return;
  const assistant = msg.role === 'assistant';
  for (const key of Object.keys(msg)) {
    if (OPENAI_RESPONSES_MESSAGE_KEYS.has(key)) continue;
    if (assistant && OPENAI_RESPONSES_ASSISTANT_KEYS.has(key)) continue;
    throw unknownParameter(`input[${index}].${key}`);
  }
  if (assistant && msg.phase !== undefined && !OPENAI_RESPONSES_PHASES.some((phase) => phase === msg.phase)) {
    throw invalidValue(`input[${index}].phase`, String(msg.phase), OPENAI_RESPONSES_PHASES);
  }
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

/**
 * Reads messages the walk has already validated. It used to validate them a
 * second time with sentences of its own — two validators for one contract, and
 * the second one refused `role: "system"` at every position, which the direct
 * API accepts anywhere but the head.
 */
function readAnthropicMessages(value: unknown): NormalizedMessage[] {
  const items = (value as unknown[]).map((item) => {
    const msg = asRecord(item) as Record<string, unknown>;
    const flattened = flattenAnthropicMessage(msg);
    return {
      message: {
        role: msg.role as NormalizedMessage['role'],
        content: flattened.text,
        images: flattened.images,
        ...(flattened.tool ? { tool: flattened.tool } : {}),
      },
      // Emptiness is measured ONCE, on the content the client sent, by the
      // function the shape validator measures it with.
      empty: contributesNothing(msg.content),
    };
  });
  return items
    .filter((_item, index) => !isAbsorbedEmptyItem(items, index))
    .map((item) => item.message);
}

interface AnthropicTurnItem {
  readonly message: NormalizedMessage;
  readonly empty: boolean;
}

/**
 * Nothing for a backend to say — judged the way `refuseAnthropicMessageShape`
 * judges it, from the CONTENT THE CLIENT SENT.
 *
 * It used to be `content.trim() === ''` on the flattened TEXT, and the two
 * disagreed: `anthropicContentLength('   ')` is 3, so the validator accepts
 * `[user:'   ', user:'PING']` as a run with content — and the merge then erased
 * the three spaces as if the item were empty, dropping a body the validator had
 * just called non-empty. One question, one answer: whatever the validator
 * counts as content is content here too. The images and the tool turn no longer
 * need a clause of their own — a block carrying either is a block, and the
 * length counts it.
 */
function contributesNothing(content: unknown): boolean {
  return anthropicContentLength(content) === 0;
}

/**
 * Whether an item is an empty part of a turn that has content elsewhere.
 *
 * `refuseAnthropicMessageShape` already treats a consecutive same-role run as
 * ONE turn — measured, and why `[user:[], user:'ping']` is accepted where
 * `[user:[]]` is not. But it merged only to decide acceptance, and the
 * projection then emitted each item as its own backend turn, so that accepted
 * body reached the model as `[{text:''}, {text:'ping'}]` — a leading turn the
 * client never sent, ahead of the one it did.
 *
 * The same merge is applied here, and it takes away only what the client did
 * not send: two NON-EMPTY same-role items are two real turns and both stay, and
 * a run that is empty ALL THE WAY THROUGH is the whole turn, so its items stay
 * too (an empty trailing `assistant` item is a prefill the direct API accepts —
 * matrix §5.5.7 `assistant` 빈 턴).
 */
function isAbsorbedEmptyItem(items: readonly AnthropicTurnItem[], index: number): boolean {
  if (!items[index].empty) return false;
  const { role } = items[index].message;
  let start = index;
  while (start > 0 && items[start - 1].message.role === role) start -= 1;
  let end = index;
  while (end + 1 < items.length && items[end + 1].message.role === role) end += 1;
  return items.slice(start, end + 1).some((sibling) => !sibling.empty);
}

function flattenOpenAiMessage(msg: Record<string, unknown>, role: NormalizedMessage['role']): NormalizedContent {
  const content = flattenOpenAiContent(msg.content);
  // Read once, into structure; the text below is a RENDERING of that structure
  // rather than the place it lives. The two used to be the same thing, so a
  // backend had to parse the rendering back — and could not tell this module's
  // markers from the same characters inside a tool's own output.
  if (role === 'tool') {
    const callId = toolCallId(msg.tool_call_id);
    // The deprecated `function` role lands here — it is a tool result, and it
    // carries a function NAME and no call id at all. There is nothing to pair
    // with, so it is not structure; see `unpairedToolResultText`.
    if (callId === null) {
      return {
        text: unpairedToolResultText(content.text, readOptionalString(msg.name)),
        images: content.images,
      };
    }
    const result: NormalizedToolResult = {
      callId,
      output: content.text,
      ...(content.images.length > 0 ? { images: content.images } : {}),
    };
    return {
      text: renderToolResult(result),
      images: content.images,
      tool: { parts: [{ kind: 'result', result }] },
    };
  }
  // This shape holds the prose and the calls in two separate MEMBERS, so their
  // order is the schema's rather than the client's: `content` first, then
  // `tool_calls`. That is the sequence recorded.
  const parts: NormalizedToolPart[] = [];
  appendToolText(parts, content.text);
  const rendered: string[] = [];
  for (const toolCall of Array.isArray(msg.tool_calls) ? msg.tool_calls : []) {
    const raw = asRecord(toolCall);
    const fn = asRecord(raw?.function);
    const name = readString(fn?.name, 'tool');
    const args = typeof fn?.arguments === 'string' ? fn.arguments : JSON.stringify(fn?.arguments ?? {});
    const id = toolCallId(raw?.id);
    if (id === null) {
      // Into the SEQUENCE, not only into `text`. A backend that has items
      // projects the sequence and never reads `content`, so a block left out of
      // it vanishes on that path — silently, and only when the turn also had a
      // block that DID have an id, which is why it takes a mixed turn to see.
      const unpaired = unpairedToolCallText(name, args);
      appendToolText(parts, unpaired);
      rendered.push(unpaired);
      continue;
    }
    const call: LocalToolCall = { id, name, arguments: args };
    parts.push({ kind: 'call', call });
    rendered.push(renderToolCall(call));
  }
  return {
    text: [content.text, rendered.join('\n')].filter(Boolean).join('\n\n'),
    images: content.images,
    ...toolTurnOf(parts),
  };
}

/**
 * A tool part's own call id, or `null` where the client sent none.
 *
 * A missing id used to be filled in with the literal `'tool_call'`, and the
 * filled-in value was then treated as structure — so an id NOBODY SENT reached
 * the backend as a real pairing. Measured on the real transport:
 * `[user, assistant, {role:'function', name:'f', content:'23C'}]` arrived as a
 * `function_call_output` with `call_id: "tool_call"` answering a call that
 * appears nowhere in `input`. The deprecated `function` role hits this every
 * time, because it carries a NAME and no id at all — but every shape has the
 * same door, on both sides: an id-less `function_call` is a call nothing
 * answers, which is a 400 from that API.
 *
 * It is the same fault as the marker-text forgery this module already closed —
 * an item carrying a call id the client never sent — arriving by a different
 * door, and self-inflicted rather than smuggled in. Nothing may be invented
 * here: a part with no id is not a pairing, so it is not structure.
 */
function toolCallId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

/**
 * A tool call or result with no id to pair it with, written as TEXT and nothing
 * else — no `tool` field, so no backend builds an item from it.
 *
 * The turn still reaches the model whole, in the tool's own voice and under the
 * marker that says whose output it is; what it no longer carries is a call id
 * this proxy made up. The alternatives both invent MORE: fabricating a matching
 * `function_call` invents an assistant turn the model never took, and refusing
 * the body would take back what the `chat-function-role-is-not-refused`
 * divergence exists for — the backends can serve this turn.
 */
function unpairedToolCallText(name: string, args: string): string {
  return [ASSISTANT_TOOL_CALL_MARKER, `name: ${name}`, `arguments: ${args}`].join('\n');
}

function unpairedToolResultText(output: string, name?: string): string {
  return [TOOL_RESULT_MARKER, ...(name ? [`name: ${name}`] : []), output].join('\n');
}

/**
 * The turn, or nothing — presence is the provenance signal.
 *
 * A sequence of pure text is not a tool turn: the field would tell the codex
 * transport to rebuild ordinary prose as tool items, which is the defect the
 * field exists to prevent, pointing the other way.
 */
function toolTurnOf(parts: readonly NormalizedToolPart[]): { tool?: NormalizedToolTurn } {
  return parts.some((part) => part.kind !== 'text') ? { tool: { parts } } : {};
}

/**
 * Adds a run of prose, joining it to the run before it.
 *
 * Adjacent text blocks were one `narration` string joined with a blank line
 * when the turn was three groups; keeping them one part keeps that rendering
 * and keeps "a text part is a RUN" true, so a projection never has to decide
 * how to space two neighbours.
 */
function appendToolText(parts: NormalizedToolPart[], text: string): void {
  if (!text) return;
  const last = parts[parts.length - 1];
  if (last?.kind === 'text') {
    parts[parts.length - 1] = { kind: 'text', text: `${last.text}\n\n${text}` };
    return;
  }
  parts.push({ kind: 'text', text });
}

/** The one place a call is written as text; nothing reads it back. */
function renderToolCall(call: LocalToolCall): string {
  return [
    ASSISTANT_TOOL_CALL_MARKER,
    `id: ${call.id}`,
    `name: ${call.name}`,
    `arguments: ${call.arguments}`,
  ].join('\n');
}

/** The one place a result is written as text; nothing reads it back. */
function renderToolResult(result: NormalizedToolResult): string {
  return [TOOL_RESULT_MARKER, `tool_call_id: ${result.callId}`, result.output].join('\n');
}

/**
 * One input item as a turn, or `null` for an item that is not one.
 *
 * A message item always carries `content` — `validateOpenAiResponsesInputItem`
 * requires it — so an item without one is a typed item of some other kind.
 * There are two kinds of those and they are not the same:
 *
 * A `reasoning` item is STATE. Its `summary` is a rendering of thinking, its
 * `content` is `reasoning_text`, and its `encrypted_content` is opaque to
 * everything but the server that issued it; no runtime here has a slot for any
 * of them, so it replays as nothing. It used to be stringified into a `user`
 * turn, which told the model `{"id":"rs_…","type":"reasoning","summary":[]}` in
 * the user's voice — and reading its `content` as a message's put the chain of
 * thought there instead, which is the same corruption with better grammar.
 *
 * Every other typed item — the hosted-tool calls and their outputs — carries
 * the RESULT of work a previous turn did, which is exactly what a client
 * replays `output` as `input` to preserve. This runtime cannot re-run that
 * work, but the model still has to see it, so it replays as a transcript
 * record: dropping it erased results a client sent on purpose, and calling it
 * a plain user message put a tool's own output in the user's voice.
 *
 * The record carries NO `tool` field, which is the one thing that must not
 * happen to it. That field is a turn's calls and results, and a generic record
 * has neither: while the record was flagged as tool history instead, the
 * default Codex transport parsed its text, found no `tool_call_id:` line and
 * replaced the record with
 * `{"type":"function_call_output","call_id":"tool_call","output":""}` — the
 * result the client sent never reached the model. Marked as a record instead,
 * it survives every consumer: `buildPrompt` and `claudeMessageContentFor`
 * render `content` as it stands, and the Codex transport carries it as an
 * `input_text` message.
 */
function flattenResponsesMessage(msg: Record<string, unknown>): NormalizedContent | null {
  if (msg.type === 'function_call_output') {
    const output = flattenOpenAiContent(msg.output);
    const text = output.text || (typeof msg.output === 'string' ? msg.output : JSON.stringify(msg.output ?? ''));
    const callId = toolCallId(msg.call_id);
    if (callId === null) return { text: unpairedToolResultText(text), images: output.images };
    const result: NormalizedToolResult = {
      callId,
      output: text,
      ...(output.images.length > 0 ? { images: output.images } : {}),
    };
    return {
      text: renderToolResult(result),
      images: output.images,
      tool: { parts: [{ kind: 'result', result }] },
    };
  }
  if (msg.type === 'function_call') {
    const name = readString(msg.name, 'tool');
    const args = typeof msg.arguments === 'string' ? msg.arguments : JSON.stringify(msg.arguments ?? {});
    const id = toolCallId(msg.call_id);
    if (id === null) return { text: unpairedToolCallText(name, args), images: [] };
    const call: LocalToolCall = { id, name, arguments: args };
    return {
      text: renderToolCall(call),
      images: [],
      tool: { parts: [{ kind: 'call', call }] },
    };
  }
  // Keyed on the item's KIND, never on whether it happens to carry a `content`
  // member. `content === undefined` implies "not a message item", but the
  // converse is false and reading it that way was its own corruption: a
  // reasoning item's schema has `content: [{type:'reasoning_text'}]`, so a
  // client replaying one — which the API's own description tells it to do —
  // had the model's chain of thought put in front of it in the USER's voice.
  if (msg.type === undefined || msg.type === 'message') return flattenOpenAiContent(msg.content);
  if (msg.type === 'reasoning') return null;
  return {
    text: [REPLAYED_ITEM_LABEL, `type: ${readString(msg.type, 'item')}`, JSON.stringify(msg)].join('\n'),
    images: [],
  };
}

function flattenAnthropicMessage(msg: Record<string, unknown>): NormalizedContent {
  const value = msg.content;
  if (!Array.isArray(value)) return flattenAnthropicContent(value);
  const images: NormalizedImage[] = [];
  // This shape lists its blocks in ONE array, so the client's own order is
  // readable — and is what the turn records. Bucketing the blocks by kind threw
  // it away: `[tool_use, text, tool_use]` came out as text-then-both-calls.
  const parts: NormalizedToolPart[] = [];
  const text = value.map((part) => {
    const block = asRecord(part);
    if (!block) {
      const rest = String(part ?? '');
      appendToolText(parts, rest);
      return rest;
    }
    if (block.type === 'text' && typeof block.text === 'string') {
      appendToolText(parts, block.text);
      return block.text;
    }
    if (block.type === 'image') {
      const image = readAnthropicImage(block);
      if (image) images.push(image);
      return '';
    }
    if (block.type === 'tool_use') {
      const name = readString(block.name, 'tool');
      const args = JSON.stringify(block.input ?? {});
      const id = toolCallId(block.id);
      if (id === null) {
        const unpaired = unpairedToolCallText(name, args);
        appendToolText(parts, unpaired);
        return unpaired;
      }
      const call: LocalToolCall = { id, name, arguments: args };
      parts.push({ kind: 'call', call });
      return renderToolCall(call);
    }
    if (block.type === 'tool_result') {
      const resultContent = flattenAnthropicContent(block.content);
      images.push(...resultContent.images);
      const callId = toolCallId(block.tool_use_id);
      if (callId === null) {
        const unpaired = unpairedToolResultText(resultContent.text);
        appendToolText(parts, unpaired);
        return unpaired;
      }
      const result: NormalizedToolResult = {
        callId,
        output: resultContent.text,
        // The very same image objects the message-level list holds, so a
        // consumer that walks either one is looking at one picture, not a copy.
        ...(resultContent.images.length > 0 ? { images: resultContent.images } : {}),
      };
      parts.push({ kind: 'result', result });
      return renderToolResult(result);
    }
    return '';
  }).filter(Boolean).join('\n\n');
  // Same rule as the OpenAI shapes: the turn is recorded from the BLOCKS this
  // function read, so a caller who types the same characters into a text block
  // is never mistaken for a tool turn — and neither is a tool whose own output
  // contains them, because that output is one result's `output`, not a boundary.
  return { text, images, ...toolTurnOf(parts) };
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
/**
 * The two surfaces word the same fault differently and name the tool
 * differently, so this takes the surface rather than guessing:
 *
 *   Chat      `expected one of one of 'none', 'auto', or 'required' or object`
 *   Responses `expected one of an object or 'none', 'auto', or 'required'`
 *
 * and the object form is `{type:'function', function:{name}}` on Chat against
 * `{type:'function', name}` on Responses — a Chat-shaped choice sent to
 * Responses names no tool at all.
 */
function readOpenAiToolChoice(
  value: unknown,
  shape: 'openai-chat' | 'openai-responses' = 'openai-chat',
): NormalizedToolChoice {
  if (value === undefined || value === null || value === 'auto') return { type: 'auto' };
  if (value === 'none') return { type: 'none' };
  if (value === 'required') return { type: 'required' };
  if (typeof value === 'string') throw invalidValue('tool_choice', value, OPENAI_TOOL_CHOICE_MODES);
  const choice = asRecord(value);
  if (!choice) {
    const expected = shape === 'openai-chat'
      ? `one of one of ${listOfQuoted(OPENAI_TOOL_CHOICE_MODES, 'or')} or object`
      : `one of an object or ${listOfQuoted(OPENAI_TOOL_CHOICE_MODES, 'or')}`;
    throw invalidType('tool_choice', expected, value);
  }
  if (shape === 'openai-responses') {
    if (typeof choice.name !== 'string') throw missingRequiredParameter('tool_choice.name');
    return { type: 'tool', name: choice.name };
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
