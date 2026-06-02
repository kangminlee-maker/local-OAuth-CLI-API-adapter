import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type {
  LocalCliBackend,
  LocalCompletionResult,
  LocalToolCall,
  NormalizedRequest,
  ProxyServerOptions,
} from './types.js';
import { ProxyRequestError } from './types.js';
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
  return {
    server,
    url: `http://${options.host}:${options.port}`,
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
      const result = await runWithTimeout(backend, normalized, requestTimeoutMs);
      writeJson(res, 200, openAiChatResponse(result));
      return;
    }
    if (path === '/v1/responses') {
      const normalized = normalizeOpenAiResponsesRequest(body);
      rejectDeferredFeatures(normalized);
      const result = await runWithTimeout(backend, normalized, requestTimeoutMs);
      writeJson(res, 200, openAiResponsesResponse(result));
      return;
    }
    if (path === '/v1/messages') {
      const normalized = normalizeAnthropicMessagesRequest(body);
      rejectDeferredFeatures(normalized, 'anthropic');
      const result = await runWithTimeout(backend, normalized, requestTimeoutMs);
      writeJson(res, 200, anthropicMessagesResponse(result));
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

function rejectDeferredFeatures(
  request: NormalizedRequest,
  provider: 'openai' | 'anthropic' = 'openai',
): void {
  if (request.stream) {
    throw new ProxyRequestError('stream=true is not supported by this local proxy yet.', 501, provider);
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > 2_000_000) {
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

function writeJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
  });
  res.end(`${JSON.stringify(payload)}\n`);
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
