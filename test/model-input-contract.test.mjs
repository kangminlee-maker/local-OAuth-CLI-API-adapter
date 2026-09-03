import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startLocalApiProxy } from '../dist/proxy/http-server.js';

// `model` is required on every provider surface. The proxy's input contract must
// match theirs: a body a direct API rejects must not quietly succeed here by
// having a default substituted for it.
function backend() {
  return {
    name: 'test', model: 'configured-model',
    async generate() {
      return { id: 'x', model: 'configured-model', text: 'OK', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, source: 'estimated' }, latencyMs: 1 };
    },
    async close() {},
  };
}

async function post(path, body) {
  const started = await startLocalApiProxy({ backend: backend(), host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000 });
  try {
    const res = await fetch(`${started.url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, payload: await res.json() };
  } finally {
    await started.close();
  }
}

const SURFACES = [
  ['/v1/chat/completions', { messages: [{ role: 'user', content: 'hi' }] }, 'openai'],
  ['/v1/responses', { input: 'hi' }, 'openai'],
  ['/v1/messages', { max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }, 'anthropic'],
];

for (const [path, base, provider] of SURFACES) {
  test(`${path}: an omitted model is a 400, not a substituted default`, async () => {
    const { status, payload } = await post(path, base);
    assert.equal(status, 400);
    if (provider === 'anthropic') {
      assert.equal(payload.type, 'error');
      assert.equal(payload.error.type, 'invalid_request_error');
    } else if (path === '/v1/chat/completions') {
      // Chat answers an absent model with neither `param` nor `code`
      // (measured 2026-08-30); Responses names the parameter.
      assert.equal(payload.error.type, 'invalid_request_error');
      assert.equal(payload.error.param, null);
      assert.equal(payload.error.message, 'you must provide a model parameter');
    } else {
      assert.equal(payload.error.type, 'invalid_request_error');
      assert.equal(payload.error.param, 'model');
    }
  });

  // A blank model is refused everywhere; the SHAPE of the refusal is the
  // surface's own. Chat and Anthropic read it as an absent model (400);
  // Responses reads it as a model that does not exist and answers 404 with no
  // `param`, exactly as it answers an unknown name (measured 2026-09-03).
  const blankModelStatus = path === '/v1/responses' ? 404 : 400;

  test(`${path}: an empty model is refused`, async () => {
    const { status } = await post(path, { ...base, model: '' });
    assert.equal(status, blankModelStatus);
  });

  test(`${path}: a whitespace-only model is refused`, async () => {
    const { status } = await post(path, { ...base, model: '   ' });
    assert.equal(status, blankModelStatus);
  });

  test(`${path}: a non-string model is a 400`, async () => {
    const { status } = await post(path, { ...base, model: 123 });
    assert.equal(status, 400);
  });

  test(`${path}: a real model name is accepted`, async () => {
    const { status } = await post(path, { ...base, model: 'configured-model' });
    assert.equal(status, 200);
  });
}
