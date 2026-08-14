import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startLocalApiProxy } from '../dist/proxy/http-server.js';
import { BACKEND_IDENTIFIERS } from '../dist/proxy/types.js';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { after } from 'node:test';

// What `GET /v1/models` advertises is part of the documented contract, and the
// contract previously described it wrongly. Pin the actual value.
function backendWith(model) {
  return {
    name: 'test', model,
    async generate() {
      return { id: 'x', model, text: 'OK', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, source: 'estimated' }, latencyMs: 1 };
    },
    async close() {},
  };
}

async function modelsFor(model) {
  const started = await startLocalApiProxy({
    backend: backendWith(model),
    host: '127.0.0.1',
    port: 0,
    requestTimeoutMs: 30_000,
  });
  try {
    const res = await fetch(`${started.url}/v1/models`);
    const payload = await res.json();
    // An empty `data` is a documented answer here, so the status and envelope
    // have to be checked too: an error body that happens to serialize an empty
    // array would otherwise satisfy every empty-list assertion below.
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(payload)}`);
    assert.equal(payload.object, 'list');
    return payload;
  } finally {
    await started.close();
  }
}

test('GET /v1/models returns the configured model, not the backend alias', async () => {
  const payload = await modelsFor('claude-opus-4-8');
  assert.equal(payload.object, 'list');
  assert.deepEqual(payload.data.map((m) => m.id), ['claude-opus-4-8']);
  assert.equal(payload.data[0].object, 'model');
});

// The transport names that must never be advertised as models. Pinned as a
// literal so that narrowing the production list fails here instead of silently
// narrowing what the loops below cover — and compared against the production
// constant so that GROWING it fails too. Without that comparison, adding a
// genuinely selectable name (`fable`) to the production list would drop it from
// every `/v1/models` response while every test here stayed green.
const PINNED_IDENTIFIERS = ['codex-app-server', 'codex-backend', 'claude-code-cli'];

test('the pinned identifier list is exactly the production one', () => {
  assert.deepEqual([...BACKEND_IDENTIFIERS], PINNED_IDENTIFIERS);
});

for (const identifier of PINNED_IDENTIFIERS) {
  test(`GET /v1/models never advertises the backend identifier ${identifier}`, async () => {
    // An identifier names a transport, not a model a client can select, so it
    // is never offered as a choice. What a request naming one actually gets is
    // the runtime's business and depends on the honouring switch.
    const payload = await modelsFor(identifier);
    assert.deepEqual(payload.data.map((m) => m.id), []);
  });
}

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const trees = [];

after(async () => {
  await Promise.all(trees.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

// With honouring on, `GET /v1/models` advertises what the runtime says it can
// run, so a new model generation shows up without a code change. With it off the
// request model is not the proxy's choice to offer, so alternatives are not
// advertised — what an off-mode request model actually does is per-runtime.
async function modelsWithSetting(honorRequestModel, listed, backendModel = 'configured-model') {
  const root = await mkdtemp(join(tmpdir(), 'models-endpoint-'));
  trees.push(root);
  await cp(join(repoRoot, 'dist'), join(root, 'dist'), { recursive: true });
  const settings = JSON.parse(await readFile(join(repoRoot, 'settings.json'), 'utf8'));
  await writeFile(
    join(root, 'settings.json'),
    `${JSON.stringify({ ...settings, modelSelection: { honorRequestModel } }, null, 2)}\n`,
  );
  const scriptPath = join(root, 'probe.mjs');
  await writeFile(scriptPath, `
    import { startLocalApiProxy } from ${JSON.stringify(join(root, 'dist/proxy/http-server.js'))};
    const backend = {
      name: 'test', model: ${JSON.stringify(backendModel)},
      async availableModels() { return ${JSON.stringify(listed)}; },
      async generate() { return { id: 'x', model: ${JSON.stringify(backendModel)}, text: 'OK', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, source: 'estimated' }, latencyMs: 1 }; },
      async close() {},
    };
    const started = await startLocalApiProxy({ backend, host: '127.0.0.1', port: 0, requestTimeoutMs: 30000 });
    const res = await fetch(started.url + '/v1/models');
    process.stdout.write(JSON.stringify({ status: res.status, payload: await res.json() }));
    await started.close();
  `);
  const { stdout } = await execFileAsync(process.execPath, [scriptPath], { cwd: root });
  const { status, payload } = JSON.parse(stdout);
  assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(payload)}`);
  assert.equal(payload.object, 'list');
  return payload;
}

test('honour-on: the runtime catalogue is advertised, configured model first', async () => {
  const payload = await modelsWithSetting(true, ['gpt-5.6-sol', 'configured-model', 'gpt-5.6-terra']);
  assert.deepEqual(payload.data.map((m) => m.id), ['configured-model', 'gpt-5.6-sol', 'gpt-5.6-terra']);
});

// Not "the executed model": with honouring off `codex-backend` runs the request
// model while the list still shows what is configured. The list is about
// configuration, not about what any particular request will run.
test('honour-off: only the configured model is advertised', async () => {
  const payload = await modelsWithSetting(false, ['gpt-5.6-sol', 'gpt-5.6-terra']);
  assert.deepEqual(payload.data.map((m) => m.id), ['configured-model']);
});

test('a runtime that cannot enumerate falls back to its single model', async () => {
  const payload = await modelsWithSetting(true, null);
  assert.deepEqual(payload.data.map((m) => m.id), ['configured-model']);
});

for (const identifier of PINNED_IDENTIFIERS) {
  // The identifier can reach the list from two independent places, and they are
  // kept in separate tests on purpose. Exercising both at once lets a filter
  // that only de-duplicates against `backend.model` look like identifier
  // filtering: the listed copy would vanish merely for equalling the configured
  // one. Each position has to fail on its own.
  test(`honour-on: ${identifier} listed by the runtime is filtered out`, async () => {
    const payload = await modelsWithSetting(
      true,
      ['gpt-5.6-sol', identifier, 'gpt-5.6-terra'],
      'configured-model',
    );
    assert.deepEqual(payload.data.map((m) => m.id), ['configured-model', 'gpt-5.6-sol', 'gpt-5.6-terra']);
  });

  test(`honour-on: ${identifier} as the backend's own model is not listed first`, async () => {
    const payload = await modelsWithSetting(true, ['gpt-5.6-sol', 'gpt-5.6-terra'], identifier);
    assert.deepEqual(payload.data.map((m) => m.id), ['gpt-5.6-sol', 'gpt-5.6-terra']);
  });

  test(`honour-on with nothing to advertise: ${identifier} yields an empty list`, async () => {
    // The documented consequence of "an identifier is not a selectable model":
    // with no configured model and no runtime catalogue there is nothing to
    // advertise, so the answer is an empty list rather than a transport name.
    const payload = await modelsWithSetting(true, null, identifier);
    assert.deepEqual(payload.data.map((m) => m.id), []);
  });
}
