import type {
  LocalTextRun,
  LocalToolCall,
  LocalUsage,
  NormalizedImage,
  NormalizedMessage,
  NormalizedRequest,
} from './types.js';
import { estimateTokens, ProxyRequestError } from './types.js';
// The tool grammar has ONE writer. A prompt that spelled `[tool result]` and
// `[assistant tool_call]` itself would be a second, and a grammar with two
// writers drifts.
import { renderToolCall, renderToolResult } from './normalizers.js';
import { wrapperCallsPrecedeText,
  callNameIsDeclared,
} from './tool-wrapper.js';

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
  // `[image N]` is counted over the WHOLE request, because the array it names
  // is: every backend that renders this prompt hoists the pictures with one
  // flat walk of `request.messages`. Numbered per message instead, two turns
  // carrying one picture each both said `[image 1]` — two different pictures,
  // one name, and a model told `[image 1]` twice cannot tell which sentence is
  // about which. The count runs over every message, including the instruction
  // turns a caller may drop from the text: they carry no pictures, so dropping
  // them cannot shift a number, and counting them keeps this walk and the
  // hoisting walk the same walk.
  let imageOrdinal = 0;
  const rendered: string[] = [];
  for (const message of request.messages) {
    const firstImage = imageOrdinal;
    imageOrdinal += (message.images ?? []).length;
    if (!includeInstructionMessages && isInstructionMessage(message)) continue;
    rendered.push([
      `<${message.role}>`,
      renderMessageContent(message, firstImage),
      `</${message.role}>`,
    ].join('\n'));
  }
  const messages = rendered.join('\n\n');
  return [
    modeInstructions(request),
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

/**
 * Whether this turn's `tool_choice` obliges the model to call something.
 *
 * Anthropic's `any` normalizes to `required`, so one predicate covers all
 * three surfaces.
 */
export function toolChoiceRequiresCall(request: NormalizedRequest): boolean {
  return request.tools.length > 0 && request.toolChoice.type === 'required';
}

/**
 * The runtime schema for the turn — the channel that makes an accepted option
 * actually happen, rather than a sentence asking for it.
 *
 * Two of these were missing, and both failures had the same shape: the option
 * was accepted, a prompt sentence asked for it, and a backend that ignored the
 * sentence produced a 200 that broke the promise.
 *
 * - `tool_choice: "required"` with ONE tool was already forced through
 *   `toolArgumentsSchema`. With two or more it fell through to the plain
 *   decision schema, which permits `status: "message"` — so `required` could
 *   answer without calling anything.
 * - `json_object` produced no schema at all (`jsonSchema` is undefined without
 *   an explicit one), so only the prompt asked for JSON. `CodexBackendTransport`
 *   has always sent the native `text.format: {type:"json_object"}`, so the two
 *   other backends were the ones diverging.
 */
export function outputSchemaFor(request: NormalizedRequest): unknown {
  const forcedTool = forcedSingleToolCall(request);
  if (forcedTool) return toolArgumentsSchema(forcedTool);
  if (hasToolDecisionSchema(request)) return toolDecisionSchema(request);
  if (request.jsonSchema) return request.jsonSchema;
  // `json_object` is "any JSON object", and that is exactly what the direct
  // API enforces: asked for the array `[1,2,3]` under this format it answered
  // `{"0":1,"1":2,"2":3}` (measured 2026-09-02). A bare object schema says the
  // same thing, and the same probe through `claude --json-schema` reproduced
  // the direct answer against a prompt begging for prose.
  if (request.jsonMode) return { type: 'object' };
  return null;
}

/**
 * The names this turn's runtime schema allows a call to carry, or null when
 * the turn constrains none.
 *
 * `toolDecisionSchema` already builds this enum and hands it to the runtime.
 * The response path did not check it, and neither did the incremental reader,
 * so a wrapper naming `never_declared` was published as an executable call on
 * both — "a call the client never declared is not a call it can answer", and
 * the client has no way to answer it. Both readers take the set from here so
 * they cannot decide it differently.
 *
 * A forced single tool is not included: that path names the call itself and
 * never reads a name off the wrapper.
 */
export function declaredToolNames(request: NormalizedRequest): ReadonlySet<string> | null {
  if (!hasToolDecisionSchema(request)) return null;
  const names = request.tools.map((tool) => tool.name).filter((name) => name.trim() !== '');
  return names.length > 0 ? new Set(names) : null;
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

/**
 * Where the wrapper's narration sits among its calls.
 *
 * Both ordered surfaces report a turn's parts in production order, and they
 * read it from `textRuns` — which only `CodexBackendTransport` ever set, so
 * the wrapper backends' bodies reported `[text, call]` for a turn whose stream
 * had said `[call, text]`: the same turn, two orders.
 *
 * The wrapper's own key order is the artifact every reading of the turn sees,
 * so it is what decides, rather than one path's incidental timing.
 * Both readings go through `wrapperCallsPrecedeText`, the single rule: while
 * the extractor kept a rule of its own — emit whatever the incremental decoder
 * produced first — the two agreed only for some chunkings of the wrapper, and
 * a backend that delivered it in one delta made them contradict each other.
 *
 * The wrapper has ONE `text` field, so a turn it describes has at most one run:
 * either the whole narration precedes every call or it follows every call.
 * That is the wrapper's own limit, not the representation's — a backend that
 * can interleave reports the runs it produced.
 */
function wrapperTextRuns(raw: string, text: string, callCount: number): readonly LocalTextRun[] {
  return [{ text, afterCalls: wrapperCallsPrecedeText(raw) ? callCount : 0 }];
}

/**
 * The runtime schema is the enforcement; this is the backstop behind it.
 *
 * It rejects and never repairs. Under `tool_choice: "required"` the answer is
 * a call, and if the backend returned none the only honest options are an
 * error or an invented call — and inventing one would put a tool invocation
 * the model never made in front of the client. Under a JSON format the answer
 * is JSON, and text that does not parse is not it.
 *
 * A firing backstop means a backend ignored a schema it was handed, so this is
 * an upstream fault (502), reported in the shape of the surface that was called.
 */
function backendContractError(message: string, shape: NormalizedRequest['shape']): ProxyRequestError {
  return shape === 'anthropic-messages'
    ? new ProxyRequestError(message, 502, 'anthropic', 'api_error')
    : new ProxyRequestError(message, 502, 'openai', 'api_error');
}

export function parseBackendOutput(
  request: NormalizedRequest,
  text: string,
): { text: string; toolCalls: readonly LocalToolCall[]; textRuns?: readonly LocalTextRun[] } {
  if (!hasToolDecisionSchema(request)) {
    // Only `json_object` means "any JSON OBJECT". A client that supplied its
    // own `json_schema` gets whatever root that schema declares, and the
    // measurement behind the object rule (asked for `[1,2,3]` under
    // `json_object`, the direct API answered `{"0":1,…}`) was taken for the
    // schemaless format alone. Enforcing it for both made a schema whose root
    // is an array unanswerable: the runtime was handed `{"type":"array"}` and
    // then every array it produced was refused, so the only replies that got
    // through were the ones violating the client's schema.
    if (!answersAsJsonObject(request, text)) {
      throw backendContractError(
        'The local runtime returned output that is not a JSON object for a request that asked for one.',
        request.shape,
      );
    }
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
  // Every path below that yields no call breaks `required`, so the check sits
  // once at the end rather than at each `return`.
  const decided = parseToolDecision(request, text);
  if (toolChoiceRequiresCall(request) && decided.toolCalls.length === 0) {
    throw backendContractError(
      'The local runtime answered without calling a tool for a request that required one.',
      request.shape,
    );
  }
  // The runtime was handed the declared names as an enum; a call outside it is
  // a backend that ignored its schema, which is what this backstop is for. It
  // rejects rather than repairs: renaming the call would put a tool invocation
  // the model never made in front of the client, and dropping it silently
  // would leave a turn that claims to have called something.
  const declared = declaredToolNames(request);
  if (declared && decided.rawNames?.some((name) => !callNameIsDeclared(declared, name))) {
    throw backendContractError(
      'The local runtime called a tool the request never declared.',
      request.shape,
    );
  }
  // `rawNames` is this backstop's evidence, not part of the answer.
  const { rawNames: _rawNames, ...answer } = decided;
  void _rawNames;
  // No object rule here, deliberately. The one structured-output channel is
  // carrying the tool wrapper on this path, so the JSON format never reached
  // the runtime and the model was never asked for it — rejecting the answer
  // would refuse a turn nothing had required anything of. The combination is
  // declared unenforced in the conformance matrix instead. Enforcement and the
  // knob travel together; where there is no knob there is no enforcement, and
  // the matrix says so rather than a check inventing one.
  return answer;
}

function parseToolDecision(
  request: NormalizedRequest,
  text: string,
): {
  text: string;
  toolCalls: readonly LocalToolCall[];
  textRuns?: readonly LocalTextRun[];
  /** Each call's `name` exactly as the backend wrote it, for the declared-name backstop. */
  rawNames?: readonly unknown[];
} {
  // The catch belongs to `JSON.parse` and nothing else. It used to wrap the
  // whole body, so a contract violation raised below was caught by it and
  // turned back into "the answer is the raw text" — the exact leak the throw
  // was added to stop.
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { text, toolCalls: [] };
  }
  {
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
      const narration = typeof obj.text === 'string' ? obj.text : '';
      return {
        text: narration,
        toolCalls: calls,
        rawNames: Array.isArray(obj.toolCalls) ? obj.toolCalls.map((call) => asRecord(call)?.name) : [],
        ...(calls.length > 0 && narration ? { textRuns: wrapperTextRuns(text, narration, calls.length) } : {}),
      };
    }
    // Only a wrapper this backend produced may be unwrapped. Anything that is
    // not the wrapper is the answer itself: reading a non-wrapper object as a
    // wrapper found no `text` field and returned an empty answer — the whole
    // reply dropped on the floor.
    if (typeof obj.text === 'string' && obj.status === 'message') {
      return { text: obj.text, toolCalls: [] };
    }
    // Wrapper-SHAPED but not a wrapper: it carries `toolCalls`, so it is not a
    // client's own object, and its `status` is not one of the two the schema
    // allows. Returning it as the answer handed the client this proxy's
    // internal grammar verbatim — the whole wrapper JSON as the assistant's
    // reply. There is nothing here to repair into an answer, so it is refused.
    // Outside JSON mode only. There, `toolCalls` is an ordinary property name
    // the CLIENT controls, and an object carrying it is its answer — a request
    // for literally `{"toolCalls":[]}` came back 502 as a "malformed wrapper".
    //
    // In JSON mode this cannot be decided here, and the exemption leaks: a
    // turn answering `{"status":"done","text":"…","toolCalls":[]}` is
    // published verbatim, handing a client that asked for JSON against its own
    // schema this proxy's internal grammar. Telling the two apart needs the
    // client's data separated from the wrapper's own, which is the design task
    // the matrix declares — not a predicate that can be written here. Round 12
    // wrote the opposite rationale into this comment while leaving the code as
    // it is; the code is what shipped, and it is what this says now.
    if (!request.jsonMode && Array.isArray(obj.toolCalls)) {
      throw backendContractError(
        'The local runtime returned a tool wrapper with no usable status.',
        request.shape,
      );
    }
    return { text, toolCalls: [] };
  }
}

/**
 * Whether this answer satisfies the turn's JSON format.
 *
 * Only `json_object` means "any JSON OBJECT"; a client that supplied its own
 * `json_schema` gets whatever root that schema declares, and a turn with no
 * JSON format has nothing to satisfy. One predicate, so the two places that
 * enforce it cannot drift — the tool-decision path had no check at all.
 */
function answersAsJsonObject(request: NormalizedRequest, text: string): boolean {
  if (!textMayBeRefused(request)) return true;
  return parsesAsJsonObject(text);
}

/**
 * Whether the response path may refuse this turn's text once it is complete.
 *
 * Only the schemaless `json_object` format can be: a client that supplied its
 * own `json_schema` gets whatever root that schema declares, and the check
 * above exempts it. Three streaming gates had spelled this `!request.jsonMode`,
 * which also held back every explicit client schema — those turns streamed
 * nothing and arrived in one piece, withheld against a refusal that could not
 * happen. One predicate, so a gate cannot drift from what actually refuses.
 */
export function textMayBeRefused(request: NormalizedRequest): boolean {
  return request.jsonMode && request.jsonSchema === undefined;
}

function parsesAsJsonObject(text: string): boolean {
  try {
    return asRecord(JSON.parse(text) as unknown) !== null;
  } catch {
    return false;
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

/*
 * `max_tokens` / `max_output_tokens` has no implementation here, deliberately.
 *
 * This used to append `Output token limit: N.` to the prompt for values <= 128
 * and nothing at all above it. That is asking, and an option is a promise: the
 * request was accepted, echoed back, and never enforced, so a capped turn came
 * back whole with `stop_reason: "end_turn"` and a usage count far above the cap.
 *
 * Neither runtime has a channel for it, measured rather than assumed:
 *   - codex: no upstream cap exists (runtime capability catalog, L2 + L5
 *     negative).
 *   - claude: `CLAUDE_CODE_MAX_OUTPUT_TOKENS` does reach the wire as
 *     `max_tokens`, but the CLI turns hitting that cap into a hard error
 *     ("API Error: Claude's response exceeded the N output token maximum") and
 *     discards the partial text. The direct API returns the partial text with
 *     `stop_reason: "max_tokens"`, so the variable produces an error where the
 *     API produces an answer. Measured 2026-09-02 at 16 and 32.
 *
 * Trimming in the response path is not the third option it looks like: the
 * tokens were generated and billed, so the honest `usage.output_tokens` is the
 * full count, and reporting the cap instead would fabricate a billing number.
 *
 * So the cap is not enforced, and the conformance matrix says so on all three
 * rows rather than claiming support. Anthropic requires the field, so it is
 * still accepted and echoed — what changed is that nothing pretends it acted.
 */

function toolModeInstructions(request: NormalizedRequest): string {
  const choice = request.toolChoice;
  const choiceText = choice.type === 'tool'
    ? `Use tool "${choice.name}" if calling.`
    : choice.type === 'required'
    // Measured against both direct APIs on 2026-09-02: `required` / `any`
    // forces a call even on a continuation that already carries the answer,
    // and even when the prompt begs for no call. The old sentence here told
    // the model the opposite ("unless prior tool results answer"). The schema
    // is what enforces this now; this line only has to stop contradicting it.
    ? 'Always call a tool.'
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

function toolDecisionSchema(request: NormalizedRequest): Record<string, unknown> {
  const mustCall = toolChoiceRequiresCall(request);
  // A call the client never declared is not a call it can answer. Left
  // unconstrained, a model handed a forced-call schema invents one: the
  // 2026-09-02 probe answered `{"status":"tool_calls", ... "name":"NO_TOOL"}`
  // for a tool list of `f1`/`f2`. The direct API picked `f1`.
  const names = request.tools.map((tool) => tool.name);
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      status: { enum: mustCall ? ['tool_calls'] : ['message', 'tool_calls'] },
      text: { type: 'string' },
      toolCalls: {
        type: 'array',
        ...(mustCall ? { minItems: 1 } : {}),
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            ...(names.length > 0 ? { name: { enum: names } } : { name: { type: 'string' } }),
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

/**
 * The forced-tool path's whole answer IS the arguments, and this decides what
 * shape it is reported in — by the OPENING CHARACTER, which is the only part
 * of the decision the streaming reader can know before the answer is complete.
 *
 * It used to decide by whether `JSON.parse` succeeded, and the streamed reader
 * approximated that from the outside with a first-character test. The two
 * agreed on every well-formed payload and came apart on a `{`-opening one that
 * does not parse — a truncated object, a trailing comma: the client
 * accumulated the raw fragment while the body reported
 * `{"input":"{\"city\":\"Seo"}`. Both are unusable, and the reconciler cannot
 * bridge them, so what matters is that one turn reads the same either way.
 *
 * A payload that opens as an object or array is therefore reported as it
 * stands, well-formed or not; only a JSON string (unwrapped) and an answer
 * that is not JSON-shaped at all (wrapped) are rewritten.
 */
function normalizeToolArgumentsText(value: string): string {
  // Leading whitespace only. Trimming the tail as well changed `{"a":1}\n`
  // between one reading of the turn and another for no gain: both parse to
  // the same object, and the bytes the backend wrote are the answer.
  const trimmed = value.replace(/^\s+/, '');
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return trimmed;
  const both = trimmed.trim();
  try {
    const parsed = JSON.parse(both) as unknown;
    return typeof parsed === 'string' ? ensureJsonString(parsed) : both;
  } catch {
    return ensureJsonString(both);
  }
}

/**
 * One message as prompt text, with each picture named WHERE it was sent.
 *
 * This runtime cannot interleave pictures with prose — every picture is hoisted
 * ahead of the whole prompt and only a reference line can say where it sat — so
 * every reference used to sit at the head of the message, ahead of all of its
 * text. A caption written before its picture arrived after it, and two captions
 * for two pictures arrived merged with both references in front of them.
 *
 * `firstImage` is where this message's pictures start in the REQUEST's flat
 * list — the one the runtime is actually handed — so `[image N]` names the Nth
 * picture the runtime received rather than the Nth of this message.
 *
 * A TOOL turn is walked the same way. It used to take the images-first branch
 * on the reading that its calls and results have no text in the sequence — but
 * they do: the grammar's one writer renders them, and this walk calls it. While
 * they did not, the two prompt backends announced every picture at the head of
 * the turn while the codex transport was already sending the client's order, so
 * one conversation reached two backends described differently.
 *
 * A message with no sequence at all — built by hand rather than read from a
 * client body — keeps the images-first shape: there is no client order to
 * preserve and claiming one would invent it.
 */
function renderMessageContent(message: NormalizedMessage, firstImage: number): string {
  const images = message.images ?? [];
  if (images.length === 0) return message.content;
  if (!message.parts) {
    const imageReferences = images
      .map((image, index) => formatImageReference(image, firstImage + index))
      .join('\n');
    return [imageReferences, message.content].filter(Boolean).join('\n');
  }
  const positions = new Map<NormalizedImage, number>();
  images.forEach((image, index) => positions.set(image, firstImage + index));
  // A picture the message's own list does not hold has no number to give, and
  // inventing one would name a picture the runtime never receives.
  const reference = (image: NormalizedImage): string | null => {
    const index = positions.get(image);
    return index === undefined ? null : formatImageReference(image, index);
  };
  const lines: string[] = [];
  for (const part of message.parts) {
    if (part.kind === 'text') {
      if (part.text) lines.push(part.text);
    } else if (part.kind === 'image') {
      const line = reference(part.image);
      if (line) lines.push(line);
    } else if (part.kind === 'call') {
      lines.push(renderToolCall(part.call));
    } else {
      lines.push(renderToolResult(part.result, reference));
    }
  }
  // The separator `content` renders this shape's blocks with: a tool turn's
  // blocks are a blank line apart, an ordinary message's text runs and pictures
  // one line. Adding a picture to a turn must not also re-space the words
  // around it.
  return lines.join(message.tool ? '\n\n' : '\n');
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
