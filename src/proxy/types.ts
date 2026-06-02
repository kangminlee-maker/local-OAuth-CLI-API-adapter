export type ApiShape = 'openai-chat' | 'openai-responses' | 'anthropic-messages';

export interface NormalizedMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
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

export interface NormalizedRequest {
  readonly shape: ApiShape;
  readonly model: string;
  readonly messages: readonly NormalizedMessage[];
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly stream: boolean;
  readonly jsonMode: boolean;
  readonly jsonSchema?: unknown;
  readonly tools: readonly NormalizedTool[];
  readonly toolChoice: NormalizedToolChoice;
  readonly raw: unknown;
}

export interface LocalUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
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

export type LocalStreamEvent =
  | { readonly type: 'text_delta'; readonly delta: string }
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
  ) {
    super(message);
  }
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}
