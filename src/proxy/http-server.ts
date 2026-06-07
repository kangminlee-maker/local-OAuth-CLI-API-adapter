import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type {
  LocalCliBackend,
  LocalCompletionResult,
  LocalStreamEvent,
  LocalToolCall,
  LocalUsage,
  NormalizedImage,
  NormalizedRequest,
  NormalizedReasoningEffort,
  OpenAiGeneratedImage,
  OpenAiImageGenerationClient,
  OpenAiImageGenerationRequest,
  OpenAiImageGenerationResult,
  OpenAiImageGenerationStreamEvent,
  OpenAiImageProxyRoute,
  ProxyServerOptions,
} from './types.js';
import { ProxyRequestError } from './types.js';
import { unsupportedImageFileIds } from './multimodal.js';
import { hasToolDecisionSchema } from './backend-contract.js';
import { missingToolCallArgumentDelta } from './tool-call-stream.js';
import { image2QualityToGpt55ReasoningEffort } from './image2-via-gpt55.js';
import {
  normalizeAnthropicMessagesRequest,
  normalizeOpenAiChatRequest,
  normalizeOpenAiResponsesRequest,
} from './normalizers.js';
import {
  LocalCliChatError,
  type LocalCliChatCreateInput,
  type LocalCliChatTurnInput,
} from '../chat/types.js';

export interface StartedProxyServer {
  readonly server: Server;
  readonly url: string;
  close(): Promise<void>;
}

type ErrorResponseShape = 'openai' | 'openai-chat' | 'openai-responses' | 'anthropic';
type OpenAiImageOperation = OpenAiImageGenerationRequest['operation'];

const DEFAULT_IMAGE_GENERATION_SIZE = 'auto';
const DEFAULT_IMAGE_GENERATION_QUALITY = 'auto';
const DEFAULT_IMAGE_GENERATION_OUTPUT_FORMAT = 'png';
const DEFAULT_IMAGE_GENERATION_BACKGROUND = 'auto';
const GENERATED_IMAGE_TTL_MS = 60 * 60 * 1000;
const IMAGE_PROXY_VISUAL_CLASSES = [
  'primitive_flat_shape',
  'geometric_icon',
  'badge_or_emblem',
  'photoreal_raster',
  'product_identity',
  'reference_or_edit',
  'unknown_hybrid',
] as const;
const IMAGE_PROXY_GEOMETRY_MODES = ['auto', 'strict', 'loose'] as const;

interface ParsedImageRequestBody {
  readonly body: unknown;
  readonly isMultipart: boolean;
}

export async function startLocalApiProxy(
  options: ProxyServerOptions,
): Promise<StartedProxyServer> {
  const generatedImages = new GeneratedImageStore();
  const server = createServer((req, res) => {
    void handleRequest(req, res, options, generatedImages);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  const actualPort = address && isAddressInfo(address) ? address.port : options.port;
  return {
    server,
    url: `http://${options.host}:${actualPort}`,
    async close() {
      await Promise.all([
        new Promise<void>((resolve, reject) => {
          server.close((err) => err ? reject(err) : resolve());
        }),
        options.backend.close(),
        closeImageGenerationClient(options),
        options.chatSessionManager?.closeAll() ?? Promise.resolve(),
      ]);
      generatedImages.clear();
    },
  };
}

async function closeImageGenerationClient(options: ProxyServerOptions): Promise<void> {
  const imageClient = options.imageGenerationClient;
  if (!imageClient?.close) return;
  if (Object.is(imageClient, options.backend)) return;
  await imageClient.close();
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: ProxyServerOptions,
  generatedImages: GeneratedImageStore,
): Promise<void> {
  const { backend, requestTimeoutMs } = options;
  setCorsHeaders(res);
  let errorShape: ErrorResponseShape = 'openai';
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }
  try {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (path === '/local/cli/sessions' || path.startsWith('/local/cli/sessions/')) {
      await handleLocalCliChatRequest(req, res, options, path);
      return;
    }
    if (req.method === 'GET' && path === '/v1/models') {
      writeJson(res, 200, openAiModelsResponse(backend));
      return;
    }
    if (req.method === 'GET' && path.startsWith('/v1/images/generated/')) {
      writeGeneratedImage(res, generatedImages, path);
      return;
    }
    if (req.method !== 'POST') {
      throw new ProxyRequestError('Unsupported method.', 405);
    }

    if (path === '/v1/images/generations') {
      const { body, isMultipart } = await readImageRequestBody(req);
      const normalized = normalizeOpenAiImageRequest(body, 'generation', isMultipart);
      await handleOpenAiImageRequest(req, res, options, generatedImages, normalized);
      return;
    }
    if (path === '/v1/images/edits') {
      const { body, isMultipart } = await readImageRequestBody(req);
      const normalized = normalizeOpenAiImageRequest(body, 'edit', isMultipart);
      await handleOpenAiImageRequest(req, res, options, generatedImages, normalized);
      return;
    }
    if (path === '/v1/images/variations') {
      const { body, isMultipart } = await readImageRequestBody(req);
      const normalized = normalizeOpenAiImageRequest(body, 'variation', isMultipart);
      await handleOpenAiImageRequest(req, res, options, generatedImages, normalized);
      return;
    }
    const body = await readJsonBody(req);
    if (path === '/v1/chat/completions') {
      errorShape = 'openai-chat';
      const normalized = normalizeOpenAiChatRequest(body);
      rejectDeferredFeatures(normalized);
      if (normalized.stream) {
        await writeOpenAiChatStream(res, runStreamWithTimeout(backend, normalized, requestTimeoutMs), normalized);
      } else {
        const result = await runWithTimeout(backend, normalized, requestTimeoutMs);
        writeJson(res, 200, openAiChatResponse(result));
      }
      return;
    }
    if (path === '/v1/responses') {
      errorShape = 'openai-responses';
      const normalized = normalizeOpenAiResponsesRequest(body);
      rejectDeferredFeatures(normalized);
      if (normalized.stream) {
        await writeOpenAiResponsesStream(res, runStreamWithTimeout(backend, normalized, requestTimeoutMs), normalized);
      } else {
        const result = await runWithTimeout(backend, normalized, requestTimeoutMs);
        writeJson(res, 200, openAiResponsesResponse(result, normalized));
      }
      return;
    }
    if (path === '/v1/messages') {
      errorShape = 'anthropic';
      const normalized = normalizeAnthropicMessagesRequest(body);
      rejectDeferredFeatures(normalized, 'anthropic');
      if (normalized.stream) {
        await writeAnthropicMessagesStream(res, runStreamWithTimeout(backend, normalized, requestTimeoutMs), normalized);
      } else {
        const result = await runWithTimeout(backend, normalized, requestTimeoutMs);
        writeJson(res, 200, anthropicMessagesResponse(result));
      }
      return;
    }

    throw new ProxyRequestError(`Unknown endpoint: ${path}`, 404);
  } catch (err) {
    writeError(res, err, errorShape);
  }
}

async function handleLocalCliChatRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: ProxyServerOptions,
  path: string,
): Promise<void> {
  const manager = options.chatSessionManager;
  if (!manager) {
    throw new ProxyRequestError('Local CLI chat sessions are not enabled for this server.', 501);
  }
  if (path === '/local/cli/sessions' && req.method === 'POST') {
    const body = await readJsonBody(req);
    writeJson(res, 201, await manager.create(asRecordPayload(body) as unknown as LocalCliChatCreateInput));
    return;
  }
  const match = /^\/local\/cli\/sessions\/([^/]+)(?:\/([^/]+))?$/.exec(path);
  if (!match) throw new ProxyRequestError(`Unknown endpoint: ${path}`, 404);
  const sessionId = decodeURIComponent(match[1] ?? '');
  const action = match[2] ? decodeURIComponent(match[2]) : '';
  if (!action && req.method === 'GET') {
    writeJson(res, 200, manager.get(sessionId));
    return;
  }
  if (!action && req.method === 'DELETE') {
    const closed = await manager.close(sessionId);
    writeJson(res, 200, {
      session_id: closed.id,
      status: closed.status,
    });
    return;
  }
  if (action === 'interrupt' && req.method === 'POST') {
    const interrupted = await manager.interrupt(sessionId);
    writeJson(res, 200, {
      session_id: interrupted.id,
      status: 'interrupting',
    });
    return;
  }
  if (action === 'turns' && req.method === 'POST') {
    const body = await readJsonBody(req) as LocalCliChatTurnInput;
    if (body.stream) {
      await writeLocalCliChatStream(res, manager.streamTurn(sessionId, body));
    } else {
      writeJson(res, 200, await manager.runTurn(sessionId, body));
    }
    return;
  }
  throw new ProxyRequestError(`Unsupported local CLI chat endpoint: ${path}`, 404);
}

async function handleOpenAiImageRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: ProxyServerOptions,
  generatedImages: GeneratedImageStore,
  request: OpenAiImageGenerationRequest,
): Promise<void> {
  const client = options.imageGenerationClient ?? unsupportedLocalOAuthImageGenerationClient();
  if (request.stream) {
    await writeOpenAiImageStream(
      req,
      res,
      runImageGenerationStreamWithTimeout(client, request, options.requestTimeoutMs),
      generatedImages,
      request,
    );
    return;
  }
  const result = await runImageGenerationWithTimeout(
    client,
    request,
    options.requestTimeoutMs,
  );
  writeJson(res, 200, openAiImagesGenerationResponse(req, generatedImages, result, request));
}

function normalizeOpenAiImageRequest(
  body: unknown,
  operation: OpenAiImageOperation,
  isMultipart: boolean,
): OpenAiImageGenerationRequest {
  const input = asRecordPayload(body);
  const explicitResponseFormat = Object.prototype.hasOwnProperty.call(input, 'response_format');
  const prompt = imagePrompt(input.prompt, operation);
  if (!prompt.trim()) {
    throw new ProxyRequestError(
      "Missing required parameter: 'prompt'.",
      400,
      'openai',
      'invalid_request_error',
      'prompt',
      'missing_required_parameter',
    );
  }
  if (prompt.length > 32_000) {
    throw new ProxyRequestError('prompt must be 32000 characters or fewer.', 400);
  }
  const responseFormat = typeof input.response_format === 'string'
    ? input.response_format
    : 'b64_json';
  if (responseFormat !== 'b64_json' && responseFormat !== 'url') {
    throw new ProxyRequestError('response_format must be one of url or b64_json.', 400);
  }
  const model = typeof input.model === 'string' && input.model.trim()
    ? input.model
    : 'dall-e-2';
  validateOpenAiImageModelSurface(model, operation, explicitResponseFormat);
  const images = imageInputsForOperation(input, operation, isMultipart);
  if ((operation === 'edit' || operation === 'variation') && images.length === 0) {
    throw new ProxyRequestError('image input is required for image edits and variations.', 400);
  }
  if (operation === 'variation' && !isMultipart) {
    throw new ProxyRequestError('image variations require multipart/form-data with an image file.', 400);
  }
  const proxyRoute = optionalImageProxyRoute(input.x_proxy_image_route);
  const outputFormat = optionalEnum(input.output_format, 'output_format', ['png', 'jpeg', 'webp'])
    ?? proxyRoute?.outputFormat;
  const outputCompression = optionalInteger(input.output_compression, 'output_compression', 0, 100)
    ?? proxyRoute?.outputCompression;
  const request: OpenAiImageGenerationRequest = {
    operation,
    model,
    prompt,
    n: imageGenerationCount(input.n),
    images,
    mask: optionalImageInput(input.mask),
    size: optionalImageSize(input.size),
    quality: optionalEnum(input.quality, 'quality', ['standard', 'hd', 'low', 'medium', 'high', 'auto']),
    background: optionalEnum(input.background, 'background', ['transparent', 'opaque', 'auto']),
    outputFormat,
    outputCompression,
    moderation: optionalEnum(input.moderation, 'moderation', ['low', 'auto']),
    inputFidelity: optionalEnum(input.input_fidelity, 'input_fidelity', ['high', 'low']),
    style: optionalEnum(input.style, 'style', ['vivid', 'natural']),
    user: optionalString(input.user),
    responseFormat,
    stream: optionalBoolean(input.stream, 'stream') ?? false,
    partialImages: partialImageCount(input.partial_images),
    ...(proxyRoute ? { proxyRoute } : {}),
    raw: body,
  };
  validateOpenAiImageRequest(request);
  return request;
}

function validateOpenAiImageModelSurface(
  model: string,
  operation: OpenAiImageOperation,
  explicitResponseFormat: boolean,
): void {
  if (explicitResponseFormat && openAiGptImageModelPattern().test(model)) {
    throw new ProxyRequestError(
      "Unknown parameter: 'response_format'.",
      400,
      'openai',
      'invalid_request_error',
      'response_format',
      'unknown_parameter',
    );
  }
  if (operation === 'variation' && model !== 'dall-e-2' && model !== 'image-2') {
    throw new ProxyRequestError(
      'This endpoint only supports dall-e-2.',
      400,
      'openai',
      'invalid_request_error',
      'model',
      'invalid_value',
    );
  }
}

function openAiGptImageModelPattern(): RegExp {
  return /^gpt-image-/;
}

function validateOpenAiImageRequest(request: OpenAiImageGenerationRequest): void {
  if (
    request.outputCompression !== undefined
    && request.outputFormat !== 'jpeg'
    && request.outputFormat !== 'webp'
  ) {
    throw new ProxyRequestError(
      'Compression less than 100 is not supported for PNG output format',
      400,
      'openai',
      'image_generation_user_error',
      null,
      'invalid_png_output_compression',
    );
  }
  if (request.inputFidelity && request.operation !== 'edit') {
    throw new ProxyRequestError('input_fidelity is only supported for image edits.', 400);
  }
  if (request.model === 'image-2' && request.background === 'transparent') {
    throw new ProxyRequestError(
      'Transparent background is not supported for this model.',
      400,
      'openai',
      'image_generation_user_error',
      'tools',
      'invalid_value',
    );
  }
  if (request.background === 'transparent' && request.outputFormat === 'jpeg') {
    throw new ProxyRequestError('background transparent requires output_format to be png or webp.', 400);
  }
  if (request.model === 'image-2' && request.inputFidelity) {
    throw new ProxyRequestError(
      'input_fidelity is disabled for image-2.',
      400,
      'openai',
      'image_generation_user_error',
      'tools',
      'invalid_input_fidelity_model',
    );
  }
  if (request.style && request.operation !== 'generation') {
    throw new ProxyRequestError('style is only supported for image generations.', 400);
  }
}

function imagePrompt(value: unknown, operation: OpenAiImageOperation): string {
  if (operation === 'variation') return 'Create a variation of the provided image.';
  if (typeof value === 'string' && value.trim()) return value;
  return '';
}

function imageInputsForOperation(
  input: Record<string, unknown>,
  operation: OpenAiImageOperation,
  isMultipart: boolean,
): readonly NormalizedImage[] {
  if (operation === 'generation') return [];
  const value = operation === 'edit' && !isMultipart
    ? input.images
    : input.image ?? input['image[]'] ?? input.images;
  return imageInputArray(value);
}

function imageInputArray(value: unknown): readonly NormalizedImage[] {
  if (Array.isArray(value)) return value.map(optionalImageInput).filter(isNormalizedImage);
  const image = optionalImageInput(value);
  return image ? [image] : [];
}

function optionalImageInput(value: unknown): NormalizedImage | undefined {
  const multipart = asMultipartFile(value);
  if (multipart) {
    return {
      source: {
        type: 'base64',
        mediaType: multipart.mediaType,
        data: multipart.data,
      },
      raw: value,
    };
  }
  if (typeof value === 'string') {
    const image = imageSourceFromUrlLike(value);
    return image ? { ...image, raw: value } : undefined;
  }
  const obj = asRecordPayload(value);
  const fileId = typeof obj.file_id === 'string' && obj.file_id.trim()
    ? obj.file_id.trim()
    : '';
  const imageUrl = typeof obj.image_url === 'string'
    ? obj.image_url
    : typeof asRecordPayload(obj.image_url).url === 'string'
    ? String(asRecordPayload(obj.image_url).url)
    : typeof obj.url === 'string'
    ? obj.url
    : '';
  if (fileId && imageUrl.trim()) {
    throw new ProxyRequestError('image references must provide exactly one of file_id or image_url.', 400);
  }
  if (fileId) {
    return {
      source: { type: 'file_id', fileId },
      raw: value,
    };
  }
  const fromUrl = imageSourceFromUrlLike(imageUrl);
  if (fromUrl) return { ...fromUrl, raw: value };
  if (typeof obj.b64_json === 'string' && obj.b64_json.trim()) {
    return {
      source: {
        type: 'base64',
        mediaType: typeof obj.media_type === 'string' ? obj.media_type : 'image/png',
        data: obj.b64_json.replace(/\s/g, ''),
      },
      raw: value,
    };
  }
  return undefined;
}

function imageSourceFromUrlLike(
  value: string,
): Omit<NormalizedImage, 'raw'> | null {
  const url = value.trim();
  if (!url) return null;
  const dataUrl = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (dataUrl) {
    const mediaType = dataUrl[1]?.trim() || 'image/png';
    const data = dataUrl[2]?.replace(/\s/g, '') ?? '';
    if (!mediaType.startsWith('image/') || !data) return null;
    return {
      source: { type: 'base64', mediaType, data },
    };
  }
  return { source: { type: 'url', url } };
}

function isNormalizedImage(value: NormalizedImage | undefined): value is NormalizedImage {
  return Boolean(value);
}

function imageGenerationCount(value: unknown): number {
  if (value === undefined || value === null) return 1;
  const parsed = optionalInteger(value, 'n', 1, 10);
  if (parsed === undefined) {
    throw new ProxyRequestError('n must be an integer between 1 and 10.', 400);
  }
  return parsed;
}

function partialImageCount(value: unknown): number {
  if (value === undefined || value === null) return 0;
  const parsed = optionalInteger(value, 'partial_images', 0, 3);
  if (parsed === undefined) {
    throw new ProxyRequestError('partial_images must be an integer between 0 and 3.', 400);
  }
  if (parsed > 0) {
    throw new ProxyRequestError(
      'partial_images is not supported by this local image proxy.',
      400,
      'openai',
      'image_generation_user_error',
      'partial_images',
      'unsupported_value',
    );
  }
  return 0;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function optionalEnum<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
): T | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new ProxyRequestError(`${field} must be one of ${allowed.join(', ')}.`, 400);
  }
  return value as T;
}

function optionalInteger(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+$/.test(value.trim())
    ? Number(value.trim())
    : NaN;
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new ProxyRequestError(`${field} must be an integer between ${min} and ${max}.`, 400);
  }
  return parsed;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new ProxyRequestError(`${field} must be a boolean.`, 400);
}

function optionalImageProxyRoute(value: unknown): OpenAiImageProxyRoute | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const input = imageProxyRoutePayload(value);
  const visualClass = optionalEnum(
    input.visual_class,
    'x_proxy_image_route.visual_class',
    IMAGE_PROXY_VISUAL_CLASSES,
  );
  const outputFormat = optionalEnum(
    input.output_format,
    'x_proxy_image_route.output_format',
    ['png', 'jpeg', 'webp'],
  );
  const outputCompression = optionalInteger(
    input.output_compression,
    'x_proxy_image_route.output_compression',
    0,
    100,
  );
  const geometryMode = optionalEnum(
    input.geometry_mode,
    'x_proxy_image_route.geometry_mode',
    IMAGE_PROXY_GEOMETRY_MODES,
  );
  const route: OpenAiImageProxyRoute = {
    ...(visualClass ? { visualClass } : {}),
    ...(outputFormat ? { outputFormat } : {}),
    ...(outputCompression !== undefined ? { outputCompression } : {}),
    ...(geometryMode ? { geometryMode } : {}),
  };
  return Object.keys(route).length > 0 ? route : undefined;
}

function imageProxyRoutePayload(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      throw new ProxyRequestError('x_proxy_image_route must be a JSON object.', 400);
    }
    throw new ProxyRequestError('x_proxy_image_route must be a JSON object.', 400);
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new ProxyRequestError('x_proxy_image_route must be a JSON object.', 400);
}

function optionalImageSize(value: unknown): string | undefined {
  const size = optionalString(value);
  if (!size) return undefined;
  if (size === 'auto') return size;
  const match = /^(\d+)x(\d+)$/.exec(size);
  if (!match) {
    throw new ProxyRequestError('size must be auto or a WIDTHxHEIGHT string.', 400);
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width <= 0 || height <= 0) {
    throw new ProxyRequestError('size width and height must be positive.', 400);
  }
  return size;
}

async function runImageGenerationWithTimeout(
  client: OpenAiImageGenerationClient,
  request: OpenAiImageGenerationRequest,
  requestTimeoutMs: number,
): Promise<OpenAiImageGenerationResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    return await client.generate(request, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function* runImageGenerationStreamWithTimeout(
  client: OpenAiImageGenerationClient,
  request: OpenAiImageGenerationRequest,
  requestTimeoutMs: number,
): AsyncIterable<OpenAiImageGenerationStreamEvent> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    if (client.stream) {
      for await (const event of client.stream(request, controller.signal)) {
        yield event;
      }
      return;
    }
    const result = await client.generate(request, controller.signal);
    for (const [index, image] of result.images.entries()) {
      yield {
        type: 'completed',
        created: result.created,
        image,
        partialImageIndex: index,
        background: result.background,
        outputFormat: result.outputFormat,
        quality: result.quality,
        size: result.size,
        usage: result.usage,
      };
    }
  } finally {
    clearTimeout(timer);
  }
}

function unsupportedLocalOAuthImageGenerationClient(): OpenAiImageGenerationClient {
  const fail = (): never => {
    throw new ProxyRequestError(
      'Images API proxy does not have a local OAuth CLI image-generation backend yet. Direct OpenAI API fallback is disabled.',
      501,
      'openai',
      'unsupported_feature',
    );
  };
  return {
    async generate(): Promise<OpenAiImageGenerationResult> {
      return fail();
    },
    async *stream(): AsyncIterable<OpenAiImageGenerationStreamEvent> {
      fail();
    },
  };
}

export function openAiImageQualityReasoningEffort(
  quality: string | undefined,
): NormalizedReasoningEffort {
  return image2QualityToGpt55ReasoningEffort(quality);
}

async function runWithTimeout(
  backend: LocalCliBackend,
  request: NormalizedRequest,
  requestTimeoutMs: number,
): Promise<LocalCompletionResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    return await backend.generate(request, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function* runStreamWithTimeout(
  backend: LocalCliBackend,
  request: NormalizedRequest,
  requestTimeoutMs: number,
): AsyncIterable<LocalStreamEvent> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    if (backend.stream) {
      for await (const event of backend.stream(request, controller.signal)) {
        yield event;
      }
      return;
    }
    const result = await backend.generate(request, controller.signal);
    yield { type: 'completed', result };
  } finally {
    clearTimeout(timer);
  }
}

function rejectDeferredFeatures(
  request: NormalizedRequest,
  provider: 'openai' | 'anthropic' = 'openai',
): void {
  const fileIds = unsupportedImageFileIds(request);
  if (fileIds.length > 0) {
    throw new ProxyRequestError(
      'file_id image sources are not supported by this local CLI proxy; use an image URL, data URL, or base64 image source.',
      400,
      provider,
    );
  }
}

interface MultipartFilePart {
  readonly filename: string;
  readonly mediaType: string;
  readonly data: string;
}

class GeneratedImageStore {
  private readonly images = new Map<string, {
    readonly bytes: Buffer;
    readonly contentType: string;
    readonly expiresAt: number;
  }>();

  put(b64Json: string, outputFormat: string): string {
    this.cleanupExpired();
    const id = randomUUID();
    this.images.set(id, {
      bytes: Buffer.from(b64Json, 'base64'),
      contentType: imageContentType(outputFormat),
      expiresAt: Date.now() + GENERATED_IMAGE_TTL_MS,
    });
    return id;
  }

  get(id: string): { readonly bytes: Buffer; readonly contentType: string } | null {
    const image = this.images.get(id);
    if (!image) return null;
    if (image.expiresAt <= Date.now()) {
      this.images.delete(id);
      return null;
    }
    return image;
  }

  clear(): void {
    this.images.clear();
  }

  private cleanupExpired(): void {
    const now = Date.now();
    for (const [id, image] of this.images.entries()) {
      if (image.expiresAt <= now) this.images.delete(id);
    }
  }
}

function writeGeneratedImage(
  res: ServerResponse,
  generatedImages: GeneratedImageStore,
  path: string,
): void {
  const id = decodeURIComponent(path.slice('/v1/images/generated/'.length));
  const image = generatedImages.get(id);
  if (!image) {
    writeJson(res, 404, {
      error: {
        message: 'Generated image URL has expired or does not exist.',
        type: 'invalid_request_error',
        param: null,
        code: null,
      },
    });
    return;
  }
  res.writeHead(200, {
    'content-type': image.contentType,
    'cache-control': 'private, max-age=3600',
  });
  res.end(image.bytes);
}

function generatedImageUrl(req: IncomingMessage, id: string): string {
  const host = headerValue(req.headers.host) || '127.0.0.1';
  return `http://${host}/v1/images/generated/${encodeURIComponent(id)}`;
}

function imageContentType(outputFormat: string): string {
  if (outputFormat === 'jpeg' || outputFormat === 'jpg') return 'image/jpeg';
  if (outputFormat === 'webp') return 'image/webp';
  return 'image/png';
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const text = (await readBodyBuffer(req)).toString('utf8');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ProxyRequestError('Request body must be valid JSON.', 400);
  }
}

async function readImageRequestBody(req: IncomingMessage): Promise<ParsedImageRequestBody> {
  const body = await readBodyBuffer(req);
  const contentType = headerValue(req.headers['content-type']);
  if (contentType.toLowerCase().includes('multipart/form-data')) {
    return { body: parseMultipartFormData(body, contentType), isMultipart: true };
  }
  const text = body.toString('utf8');
  if (!text.trim()) return { body: {}, isMultipart: false };
  try {
    return { body: JSON.parse(text), isMultipart: false };
  } catch {
    throw new ProxyRequestError('Request body must be valid JSON or multipart/form-data.', 400);
  }
}

async function readBodyBuffer(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > 50_000_000) {
      throw new ProxyRequestError('Request body is too large.', 413);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function parseMultipartFormData(
  body: Buffer,
  contentType: string,
): Record<string, unknown> {
  const boundary = multipartBoundary(contentType);
  if (!boundary) throw new ProxyRequestError('multipart/form-data boundary is required.', 400);
  const output: Record<string, unknown> = {};
  const binary = body.toString('latin1');
  const parts = binary.split(`--${boundary}`);
  for (const rawPart of parts) {
    if (!rawPart || rawPart === '--\r\n' || rawPart === '--') continue;
    const part = rawPart.startsWith('\r\n') ? rawPart.slice(2) : rawPart;
    if (part.startsWith('--')) continue;
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    const rawHeaders = part.slice(0, headerEnd);
    let rawContent = part.slice(headerEnd + 4);
    if (rawContent.endsWith('\r\n')) rawContent = rawContent.slice(0, -2);
    const headers = multipartHeaders(rawHeaders);
    const disposition = parseContentDisposition(headers['content-disposition']);
    if (!disposition.name) continue;
    const content = Buffer.from(rawContent, 'latin1');
    const value = disposition.filename
      ? {
          filename: disposition.filename,
          mediaType: headers['content-type'] || mediaTypeForFilename(disposition.filename),
          data: content.toString('base64'),
        } satisfies MultipartFilePart
      : content.toString('utf8');
    assignMultipartValue(output, disposition.name, value);
  }
  return output;
}

function multipartBoundary(contentType: string): string | null {
  const match = /(?:^|;)\s*boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  return match?.[1] ?? match?.[2]?.trim() ?? null;
}

function multipartHeaders(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split('\r\n')) {
    const index = line.indexOf(':');
    if (index === -1) continue;
    out[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
  }
  return out;
}

function parseContentDisposition(value: string | undefined): {
  readonly name?: string;
  readonly filename?: string;
} {
  if (!value) return {};
  const out: Record<string, string> = {};
  for (const part of value.split(';').slice(1)) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    let val = part.slice(index + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    out[key] = val;
  }
  return { name: out.name, filename: out.filename };
}

function assignMultipartValue(
  output: Record<string, unknown>,
  name: string,
  value: unknown,
): void {
  const existing = output[name];
  if (existing === undefined) {
    output[name] = value;
  } else if (Array.isArray(existing)) {
    existing.push(value);
  } else {
    output[name] = [existing, value];
  }
}

function asMultipartFile(value: unknown): MultipartFilePart | null {
  const obj = asRecordPayload(value);
  if (
    typeof obj.filename === 'string'
    && typeof obj.mediaType === 'string'
    && typeof obj.data === 'string'
  ) {
    return {
      filename: obj.filename,
      mediaType: obj.mediaType,
      data: obj.data,
    };
  }
  return null;
}

function mediaTypeForFilename(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  return 'image/png';
}

function headerValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function openAiModelsResponse(backend: LocalCliBackend): unknown {
  return {
    object: 'list',
    data: [
      {
        id: backend.model,
        object: 'model',
        created: 0,
        owned_by: 'local-oauth-cli',
      },
    ],
  };
}

function openAiImagesGenerationResponse(
  req: IncomingMessage,
  generatedImages: GeneratedImageStore,
  result: OpenAiImageGenerationResult,
  request: OpenAiImageGenerationRequest,
): unknown {
  return {
    created: result.created,
    data: result.images.map((image) => openAiImageObject(req, generatedImages, image, request)),
    ...openAiImageResponseMetadata(result, request),
    ...(result.usage ? { usage: openAiImagesUsage(result.usage) } : {}),
  };
}

function openAiImageResponseMetadata(
  result: OpenAiImageGenerationResult,
  request: OpenAiImageGenerationRequest,
): Record<string, string> {
  const background = responseBackground(result.background ?? request.background);
  const outputFormat = result.outputFormat ?? request.outputFormat;
  const quality = responseQuality(result.quality ?? request.quality);
  const size = responseSize(result.size ?? request.size);
  return {
    ...(background ? { background } : {}),
    ...(outputFormat ? { output_format: outputFormat } : {}),
    ...(quality ? { quality } : {}),
    ...(size ? { size } : {}),
  };
}

function responseBackground(value: string | undefined): string | undefined {
  return value === 'transparent' || value === 'opaque' ? value : undefined;
}

function responseQuality(value: string | undefined): string | undefined {
  return value === 'low' || value === 'medium' || value === 'high' ? value : undefined;
}

function responseSize(value: string | undefined): string | undefined {
  return value && value !== 'auto' ? value : undefined;
}

function openAiImageObject(
  req: IncomingMessage,
  generatedImages: GeneratedImageStore,
  image: OpenAiGeneratedImage,
  request: OpenAiImageGenerationRequest,
): unknown {
  if (request.responseFormat === 'url') {
    const id = generatedImages.put(
      image.b64Json,
      request.outputFormat ?? DEFAULT_IMAGE_GENERATION_OUTPUT_FORMAT,
    );
    return {
      url: generatedImageUrl(req, id),
      ...(image.revisedPrompt ? { revised_prompt: image.revisedPrompt } : {}),
    };
  }
  return {
    b64_json: image.b64Json,
    ...(image.revisedPrompt ? { revised_prompt: image.revisedPrompt } : {}),
  };
}

async function writeOpenAiImageStream(
  req: IncomingMessage,
  res: ServerResponse,
  events: AsyncIterable<OpenAiImageGenerationStreamEvent>,
  generatedImages: GeneratedImageStore,
  request: OpenAiImageGenerationRequest,
): Promise<void> {
  writeSseHeaders(res);
  try {
    for await (const event of events) {
      if (event.type === 'partial_image') continue;
      const type = imageStreamEventType(request.operation, event.type);
      const payload = {
        type,
        created_at: event.created,
        background: event.background ?? request.background ?? DEFAULT_IMAGE_GENERATION_BACKGROUND,
        output_format: event.outputFormat ?? request.outputFormat ?? DEFAULT_IMAGE_GENERATION_OUTPUT_FORMAT,
        quality: event.quality ?? request.quality ?? DEFAULT_IMAGE_GENERATION_QUALITY,
        size: event.size ?? request.size ?? DEFAULT_IMAGE_GENERATION_SIZE,
        ...(request.responseFormat === 'url'
          ? { url: generatedImageUrl(req, generatedImages.put(event.image.b64Json, request.outputFormat ?? DEFAULT_IMAGE_GENERATION_OUTPUT_FORMAT)) }
          : { b64_json: event.image.b64Json }),
        ...(event.usage ? { usage: openAiImagesUsage(event.usage) } : {}),
      };
      await writeSseEvent(res, type, payload);
    }
  } catch (err) {
    await writeSseEvent(res, 'error', streamErrorPayload(err));
  } finally {
    res.end();
  }
}

function imageStreamEventType(
  operation: OpenAiImageOperation,
  eventType: OpenAiImageGenerationStreamEvent['type'],
): string {
  const prefix = operation === 'edit' || operation === 'variation'
    ? 'image_edit'
    : 'image_generation';
  return eventType === 'partial_image'
    ? `${prefix}.partial_image`
    : `${prefix}.completed`;
}

function openAiChatResponse(result: LocalCompletionResult): unknown {
  const hasToolCalls = result.toolCalls.length > 0;
  return {
    id: `chatcmpl-${result.id}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: result.model,
    choices: [
      {
        index: 0,
        message: hasToolCalls ? {
          role: 'assistant',
          content: null,
          tool_calls: result.toolCalls.map(openAiToolCall),
          refusal: null,
          annotations: [],
        } : {
          role: 'assistant',
          content: result.text,
          refusal: null,
          annotations: [],
        },
        finish_reason: hasToolCalls ? 'tool_calls' : 'stop',
      },
    ],
    usage: openAiChatUsage(result.usage),
    service_tier: 'default',
    system_fingerprint: null,
  };
}

function openAiResponsesResponse(
  result: LocalCompletionResult,
  request: NormalizedRequest,
): unknown {
  const output = result.toolCalls.length > 0
    ? result.toolCalls.map(openAiResponseToolCall)
    : [
        openAiResponseReasoningItem(),
        openAiResponseMessageItem(`msg_${randomUUID()}`, result.text),
      ];
  return openAiResponseObject({
    id: `resp_${result.id}`,
    model: result.model,
    request,
    status: 'completed',
    output,
    usage: openAiResponsesUsage(result.usage),
    completed: true,
  });
}

function anthropicMessagesResponse(result: LocalCompletionResult): unknown {
  const hasToolCalls = result.toolCalls.length > 0;
  return {
    id: `msg_${result.id}`,
    type: 'message',
    role: 'assistant',
    model: result.model,
    content: hasToolCalls
      ? result.toolCalls.map(anthropicToolUse)
      : [
          {
            type: 'text',
            text: result.text,
          },
        ],
    stop_reason: hasToolCalls ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: anthropicUsage(result.usage),
  };
}

function openAiChatUsage(usage: LocalUsage): unknown {
  const promptTokens = openAiInputTokens(usage);
  const completionTokens = usage.outputTokens;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: usage.totalTokens ?? promptTokens + completionTokens,
    prompt_tokens_details: {
      cached_tokens: cachedInputTokens(usage),
      audio_tokens: 0,
    },
    completion_tokens_details: {
      reasoning_tokens: usage.reasoningOutputTokens ?? 0,
      audio_tokens: 0,
      accepted_prediction_tokens: 0,
      rejected_prediction_tokens: 0,
    },
  };
}

function openAiResponsesUsage(usage: LocalUsage): unknown {
  const inputTokens = openAiInputTokens(usage);
  const outputTokens = usage.outputTokens;
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: usage.totalTokens ?? inputTokens + outputTokens,
    input_tokens_details: {
      cached_tokens: cachedInputTokens(usage),
    },
    output_tokens_details: {
      reasoning_tokens: usage.reasoningOutputTokens ?? 0,
    },
  };
}

function openAiImagesUsage(usage: unknown): unknown {
  return isLocalUsage(usage) ? openAiResponsesUsage(usage) : usage;
}

function isLocalUsage(value: unknown): value is LocalUsage {
  const usage = asRecordPayload(value);
  return typeof usage.inputTokens === 'number'
    && typeof usage.outputTokens === 'number';
}

interface OpenAiResponseObjectOptions {
  readonly id: string;
  readonly model: string;
  readonly request: NormalizedRequest;
  readonly status: 'in_progress' | 'completed';
  readonly output: readonly unknown[];
  readonly usage: unknown;
  readonly completed: boolean;
  readonly includeBilling?: boolean;
}

function openAiResponseObject(options: OpenAiResponseObjectOptions): unknown {
  const now = Math.floor(Date.now() / 1000);
  const raw = asRecordPayload(options.request.raw);
  return {
    id: options.id,
    object: 'response',
    created_at: now,
    status: options.status,
    background: false,
    ...(options.includeBilling === false ? {} : { billing: { payer: 'developer' } }),
    completed_at: options.completed ? now : null,
    error: null,
    frequency_penalty: numberOrDefault(raw.frequency_penalty, 0),
    incomplete_details: null,
    instructions: typeof raw.instructions === 'string' ? raw.instructions : null,
    max_output_tokens: options.request.maxTokens ?? null,
    max_tool_calls: null,
    model: options.model,
    moderation: null,
    output: options.output,
    parallel_tool_calls: true,
    presence_penalty: numberOrDefault(raw.presence_penalty, 0),
    previous_response_id: typeof raw.previous_response_id === 'string' ? raw.previous_response_id : null,
    prompt_cache_key: typeof raw.prompt_cache_key === 'string' ? raw.prompt_cache_key : null,
    prompt_cache_retention: '24h',
    reasoning: responseReasoning(raw.reasoning),
    safety_identifier: typeof raw.safety_identifier === 'string' ? raw.safety_identifier : null,
    service_tier: 'default',
    store: raw.store === false ? false : true,
    temperature: options.request.temperature ?? 1,
    text: responseTextConfig(raw.text),
    tool_choice: responseToolChoice(raw.tool_choice),
    tools: Array.isArray(raw.tools) ? raw.tools : [],
    top_logprobs: numberOrDefault(raw.top_logprobs, 0),
    top_p: numberOrDefault(raw.top_p, 0.98),
    truncation: typeof raw.truncation === 'string' ? raw.truncation : 'disabled',
    usage: options.usage,
    user: typeof raw.user === 'string' ? raw.user : null,
    metadata: asRecordPayload(raw.metadata),
  };
}

function openAiResponseReasoningItem(): unknown {
  return {
    id: `rs_${randomUUID()}`,
    type: 'reasoning',
    summary: [],
  };
}

function openAiResponseMessageItem(id: string, text: string): unknown {
  return {
    id,
    type: 'message',
    status: 'completed',
    content: [
      {
        type: 'output_text',
        annotations: [],
        logprobs: [],
        text,
      },
    ],
    phase: 'final_answer',
    role: 'assistant',
  };
}

function responseReasoning(value: unknown): unknown {
  const reasoning = asRecordPayload(value);
  return {
    context: typeof reasoning.context === 'string' ? reasoning.context : 'current_turn',
    effort: typeof reasoning.effort === 'string' ? reasoning.effort : 'medium',
    summary: reasoning.summary ?? null,
  };
}

function responseTextConfig(value: unknown): unknown {
  const text = asRecordPayload(value);
  const format = asRecordPayload(text.format);
  return {
    format: Object.keys(format).length > 0 ? format : { type: 'text' },
    verbosity: typeof text.verbosity === 'string' ? text.verbosity : 'medium',
  };
}

function responseToolChoice(value: unknown): unknown {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') return value;
  return 'auto';
}

function numberOrDefault(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function anthropicUsage(usage: LocalUsage): Record<string, number> {
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    ...(usage.cacheCreationInputTokens !== undefined
      ? { cache_creation_input_tokens: usage.cacheCreationInputTokens }
      : {}),
    ...(usage.cacheReadInputTokens !== undefined
      ? { cache_read_input_tokens: usage.cacheReadInputTokens }
      : {}),
  };
}

function openAiInputTokens(usage: LocalUsage): number {
  const anthropicCacheTokens =
    (usage.cacheCreationInputTokens ?? 0) + (usage.cacheReadInputTokens ?? 0);
  return anthropicCacheTokens > 0
    ? usage.inputTokens + anthropicCacheTokens
    : usage.inputTokens;
}

function cachedInputTokens(usage: LocalUsage): number {
  return usage.cachedInputTokens
    ?? (usage.cacheCreationInputTokens ?? 0) + (usage.cacheReadInputTokens ?? 0);
}

async function writeOpenAiChatStream(
  res: ServerResponse,
  events: AsyncIterable<LocalStreamEvent>,
  request: NormalizedRequest,
): Promise<void> {
  writeSseHeaders(res);
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  let base = {
    id,
    object: 'chat.completion.chunk',
    created,
    model: request.model,
    service_tier: 'default',
    system_fingerprint: null,
  };
  let streamedText = '';
  let assistantStarted = false;
  const toolState = new OpenAiChatToolStreamState(
    res,
    request.streamOptions,
    () => assistantStarted,
    () => {
      assistantStarted = true;
    },
  );
  try {
    const ensureTextStarted = async (): Promise<void> => {
      if (assistantStarted) return;
      assistantStarted = true;
      await writeSseData(res, openAiChatStreamChunk(
        base,
        [{ index: 0, delta: { role: 'assistant', content: '', refusal: null }, finish_reason: null }],
        request.streamOptions,
      ));
    };
    if (!hasToolDecisionSchema(request)) {
      await ensureTextStarted();
    } else {
      await toolState.prestart(base, predictableOpenAiChatToolStart(request));
    }
    for await (const event of events) {
      if (event.type === 'text_delta') {
        if (!event.delta) continue;
        await ensureTextStarted();
        streamedText += event.delta;
        await writeSseData(res, openAiChatStreamChunk(
          base,
          [{ index: 0, delta: { content: event.delta }, finish_reason: null }],
          request.streamOptions,
        ));
        continue;
      }
      if (event.type === 'tool_call_delta') {
        await toolState.write(base, event);
        continue;
      }
      const result = event.result;
      base = { ...base, model: result.model };
      if (result.toolCalls.length > 0) {
        await toolState.finish(base, result.toolCalls);
        await writeSseData(res, openAiChatStreamChunk(
          base,
          [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
          request.streamOptions,
        ));
      } else {
        await ensureTextStarted();
        if (!streamedText && result.text) {
          for (const chunk of chunkText(result.text)) {
            await writeSseData(res, openAiChatStreamChunk(
              base,
              [{ index: 0, delta: { content: chunk }, finish_reason: null }],
              request.streamOptions,
            ));
          }
        }
        await writeSseData(res, openAiChatStreamChunk(
          base,
          [{ index: 0, delta: {}, finish_reason: 'stop' }],
          request.streamOptions,
        ));
      }
      if (request.streamOptions.includeUsage) {
        await writeSseData(res, {
          ...base,
          choices: [],
          usage: openAiChatUsage(result.usage),
          ...(request.streamOptions.includeObfuscation ? { obfuscation: randomObfuscation() } : {}),
        });
      }
    }
    res.write('data: [DONE]\n\n');
  } catch (err) {
    await writeSseData(res, streamErrorPayload(err));
    res.write('data: [DONE]\n\n');
  } finally {
    res.end();
  }
}

function openAiChatStreamChunk(
  base: Record<string, unknown>,
  choices: readonly unknown[],
  streamOptions: NormalizedRequest['streamOptions'],
): unknown {
  return {
    ...base,
    choices,
    ...(streamOptions.includeUsage ? { usage: null } : {}),
    ...(streamOptions.includeObfuscation ? { obfuscation: randomObfuscation() } : {}),
  };
}

class OpenAiChatToolStreamState {
  private readonly streamedArguments = new Map<number, string>();
  private readonly started = new Set<number>();

  constructor(
    private readonly res: ServerResponse,
    private readonly streamOptions: NormalizedRequest['streamOptions'],
    private readonly hasAssistantStarted: () => boolean,
    private readonly markAssistantStarted: () => void,
  ) {}

  async prestart(base: Record<string, unknown>, tool: PredictableToolStart | null): Promise<void> {
    if (!tool) return;
    await this.ensureStarted(base, tool.index, tool.id, tool.name);
  }

  async write(
    base: Record<string, unknown>,
    event: Extract<LocalStreamEvent, { type: 'tool_call_delta' }>,
  ): Promise<void> {
    await this.ensureStarted(base, event.index, event.id, event.name);
    if (event.argumentsDelta) {
      await this.writeArgumentsChunk(base, event.index, event.argumentsDelta);
    }
  }

  async finish(
    base: Record<string, unknown>,
    toolCalls: readonly LocalToolCall[],
  ): Promise<void> {
    for (const [index, call] of toolCalls.entries()) {
      await this.ensureStarted(base, index, call.id, call.name);
      const rest = missingToolCallArgumentDelta(
        this.streamedArguments.get(index) ?? '',
        call,
      );
      if (rest) await this.writeArgumentsChunk(base, index, rest);
    }
  }

  private async ensureStarted(
    base: Record<string, unknown>,
    index: number,
    id: string | undefined,
    name: string | undefined,
  ): Promise<void> {
    if (this.started.has(index)) return;
    const includeAssistantStart = !this.hasAssistantStarted();
    if (includeAssistantStart) this.markAssistantStarted();
    this.started.add(index);
    await writeSseData(this.res, openAiChatStreamChunk(
      base,
      [
        {
          index: 0,
          delta: {
            ...(includeAssistantStart ? { role: 'assistant', content: null, refusal: null } : {}),
            tool_calls: [
              {
                index,
                id: id ?? `call_${index + 1}`,
                type: 'function',
                function: {
                  name: name ?? 'tool',
                  arguments: '',
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
      this.streamOptions,
    ));
  }

  private async writeArgumentsChunk(
    base: Record<string, unknown>,
    index: number,
    argumentsDelta: string,
  ): Promise<void> {
    this.streamedArguments.set(
      index,
      `${this.streamedArguments.get(index) ?? ''}${argumentsDelta}`,
    );
    await writeSseData(this.res, openAiChatStreamChunk(
      base,
      [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index,
                function: {
                  arguments: argumentsDelta,
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
      this.streamOptions,
    ));
  }
}

async function writeOpenAiResponsesStream(
  res: ServerResponse,
  events: AsyncIterable<LocalStreamEvent>,
  request: NormalizedRequest,
): Promise<void> {
  writeSseHeaders(res);
  const responseId = `resp_stream_${randomUUID()}`;
  const reasoningItem = openAiResponseReasoningItem();
  const itemId = `msg_${randomUUID()}`;
  let textStarted = false;
  let reasoningEmitted = false;
  let streamedText = '';
  let finalOutput: unknown[] = [];
  let sequenceNumber = -1;
  const writeResponseEvent: OpenAiResponseEventWriter = async (event, payload) => {
    sequenceNumber += 1;
    await writeSseEvent(res, event, {
      sequence_number: sequenceNumber,
      ...payload,
    });
  };
  const createdResponse = openAiResponseObject({
    id: responseId,
    model: request.model,
    request,
    status: 'in_progress',
    output: [],
    usage: null,
    completed: false,
    includeBilling: false,
  });
  const toolState = new OpenAiResponsesToolStreamState(writeResponseEvent);

  try {
    await writeResponseEvent('response.created', {
      type: 'response.created',
      response: createdResponse,
    });
    await writeResponseEvent('response.in_progress', {
      type: 'response.in_progress',
      response: createdResponse,
    });

    const ensureTextStarted = async (): Promise<void> => {
      if (textStarted) return;
      if (!reasoningEmitted) {
        reasoningEmitted = true;
        await writeResponseEvent('response.output_item.added', {
          type: 'response.output_item.added',
          output_index: 0,
          item: reasoningItem,
        });
        await writeResponseEvent('response.output_item.done', {
          type: 'response.output_item.done',
          output_index: 0,
          item: reasoningItem,
        });
      }
      textStarted = true;
      await writeResponseEvent('response.output_item.added', {
        type: 'response.output_item.added',
        output_index: 1,
        item: {
          id: itemId,
          type: 'message',
          status: 'in_progress',
          content: [],
          phase: 'final_answer',
          role: 'assistant',
        },
      });
      await writeResponseEvent('response.content_part.added', {
        type: 'response.content_part.added',
        item_id: itemId,
        output_index: 1,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      });
    };

    for await (const event of events) {
      if (event.type === 'text_delta') {
        if (!event.delta) continue;
        await ensureTextStarted();
        streamedText += event.delta;
        await writeResponseEvent('response.output_text.delta', {
          type: 'response.output_text.delta',
          item_id: itemId,
          output_index: 1,
          content_index: 0,
          delta: event.delta,
          logprobs: [],
        });
        continue;
      }
      if (event.type === 'tool_call_delta') {
        await toolState.write(event);
        continue;
      }

      const result = event.result;
      if (result.toolCalls.length > 0) {
        finalOutput = await toolState.finish(result.toolCalls);
      } else {
        await ensureTextStarted();
        if (!streamedText && result.text) {
          for (const chunk of chunkText(result.text)) {
            streamedText += chunk;
            await writeResponseEvent('response.output_text.delta', {
              type: 'response.output_text.delta',
              item_id: itemId,
              output_index: 1,
              content_index: 0,
              delta: chunk,
              logprobs: [],
            });
          }
        }
        await writeResponseEvent('response.output_text.done', {
          type: 'response.output_text.done',
          item_id: itemId,
          output_index: 1,
          content_index: 0,
          logprobs: [],
          text: result.text,
        });
        await writeResponseEvent('response.content_part.done', {
          type: 'response.content_part.done',
          item_id: itemId,
          output_index: 1,
          content_index: 0,
          part: { type: 'output_text', text: result.text, annotations: [], logprobs: [] },
        });
        const item = openAiResponseMessageItem(itemId, result.text);
        finalOutput = [reasoningItem, item];
        await writeResponseEvent('response.output_item.done', {
          type: 'response.output_item.done',
          output_index: 1,
          item,
        });
      }
      await writeResponseEvent('response.completed', {
        type: 'response.completed',
        response: openAiResponsesCompletedResponse(responseId, result, request, finalOutput),
      });
    }
    res.write('data: [DONE]\n\n');
  } catch (err) {
    await writeResponseEvent('error', asRecordPayload(streamErrorPayload(err)));
    res.write('data: [DONE]\n\n');
  } finally {
    res.end();
  }
}

interface OpenAiResponseToolItemState {
  readonly itemId: string;
  callId: string;
  name: string;
  arguments: string;
}

type OpenAiResponseEventWriter = (event: string, payload: Record<string, unknown>) => Promise<void>;

class OpenAiResponsesToolStreamState {
  private readonly items = new Map<number, OpenAiResponseToolItemState>();

  constructor(private readonly writeResponseEvent: OpenAiResponseEventWriter) {}

  async write(event: Extract<LocalStreamEvent, { type: 'tool_call_delta' }>): Promise<void> {
    const state = await this.ensureStarted(
      event.index,
      event.id ?? `call_${event.index + 1}`,
      event.name ?? 'tool',
    );
    if (event.argumentsDelta) await this.writeArgumentsDelta(event.index, state, event.argumentsDelta);
  }

  async finish(toolCalls: readonly LocalToolCall[]): Promise<unknown[]> {
    const output: unknown[] = [];
    for (const [index, call] of toolCalls.entries()) {
      const state = await this.ensureStarted(index, call.id, call.name);
      const rest = missingToolCallArgumentDelta(state.arguments, call);
      if (rest) await this.writeArgumentsDelta(index, state, rest);
      const item = {
        id: state.itemId,
        type: 'function_call',
        status: 'completed',
        call_id: state.callId,
        name: state.name,
        arguments: call.arguments,
      };
      output.push(item);
      await this.writeResponseEvent('response.function_call_arguments.done', {
        type: 'response.function_call_arguments.done',
        output_index: index,
        item_id: state.itemId,
        arguments: call.arguments,
      });
      await this.writeResponseEvent('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: index,
        item,
      });
    }
    return output;
  }

  private async ensureStarted(
    index: number,
    callId: string,
    name: string,
  ): Promise<OpenAiResponseToolItemState> {
    const existing = this.items.get(index);
    if (existing) return existing;
    const state: OpenAiResponseToolItemState = {
      itemId: `fc_${randomUUID()}`,
      callId,
      name,
      arguments: '',
    };
    this.items.set(index, state);
    await this.writeResponseEvent('response.output_item.added', {
      type: 'response.output_item.added',
      output_index: index,
      item: {
        id: state.itemId,
        type: 'function_call',
        status: 'in_progress',
        call_id: state.callId,
        name: state.name,
        arguments: '',
      },
    });
    return state;
  }

  private async writeArgumentsDelta(
    index: number,
    state: OpenAiResponseToolItemState,
    delta: string,
  ): Promise<void> {
    state.arguments += delta;
    await this.writeResponseEvent('response.function_call_arguments.delta', {
      type: 'response.function_call_arguments.delta',
      output_index: index,
      item_id: state.itemId,
      delta,
    });
  }
}

interface PredictableToolStart {
  readonly index: number;
  readonly id: string;
  readonly name: string;
}

function predictableOpenAiChatToolStart(request: NormalizedRequest): PredictableToolStart | null {
  if (request.shape !== 'openai-chat') return null;
  if (request.toolChoice.type === 'tool') {
    return {
      index: 0,
      id: 'call_1',
      name: request.toolChoice.name,
    };
  }
  if (request.toolChoice.type === 'required' && request.tools.length === 1) {
    return {
      index: 0,
      id: 'call_1',
      name: request.tools[0]?.name ?? 'tool',
    };
  }
  return null;
}

function openAiResponsesCompletedResponse(
  responseId: string,
  result: LocalCompletionResult,
  request: NormalizedRequest,
  output: unknown[],
): unknown {
  return openAiResponseObject({
    id: responseId,
    model: result.model,
    request,
    status: 'completed',
    output,
    usage: openAiResponsesUsage(result.usage),
    completed: true,
    includeBilling: false,
  });
}

async function writeAnthropicMessagesStream(
  res: ServerResponse,
  events: AsyncIterable<LocalStreamEvent>,
  request: NormalizedRequest,
): Promise<void> {
  writeSseHeaders(res);
  let textStarted = false;
  let streamedText = '';
  const toolState = new AnthropicToolUseStreamState(res);

  try {
    await writeSseEvent(res, 'message_start', {
      type: 'message_start',
      message: {
        id: `msg_stream_${randomUUID()}`,
        type: 'message',
        role: 'assistant',
        model: request.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
        },
      },
    });

    const ensureTextStarted = async (): Promise<void> => {
      if (textStarted) return;
      textStarted = true;
      await writeSseEvent(res, 'content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      });
    };

    for await (const event of events) {
      if (event.type === 'text_delta') {
        if (!event.delta) continue;
        await ensureTextStarted();
        streamedText += event.delta;
        await writeSseEvent(res, 'content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: event.delta },
        });
        continue;
      }
      if (event.type === 'tool_call_delta') {
        await toolState.write(event);
        continue;
      }

      const result = event.result;
      if (result.toolCalls.length > 0) {
        await toolState.finish(result.toolCalls);
      } else {
        await ensureTextStarted();
        if (!streamedText && result.text) {
          for (const chunk of chunkText(result.text)) {
            streamedText += chunk;
            await writeSseEvent(res, 'content_block_delta', {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: chunk },
            });
          }
        }
        await writeSseEvent(res, 'content_block_stop', {
          type: 'content_block_stop',
          index: 0,
        });
      }

      await writeSseEvent(res, 'message_delta', {
        type: 'message_delta',
        delta: {
          stop_reason: result.toolCalls.length > 0 ? 'tool_use' : 'end_turn',
          stop_sequence: null,
        },
        usage: {
          output_tokens: result.usage.outputTokens,
        },
      });
      await writeSseEvent(res, 'message_stop', {
        type: 'message_stop',
      });
    }
  } catch (err) {
    await writeSseEvent(res, 'error', {
      type: 'error',
      error: {
        type: 'api_error',
        message: errorMessage(err),
      },
    });
  } finally {
    res.end();
  }
}

interface AnthropicToolUseState {
  id: string;
  name: string;
  arguments: string;
}

class AnthropicToolUseStreamState {
  private readonly states = new Map<number, AnthropicToolUseState>();

  constructor(private readonly res: ServerResponse) {}

  async write(event: Extract<LocalStreamEvent, { type: 'tool_call_delta' }>): Promise<void> {
    const state = await this.ensureStarted(
      event.index,
      event.id ?? `call_${event.index + 1}`,
      event.name ?? 'tool',
    );
    if (event.argumentsDelta) await this.writeArgumentsDelta(event.index, state, event.argumentsDelta);
  }

  async finish(toolCalls: readonly LocalToolCall[]): Promise<void> {
    for (const [index, call] of toolCalls.entries()) {
      const state = await this.ensureStarted(index, call.id, call.name);
      const rest = missingToolCallArgumentDelta(state.arguments, call);
      if (rest) await this.writeArgumentsDelta(index, state, rest);
      await writeSseEvent(this.res, 'content_block_stop', {
        type: 'content_block_stop',
        index,
      });
    }
  }

  private async ensureStarted(
    index: number,
    id: string,
    name: string,
  ): Promise<AnthropicToolUseState> {
    const existing = this.states.get(index);
    if (existing) return existing;
    const state = { id, name, arguments: '' };
    this.states.set(index, state);
    await writeSseEvent(this.res, 'content_block_start', {
      type: 'content_block_start',
      index,
      content_block: {
        type: 'tool_use',
        id: state.id,
        name: state.name,
        input: {},
      },
    });
    return state;
  }

  private async writeArgumentsDelta(
    index: number,
    state: AnthropicToolUseState,
    delta: string,
  ): Promise<void> {
    state.arguments += delta;
    await writeSseEvent(this.res, 'content_block_delta', {
      type: 'content_block_delta',
      index,
      delta: {
        type: 'input_json_delta',
        partial_json: delta,
      },
    });
  }
}

function openAiToolCall(call: LocalToolCall): unknown {
  return {
    id: call.id,
    type: 'function',
    function: {
      name: call.name,
      arguments: call.arguments,
    },
  };
}

function openAiResponseToolCall(call: LocalToolCall): unknown {
  return {
    id: `fc_${randomUUID()}`,
    type: 'function_call',
    status: 'completed',
    call_id: call.id,
    name: call.name,
    arguments: call.arguments,
  };
}

function anthropicToolUse(call: LocalToolCall): unknown {
  return {
    type: 'tool_use',
    id: call.id,
    name: call.name,
    input: parseToolArguments(call.arguments),
  };
}

function parseToolArguments(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return { input: value };
  }
}

function streamErrorPayload(err: unknown): unknown {
  if (err instanceof ProxyRequestError) {
    return {
      error: {
        message: err.message,
        type: err.type,
        param: err.param,
        code: err.code,
      },
    };
  }
  const providerError = providerErrorFromBackendError(err);
  if (providerError) {
    return {
      error: {
        message: providerError.message,
        type: providerError.type,
        param: providerError.param,
        code: providerError.code,
      },
    };
  }
  return {
    error: {
      message: errorMessage(err),
      type: 'server_error',
      param: null,
      code: null,
    },
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function writeJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
  });
  res.end(`${JSON.stringify(payload)}\n`);
}

function writeSseHeaders(res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
}

async function writeSseEvent(
  res: ServerResponse,
  event: string,
  payload: unknown,
): Promise<void> {
  res.write(`event: ${event}\n`);
  await writeSseData(res, payload);
}

async function writeSseData(res: ServerResponse, payload: unknown): Promise<void> {
  const line = `data: ${JSON.stringify(payload)}\n\n`;
  if (!res.write(line)) {
    await new Promise<void>((resolve) => res.once('drain', resolve));
  }
}

async function writeLocalCliChatStream(
  res: ServerResponse,
  events: AsyncIterable<{
    readonly event: string;
    readonly session_id: string;
    readonly turn_id?: string;
    readonly runtime: string;
    readonly raw: unknown;
  }>,
): Promise<void> {
  writeSseHeaders(res);
  for await (const event of events) {
    await writeSseEvent(res, event.event, event);
  }
  res.end();
}

function chunkText(text: string): string[] {
  if (!text) return [];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += 48) {
    chunks.push(text.slice(i, i + 48));
  }
  return chunks;
}

function randomObfuscation(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12);
}

function asRecordPayload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function isAddressInfo(value: string | AddressInfo | null): value is AddressInfo {
  return Boolean(value) && typeof value === 'object';
}

function writeError(
  res: ServerResponse,
  err: unknown,
  shape: ErrorResponseShape = 'openai',
): void {
  if (err instanceof LocalCliChatError) {
    writeJson(res, err.statusCode, {
      error: {
        message: err.message,
        type: 'local_cli_chat_error',
        param: null,
        code: err.code,
      },
    });
    return;
  }
  if (err instanceof ProxyRequestError) {
    if (err.provider === 'anthropic') {
      writeJson(res, err.statusCode, {
        type: 'error',
        error: {
          type: err.type,
          message: err.message,
        },
      });
      return;
    }
    writeJson(res, err.statusCode, {
      error: {
        message: err.message,
        type: err.type,
        param: err.param,
        code: err.code,
      },
    });
    return;
  }
  const providerError = providerErrorFromBackendError(err);
  if (providerError) {
    if (shape === 'anthropic') {
      writeJson(res, providerError.statusCode, {
        type: 'error',
        error: {
          type: providerError.type,
          message: providerError.message,
        },
      });
      return;
    }
    writeJson(res, providerError.statusCode, {
      error: {
        message: providerError.message,
        type: providerError.type,
        param: providerErrorParamForShape(providerError.param, shape),
        code: providerError.code,
      },
    });
    return;
  }
  writeJson(res, 500, {
    error: {
      message: err instanceof Error ? err.message : String(err),
      type: 'server_error',
      param: null,
      code: null,
    },
  });
}

function providerErrorFromBackendError(err: unknown): {
  readonly statusCode: number;
  readonly type: string;
  readonly message: string;
  readonly param: string | null;
  readonly code: string | null;
} | null {
  const outer = parseObject(errorMessage(err));
  const inner = parseObject(typeof outer?.message === 'string' ? outer.message : undefined) ?? outer;
  const error = asRecordPayload(inner?.error);
  const statusCode = typeof inner?.status === 'number' ? inner.status : undefined;
  const message = typeof error.message === 'string' ? error.message : undefined;
  if (!statusCode || statusCode < 400 || statusCode >= 600 || !message) return null;
  return {
    statusCode,
    type: typeof error.type === 'string' ? error.type : 'invalid_request_error',
    message,
    param: typeof error.param === 'string' ? error.param : null,
    code: typeof error.code === 'string' ? error.code : null,
  };
}

function providerErrorParamForShape(
  param: string | null,
  shape: ErrorResponseShape,
): string | null {
  if (shape === 'openai-chat' && param === 'reasoning.effort') return 'reasoning_effort';
  return param;
}

function parseObject(value: string | undefined): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return asRecordPayload(parsed);
  } catch {
    return null;
  }
}

function setCorsHeaders(res: ServerResponse): void {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  res.setHeader('access-control-allow-headers', 'authorization,content-type,x-api-key,anthropic-version');
}
