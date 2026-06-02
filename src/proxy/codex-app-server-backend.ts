import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import readline from 'node:readline';
import { AsyncQueue } from './async-queue.js';
import {
  baseInstructions,
  buildPrompt,
  developerInstructions,
  hasToolDecisionSchema,
  outputSchemaFor,
  parseBackendOutput,
  usageFor,
} from './backend-contract.js';
import { prepareCodexInput } from './multimodal.js';
import type {
  LocalCliBackend,
  LocalCompletionResult,
  LocalStreamEvent,
  LocalUsage,
  NormalizedRequest,
} from './types.js';
import { ToolCallDeltaExtractor } from './tool-call-stream.js';

interface CodexAppServerBackendOptions {
  readonly command?: string;
  readonly cwd: string;
  readonly model?: string;
  readonly timeoutMs: number;
  readonly reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
}

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: JsonRpcMessage) => void;
  readonly reject: (err: Error) => void;
  readonly timer: NodeJS.Timeout;
}

interface TurnWaiter {
  readonly threadId: string;
  readonly turnId: string;
  text: string;
  usage?: LocalUsage;
  onTextDelta?: (delta: string) => void;
  resolve: (value: TurnResult) => void;
  reject: (err: Error) => void;
}

type JsonRpcMessage = Record<string, unknown>;

interface TurnResult {
  readonly text: string;
  readonly usage?: LocalUsage;
}

const USAGE_NOTIFICATION_GRACE_MS = 100;

export class CodexAppServerBackend implements LocalCliBackend {
  readonly name = 'codex-app-server';
  readonly model: string;

  private readonly command: string;
  private readonly cwd: string;
  private readonly configuredModel?: string;
  private readonly timeoutMs: number;
  private readonly reasoningEffort: NonNullable<CodexAppServerBackendOptions['reasoningEffort']>;
  private child: ChildProcessWithoutNullStreams | null = null;
  private lineReader: readline.Interface | null = null;
  private nextId = 1;
  private initialized: Promise<void> | null = null;
  private stderr = '';
  private readonly pending = new Map<number, PendingRequest>();
  private readonly turnWaiters = new Map<string, TurnWaiter>();

  constructor(options: CodexAppServerBackendOptions) {
    this.command = options.command ?? 'codex';
    this.cwd = options.cwd;
    this.model = options.model ?? 'codex-app-server';
    this.configuredModel = options.model;
    this.timeoutMs = options.timeoutMs;
    this.reasoningEffort = options.reasoningEffort ?? 'low';
  }

  async generate(
    request: NormalizedRequest,
    signal?: AbortSignal,
  ): Promise<LocalCompletionResult> {
    return this.runTurn(request, signal);
  }

  async *stream(
    request: NormalizedRequest,
    signal?: AbortSignal,
  ): AsyncIterable<LocalStreamEvent> {
    const queue = new AsyncQueue<LocalStreamEvent>();
    const toolExtractor = hasToolDecisionSchema(request)
      ? new ToolCallDeltaExtractor()
      : null;
    const run = this.runTurn(
      request,
      signal,
      (delta) => {
        if (toolExtractor) {
          for (const event of toolExtractor.push(delta)) queue.push(event);
        } else {
          queue.push({ type: 'text_delta', delta });
        }
      },
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

  private async runTurn(
    request: NormalizedRequest,
    signal?: AbortSignal,
    onTextDelta?: (delta: string) => void,
  ): Promise<LocalCompletionResult> {
    const startedAt = Date.now();
    await this.ensureStarted();
    const prompt = buildPrompt(request);
    const threadPromise = this.startThread();
    let threadId: string | null = null;
    let preparedInput: Awaited<ReturnType<typeof prepareCodexInput>> | null = null;
    const preparedInputPromise = prepareCodexInput(request, prompt).then((value) => {
      preparedInput = value;
      return value;
    });
    let turnId: string | null = null;
    const abort = async (): Promise<void> => {
      if (!turnId) return;
      await this.send('turn/interrupt', { threadId, turnId }).catch(() => undefined);
    };
    const onAbort = (): void => {
      void abort();
    };
    if (signal) {
      if (signal.aborted) await abort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      [threadId, preparedInput] = await Promise.all([threadPromise, preparedInputPromise]);
      const turn = await this.send('turn/start', {
        threadId,
        input: preparedInput.input,
        model: this.modelOverrideFor(request.model),
        effort: this.reasoningEffort,
        outputSchema: outputSchemaFor(request),
      });
      turnId = readPath<string>(turn, ['result', 'turn', 'id']);
      if (!turnId) throw new Error('codex app-server did not return a turn id');
      const turnResult = await this.waitForTurn(threadId, turnId, signal, onTextDelta);
      const parsed = parseBackendOutput(request, turnResult.text);
      const usage = turnResult.usage ?? usageFor(request, parsed.text, parsed.toolCalls);
      return {
        id: `local_${randomUUID()}`,
        model: request.model,
        text: parsed.text,
        toolCalls: parsed.toolCalls,
        usage,
        latencyMs: Date.now() - startedAt,
      };
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (preparedInput) await preparedInput.cleanup();
      else void preparedInputPromise.then((value) => value.cleanup()).catch(() => undefined);
      if (threadId) this.archiveThread(threadId);
    }
  }

  async close(): Promise<void> {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('codex app-server backend closed'));
    }
    this.pending.clear();
    for (const waiter of this.turnWaiters.values()) {
      waiter.reject(new Error('codex app-server backend closed'));
    }
    this.turnWaiters.clear();
    this.lineReader?.close();
    this.child?.kill('SIGTERM');
    this.child = null;
    this.lineReader = null;
    this.initialized = null;
  }

  private async ensureStarted(): Promise<void> {
    if (this.initialized) return this.initialized;
    this.initialized = this.start();
    return this.initialized;
  }

  private async start(): Promise<void> {
    this.child = spawn(this.command, ['app-server', '--listen', 'stdio://'], {
      cwd: this.cwd,
      shell: false,
      env: {
        ...process.env,
        TERM: process.env.TERM && process.env.TERM !== 'dumb'
          ? process.env.TERM
          : 'xterm-256color',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-12_000);
    });
    this.child.on('error', (err) => this.failAll(err));
    this.child.on('close', (code, signal) => {
      this.failAll(new Error(`codex app-server exited: code=${code ?? 'null'} signal=${signal ?? 'null'}`));
      this.child = null;
      this.lineReader = null;
      this.initialized = null;
    });

    this.lineReader = readline.createInterface({ input: this.child.stdout });
    this.lineReader.on('line', (line) => this.handleLine(line));

    await this.send('initialize', {
      clientInfo: {
        name: 'ggui_oauth_cli_proxy',
        title: 'ggui OAuth CLI Proxy',
        version: '0.1.0',
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        optOutNotificationMethods: [],
      },
    });
    this.notify('initialized', {});
  }

  private async startThread(): Promise<string> {
    const thread = await this.send('thread/start', {
      cwd: this.cwd,
      runtimeWorkspaceRoots: [this.cwd],
      approvalPolicy: 'never',
      sandbox: 'read-only',
      ephemeral: true,
      baseInstructions: baseInstructions(),
      developerInstructions: developerInstructions(),
      experimentalRawEvents: false,
      persistExtendedHistory: false,
      config: {
        model_reasoning_effort: this.reasoningEffort,
      },
    });
    const threadId = readPath<string>(thread, ['result', 'thread', 'id']);
    if (!threadId) throw new Error('codex app-server did not return a thread id');
    return threadId;
  }

  private archiveThread(threadId: string): void {
    void this.send('thread/archive', { threadId }).catch(() => undefined);
  }

  private send(method: string, params: unknown): Promise<JsonRpcMessage> {
    if (!this.child) {
      return Promise.reject(new Error('codex app-server is not running'));
    }
    const id = this.nextId;
    this.nextId += 1;
    const payload = JSON.stringify({ method, id, params });
    this.child.stdin.write(`${payload}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
    });
  }

  private notify(method: string, params: unknown): void {
    this.child?.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  private handleLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }

    const id = typeof message.id === 'number' ? message.id : null;
    if (id !== null && this.pending.has(id)) {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(`${pending.method} failed: ${JSON.stringify(message.error)}`));
      } else {
        pending.resolve(message);
      }
      return;
    }

    if (id !== null && typeof message.method === 'string') {
      this.respondToServerRequest(id, message.method);
      return;
    }

    if (typeof message.method === 'string') {
      this.handleNotification(message.method, message.params);
    }
  }

  private respondToServerRequest(id: number, method: string): void {
    const result = method.includes('requestApproval')
      ? { decision: 'decline' }
      : undefined;
    this.child?.stdin.write(`${JSON.stringify({
      id,
      ...(result
        ? { result }
        : { error: { code: -32601, message: `Unsupported server request: ${method}` } }),
    })}\n`);
  }

  private handleNotification(method: string, params: unknown): void {
    const data = asRecord(params);
    if (!data) return;
    if (method === 'item/agentMessage/delta') {
      const waiter = this.turnWaiters.get(`${data.threadId}:${data.turnId}`);
      if (waiter && typeof data.delta === 'string') {
        waiter.text += data.delta;
        waiter.onTextDelta?.(data.delta);
      }
      return;
    }
    if (method === 'item/completed') {
      const waiter = this.turnWaiters.get(`${data.threadId}:${data.turnId}`);
      const item = asRecord(data.item);
      if (waiter && item?.type === 'agentMessage' && typeof item.text === 'string') {
        waiter.text = item.text;
      }
      return;
    }
    if (method === 'thread/tokenUsage/updated') {
      const threadId = typeof data.threadId === 'string' ? data.threadId : null;
      const turnId = typeof data.turnId === 'string' ? data.turnId : null;
      if (!threadId || !turnId) return;
      const usage = usageFromCodexTokenUsage(data.tokenUsage);
      const waiter = usage ? this.turnWaiters.get(`${threadId}:${turnId}`) : null;
      if (waiter && usage) waiter.usage = usage;
      return;
    }
    if (method === 'turn/completed') {
      const threadId = typeof data.threadId === 'string' ? data.threadId : null;
      const turn = asRecord(data.turn);
      const turnId = typeof turn?.id === 'string' ? turn.id : null;
      if (!threadId || !turnId) return;
      const key = `${threadId}:${turnId}`;
      const waiter = this.turnWaiters.get(key);
      if (!waiter) return;
      if (turn?.status === 'failed') {
        this.turnWaiters.delete(key);
        waiter.reject(new Error(JSON.stringify(turn.error ?? 'turn failed')));
      } else {
        const resolveTurn = (): void => {
          const current = this.turnWaiters.get(key);
          if (!current) return;
          this.turnWaiters.delete(key);
          current.resolve({
            text: current.text.trim(),
            usage: current.usage,
          });
        };
        if (waiter.usage) resolveTurn();
        else setTimeout(resolveTurn, USAGE_NOTIFICATION_GRACE_MS);
      }
    }
  }

  private waitForTurn(
    threadId: string,
    turnId: string,
    signal?: AbortSignal,
    onTextDelta?: (delta: string) => void,
  ): Promise<TurnResult> {
    const key = `${threadId}:${turnId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.turnWaiters.delete(key);
        reject(new Error(`turn timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', abortFromSignal);
      };
      const abortFromSignal = (): void => {
        this.turnWaiters.delete(key);
        cleanup();
        reject(new Error('request aborted'));
      };
      const waiter: TurnWaiter = {
        threadId,
        turnId,
        text: '',
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
      this.turnWaiters.set(key, waiter);
      if (signal) {
        if (signal.aborted) abortFromSignal();
        else signal.addEventListener('abort', abortFromSignal, { once: true });
      }
    });
  }

  private failAll(err: Error): void {
    const detail = this.stderr ? `\n${this.stderr.slice(-2000)}` : '';
    const wrapped = new Error(`${err.message}${detail}`);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(wrapped);
    }
    this.pending.clear();
    for (const waiter of this.turnWaiters.values()) waiter.reject(wrapped);
    this.turnWaiters.clear();
  }

  private modelOverrideFor(requestModel: string): string | undefined {
    if (this.configuredModel) return this.configuredModel;
    if (!requestModel || requestModel === this.model || requestModel === 'codex-app-server') {
      return undefined;
    }
    return requestModel;
  }
}

function readPath<T>(value: unknown, path: readonly string[]): T | null {
  let current = value;
  for (const part of path) {
    const obj = asRecord(current);
    if (!obj) return null;
    current = obj[part];
  }
  return current as T;
}

export function usageFromCodexTokenUsage(value: unknown): LocalUsage | null {
  const usage = asRecord(value);
  const last = asRecord(usage?.last);
  if (!last) return null;
  const totalTokens = readNumber(last.totalTokens);
  const inputTokens = readNumber(last.inputTokens);
  const outputTokens = readNumber(last.outputTokens);
  const cachedInputTokens = readNumber(last.cachedInputTokens);
  const reasoningOutputTokens = readNumber(last.reasoningOutputTokens);
  if (
    totalTokens === 0
    && inputTokens === 0
    && outputTokens === 0
    && cachedInputTokens === 0
    && reasoningOutputTokens === 0
  ) {
    return null;
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cachedInputTokens,
    reasoningOutputTokens,
    source: 'provider',
    raw: value,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
