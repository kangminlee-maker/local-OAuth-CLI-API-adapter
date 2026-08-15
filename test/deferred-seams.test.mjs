import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { startLocalApiProxy } from '../dist/proxy/http-server.js';
import { CodexAppServerBackend } from '../dist/proxy/codex-app-server-backend.js';
import { CodexBackendTransport } from '../dist/proxy/codex-backend-transport.js';
import { LocalCliChatSessionManager } from '../dist/chat/session-manager.js';
import { gradientFlatIconPngBase64, uniqueOpaqueColorCount, tinyPngBase64 } from './fixtures/flat-png.mjs';

// The three seams every review round deferred: each promise was tested BELOW
// its seam (helpers, builders, units) while the production composition above it
// went unpinned. These traverse the real composition.

const here = dirname(fileURLToPath(import.meta.url));
const fakeCodex = resolve(here, 'fixtures/fake-codex.cjs');

test('a native session turn survives its client disconnecting', async () => {
  // The provider surfaces abort on disconnect; the native surface must NOT —
  // its turns belong to the session, which survives the socket, and the
  // interrupt endpoint is the only cancellation. One listener wired to
  // res.close would break this silently.
  let interrupted = 0;
  let releaseGate;
  const gate = new Promise((r) => { releaseGate = r; });
  const chatSessionManager = new LocalCliChatSessionManager({
    defaultCwd: process.cwd(),
    runtimes: {
      codex: async () => ({
        runtime: 'codex',
        native: { thread_id: 'thread_hold' },
        async *startTurn(turn) {
          const text = typeof turn.input === 'string' ? turn.input : 'x';
          yield { raw: { method: 'item/agentMessage/delta', params: { delta: text } }, textDelta: text };
          if (text === 'hold') await gate;
          yield { raw: { method: 'thread/tokenUsage/updated', params: {} }, usage: { totalTokens: 1 } };
        },
        async interrupt() { interrupted += 1; },
        async close() {},
      }),
    },
  });
  const started = await startLocalApiProxy({
    host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000, chatSessionManager,
    backend: {
      name: 'unused', model: 'unused',
      async generate() { throw new Error('unused'); },
      async close() {},
    },
  });
  try {
    const created = await fetch(`${started.url}/local/cli/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runtime: 'codex' }),
    });
    const session = await created.json();
    assert.ok(session.id, JSON.stringify(session));

    const controller = new AbortController();
    const turn = await fetch(`${started.url}/local/cli/sessions/${session.id}/turns`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'hold', stream: true }),
      signal: controller.signal,
    });
    const reader = turn.body.getReader();
    await reader.read();
    controller.abort();
    await new Promise((r) => setTimeout(r, 200));

    assert.equal(interrupted, 0, 'a disconnect must not become an implicit interrupt');

    // The abandoned turn is still RUNNING — the strongest proof the socket did
    // not cancel it: a second turn is refused as concurrent.
    const concurrent = await fetch(`${started.url}/local/cli/sessions/${session.id}/turns`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'again', stream: false }),
    });
    assert.equal(concurrent.status, 409, await concurrent.clone().text());

    // The documented cancellation is the interrupt endpoint, and only it.
    const stop = await fetch(`${started.url}/local/cli/sessions/${session.id}/interrupt`, { method: 'POST' });
    assert.equal(stop.status, 200, await stop.clone().text());
    assert.equal(interrupted, 1, 'the explicit interrupt reaches the runtime');
    releaseGate();
    await new Promise((r) => setTimeout(r, 100));

    const inspected = await fetch(`${started.url}/local/cli/sessions/${session.id}`);
    assert.equal(inspected.status, 200, 'the session survives it all');
  } finally {
    await started.close();
  }
});

test('flat/vector postprocessing crosses the HTTP seam', async () => {
  // The postprocessor's unit tests pass with the production wiring deleted;
  // this pins the wiring: a qualifying reference-style edit through the real
  // HTTP path returns FLATTENED bytes, not the backend's gradient.
  const codexHome = await mkdtemp(join(tmpdir(), 'codex-flat-home-'));
  await writeFile(join(codexHome, 'auth.json'), JSON.stringify({
    tokens: { access_token: 'local-test-token', account_id: 'local-test-account' },
  }));
  const gradient = gradientFlatIconPngBase64();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    [
      `data: ${JSON.stringify({ type: 'response.created', response: { id: 'r1', model: 'gpt-5.5' } })}`,
      `data: ${JSON.stringify({
        type: 'response.output_item.done', output_index: 0,
        item: { type: 'image_generation_call', id: 'ig_1', status: 'completed', result: gradient },
      })}`,
      `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'r1', model: 'gpt-5.5' } })}`,
      'data: [DONE]', '',
    ].join('\n\n'),
    { status: 200 },
  );
  try {
    const imageClient = new CodexBackendTransport({ codexHome, timeoutMs: 30_000, model: 'gpt-5.5' });
    const started = await startLocalApiProxy({
      backend: imageClient, imageGenerationClient: imageClient,
      host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
    });
    try {
      const res = await originalFetch(`${started.url}/v1/images/edits`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'image-2',
          prompt: 'Use the attached style reference image to create a new flat vector icon. No text.',
          image: `data:image/png;base64,${tinyPngBase64()}`,
          output_format: 'png',
        }),
      });
      assert.equal(res.status, 200, await res.clone().text());
      const payload = await res.json();
      const returned = payload.data[0].b64_json;
      assert.notEqual(returned, gradient, 'the gradient must not pass through untouched');
      assert.ok(
        uniqueOpaqueColorCount(returned) < uniqueOpaqueColorCount(gradient),
        'the returned bytes must be the flattened output',
      );
    } finally {
      await started.close();
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('ambient project context cannot reach a proxied HTTP completion', async () => {
  // The isolation helpers have their own tests; this pins the COMPOSITION: the
  // thread the CLI actually runs must live in the isolated temp workspace, not
  // the directory the operator launched from, and the sentinel there must be
  // invisible.
  const ambient = await mkdtemp(join(tmpdir(), 'ambient-project-'));
  await writeFile(join(ambient, 'AGENTS.md'), 'AMBIENT-SENTINEL-77\n');
  const codexHome = await mkdtemp(join(tmpdir(), 'codex-ambient-home-'));
  await writeFile(join(codexHome, 'auth.json'), '{"token":"local"}\n');
  await writeFile(join(codexHome, 'config.toml'), 'model = "gpt-test-model"\n');
  const previousHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  try {
    const backend = new CodexAppServerBackend({
      command: fakeCodex, cwd: ambient, timeoutMs: 30_000,
    });
    const started = await startLocalApiProxy({
      backend, host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
    });
    try {
      const res = await fetch(`${started.url}/v1/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'codex-app-server', messages: [{ role: 'user', content: 'DEBUG_PAYLOAD' }] }),
      });
      assert.equal(res.status, 200, await res.clone().text());
      const text = (await res.json()).choices[0].message.content;
      const payload = JSON.parse(text);
      assert.ok(payload.threadCwd, `the fixture must report the thread cwd: ${text.slice(0, 200)}`);
      assert.notEqual(payload.threadCwd, ambient, 'the thread must not run in the ambient directory');
      assert.match(payload.threadCwd, /local-oauth-cli-codex-proxy-/, 'the isolated temp workspace runs the thread');
      assert.ok(
        !(payload.threadCwdFiles ?? []).includes('AGENTS.md'),
        `the sentinel must be invisible: ${JSON.stringify(payload.threadCwdFiles)}`,
      );
    } finally {
      await started.close();
    }
  } finally {
    process.env.CODEX_HOME = previousHome;
    await new Promise((r) => setTimeout(r, 50));
  }
});
