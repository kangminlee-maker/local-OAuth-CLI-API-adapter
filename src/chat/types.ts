import type {
  LocalUsage,
  NormalizedImage,
  NormalizedReasoningEffort,
  NormalizedVerbosity,
} from '../proxy/types.js';

export type LocalCliChatRuntime = 'codex' | 'claude';
export type LocalCliChatSessionStatus = 'ready' | 'running' | 'closed';
export type LocalCliChatEventName = 'cli.event' | 'cli.completed' | 'cli.error';

export interface LocalCliChatCreateInput {
  readonly runtime: LocalCliChatRuntime;
  readonly cwd?: string;
  readonly model?: string;
  readonly title?: string;
  readonly mode?: 'native';
  readonly options?: {
    readonly reasoningEffort?: NormalizedReasoningEffort;
    readonly verbosity?: NormalizedVerbosity;
    readonly imageGeneration?: boolean;
  };
}

export interface LocalCliChatTextInputPart {
  readonly type: 'text';
  readonly text: string;
}

export interface LocalCliChatImageInputPart {
  readonly type: 'image';
  readonly source: NormalizedImage['source'];
  readonly detail?: NormalizedImage['detail'];
}

export type LocalCliChatInputPart =
  | LocalCliChatTextInputPart
  | LocalCliChatImageInputPart;

export interface LocalCliChatTurnInput {
  readonly input: string | readonly LocalCliChatInputPart[];
  readonly stream?: boolean;
  readonly metadata?: Record<string, unknown>;
}

export interface LocalCliChatRuntimeEvent {
  readonly raw: unknown;
  readonly textDelta?: string;
  readonly usage?: LocalUsage | unknown;
  readonly completed?: boolean;
}

export interface LocalCliChatEvent {
  readonly event: LocalCliChatEventName;
  readonly session_id: string;
  readonly turn_id?: string;
  readonly runtime: LocalCliChatRuntime;
  readonly raw: unknown;
  readonly text_delta?: string;
  readonly usage?: LocalUsage | unknown;
}

export interface LocalCliChatTurnResult {
  readonly id: string;
  readonly session_id: string;
  readonly status: 'completed' | 'error';
  readonly events: readonly LocalCliChatEvent[];
  readonly final: {
    readonly text: string;
    readonly raw: unknown;
  };
  readonly usage?: LocalUsage | unknown;
}

export interface LocalCliChatSessionSnapshot {
  readonly id: string;
  readonly runtime: LocalCliChatRuntime;
  readonly created_at: number;
  readonly status: LocalCliChatSessionStatus;
  readonly cwd: string;
  readonly model?: string;
  readonly title?: string;
  readonly last_turn_id?: string;
  readonly native: Record<string, unknown>;
}

export interface LocalCliChatRuntimeSession {
  readonly runtime: LocalCliChatRuntime;
  readonly native: Record<string, unknown>;
  startTurn(
    input: LocalCliChatTurnInput,
    signal?: AbortSignal,
  ): AsyncIterable<LocalCliChatRuntimeEvent>;
  /**
   * Stops the running turn: the child stops working AND the turn's iteration
   * ends. It is the session's only stop — the manager triggers nothing beside
   * it — so a runtime that implements this owns interrupting there. Only a
   * runtime that implements none is stopped through the turn's abort signal.
   */
  interrupt?(): Promise<void>;
  close(): Promise<void>;
}

export interface LocalCliChatRuntimeFactoryInput extends LocalCliChatCreateInput {
  readonly cwd: string;
}

export type LocalCliChatRuntimeFactory = (
  input: LocalCliChatRuntimeFactoryInput,
) => Promise<LocalCliChatRuntimeSession>;

export class LocalCliChatError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
    readonly code: string | null = null,
  ) {
    super(message);
  }
}
