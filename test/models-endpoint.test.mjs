import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startLocalApiProxy } from '../dist/proxy/http-server.js';
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
    return await res.json();
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

// Every value the proxy would reject as a model. Kept as a literal list rather
// than imported from the source so that dropping one from BACKEND_IDENTIFIERS
// fails here instead of silently narrowing what both sides check.
const BACKEND_IDENTIFIERS = ['codex-app-server', 'codex-backend', 'claude-code-cli'];

for (const identifier of BACKEND_IDENTIFIERS) {
  test(`GET /v1/models never advertises the backend identifier ${identifier}`, async () => {
    // Advertising it would hand clients a value the proxy now rejects.
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
// request model selects nothing, so advertising alternatives would invite a
// choice the proxy ignores.
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
    process.stdout.write(JSON.stringify(await res.json()));
    await started.close();
  `);
  const { stdout } = await execFileAsync(process.execPath, [scriptPath], { cwd: root });
  return JSON.parse(stdout);
}

test('honour-on: the runtime catalogue is advertised, configured model first', async () => {
  const payload = await modelsWithSetting(true, ['gpt-5.6-sol', 'configured-model', 'gpt-5.6-terra']);
  assert.deepEqual(payload.data.map((m) => m.id), ['configured-model', 'gpt-5.6-sol', 'gpt-5.6-terra']);
});

test('honour-off: only the executed model is advertised', async () => {
  const payload = await modelsWithSetting(false, ['gpt-5.6-sol', 'gpt-5.6-terra']);
  assert.deepEqual(payload.data.map((m) => m.id), ['configured-model']);
});

test('a runtime that cannot enumerate falls back to its single model', async () => {
  const payload = await modelsWithSetting(true, null);
  assert.deepEqual(payload.data.map((m) => m.id), ['configured-model']);
});

for (const identifier of BACKEND_IDENTIFIERS) {
  test(`honour-on: ${identifier} is filtered out of the advertised catalogue`, async () => {
    // A runtime that listed its own identifier — or a backend whose `model` is
    // the identifier because nothing is configured — must not leak it into the
    // list, in either position. Both are exercised at once here.
    const payload = await modelsWithSetting(
      true,
      ['gpt-5.6-sol', identifier, 'gpt-5.6-terra'],
      identifier,
    );
    assert.deepEqual(payload.data.map((m) => m.id), ['gpt-5.6-sol', 'gpt-5.6-terra']);
  });

  test(`honour-on with nothing to advertise: ${identifier} yields an empty list`, async () => {
    // The documented consequence of "an identifier is not a selectable model":
    // with no configured model and no runtime catalogue there is nothing to
    // advertise, so the list is empty rather than a value the proxy rejects.
    const payload = await modelsWithSetting(true, null, identifier);
    assert.deepEqual(payload.data.map((m) => m.id), []);
  });
}
