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

interface ManagedSession {
  readonly id: string;
  readonly runtime: LocalCliChatRuntime;
  readonly createdAt: number;
  readonly cwd: string;
  readonly model?: string;
  readonly title?: string;
  readonly nativeSession: LocalCliChatRuntimeSession;
  status: LocalCliChatSessionStatus;
  lastTurnId?: string;
  currentAbort?: AbortController;
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
      status: 'ready',
    };
    this.sessions.set(session.id, session);
    return snapshot(session);
  }

  get(id: string): LocalCliChatSessionSnapshot {
    return snapshot(this.requireSession(id));
  }

  async close(id: string): Promise<LocalCliChatSessionSnapshot> {
    const session = this.requireSession(id);
    session.currentAbort?.abort();
    await session.nativeSession.close();
    session.status = 'closed';
    this.sessions.delete(id);
    return snapshot(session);
  }

  async closeAll(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(sessions.map(async (session) => {
      session.currentAbort?.abort();
      session.status = 'closed';
      await session.nativeSession.close().catch(() => undefined);
    }));
  }

  async interrupt(id: string): Promise<LocalCliChatSessionSnapshot> {
    const session = this.requireSession(id);
    session.currentAbort?.abort();
    await session.nativeSession.interrupt?.();
    session.status = 'ready';
    return snapshot(session);
  }

  async *streamTurn(
    sessionId: string,
    input: LocalCliChatTurnInput,
    options: LocalCliChatTurnOptions = {},
  ): AsyncIterable<LocalCliChatEvent> {
    const session = this.requireSession(sessionId);
    if (session.status === 'closed') {
      throw new LocalCliChatError('Session is closed.', 410, 'session_closed');
    }
    if (session.status === 'running') {
      throw new LocalCliChatError('Session already has a running turn.', 409, 'turn_already_running');
    }
    const turnId = `turn_${randomUUID()}`;
    session.lastTurnId = turnId;
    session.status = 'running';
    const abort = new AbortController();
    session.currentAbort = abort;
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
    const armDeadline = (): void => {
      if (idleTimeoutMs === undefined) return;
      if (deadline) clearTimeout(deadline);
      deadline = setTimeout(() => abort.abort(), idleTimeoutMs);
    };
    armDeadline();
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
      if (deadline) clearTimeout(deadline);
      if (session.currentAbort === abort) session.currentAbort = undefined;
      if (session.status === 'running') session.status = 'ready';
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
    status: session.status,
    cwd: session.cwd,
    ...(session.model ? { model: session.model } : {}),
    ...(session.title ? { title: session.title } : {}),
    ...(session.lastTurnId ? { last_turn_id: session.lastTurnId } : {}),
    native: session.nativeSession.native,
  };
}
