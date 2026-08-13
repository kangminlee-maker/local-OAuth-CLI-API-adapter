import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withFirstEventSettled } from '../dist/proxy/http-server.js';

// The wrapper exists so a model rejection can still become a 404 before SSE
// headers commit. Because it drives the source iterator by hand, it owns that
// iterator's lifetime: closing the wrapper early — a client disconnecting
// mid-stream — must reach the source generator's own cleanup, or the CLI
// process, timer, or backend lock behind it stays alive.

function sourceRecordingCleanup(state) {
  return (async function* source() {
    try {
      yield { type: 'text_delta', delta: 'first' };
      yield { type: 'text_delta', delta: 'second' };
      yield { type: 'text_delta', delta: 'third' };
    } finally {
      state.cleanedUp = true;
    }
  })();
}

test('breaking out after the first event runs the source cleanup', async () => {
  const state = { cleanedUp: false };
  const wrapped = await withFirstEventSettled(sourceRecordingCleanup(state));
  for await (const event of wrapped) {
    assert.equal(event.delta, 'first');
    break;
  }
  assert.equal(state.cleanedUp, true, 'source cleanup must run on early close');
});

test('breaking out mid-stream runs the source cleanup', async () => {
  const state = { cleanedUp: false };
  const wrapped = await withFirstEventSettled(sourceRecordingCleanup(state));
  const seen = [];
  for await (const event of wrapped) {
    seen.push(event.delta);
    if (seen.length === 2) break;
  }
  assert.deepEqual(seen, ['first', 'second']);
  assert.equal(state.cleanedUp, true);
});

test('draining fully also runs the source cleanup exactly once', async () => {
  const state = { cleanedUp: false };
  const wrapped = await withFirstEventSettled(sourceRecordingCleanup(state));
  const seen = [];
  for await (const event of wrapped) seen.push(event.delta);
  assert.deepEqual(seen, ['first', 'second', 'third']);
  assert.equal(state.cleanedUp, true);
});

test('an error thrown before the first event propagates without committing anything', async () => {
  const failing = (async function* () {
    throw Object.assign(new Error('nope'), { statusCode: 404 });
    // eslint-disable-next-line no-unreachable
    yield { type: 'text_delta', delta: 'unreachable' };
  })();
  await assert.rejects(() => withFirstEventSettled(failing), (err) => {
    assert.equal(err.statusCode, 404);
    return true;
  });
});

test('control: hand-driving an iterator without closing it leaves cleanup undone', async () => {
  // This is exactly what the wrapper does minus its `finally`. It shows the
  // cleanup above is caused by that block, not by generator semantics.
  const state = { cleanedUp: false };
  const iterator = sourceRecordingCleanup(state)[Symbol.asyncIterator]();
  await iterator.next();
  assert.equal(state.cleanedUp, false, 'without an explicit return(), the source stays open');
  await iterator.return?.();
  assert.equal(state.cleanedUp, true, 'and return() is what closes it');
});

test('honour-on settles the first event before returning', () => {
  // The off-mode side of this property lives in the live HTTP header-timing
  // test, which drives `streamEvents` and the real server. Asserting it here
  // would only observe that async generators are lazy.
  return (async () => {
    const state = { released: false };
    const gated = (async function* () {
      await new Promise((r) => setTimeout(r, 50));
      state.released = true;
      yield { type: 'text_delta', delta: 'first' };
    })();
    const wrapped = await withFirstEventSettled(gated);
    assert.equal(state.released, true);
    const seen = [];
    for await (const event of wrapped) seen.push(event.delta);
    assert.deepEqual(seen, ['first']);
  })();
});
