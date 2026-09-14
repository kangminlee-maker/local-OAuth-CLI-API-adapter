// The ledger's durability: what is readable at the instant a write goes wrong.
//
// The shipped save opened the sole good ledger with truncation and rewrote the
// whole JSON object in place. A review ran that write under a deterministic size
// limit and the file was truncated mid-object: it no longer parsed, and the
// run's paid samples were no longer resumable through any shipped path.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { readLedger, saveLedger, UnreadableLedgerError } from '../scripts/lib/ledger.mjs';

const roots = [];
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'aa-ledger-'));
  roots.push(dir);
  return dir;
};
after(() => { for (const dir of roots) rmSync(dir, { recursive: true, force: true }); });

test('a saved ledger reads back, and the copy beside it is kept', () => {
  const path = join(scratch(), 'state.json');
  saveLedger(path, { rows: { 'openai/a': { samples: [{ chars: 1 }] } }, spent: 1 });
  assert.deepEqual(readLedger(path), { rows: { 'openai/a': { samples: [{ chars: 1 }] } }, spent: 1 });
  // The shadow used to be removed at the end of every save, which left exactly
  // one readable copy between saves — the state the two-file protocol exists to
  // avoid. It is kept, and which of the two is current is decided by generation
  // rather than by which name was tried first.
  assert.ok(existsSync(`${path}.next`), 'the copy the protocol depends on was deleted');
  // The generation is the format's, not the run's: a caller that reads and
  // writes the state back does not carry a counter it does not maintain.
  assert.equal(readLedger(path).generation, undefined);
});

test('the complete new content is on disk before the ledger is opened for truncation', () => {
  // The guarantee, stated as the instant it is about: whatever happens to the
  // ledger's own write, the content it was going to hold is already beside it.
  // Forced here by making the ledger unwritable, which is the only way to
  // observe the ordering from outside.
  const path = join(scratch(), 'state.json');
  saveLedger(path, { rows: {}, spent: 0 });
  chmodSync(path, 0o444);
  try {
    assert.throws(() => saveLedger(path, { rows: { 'openai/a': { samples: [{ chars: 7 }] } }, spent: 1 }));
    assert.ok(existsSync(`${path}.next`), 'the ledger was opened for truncation with no complete copy beside it');
    const { generation, ...shadow } = JSON.parse(readFileSync(`${path}.next`, 'utf8'));
    assert.deepEqual(shadow, { rows: { 'openai/a': { samples: [{ chars: 7 }] } }, spent: 1 });
    // ...and it is the copy the next read returns, because it is newer. The
    // reader used to try the ledger first and hand back the state this failed
    // write was replacing — the paid sample above, gone, with both files intact.
    assert.deepEqual(readLedger(path), { rows: { 'openai/a': { samples: [{ chars: 7 }] } }, spent: 1 },
      'the reader preferred the stale ledger to the newer copy beside it');
    assert.ok(generation > 0);
  } finally {
    chmodSync(path, 0o644);
  }
});

test('a ledger truncated mid-write is recovered from the shadow', () => {
  // The exact failure: the whole new content is beside the ledger BEFORE the
  // ledger is opened for truncation, so the instant that used to leave zero
  // readable copies now leaves one.
  const path = join(scratch(), 'state.json');
  const good = { rows: { 'openai/a': { samples: [{ chars: 11 }, { chars: 12 }] } }, spent: 2 };
  saveLedger(path, good);
  writeFileSync(`${path}.next`, `${JSON.stringify(good, null, 2)}\n`);
  writeFileSync(path, '{"rows":{"openai/a":{"samp');

  assert.deepEqual(readLedger(path), good, 'a truncated ledger lost a paid run that was recoverable');
});

test('a ledger nobody wrote is a fresh run, not a crash', () => {
  assert.equal(readLedger(join(scratch(), 'absent.json')), null);
});

test('the only copy that parses is not the one a failing write consumes', () => {
  // The construction a review ended two unreadable files with: an invalid ledger
  // beside a valid shadow, then one more save. The save used to truncate the
  // shadow first — the only copy that parsed — so a write that failed partway
  // destroyed the last recoverable state.
  const path = join(scratch(), 'state.json');
  const paid = { rows: { 'openai/a': { samples: [{ chars: 60 }] } }, spent: 60 };
  saveLedger(path, paid);
  writeFileSync(path, '{"rows":{"openai/a":{"samp');
  chmodSync(path, 0o444);
  try {
    assert.throws(() => saveLedger(path, { rows: {}, spent: 61 }));
    // The shadow was replaced by rename, so it is whole whatever happened next.
    assert.deepEqual(readLedger(path), { rows: {}, spent: 61 },
      'the save consumed the only copy that parsed');
  } finally {
    chmodSync(path, 0o644);
  }
});

test('the shadow is replaced, and the ledger is not', () => {
  // Two different guarantees in one sentence. The shadow gets a new inode every
  // save because rename is what makes a partial write survivable; the ledger
  // keeps its inode because that inode is the lock's identity, and replacing it
  // would hand a second run a second lock in the middle of this one's.
  const path = join(scratch(), 'state.json');
  saveLedger(path, { rows: {}, spent: 0 });
  const ledgerIno = statSync(path).ino;
  const shadowIno = statSync(`${path}.next`).ino;
  saveLedger(path, { rows: {}, spent: 1 });
  assert.equal(statSync(path).ino, ledgerIno, 'the save replaced the ledger instead of rewriting it');
  assert.notEqual(statSync(`${path}.next`).ino, shadowIno, 'the shadow was truncated in place');
  assert.ok(!existsSync(`${path}.next.writing`), 'the scratch name outlived the write');
});

test('a ledger that exists and cannot be read is not a run that has not started', () => {
  // Both answers used to be `null`, and the runner turned `null` into a fresh
  // run — so a corrupted pair re-granted a ceiling that had already been paid
  // for. Absent is still `null`; unreadable stops the run.
  const path = join(scratch(), 'state.json');
  writeFileSync(path, '{"rows":{"openai/a":{"samp');
  writeFileSync(`${path}.next`, 'not json at all');
  assert.throws(() => readLedger(path), UnreadableLedgerError);
  assert.equal(readLedger(join(scratch(), 'absent.json')), null);
});

test('the newest generation wins, whichever file holds it', () => {
  const path = join(scratch(), 'state.json');
  saveLedger(path, { rows: {}, spent: 1 });
  const older = JSON.parse(readFileSync(path, 'utf8'));
  saveLedger(path, { rows: {}, spent: 2 });
  // Put the older state back in the ledger by hand: the reader must still find
  // the newer one beside it rather than trusting the name it tried first.
  writeFileSync(path, `${JSON.stringify(older, null, 2)}\n`);
  assert.equal(readLedger(path).spent, 2, 'position decided which copy was current');
});

test('the ledger keeps its inode, because the lock is keyed on it', () => {
  // Not `rename`: replacing the file replaces the inode, which would hand the
  // next run a second lock identity in the middle of this one's run.
  const path = join(scratch(), 'state.json');
  saveLedger(path, { rows: {}, spent: 0 });
  const { ino } = statSync(path);
  saveLedger(path, { rows: {}, spent: 1 });
  assert.equal(statSync(path).ino, ino, 'the save replaced the ledger instead of rewriting it');
  assert.equal(readLedger(path).spent, 1);
});
