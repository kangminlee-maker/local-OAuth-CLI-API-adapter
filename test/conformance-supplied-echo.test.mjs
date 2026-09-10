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
  answerPremiseFailures,
  MINIMAL_SURFACES,
  bindingsReached,
  echoFailures,
  freeFieldsReached,
  harnessGapsFrom,
  missingRequiredEffects,
  unclaimedRequestOptions,
} from './replayed-captures.mjs';

const specDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'spec');
// A capture this gate's roster does not name cannot be read here. A review
// repointed a gate's own driver at a different fixture while leaving the roster
// and the manifest alone: every check still certified the capture the roster
// advertised, and nothing replayed it. Advertising and reading are the same act
// now.
const ROSTER = new Set(CAPTURES.map((row) => row.fixture));
/** The keys a capture's own request carries, which is what the rules ask about. */
const requestKeysOf = (fixture) => Object.keys(JSON.parse(load(fixture).request));
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
  // What WE report, by field. A declared ancestor stops answering for its
  // descendants the moment our own answer carries it.
  const ourFields = new Set(keyPaths(ours.body).values());

  const differences = [];
  const exhibited = new Set();
  // Per ROOT, not one total. `compared > 0` summed every claimed root together,
  // so a row supplying four options passed on the strength of whichever one
  // echoed — `model`, in every row that had this shape. Two independent reviews
  // built that case from different directions on the same day.
  const comparedByRoot = new Map();
  let compared = 0;
  for (const [path, value] of vendorLeaves) {
    // Only what this row claims. The rest of the body is the sibling gate's
    // claim, and reading it here would make every fixture a second copy of
    // that comparison.
    const claimed = supplied.includes(rootOf(path)) || (alsoCompare ?? []).includes(path);
    if (!claimed) continue;
    if (PER_CALL.has(rootOf(path)) && !path.endsWith('[]#')) continue;
    if (isDeclaredAbsent(absent, path, ourFields)) continue;
    compared += 1;
    const claimedBy = supplied.includes(rootOf(path)) ? rootOf(path) : path;
    comparedByRoot.set(claimedBy, (comparedByRoot.get(claimedBy) ?? 0) + 1);
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
  return { compared, comparedByRoot, differences, exhibited, echoedPaths };
}

for (const { fixture, surface, supplied, echoed, alsoCompare, declaredAbsent, harnessGaps, harnessPremise, vendorPaths } of CAPTURES) {
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
      // ...and the list itself follows from that missing item. A true premise
      // used to license any path listed beside it.
      assert.deepEqual([...gaps].sort(), harnessGapsFrom(vendor, harnessPremise),
        `${fixture}: a declared harness gap does not follow from the item our turn lacks`);
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

    const { compared, comparedByRoot, differences, echoedPaths } = readEcho({ fixture, surface, supplied, alsoCompare });

    const vendorRoots = new Set([...keyPaths(JSON.parse(capture.body)).values()].map(rootOf));
    const ourRoots = new Set([...keyPaths(ours.body).values()].map(rootOf));
    assert.deepEqual(
      echoFailures({
        supplied, echoed, alsoCompare, declaredAbsent, comparedByRoot, echoedPaths,
        vendorRoots, ourRoots, rootOf,
      }),
      [],
      `${fixture}: this row's echo claim does not hold`,
    );
    // A row that claims no echoed option still has to have compared exactly the
    // paths it named, and nothing else.
    const speaksForNothing = supplied.every((root) => (typeof echoed === 'object' && echoed !== null ? echoed[root] !== true : echoed !== true));
    if (speaksForNothing) {
      assert.equal(compared, (alsoCompare ?? []).length, `${fixture}: the paths this row claims did not all reach the comparison`);
    }
    assert.deepEqual(differences, [], `${fixture}: the proxy answers ${supplied.join(', ')} differently`);
  });
}

test('every row answer describes the turn its own capture recorded', () => {
  const { failures, checked } = answerPremiseFailures(CAPTURES, (fixture) => {
    const capture = load(fixture);
    return { body: JSON.parse(capture.body), request: JSON.parse(capture.request) };
  });
  assert.deepEqual(failures, [], 'a fixture that contradicts its own capture can hide a defect');
  assert.ok(checked > 0, 'no answer field was bound to its capture, so this check compared nothing');
});

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

// The premise check's own controls, on a synthetic roster. The case above runs
// it over the real one, where every surface happens to be bound and every answer
// happens to agree — so nothing there can show what it does when they do not.
// A free field's REASON is prose, and prose rots. A round found two of these
// reasons already false: one said `stopReason` is "not passed through on this
// surface" when all three surfaces pass it through, and one named `harnessGaps`
// as the mechanism keeping `usage.reasoningOutputTokens` free when every path in
// that list is under `.output[]` and none is a usage path. The first was not
// merely mis-worded — two independent reviews walked through it — and is now a
// binding rather than a reason. What is left free rests on checkable facts, and
// these are those facts, so the next reason to go false says so.

test('a gap that does not follow from the missing item is not derivable', () => {
  // The construction: a real premise (`reasoning` gone from our turn) plus an
  // unrelated top-level field the proxy stopped reporting.
  const vendor = {
    billing: { payer: 'developer' },
    output: [{ type: 'reasoning', summary: [] }, { type: 'message', content: [] }],
  };
  const derived = harnessGapsFrom(vendor, { vendor: ['reasoning', 'message'], ours: ['message'] });
  assert.ok(!derived.includes('.billing:object'), 'the derivation credits a path the missing item cannot explain');
  assert.ok(derived.includes('.output[].summary:array'), 'the derivation lost the paths the missing item does explain');
});

test('an option whose only effect is a path is compared by every row whose request carries it', () => {
  // Of the REQUEST. Asked of `supplied`, the rule stood one door up from where it
  // was aimed: a row that stopped claiming `n` also stopped owing `.choices[]#`.
  // This gate's roster only: `load` refuses a fixture the roster does not name,
  // which is what keeps a gate from reading off somebody else's list. The
  // sibling gate asserts the same rule over its own rows.
  assert.deepEqual(missingRequiredEffects(CAPTURES, undefined, requestKeysOf), []);
});

test('a row that stops claiming the option still owes its effect', () => {
  // Both halves of the construction at once: `supplied` narrowed AND the effect
  // path deleted. The request still carries `n`, so the requirement still holds.
  assert.deepEqual(
    missingRequiredEffects([{ fixture: 'narrowed', surface: '/v1/chat/completions', supplied: [] }],
      undefined, () => ['model', 'messages', 'n']),
    ['narrowed n: nothing compares .choices[]#, which is the only way this option shows'],
  );
});

test('deleting the only effect path fails the row that supplies the option', () => {
  // The construction that broke the row-local version: `n: 2` answered as one
  // choice, the row still claiming `n`, and `alsoCompare` simply gone.
  assert.deepEqual(
    missingRequiredEffects([{ fixture: 'fanout', surface: '/v1/chat/completions', supplied: ['n'] }]),
    ['fanout n: nothing compares .choices[]#, which is the only way this option shows'],
  );
});

test('the free reasons no roster reaches are the ones held in reserve', () => {
  // A reason nothing reads has the authority of a checked one and none of the
  // checking — which is how "not passed through on this surface" survived three
  // rounds of review while being false on all three. Four of the five this
  // started with turned out to be reachable the moment the scan read what the
  // proxy is actually handed rather than what the roster wrote; their reasons
  // were rewritten as part of becoming live. `stopSequence` is what is left:
  // `servedResult` never returns it, so nothing has ever read this sentence.
  const { heldInReserve } = freeFieldsReached([CAPTURES, MINIMAL_SURFACES]);
  assert.deepEqual(heldInReserve, [
    '/v1/chat/completions stopSequence',
    '/v1/messages stopSequence',
    '/v1/responses stopSequence',
  ], 'the set of never-read reasons changed: read the ones that became live before counting them');
});

test('every binding is run by some row', () => {
  // The mirror of the reserve list, and the reason it is not optional: a binding
  // nothing runs certifies without being able to be wrong. Two of these had
  // never been read against anything — both were rewritten to return a string no
  // vendor sends and the suite stayed green — because only the six
  // `/v1/messages` rows wrote a cache-write number. `DEFAULT_ANSWER` serves one
  // now, so the two OpenAI surfaces read it too.
  const { neverRun, runs } = bindingsReached([CAPTURES, MINIMAL_SURFACES]);
  assert.deepEqual(neverRun, [],
    'a binding is in the table and absent from every run; serve the value or say why it is held');
  // ...and the count is per binding, not one number over all of them. The gate's
  // only coverage assertion used to be `checked > 0`, which nine bindings
  // satisfied on behalf of the two that never ran.
  assert.ok(Object.values(runs).every((count) => count > 0));
});

test('the usage counts are free only while nothing compares a usage path', () => {
  // Every usage count that is not bound BY NAME is free for one reason: the
  // value half skips the root, and no row reaches into it by hand.
  assert.ok(PER_CALL.has('usage'), '`usage` left PER_CALL: bind the counts or rewrite their reasons');
  // A member-signature path is not reaching in; PER_CALL never skipped those.
  const reaching = CAPTURES.filter(({ alsoCompare }) => (alsoCompare ?? [])
    .some((path) => rootOf(path) === 'usage' && !path.endsWith('[]#')));
  assert.deepEqual(reaching.map((row) => row.fixture), [],
    'a row compares a usage path, so the free reasons no longer describe what happens');
});

test('every /v1/messages capture that carries a stop sequence has a row comparing it', () => {
  // `stopSequence` is free on this surface for a different reason than on the
  // other two: it IS reported here, as `stop_sequence`, and the rows that depend
  // on it read it off the wire through `alsoCompare` rather than off the answer.
  const unwatched = [];
  for (const { fixture, surface, alsoCompare } of CAPTURES) {
    if (surface !== '/v1/messages') continue;
    const body = JSON.parse(load(fixture).body);
    if (body.stop_sequence === null || body.stop_sequence === undefined) continue;
    if (!(alsoCompare ?? []).includes('.stop_sequence')) unwatched.push(fixture);
  }
  assert.deepEqual(unwatched, [],
    'a capture reports a stop sequence and no row compares it, so a fixture could move it unseen');
});

test('the premise check refuses an answer on a surface it cannot check', () => {
  const { failures, checked } = answerPremiseFailures(
    [{ fixture: 'made-up', surface: '/v1/nowhere', answer: { stopReason: 'end_turn' } }],
    () => ({ body: {}, request: {} }),
  );
  assert.equal(checked, 0);
  assert.equal(failures.length, 1, 'an unbound surface was skipped instead of failing');
  assert.match(failures[0], /no binding table/);
});

test('the premise check catches an answer that contradicts its capture', () => {
  const rows = [{
    fixture: 'made-up',
    surface: '/v1/messages',
    answer: { stopReason: 'end_turn', usage: { cachedInputTokens: 1 } },
  }];
  // The merged answer is what reaches the proxy, so that is what is checked.
  const { failures } = answerPremiseFailures(rows, () => ({
    body: { stop_reason: 'max_tokens', usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
    request: {},
  }));
  const said = failures.join('\n');
  assert.match(said, /stopReason/);
  assert.match(said, /cachedInputTokens/);
  // And the DEFAULT half of the served answer is checked too — this row names no
  // text, so it is served `OK` while its capture produced nothing. A default
  // nobody checks is a default anybody can put a compensating value into, which
  // is how a real proxy defect survived 122 green tests.
  assert.match(said, /text/);
});

test('the premise check passes an answer that agrees with its capture', () => {
  const { failures, checked } = answerPremiseFailures(
    [{ fixture: 'made-up', surface: '/v1/messages', answer: { stopReason: 'max_tokens' } }],
    () => ({
      // Agreeing means agreeing with the MERGED answer, defaults included: this
      // row names no text, so `DEFAULT_ANSWER.text` is what the proxy is served.
      body: {
        stop_reason: 'max_tokens',
        content: [{ type: 'text', text: 'OK' }],
        usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      request: {},
    }),
  );
  assert.deepEqual(failures, []);
  assert.ok(checked >= 3, `only ${checked} field(s) were compared`);
});

test('an explicit undefined does not blank a bound field back to unchecked', () => {
  // `undefined` is a VALUE the fixture can write, not an absence. Read as
  // absence, it took a field out of the comparison entirely: this row's proxy
  // answers `end_turn` while the capture says `max_tokens`, and nothing said so.
  const { failures } = answerPremiseFailures(
    [{ fixture: 'blanked', surface: '/v1/messages', answer: { stopReason: undefined, text: '' } }],
    () => ({
      body: { stop_reason: 'max_tokens', content: [], usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
      request: {},
    }),
  );
  assert.match(failures.join('\n'), /blanked: the answer's stopReason yields "end_turn", the capture says "max_tokens"/);
});

test('a stop reason that contradicts its capture fails on every surface', () => {
  // One fixture field, three surfaces, and each one carries the contradiction to
  // a different place on the wire. Both round-4 seats built this construction on
  // the OpenAI pair, where the answer used to be free.
  const chat = answerPremiseFailures(
    [{ fixture: 'cut-off-chat', surface: '/v1/chat/completions', answer: { stopReason: 'max_tokens' } }],
    () => ({ body: { choices: [{ finish_reason: 'stop' }], usage: {} }, request: {} }),
  ).failures.join('\n');
  assert.match(chat, /stopReason yields \["length"\], the capture says \["stop"\]/);

  const responses = answerPremiseFailures(
    [{ fixture: 'cut-off-responses', surface: '/v1/responses', answer: { stopReason: 'max_tokens' } }],
    () => ({ body: { status: 'completed', incomplete_details: null, completed_at: 1, usage: {} }, request: {} }),
  ).failures.join('\n');
  assert.match(responses, /stopReason yields \{"status":"incomplete"/);

  const messages = answerPremiseFailures(
    [{ fixture: 'cut-off-messages', surface: '/v1/messages', answer: { stopReason: 'max_tokens', text: '' } }],
    () => ({ body: { stop_reason: 'end_turn', content: [], usage: {} }, request: {} }),
  ).failures.join('\n');
  assert.match(messages, /stopReason yields "max_tokens", the capture says "end_turn"/);
});

test('a fan-out answers every choice, not just the first', () => {
  // The chat binding is per choice because `n` is: a fixture that could move one
  // finish reason while the others stayed put would be the `n` hole again, one
  // field along.
  const { failures } = answerPremiseFailures(
    [{ fixture: 'fanout', surface: '/v1/chat/completions', answer: {} }],
    () => ({ body: { choices: [{ finish_reason: 'stop' }], usage: {} }, request: { n: 2 } }),
  );
  assert.match(failures.join('\n'), /yields \["stop","stop"\], the capture says \["stop"\]/);
});

// The echo rule's own controls, on synthetic readings. The rows above happen to
// agree under the per-root rule and an aggregate one, so nothing there can show
// the difference — and a rule no input distinguishes is an un-run input, not a
// guard that has been proved unnecessary.
test('an echoed option that compared nothing fails even when a sibling compared plenty', () => {
  const failures = echoFailures({
    supplied: ['store', 'include'],
    echoed: true,
    alsoCompare: [],
    comparedByRoot: new Map([['store', 9]]),
    echoedPaths: [],
    rootOf,
  });
  assert.equal(failures.length, 1, `expected include to fail, got ${JSON.stringify(failures)}`);
  assert.match(failures[0], /^include reached no comparison/);
});

test('an echo map must say what happens to every option the row supplies', () => {
  const failures = echoFailures({
    supplied: ['store', 'include'],
    echoed: { store: true },
    alsoCompare: [],
    comparedByRoot: new Map([['store', 1]]),
    echoedPaths: [],
    rootOf,
  });
  assert.match(failures.join('\n'), /does not say what happens to include/);
});

test('a root the row says is silent must stay silent', () => {
  const failures = echoFailures({
    supplied: ['n'],
    echoed: false,
    alsoCompare: [],
    comparedByRoot: new Map(),
    echoedPaths: ['.n'],
    rootOf,
  });
  assert.match(failures.join('\n'), /now echoes \.n/);
});

test('an alsoCompare path that reached nothing fails by name', () => {
  const failures = echoFailures({
    supplied: ['stop_sequences'],
    echoed: false,
    alsoCompare: ['.stop_reason', '.stop_sequence'],
    comparedByRoot: new Map([['.stop_reason', 1]]),
    echoedPaths: [],
    rootOf,
  });
  assert.deepEqual(failures, ['.stop_sequence did not reach the comparison']);
});

// The third row state's own controls. `declaredAbsent` says a whole root is
// answered for by a declaration, which `echoed: true` and `echoed: false` both
// get wrong: the vendor fills the root, we report none of it, so there is a
// compared count of zero AND a long list of echoed paths.
test('a declared-absent root that the vendor does not fill proves nothing', () => {
  const failures = echoFailures({
    supplied: ['reasoning_effort'],
    echoed: false,
    declaredAbsent: ['moderation'],
    comparedByRoot: new Map(),
    echoedPaths: [],
    vendorRoots: new Set(['id', 'choices']),
    ourRoots: new Set(['id', 'choices']),
    rootOf,
  });
  assert.match(failures.join('\n'), /carries nothing under it, so this row proves nothing/);
});

test('a declared-absent root this answer reports is a failure', () => {
  const failures = echoFailures({
    supplied: ['reasoning_effort'],
    echoed: false,
    declaredAbsent: ['moderation'],
    comparedByRoot: new Map(),
    echoedPaths: [],
    vendorRoots: new Set(['moderation']),
    ourRoots: new Set(['moderation']),
    rootOf,
  });
  assert.deepEqual(failures, ['moderation is declared absent and this answer reports it']);
});

test('a declared-absent root whose leaves got compared is a failure', () => {
  const failures = echoFailures({
    supplied: [],
    echoed: false,
    declaredAbsent: ['moderation'],
    comparedByRoot: new Map([['moderation', 3]]),
    echoedPaths: [],
    vendorRoots: new Set(['moderation']),
    ourRoots: new Set(),
    rootOf,
  });
  assert.match(failures.join('\n'), /3 of its leaves were compared/);
});

test('a root cannot be both supplied and declared absent', () => {
  const failures = echoFailures({
    supplied: ['moderation'],
    echoed: false,
    declaredAbsent: ['moderation'],
    comparedByRoot: new Map(),
    echoedPaths: [],
    vendorRoots: new Set(['moderation']),
    ourRoots: new Set(),
    rootOf,
  });
  assert.match(failures.join('\n'), /says one or the other about a root/);
});

// The `supplied` assertion used to run one way: a row could not claim an option
// its request lacks, and nothing said a row must claim the options its request
// HAS. Deleting one word from one row's `supplied` made a real echo defect —
// `top_logprobs: 1` answered as `0` — invisible to the entire suite, because
// that row was the defect's only witness.
//
// The first fix asked the question PER SURFACE, which is a different property:
// a key stays claimed by any row that names it, so the witness row could still
// stop claiming it. A second review used exactly that to make
// `reasoning.effort: "none"` answered as `"medium"` pass all 2283 tests. It is
// per row now, with the probe-shaping keys excused per row and by name.
test('every option the store sends is claimed by the row that replays it', () => {
  const { unclaimed, staleExceptions } = unclaimedRequestOptions(CAPTURES, requestKeysOf);
  assert.deepEqual(unclaimed, [], 'options the captures send that no row asserts anything about');
  assert.deepEqual(staleExceptions, [], 'exceptions that have outlived what they were for');
});

// The rules below are true of this roster, so nothing in it can tell a working
// rule from a broken one. Three mutants survived on exactly that: the roster is
// clean, so removing the rule changed nothing. A rule no input distinguishes is
// an un-run input, not a guard shown to be unnecessary.

test('a row with NO answer is still checked against its capture', () => {
  // The scope round 3 moved a compensating value into: rows that declare no
  // answer are served `DEFAULT_ANSWER`, and it was bound to no capture.
  const { failures } = answerPremiseFailures(
    [{ fixture: 'made-up', surface: '/v1/messages' }],
    () => ({
      body: { stop_reason: 'max_tokens', content: [], usage: { cache_creation_input_tokens: 4, cache_read_input_tokens: 0 } },
      request: {},
    }),
  );
  // `DEFAULT_ANSWER` says nothing was read from cache; this capture says 4 was.
  assert.match(failures.join('\n'), /cachedInputTokens yields 0, the capture says 4/,
    'a row with no answer of its own escaped the check entirely');
});

test('an answer field that is neither bound nor named free is reported', () => {
  const { failures } = answerPremiseFailures(
    [{ fixture: 'made-up', surface: '/v1/messages', answer: { somethingNew: 1 } }],
    () => ({ body: { stop_reason: 'max_tokens', content: [], usage: {} }, request: {} }),
  );
  assert.match(failures.join('\n'), /somethingNew, which no binding checks/);
});

test('a constant the backend invents, that no row wrote, is reported', () => {
  // The scan reads what the proxy is HANDED, not only what the roster wrote.
  // `id`, `toolCalls` and `latencyMs` are constants `servedResult()` invents and
  // every one of them is named free; the case that has to fail is the next
  // constant somebody adds to it.
  const { failures } = answerPremiseFailures(
    [{ fixture: 'made-up', surface: '/v1/messages', answer: {} }],
    () => ({ body: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'OK' }], usage: {} }, request: {} }),
    undefined,
    (answer) => ({ ...answer, refusalMode: 'invented-by-the-harness' }),
  );
  assert.match(failures.join('\n'), /refusalMode, which no binding checks/);
});

test('a NESTED answer field that no binding covers is reported', () => {
  // The shape that walked past a scan of top-level keys: `usage` is covered, so
  // anything under it rode along. This is where the next compensating fixture
  // would go, and a top-level case cannot tell a leaf scan from a shallow one.
  const { failures } = answerPremiseFailures(
    [{ fixture: 'made-up', surface: '/v1/messages', answer: { usage: { anythingAtAll: 1 } } }],
    () => ({ body: { stop_reason: 'max_tokens', content: [], usage: {} }, request: {} }),
  );
  assert.match(failures.join('\n'), /usage\.anythingAtAll, which no binding checks/);
});

test('a free field with no reason given is itself a failure', () => {
  const { failures } = answerPremiseFailures(
    [{ fixture: 'made-up', surface: '/v1/nowhere-free', answer: {} }],
    () => ({ body: {}, request: {} }),
    { '/v1/nowhere-free': [] },
  );
  // No binding table entry for this surface in FREE_ANSWER_FIELDS either, so
  // every leaf is reported rather than silently skipped.
  assert.ok(failures.length > 0, 'an entirely unbound surface reported nothing');
});

test('an option THIS row does not claim is named, even if a sibling claims it', () => {
  // Per ROW, not per surface. A key stays claimed on a surface by any row that
  // names it, so the row that is a defect's only WITNESS could stop claiming it
  // and the rule saw nothing: a review made `reasoning.effort: "none"` answered
  // as `"medium"` pass all 2283 tests by deleting one word from the row that
  // witnessed it, while another row on the same surface kept `reasoning` alive.
  const { unclaimed } = unclaimedRequestOptions(
    [
      { fixture: 'witness', surface: '/v1/responses', supplied: ['top_logprobs'] },
      { fixture: 'sibling', surface: '/v1/responses', supplied: ['reasoning'] },
    ],
    (fixture) => (fixture === 'witness'
      ? ['model', 'input', 'top_logprobs', 'reasoning']
      : ['model', 'input', 'reasoning']),
    { '/v1/responses': ['model', 'input'] },
    {},
  );
  assert.deepEqual(unclaimed, ['witness reasoning'],
    'a row stopped claiming an option its own request carries and nothing said so');
});

test('a row opts out only where the surface already says the probe shapes the key', () => {
  const rows = [
    { fixture: 'excused', surface: '/v1/responses', supplied: ['top_logprobs'], unclaimed: ['reasoning'] },
    { fixture: 'bare', surface: '/v1/responses', supplied: ['top_logprobs'] },
  ];
  const { unclaimed, staleExceptions } = unclaimedRequestOptions(
    rows,
    () => ['model', 'input', 'top_logprobs', 'reasoning'],
    { '/v1/responses': ['model', 'input'] },
    {},
    { '/v1/responses': { reasoning: 'the probe sets it' } },
  );
  assert.deepEqual(unclaimed, ['bare reasoning'], 'the opt-out excused a row that did not take it');
  assert.deepEqual(staleExceptions, []);
});

test('a row cannot mint its own excuse for the option it stopped claiming', () => {
  // The construction: narrow `supplied` by one word AND write a true sentence
  // about why this row need not claim it, in the same object. The rule asked the
  // question per row and read the answer off the same row. The reasons live
  // outside the rosters now, and a key that is not listed there cannot be opted
  // out of at all.
  const { unclaimed, staleExceptions } = unclaimedRequestOptions(
    [{ fixture: 'narrowed', surface: '/v1/responses', supplied: ['top_logprobs'], unclaimed: ['reasoning'] }],
    () => ['model', 'input', 'top_logprobs', 'reasoning'],
    { '/v1/responses': ['model', 'input'] },
    {},
    { '/v1/responses': {} },
  );
  assert.match(staleExceptions.join('\n'),
    /narrowed reasoning: opted out of a key this surface does not list as probe-shaped/);
  assert.deepEqual(unclaimed, [], 'the key was reported twice, once as unclaimed and once as a bad opt-out');
});

test('an opt-out for a key the row claims, or one its request lacks, is stale', () => {
  const { staleExceptions } = unclaimedRequestOptions(
    [
      { fixture: 'both-ways', surface: '/v1/responses', supplied: ['reasoning'], unclaimed: ['reasoning'] },
      { fixture: 'absent-key', surface: '/v1/responses', supplied: ['store'], unclaimed: ['nowhere'] },
    ],
    () => ['model', 'input', 'store', 'reasoning'],
    { '/v1/responses': ['model', 'input'] },
    {},
    { '/v1/responses': { reasoning: 'the probe sets it', nowhere: 'nothing sends it' } },
  );
  const said = staleExceptions.join('\n');
  assert.match(said, /both-ways reasoning: excused but this row claims it/);
  assert.match(said, /absent-key nowhere: excused but its request does not carry it/);
});

test('a probe-shaped key with no reason, or one nothing sends, is stale', () => {
  const { staleExceptions } = unclaimedRequestOptions(
    [{ fixture: 'made-up', surface: '/v1/responses', supplied: ['store'] }],
    () => ['model', 'input', 'store'],
    { '/v1/responses': ['model', 'input'] },
    {},
    { '/v1/responses': { store: '', gone: 'a reason for a key nothing sends' } },
  );
  const said = staleExceptions.join('\n');
  assert.match(said, /store: listed as probe-shaped with no reason/);
  assert.match(said, /gone: listed as probe-shaped but no capture's request carries it/);
});

test('a SURFACE exception no capture sends, or one a row claims, is stale', () => {
  const tables = [{ '/v1/responses': ['model', 'input'] }, { '/v1/responses': { cap: 'the probe caps the turn' } }];
  const { staleExceptions } = unclaimedRequestOptions(
    [{ fixture: 'made-up', surface: '/v1/responses', supplied: ['cap'] }],
    () => ['model', 'input', 'cap'],
    ...tables,
  );
  assert.match(staleExceptions.join('\n'), /cap: excused but a row claims it/);

  const { staleExceptions: gone } = unclaimedRequestOptions(
    [{ fixture: 'made-up', surface: '/v1/responses', supplied: ['store'] }],
    () => ['model', 'input', 'store'],
    ...tables,
  );
  assert.match(gone.join('\n'), /cap: excused but no capture's request carries it/);
});

test('parking a claim on a mandatory key does not save the row', () => {
  // `supplied: ['model']` satisfies `option in request`, `supplied.length > 0`
  // and even `echoed: true` — `.model` really is echoed and really does match —
  // so a row could park its claim there instead of dropping it and go on
  // certifying while asserting nothing. Per row, the option it stopped claiming
  // is the one that fails.
  const { unclaimed } = unclaimedRequestOptions(
    [{ fixture: 'parked', surface: '/v1/responses', supplied: ['model'] }],
    () => ['model', 'input', 'service_tier'],
    { '/v1/responses': ['model', 'input'] },
    {},
  );
  assert.deepEqual(unclaimed, ['parked service_tier']);
});
