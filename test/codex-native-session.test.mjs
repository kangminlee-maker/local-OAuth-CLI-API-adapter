import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
const originalAckDelay = process.env.FAKE_CODEX_TURN_START_DELAY_MS;
const originalMethodLog = process.env.FAKE_CODEX_METHOD_LOG;

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
  if (originalAckDelay === undefined) delete process.env.FAKE_CODEX_TURN_START_DELAY_MS;
  else process.env.FAKE_CODEX_TURN_START_DELAY_MS = originalAckDelay;
  if (originalMethodLog === undefined) delete process.env.FAKE_CODEX_METHOD_LOG;
  else process.env.FAKE_CODEX_METHOD_LOG = originalMethodLog;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Starts a session and returns it with the path the fake logs received methods to. */
async function startSession() {
  const sourceHome = await mkdtemp(join(tmpdir(), 'codex-native-home-'));
  tempDirs.push(sourceHome);
  await writeFile(join(sourceHome, 'auth.json'), JSON.stringify({ tokens: { access_token: 't' } }), { mode: 0o600 });
  process.env.CODEX_HOME = sourceHome;
  const cwd = await mkdtemp(join(tmpdir(), 'codex-native-cwd-'));
  tempDirs.push(cwd);
  const methodLog = join(sourceHome, 'received-methods.log');
  process.env.FAKE_CODEX_METHOD_LOG = methodLog;
  // A turn budget in the minutes, as a real session has.
  const session = await CodexNativeCliChatSession.create({ command: fakeCodex, cwd, timeoutMs: 20_000 });
  return { session, methodLog };
}

async function receivedMethods(methodLog) {
  return await readFile(methodLog, 'utf8').catch(() => '');
}

test('closing a session whose child stopped answering does not wait out the turn timeout', async () => {
  // `close()` asks the child to archive its thread, and that request carried the
  // TURN timeout. A child that answered `initialize` and `thread/start` and then
  // went quiet therefore held every caller of close() — a session DELETE, and
  // the proxy's own shutdown — for the whole turn budget.
  process.env.FAKE_CODEX_SILENT_AFTER_START = '1';
  const { session } = await startSession();

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
  const { session } = await startSession();
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

test('a turn whose caller already left never starts on the child', async () => {
  // The sibling backend holds this invariant with its own regression test: an
  // aborted signal at entry must not spend a turn on the child. Here the abort
  // failed the caller's queue and then fell through to `turn/start` anyway, so
  // the child ran a turn nobody would read and nothing would interrupt.
  const { session } = await startSession();
  const aborted = new AbortController();
  aborted.abort();

  await assert.rejects(async () => {
    for await (const _event of session.startTurn({ input: 'never runs' }, aborted.signal)) {
      // no events expected
    }
  }, /abort/i);

  // The fixture counts `turn/start` calls and reports the count in its debug
  // payload; the aborted turn must not appear in it.
  let text = '';
  for await (const event of session.startTurn({ input: 'DEBUG_PAYLOAD' })) {
    if (event.textDelta) text += event.textDelta;
  }
  assert.equal(JSON.parse(text).turnCount, 1, 'the aborted turn must never have started');
  await session.close();
});

test('a turn abandoned before the child acknowledges it is interrupted, not orphaned', { timeout: 20_000 }, async () => {
  // Aborting while `turn/start` is still in flight left `turnId` empty, so the
  // interrupt was skipped entirely — the turn then opened on the child with no
  // reader and no way to stop it, and its late notifications were buffered into
  // whatever turn came next.
  process.env.FAKE_CODEX_TURN_START_DELAY_MS = '150';
  const { session, methodLog } = await startSession();
  const controller = new AbortController();
  const drain = (async () => {
    for await (const _event of session.startTurn({ input: 'hello' }, controller.signal)) {
      // the acknowledgement never reaches us
    }
  })();
  setTimeout(() => controller.abort(), 20).unref();
  await assert.rejects(drain, /abort/i);

  await session.close();
  assert.match(
    await receivedMethods(methodLog),
    /turn\/interrupt/,
    'the abandoned turn should have been interrupted',
  );
});

test('a session whose child answers still archives its thread on close', async () => {
  // The control for the budget above — and it has to assert the archive was
  // actually RECEIVED: a `close()` that skipped it entirely satisfies an
  // elapsed-time bound faster than one that sends it, so timing alone proves
  // the opposite of what this test is for.
  const { session, methodLog } = await startSession();

  const startedAt = Date.now();
  await session.close();

  assert.ok(Date.now() - startedAt < 2_000);
  assert.match(await receivedMethods(methodLog), /thread\/archive/);
});
