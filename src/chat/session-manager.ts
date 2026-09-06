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

/**
 * What the manager owns for one turn, from the moment it is admitted to the
 * moment its caller's iteration ends — whether or not the generator that
 * delivers the turn's events was ever entered. It used to be two records
 * (`running` and a `currentTurn` installed at admission) released only by a
 * generator's `finally`, which never runs for a reader that cancels before its
 * first read: the slot stayed taken for the session's life (r56-codex).
 *
 * States: `admitted` (slot taken, runtime not asked, nobody has read),
 * `streaming` (the first read entered the generator), and the two terminal
 * ones — `stopped` (a stop ended the turn for its caller; one `cli.error`
 * carrying the reason is owed to a reader) and `released` (ended without a
 * stop: completed, failed runtime-side, or the reader returned). A terminal
 * transition runs once, clears the deadline, and detaches from the session
 * iff the session still holds this reservation.
 */
interface TurnReservation {
  readonly turnId: string;
  readonly abort: AbortController;
  readonly idleTimeoutMs: number | undefined;
  state: 'admitted' | 'streaming' | 'stopped' | 'released';
  /** The stop's reason — what the reader is owed as its one `cli.error`. */
  reason: string | null;
  /** Settles when a stop ends the turn: a read parked in the runtime ends there. */
  readonly stopped$: Promise<void>;
  markStopped: () => void;
  deadline: NodeJS.Timeout | undefined;
  /**
   * Closes the runtime's iteration, once, from wherever the turn ends: a stop
   * that lands between two reads left the runtime's generator suspended at its
   * `yield` for good, and a runtime that retires only in its `finally` then
   * held the session for its life (t1-r1-codex). Installed by the iterator
   * that owns the generator; a read still pending in the runtime is finalized
   * behind its own settlement.
   */
  closeInner: (() => Promise<void>) | null;
}

/** The manager's answer for every turn it stops itself, on both runtimes. */
const TURN_ABORTED = 'local CLI chat turn aborted';
/** The runtimes' own in-band answer when a close ends a running turn, reused for one not yet entered. */
const SESSION_CLOSED = 'local CLI chat session closed';

interface ManagedSession {
  readonly id: string;
  readonly runtime: LocalCliChatRuntime;
  readonly createdAt: number;
  readonly cwd: string;
  readonly model?: string;
  readonly title?: string;
  readonly nativeSession: LocalCliChatRuntimeSession;
  closed: boolean;
  lastTurnId?: string;
  reservation?: TurnReservation;
}

/**
 * Occupancy is two single-owner values, projected: the manager's reservation
 * (admission → the caller's iteration ends) and the runtime's `isBusy`
 * (dispatch → the child-side retirement). Neither restates the other — the
 * manager's own bookkeeping used to be a second, parallel lifetime, and the
 * two disagreed. The disjunction is what lets a stop free the caller before
 * the child has acknowledged the turn without freeing the SESSION: codex keeps
 * its turn until the acknowledgement, retiring it immediately before it writes
 * the interrupt, so admission answers 409 for that whole window (r56-codex).
 */
function sessionStatus(session: ManagedSession): LocalCliChatSessionStatus {
  if (session.closed) return 'closed';
  const busy = session.reservation !== undefined || session.nativeSession.isBusy();
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
    // The turn found is stopped before the teardown is awaited: a reader that
    // arrives after the close hears the close — on both runtimes — and the
    // runtime is never asked to start it (r56: claude answered "not running",
    // the wrong fact, for the same sequence codex answered "closed").
    if (session.reservation) this.stop(session, session.reservation, SESSION_CLOSED);
    await session.nativeSession.close();
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
      session.closed = true;
      if (session.reservation) this.stop(session, session.reservation, SESSION_CLOSED);
      await session.nativeSession.close();
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
    // The reservation is stopped BEFORE the runtime is asked — synchronously,
    // so nothing can be dispatched in between: a turn admitted but not yet read
    // had no runtime turn to stop, the endpoint answered `ready`, and the turn
    // ran on the next read (r56-codex). Stopped, the reservation owes its
    // reader one `cli.error` and holds the session no longer; whether the
    // session is free is then the runtime's answer — a turn the child has not
    // named yet keeps it busy until it can be told to stop. And the stop is
    // recorded even when the runtime's own stop throws: the rejection is the
    // caller's, not a session wedged at `running`.
    const reservation = session.reservation;
    if (reservation) this.stop(session, reservation, TURN_ABORTED);
    if (session.nativeSession.interrupt) await session.nativeSession.interrupt();
    else reservation?.abort.abort();
    return snapshot(session);
  }

  /** The one place a stop ends a turn for its caller. Runs once; safe on a turn already over. */
  private stop(session: ManagedSession, reservation: TurnReservation, reason: string): void {
    if (reservation.state === 'stopped' || reservation.state === 'released') return;
    reservation.state = 'stopped';
    reservation.reason = reason;
    this.end(session, reservation);
    reservation.markStopped();
    void reservation.closeInner?.();
  }

  /** The one place a turn ends without a stop: completed, failed runtime-side, or the reader returned. */
  private release(session: ManagedSession, reservation: TurnReservation): void {
    if (reservation.state === 'stopped' || reservation.state === 'released') return;
    reservation.state = 'released';
    this.end(session, reservation);
  }

  /**
   * The terminal transition's effects: the deadline dies with the turn, and
   * only the turn that still owns the session releases it — an abandoned
   * stream finalizes late, after its turn was stopped and the next one
   * started, and releasing there handed the running turn's slot to whoever
   * asked next.
   */
  private end(session: ManagedSession, reservation: TurnReservation): void {
    if (reservation.deadline) clearTimeout(reservation.deadline);
    reservation.deadline = undefined;
    if (session.reservation === reservation) session.reservation = undefined;
  }

  /**
   * The idle deadline bounds SILENCE, not duration: a native turn is an agentic
   * CLI session that legitimately runs for many minutes while streaming, and a
   * total cap would cut a turn that is working. Re-armed on every delivered
   * event, so what it ends is a turn that has stopped producing. Firing, it
   * is a stop like any other — the caller is answered at once, and the signal
   * reaches the runtime as it always did — where it used to only fire the
   * signal, which a reservation nobody had read could not observe (r56-codex).
   */
  private armDeadline(session: ManagedSession, reservation: TurnReservation): void {
    if (reservation.idleTimeoutMs === undefined) return;
    if (reservation.deadline) clearTimeout(reservation.deadline);
    reservation.deadline = setTimeout(() => {
      this.stop(session, reservation, TURN_ABORTED);
      reservation.abort.abort();
    }, reservation.idleTimeoutMs);
  }

  /**
   * Admits the turn NOW — the 404/409/410 are thrown from this call, before
   * the caller has committed anything (r55-codex: a lazy generator ran its
   * admission only at the first read, after the HTTP writer had committed 200
   * SSE headers, so a known 404 went out as a 200 with a generic error) — and
   * returns the turn's events. The reservation made here is released by the
   * iteration's end, by a reader that returns before it ever read, by the idle
   * deadline, or by a stop — not only by a generator's `finally`.
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
    let markStopped = (): void => {};
    const stopped$ = new Promise<void>((resolve) => { markStopped = resolve; });
    // The caller's deadline reaches the runtime through the turn's own signal —
    // the same mechanism `interrupt` uses. Without it a child that stopped
    // answering held the HTTP request open with no end, and left the session
    // `running`, so every later turn was refused with 409.
    const reservation: TurnReservation = {
      turnId,
      abort: new AbortController(),
      idleTimeoutMs: options.timeoutMs !== undefined && options.timeoutMs > 0 ? options.timeoutMs : undefined,
      state: 'admitted',
      reason: null,
      stopped$,
      markStopped,
      deadline: undefined,
      closeInner: null,
    };
    session.reservation = reservation;
    this.armDeadline(session, reservation);
    return this.turnEvents(session, reservation, input);
  }

  /**
   * The turn's events, as an iterator whose `return()` and `next()` are real
   * code from the moment of admission. An async generator's `finally` does
   * not run for a `return()` before its first `next()`, and a stop that lands
   * while a read is parked inside the runtime — codex's `turn/start` RPC —
   * cannot settle that read by failing a queue nobody is reading yet, so the
   * caller waited out the child's acknowledgement (r56-codex). Every read
   * races the runtime against the reservation's stop; a stopped reservation
   * answers with its reason, once. The runtime's iteration is closed by the
   * stop itself — behind a read still pending in the runtime, whose
   * settlement then runs the generator's own `catch` and `finally` (a
   * replacement on timeout, the retirement on acknowledgement) and reaches no
   * caller; at once when the stop lands between reads, so a reader that never
   * reads again still leaves a retired runtime turn behind (t1-r1-codex).
   */
  private turnEvents(
    session: ManagedSession,
    reservation: TurnReservation,
    input: LocalCliChatTurnInput,
  ): AsyncIterable<LocalCliChatEvent> {
    const inner = this.runtimeEvents(session, reservation, input);
    // Read through a call: the state moves under an `await`, past what a
    // narrowing on the field would admit.
    const stopped = (): boolean => reservation.state === 'stopped';
    const done: IteratorResult<LocalCliChatEvent> = { done: true, value: undefined };
    let finished = false;
    let owed = true;
    const stopEvent = (): IteratorResult<LocalCliChatEvent> => {
      if (!owed) {
        finished = true;
        return done;
      }
      owed = false;
      return {
        done: false,
        value: {
          event: 'cli.error',
          session_id: session.id,
          turn_id: reservation.turnId,
          runtime: session.runtime,
          raw: { message: reservation.reason ?? TURN_ABORTED },
        },
      };
    };
    // The read in flight, if any: a stop that lands while it is parked in the
    // runtime finalizes the generator behind its settlement; one that lands
    // between reads finalizes it now. One handler, attached once: the
    // generator's own `catch` turns every runtime error into an event, so the
    // read settles, and nothing is left for the process to report.
    let pending: Promise<IteratorResult<LocalCliChatEvent>> | null = null;
    let closing: Promise<void> | null = null;
    const closeInner = (): Promise<void> => {
      if (closing) return closing;
      const settled = pending ?? Promise.resolve();
      closing = settled
        .then(() => inner.return(undefined), () => inner.return(undefined))
        .then(() => undefined, () => undefined);
      return closing;
    };
    reservation.closeInner = closeInner;
    let chain: Promise<unknown> = Promise.resolve();
    const serialized = <T>(step: () => Promise<T>): Promise<T> => {
      const result = chain.then(step, step);
      chain = result.catch(() => undefined);
      return result;
    };
    const iterator: AsyncIterableIterator<LocalCliChatEvent> = {
      [Symbol.asyncIterator]() {
        return iterator;
      },
      next: () => serialized(async () => {
        if (finished) return done;
        if (reservation.state === 'stopped') return stopEvent();
        if (reservation.state === 'released') {
          finished = true;
          return done;
        }
        reservation.state = 'streaming';
        const read = inner.next();
        pending = read;
        const outcome = await Promise.race([
          read.then((result): { result: IteratorResult<LocalCliChatEvent> | null } => ({ result })),
          reservation.stopped$.then((): { result: IteratorResult<LocalCliChatEvent> | null } => ({ result: null })),
        ]);
        if (outcome.result !== null) pending = null;
        if (outcome.result === null || stopped()) return stopEvent();
        if (outcome.result.done) {
          finished = true;
          return done;
        }
        const event = outcome.result.value;
        if (event.event === 'cli.completed' || event.event === 'cli.error') {
          // The terminal event IS the end: the slot goes with it, not with the
          // read after it — a stop landing between the two (an interrupt
          // racing the terminal SSE write) found the reservation still attached
          // and appended a second terminal event (t1-r1-codex). The read after
          // it is done through the released state; the generator, parked at
          // its last yield with the runtime's turn already over, holds nothing.
          this.release(session, reservation);
          return outcome.result;
        }
        this.armDeadline(session, reservation);
        return outcome.result;
      }),
      return: () => serialized(async () => {
        if (finished) return done;
        finished = true;
        if (reservation.state === 'admitted') {
          // Never entered: nothing to finalize, and the slot goes now.
          this.release(session, reservation);
          return done;
        }
        if (reservation.state === 'streaming') await closeInner();
        return done;
      }),
    };
    return iterator;
  }

  private async *runtimeEvents(
    session: ManagedSession,
    reservation: TurnReservation,
    input: LocalCliChatTurnInput,
  ): AsyncGenerator<LocalCliChatEvent, void, undefined> {
    try {
      for await (const runtimeEvent of session.nativeSession.startTurn(input, reservation.abort.signal)) {
        yield {
          event: 'cli.event',
          session_id: session.id,
          turn_id: reservation.turnId,
          runtime: session.runtime,
          raw: runtimeEvent.raw,
          ...(runtimeEvent.textDelta !== undefined ? { text_delta: runtimeEvent.textDelta } : {}),
          ...(runtimeEvent.usage !== undefined ? { usage: runtimeEvent.usage } : {}),
        };
      }
      yield {
        event: 'cli.completed',
        session_id: session.id,
        turn_id: reservation.turnId,
        runtime: session.runtime,
        raw: { status: 'completed' },
      };
    } catch (err) {
      yield {
        event: 'cli.error',
        session_id: session.id,
        turn_id: reservation.turnId,
        runtime: session.runtime,
        raw: {
          message: err instanceof Error ? err.message : String(err),
        },
      };
    } finally {
      this.release(session, reservation);
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
