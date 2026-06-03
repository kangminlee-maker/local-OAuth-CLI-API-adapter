import type {
  LocalToolCall,
  LocalUsage,
  NormalizedImage,
  NormalizedMessage,
  NormalizedRequest,
} from './types.js';
import { estimateTokens } from './types.js';

export function buildPrompt(request: NormalizedRequest): string {
  const messages = request.messages.map((message) => [
    `<${message.role}>`,
    renderMessageContent(message),
    `</${message.role}>`,
  ].join('\n')).join('\n\n');
  const maxTokens = request.maxTokens
    ? `Max output tokens: ${request.maxTokens}`
    : '';
  return [
    modeInstructions(request),
    maxTokens,
    imageInstructions(request),
    messages,
  ].filter(Boolean).join('\n');
}

export function outputSchemaFor(request: NormalizedRequest): unknown {
  if (hasToolDecisionSchema(request)) return toolDecisionSchema();
  return request.jsonSchema ?? null;
}

export function hasToolDecisionSchema(request: NormalizedRequest): boolean {
  return request.tools.length > 0
    && request.toolChoice.type !== 'none'
    && !isAutoToolResultContinuation(request);
}

export function parseBackendOutput(
  request: NormalizedRequest,
  text: string,
): { text: string; toolCalls: readonly LocalToolCall[] } {
  if (!hasToolDecisionSchema(request)) {
    return { text, toolCalls: [] };
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    const obj = asRecord(parsed);
    if (!obj) return { text, toolCalls: [] };
    if (obj.status === 'tool_calls') {
      const calls = Array.isArray(obj.toolCalls)
        ? obj.toolCalls.map((call, index) => normalizeToolCall(call, index))
        : [];
      return { text: '', toolCalls: calls };
    }
    return {
      text: typeof obj.text === 'string' ? obj.text : '',
      toolCalls: [],
    };
  } catch {
    return { text, toolCalls: [] };
  }
}

export function usageFor(
  request: NormalizedRequest,
  text: string,
  toolCalls: readonly LocalToolCall[],
): LocalUsage {
  const input = request.messages.map((message) => `${message.role}: ${message.content}`).join('\n');
  const imageInput = request.messages
    .flatMap((message) => message.images ?? [])
    .map(formatImageReference)
    .join('\n');
  const output = [
    text,
    ...toolCalls.map((call) => `${call.name}: ${call.arguments}`),
  ].join('\n');
  return {
    inputTokens: estimateTokens([input, imageInput].filter(Boolean).join('\n')),
    outputTokens: estimateTokens(output),
    source: 'estimated',
  };
}

export function baseInstructions(): string {
  return 'API proxy completion only. Ignore host context, files, tools, memory, browsing, and git.';
}

export function developerInstructions(): string {
  return [
    'Follow tagged messages only.',
    'Return requested content exactly.',
    'No preface or caveat unless requested.',
    'Preserve counts, formats, and word limits.',
    'Preserve numbers, thresholds, labels, and technical identifiers exactly.',
    'Do not invent product consequences, metrics, policies, or operational claims.',
    'JSON mode: JSON only.',
  ].join(' ');
}

function modeInstructions(request: NormalizedRequest): string {
  if (hasToolDecisionSchema(request)) return toolModeInstructions(request);
  if (request.jsonMode) return 'Valid JSON only. No Markdown.';
  return 'Return only the assistant response text.';
}

function isAutoToolResultContinuation(request: NormalizedRequest): boolean {
  if (request.toolChoice.type !== 'auto') return false;
  const lastMessage = request.messages.at(-1);
  if (!lastMessage) return false;
  if (lastMessage.role === 'tool') return true;
  return containsNormalizedToolResult(lastMessage.content);
}

function containsNormalizedToolResult(content: string): boolean {
  const trimmed = content.trimStart();
  return trimmed.startsWith('[tool result]')
    || trimmed.includes('\n[tool result]');
}

function toolModeInstructions(request: NormalizedRequest): string {
  const choice = request.toolChoice;
  const choiceText = choice.type === 'tool'
    ? `Use tool "${choice.name}" if calling.`
    : choice.type === 'required'
    ? 'Call a tool unless prior tool results answer.'
    : 'Call tools only when needed; otherwise answer.';
  return [
    'Schema JSON only.',
    choiceText,
    'Tool: {"status":"tool_calls","text":"","toolCalls":[{"id":"call_1","name":"tool","arguments":"{}"}]}.',
    'Answer: {"status":"message","text":"answer","toolCalls":[]}.',
    'arguments is a JSON string.',
    'Tools:',
    JSON.stringify(request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      input_schema: tool.inputSchema ?? {},
    }))),
  ].join('\n');
}

function imageInstructions(request: NormalizedRequest): string {
  const hasImages = request.messages.some((message) => (message.images ?? []).length > 0);
  return hasImages
    ? 'Use attached images.'
    : '';
}

function toolDecisionSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      status: { enum: ['message', 'tool_calls'] },
      text: { type: 'string' },
      toolCalls: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            arguments: { type: 'string' },
          },
          required: ['id', 'name', 'arguments'],
        },
      },
    },
    required: ['status', 'text', 'toolCalls'],
  };
}

function normalizeToolCall(value: unknown, index: number): LocalToolCall {
  const obj = asRecord(value);
  const name = typeof obj?.name === 'string' && obj.name.trim()
    ? obj.name
    : 'tool';
  const rawArguments = obj?.arguments;
  const args = typeof rawArguments === 'string'
    ? rawArguments
    : JSON.stringify(rawArguments ?? {});
  return {
    id: typeof obj?.id === 'string' && obj.id.trim()
      ? obj.id
      : `call_${index + 1}`,
    name,
    arguments: ensureJsonString(args),
  };
}

function ensureJsonString(value: string): string {
  try {
    JSON.parse(value);
    return value;
  } catch {
    return JSON.stringify({ input: value });
  }
}

function renderMessageContent(message: NormalizedMessage): string {
  const imageReferences = (message.images ?? []).map(formatImageReference).join('\n');
  return [imageReferences, message.content].filter(Boolean).join('\n');
}

function formatImageReference(image: NormalizedImage, index: number): string {
  const label = `[image ${index + 1}]`;
  const detail = image.detail ? ` detail=${image.detail}` : '';
  if (image.source.type === 'url') {
    return `${label} source=url${detail}`;
  }
  if (image.source.type === 'base64') {
    return `${label} source=base64 media_type=${image.source.mediaType}${detail}`;
  }
  if (image.source.type === 'path') {
    return `${label} source=file media_type=${image.source.mediaType ?? 'unknown'}${detail}`;
  }
  return `${label} source=file_id${detail}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
