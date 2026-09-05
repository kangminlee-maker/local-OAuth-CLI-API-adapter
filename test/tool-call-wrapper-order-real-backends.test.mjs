import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, before, test } from 'node:test';
import { ClaudeCodeBackend } from '../dist/proxy/claude-code-backend.js';
import { CodexAppServerBackend } from '../dist/proxy/codex-app-server-backend.js';

/**
 * Where the narration sits among a turn's calls, asserted against the REAL
 * backend classes.
 *
 * `tool-call-wrapper-order.test.mjs` drives a hand-built double whose comment
 * says it is "wired the way `ClaudeCodeBackend` and `CodexAppServerBackend`
 * wire it". It is — but a copy of a mapping cannot fail when the original
 * breaks: forcing every propagated run in `ClaudeCodeBackend` to
 * `afterCalls: 0` (narration moves from after the call to before it, the
 * ordering defect this repo keeps producing) left 1665 tests green.
 *
 * These drive the same two wrappers through the shipped backends, so the
 * propagation line itself is what is under test.
 */

const here = dirname(fileURLToPath(import.meta.url));
const wrapperClaude = resolve(here, 'fixtures/wrapper-claude.cjs');
const fakeCodex = resolve(here, 'fixtures/fake-codex.cjs');
const tempDirs = [];
const CALL = '{"id":"c1","name":"get","arguments":"{\\"n\\":1}"}';
const CALLS_FIRST = `{"status":"tool_calls","toolCalls":[${CALL}],"text":"AFTER"}`;
const TEXT_FIRST = `{"status":"tool_calls","text":"BEFORE","toolCalls":[${CALL}]}`;

before(async () => {
  await chmod(wrapperClaude, 0o755);
  await chmod(fakeCodex, 0o755);
});

afterEach(async () => {
  delete process.env.WRAPPER_RAW;
  delete process.env.FAKE_CODEX_RAW_TEXT;
  delete process.env.CODEX_HOME;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function toolRequest(shape = 'openai-chat') {
  return {
    shape,
    model: 'codex-app-server',
    messages: [{ role: 'user', content: 'call get', images: [] }],
    stream: false,
    streamOptions: { includeUsage: false, includeObfuscation: false },
    jsonMode: false,
    tools: [{ name: 'get', description: 'g', inputSchema: { type: 'object', properties: { n: { type: 'number' } } } }],
    toolChoice: { type: 'auto' },
    raw: {},
  };
}

async function claudeRuns(raw) {
  process.env.WRAPPER_RAW = raw;
  const backend = new ClaudeCodeBackend({
    command: wrapperClaude,
    cwd: process.cwd(),
    model: 'claude-code-cli',
    timeoutMs: 30_000,
  });
  try {
    return await backend.generate(toolRequest());
  } finally {
    await backend.close();
  }
}

async function codexRuns(raw) {
  const dir = await mkdtemp(join(tmpdir(), 'codex-wrapper-home-'));
  tempDirs.push(dir);
  await writeFile(join(dir, 'auth.json'), '{"token":"local"}\n');
  await writeFile(join(dir, 'config.toml'), 'model = "gpt-test-model"\n');
  process.env.CODEX_HOME = dir;
  process.env.FAKE_CODEX_RAW_TEXT = raw;
  const backend = new CodexAppServerBackend({ command: fakeCodex, cwd: process.cwd(), timeoutMs: 30_000 });
  try {
    return await backend.generate(toolRequest());
  } finally {
    await backend.close();
  }
}

for (const [name, run] of [['ClaudeCodeBackend', claudeRuns], ['CodexAppServerBackend', codexRuns]]) {
  test(`${name} reports narration written AFTER the call as after the call`, async () => {
    const result = await run(CALLS_FIRST);
    assert.equal(result.text, 'AFTER');
    assert.equal(result.toolCalls.length, 1);
    assert.deepEqual(
      result.textRuns,
      [{ text: 'AFTER', afterCalls: 1 }],
      `${name} lost the narration's position on the way out of the backend`,
    );
  });

  test(`${name} reports narration written BEFORE the call as before the call`, async () => {
    const result = await run(TEXT_FIRST);
    assert.equal(result.text, 'BEFORE');
    assert.equal(result.toolCalls.length, 1);
    assert.deepEqual(
      result.textRuns,
      [{ text: 'BEFORE', afterCalls: 0 }],
      `${name} lost the narration's position on the way out of the backend`,
    );
  });

  test(`${name}: the two wrappers do not produce the same position`, async () => {
    // Compare POSITIONS only. Comparing whole runs would pass even with every
    // position collapsed to 0, because the two wrappers carry different text —
    // which is exactly what happened when this was written as a whole-run
    // notDeepEqual and the collapse mutant walked past it.
    const positions = (result) => (result.textRuns ?? []).map((run) => run.afterCalls);
    const after = positions(await run(CALLS_FIRST));
    const before = positions(await run(TEXT_FIRST));
    assert.deepEqual(after, [1]);
    assert.deepEqual(before, [0]);
    assert.notDeepEqual(after, before, 'both wrappers reported the same position');
  });
}
