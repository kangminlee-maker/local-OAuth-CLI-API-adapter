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

// `withFirstEventSettled` was a generator until 2026-08-31 and is now an
// explicit iterator, because `return()` on a generator that was never started
// skips its body — an abandoned fan-out sibling is exactly that case. The
// rewrite made `close()` idempotent by hand, and a generator's own `finally`
// runs once for free, so the property that came free before now needs pinning:
// a source whose second teardown rejects, or releases an already-released lock
// or process, turns a legal repeated `return()` into a different answer.
test('the wrapper closes its source once, however many times it is returned', async () => {
  let returns = 0;
  const source = {
    [Symbol.asyncIterator]() {
      return {
        async next() { return { done: false, value: { type: 'text_delta', delta: 'a' } }; },
        async return() {
          returns += 1;
          if (returns > 1) throw new Error('a second teardown must never happen');
          return { done: true, value: undefined };
        },
      };
    },
  };
  const wrapped = await withFirstEventSettled(source);
  const iterator = wrapped[Symbol.asyncIterator]();
  assert.deepEqual(await iterator.return(), { done: true, value: undefined });
  assert.deepEqual(await iterator.return(), { done: true, value: undefined }, 'a repeated return is legal and is a no-op');
  assert.equal(returns, 1, 'the source is torn down exactly once');
  // And a fresh iterator off the same wrapper does not tear it down again.
  await wrapped[Symbol.asyncIterator]().return?.();
  assert.equal(returns, 1);
  // Closed means closed: no event is delivered after it.
  assert.deepEqual(await iterator.next(), { done: true, value: undefined });
});

test('a source exhausted normally is closed once, not once per next()', async () => {
  let returns = 0;
  let delivered = 0;
  const source = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          delivered += 1;
          return delivered <= 2
            ? { done: false, value: { type: 'text_delta', delta: String(delivered) } }
            : { done: true, value: undefined };
        },
        async return() { returns += 1; return { done: true, value: undefined }; },
      };
    },
  };
  const wrapped = await withFirstEventSettled(source);
  const seen = [];
  for await (const event of wrapped) seen.push(event.delta);
  assert.deepEqual(seen, ['1', '2']);
  assert.equal(returns, 1, 'exhaustion closes the source exactly once');
});
