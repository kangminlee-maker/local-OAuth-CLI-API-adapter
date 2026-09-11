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
import { readLedger, saveLedger } from '../scripts/lib/ledger.mjs';

const roots = [];
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'aa-ledger-'));
  roots.push(dir);
  return dir;
};
after(() => { for (const dir of roots) rmSync(dir, { recursive: true, force: true }); });

test('a saved ledger reads back, and leaves no shadow behind', () => {
  const path = join(scratch(), 'state.json');
  saveLedger(path, { rows: { 'openai/a': { samples: [{ chars: 1 }] } }, spent: 1 });
  assert.deepEqual(readLedger(path), { rows: { 'openai/a': { samples: [{ chars: 1 }] } }, spent: 1 });
  assert.ok(!existsSync(`${path}.next`), 'the shadow outlived the write it exists for');
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
    assert.deepEqual(JSON.parse(readFileSync(`${path}.next`, 'utf8')),
      { rows: { 'openai/a': { samples: [{ chars: 7 }] } }, spent: 1 });
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
