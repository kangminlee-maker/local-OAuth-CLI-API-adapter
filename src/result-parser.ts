import type { RuntimeGenerateResult } from './types.js';

export function parseRuntimeResult(raw: unknown): RuntimeGenerateResult | null {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    try {
      return parseRuntimeResult(JSON.parse(trimmed));
    } catch {
      const fenced = extractFencedJson(trimmed);
      if (fenced) return parseRuntimeResult(fenced);
      return null;
    }
  }

  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;

  if (typeof record.result === 'string') {
    const nested = parseRuntimeResult(record.result);
    if (nested) {
      return {
        ...nested,
        sessionId:
          typeof record.session_id === 'string' ? record.session_id : nested.sessionId,
        rawOutput: raw,
      };
    }
  }

  const status = record.status;
  if (status !== 'ok' && status !== 'error') return null;

  return {
    status,
    componentPath:
      typeof record.componentPath === 'string'
        ? record.componentPath
        : typeof record.component_path === 'string'
          ? record.component_path
          : undefined,
    notes: Array.isArray(record.notes)
      ? record.notes.filter((note): note is string => typeof note === 'string')
      : undefined,
    error: typeof record.error === 'string' ? record.error : undefined,
    sessionId:
      typeof record.sessionId === 'string'
        ? record.sessionId
        : typeof record.session_id === 'string'
          ? record.session_id
          : undefined,
    rawOutput: raw,
  };
}

function extractFencedJson(input: string): string | null {
  const match = input.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return match?.[1] ?? null;
}
