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

// --- input parity: roles and content are validated as the direct APIs validate
// them. The permissive normalization these replace rewrote an unknown or missing
// role to `user` — a typo'd `assistantt` became a user turn with no error
// anywhere, and a client that worked here failed on the direct API.

test('an unknown role is rejected, naming the field', async () => {
  const { status, text } = await call(
    backendThat({}),
    '/v1/chat/completions',
    { model: 'a-model', messages: [{ role: 'future_role', content: 'hello' }] },
  );
  assert.equal(status, 400);
  const body = JSON.parse(text);
  assert.equal(body.error.param, 'messages[0].role');
});

test('a message with no role is rejected as missing, not defaulted', async () => {
  const { status, text } = await call(
    backendThat({}),
    '/v1/chat/completions',
    { model: 'a-model', messages: [{ content: 'hello' }] },
  );
  assert.equal(status, 400);
  const body = JSON.parse(text);
  assert.equal(body.error.code, 'missing_required_parameter');
  assert.equal(body.error.param, 'messages[0].role');
});

for (const [label, content] of [['null', null], ['a number', 42], ['a bare object', { type: 'text', text: 'x' }]]) {
  test(`chat content ${label} is rejected, as on the direct API`, async () => {
    const { status, text } = await call(
      backendThat({}),
      '/v1/chat/completions',
      { model: 'a-model', messages: [{ role: 'user', content }] },
    );
    assert.equal(status, 400, `content=${JSON.stringify(content)} must be a string or array`);
    assert.equal(JSON.parse(text).error.param, 'messages[0].content');
  });
}

test('a user message with no content is rejected as missing', async () => {
  const { status, text } = await call(
    backendThat({}),
    '/v1/chat/completions',
    { model: 'a-model', messages: [{ role: 'user' }] },
  );
  assert.equal(status, 400);
  assert.equal(JSON.parse(text).error.code, 'missing_required_parameter');
});

test('an assistant tool-call turn needs no content, as on the direct API', async () => {
  // "Required unless tool_calls or function_call is specified" — a client
  // replaying an agent conversation sends exactly this shape, so rejecting it
  // breaks every multi-turn tool loop.
  const { status } = await call(
    backendThat({}),
    '/v1/chat/completions',
    {
      model: 'a-model',
      messages: [
        { role: 'user', content: 'weather?' },
        { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'w', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: 'sunny' },
      ],
    },
  );
  assert.equal(status, 200);
});

test('an assistant message with neither content nor tool calls is rejected', async () => {
  const { status } = await call(
    backendThat({}),
    '/v1/chat/completions',
    { model: 'a-model', messages: [{ role: 'assistant' }] },
  );
  assert.equal(status, 400);
});

test('the deprecated function role is accepted and treated as a tool result', async () => {
  // Still in the direct schema; dropping it would reject histories that older
  // clients replay.
  const { status } = await call(
    backendThat({}),
    '/v1/chat/completions',
    {
      model: 'a-model',
      messages: [
        { role: 'user', content: 'weather?' },
        { role: 'function', name: 'w', content: 'sunny' },
      ],
    },
  );
  assert.equal(status, 200);
});

test('/v1/messages: a system role inside messages is rejected, naming the mistake', async () => {
  // `system` is a top-level field on the Anthropic API, not a role. Rewriting it
  // to `user` hid exactly that mistake.
  const { status, text } = await call(
    backendThat({}),
    '/v1/messages',
    { model: 'a-model', max_tokens: 16, messages: [{ role: 'system', content: 'be terse' }] },
  );
  assert.equal(status, 400);
  const body = JSON.parse(text);
  assert.equal(body.type, 'error');
  assert.match(body.error.message, /must be user or assistant/);
});

for (const [label, content] of [['null', null], ['a number', 7]]) {
  test(`/v1/messages: content ${label} is rejected`, async () => {
    const { status } = await call(
      backendThat({}),
      '/v1/messages',
      { model: 'a-model', max_tokens: 16, messages: [{ role: 'user', content }] },
    );
    assert.equal(status, 400);
  });
}

test('/v1/responses: a primitive input item is rejected', async () => {
  const { status, text } = await call(
    backendThat({}),
    '/v1/responses',
    { model: 'a-model', input: [7] },
  );
  assert.equal(status, 400);
  assert.match(JSON.parse(text).error.message, /input\[0\] must be an object/);
});

test('/v1/responses: a message item with no role is rejected, a typed item needs none', async () => {
  // Items are polymorphic: `function_call` has no role and is valid without
  // one. Only something claiming to be a message must say whose turn it is.
  const missing = await call(
    backendThat({}),
    '/v1/responses',
    { model: 'a-model', input: [{ content: 'hi' }] },
  );
  assert.equal(missing.status, 400);
  assert.equal(JSON.parse(missing.text).error.param, 'input[0].role');

  const typed = await call(
    backendThat({}),
    '/v1/responses',
    {
      model: 'a-model',
      input: [
        { role: 'user', content: 'weather?' },
        { type: 'function_call', call_id: 'c1', name: 'w', arguments: '{}' },
        { type: 'function_call_output', call_id: 'c1', output: 'sunny' },
      ],
    },
  );
  assert.equal(typed.status, 200);
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

// --- round 39: dispatch identity, surface envelopes for shared errors, and the
// gate's byte-level contract ---

import net from 'node:net';

async function rawRequest(url, lines, body = '') {
  const target = new URL(url);
  return await new Promise((resolve, reject) => {
    const conn = net.connect(Number(target.port), target.hostname, () => {
      conn.write(lines.join('\r\n') + '\r\n\r\n' + body);
    });
    let data = '';
    conn.on('data', (chunk) => { data += chunk; });
    conn.on('end', () => resolve(data));
    conn.on('error', reject);
  });
}

test('a dot-segment path is not normalized into a served endpoint', async () => {
  // `new URL().pathname` collapses `/x/../v1/chat/completions` to the real
  // endpoint, so a request the contract promises a 404 executed a completion.
  // Raw sockets, because every HTTP client normalizes before sending.
  const started = await startLocalApiProxy({
    backend: backendThat({}), host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
  });
  try {
    const body = JSON.stringify(CHAT);
    for (const path of ['/x/../v1/chat/completions', '/v1/chat/./completions']) {
      const raw = await rawRequest(started.url, [
        `POST ${path} HTTP/1.1`, 'Host: h', 'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(body)}`, 'Connection: close',
      ], body);
      assert.match(raw, /^HTTP\/1\.1 404 /, `${path} must not be routable: ${raw.slice(0, 60)}`);
    }
  } finally {
    await started.close();
  }
});

test('an unparseable request target is a 404, not a 500 thrown before the gate', async () => {
  // `//example:99999/v1/models` made the WHATWG constructor throw — a generic
  // 500 emitted before authentication ran.
  const started = await startLocalApiProxy({
    backend: backendThat({}), host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
  });
  try {
    const raw = await rawRequest(started.url, [
      'GET //example:99999/v1/models HTTP/1.1', 'Host: h', 'Connection: close',
    ]);
    assert.match(raw, /^HTTP\/1\.1 404 /, raw.slice(0, 60));
  } finally {
    await started.close();
  }
});

test('a query string does not change the endpoint', async () => {
  const started = await startLocalApiProxy({
    backend: backendThat({}), host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
  });
  try {
    const res = await fetch(`${started.url}/v1/models?probe=1`);
    assert.equal(res.status, 200);
  } finally {
    await started.close();
  }
});

test('a bare OPTIONS goes through dispatch: 404 unknown, 405 known', async () => {
  const started = await startLocalApiProxy({
    backend: backendThat({}), host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
  });
  try {
    const unknown = await fetch(`${started.url}/v1/nope`, { method: 'OPTIONS' });
    assert.equal(unknown.status, 404);
    const known = await fetch(`${started.url}/v1/chat/completions`, { method: 'OPTIONS' });
    assert.equal(known.status, 405);
  } finally {
    await started.close();
  }
});

test('wrong methods on the GET routes are 405, not unknown endpoints', async () => {
  const started = await startLocalApiProxy({
    backend: backendThat({}), host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
  });
  try {
    const post = await fetch(`${started.url}/v1/models`, { method: 'POST' });
    assert.equal(post.status, 405, 'POST /v1/models is a method problem, the path exists');
    const head = await fetch(`${started.url}/v1/models`, { method: 'HEAD' });
    assert.equal(head.status, 405);
  } finally {
    await started.close();
  }
});

test('/v1/messages: shared pre-handler errors answer in the Anthropic envelope', async () => {
  // The method rejection and the JSON-parse failure are thrown by shared code
  // with no provider; the surface, decided from the path alone, must shape them.
  const started = await startLocalApiProxy({
    backend: backendThat({}), host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
  });
  try {
    const method = await fetch(`${started.url}/v1/messages`, { method: 'GET' });
    assert.equal(method.status, 405);
    const methodBody = await method.json();
    assert.equal(methodBody.type, 'error', `expected the Anthropic shape: ${JSON.stringify(methodBody)}`);
    assert.equal(methodBody.error.type, 'invalid_request_error');
    assert.equal(methodBody.error.param, undefined);

    const parse = await fetch(`${started.url}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{',
    });
    assert.equal(parse.status, 400);
    const parseBody = await parse.json();
    assert.equal(parseBody.type, 'error', `expected the Anthropic shape: ${JSON.stringify(parseBody)}`);
  } finally {
    await started.close();
  }
});

test('a non-ASCII key sent as its UTF-8 bytes authenticates', async () => {
  // Node decodes header bytes as latin1; the gate re-encodes candidates to
  // recover the wire bytes and compares against the key's UTF-8 bytes. Raw
  // socket, because fetch refuses non-latin1 header strings.
  const key = 'k\u{1F511}';
  const started = await startLocalApiProxy({
    backend: backendThat({}), host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
    authKey: key,
  });
  const target = new URL(started.url);
  try {
    const status = await new Promise((resolve, reject) => {
      const conn = net.connect(Number(target.port), target.hostname, () => {
        conn.write(Buffer.concat([
          Buffer.from('GET /v1/models HTTP/1.1\r\nHost: h\r\nConnection: close\r\nx-api-key: '),
          Buffer.from(key, 'utf8'),
          Buffer.from('\r\n\r\n'),
        ]));
      });
      let data = '';
      conn.on('data', (chunk) => { data += chunk; });
      conn.on('end', () => resolve(data.split('\r\n')[0]));
      conn.on('error', reject);
    });
    assert.match(status, /200/, status);
  } finally {
    await started.close();
  }
});

test('/v1/responses: a non-string non-array input is rejected, omission is not', async () => {
  for (const input of [7, null, true, {}]) {
    const { status, text } = await call(backendThat({}), '/v1/responses', { model: 'a-model', input });
    assert.equal(status, 400, `input=${JSON.stringify(input)} is not a string or array`);
    assert.equal(JSON.parse(text).error.param, 'input');
  }
  const omitted = await call(backendThat({}), '/v1/responses', { model: 'a-model' });
  assert.equal(omitted.status, 200, 'omission keeps its existing behaviour');
});

test('/v1/responses: a non-string item type is rejected, an unknown string type is not', async () => {
  // `type: null` took the typed-item exemption and skipped role validation.
  // Unknown STRING types stay accepted deliberately: the direct item union
  // grows with the API, and pinning it here would 400 tomorrow's valid items.
  const bad = await call(backendThat({}), '/v1/responses', {
    model: 'a-model', input: [{ type: null, content: 'hi' }],
  });
  assert.equal(bad.status, 400);
  assert.equal(JSON.parse(bad.text).error.param, 'input[0].type');

  const unknown = await call(backendThat({}), '/v1/responses', {
    model: 'a-model', input: [{ type: 'not_yet_invented', content: 'hi' }],
  });
  assert.equal(unknown.status, 200);
});

// --- round 39 coverage: promises the inventory showed nothing pins ---

test('an assistant with the singular deprecated function_call needs no content either', async () => {
  // The exemption names tool_calls AND function_call; only tool_calls was
  // pinned, so the function_call half could be deleted unnoticed.
  const { status } = await call(
    backendThat({}),
    '/v1/chat/completions',
    {
      model: 'a-model',
      messages: [
        { role: 'user', content: 'weather?' },
        { role: 'assistant', function_call: { name: 'w', arguments: '{}' } },
        { role: 'function', name: 'w', content: 'sunny' },
      ],
    },
  );
  assert.equal(status, 200);
});

test('chat accepts nested reasoning.effort as the alternate spelling', async () => {
  // The contract names both `reasoning_effort` and `reasoning.effort` on chat;
  // only the top-level spelling was tested there.
  let seen;
  const backend = {
    name: 'test', model: 'configured-model',
    async generate(request) { seen = request.reasoningEffort; return ok(); },
    async *stream() {},
    async close() {},
  };
  const { status } = await call(backend, '/v1/chat/completions', {
    ...CHAT, reasoning: { effort: 'high' },
  });
  assert.equal(status, 200);
  assert.equal(seen, 'high', 'the nested spelling must reach the backend');
});

test('/v1/responses: a non-streaming tool call is reported as a function_call output item', async () => {
  const backend = {
    name: 'test', model: 'configured-model',
    async generate() {
      return {
        id: 'x', model: 'configured-model', text: '',
        toolCalls: [{ id: 'c1', name: 'get_weather', arguments: '{"city":"Seoul"}' }],
        usage: { inputTokens: 1, outputTokens: 1, source: 'provider' }, latencyMs: 1,
      };
    },
    async *stream() {},
    async close() {},
  };
  const { status, text } = await call(backend, '/v1/responses', { model: 'a-model', input: 'hi' });
  assert.equal(status, 200);
  const body = JSON.parse(text);
  const call_ = body.output.find((item) => item.type === 'function_call');
  assert.ok(call_, `expected a function_call item: ${JSON.stringify(body.output)}`);
  assert.equal(call_.name, 'get_weather');
  assert.equal(call_.arguments, '{"city":"Seoul"}');
  assert.ok(call_.call_id, 'a call_id is what the client replays back');
});

// --- round 40: gate byte semantics, preflight strictness, dispatch identity ---

async function rawStatusWith(authKey, payload) {
  const started = await startLocalApiProxy({
    backend: backendThat({}), host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000, authKey,
  });
  const target = new URL(started.url);
  try {
    return await new Promise((resolve, reject) => {
      const conn = net.connect(Number(target.port), target.hostname, () => conn.write(payload));
      let data = '';
      conn.on('data', (chunk) => { data += chunk; });
      conn.on('end', () => resolve(data));
      conn.on('error', reject);
    });
  } finally {
    await started.close();
  }
}

test('an empty preflight-method header does not make OPTIONS a preflight', async () => {
  // The presence check let `Access-Control-Request-Method:` (empty) take the
  // ungated 204 — an unauthenticated probe for served paths. A preflight names
  // the method it is asking about, or it is not a preflight.
  const res = await rawStatusWith('secret', Buffer.from(
    'OPTIONS /v1/nope HTTP/1.1\r\nHost: h\r\nAccess-Control-Request-Method: \r\nConnection: close\r\n\r\n',
  ));
  assert.match(res.split('\r\n')[0], /401/, res.slice(0, 40));
});

test('a Bearer key whose UTF-8 bytes end in 0xA0 authenticates', async () => {
  // U+00E0 encodes as C3 A0; latin1 decoding makes the A0 byte U+00A0, which
  // String.trim eats — the Authorization branch was still doing that after the
  // x-api-key branch was fixed, so this valid credential got 401.
  const res = await rawStatusWith('\u00e0', Buffer.concat([
    Buffer.from('GET /v1/models HTTP/1.1\r\nHost: h\r\nConnection: close\r\nAuthorization: Bearer '),
    Buffer.from('\u00e0', 'utf8'),
    Buffer.from('\r\n\r\n'),
  ]));
  assert.match(res.split('\r\n')[0], /200/, res.slice(0, 40));
});

test('a Bearer credential with a trailing 0xA0 junk byte is NOT the key', async () => {
  // The same trim, other direction: the junk byte was silently removed and a
  // WRONG credential authorized.
  const res = await rawStatusWith('secret', Buffer.concat([
    Buffer.from('GET /v1/models HTTP/1.1\r\nHost: h\r\nConnection: close\r\nAuthorization: Bearer secret'),
    Buffer.from([0xa0]),
    Buffer.from('\r\n\r\n'),
  ]));
  assert.match(res.split('\r\n')[0], /401/, res.slice(0, 40));
});

test('a latin1-range key is its UTF-8 bytes, not its latin1 byte', async () => {
  // é: UTF-8 C3 A9 must authenticate; the single latin1 byte E9 must not.
  const ok = await rawStatusWith('\u00e9', Buffer.concat([
    Buffer.from('GET /v1/models HTTP/1.1\r\nHost: h\r\nConnection: close\r\nx-api-key: '),
    Buffer.from([0xc3, 0xa9]),
    Buffer.from('\r\n\r\n'),
  ]));
  assert.match(ok.split('\r\n')[0], /200/, ok.slice(0, 40));
  const wrong = await rawStatusWith('\u00e9', Buffer.concat([
    Buffer.from('GET /v1/models HTTP/1.1\r\nHost: h\r\nConnection: close\r\nx-api-key: '),
    Buffer.from([0xe9]),
    Buffer.from('\r\n\r\n'),
  ]));
  assert.match(wrong.split('\r\n')[0], /401/, wrong.slice(0, 40));
});

test('tab-padded credentials are trimmed as OWS in both headers', async () => {
  const viaKey = await rawStatusWith('secret', Buffer.from(
    'GET /v1/models HTTP/1.1\r\nHost: h\r\nConnection: close\r\nx-api-key: \tsecret\t\r\n\r\n',
  ));
  assert.match(viaKey.split('\r\n')[0], /200/, viaKey.slice(0, 40));
  const viaBearer = await rawStatusWith('secret', Buffer.from(
    'GET /v1/models HTTP/1.1\r\nHost: h\r\nConnection: close\r\nAuthorization: Bearer\tsecret\t\r\n\r\n',
  ));
  assert.match(viaBearer.split('\r\n')[0], /200/, viaBearer.slice(0, 40));
});

test('an authKey with an unpaired surrogate is a configuration error, not a lookalike key', async () => {
  // \uD800 has no UTF-8 encoding; Buffer.from replaces it with U+FFFD, so the
  // DIFFERENT credential \uFFFD compared equal and authorized.
  const res = await rawStatusWith('\ud800', Buffer.concat([
    Buffer.from('GET /v1/models HTTP/1.1\r\nHost: h\r\nConnection: close\r\nx-api-key: '),
    Buffer.from([0xef, 0xbf, 0xbd]),
    Buffer.from('\r\n\r\n'),
  ]));
  assert.match(res.split('\r\n')[0], /500/, res.slice(0, 40));
});

test('a configuration-error response never echoes the configured key', async () => {
  const sentinel = 'SENTINEL-9c41';
  for (const path of ['/v1/models', '/v1/messages']) {
    const started = await startLocalApiProxy({
      backend: backendThat({}), host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
      authKey: ` ${sentinel} `,
    });
    try {
      const res = await fetch(`${started.url}${path}`, path === '/v1/messages'
        ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(MESSAGES) }
        : {});
      assert.equal(res.status, 500);
      const body = await res.text();
      assert.ok(!body.includes(sentinel), `the key must not be echoed: ${body.slice(0, 120)}`);
    } finally {
      await started.close();
    }
  }
});

test('case variants and encoded separators are different, unknown paths', async () => {
  const started = await startLocalApiProxy({
    backend: backendThat({}), host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
  });
  try {
    for (const path of ['/V1/MODELS', '/v1/models/', '/v1%2Fmodels']) {
      const res = await fetch(`${started.url}${path}`);
      assert.equal(res.status, 404, `${path} is not /v1/models`);
    }
  } finally {
    await started.close();
  }
});

test('the 413 limit answers /v1/messages in the Anthropic envelope', async () => {
  const started = await startLocalApiProxy({
    backend: backendThat({}), host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
  });
  try {
    const res = await fetch(`${started.url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: Buffer.alloc(50_000_001, 0x61),
    });
    assert.equal(res.status, 413);
    const body = await res.json();
    assert.equal(body.type, 'error', `expected the Anthropic shape: ${JSON.stringify(body).slice(0, 120)}`);
    assert.equal(body.error.param, undefined);
  } finally {
    await started.close();
  }
});

test('/v1/responses: an unknown role on a message item is rejected there too', async () => {
  // The chat surface pins its own unknown-role rejection; the Responses message
  // role set is narrower (no tool), and only the missing-role case was pinned.
  for (const item of [{ role: 'tool', content: 'hi' }, { type: 'message', role: 'tool', content: 'hi' }]) {
    const { status, text } = await call(backendThat({}), '/v1/responses', { model: 'a-model', input: [item] });
    assert.equal(status, 400, `role tool is not in the Responses message set: ${JSON.stringify(item)}`);
    assert.equal(JSON.parse(text).error.param, 'input[0].role');
  }
});

test('/v1/responses: instructions reach the backend as an instruction message', async () => {
  let seen;
  const backend = {
    name: 'test', model: 'configured-model',
    async generate(request) { seen = request.messages; return ok(); },
    async *stream() {},
    async close() {},
  };
  const { status } = await call(backend, '/v1/responses', {
    model: 'a-model', input: 'hi', instructions: 'Answer in French.',
  });
  assert.equal(status, 200);
  assert.ok(
    seen.some((m) => m.role === 'system' && m.content.includes('Answer in French.')),
    `instructions must be lifted into the conversation: ${JSON.stringify(seen)}`,
  );
});

// --- round 41: preflight grammar, native envelope, CONNECT, presentable keys ---

test('a preflight must name a real method: a malformed token does not bypass the gate', async () => {
  for (const bad of ['P OST', ',', '()']) {
    const res = await rawStatusWith('secret', Buffer.from(
      `OPTIONS /v1/chat/completions HTTP/1.1\r\nHost: h\r\nAccess-Control-Request-Method: ${bad}\r\nConnection: close\r\n\r\n`,
    ));
    assert.match(res.split('\r\n')[0], /401/, `${bad} is not a method name: ${res.slice(0, 40)}`);
  }
  const real = await rawStatusWith('secret', Buffer.from(
    'OPTIONS /v1/chat/completions HTTP/1.1\r\nHost: h\r\nAccess-Control-Request-Method: POST\r\nConnection: close\r\n\r\n',
  ));
  assert.match(real.split('\r\n')[0], /204/, 'a real preflight keeps its exemption');
});

test('the native sessions surface answers gate failures in its own envelope', async () => {
  // The contract gives /local/cli/sessions its own envelope for its errors;
  // the gate and configuration failures happen before its handler, but the
  // caller is still a native-surface caller.
  const started = await startLocalApiProxy({
    backend: backendThat({}), host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
    authKey: 'secret-key',
  });
  try {
    const res = await fetch(`${started.url}/local/cli/sessions`);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error.type, 'local_cli_chat_error', JSON.stringify(body));

    const authed = await fetch(`${started.url}/local/cli/sessions`, {
      headers: { 'x-api-key': 'secret-key' },
    });
    assert.notEqual(authed.status, 401, 'a valid key must pass the gate on this surface');
  } finally {
    await started.close();
  }
});

test('the sessions surface does not lose the shared gate', async () => {
  // One-line risk: an exemption for the native prefix. Root and a subpath.
  const started = await startLocalApiProxy({
    backend: backendThat({}), host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
    authKey: 'secret-key',
  });
  try {
    for (const path of ['/local/cli/sessions', '/local/cli/sessions/some-id/turns']) {
      const res = await fetch(`${started.url}${path}`, { method: 'POST' });
      assert.equal(res.status, 401, `${path} must be gated`);
    }
  } finally {
    await started.close();
  }
});

test('CONNECT receives an HTTP 405, not a dead socket', async () => {
  const started = await startLocalApiProxy({
    backend: backendThat({}), host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
  });
  const target = new URL(started.url);
  try {
    const res = await new Promise((resolve, reject) => {
      const conn = net.connect(Number(target.port), target.hostname, () => {
        conn.write('CONNECT example.com:443 HTTP/1.1\r\nHost: h\r\n\r\n');
      });
      let data = '';
      conn.on('data', (chunk) => { data += chunk; });
      conn.on('end', () => resolve(data));
      conn.on('error', reject);
      setTimeout(() => { conn.destroy(); resolve(data || 'NO RESPONSE'); }, 3000);
    });
    assert.match(res.split('\r\n')[0], /405/, `expected an HTTP answer: ${res.slice(0, 40)}`);
  } finally {
    await started.close();
  }
});

test('an authKey with a control byte is a configuration error, not an unpresentable key', async () => {
  // Node's parser rejects a header carrying the byte before the gate could see
  // it, so the key passes configuration and can never authenticate anyone.
  const started = await startLocalApiProxy({
    backend: backendThat({}), host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
    authKey: `a${String.fromCharCode(0)}b`,
  });
  try {
    const res = await fetch(`${started.url}/v1/models`);
    assert.equal(res.status, 500);
    // The SPECIFIC cause is operator-only; the response carries one fixed
    // sentence for every configuration-error class.
    assert.match((await res.json()).error.message, /access gate is misconfigured/);
  } finally {
    await started.close();
  }
});

test('every response carries the static CORS policy, success and error alike', async () => {
  const started = await startLocalApiProxy({
    backend: backendThat({}), host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
  });
  try {
    const okRes = await fetch(`${started.url}/v1/models`);
    const errRes = await fetch(`${started.url}/v1/nope`);
    for (const [label, res] of [['success', okRes], ['error', errRes]]) {
      assert.equal(res.headers.get('access-control-allow-origin'), '*', `${label} must carry the wildcard`);
      assert.match(res.headers.get('access-control-allow-methods') ?? '', /POST/, label);
      assert.match(res.headers.get('access-control-allow-headers') ?? '', /x-api-key/, label);
    }
  } finally {
    await started.close();
  }
});

for (const [path, body, readUsage] of [
  ['/v1/responses', { model: 'a-model', input: 'hi' },
    (b) => [b.usage.input_tokens, b.usage.output_tokens, b.usage.total_tokens]],
  ['/v1/messages', { model: 'a-model', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] },
    (b) => [b.usage.input_tokens, b.usage.output_tokens, undefined]],
]) {
  test(`${path}: estimated usage is reported when the runtime reports none`, async () => {
    // The chat surface pins this fallback; these two did not, so a
    // provider-only usage mapper would silently drop their counts.
    const { status, text } = await call(
      usageBackendReporting({ inputTokens: 5, outputTokens: 6, source: 'estimated' }),
      path,
      body,
    );
    assert.equal(status, 200);
    const [input, output, total] = readUsage(JSON.parse(text));
    assert.equal(input, 5);
    assert.equal(output, 6);
    if (total !== undefined) assert.equal(total, 11);
  });
}

// --- round 42: native envelope completeness, output-control validation ---

test('a provider-mapped error on the native surface keeps its status but wears the native envelope', async () => {
  // The mapped 429 is still a 429; the ENVELOPE belongs to the caller's
  // surface — this branch was falling through to the OpenAI writer.
  const started = await startLocalApiProxy({
    backend: backendThat({}), host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
    chatSessionManager: {
      async create() {
        throw new Error(JSON.stringify({
          status: 429,
          error: { type: 'rate_limit_error', message: 'slow down', code: 'rate_limit' },
        }));
      },
      async closeAll() {},
    },
  });
  try {
    const res = await fetch(`${started.url}/local/cli/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(res.status, 429, 'the mapped status survives');
    const body = await res.json();
    assert.equal(body.error.type, 'local_cli_chat_error', JSON.stringify(body));
    assert.match(body.error.message, /slow down/);
  } finally {
    await started.close();
  }
});

test('the native surface reports a configuration error in its own envelope', async () => {
  const started = await startLocalApiProxy({
    backend: backendThat({}), host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
    authKey: ' broken ',
  });
  try {
    const res = await fetch(`${started.url}/local/cli/sessions`);
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.error.type, 'local_cli_chat_error', JSON.stringify(body));
    assert.match(body.error.message, /access gate is misconfigured/);
  } finally {
    await started.close();
  }
});

test('every authKey configuration mistake gets the same fixed public sentence', async () => {
  // Which class of mistake was made is configuration state; an unauthenticated
  // caller has no business learning it.
  const keys = ['', ' pad ', '\ud800', `x${String.fromCharCode(31)}`, `x${String.fromCharCode(127)}`];
  const seen = new Set();
  for (const authKey of keys) {
    const started = await startLocalApiProxy({
      backend: backendThat({}), host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000, authKey,
    });
    try {
      const res = await fetch(`${started.url}/v1/models`);
      assert.equal(res.status, 500, `key ${JSON.stringify(authKey)} must be a configuration error`);
      seen.add((await res.json()).error.message);
    } finally {
      await started.close();
    }
  }
  assert.equal(seen.size, 1, `one sentence for every class: ${[...seen].join(' | ')}`);
});

test('a legal but unusual preflight method token still gets its 204', async () => {
  // The exemption is grammar-based, not an allow-list: PATCH names a method.
  const res = await rawStatusWith('secret', Buffer.from(
    'OPTIONS /v1/nope HTTP/1.1\r\nHost: h\r\nAccess-Control-Request-Method: PATCH\r\nConnection: close\r\n\r\n',
  ));
  assert.match(res.split('\r\n')[0], /204/, res.slice(0, 40));
});

test('/v1/messages: thinking and output_config are validated at the HTTP boundary', async () => {
  const base = { model: 'a-model', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] };
  for (const [label, extra] of [
    ['an invalid thinking.display', { thinking: { type: 'adaptive', display: 'raw' } }],
    ['an invalid effort', { output_config: { effort: 'extreme' } }],
    ['a scalar format', { output_config: { format: 'json_schema' } }],
    ['an undersized task_budget', { output_config: { task_budget: { type: 'tokens', total: 10 } } }],
  ]) {
    const { status, text } = await call(backendThat({}), '/v1/messages', { ...base, ...extra });
    assert.equal(status, 400, `${label} must be rejected`);
    const body = JSON.parse(text);
    assert.equal(body.type, 'error', `${label} must use the Anthropic envelope`);
  }
  const okDisplay = await call(backendThat({}), '/v1/messages', {
    ...base, thinking: { type: 'adaptive', display: 'omitted' },
  });
  assert.equal(okDisplay.status, 200, 'a valid display stays valid');
  const droppedUnderDisabled = await call(backendThat({}), '/v1/messages', {
    ...base, thinking: { type: 'disabled', display: 'summarized' },
  });
  assert.equal(droppedUnderDisabled.status, 200, 'a VALID display under disabled is dropped, not rejected');
});

test('chat system and developer messages reach the backend conversation', async () => {
  let seen;
  const backend = {
    name: 'test', model: 'configured-model',
    async generate(request) { seen = request.messages; return ok(); },
    async *stream() {},
    async close() {},
  };
  const { status } = await call(backend, '/v1/chat/completions', {
    model: 'a-model',
    messages: [
      { role: 'system', content: 'Be terse.' },
      { role: 'developer', content: 'Answer in French.' },
      { role: 'user', content: 'hi' },
    ],
  });
  assert.equal(status, 200);
  assert.ok(seen.some((m) => m.role === 'system' && m.content.includes('Be terse.')), JSON.stringify(seen));
  assert.ok(seen.some((m) => m.role === 'developer' && m.content.includes('Answer in French.')), JSON.stringify(seen));
});

// --- round 43: null holes, disconnect aborts, termination passthrough ---

// LEAVES declared nullable on the direct API treat null as omission; the
// CONTAINERS are not nullable and reject it. Both directions were wrong at
// some point: the leaves briefly rejected null (anti-parity, measured against
// the published SDK types), and the containers silently accepted it.
for (const [label, body] of [
  ['thinking.display null (adaptive)', { thinking: { type: 'adaptive', display: null } }],
  ['thinking.display null under disabled', { thinking: { type: 'disabled', display: null } }],
  ['output_config.format null', { output_config: { format: null } }],
  ['output_config.task_budget null', { output_config: { task_budget: null } }],
]) {
  test(`/v1/messages: ${label} is omission — the leaf is nullable`, async () => {
    const base = { model: 'a-model', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] };
    const { status } = await call(backendThat({}), '/v1/messages', { ...base, ...body });
    assert.equal(status, 200, `${label} is declared nullable on the direct API`);
  });
}

for (const [label, body] of [
  ['thinking: null', { thinking: null }],
  ['thinking: a string', { thinking: 'adaptive' }],
  ['output_config: null', { output_config: null }],
  ['output_config: a string', { output_config: 'json' }],
]) {
  test(`/v1/messages: container ${label} is rejected — the container is not nullable`, async () => {
    const base = { model: 'a-model', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] };
    const { status, text } = await call(backendThat({}), '/v1/messages', { ...base, ...body });
    assert.equal(status, 400, `${label} must be rejected`);
    assert.equal(JSON.parse(text).type, 'error');
  });
}

test('/v1/messages: enabled thinking requires budget_tokens in its direct domain', async () => {
  const base = { model: 'a-model', max_tokens: 4096, messages: [{ role: 'user', content: 'hi' }] };
  for (const [label, thinking, expected] of [
    ['missing budget', { type: 'enabled' }, 400],
    ['non-integer budget', { type: 'enabled', budget_tokens: 'lots' }, 400],
    ['budget below 1024', { type: 'enabled', budget_tokens: 512 }, 400],
    ['budget not below max_tokens', { type: 'enabled', budget_tokens: 4096 }, 400],
    ['a valid budget', { type: 'enabled', budget_tokens: 2048 }, 200],
  ]) {
    const { status } = await call(backendThat({}), '/v1/messages', { ...base, thinking });
    assert.equal(status, expected, `${label}: expected ${expected}`);
  }
});

test('a client disconnect aborts the backend turn, freeing a serialized backend', async () => {
  // The promise existed; the wiring covered only honor-on prefetch. On a
  // serialized backend an abandoned turn kept its slot until the timeout and
  // the NEXT client paid for it.
  let firstAborted = false;
  let running = null;
  const backend = {
    name: 'test', model: 'configured-model',
    async generate(request, signal) {
      if (request.messages.some((m) => m.content.includes('hang'))) {
        running = new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => { firstAborted = true; reject(new Error('aborted')); }, { once: true });
        });
        await running;
      }
      return ok();
    },
    async *stream() {},
    async close() {},
  };
  const started = await startLocalApiProxy({
    backend, host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
  });
  try {
    const controller = new AbortController();
    const hung = fetch(`${started.url}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'a-model', messages: [{ role: 'user', content: 'hang' }] }),
      signal: controller.signal,
    }).catch(() => null);
    // Let the turn start, then walk away.
    await new Promise((r) => setTimeout(r, 150));
    controller.abort();
    await hung;
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(firstAborted, true, 'the abandoned turn must be aborted, not left to the timeout');
  } finally {
    await started.close();
  }
});

test('a mid-stream disconnect aborts the turn in default (honor-off) mode too', async () => {
  let aborted = false;
  const backend = {
    name: 'test', model: 'configured-model',
    async generate() { return ok(); },
    async *stream(request, signal) {
      yield { type: 'text_delta', delta: 'first chunk' };
      await new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true });
      });
    },
    async close() {},
  };
  const started = await startLocalApiProxy({
    backend, host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
  });
  try {
    const controller = new AbortController();
    const res = await fetch(`${started.url}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'a-model', messages: [{ role: 'user', content: 'hi' }], stream: true }),
      signal: controller.signal,
    });
    const reader = res.body.getReader();
    await reader.read();
    controller.abort();
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(aborted, true, 'the stream turn must see the abort after the client leaves');
  } finally {
    await started.close();
  }
});

test('/v1/messages: pause_turn passes through, streaming and not', async () => {
  const paused = () => ({
    id: 'x', model: 'configured-model', text: 'partial', toolCalls: [],
    usage: { inputTokens: 1, outputTokens: 1, source: 'provider' }, latencyMs: 1,
    stopReason: 'pause_turn',
  });
  const backend = {
    name: 'test', model: 'configured-model',
    async generate() { return paused(); },
    async *stream() { yield { type: 'completed', result: paused() }; },
    async close() {},
  };
  const plain = await call(backend, '/v1/messages', MESSAGES);
  assert.equal(JSON.parse(plain.text).stop_reason, 'pause_turn');

  const streamed = await call(backend, '/v1/messages', { ...MESSAGES, stream: true });
  const delta = streamed.text.split('\n')
    .filter((l) => l.startsWith('data: ') && l.includes('"message_delta"'))
    .map((l) => JSON.parse(l.slice(6)))
    .at(-1);
  assert.equal(delta.delta.stop_reason, 'pause_turn', JSON.stringify(delta));
});

for (const [path, body, isAnthropic] of [
  ['/v1/chat/completions', CHAT, false],
  ['/v1/responses', { model: 'a-model', input: 'hi' }, false],
  ['/v1/messages', MESSAGES, true],
]) {
  test(`${path}: a non-streaming timeout is an HTTP error in the surface envelope`, async () => {
    const backend = {
      name: 'test', model: 'configured-model',
      async generate(request, signal) {
        await new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('timed out')), { once: true });
        });
      },
      async *stream() {},
      async close() {},
    };
    const started = await startLocalApiProxy({
      backend, host: '127.0.0.1', port: 0, requestTimeoutMs: 250,
    });
    try {
      const res = await fetch(`${started.url}${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      assert.ok(res.status >= 500, `a timeout before any byte is an HTTP error, got ${res.status}`);
      const payload = await res.json();
      if (isAnthropic) assert.equal(payload.type, 'error', JSON.stringify(payload));
      else assert.ok(payload.error, JSON.stringify(payload));
    } finally {
      await started.close();
    }
  });
}

// --- round 44 coverage: per-surface disconnects, stream timeouts, synthesis ---

for (const [path, body] of [
  ['/v1/responses', { model: 'a-model', input: 'hang' }],
  ['/v1/messages', { model: 'a-model', max_tokens: 16, messages: [{ role: 'user', content: 'hang' }] }],
]) {
  test(`${path}: a non-streaming disconnect aborts the backend turn`, async () => {
    let aborted = false;
    const backend = {
      name: 'test', model: 'configured-model',
      async generate(request, signal) {
        await new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true });
        });
      },
      async *stream() {},
      async close() {},
    };
    const started = await startLocalApiProxy({
      backend, host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
    });
    try {
      const controller = new AbortController();
      const pending = fetch(`${started.url}${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body), signal: controller.signal,
      }).catch(() => null);
      await new Promise((r) => setTimeout(r, 150));
      controller.abort();
      await pending;
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(aborted, true, 'the abandoned turn must see the abort');
    } finally {
      await started.close();
    }
  });
}

for (const [path, body, isAnthropic] of [
  ['/v1/chat/completions', { model: 'a-model', messages: [{ role: 'user', content: 'hi' }], stream: true }, false],
  ['/v1/responses', { model: 'a-model', input: 'hi', stream: true }, false],
  ['/v1/messages', { model: 'a-model', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }], stream: true }, true],
]) {
  test(`${path}: a mid-stream timeout lands as the surface's terminal sequence`, async () => {
    const backend = {
      name: 'test', model: 'configured-model',
      async generate() { return ok(); },
      async *stream(request, signal) {
        yield { type: 'text_delta', delta: 'first' };
        await new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('timed out')), { once: true });
        });
      },
      async close() {},
    };
    const started = await startLocalApiProxy({
      backend, host: '127.0.0.1', port: 0, requestTimeoutMs: 300,
    });
    try {
      const res = await fetch(`${started.url}${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      assert.equal(res.status, 200, 'the stream was committed before the timer fired');
      const text = await res.text();
      if (isAnthropic) {
        assert.match(text, /event: error/, text.slice(-200));
        assert.doesNotMatch(text, /message_stop/, 'a timed-out turn did not finish normally');
      } else {
        const frames = text.split('\n\n').map((b) => b.trim()).filter(Boolean);
        assert.equal(frames.at(-1), 'data: [DONE]', frames.at(-1));
        assert.ok(frames.some((f) => f.includes('"error"')), text.slice(-200));
      }
    } finally {
      await started.close();
    }
  });
}

test('/v1/messages: a refusal without runtime details gets the synthesized stop_details', async () => {
  const refusal = () => ({
    id: 'x', model: 'configured-model', text: '', toolCalls: [],
    usage: { inputTokens: 1, outputTokens: 1, source: 'provider' }, latencyMs: 1,
    stopReason: 'refusal',
  });
  const backend = {
    name: 'test', model: 'configured-model',
    async generate() { return refusal(); },
    async *stream() { yield { type: 'completed', result: refusal() }; },
    async close() {},
  };
  const plain = JSON.parse((await call(backend, '/v1/messages', MESSAGES)).text);
  assert.equal(plain.stop_reason, 'refusal');
  assert.deepEqual(plain.stop_details, { type: 'refusal', category: null });

  const streamed = (await call(backend, '/v1/messages', { ...MESSAGES, stream: true })).text;
  const delta = streamed.split('\n')
    .filter((l) => l.startsWith('data: ') && l.includes('"message_delta"'))
    .map((l) => JSON.parse(l.slice(6))).at(-1);
  assert.deepEqual(delta.delta.stop_details, { type: 'refusal', category: null });
});
