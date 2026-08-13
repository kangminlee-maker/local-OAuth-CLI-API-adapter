import { execFile } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { proxyChildProcessEnv } from './process-env.js';
import { unsupportedModelError } from './types.js';
import type { ApiShape } from './types.js';

// Codex CLI accepts any `--model` value and only fails once the request reaches
// the server, so the proxy cannot delegate model validation to the CLI the way
// it can for Claude Code. `codex debug models` is the authority: the list is
// served, not compiled in, so it changes without a CLI upgrade and must never be
// hard-coded here.
// Deliberately short. Validation is an optional gate in front of the request:
// exceeding it means the catalogue is unknown and the model passes through, so
// a hanging `codex debug models` costs seconds rather than the caller's whole
// deadline. Concurrent requests share one in-flight lookup, so they share this
// bound too.
const MODEL_LIST_TIMEOUT_MS = 5_000;
const MODEL_LIST_TTL_MS = 10 * 60 * 1000;
// A lookup that failed is remembered too, for a shorter window. Without this an
// unreachable or hanging `codex debug models` would spawn a fresh process and
// burn the full timeout on every single request while still passing models
// through, which turns an inconclusive lookup into sustained process churn.
const MODEL_LIST_FAILURE_TTL_MS = 30 * 1000;

export interface CodexModel {
  readonly slug: string;
  readonly supportedInApi: boolean;
  readonly reasoningEfforts: readonly string[];
}

interface CacheEntry {
  readonly models: readonly CodexModel[] | null;
  readonly fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<readonly CodexModel[] | null>>();

export interface CodexModelCatalogOptions {
  readonly command?: string;
  readonly codexHome?: string;
  /**
   * Where to run the lookup. Codex reads project-local configuration from its
   * working directory, so without this the probe would inherit whatever
   * directory the proxy was launched from and could answer from a different
   * configuration than the runtime it is validating for.
   */
  readonly cwd?: string;
  /**
   * The directory a path-like `command` is resolved against — the runtime's own
   * working directory. Distinct from `cwd`, which is where the lookup executes.
   */
  readonly commandCwd?: string;
  readonly now?: () => number;
  /**
   * The request's cancellation signal. Aborting stops this caller from waiting on
   * the lookup and treats the catalogue as unknown; it does not cancel a shared
   * lookup other callers may still need.
   */
  readonly signal?: AbortSignal;
}

/**
 * Returns the models the installed Codex CLI advertises, or `null` when the list
 * could not be collected. `null` means "unknown", never "empty": callers must
 * not reject a model on an unknown list, because an offline or failing lookup
 * would otherwise turn into a blanket outage.
 */
export async function codexModels(
  options: CodexModelCatalogOptions = {},
): Promise<readonly CodexModel[] | null> {
  // The lookup runs in its own directory, so a path-like command must be
  // resolved against the caller's cwd first — otherwise `./bin/codex` would be
  // looked for inside the probe directory and never found. A bare command name
  // is left alone so PATH resolution still applies.
  const command = resolveCommand(options.command ?? 'codex', options.commandCwd ?? options.cwd);
  // Absolute before the child cwd changes, and against process.cwd() — the same
  // base the transport uses when it reads auth.json from this value. Rebasing it
  // on the runtime cwd instead would point the lookup at a different Codex
  // profile than the one executing the request.
  const codexHome = options.codexHome === undefined
    ? undefined
    : resolve(process.cwd(), options.codexHome);
  // A directory this process created and owns. The OS temp root is NOT empty —
  // it is shared, and anything with Codex configuration sitting in it would be
  // picked up by the lookup.
  const cwd = options.cwd ?? await probeDir();
  // No private directory to run in means the lookup could not be performed at
  // all — unknown, not empty, so the caller passes the model through.
  if (!cwd) return null;
  const now = options.now ?? (() => Date.now());
  // The served list reflects account entitlements, so a cached one belongs to the
  // account that was authenticated when it was collected. Logging a different
  // account into the same CODEX_HOME must not keep answering from the previous
  // one — the stamp changes with auth.json and retires those entries.
  const authGeneration = await authFingerprint(codexHome);
  // Serialized rather than space-joined: a space inside any component would
  // otherwise let two distinct tuples share one entry.
  const key = JSON.stringify([command, codexHome ?? null, cwd, authGeneration]);

  const cached = cache.get(key);
  if (cached) {
    const ttl = cached.models ? MODEL_LIST_TTL_MS : MODEL_LIST_FAILURE_TTL_MS;
    if (now() - cached.fetchedAt < ttl) return cached.models;
  }

  const pending = inFlight.get(key);
  if (pending) return abortable(pending, options.signal);

  const request = collectModels(command, codexHome, cwd)
    .then((models) => {
      cache.set(key, { models, fetchedAt: now() });
      return models;
    })
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, request);
  // The lookup itself keeps running for whoever else is waiting on it; only this
  // caller stops awaiting. Validation is an optional gate, so an abandoned or
  // timed-out request treats the catalogue as unknown and moves on.
  return abortable(request, options.signal);
}

function abortable(
  request: Promise<readonly CodexModel[] | null>,
  signal: AbortSignal | undefined,
): Promise<readonly CodexModel[] | null> {
  if (!signal) return request;
  if (signal.aborted) return Promise.resolve(null);
  return new Promise((resolveWith) => {
    const onAbort = (): void => resolveWith(null);
    signal.addEventListener('abort', onAbort, { once: true });
    void request
      .then((models) => resolveWith(models), () => resolveWith(null))
      .finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/**
 * Rejects a model the Codex CLI does not advertise. Does nothing when the list
 * could not be collected: unknown is not empty, and a failed lookup must not
 * become a blanket outage.
 */
export async function assertCodexModelSupported(
  model: string,
  shape: ApiShape,
  options: CodexModelCatalogOptions = {},
  fromRequest = true,
): Promise<void> {
  const models = await codexModels(options);
  if (!models) return;
  if (models.some((entry) => entry.slug === model)) return;
  throw unsupportedModelError(model, shape, fromRequest);
}

export function resetCodexModelCatalogCache(): void {
  cache.clear();
  inFlight.clear();
  // The probe directory is memoized too, so a caller resetting the cache gets a
  // genuinely fresh lookup rather than one that reuses an earlier directory.
  // Directories already created are removed by their exit hook.
  probeDirPromise = null;
}

/**
 * A private empty directory for lookups that have no runtime workspace of their
 * own. Created once per process and removed on exit, so the probe never inherits
 * project-local Codex configuration from wherever the proxy was started.
 */
let probeDirPromise: Promise<string | null> | null = null;

function probeDir(): Promise<string | null> {
  probeDirPromise ??= mkdtemp(join(tmpdir(), 'codex-model-probe-'))
    .then((dir) => {
      process.once('exit', () => {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // Exit-time cleanup is best effort; an empty temp dir is harmless.
        }
      });
      return dir;
    })
    .catch(() => {
      // An unwritable or full temp volume must not turn into a request failure:
      // the lookup is simply unknown, and the model passes through. Forgetting
      // the rejection lets a later request retry once the volume recovers.
      probeDirPromise = null;
      return null;
    });
  return probeDirPromise;
}

function collectModels(
  command: string,
  codexHome: string | undefined,
  cwd: string,
): Promise<readonly CodexModel[] | null> {
  return new Promise((resolve) => {
    execFile(
      command,
      ['debug', 'models'],
      {
        cwd,
        env: proxyChildProcessEnv(codexHome ? { CODEX_HOME: codexHome } : {}),
        timeout: MODEL_LIST_TIMEOUT_MS,
        // Every model carries its full base instructions, so the payload is far
        // larger than a typical CLI response.
        maxBuffer: 64 * 1024 * 1024,
        shell: false,
        killSignal: 'SIGKILL',
      },
      (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        resolve(parseModels(stdout));
      },
    );
  });
}

function parseModels(stdout: string): readonly CodexModel[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    return null;
  }
  const models = asRecord(parsed)?.models;
  if (!Array.isArray(models)) return null;
  const collected: CodexModel[] = [];
  for (const entry of models) {
    const record = asRecord(entry);
    const slug = record?.slug;
    // One unreadable entry makes the whole list unusable as proof of absence: a
    // model whose slug we failed to parse would be rejected as "not advertised"
    // even though collection never determined its name. Inconclusive must stay
    // inconclusive, so the catalogue becomes unknown rather than truncated.
    if (typeof slug !== 'string' || !slug.trim()) return null;
    collected.push({
      slug,
      supportedInApi: record?.supported_in_api !== false,
      reasoningEfforts: readReasoningEfforts(record?.supported_reasoning_levels),
    });
  }
  // An empty `models` array is a conclusive answer — the account is entitled to
  // nothing — not a failure to collect. Reporting it as unknown would let every
  // model through instead of rejecting it here.
  return collected;
}

function readReasoningEfforts(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const efforts: string[] = [];
  for (const entry of value) {
    const effort = asRecord(entry)?.effort;
    if (typeof effort === 'string' && effort.trim()) efforts.push(effort);
  }
  return efforts;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function resolveCommand(command: string, runtimeCwd: string | undefined): string {
  const looksLikePath = command.includes('/') || command.includes('\\');
  if (!looksLikePath || isAbsolute(command)) return command;
  // Against the directory the runtime itself spawns from, not the proxy's own
  // cwd: the two differ whenever a backend is given an explicit cwd, and the
  // catalogue must query the very executable the turn will run.
  return resolve(runtimeCwd ?? process.cwd(), command);
}

/**
 * A non-secret marker of which credentials are in place. Size and mtime change
 * when the file is rewritten by a login or refresh; the contents are never read,
 * so no token material enters the cache key.
 */
async function authFingerprint(codexHome: string | undefined): Promise<string> {
  if (!codexHome) return 'no-home';
  const path = join(codexHome, 'auth.json');
  try {
    const raw = await readFile(path, 'utf8');
    // A digest of the credential contents, so a swap that preserves size and
    // mtime — `cp -p`, a same-length rewrite, a coarse-timestamp filesystem —
    // still changes the key. Paired with the account id, which is not secret and
    // makes the entry legible; the digest itself is never logged or returned.
    const digest = createHash('sha256').update(raw).digest('hex').slice(0, 32);
    return `${accountIdFrom(raw) ?? 'unknown'}:${digest}`;
  } catch {
    try {
      // Unreadable but present: fall back to metadata rather than treating every
      // such home as identical.
      const info = await stat(path);
      return `unreadable:${info.mtimeMs}:${info.size}`;
    } catch {
      // No credentials file is itself a state worth distinguishing from one.
      return 'absent';
    }
  }
}

function accountIdFrom(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    const tokens = asRecord(asRecord(parsed)?.tokens);
    const accountId = tokens?.account_id;
    return typeof accountId === 'string' && accountId ? accountId : null;
  } catch {
    return null;
  }
}
