import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, before, test } from 'node:test';
import { CodexNativeCliChatSession } from '../dist/chat/codex-native-session.js';

const here = dirname(fileURLToPath(import.meta.url));
const fakeCodex = resolve(here, 'fixtures/fake-codex.cjs');
const tempDirs = [];
const originalCodexHome = process.env.CODEX_HOME;
const originalSilent = process.env.FAKE_CODEX_SILENT_AFTER_START;
const originalNoCompletion = process.env.FAKE_CODEX_NO_TURN_COMPLETION;

before(async () => {
  await chmod(fakeCodex, 0o755);
});

afterEach(async () => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  if (originalSilent === undefined) delete process.env.FAKE_CODEX_SILENT_AFTER_START;
  else process.env.FAKE_CODEX_SILENT_AFTER_START = originalSilent;
  if (originalNoCompletion === undefined) delete process.env.FAKE_CODEX_NO_TURN_COMPLETION;
  else process.env.FAKE_CODEX_NO_TURN_COMPLETION = originalNoCompletion;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function startSession() {
  const sourceHome = await mkdtemp(join(tmpdir(), 'codex-native-home-'));
  tempDirs.push(sourceHome);
  await writeFile(join(sourceHome, 'auth.json'), JSON.stringify({ tokens: { access_token: 't' } }), { mode: 0o600 });
  process.env.CODEX_HOME = sourceHome;
  const cwd = await mkdtemp(join(tmpdir(), 'codex-native-cwd-'));
  tempDirs.push(cwd);
  // A turn budget in the minutes, as a real session has.
  return await CodexNativeCliChatSession.create({ command: fakeCodex, cwd, timeoutMs: 20_000 });
}

test('closing a session whose child stopped answering does not wait out the turn timeout', async () => {
  // `close()` asks the child to archive its thread, and that request carried the
  // TURN timeout. A child that answered `initialize` and `thread/start` and then
  // went quiet therefore held every caller of close() — a session DELETE, and
  // the proxy's own shutdown — for the whole turn budget.
  process.env.FAKE_CODEX_SILENT_AFTER_START = '1';
  const session = await startSession();

  const startedAt = Date.now();
  await session.close();
  const elapsed = Date.now() - startedAt;

  assert.ok(elapsed < 5_000, `close waited ${elapsed}ms on an unanswered thread/archive`);
});

test('an aborted turn stops iterating even when the child never completes it', { timeout: 15_000 }, async () => {
  // The turn's queue closes on `turn/completed`. A child that opened the turn
  // and then produced nothing left the caller iterating with no end: the abort
  // reached the child as `turn/interrupt` and nothing reached the caller — so
  // the deadline the HTTP surface now applies had nothing to end.
  process.env.FAKE_CODEX_NO_TURN_COMPLETION = '1';
  const session = await startSession();
  const controller = new AbortController();
  const drain = (async () => {
    for await (const _event of session.startTurn({ input: 'hello' }, controller.signal)) {
      // The turn/start acknowledgement arrives; nothing else ever does.
    }
  })();
  setTimeout(() => controller.abort(), 100).unref();

  await assert.rejects(drain, /abort/i);
  await session.close();
});

test('a session whose child answers still archives its thread on close', async () => {
  // The control: the budget is a ceiling, not a delay, and the archive is still
  // sent — a fake that never received it would report the method as unsupported.
  const session = await startSession();

  const startedAt = Date.now();
  await session.close();

  assert.ok(Date.now() - startedAt < 2_000);
});
