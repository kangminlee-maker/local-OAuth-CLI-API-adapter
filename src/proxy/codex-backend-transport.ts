import { randomUUID } from 'node:crypto';
import { open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { honorRequestModel } from '../settings.js';
import { backendContractError, baseInstructions, declaredToolNames, developerInstructions, requestInstructionText, usageFor } from './backend-contract.js';
import { assertCodexModelSupported, codexModels, sourceCodexHome } from './codex-model-catalog.js';
import {
  image2QualityToGpt55ReasoningEffort,
  image2ViaGpt55PromptFromRequest,
} from './image2-via-gpt55.js';
import { postprocessFlatGraphicImageIfNeeded } from './flat-image-postprocess.js';
import { prepareRequestedSize, realizeRequestedSize } from './image-realize.js';
import { toolResultImageLabels } from './multimodal.js';
import type {
  LocalCliBackend,
  LocalCompletionResult,
  LocalReasoningItem,
  LocalStreamEvent,
  LocalToolCall,
  LocalUsage,
  NormalizedImage,
  NormalizedMessage,
  NormalizedPart,
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
import { messageParts, ProxyRequestError, toolResultImages } from './types.js';

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
  /** Text on a text delta; read as arguments through `argumentsText`. */
  readonly delta?: unknown;
  readonly output_index?: number;
  /** Identity members are read through `identityText`. */
  readonly item_id?: unknown;
  /** `function_call_arguments.done` carries the call's whole arguments here. */
  readonly arguments?: unknown;
  readonly item?: {
    readonly id?: unknown;
    readonly type?: string;
    readonly name?: unknown;
    readonly call_id?: unknown;
    readonly arguments?: unknown;
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
   * Whether the backend has supplied the call's real name. `name` is the
   * placeholder `tool` until then, and a call is not announced on a `call_id`
   * alone: the placeholder went out on the stream and, once identities froze
   * (r24), stayed in the body too (r25-codex).
   */
  named: boolean;
  /**
   * Whether the backend has supplied the client-facing `call_id`. Latched
   * like `named`: the two halves of an identity may arrive on different
   * frames (the id on `output_item.added`, the name on `output_item.done`
   * without the id repeated), and deriving identification from the CURRENT
   * frame alone left such a call unannounced until the completed result —
   * behind narration the backend produced after it (r27-codex).
   */
  hasCallId: boolean;
  /**
   * Whether this state was opened by events carrying no id at all. Such a state
   * holds its output position on nothing but that position, so the call that
   * later names the position owns it — see `toolOrdinal`.
   */
  anonymous: boolean;
  /** Whether the client has been told this call's arguments are complete. */
  argumentsDone: boolean;
  /**
   * Whether the client has been told the call is finished. The vendor's
   * finish event fixes the VALUE at once (`argumentsDone`: later deltas are
   * dropped), but the signal that closes a surface's block waits until the
   * cut cannot hit the call — an event for a LATER output position, or the
   * terminal frame, which alone says whether the turn completed or was cut
   * off; a cut call's final block stays open (r24-codex F4, r27-fable F3,
   * r28-fable F2).
   */
  announcedDone: boolean;
  /**
   * A completed item has been applied to this call. Carried by the fold's
   * survivor: tracked by ordinal, the flag stayed on the retired state and
   * a second listing resolving to the survivor slipped past the
   * listed-twice gate (r40-fable).
   */
  placed: boolean;
  /**
   * Where this call sits in ANNOUNCEMENT order, set when the client is first
   * told about it. The completed result has to list calls in the order the
   * wire opened their blocks, and the map's own key is first-SEEN order — the
   * two coincide only while every call is announced in the order it appeared.
   */
  announcedAt?: number;
}

/**
 * The identifiers a tool event or a completed item carries, each in its own
 * namespace. Item ids, call ids and output positions are opaque to each
 * other: kept in one map, a `call_id` spelled `#0` resolved the holder of
 * position 0, and a spelling shared between one call's item id and another's
 * `call_id` bound the second call to the first (r35-codex).
 */
interface ToolIds {
  readonly itemId?: string;
  readonly callId?: string;
  /**
   * The tool's name when the frame gives one. Not an identifier, but a
   * witness every correlation must hear: two pieces carrying different
   * names are two calls, whatever id or position says — bound or folded
   * anyway, one call's arguments went out under the other's name (r37-codex).
   */
  readonly name?: string;
}

/** One `function_call` item of the completed output, as `captureFinalOutput` reads it. */
interface FinalCallItem {
  readonly outputIndex: number;
  readonly arguments: string | undefined;
  readonly itemId: string | undefined;
  readonly callId: string | undefined;
  readonly name: string | undefined;
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
  private readonly itemOrdinals = new Map<string, number>();
  private readonly callOrdinals = new Map<string, number>();
  /** The ordinal holding each backend output position: its first claimant, or the survivor of a fold. */
  private readonly holders = new Map<number, number>();
  /**
   * Each call's backend output position, from the first event that carried
   * one. The early finish signal compares positions: only an event for a
   * LATER item proves a finished call is not the one a cut will hit.
   */
  private readonly positions = new Map<number, number>();
  /**
   * The highest output position a NON-TOOL event has carried — narration,
   * reasoning, the other items: the vendor has moved past everything below
   * it. Tool events contribute through `progress()`, from the accepted
   * positions of the calls that can no longer fold into another. A fact, not
   * a trigger — a call that learns its position, or finishes, after the
   * vendor moved on is released on that frame, not at the terminal
   * (r30-codex).
   */
  private highestPosition = -1;
  private nextToolOrdinal = 0;
  private failure?: string;
  private settled = false;
  private stopReason?: string;
  /**
   * The turn's text, in the runs it was produced in, each recorded against the
   * tool calls announced before it. Recorded here because this is the one
   * backend that can genuinely interleave the two, so it is the only one that
   * can produce a turn a single position cannot describe: narration, a call,
   * then narration again.
   */
  private readonly textRuns: { text: string; afterCalls: number }[] = [];
  private announcedCalls = 0;
  private reasoning?: LocalReasoningItem;

  /** Whether the request permits any tool call at all (`declaredToolNames`). */
  private readonly callsPermitted: boolean;

  constructor(
    private readonly request: NormalizedRequest,
    private readonly startedAt: number,
  ) {
    this.callsPermitted = declaredToolNames(request) !== null;
  }

  /**
   * The ordinal for a tool call seen in the STREAM, keyed by item id with the
   * stream's own `output_index` as fallback. Argument deltas arrive once per
   * token, so a known id resolves before anything is allocated.
   */
  private toolOrdinal(event: CodexBackendEvent, ids: ToolIds): number {
    // A request that permits no call — no tools, or `tool_choice: none`; the
    // vendor is sent none — is refused at its first tool event, before
    // anything is correlated or announced: refusing at completion published
    // the call on the stream first, and a client that dispatches on the block
    // cannot take it back (r29-codex). `completed()` keeps its check for a
    // call that appears only in the completed output.
    if (!this.callsPermitted) {
      throw backendContractError('The local runtime called a tool the request never declared.', this.request.shape);
    }
    // Every identifier the event carries is looked up, not the first that
    // resolves: a `call_id` bound on an index-less first frame and an
    // `item_id` bound by a positioned delta are one call, and the frame that
    // carries both is where they meet — taking the first match announced
    // the one invocation twice (r30-codex).
    const bound = this.boundOrdinals(ids);
    const known = bound.length > 1 ? this.coalesce(bound) : bound[0];
    const position = explicitOutputIndex(event);
    const explicit = position !== undefined;
    if (known !== undefined) {
      this.bindOrdinal(known, ids);
      // A call bound by id on a frame that carried no position learns it from
      // the first later frame that does. Returning before the recording left
      // such a call positionless, and the early finish signal never fired for
      // it — the r27 held-blocks defect back for one input family (r29-fable
      // F1). That frame also claims the position for the call — adopting the
      // holder already there, if any — so the anonymous deltas that arrived
      // at it, and those that follow, reach the call. Only the call's ACCEPTED
      // position is claimed: a later frame naming another one claimed that
      // too, and the real call there was bound to this one and vanished
      // (r30-codex).
      this.recordPosition(known, event);
      // The call holds one position: a frame naming this call at some other
      // position is the vendor contradicting its own positions — a mislabel,
      // not a later item (r31-codex F5) — and is refused as arguments the
      // transport cannot place, as the completed item is. Adopting nothing
      // there but consuming the frame delivered its bytes under the call
      // (r45-codex).
      if (explicit && this.positions.get(known) !== position) {
        throw backendContractError('The local runtime wrote tool arguments the transport cannot place.', this.request.shape);
      }
      const survivor = explicit ? this.adoptHolder(known, position) : known;
      // A frame for a call already named, naming another tool, is the vendor
      // contradicting itself: refused, not the new name adopted and not its
      // arguments delivered under the old one — the announced identity was
      // kept and the frame's bytes went out under it (r39-codex). Heard on
      // the SURVIVOR, after the fold: checked against the known state alone,
      // an unnamed call adopting a `beta` holder took that name past a frame
      // that said `alpha` (r42-fable). The `call_id` is heard the same way.
      if (!this.namesAgree(ids.name, survivor) || !this.callIdAgrees(ids.callId, survivor)) {
        throw backendContractError('The local runtime named two tool calls as one.', this.request.shape);
      }
      return survivor;
    }
    // An `output_index` the event actually carries names ONE item: an
    // unfamiliar identifier arriving at a position a call already holds is
    // that call's other identifier (`call_id` first, `item_id` later, or the
    // reverse), and is bound to it. Splitting it off announced the same
    // `call_id` twice, `{}` and `{"a":1}` (r24-codex F5/F6).
    //
    // An ANONYMOUS holder is the same rule the other way round: argument
    // deltas that arrive before the call is named have nothing but the
    // position, so they belong to the call that names it. Splitting them off
    // invented a second call — named `tool`, carrying a fragment of the real
    // call's arguments — that the model never made and the client would have
    // executed.
    //
    // Only an event that carries a position claims one. An identified event
    // without one used to claim `#0` (its index read as 0), and a later call
    // really at position 0 was then bound to it and vanished — its identity
    // and arguments refused by a state that had already started (r29-codex).
    // Such an event is a new call, correlated by its ids alone.
    const identified = ids.itemId !== undefined || ids.callId !== undefined;
    // An event that names neither an item nor a position is uncorrelatable.
    // Read as position 0, it was spliced into whichever call next omitted its
    // index: the stream carried `{"b":2}{"a":1}` under a call whose body said
    // `{"a":1}` (r27-codex). Streamed bytes are never retracted, so nothing
    // afterwards can put that right; the turn is refused here instead.
    if (!identified && !explicit) {
      throw backendContractError('The local runtime wrote a tool event that names no call.', this.request.shape);
    }
    let ordinal = explicit ? this.holders.get(position) : undefined;
    // ...and only when the names agree: a named event at a position held by
    // a state of another name is two calls named as one, refused here before
    // the holder's bytes go out under this event's name (r37-codex). The
    // `call_id` is heard here like the name: this door heard only the name,
    // and a frame at the call's position naming another `call_id` had its
    // arguments ratified under the latched id — or, before the announcement,
    // replaced the id the client would echo (r45-fable).
    if (ordinal !== undefined && (!this.namesAgree(ids.name, ordinal) || !this.callIdAgrees(ids.callId, ordinal))) {
      throw backendContractError('The local runtime named two tool calls as one.', this.request.shape);
    }
    if (ordinal === undefined) {
      ordinal = this.nextToolOrdinal;
      this.nextToolOrdinal += 1;
    }
    if (explicit) this.holders.set(position, ordinal);
    this.bindOrdinal(ordinal, ids);
    this.recordPosition(ordinal, event);
    return ordinal;
  }

  /** The vendor has produced an item at this position: everything below it is behind it. */
  private advance(position: number | undefined): void {
    if (position !== undefined && position > this.highestPosition) this.highestPosition = position;
  }

  /**
   * How far the vendor has got: the highest position of an item that cannot
   * be an earlier call — narration and the other non-tool items (`advance`),
   * and the calls the client will be told about, at their accepted
   * positions. A tool event's position is not progress in itself: a state
   * that can still fold into another (`absorbable` — no `call_id`, nothing
   * announced) may BE an earlier call, and counting its position closed the
   * block of the very call it then folded into, ahead of the cut that
   * `response.incomplete` reported (r33-codex F3). Derived, not retained:
   * a fold retires the provisional state and its position with it.
   */
  private progress(): number {
    let progress = this.highestPosition;
    for (const [ordinal, state] of this.toolStates) {
      if (this.absorbable(state)) continue;
      const position = this.positions.get(ordinal);
      if (position !== undefined && position > progress) progress = position;
    }
    return progress;
  }

  /** The first explicit output position seen for a call is its position. */
  private recordPosition(ordinal: number, event: CodexBackendEvent): void {
    const position = explicitOutputIndex(event);
    if (position !== undefined && !this.positions.has(ordinal)) this.positions.set(ordinal, position);
  }

  /** The ordinal at a position, when nothing named has claimed it yet. */
  private adoptableOrdinal(claimed: number | undefined): number | undefined {
    if (claimed === undefined) return undefined;
    return this.toolStates.get(claimed)?.anonymous ? claimed : undefined;
  }

  /**
   * Claims a position for a call the stream already knows by id. An
   * anonymous holder there — argument deltas that carried only the position,
   * before any frame with the call's id named it — is the call's own earlier
   * bytes: a delta with the id at that position would have claimed it first,
   * so the holder's bytes precede the call's own. Left apart, the holder
   * stranded that prefix and the turn was refused as a call missing its
   * identity, after a/ had delivered it (r30-fable F1). When the call already
   * carries bytes the order of the two is not reconstructible, and the turn
   * is refused rather than guessed.
   */
  private adoptHolder(known: number, position: number): number {
    // The call claims only its accepted position — from the completed output
    // as from a live frame. An item at another index naming this call still
    // completes it by its ids (declared), but adopts nothing there: adopting
    // the holder handed the call that position's anonymous arguments under a
    // 200 (r36-codex); left apart, whatever holds that position — an
    // anonymous holder, a call known by an item id alone — stays a call of
    // its own, refused at completion unless a frame identifies it. A call
    // with no position yet takes this one: its first evidence.
    const accepted = this.positions.get(known);
    if (accepted !== undefined && accepted !== position) return known;
    if (accepted === undefined) this.positions.set(known, position);
    const holder = this.holders.get(position);
    if (holder === undefined) {
      this.holders.set(position, known);
      return known;
    }
    if (holder === known) return known;
    // The survivor is chosen by the one rule (`coalesce`), not by which side
    // the caller arrived from: the holder may be the call the client knows —
    // announced under its `call_id` — and the known state its item-id half,
    // and absorbing only one way refused the turn the position joined
    // (r31-codex F3). Two states the client knows at one position are left
    // apart (declared).
    const holderState = this.toolStates.get(holder);
    const state = this.toolStates.get(known);
    const holderAbsorbable = holderState !== undefined && this.absorbable(holderState);
    const knownAbsorbable = state !== undefined && this.absorbable(state);
    if (!holderAbsorbable && !knownAbsorbable) return known;
    return this.coalesce([known, holder]);
  }

  /**
   * Whether a state can be folded into another as the same call: the client
   * has never been told about it, and it carries no client-facing identity
   * (`call_id`) of its own — an anonymous holder, or a state opened by an
   * item id alone.
   */
  private absorbable(state: ToolState): boolean {
    return !state.started && !state.hasCallId;
  }

  /**
   * Two ordinals one frame names as the same call. The one the client knows
   * — announced, or carrying the `call_id` — survives; the others must be
   * absorbable, or the vendor has bridged two calls into one and the turn
   * is refused.
   */
  private coalesce(bound: readonly number[]): number {
    const survivor = bound.find((ordinal) => {
      const state = this.toolStates.get(ordinal);
      return state !== undefined && !this.absorbable(state);
    }) ?? bound[0];
    for (const other of bound) {
      if (other === survivor) continue;
      const otherState = this.toolStates.get(other);
      // Two pieces carrying different names are two calls, however the ids
      // or the position join them: folded, the absorbed piece's bytes went
      // out under the survivor's name (r37-codex).
      const contradicts = otherState !== undefined && otherState.named && !this.namesAgree(otherState.name, survivor);
      if (otherState !== undefined && (!this.absorbable(otherState) || contradicts)) {
        throw backendContractError('The local runtime named two tool calls as one.', this.request.shape);
      }
      this.absorb(survivor, other);
    }
    return survivor;
  }

  /**
   * Folds `other` into `survivor`: they are one call. `other`'s bytes precede
   * the survivor's own (see `adoptHolder`); when both carry bytes the order
   * is not reconstructible and the turn is refused rather than guessed. Every
   * id alias of `other` names the survivor afterwards; of its position
   * aliases only the one at the survivor's accepted position survives (the
   * others would bind the real call arriving there to the survivor —
   * r31-codex F4), and the retired ordinal leaves the map.
   */
  private absorb(survivor: number, other: number): void {
    const state = this.toolStates.get(survivor);
    const otherState = this.toolStates.get(other);
    if (state !== undefined && otherState !== undefined) {
      if (otherState.arguments !== '' || otherState.argumentsDone) {
        if (state.arguments !== '' || state.argumentsDone) {
          throw backendContractError('The local runtime wrote tool arguments the transport cannot place.', this.request.shape);
        }
        state.arguments = otherState.arguments;
        if (otherState.argumentsDone) state.argumentsDone = true;
      }
      if (!state.named && otherState.named) {
        state.name = otherState.name;
        state.named = true;
      }
      if (state.hasCallId && state.named) state.identified = true;
      if (otherState.placed) state.placed = true;
    }
    // Two states at two accepted positions are two items: folding them moved
    // the retired position's bytes under the survivor's call whichever side
    // survived, live and from the completed output (r45-codex). Only a state
    // with no position yet inherits the other's.
    const position = this.positions.get(other);
    const accepted = this.positions.get(survivor);
    if (accepted !== undefined && position !== undefined && accepted !== position) {
      throw backendContractError('The local runtime wrote tool arguments the transport cannot place.', this.request.shape);
    }
    if (position !== undefined && accepted === undefined) this.positions.set(survivor, position);
    this.positions.delete(other);
    // Id aliases follow the survivor; a POSITION alias follows it only at the
    // survivor's accepted position. Carrying every `#N` over left a stale
    // alias at the retired state's other position, and the real call that
    // later arrived there was bound to the survivor and vanished (r31-codex
    // F4).
    const kept = this.positions.get(survivor);
    for (const aliases of [this.itemOrdinals, this.callOrdinals]) {
      for (const [id, ordinal] of aliases) if (ordinal === other) aliases.set(id, survivor);
    }
    for (const [position, ordinal] of this.holders) {
      if (ordinal !== other) continue;
      if (position === kept) this.holders.set(position, survivor);
      else this.holders.delete(position);
    }
    this.toolStates.delete(other);
  }

  /** The distinct ordinals the ids resolve to, each id in its own namespace. */
  private boundOrdinals(ids: ToolIds): number[] {
    const bound = new Set<number>();
    const byItem = ids.itemId === undefined ? undefined : this.itemOrdinals.get(ids.itemId);
    const byCall = ids.callId === undefined ? undefined : this.callOrdinals.get(ids.callId);
    if (byItem !== undefined) bound.add(byItem);
    if (byCall !== undefined) bound.add(byCall);
    return [...bound];
  }

  private knownOrdinal(ids: ToolIds): number | undefined {
    return this.boundOrdinals(ids)[0];
  }

  private bindOrdinal(ordinal: number, ids: ToolIds): void {
    if (ids.itemId !== undefined) this.itemOrdinals.set(ids.itemId, ordinal);
    if (ids.callId !== undefined) this.callOrdinals.set(ids.callId, ordinal);
  }

  /**
   * The ordinal for an item of the COMPLETED output that names a call — by
   * id; else by the call holding its `output_index`, the array index being
   * the stream's position (both count every item — a dense function-call
   * coordinate fed into the positional keyspace minted a second ordinal for a
   * call already streamed, r27-codex, and re-adopted holders the doors above
   * had declined, r39-fable/r39-codex, until round 45 removed it); else a new
   * call claiming that index. An item that names nothing is placed by
   * `captureFinalOutput` itself: by the call holding its position first; then,
   * only when exactly one such item and one standing call no item placed
   * remain and their names do not conflict, as that pair; every other one is
   * a call without an identity, refused at completion.
   */
  private finalOutputOrdinal(outputIndex: number, ids: ToolIds): number {
    const known = this.knownOrdinal(ids);
    if (known !== undefined) {
      // Every id the item carries names the call from here on, as on a live
      // frame: a `call_id` the item supplied to a call the stream knew by its
      // item id alone was copied into the state but bound to nothing, and a
      // second item carrying that `call_id` minted a second call under the
      // same client identity (r37-codex).
      this.bindOrdinal(known, ids);
      // A call known by id whose frames never carried a position is placed
      // by the completed output; the anonymous holder at that position is
      // its own (the rule `toolOrdinal` applies live — r30-fable F1). An
      // item at another index adopts nothing there, and `captureFinalOutput`
      // refuses it once the listed-twice door has had its say (r41-codex).
      const survivor = this.adoptHolder(known, outputIndex);
      // The completed item hears the name and the `call_id` like a live
      // frame, on the survivor after the fold: another name, or another
      // `call_id`, for a known call is two calls named as one (r39-codex,
      // r42-fable, r41-codex).
      if (!this.namesAgree(ids.name, survivor) || !this.callIdAgrees(ids.callId, survivor)) {
        throw backendContractError('The local runtime named two tool calls as one.', this.request.shape);
      }
      return survivor;
    }
    // The completed output is in `output_index` order, so the item's array
    // index is the position the live events named, and the call holding that
    // position IS this item — the position is the protocol's own correlation
    // (`output[i]` is the item announced at `output_index: i`) — when its
    // name and `call_id` agree, as at the live door at a held position; an
    // unfamiliar item id on it binds, as on a live frame (refused at
    // completion as a call missing its `call_id` while the live equivalent
    // was accepted — r45-codex). Another name, or another `call_id`, is two
    // calls named as one: allocated beside the holder, a second call went
    // out at the one position (r45-codex), as an item-id-only holder's call
    // once went out twice, under the item id and under the `call_id`
    // (r28-codex F7). The holder is looked up by the item's array index, not
    // by its dense function-call position: with the events arriving out of
    // order the holder for backend position 1 lived at ordinal 0, and
    // inspecting ordinal 1 instead invented a third call (r27-codex).
    const holder = this.holders.get(outputIndex);
    if (holder !== undefined && this.toolStates.has(holder)) {
      if (!this.namesAgree(ids.name, holder) || !this.callIdAgrees(ids.callId, holder)) {
        throw backendContractError('The local runtime named two tool calls as one.', this.request.shape);
      }
      this.bindOrdinal(holder, ids);
      return holder;
    }
    // An item that names an unfamiliar call at a position nothing holds is a
    // call the stream never announced, and it still belongs to the client. It
    // records no position: the array lists each index once, so nothing can
    // resolve to it by position afterwards, and a later item resolving to it
    // by id is that call listed twice (`captureFinalOutput`).
    const ordinal = this.nextToolOrdinal;
    this.nextToolOrdinal = ordinal + 1;
    this.bindOrdinal(ordinal, ids);
    return ordinal;
  }

  push(event: CodexBackendEvent): LocalStreamEvent[] {
    const out = this.consume(event);
    // Whatever the event changed — a call finished, identified, or placed —
    // is judged against the vendor's progress once more, so a call released
    // by a position it learned late goes out on this frame.
    if (!this.settled) out.push(...this.announceFinished('moved'));
    return out;
  }

  private consume(event: CodexBackendEvent): LocalStreamEvent[] {
    const out: LocalStreamEvent[] = [];
    // A settled turn is finished, whatever noise follows: a delta after the
    // terminal frame used to extend the completed answer and change whether
    // the request succeeded (r23-codex). Failure frames after settlement
    // were already ignored below; every event is now.
    if (this.settled) return out;
    // Progress from a frame that names no call — narration, a reasoning or
    // message item. A tool event's position is not retained here: it counts
    // through `progress()`, from the accepted position of a call that can no
    // longer fold into another. Retained raw, a duplicate frame for a known
    // call, mislabelled with a higher position, advanced progress past the
    // call itself and closed the block `response.incomplete` then had to
    // leave open (r31-codex F5).
    if (!isToolEvent(event)) this.advance(explicitOutputIndex(event));
    if (event.response?.id) this.responseId = event.response.id;
    if (event.response?.model) this.model = event.response.model;
    if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
      if (event.delta !== '') out.push(...this.announceFinished('moved'));
      // Recorded against the calls announced so far — the same instant, and the
      // same counter, the stream itself uses to place its items. Deltas that
      // arrive with no call between them are ONE run: they open one block on
      // the wire, so they are one block in the body too.
      if (event.delta !== '') {
        const open = this.textRuns[this.textRuns.length - 1];
        if (open && open.afterCalls === this.announcedCalls) open.text += event.delta;
        else this.textRuns.push({ text: event.delta, afterCalls: this.announcedCalls });
      }
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
      const itemId = identityText(event.item.id, this.request.shape);
      const callId = identityText(event.item.call_id, this.request.shape);
      const name = identityText(event.item.name, this.request.shape);
      // Validated, not consumed: a present member that is not text is refused
      // here like everywhere else (read past, the call went out as `{}` —
      // r29-codex); whether the added snapshot's string is cumulative or
      // authoritative is unmeasured, so a string is left to the later frames.
      argumentsText(event.item.arguments, this.request.shape);
      const index = this.toolOrdinal(event, { itemId, callId, name });
      out.push(...this.announceFinished('moved'));
      const id = callId ?? itemId ?? `call_${index + 1}`;
      const named = itemId !== undefined || callId !== undefined;
      const state = this.toolStates.get(index) ?? this.newToolState(index, { id, name: name, anonymous: !named });
      // Same rule the `.done` branch states: never downgrade a `call_id` to
      // an item id — announced or not. A repeat of the item that omits it
      // would otherwise rename a call the client has already reported under,
      // and once the client has been told an identity (`started`), no later
      // frame changes it at all (r25-fable: a repeat carrying `call_2`/`other`
      // renamed the body's call behind a stream that had announced
      // `call_1`/`probe`). The item-id fallback stands in only while the
      // call has no `call_id`: gated on `identified` — a `call_id` AND a
      // name — a name-bearing frame joining a fold's survivor that owned the
      // `call_id` but no name yet put its item id where the `call_id` stood,
      // and the client was told to echo an id the backend never supplied as
      // one (r43-codex).
      if (!state.started) {
        if (callId !== undefined) state.id = callId;
        else if (!state.hasCallId) state.id = id;
      }
      // A call once named keeps that name, announced or not: a later frame
      // for the same call naming another tool is the vendor's contradiction,
      // kept out like a contradicting value — adopted, the last name won
      // before the announcement (r39-fable).
      if (name !== undefined && !state.named) {
        state.name = name;
        state.named = true;
      }
      if (named) state.anonymous = false;
      // `call_id` is the identity the client echoes back with the tool result;
      // an item id is not interchangeable with it, so a call is only worth
      // announcing once the backend has supplied one. It is a latch: a repeat of
      // the item that omits the `call_id` cannot un-name a call the client has
      // already been told about, and un-naming it stranded every later delta in
      // the buffer, since only an announced call is ever flushed.
      // Identity is a `call_id` AND a name: announcing on the id alone told
      // the client a call named `tool` (r25-codex).
      if (callId !== undefined) state.hasCallId = true;
      if (state.hasCallId && state.named) state.identified = true;
      this.toolStates.set(index, state);
      if (state.identified) out.push(...this.emitPending(index, state));
      return out;
    }
    if (event.type === 'response.function_call_arguments.done') {
      // The vendor's own finish event for a call's arguments, carrying the
      // whole value; it precedes `output_item.done`, which may then arrive
      // without an `arguments` member. Left unread (r23-codex), a delta after
      // it was folded into every stream while the bodies kept the done value.
      // One WITHOUT the member finishes nothing — but it still names its call
      // and its position, and the finished calls below that position are
      // announced on it like on any other event: returning before that held
      // the Messages stream behind the earlier call (r29-codex).
      const finished = argumentsText(event.arguments, this.request.shape);
      const itemId = identityText(event.item_id, this.request.shape);
      const index = this.toolOrdinal(event, { itemId });
      out.push(...this.announceFinished('moved'));
      const state = this.toolStates.get(index) ?? this.newToolState(index, {
        id: itemId,
        anonymous: itemId === undefined,
      });
      if (finished !== undefined && !state.argumentsDone) state.arguments = finished;
      this.toolStates.set(index, state);
      if (finished !== undefined) this.finishArguments(state);
      if (!state.identified) return out;
      out.push(...this.emitPending(index, state));
      return out;
    }
    if (event.type === 'response.function_call_arguments.delta') {
      const delta = argumentsText(event.delta, this.request.shape);
      if (delta === undefined) return out;
      const itemId = identityText(event.item_id, this.request.shape);
      const index = this.toolOrdinal(event, { itemId });
      out.push(...this.announceFinished('moved'));
      const state = this.toolStates.get(index) ?? this.newToolState(index, {
        id: itemId,
        anonymous: itemId === undefined,
      });
      // A call announced as finished is finished on every path: the stream
      // could not carry this delta (`emitArgumentExtension`), and folding it
      // into the completed result put bytes in the body that the closed block
      // never had (r22-fable F4). The signal promised "what you have is what
      // the body will report". Only the BYTES are dropped: a call this frame
      // identified — by folding a finished holder into it — is still
      // announced below, or the finish signal went out for a call the client
      // had never been told about (r31-fable F1).
      if (!state.argumentsDone) state.arguments += delta;
      this.toolStates.set(index, state);
      // Arguments that arrive before the call is named are held, because
      // announcing a placeholder identity is worse than waiting for the real
      // one. `emitPending` sends them the moment the name arrives.
      if (!state.identified) return out;
      out.push(...this.emitPending(index, state));
      return out;
    }
    if (event.type === 'response.output_item.done' && event.item?.type === 'function_call') {
      const itemId = identityText(event.item.id, this.request.shape);
      const callId = identityText(event.item.call_id, this.request.shape);
      const name = identityText(event.item.name, this.request.shape);
      const index = this.toolOrdinal(event, { itemId, callId, name });
      out.push(...this.announceFinished('moved'));
      const named = itemId !== undefined || callId !== undefined;
      const state = this.toolStates.get(index) ?? this.newToolState(index, {
        id: callId ?? itemId,
        name: name,
        anonymous: !named,
      });
      // Never downgrade an announced call_id to an item id: the client echoes
      // this value back, and the two surfaces would disagree about the call.
      // An identity the client has been told is frozen (`started`), as in
      // `captureFinalOutput` (r25-fable).
      if (!state.started) state.id = callId ?? state.id;
      if (name !== undefined && !state.named) {
        state.name = name;
        state.named = true;
      }
      if (named) state.anonymous = false;
      if (callId !== undefined) state.hasCallId = true;
      if (state.hasCallId && state.named) state.identified = true;
      // A call already announced as finished keeps the value it was finished
      // on; an item that names a different one afterwards is the vendor
      // contradicting itself, and the stream closed on the first value.
      const itemArguments = argumentsText(event.item.arguments, this.request.shape);
      if (itemArguments !== undefined && !state.argumentsDone) state.arguments = itemArguments;
      this.toolStates.set(index, state);
      if (state.identified) out.push(...this.emitPending(index, state));
      // The backend closing the item with its arguments fixes the call's
      // value; the client is told it is finished once a later item proves the
      // cut cannot hit it, or at the terminal frame (`announceFinished`). An
      // item closed WITHOUT its arguments promises
      // nothing: the call stays open and the completed output supplies the
      // value (r22-codex F3: a streamed `{}` was latched as final because it
      // happened to parse, and the completed `{"city":"Seoul"}` was refused).
      if (itemArguments !== undefined) this.finishArguments(state);
      return out;
    }
    if (event.type === 'response.completed') {
      const usage = usageFromResponses(event.response?.usage);
      if (usage) this.usage = usage;
      this.captureFinalOutput(event.response?.output);
      out.push(...this.announceFinished('terminal'));
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
      named: seed.name !== undefined,
      hasCallId: false,
      anonymous: seed.anonymous ?? false,
      argumentsDone: false,
      announcedDone: false,
      placed: false,
    };
  }

  /**
   * Emits what the client has not been told yet: the call's identity the first
   * time, then any arguments buffered while the call was still unnamed. Those
   * held deltas have no other way out — nothing re-sends them — so a call
   * announced after its arguments arrived reached the client as a fragment it
   * could not parse.
   */
  /**
   * The index a call carries on the wire: its position in announcement order,
   * which is the position `toolCalls()` gives it — one coordinate system for
   * the stream and the completed result. Events used to carry the transport's
   * first-seen ordinal, and a call identified late (its `call_id` arriving
   * after a later-seen call was announced) was then paired with the wrong
   * block by the writers: the cut call's block was stopped, Chat's streamed
   * `index` values read the two calls in the opposite order from the body
   * (r26-fable F2).
   */
  private wireIndex(state: ToolState): number {
    return (state.announcedAt ?? this.announcedCalls) - 1;
  }

  private emitPending(index: number, state: ToolState): LocalStreamEvent[] {
    const out: LocalStreamEvent[] = [];
    // Announced means told to the client (`announcedAt`), not `started`: a
    // state the completed output created is `started` — its identity frozen
    // — without a frame ever having gone out, and reading `started` as
    // announced signalled it finished at wire index -1 while the writers
    // then announced it again from the result (r32-codex).
    if (state.announcedAt === undefined) {
      state.started = true;
      // Counted HERE, at the first thing the client is told about a tool, not
      // when the backend opened state for one: arguments held until the call is
      // named arrive before any text, but they are not announced until after
      // whatever narration streamed while they waited. Counting at state
      // creation claimed the tool came first on exactly that path — the
      // contradiction between stream and body this whole rule exists to remove.
      this.announcedCalls += 1;
      state.announcedAt = this.announcedCalls;
      out.push({
        type: 'tool_call_delta',
        index: this.wireIndex(state),
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
   * `state.streamed` by the caller that needs to know — `announceFinished`,
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
    if (state.announcedDone) return [];
    if (!value.startsWith(state.streamed)) return [];
    if (value === state.streamed) return [];
    const pending = value.slice(state.streamed.length);
    state.streamed = value;
    return [{
      type: 'tool_call_delta',
      index: this.wireIndex(state),
      id: state.id,
      name: state.name,
      argumentsDelta: pending,
    }];
  }

  /**
   * The vendor has named the call's final value: later deltas are dropped on
   * every path. The signal that lets a surface close the call's block is NOT
   * sent here — `announceFinished` sends it once a later item, or the terminal
   * frame, proves the cut cannot hit this call — because a finish event
   * arrives before the transport knows whether the turn was cut off, and
   * closing on it normalized a cut call's empty bytes to `{}` and shut a
   * final block the cut-turn contract leaves open (r24-codex F4).
   */
  private finishArguments(state: ToolState): void {
    state.argumentsDone = true;
  }

  /**
   * At `response.completed`: every announced call the vendor finished is now
   * told to the client as finished — the value it was finished on, `{}` where
   * it wrote none (the direct API's own shape for a no-argument call), sent in
   * full before the signal, since a surface that closes on it can send nothing
   * afterwards. A value that does not extend what was streamed is the vendor
   * contradicting itself (declared): no signal, the end of the turn reconciles.
   * A cut-off turn (`response.incomplete`) sends no signal: its calls are
   * fragments by the vendor's own account, and the writers project them.
   *
   * Also sent once the vendor has moved on to a LATER item — narration, or
   * another call's events, at a higher output position — for every finished
   * call below it: the cut can only hit the turn's last item, so a call with
   * something after it is finished for good, and waiting for the terminal
   * frame held every later block of the Messages stream behind its open block
   * (r27-fable F3). Positions, not "any other item": a late frame for an
   * EARLIER item closed the block of the very call the cut then hit
   * (r28-fable F2). The vendor's progress is `progress()` — retained
   * non-tool positions and the accepted positions of the calls that cannot
   * fold into another — not the frame at hand: compared against the frame
   * alone, a call that learned its position — or finished — after the vendor
   * had moved on waited for the terminal frame (r30-codex). An event carrying
   * no position proves nothing, and a call whose position is unknown waits.
   */
  private announceFinished(scope: 'terminal' | 'moved'): LocalStreamEvent[] {
    const out: LocalStreamEvent[] = [];
    const progress = this.progress();
    for (const [index, state] of [...this.toolStates.entries()].sort(([a], [b]) => a - b)) {
      if (!state.identified || !state.argumentsDone || state.announcedDone) continue;
      if (scope === 'moved') {
        const position = this.positions.get(index);
        if (position === undefined || position >= progress) continue;
      }
      // A call identified and finished in one step — a holder folded into it
      // at completion — has not been announced: the identity and the bytes go
      // first, or the finish signal names a wire index the client never saw
      // (r31-fable F1).
      if (state.announcedAt === undefined) out.push(...this.emitPending(index, state));
      const complete = argumentsOrEmptyObject(state.arguments);
      out.push(...this.emitArgumentExtension(index, state, complete));
      if (state.streamed !== complete) continue;
      // Keep both baselines in one coordinate system: `emitPending` compares
      // later values against `arguments`, and a no-argument call's `arguments`
      // ('') disagreeing with its `streamed` ('{}') dropped later deltas.
      state.arguments = complete;
      state.announcedDone = true;
      out.push({
        type: 'tool_call_delta',
        index: this.wireIndex(state),
        id: state.id,
        name: state.name,
        argumentsDone: true,
      });
    }
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
    // Half an identity is no identity. A call the vendor never gave a
    // `call_id` went out under its item id or a minted `call_N` — an
    // identifier the backend never issued, which the client's tool result
    // then answers — and one it never named went out as the placeholder
    // `tool`, executable when the client happens to declare a tool by that
    // name (r27-fable F1, r27-codex). The live path withholds such a call
    // (`identified`); the completed result publishes nothing the stream
    // would not — both paths, since the buffered result is the stream's
    // completion too.
    for (const state of this.toolStates.values()) {
      if (!state.hasCallId || !state.named) {
        throw backendContractError('The local runtime reported a tool call missing its call_id or its name.', this.request.shape);
      }
    }
    // The wrapper reading's rule, taken to the native channel: a call the
    // client never declared is not a call it can answer — and a request that
    // declares no tools, or forbids a call (`tool_choice: none`; the vendor is
    // sent no tools), permits none at all: an empty allowed set, not no rule
    // (r28-codex F4).
    const declared = declaredToolNames(this.request);
    if (toolCalls.length > 0 && !declared) {
      throw backendContractError('The local runtime called a tool the request never declared.', this.request.shape);
    }
    if (declared) {
      for (const call of toolCalls) {
        if (!declared.has(call.name)) {
          throw backendContractError('The local runtime called a tool the request never declared.', this.request.shape);
        }
      }
    }
    return {
      id: this.responseId ?? this.id,
      model: this.model ?? this.request.model,
      // Text and tool calls coexist upstream — a model that narrates before
      // calling a tool sends both — and the streamed deltas already delivered
      // the narration, so dropping it here made streaming and non-streaming
      // clients disagree about what the model said.
      //
      // Not trimmed, for the same reason. The deltas went out untrimmed, so a
      // trim here is a transformation on ONE of the two paths: a narration
      // ending in a newline arrived as two different strings, and a
      // whitespace-only one gave the stream a message item the buffered body
      // did not have. The vendor returns what the model emitted; so does this.
      text: this.text,
      ...(this.stopReason ? { stopReason: this.stopReason } : {}),
      // The completed result flattens the turn's text into one string, so this
      // is the one ordering a non-streaming client cannot reconstruct — and
      // both ordered surfaces need it to agree with the stream. Clamped to the
      // calls the turn actually reports: a run recorded against a call the
      // final output does not list would otherwise address nothing.
      ...(toolCalls.length > 0 && this.textRuns.length > 0
        ? {
            textRuns: this.textRuns.map((run) => ({
              text: run.text,
              afterCalls: Math.min(run.afterCalls, toolCalls.length),
            })),
          }
        : {}),
      ...(this.reasoning ? { reasoning: this.reasoning } : {}),
      toolCalls,
      usage: this.usage ?? usageFor(this.request, this.text, toolCalls),
      latencyMs: Date.now() - this.startedAt,
    };
  }

  /**
   * The turn's calls in the order the client was told about them.
   *
   * This used to sort by the map key — first-seen order — while
   * `announcedCalls`, which `afterCalls` indexes into, counts announcements.
   * A call whose `call_id` arrives late (or never) is announced after one
   * that appeared later, and the two orders come apart: the same turn read
   * `[call_a, text, call_b]` buffered and `[call_b, text, call_a]` streamed,
   * and `response.output_item.done` went out as indices [1, 2, 0] — a client
   * told a later item finished before an earlier one.
   *
   * A call that was never announced has no place in that order, so it goes
   * after everything that was, keeping its own relative position.
   */
  private toolCalls(): readonly LocalToolCall[] {
    const byAnnouncement = (
      [leftKey, left]: [number, ToolState],
      [rightKey, right]: [number, ToolState],
    ): number => {
      if (left.announcedAt !== undefined && right.announcedAt !== undefined) {
        return left.announcedAt - right.announcedAt;
      }
      if (left.announcedAt !== undefined) return -1;
      if (right.announcedAt !== undefined) return 1;
      return leftKey - rightKey;
    };
    return [...this.toolStates.entries()]
      .sort(byAnnouncement)
      .map(([, state]) => ({
        id: state.id,
        name: state.name,
        // A call the backend cut off at its output limit is a fragment by the
        // backend's own account, and the direct API delivers it verbatim under
        // `finish_reason: "length"` (measured 2026-09-04); a completed call is
        // the bytes the vendor wrote, or `{}` where it wrote none.
        arguments: this.stopReason === 'max_tokens' ? state.arguments : argumentsOrEmptyObject(state.arguments),
      }));
  }

  private captureFinalOutput(output: readonly unknown[] | undefined): void {
    if (!Array.isArray(output)) return;
    const items: FinalCallItem[] = [];
    for (const [outputIndex, item] of output.entries()) {
      const obj = asRecord(item);
      if (obj?.type !== 'function_call') continue;
      items.push({
        outputIndex,
        arguments: argumentsText(obj.arguments, this.request.shape),
        itemId: identityText(obj.id, this.request.shape),
        callId: identityText(obj.call_id, this.request.shape),
        name: identityText(obj.name, this.request.shape),
      });
    }
    const anonymous = (item: FinalCallItem): boolean => item.itemId === undefined && item.callId === undefined;
    // Two passes. The items that name a call are placed first — with the
    // folds a completed item performs, which retire states — and only then
    // the items that name nothing, against the calls still standing. Judged
    // per item in array order, an anonymous item BEFORE the fold was
    // discarded by a count the fold had not yet corrected (r33-fable F2), as
    // it was by a count taken once before the loop (r32-fable F1).
    const streamed = new Set(this.toolStates.keys());
    const placed = (ordinal: number): boolean => this.toolStates.get(ordinal)?.placed === true;
    for (const item of items) {
      if (anonymous(item)) continue;
      // An item whose `id` and `call_id` name two DIFFERENT calls the stream
      // announced is the vendor contradicting itself; taking the first
      // identifier it recognized cross-wired the two calls' arguments in
      // the body behind a stream that had paired them right (r26-codex).
      // Position is not proof of identity and neither is half an identity:
      // the streamed state — what the client already acted on — wins, and
      // the item is left alone (declared, matrix §7 row 8).
      const itemOrdinal = item.itemId === undefined ? undefined : this.itemOrdinals.get(item.itemId);
      const callOrdinal = item.callId === undefined ? undefined : this.callOrdinals.get(item.callId);
      if (itemOrdinal !== undefined && callOrdinal !== undefined && itemOrdinal !== callOrdinal) {
        // ...unless one of the two is a state the client was never told
        // about: then the item is where the split identity meets, and it
        // folds into the one the client knows, as a live frame carrying
        // both would (r31-fable F2). Two announced states stay apart.
        const itemState = this.toolStates.get(itemOrdinal);
        const callState = this.toolStates.get(callOrdinal);
        const foldable = (itemState !== undefined && this.absorbable(itemState)) || (callState !== undefined && this.absorbable(callState));
        if (!foldable) continue;
        this.coalesce([itemOrdinal, callOrdinal]);
      }
      const index = this.finalOutputOrdinal(item.outputIndex, item);
      // An item resolving to a call an earlier item already placed is that
      // call listed twice: two array positions for one identity. Applied
      // again it silently collapsed into one call, a repair; minting a second
      // call put the same `call_id` on the wire twice (r37-codex). No door is
      // left open: the split identity meeting rounds 31–44 kept — a second
      // listing folding a streamed state into the call with no value or the
      // call's own — was one `call_id` at two indices, moving the call across
      // the array, and is that call listed twice (r45-codex).
      if (placed(index)) {
        throw backendContractError('The local runtime named two tool calls as one.', this.request.shape);
      }
      // `output[i]` is the item announced at `output_index: i`: an
      // identified item listed at an index other than its call's accepted
      // position is the vendor contradicting its own positions, refused as
      // arguments the transport cannot place. Correlated by its ids wherever
      // the array listed it, the answer was repaired into the stream's order
      // (r41-codex; the wire-positions row decides, and five round-26
      // fixtures that reordered the array now refuse).
      if (!this.positionAgrees(item.outputIndex, index)) {
        throw backendContractError('The local runtime wrote tool arguments the transport cannot place.', this.request.shape);
      }
      this.applyFinalItem(item, index);
      this.toolStates.get(index)!.placed = true;
    }
    // An anonymous item has nothing but its position, and the position is the
    // protocol's own correlation: `output[i]` is the item announced at
    // `output_index: i`, and the call holding that position is this call
    // whatever the two views count — the prefix gate below still protects the
    // value (r31-codex F6). Every item a position places is placed before any
    // is aligned by count, so the count cannot book that call again.
    const unplaced: FinalCallItem[] = [];
    for (const item of items.filter(anonymous)) {
      const holder = this.holders.get(item.outputIndex);
      if (holder === undefined || !this.toolStates.has(holder)) {
        unplaced.push(item);
        continue;
      }
      // An anonymous item naming a DIFFERENT tool than the call at its
      // position is two calls named as one — refused, like every other
      // door. Kept out, the streamed calls stood and a call the runtime
      // wrote vanished under a 200 (r41-codex; rounds 26–35 kept it out).
      if (!this.namesAgree(item.name, holder)) {
        throw backendContractError('The local runtime named two tool calls as one.', this.request.shape);
      }
      // (A call holds one position, and an identified listing of it sits at
      // that position or is refused above — so no anonymous item can find a
      // placed call here; the position pass needs no listed-twice door.)
      this.applyFinalItem(item, holder);
      this.toolStates.get(holder)!.placed = true;
    }
    // The rest align by count, and only when the two views agree on how many
    // calls are left: the streamed calls still standing after the folds
    // above that no item placed — a state this capture added for an item the
    // stream never showed is not one of them — against the items no position
    // placed. Counted whole, an item that ADDS a call the stream never showed
    // outnumbered the standing calls and the item completing the index-less
    // streamed call was discarded (r34-fable F1). The count is identity only
    // when it leaves nothing to choose: ONE item no position placed and ONE
    // standing call no item placed, agreeing on the name when the item gives
    // one and on the position when the call has one (`positionAgrees`,
    // r37-fable) — not the k-th to the k-th, a call a position may already have
    // placed (r33-fable F1), and not two to two in arrival order, which handed
    // each call the other's arguments when both had streamed `{` and the
    // completed output listed them the other way round (r35-codex). Every
    // other item left is a call of its own: one the completed output reports
    // without an identity, refused at `completed()` as a call missing its
    // `call_id`. Discarded instead, two calls the runtime wrote vanished under
    // a 200 (r34-codex). With nothing streamed, every item is a call of its
    // own the same way.
    const standing = [...streamed].filter((ordinal) => this.toolStates.has(ordinal));
    const unmatched = standing.filter((ordinal) => !placed(ordinal));
    const only = unplaced.length === 1 && unmatched.length === 1 ? unmatched[0] : undefined;
    for (const item of unplaced) {
      const index = only !== undefined && this.namesAgree(item.name, only) && this.positionAgrees(item.outputIndex, only) ? only : this.nextToolOrdinal;
      if (index >= this.nextToolOrdinal) this.nextToolOrdinal = index + 1;
      this.applyFinalItem(item, index);
    }
  }

  /**
   * Whether the call at `index` may sit at the item's output position: it
   * has no accepted position yet, or that is the one. The pair is bound by
   * the rule `adoptHolder` applies to a call named by id — a call claims
   * only its accepted position — or the one remaining item at another index
   * handed the call that index's arguments under a 200 (r37-fable).
   */
  private positionAgrees(outputIndex: number, index: number): boolean {
    const accepted = this.positions.get(index);
    return accepted === undefined || accepted === outputIndex;
  }

  /**
   * Whether `callId`, when given, is the `call_id` the call at `index` already
   * carries. Latched like the name: the client echoes it back, and a frame
   * or item naming another for the same call — the name unchanged, so the
   * name doors heard nothing — kept the announced id and delivered, a
   * repair (r41-codex; rounds 23–25 declared it).
   */
  private callIdAgrees(callId: string | undefined, index: number): boolean {
    const state = this.toolStates.get(index);
    return callId === undefined || state === undefined || !state.hasCallId || state.id === callId;
  }

  /** Whether `name`, when given, is the name the call at `index` already carries. */
  private namesAgree(name: string | undefined, index: number): boolean {
    const state = this.toolStates.get(index);
    return name === undefined || state === undefined || !state.named || state.name === name;
  }

  /**
   * Applies one completed item to the call its caller correlated it with —
   * by id, by the call holding its position, or as the one remaining pair —
   * creating the state for a call the stream never showed. An identity the
   * client was told is frozen. Arguments: an anonymous item may only fill in
   * what the stream never delivered (an absent value, or a value the streamed
   * bytes are a prefix of); an identified item may replace the pending value
   * until the vendor's own finish event has fixed it, and a replacement that
   * disagrees with the streamed bytes is the declared stream/body
   * contradiction (matrix row 8). Nothing is repaired either way.
   */
  private applyFinalItem(item: FinalCallItem, index: number): void {
    const anonymous = item.itemId === undefined && item.callId === undefined;
    const existing = this.toolStates.get(index);
    const state = existing ?? {
      ...this.newToolState(index, {
        id: item.callId,
        name: item.name,
      }),
      started: true,
      hasCallId: item.callId !== undefined,
      identified: item.callId !== undefined && item.name !== undefined,
    };
    // Correlation is not proof of identity for an anonymous item: with two
    // calls listed in an order the stream did not use, overwriting here gave
    // each streamed call the OTHER call's name and arguments under its own
    // id, so tool results came back answering the wrong call.
    const mayReplace = !anonymous || existing === undefined;
    // An identity the client has already been told is a promise: a client
    // that reported `call_1`/`probe` from the stream cannot be handed
    // `call_2`/`other` by the body (r23-codex). The completed output may
    // supply identity to a call never announced, not rename one.
    if (item.callId !== undefined && !state.started) {
      state.id = item.callId;
      state.hasCallId = true;
    }
    if (item.name !== undefined && !state.named) {
      state.name = item.name;
      state.named = true;
    }
    if (!anonymous) state.anonymous = false;
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
    // ...and for a call already finished by the vendor's own event, only a
    // value that EXTENDS the finished one — a fragment finish event
    // (`{"city":`) completed by the output's `{"city":"Seoul"}` — and only
    // while the finish signal has not gone out, so the stream can still
    // carry the rest (r27-fable F2). Once it has (the vendor moved on
    // before completing: `announcedDone`), the closed block cannot take
    // the rest, and taking it into the body split the two paths (r28:
    // Fable F1, codex F1): the finished value is kept, and the turn falls
    // into the declared contradiction lane. Anything else keeps the
    // finished value.
    if (
      item.arguments !== undefined
      && (state.argumentsDone
        ? (!state.announcedDone && item.arguments.startsWith(state.arguments))
        : (mayReplace || item.arguments.startsWith(state.arguments)))
    ) {
      state.arguments = item.arguments;
    }
    this.toolStates.set(index, state);
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
  private readonly verbosity: NormalizedVerbosity | undefined;
  private readonly codexHome: string;
  private readonly onImageAttempt?: (diagnostic: CodexBackendImageAttemptDiagnostic) => void;
  private readonly honorRequestModel: boolean;
  private readonly codexCommand?: string;
  private readonly runtimeCwd?: string;

  constructor(options: CodexBackendTransportOptions) {
    this.model = options.model ?? DEFAULT_CODEX_BACKEND_MODEL;
    this.timeoutMs = options.timeoutMs;
    this.reasoningEffort = options.reasoningEffort;
    // No default. `text.verbosity` is a length-governing field on an endpoint
    // whose own no-field default we have not observed, and the direct API sends
    // it only when the caller does. Filling it in with 'medium' made the adapter
    // the author of a parameter nobody set — the same class as injecting prose,
    // one layer down. An operator who wants a floor passes one explicitly.
    this.verbosity = options.verbosity;
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
    const events = this.responseEvents(request, signal)[Symbol.asyncIterator]();
    let unwinding = false;
    try {
      for (;;) {
        const next = await events.next();
        if (next.done) break;
        for (const local of state.push(next.value)) yield local;
        // The terminal frame ends the read: nothing after it changes a settled
        // turn (r24), and a transport failure after it overturned a completed
        // answer into a 500 (r25-codex).
        if (state.isSettled()) break;
      }
    } catch (err) {
      unwinding = true;
      throw err;
    } finally {
      // Ownership of the unread body ends here either way. Once the turn's
      // outcome is decided — the terminal frame settled it, or a refusal
      // thrown from the pump (`push`) is unwinding — teardown must not gate
      // its delivery: a rejection from cancelling what was left unread is
      // noise (it turned a completed answer into a 500 with the usage lost,
      // r27-codex, and a declared 502 into a 500 carrying the body's teardown
      // message, r29-fable F2), and a cancellation that never settled held a
      // decided outcome back indefinitely (r30-codex). The cancellation still
      // runs; its result is consumed. A consumer-driven end with no outcome
      // awaits it, and its rejection is that end's.
      const teardown = events.return?.(undefined);
      if (state.isSettled() || unwinding) {
        void Promise.resolve(teardown).catch(() => undefined);
      } else {
        await teardown;
      }
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
    await prepareRequestedSize(request);
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
      for (const image of result.images) images.push(await realizeRequestedSize(request, image));
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
    await prepareRequestedSize(request);
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
                image: postprocessFlatGraphicImageIfNeeded(request, await realizeRequestedSize(request, local.image)),
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
      tools: [await codexBackendImageGenerationTool(request)],
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
      // The mask is not an input image: it rides on the tool as
      // `input_image_mask`. Attached here as well, it was one more reference
      // picture the model had to be told in prose was actually a mask.
      images: request.images,
    }],
    stream: false,
    streamOptions: { includeUsage: false, includeObfuscation: false },
    jsonMode: false,
    tools: [],
    toolChoice: { type: 'auto' },
    raw: request.raw,
  };
}

// Every Images API option with a slot on the backend's `image_generation` tool
// is sent on that slot, and only when the caller sent it. The backend validates
// this declaration strictly (an unknown key or an out-of-enum value is a 400
// naming `tools[0].<field>`, probed live 2026-08-29), so what it accepts here
// is what the image model receives. `background: transparent` and
// `input_fidelity` are accepted by the schema and then refused by the backend
// image model itself (`image_generation_user_error`) — that refusal is the
// backend's to make and is forwarded as such, not pre-empted or asked for in
// prose.
async function codexBackendImageGenerationTool(
  request: OpenAiImageGenerationRequest,
): Promise<Record<string, unknown>> {
  const quality = codexBackendImageQuality(request.quality);
  return {
    type: 'image_generation',
    action: request.operation === 'generation' ? 'generate' : 'edit',
    ...(request.size && request.size !== 'auto' ? { size: request.size } : {}),
    ...(quality ? { quality } : {}),
    ...(request.outputFormat ? { output_format: request.outputFormat } : {}),
    ...(request.outputCompression !== undefined ? { output_compression: request.outputCompression } : {}),
    ...(request.background ? { background: request.background } : {}),
    ...(request.moderation ? { moderation: request.moderation } : {}),
    ...(request.inputFidelity ? { input_fidelity: request.inputFidelity } : {}),
    ...(request.mask ? { input_image_mask: { image_url: await responseImageUrl(request.mask) } } : {}),
  };
}

function codexBackendImageQuality(quality: string | undefined): 'low' | 'medium' | 'high' {
  if (quality === 'low') return 'low';
  if (quality === 'medium') return 'medium';
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
  const labels = toolResultImageLabels(message);
  const toolItems = await responseToolHistoryItems(message, labels);
  if (toolItems) {
    // Whatever the SEQUENCE placed has already left at its own position — what
    // a result returned, beside that result, and a block of the turn's own, at
    // the point the client wrote it. What can be left over is a picture no part
    // claims, which the normalizer no longer produces: it is a request built by
    // hand, with images on the message and none of them in the turn. Nothing is
    // dropped on that path either — it arrives after the sequence, which is
    // where every message image used to arrive.
    const placed = toolTurnImages(message);
    const messageImages = message.images.filter((image) => !placed.has(image));
    if (messageImages.length === 0) return toolItems;
    return [
      ...toolItems,
      {
        type: 'message',
        role: 'user',
        content: await Promise.all(messageImages.map((image) => responseImagePart(image))),
      },
    ];
  }
  return [{
    type: 'message',
    role: responseRole(message.role),
    content: await responseContent(message),
  }];
}

/** Every picture the turn's own sequence places, by identity, not by index. */
function toolTurnImages(message: NormalizedMessage): Set<NormalizedImage> {
  const placed = new Set<NormalizedImage>();
  for (const part of message.tool?.parts ?? []) {
    if (part.kind === 'result') {
      for (const image of toolResultImages(part.result)) placed.add(image);
    } else if (part.kind === 'image') {
      placed.add(part.image);
    }
  }
  return placed;
}

/**
 * An ordinary message as this API's content array — the client's own sequence.
 *
 * It used to be the flattened text, then every picture: all the text joined
 * into one block and the pictures collected behind it. A client who showed a
 * picture and then asked about it had the question delivered ahead of the
 * picture, and `["THIS_IS_A", <red>, "THIS_IS_B", <blue>]` arrived as one
 * merged caption with both pictures after it — nothing saying which caption
 * named which picture, so the model could only match them by position. This
 * surface is an ORDERED array; the order in it is now the client's.
 *
 * Call and result parts cannot reach here: a message carrying either is a tool
 * turn, and `responseInputItemsForMessage` sends those to the item projection
 * before this function is reached.
 */
async function responseContent(message: NormalizedMessage): Promise<unknown[]> {
  const content: unknown[] = [];
  const textType = message.role === 'assistant' ? 'output_text' : 'input_text';
  for (const part of messageParts(message)) {
    if (part.kind === 'text') {
      if (part.text) content.push({ type: textType, text: part.text });
    } else if (part.kind === 'image') {
      content.push(await responseImagePart(part.image));
    }
  }
  return content.length > 0 ? content : [{ type: textType, text: '' }];
}

/**
 * The tool turns of the conversation, as this API's own items.
 *
 * Built from the structure the normalizer recorded when it flattened the turn,
 * never from the flattened TEXT. This used to re-parse `message.content` for
 * `[tool result]` / `[assistant tool_call]` lines, gated on a boolean saying
 * this proxy had written that grammar. The gate was honest about WHO wrote the
 * message and said nothing about WHERE the grammar was, so a GENUINE tool
 * result whose OUTPUT contained those lines — a fetched page, a file, a
 * command's stdout, none of it authored by the client — split into a second
 * `function_call_output` under a call id nobody sent, and the real output was
 * truncated at the marker. Whoever controls a tool's output is not whoever
 * controls the conversation; structure carried is structure that cannot be
 * forged.
 *
 * Images used to disqualify a message from being read as tool history at all,
 * which left the `function_call` before it unanswered — a 400 here, and prose
 * saying `[tool result]` in the prompt if it got through. The images come back
 * beside these items instead; see `responseInputItemsForMessage`.
 */
async function responseToolHistoryItems(
  message: NormalizedMessage,
  labels: Map<NormalizedImage, string>,
): Promise<unknown[] | null> {
  const { tool } = message;
  if (!tool) return null;
  // The turn's own sequence, projected position for position. It used to be
  // read out of three groups — narration, then every call, then every result —
  // so where the prose sat was a GUESS the projection made rather than
  // something the turn could say. `[call, text, call]` came out
  // text-then-both-calls, and `[call, text]` was reordered outright.
  //
  // The prose is part of the turn and must survive it either way: dropping a
  // "let me check…" before a call turned the whole message into prose, so the
  // call vanished and the result answering it had nothing to pair with — a 400
  // from this API. And one output per result, because parallel calls answer in
  // a single turn: one result for the whole message left the rest unanswered,
  // the other half of the same 400.
  const role = responseRole(message.role);
  const textType = role === 'assistant' ? 'output_text' : 'input_text';
  const items: unknown[] = [];
  for (const part of tool.parts) {
    if (part.kind === 'call') {
      items.push({
        type: 'function_call',
        call_id: part.call.id,
        name: part.call.name,
        arguments: part.call.arguments,
      });
    } else if (part.kind === 'result') {
      // A result's OWN sequence, split where this API's shape forces a split.
      //
      // `function_call_output.output` is one STRING: a picture cannot ride
      // inside the answer, and neither can the prose that came after a picture,
      // because that prose would then be read ahead of it. So the output
      // carries the result's text UP TO its first picture, and everything from
      // that picture on — the picture, and any words that followed it — arrives
      // in the companion message that comes immediately after, in the client's
      // order. Sending the whole text and then the pictures is what delivered
      // `[text, image, text]` as `out("BEFORE\nAFTER") image`, with the second
      // sentence ahead of the picture it followed.
      //
      // Beside THIS result, not after the whole turn: appending every one of the
      // message's images after the last part put the picture a parallel turn's
      // FIRST call returned behind the SECOND call's output, with nothing saying
      // which call it answered. The caption is the labeller's, not a second
      // grammar written here.
      const inner = part.result.parts ?? [];
      const firstImage = inner.findIndex((entry) => entry.kind === 'image');
      items.push({
        type: 'function_call_output',
        call_id: part.result.callId,
        // `output` verbatim where no picture splits it — it is the whole of a
        // result whose text this runtime stringified rather than read as blocks.
        output: firstImage < 0 ? part.result.output : resultText(inner.slice(0, firstImage)),
      });
      if (firstImage >= 0) {
        const content: unknown[] = [];
        for (const entry of inner.slice(firstImage)) {
          if (entry.kind === 'image') {
            const label = labels.get(entry.image);
            if (label) content.push({ type: 'input_text', text: label });
            content.push(await responseImagePart(entry.image));
          } else if (entry.kind === 'text' && entry.text) {
            content.push({ type: 'input_text', text: entry.text });
          }
        }
        if (content.length > 0) items.push({ type: 'message', role: 'user', content });
      }
    } else if (part.kind === 'image') {
      // A picture the turn carried as a block of its own. It answers no call,
      // so it gets no caption — attributing it to one would be the invention
      // the labels exist to prevent — but it does have a POSITION, and this is
      // it. Appended after the sequence instead, the picture a client put
      // between the first result and the prose after it arrived behind the LAST
      // result, in an order the client never wrote.
      items.push({ type: 'message', role: 'user', content: [await responseImagePart(part.image)] });
    } else if (part.text) {
      // In the voice of the turn it belongs to: prose beside a call is the
      // assistant's, prose beside a result is the user's — which is the
      // message's own role, not a rule about calls and results.
      items.push({ type: 'message', role, content: [{ type: textType, text: part.text }] });
    }
  }
  return items.length > 0 ? items : null;
}

/**
 * A run of a result's own blocks as the one string `output` can be.
 *
 * `\n` is the separator both content readers join a result's text runs with, so
 * a result with no picture in it flattens here to exactly the bytes `output`
 * already holds.
 */
function resultText(parts: readonly NormalizedPart[]): string {
  return parts
    .flatMap((part) => (part.kind === 'text' && part.text ? [part.text] : []))
    .join('\n');
}

async function responseImagePart(image: NormalizedImage): Promise<unknown> {
  return {
    type: 'input_image',
    image_url: await responseImageUrl(image),
    ...(image.detail ? { detail: image.detail } : {}),
  };
}

async function responseImageUrl(image: NormalizedImage): Promise<string> {
  if (image.source.type === 'url') return image.source.url;
  if (image.source.type === 'base64') {
    return `data:${image.source.mediaType};base64,${image.source.data}`;
  }
  if (image.source.type === 'path') {
    const mediaType = image.source.mediaType ?? mediaTypeForPath(image.source.path);
    const data = await readFile(image.source.path, 'base64');
    return `data:${mediaType};base64,${data}`;
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
  fallbackVerbosity: NormalizedVerbosity | undefined,
): Record<string, unknown> | undefined {
  const verbosity = request.verbosity ?? fallbackVerbosity;
  const text: Record<string, unknown> = {
    ...(verbosity ? { verbosity } : {}),
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
  // Nothing to say means say nothing: an empty `text` object is still a field
  // the caller did not send.
  return Object.keys(text).length > 0 ? text : undefined;
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

/** Whether the event is one `toolOrdinal` correlates to a function call. */
function isToolEvent(event: CodexBackendEvent): boolean {
  return event.type === 'response.function_call_arguments.delta'
    || event.type === 'response.function_call_arguments.done'
    || ((event.type === 'response.output_item.added' || event.type === 'response.output_item.done') && event.item?.type === 'function_call');
}

/** The output position an event actually carries, or nothing. */
function explicitOutputIndex(event: CodexBackendEvent): number | undefined {
  return typeof event.output_index === 'number' && Number.isFinite(event.output_index)
    ? event.output_index
    : undefined;
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
/**
 * A call the backend finished without writing any arguments is the direct
 * API's `"{}"`. Everything else — whitespace included — is the bytes the
 * vendor wrote, JSON or not: the direct API delivers what the model produced
 * (its own documentation says the arguments may not be valid JSON), and
 * wrapping what did not parse as `{"input": …}` published an object the model
 * never produced while the stream had already carried the bytes (round 21).
 * Reading `"   "` as "wrote none" put `{}` in the body behind a stream that
 * had carried three spaces (round 22).
 */
function argumentsOrEmptyObject(value: string): string {
  return value === '' ? '{}' : value;
}

/**
 * A call's arguments as the vendor wrote them: absent, or text. A present
 * member of any other type is the vendor breaking its own protocol — read
 * past it, the call went out as `{}` for an object the runtime had actually
 * supplied (r27-codex). Refused, never re-serialized: the bytes are the answer.
 */
function argumentsText(value: unknown, shape: NormalizedRequest['shape']): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  throw backendContractError('The local runtime wrote tool arguments that are not text.', shape);
}

/**
 * An identity member — item `id`, `call_id`, `name`, a delta's `item_id` — as
 * the vendor wrote it: absent, or text. Presence alone passed the identity
 * gate, so an object-valued `call_id` crossed the `LocalToolCall` boundary and
 * went out as the id the client must echo, on every surface (r29-codex).
 */
function identityText(value: unknown, shape: NormalizedRequest['shape']): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  throw backendContractError('The local runtime named a tool call with something that is not text.', shape);
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
