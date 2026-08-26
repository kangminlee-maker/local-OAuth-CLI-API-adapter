import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, before, test } from 'node:test';
import { ClaudeNativeCliChatSession } from '../dist/chat/claude-native-session.js';
import { CodexNativeCliChatSession } from '../dist/chat/codex-native-session.js';
import { LocalCliChatSessionManager } from '../dist/chat/session-manager.js';

// Interrupting a native turn is ONE operation with one owner: the runtime
// session stops its child and ends the turn's iteration. The manager used to
// trigger the turn's abort signal as well, so the child was told twice through
// two paths that each believed they owned the stop.

const here = dirname(fileURLToPath(import.meta.url));
const fakeCodex = resolve(here, 'fixtures/fake-codex.cjs');
const fakeClaude = resolve(here, 'fixtures/fake-claude-native.cjs');
const tempDirs = [];
// Every session spawns a child, and a child outliving its test keeps the test
// runner's process alive for good — a failing assertion would hang the suite
// rather than report itself.
const openSessions = [];
const originalCodexHome = process.env.CODEX_HOME;
const originalNoCompletion = process.env.FAKE_CODEX_NO_TURN_COMPLETION;
const originalMethodLog = process.env.FAKE_CODEX_METHOD_LOG;

before(async () => {
  await chmod(fakeCodex, 0o755);
  await chmod(fakeClaude, 0o755);
});

afterEach(async () => {
  await Promise.all(openSessions.splice(0).map((closeable) => closeable().catch(() => undefined)));
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  if (originalNoCompletion === undefined) delete process.env.FAKE_CODEX_NO_TURN_COMPLETION;
  else process.env.FAKE_CODEX_NO_TURN_COMPLETION = originalNoCompletion;
  if (originalMethodLog === undefined) delete process.env.FAKE_CODEX_METHOD_LOG;
  else process.env.FAKE_CODEX_METHOD_LOG = originalMethodLog;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const delay = (ms) => new Promise((resolve_) => setTimeout(resolve_, ms).unref());

/** A manager whose codex runtime is the real session over the fake child. */
async function startCodexManager() {
  const sourceHome = await mkdtemp(join(tmpdir(), 'interrupt-codex-home-'));
  tempDirs.push(sourceHome);
  await writeFile(join(sourceHome, 'auth.json'), JSON.stringify({ tokens: { access_token: 't' } }), { mode: 0o600 });
  process.env.CODEX_HOME = sourceHome;
  const cwd = await mkdtemp(join(tmpdir(), 'interrupt-codex-cwd-'));
  tempDirs.push(cwd);
  const methodLog = join(sourceHome, 'received-methods.log');
  process.env.FAKE_CODEX_METHOD_LOG = methodLog;
  const manager = new LocalCliChatSessionManager({
    defaultCwd: cwd,
    runtimes: {
      codex: async (input) => CodexNativeCliChatSession.create({
        command: fakeCodex,
        cwd: input.cwd,
        timeoutMs: 20_000,
      }),
    },
  });
  openSessions.push(() => manager.closeAll());
  return { manager, methodLog };
}

async function receivedMethods(methodLog) {
  return (await readFile(methodLog, 'utf8').catch(() => '')).split('\n').filter(Boolean);
}

test('an interrupted codex turn is stopped once, not once per path', { timeout: 20_000 }, async () => {
  process.env.FAKE_CODEX_NO_TURN_COMPLETION = '1';
  const { manager, methodLog } = await startCodexManager();
  const session = await manager.create({ runtime: 'codex' });
  const events = [];
  const drain = (async () => {
    for await (const event of manager.streamTurn(session.id, { input: 'hello' })) events.push(event);
  })();
  await delay(300);

  await manager.interrupt(session.id);
  await drain;

  assert.equal(
    (await receivedMethods(methodLog)).filter((method) => method === 'turn/interrupt').length,
    1,
    'the child must be told to stop once, by the one path that owns stopping',
  );
  assert.equal(events.at(-1).event, 'cli.error', 'the caller stops iterating too');
});

test('a claude turn abandoned mid-flight leaves a session that still answers', async () => {
  // The abort signal killed the child without replacing it, so the session
  // reported `ready` over a child that was gone and every later turn answered
  // "session is not running". Abandoning and interrupting are one operation.
  const cwd = await mkdtemp(join(tmpdir(), 'interrupt-claude-cwd-'));
  tempDirs.push(cwd);
  const session = await ClaudeNativeCliChatSession.create({
    command: fakeClaude,
    cwd,
    model: 'claude-opus-4-8',
    timeoutMs: 20_000,
  });
  openSessions.push(() => session.close());
  try {
    const controller = new AbortController();
    const drain = (async () => {
      for await (const _event of session.startTurn({ input: 'HANG' }, controller.signal)) {
        // the fake child answers this prompt with nothing at all
      }
    })();
    await delay(150);
    controller.abort();
    await assert.rejects(drain, /interrupt|abort/i);

    assert.equal(await turnText(session, 'Say OK'), 'OK');
  } finally {
    await session.close();
  }
});

test('an interrupted claude turn leaves a session that still answers', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'interrupt-claude-cwd-'));
  tempDirs.push(cwd);
  const session = await ClaudeNativeCliChatSession.create({
    command: fakeClaude,
    cwd,
    model: 'claude-opus-4-8',
    timeoutMs: 20_000,
  });
  openSessions.push(() => session.close());
  try {
    const drain = (async () => {
      for await (const _event of session.startTurn({ input: 'HANG' })) {
        // the fake child answers this prompt with nothing at all
      }
    })();
    await delay(150);
    await session.interrupt();
    await assert.rejects(drain, /interrupt/i);

    assert.equal(await turnText(session, 'Say OK'), 'OK');
  } finally {
    await session.close();
  }
});

async function turnText(session, input) {
  let text = '';
  for await (const event of session.startTurn({ input })) {
    const raw = event.raw;
    if (raw && typeof raw === 'object' && raw.type === 'result' && typeof raw.result === 'string') {
      text = raw.result;
    }
  }
  return text;
}
