import { readFileSync } from 'node:fs';
import type { NormalizedReasoningEffort, NormalizedVerbosity } from './proxy/types.js';

export type CodexProxyTransport = 'app-server' | 'codex-backend';
export type CodexProxyImageTransport = 'app-server' | 'codex-backend';

export interface AddonSettings {
  readonly codexProxy: {
    readonly transport: CodexProxyTransport;
    readonly imageTransport: CodexProxyImageTransport;
    readonly fallbackReasoningEffort: NormalizedReasoningEffort;
    readonly fallbackVerbosity: NormalizedVerbosity;
    readonly imageModel: string;
  };
  readonly modelSelection: {
    readonly honorRequestModel: boolean;
  };
}

const SETTINGS_URL = new URL('../settings.json', import.meta.url);
const CODEX_PROXY_TRANSPORTS = ['app-server', 'codex-backend'] as const;
const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;
const VERBOSITIES = ['low', 'medium', 'high'] as const;

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
      transport: readCodexProxyTransportSetting(
        codexProxy?.transport,
        'codexProxy.transport',
      ),
      imageTransport: readCodexProxyImageTransportSetting(
        codexProxy?.imageTransport,
        'codexProxy.imageTransport',
      ),
      fallbackReasoningEffort: readReasoningEffortSetting(
        codexProxy?.fallbackReasoningEffort,
        'codexProxy.fallbackReasoningEffort',
      ),
      fallbackVerbosity: readVerbositySetting(
        codexProxy?.fallbackVerbosity,
        'codexProxy.fallbackVerbosity',
      ),
      imageModel: readNonEmptyStringSetting(
        codexProxy?.imageModel,
        'codexProxy.imageModel',
      ),
    },
    modelSelection: {
      // Absent means the pre-existing behaviour: the configured model wins and a
      // request model is never honoured. Installs that predate this key keep
      // working unchanged.
      honorRequestModel: readOptionalBooleanSetting(
        asRecord(root?.modelSelection)?.honorRequestModel,
        'modelSelection.honorRequestModel',
        false,
      ),
    },
  };
  return cachedSettings;
}

export function codexProxyTransport(): CodexProxyTransport {
  return loadSettings().codexProxy.transport;
}

export function codexProxyImageTransport(): CodexProxyImageTransport {
  return loadSettings().codexProxy.imageTransport;
}

export function codexProxyFallbackReasoningEffort(): NormalizedReasoningEffort {
  return loadSettings().codexProxy.fallbackReasoningEffort;
}

export function codexProxyFallbackVerbosity(): NormalizedVerbosity {
  return loadSettings().codexProxy.fallbackVerbosity;
}

export function codexProxyImageModel(): string {
  return loadSettings().codexProxy.imageModel;
}

export function honorRequestModel(): boolean {
  return loadSettings().modelSelection.honorRequestModel;
}

export function isReasoningEffort(value: unknown): value is NormalizedReasoningEffort {
  return typeof value === 'string' && REASONING_EFFORTS.includes(value as NormalizedReasoningEffort);
}

export function isVerbosity(value: unknown): value is NormalizedVerbosity {
  return typeof value === 'string' && VERBOSITIES.includes(value as NormalizedVerbosity);
}

export function isCodexProxyTransport(value: unknown): value is CodexProxyTransport {
  return typeof value === 'string' && CODEX_PROXY_TRANSPORTS.includes(value as CodexProxyTransport);
}

export function isCodexProxyImageTransport(value: unknown): value is CodexProxyImageTransport {
  return isCodexProxyTransport(value);
}

function readCodexProxyTransportSetting(
  value: unknown,
  key: string,
): CodexProxyTransport {
  if (isCodexProxyTransport(value)) return value;
  throw new Error(`${key} must be one of ${CODEX_PROXY_TRANSPORTS.join(', ')}.`);
}

function readCodexProxyImageTransportSetting(
  value: unknown,
  key: string,
): CodexProxyImageTransport {
  if (isCodexProxyImageTransport(value)) return value;
  throw new Error(`${key} must be one of ${CODEX_PROXY_TRANSPORTS.join(', ')}.`);
}

function readReasoningEffortSetting(
  value: unknown,
  key: string,
): NormalizedReasoningEffort {
  if (isReasoningEffort(value)) return value;
  throw new Error(`${key} must be one of ${REASONING_EFFORTS.join(', ')}.`);
}

function readVerbositySetting(
  value: unknown,
  key: string,
): NormalizedVerbosity {
  if (isVerbosity(value)) return value;
  throw new Error(`${key} must be one of ${VERBOSITIES.join(', ')}.`);
}

function readNonEmptyStringSetting(value: unknown, key: string): string {
  if (typeof value === 'string' && value.trim()) return value.trim();
  throw new Error(`${key} must be a non-empty string.`);
}

function readOptionalBooleanSetting(
  value: unknown,
  key: string,
  fallback: boolean,
): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  throw new Error(`${key} must be a boolean.`);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
