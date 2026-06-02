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
  NormalizedRequest,
  ProxyServerOptions,
} from './types.js';
import { ProxyRequestError } from './types.js';
import { unsupportedImageFileIds } from './multimodal.js';
import { hasToolDecisionSchema } from './backend-contract.js';
import { missingToolCallArgumentDelta } from './tool-call-stream.js';
import {
  normalizeAnthropicMessagesRequest,
  normalizeOpenAiChatRequest,
  normalizeOpenAiResponsesRequest,
} from './normalizers.js';

export interface StartedProxyServer {
  readonly server: Server;
  readonly url: string;
  close(): Promise<void>;
}

export async function startLocalApiProxy(
  options: ProxyServerOptions,
): Promise<StartedProxyServer> {
  const server = createServer((req, res) => {
    void handleRequest(req, res, options.backend, options.requestTimeoutMs);
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
      ]);
    },
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  backend: LocalCliBackend,
  requestTimeoutMs: number,
): Promise<void> {
  setCorsHeaders(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }
  try {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (req.method === 'GET' && path === '/v1/models') {
      writeJson(res, 200, openAiModelsResponse(backend));
      return;
    }
    if (req.method !== 'POST') {
      throw new ProxyRequestError('Unsupported method.', 405);
    }

    const body = await readJsonBody(req);
    if (path === '/v1/chat/completions') {
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
    writeError(res, err);
  }
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

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
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
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ProxyRequestError('Request body must be valid JSON.', 400);
  }
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

function writeError(res: ServerResponse, err: unknown): void {
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
        param: null,
        code: null,
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

function setCorsHeaders(res: ServerResponse): void {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  res.setHeader('access-control-allow-headers', 'authorization,content-type,x-api-key,anthropic-version');
}
