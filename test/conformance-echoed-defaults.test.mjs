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

const specDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'spec');

function load(name) {
  return JSON.parse(readFileSync(join(specDir, 'captures', `${name}.json`), 'utf8'));
}

const declaredDivergences = JSON.parse(
  readFileSync(join(specDir, 'declared-divergences.json'), 'utf8'),
).divergences;

// `echoedLeaves` is the denominator, pinned rather than bounded: it is how many
// leaf values the vendor's minimal answer carries that are configuration rather
// than per-call output. Chat's three (`object`, `service_tier`,
// `system_fingerprint`) look thin because that surface's minimal body really is
// almost all per-call — and a pinned 3 fails if it silently becomes 2, which a
// `>= 1` would not.
const SURFACES = [
  { surface: '/v1/responses', fixture: 'direct-responses-minimal', echoedLeaves: 30 },
  { surface: '/v1/chat/completions', fixture: 'direct-chat-minimal', echoedLeaves: 3 },
];

// Values that differ on every call by construction — identifiers, clocks, the
// answer itself, and the token counts of two different models. Their SHAPE is
// still compared; only the leaf values below them are not.
const PER_CALL = new Set([
  'id', 'created', 'created_at', 'completed_at', 'model', 'output', 'usage', 'choices',
]);

/** Every key path in a value, arrays collapsed to `[]` so item count is not shape. */
function keyPaths(value, prefix, out) {
  if (Array.isArray(value)) {
    for (const item of value) keyPaths(item, `${prefix}[]`, out);
    return out;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, member] of Object.entries(value)) {
      out.add(`${prefix}.${key}`);
      keyPaths(member, `${prefix}.${key}`, out);
    }
    return out;
  }
  return out;
}

/** Leaf values by path, for the fields a client would read as configuration. */
function leafValues(value, prefix, out) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => leafValues(item, `${prefix}[${index}]`, out));
    return out;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, member] of Object.entries(value)) leafValues(member, `${prefix}.${key}`, out);
    return out;
  }
  out.set(prefix, JSON.stringify(value));
  return out;
}

const rootOf = (path) => path.replace(/^\./, '').split(/[.[]/, 1)[0];

/** The paths a surface is declared NOT to report, from the divergence data. */
function declaredAbsentPaths(surface) {
  return declaredDivergences
    .filter((entry) => entry.surface === surface && entry.claim === 'echoed-defaults')
    .flatMap((entry) => entry.absentPaths ?? []);
}

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

  // The capture's own request bytes, forwarded verbatim: the claim is about a
  // body that omits every optional field, so re-typing it here would be a
  // different request than the one the vendor answered.
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
  for (const { fixture } of SURFACES) {
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
    // The claim is "every optional field omitted". A capture whose request grew
    // an option is evidence for a different claim.
    const request = JSON.parse(capture.request);
    const optional = Object.keys(request).filter(
      (key) => !['model', 'input', 'messages', 'max_output_tokens', 'max_completion_tokens'].includes(key),
    );
    assert.deepEqual(optional, [], `${fixture} request carries optional fields: ${optional.join(', ')}`);
  }
});

test('the readers distinguish a shape and a value that differ', () => {
  // Proven against known-opposite inputs before they are used on real bytes.
  const paths = (value) => [...keyPaths(value, '', new Set())].sort();
  assert.deepEqual(paths({ a: { b: 1 } }), ['.a', '.a.b']);
  assert.deepEqual(paths({ a: [{ b: 1 }] }), ['.a', '.a[].b']);
  // An array's LENGTH is not shape, but a member only one item carries is.
  assert.deepEqual(paths({ a: [{ b: 1 }, { c: 2 }] }), ['.a', '.a[].b', '.a[].c']);
  assert.notDeepEqual(paths({ a: 1 }), paths({ b: 1 }));

  const leaves = (value) => [...leafValues(value, '', new Map())];
  assert.deepEqual(leaves({ a: 1, b: null }), [['.a', '1'], ['.b', 'null']]);
  // 0 and false and null are values, not absences — the reading that matters
  // for a defaults check, where an absent field and a zero mean different things.
  assert.deepEqual(leaves({ a: 0 }), [['.a', '0']]);
  assert.notDeepEqual(leaves({ a: 0 }), leaves({ a: false }));

  assert.equal(rootOf('.usage.input_tokens_details.cached_tokens'), 'usage');
  assert.equal(rootOf('.output[0].content[0].text'), 'output');
});

for (const { surface, fixture, echoedLeaves } of SURFACES) {
  test(`${surface}: the proxy answers a minimal request in the vendor's shape`, () => {
    const direct = JSON.parse(load(fixture).body);
    const answered = bodies.get(surface);
    assert.equal(answered.status, 200, `the proxy did not answer 200: ${JSON.stringify(answered.body).slice(0, 300)}`);

    const vendorPaths = keyPaths(direct, '', new Set());
    const ourPaths = keyPaths(answered.body, '', new Set());
    const onlyVendor = [...vendorPaths].filter((path) => !ourPaths.has(path)).sort();
    const onlyOurs = [...ourPaths].filter((path) => !vendorPaths.has(path)).sort();

    // The proxy has never invented a field the vendor does not send (§5.5.9),
    // and a client that meets one cannot tell it from the real surface.
    assert.deepEqual(onlyOurs, [], `${surface} reports fields the vendor does not: ${onlyOurs.join(', ')}`);

    // What we do NOT report has to be declared, and the declaration has to
    // still be true. A field we quietly started reporting makes its
    // declaration stale, and a stale exemption hides the fix and waves the
    // next regression through — so both directions fail here.
    assert.deepEqual(
      onlyVendor,
      declaredAbsentPaths(surface).slice().sort(),
      `${surface}: the fields missing from the proxy's answer are not the declared ones`,
    );
  });

  test(`${surface}: the proxy fills omitted fields with the vendor's defaults`, () => {
    const direct = JSON.parse(load(fixture).body);
    const ours = bodies.get(surface).body;
    const absent = new Set(declaredAbsentPaths(surface));

    const vendorLeaves = leafValues(direct, '', new Map());
    const ourLeaves = leafValues(ours, '', new Map());
    const differences = [];
    let compared = 0;
    for (const [path, value] of vendorLeaves) {
      if (PER_CALL.has(rootOf(path))) continue;
      // `[]` in a declaration stands for any index; leaves carry real ones.
      if (absent.has(path) || absent.has(path.replace(/\[\d+\]/g, '[]'))) continue;
      compared += 1;
      const ourValue = ourLeaves.get(path);
      if (ourValue !== value) differences.push(`${path}: vendor ${value}, proxy ${ourValue ?? '(absent)'}`);
    }

    // The denominator, asserted rather than printed: with every echoed field
    // excluded this check passes while comparing nothing.
    // The denominator, asserted rather than printed: with every echoed field
    // skipped this check passes while comparing nothing, and a defaults check
    // that compares nothing is the exact failure this suite keeps finding.
    assert.equal(
      compared,
      echoedLeaves,
      `${surface} compared ${compared} echoed values, not the ${echoedLeaves} this fixture carries`,
    );
    assert.deepEqual(differences, [], `${surface} echoes different defaults than the vendor:\n  ${differences.join('\n  ')}`);
  });
}
