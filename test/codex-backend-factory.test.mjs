import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, before, test } from 'node:test';
import { createCodexBackend } from '../dist/proxy-cli.js';
import { resetCodexModelCatalogCache } from '../dist/proxy/codex-model-catalog.js';

const here = dirname(fileURLToPath(import.meta.url));
const fakeCodexModelsOk = resolve(here, 'fixtures/fake-codex-models-ok.cjs');

const originalFetch = globalThis.fetch;
const tempDirs = [];

before(async () => {
  await chmod(fakeCodexModelsOk, 0o755);
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  delete process.env.CODEX_MODELS_CALL_LOG;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

// The operator can point the proxy at a specific Codex executable. The catalogue
// lookup has to query that one, because a model the selected runtime advertises
// may be absent from whatever `codex` happens to be first on PATH — validating
// against the wrong binary would reject a usable model with a 404.
test('the default transport queries the selected Codex executable, not PATH', async () => {
  resetCodexModelCatalogCache();
  const codexHome = await createCodexHome();
  const callLog = join(await mkdtemp(join(tmpdir(), 'codex-factory-')), 'calls.log');
  process.env.CODEX_MODELS_CALL_LOG = callLog;
  process.env.CODEX_HOME = codexHome;

  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(
      [
        `data: ${JSON.stringify({ type: 'response.created', response: { id: 'r', model: 'x', status: 'in_progress' } })}\n\n`,
        `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'OK' })}\n\n`,
        `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'r', model: 'x' } })}\n\n`,
      ].join(''),
      { status: 200 },
    );
  };

  const backend = createCodexBackend({
    transport: 'codex-backend',
    command: fakeCodexModelsOk,
    cwd: process.cwd(),
    model: 'fixture-model-a',
    timeoutMs: 30_000,
    honorRequestModel: true,
  });

  await backend.generate({
    shape: 'openai-chat',
    model: 'fixture-model-a',
    messages: [{ role: 'user', content: 'Say OK', images: [] }],
    stream: false,
    streamOptions: { includeUsage: false, includeObfuscation: false },
    jsonMode: false,
    tools: [],
    toolChoice: { type: 'auto' },
    raw: {},
  });

  // `fixture-model-a` exists only in the fake CLI's catalogue, so a successful
  // request proves the lookup used the selected executable.
  assert.equal(existsSync(callLog), true, 'expected the selected executable to be queried');
  assert.equal((await readFile(callLog, 'utf8')).trim(), 'debug models');
  assert.equal(JSON.parse(calls[0].init.body).model, 'fixture-model-a');
});

async function createCodexHome() {
  const dir = await mkdtemp(join(tmpdir(), 'codex-factory-home-'));
  tempDirs.push(dir);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'auth.json'),
    `${JSON.stringify({
      tokens: {
        access_token: 'codex-oauth-token',
        account_id: 'account-1',
        refresh_token: 'refresh-token',
      },
    })}\n`,
  );
  return dir;
}
