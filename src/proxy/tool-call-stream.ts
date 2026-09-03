import type { LocalStreamEvent, LocalToolCall } from './types.js';

interface ToolCallSnapshot {
  readonly index: number;
  /** Whether the call object's closing brace has arrived. */
  readonly closed: boolean;
  readonly id?: string;
  readonly name?: string;
  readonly arguments: string;
}

interface ToolCallState {
  id?: string;
  name?: string;
  arguments: string;
  started: boolean;
}

export class ToolCallDeltaExtractor {
  /**
   * What this turn's contract permits, so that nothing is released which the
   * response path will refuse — bytes a client cannot un-read.
   *
   * `requiresCall`: `tool_choice` obliges a call, so a turn that does not
   * carry one is refused. Testing only `status !== 'tool_calls'` was not the
   * same condition the backstop tests: `{"status":"tool_calls","toolCalls":[]}`
   * passed this gate and was refused anyway, delivering the whole answer first.
   *
   * `jsonMode`: the client asked for JSON, so on an ANSWER turn the wrapper's
   * `json` member is the answer and its `text` is not — the body returns
   * `{"verdict":"True"}` where the stream was sending `Here is the verdict.`
   * On a tool_calls turn `text` is narration and still streams.
   */
  constructor(private readonly policy: { requiresCall?: boolean; jsonMode?: boolean } = {}) {}

  /** Whether the wrapper has committed to at least one tool call. */
  private carriesAClosedCall(): boolean {
    return readToolCallSnapshots(this.raw).some((snapshot) => snapshot.closed);
  }

  private raw = '';
  private readonly states = new Map<number, ToolCallState>();
  /** How much of the wrapper's answer text has already been streamed. */
  private streamedText = '';

  push(delta: string): LocalStreamEvent[] {
    if (!delta) return [];
    this.raw += delta;
    // The wrapper carries the ANSWER too, and a turn that answers is the common
    // one once tools stay available for the whole conversation. Reading only
    // its tool calls meant such a turn streamed nothing at all and arrived in
    // one piece when it finished — the client sat silent through the wait.
    // Nothing leaves this decoder until the wrapper says what it is.
    //
    // `parseBackendOutput` keys everything on `status`: it reports calls only
    // for `tool_calls`, and a string that is not a wrapper at all comes back
    // as the answer verbatim. This decoder used to read `toolCalls` whatever
    // `status` said, so a wrapper reading `{"status":"message", …,
    // "toolCalls":[one call]}` streamed a `tool_use` block the same turn's
    // buffered body denied — a call the client would execute and echo a
    // result for, delivered next to `stop_reason: "end_turn"`.
    //
    // Holding the TEXT to the same gate is what keeps the fix from becoming
    // the next disagreement: releasing text early and calls late would reorder
    // any wrapper that writes `status` after `toolCalls`. Until `status`
    // closes, this string is not yet known to be a wrapper, so none of its
    // fields are its answer.
    const status = readClosedStringProperty(this.raw, 'status');
    if (status === undefined) return [];
    // A status the schema does not allow is refused downstream as a wrapper
    // with no usable status, so nothing about that turn may be released.
    if (status !== 'message' && status !== 'tool_calls') return [];
    // A required turn is refused unless it actually carries a call, which is
    // the condition the backstop tests — not merely what `status` claims.
    if (this.policy.requiresCall && (status !== 'tool_calls' || !this.carriesAClosedCall())) return [];
    // In JSON mode the answer turn's answer is `json`, delivered whole by the
    // completed result; `text` there is not the answer and must not be sent.
    const textEvents = this.policy.jsonMode && status !== 'tool_calls' ? [] : this.textDeltas();
    const callEvents = status === 'tool_calls' ? this.toolCallDeltas() : [];
    // Which of the two came first is the wrapper's to say, not this decoder's.
    // Emitting text first unconditionally made the answer depend on where the
    // backend cut its deltas: a `toolCalls`-before-`text` wrapper streamed
    // [call, text] when it arrived in small pieces and [text, call] when a
    // whole delta carried both, while its buffered body said [call, text]
    // either way. One turn, two orders, chosen by chunk boundary.
    return wrapperCallsPrecedeText(this.raw)
      ? [...callEvents, ...textEvents]
      : [...textEvents, ...callEvents];
  }

  private toolCallDeltas(): LocalStreamEvent[] {
    const out: LocalStreamEvent[] = [];
    for (const snapshot of readToolCallSnapshots(this.raw)) {
      const state = this.states.get(snapshot.index) ?? {
        arguments: '',
        started: false,
      };
      state.id = snapshot.id ?? state.id;
      state.name = snapshot.name ?? state.name;
      // A closed call object has said everything it is going to say, so a
      // missing or blank identity is now final rather than pending. The body
      // substitutes `call_N` / `tool` for exactly this case, and a call the
      // body reports but the stream never announced is a call the two orders
      // disagree about: buffered `[tool_use, text]`, streamed `[text,
      // tool_use]`. The substitution has to match `normalizeToolCall`.
      if (snapshot.closed) {
        if (!state.id?.trim()) state.id = `call_${snapshot.index + 1}`;
        if (!state.name?.trim()) state.name = 'tool';
      }

      if (!state.started && state.id && state.name) {
        state.started = true;
        out.push({
          type: 'tool_call_delta',
          index: snapshot.index,
          id: state.id,
          name: state.name,
          argumentsDelta: '',
        });
      }

      const canEmitArguments = state.started || Boolean(state.id && state.name);
      if (snapshot.arguments !== state.arguments && canEmitArguments) {
        const argumentsDelta = snapshot.arguments.startsWith(state.arguments)
          ? snapshot.arguments.slice(state.arguments.length)
          : snapshot.arguments;
        state.arguments = snapshot.arguments;
        if (argumentsDelta) {
          out.push({
            type: 'tool_call_delta',
            index: snapshot.index,
            id: state.id,
            name: state.name,
            argumentsDelta,
          });
        }
      }
      this.states.set(snapshot.index, state);
    }
    return out;
  }

  /**
   * The part of the wrapper's `text` the client has not seen. Read from the
   * growing snapshot the same way arguments are: what a partial value decodes
   * to can only grow, and anything that contradicts what was already sent is
   * not sent again.
   */
  private textDeltas(): LocalStreamEvent[] {
    const text = readStringProperty(this.raw, 'text')?.value;
    if (text === undefined || text === this.streamedText) return [];
    if (!text.startsWith(this.streamedText)) return [];
    const delta = text.slice(this.streamedText.length);
    this.streamedText = text;
    return delta ? [{ type: 'text_delta', delta }] : [];
  }
}

export class KnownToolArgumentsDeltaExtractor {
  private started = false;
  private sawArgument = false;
  /** Whether the payload's opening character means `normalizeToolArgumentsText` will leave it alone. */
  private passesThrough = false;

  constructor(
    private readonly index: number,
    private readonly id: string,
    private readonly name: string,
  ) {}

  /**
   * The call is announced at the first byte; its arguments are streamed only
   * when the buffered reading will report the same bytes back.
   *
   * On this path the whole CLI answer IS the arguments, and the buffered
   * reading puts it through `normalizeToolArgumentsText`, which unwraps a JSON
   * *string* holding the object and wraps a non-JSON answer as
   * `{"input": …}`. Forwarding raw bytes for those two shapes made the two
   * readings of one turn disagree: `"{\"city\":\"Seoul\"}"` accumulated to a
   * quoted string whose `.city` is undefined while the body reported
   * `{"city":"Seoul"}`, and a prose answer accumulated to something that is not
   * JSON at all. The end-of-turn reconciler cannot repair either, because it
   * only appends when the final value STARTS WITH what was streamed.
   *
   * Which of the three normalizations applies is decided by the first
   * non-whitespace character: `{` or `[` is passed through unchanged, anything
   * else is rewritten. So a payload that opens as an object or array streams
   * live exactly as before, and any other opening withholds its arguments and
   * lets the completed result deliver them whole. Nothing is retracted either
   * way.
   */
  push(delta: string): LocalStreamEvent[] {
    const argumentsDelta = this.normalizeDelta(delta);
    if (!argumentsDelta) return [];
    const out: LocalStreamEvent[] = [];
    if (!this.started) {
      this.started = true;
      this.passesThrough = argumentsDelta.startsWith('{') || argumentsDelta.startsWith('[');
      out.push({
        type: 'tool_call_delta',
        index: this.index,
        id: this.id,
        name: this.name,
        argumentsDelta: '',
      });
    }
    if (!this.passesThrough) return out;
    out.push({
      type: 'tool_call_delta',
      index: this.index,
      id: this.id,
      name: this.name,
      argumentsDelta,
    });
    return out;
  }

  private normalizeDelta(delta: string): string {
    if (this.sawArgument) return delta;
    const trimmed = delta.replace(/^\s+/, '');
    if (trimmed) this.sawArgument = true;
    return trimmed;
  }
}

export function missingToolCallArgumentDelta(
  streamedArguments: string,
  finalCall: LocalToolCall,
): string {
  return finalCall.arguments.startsWith(streamedArguments)
    ? finalCall.arguments.slice(streamedArguments.length)
    : '';
}

/**
 * Whether the wrapper writes its calls before its narration.
 *
 * The wrapper's own key order is the one artifact BOTH readings of a turn see
 * — this extractor decodes the string left to right, the buffered parse holds
 * all of it — so it is what decides production order on both sides. Reading it
 * here rather than in each reader is the point: two rules for one turn is how
 * the stream and the body came to contradict each other.
 *
 * The wrapper holds its calls in one array and its narration in one field, so
 * it can only say all-before or all-after; a backend that can genuinely
 * interleave the two reports the count itself.
 */
export function wrapperCallsPrecedeText(raw: string): boolean {
  const calls = wrapperKeyIndex(raw, 'toolCalls');
  const narration = wrapperKeyIndex(raw, 'text');
  return calls !== -1 && (narration === -1 || calls < narration);
}

/**
 * Where a KEY of that name sits, or -1. A plain substring search reads the key
 * order right up until some other value spells one of the two names, and then
 * it reads a position that is not a key at all — at which point both readers
 * agree on the same wrong answer and the order goes back to depending on the
 * chunking. The value of a string field is stepped over rather than searched,
 * so a tool named `text` or an `arguments` payload with a `text` field of its
 * own cannot pose as the wrapper's narration.
 */
function wrapperKeyIndex(raw: string, key: string): number {
  for (const entry of topLevelKeys(raw)) {
    if (entry.key === key) return entry.keyIndex;
  }
  return -1;
}

function readToolCallSnapshots(raw: string): ToolCallSnapshot[] {
  const arrayStart = findToolCallsArray(raw);
  if (arrayStart === -1) return [];
  return readArrayObjectSegments(raw, arrayStart).map((segment, index) => ({
    index,
    closed: segment.closed,
    // `id` and `name` are the call's IDENTITY: the client dispatches on the
    // name and echoes the id back with the tool result, and the announcement
    // carrying them is latched — every writer returns early for an index it
    // already holds, so a later delta cannot correct them. A value read out of
    // a string literal the delta boundary has not closed yet is a PREFIX of
    // the identity, not the identity, so it is withheld until the closing
    // quote arrives. `arguments` is the opposite: a prefix of it IS the answer
    // so far, and the client is meant to watch it grow.
    id: readClosedStringProperty(segment.text, 'id'),
    name: readClosedStringProperty(segment.text, 'name'),
    arguments: readStringProperty(segment.text, 'arguments')?.value ?? '',
  }));
}

/** A string property whose closing quote has arrived, or undefined. */
function readClosedStringProperty(
  raw: string,
  property: string,
): string | undefined {
  const parsed = readStringProperty(raw, property);
  return parsed?.closed ? parsed.value : undefined;
}

function findToolCallsArray(raw: string): number {
  for (const { key, valueAt } of topLevelKeys(raw)) {
    if (key === 'toolCalls' && raw[valueAt] === '[') return valueAt;
  }
  return -1;
}

function readArrayObjectSegments(
  raw: string,
  arrayStart: number,
): { text: string; closed: boolean }[] {
  const segments: { text: string; closed: boolean }[] = [];
  let objectStart = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = arrayStart + 1; i < raw.length; i += 1) {
    const char = raw[i] ?? '';
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      if (depth === 0) objectStart = i;
      depth += 1;
      continue;
    }
    if (char === '}') {
      if (depth > 0) depth -= 1;
      if (depth === 0 && objectStart !== -1) {
        segments.push({ text: raw.slice(objectStart, i + 1), closed: true });
        objectStart = -1;
      }
      continue;
    }
    if (char === ']' && depth === 0) break;
  }

  if (objectStart !== -1) segments.push({ text: raw.slice(objectStart), closed: false });
  return segments;
}

/**
 * The property's string value AND whether its closing quote has arrived. The
 * two are reported together because a partial read is the right answer for
 * some fields and the wrong one for others: `closed` is what lets each caller
 * say which it is, and reading the value without it is how a prefix came to
 * pass for a whole value.
 */
/**
 * The index just past the JSON value starting at `start`, or -1 while that
 * value is still unfinished.
 */
function skipJsonValue(raw: string, start: number): number {
  const first = raw[start];
  if (first === undefined) return -1;
  if (first === '"') {
    const parsed = readJsonString(raw, start);
    return parsed.closed ? parsed.end + 1 : -1;
  }
  if (first === '{' || first === '[') {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < raw.length; index += 1) {
      const char = raw[index] ?? '';
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') { inString = true; continue; }
      if (char === '{' || char === '[') depth += 1;
      else if (char === '}' || char === ']') {
        depth -= 1;
        if (depth === 0) return index + 1;
      }
    }
    return -1;
  }
  // A number, `true`, `false` or `null`: it ends where the object does.
  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index] ?? '';
    if (char === ',' || char === '}' || char === ']') return index;
  }
  return -1;
}

/**
 * The wrapper's TOP-LEVEL keys, in order, each with where its value starts.
 *
 * Every value is stepped over whole, so the walk never descends into one. The
 * three scanners in this file each used to step differently — one skipped only
 * string values, one searched for a key with `indexOf` at any depth — and the
 * wrapper now carries a `json` member whose keys the CLIENT chooses. A client
 * schema with a `toolCalls` property therefore wrote a `"toolCalls":[…]` ahead
 * of the wrapper's own, and the streamed reader announced a tool call built
 * out of the client's answer: its name, its id, its arguments. A client
 * property named `text` moved the turn's narration. The buffered reader was
 * right in both cases because it reads a parsed object.
 *
 * Stops as soon as a value is unfinished: nothing past it has arrived, so no
 * later key is readable yet.
 */
function* topLevelKeys(raw: string): Generator<{ keyIndex: number; key: string; valueAt: number }> {
  // The wrapper is an OBJECT. Without this the walk started at byte zero and
  // read the first quoted key it met at any nesting — so an artifact whose
  // root is an ARRAY, `[{"status":"tool_calls","toolCalls":[…]}]`, had its
  // inner object read as the wrapper: the stream announced a real tool call
  // while the buffered reader, which checks the parsed root, returned the whole
  // array as text and reported no call at all.
  const start = skipWhitespace(raw, 0);
  if (raw[start] !== '{') return;
  let index = start + 1;
  while (index < raw.length) {
    if (raw[index] !== '"') {
      index += 1;
      continue;
    }
    const parsedKey = readJsonString(raw, index);
    if (!parsedKey.closed) return;
    const colon = skipWhitespace(raw, parsedKey.end + 1);
    if (raw[colon] !== ':') {
      index = parsedKey.end + 1;
      continue;
    }
    const valueAt = skipWhitespace(raw, colon + 1);
    yield { keyIndex: index, key: parsedKey.value, valueAt };
    const next = skipJsonValue(raw, valueAt);
    if (next === -1) return;
    index = next;
  }
}

/**
 * The EXACT source text of a top-level member's value, or undefined.
 *
 * Reading a client's answer back out of a parsed object and re-serializing it
 * rounds every number through IEEE-754 first: an id of `9007199254740993` was
 * published as `…992`. The bytes the backend wrote are the answer, so they are
 * the bytes that go out.
 */
export function rawTopLevelValue(raw: string, key: string): string | undefined {
  for (const entry of topLevelKeys(raw)) {
    if (entry.key !== key) continue;
    const end = skipJsonValue(raw, entry.valueAt);
    return end === -1 ? undefined : raw.slice(entry.valueAt, end);
  }
  return undefined;
}

/**
 * The value of `property` at the TOP level of `raw`.
 *
 * Every value is stepped over whole, whatever its type. Only string values
 * were skipped before, and any other value — an object, an array — merely
 * advanced past its key, so the scan carried on INSIDE it. The comment above
 * `wrapperKeyIndex` promised that "a tool named `text` or an `arguments`
 * payload with a `text` field of its own cannot pose as the wrapper's
 * narration"; that promise held for the ORDER scan and not for this one, so a
 * call written `{"arguments":{"text":"Seoul"},…}` streamed `Seoul` as the
 * turn's narration, and `{"arguments":{"name":"Ada"},…,"name":"create_user"}`
 * announced the call as `Ada` — a tool the client has no handler for, latched
 * so that nothing later corrects it. The buffered reading of the same bytes
 * had both right.
 */
function readStringProperty(
  raw: string,
  property: string,
): { value: string; closed: boolean } | undefined {
  for (const { key, valueAt } of topLevelKeys(raw)) {
    if (key !== property) continue;
    if (raw[valueAt] !== '"') return undefined;
    const parsedValue = readJsonString(raw, valueAt);
    return { value: parsedValue.value, closed: parsedValue.closed };
  }
  return undefined;
}

function readJsonString(
  raw: string,
  quoteIndex: number,
): { value: string; end: number; closed: boolean } {
  let value = '';
  let escaped = false;
  for (let i = quoteIndex + 1; i < raw.length; i += 1) {
    const char = raw[i] ?? '';
    if (escaped) {
      if (char === 'u') {
        const hex = raw.slice(i + 1, i + 5);
        if (hex.length < 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) {
          return { value, end: i - 1, closed: false };
        }
        value += String.fromCharCode(Number.parseInt(hex, 16));
        i += 4;
      } else {
        value += unescapeJsonChar(char);
      }
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      return { value, end: i, closed: true };
    }
    value += char;
  }
  return { value, end: raw.length, closed: false };
}

function unescapeJsonChar(char: string): string {
  if (char === 'b') return '\b';
  if (char === 'f') return '\f';
  if (char === 'n') return '\n';
  if (char === 'r') return '\r';
  if (char === 't') return '\t';
  return char;
}

function skipWhitespace(raw: string, index: number): number {
  let cursor = index;
  while (/\s/.test(raw[cursor] ?? '')) cursor += 1;
  return cursor;
}
