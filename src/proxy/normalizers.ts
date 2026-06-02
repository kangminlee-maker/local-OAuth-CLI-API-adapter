import { fileURLToPath } from 'node:url';
import type {
  NormalizedImage,
  NormalizedImageDetail,
  NormalizedMessage,
  NormalizedRequest,
  NormalizedTool,
  NormalizedToolChoice,
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
    model: readString(input.model, 'codex-app-server'),
    messages,
    maxTokens: readOptionalNumber(input.max_tokens ?? input.max_completion_tokens),
    temperature: readOptionalNumber(input.temperature),
    stream: input.stream === true,
    jsonMode: isOpenAiJsonMode(input.response_format),
    jsonSchema: readOpenAiJsonSchema(input.response_format),
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
  return {
    shape: 'openai-responses',
    model: readString(input.model, 'codex-app-server'),
    messages,
    maxTokens: readOptionalNumber(input.max_output_tokens),
    temperature: readOptionalNumber(input.temperature),
    stream: input.stream === true,
    jsonMode: format?.type === 'json_object' || format?.type === 'json_schema',
    jsonSchema: format?.schema,
    tools: readOpenAiTools(input.tools),
    toolChoice: readOpenAiToolChoice(input.tool_choice),
    raw: body,
  };
}

export function normalizeAnthropicMessagesRequest(body: unknown): NormalizedRequest {
  const input = objectBody(body);
  const messages: NormalizedMessage[] = [];
  const system = flattenAnthropicSystem(input.system);
  if (system) messages.push({ role: 'system', content: system, images: [] });
  messages.push(...readAnthropicMessages(input.messages));
  return {
    shape: 'anthropic-messages',
    model: readString(input.model, 'codex-app-server'),
    messages,
    maxTokens: readOptionalNumber(input.max_tokens),
    temperature: readOptionalNumber(input.temperature),
    stream: input.stream === true,
    jsonMode: false,
    tools: readAnthropicTools(input.tools),
    toolChoice: readAnthropicToolChoice(input.tool_choice),
    raw: body,
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
  return value.map((item) => {
    const msg = asRecord(item);
    if (!msg) throw new ProxyRequestError('Each message must be an object.', 400);
    const role = readRole(msg.role);
    const content = flattenOpenAiMessage(msg);
    return {
      role,
      content: content.text,
      images: content.images,
    };
  });
}

function readResponsesInput(value: unknown): NormalizedMessage[] {
  if (typeof value === 'string') return [{ role: 'user', content: value, images: [] }];
  if (!Array.isArray(value)) return [{ role: 'user', content: '', images: [] }];
  return value.map((item) => {
    const msg = asRecord(item);
    if (!msg) {
      return { role: 'user' as const, content: String(item ?? ''), images: [] };
    }
    const content = flattenResponsesMessage(msg);
    return {
      role: readRole(msg.role ?? 'user'),
      content: content.text,
      images: content.images,
    };
  });
}

function readAnthropicMessages(value: unknown): NormalizedMessage[] {
  if (!Array.isArray(value)) {
    throw new ProxyRequestError('messages must be an array.', 400, 'anthropic');
  }
  return value.map((item) => {
    const msg = asRecord(item);
    if (!msg) throw new ProxyRequestError('Each message must be an object.', 400, 'anthropic');
    const role = msg.role === 'assistant' ? 'assistant' : 'user';
    const content = flattenAnthropicMessage(msg);
    return {
      role,
      content: content.text,
      images: content.images,
    };
  });
}

function flattenOpenAiMessage(msg: Record<string, unknown>): NormalizedContent {
  const role = readRole(msg.role);
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

function readRole(value: unknown): NormalizedMessage['role'] {
  if (value === 'system' || value === 'user' || value === 'assistant' || value === 'tool') {
    return value;
  }
  return 'user';
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
