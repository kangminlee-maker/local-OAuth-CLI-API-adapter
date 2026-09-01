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
  BACKEND_IDENTIFIERS, MAX_ERROR_MESSAGE_CHARS, ProxyRequestError } from './types.js';
import { unsupportedImageFileIds } from './multimodal.js';
import { hasToolDecisionSchema } from './backend-contract.js';
import { StopSequenceGate, truncateAtStopSequence } from './stop-sequences.js';
import { missingToolCallArgumentDelta } from './tool-call-stream.js';
import { image2QualityToGpt55ReasoningEffort } from './image2-via-gpt55.js';
import {
  jsonTypeName,
  normalizeAnthropicMessagesRequest,
  resolvedOpenAiServiceTier,
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
  const server = createServer((req, res) => {
    void handleRequest(req, res, options);
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
  // `/v1/images/variations` is gone from the direct API (404, measured
  // 2026-08-29, with the dall-e-2 model it served), so it is unknown here too.
]);

class UnknownEndpointError extends ProxyRequestError {
  constructor(path: string) {
    super(`Unknown endpoint: ${path}`, 404);
  }
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: ProxyServerOptions,
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
    const isGetRoute = path === '/v1/models';
    // Path first, method second: `GET /v1/nope` is an unknown endpoint, not an
    // unsupported method. 405 is reserved for a path this proxy does serve —
    // including the GET route, so `POST /v1/models` is a method problem, not a
    // missing endpoint.
    if (!isGetRoute && !POST_ENDPOINTS.has(path)) {
      throw new UnknownEndpointError(path);
    }
    if (req.method !== (isGetRoute ? 'GET' : 'POST')) {
      throw new ProxyRequestError('Unsupported method.', 405);
    }
    if (path === '/v1/models') {
      writeJson(res, 200, await openAiModelsResponse(backend));
      return;
    }

    if (path === '/v1/images/generations') {
      const { body, isMultipart } = await readImageRequestBody(req);
      const normalized = normalizeOpenAiImageRequest(body, 'generation', isMultipart);
      await handleOpenAiImageRequest(res, options, normalized);
      return;
    }
    if (path === '/v1/images/edits') {
      const { body, isMultipart } = await readImageRequestBody(req);
      const normalized = normalizeOpenAiImageRequest(body, 'edit', isMultipart);
      await handleOpenAiImageRequest(res, options, normalized);
      return;
    }
    const body = await readJsonBody(req);
    if (path === '/v1/chat/completions') {
      errorShape = 'openai-chat';
      const normalized = normalizeOpenAiChatRequest(body);
      rejectDeferredFeatures(normalized);
      // `n` is realized as n backend turns — the runtimes have no slot for it,
      // and n independent samples is exactly what n turns are.
      const choiceCount = normalized.choices ?? 1;
      if (normalized.stream) {
        // One `close` listener per turn is wired inside `streamEvents`.
        if (choiceCount > 1) res.setMaxListeners(choiceCount + 10);
        // The turns of one fan-out share a cancel: the first failure ends them
        // all, instead of each waiting out its own timeout.
        const fanOut = new AbortController();
        await writeOpenAiChatStream(
          res,
          await startFanOutStreams(
            choiceCount,
            () => streamEvents(backend, normalized, requestTimeoutMs, res, fanOut.signal),
            () => fanOut.abort(),
          ),
          await requestReportingExecutedModel(backend, normalized),
          () => fanOut.abort(),
        );
      } else {
        const results = await runChoicesWithTimeout(backend, normalized, choiceCount, requestTimeoutMs, res);
        writeJson(res, 200, openAiChatResponse(results, normalized));
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
        writeJson(res, 200, anthropicMessagesResponse(applyStopSequences(result, normalized)));
      }
      return;
    }

    throw new UnknownEndpointError(path);
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
  res: ServerResponse,
  options: ProxyServerOptions,
  request: OpenAiImageGenerationRequest,
): Promise<void> {
  const client = options.imageGenerationClient ?? unsupportedLocalOAuthImageGenerationClient();
  if (request.stream) {
    await writeOpenAiImageStream(
      res,
      runImageGenerationStreamWithTimeout(client, request, options.requestTimeoutMs, res),
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
  writeJson(res, 200, openAiImagesGenerationResponse(result, request));
}

function normalizeOpenAiImageRequest(
  body: unknown,
  operation: OpenAiImageOperation,
  isMultipart: boolean,
): OpenAiImageGenerationRequest {
  const input = asRecordPayload(body);
  // The order below is the order the direct API reports problems in, measured
  // 2026-08-29/30 with bodies carrying two faults at once: `model`, then any
  // key it does not know, then `prompt`, then `images`, then `n`, then the
  // rest. A client fixing errors one at a time sees the same sequence here.
  const model = openAiImageModel(input.model);
  rejectUnknownOpenAiImageParameters(input, operation, isMultipart);
  const prompt = imagePrompt(input.prompt);
  if (prompt.length > 32_000) {
    throw new ProxyRequestError('prompt must be 32000 characters or fewer.', 400);
  }
  const images = imageInputsForOperation(input, operation, isMultipart);
  if (operation === 'edit' && images.length === 0) {
    throw new ProxyRequestError(
      isMultipart
        ? 'image input is required for image edits.'
        : "Invalid 'images': empty array. Expected an array with minimum length 1, but got an empty array instead.",
      400,
      'openai',
      'invalid_request_error',
      isMultipart ? 'image' : 'images',
      isMultipart ? null : 'empty_array',
    );
  }
  const n = imageInteger(input.n, 'n', 1, 10, isMultipart) ?? 1;
  // `quality` is checked before `output_compression`, `size` after it
  // (measured with two faults per form).
  const quality = imageEnum(input.quality, 'quality', ['low', 'medium', 'high', 'auto'], isMultipart);
  const proxyRoute = optionalImageProxyRoute(input.x_proxy_image_route);
  const outputFormat = imageEnum(input.output_format, 'output_format', ['png', 'webp', 'jpeg'], isMultipart)
    ?? proxyRoute?.outputFormat;
  const outputCompression = imageInteger(input.output_compression, 'output_compression', 0, 100, isMultipart)
    ?? proxyRoute?.outputCompression;
  const request: OpenAiImageGenerationRequest = {
    operation,
    model,
    prompt,
    n,
    images,
    // On a generation `mask` is an unknown parameter (rejected above); on a
    // multipart generation it is simply not read.
    mask: operation === 'edit' ? requiredValidImageInput(input.mask, 'mask') : undefined,
    size: optionalImageSize(input.size),
    quality,
    background: imageEnum(input.background, 'background', ['transparent', 'opaque', 'auto'], isMultipart),
    outputFormat,
    outputCompression,
    moderation: imageEnum(input.moderation, 'moderation', ['auto', 'low'], isMultipart),
    inputFidelity: imageEnum(input.input_fidelity, 'input_fidelity', ['high', 'low'], isMultipart),
    user: optionalString(input.user),
    stream: imageBoolean(input.stream, 'stream', isMultipart) ?? false,
    partialImages: partialImageCount(input.partial_images, isMultipart),
    ...(proxyRoute ? { proxyRoute } : {}),
    raw: body,
  };
  validateOpenAiImageRequest(request);
  return request;
}

// The Images models the direct API serves, read from its `GET /v1/models` on
// 2026-08-29. Every one of them runs on the local image backend; the name a
// client sends selects nothing but its own validation. `dall-e-2`, `dall-e-3`
// and the proxy's former invented route name `image-2` are refused exactly as
// the direct API refuses them, because it does: "The model 'dall-e-2' does not
// exist." Refresh against the live list when the vendor's changes.
const OPENAI_IMAGE_MODELS: ReadonlySet<string> = new Set([
  'chatgpt-image-latest',
  'gpt-image-1',
  'gpt-image-1-mini',
  'gpt-image-1.5',
  'gpt-image-2',
  'gpt-image-2-2026-04-21',
]);

// `model` is required on the direct API (measured 2026-08-29: absent is
// `missing_required_parameter`, null and a number are `invalid_type`, an
// unknown or empty name "does not exist"). The proxy used to default an absent
// model to dall-e-2, a model that no longer exists to default to.
function openAiImageModel(value: unknown): string {
  if (value === undefined) {
    throw new ProxyRequestError(
      "Missing required parameter: 'model'.",
      400,
      'openai',
      'invalid_request_error',
      'model',
      'missing_required_parameter',
    );
  }
  if (typeof value !== 'string') {
    throw new ProxyRequestError(
      `Invalid type for 'model': expected a string, but got ${jsonTypeName(value)} instead.`,
      400,
      'openai',
      'invalid_request_error',
      'model',
      'invalid_type',
    );
  }
  if (!OPENAI_IMAGE_MODELS.has(value)) {
    throw new ProxyRequestError(
      `The model '${value}' does not exist.`,
      400,
      'openai',
      'image_generation_user_error',
      'model',
      'invalid_value',
    );
  }
  return value;
}

// A JSON body may carry only the keys the direct API knows for the operation
// (measured 2026-08-29/30: `response_format`, `style`, a generation's
// `input_fidelity`, `mask` or `images`, and any made-up key are all "Unknown
// parameter: 'x'.", and a present null counts as present). The one deliberate
// exception is `x_proxy_image_route`, this proxy's documented extension —
// the direct API refuses it, and the contract says so. A multipart edit names
// its files `image` / `image[]` instead of `images`; in JSON those two
// spellings get the direct API's pointer to `images` (measured), not the bare
// unknown-parameter line. Multipart bodies are held to the same key set (the
// direct API's form-data answer was not measured; accepting a key JSON refuses
// would be the stranger choice).
const OPENAI_IMAGE_GENERATION_KEYS: ReadonlySet<string> = new Set([
  'model', 'prompt', 'n', 'size', 'quality', 'background', 'output_format',
  'output_compression', 'moderation', 'user', 'stream', 'partial_images',
  'x_proxy_image_route',
]);
const OPENAI_IMAGE_EDIT_KEYS: ReadonlySet<string> = new Set([
  ...OPENAI_IMAGE_GENERATION_KEYS, 'images', 'mask', 'input_fidelity',
]);
const OPENAI_IMAGE_EDIT_MULTIPART_KEYS: ReadonlySet<string> = new Set([
  ...[...OPENAI_IMAGE_EDIT_KEYS].filter((key) => key !== 'images'), 'image', 'image[]',
]);

function rejectUnknownOpenAiImageParameters(
  input: Record<string, unknown>,
  operation: OpenAiImageOperation,
  isMultipart: boolean,
): void {
  const known = operation === 'edit'
    ? (isMultipart ? OPENAI_IMAGE_EDIT_MULTIPART_KEYS : OPENAI_IMAGE_EDIT_KEYS)
    : OPENAI_IMAGE_GENERATION_KEYS;
  for (const name of Object.keys(input)) {
    if (known.has(name)) continue;
    // The two encodings spell the image field differently, and the direct API
    // points a body at the other spelling (both measured).
    const pointer = operation !== 'edit'
      ? null
      : !isMultipart && (name === 'image' || name === 'image[]')
        ? "For application/json on /v1/images/edits, use 'images' (array)."
        : isMultipart && name === 'images'
          ? "For multipart/form-data use 'image' or 'image[]'."
          : null;
    if (pointer) {
      throw new ProxyRequestError(`Unknown parameter: '${name}'. ${pointer}`, 400, 'openai', 'invalid_request_error', name, 'invalid_value');
    }
    throw unknownImageParameter(name);
  }
}

function unknownImageParameter(name: string): ProxyRequestError {
  return new ProxyRequestError(
    `Unknown parameter: '${name}'.`,
    400,
    'openai',
    'invalid_request_error',
    name,
    'unknown_parameter',
  );
}

// The direct API's wording for a wrong JSON type — "got null / an integer / a
// decimal number / a boolean / an object / an array instead" — each measured
// on `model` (2026-08-30).
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
  // `input_fidelity` on an edit is the backend's answer, forwarded — it
  // refuses today (`invalid_input_fidelity_model`); on a generation it was
  // refused as an unknown parameter before the body was parsed.
  if (request.background === 'transparent' && request.outputFormat === 'jpeg') {
    throw new ProxyRequestError('background transparent requires output_format to be png or webp.', 400);
  }
}

// Absent, wrong type, and empty are three different answers on the direct API
// (measured 2026-08-30); a whitespace-only prompt is accepted and generates.
function imagePrompt(value: unknown): string {
  if (value === undefined) {
    throw new ProxyRequestError("Missing required parameter: 'prompt'.", 400, 'openai', 'invalid_request_error', 'prompt', 'missing_required_parameter');
  }
  if (typeof value !== 'string') {
    throw new ProxyRequestError(`Invalid type for 'prompt': expected a string, but got ${jsonTypeName(value)} instead.`, 400, 'openai', 'invalid_request_error', 'prompt', 'invalid_type');
  }
  if (value === '') {
    throw new ProxyRequestError("Invalid 'prompt': empty string. Expected a string with minimum length 1, but got an empty string instead.", 400, 'openai', 'invalid_request_error', 'prompt', 'empty_string');
  }
  return value;
}

function imageInputsForOperation(
  input: Record<string, unknown>,
  operation: OpenAiImageOperation,
  isMultipart: boolean,
): readonly NormalizedImage[] {
  if (operation === 'generation') return [];
  // A multipart edit names its files `image` or `image[]`, as the direct
  // API's form does.
  if (isMultipart) return imageInputArray(input.image ?? input['image[]']);
  // A JSON edit carries `images`, an array of objects, and nothing else —
  // measured 2026-08-29: a non-array `images` and a string member each have
  // their own envelope (`image` / `image[]` were refused upstream, as unknown
  // keys with the direct API's pointer). The proxy used to take them all as
  // aliases.
  if (input.images === undefined) {
    throw new ProxyRequestError(
      "Missing required parameter: 'images'.",
      400,
      'openai',
      'invalid_request_error',
      'images',
      'missing_required_parameter',
    );
  }
  if (!Array.isArray(input.images)) {
    throw new ProxyRequestError(
      `Invalid type for 'images': expected an array of objects, but got ${jsonTypeName(input.images)} instead.`,
      400,
      'openai',
      'invalid_request_error',
      'images',
      'invalid_type',
    );
  }
  input.images.forEach((member, index) => {
    if (!member || typeof member !== 'object' || Array.isArray(member)) {
      throw new ProxyRequestError(
        `Invalid type for 'images[${index}]': expected an object, but got ${jsonTypeName(member)} instead.`,
        400,
        'openai',
        'invalid_request_error',
        `images[${index}]`,
        'invalid_type',
      );
    }
  });
  return imageInputArray(input.images);
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

// The direct API's integer envelopes (measured 2026-08-30 on `n`,
// `output_compression`, `partial_images`): a wrong JSON type names the type
// it got, a decimal is "a decimal number", and a value outside the range is
// `integer_below_min_value` / `integer_above_max_value` naming the bound and
// the value. Null is omission. A multipart field arrives as a string, so
// there a digit string is the integer it spells.
function imageInteger(
  value: unknown,
  field: string,
  min: number,
  max: number,
  isMultipart: boolean,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  let parsed: number;
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw invalidImageType(field, 'an integer', 'a decimal number');
    parsed = value;
  } else if (isMultipart && typeof value === 'string') {
    if (!/^-?\d+$/.test(value.trim())) {
      // The one type sentence the direct API ends without "instead" (measured).
      throw new ProxyRequestError(`Invalid type for '${field}': expected an integer, but got a string value that could not be converted into an integer.`, 400, 'openai', 'invalid_request_error', field, 'invalid_type');
    }
    parsed = Number(value.trim());
  } else {
    throw invalidImageType(field, 'an integer', jsonTypeName(value));
  }
  if (parsed < min) {
    throw new ProxyRequestError(`Invalid '${field}': integer below minimum value. Expected a value >= ${min}, but got ${parsed} instead.`, 400, 'openai', 'invalid_request_error', field, 'integer_below_min_value');
  }
  if (parsed > max) {
    throw new ProxyRequestError(`Invalid '${field}': integer above maximum value. Expected a value <= ${max}, but got ${parsed} instead.`, 400, 'openai', 'invalid_request_error', field, 'integer_above_max_value');
  }
  return parsed;
}

// The direct API's enum envelopes (measured 2026-08-30 on `quality`,
// `output_format`, `moderation`, `background`): a string outside the set is
// `invalid_value` listing the set, a non-string is `invalid_type` listing the
// set with "or". Null is omission; the empty string is a value outside the
// set. The order of `allowed` is the order the direct API lists.
function imageEnum<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
  isMultipart: boolean,
): T | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    // A file part or a repeated field is not a value in the set either — in
    // a form as in JSON, it is a type error, never a silent omission.
    throw invalidImageType(field, `one of ${quotedList(allowed, 'or')}`, jsonTypeName(value));
  }
  if (!allowed.includes(value as T)) {
    throw new ProxyRequestError(`Invalid value: '${value}'. Supported values are: ${quotedList(allowed, 'and')}.`, 400, 'openai', 'invalid_request_error', field, 'invalid_value');
  }
  return value as T;
}

function imageBoolean(value: unknown, field: string, isMultipart: boolean): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value;
  if (isMultipart && value === '') return undefined;
  if (isMultipart && (value === 'true' || value === 'false')) return value === 'true';
  throw invalidImageType(field, 'a boolean', jsonTypeName(value));
}

function invalidImageType(field: string, expected: string, got: string): ProxyRequestError {
  return new ProxyRequestError(`Invalid type for '${field}': expected ${expected}, but got ${got} instead.`, 400, 'openai', 'invalid_request_error', field, 'invalid_type');
}

// "'a', 'b', and 'c'" / "'a' and 'b'" — the direct API's list punctuation.
function quotedList(items: readonly string[], conjunction: 'and' | 'or'): string {
  const quoted = items.map((item) => `'${item}'`);
  if (quoted.length <= 1) return quoted.join('');
  if (quoted.length === 2) return `${quoted[0]} ${conjunction} ${quoted[1]}`;
  return `${quoted.slice(0, -1).join(', ')}, ${conjunction} ${quoted[quoted.length - 1]}`;
}

function partialImageCount(value: unknown, isMultipart: boolean): number {
  const parsed = imageInteger(value, 'partial_images', 0, 3, isMultipart) ?? 0;
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
  return parsed;
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

// The direct API's size envelopes (measured 2026-08-30): anything that is not
// WIDTHxHEIGHT — `bogus`, `0x0` — and a dimension not divisible by 16 are
// each `image_generation_user_error` / `size` / `invalid_value` with their own
// sentence. `auto` passes; null is omission.
function optionalImageSize(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw invalidImageType('size', 'a string', jsonTypeName(value));
  const size = value;
  if (size === 'auto') return size;
  const invalid = (detail: string): ProxyRequestError => new ProxyRequestError(
    `Invalid size '${size}'. ${detail}`, 400, 'openai', 'image_generation_user_error', 'size', 'invalid_value',
  );
  const match = /^(\d+)x(\d+)$/.exec(size);
  const width = match ? Number(match[1]) : 0;
  const height = match ? Number(match[2]) : 0;
  if (!match || width <= 0 || height <= 0) throw invalid("Expected WIDTHxHEIGHT, for example '1824x1024'.");
  if (width % 16 !== 0 || height % 16 !== 0) throw invalid('Width and height must both be divisible by 16.');
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

/**
 * Chat `n`, realized: n independent turns, run together, one per `choices[]`
 * entry. A turn that fails cancels its siblings — they are already-lost work,
 * and on a serialized backend they would hold the queue for a caller that has
 * its error already.
 */
async function runChoicesWithTimeout(
  backend: LocalCliBackend,
  request: NormalizedRequest,
  count: number,
  requestTimeoutMs: number,
  res: ServerResponse,
): Promise<LocalCompletionResult[]> {
  const abort = turnAbort(res, requestTimeoutMs);
  const fanOut = new AbortController();
  const onAbort = (): void => fanOut.abort();
  abort.signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.all(Array.from({ length: count }, () => backend
      .generate(request, fanOut.signal)
      .catch((err: unknown) => {
        fanOut.abort();
        throw err;
      })));
  } finally {
    abort.signal.removeEventListener('abort', onAbort);
    abort.release();
  }
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
  let delivered = false;
  let closed = false;
  // The wrapper drives the backend iterator by hand, so closing early — a
  // client disconnect after the first event, or a fan-out sibling abandoned
  // when another turn failed to start — would otherwise never reach the source
  // generator's own cleanup, leaving its timeout, CLI process, or backend lock
  // alive. It is written as an explicit iterator rather than a generator
  // because `return()` on a generator that was never started skips its body:
  // an abandoned turn nothing ever read is exactly that case.
  const close = async (): Promise<IteratorResult<LocalStreamEvent>> => {
    if (!closed) {
      closed = true;
      await iterator.return?.();
    }
    return { done: true, value: undefined };
  };
  return {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<LocalStreamEvent>> {
          if (closed) return { done: true, value: undefined };
          if (!delivered) {
            delivered = true;
            if (!first.done) return { done: false, value: first.value };
            return await close();
          }
          try {
            const next = await iterator.next();
            return next.done ? await close() : next;
          } catch (err) {
            await close();
            throw err;
          }
        },
        return: close,
      };
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

/**
 * A fan-out's turns, with the whole fan-out cancelled if any of them fails to
 * start.
 *
 * With honouring on, `streamEvents` prefetches each turn's first event, so a
 * turn that fails before that event rejects HERE — before the writer that owns
 * the shared cancel exists, which is the only place the siblings were being
 * cancelled from. Measured before this: `n: 3` with the first turn throwing
 * answered the client in 13ms and left turns 1 and 2 suspended with zero abort
 * signals fired, generating until their own request timeouts.
 */
async function startFanOutStreams(
  count: number,
  start: () => Promise<AsyncIterable<LocalStreamEvent>>,
  cancel: () => void,
): Promise<AsyncIterable<LocalStreamEvent>[]> {
  let failure: { readonly reason: unknown } | undefined;
  // Cancel on the FIRST start to fail, not once every start has settled.
  // Awaiting all of them first cannot work: the siblings being cancelled are
  // exactly the ones still pending, so the wait is for the thing the cancel is
  // supposed to end. Measured before this, with a 300ms request timeout: the
  // client got its 500 at 326ms and the sibling aborts fired at 319ms — the
  // whole timeout, and at 30s the client would have waited 30s for an error
  // known in milliseconds.
  const started = await Promise.all(Array.from({ length: count }, () => start().then(
    (events) => ({ events }),
    (reason: unknown) => {
      if (!failure) {
        failure = { reason };
        cancel();
      }
      return { events: undefined };
    },
  )));
  const live = started.map((entry) => entry.events).filter((events) => events !== undefined);
  if (!failure) return live;
  // Cancel first, then collect: an iterator suspended inside `next()` queues a
  // `return()` behind that call, which is the same trap `mergeTaggedStreams`
  // documents in its own `finally`. The cancel above has already run.
  await Promise.allSettled(live.map((events) => events[Symbol.asyncIterator]().return?.()));
  throw failure.reason;
}

function streamEvents(
  backend: LocalCliBackend,
  request: NormalizedRequest,
  requestTimeoutMs: number,
  res: ServerResponse,
  fanOut?: AbortSignal,
): Promise<AsyncIterable<LocalStreamEvent>> {
  // The cancel signal is wired in BOTH modes and lives for the whole
  // iteration. It used to exist only during honor-on prefetch, so a client
  // that left mid-stream kept its backend turn running to the timeout — and on
  // a serialized backend the next client paid for it.
  //
  // A fan-out's siblings cancel through the same door: when one choice fails
  // the others are turns nothing will read, and without this they ran to the
  // request timeout with the client's error held back behind them.
  const cancelled = new AbortController();
  const onResponseClose = (): void => {
    if (!res.writableEnded) cancelled.abort();
  };
  const onFanOut = (): void => cancelled.abort();
  res.once('close', onResponseClose);
  if (fanOut?.aborted) cancelled.abort();
  else fanOut?.addEventListener('abort', onFanOut, { once: true });
  const release = (): void => {
    res.removeListener('close', onResponseClose);
    fanOut?.removeEventListener('abort', onFanOut);
  };
  const events = releaseOnFinish(
    runStreamWithTimeout(backend, request, requestTimeoutMs, cancelled.signal),
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

// An IPv6 literal needs brackets inside a URL authority — `http://::1:8080`
// does not parse. Hostnames and IPv4 pass through untouched.
function urlHostname(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
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
  result: OpenAiImageGenerationResult,
  request: OpenAiImageGenerationRequest,
): unknown {
  return {
    created: result.created,
    // At most `n` images: the count is backend-controlled, `n` is the
    // request's, the same rule the streamed path applies.
    data: result.images.slice(0, request.n ?? 1).map(openAiImageObject),
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

function openAiImageObject(image: OpenAiGeneratedImage): unknown {
  return {
    b64_json: image.b64Json,
    ...(image.revisedPrompt ? { revised_prompt: image.revisedPrompt } : {}),
  };
}

async function writeOpenAiImageStream(
  res: ServerResponse,
  events: AsyncIterable<OpenAiImageGenerationStreamEvent>,
  request: OpenAiImageGenerationRequest,
): Promise<void> {
  // The stream commits on the backend's first event, not before it. A backend
  // that refuses the request outright — an option its image model does not
  // support — answers with an HTTP error before any stream byte, and the
  // client gets that error as an HTTP status, exactly as the non-streaming
  // path reports it and as the local validators do. Writing the 200 first
  // turned the same refusal into an in-band error frame for one model and a
  // 400 for another.
  let committed = false;
  const commit = (): void => {
    if (committed) return;
    writeSseHeaders(res);
    committed = true;
  };
  // The event count is backend-controlled; `n` is the request's. A runaway
  // stream must not emit more images than were asked for — nor pin more.
  let completedEmitted = 0;
  try {
    for await (const event of events) {
      commit();
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
        b64_json: event.image.b64Json,
        // The provider's rewrite of the prompt, which the non-streaming
        // response carries: a client comparing the two modes saw it vanish.
        ...(event.image.revisedPrompt ? { revised_prompt: event.image.revisedPrompt } : {}),
        ...(event.usage ? { usage: openAiImagesUsage(event.usage) } : {}),
      };
      await writeSseEvent(res, type, payload);
    }
    // A backend that ends without an event is still a stream that ran.
    commit();
  } catch (err) {
    // Nothing on the wire yet: the request handler's error path writes the
    // status and envelope.
    if (!committed) throw err;
    await writeSseEvent(res, 'error', streamErrorPayload(err));
    // The OpenAI mid-stream contract: an in-band error, then `data: [DONE]` —
    // the images stream was the one OpenAI surface that ended without it.
    res.write('data: [DONE]\n\n');
  } finally {
    if (committed) res.end();
  }
}

function imageStreamEventType(
  operation: OpenAiImageOperation,
  eventType: OpenAiImageGenerationStreamEvent['type'],
): string {
  const prefix = operation === 'edit' ? 'image_edit' : 'image_generation';
  return eventType === 'partial_image'
    ? `${prefix}.partial_image`
    : `${prefix}.completed`;
}

function openAiChatResponse(
  results: readonly LocalCompletionResult[],
  request: NormalizedRequest,
): unknown {
  const [first] = results;
  return {
    id: `chatcmpl-${first.id}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: first.model,
    choices: results.map((result, index) => openAiChatChoice(result, index)),
    usage: openAiChatUsage(mergedChatUsage(results)),
    service_tier: echoedServiceTier(request),
    system_fingerprint: null,
  };
}

function openAiChatChoice(result: LocalCompletionResult, index: number): unknown {
  const hasToolCalls = result.toolCalls.length > 0;
  return {
    index,
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
  };
}

/**
 * One usage for a fan-out, shaped as the direct API shapes it: the PROMPT is
 * counted once and the completions are summed (measured on `n: 2` —
 * `prompt_tokens` unchanged, `completion_tokens` doubled). This proxy really
 * does send the prompt once per turn, so the number under-reports what the
 * backend consumed; the contract's `n` row says so. Reporting it n times would
 * hand a client a number no direct response can produce.
 */
function mergedChatUsage(results: readonly LocalCompletionResult[]): LocalUsage {
  const [first, ...rest] = results;
  if (rest.length === 0) return first.usage;
  let outputTokens = first.usage.outputTokens;
  let reasoningOutputTokens = first.usage.reasoningOutputTokens;
  for (const result of rest) {
    outputTokens += result.usage.outputTokens;
    if (result.usage.reasoningOutputTokens !== undefined) {
      reasoningOutputTokens = (reasoningOutputTokens ?? 0) + result.usage.reasoningOutputTokens;
    }
  }
  return {
    ...first.usage,
    outputTokens,
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
    ...(first.usage.totalTokens !== undefined
      ? { totalTokens: first.usage.inputTokens + outputTokens }
      : {}),
  };
}

/**
 * The tier the response reports. The direct API does not echo the request
 * verbatim — `fast` comes back as `priority` — so the resolution lives with
 * the validator that knows the enum, and the value here is only ever one the
 * validator has already accepted. Hard-coding `default` for every request
 * reported a tier the caller had not asked for; echoing the request reported
 * one the direct API never sends.
 */
function echoedServiceTier(request: NormalizedRequest): string {
  const raw = request.raw as Record<string, unknown> | null | undefined;
  return resolvedOpenAiServiceTier(raw && typeof raw === 'object' ? raw.service_tier : undefined);
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

/**
 * `stop_sequences` on a finished turn: the text is cut before the first one and
 * the turn reports that it stopped there — the direct API's answer, realized in
 * the response path because no runtime carries the option. A turn that made
 * tool calls keeps `tool_use` as its reason; only the text is cut.
 */
function applyStopSequences(
  result: LocalCompletionResult,
  request: NormalizedRequest,
): LocalCompletionResult {
  const sequences = request.stopSequences ?? [];
  if (sequences.length === 0) return result;
  const { text, sequence } = truncateAtStopSequence(result.text, sequences);
  if (sequence === null) return result;
  return {
    ...result,
    text,
    ...(result.toolCalls.length === 0
      ? { stopReason: 'stop_sequence', stopSequence: sequence, stopDetails: undefined }
      : {}),
  };
}

/**
 * Reconciles a finished turn with what the stop-sequence gate let through.
 * Three cases: a sequence matched on the wire (the turn is a `stop_sequence`
 * stop and nothing more is written), the result's full text contains one the
 * deltas never carried (the same, computed from the result), or neither (the
 * held-back tail plus whatever text the deltas missed is written as usual).
 */
function applyStreamStopSequence(
  result: LocalCompletionResult,
  gate: StopSequenceGate,
  streamedText: string,
): { readonly result: LocalCompletionResult; readonly tail: string } {
  if (!gate.active) return { result, tail: missingTextTail(streamedText, result.text) };
  const stopped = (sequence: string): { result: LocalCompletionResult; tail: string } => ({
    result: result.toolCalls.length === 0
      ? { ...result, text: streamedText, stopReason: 'stop_sequence', stopSequence: sequence, stopDetails: undefined }
      : { ...result, text: streamedText },
    tail: '',
  });
  if (gate.stopped) return stopped(gate.stopped);
  // The deltas may have carried nothing at all (a schema or refusal result), so
  // the result's own text goes through the gate before it is written. What the
  // gate is still holding stays inside it — `push` prepends it — and the flush
  // resolves the turn, which is where a deferred match becomes the answer.
  const remaining = missingTextTail(streamedText + gate.pending, result.text);
  const emitted = gate.push(remaining) + gate.flush();
  if (gate.stopped) {
    return {
      ...stopped(gate.stopped),
      tail: emitted,
      result: result.toolCalls.length === 0
        ? { ...result, text: streamedText + emitted, stopReason: 'stop_sequence', stopSequence: gate.stopped, stopDetails: undefined }
        : { ...result, text: streamedText + emitted },
    };
  }
  return { result, tail: emitted };
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
    background: raw.background === true ? true : false,
    ...(options.includeBilling === false ? {} : { billing: { payer: 'developer' } }),
    completed_at: options.completed ? now : null,
    error: null,
    frequency_penalty: numberOrDefault(raw.frequency_penalty, 0),
    incomplete_details: null,
    instructions: typeof raw.instructions === 'string' ? raw.instructions : null,
    max_output_tokens: options.request.maxTokens ?? null,
    max_tool_calls: numberOrNull(raw.max_tool_calls),
    model: options.model,
    moderation: null,
    output: options.output,
    parallel_tool_calls: raw.parallel_tool_calls === false ? false : true,
    presence_penalty: numberOrDefault(raw.presence_penalty, 0),
    previous_response_id: typeof raw.previous_response_id === 'string' ? raw.previous_response_id : null,
    prompt_cache_key: typeof raw.prompt_cache_key === 'string' ? raw.prompt_cache_key : null,
    // Echoed with its defaults filled in, as the direct API echoes it
    // (measured 2026-08-30: `{ttl:'30m'}` in, `{mode:'implicit', ttl:'30m'}`
    // out), and absent from the body when the caller sent none.
    ...(raw.prompt_cache_options && typeof raw.prompt_cache_options === 'object'
      ? { prompt_cache_options: { mode: 'implicit', ttl: '30m', ...asRecordPayload(raw.prompt_cache_options) } }
      : {}),
    // The only value this surface accepts; `in_memory` is refused at the door.
    prompt_cache_retention: '24h',
    reasoning: responseReasoning(raw.reasoning),
    safety_identifier: typeof raw.safety_identifier === 'string' ? raw.safety_identifier : null,
    service_tier: echoedServiceTier(options.request),
    store: raw.store === false ? false : true,
    // Sampling is echoed at the direct API's defaults, which are the only
    // values a request can still carry here: the normalizer rejects any other
    // `temperature`, and `top_p` altogether, on this surface. The echo used to
    // repeat whatever the caller sent, for a value no backend applied.
    temperature: 1,
    // Measured, not assumed: with no `top_p` in the request — the only
    // possibility, since this surface refuses the parameter — the direct API
    // echoes 0.98, not 1.

    text: responseTextConfig(raw.text),
    tool_choice: responseToolChoice(raw.tool_choice),
    tools: Array.isArray(raw.tools) ? raw.tools : [],
    top_logprobs: numberOrDefault(raw.top_logprobs, 0),
    top_p: 0.98,
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

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
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
/**
 * The part of the final text a stream has not delivered. Live deltas can stop
 * short of the finished answer — a wrapper's text is read from a growing
 * snapshot — and a surface that only handles "nothing was streamed" then
 * truncates the reply at whatever arrived first.
 */
function missingTextTail(streamed: string, final: string): string {
  if (!final || final === streamed) return '';
  if (!streamed) return final;
  return final.startsWith(streamed) ? final.slice(streamed.length) : '';
}

function anthropicUsage(usage: LocalUsage): Record<string, number> {
  // A zero is not a report: the OpenAI-shaped producers read `cached_tokens`
  // with a numeric default, and merged usages sum absent halves into 0, so
  // treating 0 as "this runtime reports caching" put `cache_read_input_tokens:
  // 0` on every cache-miss turn and re-hid a real hit behind a merged zero.
  const openAiCacheRead = usage.cachedInputTokens || undefined;
  const cacheRead = usage.cacheReadInputTokens ?? openAiCacheRead;
  const inputTokens = usage.cacheReadInputTokens === undefined && openAiCacheRead !== undefined
    ? Math.max(usage.inputTokens - openAiCacheRead, 0)
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

/**
 * The Chat stream, with `n` realized: one backend turn per choice, merged as
 * their events arrive and written with each choice's own `index`. Every chunk
 * carries exactly one choice, which is how the direct API streams a fan-out
 * (measured 2026-08-30 on `n: 2`: the two choices' role, content and stop
 * chunks interleave, one choice per chunk). With one choice this is the stream
 * it has always been.
 */
async function writeOpenAiChatStream(
  res: ServerResponse,
  streams: readonly AsyncIterable<LocalStreamEvent>[],
  request: NormalizedRequest,
  cancel?: () => void,
): Promise<void> {
  writeSseHeaders(res);
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  let base = {
    id,
    object: 'chat.completion.chunk',
    created,
    model: request.model,
    service_tier: echoedServiceTier(request),
    system_fingerprint: null,
  };
  const choices = streams.map((_, index) => new OpenAiChatChoiceStream(res, request, index));
  const results: LocalCompletionResult[] = [];
  try {
    for (const choice of choices) await choice.start(base);
    for await (const { index, value: event } of mergeTaggedStreams(streams, cancel)) {
      const result = await choices[index].push(base, event);
      if (result) {
        base = { ...base, model: result.model };
        results.push(result);
      }
    }
    if (request.streamOptions.includeUsage && results.length > 0) {
      await writeSseData(res, {
        ...base,
        choices: [],
        usage: openAiChatUsage(mergedChatUsage(results)),
        ...(request.streamOptions.includeObfuscation ? { obfuscation: randomObfuscation() } : {}),
      });
    }
    res.write('data: [DONE]\n\n');
  } catch (err) {
    await writeSseData(res, streamErrorPayload(err));
    res.write('data: [DONE]\n\n');
  } finally {
    res.end();
  }
}

/**
 * Interleaves n event streams, tagging each event with the stream it came
 * from. One stream's failure propagates — a fan-out that answers a client with
 * three of its four choices and no error would be worse than the error — and
 * the `finally` closes the siblings, so a rejected turn does not leave the
 * others generating for nobody.
 */
async function* mergeTaggedStreams<T>(
  sources: readonly AsyncIterable<T>[],
  cancel?: () => void,
): AsyncIterable<{ index: number; value: T }> {
  const iterators = sources.map((source) => source[Symbol.asyncIterator]());
  const pending = new Map<number, Promise<{ index: number; result: IteratorResult<T> }>>();
  const pull = (index: number): void => {
    pending.set(index, iterators[index].next().then((result) => ({ index, result })));
  };
  iterators.forEach((_, index) => pull(index));
  try {
    while (pending.size > 0) {
      const { index, result } = await Promise.race(pending.values());
      pending.delete(index);
      if (result.done) continue;
      pull(index);
      yield { index, value: result.value };
    }
  } finally {
    // Cancel FIRST, then collect. `iterator.return()` on a generator suspended
    // inside `next()` is queued behind that call, so awaiting the returns
    // without cancelling waits for whatever the sibling is waiting for — in
    // practice the whole request timeout, with the client's error held back
    // for all of it. Measured: a failed choice took 3003ms to reach the client
    // on a 3000ms timeout, and the sibling's abort came from its own timer.
    cancel?.();
    await Promise.allSettled(iterators.map((iterator) => iterator.return?.()));
  }
}

/**
 * One choice of a Chat stream: its own assistant-start, its own streamed text,
 * its own tool-call state. With `n > 1` these run side by side, and nothing
 * about a choice may leak into another — a shared `assistantStarted` would
 * silently drop the second choice's opening chunk.
 */
class OpenAiChatChoiceStream {
  private assistantStarted = false;
  private streamedText = '';
  private readonly toolState: OpenAiChatToolStreamState;

  constructor(
    private readonly res: ServerResponse,
    private readonly request: NormalizedRequest,
    private readonly choiceIndex: number,
  ) {
    this.toolState = new OpenAiChatToolStreamState(
      res,
      request.streamOptions,
      choiceIndex,
      () => this.assistantStarted,
      () => {
        this.assistantStarted = true;
      },
    );
  }

  async start(base: Record<string, unknown>): Promise<void> {
    if (!hasToolDecisionSchema(this.request)) {
      await this.ensureTextStarted(base);
      return;
    }
    await this.toolState.prestart(base, predictableOpenAiChatToolStart(this.request));
  }

  /** Returns this choice's result once its turn has finished. */
  async push(
    base: Record<string, unknown>,
    event: LocalStreamEvent,
  ): Promise<LocalCompletionResult | null> {
    if (event.type === 'text_delta') {
      if (!event.delta) return null;
      await this.ensureTextStarted(base);
      this.streamedText += event.delta;
      await this.write(base, { delta: { content: event.delta }, finish_reason: null });
      return null;
    }
    if (event.type === 'tool_call_delta') {
      await this.toolState.write(base, event);
      return null;
    }
    // The chat surface has no reasoning item: its shape reports reasoning
    // only as a token count in `usage`.
    if (event.type === 'reasoning_item') return null;
    const result = event.result;
    // The closing chunks report the model that actually ran.
    const finalBase = { ...base, model: result.model };
    if (result.toolCalls.length > 0) {
      // The narration that came with the call is part of the turn, and the
      // buffered body reports it — a stream that drops it makes the two
      // describe different turns. Nothing streams it live: a backend running a
      // tool extractor emits no `text_delta` at all, so the wrapper's prose is
      // first known here.
      const tail = missingTextTail(this.streamedText, result.text);
      if (tail) {
        await this.ensureTextStarted(finalBase);
        for (const chunk of chunkText(tail)) {
          this.streamedText += chunk;
          await this.write(finalBase, { delta: { content: chunk }, finish_reason: null });
        }
      }
      await this.toolState.finish(finalBase, result.toolCalls);
      await this.write(finalBase, { delta: {}, finish_reason: 'tool_calls' });
    } else {
      await this.ensureTextStarted(finalBase);
      for (const chunk of chunkText(missingTextTail(this.streamedText, result.text))) {
        await this.write(finalBase, { delta: { content: chunk }, finish_reason: null });
      }
      await this.write(finalBase, { delta: {}, finish_reason: 'stop' });
    }
    return result;
  }

  private async ensureTextStarted(base: Record<string, unknown>): Promise<void> {
    if (this.assistantStarted) return;
    this.assistantStarted = true;
    await this.write(base, { delta: { role: 'assistant', content: '', refusal: null }, finish_reason: null });
  }

  private async write(base: Record<string, unknown>, choice: Record<string, unknown>): Promise<void> {
    await writeSseData(this.res, openAiChatStreamChunk(
      base,
      [{ index: this.choiceIndex, ...choice }],
      this.request.streamOptions,
    ));
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
    // The CHOICE this state belongs to. The `index` inside `tool_calls` is the
    // tool's position; this one is the choice's, and with `n > 1` they differ.
    private readonly choiceIndex: number,
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
          index: this.choiceIndex,
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
          index: this.choiceIndex,
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
        const finishTools = async (): Promise<void> => {
          for (const { outputIndex, item } of await toolState.finish(result.toolCalls)) {
            finalItems.set(outputIndex, item);
          }
        };
        // Narration belongs in the completed output too, or the stream's own
        // summary contradicts the deltas it sent — and nothing streams it live
        // when a tool extractor is active, so the tail the result carries is
        // the only place the prose appears at all.
        const finishMessage = async (): Promise<void> => {
          const tail = missingTextTail(streamedText, result.text);
          if (!streamedText && !tail) return;
          await ensureTextStarted();
          for (const chunk of chunkText(tail)) {
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
        };
        // Two different questions, and conflating them made
        // `response.output_item.done` non-monotonic.
        //
        // For an item ALREADY announced, its position is fixed and the only
        // thing left to decide is the order of the terminal frames — which has
        // to be the order the stream announced them in, or a client is told a
        // later item finished before an earlier one, and the `arguments.done`
        // frame that promises a call is final arrives after a whole other item
        // has closed.
        //
        // For a turn that announced NOTHING until it completed — every tool
        // call on the claude native-schema channel — this call is where both
        // positions are allocated, so production order decides, through the
        // same `toolCallsBeforeText` knob the buffered body reads.
        const announced = streamedText || toolState.firstAnnouncedIndex !== Infinity;
        const messageFirst = announced
          ? messageOutputIndex !== -1 && messageOutputIndex < toolState.firstAnnouncedIndex
          : !result.toolCallsBeforeText;
        if (messageFirst) {
          await finishMessage();
          await finishTools();
        } else {
          await finishTools();
          await finishMessage();
        }
      } else {
        await ensureTextStarted();
        {
          for (const chunk of chunkText(missingTextTail(streamedText, result.text))) {
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
    // The Responses surface ends at `response.completed`; the vendor sends no
    // `[DONE]`. Captured 2026-08-29 against gpt-5.6-terra — nine events, same
    // names and order as ours, and nothing after the last one. `[DONE]` is the
    // Chat convention and stays there. An extra frame carrying a body that is
    // not a Responses event is a shape a strict SDK has to skip or reject, and
    // an adapter that emits what the vendor does not is diverging by addition.
    //
    // The error path below still writes one. That is NOT evidence-backed: no
    // capture of a vendor Responses stream failing mid-flight exists yet, so
    // changing it would be replacing a guess with another guess.
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

  /**
   * The lowest position any call has been announced at, or `Infinity` when none
   * has. The terminal frames go out in announced order, and only an item that
   * is already announced has a position to compare.
   */
  get firstAnnouncedIndex(): number {
    let lowest = Infinity;
    for (const state of this.items.values()) lowest = Math.min(lowest, state.outputIndex);
    return lowest;
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
  // `stop_sequences`, realized on the wire: text is written through the gate,
  // which holds back a tail that could still become a sequence and drops
  // everything once one arrives. The runtime keeps generating — nothing can
  // stop it mid-turn and still report the turn's usage — so the stream simply
  // stops carrying its output.
  const stopGate = new StopSequenceGate(request.stopSequences ?? []);

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
      // A tool block whose arguments the backend never declared finished is
      // still open. Opening a text block inside it nests two blocks on a wire
      // that has no nesting, and a client assembling by index cannot read it.
      await toolState.closeOpen();
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

    const writeText = async (text: string): Promise<void> => {
      if (!text) return;
      await ensureTextStarted();
      streamedText += text;
      await writeSseEvent(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: textBlockIndex,
        delta: { type: 'text_delta', text },
      });
    };

    for await (const event of events) {
      if (event.type === 'text_delta') {
        if (!event.delta) continue;
        await writeText(stopGate.push(event.delta));
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

      // The gated text is what the caller received, so the turn is reported
      // against it: a match makes this a `stop_sequence` stop, and the tail the
      // runtime produced after it is never written.
      const gated = applyStreamStopSequence(event.result, stopGate, streamedText);
      const result = gated.result;
      const stopReason = anthropicStopReason(result, result.toolCalls.length > 0);
      if (result.toolCalls.length > 0) {
        // Blocks follow production order, which is what the non-streamed body
        // reports through `orderedByEmission`. A turn whose tools came before
        // any text was answered here in the other order — the same turn read
        // as [text, tool_use] streamed and [tool_use, text] buffered.
        if (result.toolCallsBeforeText && !streamedText) {
          await toolState.finish(result.toolCalls);
          for (const chunk of chunkText(gated.tail)) await writeText(chunk);
          await closeOpenTextBlock();
        } else {
          await writeText(gated.tail);
          await closeOpenTextBlock();
          await toolState.finish(result.toolCalls);
        }
      } else {
        // Flush any final text not already streamed (covers schema/refusal results
        // where no live text_delta was emitted), then close the block. A truly empty
        // result opens no content block, matching the non-streaming content:[] mapping
        // — so streaming and non-streaming refusals carry the same content.
        for (const chunk of chunkText(gated.tail)) await writeText(chunk);
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

/** The single exit for the Anthropic surface's in-band error event. */
function anthropicStreamErrorPayload(err: unknown): Record<string, unknown> {
  return boundedErrorEnvelope(rawAnthropicStreamErrorPayload(err));
}

function rawAnthropicStreamErrorPayload(err: unknown): Record<string, unknown> {
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

  /** Closes any block still open, so nothing else can open inside one. */
  async closeOpen(): Promise<void> {
    for (const state of this.states.values()) await this.stop(state);
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

/**
 * The single exit for every OpenAI-shape SSE error frame — chat, responses,
 * images and the native surface all write what this returns.
 */
function streamErrorPayload(err: unknown): unknown {
  return boundedErrorEnvelope(rawStreamErrorPayload(err));
}

function rawStreamErrorPayload(err: unknown): unknown {
  if (err instanceof ProxyRequestError) {
    return {
      error: {
        message: boundedErrorMessage(err.message),
        type: err.type,
        param: boundedErrorParam(err.param),
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
        param: boundedErrorParam(providerError.param),
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

const ERROR_TRUNCATION_MARKER = '...[truncated]';

/**
 * The same ceiling for `param`. It is client-visible and caller-supplied too —
 * an unknown key's own name and `metadata.<key>` both put the caller's bytes
 * there, and a provider error's `param` is prose this proxy did not write.
 * Measured before this: an unknown key of 10,000,000 characters answered 400
 * with `message.len 1024` beside `param.len 10,000,000`.
 */
function boundedErrorParam(param: string | null): string | null {
  return param === null ? null : boundedErrorMessage(param);
}

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

/**
 * Every client-visible JSON error body leaves through here. `writeJson` is
 * shared with the success writers, so the envelope bound belongs on the error
 * side of it rather than inside it.
 */
function writeErrorJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  writeJson(res, statusCode, boundedErrorEnvelope(payload));
}

function writeError(
  res: ServerResponse,
  err: unknown,
  shape: ErrorResponseShape = 'openai',
): void {
  if (err instanceof LocalCliChatError) {
    writeErrorJson(res, err.statusCode, {
      error: {
        message: boundedErrorMessage(err.message),
        type: 'local_cli_chat_error',
        param: null,
        code: err.code,
      },
    });
    return;
  }
  // A path this proxy does not serve answers as the direct OpenAI API does for
  // a path it does not serve (measured 2026-08-29 on `/v1/nope`,
  // `/v1/images/foo`, `/v1/images/variations`): a bare 404, no body,
  // `x-content-type-options: nosniff`. The native surface keeps its own
  // envelope for its own unknown subpaths.
  if (err instanceof UnknownEndpointError && shape !== 'local-cli') {
    res.writeHead(404, { 'x-content-type-options': 'nosniff' });
    res.end();
    return;
  }
  if (err instanceof ProxyRequestError) {
    // The native surface promises its own envelope for everything, the gate
    // and configuration failures included — they happen before its handler,
    // but the caller is still a native-surface caller.
    if (shape === 'local-cli') {
      writeErrorJson(res, err.statusCode, {
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
      writeErrorJson(res, err.statusCode, {
        type: 'error',
        error: {
          type: err.type,
          message: boundedErrorMessage(err.message),
        },
      });
      return;
    }
    writeErrorJson(res, err.statusCode, {
      error: {
        message: boundedErrorMessage(err.message),
        type: err.type,
        param: boundedErrorParam(err.param),
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
      writeErrorJson(res, providerError.statusCode, {
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
      writeErrorJson(res, providerError.statusCode, {
        type: 'error',
        error: {
          type: providerError.type,
          message: boundedErrorMessage(providerError.message),
        },
      });
      return;
    }
    writeErrorJson(res, providerError.statusCode, {
      error: {
        message: boundedErrorMessage(providerError.message),
        type: providerError.type,
        param: boundedErrorParam(providerErrorParamForShape(providerError.param, shape)),
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
    writeErrorJson(res, 500, {
      error: { message, type: 'local_cli_chat_error', param: null, code: null },
    });
    return;
  }
  if (shape === 'anthropic') {
    writeErrorJson(res, 500, { type: 'error', error: { type: 'api_error', message } });
    return;
  }
  writeErrorJson(res, 500, {
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
    type: boundedDiscriminator(error.type) ?? 'invalid_request_error',
    message,
    param: typeof error.param === 'string' ? error.param : null,
    code: boundedDiscriminator(error.code),
  };
}

/**
 * `type` and `code` come from an upstream body, which makes them a
 * backend-controlled channel into every client-visible envelope — and unlike
 * `message` and `param`, they are DISCRIMINATORS: a client switches on them.
 * Truncating one leaves a value that is neither the real one nor a known one,
 * so anything past the ceiling is dropped to the same default a missing one
 * gets. Measured before this: a backend error carrying a 4096-character `type`
 * and `code` put both, at full length, in the Responses envelope and the
 * Anthropic one.
 */
function boundedDiscriminator(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_ERROR_MESSAGE_CHARS) return null;
  return value;
}

/**
 * The one exit every client-visible error envelope passes through — the JSON
 * writer and both SSE writers. A discriminator reaches an envelope from two
 * sources, and only one of them was bounded: `providerErrorFromBackendError`
 * parses an upstream body and bounds what it reads, but `codexBackendError`
 * has already copied that same upstream's `type` and `code` onto a
 * `ProxyRequestError` verbatim, and every writer read those two fields off the
 * error directly. Measured before this: an upstream 400 carrying a
 * 4096-character `type` and `code` arrived at full length on all six
 * client-visible surfaces — Responses, Chat and Anthropic, buffered and
 * streamed alike. Bounding the ENVELOPE rather than each reader is the point:
 * a writer added later cannot reopen it. The upstream STATUS is untouched;
 * only the nonconforming discriminator is sacrificed.
 */
function boundedErrorEnvelope<T>(payload: T): T {
  const envelope = payload as unknown;
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return payload;
  const error = (envelope as Record<string, unknown>).error;
  if (!error || typeof error !== 'object' || Array.isArray(error)) return payload;
  const fields = error as Record<string, unknown>;
  const bounded: Record<string, unknown> = { ...fields };
  // Absent stays absent: the Anthropic envelope has no `code`, and inventing
  // one is a different divergence from leaking an oversized one.
  if ('type' in fields) bounded.type = boundedDiscriminator(fields.type) ?? 'invalid_request_error';
  if ('code' in fields) bounded.code = boundedDiscriminator(fields.code);
  return { ...(envelope as Record<string, unknown>), error: bounded } as T;
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
