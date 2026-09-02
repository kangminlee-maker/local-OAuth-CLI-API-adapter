import type { LocalStreamEvent, LocalToolCall } from './types.js';

interface ToolCallSnapshot {
  readonly index: number;
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
    const textEvents = this.textDeltas();
    const callEvents = this.toolCallDeltas();
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

  constructor(
    private readonly index: number,
    private readonly id: string,
    private readonly name: string,
  ) {}

  push(delta: string): LocalStreamEvent[] {
    const argumentsDelta = this.normalizeDelta(delta);
    if (!argumentsDelta) return [];
    const out: LocalStreamEvent[] = [];
    if (!this.started) {
      this.started = true;
      out.push({
        type: 'tool_call_delta',
        index: this.index,
        id: this.id,
        name: this.name,
        argumentsDelta: '',
      });
    }
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
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] !== '"') continue;
    const parsed = readJsonString(raw, index);
    // The delta boundary landed inside a string: nothing past it is readable
    // yet, and the key is not in the part that is.
    if (!parsed.closed) return -1;
    const cursor = skipWhitespace(raw, parsed.end + 1);
    if (raw[cursor] === ':') {
      if (parsed.value === key) return index;
      const valueAt = skipWhitespace(raw, cursor + 1);
      if (raw[valueAt] === '"') {
        index = readJsonString(raw, valueAt).end;
        continue;
      }
    }
    index = parsed.end;
  }
  return -1;
}

function readToolCallSnapshots(raw: string): ToolCallSnapshot[] {
  const arrayStart = findToolCallsArray(raw);
  if (arrayStart === -1) return [];
  return readArrayObjectSegments(raw, arrayStart).map((segment, index) => ({
    index,
    // `id` and `name` are the call's IDENTITY: the client dispatches on the
    // name and echoes the id back with the tool result, and the announcement
    // carrying them is latched — every writer returns early for an index it
    // already holds, so a later delta cannot correct them. A value read out of
    // a string literal the delta boundary has not closed yet is a PREFIX of
    // the identity, not the identity, so it is withheld until the closing
    // quote arrives. `arguments` is the opposite: a prefix of it IS the answer
    // so far, and the client is meant to watch it grow.
    id: readClosedStringProperty(segment, 'id'),
    name: readClosedStringProperty(segment, 'name'),
    arguments: readStringProperty(segment, 'arguments')?.value ?? '',
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
  let index = 0;
  while (index < raw.length) {
    const keyIndex = raw.indexOf('"toolCalls"', index);
    if (keyIndex === -1) return -1;
    let cursor = keyIndex + '"toolCalls"'.length;
    cursor = skipWhitespace(raw, cursor);
    if (raw[cursor] !== ':') {
      index = cursor;
      continue;
    }
    cursor = skipWhitespace(raw, cursor + 1);
    if (raw[cursor] === '[') return cursor;
    index = cursor;
  }
  return -1;
}

function readArrayObjectSegments(raw: string, arrayStart: number): string[] {
  const segments: string[] = [];
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
        segments.push(raw.slice(objectStart, i + 1));
        objectStart = -1;
      }
      continue;
    }
    if (char === ']' && depth === 0) break;
  }

  if (objectStart !== -1) segments.push(raw.slice(objectStart));
  return segments;
}

/**
 * The property's string value AND whether its closing quote has arrived. The
 * two are reported together because a partial read is the right answer for
 * some fields and the wrong one for others: `closed` is what lets each caller
 * say which it is, and reading the value without it is how a prefix came to
 * pass for a whole value.
 */
function readStringProperty(
  raw: string,
  property: string,
): { value: string; closed: boolean } | undefined {
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] !== '"') continue;
    const parsedKey = readJsonString(raw, index);
    if (!parsedKey.closed) return undefined;
    let cursor = skipWhitespace(raw, parsedKey.end + 1);
    if (raw[cursor] !== ':') {
      index = parsedKey.end;
      continue;
    }
    cursor = skipWhitespace(raw, cursor + 1);
    if (parsedKey.value === property) {
      if (raw[cursor] !== '"') return undefined;
      const parsedValue = readJsonString(raw, cursor);
      return { value: parsedValue.value, closed: parsedValue.closed };
    }
    if (raw[cursor] === '"') {
      const parsedValue = readJsonString(raw, cursor);
      index = Math.max(parsedKey.end, parsedValue.end);
    } else {
      index = parsedKey.end;
    }
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
