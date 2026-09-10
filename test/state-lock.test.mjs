// The A/A sidecar lock, as the thing it protects: one writer per state INODE,
// and a release that frees only what this process took.
//
// Both cases below are constructions a review ran end-to-end against the real
// sampler loop, and both ended the same way — the ceiling spent twice and one
// run's paid samples erased by the other's whole-state save. What follows is the
// same two constructions with the sampling removed, because the lock is the part
// that was wrong.
import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { acquireStateLock, canonicalStatePath, stateIdentity } from '../scripts/lib/state-lock.mjs';

const roots = [];
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'aa-lock-'));
  roots.push(dir);
  return dir;
};
// The sidecars live in one directory, not beside the state file — that is what
// makes two hard links in two different directories collide. Each case gets its
// own so the suite cannot collide with a real run or with itself.
const locked = (target, options = {}) => acquireStateLock(target, { lockDir: locks, ...options });
let locks;
before(() => { locks = scratch(); });
after(() => { for (const dir of roots) rmSync(dir, { recursive: true, force: true }); });

test('a symlink alias of the state file is the same writer', () => {
  const dir = scratch();
  const real = join(dir, 'state.json');
  writeFileSync(real, '{"rows":{},"spent":0}\n');
  const alias = join(dir, 'alias.json');
  symlinkSync(real, alias);

  const first = locked(real);
  assert.ok(first.release, 'the first run did not get the lock');
  const second = locked(alias);
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
  const first = locked(join(aliasDir, 'new.json'));
  const second = locked(join(nested, 'new.json'));
  assert.ok(first.release);
  assert.equal(second.release, undefined, 'two runs racing to create one state file took two locks');
  first.release();
});

test('two hard links to one ledger are one writer', () => {
  // `realpathSync` collapses symlinks and CANNOT collapse these: both names are
  // equally real and neither is derivable from the other. A review drove the
  // real sampling loop through both and got four calls against a ceiling of
  // two, with one runner's paid samples erased by the other's whole-state save.
  const dir = scratch();
  const real = join(dir, 'state.json');
  writeFileSync(real, '{"rows":{},"spent":0}\n');
  const alias = join(dir, 'hard-alias.json');
  linkSync(real, alias);

  const first = locked(real);
  assert.ok(first.release, 'the first run did not get the lock');
  const second = locked(alias);
  assert.equal(second.release, undefined, 'a second NAME for one inode took a second lock');
  first.release();
});

test('two hard links in different directories are still one writer', () => {
  // The reason the sidecar cannot live beside the state file: two directories,
  // one inode, and a lock named after either path would differ.
  const dir = scratch();
  const here = join(dir, 'here');
  const there = join(dir, 'there');
  mkdirSync(here);
  mkdirSync(there);
  const real = join(here, 'state.json');
  writeFileSync(real, '{"rows":{},"spent":0}\n');
  linkSync(real, join(there, 'state.json'));

  const first = locked(real);
  const second = locked(join(there, 'state.json'));
  assert.ok(first.release);
  assert.equal(second.release, undefined, 'one inode under two directories took two locks');
  first.release();
});

test('a dangling symlink is the file it will become, not a name of its own', () => {
  // `existsSync` is false for it, so a "not there yet" branch kept the alias's
  // own basename — and then the first save created the target THROUGH the link.
  // Both runs converge on one inode after the fact and neither knew.
  const dir = scratch();
  const real = join(dir, 'state.json');
  const alias = join(dir, 'dangling.json');
  symlinkSync(real, alias);
  assert.ok(!existsSync(alias), 'the alias is not dangling, so this case is not the one described');

  const first = locked(alias);
  assert.ok(first.release, 'the first run did not get the lock');
  assert.equal(first.statePath, canonicalStatePath(real),
    'the lock is on the alias rather than on what it points at');
  const second = locked(real);
  assert.equal(second.release, undefined, 'a dangling alias and its target took two locks');
  first.release();
});

test('a run that creates the ledger and one that finds it agree', () => {
  // Identity is an inode from the first moment, so the run that gets there
  // first cannot key on a name while the next one keys on a file.
  const dir = scratch();
  const state = join(dir, 'fresh.json');
  const first = locked(state);
  assert.ok(existsSync(state), 'the ledger was not created, so identity is still a name');
  assert.deepEqual(JSON.parse(readFileSync(state, 'utf8')), { rows: {}, spent: 0 });
  const second = locked(state);
  assert.equal(second.release, undefined, 'the second run keyed on something else');
  first.release();
});

test('a late release does not free the lock somebody else now holds', () => {
  // The signal path called release and then `process.exit()`, which emits
  // `exit`, which called release again. Between the two, the next run acquires.
  const dir = scratch();
  const state = join(dir, 'state.json');
  const first = locked(state);
  first.release();

  const second = locked(state);
  assert.ok(second.release, 'the lock was not free after the owner released it');
  first.release();
  assert.ok(existsSync(second.lockPath), "a departing process unlinked the next run's lock");
  assert.ok(readFileSync(second.lockPath, 'utf8').startsWith(`${second.token} `));
  second.release();
  assert.ok(!existsSync(second.lockPath));
});

test("a release after the lock was cleared by hand does not take the next run's", () => {
  // The once-flag covers the signal handler calling release before the `exit`
  // hook does. It cannot cover this: the refusal message tells a user to delete
  // a stale lock deliberately, so the FIRST release a process makes can already
  // be aimed at somebody else's file. Only the token knows the difference.
  const dir = scratch();
  const state = join(dir, 'state.json');
  const first = locked(state);
  rmSync(first.lockPath);

  const second = locked(state);
  assert.ok(second.release, 'the lock was not free after it was cleared by hand');
  first.release();
  assert.ok(existsSync(second.lockPath), "a run's first release freed a lock it never owned");
  second.release();
});

test('the holder is reported by pid, not by token', () => {
  const dir = scratch();
  const state = join(dir, 'state.json');
  const first = locked(state, { pid: 4242 });
  const second = locked(state);
  assert.equal(second.heldBy, '4242');
  first.release();
});

test('a name-keyed lock reserves a file that must not exist yet', () => {
  // The artifact is the other case: it must NOT be there, so there is no inode
  // to key on and creating a placeholder would be the run refusing itself. What
  // is reserved is the NAME.
  const dir = scratch();
  const artifact = join(dir, 'aa-noise-floor-20260910-openai.json');
  const first = locked(artifact, { create: false });
  assert.ok(first.release);
  assert.ok(!existsSync(artifact), 'the lock created the artifact it exists to reserve');
  const second = locked(artifact, { create: false });
  assert.equal(second.release, undefined, 'two runs reserved one artifact name');
  first.release();
});

