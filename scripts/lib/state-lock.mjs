// One writer per state FILE, where "file" means the inode and not the spelling.
//
// Without a lock, two invocations each start from the same ledger, each spend
// the whole ceiling, and — because the state is saved as a whole object from
// each process's own snapshot — the second erases the rows the first paid for.
// Through `--only`, which exists to partition a batch across processes, that is
// the ordinary way to run it.
//
// The lock this replaces was keyed on the string `${statePath}.lock` while the
// reads and writes followed symlinks to the target. A review pointed two runs at
// one state file through two spellings — a path and a symlink to it — and both
// took a sidecar, both loaded `spent: 0`, both spent the ceiling, and the survivor's
// whole-state save erased the other's paid samples. Two locks, one inode.
//
// The second bypass was ownership. `release` was registered on `exit` AND called
// by the signal handler before `process.exit(130)`, which itself emits `exit`:
// the same path was unlinked twice with no check that the lock still belonged to
// this process. Between the two, another run could acquire — and have its lock
// deleted out from under it by a process on its way out.
import { existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * The one spelling of a state path that two runs will agree on.
 *
 * An existing file is resolved through every symlink. One that does not exist
 * yet cannot be, so its DIRECTORY is resolved instead and the basename joined
 * back on: two runs racing to create the same state file still derive the same
 * lock.
 */
export function canonicalStatePath(statePath) {
  if (!statePath) return null;
  const target = resolve(statePath);
  if (existsSync(target)) return realpathSync(target);
  mkdirSync(dirname(target), { recursive: true });
  return join(realpathSync(dirname(target)), basename(target));
}

/**
 * Take the sidecar for `statePath`, or explain who holds it.
 *
 * Returns `{ lockPath, release }` on success and `{ lockPath, heldBy }` when
 * another run has it. `release` is idempotent and checks ownership: it unlinks
 * only a lock file that still carries THIS call's token, so a late or duplicated
 * release cannot free somebody else's.
 */
export function acquireStateLock(statePath, { pid = process.pid } = {}) {
  const canonical = canonicalStatePath(statePath);
  const lockPath = `${canonical}.lock`;
  const token = `${pid}:${randomUUID()}`;
  try {
    writeFileSync(lockPath, `${token}\n`, { flag: 'wx' });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    let heldBy = 'unknown';
    try {
      heldBy = readFileSync(lockPath, 'utf8').trim().split(':')[0];
    } catch { /* the holder released between the failed write and this read */ }
    return { lockPath, heldBy };
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      if (readFileSync(lockPath, 'utf8').trim() !== token) return;
      unlinkSync(lockPath);
    } catch { /* already gone */ }
  };
  return { lockPath, release, token };
}
