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
  NormalizedRequest,
  ProxyServerOptions,
} from './types.js';
import { ProxyRequestError } from './types.js';
import { unsupportedImageFileIds } from './multimodal.js';
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
        writeJson(res, 200, openAiResponsesResponse(result));
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
    id: `chatcmpl_${result.id}`,
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
        } : {
          role: 'assistant',
          content: result.text,
        },
        finish_reason: hasToolCalls ? 'tool_calls' : 'stop',
      },
    ],
    usage: {
      prompt_tokens: result.usage.inputTokens,
      completion_tokens: result.usage.outputTokens,
      total_tokens: result.usage.inputTokens + result.usage.outputTokens,
    },
    system_fingerprint: 'local-oauth-cli',
  };
}

function openAiResponsesResponse(result: LocalCompletionResult): unknown {
  const output = result.toolCalls.length > 0
    ? result.toolCalls.map(openAiResponseToolCall)
    : [
        {
          id: `msg_${randomUUID()}`,
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text: result.text,
              annotations: [],
            },
          ],
        },
      ];
  return {
    id: `resp_${result.id}`,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model: result.model,
    output,
    output_text: result.toolCalls.length > 0 ? '' : result.text,
    usage: {
      input_tokens: result.usage.inputTokens,
      output_tokens: result.usage.outputTokens,
      total_tokens: result.usage.inputTokens + result.usage.outputTokens,
    },
  };
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
    usage: {
      input_tokens: result.usage.inputTokens,
      output_tokens: result.usage.outputTokens,
    },
  };
}

async function writeOpenAiChatStream(
  res: ServerResponse,
  events: AsyncIterable<LocalStreamEvent>,
  request: NormalizedRequest,
): Promise<void> {
  writeSseHeaders(res);
  const id = `chatcmpl_stream_${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  let base = {
    id,
    object: 'chat.completion.chunk',
    created,
    model: request.model,
    system_fingerprint: 'local-oauth-cli',
  };
  let streamedText = '';
  try {
    await writeSseData(res, {
      ...base,
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    });
    for await (const event of events) {
      if (event.type === 'text_delta') {
        if (!event.delta) continue;
        streamedText += event.delta;
        await writeSseData(res, {
          ...base,
          choices: [{ index: 0, delta: { content: event.delta }, finish_reason: null }],
        });
        continue;
      }
      const result = event.result;
      base = { ...base, model: result.model };
      if (result.toolCalls.length > 0) {
        await writeOpenAiChatToolCallChunks(res, base, result.toolCalls);
        await writeSseData(res, {
          ...base,
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        });
      } else {
        if (!streamedText && result.text) {
          for (const chunk of chunkText(result.text)) {
            await writeSseData(res, {
              ...base,
              choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }],
            });
          }
        }
        await writeSseData(res, {
          ...base,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
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

async function writeOpenAiChatToolCallChunks(
  res: ServerResponse,
  base: Record<string, unknown>,
  toolCalls: readonly LocalToolCall[],
): Promise<void> {
  for (const [index, call] of toolCalls.entries()) {
    await writeSseData(res, {
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index,
                id: call.id,
                type: 'function',
                function: {
                  name: call.name,
                  arguments: call.arguments,
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    });
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
  let finalOutput: unknown[] = [];

  try {
    await writeSseEvent(res, 'response.created', {
      type: 'response.created',
      response: {
        id: responseId,
        object: 'response',
        created_at: Math.floor(Date.now() / 1000),
        status: 'in_progress',
        model: request.model,
        output: [],
      },
    });

    const ensureTextStarted = async (): Promise<void> => {
      if (textStarted) return;
      textStarted = true;
      await writeSseEvent(res, 'response.output_item.added', {
        type: 'response.output_item.added',
        output_index: 0,
        item: {
          id: itemId,
          type: 'message',
          status: 'in_progress',
          role: 'assistant',
          content: [],
        },
      });
      await writeSseEvent(res, 'response.content_part.added', {
        type: 'response.content_part.added',
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      });
    };

    for await (const event of events) {
      if (event.type === 'text_delta') {
        if (!event.delta) continue;
        await ensureTextStarted();
        streamedText += event.delta;
        await writeSseEvent(res, 'response.output_text.delta', {
          type: 'response.output_text.delta',
          item_id: itemId,
          output_index: 0,
          content_index: 0,
          delta: event.delta,
        });
        continue;
      }

      const result = event.result;
      if (result.toolCalls.length > 0) {
        finalOutput = await writeOpenAiResponseToolCallChunks(res, result.toolCalls);
      } else {
        await ensureTextStarted();
        if (!streamedText && result.text) {
          for (const chunk of chunkText(result.text)) {
            streamedText += chunk;
            await writeSseEvent(res, 'response.output_text.delta', {
              type: 'response.output_text.delta',
              item_id: itemId,
              output_index: 0,
              content_index: 0,
              delta: chunk,
            });
          }
        }
        await writeSseEvent(res, 'response.output_text.done', {
          type: 'response.output_text.done',
          item_id: itemId,
          output_index: 0,
          content_index: 0,
          text: result.text,
        });
        await writeSseEvent(res, 'response.content_part.done', {
          type: 'response.content_part.done',
          item_id: itemId,
          output_index: 0,
          content_index: 0,
          part: { type: 'output_text', text: result.text, annotations: [] },
        });
        const item = {
          id: itemId,
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: result.text, annotations: [] }],
        };
        finalOutput = [item];
        await writeSseEvent(res, 'response.output_item.done', {
          type: 'response.output_item.done',
          output_index: 0,
          item,
        });
      }
      await writeSseEvent(res, 'response.completed', {
        type: 'response.completed',
        response: openAiResponsesCompletedResponse(responseId, result, finalOutput),
      });
    }
    res.write('data: [DONE]\n\n');
  } catch (err) {
    await writeSseEvent(res, 'error', streamErrorPayload(err));
    res.write('data: [DONE]\n\n');
  } finally {
    res.end();
  }
}

async function writeOpenAiResponseToolCallChunks(
  res: ServerResponse,
  toolCalls: readonly LocalToolCall[],
): Promise<unknown[]> {
  const output: unknown[] = [];
  for (const [index, call] of toolCalls.entries()) {
    const item = asObjectPayload(openAiResponseToolCall(call));
    output.push(item);
    await writeSseEvent(res, 'response.output_item.added', {
      type: 'response.output_item.added',
      output_index: index,
      item: {
        ...item,
        arguments: '',
      },
    });
    await writeSseEvent(res, 'response.function_call_arguments.delta', {
      type: 'response.function_call_arguments.delta',
      output_index: index,
      item_id: readObjectField(item, 'id'),
      delta: call.arguments,
    });
    await writeSseEvent(res, 'response.function_call_arguments.done', {
      type: 'response.function_call_arguments.done',
      output_index: index,
      item_id: readObjectField(item, 'id'),
      arguments: call.arguments,
    });
    await writeSseEvent(res, 'response.output_item.done', {
      type: 'response.output_item.done',
      output_index: index,
      item,
    });
  }
  return output;
}

function openAiResponsesCompletedResponse(
  responseId: string,
  result: LocalCompletionResult,
  output: unknown[],
): unknown {
  return {
    id: responseId,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model: result.model,
    output,
    output_text: result.toolCalls.length > 0 ? '' : result.text,
    usage: {
      input_tokens: result.usage.inputTokens,
      output_tokens: result.usage.outputTokens,
      total_tokens: result.usage.inputTokens + result.usage.outputTokens,
    },
  };
}

async function writeAnthropicMessagesStream(
  res: ServerResponse,
  events: AsyncIterable<LocalStreamEvent>,
  request: NormalizedRequest,
): Promise<void> {
  writeSseHeaders(res);
  let textStarted = false;
  let streamedText = '';

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

      const result = event.result;
      if (result.toolCalls.length > 0) {
        await writeAnthropicToolUseChunks(res, result.toolCalls);
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

async function writeAnthropicToolUseChunks(
  res: ServerResponse,
  toolCalls: readonly LocalToolCall[],
): Promise<void> {
  for (const [index, call] of toolCalls.entries()) {
    await writeSseEvent(res, 'content_block_start', {
      type: 'content_block_start',
      index,
      content_block: {
        type: 'tool_use',
        id: call.id,
        name: call.name,
        input: {},
      },
    });
    await writeSseEvent(res, 'content_block_delta', {
      type: 'content_block_delta',
      index,
      delta: {
        type: 'input_json_delta',
        partial_json: call.arguments,
      },
    });
    await writeSseEvent(res, 'content_block_stop', {
      type: 'content_block_stop',
      index,
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
  await new Promise<void>((resolve) => setTimeout(resolve, 1));
}

function chunkText(text: string): string[] {
  if (!text) return [];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += 48) {
    chunks.push(text.slice(i, i + 48));
  }
  return chunks;
}

function readObjectField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' ? field : undefined;
}

function asObjectPayload(value: unknown): Record<string, unknown> {
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
