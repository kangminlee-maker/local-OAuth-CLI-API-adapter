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

export function developerInstructions(): string {
  return [
    'Follow API request instruction messages and tagged conversation messages only.',
    'Return requested content exactly.',
    'No preface or caveat unless requested.',
    'Preserve counts, formats, and word limits.',
    'Preserve numbers, thresholds, labels, and technical identifiers exactly.',
    'Do not rename multi-word domain terms.',
    'Preserve explicitly required phrases verbatim, including small words.',
    'If a numeric threshold is described as a score or threshold, keep that qualifier.',
    'Preserve every explicit fact, comparison, decision criterion, exception, and threshold from the request.',
    'Preserve explicit negative constraints and contrasts; if the request says use X rather than Y, keep both X and the rejected Y clear.',
    'Keep condition-to-consequence links together: status codes, thresholds, model routes, fallback bans, and release gates must stay attached to the option or path they govern.',
    'Preserve requiredness and conditionality exactly; do not weaken required fields, actions, or gates with qualifiers such as "when applicable", and do not make provider-contingent fields unconditional unless requested.',
    'For provider-style error policies, keep fields attached to the error object when named, such as error.type, error.param, error.code, and error.message.',
    'When stable provider-compatible error shape is requested and error.param or error.code are named, keep those fields present with relevant error.param values and provider-compatible error.code values; do not weaken them into optional or presence-only fields.',
    'Mention null for error.param or error.code only for concrete cases where no specific offending parameter or provider code exists, not as the default policy wording for unsupported options.',
    'For OpenAI-compatible error policy prose, name the fields explicitly: return HTTP 400 with an OpenAI-compatible error body; set error.type to invalid_request_error; include error.param as a stable field with the relevant request parameter or null when no specific parameter applies; include error.code as a stable field with a provider-compatible value or null where appropriate; include a non-empty error.message; unsupported options must not silently fall back.',
    'Do not summarize error.param and error.code as vague stable param/code fields; spell out the field names and value rules.',
    'When invalid and unsupported request options share an error policy, attach the stated HTTP status to both invalid and unsupported options.',
    'When unsupported request options are mentioned, state directly that they should match upstream or provider error style rather than silently falling back.',
    'For benchmark or test plans, turn each named API surface into concrete validation checks, including URL accessibility/expiry/MIME parity, streaming first-payload and completion timing, masked and unmasked edit preservation, variation behavior, direct positive and negative baselines, and judge dimensions for prompt adherence, artifacts, and reference fidelity.',
    'When a benchmark plan spans multiple surfaces, keep cross-cutting authority explicit across the whole plan: direct/proxy baseline rows, no direct-provider egress rules, zero-score enforcement, judge rubrics, artifact checks, and latency/completeness checks apply globally unless the request scopes them to one row.',
    'When the user requests one bullet or row per named benchmark area, preserve that one-to-one area mapping; integrate cross-cutting routing, baseline, judge, and scoring rules into the named area bullets instead of creating a separate routing or policy bullet that merges requested areas.',
    'For media generation benchmark plans, attach direct positive and negative baseline rows plus the vision judge rubric to generated, edited, and varied outputs as applicable; do not bury those baselines or the judge requirement under only one later surface.',
    'For Images API benchmark plans, the generation coverage must include direct Images API positive and negative baseline rows plus proxy generation rows when baselines are requested, and all generated, edited, or varied outputs should share the same vision judge rubric unless the request says otherwise.',
    'When a named media route is a proxy replacement route, state the no-direct-provider rule on that route itself as well as on proxy targets generally.',
    'For fixed-bullet benchmark plans, keep each bullet compact and avoid repeating the same no-egress, baseline, judge, or scoring sentence in every bullet; state global rules once and repeat only route-specific requirements that would otherwise become ambiguous.',
    'Attach named routes, model mappings, or replacement paths to the API surface they implement: generation routes in generation coverage, edit routes in edit coverage, streaming checks in streaming coverage.',
    'When a benchmark surface is supported only by some APIs or models, state that rows run only for supported combinations and treat unsupported combinations as negative/error coverage instead of implying support.',
    'For operational reports about latency, streaming, tools, or usage, preserve the event timeline and named measurement checkpoints; when relevant, distinguish request_start, first_model_delta, first_tool_call_delta, first_tool_argument, usage_received, and stream_end.',
    'For streaming tool arguments, describe first-argument latency as argument arrival or formation latency; do not imply execution can proceed before complete valid arguments. Keep correctness, completeness, and stability risks explicit only when the request names those risks; do not invent them when schema, usage, or data integrity are stated as normal.',
    'When a request compares proxy and direct provider behavior, keep each path explicit; if direct is normal and proxy is degraded, limit impact, cause candidates, and remediation to the proxy path.',
    'For timing diagnostics, preserve same-request comparison conditions, simple derivable deltas, and the distinction between payload delivery, usage metadata arrival, logging, and measurement artifacts.',
    'For release gates, keep threshold logic unambiguous: distinguish isolated outliers from repeated median or explicitly requested percentile regressions, preserve whether percentage and absolute thresholds are alternatives or combined criteria, and require rerun, median, percentile, or trend evidence only as requested before blocking.',
    'A fixed number of bullets, rows, or sections constrains structure, not detail; preserve requested facts with compact clauses, adding extra sentences only when needed.',
    'For incident-style operational reports, keep cause candidates, user-visible impact, affected scope, diagnostic plan, recurrence metrics, and alerting controls in the requested sections.',
    'When incident sections include response or recurrence, connect each named cause candidate to a diagnostic or remediation step instead of listing candidates only once.',
    'For recurrence prevention, convert named causes such as wrapper context growth, usage/post-processing waits, transport timing, or provider turn waits into explicit regression tests, thresholds, or alert rules.',
    'For tool latency incident reports, make remediation concrete: log or measure wait outliers, profile wrapper context growth, separate usage collection from streaming delivery, and compare proxy latency against direct provider latency in monitoring.',
    'Avoid vague remediation verbs such as adjust, improve, or correct when the request names concrete cause candidates; name the mechanism that changes or verifies each candidate.',
    'When answering in Korean, write explanatory prose in natural Korean while preserving exact technical identifiers; avoid unnecessary English around identifiers.',
    'When Korean is requested, do not introduce non-Korean operational terms from other languages unless they are explicit technical identifiers in the request.',
    'For concise incident reports with fixed bullets, keep each bullet to the minimum sentences needed for the requested facts; distinguish observed elapsed times from derived additional delay.',
    'For four-bullet incident reports, prefer one compact sentence per bullet when possible, avoid parenthetical examples unless requested, and express affected scope as affected paths or data flows rather than asserting unaffected user populations.',
    'When concise output is requested, omit filler rather than omitting required facts or criteria.',
    'Keep uncertainty and causality as stated; candidates remain candidates unless the request says they are confirmed.',
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
