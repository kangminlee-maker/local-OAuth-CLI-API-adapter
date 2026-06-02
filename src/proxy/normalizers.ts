import type {
  NormalizedMessage,
  NormalizedRequest,
  NormalizedTool,
  NormalizedToolChoice,
} from './types.js';
import { ProxyRequestError } from './types.js';

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
    messages.push({ role: 'system', content: input.instructions });
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
  if (system) messages.push({ role: 'system', content: system });
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
    return {
      role,
      content: flattenOpenAiMessage(msg),
    };
  });
}

function readResponsesInput(value: unknown): NormalizedMessage[] {
  if (typeof value === 'string') return [{ role: 'user', content: value }];
  if (!Array.isArray(value)) return [{ role: 'user', content: '' }];
  return value.map((item) => {
    const msg = asRecord(item);
    if (!msg) {
      return { role: 'user' as const, content: String(item ?? '') };
    }
    return {
      role: readRole(msg.role ?? 'user'),
      content: flattenResponsesMessage(msg),
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
    return {
      role,
      content: flattenAnthropicMessage(msg),
    };
  });
}

function flattenOpenAiMessage(msg: Record<string, unknown>): string {
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
    return [`[tool result]`, `tool_call_id: ${toolCallId}`, content].join('\n');
  }
  return [content, toolCalls].filter(Boolean).join('\n\n');
}

function flattenResponsesMessage(msg: Record<string, unknown>): string {
  if (msg.type === 'function_call_output') {
    return [
      '[tool result]',
      `tool_call_id: ${readString(msg.call_id, 'tool_call')}`,
      typeof msg.output === 'string' ? msg.output : JSON.stringify(msg.output ?? ''),
    ].join('\n');
  }
  if (msg.type === 'function_call') {
    return [
      '[assistant tool_call]',
      `id: ${readString(msg.call_id, 'tool_call')}`,
      `name: ${readString(msg.name, 'tool')}`,
      `arguments: ${typeof msg.arguments === 'string' ? msg.arguments : JSON.stringify(msg.arguments ?? {})}`,
    ].join('\n');
  }
  return flattenOpenAiContent(msg.content ?? msg);
}

function flattenAnthropicMessage(msg: Record<string, unknown>): string {
  const value = msg.content;
  if (!Array.isArray(value)) return flattenAnthropicContent(value);
  return value.map((part) => {
    const block = asRecord(part);
    if (!block) return String(part ?? '');
    if (block.type === 'text' && typeof block.text === 'string') return block.text;
    if (block.type === 'tool_use') {
      return [
        '[assistant tool_call]',
        `id: ${readString(block.id, 'tool_call')}`,
        `name: ${readString(block.name, 'tool')}`,
        `arguments: ${JSON.stringify(block.input ?? {})}`,
      ].join('\n');
    }
    if (block.type === 'tool_result') {
      return [
        '[tool result]',
        `tool_call_id: ${readString(block.tool_use_id, 'tool_call')}`,
        flattenAnthropicContent(block.content),
      ].join('\n');
    }
    return '';
  }).filter(Boolean).join('\n\n');
}

function flattenOpenAiContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return value == null ? '' : JSON.stringify(value);
  return value.map((part) => {
    const block = asRecord(part);
    if (!block) return String(part ?? '');
    if (typeof block.text === 'string') return block.text;
    if (typeof block.input_text === 'string') return block.input_text;
    if (typeof block.content === 'string') return block.content;
    return '';
  }).filter(Boolean).join('\n');
}

function flattenAnthropicSystem(value: unknown): string {
  if (typeof value === 'string') return value;
  return flattenAnthropicContent(value);
}

function flattenAnthropicContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return value == null ? '' : JSON.stringify(value);
  return value.map((part) => {
    const block = asRecord(part);
    if (!block) return String(part ?? '');
    if (block.type === 'text' && typeof block.text === 'string') return block.text;
    return '';
  }).filter(Boolean).join('\n');
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
