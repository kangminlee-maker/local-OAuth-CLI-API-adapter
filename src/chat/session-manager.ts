import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type {
  LocalCliChatCreateInput,
  LocalCliChatEvent,
  LocalCliChatRuntime,
  LocalCliChatRuntimeFactory,
  LocalCliChatRuntimeSession,
  LocalCliChatSessionSnapshot,
  LocalCliChatSessionStatus,
  LocalCliChatTurnInput,
  LocalCliChatTurnResult,
} from './types.js';
import { LocalCliChatError } from './types.js';

export interface LocalCliChatSessionManagerOptions {
  readonly defaultCwd: string;
  readonly runtimes: Partial<Record<LocalCliChatRuntime, LocalCliChatRuntimeFactory>>;
}

export interface LocalCliChatTurnOptions {
  /**
   * How long the caller will wait for the turn. The surface that accepted the
   * request owns this number — the session outlives the socket, but a turn that
   * produces nothing must not outlive the request that asked for it.
   */
  readonly timeoutMs?: number;
}

/** What the manager owns for one turn: the caller's deadline and its signal. */
interface ManagedTurn {
  readonly abort: AbortController;
  /** Cancels this turn's idle deadline, wherever the turn ends. */
  readonly stopDeadline: () => void;
}

interface ManagedSession {
  readonly id: string;
  readonly runtime: LocalCliChatRuntime;
  readonly createdAt: number;
  readonly cwd: string;
  readonly model?: string;
  readonly title?: string;
  readonly nativeSession: LocalCliChatRuntimeSession;
  closed: boolean;
  /**
   * Whether a turn is running, for a runtime that cannot say. A runtime that
   * can is asked instead — see `sessionStatus`.
   */
  running: boolean;
  lastTurnId?: string;
  currentTurn?: ManagedTurn;
}

/**
 * One answer about occupancy, from whoever knows. A runtime that reports it
 * IS the authority: the manager's own bookkeeping used to be a second, parallel
 * lifetime, and the two disagreed — a session answered `ready` while its
 * runtime refused every turn as concurrent, and the reverse.
 */
function sessionStatus(session: ManagedSession): LocalCliChatSessionStatus {
  if (session.closed) return 'closed';
  const busy = session.nativeSession.isBusy?.() ?? session.running;
  return busy ? 'running' : 'ready';
}

export class LocalCliChatSessionManager {
  private readonly defaultCwd: string;
  private readonly runtimes: Partial<Record<LocalCliChatRuntime, LocalCliChatRuntimeFactory>>;
  private readonly sessions = new Map<string, ManagedSession>();

  constructor(options: LocalCliChatSessionManagerOptions) {
    this.defaultCwd = options.defaultCwd;
    this.runtimes = options.runtimes;
  }

  async create(input: LocalCliChatCreateInput): Promise<LocalCliChatSessionSnapshot> {
    const runtime = parseRuntime(input.runtime);
    if (input.mode !== undefined && input.mode !== 'native') {
      throw new LocalCliChatError('local CLI chat sessions only support mode "native".');
    }
    const factory = this.runtimes[runtime];
    if (!factory) {
      throw new LocalCliChatError(`Runtime is not enabled for local CLI chat sessions: ${runtime}`, 400, 'runtime_not_enabled');
    }
    const cwd = resolve(input.cwd ?? this.defaultCwd);
    const nativeSession = await factory({ ...input, runtime, cwd });
    const session: ManagedSession = {
      id: `sess_${randomUUID()}`,
      runtime,
      createdAt: Math.floor(Date.now() / 1000),
      cwd,
      model: input.model,
      title: input.title,
      nativeSession,
      closed: false,
      running: false,
    };
    this.sessions.set(session.id, session);
    return snapshot(session);
  }

  get(id: string): LocalCliChatSessionSnapshot {
    return snapshot(this.requireSession(id));
  }

  async close(id: string): Promise<LocalCliChatSessionSnapshot> {
    const session = this.requireSession(id);
    // Closed first — gone from the map before the runtime's teardown is
    // awaited, so no turn is admitted during the archive's grace (r54-codex:
    // one was, and completed, while the DELETE waited) — then aborted. A
    // runtime whose stop is a child REPLACEMENT spawned one on the way out — a
    // whole CLI launch, killed microseconds later by the close that followed.
    // Closing ends the turn; the abort is what is left for a runtime that
    // needs the signal. A teardown that fails after that is the caller's
    // error, not a session kept listed (r54-fable).
    session.closed = true;
    this.sessions.delete(id);
    try {
      await session.nativeSession.close();
    } finally {
      this.endTurn(session);
    }
    return snapshot(session);
  }

  async closeAll(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    // Every session is torn down and its bookkeeping finished before any
    // teardown's error is raised — and one IS raised: a close that leaves a
    // credentials copy on disk says so to the server's own close, which used
    // to hear a clean shutdown over it (r55-codex).
    const outcomes = await Promise.allSettled(sessions.map(async (session) => {
      try {
        await session.nativeSession.close();
      } finally {
        this.endTurn(session);
        session.closed = true;
      }
    }));
    const failures = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
    if (failures.length === 1) throw failures[0].reason;
    if (failures.length > 1) {
      throw new Error(failures.map((failure) => (failure.reason instanceof Error ? failure.reason.message : String(failure.reason))).join('; '));
    }
  }

  async interrupt(id: string): Promise<LocalCliChatSessionSnapshot> {
    const session = this.requireSession(id);
    // The runtime session owns stopping its turn: it tells the child AND ends
    // the caller's iteration, and it is the only thing that knows what
    // stopping means for that CLI. Every route ends there — this endpoint asks
    // it directly, the idle deadline asks through the turn's abort signal, and
    // the session's own handler for that signal runs the same stop. Asking
    // both ways at once is what told the child twice. A runtime that
    // implements no interrupt is stopped through the signal alone.
    // The turn's deadline goes with the turn. An abandoned stream's `finally` —
    // the only other place it was cleared — never runs, so the deadline
    // outlived the turn it belonged to and later aborted a signal whose turn
    // was long over, stopping whoever was running by then.
    const turn = this.endTurn(session);
    try {
      if (session.nativeSession.interrupt) await session.nativeSession.interrupt();
      else turn?.abort.abort();
    } finally {
      // Even when the runtime's stop threw. Whether the session is free again
      // is the runtime's answer, not this bookkeeping — a turn the child has
      // not named yet keeps it busy until it can be told to stop.
      session.running = false;
    }
    return snapshot(session);
  }

  /** Ends the manager's side of the current turn: its deadline and its record. */
  private endTurn(session: ManagedSession): ManagedTurn | undefined {
    const turn = session.currentTurn;
    turn?.stopDeadline();
    session.currentTurn = undefined;
    return turn;
  }

  /**
   * Admits the turn NOW — the 404/409/410 are thrown from this call, before
   * the caller has committed anything — and returns the turn's events, which
   * the caller must consume: the reservation made here is released by the
   * iteration's end (r55-codex: a lazy generator ran its admission only at
   * the first read, after the HTTP writer had committed 200 SSE headers, so a
   * known 404 went out as a 200 with a generic error).
   */
  streamTurn(
    sessionId: string,
    input: LocalCliChatTurnInput,
    options: LocalCliChatTurnOptions = {},
  ): AsyncIterable<LocalCliChatEvent> {
    const session = this.requireSession(sessionId);
    const status = sessionStatus(session);
    if (status === 'closed') {
      throw new LocalCliChatError('Session is closed.', 410, 'session_closed');
    }
    if (status === 'running') {
      throw new LocalCliChatError('Session already has a running turn.', 409, 'turn_already_running');
    }
    const turnId = `turn_${randomUUID()}`;
    session.lastTurnId = turnId;
    session.running = true;
    const abort = new AbortController();
    // The caller's deadline reaches the runtime through the turn's own signal —
    // the same mechanism `interrupt` uses. Without it a child that stopped
    // answering held the HTTP request open with no end, and left the session
    // `running`, so every later turn was refused with 409.
    //
    // It bounds SILENCE, not duration: a native turn is an agentic CLI session
    // that legitimately runs for many minutes while streaming, and a total cap
    // would cut a turn that is working. Every event restarts the clock, so what
    // the deadline ends is a turn that has stopped producing.
    const idleTimeoutMs = options.timeoutMs !== undefined && options.timeoutMs > 0
      ? options.timeoutMs
      : undefined;
    let deadline: NodeJS.Timeout | undefined;
    const stopDeadline = (): void => {
      if (deadline) clearTimeout(deadline);
      deadline = undefined;
    };
    const turn: ManagedTurn = { abort, stopDeadline };
    session.currentTurn = turn;
    const armDeadline = (): void => {
      if (idleTimeoutMs === undefined) return;
      stopDeadline();
      deadline = setTimeout(() => abort.abort(), idleTimeoutMs);
    };
    armDeadline();
    return this.turnEvents(session, turn, turnId, input, abort, armDeadline, stopDeadline);
  }

  private async *turnEvents(
    session: ManagedSession,
    turn: ManagedTurn,
    turnId: string,
    input: LocalCliChatTurnInput,
    abort: AbortController,
    armDeadline: () => void,
    stopDeadline: () => void,
  ): AsyncIterable<LocalCliChatEvent> {
    try {
      for await (const runtimeEvent of session.nativeSession.startTurn(input, abort.signal)) {
        armDeadline();
        yield {
          event: 'cli.event',
          session_id: session.id,
          turn_id: turnId,
          runtime: session.runtime,
          raw: runtimeEvent.raw,
          ...(runtimeEvent.textDelta !== undefined ? { text_delta: runtimeEvent.textDelta } : {}),
          ...(runtimeEvent.usage !== undefined ? { usage: runtimeEvent.usage } : {}),
        };
      }
      yield {
        event: 'cli.completed',
        session_id: session.id,
        turn_id: turnId,
        runtime: session.runtime,
        raw: { status: 'completed' },
      };
    } catch (err) {
      yield {
        event: 'cli.error',
        session_id: session.id,
        turn_id: turnId,
        runtime: session.runtime,
        raw: {
          message: err instanceof Error ? err.message : String(err),
        },
      };
    } finally {
      stopDeadline();
      // Only the turn that still owns the session may release it. An
      // interrupted stream nobody is reading finalizes late — after its turn
      // was stopped and the next one started — and releasing there handed the
      // running turn's slot to whoever asked next.
      if (session.currentTurn === turn) {
        session.currentTurn = undefined;
        session.running = false;
      }
    }
  }

  async runTurn(
    sessionId: string,
    input: LocalCliChatTurnInput,
    options: LocalCliChatTurnOptions = {},
  ): Promise<LocalCliChatTurnResult> {
    const events: LocalCliChatEvent[] = [];
    let text = '';
    let usage: LocalCliChatEvent['usage'];
    for await (const event of this.streamTurn(sessionId, input, options)) {
      events.push(event);
      if (event.text_delta) text += event.text_delta;
      if (event.usage !== undefined) usage = event.usage;
    }
    const completed = findLastEvent(events, 'cli.completed');
    const error = findLastEvent(events, 'cli.error');
    return {
      id: events[0]?.turn_id ?? `turn_${randomUUID()}`,
      session_id: sessionId,
      status: error ? 'error' : 'completed',
      events,
      final: {
        text,
        raw: completed?.raw ?? error?.raw ?? {},
      },
      ...(usage !== undefined ? { usage } : {}),
    };
  }

  private requireSession(id: string): ManagedSession {
    const session = this.sessions.get(id);
    if (!session) throw new LocalCliChatError(`Unknown local CLI chat session: ${id}`, 404, 'session_not_found');
    return session;
  }
}

function findLastEvent(
  events: readonly LocalCliChatEvent[],
  eventName: LocalCliChatEvent['event'],
): LocalCliChatEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.event === eventName) return events[index];
  }
  return undefined;
}

function parseRuntime(value: unknown): LocalCliChatRuntime {
  if (value === 'codex' || value === 'claude') return value;
  throw new LocalCliChatError('runtime must be one of codex or claude.', 400, 'invalid_runtime');
}

function snapshot(session: ManagedSession): LocalCliChatSessionSnapshot {
  return {
    id: session.id,
    runtime: session.runtime,
    created_at: session.createdAt,
    status: sessionStatus(session),
    cwd: session.cwd,
    ...(session.model ? { model: session.model } : {}),
    ...(session.title ? { title: session.title } : {}),
    ...(session.lastTurnId ? { last_turn_id: session.lastTurnId } : {}),
    native: session.nativeSession.native,
  };
}
