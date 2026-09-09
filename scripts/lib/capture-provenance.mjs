// What wrote a promoted capture, stated so that git can re-check it.
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
// The fix to that bound one file, and the next review walked through the gap
// that left: the promoter imports THIS module, so an uncommitted edit here wrote
// a fully bound-looking stamp. A program is not its entry file. So the stamp
// names every first-party source that runs — derived from the import graph, not
// declared — and promotion refuses unless git holds each of them, unchanged, at
// the revision it names.
//
// WHAT THIS DOES NOT CLAIM:
// - That a named path is a promoter. It binds artifacts to committed bytes; it
//   does not prove those bytes can promote anything, and it defends against
//   nothing that someone with commit rights writes by hand.
// - Anything about `node_modules`. The runtime and its packages are outside git
//   and outside this claim; only first-party sources are bound.
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

/** `merge-base --is-ancestor` answers by exit code; 1 is an answer, not a fault. */
function isAncestorOfHead(root, revision) {
  try {
    git(root, 'merge-base', '--is-ancestor', revision, 'HEAD');
    return true;
  } catch (error) {
    if (error.status === 1) return false;
    throw error;
  }
}

// Specifier forms this walk understands. Anything that is not a string literal
// is refused rather than guessed at, because a specifier computed at run time
// makes the set of files that execute underivable — and a stamp that silently
// omits one is the defect this exists to close.
const IMPORT_FROM = /(?:^|[\s;}])(?:import|export)\b[^;'"]*?\bfrom\s*(['"])([^'"]+)\1/g;
const IMPORT_BARE = /(?:^|[\s;}])import\s*(['"])([^'"]+)\1/g;
const IMPORT_CALL_LITERAL = /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g;
const IMPORT_CALL_ANY = /\bimport\s*\(/g;

function specifiers(text, where) {
  const found = [];
  for (const pattern of [IMPORT_FROM, IMPORT_BARE, IMPORT_CALL_LITERAL]) {
    for (const match of text.matchAll(pattern)) found.push(match[2]);
  }
  const calls = [...text.matchAll(IMPORT_CALL_ANY)].length;
  const literals = [...text.matchAll(IMPORT_CALL_LITERAL)].length;
  if (calls !== literals) {
    throw new Error(`${where} loads a module by a specifier that is not a literal, so the set of sources that run cannot be derived`);
  }
  return found;
}

/**
 * Every first-party source reachable from an entry file, in discovery order.
 * Bare and `node:` specifiers are the runtime, not our code, and are skipped.
 */
function sourceGraph(entry, root) {
  const seen = new Set();
  const order = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = realpathSync(queue.shift());
    if (seen.has(file)) continue;
    seen.add(file);
    order.push(file);
    const where = relative(root, file);
    for (const specifier of specifiers(readFileSync(file, 'utf8'), where)) {
      if (specifier.startsWith('.')) queue.push(resolve(dirname(file), specifier));
    }
  }
  return order;
}

/**
 * The binding for the program that is executing right now.
 *
 * Throws rather than degrading: a promotion that cannot state where its code
 * lives must not write an artifact that looks bound. Every failure mode a review
 * demonstrated exits through here — git missing, source untracked or ignored,
 * any source edited since the commit it names.
 */
export function bindingOfExecutingSource(entryUrl) {
  // `realpath` first: on macOS a temporary checkout is reached through a
  // symlink, and a path that disagrees with git's own spelling would compute a
  // relative path that resolves to nothing.
  const entry = realpathSync(fileURLToPath(entryUrl));
  // Ask git where the repository is rather than deriving it from this file's
  // position. `git -C <anywhere>` walks UP to the enclosing repository, so a
  // copy of this code under an ignored directory would otherwise ask about
  // `HEAD:scripts/...` — the path the ORIGINAL occupies — and inherit the
  // tracked file's blob as its own binding.
  const root = git(dirname(entry), 'rev-parse', '--show-toplevel');
  const revision = git(root, 'rev-parse', 'HEAD');
  const sources = [];
  for (const file of sourceGraph(entry, root)) {
    const path = relative(root, file);
    if (path.startsWith('..')) throw new Error(`${file} is outside ${root}, so no revision of it can name this code`);
    // The bytes on disk, hashed the way git hashes what it stores.
    const blob = git(root, 'hash-object', '--', file);
    let committed;
    try {
      committed = git(root, 'rev-parse', `${revision}:${path}`);
    } catch {
      throw new Error(`${path} does not exist at ${revision.slice(0, 12)}: an untracked or ignored source cannot be bound to a revision`);
    }
    if (committed !== blob) {
      throw new Error(`${path} on disk is ${blob.slice(0, 12)} but ${revision.slice(0, 12)} holds ${committed.slice(0, 12)}: that revision does not name the code that is running`);
    }
    sources.push({ path, blob });
  }
  sources.sort((left, right) => (left.path < right.path ? -1 : 1));
  return { revision, sources };
}

/**
 * Ask git whether a recorded binding can be true.
 * Returns `null` when it holds, and the reason it does not otherwise — a reason
 * rather than a boolean because "unbound" has several distinct causes and a
 * reader has to be told which one they are looking at.
 */
export function whyUnbound(promotedFrom, { root = repoRoot } = {}) {
  if (!promotedFrom || typeof promotedFrom !== 'object') return 'carries no promotedFrom record';
  // Any `unbound` key at all, whatever its value: the override writes a reason
  // there, and a record that carries one is making no claim to be checked.
  if ('unbound' in promotedFrom) return `was promoted unbound: ${JSON.stringify(promotedFrom.unbound)}`;
  const { revision, sources } = promotedFrom;
  if (typeof revision !== 'string' || !/^[0-9a-f]{40}$/.test(revision)) return `records no promoting revision (${JSON.stringify(revision)})`;
  if (!Array.isArray(sources) || sources.length === 0) return 'records no promoting sources';

  let type;
  try {
    // Deliberately NOT `^{commit}`, which peels a tag and would accept one as a
    // revision while reporting every other object type as simply missing.
    type = git(root, 'cat-file', '-t', revision);
  } catch {
    return `names revision ${revision.slice(0, 12)}, which this clone does not have`;
  }
  if (type !== 'commit') return `names ${revision.slice(0, 12)}, which is a ${type}, not a commit`;
  try {
    if (!isAncestorOfHead(root, revision)) {
      return `names ${revision.slice(0, 12)}, which is not in this checkout's history: a commit reachable from nothing is not evidence anyone can review`;
    }
  } catch (error) {
    return `names ${revision.slice(0, 12)}, whose place in history git could not answer: ${error.message}`;
  }

  for (const source of sources) {
    if (!source || typeof source !== 'object') return `records a source that is not a record (${JSON.stringify(source)})`;
    const { path, blob } = source;
    if (typeof blob !== 'string' || !/^[0-9a-f]{40}$/.test(blob)) return `records no blob for a source (${JSON.stringify(blob)})`;
    if (typeof path !== 'string' || path.length === 0 || path.startsWith('/') || path.split('/').includes('..')) {
      return `records no usable source path (${JSON.stringify(path)})`;
    }
    let committed;
    try {
      committed = git(root, 'rev-parse', `${revision}:${path}`);
    } catch {
      return `names ${path} at ${revision.slice(0, 12)}, where that path does not exist`;
    }
    if (committed !== blob) return `claims ${path} is ${blob.slice(0, 12)} at ${revision.slice(0, 12)}, which holds ${committed.slice(0, 12)}`;
  }
  return null;
}

/**
 * Every capture in the store, not only the ones one check happens to name.
 *
 * The first version of this gate validated the two fixtures its own test loaded,
 * which left the four SSE captures another check consumes silently exempt — a
 * planted stamp in one of them passed 4/4. Sweeping the directory means adding a
 * capture cannot quietly add an unverified one.
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
