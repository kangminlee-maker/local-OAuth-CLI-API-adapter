import type {
  LocalToolCall,
  LocalUsage,
  NormalizedImage,
  NormalizedMessage,
  NormalizedRequest,
} from './types.js';
import { estimateTokens } from './types.js';

interface BuildPromptOptions {
  readonly includeInstructionMessages?: boolean;
}

export interface ForcedSingleToolCall {
  readonly index: number;
  readonly id: string;
  readonly name: string;
  readonly inputSchema?: unknown;
}

export function buildPrompt(
  request: NormalizedRequest,
  options: BuildPromptOptions = {},
): string {
  const includeInstructionMessages = options.includeInstructionMessages ?? true;
  const messages = request.messages
    .filter((message) => includeInstructionMessages || !isInstructionMessage(message))
    .map((message) => [
    `<${message.role}>`,
    renderMessageContent(message),
    `</${message.role}>`,
  ].join('\n')).join('\n\n');
  return [
    modeInstructions(request),
    maxTokenInstruction(request),
    imageInstructions(request),
    messages,
  ].filter(Boolean).join('\n');
}

export function requestInstructionText(request: NormalizedRequest): string {
  const instructions = request.messages
    .filter(isInstructionMessage)
    .map((message) => [
      `<${message.role}>`,
      message.content,
      `</${message.role}>`,
    ].join('\n'));
  if (instructions.length === 0) return '';
  return [
    'API request instruction messages:',
    ...instructions,
  ].join('\n');
}

export function outputSchemaFor(request: NormalizedRequest): unknown {
  const forcedTool = forcedSingleToolCall(request);
  if (forcedTool) return toolArgumentsSchema(forcedTool);
  if (hasToolDecisionSchema(request)) return toolDecisionSchema();
  return request.jsonSchema ?? null;
}

/**
 * Tools are available for the whole conversation, not just its first turn.
 *
 * A turn that follows a tool result used to be given the plain-text mode, on
 * the reading that a continuation is where the model finally answers. But a
 * model that wants to call another tool there has no structured way to say so:
 * it wrote the call as prose — `{"name":"get_weather","arguments":{…}}` — and
 * the turn came back as `stop_reason: end_turn` with the call stranded in a
 * text block, so every question needing two lookups broke. The decision schema
 * already carries `status: 'message'` for the answer case, so keeping it on
 * costs the continuation nothing and gives the call somewhere to go.
 *
 * A client that wants its own JSON schema honoured on such a turn says so the
 * way the API already allows: `tool_choice: "none"` takes the tools off the
 * table for that turn.
 */
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
  const forcedTool = forcedSingleToolCall(request);
  if (forcedTool) {
    return {
      text: '',
      toolCalls: [{
        id: forcedTool.id,
        name: forcedTool.name,
        arguments: normalizeToolArgumentsText(text),
      }],
    };
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    const obj = asRecord(parsed);
    if (!obj) return { text, toolCalls: [] };
    if (obj.status === 'tool_calls') {
      const calls = Array.isArray(obj.toolCalls)
        ? obj.toolCalls.map((call, index) => normalizeToolCall(call, index))
        : [];
      // The narration that came with the call is part of the turn — every
      // surface reports text alongside tool calls, and dropping it here made
      // this runtime the one that silently did not. The wrapper has a `text`
      // field for exactly this.
      return { text: typeof obj.text === 'string' ? obj.text : '', toolCalls: calls };
    }
    // Only a wrapper this backend produced may be unwrapped. A json-mode client
    // gets its OWN object back from the runtime, and reading that as a wrapper
    // with no `text` field returned an empty answer — the whole reply dropped
    // on the floor. Anything that is not the wrapper is the answer itself.
    if (typeof obj.text === 'string' && obj.status === 'message') {
      return { text: obj.text, toolCalls: [] };
    }
    return { text, toolCalls: [] };
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

// The general request-fidelity rules an API backend owes every caller. Each line
// must hold for any request on any topic. A line that only makes sense for one
// shape of question is tuning the runtime to that question instead of describing
// the contract, and a runtime tuned to the questions it is measured on can no
// longer be measured by them. This block once carried 46 lines; the other 38
// entered in four commits that each edited quality-suite case definitions in the
// same breath, and they named those cases' subject matter directly. One told the
// model to answer a fixed-length report in one sentence per item — and the same
// suite then scored that answer as thinner than the direct-API reference, which
// never saw the instruction. A test asserts that vocabulary stays out of what
// this function returns.
export function developerInstructions(): string {
  return [
    'Follow API request instruction messages and tagged conversation messages only.',
    'Return requested content exactly.',
    'No preface or caveat unless requested.',
    'Preserve counts, formats, and word limits.',
    'Preserve numbers, thresholds, labels, and technical identifiers exactly.',
    'Preserve every explicit fact, comparison, decision criterion, exception, and threshold from the request.',
    'When concise output is requested, omit filler rather than omitting required facts or criteria.',
    'JSON mode: JSON only.',
  ].join(' ');
}

export function claudeSystemPrompt(): string {
  return [
    'You are an API completion backend inside a local proxy.',
    'Treat each user message as a standalone provider API request.',
    'Do not use or mention repository files, git status, host tools, commands, browsing, memory, or inability to inspect them unless the user explicitly asks.',
    developerInstructions(),
  ].join(' ');
}

function modeInstructions(request: NormalizedRequest): string {
  const forcedTool = forcedSingleToolCall(request);
  if (forcedTool) return forcedToolArgumentsInstructions(forcedTool);
  if (hasToolDecisionSchema(request)) return toolModeInstructions(request);
  if (request.jsonMode) return 'Valid JSON only. No Markdown.';
  return 'Return only the assistant response text.';
}

function maxTokenInstruction(request: NormalizedRequest): string {
  if (!request.maxTokens || request.maxTokens > 128) return '';
  return `Output token limit: ${request.maxTokens}.`;
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

export function forcedSingleToolCall(request: NormalizedRequest): ForcedSingleToolCall | null {
  if (request.tools.length === 0) return null;
  if (request.toolChoice.type === 'tool') {
    const name = request.toolChoice.name;
    const tool = request.tools.find((item) => item.name === name);
    return {
      index: 0,
      id: 'call_1',
      name,
      inputSchema: tool?.inputSchema,
    };
  }
  if (request.toolChoice.type === 'required' && request.tools.length === 1) {
    const tool = request.tools[0];
    if (!tool) return null;
    return {
      index: 0,
      id: 'call_1',
      name: tool.name,
      inputSchema: tool.inputSchema,
    };
  }
  return null;
}

function forcedToolArgumentsInstructions(tool: ForcedSingleToolCall): string {
  return [
    'Schema JSON only.',
    `Call tool "${tool.name}".`,
    'Return only the JSON object for that tool\'s arguments.',
    'Do not include status, text, toolCalls, id, name, Markdown, or wrapper fields.',
    'Tool input_schema:',
    JSON.stringify(toolArgumentsSchema(tool)),
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

function toolArgumentsSchema(tool: ForcedSingleToolCall): unknown {
  return tool.inputSchema ?? {
    type: 'object',
    additionalProperties: true,
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

function normalizeToolArgumentsText(value: string): string {
  const trimmed = value.trim();
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return typeof parsed === 'string'
      ? ensureJsonString(parsed)
      : trimmed;
  } catch {
    return ensureJsonString(trimmed);
  }
}

function renderMessageContent(message: NormalizedMessage): string {
  const imageReferences = (message.images ?? []).map(formatImageReference).join('\n');
  return [imageReferences, message.content].filter(Boolean).join('\n');
}

function isInstructionMessage(message: NormalizedMessage): boolean {
  return (
    message.role === 'system'
    || message.role === 'developer'
  ) && message.content.trim() !== ''
    && (message.images ?? []).length === 0;
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
