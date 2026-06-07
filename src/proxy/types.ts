import type { LocalCliChatSessionManager } from '../chat/session-manager.js';

export type ApiShape = 'openai-chat' | 'openai-responses' | 'anthropic-messages';

export type NormalizedReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type NormalizedVerbosity = 'low' | 'medium' | 'high';

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
  readonly stream: boolean;
  readonly streamOptions: NormalizedStreamOptions;
  readonly jsonMode: boolean;
  readonly jsonSchema?: unknown;
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
}

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

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}
