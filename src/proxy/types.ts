import type { LocalCliChatSessionManager } from '../chat/session-manager.js';

export type ApiShape = 'openai-chat' | 'openai-responses' | 'anthropic-messages';

export type NormalizedReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type NormalizedVerbosity = 'low' | 'medium' | 'high';

// Anthropic `output_config.effort` channel (distinct from the OpenAI/codex
// `reasoning_effort` enum: includes `max`, excludes `none`/`minimal`).
export type NormalizedAnthropicEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

// Anthropic `thinking` field, threaded to `claude --thinking`/`--thinking-display`.
// `enabled` is the pre-adaptive extended-thinking mode (still valid on the CLI).
export interface NormalizedThinking {
  readonly type: 'adaptive' | 'enabled' | 'disabled';
  readonly display?: 'summarized' | 'omitted';
  // budget_tokens is validated by the normalizer and deliberately not carried:
  // no backend consumes it — the local runtime governs its own thinking
  // budget, and the pinned CLI's numeric budget controls are inert at runtime.
  // The contract's `thinking` row documents the divergence.
}

/** One result of a tool turn the normalizer flattened. */
export interface NormalizedToolResult {
  readonly callId: string;
  readonly output: string;
  /**
   * The pictures THIS result returned, in the order it carried them.
   *
   * `NormalizedMessage.images` is every image of the message, and a turn
   * answering two parallel calls has two results in it — so the message-level
   * list cannot say which call a picture answers. Reading the FIRST result's
   * call id for all of them labelled both of a turn's pictures with the first
   * call, which is the position-matching the labels exist to end.
   */
  readonly images?: readonly NormalizedImage[];
}

/**
 * One part of a message, in the position the client put it.
 *
 * A `text` part is a run of prose the message carried outside its other blocks;
 * adjacent runs are joined, so no two text parts are ever neighbours.
 *
 * A message is only a TOOL turn when a call or a result is in it — text and
 * pictures alone are an ordinary message, and `tool` stays unset there. The
 * parts are recorded either way: order between a caption and the picture it
 * captions is the client's, whether or not a tool ran.
 */
export type NormalizedPart =
  /** `LocalToolCall` is already this shape — one name for one thing. */
  | { readonly kind: 'call'; readonly call: LocalToolCall }
  | { readonly kind: 'result'; readonly result: NormalizedToolResult }
  /**
   * A picture the turn carried as a block of its OWN — not inside any result,
   * so `NormalizedToolResult.images` cannot hold it and nothing captions it.
   *
   * It is here because a part is what gives a block a POSITION. While the turn
   * recorded nothing for it, every such image was appended after the whole
   * sequence: a client sending `[result c1, image, text, result c2]` had its
   * picture arrive behind c2's output, in an order it never wrote. The image
   * object is the very one `NormalizedMessage.images` holds, so a consumer that
   * walks either one is looking at one picture, not a copy.
   */
  | { readonly kind: 'image'; readonly image: NormalizedImage }
  | { readonly kind: 'text'; readonly text: string };

/**
 * A tool turn as STRUCTURE, recorded where the normalizer already knew it.
 *
 * `content` still renders the same turn as text, because the claude runtime
 * puts `content` in its prompt verbatim and has no items to build. Backends
 * that DO have items build them from here.
 *
 * A SEQUENCE, not groups. It used to be `{calls, results, narration}` — three
 * buckets and one string — which cannot say where the prose sat: the projection
 * had to guess (before the calls, after the results), so a client sending
 * `[call, text, call]` had its text hoisted to the front and `[call, text]` was
 * reordered outright. The same shape defect the turn's own text/tool order had
 * one level up, where a boolean could not express `[call, text, call]` either
 * and became a count. Grouping loses order; a sequence is the order.
 */
export interface NormalizedToolTurn {
  readonly parts: readonly NormalizedPart[];
}

export interface NormalizedMessage {
  readonly role: 'system' | 'developer' | 'user' | 'assistant' | 'tool';
  /**
   * The message as ONE STRING — a rendering of `parts`, not the place its
   * content lives. Every runtime that has no items of its own puts this in a
   * prompt verbatim, so it stays; what it cannot say is where a picture sat.
   */
  readonly content: string;
  /**
   * Every picture of the message, in the order it carried them — the same
   * objects `parts` places, so a consumer that walks either one is looking at
   * one picture, not a copy. Backends that can only hoist pictures ahead of a
   * prompt read this; backends with an ordered input read `parts`.
   */
  readonly images: readonly NormalizedImage[];
  /**
   * The message's content as the SEQUENCE the client sent, when the normalizer
   * read one.
   *
   * `content` is "all the text, joined" and `images` is "the pictures,
   * collected", and between the two of them the order a client wrote is gone:
   * `[picture, "what is this"]` reached the model as the question ahead of the
   * picture, and `["THIS_IS_A", <red>, "THIS_IS_B", <blue>]` reached it as one
   * merged caption with both pictures behind it — nothing saying which caption
   * belonged to which picture, so the model could only match them by position.
   * That is the position-matching the tool-result labels exist to end, arriving
   * one level up.
   *
   * The same sequence a tool turn already records — one concept, not two: when
   * `tool` is set it holds THIS ARRAY, so the two views cannot disagree.
   *
   * Absent on a message built by hand rather than read from a client body.
   * `messageParts` derives the legacy order for those, so a consumer never has
   * two code paths.
   */
  readonly parts?: readonly NormalizedPart[];
  /**
   * Set only when the normalizer itself flattened a tool turn into this text,
   * and carrying that turn's own parts in the order the client sent them.
   *
   * PRESENCE is the provenance signal, and it means the same thing under the
   * sequence as it did under the groups: a turn with at least one call or one
   * result in it. Prose alone never sets the field, so an ordinary message is
   * never mistaken for tool history.
   *
   * It began as a boolean saying "this proxy wrote the grammar", because
   * downstream readers used to decide by looking for the marker in the text —
   * which a caller can write, so a user message beginning `[tool result]` became
   * a `function_call_output` with an empty body. But a flag bounds who wrote the
   * text, not WHERE the grammar is: a GENUINE tool result whose OUTPUT carried
   * those lines — a fetched page, a file, a command's stdout, none of it authored
   * by the client — was re-parsed into a second result under a call id nobody
   * sent, and the real output was truncated at the marker. Provenance is not a
   * prefix, and structure is not text: this field carries the parse instead of
   * inviting one.
   */
  readonly tool?: NormalizedToolTurn;
}

/**
 * The message's parts, for every consumer that projects a message.
 *
 * A message the normalizer read carries its own sequence. A message built by
 * hand — an instructions turn this proxy synthesizes, a request assembled in a
 * test — carries none, and gets the order those messages have always had:
 * the text, then the pictures. One function, so the fallback is written once
 * and the two shapes never grow separate projections.
 */
export function messageParts(message: NormalizedMessage): readonly NormalizedPart[] {
  if (message.parts) return message.parts;
  const derived: NormalizedPart[] = [];
  if (message.content) derived.push({ kind: 'text', text: message.content });
  for (const image of message.images ?? []) derived.push({ kind: 'image', image });
  return derived;
}

export type NormalizedImageDetail = 'low' | 'high' | 'auto' | 'original';

export type NormalizedImageSource =
  | { readonly type: 'url'; readonly url: string }
  | { readonly type: 'base64'; readonly mediaType: string; readonly data: string }
  | { readonly type: 'path'; readonly path: string; readonly mediaType?: string }
  | { readonly type: 'file_id'; readonly fileId: string };

export interface NormalizedImage {
  readonly source: NormalizedImageSource;
  readonly detail?: NormalizedImageDetail;
  readonly raw: unknown;
}

export interface NormalizedTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
  readonly raw: unknown;
}

export type NormalizedToolChoice =
  | { readonly type: 'auto' }
  | { readonly type: 'none' }
  | { readonly type: 'required' }
  | { readonly type: 'tool'; readonly name: string };

export interface NormalizedStreamOptions {
  readonly includeUsage: boolean;
  readonly includeObfuscation: boolean;
}

export interface NormalizedRequest {
  readonly shape: ApiShape;
  readonly model: string;
  readonly messages: readonly NormalizedMessage[];
  readonly maxTokens?: number;
  readonly reasoningEffort?: NormalizedReasoningEffort;
  readonly verbosity?: NormalizedVerbosity;
  // Anthropic `output_config.effort`, routed to `claude --effort` (claude runtime).
  readonly effort?: NormalizedAnthropicEffort;
  // Anthropic `output_config.task_budget.total`, routed to `claude --task-budget`.
  readonly taskBudgetTokens?: number;
  // Anthropic `thinking`, routed to `claude --thinking`/`--thinking-display`.
  readonly thinking?: NormalizedThinking;
  readonly stream: boolean;
  readonly streamOptions: NormalizedStreamOptions;
  readonly jsonMode: boolean;
  readonly jsonSchema?: unknown;
  // Client-supplied OpenAI `response_format.json_schema` fidelity fields, preserved
  // through to the codex runtime (enforcement is unaffected — codex is always hard).
  readonly jsonSchemaName?: string;
  readonly jsonSchemaStrict?: boolean;
  readonly tools: readonly NormalizedTool[];
  readonly toolChoice: NormalizedToolChoice;
  /**
   * Chat `n`: how many completions the caller asked for, when they asked for
   * more than one. The runtimes have no such slot, so it is realized as that
   * many backend turns — one per `choices[]` entry, which is what the direct
   * API's n independent samples are.
   */
  readonly choices?: number;
  /**
   * Anthropic `stop_sequences`. No runtime carries them, so they are realized
   * on the response path (`stop-sequences.ts`): the text is cut before the
   * first one and the turn reports `stop_sequence`.
   */
  readonly stopSequences?: readonly string[];
  readonly raw: unknown;
}

export interface LocalUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens?: number;
  readonly cachedInputTokens?: number;
  readonly cacheCreationInputTokens?: number;
  readonly cacheReadInputTokens?: number;
  readonly reasoningOutputTokens?: number;
  readonly source?: 'provider' | 'estimated';
  readonly raw?: unknown;
}

export interface LocalToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

/** A reasoning item as the backend reported it; the summary is not carried. */
export interface LocalReasoningItem {
  readonly id?: string;
}

export interface LocalCompletionResult {
  readonly id: string;
  readonly model: string;
  readonly text: string;
  readonly toolCalls: readonly LocalToolCall[];
  /**
   * How many of `toolCalls` the backend produced BEFORE this turn's text.
   * `text` is one flattened string, so this is the only ordering a
   * non-streaming client cannot reconstruct — and the Responses `output` array
   * and the Anthropic `content` array are ordered surfaces, so without it the
   * body contradicts the stream that carried the same turn.
   *
   * A COUNT rather than the boolean this used to be. The boolean could say
   * only "all calls before the text" or "all calls after it", and a turn that
   * ran a call, said something, then ran another call is neither: the stream
   * announced [call, text, call] while the buffered body claimed
   * [call, call, text]. One turn, two orders, on both ordered surfaces.
   *
   * 0 (or absent) means the text came first, which is what a backend that
   * cannot interleave the two always produces; `toolCalls.length` means every
   * call came first.
   */
  readonly textOrdinal?: number;
  /**
   * The reasoning item the backend reported for this turn, when it reported
   * one. Its presence is the fact — a turn that did not reason has no such
   * item, which is what the direct API returns (measured on gpt-5.5: an item
   * whenever `reasoning_tokens > 0`, none at all when zero, and always ahead
   * of the message and the tool calls). A backend that cannot report one omits
   * this, and the surfaces then report no reasoning item rather than inventing
   * one.
   */
  readonly reasoning?: LocalReasoningItem;
  readonly usage: LocalUsage;
  readonly latencyMs: number;
  // CLI-reported stop reason (e.g. end_turn, max_tokens, refusal) when available;
  // mapped onto the Anthropic response `stop_reason` / `stop_details` / `stop_sequence`.
  readonly stopReason?: string;
  readonly stopDetails?: unknown;
  readonly stopSequence?: string | null;
}

export interface OpenAiImageGenerationRequest {
  readonly operation: 'generation' | 'edit';
  readonly model: string;
  readonly prompt: string;
  readonly n: number;
  readonly images: readonly NormalizedImage[];
  readonly mask?: NormalizedImage;
  readonly size?: string;
  readonly quality?: string;
  readonly background?: string;
  readonly outputFormat?: string;
  readonly outputCompression?: number;
  readonly moderation?: string;
  readonly inputFidelity?: string;
  readonly user?: string;
  readonly stream: boolean;
  readonly partialImages: number;
  readonly proxyRoute?: OpenAiImageProxyRoute;
  readonly raw: unknown;
}

export type OpenAiImageProxyVisualClass =
  | 'primitive_flat_shape'
  | 'geometric_icon'
  | 'badge_or_emblem'
  | 'photoreal_raster'
  | 'product_identity'
  | 'reference_or_edit'
  | 'unknown_hybrid';

export type OpenAiImageProxyGeometryMode = 'auto' | 'strict' | 'loose';

export interface OpenAiImageProxyRoute {
  readonly visualClass?: OpenAiImageProxyVisualClass;
  readonly outputFormat?: 'png' | 'jpeg' | 'webp';
  readonly outputCompression?: number;
  readonly geometryMode?: OpenAiImageProxyGeometryMode;
}

export interface OpenAiGeneratedImage {
  readonly b64Json: string;
  readonly revisedPrompt?: string;
}

export interface OpenAiImageGenerationResult {
  readonly created: number;
  readonly images: readonly OpenAiGeneratedImage[];
  readonly background?: string;
  readonly outputFormat?: string;
  readonly quality?: string;
  readonly size?: string;
  readonly usage?: unknown;
  readonly latencyMs: number;
  readonly raw?: unknown;
}

export interface OpenAiImageGenerationStreamEvent {
  readonly type: 'partial_image' | 'completed';
  readonly created: number;
  readonly image: OpenAiGeneratedImage;
  readonly partialImageIndex?: number;
  readonly background?: string;
  readonly outputFormat?: string;
  readonly quality?: string;
  readonly size?: string;
  readonly usage?: unknown;
}

export interface OpenAiImageGenerationClient {
  generate(
    request: OpenAiImageGenerationRequest,
    signal?: AbortSignal,
  ): Promise<OpenAiImageGenerationResult>;
  stream?(
    request: OpenAiImageGenerationRequest,
    signal?: AbortSignal,
  ): AsyncIterable<OpenAiImageGenerationStreamEvent>;
  close?(): Promise<void>;
}

export type LocalStreamEvent =
  | { readonly type: 'text_delta'; readonly delta: string }
  | {
      /**
       * `index` is the tool call's DENSE position among the tool calls of this
       * turn — the same position it will hold in the completed result's
       * `toolCalls` array — never a backend output position. The server pairs
       * streamed deltas with the completed result by this index and re-emits
       * any arguments it thinks were not sent, so a backend that forwards a raw
       * upstream index (one that also counts reasoning or message items) makes
       * the client receive the arguments twice.
       */
      readonly type: 'tool_call_delta';
      readonly index: number;
      readonly id?: string;
      readonly name?: string;
      readonly argumentsDelta?: string;
      /**
       * The backend has delivered this call's arguments in full: nothing more
       * will be sent for it, and what was streamed already equals what the
       * completed result will report. Surfaces that address a tool call as an
       * open region — the Anthropic `content_block` — close it here, so two
       * blocks are never open at once. A backend that cannot say when a call's
       * arguments end omits it, and its calls close at the end of the turn,
       * where the completed result still supplies whatever was not streamed.
       */
      readonly argumentsDone?: true;
    }
  | {
      /**
       * The backend opened a reasoning item. Forwarded so the Responses
       * surface can announce it where the backend put it — first — instead of
       * guessing at the end of the turn. Surfaces with no reasoning item of
       * their own ignore it.
       */
      readonly type: 'reasoning_item';
      readonly id?: string;
    }
  | { readonly type: 'completed'; readonly result: LocalCompletionResult };

export interface LocalCliBackend {
  readonly name: string;
  readonly model: string;
  /**
   * Models this runtime can currently run, for `GET /v1/models`.
   *
   * Optional and best-effort: a backend that cannot enumerate returns null and
   * the endpoint falls back to its single exposed model. Never a hard-coded
   * list — the runtimes advertise their own, so new generations appear without
   * a code change.
   */
  availableModels?(): Promise<readonly string[] | null>;
  /**
   * The model this request will actually run on, resolvable before execution.
   *
   * Lets the response report the executed model instead of echoing the request.
   * Returns null when the runtime's own default applies and its name is unknown
   * to the proxy.
   */
  resolvedModel?(request: NormalizedRequest): Promise<string | null>;
  generate(request: NormalizedRequest, signal?: AbortSignal): Promise<LocalCompletionResult>;
  stream?(
    request: NormalizedRequest,
    signal?: AbortSignal,
  ): AsyncIterable<LocalStreamEvent>;
  close(): Promise<void>;
}

export interface ProxyServerOptions {
  readonly backend: LocalCliBackend;
  readonly imageGenerationClient?: OpenAiImageGenerationClient;
  readonly chatSessionManager?: LocalCliChatSessionManager;
  readonly host: string;
  readonly port: number;
  readonly requestTimeoutMs: number;
  // When set, every request must present this key via `Authorization: Bearer <key>`
  // or `x-api-key: <key>`. The key gates proxy access only; the local CLI backend
  // still authenticates with its own OAuth session.
  readonly authKey?: string;
}

/**
 * Names a backend uses to identify itself when no model is configured. They are
 * not models a client can select, so `GET /v1/models` must not advertise them —
 * advertising a value the proxy would then reject is a contract the client
 * cannot follow.
 */
export const BACKEND_IDENTIFIERS: readonly string[] = [
  'codex-app-server',
  'codex-backend',
  'claude-code-cli',
];

// The ceiling on every client-visible diagnostic. It lives beside the error
// type rather than inside one surface, because its producers are on both sides
// of the HTTP boundary: a model name a client chose, a backend runtime's own
// words, an upstream's prose. One constant rather than one per producer —
// bounding at each source has already been missed once, and a second, tighter
// bound in a backend made raising this one silently do nothing there.
//
// The ceiling bounds GROWTH; it is not a target. It has to clear the longest
// sentence the surfaces this proxy mirrors actually emit, or it turns a
// faithful message into a divergence — which is what 500 did to the Responses
// item-type union (713 characters, measured 2026-08-31, and the parity row
// `responses input item type unknown` is what catches a regression here).
export const MAX_ERROR_MESSAGE_CHARS = 1024;

export class ProxyRequestError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly provider: 'openai' | 'anthropic' = 'openai',
    readonly type = 'invalid_request_error',
    readonly param: string | null = null,
    readonly code: string | null = null,
  ) {
    super(message);
  }
}

/**
 * The request named a model this runtime cannot run. Reported in the error shape
 * of the surface the client called, so an OpenAI client sees `model_not_found`
 * and an Anthropic client sees `not_found_error`.
 */
export function unsupportedModelError(
  model: string,
  shape: ApiShape,
  // Echo the client's own value back; never the locally configured default,
  // which the client did not supply and should not learn about from an error.
  fromRequest = true,
): ProxyRequestError {
  const message = fromRequest
    ? `Model \`${model}\` is not available through this local CLI runtime.`
    : 'The model configured for this local CLI runtime is not available.';
  if (shape === 'anthropic-messages') {
    return new ProxyRequestError(message, 404, 'anthropic', 'not_found_error');
  }
  return new ProxyRequestError(
    message,
    404,
    'openai',
    'invalid_request_error',
    'model',
    'model_not_found',
  );
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}
