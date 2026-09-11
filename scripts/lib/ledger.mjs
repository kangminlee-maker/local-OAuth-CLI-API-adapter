// The measurement ledger's durability, which is not the same question as who may
// write it.
//
// `saveState()` opened the sole good ledger with truncation and rewrote the
// whole JSON object in place. A review ran that write under a deterministic size
// limit: the file was truncated mid-object, no longer parsed, and the run's paid
// samples were no longer resumable through any shipped path — the raw capture
// records survive, but neither resume nor `--report` reads them.
//
// The fix is not `rename`. The lock is keyed on the ledger's inode, and
// replacing the file replaces the inode, which would hand a second run a second
// lock identity in the middle of the first one's run. So the complete new
// content is written BESIDE the ledger first and removed after: at every instant
// one of the two files holds a whole, parseable state, and the ledger keeps the
// inode its lock is about.
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const shadowOf = (path) => `${path}.next`;

/** Write the ledger so that a failed write cannot leave zero readable copies. */
export function saveLedger(path, state) {
  const body = `${JSON.stringify(state, null, 2)}\n`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(shadowOf(path), body);
  writeFileSync(path, body);
  try {
    unlinkSync(shadowOf(path));
  } catch { /* already gone */ }
}

/**
 * The ledger, or the shadow when the ledger does not parse.
 *
 * Returns `null` when neither is readable, which the caller reads as a fresh
 * run — the same thing an absent ledger means.
 */
export function readLedger(path) {
  for (const candidate of [path, shadowOf(path)]) {
    if (!existsSync(candidate)) continue;
    try {
      return JSON.parse(readFileSync(candidate, 'utf8'));
    } catch { /* try the other one */ }
  }
  return null;
}
