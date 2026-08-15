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
}

export function normalizeOpenAiChatRequest(body: unknown): NormalizedRequest {
  const input = objectBody(body);
  const messages = readOpenAiMessages(input.messages);
  const tools = readOpenAiTools(input.tools);
  return {
    shape: 'openai-chat',
    model: readRequiredModel(input.model, 'openai'),
    messages,
    maxTokens: readOptionalNumber(input.max_tokens ?? input.max_completion_tokens),
    temperature: readOptionalNumber(input.temperature),
    reasoningEffort: readOpenAiReasoningEffort(input.reasoning_effort ?? asRecord(input.reasoning)?.effort),
    verbosity: readOpenAiVerbosity(input.verbosity ?? asRecord(input.text)?.verbosity),
    stream: input.stream === true,
    streamOptions: readStreamOptions(input.stream_options),
    jsonMode: isOpenAiJsonMode(input.response_format),
    jsonSchema: readOpenAiJsonSchema(input.response_format),
    jsonSchemaName: readOpenAiJsonSchemaName(input.response_format),
    jsonSchemaStrict: readOpenAiJsonSchemaStrict(input.response_format),
    tools,
    toolChoice: readOpenAiToolChoice(input.tool_choice),
    raw: body,
  };
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
  return {
    shape: 'openai-responses',
    model: readRequiredModel(input.model, 'openai'),
    messages,
    maxTokens: readOptionalNumber(input.max_output_tokens),
    temperature: readOptionalNumber(input.temperature),
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
    raw: body,
  };
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
  const outputConfig = asRecord(input.output_config);
  const outputFormat = readAnthropicOutputFormat(outputConfig?.format);
  const tools = readAnthropicTools(input.tools);
  if (outputFormat !== undefined && tools.length > 0) {
    // The proxy has a single structured-output channel (claude --json-schema); a
    // forced/decision tool schema and output_config.format would collide, so the
    // user's format schema would be silently dropped. Reject instead.
    throw new ProxyRequestError(
      'output_config.format is not supported together with tools.',
      400,
      'anthropic',
    );
  }
  return {
    shape: 'anthropic-messages',
    model: readRequiredModel(input.model, 'anthropic'),
    messages,
    maxTokens: readRequiredMaxTokens(input.max_tokens),
    temperature: readOptionalNumber(input.temperature),
    effort: readAnthropicEffort(outputConfig?.effort),
    taskBudgetTokens: readAnthropicTaskBudget(outputConfig?.task_budget),
    thinking: readAnthropicThinking(input.thinking),
    stream: input.stream === true,
    streamOptions: readStreamOptions(undefined),
    jsonMode: outputFormat !== undefined,
    jsonSchema: outputFormat,
    tools,
    toolChoice: readAnthropicToolChoice(input.tool_choice),
    raw: body,
  };
}

// Anthropic structured outputs: `output_config.format = {type:'json_schema', schema}`
// (accepts a nested `json_schema.schema` variant). A json_schema format with no
// resolvable schema is malformed input, not absence — reject it (fail-loud).
function readAnthropicOutputFormat(value: unknown): unknown {
  const format = asRecord(value);
  if (!format) return undefined;
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

function readAnthropicThinking(value: unknown): NormalizedThinking | undefined {
  if (value === undefined || value === null) return undefined;
  const thinking = asRecord(value);
  const type = thinking?.type;
  if (type !== 'adaptive' && type !== 'enabled' && type !== 'disabled') {
    throw new ProxyRequestError(
      'thinking.type must be one of adaptive, enabled, or disabled.',
      400,
      'anthropic',
    );
  }
  const display = thinking?.display;
  return {
    type,
    // display governs visibility of thinking blocks, which disabled never produces.
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
  if (!Array.isArray(value)) {
    throw new ProxyRequestError('messages must be an array.', 400);
  }
  // `minItems: 1` on the direct API. An empty conversation was reaching the
  // runtime as a turn with nothing in it.
  if (value.length === 0) {
    throw new ProxyRequestError('messages must contain at least one message.', 400);
  }
  return value.map((item, index) => {
    const msg = asRecord(item);
    if (!msg) throw new ProxyRequestError('Each message must be an object.', 400);
    const role = readOpenAiChatRole(msg.role, index);
    requireOpenAiChatContent(msg, index);
    const content = flattenOpenAiMessage(msg, role);
    return {
      role,
      content: content.text,
      images: content.images,
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
  const missing = value === undefined || value === null;
  throw new ProxyRequestError(
    missing
      ? `messages[${index}].role is required.`
      : `messages[${index}].role must be one of system, developer, user, assistant, tool or function.`,
    400,
    'openai',
    'invalid_request_error',
    `messages[${index}].role`,
    missing ? 'missing_required_parameter' : null,
  );
}

/**
 * `content` as the direct API accepts it: a string or an array of parts.
 * An assistant message may omit it (or send null) when it carries `tool_calls`
 * or the deprecated `function_call` instead — the message the client is
 * replaying is the model's own tool-call turn, which has no text. A deprecated
 * `function` message's content is nullable there too.
 */
function requireOpenAiChatContent(msg: Record<string, unknown>, index: number): void {
  const content = msg.content;
  if (typeof content === 'string' || Array.isArray(content)) return;
  const absent = content === undefined || content === null;
  if (absent && msg.role === 'assistant') {
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) return;
    if (asRecord(msg.function_call)) return;
  }
  if (content === null && msg.role === 'function') return;
  throw new ProxyRequestError(
    absent
      ? `messages[${index}].content is required.`
      : `messages[${index}].content must be a string or an array of content parts.`,
    400,
    'openai',
    'invalid_request_error',
    `messages[${index}].content`,
    absent ? 'missing_required_parameter' : null,
  );
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
          '[assistant tool_call]',
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
    };
  }
  return {
    text: [content.text, toolCalls].filter(Boolean).join('\n\n'),
    images: content.images,
  };
}

function flattenResponsesMessage(msg: Record<string, unknown>): NormalizedContent {
  if (msg.type === 'function_call_output') {
    const output = flattenOpenAiContent(msg.output);
    return {
      text: [
        '[tool result]',
        `tool_call_id: ${readString(msg.call_id, 'tool_call')}`,
        output.text || (typeof msg.output === 'string' ? msg.output : JSON.stringify(msg.output ?? '')),
      ].join('\n'),
      images: output.images,
    };
  }
  if (msg.type === 'function_call') {
    return {
      text: [
        '[assistant tool_call]',
        `id: ${readString(msg.call_id, 'tool_call')}`,
        `name: ${readString(msg.name, 'tool')}`,
        `arguments: ${typeof msg.arguments === 'string' ? msg.arguments : JSON.stringify(msg.arguments ?? {})}`,
      ].join('\n'),
      images: [],
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
        '[assistant tool_call]',
        `id: ${readString(block.id, 'tool_call')}`,
        `name: ${readString(block.name, 'tool')}`,
        `arguments: ${JSON.stringify(block.input ?? {})}`,
      ].join('\n');
    }
    if (block.type === 'tool_result') {
      const resultContent = flattenAnthropicContent(block.content);
      images.push(...resultContent.images);
      return [
        '[tool result]',
        `tool_call_id: ${readString(block.tool_use_id, 'tool_call')}`,
        resultContent.text,
      ].join('\n');
    }
    return '';
  }).filter(Boolean).join('\n\n');
  return { text, images };
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

function readOpenAiToolChoice(value: unknown): NormalizedToolChoice {
  if (value === 'none') return { type: 'none' };
  if (value === 'required') return { type: 'required' };
  const choice = asRecord(value);
  const fn = asRecord(choice?.function);
  if (choice?.type === 'function' && typeof fn?.name === 'string') {
    return { type: 'tool', name: fn.name };
  }
  return { type: 'auto' };
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
