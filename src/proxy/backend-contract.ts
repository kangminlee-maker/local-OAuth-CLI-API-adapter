import type {
  LocalToolCall,
  LocalUsage,
  NormalizedRequest,
} from './types.js';
import { estimateTokens } from './types.js';

export function buildPrompt(request: NormalizedRequest): string {
  const hasCallableTools = hasToolDecisionSchema(request);
  const mode = hasCallableTools
    ? toolModeInstructions(request)
    : request.jsonMode
    ? 'Return only valid JSON. Do not wrap it in Markdown.'
    : 'Return only the assistant response text.';
  const messages = request.messages.map((message) => [
    `<${message.role}>`,
    message.content,
    `</${message.role}>`,
  ].join('\n')).join('\n\n');
  const maxTokens = request.maxTokens
    ? `\nApproximate max output tokens: ${request.maxTokens}`
    : '';
  return [
    'Handle this local API-compatible request.',
    mode,
    'Do not run commands, edit files, browse, or call host tools.',
    maxTokens,
    '',
    messages,
  ].join('\n');
}

export function outputSchemaFor(request: NormalizedRequest): unknown {
  if (hasToolDecisionSchema(request)) return toolDecisionSchema();
  return request.jsonSchema ?? null;
}

export function hasToolDecisionSchema(request: NormalizedRequest): boolean {
  return request.tools.length > 0 && request.toolChoice.type !== 'none';
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
  const output = [
    text,
    ...toolCalls.map((call) => `${call.name}: ${call.arguments}`),
  ].join('\n');
  return {
    inputTokens: estimateTokens(input),
    outputTokens: estimateTokens(output),
  };
}

export function baseInstructions(): string {
  return [
    'You are a local API-compatible text generation backend.',
    'Follow the current request only.',
    'Do not retain or reuse prior request content.',
    'Do not execute commands, edit files, browse, or call tools unless explicitly supported by this proxy.',
  ].join('\n');
}

export function developerInstructions(): string {
  return [
    'The caller expects an API-shaped response from the wrapper.',
    'Return exactly the content requested by the current turn.',
    'For JSON mode, return valid JSON only.',
  ].join('\n');
}

function toolModeInstructions(request: NormalizedRequest): string {
  const choice = request.toolChoice;
  const choiceText = choice.type === 'tool'
    ? `You must request the tool named "${choice.name}" if a tool call is needed.`
    : choice.type === 'required'
    ? 'You must request at least one tool call unless the conversation already contains sufficient tool results.'
    : 'Request tool calls only when needed. If tool results are already provided and sufficient, answer normally.';
  return [
    'You may request client-provided tools, but you must not execute them yourself.',
    choiceText,
    'Return JSON matching the provided schema.',
    'Use status "tool_calls" to ask the client to run tools.',
    'Use status "message" to return a final assistant response.',
    'For every tool call, set arguments to a JSON string, not an object.',
    '',
    'Available tools:',
    JSON.stringify(request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      input_schema: tool.inputSchema ?? {},
    })), null, 2),
  ].join('\n');
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

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
