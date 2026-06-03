import { readFileSync } from 'node:fs';
import type { NormalizedReasoningEffort } from './proxy/types.js';

export interface AddonSettings {
  readonly codexProxy: {
    readonly fallbackReasoningEffort: NormalizedReasoningEffort;
  };
}

const SETTINGS_URL = new URL('../settings.json', import.meta.url);
const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;

let cachedSettings: AddonSettings | null = null;

export function loadSettings(): AddonSettings {
  if (cachedSettings) return cachedSettings;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(SETTINGS_URL, 'utf8')) as unknown;
  } catch (err) {
    throw new Error(`Unable to read settings.json: ${errorMessage(err)}`);
  }

  const root = asRecord(parsed);
  if (!root) throw new Error('settings.json must contain a JSON object.');
  const codexProxy = asRecord(root?.codexProxy);
  if (!codexProxy) throw new Error('settings.json must define codexProxy.');
  cachedSettings = {
    codexProxy: {
      fallbackReasoningEffort: readReasoningEffortSetting(
        codexProxy?.fallbackReasoningEffort,
        'codexProxy.fallbackReasoningEffort',
      ),
    },
  };
  return cachedSettings;
}

export function codexProxyFallbackReasoningEffort(): NormalizedReasoningEffort {
  return loadSettings().codexProxy.fallbackReasoningEffort;
}

export function isReasoningEffort(value: unknown): value is NormalizedReasoningEffort {
  return typeof value === 'string' && REASONING_EFFORTS.includes(value as NormalizedReasoningEffort);
}

function readReasoningEffortSetting(
  value: unknown,
  key: string,
): NormalizedReasoningEffort {
  if (isReasoningEffort(value)) return value;
  throw new Error(`${key} must be one of ${REASONING_EFFORTS.join(', ')}.`);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
