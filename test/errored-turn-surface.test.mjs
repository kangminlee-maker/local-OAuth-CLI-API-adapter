import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startLocalApiProxy } from '../dist/proxy/http-server.js';
import { ClaudeCodeBackend } from '../dist/proxy/claude-code-backend.js';

const here = dirname(fileURLToPath(import.meta.url));
const resultShapes = resolve(here, 'fixtures/claude-result-shapes.cjs');

// The fixture is committed executable; the suite does not chmod a tracked file,
// which would fail in a read-only checkout.

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


// The stub tests above pin the HTTP layer. These wire the REAL Claude backend to
// the server, so the documented Claude statuses are established end to end
// rather than inferred from a stub that throws a plain Error.
async function claudeStatusFor(shape, body) {
  const previous = process.env.CLAUDE_TEST_RESULT_SHAPE;
  process.env.CLAUDE_TEST_RESULT_SHAPE = shape;
  const backend = new ClaudeCodeBackend({
    command: resultShapes,
    cwd: process.cwd(),
    model: 'claude-opus-4-8',
    timeoutMs: 30_000,
    honorRequestModel: true,
  });
  const started = await startLocalApiProxy({
    backend, host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
  });
  try {
    const res = await fetch(`${started.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, payload: await res.json() };
  } finally {
    await started.close();
    await backend.close();
    if (previous === undefined) delete process.env.CLAUDE_TEST_RESULT_SHAPE;
    else process.env.CLAUDE_TEST_RESULT_SHAPE = previous;
  }
}

const CHAT = { model: 'claude-not-a-model', messages: [{ role: 'user', content: 'hi' }] };

test('Claude: a refused model is a 404 model_not_found at the HTTP surface', async () => {
  const { status, payload } = await claudeStatusFor('assistant_only', CHAT);
  assert.equal(status, 404);
  assert.equal(payload.error.code, 'model_not_found');
  assert.equal(payload.error.param, 'model');
});

test('Claude: a bare 404 with no model signal is a 5xx at the HTTP surface', async () => {
  const { status, payload } = await claudeStatusFor('bare_404', CHAT);
  assert.ok(status >= 500 && status < 600, `expected a 5xx, got ${status}`);
  assert.equal(payload.error.code, null);
  assert.match(payload.error.message, /upstream returned 404/);
});

test('Claude: an errored result with no diagnostic is a 5xx that leaks no event fields', async () => {
  const { status, payload } = await claudeStatusFor('error_no_text', CHAT);
  assert.ok(status >= 500 && status < 600, `expected a 5xx, got ${status}`);
  assert.ok(!payload.error.message.includes('sentinel-session'), payload.error.message);
  assert.match(payload.error.message, /without a diagnostic message/);
});

test('Claude: child stderr never reaches the HTTP client', async () => {
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;
  try {
    const { status, payload } = await claudeStatusFor('stderr_only', CHAT);
    assert.ok(status >= 500 && status < 600, `expected a 5xx, got ${status}`);
    assert.ok(!payload.error.message.includes('SENTINEL_STDERR'), payload.error.message);
    assert.ok(!payload.error.message.includes('internal.example'), payload.error.message);
  } finally {
    process.stderr.write = originalWrite;
  }
});

test('Claude: an error subtype with no diagnostic still names the failure kind', async () => {
  // The kind is the only thing the runtime told us. Replacing it with a generic
  // sentence would leave an operator with nothing to search for.
  const { status, payload } = await claudeStatusFor('subtype_only', CHAT);
  assert.ok(status >= 500 && status < 600, `expected a 5xx, got ${status}`);
  assert.match(payload.error.message, /error_max_turns/);
  assert.ok(!payload.error.message.includes('sentinel-session'), payload.error.message);
  assert.ok(!payload.error.message.includes('total_cost_usd'), payload.error.message);
});
