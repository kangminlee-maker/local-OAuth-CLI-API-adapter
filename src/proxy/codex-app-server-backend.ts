import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import readline from 'node:readline';
import { codexProxyFallbackReasoningEffort } from '../settings.js';
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
  NormalizedReasoningEffort,
} from './types.js';
import { ToolCallDeltaExtractor } from './tool-call-stream.js';

interface CodexAppServerBackendOptions {
  readonly command?: string;
  readonly cwd: string;
  readonly model?: string;
  readonly timeoutMs: number;
  readonly reasoningEffort?: CodexReasoningEffort;
  readonly onTiming?: (timing: CodexTurnTiming) => void;
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
  completed: boolean;
  completedAt?: number;
  usageUpdatedAt?: number;
  usageGraceTimer?: NodeJS.Timeout;
  onTextDelta?: (delta: string) => void;
  resolve: (value: TurnResult) => void;
  reject: (err: Error) => void;
}

type JsonRpcMessage = Record<string, unknown>;

interface TurnResult {
  readonly text: string;
  readonly usage?: LocalUsage;
  readonly usageWaitMs?: number;
}

type CodexReasoningEffort = NormalizedReasoningEffort;

export interface CodexIsolation {
  readonly rootDir: string;
  readonly homeDir: string;
  readonly workDir: string;
  readonly defaultModel?: string;
}

interface CodexTurnTiming {
  readonly ensureStartedMs: number;
  readonly promptBuildMs: number;
  readonly threadStartMs: number;
  readonly inputPrepareMs: number;
  readonly turnStartMs: number;
  readonly turnWaitMs: number;
  readonly usageWaitMs: number;
  readonly totalMs: number;
}

const USAGE_NOTIFICATION_GRACE_MS = 100;
const FALLBACK_CODEX_MODEL = 'gpt-5.5';
const DISABLED_CODEX_CONTEXT_FEATURES = [
  'apps',
  'browser_use',
  'computer_use',
  'goals',
  'hooks',
  'image_generation',
  'multi_agent',
  'plugins',
  'shell_tool',
  'workspace_dependencies',
] as const;

export class CodexAppServerBackend implements LocalCliBackend {
  readonly name = 'codex-app-server';
  readonly model: string;

  private readonly command: string;
  private readonly cwd: string;
  private readonly configuredModel?: string;
  private readonly timeoutMs: number;
  private readonly reasoningEffort: CodexReasoningEffort;
  private readonly onTiming?: (timing: CodexTurnTiming) => void;
  private child: ChildProcessWithoutNullStreams | null = null;
  private lineReader: readline.Interface | null = null;
  private nextId = 1;
  private initialized: Promise<void> | null = null;
  private stderr = '';
  private readonly pending = new Map<number, PendingRequest>();
  private readonly turnWaiters = new Map<string, TurnWaiter>();
  private isolation: CodexIsolation | null = null;

  constructor(options: CodexAppServerBackendOptions) {
    this.command = options.command ?? 'codex';
    this.cwd = options.cwd;
    this.model = options.model ?? 'codex-app-server';
    this.configuredModel = options.model;
    this.timeoutMs = options.timeoutMs;
    this.reasoningEffort = options.reasoningEffort ?? codexProxyFallbackReasoningEffort();
    this.onTiming = options.onTiming;
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
    const timing = {
      ensureStartedMs: 0,
      promptBuildMs: 0,
      threadStartMs: 0,
      inputPrepareMs: 0,
      turnStartMs: 0,
      turnWaitMs: 0,
      usageWaitMs: 0,
    };
    let phaseStartedAt = Date.now();
    await this.ensureStarted();
    timing.ensureStartedMs = Date.now() - phaseStartedAt;
    phaseStartedAt = Date.now();
    const reasoningEffort = request.reasoningEffort ?? this.reasoningEffort;
    const prompt = buildPrompt(request);
    timing.promptBuildMs = Date.now() - phaseStartedAt;
    const threadStartedAt = Date.now();
    const threadPromise = this.startThread(reasoningEffort).then((value) => {
      timing.threadStartMs = Date.now() - threadStartedAt;
      return value;
    });
    let threadId: string | null = null;
    let preparedInput: Awaited<ReturnType<typeof prepareCodexInput>> | null = null;
    const inputStartedAt = Date.now();
    const preparedInputPromise = prepareCodexInput(request, prompt).then((value) => {
      preparedInput = value;
      timing.inputPrepareMs = Date.now() - inputStartedAt;
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
      const cwd = this.isolation?.workDir ?? this.cwd;
      phaseStartedAt = Date.now();
      const turn = await this.send('turn/start', {
        threadId,
        cwd,
        runtimeWorkspaceRoots: [cwd],
        environments: [],
        input: preparedInput.input,
        model: this.modelOverrideFor(request.model),
        effort: reasoningEffort,
        summary: 'none',
        personality: 'none',
        outputSchema: outputSchemaFor(request),
      });
      timing.turnStartMs = Date.now() - phaseStartedAt;
      turnId = readPath<string>(turn, ['result', 'turn', 'id']);
      if (!turnId) throw new Error('codex app-server did not return a turn id');
      phaseStartedAt = Date.now();
      const turnResult = await this.waitForTurn(threadId, turnId, signal, onTextDelta);
      timing.turnWaitMs = Date.now() - phaseStartedAt;
      timing.usageWaitMs = turnResult.usageWaitMs ?? 0;
      const parsed = parseBackendOutput(request, turnResult.text);
      const usage = turnResult.usage ?? usageFor(request, parsed.text, parsed.toolCalls);
      const totalMs = Date.now() - startedAt;
      this.onTiming?.({
        ...timing,
        totalMs,
      });
      return {
        id: `local_${randomUUID()}`,
        model: request.model,
        text: parsed.text,
        toolCalls: parsed.toolCalls,
        usage,
        latencyMs: totalMs,
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
    await this.cleanupIsolation();
  }

  private async ensureStarted(): Promise<void> {
    if (this.initialized) return this.initialized;
    this.initialized = this.start();
    return this.initialized;
  }

  private async start(): Promise<void> {
    const isolation = await createCodexIsolation({
      configuredModel: this.configuredModel,
      reasoningEffort: this.reasoningEffort,
    });
    this.isolation = isolation;
    const appServerArgs = [
      'app-server',
      ...codexContextIsolationArgs({
        model: this.configuredModel ?? isolation.defaultModel ?? FALLBACK_CODEX_MODEL,
        reasoningEffort: this.reasoningEffort,
      }),
      '--listen',
      'stdio://',
    ];
    this.child = spawn(this.command, appServerArgs, {
      cwd: isolation.workDir,
      shell: false,
      env: {
        ...process.env,
        CODEX_HOME: isolation.homeDir,
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
      void this.cleanupIsolation();
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

  private async startThread(reasoningEffort: CodexReasoningEffort): Promise<string> {
    const cwd = this.isolation?.workDir ?? this.cwd;
    const thread = await this.send('thread/start', {
      cwd,
      runtimeWorkspaceRoots: [cwd],
      approvalPolicy: 'never',
      sandbox: 'read-only',
      environments: [],
      dynamicTools: [],
      ephemeral: true,
      baseInstructions: baseInstructions(),
      developerInstructions: developerInstructions(),
      personality: 'none',
      experimentalRawEvents: false,
      persistExtendedHistory: false,
      config: {
        model_reasoning_effort: reasoningEffort,
        model_reasoning_summary: 'none',
        web_search: 'disabled',
      },
    });
    const threadId = readPath<string>(thread, ['result', 'thread', 'id']);
    if (!threadId) throw new Error('codex app-server did not return a thread id');
    return threadId;
  }

  private archiveThread(threadId: string): void {
    void this.send('thread/archive', { threadId }).catch(() => undefined);
  }

  private async cleanupIsolation(): Promise<void> {
    const isolation = this.isolation;
    this.isolation = null;
    if (isolation) {
      await rm(isolation.rootDir, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
    }
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
      if (waiter && usage) {
        waiter.usage = usage;
        waiter.usageUpdatedAt = Date.now();
        if (waiter.completed) this.resolveTurnWaiter(threadId, turnId);
      }
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
        waiter.completed = true;
        waiter.completedAt = Date.now();
        if (waiter.usage) this.resolveTurnWaiter(threadId, turnId);
        else {
          waiter.usageGraceTimer = setTimeout(
            () => this.resolveTurnWaiter(threadId, turnId),
            USAGE_NOTIFICATION_GRACE_MS,
          );
        }
      }
    }
  }

  private resolveTurnWaiter(threadId: string, turnId: string): void {
    const key = `${threadId}:${turnId}`;
    const waiter = this.turnWaiters.get(key);
    if (!waiter) return;
    this.turnWaiters.delete(key);
    if (waiter.usageGraceTimer) {
      clearTimeout(waiter.usageGraceTimer);
      waiter.usageGraceTimer = undefined;
    }
    waiter.resolve({
      text: waiter.text.trim(),
      usage: waiter.usage,
      usageWaitMs: waiter.completedAt
        ? Math.max(0, (waiter.usageUpdatedAt ?? Date.now()) - waiter.completedAt)
        : 0,
    });
  }

  private waitForTurn(
    threadId: string,
    turnId: string,
    signal?: AbortSignal,
    onTextDelta?: (delta: string) => void,
  ): Promise<TurnResult> {
    const key = `${threadId}:${turnId}`;
    return new Promise((resolve, reject) => {
      let waiter: TurnWaiter | undefined;
      const timer = setTimeout(() => {
        this.turnWaiters.delete(key);
        cleanup();
        reject(new Error(`turn timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        if (waiter?.usageGraceTimer) {
          clearTimeout(waiter.usageGraceTimer);
          waiter.usageGraceTimer = undefined;
        }
        if (signal) signal.removeEventListener('abort', abortFromSignal);
      };
      const abortFromSignal = (): void => {
        this.turnWaiters.delete(key);
        cleanup();
        reject(new Error('request aborted'));
      };
      waiter = {
        threadId,
        turnId,
        text: '',
        completed: false,
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

export function codexContextIsolationArgs(options: {
  readonly model: string;
  readonly reasoningEffort: CodexReasoningEffort;
}): string[] {
  return [
    '-c',
    `model=${tomlString(options.model)}`,
    '-c',
    `model_reasoning_effort=${tomlString(options.reasoningEffort)}`,
    '-c',
    'model_reasoning_summary="none"',
    '-c',
    'web_search="disabled"',
    '-c',
    'approval_policy="never"',
    '-c',
    'sandbox_mode="read-only"',
    '-c',
    'shell_environment_policy.inherit="none"',
    ...DISABLED_CODEX_CONTEXT_FEATURES.flatMap((feature) => [
      '-c',
      `features.${feature}=false`,
    ]),
    '-c',
    'notify=[]',
    '-c',
    'analytics.enabled=false',
  ];
}

export async function createCodexIsolation(options: {
  readonly configuredModel?: string;
  readonly reasoningEffort: CodexReasoningEffort;
}): Promise<CodexIsolation> {
  const rootDir = await mkdtemp(join(tmpdir(), 'ggui-codex-proxy-'));
  const homeDir = join(rootDir, 'codex-home');
  const workDir = join(rootDir, 'workspace');
  await Promise.all([
    mkdir(homeDir, { recursive: true }),
    mkdir(workDir, { recursive: true }),
  ]);

  const sourceHome = sourceCodexHome();
  const defaultModel = options.configuredModel ?? await readTopLevelStringConfig(sourceHome, 'model');
  await copyCodexAuth(sourceHome, homeDir);
  await writeFile(
    join(homeDir, 'config.toml'),
    minimalCodexConfigToml({
      model: defaultModel ?? FALLBACK_CODEX_MODEL,
      reasoningEffort: options.reasoningEffort,
    }),
    { mode: 0o600 },
  );

  return {
    rootDir,
    homeDir,
    workDir,
    defaultModel,
  };
}

export function minimalCodexConfigToml(options: {
  readonly model: string;
  readonly reasoningEffort: CodexReasoningEffort;
}): string {
  return [
    `model = ${tomlString(options.model)}`,
    `model_reasoning_effort = ${tomlString(options.reasoningEffort)}`,
    'model_reasoning_summary = "none"',
    'web_search = "disabled"',
    'approval_policy = "never"',
    'sandbox_mode = "read-only"',
    '',
    '[analytics]',
    'enabled = false',
    '',
    '[features]',
    ...DISABLED_CODEX_CONTEXT_FEATURES.map((feature) => `${feature} = false`),
    '',
    '[shell_environment_policy]',
    'inherit = "none"',
    '',
  ].join('\n');
}

function sourceCodexHome(): string {
  return process.env.CODEX_HOME && process.env.CODEX_HOME.trim()
    ? process.env.CODEX_HOME
    : join(homedir(), '.codex');
}

async function copyCodexAuth(sourceHome: string, targetHome: string): Promise<void> {
  try {
    await copyFile(join(sourceHome, 'auth.json'), join(targetHome, 'auth.json'));
  } catch {
    // Let Codex surface its normal auth error if the user has no local auth state.
  }
}

async function readTopLevelStringConfig(sourceHome: string, key: string): Promise<string | undefined> {
  let text: string;
  try {
    text = await readFile(join(sourceHome, 'config.toml'), 'utf8');
  } catch {
    return undefined;
  }
  const match = new RegExp(`^${escapeRegExp(key)}\\s*=\\s*"([^"\\\\]*(?:\\\\.[^"\\\\]*)*)"\\s*$`, 'm').exec(text);
  if (!match?.[1]) return undefined;
  return match[1].replace(/\\(["\\])/g, '$1');
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
