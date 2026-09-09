// What does a minimal request come back as — the fields a client never asked
// for, filled in by the surface it asked?
//
// `conformance-stream-terminator.test` closed the capture loop on how a stream
// ENDS. This closes it on the body of a turn nobody configured, which is the
// facet the matrix names as its reason for existing ("생략 시 기본값") and the
// one an ordinary SDK client meets on its very first call.
//
// The two sides are not symmetric, on purpose:
//
//   the vendor is FROZEN — a promoted capture, request bytes and response bytes
//     with their digests, because the vendor is not ours to re-run per test and
//     the bytes are the authority for what it answered.
//   the proxy is LIVE — the real server, started here, answering the capture's
//     own request bytes. A frozen proxy fixture would only ever detect fixture
//     drift; computing this side fresh means a proxy regression fails HERE, on
//     the next run, rather than at the next promotion.
//
// Shape and value are judged separately, and the split is load-bearing. An
// earlier hand-run of this comparison excluded `usage` from the value check as
// "per-call" and thereby also stopped comparing its KEYS — which is exactly
// where the real gap was (`cache_write_tokens`, absent on both OpenAI surfaces,
// §5.5.9's open row). So: every path is compared as shape, and only leaf VALUES
// under genuinely per-call roots are skipped.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { startLocalApiProxy } from '../dist/proxy/http-server.js';
import { verifyCaptureStore } from '../scripts/lib/capture-provenance.mjs';
import { PER_CALL, absentPathsFor, declarablePath, expectedAbsentPaths, keyPaths, leafValues, rootOf } from '../scripts/lib/response-comparison.mjs';

const specDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'spec');

function load(name) {
  return JSON.parse(readFileSync(join(specDir, 'captures', `${name}.json`), 'utf8'));
}

// The two denominators, pinned rather than bounded. `echoedDefaults` counts the
// leaf values the vendor CHOSE for a field the request never mentioned;
// `suppliedEchoes` counts the ones it echoed back from the request. They are
// counted apart because the probe has to supply an output cap to bound its
// cost, and counting that cap among the defaults is how the gate came to claim
// a property it never exercised. A pinned count fails when it silently drops by
// one, which a `>= 1` would not.
const SURFACES = [
  {
    surface: '/v1/responses',
    fixture: 'direct-responses-minimal',
    requestKeys: ['model', 'input', 'max_output_tokens'],
    echoedDefaults: 34,
    // `model` and `max_output_tokens` — the two the request named.
    suppliedEchoes: 2,
  },
  {
    surface: '/v1/chat/completions',
    fixture: 'direct-chat-minimal',
    requestKeys: ['model', 'messages', 'max_completion_tokens'],
    echoedDefaults: 5,
    // `model` only: Chat does not echo its cap or its messages as configuration.
    suppliedEchoes: 1,
  },
];

// The list above is the gate's whole reach, and it is a mutable array in the
// file it gates: duplicating one entry over the other leaves six green tests
// and silently drops a surface. Pinned here so that edit fails.
test('the gate covers the surfaces it claims to, once each', () => {
  assert.deepEqual(
    SURFACES.map((entry) => entry.surface).sort(),
    ['/v1/chat/completions', '/v1/responses'],
  );
  assert.equal(new Set(SURFACES.map((entry) => entry.fixture)).size, SURFACES.length);
});

let started;
const bodies = new Map();

before(async () => {
  started = await startLocalApiProxy({
    host: '127.0.0.1',
    port: 0,
    requestTimeoutMs: 10_000,
    backend: {
      name: 'fake-backend',
      model: 'fake-local-model',
      async generate(request) {
        return {
          id: 'local_test',
          model: request.model,
          text: 'OK',
          toolCalls: [],
          usage: {
            inputTokens: 7,
            outputTokens: 1,
            totalTokens: 8,
            cachedInputTokens: 0,
            reasoningOutputTokens: 0,
            source: 'provider',
          },
          latencyMs: 1,
        };
      },
      async close() {},
    },
  });

  // The capture's own request bytes, forwarded verbatim. Re-typing them here
  // would ask a different question than the one the vendor answered — and the
  // body is not "every optional field omitted" either: it supplies the output
  // cap to bound what the probe costs, which is why the check below counts
  // supplied echoes apart from defaults.
  for (const { surface, fixture } of SURFACES) {
    const capture = load(fixture);
    const res = await fetch(`${started.url}${surface}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: capture.request,
    });
    bodies.set(surface, { status: res.status, body: await res.json() });
  }
});

after(async () => {
  await started?.close();
});

test('the captures this check reads are present and intact', () => {
  // Evidence that is missing has not passed, it has not run.

  // A fixture whose stamp names a revision that could not have produced it is
  // worse than one with no stamp, because a reader treats the stamp as
  // evidence. Checking the stamp's SHAPE is not that check: a hand-written
  // revision of forty zeroes satisfied a hex match. So git re-derives the
  // claim — revision, path, and the promoter blob committed there — over the
  // whole capture store, because a gate that verifies only the fixtures it
  // itself loads leaves every other consumed capture exempt.
  const { checked, unbound } = verifyCaptureStore();
  assert.deepEqual(unbound, [], 'promoted captures whose provenance git cannot confirm');
  for (const { fixture } of SURFACES) {
    assert.ok(checked.includes(fixture), `${fixture} is not among the ${checked.length} verified captures`);
  }

  for (const { fixture, requestKeys } of SURFACES) {
    const capture = load(fixture);
    assert.equal(capture.kind, 'json', `${fixture} is not a buffered capture`);
    assert.equal(capture.status, 200, `${fixture} did not record a 200`);
    for (const [field, digest] of [['body', 'bodySha256'], ['request', 'requestSha256']]) {
      assert.equal(typeof capture[field], 'string', `${fixture} carries no ${field}`);
      assert.ok(capture[field].length > 0, `${fixture} ${field} is empty`);
      assert.equal(
        createHash('sha256').update(capture[field]).digest('hex'),
        capture[digest],
        `${fixture} ${field} no longer matches the capture it was promoted from`,
      );
    }
    // The claim is "every optional field omitted EXCEPT the output cap", which
    // the probe sets to bound what the measurement costs. That cap is not a
    // default — it is an echo of a value the request supplied, and it is
    // compared as one.
    //
    // KNOWN LIMIT, stated here because a reader would otherwise assume
    // otherwise: because the request supplies the cap, this gate never enters
    // the branch that fills `max_output_tokens` when it is ABSENT, and a wrong
    // default there stays green. Closing that needs a capture whose request
    // omits the cap; no capture in the store has one (every 200 in
    // `artifacts/direct-api-captures` carries it), so it is a probe to run,
    // not something this fixture can settle. Pinning the exact key set here keeps a capture that
    // grew a second option from being read as evidence for the claim it is
    // not: `temperature` appearing in this request would make every echoed
    // sampling value a response to input rather than a default.
    const request = JSON.parse(capture.request);
    assert.deepEqual(
      Object.keys(request).sort(),
      requestKeys.slice().sort(),
      `${fixture} request is not the minimal-plus-cap body this claim is about`,
    );
  }
});

test('the readers distinguish a shape and a value that differ', () => {
  // Proven against known-opposite inputs before they are used on real bytes.
  const paths = (value) => [...keyPaths(value, '', new Set())].sort();
  assert.deepEqual(paths({ a: { b: 1 } }), ['.a.b:number', '.a:object']);
  assert.deepEqual(paths({ a: [{ b: 1 }] }), ['.a:array', '.a[].b:number', '.a[]:object']);
  // An array's LENGTH is not shape, but a member only one item carries is.
  assert.deepEqual(paths({ a: [{ b: 1 }, { c: 2 }] }), ['.a:array', '.a[].b:number', '.a[].c:number', '.a[]:object']);
  // …and so is the TYPE a member takes. A second choice answered as `null`
  // contributes no paths of its own, so the union of the others hid it until
  // the member type became a path — a review planted exactly that.
  assert.notDeepEqual(paths({ a: [{ b: 1 }] }), paths({ a: [{ b: 1 }, null] }));
  assert.notDeepEqual(paths({ a: ['x'] }), paths({ a: [1] }));
  assert.notDeepEqual(paths({ a: 1 }), paths({ b: 1 }));
  // The type tag: an empty container and a null share a path and have no
  // children, and telling them apart is the whole reason the tag is there.
  assert.notDeepEqual(paths({ a: {} }), paths({ a: null }));
  assert.notDeepEqual(paths({ a: [] }), paths({ a: {} }));
  assert.notDeepEqual(paths({ a: 1 }), paths({ a: '1' }));

  const leaves = (value) => [...leafValues(value, '', new Map())];
  assert.deepEqual(leaves({ a: 1, b: null }), [['.a', '1'], ['.b', 'null']]);
  // 0 and false and null are values, not absences — the reading that matters
  // for a defaults check, where an absent field and a zero mean different things.
  assert.deepEqual(leaves({ a: 0 }), [['.a', '0']]);
  assert.notDeepEqual(leaves({ a: 0 }), leaves({ a: false }));
  // Array length is a value, so an empty vendor array that we filled with
  // scalars — which adds no key path at all — still differs here.
  assert.deepEqual(leaves({ a: [] }), [['.a[]#', '0']]);
  assert.notDeepEqual(leaves({ a: [] }), leaves({ a: ['leaked'] }));
  assert.notDeepEqual(leaves({ a: [] }), leaves({ a: [null] }));

  assert.equal(rootOf('.usage.input_tokens_details.cached_tokens'), 'usage');
  assert.equal(rootOf('.output[0].content[0].text'), 'output');
});

for (const { surface, fixture, echoedDefaults, suppliedEchoes } of SURFACES) {
  test(`${surface}: the proxy answers a minimal request in the vendor's shape`, () => {
    const direct = JSON.parse(load(fixture).body);
    const answered = bodies.get(surface);
    assert.equal(answered.status, 200, `the proxy did not answer 200: ${JSON.stringify(answered.body).slice(0, 300)}`);

    const vendorPaths = keyPaths(direct, '', new Set());
    const ourPaths = keyPaths(answered.body, '', new Set());
    const onlyVendor = [...vendorPaths].filter((path) => !ourPaths.has(path)).sort();
    const onlyOurs = [...ourPaths].filter((path) => !vendorPaths.has(path)).sort();
    // Declarations name paths, not types: a path we do not report at all has no
    // type to declare. The tag stays in the messages, where it is what tells a
    // reader whether a difference is a missing field or a changed type.
    // The proxy has never invented a field the vendor does not send (§5.5.9),
    // and a client that meets one cannot tell it from the real surface.
    assert.deepEqual(onlyOurs, [], `${surface} reports fields the vendor does not: ${onlyOurs.join(', ')}`);

    // What we do NOT report has to be declared, and the declaration has to
    // still be true. A field we quietly started reporting makes its
    // declaration stale, and a stale exemption hides the fix and waves the
    // next regression through — so both directions fail here.
    assert.deepEqual(
      [...new Set(onlyVendor.map(declarablePath))].sort(),
      [...new Set(expectedAbsentPaths(surface, vendorPaths))].sort(),
      `${surface}: the fields missing from the proxy's answer are not the declared ones`,
    );
  });

  test(`${surface}: the proxy fills omitted fields with the vendor's defaults`, () => {
    const capture = load(fixture);
    const direct = JSON.parse(capture.body);
    const ours = bodies.get(surface).body;
    const absent = new Set(absentPathsFor(surface));
    // A response field whose name the REQUEST also carries is an echo of what
    // was supplied, not a default the vendor chose. Counting the probe's own
    // `max_output_tokens: 16` among the defaults was how "every optional field
    // omitted" stayed true-sounding while the branch that fills that field when
    // it is ABSENT went unexercised. The two are separated and counted apart,
    // so neither can stand in for the other.
    const supplied = new Set(Object.keys(JSON.parse(capture.request)));

    const vendorLeaves = leafValues(direct, '', new Map());
    const ourLeaves = leafValues(ours, '', new Map());
    const differences = [];
    const counts = { defaults: 0, echoes: 0 };
    for (const [path, value] of vendorLeaves) {
      // A per-call root's CONTENT varies by construction; its cardinality does
      // not. A duplicated `output` item is a message the client receives twice,
      // and skipping the whole subtree hid it — so array counts survive the
      // skip even where the values below them do not.
      if (PER_CALL.has(rootOf(path)) && !path.endsWith('[]#')) continue;
      // `[]` in a declaration stands for any index; leaves carry real ones.
      if (absent.has(path) || absent.has(path.replace(/\[\d+\]/g, '[]'))) continue;
      counts[supplied.has(rootOf(path)) ? 'echoes' : 'defaults'] += 1;
      const ourValue = ourLeaves.get(path);
      if (ourValue !== value) differences.push(`${path}: vendor ${value}, proxy ${ourValue ?? '(absent)'}`);
    }

    // Both denominators, asserted rather than printed: with every field skipped
    // this check passes while comparing nothing, and a defaults check that
    // compares nothing is the exact failure this suite keeps finding. Splitting
    // them means a shrinking default count cannot be masked by an echo.
    assert.deepEqual(
      counts,
      { defaults: echoedDefaults, echoes: suppliedEchoes },
      `${surface} compared ${counts.defaults} defaults and ${counts.echoes} supplied echoes, not ${echoedDefaults} and ${suppliedEchoes}`,
    );
    assert.deepEqual(differences, [], `${surface} echoes different defaults than the vendor:\n  ${differences.join('\n  ')}`);
  });
}
