import type { LocalToolCall } from './types.js';

/**
 * Readers of the COMPLETED tool wrapper — the one artefact a tool turn has —
 * and the one reconciliation the stream still needs when a turn completes.
 *
 * There used to be a second, incremental reader here that released bytes
 * before the wrapper was complete; the two disagreed on malformed output and
 * a streaming client could execute a call the buffered reading denied. A tool
 * turn now releases nothing until its completed reading exists, and these
 * functions read that whole text: the wrapper's own key order, a member's
 * exact bytes, whether a call's name was declared.
 */

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

/**
 * Whether a call's name, as the backend wrote it, is one the request declared.
 *
 * Tested against the RAW value, before any substitution. The buffered reader
 * used to substitute `tool` for a missing or blank name and then find `tool`
 * undeclared, while the streamed reader tested the pre-substitution value —
 * `undefined`, which passed — and then substituted and published. One reader
 * refused, the other delivered an executable call for a tool the client never
 * declared. A call the runtime schema would not have allowed is not repaired
 * into an identity; it is undeclared, in both readers, from this one rule.
 */
export function callNameIsDeclared(declared: ReadonlySet<string>, name: unknown): boolean {
  return typeof name === 'string' && name.trim() !== '' && declared.has(name);
}

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
/**
 * The complete top-level members of an object cut off mid-way — what the
 * direct Messages API publishes as a `tool_use` block's `input` when
 * `max_tokens` cut the call off (measured 2026-09-04: `{"title": "The Sea"}`
 * with the `body` member dropped, `{}` when nothing had closed). A walk over a
 * COMPLETED fragment, with the lexer that survived the incremental reader; not
 * a stream reader. Anything that is not an object at all yields `{}`.
 */
export function completeTopLevelMembers(fragment: string): string {
  const members: Record<string, unknown> = {};
  let cursor = skipWhitespace(fragment, 0);
  if (fragment[cursor] !== '{') return '{}';
  cursor = skipWhitespace(fragment, cursor + 1);
  while (cursor < fragment.length && fragment[cursor] === '"') {
    const key = readJsonString(fragment, cursor);
    if (!key.closed) break;
    cursor = skipWhitespace(fragment, key.end + 1);
    if (fragment[cursor] !== ':') break;
    cursor = skipWhitespace(fragment, cursor + 1);
    const valueEnd = skipJsonValue(fragment, cursor);
    if (valueEnd === -1) break;
    try {
      members[key.value] = JSON.parse(fragment.slice(cursor, valueEnd)) as unknown;
    } catch {
      break;
    }
    cursor = skipWhitespace(fragment, valueEnd);
    if (fragment[cursor] === ',') cursor = skipWhitespace(fragment, cursor + 1);
    else break;
  }
  return JSON.stringify(members);
}

export function rawTopLevelValue(raw: string, key: string): string | undefined {
  for (const entry of topLevelKeys(raw)) {
    if (entry.key !== key) continue;
    const end = skipJsonValue(raw, entry.valueAt);
    return end === -1 ? undefined : raw.slice(entry.valueAt, end);
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

/**
 * JSON's whitespace, which is four characters and not JavaScript's `\s`.
 *
 * `\s` also matches U+FEFF, U+00A0, U+000B and U+2028. A wrapper with a BOM
 * in front of it was therefore read as a wrapper here while `JSON.parse`
 * rejected it outright, so under `tool_choice:"required"` the stream published
 * a complete executable call and the buffered reading answered 502. Deciding
 * "is this a wrapper" has to answer the same question `JSON.parse` answers.
 */
function skipWhitespace(raw: string, index: number): number {
  let cursor = index;
  while (JSON_WHITESPACE.has(raw[cursor] ?? '')) cursor += 1;
  return cursor;
}

const JSON_WHITESPACE = new Set([' ', '\t', '\n', '\r']);
