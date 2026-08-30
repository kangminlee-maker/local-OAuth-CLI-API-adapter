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

const specDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'spec');
const captureDir = join(specDir, 'captures');

function loadCapture(name) {
  return JSON.parse(readFileSync(join(captureDir, `${name}.json`), 'utf8'));
}

function hasDoneTerminator(wire) {
  return /^data:\s*\[DONE\]\s*$/m.test(wire);
}

// Surfaces to compare, and which capture is which side.
const SURFACES = [
  { surface: 'openai.responses.stream', vendor: 'direct-responses-stream', proxy: 'proxy-responses-stream' },
  { surface: 'openai.chat.stream', vendor: 'direct-chat-stream', proxy: 'proxy-chat-stream' },
];

test('the capture set this check reads is present and intact', () => {
  // A check whose evidence is missing has not passed, it has not run. Saying so
  // loudly is the whole difference between the two, and an empty directory
  // reading as green is the failure this suite keeps finding elsewhere.
  const files = readdirSync(captureDir).filter((name) => name.endsWith('.json'));
  assert.ok(files.length > 0, 'spec/captures is empty: no stream evidence to check');

  for (const { vendor, proxy } of SURFACES) {
    for (const name of [vendor, proxy]) {
      const capture = loadCapture(name);
      assert.equal(typeof capture.stream, 'string', `${name} carries no wire text`);
      assert.ok(capture.stream.length > 0, `${name} wire text is empty`);
      // The fixture is a promotion of a real capture; the digest ties it back.
      const actual = createHash('sha256').update(capture.stream).digest('hex');
      assert.equal(actual, capture.streamSha256, `${name} no longer matches the capture it was promoted from`);
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
