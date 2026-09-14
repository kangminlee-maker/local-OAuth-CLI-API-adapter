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
// content is written BESIDE the ledger first: at every instant one of the two
// files holds a whole, parseable state, and the ledger keeps the inode its lock
// is about.
//
// That much was right and it was not enough, because two questions were left to
// POSITION rather than to evidence:
//
//   - which copy is newer. The reader tried the ledger and then the shadow, so a
//     save whose second write failed — the shadow complete, the ledger still
//     holding the previous state — was read back as the PREVIOUS state. A review
//     made the ledger unwritable, saved a paid sample, and read the run back
//     without it. Every copy now carries a generation and the newest valid one
//     wins.
//   - whether the copy being written can be destroyed by the write. Every save
//     truncated the shadow first, even when the shadow was the only copy that
//     parsed. A review left a valid shadow beside an invalid ledger, ran one
//     save under a size limit, and ended with two unreadable files. The shadow
//     is now replaced by rename, so a partial write cannot consume it — and
//     rename is available there precisely because nothing locks the shadow. The
//     ledger itself is still written in place, because its inode is the lock.
//
// And `null` used to mean both "no ledger" and "a ledger nothing can read",
// which the runner turned into a fresh run with the whole ceiling to spend
// again. Absent is `null`; present and unreadable throws.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const shadowOf = (path) => `${path}.next`;

/** A ledger that exists and cannot be read is not a run that has not started. */
export class UnreadableLedgerError extends Error {
  constructor(path) {
    super(`${path}: the ledger and its shadow both exist and neither parses, so what this run has already `
      + 'spent cannot be read. Starting over would re-grant a ceiling that has already been paid for.');
    this.name = 'UnreadableLedgerError';
    this.path = path;
  }
}

function readCopy(path) {
  if (!existsSync(path)) return { exists: false, state: null };
  try {
    const state = JSON.parse(readFileSync(path, 'utf8'));
    // A ledger written before generations were kept reads as generation 0, which
    // any subsequent save outranks.
    return { exists: true, state, generation: Number(state?.generation ?? 0) };
  } catch {
    return { exists: true, state: null };
  }
}

/** Write the ledger so that a failed write cannot leave zero readable copies. */
export function saveLedger(path, state) {
  const copies = [readCopy(path), readCopy(shadowOf(path))];
  const newest = copies.filter((copy) => copy.state).reduce(
    (best, copy) => (best === null || copy.generation > best.generation ? copy : best),
    null,
  );
  const body = `${JSON.stringify({ ...state, generation: (newest?.generation ?? 0) + 1 }, null, 2)}\n`;
  mkdirSync(dirname(path), { recursive: true });
  // The shadow is REPLACED, never truncated: a write that fails partway consumes
  // the scratch name and leaves the previous shadow whole. Nothing locks the
  // shadow, so its inode is free to change — which is the whole reason this is
  // available here and not for the ledger below.
  writeFileSync(`${shadowOf(path)}.writing`, body);
  renameSync(`${shadowOf(path)}.writing`, shadowOf(path));
  // ...and only then the ledger, in place, keeping the inode its lock is about.
  // A partial write here leaves a complete, newer copy beside it.
  writeFileSync(path, body);
}

/**
 * The newest readable copy of the ledger.
 *
 * `null` when there is no ledger at all — a run that has not started. Throws
 * when one exists and nothing can be read out of it, because that is a run whose
 * spending is unknown and the two cases used to be the same answer.
 */
export function readLedger(path) {
  const copies = [readCopy(path), readCopy(shadowOf(path))];
  const readable = copies.filter((copy) => copy.state);
  if (readable.length > 0) {
    // Without the generation: which copy is newer is the file format's business,
    // and a caller that round-trips the state should not carry a counter it does
    // not maintain.
    const { generation, ...state } = readable.reduce(
      (best, copy) => (copy.generation > best.generation ? copy : best),
    ).state;
    return state;
  }
  if (copies.some((copy) => copy.exists)) throw new UnreadableLedgerError(path);
  return null;
}
