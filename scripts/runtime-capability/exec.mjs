// Process execution and binary resolution: how the collector runs a CLI, which
// executable it runs, and where probes are allowed to write.
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { probeBudgetMs, repoRoot } from './options.mjs';
import { firstLine, trimEnd } from './text.mjs';

const execFileAsync = promisify(execFile);
// Probes run outside the repository. Some options treat their argument as an
// output path (`--debug-file` writes a log plus a `latest` symlink beside it),
// so probing from the repo root would litter the working tree.
let probeScratchPromise = null;

// Telemetry for every CLI spawn the collector makes, so growth is visible in the
// artifact rather than discovered as a timeout months later.
const telemetry = { count: 0, totalMs: 0, exhausted: false };

export function probeTelemetry() {
  return { ...telemetry, budgetMs: probeBudgetMs };
}

export async function run(command, commandArgs, options = {}) {
  if (telemetry.exhausted) {
    return { ok: false, code: null, signal: null, budgetExhausted: true, stdout: '', stderr: 'probe budget exhausted' };
  }
  const startedAt = Date.now();
  try {
    const result = await execFileAsync(command, commandArgs, {
      cwd: options.cwd ?? repoRoot,
      encoding: 'utf8',
      timeout: options.timeoutMs ?? 15_000,
      maxBuffer: options.maxBuffer ?? 4_000_000,
      env: process.env,
    });
    return {
      ok: true,
      code: 0,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  } catch (error) {
    return {
      ok: false,
      code: typeof error.code === 'number' ? error.code : null,
      signal: error.signal ?? null,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? error.message ?? '',
    };
  } finally {
    telemetry.count += 1;
    telemetry.totalMs += Date.now() - startedAt;
    if (telemetry.totalMs > probeBudgetMs) telemetry.exhausted = true;
  }
}

export function summarizeCommand(result) {
  if (!result) return null;
  return {
    ok: result.ok,
    code: result.code,
    signal: result.signal ?? null,
    stdout: trimEnd(result.stdout),
    stderr: trimEnd(result.stderr),
  };
}

export async function commandPath(name) {
  const result = await run('/bin/sh', ['-lc', `command -v ${shellQuote(name)}`], {
    timeoutMs: 10_000,
  });
  if (!result.ok) return null;
  return result.stdout.trim().split(/\r?\n/).filter(Boolean)[0] ?? null;
}

// A PATH entry can be a shell wrapper that re-dispatches to the real CLI. The
// wrapper is what actually runs, so every behavioural authority — version, help,
// schema, parse probes — must keep using it. It carries none of the real
// binary's strings though, so the string scan needs the native target instead.
//
// The native target is not simply "the next same-named file on PATH": a wrapper
// can pin a different installation or select per-account binaries, and scanning
// an unrelated build would describe a runtime nobody is running. A candidate is
// accepted only when it reports the same version as the wrapper; otherwise the
// scan is left without a target and reports itself unavailable.
export async function runtimeBinaryPath(name) {
  const primary = await commandPath(name);
  if (!primary) return { path: null, scanPath: null, wrapper: null };
  if (await executableKind(primary) !== false) {
    return { path: primary, scanPath: primary, wrapper: null };
  }
  const wrapperVersion = firstLine((await run(primary, ['--version'], { timeoutMs: 10_000 })).stdout);
  for (const dir of String(process.env.PATH ?? '').split(':')) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (candidate === primary || !existsSync(candidate)) continue;
    if (await executableKind(candidate) !== true) continue;
    const candidateVersion = firstLine((await run(candidate, ['--version'], { timeoutMs: 10_000 })).stdout);
    if (wrapperVersion && candidateVersion === wrapperVersion) {
      return { path: primary, scanPath: candidate, wrapper: primary };
    }
  }
  return { path: primary, scanPath: null, wrapper: primary };
}

// Returns true (native), false (not native), or null (undeterminable). Null is
// not "native": without `file` there is no evidence either way, and treating the
// unknown case as native is exactly what lets a PATH wrapper be scanned as if it
// were the binary.
export async function executableKind(binary) {
  // `-L` because a CLI is often installed as a symlink to the real executable
  // (Homebrew does this for codex). GNU file does not follow symlinks unless
  // POSIXLY_CORRECT is set, and would answer "symbolic link to ..." — which
  // reads as "not native" and would misclassify the install as a wrapper.
  const result = await run('file', ['-b', '-L', binary], { timeoutMs: 10_000 });
  if (!result.ok) return null;
  return /Mach-O|ELF|PE32/i.test(result.stdout);
}

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function probeScratchDir() {
  probeScratchPromise ??= mkdtemp(join(tmpdir(), 'runtime-capability-probe-'));
  return probeScratchPromise;
}

export async function cleanupProbeScratch() {
  const pending = probeScratchPromise;
  probeScratchPromise = null;
  if (!pending) return;
  const dir = await pending.catch(() => null);
  if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 3 });
}

export async function listFiles(dir) {
  const entries = [];
  for (const name of await readdir(dir)) {
    const filePath = join(dir, name);
    const fileStat = await stat(filePath);
    if (fileStat.isDirectory()) {
      entries.push(...await listFiles(filePath));
    } else if (fileStat.isFile()) {
      entries.push(filePath);
    }
  }
  return entries;
}
