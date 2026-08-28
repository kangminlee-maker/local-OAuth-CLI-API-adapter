import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
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
import { honorRequestModel } from '../settings.js';
import {
  GeneratedImageStoreLike, BACKEND_IDENTIFIERS, ProxyRequestError } from './types.js';
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

type ErrorResponseShape = 'openai' | 'openai-chat' | 'openai-responses' | 'anthropic' | 'local-cli';
type OpenAiImageOperation = OpenAiImageGenerationRequest['operation'];

const DEFAULT_IMAGE_GENERATION_SIZE = 'auto';
const DEFAULT_IMAGE_GENERATION_QUALITY = 'auto';
const DEFAULT_IMAGE_GENERATION_OUTPUT_FORMAT = 'png';
const DEFAULT_IMAGE_GENERATION_BACKGROUND = 'auto';
const GENERATED_IMAGE_TTL_MS = 60 * 60 * 1000;
// Expiry alone bounds nothing: a client generating images for an hour grows the
// store without limit. Bytes, not entries, are what runs the machine out.
const GENERATED_IMAGE_MAX_BYTES = 128 * 1024 * 1024;
// The byte budget bounds payloads, not Map overhead: a flood of 1-byte images
// would grow keys and entry metadata with almost no counted bytes. Entries are
// bounded separately.
const GENERATED_IMAGE_MAX_ENTRIES = 10_000;
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
  // Injectable like the backends: the store's budgets are real behaviour
  // (eviction, pinning) that HTTP-level tests cannot exercise against the
  // production 128 MiB constant.
  const generatedImages = options.generatedImageStore ?? new GeneratedImageStore();
  const server = createServer((req, res) => {
    void handleRequest(req, res, options, generatedImages);
  });
  // Node routes CONNECT to this event and, with no listener, destroys the
  // socket — the one method that got no HTTP answer at all. It is a tunnel
  // request this proxy does not serve; say so in the promised shape.
  server.on('connect', (_req, socket) => {
    const body = JSON.stringify({
      error: {
        message: 'Unsupported method.',
        type: 'invalid_request_error',
        param: null,
        code: null,
      },
    });
    socket.end(
      'HTTP/1.1 405 Method Not Allowed\r\n'
      + 'content-type: application/json; charset=utf-8\r\n'
      + `content-length: ${Buffer.byteLength(body)}\r\n`
      + 'connection: close\r\n\r\n'
      + body,
    );
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
    url: `http://${urlHostname(options.host)}:${actualPort}`,
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

// Every endpoint this server answers with POST. Consulted before the method
// check so an unknown path is a 404 whatever method it arrives with.
const POST_ENDPOINTS = new Set([
  '/v1/chat/completions',
  '/v1/responses',
  '/v1/messages',
  '/v1/images/generations',
  '/v1/images/edits',
  '/v1/images/variations',
]);

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: ProxyServerOptions,
  generatedImages: GeneratedImageStoreLike,
): Promise<void> {
  const { backend, requestTimeoutMs } = options;
  setCorsHeaders(res);
  let errorShape: ErrorResponseShape = 'openai';
  // 204 is for a real CORS preflight — the browser's permission question, sent
  // before it will attach credentials, which is why it bypasses the gate. A
  // preflight always names the method it is asking about; a bare OPTIONS does
  // not, is an ordinary request, and goes through dispatch like any other.
  if (req.method === 'OPTIONS' && isHttpMethodToken(stripOws(headerValue(req.headers['access-control-request-method'])))) {
    res.writeHead(204).end();
    return;
  }
  try {
    // The raw request target with only the query removed — NOT a parsed URL.
    // WHATWG parsing normalizes dot segments and backslashes, so
    // `/x/../v1/chat/completions` silently became a routable path, breaking the
    // exact-match promise; and a target it cannot parse (`//host:99999/...`)
    // threw before the gate ran.
    const rawTarget = req.url ?? '/';
    const queryIndex = rawTarget.indexOf('?');
    const path = queryIndex === -1 ? rawTarget : rawTarget.slice(0, queryIndex);
    // The caller's envelope is decided by the path alone, before anything can
    // fail: a method rejection, a body-parse failure or a configuration error
    // on /v1/messages must already answer in the Anthropic shape.
    if (path === '/v1/messages') errorShape = 'anthropic';
    if (path === '/local/cli/sessions' || path.startsWith('/local/cli/sessions/')) {
      errorShape = 'local-cli';
    }
    requireAuthorizedRequest(req, path, options.authKey);
    if (path === '/local/cli/sessions' || path.startsWith('/local/cli/sessions/')) {
      await handleLocalCliChatRequest(req, res, options, path);
      return;
    }
    // The generated route is exactly one nonempty, slash-free id segment. A
    // doubled slash or a deeper path is a DIFFERENT path, which the dispatch
    // row promises is a 404 whatever the method — prefix matching was
    // classifying it as served and answering 405.
    const generatedId = path.startsWith('/v1/images/generated/')
      ? path.slice('/v1/images/generated/'.length)
      : null;
    const isGetRoute = path === '/v1/models'
      || (generatedId !== null && generatedId !== '' && !generatedId.includes('/'));
    // Path first, method second: `GET /v1/nope` is an unknown endpoint, not an
    // unsupported method. 405 is reserved for a path this proxy does serve —
    // including the GET routes, so `POST /v1/models` is a method problem, not a
    // missing endpoint.
    if (!isGetRoute && !POST_ENDPOINTS.has(path)) {
      throw new ProxyRequestError(`Unknown endpoint: ${path}`, 404);
    }
    if (req.method !== (isGetRoute ? 'GET' : 'POST')) {
      throw new ProxyRequestError('Unsupported method.', 405);
    }
    if (path === '/v1/models') {
      writeJson(res, 200, await openAiModelsResponse(backend));
      return;
    }
    if (path.startsWith('/v1/images/generated/')) {
      writeGeneratedImage(res, generatedImages, path);
      return;
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
        await writeOpenAiChatStream(
          res,
          await streamEvents(backend, normalized, requestTimeoutMs, res),
          await requestReportingExecutedModel(backend, normalized),
        );
      } else {
        const result = await runWithTimeout(backend, normalized, requestTimeoutMs, res);
        writeJson(res, 200, openAiChatResponse(result));
      }
      return;
    }
    if (path === '/v1/responses') {
      errorShape = 'openai-responses';
      const normalized = normalizeOpenAiResponsesRequest(body);
      rejectDeferredFeatures(normalized);
      if (normalized.stream) {
        await writeOpenAiResponsesStream(
          res,
          await streamEvents(backend, normalized, requestTimeoutMs, res),
          await requestReportingExecutedModel(backend, normalized),
        );
      } else {
        const result = await runWithTimeout(backend, normalized, requestTimeoutMs, res);
        writeJson(res, 200, openAiResponsesResponse(result, normalized));
      }
      return;
    }
    if (path === '/v1/messages') {
      errorShape = 'anthropic';
      const normalized = normalizeAnthropicMessagesRequest(body);
      rejectDeferredFeatures(normalized, 'anthropic');
      if (normalized.stream) {
        await writeAnthropicMessagesStream(
          res,
          await streamEvents(backend, normalized, requestTimeoutMs, res),
          await requestReportingExecutedModel(backend, normalized),
        );
      } else {
        const result = await runWithTimeout(backend, normalized, requestTimeoutMs, res);
        writeJson(res, 200, anthropicMessagesResponse(result));
      }
      return;
    }

    throw new ProxyRequestError(`Unknown endpoint: ${path}`, 404);
  } catch (err) {
    writeError(res, err, errorShape);
  }
}

// Optional access gate. When `authKey` is configured the proxy requires every
// request (except the CORS preflight, which carries no credentials) to present
// the key via `Authorization: Bearer <key>` or `x-api-key: <key>`. This protects
// a tunnel-exposed personal proxy; it does not change how the local CLI backend
// authenticates. The 401 is shaped per provider so OpenAI and Anthropic SDKs
// surface it as an auth error.
function requireAuthorizedRequest(
  req: IncomingMessage,
  path: string,
  authKey: string | undefined,
): void {
  // An empty configured key is a configuration mistake, not "no gate": treating
  // it as off silently opens a proxy its operator believed was closed.
  if (authKey === undefined) return;
  // Each rejected class below is a key no request could ever present: empty;
  // edge whitespace (presented values are trimmed); unpaired surrogates (no
  // UTF-8 encoding — the U+FFFD replacement would make a DIFFERENT credential
  // compare equal); control bytes (the HTTP parser rejects the presenting
  // request before the gate sees it). The proxy would answer 401 to everyone,
  // including its operator.
  //
  // The SPECIFIC cause goes to the operator's stderr only. The response gets
  // one fixed sentence: which class of mistake was made is configuration
  // state, and an unauthenticated caller has no business learning it.
  const configurationMistake = (): never => {
    throw new Error('the access gate is misconfigured; see the proxy log');
  };
  if (!authKey) {
    process.stderr.write('authKey is configured but empty; refusing to serve unauthenticated\n');
    configurationMistake();
  }
  if (authKey !== authKey.trim()) {
    process.stderr.write('authKey has leading or trailing whitespace, which no request can present\n');
    configurationMistake();
  }
  if (Buffer.from(authKey, 'utf8').toString('utf8') !== authKey) {
    process.stderr.write('authKey contains unpaired surrogates, which cannot be encoded as UTF-8 bytes\n');
    configurationMistake();
  }
  for (const byte of Buffer.from(authKey, 'utf8')) {
    if ((byte < 0x20 && byte !== 0x09) || byte === 0x7f) {
      process.stderr.write('authKey contains control bytes that HTTP forbids in header values\n');
      configurationMistake();
    }
  }
  if (presentedAuthKeys(req).some((candidate) => safeKeyEqual(candidate, authKey))) return;
  const provider = path === '/v1/messages' ? 'anthropic' : 'openai';
  throw new ProxyRequestError(
    'Unauthorized: missing or invalid API key.',
    401,
    provider,
    provider === 'anthropic' ? 'authentication_error' : 'invalid_request_error',
    null,
    provider === 'anthropic' ? null : 'invalid_api_key',
  );
}

/**
 * The credentials a request presents, in the two documented forms. Both are
 * returned, not the first non-empty one: they are alternatives, so a stale
 * `x-api-key` beside a valid `Authorization: Bearer` must not decide the answer.
 *
 * A bare `Authorization: <key>` is NOT a credential. The contract names the
 * Bearer form, and accepting the raw value silently widened what counts.
 */
function presentedAuthKeys(req: IncomingMessage): string[] {
  const presented: string[] = [];
  // From `rawHeaders`, which keeps each physical header line. Node folds repeated
  // `x-api-key` lines into one comma-joined value, and splitting THAT on commas
  // cannot tell two headers apart from one key that contains a comma — a key the
  // contract puts no character restriction on. Reading the raw lines answers both
  // without guessing.
  const raw = req.rawHeaders;
  for (let i = 0; i + 1 < raw.length; i += 2) {
    if (raw[i].toLowerCase() !== 'x-api-key') continue;
    // OWS only (space/tab, per RFC 7230) — String.trim also eats U+00A0, which
    // under latin1 header decoding is a real byte of a multibyte key.
    const trimmed = stripOws(raw[i + 1]);
    if (trimmed) presented.push(trimmed);
  }
  const headers = req.headers;
  // OWS only, same as the x-api-key lines above. `String.trim()` and `\s` both
  // eat U+00A0, which under latin1 header decoding is a real byte — of the key
  // (a valid credential was rejected) or of trailing junk (an INVALID credential
  // was accepted, because the junk was silently removed before comparing).
  const authorization = stripOws(headerValue(headers.authorization));
  const bearer = /^Bearer[ \t]+(.+)$/i.exec(authorization);
  if (bearer) {
    const token = stripOws(bearer[1]);
    if (token) presented.push(token);
  }
  return presented;
}

// RFC 9110 token grammar. The preflight exemption is for a request that NAMES
// the method it is asking about; `P OST` or `,` names none, and treating mere
// non-emptiness as a name let malformed OPTIONS skip the gate.
function isHttpMethodToken(value: string): boolean {
  return /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value);
}

// RFC 7230 optional whitespace: ASCII space and horizontal tab, nothing else.
function stripOws(value: string): string {
  return value.replace(/^[ \t]+|[ \t]+$/g, '');
}

function safeKeyEqual(presented: string, expected: string): boolean {
  // Node decodes header bytes as latin1, so a client that sent the UTF-8 bytes
  // of a non-ASCII key arrives here as that byte sequence read as latin1.
  // Re-encoding the candidate as latin1 recovers the wire bytes; the configured
  // key is compared as its UTF-8 bytes. Pure-ASCII keys are unaffected — the
  // two encodings agree there.
  const presentedBytes = Buffer.from(presented, 'latin1');
  const expectedBytes = Buffer.from(expected, 'utf8');
  if (presentedBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(presentedBytes, expectedBytes);
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
    // The turn belongs to the session and survives a client disconnect — that
    // is what `interrupt` is for — but it does not survive the request's own
    // deadline: an unanswered turn used to hold the socket with no end.
    const turnOptions = { timeoutMs: options.requestTimeoutMs };
    if (body.stream) {
      await writeLocalCliChatStream(res, manager.streamTurn(sessionId, body, turnOptions));
    } else {
      writeJson(res, 200, await manager.runTurn(sessionId, body, turnOptions));
    }
    return;
  }
  throw new ProxyRequestError(`Unsupported local CLI chat endpoint: ${path}`, 404);
}

async function handleOpenAiImageRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: ProxyServerOptions,
  generatedImages: GeneratedImageStoreLike,
  request: OpenAiImageGenerationRequest,
): Promise<void> {
  const client = options.imageGenerationClient ?? unsupportedLocalOAuthImageGenerationClient();
  if (request.stream) {
    await writeOpenAiImageStream(
      req,
      res,
      runImageGenerationStreamWithTimeout(client, request, options.requestTimeoutMs, res),
      generatedImages,
      request,
    );
    return;
  }
  const result = await runImageGenerationWithTimeout(
    client,
    request,
    options.requestTimeoutMs,
  
    res,
  );
  writeJson(res, 200, openAiImagesGenerationResponse(req, generatedImages, result, request));
}

function normalizeOpenAiImageRequest(
  body: unknown,
  operation: OpenAiImageOperation,
  isMultipart: boolean,
): OpenAiImageGenerationRequest {
  const input = asRecordPayload(body);
  // "Explicit" means a real value: null is omission (the field is nullable on
  // the direct API), so a GPT-image request carrying response_format: null must
  // behave exactly like one without the property.
  const explicitResponseFormat = input.response_format !== undefined && input.response_format !== null;
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
  // Absence and null get the default (the direct API declares the field
  // nullable); any other present value is validated rather than silently
  // replaced with `b64_json`.
  const responseFormat = input.response_format === undefined || input.response_format === null
    ? 'b64_json'
    : input.response_format;
  if (responseFormat !== 'b64_json' && responseFormat !== 'url') {
    throw new ProxyRequestError('response_format must be one of url or b64_json.', 400);
  }
  // Absence and null default (the field is nullable on the direct API); a
  // present non-string or blank string is malformed input, not a request for
  // dall-e-2 — substituting a model the client never named ran the wrong route.
  if (input.model !== undefined && input.model !== null
    && (typeof input.model !== 'string' || !input.model.trim())) {
    throw new ProxyRequestError('model must be a non-empty string.', 400, 'openai', 'invalid_request_error', 'model');
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
    // Validated only where the contract gives it meaning. On generations and
    // variations the row says "ignored" — validating an ignored field rejected
    // requests the contract promises succeed.
    mask: operation === 'edit' ? requiredValidImageInput(input.mask, 'mask') : undefined,
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
  // Only compression BELOW 100 needs a lossy format — 100 is "no compression",
  // which PNG can express. The guard rejected every defined value, including the
  // one its own message says is fine.
  if (
    request.outputCompression !== undefined
    && request.outputCompression < 100
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
  if (request.inputFidelity && request.model === 'image-2') {
    // The model-specific rejection carries its documented envelope
    // (image_generation_user_error); the generic operation guard below used to
    // shadow it for generations and variations.
    throw new ProxyRequestError(
      'input_fidelity is disabled for image-2.',
      400,
      'openai',
      'image_generation_user_error',
      'tools',
      'invalid_input_fidelity_model',
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
  // The documented aliases hold in BOTH encodings: a JSON edit naming its
  // image with the singular `image` field was rejected as having none.
  const value = input.image ?? input['image[]'] ?? input.images;
  return imageInputArray(value);
}

function imageInputArray(value: unknown): readonly NormalizedImage[] {
  if (Array.isArray(value)) {
    // Every supplied member must be a valid image reference. Filtering the
    // bad ones executed the request with silently altered input.
    return value.map((member, index) => {
      let image: NormalizedImage | undefined;
      try {
        image = optionalImageInput(member);
      } catch (err) {
        // The member parser throws its own diagnostics (`exactly one source`);
        // the index is this function's to add, whichever path rejected.
        const detail = err instanceof Error ? err.message : String(err);
        throw new ProxyRequestError(`image[${index}]: ${detail}`, 400);
      }
      if (!image) {
        throw new ProxyRequestError(`image[${index}] is not a valid image reference.`, 400);
      }
      return image;
    });
  }
  const image = optionalImageInput(value);
  return image ? [image] : [];
}

/**
 * An optional image field whose PRESENT values must be valid: omission and
 * null pass through as absence, but `mask: 42` used to be silently dropped —
 * executing an unmasked edit the client never asked for.
 */
function requiredValidImageInput(value: unknown, field: string): NormalizedImage | undefined {
  if (value === undefined || value === null) return undefined;
  const image = optionalImageInput(value);
  if (!image) {
    throw new ProxyRequestError(`${field} is not a valid image reference.`, 400);
  }
  return image;
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
    // Media-type tokens are case-insensitive; `data:IMAGE/PNG` is a PNG.
    // The media-type token is FRAMING: per the whitespace doctrine, only
    // ASCII OWS strips. A 0xA0 byte keeps the token malformed rather than
    // being repaired into `image/png`.
    // No default: the regex requires at least one media-type character, so an
    // empty capture is impossible and an OWS-only one is present junk — the
    // `|| 'image/png'` fallback was REPAIRING `data: \t;base64,...`.
    const rawMediaType = stripOws(dataUrl[1] ?? '');
    const data = dataUrl[2]?.replace(/\s/g, '') ?? '';
    // Validate BEFORE case-folding: RFC 2045 tokens are US-ASCII, and
    // JavaScript toLowerCase folds Unicode — U+212A KELVIN SIGN became `k`,
    // admitting a subtype the grammar excludes. The class carries A-Z itself.
    // Grammar: every CHAR except SPACE, CTLs and tspecials — which PERMITS
    // `{}` (the HTTP tchar class wrongly rejected `image/x-{foo}`).
    if (!/^[Ii][Mm][Aa][Gg][Ee]\/[0-9A-Za-z!#$%&'*+\-.^_\`{|}~]+$/.test(rawMediaType) || !data) {
      return null;
    }
    const mediaType = rawMediaType.toLowerCase();
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
  // The direct API declares `n` nullable (`Optional[int]`), so null IS
  // omission — the earlier explicit-null rejection was anti-parity, measured
  // against the published SDK types.
  if (value === undefined || value === null) return 1;
  const parsed = optionalInteger(value, 'n', 1, 10);
  if (parsed === undefined) {
    throw new ProxyRequestError('n must be an integer between 1 and 10.', 400);
  }
  return parsed;
}

function partialImageCount(value: unknown): number {
  // Nullable on the direct API, like `n`: null is omission.
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
  // null is omission (these fields are nullable on the direct API); an empty
  // string is a PRESENT value outside the enum and used to be silently
  // dropped, running the request without the control the client sent.
  if (value === undefined || value === null) return undefined;
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
  // null is omission (nullable on the direct API); an empty string is a
  // PRESENT value that is not an integer.
  if (value === undefined || value === null) return undefined;
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
  res: ServerResponse,
): Promise<OpenAiImageGenerationResult> {
  const abort = turnAbort(res, requestTimeoutMs);
  try {
    return await client.generate(request, abort.signal);
  } finally {
    abort.release();
  }
}

async function* runImageGenerationStreamWithTimeout(
  client: OpenAiImageGenerationClient,
  request: OpenAiImageGenerationRequest,
  requestTimeoutMs: number,
  res: ServerResponse,
): AsyncIterable<OpenAiImageGenerationStreamEvent> {
  const abort = turnAbort(res, requestTimeoutMs);
  try {
    if (client.stream) {
      for await (const event of client.stream(request, abort.signal)) {
        yield event;
      }
      return;
    }
    const result = await client.generate(request, abort.signal);
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
    abort.release();
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

/**
 * One abort signal per backend turn: the timeout, or the client walking away.
 * The RESPONSE's close is the disconnect signal — `IncomingMessage` closes as
 * soon as the body is consumed, which is every normal request; `writableEnded`
 * separates an orderly finish from a client that left. Call `release` when the
 * turn settles, or the listener outlives the request.
 */
function turnAbort(res: ServerResponse, requestTimeoutMs: number): { signal: AbortSignal; release: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  const onClose = (): void => {
    if (!res.writableEnded) controller.abort();
  };
  res.once('close', onClose);
  return {
    signal: controller.signal,
    release: () => {
      clearTimeout(timer);
      res.removeListener('close', onClose);
    },
  };
}

async function runWithTimeout(
  backend: LocalCliBackend,
  request: NormalizedRequest,
  requestTimeoutMs: number,
  res: ServerResponse,
): Promise<LocalCompletionResult> {
  // The disconnect half matters even without streaming: on a serialized
  // backend an abandoned turn kept its slot to the timeout, and the NEXT
  // client paid for it.
  const abort = turnAbort(res, requestTimeoutMs);
  try {
    return await backend.generate(request, abort.signal);
  } finally {
    abort.release();
  }
}

/**
 * Pulls the first event before the caller writes SSE headers.
 *
 * Model validation happens inside the backend — for Claude it cannot happen
 * earlier, since only the CLI knows which models exist. Streaming responses
 * commit a 200 the moment headers are written, so without this the contracted
 * 404 would arrive after the response was already committed and the client would
 * see a truncated 200 instead.
 *
 * Only used when the request model can be rejected at all; otherwise the stream
 * is passed through untouched so first-byte latency is unchanged.
 */
export async function withFirstEventSettled(
  events: AsyncIterable<LocalStreamEvent>,
): Promise<AsyncIterable<LocalStreamEvent>> {
  const iterator = events[Symbol.asyncIterator]();
  const first = await iterator.next();
  return {
    async *[Symbol.asyncIterator]() {
      try {
        if (first.done) return;
        yield first.value;
        while (true) {
          const next = await iterator.next();
          if (next.done) return;
          yield next.value;
        }
      } finally {
        // The wrapper drives the backend iterator by hand, so closing early —
        // a client disconnect after the first event — would otherwise never
        // reach the source generator's own cleanup, leaving its timeout, CLI
        // process, or backend lock alive.
        await iterator.return?.();
      }
    },
  };
}

/**
 * The request, with `model` replaced by the model that will actually run.
 *
 * Streaming chunks carry the request's model, which is only the executed one by
 * coincidence. With honouring on the proxy knows the real answer before the
 * stream starts, so it reports that instead of echoing the client back to
 * itself. With honouring off the historical echo is preserved.
 */
async function requestReportingExecutedModel(
  backend: LocalCliBackend,
  request: NormalizedRequest,
): Promise<NormalizedRequest> {
  if (!honorRequestModel()) return request;
  const resolved = await backend.resolvedModel?.(request).catch(() => null) ?? null;
  if (!resolved || resolved === request.model) return request;
  return { ...request, model: resolved };
}

function streamEvents(
  backend: LocalCliBackend,
  request: NormalizedRequest,
  requestTimeoutMs: number,
  res: ServerResponse,
): Promise<AsyncIterable<LocalStreamEvent>> {
  // The disconnect signal is wired in BOTH modes and lives for the whole
  // iteration. It used to exist only during honor-on prefetch, so a client
  // that left mid-stream kept its backend turn running to the timeout — and on
  // a serialized backend the next client paid for it.
  const clientGone = new AbortController();
  const onResponseClose = (): void => {
    if (!res.writableEnded) clientGone.abort();
  };
  res.once('close', onResponseClose);
  const release = (): void => {
    res.removeListener('close', onResponseClose);
  };
  const events = releaseOnFinish(
    runStreamWithTimeout(backend, request, requestTimeoutMs, clientGone.signal),
    release,
  );
  if (!honorRequestModel()) {
    return Promise.resolve(events);
  }
  return withFirstEventSettled(events);
}

async function* releaseOnFinish(
  events: AsyncIterable<LocalStreamEvent>,
  release: () => void,
): AsyncIterable<LocalStreamEvent> {
  try {
    for await (const event of events) yield event;
  } finally {
    release();
  }
}

async function* runStreamWithTimeout(
  backend: LocalCliBackend,
  request: NormalizedRequest,
  requestTimeoutMs: number,
  clientGone?: AbortSignal,
): AsyncIterable<LocalStreamEvent> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  // A client that disconnects while the first event is still pending — during
  // model validation or CLI startup — has no response writer yet to notice, so
  // the abort has to reach the backend from here.
  const onClientGone = () => controller.abort();
  clientGone?.addEventListener('abort', onClientGone, { once: true });
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
    clientGone?.removeEventListener('abort', onClientGone);
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

export class GeneratedImageStore {
  private readonly images = new Map<string, {
    readonly bytes: Buffer;
    readonly contentType: string;
    readonly expiresAt: number;
  }>();

  private heldBytes = 0;

  constructor(
    private readonly ttlMs: number = GENERATED_IMAGE_TTL_MS,
    private readonly maxBytes: number = GENERATED_IMAGE_MAX_BYTES,
    private readonly maxEntries: number = GENERATED_IMAGE_MAX_ENTRIES,
  ) {}

  put(b64Json: string, outputFormat: string, pinned?: ReadonlySet<string>): string {
    this.cleanupExpired();
    const id = randomUUID();
    const bytes = Buffer.from(b64Json, 'base64');
    this.images.set(id, {
      bytes,
      contentType: imageContentType(outputFormat),
      expiresAt: Date.now() + this.ttlMs,
    });
    this.heldBytes += bytes.byteLength;
    // Map preserves insertion order, so iteration meets oldest entries first.
    // Never evicted: the image just stored, and any id in `pinned` — the other
    // images of the SAME response, whose URLs are about to be handed out
    // together. Without the pin, an oversized first image was evicted by its
    // own sibling before the response was even sent.
    for (const [oldest] of this.images) {
      if (this.heldBytes <= this.maxBytes && this.images.size <= this.maxEntries) break;
      if (oldest === id) break;
      if (pinned?.has(oldest)) continue;
      this.drop(oldest);
    }
    return id;
  }

  private drop(id: string): void {
    const image = this.images.get(id);
    if (!image) return;
    this.heldBytes -= image.bytes.byteLength;
    this.images.delete(id);
  }

  get(id: string): { readonly bytes: Buffer; readonly contentType: string } | null {
    const image = this.images.get(id);
    if (!image) return null;
    if (image.expiresAt <= Date.now()) {
      this.drop(id);
      return null;
    }
    return image;
  }

  clear(): void {
    this.images.clear();
    this.heldBytes = 0;
  }

  private cleanupExpired(): void {
    const now = Date.now();
    for (const [id, image] of this.images.entries()) {
      if (image.expiresAt <= now) this.drop(id);
    }
  }
}

function writeGeneratedImage(
  res: ServerResponse,
  generatedImages: GeneratedImageStoreLike,
  path: string,
): void {
  // Byte-for-byte, no percent-decoding: issued ids are plain UUIDs, so no
  // client ever needs encoding, and decoding created aliases — `%61bc...` and
  // `abc...` named the same image, while `%2F` decoded into a separator the
  // route grammar had already excluded. A `%FF` or `%2F` segment is simply an
  // id that was never issued: the ordinary miss.
  const id = path.slice('/v1/images/generated/'.length);
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

// An IPv6 literal needs brackets inside a URL authority — `http://::1:8080`
// does not parse. Hostnames and IPv4 pass through untouched.
function urlHostname(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

/**
 * The link handed back for `response_format: url`.
 *
 * The authority is the one the client addressed — `Host` is how it reached this
 * proxy, and rewriting it to the bound address would break every tunnelled
 * client. When there is no `Host` (HTTP/1.0) the bound address is the only
 * authority we know.
 *
 * The scheme is NOT hard-coded: behind an HTTPS tunnel a hard-coded `http://`
 * hands the client a link its own page will refuse as mixed content, for bytes
 * that are on the other side of the same TLS connection.
 */
function generatedImageUrl(req: IncomingMessage, id: string): string {
  const socket = req.socket as { encrypted?: boolean; localAddress?: string; localPort?: number };
  const host = headerValue(req.headers.host)
    || (socket.localAddress ? `${urlHostname(socket.localAddress)}:${socket.localPort}` : '127.0.0.1');
  const forwarded = stripOws(headerValue(req.headers['x-forwarded-proto']).split(',')[0] ?? '').toLowerCase();
  const scheme = forwarded === 'https' || forwarded === 'http'
    ? forwarded
    : (socket.encrypted ? 'https' : 'http');
  return `${scheme}://${host}/v1/images/generated/${encodeURIComponent(id)}`;
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
  // The media-type ESSENCE, not a substring: `application/json;
  // profile="...multipart/form-data..."` is JSON whose parameter happens to
  // contain those words.
  const essence = stripOws(contentType.split(';')[0] ?? '').toLowerCase();
  if (essence === 'multipart/form-data') {
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
  // A boundary DELIMITS only when the whole delimiter line matches (RFC
  // 2046): at the start of a line AND terminated by optional whitespace plus
  // CRLF, or by `--` for the close. Bare splitting truncated data twice —
  // first on mid-line marker bytes, then on line-starting PREFIXES
  // (`--BX` where the boundary is `B` is data, because `X` terminates
  // nothing). A scanner checks both sides of every candidate.
  const source = `\r\n${binary}`;
  const marker = `\r\n--${boundary}`;
  const segments: string[] = [];
  let start = 0;
  let cursor = 0;
  let closed = false;
  while (!closed) {
    const at = source.indexOf(marker, cursor);
    if (at === -1) break;
    const rest = source.slice(at + marker.length);
    const delimiter = /^[ \t]*\r\n/.exec(rest);
    if (delimiter) {
      segments.push(source.slice(start, at));
      cursor = at + marker.length + delimiter[0].length;
      start = cursor;
    } else if (/^--[ \t]*(\r\n|$)/.test(rest)) {
      // The CLOSE delimiter has the same whole-line rule: `--` then optional
      // whitespace then CRLF or end of body. `--B--X` is data — the bare
      // startsWith check truncated everything after such bytes.
      segments.push(source.slice(start, at));
      closed = true;
    } else {
      // A prefix of real data — keep scanning past it.
      cursor = at + marker.length;
    }
  }
  // segments[0] is the preamble before the opening boundary; each later one is
  // a complete part, `headers\r\n\r\ncontent`, its delimiter CRLFs consumed.
  for (const part of segments.slice(1)) {
    // An empty header block ends at the part's very first CRLF — searching
    // for CRLFCRLF from the top read the CONTENT as headers when the block
    // was empty.
    if (part.startsWith('\r\n')) continue;
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    const rawHeaders = part.slice(0, headerEnd);
    // The delimiter's CRLF was consumed by the scanner, so the content is
    // exactly the part's bytes.
    const rawContent = part.slice(headerEnd + 4);
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

/**
 * Quote-aware parameter splitting, shared by the content-type and
 * content-disposition parsers: a `;` inside a quoted value is data, and a
 * quoted-pair (`\"`) neither closes the quote nor separates. Naive
 * splitting let `filename="x; name=bogus"` fabricate — or overwrite — a
 * parameter.
 */
function splitHeaderParameters(value: string): string[] {
  const params: string[] = [];
  let current = '';
  let inQuotes = false;
  let escaped = false;
  for (const ch of value) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (inQuotes && ch === '\\') {
      current += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') inQuotes = !inQuotes;
    if (ch === ';' && !inQuotes) {
      params.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  params.push(current);
  return params;
}

function multipartBoundary(contentType: string): string | null {
  // Parameters are walked with quote awareness: a `;` inside a quoted value
  // does not separate, and `boundary=` inside ANOTHER parameter's quoted value
  // is text — the naive regex picked a decoy out of `note="x;boundary=bogus"`
  // and stopped at the closing quote of `boundary="B"junk`, silently accepting
  // a malformed parameter.
  const semi = contentType.indexOf(';');
  if (semi === -1) return null;
  for (const param of splitHeaderParameters(contentType.slice(semi + 1))) {
    const eq = param.indexOf('=');
    if (eq === -1) continue;
    // OWS only — String.trim also eats U+00A0, which under latin1 header
    // decoding is a real byte and NOT in the boundary alphabet.
    if (stripOws(param.slice(0, eq)).toLowerCase() !== 'boundary') continue;
    let value = stripOws(param.slice(eq + 1));
    if (value.startsWith('"')) {
      // A quoted value is the WHOLE value; a suffix after the closing quote is
      // malformed, not ignorable. Quoted-pairs decode: `"B\?"` names `B?`.
      const quoted = /^"((?:[^"\\]|\\.)*)"$/.exec(value);
      if (!quoted) return null;
      value = (quoted[1] ?? '').replace(/\\(.)/g, '$1');
    }
    // RFC 2046 bchars: 1-70 characters from a fixed alphabet, the last not a
    // space.
    if (!/^[0-9A-Za-z'()+_,\-./:=? ]{0,69}[0-9A-Za-z'()+_,\-./:=?]$/.test(value)) {
      return null;
    }
    return value;
  }
  return null;
}

function multipartHeaders(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Unfold first: a CRLF followed by SP/HTAB continues the previous field
  // (RFC 822 folding). The continuation line has no colon, so it was silently
  // dropped — taking a folded Content-Disposition's `name` with it.
  const unfolded = raw.replace(/\r\n[ \t]+/g, ' ');
  for (const line of unfolded.split('\r\n')) {
    const index = line.indexOf(':');
    if (index === -1) continue;
    // OWS only, the multipart path's LAST remaining String.trim: a 0xA0 byte
    // beside a field name or value is a real byte that makes the header
    // malformed, not whitespace to forgive.
    out[stripOws(line.slice(0, index)).toLowerCase()] = stripOws(line.slice(index + 1));
  }
  return out;
}

function parseContentDisposition(value: string | undefined): {
  readonly name?: string;
  readonly filename?: string;
} {
  if (!value) return {};
  const segments = splitHeaderParameters(value);
  // The disposition TYPE is the first segment and must be `form-data` (OWS
  // only; a 0xA0 byte keeps it malformed). It was skipped unexamined, so any
  // junk type still named a part.
  if (stripOws(segments[0] ?? '').toLowerCase() !== 'form-data') return {};
  const out: Record<string, string> = {};
  for (const part of segments.slice(1)) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    // Parameter names are case-insensitive; `NAME="image"` names the part.
    // OWS only — String.trim also eats U+00A0, a real latin1 header byte that
    // makes the name NOT `name`.
    const key = stripOws(part.slice(0, index)).toLowerCase();
    let val = stripOws(part.slice(index + 1));
    if (val.startsWith('"') && val.endsWith('"')) {
      // Quoted-pairs decode here as they do in the boundary parameter:
      // `name="im\age"` names `image`.
      val = val.slice(1, -1).replace(/\\(.)/g, '$1');
    }
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
    // An empty upload is not an image, and neither is a part that says it is
    // something else. Every other encoding of an image input enforces both;
    // this one accepted them and sent `data:text/plain;base64,…` upstream as
    // though it were a picture.
    && obj.data !== ''
    && /^image\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(obj.mediaType)
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

async function openAiModelsResponse(backend: LocalCliBackend): Promise<unknown> {
  // Only advertise a choice the client can actually make. With honouring off the
  // request model does not select anything, so listing alternatives would invite
  // a selection the proxy then ignores.
  const ids = honorRequestModel()
    ? await advertisedModels(backend)
    : (BACKEND_IDENTIFIERS.includes(backend.model) ? [] : [backend.model]);
  return {
    object: 'list',
    data: ids.map((id) => ({
      id,
      object: 'model',
      created: 0,
      owned_by: 'local-oauth-cli',
    })),
  };
}

async function advertisedModels(backend: LocalCliBackend): Promise<readonly string[]> {
  const listed = await backend.availableModels?.().catch(() => null) ?? null;
  // A backend identifier is not a selectable model, so it is never advertised —
  // a client that echoed one back would now be rejected.
  const configured = BACKEND_IDENTIFIERS.includes(backend.model) ? null : backend.model;
  const rest = (listed ?? []).filter((id) => id !== configured && !BACKEND_IDENTIFIERS.includes(id));
  const ids = configured ? [configured, ...rest] : rest;
  // A runtime that advertised the same slug twice would otherwise put it in the
  // response twice; a model list with duplicate `id`s is malformed for a client
  // whatever the runtime meant by it. First occurrence wins, so order holds.
  return [...new Set(ids)];
}

function openAiImagesGenerationResponse(
  req: IncomingMessage,
  generatedImages: GeneratedImageStoreLike,
  result: OpenAiImageGenerationResult,
  request: OpenAiImageGenerationRequest,
): unknown {
  return {
    created: result.created,
    // One pin set for the whole response: sibling images must not evict each
    // other before their URLs are even sent. And at most `n` of them — the
    // count is backend-controlled, `n` is the request's, the same rule the
    // streamed path applies.
    data: (() => {
      const batch = new Set<string>();
      return result.images.slice(0, request.n ?? 1)
        .map((image) => openAiImageObject(req, generatedImages, image, request, batch, result.outputFormat));
    })(),
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
  generatedImages: GeneratedImageStoreLike,
  image: OpenAiGeneratedImage,
  request: OpenAiImageGenerationRequest,
  batch?: Set<string>,
  producedFormat?: string,
): unknown {
  if (request.responseFormat === 'url') {
    const id = generatedImages.put(
      image.b64Json,
      // What the bytes ARE, not what was asked for: the JSON body already
      // reports the produced format, so labelling the stored bytes from the
      // request let one response advertise webp and serve image/png.
      producedFormat ?? request.outputFormat ?? DEFAULT_IMAGE_GENERATION_OUTPUT_FORMAT,
      batch,
    );
    batch?.add(id);
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
  generatedImages: GeneratedImageStoreLike,
  request: OpenAiImageGenerationRequest,
): Promise<void> {
  writeSseHeaders(res);
  // One pin set for the whole stream: sibling images of one response must not
  // evict each other, exactly as in the non-streaming path.
  const batch = new Set<string>();
  const putPinned = (b64Json: string, outputFormat?: string): string => {
    const id = generatedImages.put(b64Json, outputFormat ?? request.outputFormat ?? DEFAULT_IMAGE_GENERATION_OUTPUT_FORMAT, batch);
    batch.add(id);
    return id;
  };
  // The event count is backend-controlled; `n` is the request's. A runaway
  // stream must not emit more images than were asked for — nor pin more.
  let completedEmitted = 0;
  try {
    for await (const event of events) {
      if (event.type === 'partial_image') continue;
      if (completedEmitted >= (request.n ?? 1)) break;
      completedEmitted += 1;
      const type = imageStreamEventType(request.operation, event.type);
      const payload = {
        type,
        created_at: event.created,
        background: event.background ?? request.background ?? DEFAULT_IMAGE_GENERATION_BACKGROUND,
        output_format: event.outputFormat ?? request.outputFormat ?? DEFAULT_IMAGE_GENERATION_OUTPUT_FORMAT,
        quality: event.quality ?? request.quality ?? DEFAULT_IMAGE_GENERATION_QUALITY,
        size: event.size ?? request.size ?? DEFAULT_IMAGE_GENERATION_SIZE,
        ...(request.responseFormat === 'url'
          ? { url: generatedImageUrl(req, putPinned(event.image.b64Json, event.outputFormat)) }
          : { b64_json: event.image.b64Json }),
        // The provider's rewrite of the prompt, which the non-streaming
        // response carries: a client comparing the two modes saw it vanish.
        ...(event.image.revisedPrompt ? { revised_prompt: event.image.revisedPrompt } : {}),
        ...(event.usage ? { usage: openAiImagesUsage(event.usage) } : {}),
      };
      await writeSseEvent(res, type, payload);
    }
  } catch (err) {
    await writeSseEvent(res, 'error', streamErrorPayload(err));
    // The OpenAI mid-stream contract: an in-band error, then `data: [DONE]` —
    // the images stream was the one OpenAI surface that ended without it.
    res.write('data: [DONE]\n\n');
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
          // Narration that accompanied the tool call, as the provider returns
          // it; `null` only when the turn really said nothing.
          content: result.text ? result.text : null,
          tool_calls: result.toolCalls.map(openAiToolCall),
          refusal: null,
          annotations: [],
        } : {
          role: 'assistant',
          content: result.text,
          refusal: null,
          annotations: [],
        },
        // `length` is how the chat surface says "stopped at the cap"; the
        // Anthropic surface already passes `max_tokens` through as a stop reason.
        finish_reason: hasToolCalls
          ? 'tool_calls'
          : result.stopReason === 'max_tokens' ? 'length' : 'stop',
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
  // A reasoning item only when the backend reported one, and always first —
  // where the backend puts it and where the direct API puts it, ahead of both
  // the message and the tool calls.
  const reasoning = result.reasoning
    ? [openAiResponseReasoningItem(result.reasoning.id)]
    : [];
  const output = result.toolCalls.length > 0
    ? [
        ...reasoning,
        ...orderedByEmission(result, {
          text: result.text ? [openAiResponseMessageItem(`msg_${randomUUID()}`, result.text)] : [],
          toolCalls: result.toolCalls.map(openAiResponseToolCall),
        }),
      ]
    : [
        ...reasoning,
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

/**
 * The turn's parts in the order they were produced. A tool call that arrived
 * before any text is streamed as the first block, so the completed body has to
 * report it as the first block too — the two surfaces describe one turn.
 */
function orderedByEmission(
  result: LocalCompletionResult,
  parts: { readonly text: readonly unknown[]; readonly toolCalls: readonly unknown[] },
): unknown[] {
  return result.toolCallsBeforeText
    ? [...parts.toolCalls, ...parts.text]
    : [...parts.text, ...parts.toolCalls];
}

function anthropicMessagesResponse(result: LocalCompletionResult): unknown {
  const hasToolCalls = result.toolCalls.length > 0;
  const stopReason = anthropicStopReason(result, hasToolCalls);
  const content = stopReason === 'refusal'
    ? (result.text ? [{ type: 'text', text: result.text }] : [])
    : hasToolCalls
    ? orderedByEmission(result, {
        text: result.text ? [{ type: 'text', text: result.text }] : [],
        toolCalls: result.toolCalls.map(anthropicToolUse),
      })
    : [
        {
          type: 'text',
          text: result.text,
        },
      ];
  return {
    id: `msg_${result.id}`,
    type: 'message',
    role: 'assistant',
    model: result.model,
    content,
    stop_reason: stopReason,
    stop_sequence: result.stopSequence ?? null,
    stop_details: anthropicStopDetails(result, stopReason),
    usage: anthropicUsage(result.usage),
  };
}

// stop_reason values the proxy mirrors from the CLI verbatim; anything else (or
// absent) falls back to the tool_use/end_turn derivation.
const ANTHROPIC_PASSTHROUGH_STOP_REASONS = new Set([
  'end_turn',
  'max_tokens',
  'stop_sequence',
  'refusal',
  'pause_turn',
]);

function anthropicStopReason(result: LocalCompletionResult, hasToolCalls: boolean): string {
  if (hasToolCalls) return 'tool_use';
  const reported = result.stopReason;
  if (reported && ANTHROPIC_PASSTHROUGH_STOP_REASONS.has(reported)) return reported;
  return 'end_turn';
}

function anthropicStopDetails(result: LocalCompletionResult, stopReason: string): unknown {
  // Only surface raw CLI stop_details when the emitted stop_reason is the reason the
  // CLI actually reported (a genuine passthrough). A downgraded/derived reason
  // (tool_use, or end_turn standing in for an unknown reason) must not carry details
  // that describe a different stop state.
  const passedThrough = result.stopReason === stopReason
    && ANTHROPIC_PASSTHROUGH_STOP_REASONS.has(stopReason);
  const details = result.stopDetails;
  if (passedThrough && details && typeof details === 'object' && !Array.isArray(details)) {
    return details;
  }
  if (stopReason === 'refusal') return { type: 'refusal', category: null };
  return null;
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

function openAiResponseReasoningItem(id?: string): unknown {
  return {
    // The backend's own id when it gave one: a client that feeds `output` back
    // as input is echoing an item the runtime really produced, and a minted id
    // names one that never existed.
    id: id ?? `rs_${randomUUID()}`,
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

/**
 * Anthropic counts cache reads OUTSIDE `input_tokens`; the OpenAI-shaped
 * runtimes count them inside `prompt_tokens` and report the hit separately as
 * `cached_tokens`. Reading only the Anthropic-named fields left a real cache
 * hit invisible on this surface — a codex-backed turn whose prefix was served
 * from cache reported no cache fields at all, so a client computing cost or
 * cache efficiency from `usage` saw a full-price prompt every turn.
 */
function anthropicUsage(usage: LocalUsage): Record<string, number> {
  const cacheRead = usage.cacheReadInputTokens ?? usage.cachedInputTokens;
  const inputTokens = usage.cacheReadInputTokens === undefined && usage.cachedInputTokens !== undefined
    ? Math.max(usage.inputTokens - usage.cachedInputTokens, 0)
    : usage.inputTokens;
  return {
    input_tokens: inputTokens,
    output_tokens: usage.outputTokens,
    ...(usage.cacheCreationInputTokens !== undefined
      ? { cache_creation_input_tokens: usage.cacheCreationInputTokens }
      : {}),
    ...(cacheRead !== undefined ? { cache_read_input_tokens: cacheRead } : {}),
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
      // The chat surface has no reasoning item: its shape reports reasoning
      // only as a token count in `usage`.
      if (event.type === 'reasoning_item') continue;
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
  const itemId = `msg_${randomUUID()}`;
  let textStarted = false;
  let streamedText = '';
  // Keyed by the position each item was announced at, so the completed array
  // reads the same way the stream did. Assembling it in a fixed order made
  // `output[0]` the reasoning item on a turn whose `output_index: 0` had
  // already named a function_call.
  const finalItems = new Map<number, unknown>();
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
  // Output positions are allocated in emission order, so the reasoning item,
  // the message item and every function_call each hold a distinct index.
  let nextOutputIndex = 0;
  let messageOutputIndex = -1;
  const allocateOutputIndex = (): number => {
    const allocated = nextOutputIndex;
    nextOutputIndex += 1;
    return allocated;
  };
  const toolState = new OpenAiResponsesToolStreamState(writeResponseEvent, allocateOutputIndex);

  try {
    await writeResponseEvent('response.created', {
      type: 'response.created',
      response: createdResponse,
    });
    await writeResponseEvent('response.in_progress', {
      type: 'response.in_progress',
      response: createdResponse,
    });

    // Announced when the backend announces its own, at the position the backend
    // gave it — first. It used to be synthesized at the first text delta
    // instead, which put an item the turn never produced ahead of the message,
    // dropped the real one on a turn that only called a tool, and on a
    // tool-first turn placed it after the call the backend had put it before.
    const emitReasoningItem = async (id?: string): Promise<void> => {
      const item = openAiResponseReasoningItem(id);
      const reasoningOutputIndex = allocateOutputIndex();
      finalItems.set(reasoningOutputIndex, item);
      await writeResponseEvent('response.output_item.added', {
        type: 'response.output_item.added',
        output_index: reasoningOutputIndex,
        item,
      });
      await writeResponseEvent('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: reasoningOutputIndex,
        item,
      });
    };

    const ensureTextStarted = async (): Promise<void> => {
      if (textStarted) return;
      textStarted = true;
      messageOutputIndex = allocateOutputIndex();
      await writeResponseEvent('response.output_item.added', {
        type: 'response.output_item.added',
        output_index: messageOutputIndex,
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
        output_index: messageOutputIndex,
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
          output_index: messageOutputIndex,
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
      if (event.type === 'reasoning_item') {
        await emitReasoningItem(event.id);
        continue;
      }

      const result = event.result;
      if (result.toolCalls.length > 0) {
        for (const { outputIndex, item } of await toolState.finish(result.toolCalls)) {
          finalItems.set(outputIndex, item);
        }
        // Narration streamed before the call belongs in the completed output
        // too, or the stream's own summary contradicts the deltas it sent.
        if (streamedText) {
          const messageItem = openAiResponseMessageItem(itemId, streamedText);
          await writeResponseEvent('response.output_text.done', {
            type: 'response.output_text.done',
            item_id: itemId,
            output_index: messageOutputIndex,
            content_index: 0,
            logprobs: [],
            text: streamedText,
          });
          await writeResponseEvent('response.content_part.done', {
            type: 'response.content_part.done',
            item_id: itemId,
            output_index: messageOutputIndex,
            content_index: 0,
            part: { type: 'output_text', text: streamedText, annotations: [], logprobs: [] },
          });
          finalItems.set(messageOutputIndex, messageItem);
          await writeResponseEvent('response.output_item.done', {
            type: 'response.output_item.done',
            output_index: messageOutputIndex,
            item: messageItem,
          });
        }
      } else {
        await ensureTextStarted();
        if (!streamedText && result.text) {
          for (const chunk of chunkText(result.text)) {
            streamedText += chunk;
            await writeResponseEvent('response.output_text.delta', {
              type: 'response.output_text.delta',
              item_id: itemId,
              output_index: messageOutputIndex,
              content_index: 0,
              delta: chunk,
              logprobs: [],
            });
          }
        }
        await writeResponseEvent('response.output_text.done', {
          type: 'response.output_text.done',
          item_id: itemId,
          output_index: messageOutputIndex,
          content_index: 0,
          logprobs: [],
          text: result.text,
        });
        await writeResponseEvent('response.content_part.done', {
          type: 'response.content_part.done',
          item_id: itemId,
          output_index: messageOutputIndex,
          content_index: 0,
          part: { type: 'output_text', text: result.text, annotations: [], logprobs: [] },
        });
        const item = openAiResponseMessageItem(itemId, result.text);
        finalItems.set(messageOutputIndex, item);
        await writeResponseEvent('response.output_item.done', {
          type: 'response.output_item.done',
          output_index: messageOutputIndex,
          item,
        });
      }
      const finalOutput = [...finalItems.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, item]) => item);
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
  /** The position this item occupies in the response's output array. */
  readonly outputIndex: number;
}

type OpenAiResponseEventWriter = (event: string, payload: Record<string, unknown>) => Promise<void>;

class OpenAiResponsesToolStreamState {
  private readonly items = new Map<number, OpenAiResponseToolItemState>();

  /**
   * `output_index` addresses the response's output array, which also holds the
   * reasoning and message items. Using the dense tool ordinal put a
   * function_call at the same index as the reasoning item whenever a turn both
   * narrated and called a tool, so a client assembling `response.output` by
   * index overwrote one with the other.
   */
  constructor(
    private readonly writeResponseEvent: OpenAiResponseEventWriter,
    private readonly allocateOutputIndex: () => number,
  ) {}

  async write(event: Extract<LocalStreamEvent, { type: 'tool_call_delta' }>): Promise<void> {
    const state = await this.ensureStarted(
      event.index,
      event.id ?? `call_${event.index + 1}`,
      event.name ?? 'tool',
    );
    if (event.argumentsDelta) await this.writeArgumentsDelta(event.index, state, event.argumentsDelta);
  }

  /** The finished items with the output position each was announced at. */
  async finish(
    toolCalls: readonly LocalToolCall[],
  ): Promise<ReadonlyArray<{ readonly outputIndex: number; readonly item: unknown }>> {
    const output: Array<{ outputIndex: number; item: unknown }> = [];
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
      output.push({ outputIndex: state.outputIndex, item });
      await this.writeResponseEvent('response.function_call_arguments.done', {
        type: 'response.function_call_arguments.done',
        output_index: state.outputIndex,
        item_id: state.itemId,
        arguments: call.arguments,
      });
      await this.writeResponseEvent('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: state.outputIndex,
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
      outputIndex: this.allocateOutputIndex(),
    };
    this.items.set(index, state);
    await this.writeResponseEvent('response.output_item.added', {
      type: 'response.output_item.added',
      output_index: state.outputIndex,
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
      output_index: state.outputIndex,
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
  let textBlockClosed = false;
  let streamedText = '';
  // Content block indices are wire positions: whichever block opens next takes
  // the next one, whether that is the text block or a tool_use block.
  let nextBlockIndex = 0;
  let textBlockIndex = -1;
  const allocateBlockIndex = (): number => {
    const allocated = nextBlockIndex;
    nextBlockIndex += 1;
    return allocated;
  };
  const toolState = new AnthropicToolUseStreamState(res, allocateBlockIndex);

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
      if (textStarted && !textBlockClosed) return;
      // Two content blocks are never open at once on this wire, so a tool call
      // stops the text block — and text that resumes afterwards is a NEW block.
      // Continuing to write at the stopped index left an SDK accumulator, which
      // finalizes a block on `content_block_stop`, dropping the trailing
      // narration or rejecting the stream outright.
      textStarted = true;
      textBlockClosed = false;
      textBlockIndex = allocateBlockIndex();
      await writeSseEvent(res, 'content_block_start', {
        type: 'content_block_start',
        index: textBlockIndex,
        content_block: { type: 'text', text: '' },
      });
    };

    // A backend that streams text and then also returns tool calls (e.g. the codex
    // backend transport) would otherwise open tool_use blocks at the index already
    // held by the open text block. Close the text block and shift tool indices.
    const closeOpenTextBlock = async (): Promise<void> => {
      if (!textStarted || textBlockClosed) return;
      textBlockClosed = true;
      await writeSseEvent(res, 'content_block_stop', { type: 'content_block_stop', index: textBlockIndex });
    };

    for await (const event of events) {
      if (event.type === 'text_delta') {
        if (!event.delta) continue;
        await ensureTextStarted();
        streamedText += event.delta;
        await writeSseEvent(res, 'content_block_delta', {
          type: 'content_block_delta',
          index: textBlockIndex,
          delta: { type: 'text_delta', text: event.delta },
        });
        continue;
      }
      if (event.type === 'tool_call_delta') {
        await closeOpenTextBlock();
        await toolState.write(event);
        continue;
      }
      // No content block corresponds to it on this wire — a `thinking` block
      // would need the reasoning TEXT, which the backends do not hand over.
      if (event.type === 'reasoning_item') continue;

      const result = event.result;
      const stopReason = anthropicStopReason(result, result.toolCalls.length > 0);
      if (result.toolCalls.length > 0) {
        await closeOpenTextBlock();
        await toolState.finish(result.toolCalls);
      } else {
        // Flush any final text not already streamed (covers schema/refusal results
        // where no live text_delta was emitted), then close the block. A truly empty
        // result opens no content block, matching the non-streaming content:[] mapping
        // — so streaming and non-streaming refusals carry the same content.
        if (!streamedText && result.text) {
          await ensureTextStarted();
          for (const chunk of chunkText(result.text)) {
            streamedText += chunk;
            await writeSseEvent(res, 'content_block_delta', {
              type: 'content_block_delta',
              index: textBlockIndex,
              delta: { type: 'text_delta', text: chunk },
            });
          }
        }
        await closeOpenTextBlock();
      }

      await writeSseEvent(res, 'message_delta', {
        type: 'message_delta',
        delta: {
          stop_reason: stopReason,
          stop_sequence: result.stopSequence ?? null,
          stop_details: anthropicStopDetails(result, stopReason),
        },
        // The whole usage, not just the output count. `message_start` is written
        // before the runtime has reported anything, so its counts are zeros; this
        // is the first event that knows them, and without them a streaming client
        // can never learn the input or cache tokens the contract promises.
        usage: anthropicUsage(result.usage),
      });
      await writeSseEvent(res, 'message_stop', {
        type: 'message_stop',
      });
    }
  } catch (err) {
    // Map the provider error the way every other surface does. Hard-coding
    // `api_error` and serializing the raw throw loses the runtime's status and
    // type, and — because the JSON travels inside the message — hands the client
    // a truncated fragment of it instead of the diagnostic.
    await writeSseEvent(res, 'error', anthropicStreamErrorPayload(err));
  } finally {
    res.end();
  }
}

function anthropicStreamErrorPayload(err: unknown): Record<string, unknown> {
  const provider = err instanceof ProxyRequestError
    ? { type: err.type, message: err.message }
    : providerErrorFromBackendError(err);
  return {
    type: 'error',
    error: {
      type: provider?.type ?? 'api_error',
      message: boundedErrorMessage(provider?.message ?? rawErrorMessage(err)),
    },
  };
}

interface AnthropicToolUseState {
  id: string;
  name: string;
  arguments: string;
  /** The content block index this call occupies on the wire. */
  blockIndex: number;
  /** Whether this call's block has already been stopped. */
  closed: boolean;
}

class AnthropicToolUseStreamState {
  private readonly states = new Map<number, AnthropicToolUseState>();

  /**
   * Content block indices are wire positions, allocated in the order blocks
   * open. A fixed offset only worked when text opened first: with a tool call
   * ahead of the text, both claimed index 0, and the turn ended by stopping an
   * index that was never started — which the Anthropic SDK rejects outright.
   */
  constructor(private readonly res: ServerResponse, private readonly allocateBlockIndex: () => number) {}

  async write(event: Extract<LocalStreamEvent, { type: 'tool_call_delta' }>): Promise<void> {
    const state = await this.ensureStarted(
      event.index,
      event.id ?? `call_${event.index + 1}`,
      event.name ?? 'tool',
    );
    if (event.argumentsDelta) await this.writeArgumentsDelta(event.index, state, event.argumentsDelta);
    // A backend that says where a call's arguments end closes the block there,
    // so the narration that resumes after it — or the next call — opens while
    // nothing else is open. Two blocks open at once is not this wire's shape,
    // and a client that assembles by index has no way to nest them.
    if (event.argumentsDone) await this.stop(state);
  }

  async finish(toolCalls: readonly LocalToolCall[]): Promise<void> {
    for (const [index, call] of toolCalls.entries()) {
      const state = await this.ensureStarted(index, call.id, call.name);
      // A call the backend announced as finished carries the arguments the
      // completed result reports: the transport only sends that signal once the
      // stream holds the value in full, and refuses to let the completed output
      // rewrite it afterwards. So there is nothing left to reconcile and
      // nothing left to stop — and nothing could be sent into a stopped block
      // anyway, which is why the signal is withheld whenever that invariant
      // cannot be met.
      if (state.closed) continue;
      const rest = missingToolCallArgumentDelta(state.arguments, call);
      if (rest) await this.writeArgumentsDelta(index, state, rest);
      await this.stop(state);
    }
  }

  private async stop(state: AnthropicToolUseState): Promise<void> {
    if (state.closed) return;
    state.closed = true;
    await writeSseEvent(this.res, 'content_block_stop', {
      type: 'content_block_stop',
      index: state.blockIndex,
    });
  }

  private async ensureStarted(
    index: number,
    id: string,
    name: string,
  ): Promise<AnthropicToolUseState> {
    const existing = this.states.get(index);
    if (existing) return existing;
    const state = { id, name, arguments: '', blockIndex: this.allocateBlockIndex(), closed: false };
    this.states.set(index, state);
    await writeSseEvent(this.res, 'content_block_start', {
      type: 'content_block_start',
      index: state.blockIndex,
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
      index: state.blockIndex,
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
        message: boundedErrorMessage(err.message),
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
        message: boundedErrorMessage(providerError.message),
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

/**
 * An error as a client-visible string, bounded. Both the JSON writer and every
 * SSE error producer come through here, which is the point: the ceiling belongs
 * where the text becomes a response, not at each of the places that can raise
 * one.
 */
function rawErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * An error as a client-visible string, bounded. Both the JSON writer and every
 * SSE error producer come through here, which is the point: the ceiling belongs
 * where the text becomes a response.
 *
 * Anything that PARSES an error must use `rawErrorMessage` instead. A backend
 * signals a provider error by carrying its JSON in the message, and truncating
 * that before parsing turns a mapped 429 into an unmapped 500 whose body is a
 * fragment of broken JSON — which is exactly what happened when the bound was
 * first added here.
 */
function errorMessage(err: unknown): string {
  return boundedErrorMessage(rawErrorMessage(err));
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
  if (res.writableEnded || res.destroyed) return;
  if (!res.write(line)) {
    // A destroyed socket never drains. Awaiting it froze the writer forever,
    // and with it the turn, its cleanup, and the session — which then refused
    // every later turn.
    await new Promise<void>((resolve) => {
      const done = (): void => {
        res.off('drain', done);
        res.off('close', done);
        res.off('error', done);
        resolve();
      };
      res.once('drain', done);
      res.once('close', done);
      res.once('error', done);
    });
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
  try {
    for await (const event of events) {
      await writeSseEvent(res, event.event, event);
    }
  } catch (err) {
    // The status is already committed, so this is an in-band error like every
    // other surface's. Letting it escape reached `writeError`, whose
    // `writeHead` threw ERR_HTTP_HEADERS_SENT, and that rejection killed the
    // process — one request ended the proxy for everyone.
    if (!res.writableEnded) {
      await writeSseEvent(res, 'cli.error', { event: 'cli.error', error: streamErrorPayload(err) });
    }
  }
  if (!res.writableEnded) res.end();
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

// Every client-visible error message passes through here, so this is where the
// documented ceiling belongs: one place rather than one per producer. A model
// name a client chose, a runtime diagnostic, an upstream's prose — each reaches a
// response through some branch below, and bounding at each source has already
// been missed once.
const MAX_ERROR_MESSAGE_CHARS = 500;
const ERROR_TRUNCATION_MARKER = '...[truncated]';

function boundedErrorMessage(message: string): string {
  // A message that already fits is returned untouched. Reserving the marker
  // unconditionally shortened messages that were never too long: anything over
  // the budget but under the limit lost its tail to make room for a marker it
  // did not need.
  if (message.length <= MAX_ERROR_MESSAGE_CHARS) return message;
  const budget = MAX_ERROR_MESSAGE_CHARS - ERROR_TRUNCATION_MARKER.length;
  let out = '';
  for (const ch of message) {
    if (out.length + ch.length > budget) break;
    out += ch;
  }
  return `${out}${ERROR_TRUNCATION_MARKER}`;
}

function writeError(
  res: ServerResponse,
  err: unknown,
  shape: ErrorResponseShape = 'openai',
): void {
  if (err instanceof LocalCliChatError) {
    writeJson(res, err.statusCode, {
      error: {
        message: boundedErrorMessage(err.message),
        type: 'local_cli_chat_error',
        param: null,
        code: err.code,
      },
    });
    return;
  }
  if (err instanceof ProxyRequestError) {
    // The native surface promises its own envelope for everything, the gate
    // and configuration failures included — they happen before its handler,
    // but the caller is still a native-surface caller.
    if (shape === 'local-cli') {
      writeJson(res, err.statusCode, {
        error: {
          message: boundedErrorMessage(err.message),
          type: 'local_cli_chat_error',
          param: null,
          code: err.code,
        },
      });
      return;
    }
    // The error's own provider wins when it names one; otherwise the caller's
    // surface decides. The shared throws — method rejections, body-parse
    // failures, the 413 — carry the default provider, and on /v1/messages they
    // were answered in the OpenAI shape an Anthropic client cannot parse.
    // `invalid_request_error`, the type these throws carry, is native to both
    // vocabularies.
    if (err.provider === 'anthropic' || shape === 'anthropic') {
      writeJson(res, err.statusCode, {
        type: 'error',
        error: {
          type: err.type,
          message: boundedErrorMessage(err.message),
        },
      });
      return;
    }
    writeJson(res, err.statusCode, {
      error: {
        message: boundedErrorMessage(err.message),
        type: err.type,
        param: err.param,
        code: err.code,
      },
    });
    return;
  }
  const providerError = providerErrorFromBackendError(err);
  if (providerError) {
    // The mapped status and message survive; the ENVELOPE belongs to the
    // caller's surface. A 429 on the native surface is still a 429 — reported
    // as this surface reports errors.
    if (shape === 'local-cli') {
      writeJson(res, providerError.statusCode, {
        error: {
          message: boundedErrorMessage(providerError.message),
          type: 'local_cli_chat_error',
          param: null,
          code: providerError.code ?? null,
        },
      });
      return;
    }
    if (shape === 'anthropic') {
      writeJson(res, providerError.statusCode, {
        type: 'error',
        error: {
          type: providerError.type,
          message: boundedErrorMessage(providerError.message),
        },
      });
      return;
    }
    writeJson(res, providerError.statusCode, {
      error: {
        message: boundedErrorMessage(providerError.message),
        type: providerError.type,
        param: providerErrorParamForShape(providerError.param, shape),
        code: providerError.code,
      },
    });
    return;
  }
  // A failure with no provider mapping is still answered in the shape the caller
  // asked in. `/v1/messages` has its own envelope and no `param`/`code`; sending
  // the OpenAI body there hands an Anthropic client something it cannot parse.
  const message = boundedErrorMessage(err instanceof Error ? err.message : String(err));
  if (shape === 'local-cli') {
    writeJson(res, 500, {
      error: { message, type: 'local_cli_chat_error', param: null, code: null },
    });
    return;
  }
  if (shape === 'anthropic') {
    writeJson(res, 500, { type: 'error', error: { type: 'api_error', message } });
    return;
  }
  writeJson(res, 500, {
    error: {
      message,
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
  const outer = parseObject(rawErrorMessage(err));
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
