// One writer per state FILE, where "file" means the inode and not the spelling.
//
// Without a lock, two invocations each start from the same ledger, each spend
// the whole ceiling, and — because the state is saved as a whole object from
// each process's own snapshot — the second erases the rows the first paid for.
// Through `--only`, which exists to partition a batch across processes, that is
// the ordinary way to run it.
//
// Three ways of spelling one file have been walked through this in review, each
// ending the same way — four calls against a ceiling of two, and one runner's
// paid samples gone:
//
//   1. A path and a SYMLINK to it. The first lock was keyed on the string
//      `${statePath}.lock` while the reads and writes followed the link.
//   2. Two HARD LINKS. `realpathSync` collapses symlinks and cannot collapse
//      these: both names are equally real, and neither is derivable from the
//      other. Nothing spelled as a path can tell them apart.
//   3. A DANGLING symlink to a state file that does not exist yet. `existsSync`
//      is false for it, so a "the file is not there" branch resolved only the
//      directory and kept the alias's own basename — and then the first save
//      created the target THROUGH the link, converging on one inode.
//
// So identity is not a path at all. It is the inode, and the way to have one
// before the first save is to make the file first: whoever wins `wx` creates the
// ledger, everyone else stats what is there, and both arrive at the same key.
// The sidecar then lives in ONE directory, so two hard links in two different
// directories still collide.
//
// Ownership is the other half. `release` used to be registered on `exit` AND
// called by the signal handler before `process.exit(130)`, which itself emits
// `exit`: the same path was unlinked twice with no check that the lock still
// belonged to this process. And the refusal message tells a user to delete a
// stale lock deliberately, so even a FIRST release can be aimed at somebody
// else's file. Each lock carries a token and unlinks only what still holds it.
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

const FRESH_STATE = '{\n  "rows": {},\n  "spent": 0\n}\n';
const MAX_LINK_HOPS = 32;

/**
 * Follow a symlink chain to the name the writes will land on, whether or not
 * anything is there yet.
 *
 * `realpathSync` cannot do this: it throws on a link whose target does not
 * exist, which is exactly the case that mattered.
 */
function resolveLinkChain(statePath) {
  let current = resolve(statePath);
  for (let hop = 0; hop < MAX_LINK_HOPS; hop += 1) {
    let link;
    try {
      link = lstatSync(current);
    } catch {
      return canonicalise(current);
    }
    if (!link.isSymbolicLink()) return canonicalise(current);
    current = resolve(dirname(current), readlinkSync(current));
  }
  throw new Error(`${statePath} is a symlink chain more than ${MAX_LINK_HOPS} deep`);
}

/**
 * The real path of something that may not exist yet: resolve the deepest
 * ancestor that DOES exist and re-join the rest. A run that creates the state
 * file and one that finds it there have to agree on the directory even before
 * the leaf is real.
 */
function canonicalise(path) {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch { /* not there yet */ }
  const parent = dirname(absolute);
  if (parent === absolute) return absolute;
  return join(canonicalise(parent), basename(absolute));
}

/** The one spelling of a state path that every run will agree on. */
export function canonicalStatePath(statePath) {
  if (!statePath) return null;
  const target = resolveLinkChain(statePath);
  mkdirSync(dirname(target), { recursive: true });
  return target;
}

/**
 * The inode two runs must agree on, creating the ledger if it is not there.
 *
 * Creating it is not a side effect worth avoiding: the script's own fresh state
 * is this object, and it would write exactly this on its first save. What it
 * buys is that identity is an inode from the first moment, so a run that starts
 * before the file exists and one that starts after cannot key on different
 * things.
 */
export function stateIdentity(statePath, { create = true } = {}) {
  const path = canonicalStatePath(statePath);
  // A file that must NOT exist yet — the artifact — has no inode to key on, and
  // a name is the right key for it: what is being reserved is the NAME, and the
  // run refuses to start if anything is already there. Creating a placeholder
  // would be the run refusing itself.
  if (!create) {
    return { path, key: `name-${createHash('sha256').update(path).digest('hex').slice(0, 32)}` };
  }
  try {
    writeFileSync(path, FRESH_STATE, { flag: 'wx' });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const { dev, ino } = statSync(path);
  return { path, key: `${dev}-${ino}` };
}

/**
 * Take the sidecar for `statePath`, or explain who holds it.
 *
 * Returns `{ lockPath, statePath, release }` on success and
 * `{ lockPath, statePath, heldBy }` when another run has it. `release` is
 * idempotent and ownership-checked: it unlinks only a lock file that still
 * carries THIS call's token.
 */
export function acquireStateLock(target, { pid = process.pid, lockDir = null, create = true } = {}) {
  const { path, key } = stateIdentity(target, { create });
  const dir = lockDir ?? join(tmpdir(), 'aa-noise-floor-locks');
  mkdirSync(dir, { recursive: true });
  const lockPath = join(dir, `${key}.lock`);
  const token = `${pid}:${randomUUID()}`;
  try {
    writeFileSync(lockPath, `${token} ${path}\n`, { flag: 'wx' });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    let heldBy = 'unknown';
    try {
      heldBy = readFileSync(lockPath, 'utf8').trim().split(':')[0];
    } catch { /* the holder released between the failed write and this read */ }
    return { lockPath, statePath: path, heldBy };
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      if (!readFileSync(lockPath, 'utf8').startsWith(`${token} `)) return;
      unlinkSync(lockPath);
    } catch { /* already gone */ }
  };
  return { lockPath, statePath: path, release, token };
}
