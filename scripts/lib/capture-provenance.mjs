// What wrote a promoted capture, stated so that git can re-check it later.
//
// A fixture's own digest proves it has not drifted since it was written. It says
// nothing about WHAT wrote it, and the first attempt at that — ambient `HEAD`
// plus a "was the promoter dirty" boolean — turned out to assert nothing a
// reader could check. A review broke it three ways: a hand-written revision of
// forty zeroes passed the gate, a copy of the promoter under the ignored `dist/`
// stamped a revision that does not contain it, and running with git off `PATH`
// wrote nulls that no consumer rejected. All three share one cause: nothing
// re-derived the RELATIONSHIP the stamp asserts.
//
// So the stamp names a revision, a path, and the sha1 of the exact bytes that
// ran, and both ends use this module: the promoter derives the triple from its
// own source and refuses to write a fixture when it cannot, and the conformance
// gates ask git to confirm it before reading any capture as evidence.
//
// WHAT THIS DOES NOT CLAIM: that the named path is a promoter. It binds an
// artifact to committed bytes at a revision; it does not prove those bytes can
// promote anything. Hand-forged evidence by someone with commit rights is out of
// scope here, as it is for every other digest in `spec/captures/`.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const captureDir = join(repoRoot, 'spec', 'captures');

function git(root, ...argv) {
  return execFileSync('git', ['-C', root, ...argv], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/**
 * The binding for the source file that is executing right now.
 *
 * Throws rather than degrading: a promotion that cannot state where its code
 * lives must not write an artifact that looks bound. Every failure mode the
 * review demonstrated exits through here — git missing, source untracked or
 * ignored, source edited since the commit it names.
 */
export function bindingOfExecutingSource(sourceUrl) {
  // `realpath` first: on macOS a temporary checkout is reached through a
  // symlink, and a path that disagrees with git's own spelling would compute a
  // relative path that resolves to nothing.
  const file = realpathSync(fileURLToPath(sourceUrl));
  // Ask git where the repository is rather than deriving it from this file's
  // position. `git -C <anywhere>` walks UP to the enclosing repository, so a
  // copy of this code under an ignored directory would otherwise ask about
  // `HEAD:scripts/...` — the path the ORIGINAL occupies — and inherit the
  // tracked file's blob as its own binding.
  const root = git(dirname(file), 'rev-parse', '--show-toplevel');
  const path = relative(root, file);
  if (path.startsWith('..')) throw new Error(`${file} is outside ${root}, so no revision of it can name this code`);
  const revision = git(root, 'rev-parse', 'HEAD');
  // The bytes on disk, hashed the way git hashes what it stores.
  const blob = git(root, 'hash-object', '--', file);
  let committed;
  try {
    committed = git(root, 'rev-parse', `${revision}:${path}`);
  } catch {
    throw new Error(`${path} does not exist at ${revision.slice(0, 12)}: an untracked or ignored copy cannot be bound to a revision`);
  }
  if (committed !== blob) {
    throw new Error(`${path} on disk is ${blob.slice(0, 12)} but ${revision.slice(0, 12)} holds ${committed.slice(0, 12)}: that revision does not name the code that is running`);
  }
  return { revision, path, blob };
}

/**
 * Ask git whether a recorded binding can be true.
 * Returns `null` when it holds, and the reason it does not otherwise — a reason
 * rather than a boolean because "unbound" has several distinct causes and a
 * reader has to be told which one they are looking at.
 */
export function whyUnbound(promotedFrom, { root = repoRoot } = {}) {
  if (!promotedFrom || typeof promotedFrom !== 'object') return 'carries no promotedFrom record';
  const { revision, path, blob } = promotedFrom;
  if (typeof promotedFrom.unbound === 'string') return `was promoted unbound: ${promotedFrom.unbound}`;
  if (typeof revision !== 'string' || !/^[0-9a-f]{40}$/.test(revision)) return `records no promoting revision (${JSON.stringify(revision)})`;
  if (typeof blob !== 'string' || !/^[0-9a-f]{40}$/.test(blob)) return `records no promoter blob (${JSON.stringify(blob)})`;
  if (typeof path !== 'string' || path.length === 0 || path.startsWith('/') || path.split('/').includes('..')) {
    return `records no promoter path (${JSON.stringify(path)})`;
  }
  let type;
  try {
    type = git(root, 'cat-file', '-t', `${revision}^{commit}`);
  } catch {
    return `names revision ${revision.slice(0, 12)}, which this clone does not have`;
  }
  if (type !== 'commit') return `names ${revision.slice(0, 12)}, which is a ${type}, not a commit`;
  let committed;
  try {
    committed = git(root, 'rev-parse', `${revision}:${path}`);
  } catch {
    return `names ${path} at ${revision.slice(0, 12)}, where that path does not exist`;
  }
  if (committed !== blob) return `claims promoter blob ${blob.slice(0, 12)} at ${revision.slice(0, 12)}:${path}, which holds ${committed.slice(0, 12)}`;
  return null;
}

/**
 * Every capture in the store, not only the ones one check happens to name.
 *
 * The first version of this gate validated the two fixtures its own test loaded,
 * which left the four SSE captures another check consumes silently exempt — a
 * planted `promoterUncommitted: true` in one of them passed 4/4. Sweeping the
 * directory means adding a capture cannot quietly add an unverified one.
 */
export function verifyCaptureStore({ dir = captureDir, root = repoRoot } = {}) {
  const checked = [];
  const unbound = [];
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.json')).sort()) {
    const name = file.slice(0, -'.json'.length);
    checked.push(name);
    const why = whyUnbound(JSON.parse(readFileSync(join(dir, file), 'utf8')).promotedFrom, { root });
    if (why !== null) unbound.push(`${name} ${why}`);
  }
  return { checked, unbound };
}
