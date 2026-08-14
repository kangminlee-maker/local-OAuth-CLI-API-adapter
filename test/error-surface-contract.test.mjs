import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
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

test('/v1/responses: a refused model is a 404 in the OpenAI envelope', async () => {
  const { status, text } = await call(
    backendThat({ fail: () => unsupportedModelError('a-model', 'openai-chat', true) }),
    '/v1/responses',
    { model: 'a-model', input: 'hi' },
  );
  const body = JSON.parse(text);
  assert.equal(status, 404);
  assert.equal(body.error.type, 'invalid_request_error');
  assert.equal(body.error.code, 'model_not_found');
  assert.equal(body.error.param, 'model');
});

// The failure envelopes are pinned above; the SUCCESS envelopes were asserted
// only where a test happened to touch a field. A client parses a fixed set of
// them, and dropping or renaming any one is a one-line edit.
test('/v1/chat/completions: the success envelope carries the fields a client reads', async () => {
  const { status, text } = await call(backendThat({}), '/v1/chat/completions', CHAT);
  assert.equal(status, 200);
  const body = JSON.parse(text);
  assert.equal(body.object, 'chat.completion');
  assert.match(body.id, /^chatcmpl-/);
  assert.equal(typeof body.created, 'number');
  assert.equal(body.choices.length, 1);
  assert.equal(body.choices[0].index, 0);
  assert.equal(body.choices[0].message.role, 'assistant');
  assert.equal(body.choices[0].message.content, 'OK');
  assert.equal(body.choices[0].finish_reason, 'stop');
  assert.equal(body.usage.prompt_tokens, 1);
  assert.equal(body.usage.completion_tokens, 1);
  assert.equal(body.usage.total_tokens, 2);
});

test('/v1/responses: the success envelope carries the fields a client reads', async () => {
  const { status, text } = await call(backendThat({}), '/v1/responses', { model: 'a-model', input: 'hi' });
  assert.equal(status, 200);
  const body = JSON.parse(text);
  assert.equal(body.object, 'response');
  assert.equal(body.status, 'completed');
  assert.equal(body.error, null);
  assert.equal(typeof body.created_at, 'number');

  const message = body.output.find((item) => item.type === 'message');
  assert.ok(message, `expected a message item: ${JSON.stringify(body.output)}`);
  assert.equal(message.role, 'assistant');
  assert.equal(message.status, 'completed');
  assert.equal(message.content[0].type, 'output_text');
  assert.equal(message.content[0].text, 'OK');

  assert.equal(body.usage.input_tokens, 1);
  assert.equal(body.usage.output_tokens, 1);
  assert.equal(body.usage.total_tokens, 2);
});

test('/v1/messages: the success envelope carries the fields a client reads', async () => {
  const { status, text } = await call(backendThat({}), '/v1/messages', MESSAGES);
  assert.equal(status, 200);
  const body = JSON.parse(text);
  assert.equal(body.type, 'message');
  assert.equal(body.role, 'assistant');
  assert.equal(body.content[0].type, 'text');
  assert.equal(body.content[0].text, 'OK');
  assert.equal(body.stop_reason, 'end_turn');
  assert.equal(body.stop_sequence, null);
  assert.equal(body.usage.input_tokens, 1);
  assert.equal(body.usage.output_tokens, 1);
  // Anthropic reports the two counts only; a total_tokens here is an OpenAI
  // field leaking into the wrong envelope.
  assert.equal(body.usage.total_tokens, undefined);
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

// Every bound test above asserts the truncating side. The other side — a message
// that already fits arrives whole — was pinned by nothing, so a bound that
// truncated unconditionally passed them all.
for (const [label, length] of [['just under', 499], ['exactly at', 500]]) {
  test(`a message ${label} the bound is delivered untouched`, async () => {
    const fits = 'M'.repeat(length);
    const { text } = await call(
      backendThat({ fail: () => new Error(fits) }),
      '/v1/chat/completions',
      CHAT,
    );
    const message = JSON.parse(text).error.message;
    assert.equal(message.length, length, `a fitting message must not be truncated`);
    assert.equal(message, fits);
  });
}

test('a message one character over the bound is truncated to the bound', async () => {
  const { text } = await call(
    backendThat({ fail: () => new Error('M'.repeat(501)) }),
    '/v1/chat/completions',
    CHAT,
  );
  const message = JSON.parse(text).error.message;
  assert.equal(message.length, 500);
  assert.ok(message.endsWith('...[truncated]'));
});

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

// A backend signals a provider error by carrying its JSON in the message. The
// mapping has to read the ORIGINAL string: bounding before parsing turns a
// mapped 429 into an unmapped 500 whose body is a fragment of broken JSON.
function providerError(status, message) {
  return () => new Error(JSON.stringify({
    status,
    error: { message, type: 'rate_limit_error', param: null, code: 'rate_limit_exceeded' },
  }));
}

const LONG_PROVIDER_MESSAGE = 'M'.repeat(600);

test('a provider error survives mapping even when its message is oversized', async () => {
  const { status, text } = await call(
    backendThat({ fail: providerError(429, LONG_PROVIDER_MESSAGE) }),
    '/v1/chat/completions',
    CHAT,
  );
  const body = JSON.parse(text);
  assert.equal(status, 429, 'the provider status must survive');
  assert.equal(body.error.type, 'rate_limit_error');
  assert.equal(body.error.code, 'rate_limit_exceeded');
  assert.ok(body.error.message.startsWith('MMMM'), 'the provider message, not a JSON fragment');
  assert.ok(body.error.message.length <= 500, `bounded, got ${body.error.message.length}`);
});

test('/v1/messages: a mapped provider error uses the Anthropic envelope', async () => {
  const { status, text } = await call(
    backendThat({ fail: providerError(429, 'slow down') }),
    '/v1/messages',
    MESSAGES,
  );
  const body = JSON.parse(text);
  assert.equal(status, 429);
  assert.equal(body.type, 'error');
  assert.equal(body.error.type, 'rate_limit_error');
  assert.equal(body.error.param, undefined, 'the Anthropic shape has no param');
  assert.equal(body.error.code, undefined, 'the Anthropic shape has no code');
});

test('a mid-stream provider error keeps its mapping in the SSE frame', async () => {
  const { text } = await call(
    backendThat({ delta: true, fail: providerError(429, LONG_PROVIDER_MESSAGE) }),
    '/v1/chat/completions',
    { ...CHAT, stream: true },
  );
  const frame = text.split('\n').find((line) => line.includes('"error"'));
  const payload = JSON.parse(frame.replace(/^data: /, '')).error;
  assert.equal(payload.type, 'rate_limit_error');
  assert.ok(payload.message.startsWith('MMMM'), 'the provider message, not a JSON fragment');
  assert.ok(payload.message.length <= 500);
});

// The generic branch: an unmapped failure whose own message is oversized. The
// oversized-model tests exercise `ProxyRequestError`, which is a different one.
const LONG_GENERIC = 'G'.repeat(900);

for (const [path, body] of [
  ['/v1/chat/completions', CHAT],
  ['/v1/responses', { model: 'a-model', input: 'hi' }],
  ['/v1/messages', MESSAGES],
]) {
  test(`${path}: an oversized unmapped failure is bounded`, async () => {
    const { text } = await call(backendThat({ fail: () => new Error(LONG_GENERIC) }), path, body);
    const message = JSON.parse(text).error.message;
    assert.ok(message.length <= 500, `expected a bound, got ${message.length}`);
    assert.ok(message.startsWith('GGGG'));
  });
}

// `/v1/responses` is its own writer. Its failure envelope and terminal sequence
// were pinned only for chat completions.
test('/v1/responses: a pre-stream failure uses the OpenAI envelope', async () => {
  const { status, text } = await call(
    backendThat({ fail: () => new Error('boom') }),
    '/v1/responses',
    { model: 'a-model', input: 'hi' },
  );
  const body = JSON.parse(text);
  assert.ok(status >= 500 && status < 600, `expected a 5xx, got ${status}`);
  assert.equal(body.error.type, 'server_error');
  assert.equal(body.type, undefined, 'not the Anthropic envelope');
  assert.match(body.error.message, /boom/);
});

test('/v1/responses: a mid-stream failure ends with an error frame then [DONE]', async () => {
  const { status, text } = await call(
    backendThat({ delta: true, fail: () => new Error('mid-stream boom') }),
    '/v1/responses',
    { model: 'a-model', input: 'hi', stream: true },
  );
  assert.equal(status, 200, 'headers are committed by the first frame');
  const frames = text.split('\n\n').map((b) => b.trim()).filter(Boolean);
  assert.equal(frames.at(-1), 'data: [DONE]', `the stream must end on [DONE]: ${frames.at(-1)}`);
  assert.ok(
    frames.some((f) => f.includes('"error"') && f.includes('mid-stream boom')),
    `expected an in-band error frame: ${text}`,
  );
});

// The access gate is client-observable and, until now, undocumented. Its 401 is
// shaped per surface for the same reason every other error is.
async function unauthorized(path, body) {
  const started = await startLocalApiProxy({
    backend: backendThat({}), host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
    authKey: 'secret-key',
  });
  try {
    const res = await fetch(`${started.url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  } finally {
    await started.close();
  }
}

test('the access gate rejects /v1/responses in the OpenAI envelope', async () => {
  const { status, body } = await unauthorized('/v1/responses', { model: 'a-model', input: 'hi' });
  assert.equal(status, 401);
  assert.equal(body.error.type, 'invalid_request_error');
  assert.equal(body.error.code, 'invalid_api_key');
});

test('the access gate rejects /v1/messages in the Anthropic envelope', async () => {
  const { status, body } = await unauthorized('/v1/messages', MESSAGES);
  assert.equal(status, 401);
  assert.equal(body.type, 'error');
  assert.equal(body.error.type, 'authentication_error');
  assert.equal(body.error.code, undefined);
});

test('the access gate rejects an images route too', async () => {
  const { status, body } = await unauthorized('/v1/images/generations', { model: 'image-2', prompt: 'hi' });
  assert.equal(status, 401);
  assert.equal(body.error.type, 'invalid_request_error');
});

test('/v1/responses: the non-streaming body reports the model the backend ran', async () => {
  const { text } = await call(echoBackend(), '/v1/responses', { model: 'client-model', input: 'hi' });
  assert.equal(JSON.parse(text).model, 'executed-model');
});

// The two credential forms are alternatives, and only the documented forms
// count. Each of these was accepted or rejected wrongly before.
async function withKey(headers, path = '/v1/chat/completions', body = CHAT) {
  const started = await startLocalApiProxy({
    backend: backendThat({}), host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
    authKey: 'secret-key',
  });
  try {
    const res = await fetch(`${started.url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    return res.status;
  } finally {
    await started.close();
  }
}

test('a valid Bearer is accepted even beside a stale x-api-key', async () => {
  // They are alternatives. Reading only the first non-empty header let a stale
  // one veto a credential the contract accepts.
  assert.equal(await withKey({ 'x-api-key': 'stale', authorization: 'Bearer secret-key' }), 200);
});

test('a valid x-api-key is accepted even beside a wrong Bearer', async () => {
  assert.equal(await withKey({ 'x-api-key': 'secret-key', authorization: 'Bearer wrong' }), 200);
});

test('a bare Authorization value is not a credential', async () => {
  // The contract names the Bearer form. Accepting the raw value widened the gate
  // beyond what was documented.
  assert.equal(await withKey({ authorization: 'secret-key' }), 401);
});

test('a Bearer with no token is rejected', async () => {
  assert.equal(await withKey({ authorization: 'Bearer' }), 401);
});

test('the access gate covers GET routes too', async () => {
  const started = await startLocalApiProxy({
    backend: backendThat({}), host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
    authKey: 'secret-key',
  });
  try {
    const res = await fetch(`${started.url}/v1/models`);
    assert.equal(res.status, 401);
    const ok = await fetch(`${started.url}/v1/models`, { headers: { 'x-api-key': 'secret-key' } });
    assert.equal(ok.status, 200);
  } finally {
    await started.close();
  }
});

// The failure sequences are pinned; the NORMAL ones were not. Deleting a
// terminal frame is a one-line edit that a failure test cannot see.
function usageBackend() {
  const result = {
    id: 'x', model: 'configured-model', text: 'hello', toolCalls: [],
    usage: { inputTokens: 11, outputTokens: 22, totalTokens: 33, source: 'provider' },
    latencyMs: 1,
  };
  return {
    name: 'test', model: 'configured-model',
    async generate() { return result; },
    async *stream() {
      yield { type: 'text_delta', delta: 'hello' };
      yield { type: 'completed', result };
    },
    async close() {},
  };
}

test('/v1/messages: a successful stream runs message_start through message_stop', async () => {
  const { text } = await call(usageBackend(), '/v1/messages', { ...MESSAGES, stream: true });
  const events = text.split('\n').filter((l) => l.startsWith('event: ')).map((l) => l.slice(7).trim());
  assert.deepEqual(events, [
    'message_start', 'content_block_start', 'content_block_delta',
    'content_block_stop', 'message_delta', 'message_stop',
  ]);
});

test('/v1/chat/completions: a non-streaming response carries the promised usage', async () => {
  const { text } = await call(usageBackend(), '/v1/chat/completions', CHAT);
  const usage = JSON.parse(text).usage;
  assert.equal(usage.prompt_tokens, 11);
  assert.equal(usage.completion_tokens, 22);
  assert.equal(usage.total_tokens, 33);
});

test('/v1/messages: a non-streaming response carries the promised usage', async () => {
  const { text } = await call(usageBackend(), '/v1/messages', MESSAGES);
  const usage = JSON.parse(text).usage;
  assert.equal(usage.input_tokens, 11);
  assert.equal(usage.output_tokens, 22);
});

test('/v1/messages: a streaming response reports usage in message_delta', async () => {
  const { text } = await call(usageBackend(), '/v1/messages', { ...MESSAGES, stream: true });
  const frame = text.split('\n').find((l) => l.startsWith('data: ') && l.includes('"message_delta"'));
  assert.ok(frame, `expected a message_delta: ${text}`);
  assert.equal(JSON.parse(frame.slice(6)).usage.output_tokens, 22);
});

test('/v1/responses: a non-streaming response carries the promised usage', async () => {
  const { text } = await call(usageBackend(), '/v1/responses', { model: 'a-model', input: 'hi' });
  const usage = JSON.parse(text).usage;
  assert.equal(usage.input_tokens, 11);
  assert.equal(usage.output_tokens, 22);
  assert.equal(usage.total_tokens, 33);
});

test('/v1/chat/completions: include_usage adds a final usage chunk', async () => {
  const { text } = await call(usageBackend(), '/v1/chat/completions', {
    ...CHAT, stream: true, stream_options: { include_usage: true },
  });
  const frames = text.split('\n').filter((l) => l.startsWith('data: ') && !l.includes('[DONE]'))
    .map((l) => JSON.parse(l.slice(6)));
  const usageFrame = frames.find((f) => f.usage);
  assert.ok(usageFrame, `expected a usage chunk: ${text}`);
  assert.deepEqual(usageFrame.choices, []);
  assert.equal(usageFrame.usage.total_tokens, 33);
});

test('/v1/messages: a mid-stream provider error keeps its mapping and bound', async () => {
  // The Anthropic stream catch used to hard-code `api_error` and serialize the
  // raw throw — which, since a provider error travels as JSON inside the
  // message, handed the client a truncated fragment of it.
  const { text } = await call(
    backendThat({ delta: true, fail: providerError(429, LONG_PROVIDER_MESSAGE) }),
    '/v1/messages',
    { ...MESSAGES, stream: true },
  );
  const frame = text.split('\n').find((l) => l.startsWith('data: ') && l.includes('"error"'));
  const payload = JSON.parse(frame.slice(6)).error;
  assert.equal(payload.type, 'rate_limit_error', 'the provider type must survive');
  assert.ok(payload.message.startsWith('MMMM'), 'the provider message, not a JSON fragment');
  assert.ok(payload.message.length <= 500, `bounded, got ${payload.message.length}`);
});

test('an empty authKey is a configuration error, not an open proxy', async () => {
  // `if (!authKey) return` would restore the previous defect: a proxy its
  // operator believed was closed, serving everyone.
  let reached = false;
  const backend = { ...backendThat({}), async generate() { reached = true; return null; } };
  const started = await startLocalApiProxy({
    backend, host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000, authKey: '',
  });
  try {
    for (const [path, body] of [['/v1/models', null], ['/v1/chat/completions', CHAT]]) {
      const res = await fetch(`${started.url}${path}`, body
        ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
        : {});
      assert.ok(res.status >= 400, `${path} must not be served, got ${res.status}`);
    }
    assert.equal(reached, false, 'the backend must never be reached');
  } finally {
    await started.close();
  }
});

// `fetch` folds repeated headers into one comma-joined value, so it cannot send
// what this and the next test are about. `node:http` with an array value writes
// one physical line per element, which is the distinction the gate now reads.
async function getWithRawHeaders(url, headers) {
  const target = new URL(`${url}/v1/models`);
  return await new Promise((resolve, reject) => {
    const req = http.request(
      { host: target.hostname, port: target.port, path: target.pathname, method: 'GET', headers },
      (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); },
    );
    req.on('error', reject);
    req.end();
  });
}

async function withRawKeyHeaders(headers, authKey = 'secret-key') {
  const started = await startLocalApiProxy({
    backend: backendThat({}), host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
    authKey,
  });
  try {
    return await getWithRawHeaders(started.url, headers);
  } finally {
    await started.close();
  }
}

test('repeated x-api-key headers: one valid value is enough', async () => {
  // Two physical lines. A stale duplicate must not veto a valid credential —
  // the same alternatives rule the two DIFFERENT headers follow.
  assert.equal(await withRawKeyHeaders({ 'x-api-key': ['stale', 'secret-key'] }), 200);
});

test('a key containing a comma is one key, not two', async () => {
  // The contract puts no character restriction on the key. Splitting the folded
  // value on commas — the shape a duplicate arrives in — turned this single
  // valid credential into two invalid fragments and answered 401.
  const key = 'a,b';
  assert.equal(await withRawKeyHeaders({ 'x-api-key': key }, key), 200);
  assert.equal(await withRawKeyHeaders({ authorization: `Bearer ${key}` }, key), 200);
});

test('a comma-containing key is not satisfied by one of its fragments', async () => {
  assert.equal(await withRawKeyHeaders({ 'x-api-key': 'a' }, 'a,b'), 401);
});

test('/v1/responses: a successful stream ends with completed then [DONE]', async () => {
  const { status, text } = await call(usageBackend(), '/v1/responses', {
    model: 'a-model', input: 'hi', stream: true,
  });
  assert.equal(status, 200);
  const frames = text.split('\n\n').map((b) => b.trim()).filter(Boolean);
  assert.equal(frames.at(-1), 'data: [DONE]');
  const events = text.split('\n').filter((l) => l.startsWith('event: ')).map((l) => l.slice(7).trim());
  assert.ok(events.includes('response.created'), `expected response.created: ${events.join(',')}`);
  assert.equal(events.at(-1), 'response.completed', `the last event must be completion: ${events.join(',')}`);
  // `"error": null` is a normal field of the Responses object, so look for an
  // error EVENT rather than the substring.
  assert.ok(!events.includes('error'), `a successful stream carries no error event: ${events.join(',')}`);
});

// --- round 38: HTTP dispatch, the gate's configuration edge, and input parity ---

test('an unknown path is a 404 whatever method it arrives with', async () => {
  // Method was checked before path, so `GET /v1/nope` answered 405 "Unsupported
  // method" — about a method this server does serve, on a path it does not have.
  const started = await startLocalApiProxy({
    backend: backendThat({}), host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
  });
  try {
    for (const method of ['GET', 'POST', 'DELETE', 'PUT']) {
      const res = await fetch(`${started.url}/v1/nope`, { method });
      assert.equal(res.status, 404, `${method} /v1/nope must be a 404`);
      const body = await res.json();
      assert.match(body.error.message, /Unknown endpoint/);
    }
  } finally {
    await started.close();
  }
});

test('a known endpoint with the wrong method is still a 405', async () => {
  const started = await startLocalApiProxy({
    backend: backendThat({}), host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
  });
  try {
    for (const method of ['GET', 'DELETE']) {
      const res = await fetch(`${started.url}/v1/chat/completions`, { method });
      assert.equal(res.status, 405, `${method} on a real POST endpoint is a method problem`);
      assert.match((await res.json()).error.message, /Unsupported method/);
    }
  } finally {
    await started.close();
  }
});

for (const [label, key] of [['trailing', 'secret '], ['leading', ' secret'], ['tab', 'secret\t']]) {
  test(`an authKey with ${label} whitespace is a configuration error, not a locked-out proxy`, async () => {
    // Presented values are trimmed, so such a key can never be presented — the
    // proxy answered 401 to every request including its operator's, with nothing
    // saying why.
    const started = await startLocalApiProxy({
      backend: backendThat({}), host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
      authKey: key,
    });
    try {
      const res = await fetch(`${started.url}/v1/models`, { headers: { 'x-api-key': key } });
      assert.ok(res.status >= 500, `expected a configuration error, got ${res.status}`);
    } finally {
      await started.close();
    }
  });
}

test('a mixed-case x-api-key header line still authenticates', async () => {
  // Header names are case-insensitive, and the gate reads raw header lines now,
  // where the original casing survives.
  assert.equal(await withRawKeyHeaders({ 'X-API-Key': 'secret-key' }), 200);
});

test('/v1/messages: max_tokens is required, as on the direct API', async () => {
  const { status, text } = await call(
    backendThat({}),
    '/v1/messages',
    { model: 'a-model', messages: [{ role: 'user', content: 'hi' }] },
  );
  assert.equal(status, 400);
  const body = JSON.parse(text);
  assert.equal(body.type, 'error');
  assert.equal(body.error.type, 'invalid_request_error');
  assert.match(body.error.message, /max_tokens is required/);
});

for (const [label, value] of [
  ['a string', 'x'],
  ['fractional', 1.5],
  ['negative', -1],
  ['null', null],
]) {
  test(`/v1/messages: max_tokens ${label} is rejected`, async () => {
    const { status } = await call(
      backendThat({}),
      '/v1/messages',
      { model: 'a-model', max_tokens: value, messages: [{ role: 'user', content: 'hi' }] },
    );
    assert.equal(status, 400, `max_tokens=${JSON.stringify(value)} is not an integer >= 0`);
  });
}

test('/v1/messages: max_tokens 0 is accepted, because the direct API accepts it', async () => {
  // Documented there as pre-warming the prompt cache without generating. A floor
  // of 1 would reject a request the direct API answers.
  const { status } = await call(
    backendThat({}),
    '/v1/messages',
    { model: 'a-model', max_tokens: 0, messages: [{ role: 'user', content: 'hi' }] },
  );
  assert.equal(status, 200);
});

for (const [path, body] of [
  ['/v1/chat/completions', { model: 'a-model', messages: [] }],
  ['/v1/messages', { model: 'a-model', max_tokens: 16, messages: [] }],
]) {
  test(`${path}: an empty messages array is rejected`, async () => {
    // `minItems: 1` on both direct APIs. An empty conversation was reaching the
    // runtime as a turn with nothing in it.
    const { status, text } = await call(backendThat({}), path, body);
    assert.equal(status, 400);
    const payload = JSON.parse(text);
    const message = payload.error.message;
    assert.match(message, /at least one message/);
  });
}

for (const [path, body] of [
  ['/v1/chat/completions', { model: 'a-model', messages: [7] }],
  ['/v1/messages', { model: 'a-model', max_tokens: 16, messages: [7] }],
]) {
  test(`${path}: a non-object message item is rejected`, async () => {
    const { status } = await call(backendThat({}), path, body);
    assert.equal(status, 400);
  });
}

for (const [path, body] of [
  ['/v1/chat/completions', { model: 'a-model', messages: null }],
  ['/v1/chat/completions', { model: 'a-model', messages: {} }],
  ['/v1/messages', { model: 'a-model', max_tokens: 16, messages: 'hi' }],
]) {
  test(`${path}: messages ${JSON.stringify(body.messages)} is rejected`, async () => {
    const { status } = await call(backendThat({}), path, body);
    assert.equal(status, 400);
  });
}

test('an unknown role is normalized to user rather than rejected', async () => {
  // A documented, deliberate divergence from the direct APIs: the normalizer is
  // permissive so local tools with their own role vocabularies still work. A
  // one-line throw in the normalizer would turn this promise into a 400.
  const { status } = await call(
    backendThat({}),
    '/v1/chat/completions',
    { model: 'a-model', messages: [{ role: 'future_role', content: 'hello' }] },
  );
  assert.equal(status, 200);
});

// --- round 38: promises the inventory showed nothing would catch breaking ---

function usageBackendReporting(usage) {
  const result = () => ({
    id: 'x', model: 'configured-model', text: 'OK', toolCalls: [], usage, latencyMs: 1,
  });
  return {
    name: 'test', model: 'configured-model',
    async generate() { return result(); },
    async *stream() {
      yield { type: 'text_delta', delta: 'OK' };
      yield { type: 'completed', result: result() };
    },
    async close() {},
  };
}

test('estimated usage is reported when the runtime reports none of its own', async () => {
  // The contract prefers provider usage and falls back to estimated. Dropping
  // the fallback would leave a response with no usage at all, and every existing
  // usage test supplies provider counts.
  const { status, text } = await call(
    usageBackendReporting({ inputTokens: 5, outputTokens: 6, source: 'estimated' }),
    '/v1/chat/completions',
    CHAT,
  );
  assert.equal(status, 200);
  const usage = JSON.parse(text).usage;
  assert.equal(usage.prompt_tokens, 5);
  assert.equal(usage.completion_tokens, 6);
  assert.equal(usage.total_tokens, 11);
});

test('/v1/responses: a streaming response reports usage in the completed event', async () => {
  // Usage was asserted only on the non-streaming Responses path; a streaming
  // client reads it from `response.completed`.
  const { status, text } = await call(
    usageBackendReporting({ inputTokens: 5, outputTokens: 6, source: 'provider' }),
    '/v1/responses',
    { model: 'a-model', input: 'hi', stream: true },
  );
  assert.equal(status, 200);
  const completed = text.split('\n')
    .filter((line) => line.startsWith('data: ') && line.includes('"response.completed"'))
    .map((line) => JSON.parse(line.slice(6)))
    .at(-1);
  assert.ok(completed, `expected a response.completed frame: ${text.slice(0, 300)}`);
  assert.equal(completed.response.usage.input_tokens, 5);
  assert.equal(completed.response.usage.output_tokens, 6);
  assert.equal(completed.response.usage.total_tokens, 11);
});

test('/v1/messages: a streaming response reports the cache tokens, not only the output count', async () => {
  // `message_start` is written before the runtime reports anything, so its
  // counts are zeros. `message_delta` is the first event that knows them, and it
  // used to carry `output_tokens` alone — leaving a streaming client with no way
  // to learn the input or cache tokens the contract lists.
  const { status, text } = await call(
    usageBackendReporting({
      inputTokens: 5, outputTokens: 6, source: 'provider',
      cacheCreationInputTokens: 7, cacheReadInputTokens: 8,
    }),
    '/v1/messages',
    { ...MESSAGES, stream: true },
  );
  assert.equal(status, 200);
  const delta = text.split('\n')
    .filter((line) => line.startsWith('data: ') && line.includes('"message_delta"'))
    .map((line) => JSON.parse(line.slice(6)))
    .at(-1);
  assert.ok(delta, `expected a message_delta frame: ${text.slice(0, 300)}`);
  assert.equal(delta.usage.output_tokens, 6);
  assert.equal(delta.usage.input_tokens, 5);
  assert.equal(delta.usage.cache_creation_input_tokens, 7);
  assert.equal(delta.usage.cache_read_input_tokens, 8);
});

test('stream_options.include_obfuscation defaults to on and is turned off explicitly', async () => {
  // Promised in the input table and named by no test, so the defaulting
  // expression could be inverted without anything failing.
  const backend = usageBackendReporting({ inputTokens: 1, outputTokens: 1, source: 'provider' });
  const withDefault = await call(backend, '/v1/chat/completions', { ...CHAT, stream: true });
  assert.match(withDefault.text, /obfuscation/, 'obfuscation is on unless turned off');

  const turnedOff = await call(backend, '/v1/chat/completions', {
    ...CHAT, stream: true, stream_options: { include_obfuscation: false },
  });
  assert.doesNotMatch(turnedOff.text, /obfuscation/, 'an explicit false must turn it off');
});
