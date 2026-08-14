import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startLocalApiProxy } from '../dist/proxy/http-server.js';
import { unsupportedModelError } from '../dist/proxy/types.js';

// What a client actually receives when something goes wrong, per surface. These
// are HTTP-level: the backends have their own tests, but the contract promises a
// RESPONSE, and the two surfaces do not share an error envelope.

function backendThat(behaviour) {
  return {
    name: 'test',
    model: 'configured-model',
    async generate() {
      if (behaviour.fail) throw behaviour.fail();
      return ok();
    },
    async *stream() {
      if (behaviour.delta) yield { type: 'text_delta', delta: 'partial' };
      if (behaviour.fail) throw behaviour.fail();
      yield { type: 'completed', result: ok() };
    },
    async close() {},
  };
}

function ok() {
  return {
    id: 'x', model: 'configured-model', text: 'OK', toolCalls: [],
    usage: { inputTokens: 1, outputTokens: 1, source: 'estimated' }, latencyMs: 1,
  };
}

async function call(backend, path, body) {
  const started = await startLocalApiProxy({
    backend, host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
  });
  try {
    const res = await fetch(`${started.url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, text: await res.text() };
  } finally {
    await started.close();
  }
}

const CHAT = { model: 'a-model', messages: [{ role: 'user', content: 'hi' }] };
const MESSAGES = { model: 'a-model', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] };

test('/v1/messages: a refused model is a 404 in the Anthropic envelope', async () => {
  // Anthropic errors are `{type:"error", error:{type, message}}` — no `param`, no
  // `code`. Routing this through the OpenAI writer would hand an Anthropic client
  // a body it cannot parse, with a `type` from the wrong vocabulary.
  const { status, text } = await call(
    backendThat({ fail: () => unsupportedModelError('a-model', 'anthropic-messages', true) }),
    '/v1/messages',
    MESSAGES,
  );
  const body = JSON.parse(text);
  assert.equal(status, 404);
  assert.equal(body.type, 'error');
  assert.equal(body.error.type, 'not_found_error');
  assert.equal(body.error.param, undefined, 'the Anthropic shape has no param');
  assert.equal(body.error.code, undefined, 'the Anthropic shape has no code');
});

test('/v1/chat/completions: a refused model is a 404 in the OpenAI envelope', async () => {
  const { status, text } = await call(
    backendThat({ fail: () => unsupportedModelError('a-model', 'openai-chat', true) }),
    '/v1/chat/completions',
    CHAT,
  );
  const body = JSON.parse(text);
  assert.equal(status, 404);
  assert.equal(body.error.type, 'invalid_request_error');
  assert.equal(body.error.code, 'model_not_found');
  assert.equal(body.error.param, 'model');
});

test('/v1/messages: a failure with no provider mapping still uses the Anthropic envelope', async () => {
  // The generic fallback used to answer every surface in the OpenAI shape.
  const { status, text } = await call(
    backendThat({ fail: () => new Error('error_during_execution: boom') }),
    '/v1/messages',
    MESSAGES,
  );
  const body = JSON.parse(text);
  assert.ok(status >= 500 && status < 600, `expected a 5xx, got ${status}`);
  assert.equal(body.type, 'error');
  assert.equal(body.error.type, 'api_error');
  assert.match(body.error.message, /error_during_execution: boom/);
  assert.equal(body.error.param, undefined);
});

// A client picks the model, and the runtime echoes it into its refusal. Without a
// ceiling at the boundary, that is a response as large as the client cares to
// make it — on every surface and in every envelope.
const OVERSIZED = 'X'.repeat(900);

for (const [path, body, shape] of [
  ['/v1/chat/completions', { ...CHAT, model: OVERSIZED }, 'openai-chat'],
  ['/v1/responses', { model: OVERSIZED, input: 'hi' }, 'openai-chat'],
  ['/v1/messages', { ...MESSAGES, model: OVERSIZED }, 'anthropic-messages'],
]) {
  test(`${path}: an oversized model name does not become an oversized error`, async () => {
    const { text } = await call(
      backendThat({ fail: () => unsupportedModelError(OVERSIZED, shape, true) }),
      path,
      body,
    );
    const message = JSON.parse(text).error.message;
    assert.ok(message.length <= 500, `error message must be bounded, got ${message.length}`);
    assert.ok(message.endsWith('...[truncated]'), `expected the marker: ${message.slice(-20)}`);
  });
}

test('a mid-stream model refusal is bounded in the SSE error frame', async () => {
  // A refusal after the first chunk is serialized by the streaming error writer,
  // which is a different branch from the JSON one — and carries the client's own
  // oversized model name.
  const { text } = await call(
    backendThat({ delta: true, fail: () => unsupportedModelError(OVERSIZED, 'openai-chat', true) }),
    '/v1/chat/completions',
    { ...CHAT, model: OVERSIZED, stream: true },
  );
  const frame = text.split('\n').find((line) => line.includes('"error"'));
  assert.ok(frame, `expected an error frame: ${text}`);
  const payload = JSON.parse(frame.replace(/^data: /, '')).error;
  assert.equal(payload.code, 'model_not_found');
  assert.ok(payload.message.length <= 500, `SSE refusal must be bounded, got ${payload.message.length}`);
});

test('a mid-stream failure is bounded in the SSE error frame too', async () => {
  const { text } = await call(
    backendThat({ delta: true, fail: () => new Error('Y'.repeat(900)) }),
    '/v1/chat/completions',
    { ...CHAT, stream: true },
  );
  const frame = text.split('\n').find((line) => line.includes('"error"'));
  assert.ok(frame, `expected an error frame: ${text}`);
  const message = JSON.parse(frame.replace(/^data: /, '')).error.message;
  assert.ok(message.length <= 500, `SSE error must be bounded, got ${message.length}`);
});

test('/v1/messages: a mid-stream failure ends with an Anthropic error event and no message_stop', async () => {
  // The Anthropic stream has no `[DONE]`; its terminal frame is the error itself.
  // A `message_stop` here would tell a client the turn finished normally.
  const { status, text } = await call(
    backendThat({ delta: true, fail: () => new Error('mid-stream boom') }),
    '/v1/messages',
    { ...MESSAGES, stream: true },
  );
  assert.equal(status, 200, 'headers are committed by the first frame');
  assert.ok(text.includes('"text":"partial"'), 'the delta already sent stays sent');
  const events = text.split('\n').filter((l) => l.startsWith('event: ')).map((l) => l.slice(7).trim());
  assert.equal(events.at(-1), 'error', `the stream must end on the failure: ${events.join(',')}`);
  assert.ok(!events.includes('message_stop'), `a failed turn must not report a normal stop: ${events.join(',')}`);
  const frame = text.split('\n').find((l) => l.startsWith('data: ') && l.includes('"error"'));
  assert.equal(JSON.parse(frame.slice(6)).error.type, 'api_error');
});

// Model echo with honouring off, as measured rather than as assumed. This mode
// exists to preserve pre-existing behaviour, so what it does is the contract —
// and what it does is not uniform: the non-streaming body reports what the
// backend says ran, while a stream opens with the request model and closes with
// the executed one. A client keying on `chunk.model` therefore sees two values in
// one response. That is a wart, pinned here so it cannot change silently, and
// described in the contract rather than quietly corrected.
function echoBackend() {
  const result = {
    id: 'x', model: 'executed-model', text: 'OK', toolCalls: [],
    usage: { inputTokens: 1, outputTokens: 1, source: 'estimated' }, latencyMs: 1,
  };
  return {
    name: 'test', model: 'configured-model',
    async generate() { return result; },
    async *stream() {
      yield { type: 'text_delta', delta: 'hi' };
      yield { type: 'completed', result };
    },
    async close() {},
  };
}

test('honour-off: the non-streaming body reports the model the backend ran', async () => {
  const { text } = await call(echoBackend(), '/v1/chat/completions', {
    model: 'client-model', messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(JSON.parse(text).model, 'executed-model');
});

test('honour-off: /v1/messages reports the model the backend ran', async () => {
  const { text } = await call(echoBackend(), '/v1/messages', {
    model: 'client-model', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(JSON.parse(text).model, 'executed-model');
});

test('honour-off: a stream opens with the request model and closes with the executed one', async () => {
  const { text } = await call(echoBackend(), '/v1/chat/completions', {
    model: 'client-model', stream: true, messages: [{ role: 'user', content: 'hi' }],
  });
  const models = text.split('\n')
    .filter((l) => l.startsWith('data: ') && l.includes('"model"'))
    .map((l) => JSON.parse(l.slice(6)).model);
  assert.equal(models[0], 'client-model', 'the opening chunk echoes the request');
  assert.equal(models.at(-1), 'executed-model', 'the closing chunk reports what ran');
});
