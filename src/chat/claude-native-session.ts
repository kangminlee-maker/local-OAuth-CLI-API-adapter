import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';
import { AsyncQueue } from '../proxy/async-queue.js';
import { claudeMessageContentFor } from '../proxy/multimodal.js';
import { proxyChildProcessEnv } from '../proxy/process-env.js';
import { chatNormalizedRequest, chatPromptText } from './input.js';
import type {
  LocalCliChatRuntimeEvent,
  LocalCliChatRuntimeSession,
  LocalCliChatTurnInput,
} from './types.js';

type JsonObject = Record<string, unknown>;

interface Turn {
  readonly queue: AsyncQueue<LocalCliChatRuntimeEvent>;
  /**
   * The turn's own deadline. It is retired with the turn: an abandoned
   * generator never reaches its `finally`, so a turn stopped any other way
   * left its timer armed to fire on whatever turn was running by then.
   */
  readonly timer: NodeJS.Timeout;
}

export interface ClaudeNativeCliChatSessionOptions {
  readonly command?: string;
  readonly cwd: string;
  readonly model?: string;
  readonly timeoutMs: number;
  readonly extraArgs?: readonly string[];
  readonly isolateUserSettings?: boolean;
}

export class ClaudeNativeCliChatSession implements LocalCliChatRuntimeSession {
  readonly runtime = 'claude' as const;
  readonly native: Record<string, unknown>;

  private readonly command: string;
  private readonly cwd: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly extraArgs: readonly string[];
  private readonly isolateUserSettings: boolean;
  private child: ChildProcessWithoutNullStreams | null = null;
  private lineReader: readline.Interface | null = null;
  private stderr = '';
  private turn: Turn | null = null;
  /** The in-flight child replacement, so a turn waits for it instead of racing it. */
  private restarting: Promise<void> | null = null;

  private constructor(options: Required<ClaudeNativeCliChatSessionOptions>) {
    this.command = options.command;
    this.cwd = options.cwd;
    this.model = options.model;
    this.timeoutMs = options.timeoutMs;
    this.extraArgs = options.extraArgs;
    this.isolateUserSettings = options.isolateUserSettings;
    this.native = {
      input_format: 'stream-json',
      output_format: 'stream-json',
    };
  }

  static async create(
    options: ClaudeNativeCliChatSessionOptions,
  ): Promise<ClaudeNativeCliChatSession> {
    const session = new ClaudeNativeCliChatSession({
      command: options.command ?? 'claude',
      cwd: options.cwd,
      model: options.model ?? 'claude-code-cli',
      timeoutMs: options.timeoutMs,
      extraArgs: options.extraArgs ?? [],
      isolateUserSettings: options.isolateUserSettings ?? false,
    });
    await session.start();
    return session;
  }

  async *startTurn(
    input: LocalCliChatTurnInput,
    signal?: AbortSignal,
  ): AsyncIterable<LocalCliChatRuntimeEvent> {
    if (this.restarting) await this.restarting;
    if (!this.child) throw new Error('claude native chat session is not running');
    if (this.turn) throw new Error('claude native chat session already has a running turn');
    const queue = new AsyncQueue<LocalCliChatRuntimeEvent>();
    const timer = setTimeout(() => {
      queue.fail(new Error(`claude turn timed out after ${this.timeoutMs}ms`));
      this.retire();
      // The child is still working on the abandoned prompt, and every line it
      // writes goes to whatever turn is active when it arrives — including the
      // `result` that closes a queue as a success. A timed-out turn's answer
      // was delivered to the NEXT turn as its own. Retire the child instead.
      void this.restartChild();
    }, this.timeoutMs);
    // Abandoning a turn and interrupting one are the same operation on this
    // runtime, so they take the same path: stopping the child without the
    // restart left the session reporting `ready` over a child that had been
    // signalled away, and every later turn answered "session is not running".
    const abort = (): void => {
      void this.stopTurn(turn);
    };
    // A caller that has already left gets no turn at all: replacing the child
    // for a turn that was never sent costs the session its child for nothing.
    if (signal?.aborted) {
      clearTimeout(timer);
      throw new Error('request aborted');
    }
    const turn: Turn = { queue, timer };
    this.turn = turn;
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const request = chatNormalizedRequest(input, this.model);
      const content = await claudeMessageContentFor(request, chatPromptText(input));
      // Assembling the prompt is asynchronous — a path-based image is file I/O
      // — and the turn can be stopped while it runs, which replaces the child.
      // The child read here is the one that exists NOW, and the prompt is only
      // written while this turn still owns the session: writing afterwards sent
      // an abandoned turn's prompt down a pipe belonging to nobody, either a
      // killed child's stdin or the replacement's.
      const child = this.child;
      if (!child || this.turn?.queue !== queue) {
        throw new Error('request aborted');
      }
      child.stdin.write(`${JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content,
        },
        parent_tool_use_id: null,
      })}\n`);
      for await (const event of queue) yield event;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', abort);
      if (this.turn?.queue === queue) this.retire();
    }
  }

  async interrupt(): Promise<void> {
    if (this.turn) await this.stopTurn(this.turn);
  }

  isBusy(): boolean {
    return this.turn !== null;
  }

  /**
   * Stops one turn — and only if it is still the session's. An abandoned turn's
   * abort listener is never removed, because its generator never finalizes, so
   * it can fire long after that turn ended: without the identity check it
   * stopped whoever was running by then and replaced that turn's child.
   */
  private async stopTurn(turn: Turn): Promise<void> {
    if (this.turn !== turn) return;
    turn.queue.fail(new Error('request interrupted'));
    this.retire();
    // This CLI has no in-band stop, so interrupting it is a restart: the child
    // is mid-prompt, and every line it writes goes to whatever turn is active
    // when it arrives. Without the restart the session reported `ready` while
    // every later turn answered "session is not running".
    //
    // Not awaited: the replacement is a process launch, and the next turn
    // already waits for it. Making the interrupt endpoint wait for a spawn
    // spends that latency on every caller who asked only to stop.
    void this.restartChild();
  }

  /** Replaces the child so the session stays usable after an abandoned turn. */
  private async restartChild(): Promise<void> {
    // One replacement at a time. Two overlapping restarts killed the child the
    // first had just spawned and left the second owning a field the first
    // would not clear.
    if (this.restarting) return this.restarting;
    const restart = (async () => {
      const previous = this.child;
      this.child = null;
      this.lineReader?.close();
      this.lineReader = null;
      previous?.kill('SIGTERM');
      // The replacement starts with a clean slate: a SIGTERMed child usually
      // writes its own shutdown to stderr, and carrying that into the next
      // child's buffer reported the previous child's death as the diagnosis for
      // an unrelated turn's failure.
      this.stderr = '';
      try {
        await this.start();
      } catch {
        // Left not-running: the next turn reports that plainly rather than
        // hanging against a child that no longer exists.
      }
    })();
    // A restart nobody awaited — the idle deadline's, and an interrupt whose
    // caller has already been answered — otherwise races the next turn, which
    // found `child` null for as long as the spawn took and refused a session
    // that was about to be fine.
    this.restarting = restart;
    try {
      await restart;
    } finally {
      if (this.restarting === restart) this.restarting = null;
    }
  }

  async close(): Promise<void> {
    // Failed, not closed: a closed queue reads as a turn that finished, and the
    // caller was streaming an answer that will now never come. And no
    // replacement child — the session is going away, not carrying on.
    this.turn?.queue.fail(new Error('local CLI chat session closed'));
    this.retire();
    this.lineReader?.close();
    this.child?.kill('SIGTERM');
    this.child = null;
    this.lineReader = null;
  }

  private async start(): Promise<void> {
    const child = spawn(this.command, [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--disable-slash-commands',
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--setting-sources',
      this.isolateUserSettings ? '' : 'user',
      '--tools',
      '',
      '--no-session-persistence',
      ...(this.model ? ['--model', this.model] : []),
      ...this.extraArgs,
    ], {
      cwd: this.cwd,
      shell: false,
      env: proxyChildProcessEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-12_000);
    });
    // Only while this child is still the session's. A replaced child reports
    // its own exit after the replacement is already running, and answering it
    // then cleared the LIVE child and failed a turn that had nothing to do
    // with it — the restart repaired the session and its own aftermath broke it.
    child.on('error', (err) => {
      if (this.child === child) this.failActive(err);
    });
    // A pipe that dies under a write reports it here, and an `error` event with
    // no listener is an uncaught exception: one racing write would take the
    // whole proxy down rather than the turn.
    child.stdin.on('error', (err) => {
      if (this.child === child) this.failActive(err);
    });
    child.on('close', (code, signal) => {
      if (this.child !== child) return;
      this.failActive(new Error(`claude code exited: code=${code ?? 'null'} signal=${signal ?? 'null'}`));
      this.child = null;
      this.lineReader = null;
    });
    this.lineReader = readline.createInterface({ input: child.stdout });
    this.lineReader.on('line', (line) => this.handleLine(line));
  }

  private handleLine(line: string): void {
    const message = parseJsonObject(line);
    if (!message || !this.turn) return;
    const event = eventFromClaudeMessage(message);
    this.turn.queue.push(event);
    if (message.type === 'result') {
      if (message.subtype === 'success') this.turn.queue.close();
      else this.turn.queue.fail(new Error(readErrorMessage(message)));
      this.retire();
    }
  }

  private failActive(err: Error): void {
    const detail = this.stderr ? `\n${this.stderr.slice(-2000)}` : '';
    this.turn?.queue.fail(new Error(`${err.message}${detail}`));
    this.retire();
  }

  /**
   * Retires the running turn, its deadline included — and the ONLY place the
   * turn stops being the session's. A deadline that outlives its turn fires
   * against whoever is running by then: it retires that turn and replaces its
   * child, and because the turn was already cleared, the child's exit fails
   * nothing, so the replacement never answers and never errors either. Every
   * path that ends a turn comes through here for that reason.
   */
  private retire(): void {
    if (!this.turn) return;
    clearTimeout(this.turn.timer);
    this.turn = null;
  }
}

function eventFromClaudeMessage(message: JsonObject): LocalCliChatRuntimeEvent {
  const event = asRecord(message.event);
  const delta = asRecord(event?.delta);
  const textDelta = event?.type === 'content_block_delta'
    && delta?.type === 'text_delta'
    && typeof delta.text === 'string'
    ? delta.text
    : undefined;
  return {
    raw: message,
    ...(textDelta !== undefined ? { textDelta } : {}),
    ...(message.type === 'result' && message.usage !== undefined ? { usage: message.usage } : {}),
  };
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

function readErrorMessage(message: JsonObject): string {
  if (typeof message.result === 'string' && message.result.trim()) return message.result;
  if (typeof message.error === 'string' && message.error.trim()) return message.error;
  return JSON.stringify(message);
}
