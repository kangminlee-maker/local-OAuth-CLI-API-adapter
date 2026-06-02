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

  push(delta: string): LocalStreamEvent[] {
    if (!delta) return [];
    this.raw += delta;
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
}

export function missingToolCallArgumentDelta(
  streamedArguments: string,
  finalCall: LocalToolCall,
): string {
  return finalCall.arguments.startsWith(streamedArguments)
    ? finalCall.arguments.slice(streamedArguments.length)
    : '';
}

function readToolCallSnapshots(raw: string): ToolCallSnapshot[] {
  const arrayStart = findToolCallsArray(raw);
  if (arrayStart === -1) return [];
  return readArrayObjectSegments(raw, arrayStart).map((segment, index) => ({
    index,
    id: readStringProperty(segment, 'id'),
    name: readStringProperty(segment, 'name'),
    arguments: readStringProperty(segment, 'arguments') ?? '',
  }));
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

function readStringProperty(raw: string, property: string): string | undefined {
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
      return readJsonString(raw, cursor).value;
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
