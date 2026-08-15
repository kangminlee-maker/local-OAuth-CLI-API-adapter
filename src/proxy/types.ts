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
  // Required by the direct API's `enabled` variant; carried so a backend that
  // can honor it has the number the client chose.
  readonly budgetTokens?: number;
}

export interface NormalizedMessage {
  readonly role: 'system' | 'developer' | 'user' | 'assistant' | 'tool';
  readonly content: string;
  readonly images: readonly NormalizedImage[];
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
  readonly temperature?: number;
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

export interface LocalCompletionResult {
  readonly id: string;
  readonly model: string;
  readonly text: string;
  readonly toolCalls: readonly LocalToolCall[];
  readonly usage: LocalUsage;
  readonly latencyMs: number;
  // CLI-reported stop reason (e.g. end_turn, max_tokens, refusal) when available;
  // mapped onto the Anthropic response `stop_reason` / `stop_details` / `stop_sequence`.
  readonly stopReason?: string;
  readonly stopDetails?: unknown;
  readonly stopSequence?: string | null;
}

export interface OpenAiImageGenerationRequest {
  readonly operation: 'generation' | 'edit' | 'variation';
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
  readonly style?: string;
  readonly user?: string;
  readonly responseFormat: 'b64_json' | 'url';
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
      readonly type: 'tool_call_delta';
      readonly index: number;
      readonly id?: string;
      readonly name?: string;
      readonly argumentsDelta?: string;
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

/**
 * The generated-image store's public surface. The implementation lives with the
 * HTTP server; this names only what the server needs, so a test can inject the
 * same class built with smaller budgets — eviction and pinning are behaviour
 * that HTTP-level tests cannot exercise against the production 128 MiB.
 */
export interface GeneratedImageStoreLike {
  put(b64Json: string, outputFormat: string, pinned?: ReadonlySet<string>): string;
  get(id: string): { readonly bytes: Buffer; readonly contentType: string } | null;
  clear(): void;
}

export interface ProxyServerOptions {
  readonly backend: LocalCliBackend;
  readonly imageGenerationClient?: OpenAiImageGenerationClient;
  readonly chatSessionManager?: LocalCliChatSessionManager;
  readonly generatedImageStore?: GeneratedImageStoreLike;
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
