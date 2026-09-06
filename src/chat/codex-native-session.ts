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
import { terminateChild } from './child-exit.js';
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

/**
 * Everything one turn owns, installed the moment a turn is asked for and
 * retired in exactly one place. The pieces used to live in separate fields
 * updated at separate sites, and every site that forgot one produced the same
 * defect in a new shape: a turn nobody could stop, a session nobody could use
 * again, a stop aimed at a turn that was already over.
 */
interface Turn {
  readonly queue: AsyncQueue<LocalCliChatRuntimeEvent>;
  /** Empty until the child names the turn; it cannot be interrupted before. */
  turnId: string;
  /** Whether a stop has been asked for, whether or not it could be delivered. */
  stopped: boolean;
  /** Whether the child has been told. A turn is interrupted once, at most. */
  interrupted: boolean;
  /** Resolves when the turn stops being the session's, however it ends. */
  readonly retired: Promise<void>;
  markRetired: () => void;
  /** Settles when the turn is stopped: a wait the turn is in ends there (r55-codex). */
  readonly stopped$: Promise<void>;
  markStopped: () => void;
  /**
   * Removes what preparing this turn's input wrote — a temp file per image.
   * Owned by the turn because a turn can end while its reader is parked at a
   * `yield`, and the generator's `finally` never runs for that caller.
   */
  cleanup: (() => Promise<void>) | null;
}

type JsonRpcMessage = Record<string, unknown>;

/** A request the child never answered within the budget: its outcome is unknown, not failed. */
class CodexRpcTimeoutError extends Error {
  constructor(method: string, timeoutMs: number) {
    super(`${method} timed out after ${timeoutMs}ms`);
    this.name = 'CodexRpcTimeoutError';
  }
}

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
  /**
   * The turn in flight, from the moment one is asked for until it is retired.
   * Installed before the first `await` so that preparing the input — file I/O
   * for every base64 image — is inside the turn's life rather than before it:
   * that window is the slowest part of starting a turn, and a turn that cannot
   * be seen there cannot be stopped there either.
   */
  private turn: Turn | null = null;
  private bufferedNotifications: LocalCliChatRuntimeEvent[] = [];
  private isolation: Awaited<ReturnType<typeof createCodexIsolation>> | null = null;
  private threadId = '';
  /** The in-flight child replacement, so a turn waits for it instead of racing it. */
  private restarting: Promise<void> | null = null;
  /** Set by `close()`: a replacement in flight must not start a child the session will never close. */
  private closed = false;
  /** Isolation directories a replacement could not remove — the close's to remove, or to report. */
  private isolationDebt: string[] = [];
  /**
   * Children still there after `SIGKILL` and its grace. No successor is
   * spawned while one lives — the session owns one child at a time — and the
   * close names them (t1-r3-codex: a replacement went on over one).
   */
  private survivors: ChildProcessWithoutNullStreams[] = [];

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
    if (this.closed) throw new Error('codex native chat session is closed');
    if (this.turn) throw new Error('codex native chat session already has a running turn');
    // A caller that has already left gets no turn at all. Failing the queue and
    // then starting one anyway spent a turn on the child that nobody would read
    // and — with no turn id yet — nothing could interrupt.
    if (signal?.aborted) throw new Error('local CLI chat turn aborted');
    const request = chatNormalizedRequest(input, this.model);
    let markRetired = (): void => {};
    const retired = new Promise<void>((resolve) => { markRetired = resolve; });
    let markStopped = (): void => {};
    const stopped$ = new Promise<void>((resolve) => { markStopped = resolve; });
    const turn: Turn = {
      queue: new AsyncQueue<LocalCliChatRuntimeEvent>(),
      turnId: '',
      stopped: false,
      interrupted: false,
      retired,
      markRetired,
      stopped$,
      markStopped,
      cleanup: null,
    };
    this.turn = turn;
    const onAbort = (): void => {
      void this.stopTurn(turn);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    let preparedInput: Awaited<ReturnType<typeof prepareCodexInput>> | null = null;
    try {
      // The turn owns the session from here — through a child replacement in
      // flight too (r54-codex: a turn waiting for the replacement was nobody's
      // — `interrupt` found no turn, the session read `ready`, and the turn ran
      // afterwards) — and a stop that lands while it waits ends the wait, not
      // the replacement (r55-codex: the caller was held for the rest of the
      // replacement's startup, a whole RPC budget under a close).
      //
      // One replacement per turn: the one in flight, or — no child, and the
      // session open — one this turn starts. A failed replacement left the
      // session answering `ready` over no child, naming a thread that no longer
      // existed, and every later turn `not running` for the session's life
      // (t1 B-child gap 3); now `ready` means a turn will be attempted, and a
      // turn that could not get a child reports why — the replacement's own
      // failure, whether the turn waited for that attempt or made it.
      const replacement = this.restarting ?? (this.child ? null : this.replaceChild());
      if (replacement) await Promise.race([replacement, turn.stopped$]);
      if (turn.stopped) throw new Error('local CLI chat turn aborted');
      if (!this.child) throw new Error('codex native chat session is not running');
      preparedInput = await prepareCodexInput(request, chatPromptText(input));
      turn.cleanup = preparedInput.cleanup;
      if (turn.stopped) throw new Error('local CLI chat turn aborted');
      let response: JsonRpcMessage;
      try {
        response = await this.send('turn/start', {
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
      } catch (err) {
        // A turn the child never named within the budget may be running on
        // it, and nothing can interrupt what has no id. The request's expiry
        // used to release the session as if the turn had failed, and the
        // next turn reached the thread ahead of that work with no interrupt
        // between them (r52-codex). The child is replaced instead — the way
        // the sibling claude session replaces one that stopped answering.
        if (err instanceof CodexRpcTimeoutError) void this.replaceChild().catch(() => undefined);
        throw err;
      }
      turn.turnId = readPath<string>(response, ['result', 'turn', 'id']) ?? '';
      if (!turn.turnId) throw new Error('codex app-server did not return a turn id');
      // The stop may have come while this acknowledgement was in flight, when
      // there was no turn id to interrupt with. Now there is one, and the turn
      // is running on the child: interrupt it rather than walking away from it.
      if (turn.stopped) {
        await this.stopTurn(turn);
        throw new Error('local CLI chat turn aborted');
      }
      turn.queue.push({
        raw: {
          method: 'turn/start',
          response,
        },
      });
      this.flushBufferedNotifications(turn);
      for await (const event of turn.queue) yield event;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      this.retire(turn);
    }
  }

  /**
   * Stops one turn for both parties: the caller's iteration ends and the child
   * is told. Safe to call for a turn that is already over — the child hears
   * about a turn once.
   */
  private async stopTurn(turn: Turn): Promise<void> {
    // Not short-circuited on `stopped`: a stop asked for before the child named
    // the turn has nothing to send, and the acknowledgement calls back here to
    // deliver it once there is an id. What is sent once is the interrupt.
    turn.stopped = true;
    turn.markStopped();
    // Ending the caller's iteration is the part that must not depend on the
    // child: the queue closes on `turn/completed`, so a child that stopped
    // answering left an aborted turn iterating forever — the abort reached the
    // child and nothing reached the caller.
    turn.queue.fail(new Error('local CLI chat turn aborted'));
    // A turn the child has been asked for but has not named yet cannot be
    // interrupted, and nothing may start ahead of it: releasing the session
    // here let the next turn's `turn/start` reach the child before this turn's
    // interrupt, putting two turns on the thread. So the turn keeps the session
    // until its acknowledgement arrives — or its request fails — which is where
    // the interrupt gets written. The caller is not made to wait for that: it
    // has already been told the turn is over, and `isBusy` reports the session
    // as occupied until the turn really ends.
    if (!turn.turnId) return;
    // Retired here, not only in the generator's `finally`: a caller that has
    // walked away never resumes the generator, so that `finally` never runs,
    // and the session then refused every later turn as concurrent while
    // reporting itself ready.
    //
    // Retiring before the child acknowledges the INTERRUPT is deliberate:
    // waiting for that would let an unresponsive child — the case interrupts
    // exist for — refuse every later turn for a whole request budget. What has
    // to hold instead is ORDER, and it does because nothing awaits between the
    // retirement above and the write below: the child is told to stop before it
    // can be asked for anything else. Do not put an `await` in between.
    this.retire(turn);
    // Written, not awaited: the session is free at the write, and the endpoint
    // answers then — an acknowledgement the child never sent held it for the
    // whole RPC budget (t1-r3-codex). The request's own failure is caught.
    void this.sendTurnInterrupt(turn);
  }

  /**
   * Replaces the child, thread and all: the one that stopped answering may
   * still be working, and a turn on the new thread cannot land on it. One
   * replacement at a time; the next turn waits for it.
   */
  private async replaceChild(): Promise<void> {
    if (this.restarting) return this.restarting;
    // The replacement rejects with its start's failure: that is the awaiting
    // turn's error (t1 B-child gap 3). A trigger that does not wait catches it
    // — a rejection nobody awaits is the whole proxy's (r53-fable: a
    // credentials directory that could not be removed escaped as one).
    const restart = (async () => {
      // The previous child has EXITED before its successor is spawned — the
      // teardown awaits that, and removes the credentials copy only after it —
      // so the session owns one child at any instant (t1 B-child gap 6).
      await this.teardownChild(new Error('codex app-server replaced'));
      this.bufferedNotifications = [];
      this.stderr = '';
      // A session closed while its child was being replaced gets no new child:
      // one started here outlived the close, with a credentials directory of
      // its own, and nothing would ever kill it (r53-fable).
      if (this.closed) return;
      const living = this.livingSurvivors();
      if (living.length > 0) {
        throw new Error(`codex app-server child ${living.map((child) => child.pid).join(', ')} did not exit; no replacement is started while it lives`);
      }
      await this.start();
    })();
    this.restarting = restart;
    try {
      await restart;
    } finally {
      if (this.restarting === restart) this.restarting = null;
    }
  }

  /** The one place a turn stops being the session's. */
  private retire(turn: Turn): void {
    if (this.turn === turn) this.turn = null;
    turn.markRetired();
    const cleanup = turn.cleanup;
    turn.cleanup = null;
    void cleanup?.().catch(() => undefined);
  }

  /**
   * Stops the running turn for both parties: the child is told, and the
   * caller's iteration ends. A turn whose reader is still waiting on
   * `turn/completed` is not stopped by telling the child alone.
   */
  async interrupt(): Promise<void> {
    const turn = this.turn;
    if (!turn) return;
    await this.stopTurn(turn);
  }

  isBusy(): boolean {
    return this.turn !== null;
  }

  /** The one place a turn is interrupted on the child. */
  private async sendTurnInterrupt(turn: Turn): Promise<void> {
    if (!turn.turnId || turn.interrupted) return;
    turn.interrupted = true;
    await this.send('turn/interrupt', { threadId: this.threadId, turnId: turn.turnId })
      .catch(() => undefined);
  }

  async close(): Promise<void> {
    this.closed = true;
    const restarting = this.restarting;
    if (restarting) {
      // A replacement in flight is not waited out: the child it is starting,
      // if any, goes now — the handshake it was in rejects, the replacement
      // settles without starting anything more — and only that cleanup is
      // awaited (r55-codex: a close waited the replacement's whole RPC budget).
      // Captured before the await: the replacement may settle under it and
      // clear the field.
      await this.teardownChild(new Error('codex native chat session closed'));
      await restarting.catch(() => undefined);
    }
    if (this.turn) {
      // Stopped, then failed — not closed: a closed queue reads as a turn that
      // FINISHED, and the caller was streaming an answer that will now never
      // come; and stopped, so a turn still waiting on its input never writes to
      // a child being archived (r55-codex).
      this.turn.stopped = true;
      this.turn.markStopped();
      this.turn.queue.fail(new Error('local CLI chat session closed'));
      this.retire(this.turn);
    }
    if (this.threadId && this.child) {
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
    await this.teardownChild(new Error('codex native chat session closed'));
    // Every isolation directory this session made goes here — one a start left
    // with no child, and any a teardown could not remove. One that still will
    // not go is the close's error, thrown after everything else is torn down:
    // the session is closed either way, and the operator hears what remains
    // (r54-fable: a rejection before the teardown kept the session listed
    // `ready` over a dead child; r54-codex: a success over a copied credential
    // left on disk) — a child still there after `SIGKILL` with it.
    const directories = [...this.isolationDebt, ...(this.isolation ? [this.isolation.rootDir] : [])];
    this.isolation = null;
    const remaining: string[] = [];
    for (const directory of directories) {
      try {
        const { rm } = await import('node:fs/promises');
        await rm(directory, { recursive: true, force: true });
      } catch {
        remaining.push(directory);
      }
    }
    this.isolationDebt = remaining;
    const living = this.livingSurvivors();
    const remains = [
      ...(remaining.length > 0 ? [`its credentials copy could not be removed: ${remaining.join(', ')}`] : []),
      ...(living.length > 0 ? [`a child survived SIGKILL: ${living.map((child) => child.pid).join(', ')}`] : []),
    ];
    if (remains.length > 0) {
      throw new Error(`codex native chat session closed, but ${remains.join('; ')}`);
    }
  }

  /**
   * Ends the child and every request waiting on it, and returns once the child
   * has exited — `SIGTERM`, a grace, `SIGKILL` the same handle, a grace — and
   * its credentials copy is removed, in that order (t1 B-child gap 6: the
   * handle was forgotten at the `SIGTERM`, so a child that ignored it outlived
   * a close reported as success, and the copy was removed while it still ran).
   * The session's fields — the child, its thread — are cleared before the
   * first await: nothing addresses the old child or names its thread after
   * this line, and the snapshot stops naming a thread that no longer exists
   * (gap 3). Safe with no child; one continuation per handle, since the handle
   * is captured here and nowhere else.
   */
  private async teardownChild(reason: Error): Promise<void> {
    const child = this.forgetChild(reason);
    const isolation = this.isolation;
    this.isolation = null;
    if (child) {
      const exit = await terminateChild(child);
      if (!exit.exited) this.survivors.push(child);
    }
    if (isolation) {
      try {
        const { rm } = await import('node:fs/promises');
        await rm(isolation.rootDir, { recursive: true, force: true });
      } catch {
        // A directory that will not go stops nothing here; it is the close's
        // to remove, or to report (r54-codex: consumed and forgotten, it
        // outlived a close that reported success).
        this.isolationDebt.push(isolation.rootDir);
      }
    }
  }

  /**
   * The teardown's synchronous part: the child and its thread stop being the
   * session's, and every request waiting on the child is failed. The child's
   * own exit runs only this — its credentials copy stays for the next
   * teardown, whose caller awaits it: a removal started here and awaited by
   * nobody failed after a close had already reported success (t1-r3-codex).
   */
  private forgetChild(reason: Error): ChildProcessWithoutNullStreams | null {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.pending.clear();
    this.lineReader?.close();
    this.lineReader = null;
    const child = this.child;
    this.child = null;
    this.threadId = '';
    delete this.native.thread_id;
    return child;
  }

  /** The children that outlived their `SIGKILL` and are still there — by their own handles, not by pid. */
  private livingSurvivors(): ChildProcessWithoutNullStreams[] {
    this.survivors = this.survivors.filter((child) => child.exitCode === null && child.signalCode === null);
    return this.survivors;
  }

  private async start(): Promise<void> {
    this.isolation = await createCodexIsolation({
      configuredModel: this.model,
      reasoningEffort: this.reasoningEffort,
      verbosity: this.verbosity,
      imageGeneration: this.imageGeneration,
    });
    // A close that landed while the credentials were being copied found
    // nothing to tear down and then waited out the successor's whole handshake
    // (t1-r3-codex): checked again here, with the copy just made removed.
    if (this.closed) {
      const closed = new Error('codex native chat session closed');
      await this.teardownChild(closed);
      throw closed;
    }
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

    // Every handler checks it still belongs to the session's child: a replaced
    // child's exit must not fail the turn on its successor, or null it.
    const child = this.child;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      if (this.child === child) this.stderr = `${this.stderr}${chunk}`.slice(-12_000);
    });
    child.on('error', (err) => {
      if (this.child === child) this.failActive(err);
    });
    // An `error` event with no listener is an uncaught exception: one racing
    // write to a child that has just died would take the whole proxy down
    // rather than the turn. The sibling claude session guards the same pipe.
    // A pipe that dies reports it here when the write returned cleanly and the
    // failure arrived a tick later — the shape `send()`'s synchronous catch
    // cannot see. A child that cannot be written to cannot be told anything: it
    // is replaced, thread and all, the same as one whose write threw, so
    // nothing starts ahead of an interrupt it never received (t1-r5-codex F2).
    child.stdin.on('error', (err) => {
      if (this.child !== child) return;
      this.failActive(err);
      if (!this.closed) void this.replaceChild().catch(() => undefined);
    });
    child.on('close', (code, signal) => {
      if (this.child !== child) return;
      const exit = new Error(`codex app-server exited: code=${code ?? 'null'} signal=${signal ?? 'null'}`);
      this.failActive(exit);
      // Gone on its own: forgotten, thread and all, and the next turn starts a
      // child for itself (t1 B-child gap 3). Its credentials copy is the next
      // teardown's — a close's or a replacement's — which its caller awaits.
      this.forgetChild(exit);
    });
    this.lineReader = readline.createInterface({ input: child.stdout });
    this.lineReader.on('line', (line) => this.handleLine(line));

    try {
      await this.handshake();
    } catch (err) {
      // A handshake that fails leaves no child: one left behind, with the old
      // thread's id still on the session, accepted the next turn (r55-codex).
      await this.teardownChild(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  }

  private async handshake(): Promise<void> {
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
    try {
      this.child.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
    } catch (err) {
      // A pipe that died under the write throws from here, and this function
      // returns a promise: a synchronous throw escapes the caller's `.catch`
      // and — on the interrupt path, where the child is likeliest to be dying —
      // took the whole endpoint with it. A child that cannot be written to
      // cannot be told anything: it is replaced, thread and all, the way one
      // that stopped answering is (r52) — an interrupt whose write failed was
      // reported delivered while the next turn reached the same child ahead
      // of it (t1-r4-codex).
      if (!this.closed) void this.replaceChild().catch(() => undefined);
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexRpcTimeoutError(method, this.timeoutMs));
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
    const turn = this.turn;
    // Nothing is running, so this belongs to a turn that is over. Holding it
    // would deliver an interrupted turn's tail — its usage above all — to
    // whoever asked next, as that turn's own.
    if (!turn) return;
    // Still being named: what arrives now belongs to the turn being started,
    // and nothing else can be running, so hold it until there is an id to
    // route by.
    if (!turn.turnId) {
      this.bufferedNotifications.push(event);
      this.bufferedNotifications = this.bufferedNotifications.slice(-100);
      return;
    }
    if (turnId && turnId !== turn.turnId) return;
    turn.queue.push(event);
    if (method === 'turn/completed') turn.queue.close();
  }

  private flushBufferedNotifications(turn: Turn): void {
    const buffered = this.bufferedNotifications;
    this.bufferedNotifications = [];
    for (const event of buffered) {
      const params = asRecord(asRecord(event.raw)?.params);
      const eventTurnId = typeof params?.turnId === 'string' ? params.turnId : undefined;
      if (eventTurnId && eventTurnId !== turn.turnId) continue;
      turn.queue.push(event);
      if (asRecord(event.raw)?.method === 'turn/completed') turn.queue.close();
    }
  }

  private failActive(err: Error): void {
    const detail = this.stderr ? `\n${this.stderr.slice(-2000)}` : '';
    if (!this.turn) return;
    this.turn.queue.fail(new Error(`${err.message}${detail}`));
    this.retire(this.turn);
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
