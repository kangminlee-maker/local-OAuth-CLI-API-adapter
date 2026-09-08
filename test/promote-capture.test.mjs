// The promoter turns a recorded exchange into evidence a gate will trust, so
// what it refuses matters more than what it accepts.
//
// It used to check the digest of the RESPONSE only. A source record whose
// request text had been edited therefore promoted with exit 0: the promoter
// took a fresh digest over the edited text and published that as the fixture's
// authenticated request, pairing a response for ever with a request that did
// not produce it. Everything downstream — "this field was omitted, and this is
// what came back" — rests on that pairing.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

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
    ...extra,
  ], { cwd: repoRoot, encoding: 'utf8' });
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
