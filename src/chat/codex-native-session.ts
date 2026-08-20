import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';
import { AsyncQueue } from '../proxy/async-queue.js';
import {
  codexContextIsolationArgs,
  createCodexIsolation,
  type CodexAppServerProxyMode,
} from '../proxy/codex-app-server-backend.js';
import { prepareCodexInput } from '../proxy/multimodal.js';
import { proxyChildProcessEnv } from '../proxy/process-env.js';
import type {
  NormalizedReasoningEffort,
  NormalizedVerbosity,
} from '../proxy/types.js';
import { codexProxyFallbackReasoningEffort } from '../settings.js';
import { chatNormalizedRequest, chatPromptText } from './input.js';
import type {
  LocalCliChatRuntimeEvent,
  LocalCliChatRuntimeSession,
  LocalCliChatTurnInput,
} from './types.js';

/** How long `close()` waits for the child's best-effort thread archive. */
const CLOSE_ARCHIVE_TIMEOUT_MS = 2_000;

/** A delay that never keeps the process alive on its own. */
function closeGraceDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: JsonRpcMessage) => void;
  readonly reject: (err: Error) => void;
  readonly timer: NodeJS.Timeout;
}

interface ActiveTurn {
  readonly turnId: string;
  readonly queue: AsyncQueue<LocalCliChatRuntimeEvent>;
}

type JsonRpcMessage = Record<string, unknown>;

export interface CodexNativeCliChatSessionOptions {
  readonly command?: string;
  readonly cwd: string;
  readonly model?: string;
  readonly timeoutMs: number;
  readonly reasoningEffort?: NormalizedReasoningEffort;
  readonly verbosity?: NormalizedVerbosity;
  readonly imageGeneration?: boolean;
  readonly proxyMode?: CodexAppServerProxyMode;
}

export class CodexNativeCliChatSession implements LocalCliChatRuntimeSession {
  readonly runtime = 'codex' as const;
  readonly native: Record<string, unknown>;

  private readonly command: string;
  private readonly cwd: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly reasoningEffort: NormalizedReasoningEffort;
  private readonly verbosity: NormalizedVerbosity;
  private readonly imageGeneration: boolean;
  private child: ChildProcessWithoutNullStreams | null = null;
  private lineReader: readline.Interface | null = null;
  private nextId = 1;
  private stderr = '';
  private readonly pending = new Map<number, PendingRequest>();
  private activeTurn: ActiveTurn | null = null;
  private bufferedNotifications: LocalCliChatRuntimeEvent[] = [];
  private isolation: Awaited<ReturnType<typeof createCodexIsolation>> | null = null;
  private threadId = '';

  private constructor(options: Required<CodexNativeCliChatSessionOptions>) {
    this.command = options.command;
    this.cwd = options.cwd;
    this.model = options.model;
    this.timeoutMs = options.timeoutMs;
    this.reasoningEffort = options.reasoningEffort;
    this.verbosity = options.verbosity;
    this.imageGeneration = options.imageGeneration;
    this.native = {};
  }

  static async create(
    options: CodexNativeCliChatSessionOptions,
  ): Promise<CodexNativeCliChatSession> {
    const session = new CodexNativeCliChatSession({
      command: options.command ?? 'codex',
      cwd: options.cwd,
      model: options.model ?? 'gpt-5.5',
      timeoutMs: options.timeoutMs,
      reasoningEffort: options.reasoningEffort ?? codexProxyFallbackReasoningEffort(),
      verbosity: options.verbosity ?? 'medium',
      imageGeneration: options.imageGeneration ?? false,
      proxyMode: options.proxyMode ?? 'no-instructions',
    });
    try {
      await session.start();
    } catch (err) {
      // The isolation directory holds a copy of the operator's real
      // credentials and the child may already be running: a failed start left
      // both behind, one more of each per retry.
      await session.close().catch(() => undefined);
      throw err;
    }
    return session;
  }

  async *startTurn(
    input: LocalCliChatTurnInput,
    signal?: AbortSignal,
  ): AsyncIterable<LocalCliChatRuntimeEvent> {
    if (!this.child) throw new Error('codex native chat session is not running');
    if (this.activeTurn) throw new Error('codex native chat session already has a running turn');
    const request = chatNormalizedRequest(input, this.model);
    const preparedInput = await prepareCodexInput(request, chatPromptText(input));
    const queue = new AsyncQueue<LocalCliChatRuntimeEvent>();
    let turnId = '';
    const abort = async (): Promise<void> => {
      // Ending the caller's iteration is the part that must not depend on the
      // child: the queue closes on `turn/completed`, so a child that stopped
      // answering left an aborted turn iterating forever — the abort reached
      // the child and nothing reached the caller.
      queue.fail(new Error('local CLI chat turn aborted'));
      if (!turnId) return;
      await this.send('turn/interrupt', { threadId: this.threadId, turnId }).catch(() => undefined);
    };
    const onAbort = (): void => {
      void abort();
    };
    if (signal) {
      if (signal.aborted) await abort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      const response = await this.send('turn/start', {
        threadId: this.threadId,
        cwd: this.cwd,
        runtimeWorkspaceRoots: [this.cwd],
        environments: [],
        input: preparedInput.input,
        model: this.model,
        effort: this.reasoningEffort,
        summary: 'none',
        outputSchema: null,
        personality: 'none',
      });
      turnId = readPath<string>(response, ['result', 'turn', 'id']) ?? '';
      if (!turnId) throw new Error('codex app-server did not return a turn id');
      this.activeTurn = { turnId, queue };
      queue.push({
        raw: {
          method: 'turn/start',
          response,
        },
      });
      this.flushBufferedNotifications(turnId, queue);
      for await (const event of queue) yield event;
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (this.activeTurn?.turnId === turnId) this.activeTurn = null;
      await preparedInput.cleanup();
    }
  }

  async interrupt(): Promise<void> {
    const turnId = this.activeTurn?.turnId;
    if (!turnId) return;
    await this.send('turn/interrupt', { threadId: this.threadId, turnId }).catch(() => undefined);
  }

  async close(): Promise<void> {
    this.activeTurn?.queue.close();
    this.activeTurn = null;
    if (this.threadId) {
      // A courtesy call gets a courtesy budget. Archiving an ephemeral thread is
      // best-effort cleanup, but it was awaited under the TURN timeout, so a
      // child that had stopped answering held shutdown for minutes — the
      // session DELETE and the server's own close both wait here. The child is
      // killed below either way; what the deadline drops is the waiting.
      await Promise.race([
        this.send('thread/archive', { threadId: this.threadId }).catch(() => undefined),
        closeGraceDelay(Math.min(CLOSE_ARCHIVE_TIMEOUT_MS, this.timeoutMs)),
      ]);
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('codex native chat session closed'));
    }
    this.pending.clear();
    this.lineReader?.close();
    this.child?.kill('SIGTERM');
    this.child = null;
    this.lineReader = null;
    if (this.isolation) {
      const { rm } = await import('node:fs/promises');
      await rm(this.isolation.rootDir, { recursive: true, force: true });
      this.isolation = null;
    }
  }

  private async start(): Promise<void> {
    this.isolation = await createCodexIsolation({
      configuredModel: this.model,
      reasoningEffort: this.reasoningEffort,
      verbosity: this.verbosity,
      imageGeneration: this.imageGeneration,
    });
    this.child = spawn(this.command, [
      'app-server',
      ...codexContextIsolationArgs({
        model: this.model,
        reasoningEffort: this.reasoningEffort,
        verbosity: this.verbosity,
        imageGeneration: this.imageGeneration,
      }),
      '--listen',
      'stdio://',
    ], {
      cwd: this.cwd,
      shell: false,
      env: proxyChildProcessEnv({
        CODEX_HOME: this.isolation.homeDir,
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-12_000);
    });
    this.child.on('error', (err) => this.failActive(err));
    this.child.on('close', (code, signal) => {
      this.failActive(new Error(`codex app-server exited: code=${code ?? 'null'} signal=${signal ?? 'null'}`));
      this.child = null;
      this.lineReader = null;
    });
    this.lineReader = readline.createInterface({ input: this.child.stdout });
    this.lineReader.on('line', (line) => this.handleLine(line));

    await this.send('initialize', {
      clientInfo: {
        name: 'local_oauth_cli_chat',
        title: 'Local OAuth CLI Chat',
        version: '0.1.0',
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        optOutNotificationMethods: [],
      },
    });
    this.notify('initialized', {});
    // Only protocol-declared `thread/start` fields are sent; see the same note in
    // the proxy backend, including why the experimental schema is the reference.
    const thread = await this.send('thread/start', {
      cwd: this.cwd,
      runtimeWorkspaceRoots: [this.cwd],
      approvalPolicy: 'never',
      sandbox: 'read-only',
      environments: [],
      dynamicTools: [],
      ephemeral: true,
      experimentalRawEvents: true,
      config: {
        model_reasoning_effort: this.reasoningEffort,
        model_reasoning_summary: 'none',
        model_verbosity: this.verbosity,
        web_search: 'disabled',
      },
    });
    this.threadId = readPath<string>(thread, ['result', 'thread', 'id']) ?? '';
    if (!this.threadId) throw new Error('codex app-server did not return a thread id');
    this.native.thread_id = this.threadId;
  }

  private send(method: string, params: unknown): Promise<JsonRpcMessage> {
    if (!this.child) return Promise.reject(new Error('codex app-server is not running'));
    const id = this.nextId;
    this.nextId += 1;
    this.child.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
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
    const message = parseJson(line);
    if (!message) return;
    const id = typeof message.id === 'number' ? message.id : null;
    if (id !== null && this.pending.has(id)) {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`${pending.method} failed: ${JSON.stringify(message.error)}`));
      else pending.resolve(message);
      return;
    }
    if (id !== null && typeof message.method === 'string') {
      this.child?.stdin.write(`${JSON.stringify({
        id,
        error: {
          code: -32601,
          message: `Unsupported local chat server request: ${message.method}`,
        },
      })}\n`);
      return;
    }
    if (typeof message.method === 'string') this.handleNotification(message.method, message.params);
  }

  private handleNotification(method: string, params: unknown): void {
    const data = asRecord(params);
    const raw = { method, params };
    const event: LocalCliChatRuntimeEvent = {
      raw,
      ...(method === 'item/agentMessage/delta' && typeof data?.delta === 'string'
        ? { textDelta: data.delta }
        : {}),
      ...(method === 'thread/tokenUsage/updated' ? { usage: params } : {}),
    };
    const turnId = typeof data?.turnId === 'string' ? data.turnId : undefined;
    if (this.activeTurn && (!turnId || turnId === this.activeTurn.turnId)) {
      this.activeTurn.queue.push(event);
      if (method === 'turn/completed') this.activeTurn.queue.close();
      return;
    }
    this.bufferedNotifications.push(event);
    this.bufferedNotifications = this.bufferedNotifications.slice(-100);
  }

  private flushBufferedNotifications(
    turnId: string,
    queue: AsyncQueue<LocalCliChatRuntimeEvent>,
  ): void {
    const remaining: LocalCliChatRuntimeEvent[] = [];
    for (const event of this.bufferedNotifications) {
      const params = asRecord(asRecord(event.raw)?.params);
      const eventTurnId = typeof params?.turnId === 'string' ? params.turnId : undefined;
      if (!eventTurnId || eventTurnId === turnId) {
        queue.push(event);
        if (asRecord(event.raw)?.method === 'turn/completed') queue.close();
      } else {
        remaining.push(event);
      }
    }
    this.bufferedNotifications = remaining;
  }

  private failActive(err: Error): void {
    const detail = this.stderr ? `\n${this.stderr.slice(-2000)}` : '';
    this.activeTurn?.queue.fail(new Error(`${err.message}${detail}`));
    this.activeTurn = null;
  }
}

function parseJson(line: string): JsonRpcMessage | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    return asRecord(parsed);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): JsonRpcMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as JsonRpcMessage;
}

function readPath<T>(value: unknown, path: readonly string[]): T | undefined {
  let current: unknown = value;
  for (const key of path) {
    const record = asRecord(current);
    if (!record || !(key in record)) return undefined;
    current = record[key];
  }
  return current as T;
}
