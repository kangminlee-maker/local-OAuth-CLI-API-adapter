import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import readline from 'node:readline';
import { AsyncQueue } from './async-queue.js';
import {
  buildPrompt,
  claudeSystemPrompt,
  forcedSingleToolCall,
  hasToolDecisionSchema,
  outputSchemaFor,
  parseBackendOutput,
  usageFor,
} from './backend-contract.js';
import { claudeMessageContentFor, hasImageInputs } from './multimodal.js';
import { proxyChildProcessEnv } from './process-env.js';
import type {
  LocalCliBackend,
  LocalCompletionResult,
  LocalStreamEvent,
  LocalUsage,
  NormalizedRequest,
} from './types.js';
import { KnownToolArgumentsDeltaExtractor, ToolCallDeltaExtractor } from './tool-call-stream.js';

interface ClaudeCodeBackendOptions {
  readonly command?: string;
  readonly cwd: string;
  readonly model?: string;
  readonly timeoutMs: number;
  readonly extraArgs?: readonly string[];
}

interface ClaudeWaiter {
  readonly onTextDelta?: (delta: string) => void;
  text: string;
  structuredOutput: unknown;
  usage: unknown;
  resolve: (value: ClaudeTurnResult) => void;
  reject: (err: Error) => void;
}

interface ClaudeTurnResult {
  readonly text: string;
  readonly structuredOutput: unknown;
  readonly usage: unknown;
}

type JsonObject = Record<string, unknown>;

export class ClaudeCodeBackend implements LocalCliBackend {
  readonly name = 'claude-code';
  readonly model: string;

  private readonly command: string;
  private readonly cwd: string;
  private readonly configuredModel?: string;
  private readonly timeoutMs: number;
  private readonly extraArgs: readonly string[];
  private child: ChildProcessWithoutNullStreams | null = null;
  private lineReader: readline.Interface | null = null;
  private initialized: Promise<void> | null = null;
  private waiter: ClaudeWaiter | null = null;
  private stderr = '';
  private lock: Promise<void> = Promise.resolve();

  constructor(options: ClaudeCodeBackendOptions) {
    this.command = options.command ?? 'claude';
    this.cwd = options.cwd;
    this.model = options.model ?? 'claude-code-cli';
    this.configuredModel = options.model;
    this.timeoutMs = options.timeoutMs;
    this.extraArgs = options.extraArgs ?? [];
  }

  async generate(
    request: NormalizedRequest,
    signal?: AbortSignal,
  ): Promise<LocalCompletionResult> {
    return this.runRequest(request, signal);
  }

  async *stream(
    request: NormalizedRequest,
    signal?: AbortSignal,
  ): AsyncIterable<LocalStreamEvent> {
    const queue = new AsyncQueue<LocalStreamEvent>();
    const forcedTool = forcedSingleToolCall(request);
    const toolExtractor = forcedTool
      ? new KnownToolArgumentsDeltaExtractor(forcedTool.index, forcedTool.id, forcedTool.name)
      : hasToolDecisionSchema(request)
      ? new ToolCallDeltaExtractor()
      : null;
    const shouldStreamText = !toolExtractor && this.canStreamTextDeltas(request);
    const run = this.runRequest(
      request,
      signal,
      toolExtractor
        ? (delta) => {
            for (const event of toolExtractor.push(delta)) queue.push(event);
          }
        : shouldStreamText
        ? (delta) => queue.push({ type: 'text_delta', delta })
        : undefined,
    )
      .then((result) => queue.push({ type: 'completed', result }))
      .catch((err: Error) => queue.fail(err))
      .finally(() => queue.close());

    try {
      for await (const event of queue) yield event;
      await run;
    } finally {
      await run.catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    this.waiter?.reject(new Error('claude code backend closed'));
    this.waiter = null;
    this.lineReader?.close();
    this.child?.kill('SIGTERM');
    this.child = null;
    this.lineReader = null;
    this.initialized = null;
  }

  private runRequest(
    request: NormalizedRequest,
    signal?: AbortSignal,
    onTextDelta?: (delta: string) => void,
  ): Promise<LocalCompletionResult> {
    if (this.canUsePersistentTurn(request)) {
      return this.withLock(() => this.runPersistentTurn(request, signal, onTextDelta));
    }
    return this.runOneShotTurn(request, signal, onTextDelta);
  }

  private canStreamTextDeltas(request: NormalizedRequest): boolean {
    return !hasToolDecisionSchema(request) && !request.jsonSchema;
  }

  private canUsePersistentTurn(request: NormalizedRequest): boolean {
    return !hasImageInputs(request);
  }

  private async runPersistentTurn(
    request: NormalizedRequest,
    signal?: AbortSignal,
    onTextDelta?: (delta: string) => void,
  ): Promise<LocalCompletionResult> {
    const startedAt = Date.now();
    await this.ensureStarted();
    const turn = await this.sendPersistentMessage(
      await claudeMessageContentFor(request, buildPrompt(request)),
      signal,
      onTextDelta,
    );
    await this.clearPersistentSession(signal);
    return this.resultFromTurn(request, turn, startedAt);
  }

  private async clearPersistentSession(signal?: AbortSignal): Promise<void> {
    await this.sendPersistentMessage('/clear', signal).catch(() => undefined);
  }

  private async runOneShotTurn(
    request: NormalizedRequest,
    signal?: AbortSignal,
    onTextDelta?: (delta: string) => void,
  ): Promise<LocalCompletionResult> {
    const startedAt = Date.now();
    const prompt = buildPrompt(request);
    const useStreamJsonInput = hasImageInputs(request);
    const includePartialMessages = Boolean(onTextDelta);
    const argv = [
      '-p',
      ...(useStreamJsonInput ? ['--input-format', 'stream-json'] : []),
      '--output-format',
      'stream-json',
      '--verbose',
      ...(includePartialMessages ? ['--include-partial-messages'] : []),
      ...claudeContextIsolationArgs(),
      '--tools',
      '',
      '--no-session-persistence',
      ...(this.configuredModel ? ['--model', this.configuredModel] : []),
      ...schemaArgsFor(request),
      ...this.extraArgs,
      ...(useStreamJsonInput ? [] : [prompt]),
    ];
    const stdinMessage = useStreamJsonInput
      ? {
          type: 'user',
          message: {
            role: 'user',
            content: await claudeMessageContentFor(request, prompt),
          },
          parent_tool_use_id: null,
        }
      : undefined;
    let turn: ClaudeTurnResult | null = null;
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        turn = await runClaudeProcess(this.command, argv, {
          cwd: this.cwd,
          timeoutMs: this.timeoutMs,
          signal,
          onTextDelta,
          stdinMessage,
        });
        break;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (!isRetryableClaudeStructuredOutputError(lastError) || signal?.aborted) throw lastError;
      }
    }
    if (!turn) throw lastError ?? new Error('claude did not return a result');
    return this.resultFromTurn(request, turn, startedAt);
  }

  private resultFromTurn(
    request: NormalizedRequest,
    turn: ClaudeTurnResult,
    startedAt: number,
  ): LocalCompletionResult {
    const rawText = turn.structuredOutput === undefined
      ? turn.text
      : JSON.stringify(turn.structuredOutput);
    const parsed = parseBackendOutput(request, rawText);
    const usage = usageFromClaude(turn.usage) ?? usageFor(request, parsed.text, parsed.toolCalls);
    return {
      id: `local_${randomUUID()}`,
      model: request.model,
      text: parsed.text,
      toolCalls: parsed.toolCalls,
      usage,
      latencyMs: Date.now() - startedAt,
    };
  }

  private async ensureStarted(): Promise<void> {
    if (this.initialized) return this.initialized;
    this.initialized = this.start();
    return this.initialized;
  }

  private async start(): Promise<void> {
    this.child = spawn(this.command, [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      ...claudeContextIsolationArgs(),
      '--tools',
      '',
      '--no-session-persistence',
      ...(this.configuredModel ? ['--model', this.configuredModel] : []),
      ...this.extraArgs,
    ], {
      cwd: this.cwd,
      shell: false,
      env: proxyChildProcessEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-12_000);
    });
    this.child.on('error', (err) => this.failCurrent(err));
    this.child.on('close', (code, signal) => {
      this.failCurrent(new Error(`claude code exited: code=${code ?? 'null'} signal=${signal ?? 'null'}`));
      this.child = null;
      this.lineReader = null;
      this.initialized = null;
    });
    this.lineReader = readline.createInterface({ input: this.child.stdout });
    this.lineReader.on('line', (line) => this.handlePersistentLine(line));
  }

  private sendPersistentMessage(
    content: string | readonly unknown[],
    signal?: AbortSignal,
    onTextDelta?: (delta: string) => void,
  ): Promise<ClaudeTurnResult> {
    if (!this.child) {
      return Promise.reject(new Error('claude code is not running'));
    }
    if (this.waiter) {
      return Promise.reject(new Error('claude code already has a pending turn'));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new Error(`claude turn timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', abortFromSignal);
      };
      const abortFromSignal = (): void => {
        cleanup();
        const err = new Error('request aborted');
        this.waiter = null;
        this.child?.kill('SIGTERM');
        reject(err);
      };
      this.waiter = {
        text: '',
        structuredOutput: undefined,
        usage: undefined,
        onTextDelta,
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
        reject: (err) => {
          cleanup();
          reject(err);
        },
      };
      if (signal) {
        if (signal.aborted) abortFromSignal();
        else signal.addEventListener('abort', abortFromSignal, { once: true });
      }
      this.child?.stdin.write(`${JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: typeof content === 'string' ? [{ type: 'text', text: content }] : content,
        },
        parent_tool_use_id: null,
      })}\n`);
    });
  }

  private handlePersistentLine(line: string): void {
    const message = parseJsonObject(line);
    if (!message || !this.waiter) return;
    consumeClaudeMessage(this.waiter, message);
    if (message.type === 'result') {
      const waiter = this.waiter;
      this.waiter = null;
      if (message.subtype === 'success') {
        waiter.resolve({
          text: typeof message.result === 'string' ? message.result : waiter.text,
          structuredOutput: message.structured_output ?? waiter.structuredOutput,
          usage: message.usage ?? waiter.usage,
        });
      } else {
        waiter.reject(new Error(readErrorMessage(message)));
      }
    }
  }

  private failCurrent(err: Error): void {
    const detail = this.stderr ? `\n${this.stderr.slice(-2000)}` : '';
    const wrapped = new Error(`${err.message}${detail}`);
    this.waiter?.reject(wrapped);
    this.waiter = null;
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.lock;
    let release!: () => void;
    this.lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

function schemaArgsFor(request: NormalizedRequest): string[] {
  const schema = outputSchemaFor(request);
  return schema ? ['--json-schema', JSON.stringify(schema)] : [];
}

function claudeContextIsolationArgs(): string[] {
  return [
    '--system-prompt',
    claudeSystemPrompt(),
    '--disable-slash-commands',
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--setting-sources',
    'user',
  ];
}

function runClaudeProcess(
  command: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
    readonly onTextDelta?: (delta: string) => void;
    readonly stdinMessage?: unknown;
  },
): Promise<ClaudeTurnResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  const abortFromParent = (): void => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener('abort', abortFromParent, { once: true });
  }

  return new Promise<ClaudeTurnResult>((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      shell: false,
      env: proxyChildProcessEnv(),
      signal: controller.signal,
      stdio: options.stdinMessage ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    const waiter: ClaudeWaiter = {
      text: '',
      structuredOutput: undefined,
      usage: undefined,
      onTextDelta: options.onTextDelta,
      resolve,
      reject,
    };
    const finish = (err?: Error, value?: ClaudeTurnResult): void => {
      clearTimeout(timeout);
      if (options.signal) options.signal.removeEventListener('abort', abortFromParent);
      if (err) reject(err);
      else if (value) resolve(value);
    };
    if (!child.stdout || !child.stderr) {
      finish(new Error('claude process did not expose stdout/stderr pipes'));
      return;
    }
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-12_000);
    });
    child.stdout.on('data', (chunk) => {
      for (const line of String(chunk).split(/\n/)) {
        const message = parseJsonObject(line);
        if (!message) continue;
        consumeClaudeMessage(waiter, message);
        if (message.type === 'result') {
          if (message.subtype === 'success') {
            finish(undefined, {
              text: typeof message.result === 'string' ? message.result : waiter.text,
              structuredOutput: message.structured_output ?? waiter.structuredOutput,
              usage: message.usage ?? waiter.usage,
            });
          } else {
            finish(new Error(readErrorMessage(message)));
          }
        }
      }
    });
    child.on('error', (err) => finish(err));
    child.on('close', (code, signal) => {
      if (code === 0) return;
      finish(new Error(stderr.trim() || `claude exited with code=${code ?? 'null'} signal=${signal ?? 'null'}`));
    });
    if (options.stdinMessage && child.stdin) {
      child.stdin.write(`${JSON.stringify(options.stdinMessage)}\n`);
      child.stdin.end();
    }
  }).finally(() => {
    clearTimeout(timeout);
    if (options.signal) options.signal.removeEventListener('abort', abortFromParent);
  });
}

function consumeClaudeMessage(waiter: ClaudeWaiter, message: JsonObject): void {
  if (message.type === 'stream_event') {
    const event = asRecord(message.event);
    if (event?.type === 'content_block_delta') {
      const delta = asRecord(event.delta);
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        waiter.text += delta.text;
        waiter.onTextDelta?.(delta.text);
      }
    }
    return;
  }
  if (message.type === 'assistant') {
    const msg = asRecord(message.message);
    const content = Array.isArray(msg?.content) ? msg.content : [];
    const text = content.map((part) => {
      const block = asRecord(part);
      return block?.type === 'text' && typeof block.text === 'string' ? block.text : '';
    }).join('');
    if (text) waiter.text = text;
  }
}

function usageFromClaude(value: unknown): LocalUsage | null {
  const usage = asRecord(value);
  const inputTokens = readNumber(usage?.input_tokens);
  const cacheCreationInputTokens = readNumber(usage?.cache_creation_input_tokens);
  const cacheReadInputTokens = readNumber(usage?.cache_read_input_tokens);
  const cachedInputTokens = cacheCreationInputTokens + cacheReadInputTokens;
  const outputTokens = readNumber(usage?.output_tokens);
  if (inputTokens === 0 && cachedInputTokens === 0 && outputTokens === 0) return null;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + cachedInputTokens + outputTokens,
    cachedInputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    source: 'provider',
    raw: value,
  };
}

function readNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function readErrorMessage(message: JsonObject): string {
  if (typeof message.result === 'string' && message.result.trim()) return message.result;
  if (typeof message.error === 'string' && message.error.trim()) return message.error;
  return JSON.stringify(message);
}

function isRetryableClaudeStructuredOutputError(err: Error): boolean {
  return err.message.includes('error_during_execution')
    || err.message.includes('[ede_diagnostic]');
}

function parseJsonObject(line: string): JsonObject | null {
  if (!line.trim()) return null;
  try {
    const parsed = JSON.parse(line) as unknown;
    return asRecord(parsed);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): JsonObject | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as JsonObject;
}
