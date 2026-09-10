// The A/A sidecar lock, as the thing it protects: one writer per state INODE,
// and a release that frees only what this process took.
//
// Both cases below are constructions a review ran end-to-end against the real
// sampler loop, and both ended the same way — the ceiling spent twice and one
// run's paid samples erased by the other's whole-state save. What follows is the
// same two constructions with the sampling removed, because the lock is the part
// that was wrong.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { acquireStateLock, canonicalStatePath } from '../scripts/lib/state-lock.mjs';

const roots = [];
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'aa-lock-'));
  roots.push(dir);
  return dir;
};
after(() => { for (const dir of roots) rmSync(dir, { recursive: true, force: true }); });

test('a symlink alias of the state file is the same writer', () => {
  const dir = scratch();
  const real = join(dir, 'state.json');
  writeFileSync(real, '{"rows":{},"spent":0}\n');
  const alias = join(dir, 'alias.json');
  symlinkSync(real, alias);

  const first = acquireStateLock(real);
  assert.ok(first.release, 'the first run did not get the lock');
  const second = acquireStateLock(alias);
  assert.equal(second.release, undefined, 'a second spelling of one inode took a second lock');
  assert.equal(second.lockPath, first.lockPath);
  first.release();
});

test('a state file that does not exist yet resolves through its directory', () => {
  // The discriminating half here is `canonicalStatePath` itself: a raw-string
  // lock inside a symlinked DIRECTORY happens to land on the same inode anyway,
  // so the acquire below would collide either way. What the old code could not
  // do is agree on the NAME before the file exists, which is what a run that
  // creates the state file needs.
  const dir = scratch();
  const nested = join(dir, 'runs');
  mkdirSync(nested);
  const aliasDir = join(dir, 'runs-alias');
  symlinkSync(nested, aliasDir);

  assert.equal(canonicalStatePath(join(aliasDir, 'new.json')), canonicalStatePath(join(nested, 'new.json')));
  const first = acquireStateLock(join(aliasDir, 'new.json'));
  const second = acquireStateLock(join(nested, 'new.json'));
  assert.ok(first.release);
  assert.equal(second.release, undefined, 'two runs racing to create one state file took two locks');
  first.release();
});

test('a late release does not free the lock somebody else now holds', () => {
  // The signal path called release and then `process.exit()`, which emits
  // `exit`, which called release again. Between the two, the next run acquires.
  const dir = scratch();
  const state = join(dir, 'state.json');
  const first = acquireStateLock(state);
  first.release();

  const second = acquireStateLock(state);
  assert.ok(second.release, 'the lock was not free after the owner released it');
  first.release();
  assert.ok(existsSync(second.lockPath), "a departing process unlinked the next run's lock");
  assert.equal(readFileSync(second.lockPath, 'utf8').trim(), second.token);
  second.release();
  assert.ok(!existsSync(second.lockPath));
});

test('the holder is reported by pid, not by token', () => {
  const dir = scratch();
  const state = join(dir, 'state.json');
  const first = acquireStateLock(state, { pid: 4242 });
  const second = acquireStateLock(state);
  assert.equal(second.heldBy, '4242');
  first.release();
});
