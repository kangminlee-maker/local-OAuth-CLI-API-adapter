// The first check that reads a capture.
//
// Until now the recorder and the vendor probes produced evidence that nothing
// consumed, which makes them inert: a stored byte that no assertion reads
// changes no outcome. This closes that loop on one claim — how each streaming
// surface ends — and it is deliberately the claim where a divergence is already
// known, so the check has something to say on its first run.
//
// It costs no vendor call. Both sides are bytes recorded earlier and promoted
// into `spec/captures/`, each carrying the run it came from and the sha256 of
// the wire text, so a fixture that drifts from its origin is detectable.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { verifyCaptureStore } from '../scripts/lib/capture-provenance.mjs';

const specDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'spec');
const captureDir = join(specDir, 'captures');

function loadCapture(name) {
  return JSON.parse(readFileSync(join(captureDir, `${name}.json`), 'utf8'));
}

function hasDoneTerminator(wire) {
  return /^data:\s*\[DONE\]\s*$/m.test(wire);
}

// Surfaces to compare, and which capture is which side.
// `surface` is the vocabulary `spec/declared-divergences.json` uses, so the
// lookup below can actually find one. It used to read `openai.responses.stream`,
// a spelling no declaration has ever carried, which left the stale-declaration
// branch unreachable — the check could only ever take the equality path.
const SURFACES = [
  { surface: '/v1/responses', vendor: 'direct-responses-stream', proxy: 'proxy-responses-stream' },
  { surface: '/v1/chat/completions', vendor: 'direct-chat-stream', proxy: 'proxy-chat-stream' },
];

test('the capture set this check reads is present and intact', () => {
  // A check whose evidence is missing has not passed, it has not run. Saying so
  // loudly is the whole difference between the two, and an empty directory
  // reading as green is the failure this suite keeps finding elsewhere.
  const files = readdirSync(captureDir).filter((name) => name.endsWith('.json'));
  assert.ok(files.length > 0, 'spec/captures is empty: no stream evidence to check');

  // The digest below ties a fixture to the bytes it was promoted with; it says
  // nothing about what promoted it. These four carried no such claim at all,
  // and the gate that introduced one checked only the two captures it loaded
  // itself — so a planted "the promoter was uncommitted" stamp passed here 4/4.
  // git re-derives the binding for every capture in the store instead.
  const { checked, unbound } = verifyCaptureStore();
  assert.deepEqual(unbound, [], 'promoted captures whose provenance git cannot confirm');
  for (const { vendor, proxy } of SURFACES) {
    for (const name of [vendor, proxy]) {
      assert.ok(checked.includes(name), `${name} is not among the ${checked.length} verified captures`);
    }
  }

  for (const { vendor, proxy } of SURFACES) {
    for (const name of [vendor, proxy]) {
      const capture = loadCapture(name);
      assert.equal(typeof capture.stream, 'string', `${name} carries no wire text`);
      assert.ok(capture.stream.length > 0, `${name} wire text is empty`);
      // The fixture is a promotion of a real capture; the digests tie it back.
      // Both halves, because a stream is evidence only for the request that
      // produced it: these four carried no request at all until they were
      // re-promoted, and a field nothing checks is a field nothing defends.
      for (const [field, digest] of [['stream', 'streamSha256'], ['request', 'requestSha256']]) {
        assert.equal(typeof capture[field], 'string', `${name} carries no ${field}`);
        assert.equal(
          createHash('sha256').update(capture[field]).digest('hex'),
          capture[digest],
          `${name} ${field} no longer matches the capture it was promoted from`,
        );
      }
    }
  }
});

test('the terminator detector distinguishes a stream that has none', () => {
  // Proven against a known-opposite input before it is used on real bytes,
  // because every assertion below has its expected answer written down already.
  assert.equal(hasDoneTerminator('data: {"a":1}\n\ndata: [DONE]\n\n'), true);
  assert.equal(hasDoneTerminator('event: message_stop\ndata: {"type":"message_stop"}\n\n'), false);
});

for (const { surface, vendor, proxy } of SURFACES) {
  test(`${surface}: the proxy ends its stream the way the vendor does`, () => {
    const vendorWire = loadCapture(vendor).stream;
    const proxyWire = loadCapture(proxy).stream;
    const vendorHasDone = hasDoneTerminator(vendorWire);
    const proxyHasDone = hasDoneTerminator(proxyWire);

    const declared = JSON.parse(readFileSync(join(specDir, 'declared-divergences.json'), 'utf8'))
      .divergences.find((entry) => entry.surface === surface && entry.claim === 'stream-terminator');

    if (declared) {
      // A declared divergence has to still be true. When the proxy quietly comes
      // back into line the declaration is stale, and a stale exemption hides the
      // fix and waves the next regression through — so that fails too.
      assert.notEqual(
        proxyHasDone,
        vendorHasDone,
        `${surface} declares a terminator divergence (${declared.id}) that no longer exists; remove the declaration`,
      );
      return;
    }

    assert.equal(
      proxyHasDone,
      vendorHasDone,
      `${surface}: vendor ${vendorHasDone ? 'sends' : 'does not send'} a [DONE] terminator, proxy ${proxyHasDone ? 'does' : 'does not'}`,
    );
  });
}
