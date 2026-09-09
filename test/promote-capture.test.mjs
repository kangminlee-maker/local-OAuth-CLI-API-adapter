// The promoter turns a recorded exchange into evidence a gate will trust, so
// what it refuses matters more than what it accepts.
//
// It used to check the digest of the RESPONSE only. A source record whose
// request text had been edited therefore promoted with exit 0: the promoter
// took a fresh digest over the edited text and published that as the fixture's
// authenticated request, pairing a response for ever with a request that did
// not produce it. Everything downstream — "this field was omitted, and this is
// what came back" — rests on that pairing.
//
// The second thing it owes a gate is the binding: which code wrote the fixture,
// stated so git can re-check it. The cases below run a committed COPY of the
// promoter inside a throwaway repository, because the three ways the first
// attempt broke — edited source, ignored source, git missing — are properties of
// a checkout, and asserting them against this one would make the promoter's own
// tests fail whenever someone edits the promoter.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { whyUnbound } from '../scripts/lib/capture-provenance.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(repoRoot, 'scripts', 'promote-capture.mjs');
const sha = (text) => createHash('sha256').update(text).digest('hex');

const workspaces = [];
function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'promote-capture-'));
  workspaces.push(dir);
  mkdirSync(join(dir, 'runs', 'run-1'), { recursive: true });
  mkdirSync(join(dir, 'out'), { recursive: true });
  return dir;
}
after(() => {
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true });
});

/** A recorder-shaped exchange: digests over the ORIGINAL text, either encoding. */
function exchange({ request, response, gzip = false }) {
  const encode = (text) => (gzip
    ? { encoding: 'gzip+base64', bytes: Buffer.byteLength(text), sha256: sha(text), gzip: gzipSync(text).toString('base64') }
    : { encoding: 'utf8', bytes: Buffer.byteLength(text), sha256: sha(text), text });
  return {
    seq: 1,
    runId: 'run-1',
    kind: 'json',
    label: 'probe',
    method: 'POST',
    url: 'https://example.invalid/v1/responses',
    request: encode(request),
    status: 200,
    response: encode(response),
    stream: null,
  };
}

function write(dir, file, record) {
  writeFileSync(join(dir, 'runs', 'run-1', file), JSON.stringify(record, null, 2));
}

function promote(dir, extra = []) {
  return spawnSync(process.execPath, [
    script,
    '--name', 'fixture',
    '--from', join(dir, 'runs'),
    '--url', '/v1/responses',
    '--kind', 'json',
    '--out-dir', join(dir, 'out'),
    // These cases are about digests and selection, not about provenance, and
    // they run the WORKING copy of the promoter — which is uncommitted whenever
    // someone is editing it. The override keeps that from turning every
    // selection test red; the binding cases below use committed copies.
    '--allow-unbound-provenance',
    ...extra,
  ], { cwd: repoRoot, encoding: 'utf8' });
}

/** Git in a throwaway checkout, with an identity so `commit` works anywhere. */
function git(dir, ...argv) {
  const run = spawnSync('git', ['-C', dir, ...argv], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'promote-capture test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'promote-capture test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
    },
  });
  assert.equal(run.status, 0, `git ${argv.join(' ')}: ${run.stderr}`);
  return run.stdout.trim();
}

const PROMOTER = join('scripts', 'promote-capture.mjs');
const MODULE = join('scripts', 'lib', 'capture-provenance.mjs');

/** A repository whose only content is a committed copy of the promoter. */
function checkout() {
  const dir = workspace();
  mkdirSync(join(dir, 'scripts', 'lib'), { recursive: true });
  for (const rel of [PROMOTER, MODULE]) {
    copyFileSync(join(repoRoot, rel), join(dir, rel));
  }
  writeFileSync(join(dir, '.gitignore'), 'dist/\n');
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'the promoter, committed');
  return dir;
}

function promoteIn(dir, { from = join(dir, PROMOTER), extra = [], env = process.env } = {}) {
  return spawnSync(process.execPath, [
    from,
    '--name', 'fixture',
    '--from', join(dir, 'runs'),
    '--url', '/v1/responses',
    '--kind', 'json',
    '--out-dir', join(dir, 'out'),
    ...extra,
  ], { cwd: dir, encoding: 'utf8', env });
}

const REQUEST = '{"model":"m","input":"ping"}';
const RESPONSE = '{"object":"response","temperature":1}';
const SELECT = ['--request-must-be', REQUEST];

test('CONTROL: an intact exchange promotes, carrying the request and both digests', () => {
  const dir = workspace();
  write(dir, '0001.json', exchange({ request: REQUEST, response: RESPONSE }));
  const run = promote(dir, SELECT);
  assert.equal(run.status, 0, run.stderr);
  const fixture = JSON.parse(readFileSync(join(dir, 'out', 'fixture.json'), 'utf8'));
  assert.equal(fixture.request, REQUEST);
  assert.equal(fixture.requestSha256, sha(REQUEST));
  assert.equal(fixture.body, RESPONSE);
  assert.equal(fixture.bodySha256, sha(RESPONSE));
});

test('a source record whose REQUEST text was edited is refused, not re-blessed', () => {
  const dir = workspace();
  const record = exchange({ request: REQUEST, response: RESPONSE });
  // The digest still names the original request; only the text was changed —
  // exactly what an edited or truncated source record looks like.
  record.request.text = '{"model":"m","input":"ping","temperature":0.5}';
  write(dir, '0001.json', record);
  const run = promote(dir, ['--request-must-be', record.request.text]);
  assert.equal(run.status, 1, `expected a refusal, got ${run.status}: ${run.stdout}`);
  assert.match(run.stderr, /recorded request does not match its own digest/);
  assert.throws(() => readFileSync(join(dir, 'out', 'fixture.json')), /ENOENT/);
});

test('a source record whose RESPONSE text was edited is refused', () => {
  const dir = workspace();
  const record = exchange({ request: REQUEST, response: RESPONSE });
  record.response.text = '{"object":"response","temperature":2}';
  write(dir, '0001.json', record);
  const run = promote(dir, SELECT);
  assert.equal(run.status, 1, `expected a refusal, got ${run.status}: ${run.stdout}`);
  assert.match(run.stderr, /recorded response does not match its own digest/);
});

test('a gzip-stored body promotes: the recorder compresses, it does not discard', () => {
  // Bodies over the recorder's inline limit are stored `gzip+base64` with the
  // digest still over the original text. Reading only `text` made every long
  // or image-bearing exchange look unpromotable.
  const dir = workspace();
  const long = `{"object":"response","filler":"${'x'.repeat(70_000)}"}`;
  write(dir, '0001.json', exchange({ request: REQUEST, response: long, gzip: true }));
  const run = promote(dir, SELECT);
  assert.equal(run.status, 0, run.stderr);
  const fixture = JSON.parse(readFileSync(join(dir, 'out', 'fixture.json'), 'utf8'));
  assert.equal(fixture.body, long);
  assert.equal(fixture.bodySha256, sha(long));
});

test('two exchanges that both satisfy the conditions are refused, not ordered', () => {
  // Picking the first by directory mtime publishes a choice nobody made: the
  // two differ in the request, which is the whole evidence for what was omitted.
  const dir = workspace();
  write(dir, '0001.json', exchange({ request: '{"model":"m","input":"WRONG"}', response: RESPONSE }));
  write(dir, '0002.json', exchange({ request: REQUEST, response: RESPONSE }));
  const ambiguous = promote(dir, []);
  assert.equal(ambiguous.status, 2, 'a buffered promotion must name its request');
  assert.match(ambiguous.stderr, /--request-must-be is required/);

  // Named, it takes the one it was told to take.
  const named = promote(dir, SELECT);
  assert.equal(named.status, 0, named.stderr);
  assert.equal(JSON.parse(readFileSync(join(dir, 'out', 'fixture.json'), 'utf8')).request, REQUEST);
});

test('two IDENTICAL requests with different responses are refused as ambiguous', () => {
  const dir = workspace();
  write(dir, '0001.json', exchange({ request: REQUEST, response: RESPONSE }));
  write(dir, '0002.json', exchange({ request: REQUEST, response: '{"object":"response","temperature":2}' }));
  const run = promote(dir, SELECT);
  assert.equal(run.status, 1, `expected a refusal, got ${run.status}: ${run.stdout}`);
  assert.match(run.stderr, /match and they are not the same exchange/);
});

test('CONTROL: a committed promoter binds EVERY source it runs to the blob git holds', () => {
  const dir = checkout();
  write(dir, '0001.json', exchange({ request: REQUEST, response: RESPONSE }));
  const run = promoteIn(dir, { extra: SELECT });
  assert.equal(run.status, 0, run.stderr);

  const { promotedFrom } = JSON.parse(readFileSync(join(dir, 'out', 'fixture.json'), 'utf8'));
  assert.equal(promotedFrom.revision, git(dir, 'rev-parse', 'HEAD'));
  // Both files, derived from the import graph rather than declared: the entry
  // file alone left an uncommitted edit to the module it imports invisible.
  assert.deepEqual(promotedFrom.sources.map((source) => source.path).sort(), [MODULE, PROMOTER].sort());
  for (const { path, blob } of promotedFrom.sources) {
    assert.equal(blob, git(dir, 'hash-object', '--', join(dir, path)), `${path} is not bound to its own bytes`);
  }
  assert.equal(whyUnbound(promotedFrom, { root: dir }), null);

  // The verifier is not vacuous: the same record read against a repository that
  // does not have that revision is rejected, naming what is missing.
  assert.match(whyUnbound(promotedFrom, { root: repoRoot }) ?? '', /this clone does not have/);
});

test('an edited MODULE refuses too: the program is not its entry file', () => {
  // The gap the entry-file-only binding left. The promoter is committed and
  // unchanged; the code it imports is not, and it is what decides the stamp.
  const dir = checkout();
  write(dir, '0001.json', exchange({ request: REQUEST, response: RESPONSE }));
  appendFileSync(join(dir, MODULE), '\n// an edit that is not in HEAD\n');
  const run = promoteIn(dir, { extra: SELECT });
  assert.equal(run.status, 2, `expected a refusal, got ${run.status}: ${run.stdout}`);
  assert.match(run.stderr, /scripts\/lib\/capture-provenance\.mjs on disk is .* does not name the code that is running/);
  assert.throws(() => readFileSync(join(dir, 'out', 'fixture.json')), /ENOENT/);
});

test('a record that carries an unbound key is rejected whatever that key holds', () => {
  // `--allow-unbound-provenance` writes a reason there. A hand-written `true`
  // beside an otherwise valid triple used to be read as bound, because only a
  // string was treated as the override's mark.
  const dir = checkout();
  write(dir, '0001.json', exchange({ request: REQUEST, response: RESPONSE }));
  assert.equal(promoteIn(dir, { extra: SELECT }).status, 0);
  const { promotedFrom } = JSON.parse(readFileSync(join(dir, 'out', 'fixture.json'), 'utf8'));
  assert.equal(whyUnbound(promotedFrom, { root: dir }), null);
  for (const value of [true, {}, null, 'a reason']) {
    assert.match(
      whyUnbound({ ...promotedFrom, unbound: value }, { root: dir }) ?? '',
      /was promoted unbound/,
      `unbound: ${JSON.stringify(value)} was read as bound`,
    );
  }
});

test('a revision no branch reaches is refused: evidence has to be reviewable', () => {
  const dir = checkout();
  write(dir, '0001.json', exchange({ request: REQUEST, response: RESPONSE }));
  assert.equal(promoteIn(dir, { extra: SELECT }).status, 0);
  const { promotedFrom } = JSON.parse(readFileSync(join(dir, 'out', 'fixture.json'), 'utf8'));

  // Abandon the commit the fixture names: a second commit on a branch that the
  // first is not part of. The object still exists, and git can still answer
  // every question about its contents — which is why shape and blob checks
  // accept it and only reachability does not.
  git(dir, 'checkout', '-q', '--orphan', 'elsewhere');
  git(dir, 'commit', '-qm', 'a history the stamped commit is not in');
  assert.equal(git(dir, 'cat-file', '-t', promotedFrom.revision), 'commit');
  assert.match(whyUnbound(promotedFrom, { root: dir }) ?? '', /is not in this checkout's history/);
});

test('a promoter edited since its commit refuses: HEAD no longer names the code that runs', () => {
  const dir = checkout();
  write(dir, '0001.json', exchange({ request: REQUEST, response: RESPONSE }));
  appendFileSync(join(dir, PROMOTER), '\n// an edit that is not in HEAD\n');
  const run = promoteIn(dir, { extra: SELECT });
  assert.equal(run.status, 2, `expected a refusal, got ${run.status}: ${run.stdout}`);
  assert.match(run.stderr, /does not name the code that is running/);
  assert.throws(() => readFileSync(join(dir, 'out', 'fixture.json')), /ENOENT/);
});

test('a promoter run from an IGNORED path refuses, instead of inheriting the tracked blob', () => {
  // The construction a review used to defeat the first attempt: `dist/` is
  // ignored, so a copy there is untracked, but `git -C` walks up to the same
  // repository — and a check that asked about `scripts/promote-capture.mjs`
  // rather than about the file that is executing found the tracked blob and
  // called the copy clean.
  const dir = checkout();
  write(dir, '0001.json', exchange({ request: REQUEST, response: RESPONSE }));
  const hidden = join(dir, 'dist', 'probe');
  mkdirSync(join(hidden, 'scripts', 'lib'), { recursive: true });
  for (const rel of [PROMOTER, MODULE]) {
    copyFileSync(join(dir, rel), join(hidden, rel));
  }
  assert.equal(
    spawnSync('git', ['-C', dir, 'check-ignore', join(hidden, PROMOTER)], { encoding: 'utf8' }).status,
    0,
    'the copy is supposed to be ignored; this case proves nothing otherwise',
  );

  const run = promoteIn(dir, { from: join(hidden, PROMOTER), extra: SELECT });
  assert.equal(run.status, 2, `expected a refusal, got ${run.status}: ${run.stdout}`);
  assert.match(run.stderr, /dist\/probe\/scripts\/promote-capture\.mjs does not exist at/);
  assert.throws(() => readFileSync(join(dir, 'out', 'fixture.json')), /ENOENT/);
});

test('with git unavailable it refuses, and the override writes something no gate accepts', () => {
  const dir = checkout();
  write(dir, '0001.json', exchange({ request: REQUEST, response: RESPONSE }));
  // Node is invoked by absolute path, so only git goes missing.
  const blind = { ...process.env, PATH: join(dir, 'no-such-bin') };

  const refused = promoteIn(dir, { extra: SELECT, env: blind });
  assert.equal(refused.status, 2, `expected a refusal, got ${refused.status}: ${refused.stdout}`);
  assert.match(refused.stderr, /refusing to promote/);
  assert.throws(() => readFileSync(join(dir, 'out', 'fixture.json')), /ENOENT/);

  // An override may still produce local output — it may not produce evidence.
  const overridden = promoteIn(dir, { extra: [...SELECT, '--allow-unbound-provenance'], env: blind });
  assert.equal(overridden.status, 0, overridden.stderr);
  const { promotedFrom } = JSON.parse(readFileSync(join(dir, 'out', 'fixture.json'), 'utf8'));
  assert.equal(typeof promotedFrom.unbound, 'string');
  assert.match(whyUnbound(promotedFrom, { root: dir }) ?? '', /was promoted unbound/);
});
