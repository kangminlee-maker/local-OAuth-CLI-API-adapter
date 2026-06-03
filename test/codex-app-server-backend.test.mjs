import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, before, test } from 'node:test';
import { CodexAppServerBackend } from '../dist/proxy/codex-app-server-backend.js';

const here = dirname(fileURLToPath(import.meta.url));
const fakeCodex = resolve(here, 'fixtures/fake-codex.cjs');
const originalCodexHome = process.env.CODEX_HOME;
const tempDirs = [];

before(async () => {
  await chmod(fakeCodex, 0o755);
});

afterEach(async () => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test('CodexAppServerBackend resolves when delayed provider usage arrives after completion', async () => {
  process.env.CODEX_HOME = await createCodexHome();
  const backend = new CodexAppServerBackend({
    command: fakeCodex,
    cwd: process.cwd(),
    timeoutMs: 10_000,
  });

  try {
    await backend.generate(textRequest());

    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 90);
    let result;
    try {
      result = await backend.generate(textRequest(), controller.signal);
    } finally {
      clearTimeout(abortTimer);
    }

    assert.equal(result.text, 'MEDIUM_OK');
    assert.equal(result.usage.source, 'provider');
    assert.equal(result.usage.inputTokens, 5);
    assert.equal(result.usage.outputTokens, 2);
    assert.equal(result.usage.cachedInputTokens, 2);
  } finally {
    await backend.close();
  }
});

test('CodexAppServerBackend follows per-request reasoning effort over backend fallback', async () => {
  process.env.CODEX_HOME = await createCodexHome();
  const backend = new CodexAppServerBackend({
    command: fakeCodex,
    cwd: process.cwd(),
    timeoutMs: 10_000,
    reasoningEffort: 'low',
  });

  try {
    const result = await backend.generate({
      ...textRequest(),
      reasoningEffort: 'minimal',
    });

    assert.equal(result.text, 'MINIMAL_OK');
    assert.equal(result.usage.source, 'provider');
  } finally {
    await backend.close();
  }
});

async function createCodexHome() {
  const dir = await mkdtemp(join(tmpdir(), 'codex-test-home-'));
  tempDirs.push(dir);
  await writeFile(join(dir, 'auth.json'), '{"token":"local"}\n');
  await writeFile(join(dir, 'config.toml'), 'model = "gpt-test-model"\n');
  return dir;
}

function textRequest() {
  return {
    shape: 'openai-chat',
    model: 'codex-app-server',
    messages: [{ role: 'user', content: 'Say OK' }],
    stream: false,
    streamOptions: { includeUsage: false, includeObfuscation: false },
    jsonMode: false,
    tools: [],
    toolChoice: { type: 'auto' },
    raw: {},
  };
}
