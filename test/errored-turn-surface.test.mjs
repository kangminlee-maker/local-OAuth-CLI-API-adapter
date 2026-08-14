import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startLocalApiProxy } from '../dist/proxy/http-server.js';

// What a client actually sees when a turn fails is decided by whether any bytes
// have been committed. Both halves are pinned here: the contract describes them
// and nothing else was covering the post-commit half.

function failingBackend(options) {
  return {
    name: 'test',
    model: 'm',
    async generate() {
      throw new Error(options.message);
    },
    async *stream() {
      if (options.deltaFirst) yield { type: 'text_delta', delta: 'partial' };
      throw new Error(options.message);
    },
    async close() {},
  };
}

async function withProxy(backend, run) {
  const started = await startLocalApiProxy({
    backend,
    host: '127.0.0.1',
    port: 0,
    requestTimeoutMs: 30_000,
  });
  try {
    return await run(started.url);
  } finally {
    await started.close();
  }
}

const MESSAGE = 'upstream returned 404 for the messages route';

test('a failed turn with nothing written yet is an HTTP 5xx carrying the runtime message', async () => {
  const { status, body } = await withProxy(
    failingBackend({ message: MESSAGE }),
    async (url) => {
      const res = await fetch(`${url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
      });
      return { status: res.status, body: await res.json() };
    },
  );
  assert.ok(status >= 500 && status < 600, `expected a 5xx, got ${status}`);
  assert.equal(body.error.message, MESSAGE);
  // Not a model error: nothing here says the client should pick another model.
  assert.equal(body.error.code, null);
  assert.equal(body.error.param, null);
});

test('a failed turn after the first chunk is an in-band SSE error, not a completion', async () => {
  // Once a chunk is on the wire the status is committed, so the 5xx above is not
  // available. The failure must still be visible and must not look like a
  // finished answer — no `finish_reason`, and the error before `[DONE]`.
  const { status, text } = await withProxy(
    failingBackend({ message: MESSAGE, deltaFirst: true }),
    async (url) => {
      const res = await fetch(`${url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
      });
      return { status: res.status, text: await res.text() };
    },
  );
  assert.equal(status, 200, 'headers are already committed by the first chunk');
  assert.ok(text.includes('"content":"partial"'), 'the delta already written stays written');

  const events = text.split('\n\n').map((block) => block.replace(/^data: /, '').trim()).filter(Boolean);
  assert.equal(events.at(-1), '[DONE]');
  const errorEvent = events.map((e) => (e === '[DONE]' ? null : JSON.parse(e))).find((e) => e?.error);
  assert.ok(errorEvent, `expected an in-band error event: ${text}`);
  assert.equal(errorEvent.error.message, MESSAGE);
  assert.ok(
    !events.some((e) => e !== '[DONE]' && JSON.parse(e).choices?.some((c) => c.finish_reason)),
    `a failed turn must not report a finish_reason: ${text}`,
  );
});
