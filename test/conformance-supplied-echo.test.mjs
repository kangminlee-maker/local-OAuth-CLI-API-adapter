// A client supplies ONE option. What comes back?
//
// `conformance-echoed-defaults` answers that for a request that configures
// nothing, which is the first call an SDK makes. This answers it for the second
// one: the call that asks for something. The matrix's largest column is about
// exactly this — whether an option is honoured, mirrored, silently ignored, or
// refused — and until now that column was prose.
//
// The asymmetry is the same and for the same reason: the vendor side is a
// FROZEN promoted capture (its request bytes and its response bytes, with
// digests), and our side is LIVE — the real server, started here, answering
// those same request bytes. Two frozen fixtures would only ever detect fixture
// drift.
//
// Three things are compared, in the order a client meets them:
//
//   1. the STATUS. A surface that refuses what the vendor accepts is a
//      divergence a client cannot work around, and it is the one this gate
//      found on its first run.
//   2. the SHAPE, as typed key paths, with what we structurally do not report
//      declared in `spec/declared-divergences.json` and required to still be true.
//   3. the ECHO of the option the request supplied. This is the claim: a client
//      reads its own option back to learn what the surface did with it, and an
//      option echoed as something the vendor would not echo tells it a lie
//      about the turn it is about to receive.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { startLocalApiProxy } from '../dist/proxy/http-server.js';
import { verifyCaptureStore } from '../scripts/lib/capture-provenance.mjs';
import { PER_CALL, absentPathsFor, creditedAbsences, expectedAbsentPaths, isDeclaredAbsent, keyPaths, leafValues, rootOf, valueDivergencesFor } from '../scripts/lib/response-comparison.mjs';
import { REPLAYED_FIXTURES, SUPPLIED_ECHO_CAPTURES as CAPTURES, assertRosterReplayed, startReplayRecorder,
  createReplayBackend,
} from './replayed-captures.mjs';

const specDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'spec');
// A capture this gate's roster does not name cannot be read here. A review
// repointed a gate's own driver at a different fixture while leaving the roster
// and the manifest alone: every check still certified the capture the roster
// advertised, and nothing replayed it. Advertising and reading are the same act
// now.
const ROSTER = new Set(CAPTURES.map((row) => row.fixture));
const load = (name) => {
  assert.ok(ROSTER.has(name), `${name} is not one of this gate's roster captures`);
  return JSON.parse(readFileSync(join(specDir, 'captures', `${name}.json`), 'utf8'));
};

let started;
let replay;
let recorder;
const answers = new Map();
// A declared value divergence is identified by the WHOLE tuple. Keying it by
// path let a second declaration on the same path — with values neither side
// sends — count as exhibited because the true one was: a review planted a false
// summary tuple and the gate passed 29/29. The key is built by serialising the
// tuple rather than interpolating it, so two declarations cannot collide by
// writing the same characters in different fields, and a non-string field
// cannot be flattened into one that matches. `validateDeclarations` has already
// refused anything but JSON text on either side.
const tupleKey = (surface, entry) => JSON.stringify([surface, entry.path, entry.vendor, entry.proxy]);

before(async () => {
  replay = createReplayBackend();
  started = await startLocalApiProxy({
    host: '127.0.0.1',
    port: 0,
    requestTimeoutMs: 10_000,
    backend: replay.backend,
  });
  recorder = await startReplayRecorder(started.url);

  // The capture's own request bytes, forwarded verbatim: re-typing them would
  // ask a different question than the one the vendor answered.
  for (const { fixture, surface, answer } of CAPTURES) {
    const capture = load(fixture);
    // What the backend behind the proxy says for THIS row. A vendor turn that
    // ran out of tokens before writing anything, or ran its text into a stop
    // sequence, has a shape our side cannot reach while the backend answers
    // `OK` to everything — and reading that as "the proxy differs" is reading
    // the answer we supplied as a fact about the proxy.
    replay.answerWith(answer);
    const res = await fetch(`${recorder.url}${surface}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: capture.request,
    });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = null; }
    answers.set(fixture, { status: res.status, body, text });
  }
});

// Measured on the wire, by a recorder in front of the proxy, and compared by
// the registry against its own rows. A gate that records what it MEANT to send
// records nothing: the first version of this hashed the capture the row names
// while the driver posted a different one, and the mutant written for exactly
// that survived.
test('what crossed the wire is what the registry names', () => {
  assertRosterReplayed('supplied', recorder.seen);
});

after(async () => {
  await recorder?.close();
  await started?.close();
});

test('the gate covers each capture once, on a surface it names', () => {
  assert.equal(new Set(CAPTURES.map((row) => row.fixture)).size, CAPTURES.length);
  // Three surfaces now. `/v1/messages` arrived last because its turns are the
  // ones whose shape follows what the vendor generated, and the gate could not
  // answer the way those turns went until a row could name its own answer.
  assert.deepEqual(
    [...new Set(CAPTURES.map((row) => row.surface))].sort(),
    ['/v1/chat/completions', '/v1/messages', '/v1/responses'],
  );
});

test('the captures this check reads are present, intact, and about the option they name', () => {
  const { checked, unbound } = verifyCaptureStore();
  assert.deepEqual(unbound, [], 'promoted captures whose provenance git cannot confirm');

  for (const { fixture, supplied } of CAPTURES) {
    assert.ok(checked.includes(fixture), `${fixture} is not among the ${checked.length} verified captures`);
    const capture = load(fixture);
    assert.equal(capture.kind, 'json', `${fixture} is not a buffered capture`);
    assert.equal(capture.status, 200, `${fixture} did not record a 200`);
    for (const [field, digest] of [['body', 'bodySha256'], ['request', 'requestSha256']]) {
      assert.equal(
        createHash('sha256').update(capture[field]).digest('hex'),
        capture[digest],
        `${fixture} ${field} no longer matches the capture it was promoted from`,
      );
    }
    // The row's claim has to be about this capture: an option named here but
    // absent from the request would make the echo check below vacuous, and it
    // would pass.
    const request = JSON.parse(capture.request);
    for (const option of supplied) {
      assert.ok(option in request, `${fixture} does not supply ${option}, so this row claims nothing`);
    }
  }
});

// Reading one row's echo: what it compared, where the two sides differ, and
// which declared value divergences this row's own answer exhibits.
//
// It is a function and not a test body because two tests need the same reading.
// The exhibition set used to be filled as a side effect of the per-row tests
// and read afterwards by the participation check, which made that check's
// verdict depend on its siblings having run — under a filter, or a runner that
// reorders, it certified declarations nothing had replayed.
function readEcho({ fixture, surface, supplied, alsoCompare }) {
  const capture = load(fixture);
  const vendor = JSON.parse(capture.body);
  const ours = answers.get(fixture);

  const absent = new Set(absentPathsFor(surface));
  const divergences = new Map();
  for (const entry of valueDivergencesFor(surface)) {
    divergences.set(entry.path, [...(divergences.get(entry.path) ?? []), entry]);
  }
  const vendorLeaves = leafValues(vendor, '', new Map());
  const ourLeaves = leafValues(ours.body, '', new Map());

  const differences = [];
  const exhibited = new Set();
  let compared = 0;
  for (const [path, value] of vendorLeaves) {
    // Only what this row claims. The rest of the body is the sibling gate's
    // claim, and reading it here would make every fixture a second copy of
    // that comparison.
    const claimed = supplied.includes(rootOf(path)) || (alsoCompare ?? []).includes(path);
    if (!claimed) continue;
    if (PER_CALL.has(rootOf(path)) && !path.endsWith('[]#')) continue;
    if (isDeclaredAbsent(absent, path)) continue;
    compared += 1;
    const ourValue = ourLeaves.get(path);

    if (ourValue === value) continue;

    // The two sides differ. A declaration may say so — and if it does, it has
    // to name both sides exactly: an exemption that only says "this path may
    // differ" would wave through any future value on either side. A
    // declaration is also not surface-wide the way an absence is, because
    // whether the values differ depends on what the request asked for.
    // Every declaration for this path, not the first: two of them may name
    // the same field and only one can be true of this turn.
    const candidates = divergences.get(path) ?? [];
    const matched = candidates.find((entry) => value === entry.vendor && ourValue === entry.proxy);
    if (matched) {
      exhibited.add(tupleKey(surface, matched));
      continue;
    }
    differences.push(candidates.length > 0
      ? `${path}: declared ${candidates.map((entry) => `vendor ${entry.vendor} / proxy ${entry.proxy}`).join(' or ')}, measured vendor ${value} / proxy ${ourValue ?? '(absent)'}`
      : `${path}: vendor ${value}, proxy ${ourValue ?? '(absent)'}`);
  }

  const echoedPaths = [...vendorLeaves.keys()].filter((path) => supplied.includes(rootOf(path)));
  return { compared, differences, exhibited, echoedPaths };
}

for (const { fixture, surface, supplied, echoed, alsoCompare, harnessGaps, harnessPremise, vendorPaths } of CAPTURES) {
  test(`${fixture}: the proxy answers in the vendor's shape`, () => {
    const capture = load(fixture);
    const vendor = JSON.parse(capture.body);
    const ours = answers.get(fixture);

    // Status first: everything below reads a body that a refusal does not have,
    // and "we refuse what the vendor accepts" is the difference a client feels
    // hardest.
    assert.equal(
      ours.status,
      capture.status,
      `${fixture}: the vendor answered ${capture.status}, the proxy ${ours.status}: ${ours.text.slice(0, 200)}`,
    );

    const theirs = keyPaths(vendor);
    const mine = keyPaths(ours.body);
    assert.equal(theirs.size, vendorPaths, `${fixture}: the frozen capture's shape changed`);

    const onlyOurs = [...mine.keys()].filter((path) => !theirs.has(path)).sort();
    const onlyVendor = new Map([...theirs].filter(([path]) => !mine.has(path)).sort());

    assert.deepEqual(onlyOurs, [], `${fixture}: the proxy reports fields the vendor does not`);

    // A declaration is credited only where the FIELD it names is missing. A
    // review answered `logprobs: {content: []}` — present and empty — and the
    // only missing path was the array member's, whose field is the content
    // itself; crediting that satisfied a declaration that the field is not
    // reported at all.
    // An exemption only counts once its premise is shown to hold. The gaps
    // below are consequences of our turn lacking an output item the vendor's
    // turn has, and a review built the case that breaks that reasoning: give
    // our side a reasoning item of its own and the exemptions keep covering
    // disagreements that are no longer about a missing member.
    const gaps = harnessGaps ?? [];
    if (gaps.length > 0) {
      assert.ok(harnessPremise, `${fixture}: harness gaps without the premise that explains them`);
      const typesOf = (body) => (body?.output ?? body?.choices ?? []).map((item) => item?.type ?? null);
      assert.deepEqual(typesOf(vendor), harnessPremise.vendor, `${fixture}: the vendor's turn is not the one these gaps describe`);
      assert.deepEqual(typesOf(ours.body), harnessPremise.ours, `${fixture}: our turn is not the one these gaps describe`);
    }

    const declared = [...new Set(expectedAbsentPaths(surface, theirs))].sort();
    const { credited, uncredited } = creditedAbsences(declared, gaps, onlyVendor, mine);
    assert.deepEqual(uncredited, [], `${fixture}: fields missing from the proxy's answer that no declaration covers`);
    assert.deepEqual(credited, [...new Set([...declared, ...gaps])].sort(), `${fixture}: a declared absence this capture no longer shows`);
  });

  test(`${fixture}: the option the request supplied comes back as the vendor sends it`, () => {
    const capture = load(fixture);
    const ours = answers.get(fixture);
    assert.equal(ours.status, capture.status, `${fixture}: refused, so there is no echo to read`);

    const { compared, differences, echoedPaths } = readEcho({ fixture, surface, supplied, alsoCompare });

    if (echoed) {
      // An option that contributes no leaf is an option this row cannot speak
      // for: the check would pass by comparing nothing.
      assert.ok(compared > 0, `${fixture}: none of ${supplied.join(', ')} reached the comparison`);
    } else {
      // The other direction is a claim too. Chat's answer carries no `n`, no
      // `logprobs` and no `response_format`, so a client cannot read back what
      // it asked for — and if that ever changes, this row should fail rather
      // than quietly start comparing something new.
      assert.deepEqual(echoedPaths, [], `${fixture}: the vendor now echoes ${supplied.join(', ')}, so this row's claim is stale`);
      assert.equal(compared, (alsoCompare ?? []).length, `${fixture}: the paths this row claims did not all reach the comparison`);
    }
    assert.deepEqual(differences, [], `${fixture}: the proxy answers ${supplied.join(', ')} differently`);
  });
}

// A declaration nothing exercises is a claim nobody checks — and "exercised"
// has to mean a capture THIS GATE REPLAYS, not a capture that happens to sit in
// the store. A review deleted the row that replays the Chat logprobs capture and
// the declaration stayed certified: the check read the directory, and the
// directory still held the file nobody was reading.
test('every declaration is exercised by a capture this gate replays', () => {
  for (const { fixture, supplied } of CAPTURES) {
    // A row that claims no option compares nothing and passes. It cannot stand
    // in for a declaration either.
    assert.ok(supplied.length > 0, `${fixture} names no supplied option, so it claims nothing`);
  }

  const replayed = new Map();
  for (const { fixture, surface } of CAPTURES) {
    const paths = new Set(keyPaths(JSON.parse(load(fixture).body)).values());
    for (const path of paths) replayed.set(`${surface} ${path}`, true);
  }

  const unexercised = [];
  for (const surface of new Set(CAPTURES.map((row) => row.surface))) {
    for (const path of absentPathsFor(surface)) {
      if (!replayed.has(`${surface} ${path}`)) unexercised.push(`${surface} ${path}`);
    }
    for (const { path } of valueDivergencesFor(surface)) {
      if (!replayed.has(`${surface} ${path}`)) unexercised.push(`${surface} ${path}`);
    }
  }
  assert.deepEqual(unexercised, [], 'declared divergences no capture in this gate replays: nothing checks these');

  // Carrying the path is not the same as showing the difference. A value
  // divergence claims the two sides answer a field differently, and the only
  // proof of that is a row where they did — matched on the whole tuple, so a
  // second declaration on the same path cannot ride the first one's evidence.
  const exhibited = new Set(CAPTURES.flatMap((row) => [...readEcho(row).exhibited]));
  const unexhibited = [...new Set(CAPTURES.map((row) => row.surface))]
    .flatMap((surface) => valueDivergencesFor(surface).map((entry) => tupleKey(surface, entry)))
    .filter((key) => !exhibited.has(key));
  assert.deepEqual(unexhibited, [], 'declared value divergences that no capture actually exhibits');
});

// No promoted capture goes unread. The store is the repository's evidence, and
// a fixture nothing replays is a file that can drift, be tampered with, or
// quietly justify a declaration on its own.
test('every capture in the store is replayed by a gate', () => {
  const stored = readdirSync(join(specDir, 'captures'))
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length));
  // Against the shared registry, so the captures this gate does not replay are
  // covered by the gates that do rather than by a second list written here.
  // The streamed captures used to be carved out of this check; they are not,
  // and the carve-out is what let the registry lose the stream gate unnoticed.
  const unread = stored.filter((name) => !REPLAYED_FIXTURES.has(name));
  assert.deepEqual(unread, [], 'promoted captures that no gate replays');
});
