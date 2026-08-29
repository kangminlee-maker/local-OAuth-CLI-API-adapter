import { randomUUID } from 'node:crypto';
import { open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { honorRequestModel } from '../settings.js';
import {
  baseInstructions,
  developerInstructions,
  requestInstructionText,
  usageFor,
} from './backend-contract.js';
import { assertCodexModelSupported, codexModels, sourceCodexHome } from './codex-model-catalog.js';
import {
  image2QualityToGpt55ReasoningEffort,
  image2ViaGpt55PromptFromRequest,
} from './image2-via-gpt55.js';
import { postprocessFlatGraphicImageIfNeeded } from './flat-image-postprocess.js';
import type {
  LocalCliBackend,
  LocalCompletionResult,
  LocalReasoningItem,
  LocalStreamEvent,
  LocalToolCall,
  LocalUsage,
  NormalizedImage,
  NormalizedMessage,
  NormalizedRequest,
  NormalizedReasoningEffort,
  NormalizedToolChoice,
  NormalizedVerbosity,
  OpenAiGeneratedImage,
  OpenAiImageGenerationClient,
  OpenAiImageGenerationRequest,
  OpenAiImageGenerationResult,
  OpenAiImageGenerationStreamEvent,
} from './types.js';
import { ProxyRequestError } from './types.js';
import {
  ASSISTANT_TOOL_CALL_MARKER,
  TOOL_RESULT_MARKER,
  markerIndex,
  splitAtMarkers,
} from './tool-history-markers.js';

const CHATGPT_CODEX_BACKEND_URL = 'https://chatgpt.com/backend-api/codex';
const CODEX_REFRESH_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const DEFAULT_CODEX_BACKEND_MODEL = 'gpt-5.5';
const PRODUCT_SKU = 'codex';
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CHATGPT_AUTH_CLAIM_NAMESPACE = `https://api.${'openai'}.com/auth`;
const ACCESS_TOKEN_REFRESH_WINDOW_MS = 5 * 60 * 1000;
const FALLBACK_REFRESH_INTERVAL_MS = 8 * 24 * 60 * 60 * 1000;
const REFRESH_LOCK_TIMEOUT_MS = 10_000;
const REFRESH_LOCK_STALE_MS = 60_000;
const TRANSIENT_BACKEND_RETRY_DELAYS_MS = [250, 1_000] as const;
const IMAGE_NO_RESULT_RETRY_DELAYS_MS = [500, 1_500] as const;
const NO_IMAGE_RESULT_MESSAGE = 'codex backend image response completed without image_generation_call result';

export interface CodexBackendTransportOptions {
  readonly model?: string;
  readonly timeoutMs: number;
  readonly reasoningEffort?: NormalizedReasoningEffort;
  readonly verbosity?: NormalizedVerbosity;
  readonly codexHome?: string;
  readonly onImageAttempt?: (diagnostic: CodexBackendImageAttemptDiagnostic) => void;
  readonly honorRequestModel?: boolean;
  readonly codexCommand?: string;
  /**
   * The directory the operator selected for this runtime. Used to resolve a
   * path-like `codexCommand`, so the catalogue queries the same executable the
   * turn will run. Not the directory the lookup executes in — that is private.
   */
  readonly cwd?: string;
}

export interface CodexBackendImageAttemptDiagnostic {
  readonly operation: OpenAiImageGenerationRequest['operation'];
  readonly imageIndex: number;
  readonly attempt: number;
  readonly ok: boolean;
  readonly retrying?: boolean;
  readonly latencyMs: number;
  readonly eventTypes: readonly string[];
  readonly outputItemTypes: readonly string[];
  readonly completedOutputTypes: readonly string[];
  readonly imageResultCount: number;
  readonly imageItemAdded: boolean;
  readonly imageGenerating: boolean;
  readonly textDeltaCount: number;
  readonly eventTimeline: readonly CodexBackendImageEventDiagnostic[];
  readonly textSample?: string;
  readonly error?: string;
}

export interface CodexBackendImageEventDiagnostic {
  readonly type: string;
  readonly offsetMs: number;
  readonly itemType?: string;
  readonly itemStatus?: string;
  readonly hasImageResult?: boolean;
}

interface CodexAuthFile {
  readonly auth_mode?: string;
  readonly tokens?: {
    readonly id_token?: string;
    readonly access_token?: string;
    readonly refresh_token?: string;
    readonly account_id?: string;
  };
  readonly last_refresh?: string;
  readonly [key: string]: unknown;
}

interface CodexAuthTokens {
  readonly id_token?: string;
  readonly access_token?: string;
  readonly refresh_token?: string;
  readonly account_id?: string;
  readonly [key: string]: unknown;
}

interface CodexBackendAuth {
  readonly file: CodexAuthFile;
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly accountId: string;
}

interface CodexRefreshResponse {
  readonly id_token?: string;
  readonly access_token?: string;
  readonly refresh_token?: string;
}

interface CodexBackendEvent {
  readonly type?: string;
  readonly delta?: string;
  readonly output_index?: number;
  readonly item_id?: string;
  readonly item?: {
    readonly id?: string;
    readonly type?: string;
    readonly name?: string;
    readonly call_id?: string;
    readonly arguments?: string;
    readonly status?: string;
    readonly revised_prompt?: string;
    readonly result?: string;
  };
  readonly response?: {
    readonly id?: string;
    readonly model?: string;
    readonly usage?: unknown;
    readonly output?: readonly unknown[];
    readonly status?: string;
    readonly error?: { readonly code?: string; readonly message?: string } | null;
    readonly incomplete_details?: { readonly reason?: string } | null;
  };
  readonly error?: { readonly code?: string; readonly message?: string } | string | null;
}

interface ToolState {
  id: string;
  name: string;
  arguments: string;
  started: boolean;
  /** The arguments already sent to the client, so nothing is sent twice. */
  streamed: string;
  /**
   * Whether the backend has actually named this call. Until it has, `id` and
   * `name` are placeholders, and announcing them would tell the client an
   * identity that the completed result then contradicts — the client cannot
   * rename a call it has already been told about.
   */
  identified: boolean;
  /**
   * Whether this state was opened by events carrying no id at all. Such a state
   * holds its output position on nothing but that position, so the call that
   * later names the position owns it — see `toolOrdinal`.
   */
  anonymous: boolean;
  /** Whether the client has been told this call's arguments are complete. */
  argumentsDone: boolean;
}

class CodexBackendStreamState {
  readonly id = `local_${randomUUID()}`;
  responseId?: string;
  model?: string;
  text = '';
  usage?: LocalUsage;
  readonly toolStates = new Map<number, ToolState>();
  // Chat/Responses tool_call `index` is the position in the tool_calls array,
  // not the backend output position: a preceding reasoning item shifts
  // `output_index` (observed on gpt-5.6-terra), and forwarding the raw index
  // desyncs streamed deltas from the completed result's dense positions.
  private readonly toolOrdinals = new Map<string, number>();
  private nextToolOrdinal = 0;
  private failure?: string;
  private settled = false;
  private stopReason?: string;
  private toolCallsBeforeText?: boolean;
  private reasoning?: LocalReasoningItem;

  constructor(
    private readonly request: NormalizedRequest,
    private readonly startedAt: number,
  ) {}

  /**
   * The ordinal for a tool call seen in the STREAM, keyed by item id with the
   * stream's own `output_index` as fallback. Argument deltas arrive once per
   * token, so a known id resolves before anything is allocated.
   */
  private toolOrdinal(outputIndex: number, ...ids: ReadonlyArray<string | undefined>): number {
    const known = this.knownOrdinal(ids);
    if (known !== undefined) return known;
    // An event that names an unfamiliar call is a new call: it must not INHERIT
    // the ordinal an earlier NAMED call bound to this position, or a stream
    // whose events omit `output_index` (`readOutputIndex` reports 0 for those)
    // would merge every call into one. It does still CLAIM the position, so the
    // anonymous argument deltas that follow — the ones carrying only an
    // `output_index` — reach the call that most recently occupied it.
    //
    // An ANONYMOUS holder is the other way round: argument deltas that arrive
    // before the call is named have nothing but the position, so they belong to
    // the call that names it. Splitting them off invented a second call — named
    // `tool`, carrying a fragment of the real call's arguments — that the model
    // never made and the client would have executed.
    const identified = ids.some((id) => typeof id === 'string');
    const positionKey = `#${outputIndex}`;
    const claimed = this.toolOrdinals.get(positionKey);
    let ordinal = identified ? this.adoptableOrdinal(claimed) : claimed;
    if (ordinal === undefined) {
      ordinal = this.nextToolOrdinal;
      this.nextToolOrdinal += 1;
    }
    this.toolOrdinals.set(positionKey, ordinal);
    this.bindOrdinal(ordinal, ids);
    return ordinal;
  }

  /** The ordinal at a position, when nothing named has claimed it yet. */
  private adoptableOrdinal(claimed: number | undefined): number | undefined {
    if (claimed === undefined) return undefined;
    return this.toolStates.get(claimed)?.anonymous ? claimed : undefined;
  }

  private knownOrdinal(ids: ReadonlyArray<string | undefined>): number | undefined {
    for (const id of ids) {
      if (typeof id === 'string') {
        const known = this.toolOrdinals.get(id);
        if (known !== undefined) return known;
      }
    }
    return undefined;
  }

  private bindOrdinal(ordinal: number, ids: ReadonlyArray<string | undefined>): void {
    for (const id of ids) {
      if (typeof id === 'string') this.toolOrdinals.set(id, ordinal);
    }
  }

  /**
   * The ordinal for a tool call seen in the COMPLETED output, which is a
   * different coordinate system: its positions count function calls in an array
   * that also holds reasoning and message items, while the stream's
   * `output_index` counts every item. Feeding an array position into the
   * stream's positional keyspace mints a second ordinal for a call already
   * streamed, so an id-less final item would duplicate its own tool call.
   * Without an id, the dense function-call position is what the stream ordinals
   * already mean.
   */
  private finalOutputOrdinal(position: number, ...ids: ReadonlyArray<string | undefined>): number {
    const known = this.knownOrdinal(ids);
    if (known !== undefined) return known;
    // An item that names an unfamiliar call is a call the stream never
    // announced, and it still belongs to the client: taking a position some
    // other call already holds would replace that call instead of adding this
    // one. An anonymous item has nothing but its position, so there the dense
    // position IS the correlation — `captureFinalOutput` only reaches here for
    // one when the two views agree on how many calls there are.
    const identified = ids.some((id) => typeof id === 'string');
    const ordinal = identified && this.toolStates.has(position) ? this.nextToolOrdinal : position;
    this.bindOrdinal(ordinal, ids);
    if (ordinal >= this.nextToolOrdinal) this.nextToolOrdinal = ordinal + 1;
    return ordinal;
  }

  push(event: CodexBackendEvent): LocalStreamEvent[] {
    const out: LocalStreamEvent[] = [];
    if (event.response?.id) this.responseId = event.response.id;
    if (event.response?.model) this.model = event.response.model;
    if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
      this.text += event.delta;
      out.push({ type: 'text_delta', delta: event.delta });
      return out;
    }
    if (event.type === 'response.output_item.added' && event.item?.type === 'reasoning') {
      // Announced, not reconstructed from the completed output: the two paths
      // through this state machine — streaming and not — both see this event,
      // so reporting it here keeps the stream and the body saying the same
      // thing. A backend that lists a reasoning item ONLY in its completed
      // output is not reported, because the stream could no longer place it.
      // One turn carries one such item, and it LEADS the turn, on both the
      // ChatGPT Codex backend and the direct API (measured 2026-08-26,
      // gpt-5.5). Only that leading item is reported: the completed body
      // places the item by rule and the stream by arrival, so an item opened
      // after the turn has already produced output would have the two surfaces
      // describe the same turn in two different orders.
      if (!this.reasoning && this.text === '' && this.toolStates.size === 0) {
        this.reasoning = typeof event.item.id === 'string' ? { id: event.item.id } : {};
        out.push({
          type: 'reasoning_item',
          ...(typeof event.item.id === 'string' ? { id: event.item.id } : {}),
        });
      }
      return out;
    }
    if (event.type === 'response.output_item.added' && event.item?.type === 'function_call') {
      const index = this.toolOrdinal(readOutputIndex(event), event.item.id, event.item.call_id);
      const id = event.item.call_id ?? event.item.id ?? `call_${index + 1}`;
      const name = event.item.name ?? 'tool';
      const named = event.item.id !== undefined || event.item.call_id !== undefined;
      const state = this.toolStates.get(index) ?? this.newToolState(index, { id, name, anonymous: !named });
      // Same rule the `.done` branch states: never downgrade an announced
      // `call_id` to an item id. A repeat of the item that omits it would
      // otherwise rename a call the client has already reported under.
      if (event.item.call_id !== undefined) state.id = event.item.call_id;
      else if (!state.identified) state.id = id;
      state.name = event.item.name ?? state.name;
      if (named) state.anonymous = false;
      // `call_id` is the identity the client echoes back with the tool result;
      // an item id is not interchangeable with it, so a call is only worth
      // announcing once the backend has supplied one. It is a latch: a repeat of
      // the item that omits the `call_id` cannot un-name a call the client has
      // already been told about, and un-naming it stranded every later delta in
      // the buffer, since only an announced call is ever flushed.
      if (event.item.call_id !== undefined) state.identified = true;
      this.toolStates.set(index, state);
      if (state.identified) out.push(...this.emitPending(index, state));
      return out;
    }
    if (event.type === 'response.function_call_arguments.delta' && typeof event.delta === 'string') {
      const itemId = typeof event.item_id === 'string' ? event.item_id : undefined;
      const index = this.toolOrdinal(readOutputIndex(event), itemId);
      const state = this.toolStates.get(index) ?? this.newToolState(index, {
        id: itemId,
        anonymous: itemId === undefined,
      });
      state.arguments += event.delta;
      this.toolStates.set(index, state);
      // Arguments that arrive before the call is named are held, because
      // announcing a placeholder identity is worse than waiting for the real
      // one. `emitPending` sends them the moment the name arrives.
      if (!state.identified) return out;
      out.push(...this.emitPending(index, state));
      return out;
    }
    if (event.type === 'response.output_item.done' && event.item?.type === 'function_call') {
      const index = this.toolOrdinal(readOutputIndex(event), event.item.id, event.item.call_id);
      const named = event.item.id !== undefined || event.item.call_id !== undefined;
      const state = this.toolStates.get(index) ?? this.newToolState(index, {
        id: event.item.call_id ?? event.item.id,
        name: event.item.name,
        anonymous: !named,
      });
      // Never downgrade an announced call_id to an item id: the client echoes
      // this value back, and the two surfaces would disagree about the call.
      state.id = event.item.call_id ?? state.id;
      state.name = event.item.name ?? state.name;
      if (named) state.anonymous = false;
      if (event.item.call_id !== undefined) state.identified = true;
      if (typeof event.item.arguments === 'string') state.arguments = event.item.arguments;
      this.toolStates.set(index, state);
      if (state.identified) {
        out.push(...this.emitPending(index, state));
        // The backend closing the item is the one point where the proxy can
        // promise a client that this call is finished: the event carries the
        // call's authoritative arguments. `response.completed` is too late —
        // the surfaces have already had to guess where the call ended.
        out.push(...this.emitArgumentsDone(index, state));
      }
      return out;
    }
    if (event.type === 'response.completed') {
      const usage = usageFromResponses(event.response?.usage);
      if (usage) this.usage = usage;
      this.captureFinalOutput(event.response?.output);
      // A completed turn is finished, whatever noise follows or preceded it.
      this.failure = undefined;
      this.settled = true;
    }
    // A truncated turn is a finished turn with a reason, not an error: the
    // output that was generated is returned, the way the provider returns it,
    // and the stop reason says why it stopped. Discarding it made a request
    // that deterministically hits the cap look retryable.
    if (event.type === 'response.incomplete') {
      const usage = usageFromResponses(event.response?.usage);
      if (usage) this.usage = usage;
      this.captureFinalOutput(event.response?.output);
      this.stopReason = event.response?.incomplete_details?.reason === 'content_filter'
        ? 'refusal'
        : 'max_tokens';
      this.settled = true;
    }
    // A turn that failed upstream is not a turn that finished. Without this the
    // deltas already forwarded were served as a complete answer: HTTP 200,
    // `finish_reason: "stop"`, and whatever text arrived before the failure.
    // Recorded only while the turn is unsettled, so a frame arriving after the
    // turn completed cannot discard a finished answer.
    if ((event.type === 'response.failed' || event.type === 'error') && !this.settled) {
      this.failure = terminalFailureMessage(event);
      this.settled = true;
    }
    return out;
  }

  private newToolState(
    index: number,
    seed: { id?: string; name?: string; anonymous?: boolean },
  ): ToolState {
    return {
      id: seed.id ?? `call_${index + 1}`,
      name: seed.name ?? 'tool',
      arguments: '',
      streamed: '',
      started: false,
      identified: false,
      anonymous: seed.anonymous ?? false,
      argumentsDone: false,
    };
  }

  /**
   * Emits what the client has not been told yet: the call's identity the first
   * time, then any arguments buffered while the call was still unnamed. Those
   * held deltas have no other way out — nothing re-sends them — so a call
   * announced after its arguments arrived reached the client as a fragment it
   * could not parse.
   */
  private emitPending(index: number, state: ToolState): LocalStreamEvent[] {
    const out: LocalStreamEvent[] = [];
    if (!state.started) {
      state.started = true;
      // Decided HERE, at the first thing the client is told about a tool, not
      // when the backend opened state for one: arguments held until the call is
      // named arrive before any text, but they are not announced until after
      // whatever narration streamed while they waited. Recording the order at
      // state creation claimed the tool came first on exactly that path — the
      // contradiction between stream and body this whole rule exists to remove.
      if (this.toolCallsBeforeText === undefined) this.toolCallsBeforeText = this.text === '';
      out.push({
        type: 'tool_call_delta',
        index,
        id: state.id,
        name: state.name,
        argumentsDelta: '',
      });
    }
    out.push(...this.emitArgumentExtension(index, state, state.arguments));
    return out;
  }

  /**
   * Sends the part of `value` the client has not been told yet, if any.
   * Whether the stream ended up carrying `value` in full is read from
   * `state.streamed` by the caller that needs to know — `emitArgumentsDone`,
   * which may only promise a value the stream actually holds.
   *
   * Only an extension of what was sent may be sent. A value that CONTRADICTS
   * the streamed prefix is not a continuation of it, and appending the
   * difference would leave the client with two spliced fragments; the completed
   * result carries the authoritative arguments.
   */
  private emitArgumentExtension(index: number, state: ToolState, value: string): LocalStreamEvent[] {
    // A call announced as finished is finished. The surfaces that close on that
    // signal cannot carry anything more for it — a later delta would be written
    // into a stopped block — so a backend that keeps sending is not forwarded,
    // and the completed result keeps the value the client was promised.
    if (state.argumentsDone) return [];
    if (!value.startsWith(state.streamed)) return [];
    if (value === state.streamed) return [];
    const pending = value.slice(state.streamed.length);
    state.streamed = value;
    return [{
      type: 'tool_call_delta',
      index,
      id: state.id,
      name: state.name,
      argumentsDelta: pending,
    }];
  }

  /**
   * Says the call is finished, after sending the value the completed result
   * will report. `toolCalls()` normalizes arguments that are empty or do not
   * parse, so a call announced as finished has to be normalized here too: a
   * no-argument call would otherwise be closed on the wire having streamed
   * nothing while the body said `{}`, and a closed call has no way left to
   * carry the difference.
   */
  private emitArgumentsDone(index: number, state: ToolState): LocalStreamEvent[] {
    if (state.argumentsDone) return [];
    const complete = ensureJsonString(state.arguments);
    const out = this.emitArgumentExtension(index, state, complete);
    // The signal says "what you have is what the body will report", and a
    // surface that closes on it can send nothing afterwards. When the finishing
    // event names no arguments and what was streamed does not normalize to the
    // streamed value, that promise cannot be made: stay silent and let the end
    // of the turn reconcile, which is the path for a backend that never says
    // where arguments end.
    if (state.streamed !== complete) return out;
    // Keep both baselines in one coordinate system: `emitPending` compares
    // later values against `arguments`, and leaving it unnormalized here made a
    // no-argument call's `arguments` ('') disagree with its `streamed` ('{}'),
    // so any later delta for that call was silently dropped from the stream
    // while the completed result still folded it in.
    state.arguments = complete;
    state.argumentsDone = true;
    out.push({
      type: 'tool_call_delta',
      index,
      id: state.id,
      name: state.name,
      argumentsDone: true,
    });
    return out;
  }

  /** The failure the backend reported, if it reported one. */
  terminalFailure(): string | undefined {
    return this.failure;
  }

  /** Whether the backend ever said how the turn ended. */
  isSettled(): boolean {
    return this.settled;
  }

  completed(): LocalCompletionResult {
    const toolCalls = this.toolCalls();
    return {
      id: this.responseId ?? this.id,
      model: this.model ?? this.request.model,
      // Text and tool calls coexist upstream — a model that narrates before
      // calling a tool sends both — and the streamed deltas already delivered
      // the narration, so dropping it here made streaming and non-streaming
      // clients disagree about what the model said.
      text: this.text.trim(),
      ...(this.stopReason ? { stopReason: this.stopReason } : {}),
      // The completed result flattens the turn's text into one string, so this
      // is the one ordering a non-streaming client cannot reconstruct — and
      // both ordered surfaces need it to agree with the stream.
      ...(this.toolCallsBeforeText && toolCalls.length > 0 ? { toolCallsBeforeText: true } : {}),
      ...(this.reasoning ? { reasoning: this.reasoning } : {}),
      toolCalls,
      usage: this.usage ?? usageFor(this.request, this.text, toolCalls),
      latencyMs: Date.now() - this.startedAt,
    };
  }

  private toolCalls(): readonly LocalToolCall[] {
    return [...this.toolStates.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, state]) => ({
        id: state.id,
        name: state.name,
        arguments: ensureJsonString(state.arguments),
      }));
  }

  private captureFinalOutput(output: readonly unknown[] | undefined): void {
    if (!Array.isArray(output)) return;
    const finalCalls = output.filter((item) => asRecord(item)?.type === 'function_call');
    // Positional alignment is only meaningful when the two views agree on how
    // many calls there are. When they disagree, an id-less final item would
    // land on whichever streamed call happens to share its position and
    // overwrite that call's name and arguments — turning one tool call into a
    // second copy of another. The streamed state is the one the client already
    // acted on, so it wins.
    const alignable = this.toolStates.size === 0 || finalCalls.length === this.toolStates.size;
    let functionCallPosition = 0;
    for (const item of output) {
      const obj = asRecord(item);
      if (obj?.type === 'function_call') {
        const anonymous = typeof obj.id !== 'string' && typeof obj.call_id !== 'string';
        if (anonymous && !alignable) {
          functionCallPosition += 1;
          continue;
        }
        const index = this.finalOutputOrdinal(
          functionCallPosition,
          typeof obj.id === 'string' ? obj.id : undefined,
          typeof obj.call_id === 'string' ? obj.call_id : undefined,
        );
        functionCallPosition += 1;
        const existing = this.toolStates.get(index);
        const state = existing ?? {
          ...this.newToolState(index, {
            id: typeof obj.call_id === 'string' ? obj.call_id : undefined,
            name: typeof obj.name === 'string' ? obj.name : undefined,
          }),
          started: true,
          identified: typeof obj.call_id === 'string',
        };
        // An anonymous item is matched by position alone, and position is not
        // proof of identity: with two calls listed in an order the stream did
        // not use, overwriting here gave each streamed call the OTHER call's
        // name and arguments under its own id, so tool results came back
        // answering the wrong call. It may fill in what the stream never
        // delivered; it may not replace what it did.
        const mayReplace = !anonymous || existing === undefined;
        if (typeof obj.call_id === 'string') state.id = obj.call_id;
        if (typeof obj.name === 'string' && (mayReplace || state.name === 'tool')) state.name = obj.name;
        // An anonymous item may still COMPLETE what the stream started: a turn
        // that ended mid-argument leaves a prefix that parses as nothing, and
        // arguments the streamed text is a prefix of are that same call's
        // finished value, not another call's payload. Anything that
        // contradicts the prefix is refused, as before.
        // ...and never for a call already announced as finished. The stream
        // closed on the value it sent and cannot take it back, so a completed
        // output that names a different one would have the client's
        // accumulation and the body's report describe the same call
        // differently.
        if (
          typeof obj.arguments === 'string'
          && !state.argumentsDone
          && (mayReplace || obj.arguments.startsWith(state.arguments))
        ) {
          state.arguments = obj.arguments;
        }
        this.toolStates.set(index, state);
      }
    }
  }
}

interface CodexBackendImageTurnResult {
  readonly images: readonly OpenAiGeneratedImage[];
  readonly usage?: LocalUsage;
  readonly latencyMs: number;
}

class NoImageResultError extends Error {
  constructor() {
    super(NO_IMAGE_RESULT_MESSAGE);
  }
}

class CodexBackendImageState {
  responseId?: string;
  model?: string;
  usage?: LocalUsage;
  readonly images: OpenAiGeneratedImage[] = [];
  readonly eventTypes: string[] = [];
  readonly outputItemTypes: string[] = [];
  readonly completedOutputTypes: string[] = [];
  readonly eventTimeline: CodexBackendImageEventDiagnostic[] = [];
  imageItemAdded = false;
  imageGenerating = false;
  textDeltaCount = 0;
  textSample = '';

  constructor(
    private readonly request: OpenAiImageGenerationRequest,
    private readonly startedAt: number,
  ) {}

  push(event: CodexBackendEvent): OpenAiImageGenerationStreamEvent[] {
    const out: OpenAiImageGenerationStreamEvent[] = [];
    if (event.type) this.eventTypes.push(event.type);
    if (event.type) this.eventTimeline.push({
      type: event.type,
      offsetMs: Date.now() - this.startedAt,
      ...(event.item?.type ? { itemType: event.item.type } : {}),
      ...(event.item?.status ? { itemStatus: event.item.status } : {}),
      ...(imageGenerationFromResponseItem(event.item) ? { hasImageResult: true } : {}),
    });
    if (event.response?.id) this.responseId = event.response.id;
    if (event.response?.model) this.model = event.response.model;
    if (typeof event.delta === 'string' && event.type === 'response.output_text.delta') {
      this.textDeltaCount += 1;
      if (this.textSample.length < 240) this.textSample += event.delta;
    }
    if (event.item?.type) {
      this.outputItemTypes.push(event.item.type);
      if (isImageGenerationItemType(event.item.type)) this.imageItemAdded = true;
    }
    if (event.type === 'response.image_generation_call.generating') this.imageGenerating = true;
    const itemImage = imageGenerationFromResponseItem(event.item);
    if (itemImage && !this.hasImage(itemImage)) {
      this.images.push(itemImage);
      out.push({
        type: 'completed',
        created: Math.floor(Date.now() / 1000),
        image: itemImage,
        background: this.request.background,
        outputFormat: this.request.outputFormat,
        quality: this.request.quality,
        size: this.request.size,
      });
    }
    if (event.type === 'response.completed') {
      const usage = usageFromResponses(event.response?.usage);
      if (usage) this.usage = usage;
      this.completedOutputTypes.push(...responseOutputTypes(event.response?.output));
      for (const image of imageGenerationsFromOutput(event.response?.output)) {
        if (this.hasImage(image)) continue;
        this.images.push(image);
        out.push({
          type: 'completed',
          created: Math.floor(Date.now() / 1000),
          image,
          background: this.request.background,
          outputFormat: this.request.outputFormat,
          quality: this.request.quality,
          size: this.request.size,
          usage,
        });
      }
    }
    return out;
  }

  completed(): CodexBackendImageTurnResult {
    if (this.images.length === 0) throw new NoImageResultError();
    return {
      images: this.images,
      ...(this.usage ? { usage: this.usage } : {}),
      latencyMs: Date.now() - this.startedAt,
    };
  }

  diagnostic(options: {
    operation: OpenAiImageGenerationRequest['operation'];
    imageIndex: number;
    attempt: number;
    ok: boolean;
    retrying?: boolean;
    error?: string;
  }): CodexBackendImageAttemptDiagnostic {
    return {
      operation: options.operation,
      imageIndex: options.imageIndex,
      attempt: options.attempt,
      ok: options.ok,
      ...(options.retrying !== undefined ? { retrying: options.retrying } : {}),
      latencyMs: Date.now() - this.startedAt,
      eventTypes: [...this.eventTypes],
      outputItemTypes: [...this.outputItemTypes],
      completedOutputTypes: [...this.completedOutputTypes],
      imageResultCount: this.images.length,
      imageItemAdded: this.imageItemAdded,
      imageGenerating: this.imageGenerating,
      textDeltaCount: this.textDeltaCount,
      eventTimeline: [...this.eventTimeline],
      ...(this.textSample.trim() ? { textSample: this.textSample.trim() } : {}),
      ...(options.error ? { error: options.error } : {}),
    };
  }

  private hasImage(image: OpenAiGeneratedImage): boolean {
    return this.images.some((existing) => existing.b64Json === image.b64Json);
  }
}

export class CodexBackendTransport implements LocalCliBackend, OpenAiImageGenerationClient {
  readonly name = 'codex-backend';
  readonly model: string;

  private readonly timeoutMs: number;
  private readonly reasoningEffort?: NormalizedReasoningEffort;
  private readonly verbosity: NormalizedVerbosity;
  private readonly codexHome: string;
  private readonly onImageAttempt?: (diagnostic: CodexBackendImageAttemptDiagnostic) => void;
  private readonly honorRequestModel: boolean;
  private readonly codexCommand?: string;
  private readonly runtimeCwd?: string;

  constructor(options: CodexBackendTransportOptions) {
    this.model = options.model ?? DEFAULT_CODEX_BACKEND_MODEL;
    this.timeoutMs = options.timeoutMs;
    this.reasoningEffort = options.reasoningEffort;
    this.verbosity = options.verbosity ?? 'medium';
    this.codexHome = options.codexHome ?? sourceCodexHome();
    this.onImageAttempt = options.onImageAttempt;
    this.honorRequestModel = options.honorRequestModel ?? honorRequestModel();
    this.codexCommand = options.codexCommand;
    this.runtimeCwd = options.cwd;
  }

  async generate(
    request: NormalizedRequest,
    signal?: AbortSignal,
  ): Promise<LocalCompletionResult>;
  async generate(
    request: OpenAiImageGenerationRequest,
    signal?: AbortSignal,
  ): Promise<OpenAiImageGenerationResult>;
  async generate(
    request: NormalizedRequest | OpenAiImageGenerationRequest,
    signal?: AbortSignal,
  ): Promise<LocalCompletionResult | OpenAiImageGenerationResult> {
    if (isOpenAiImageGenerationRequest(request)) {
      return this.generateImage(request, signal);
    }
    let completed: LocalCompletionResult | undefined;
    for await (const event of this.streamText(request, signal)) {
      if (event.type === 'completed') completed = event.result;
    }
    if (!completed) throw new Error('codex backend response completed without a result');
    return completed;
  }

  stream(
    request: NormalizedRequest,
    signal?: AbortSignal,
  ): AsyncIterable<LocalStreamEvent>;
  stream(
    request: OpenAiImageGenerationRequest,
    signal?: AbortSignal,
  ): AsyncIterable<OpenAiImageGenerationStreamEvent>;
  stream(
    request: NormalizedRequest | OpenAiImageGenerationRequest,
    signal?: AbortSignal,
  ): AsyncIterable<LocalStreamEvent | OpenAiImageGenerationStreamEvent> {
    return isOpenAiImageGenerationRequest(request)
      ? this.streamImage(request, signal)
      : this.streamText(request, signal);
  }

  private async *streamText(
    request: NormalizedRequest,
    signal?: AbortSignal,
  ): AsyncIterable<LocalStreamEvent> {
    const startedAt = Date.now();
    const state = new CodexBackendStreamState(request, startedAt);
    for await (const event of this.responseEvents(request, signal)) {
      for (const local of state.push(event)) yield local;
    }
    // A turn only finished if the backend said so. A reported failure, or a
    // stream that simply stopped, was previously yielded as a completed result
    // — the client received a 200 whose content was whatever had arrived.
    const failure = state.terminalFailure();
    if (failure) throw new Error(failure);
    if (!state.isSettled()) throw new Error('codex backend stream ended without a terminal event');
    yield { type: 'completed', result: state.completed() };
  }

  async close(): Promise<void> {}

  private async generateImage(
    request: OpenAiImageGenerationRequest,
    signal?: AbortSignal,
  ): Promise<OpenAiImageGenerationResult> {
    const startedAt = Date.now();
    // Siblings of a failed turn are already-lost work: the caller has its
    // error, and every one still running is a full billed image generation
    // whose result nothing will read. Cancel them with the first failure.
    const fanOut = new AbortController();
    const abortFanOut = (): void => fanOut.abort();
    signal?.addEventListener('abort', abortFanOut, { once: true });
    let results: CodexBackendImageTurnResult[];
    try {
      results = await Promise.all(
        Array.from(
          { length: request.n },
          (_, index) => this.runSingleImageRequest(request, index, fanOut.signal).catch((err) => {
            fanOut.abort();
            throw err;
          }),
        ),
      );
    } finally {
      signal?.removeEventListener('abort', abortFanOut);
    }
    let usage: LocalUsage | undefined;
    const images: OpenAiGeneratedImage[] = [];
    for (const result of results) {
      images.push(...result.images);
      usage = mergeUsage(usage, result.usage);
    }
    return {
      created: Math.floor(Date.now() / 1000),
      images: postprocessFlatGraphicImages(request, images),
      background: request.background,
      outputFormat: request.outputFormat,
      quality: request.quality,
      size: request.size,
      ...(usage ? { usage } : {}),
      latencyMs: Date.now() - startedAt,
    };
  }

  private async *streamImage(
    request: OpenAiImageGenerationRequest,
    signal?: AbortSignal,
  ): AsyncIterable<OpenAiImageGenerationStreamEvent> {
    for (let index = 0; index < request.n; index += 1) {
      for (let attempt = 0; attempt <= IMAGE_NO_RESULT_RETRY_DELAYS_MS.length; attempt += 1) {
        const state = new CodexBackendImageState(request, Date.now());
        try {
          for await (const event of this.responseEventsForBody(
            JSON.stringify(await this.imageRequestBody(request, index, attempt)),
            signal,
          )) {
            for (const local of state.push(event)) {
              yield {
                ...local,
                image: postprocessFlatGraphicImageIfNeeded(request, local.image),
                partialImageIndex: index,
              };
            }
          }
          state.completed();
          this.reportImageAttempt(state.diagnostic({
            operation: request.operation,
            imageIndex: index,
            attempt,
            ok: true,
          }));
          break;
        } catch (err) {
          const retrying = shouldRetryNoImageResult(err, attempt, signal);
          this.reportImageAttempt(state.diagnostic({
            operation: request.operation,
            imageIndex: index,
            attempt,
            ok: false,
            retrying,
            error: errorMessage(err),
          }));
          if (!retrying) throw err;
          await sleep(IMAGE_NO_RESULT_RETRY_DELAYS_MS[attempt] ?? 0);
        }
      }
    }
  }

  private async runSingleImageRequest(
    request: OpenAiImageGenerationRequest,
    imageIndex: number,
    signal?: AbortSignal,
  ): Promise<CodexBackendImageTurnResult> {
    for (let attempt = 0; attempt <= IMAGE_NO_RESULT_RETRY_DELAYS_MS.length; attempt += 1) {
      const state = new CodexBackendImageState(request, Date.now());
      try {
        for await (const event of this.responseEventsForBody(
          JSON.stringify(await this.imageRequestBody(request, imageIndex, attempt)),
          signal,
        )) {
          state.push(event);
        }
        const result = state.completed();
        this.reportImageAttempt(state.diagnostic({
          operation: request.operation,
          imageIndex,
          attempt,
          ok: true,
        }));
        return result;
      } catch (err) {
        const retrying = shouldRetryNoImageResult(err, attempt, signal);
        this.reportImageAttempt(state.diagnostic({
          operation: request.operation,
          imageIndex,
          attempt,
          ok: false,
          retrying,
          error: errorMessage(err),
        }));
        if (!retrying) throw err;
        await sleep(IMAGE_NO_RESULT_RETRY_DELAYS_MS[attempt] ?? 0);
      }
    }
    throw new NoImageResultError();
  }

  private async *responseEvents(
    request: NormalizedRequest,
    signal?: AbortSignal,
  ): AsyncIterable<CodexBackendEvent> {
    yield* this.responseEventsForBody(JSON.stringify(await this.requestBody(request, signal)), signal);
  }

  private async *responseEventsForBody(
    body: string,
    signal?: AbortSignal,
  ): AsyncIterable<CodexBackendEvent> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const abortFromSignal = (): void => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', abortFromSignal, { once: true });
    }
    try {
      let auth = await this.readAuth();
      let response: Response | null = null;
      for (let attempt = 0; attempt <= TRANSIENT_BACKEND_RETRY_DELAYS_MS.length; attempt += 1) {
        try {
          response = await this.postBackendRequest(auth, body, controller.signal);
        } catch (err) {
          if (!shouldRetryTransientBackendFetchError(err, attempt, controller.signal)) throw err;
          await sleep(TRANSIENT_BACKEND_RETRY_DELAYS_MS[attempt] ?? 0);
          continue;
        }
        if (response.ok) break;
        const raw = await response.text().catch(() => '');
        if (shouldRefreshAfterBackendError(response.status, raw)) {
          auth = await this.refreshAuth({ force: true, previousAccessToken: auth.accessToken });
          response = await this.postBackendRequest(auth, body, controller.signal);
          if (response.ok) break;
        } else if (shouldRetryTransientBackendError(response.status, raw, attempt)) {
          await sleep(TRANSIENT_BACKEND_RETRY_DELAYS_MS[attempt] ?? 0);
          continue;
        } else {
          throw codexBackendError(response.status, raw);
        }
        if (!response.ok) {
          const retryRaw = await response.text().catch(() => '');
          if (shouldRetryTransientBackendError(response.status, retryRaw, attempt)) {
            await sleep(TRANSIENT_BACKEND_RETRY_DELAYS_MS[attempt] ?? 0);
            continue;
          }
          throw codexBackendError(response.status, retryRaw);
        }
      }
      if (!response) {
        throw new Error('Codex backend request did not return a response');
      }
      if (!response.ok) {
        throw codexBackendError(response.status, await response.text().catch(() => ''));
      }
      for await (const event of parseSseEvents(response)) {
        yield event;
      }
    } finally {
      clearTimeout(timeout);
      if (signal) signal.removeEventListener('abort', abortFromSignal);
    }
  }

  private async postBackendRequest(
    auth: CodexBackendAuth,
    body: string,
    signal: AbortSignal,
  ): Promise<Response> {
    return await fetch(`${CHATGPT_CODEX_BACKEND_URL}/responses`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${auth.accessToken}`,
        'ChatGPT-Account-ID': auth.accountId,
        'OAI-Product-Sku': PRODUCT_SKU,
        'Content-Type': 'application/json',
        accept: 'text/event-stream',
      },
      body,
      signal,
    });
  }

  private async readAuth(): Promise<CodexBackendAuth> {
    const parsed = await this.loadAuthFile();
    const auth = authFromFile(parsed);
    return shouldRefreshAuth(parsed) ? await this.refreshAuth() : auth;
  }

  private async refreshAuth(options: {
    force?: boolean;
    previousAccessToken?: string;
  } = {}): Promise<CodexBackendAuth> {
    return await withRefreshLock(this.codexHome, async () => {
      const parsed = await this.loadAuthFile();
      const current = authFromFile(parsed);
      if (options.force && options.previousAccessToken && current.accessToken !== options.previousAccessToken) {
        return current;
      }
      if (!options.force && !shouldRefreshAuth(parsed)) return current;
      if (!current.refreshToken) {
        throw codexRefreshError('Codex OAuth auth.json must include tokens.refresh_token to refresh codex-backend access.');
      }
      const refreshResponse = await requestChatgptTokenRefresh(current.refreshToken);
      const updated = mergeRefreshedAuth(parsed, refreshResponse);
      await saveAuthFile(this.codexHome, updated);
      return authFromFile(updated);
    });
  }

  private async loadAuthFile(): Promise<CodexAuthFile> {
    try {
      return JSON.parse(await readFile(join(this.codexHome, 'auth.json'), 'utf8')) as CodexAuthFile;
    } catch (err) {
      throw new Error(`Unable to read Codex OAuth auth.json for codex-backend transport: ${errorMessage(err)}`);
    }
  }

  private async requestBody(
    request: NormalizedRequest,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const effort = request.reasoningEffort ?? this.reasoningEffort;
    return {
      model: await this.modelFor(request, signal),
      instructions: [
        baseInstructions(),
        developerInstructions(),
        requestInstructionText(request),
      ].filter(Boolean).join('\n\n'),
      input: await responseInputItems(request),
      tools: responseTools(request),
      tool_choice: responseToolChoice(request.toolChoice),
      parallel_tool_calls: true,
      reasoning: effort ? { effort: codexBackendReasoningEffort(effort) } : undefined,
      store: false,
      stream: true,
      include: [],
      text: responseTextControls(request, this.verbosity),
    };
  }

  private async imageRequestBody(
    request: OpenAiImageGenerationRequest,
    imageIndex: number,
    attempt = 0,
  ): Promise<Record<string, unknown>> {
    const effort = image2QualityToGpt55ReasoningEffort(request.quality);
    const prompt = buildCodexBackendImageGenerationPrompt(request, imageIndex, attempt);
    return {
      model: this.model,
      instructions: [
        'You are serving an OpenAI-compatible Images API request through the local Codex OAuth backend.',
        'Use the image_generation tool for the visual output.',
        'The request is incomplete unless the final response includes an image_generation_call item with a non-empty result field.',
        'Do not answer with text-only content.',
        'Do not call direct provider APIs or external network APIs.',
        'If an image is generated, do not add prose.',
        imageRetryInstruction(attempt),
      ].join('\n'),
      input: await responseInputItems(codexBackendImageInputRequest(request, prompt)),
      tools: [codexBackendImageGenerationTool(request)],
      tool_choice: { type: 'image_generation' },
      parallel_tool_calls: true,
      reasoning: { effort: codexBackendReasoningEffort(effort) },
      store: false,
      stream: true,
      include: [],
      text: { verbosity: 'low' },
    };
  }

  /**
   * This transport has always let the request model win, with the configured
   * model as the fallback for requests that name none. `honorRequestModel` does
   * not change that precedence here — it adds the validation that was missing,
   * because the Codex backend accepts any model string and only fails once the
   * request reaches the server.
   */
  /** The Codex catalogue, so new model generations appear without a code change. */
  async availableModels(): Promise<readonly string[] | null> {
    const models = await codexModels({
      command: this.codexCommand,
      codexHome: this.codexHome,
      commandCwd: this.runtimeCwd,
    });
    return models?.map((entry) => entry.slug) ?? null;
  }

  async resolvedModel(request: NormalizedRequest): Promise<string | null> {
    return this.explicitRequestModel(request.model) ?? this.model;
  }

  private async modelFor(request: NormalizedRequest, signal?: AbortSignal): Promise<string> {
    // Resolve first, then validate what will actually run. Validating only the
    // requested value would let a configured-but-retired model reach the server
    // unchecked whenever a request names no model.
    const requested = this.explicitRequestModel(request.model);
    const effective = requested ?? this.model;
    if (this.honorRequestModel) {
      await assertCodexModelSupported(
        effective,
        request.shape,
        {
          command: this.codexCommand,
          codexHome: this.codexHome,
          commandCwd: this.runtimeCwd,
          signal,
        },
        requested !== undefined,
      );
    }
    return effective;
  }

  private explicitRequestModel(requestModel: string): string | undefined {
    return requestModel || undefined;
  }

  private reportImageAttempt(diagnostic: CodexBackendImageAttemptDiagnostic): void {
    this.onImageAttempt?.(diagnostic);
  }
}

function authFromFile(parsed: CodexAuthFile): CodexBackendAuth {
  const accessToken = parsed.tokens?.access_token;
  const accountId = parsed.tokens?.account_id ?? accountIdFromIdToken(parsed.tokens?.id_token);
  if (!accessToken || !accountId) {
    throw new Error('Codex OAuth auth.json must include tokens.access_token and tokens.account_id for codex-backend transport.');
  }
  return {
    file: parsed,
    accessToken,
    refreshToken: parsed.tokens?.refresh_token,
    accountId,
  };
}

function shouldRefreshAuth(parsed: CodexAuthFile): boolean {
  const accessToken = parsed.tokens?.access_token;
  if (accessToken) {
    const expiresAtMs = jwtExpirationMs(accessToken);
    if (Number.isFinite(expiresAtMs)) {
      return expiresAtMs <= Date.now() + ACCESS_TOKEN_REFRESH_WINDOW_MS;
    }
  }
  if (!parsed.last_refresh) return false;
  const lastRefreshMs = Date.parse(parsed.last_refresh);
  return Number.isFinite(lastRefreshMs)
    && lastRefreshMs < Date.now() - FALLBACK_REFRESH_INTERVAL_MS;
}

async function withRefreshLock<T>(
  codexHome: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lockPath = join(codexHome, 'auth.json.refresh.lock');
  const startedAt = Date.now();
  while (true) {
    let handle;
    try {
      handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({
        pid: process.pid,
        created_at: new Date().toISOString(),
      }));
      try {
        return await fn();
      } finally {
        await handle.close().catch(() => undefined);
        await unlink(lockPath).catch(() => undefined);
      }
    } catch (err) {
      await handle?.close().catch(() => undefined);
      if (!isFileExistsError(err)) throw err;
      if (await removeStaleLock(lockPath)) continue;
      if (Date.now() - startedAt > REFRESH_LOCK_TIMEOUT_MS) {
        throw codexRefreshError('Timed out waiting for Codex OAuth token refresh lock.');
      }
      await sleep(50);
    }
  }
}

async function removeStaleLock(lockPath: string): Promise<boolean> {
  try {
    const info = await stat(lockPath);
    if (Date.now() - info.mtimeMs <= REFRESH_LOCK_STALE_MS) return false;
    await unlink(lockPath);
    return true;
  } catch {
    return false;
  }
}

async function requestChatgptTokenRefresh(refreshToken: string): Promise<CodexRefreshResponse> {
  const response = await fetch(CODEX_REFRESH_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: CODEX_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });
  if (response.ok) {
    // A 200 carrying no usable token is a failed refresh, not a silent no-op:
    // merging it kept the expired token AND rewrote `last_refresh`, destroying
    // the staleness signal the fallback refresh depends on, so the next request
    // went out with an expired token and the operator saw the backend's
    // complaint instead of "log out and sign in again". A gateway's HTML page
    // is the same failure, and used to surface as a 500 SyntaxError.
    let refreshed: CodexRefreshResponse;
    try {
      refreshed = await response.json() as CodexRefreshResponse;
    } catch {
      throw codexRefreshError('Codex OAuth token refresh returned a response that is not JSON.');
    }
    if (!refreshed?.access_token) {
      throw codexRefreshError('Codex OAuth token refresh returned no access token. Please log out and sign in again.');
    }
    return refreshed;
  }
  const raw = await response.text().catch(() => '');
  throw codexRefreshError(refreshFailureMessage(raw), refreshFailureCode(raw));
}

function mergeRefreshedAuth(
  parsed: CodexAuthFile,
  refreshed: CodexRefreshResponse,
): CodexAuthFile {
  const previousTokens = parsed.tokens ?? {};
  const updatedTokens: CodexAuthTokens = {
    ...previousTokens,
    ...(refreshed.id_token ? { id_token: refreshed.id_token } : {}),
    ...(refreshed.access_token ? { access_token: refreshed.access_token } : {}),
    ...(refreshed.refresh_token ? { refresh_token: refreshed.refresh_token } : {}),
  };
  const accountId = accountIdFromIdToken(updatedTokens.id_token) ?? updatedTokens.account_id;
  return {
    ...parsed,
    tokens: {
      ...updatedTokens,
      ...(accountId ? { account_id: accountId } : {}),
    },
    last_refresh: new Date().toISOString(),
  };
}

async function saveAuthFile(codexHome: string, auth: CodexAuthFile): Promise<void> {
  const path = join(codexHome, 'auth.json');
  const tempPath = join(codexHome, `.auth.json.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(tempPath, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
  await rename(tempPath, path);
}

function shouldRefreshAfterBackendError(status: number, raw: string): boolean {
  if (status === 401) return true;
  if (status !== 403) return false;
  return /\b(?:token|auth|unauthori[sz]ed|expired)\b/i.test(raw);
}

function shouldRetryTransientBackendError(
  status: number,
  raw: string,
  attempt: number,
): boolean {
  if (attempt >= TRANSIENT_BACKEND_RETRY_DELAYS_MS.length) return false;
  if (status === 502 || status === 504) return true;
  if (status !== 503) return false;
  return /\b(?:upstream|connect|connection|disconnect|reset|timeout|temporar(?:y|ily)|unavailable)\b/i.test(raw);
}

function shouldRetryTransientBackendFetchError(
  err: unknown,
  attempt: number,
  signal: AbortSignal,
): boolean {
  if (attempt >= TRANSIENT_BACKEND_RETRY_DELAYS_MS.length || signal.aborted) return false;
  const message = errorMessage(err);
  return err instanceof TypeError
    || /\b(?:fetch failed|network|socket|connection|connect|disconnect|reset|timeout|terminated|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|UND_ERR)\b/i.test(message);
}

function shouldRetryNoImageResult(
  err: unknown,
  attempt: number,
  signal?: AbortSignal,
): boolean {
  return err instanceof NoImageResultError
    && attempt < IMAGE_NO_RESULT_RETRY_DELAYS_MS.length
    && signal?.aborted !== true;
}

function isOpenAiImageGenerationRequest(
  request: NormalizedRequest | OpenAiImageGenerationRequest,
): request is OpenAiImageGenerationRequest {
  return typeof (request as OpenAiImageGenerationRequest).operation === 'string'
    && Array.isArray((request as OpenAiImageGenerationRequest).images);
}

function buildCodexBackendImageGenerationPrompt(
  request: OpenAiImageGenerationRequest,
  imageIndex: number,
  attempt: number,
): string {
  const countNote = request.n > 1
    ? `Generate image ${imageIndex + 1} of ${request.n} for the same Images API request.`
    : 'Generate exactly one image for this Images API request.';
  const attachmentNote = imageAttachmentNote(request);
  return [
    imageRetryUserNote(attempt),
    countNote,
    `Images API operation: ${request.operation}.`,
    attachmentNote,
    image2ViaGpt55PromptFromRequest(request),
  ].filter(Boolean).join('\n\n');
}

function imageAttachmentNote(request: OpenAiImageGenerationRequest): string {
  const notes: string[] = [];
  if (request.images.length > 0) {
    notes.push(`Attached images 1-${request.images.length} are source/reference images for the ${request.operation} request.`);
  }
  if (request.mask) {
    notes.push(`Attached image ${request.images.length + 1} is the edit mask.`);
  }
  return notes.join(' ');
}

function imageRetryInstruction(attempt: number): string {
  return attempt > 0
    ? 'A previous backend attempt completed without an image_generation_call result. For this retry, call the image_generation tool and ensure the completed image item includes a non-empty result.'
    : '';
}

function imageRetryUserNote(attempt: number): string {
  return attempt > 0
    ? `Retry attempt ${attempt + 1}: the previous backend attempt ended without an image_generation_call result. Produce the image via the image_generation tool now; do not provide a text-only answer.`
    : '';
}

function codexBackendImageInputRequest(
  request: OpenAiImageGenerationRequest,
  prompt: string,
): NormalizedRequest {
  return {
    shape: 'openai-responses',
    model: 'codex-backend',
    messages: [{
      role: 'user',
      content: prompt,
      images: [
        ...request.images,
        ...(request.mask ? [request.mask] : []),
      ],
    }],
    stream: false,
    streamOptions: { includeUsage: false, includeObfuscation: false },
    jsonMode: false,
    tools: [],
    toolChoice: { type: 'auto' },
    raw: request.raw,
  };
}

function codexBackendImageGenerationTool(
  request: OpenAiImageGenerationRequest,
): Record<string, unknown> {
  const quality = codexBackendImageQuality(request.quality);
  return {
    type: 'image_generation',
    action: request.operation === 'generation' ? 'generate' : 'edit',
    ...(request.size && request.size !== 'auto' ? { size: request.size } : {}),
    ...(quality ? { quality } : {}),
    ...(request.outputFormat ? { output_format: request.outputFormat } : {}),
    ...(request.outputCompression !== undefined ? { output_compression: request.outputCompression } : {}),
  };
}

function codexBackendImageQuality(quality: string | undefined): 'low' | 'medium' | 'high' {
  if (quality === 'low') return 'low';
  if (quality === 'medium' || quality === 'standard') return 'medium';
  return 'high';
}

function imageGenerationFromResponseItem(
  item: CodexBackendEvent['item'] | unknown,
): OpenAiGeneratedImage | null {
  const obj = asRecord(item);
  if (!obj) return null;
  if (!isImageGenerationItemType(obj?.type)) return null;
  const result = imageResultBase64(obj);
  if (!result) return null;
  const revisedPrompt = typeof obj.revised_prompt === 'string'
    ? obj.revised_prompt
    : typeof obj.revisedPrompt === 'string'
      ? obj.revisedPrompt
      : '';
  return {
    b64Json: result,
    ...(revisedPrompt.trim()
      ? { revisedPrompt }
      : {}),
  };
}

function isImageGenerationItemType(value: unknown): boolean {
  return value === 'image_generation_call'
    || value === 'image_generation'
    || value === 'imageGeneration';
}

function imageResultBase64(item: Record<string, unknown>): string | null {
  const raw = typeof item.result === 'string'
    ? item.result
    : typeof item.b64_json === 'string'
      ? item.b64_json
      : typeof item.b64Json === 'string'
        ? item.b64Json
        : null;
  if (!raw?.trim()) return null;
  const withoutDataUrl = raw.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, '');
  return withoutDataUrl.replace(/\s/g, '');
}

function imageGenerationsFromOutput(output: readonly unknown[] | undefined): OpenAiGeneratedImage[] {
  if (!Array.isArray(output)) return [];
  return output
    .map(imageGenerationFromResponseItem)
    .filter((image): image is OpenAiGeneratedImage => Boolean(image));
}

function postprocessFlatGraphicImages(
  request: OpenAiImageGenerationRequest,
  images: readonly OpenAiGeneratedImage[],
): OpenAiGeneratedImage[] {
  return images.map((image) => postprocessFlatGraphicImageIfNeeded(request, image));
}

function responseOutputTypes(output: readonly unknown[] | undefined): string[] {
  if (!Array.isArray(output)) return [];
  return output
    .map((item) => asRecord(item)?.type)
    .filter((type): type is string => typeof type === 'string');
}

/** Sums a token field only when at least one side reported it. */
function optionalSum(
  field: 'cacheCreationInputTokens' | 'cacheReadInputTokens',
  left: LocalUsage,
  right: LocalUsage,
): Partial<LocalUsage> {
  if (left[field] === undefined && right[field] === undefined) return {};
  return { [field]: (left[field] ?? 0) + (right[field] ?? 0) };
}

function mergeUsage(
  left: LocalUsage | undefined,
  right: LocalUsage | undefined,
): LocalUsage | undefined {
  if (!right) return left;
  if (!left) return right;
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: (left.totalTokens ?? 0) + (right.totalTokens ?? 0),
    cachedInputTokens: (left.cachedInputTokens ?? 0) + (right.cachedInputTokens ?? 0),
    // Summed only where one side reported them: `?? 0` turned two silent
    // halves into a reported zero, which downstream reads as "this runtime
    // reports caching and got none" — a different claim from "it does not say".
    ...optionalSum('cacheCreationInputTokens', left, right),
    ...optionalSum('cacheReadInputTokens', left, right),
    reasoningOutputTokens: (left.reasoningOutputTokens ?? 0) + (right.reasoningOutputTokens ?? 0),
    source: left.source === 'provider' || right.source === 'provider' ? 'provider' : left.source ?? right.source,
    raw: [left.raw, right.raw].filter((value) => value !== undefined),
  };
}

function refreshFailureMessage(raw: string): string {
  const code = refreshFailureCode(raw);
  if (code === 'refresh_token_expired') {
    return 'Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.';
  }
  if (code === 'refresh_token_reused') {
    return 'Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.';
  }
  if (code === 'refresh_token_invalidated') {
    return 'Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.';
  }
  return 'Your access token could not be refreshed. Please log out and sign in again.';
}

function refreshFailureCode(raw: string): string | null {
  const parsed = parseMaybeJson(raw);
  const error = asRecord(asRecord(parsed)?.error);
  if (typeof error?.code === 'string') return error.code;
  const detail = asRecord(parsed)?.detail;
  if (typeof detail === 'object' && detail) {
    const code = (detail as Record<string, unknown>).code;
    if (typeof code === 'string') return code;
  }
  return null;
}

function codexRefreshError(message: string, code: string | null = null): ProxyRequestError {
  return new ProxyRequestError(message, 401, 'openai', 'invalid_request_error', null, code);
}

function jwtExpirationMs(jwt: string): number {
  const payload = jwtPayload(jwt);
  return typeof payload?.exp === 'number' ? payload.exp * 1000 : Number.NaN;
}

function accountIdFromIdToken(idToken: string | undefined): string | undefined {
  const auth = asRecord(jwtPayload(idToken)?.[CHATGPT_AUTH_CLAIM_NAMESPACE]);
  return typeof auth?.chatgpt_account_id === 'string'
    ? auth.chatgpt_account_id
    : undefined;
}

function jwtPayload(jwt: string | undefined): Record<string, unknown> | null {
  if (!jwt) return null;
  const payload = jwt.split('.')[1];
  if (!payload) return null;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseMaybeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isFileExistsError(err: unknown): boolean {
  return typeof err === 'object'
    && err !== null
    && 'code' in err
    && (err as { code?: unknown }).code === 'EEXIST';
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function responseInputItems(request: NormalizedRequest): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const message of request.messages) {
    if (isInstructionMessage(message)) continue;
    out.push(...await responseInputItemsForMessage(message));
  }
  return out.length > 0 ? out : [{
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: '' }],
  }];
}

async function responseInputItemsForMessage(message: NormalizedMessage): Promise<unknown[]> {
  const toolHistory = responseToolHistoryItems(message);
  if (toolHistory) {
    if (message.images.length === 0) return toolHistory;
    // The call still has to be answered — an unanswered `function_call` is a
    // 400 from this API — and the picture the tool returned still has to
    // arrive. `function_call_output` carries a string, so the image travels
    // beside it as its own user message rather than being dropped with the
    // answer.
    return [
      ...toolHistory,
      {
        type: 'message',
        role: 'user',
        content: await Promise.all(message.images.map((image) => responseImagePart(image))),
      },
    ];
  }
  return [{
    type: 'message',
    role: responseRole(message.role),
    content: await responseContent(message),
  }];
}

async function responseContent(message: NormalizedMessage): Promise<unknown[]> {
  const content: unknown[] = [];
  const textType = message.role === 'assistant' ? 'output_text' : 'input_text';
  if (message.content) content.push({ type: textType, text: message.content });
  for (const image of message.images) {
    content.push(await responseImagePart(image));
  }
  return content.length > 0 ? content : [{ type: textType, text: '' }];
}

/**
 * The tool turns of the conversation, as this API's own items.
 *
 * Images used to disqualify a message from being read as tool history at all,
 * which left the `function_call` before it unanswered — a 400 here, and prose
 * saying `[tool result]` in the prompt if it got through. The images come back
 * beside these items instead; see `responseInputItemsForMessage`.
 */
function responseToolHistoryItems(message: NormalizedMessage): unknown[] | null {
  // Provenance, not pattern. The markers are written by the normalizer when it
  // flattens a tool turn; a caller can type the same characters, and reading
  // them as tool history turned a user message beginning `[tool result]` into an
  // empty `function_call_output` — the text dropped, a result invented. The flag
  // is set only where this proxy wrote the marker itself.
  if (message.toolHistory !== true) return null;
  const text = message.content.trim();
  const callAt = markerIndex(text, ASSISTANT_TOOL_CALL_MARKER);
  if (callAt !== -1) {
    // The narration the model wrote alongside its call is part of the turn, and
    // the call must survive it. Reading tool history only from position 0 made
    // a "let me check…" before the call turn the whole message into prose, so
    // the call vanished and the result that answered it had nothing to pair
    // with — a 400 from this API.
    const narration = text.slice(0, callAt).trim();
    const items: unknown[] = parseAssistantToolCalls(text.slice(callAt)).map((call) => ({
      type: 'function_call',
      call_id: call.id,
      name: call.name,
      arguments: call.arguments,
    }));
    if (narration) {
      items.unshift({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: narration }],
      });
    }
    return items;
  }
  const resultAt = markerIndex(text, TOOL_RESULT_MARKER);
  if (resultAt !== -1) {
    // One output per result. Parallel calls answer in a single user turn, and
    // reading one `tool_call_id:` for the whole message answered the first call
    // and left the rest unanswered — the other half of the same 400.
    const items: unknown[] = splitAtMarkers(text.slice(resultAt), TOOL_RESULT_MARKER).map((block) => {
      const result = parseToolResult(block);
      return { type: 'function_call_output', call_id: result.callId, output: result.output };
    });
    const preamble = text.slice(0, resultAt).trim();
    if (preamble) {
      items.push({
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: preamble }],
      });
    }
    return items.length > 0 ? items : null;
  }
  return null;
}

function parseAssistantToolCalls(text: string): LocalToolCall[] {
  return text
    .split(ASSISTANT_TOOL_CALL_MARKER)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block, index) => ({
      id: markerValue(block, 'id') ?? `call_${index + 1}`,
      name: markerValue(block, 'name') ?? 'tool',
      arguments: markerValue(block, 'arguments') ?? '{}',
    }));
}

function parseToolResult(text: string): { callId: string; output: string } {
  const lines = text.split(/\r?\n/);
  const idIndex = lines.findIndex((line) => line.startsWith('tool_call_id:'));
  const callId = idIndex >= 0 ? lines[idIndex].slice('tool_call_id:'.length).trim() : 'tool_call';
  const output = idIndex >= 0 ? lines.slice(idIndex + 1).join('\n').trim() : '';
  return { callId: callId || 'tool_call', output };
}

function markerValue(block: string, key: string): string | undefined {
  const marker = `${key}:`;
  const index = block.indexOf(marker);
  if (index < 0) return undefined;
  const valueStart = index + marker.length;
  if (key === 'arguments') return block.slice(valueStart).trim();
  const newlineIndex = block.indexOf('\n', valueStart);
  const value = newlineIndex >= 0
    ? block.slice(valueStart, newlineIndex)
    : block.slice(valueStart);
  return value.trim();
}

async function responseImagePart(image: NormalizedImage): Promise<unknown> {
  if (image.source.type === 'url') {
    return {
      type: 'input_image',
      image_url: image.source.url,
      ...(image.detail ? { detail: image.detail } : {}),
    };
  }
  if (image.source.type === 'base64') {
    return {
      type: 'input_image',
      image_url: `data:${image.source.mediaType};base64,${image.source.data}`,
      ...(image.detail ? { detail: image.detail } : {}),
    };
  }
  if (image.source.type === 'path') {
    const mediaType = image.source.mediaType ?? mediaTypeForPath(image.source.path);
    const data = await readFile(image.source.path, 'base64');
    return {
      type: 'input_image',
      image_url: `data:${mediaType};base64,${data}`,
      ...(image.detail ? { detail: image.detail } : {}),
    };
  }
  throw new ProxyRequestError(
    'file_id image sources are not supported by codex-backend transport; use an image URL, data URL, base64, or local path source.',
    400,
  );
}

function responseTools(request: NormalizedRequest): unknown[] {
  if (request.toolChoice.type === 'none') return [];
  return request.tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description ?? '',
    parameters: tool.inputSchema ?? {
      type: 'object',
      additionalProperties: true,
    },
  }));
}

function responseToolChoice(choice: NormalizedToolChoice): unknown {
  if (choice.type === 'none') return 'none';
  if (choice.type === 'required') return 'required';
  if (choice.type === 'tool') return {
    type: 'function',
    name: choice.name,
  };
  return 'auto';
}

function responseTextControls(
  request: NormalizedRequest,
  fallbackVerbosity: NormalizedVerbosity,
): Record<string, unknown> | undefined {
  const text: Record<string, unknown> = {
    verbosity: request.verbosity ?? fallbackVerbosity,
  };
  if (request.jsonSchema) {
    // B1: preserve the client-supplied json_schema name/strict for fidelity. codex
    // enforcement is hard regardless, so these only affect what the caller sees echoed.
    text.format = {
      type: 'json_schema',
      name: request.jsonSchemaName ?? 'codex_output_schema',
      schema: request.jsonSchema,
      strict: request.jsonSchemaStrict ?? true,
    };
  } else if (request.jsonMode) {
    text.format = { type: 'json_object' };
  }
  return text;
}

function codexBackendReasoningEffort(
  effort: NormalizedReasoningEffort,
): Exclude<NormalizedReasoningEffort, 'minimal'> {
  return effort === 'minimal' ? 'low' : effort;
}

async function* parseSseEvents(response: Response): AsyncIterable<CodexBackendEvent> {
  const body = response.body;
  if (!body) return;
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let separator = /\r?\n\r?\n/.exec(buffer);
    while (separator) {
      const block = buffer.slice(0, separator.index);
      buffer = buffer.slice(separator.index + separator[0].length);
      const event = parseSseBlock(block);
      if (event) yield event;
      separator = /\r?\n\r?\n/.exec(buffer);
    }
  }
  buffer += decoder.decode();
  const event = parseSseBlock(buffer);
  if (event) yield event;
}

function parseSseBlock(block: string): CodexBackendEvent | null {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice(6))
    .join('\n')
    .trim();
  if (!data || data === '[DONE]') return null;
  try {
    return JSON.parse(data) as CodexBackendEvent;
  } catch {
    return null;
  }
}

function codexBackendError(status: number, raw: string): Error {
  let message = raw || `Codex backend request failed with status ${status}`;
  let type = 'server_error';
  let param: string | null = null;
  let code: string | null = null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    const error = asRecord(asRecord(parsed)?.error);
    const detail = asRecord(parsed)?.detail;
    if (error) {
      message = typeof error.message === 'string' ? error.message : message;
      type = typeof error.type === 'string' ? error.type : type;
      param = typeof error.param === 'string' ? error.param : null;
      code = typeof error.code === 'string' ? error.code : null;
    } else if (typeof detail === 'string') {
      message = detail;
      type = 'invalid_request_error';
    }
  } catch {
    // Keep raw message.
  }
  return new ProxyRequestError(message, status, 'openai', type, param, code);
}

function usageFromResponses(value: unknown): LocalUsage | undefined {
  const usage = asRecord(value);
  if (!usage) return undefined;
  const inputTokens = readNumber(usage.input_tokens);
  const outputTokens = readNumber(usage.output_tokens);
  const totalTokens = readNumber(usage.total_tokens);
  if (inputTokens === 0 && outputTokens === 0 && totalTokens === 0) return undefined;
  const inputDetails = asRecord(usage.input_tokens_details);
  const outputDetails = asRecord(usage.output_tokens_details);
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cachedInputTokens: readNumber(inputDetails?.cached_tokens),
    reasoningOutputTokens: readNumber(outputDetails?.reasoning_tokens),
    source: 'provider',
    raw: value,
  };
}

function readOutputIndex(event: CodexBackendEvent): number {
  return typeof event.output_index === 'number' && Number.isFinite(event.output_index)
    ? event.output_index
    : 0;
}

function responseRole(role: NormalizedMessage['role']): string {
  if (role === 'assistant') return 'assistant';
  if (role === 'tool') return 'user';
  return 'user';
}

function isInstructionMessage(message: NormalizedMessage): boolean {
  return (
    message.role === 'system'
    || message.role === 'developer'
  ) && message.content.trim() !== ''
    && (message.images ?? []).length === 0;
}

/**
 * Tool arguments as JSON. An absent value is an empty argument object — the
 * shape a no-parameter tool expects — not a phantom `input` property, which a
 * strict schema rejects and a loose one silently accepts.
 */
function ensureJsonString(value: string): string {
  if (value.trim() === '') return '{}';
  try {
    JSON.parse(value);
    return value;
  } catch {
    return JSON.stringify({ input: value });
  }
}

/** The message a terminal failure frame carries, whatever shape it arrives in. */
function terminalFailureMessage(event: CodexBackendEvent): string {
  const responseError = event.response?.error;
  const frameError = event.error;
  const detail = (typeof frameError === 'string' ? frameError : frameError?.message)
    ?? responseError?.message
    ?? event.response?.incomplete_details?.reason
    ?? event.response?.status;
  const kind = event.type === 'response.incomplete' ? 'incomplete' : 'failed';
  return `codex backend turn ${kind}${detail ? `: ${detail}` : ''}`;
}

function mediaTypeForPath(path: string): string {
  const ext = extname(path).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/png';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
