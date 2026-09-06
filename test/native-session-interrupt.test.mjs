import assert from 'node:assert/strict';
import fs, { existsSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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
const originalStartDelay = process.env.FAKE_CODEX_TURN_START_DELAY_MS;
const originalTrailing = process.env.FAKE_CODEX_TRAILING_NOTIFICATION;
const originalInitDelay = process.env.FAKE_CODEX_INITIALIZE_DELAY_MS;
const originalArchiveDelay = process.env.FAKE_CODEX_ARCHIVE_DELAY_MS;
const childHookNames = ['FAKE_CODEX_PID_FILE', 'FAKE_CODEX_IGNORE_SIGTERM', 'FAKE_CODEX_TURN_COMPLETION_DELAY_MS', 'FAKE_CODEX_NO_INTERRUPT_ACK', 'FAKE_CLAUDE_PID_FILE', 'FAKE_CLAUDE_IGNORE_SIGTERM'];
const originalChildHooks = new Map(childHookNames.map((name) => [name, process.env[name]]));

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
  if (originalStartDelay === undefined) delete process.env.FAKE_CODEX_TURN_START_DELAY_MS;
  else process.env.FAKE_CODEX_TURN_START_DELAY_MS = originalStartDelay;
  if (originalTrailing === undefined) delete process.env.FAKE_CODEX_TRAILING_NOTIFICATION;
  else process.env.FAKE_CODEX_TRAILING_NOTIFICATION = originalTrailing;
  if (originalInitDelay === undefined) delete process.env.FAKE_CODEX_INITIALIZE_DELAY_MS;
  else process.env.FAKE_CODEX_INITIALIZE_DELAY_MS = originalInitDelay;
  if (originalArchiveDelay === undefined) delete process.env.FAKE_CODEX_ARCHIVE_DELAY_MS;
  else process.env.FAKE_CODEX_ARCHIVE_DELAY_MS = originalArchiveDelay;
  for (const [name, value] of originalChildHooks) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const delay = (ms) => new Promise((resolve_) => setTimeout(resolve_, ms).unref());

/** A manager whose codex runtime is the real session over the fake child. */
async function startCodexManager(timeoutMs = 20_000) {
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
        timeoutMs,
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

  // The endpoint answers at the write, not at the child's acknowledgement
  // (t1 round 3): the receipt is waited for, then counted.
  await waitFor(async () => (await receivedMethods(methodLog)).includes('turn/interrupt'), 3_000, 'the child to receive the interrupt');
  await delay(100);
  assert.equal(
    (await receivedMethods(methodLog)).filter((method) => method === 'turn/interrupt').length,
    1,
    'the child must be told to stop once, by the one path that owns stopping',
  );
  assert.equal(events.at(-1).event, 'cli.error', 'the caller stops iterating too');
});

test('an interrupt during the turn/start round-trip still reaches the child', { timeout: 20_000 }, async () => {
  // The window between asking the child to start a turn and being told its id
  // is the slowest part of starting one — input preparation plus the RPC — and
  // an interrupt that lands there used to reach the child through the turn's
  // abort signal. Reading only `activeTurn`, which is installed after the
  // acknowledgement, made the endpoint a no-op for that whole window: the child
  // kept working and the caller kept waiting, while the session reported ready.
  process.env.FAKE_CODEX_TURN_START_DELAY_MS = '1500';
  const { manager, methodLog } = await startCodexManager();
  const session = await manager.create({ runtime: 'codex' });
  const events = [];
  const drain = (async () => {
    for await (const event of manager.streamTurn(session.id, { input: 'hello' })) events.push(event);
  })();
  await delay(400);

  await manager.interrupt(session.id);
  await drain;

  // The caller is answered at the stop, before the child acknowledges the
  // start (t1 B-res): the interrupt is written when the acknowledgement
  // arrives, so it is waited for, not read the instant the caller returns.
  await waitFor(
    async () => (await receivedMethods(methodLog)).filter((method) => method === 'turn/interrupt').length === 1,
    3_000,
    'the turn to be interrupted on the child, whenever the interrupt lands',
  );
  assert.equal(events.at(-1).event, 'cli.error', 'the caller stops iterating too');
});

test('a session whose caller walked away accepts the next turn after an interrupt', { timeout: 20_000 }, async () => {
  // The documented cancellation for an abandoned turn is this endpoint. Failing
  // the queue without clearing the active turn left the session refusing every
  // later turn with "already has a running turn" — the abandoned generator's
  // `finally`, which clears it, only runs if someone resumes the generator.
  process.env.FAKE_CODEX_NO_TURN_COMPLETION = '1';
  const { manager } = await startCodexManager();
  const session = await manager.create({ runtime: 'codex' });
  const stream = manager.streamTurn(session.id, { input: 'hello' })[Symbol.asyncIterator]();
  await stream.next();
  await delay(200);

  await manager.interrupt(session.id);

  delete process.env.FAKE_CODEX_NO_TURN_COMPLETION;
  const events = [];
  for await (const event of manager.streamTurn(session.id, { input: 'DEBUG_PAYLOAD' })) events.push(event);
  assert.equal(
    events.at(-1).event,
    'cli.completed',
    `the next turn must run: ${JSON.stringify(events.at(-1))}`,
  );
});

test('the child is told to stop before it is asked for the next turn', { timeout: 20_000 }, async () => {
  // Stopping releases the session as soon as the turn is retired, without
  // waiting for the child to acknowledge the interrupt — holding the session
  // until then would let an unresponsive child, the case interrupts exist for,
  // block every later turn for a whole request budget. What has to hold instead
  // is ORDER: the child is told to stop before it is asked to start anything
  // else, and requests reach it in the order they are written.
  process.env.FAKE_CODEX_NO_TURN_COMPLETION = '1';
  const { manager, methodLog } = await startCodexManager();
  const session = await manager.create({ runtime: 'codex' });

  const events = [];
  for await (const event of manager.streamTurn(session.id, { input: 'hello' }, { timeoutMs: 300 })) {
    events.push(event);
  }
  assert.equal(events.at(-1).event, 'cli.error', 'the idle deadline ends the turn');

  delete process.env.FAKE_CODEX_NO_TURN_COMPLETION;
  const next = [];
  for await (const event of manager.streamTurn(session.id, { input: 'DEBUG_PAYLOAD' })) next.push(event);
  assert.equal(next.at(-1).event, 'cli.completed', 'the next turn runs');

  const methods = (await receivedMethods(methodLog)).filter((m) => m === 'turn/start' || m === 'turn/interrupt');
  assert.deepEqual(
    methods,
    ['turn/start', 'turn/interrupt', 'turn/start'],
    'the interrupt must reach the child before the next turn does',
  );
});

test('a turn/start the child never names within the budget replaces the child: the next turn runs on a fresh thread, not ahead of work nobody can interrupt (r52-codex)', { timeout: 20_000 }, async () => {
  // The request's expiry used to release the session as if the turn had
  // failed; the child kept the accepted turn, its late acknowledgement was
  // dropped with the pending entry, and the next `turn/start` reached the
  // thread with no interrupt between them.
  process.env.FAKE_CODEX_TURN_START_DELAY_MS = '650';
  process.env.FAKE_CODEX_NO_TURN_COMPLETION = '1';
  const { manager, methodLog } = await startCodexManager(300);
  const session = await manager.create({ runtime: 'codex' });
  // The child already spawned keeps its environment; its replacement will not.
  delete process.env.FAKE_CODEX_TURN_START_DELAY_MS;
  delete process.env.FAKE_CODEX_NO_TURN_COMPLETION;
  const first = await manager.runTurn(session.id, { input: 'hello' }, { timeoutMs: 2000 }); // caller budget above the RPC budget: the RPC timeout ends this turn, not the caller's deadline (t1 B-res)
  assert.equal(first.status, 'error');
  assert.match(first.events.at(-1).raw.message, /turn\/start timed out after 300ms/);
  const second = await manager.runTurn(session.id, { input: 'again' }, { timeoutMs: 300 });
  assert.equal(second.status, 'completed', 'the next turn ran on the replacement');
  assert.match(second.final.text, /OK$/);
  const methods = await receivedMethods(methodLog);
  assert.equal(methods.filter((method) => method === 'turn/start').length, 2);
  assert.equal(methods.filter((method) => method === 'thread/start').length, 2, 'a fresh thread on a fresh child');
});

test('a session closed while its child is being replaced gets no new child: nothing outlives the close, no credentials directory either (r53-fable)', { timeout: 20_000 }, async () => {
  // The replacement, between its cleanup and its `start()`, outran a close:
  // the new child and its isolation directory belonged to nobody.
  process.env.FAKE_CODEX_TURN_START_DELAY_MS = '650';
  process.env.FAKE_CODEX_NO_TURN_COMPLETION = '1';
  const privateTmp = await mkdtemp(join(tmpdir(), 'interrupt-isolation-'));
  tempDirs.push(privateTmp);
  const cwd = await mkdtemp(join(tmpdir(), 'interrupt-codex-cwd-'));
  tempDirs.push(cwd);
  const methodLog = join(privateTmp, '..', `${privateTmp.split('/').pop()}-methods.log`);
  process.env.FAKE_CODEX_METHOD_LOG = methodLog;
  const originalTmp = process.env.TMPDIR;
  process.env.TMPDIR = privateTmp;
  let session;
  try {
    session = await CodexNativeCliChatSession.create({ command: fakeCodex, cwd, timeoutMs: 300 });
    openSessions.push(() => session.close());
    delete process.env.FAKE_CODEX_TURN_START_DELAY_MS;
    delete process.env.FAKE_CODEX_NO_TURN_COMPLETION;
    assert.equal((await readdir(privateTmp)).length, 1, 'one isolation directory for the child');
    await assert.rejects(turnText(session, 'hello'), /turn\/start timed out after 300ms/);
    // The replacement is in flight; the close lands on it.
    await session.close();
    await delay(1500);
    assert.deepEqual(await readdir(privateTmp), [], 'no isolation directory outlives the close');
    const methods = await receivedMethods(methodLog);
    assert.equal(methods.filter((method) => method === 'thread/start').length, 1, 'no second child was started');
  } finally {
    if (originalTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTmp;
    await rm(methodLog, { force: true });
  }
});

test('a credentials directory the replacement cannot remove stops nothing and escapes nowhere: the session goes on with a fresh child (r53-fable)', { timeout: 20_000 }, async () => {
  process.env.FAKE_CODEX_TURN_START_DELAY_MS = '650';
  process.env.FAKE_CODEX_NO_TURN_COMPLETION = '1';
  const { manager } = await startCodexManager(300);
  const privateTmp = await mkdtemp(join(tmpdir(), 'interrupt-isolation-'));
  const originalTmp = process.env.TMPDIR;
  process.env.TMPDIR = privateTmp;
  let isolationRoot;
  const rejections = [];
  const onRejection = (err) => rejections.push(err);
  try {
    const session = await manager.create({ runtime: 'codex' });
    delete process.env.FAKE_CODEX_TURN_START_DELAY_MS;
    delete process.env.FAKE_CODEX_NO_TURN_COMPLETION;
    [isolationRoot] = (await readdir(privateTmp)).map((name) => join(privateTmp, name));
    assert.ok(isolationRoot, 'the child\'s isolation directory');
    // Unreadable: the replacement's `rm` of it rejects.
    await chmod(isolationRoot, 0o000);
    process.on('unhandledRejection', onRejection);
    const first = await manager.runTurn(session.id, { input: 'hello' }, { timeoutMs: 2000 }); // caller budget above the RPC budget: the RPC timeout ends this turn, not the caller's deadline (t1 B-res)
    assert.equal(first.status, 'error');
    assert.match(first.events.at(-1).raw.message, /turn\/start timed out after 300ms/);
    const second = await manager.runTurn(session.id, { input: 'again' }, { timeoutMs: 300 });
    assert.equal(second.status, 'completed', 'the replacement went on');
    assert.match(second.final.text, /OK$/);
    await delay(200);
    assert.deepEqual(rejections, [], 'nothing escaped');
    // The directory the replacement could not remove is the close's: it tries
    // again, and what still will not go is its error — after the session is
    // gone from the manager, with the child killed (r54-codex, r54-fable).
    await assert.rejects(manager.close(session.id), /credentials copy could not be removed/);
    assert.throws(() => manager.get(session.id), /Unknown local CLI chat session/);
    assert.ok(existsSync(isolationRoot), 'the directory is still there to be reported');
  } finally {
    process.off('unhandledRejection', onRejection);
    if (originalTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTmp;
    if (isolationRoot) await chmod(isolationRoot, 0o700).catch(() => undefined);
    tempDirs.push(privateTmp);
  }
});

test('a credentials directory the close cannot remove does not keep the session listed: the close resolves and the session is gone (r54-fable)', { timeout: 20_000 }, async () => {
  const { manager } = await startCodexManager();
  const privateTmp = await mkdtemp(join(tmpdir(), 'interrupt-isolation-'));
  const originalTmp = process.env.TMPDIR;
  process.env.TMPDIR = privateTmp;
  let isolationRoot;
  try {
    const session = await manager.create({ runtime: 'codex' });
    [isolationRoot] = (await readdir(privateTmp)).map((name) => join(privateTmp, name));
    assert.ok(isolationRoot, 'the child\'s isolation directory');
    await chmod(isolationRoot, 0o000);
    await assert.rejects(manager.close(session.id), /credentials copy could not be removed/, 'not a success over a copied credential left on disk');
    assert.throws(() => manager.get(session.id), /Unknown local CLI chat session/, 'and not a session kept listed');
  } finally {
    if (originalTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTmp;
    if (isolationRoot) await chmod(isolationRoot, 0o700).catch(() => undefined);
    tempDirs.push(privateTmp);
  }
});

test('a turn waiting for a child replacement is the session\'s: it occupies the session, an interrupt ends it, and it never reaches the new child (r54-codex)', { timeout: 20_000 }, async () => {
  process.env.FAKE_CODEX_TURN_START_DELAY_MS = '650';
  process.env.FAKE_CODEX_NO_TURN_COMPLETION = '1';
  const { manager, methodLog } = await startCodexManager(300);
  const session = await manager.create({ runtime: 'codex' });
  delete process.env.FAKE_CODEX_TURN_START_DELAY_MS;
  delete process.env.FAKE_CODEX_NO_TURN_COMPLETION;
  // The replacement child is slow to come up: the next turn waits for it.
  process.env.FAKE_CODEX_INITIALIZE_DELAY_MS = '800';
  const first = await manager.runTurn(session.id, { input: 'hello' }, { timeoutMs: 2000 }); // caller budget above the RPC budget: the RPC timeout ends this turn, not the caller's deadline (t1 B-res)
  assert.equal(first.status, 'error');
  const waiting = manager.streamTurn(session.id, { input: 'too soon' })[Symbol.asyncIterator]();
  const outcome = waiting.next().catch((err) => ({ error: err }));
  await delay(100);
  assert.equal(manager.get(session.id).status, 'running', 'the waiting turn occupies the session');
  await manager.interrupt(session.id);
  const result = await outcome;
  assert.ok('error' in result || result.value?.event === 'cli.error', 'the interrupted turn ended');
  await delay(1000);
  const methods = await receivedMethods(methodLog);
  assert.equal(methods.filter((method) => method === 'turn/start').length, 1, 'the interrupted turn never reached the new child');
  assert.equal(manager.get(session.id).status, 'ready');
});

test('a stop that lands while the turn waits for the replacement ends the wait, not the replacement: the caller hears within the stop (r55-codex)', { timeout: 20_000 }, async () => {
  process.env.FAKE_CODEX_TURN_START_DELAY_MS = '650';
  process.env.FAKE_CODEX_NO_TURN_COMPLETION = '1';
  const { manager } = await startCodexManager(300);
  const session = await manager.create({ runtime: 'codex' });
  delete process.env.FAKE_CODEX_TURN_START_DELAY_MS;
  delete process.env.FAKE_CODEX_NO_TURN_COMPLETION;
  process.env.FAKE_CODEX_INITIALIZE_DELAY_MS = '250';
  const first = await manager.runTurn(session.id, { input: 'hello' }, { timeoutMs: 2000 }); // caller budget above the RPC budget: the RPC timeout ends this turn, not the caller's deadline (t1 B-res)
  assert.equal(first.status, 'error');
  const waiting = manager.streamTurn(session.id, { input: 'too soon' })[Symbol.asyncIterator]();
  const outcome = waiting.next().catch((err) => ({ error: err }));
  await delay(30);
  const interruptedAt = Date.now();
  await manager.interrupt(session.id);
  const result = await outcome;
  assert.ok(Date.now() - interruptedAt < 150, `the wait ended with the stop, not the startup: ${Date.now() - interruptedAt} ms`);
  assert.ok('error' in result || result.value?.event === 'cli.error');
});

test('a close that lands while a turn waits for the replacement ends the child being started, not the wait: the close returns within its own work and no turn reaches any child (r55-codex)', { timeout: 20_000 }, async () => {
  process.env.FAKE_CODEX_TURN_START_DELAY_MS = '1250';
  process.env.FAKE_CODEX_NO_TURN_COMPLETION = '1';
  const { manager, methodLog } = await startCodexManager(1000);
  const session = await manager.create({ runtime: 'codex' });
  delete process.env.FAKE_CODEX_TURN_START_DELAY_MS;
  delete process.env.FAKE_CODEX_NO_TURN_COMPLETION;
  // The replacement's handshake would take two seconds.
  process.env.FAKE_CODEX_INITIALIZE_DELAY_MS = '2000';
  const first = await manager.runTurn(session.id, { input: 'hello' }, { timeoutMs: 3000 }); // caller budget above the RPC budget (1000): the RPC timeout ends this turn, not the caller's deadline (t1 B-res)
  assert.equal(first.status, 'error');
  const waiting = manager.streamTurn(session.id, { input: 'too soon' })[Symbol.asyncIterator]();
  const outcome = waiting.next().catch((err) => ({ error: err }));
  await delay(100);
  const closingAt = Date.now();
  const closed = await manager.close(session.id);
  assert.ok(Date.now() - closingAt < 800, `the close did not wait out the handshake: ${Date.now() - closingAt} ms`);
  assert.equal(closed.status, 'closed');
  const result = await outcome;
  assert.ok('error' in result || result.value?.event === 'cli.error', 'the waiting caller heard the close');
  await delay(300);
  const methods = await receivedMethods(methodLog);
  assert.equal(methods.filter((method) => method === 'turn/start').length, 1, 'the waiting turn reached no child');
});

test('a replacement whose handshake fails leaves no child: the waiting turn reports why the child could not start and reaches nothing on the old thread (r55-codex; the reason since t1 B-child)', { timeout: 20_000 }, async () => {
  process.env.FAKE_CODEX_TURN_START_DELAY_MS = '650';
  process.env.FAKE_CODEX_NO_TURN_COMPLETION = '1';
  const { manager, methodLog } = await startCodexManager(300);
  const session = await manager.create({ runtime: 'codex' });
  delete process.env.FAKE_CODEX_TURN_START_DELAY_MS;
  delete process.env.FAKE_CODEX_NO_TURN_COMPLETION;
  // Slower than the RPC budget: the replacement's `initialize` times out.
  process.env.FAKE_CODEX_INITIALIZE_DELAY_MS = '850';
  const first = await manager.runTurn(session.id, { input: 'hello' }, { timeoutMs: 2000 }); // caller budget above the RPC budget: the RPC timeout ends this turn, not the caller's deadline (t1 B-res)
  assert.equal(first.status, 'error');
  // A deadline longer than the failing handshake: what ends this turn is the
  // replacement's failure, not the idle budget — and the turn reports that
  // failure, not only that no child is running (t1 B-child gap 3: the same
  // rule for a turn that waited for the attempt and one that made it).
  const second = await manager.runTurn(session.id, { input: 'again' }, { timeoutMs: 2000 });
  assert.equal(second.status, 'error');
  assert.match(second.events.at(-1).raw.message, /initialize timed out after 300ms/);
  await delay(200);
  const methods = await receivedMethods(methodLog);
  assert.equal(methods.filter((method) => method === 'turn/start').length, 1, 'nothing reached the partial child');
  assert.equal(methods.filter((method) => method === 'thread/start').length, 1, 'no thread was ever started on it');
});

test('closeAll reports a teardown that left a credentials copy on disk, after every session is torn down (r55-codex)', { timeout: 20_000 }, async () => {
  process.env.FAKE_CODEX_TURN_START_DELAY_MS = '650';
  process.env.FAKE_CODEX_NO_TURN_COMPLETION = '1';
  const { manager } = await startCodexManager(300);
  const privateTmp = await mkdtemp(join(tmpdir(), 'interrupt-isolation-'));
  const originalTmp = process.env.TMPDIR;
  process.env.TMPDIR = privateTmp;
  let isolationRoot;
  try {
    const session = await manager.create({ runtime: 'codex' });
    delete process.env.FAKE_CODEX_TURN_START_DELAY_MS;
    delete process.env.FAKE_CODEX_NO_TURN_COMPLETION;
    [isolationRoot] = (await readdir(privateTmp)).map((name) => join(privateTmp, name));
    await chmod(isolationRoot, 0o000);
    const first = await manager.runTurn(session.id, { input: 'hello' }, { timeoutMs: 2000 }); // caller budget above the RPC budget: the RPC timeout ends this turn, not the caller's deadline (t1 B-res)
    assert.equal(first.status, 'error');
    const second = await manager.runTurn(session.id, { input: 'again' }, { timeoutMs: 300 });
    assert.equal(second.status, 'completed');
    await assert.rejects(manager.closeAll(), /credentials copy could not be removed/);
    assert.throws(() => manager.get(session.id), /Unknown local CLI chat session/, 'torn down and gone all the same');
  } finally {
    if (originalTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTmp;
    if (isolationRoot) await chmod(isolationRoot, 0o700).catch(() => undefined);
    tempDirs.push(privateTmp);
  }
});

test('a session being deleted admits no turn: the DELETE\'s archive grace is not a window (r54-codex)', { timeout: 20_000 }, async () => {
  process.env.FAKE_CODEX_ARCHIVE_DELAY_MS = '600';
  const { manager, methodLog } = await startCodexManager();
  const session = await manager.create({ runtime: 'codex' });
  const closing = manager.close(session.id);
  await delay(100);
  await assert.rejects(manager.runTurn(session.id, { input: 'late' }), /Unknown local CLI chat session/, 'gone before the teardown finishes');
  assert.throws(() => manager.get(session.id), /Unknown local CLI chat session/);
  const closed = await closing;
  assert.equal(closed.status, 'closed');
  const methods = await receivedMethods(methodLog);
  assert.equal(methods.filter((method) => method === 'turn/start').length, 0, 'no turn reached the child');
  assert.equal(methods.filter((method) => method === 'thread/archive').length, 1);
});

test('a turn admitted before the close and read after it hears the close, and reaches no child (r55-fable)', { timeout: 20_000 }, async () => {
  // Admission is at the call; the turn's body runs at the first read. A close
  // that lands between the two finds the manager's record gone and the
  // runtime closed — the runtime's own refusal is what the reader hears, not
  // a turn started on a child being torn down, and not "not running" over a
  // session that was closed (r55-fable: the runtime's closed-refusal was
  // reachable by no test, so a mutant without it survived).
  const { manager, methodLog } = await startCodexManager();
  const session = await manager.create({ runtime: 'codex' });
  const stream = manager.streamTurn(session.id, { input: 'admitted first' })[Symbol.asyncIterator]();
  const closed = await manager.close(session.id);
  assert.equal(closed.status, 'closed');
  const event = await stream.next();
  assert.equal(event.value?.event, 'cli.error', JSON.stringify(event));
  assert.match(event.value.raw.message, /session closed/, 'the close is the reason the reader hears — the one in-band answer on both runtimes (t1 B-res)');
  assert.deepEqual((await stream.next()).done, true, 'and the iteration ends');
  const methods = await receivedMethods(methodLog);
  assert.equal(methods.filter((method) => method === 'turn/start').length, 0, 'no turn reached the child');
});

test('a stop between the request and its acknowledgement still precedes the next turn', { timeout: 20_000 }, async () => {
  // The third window a stop can land in. The invariant was pinned for a stop
  // AFTER the child names the turn, and asserted for one before the request is
  // even written — but in between, the turn has been asked for and has no id,
  // so there is nothing to interrupt yet. Releasing the session there let the
  // next turn reach the child first: start, start, interrupt.
  process.env.FAKE_CODEX_TURN_START_DELAY_MS = '600';
  const { manager, methodLog } = await startCodexManager();
  const session = await manager.create({ runtime: 'codex' });
  const stopped = manager.streamTurn(session.id, { input: 'hello' })[Symbol.asyncIterator]();
  void stopped.next().catch(() => undefined);
  // Long enough for `turn/start` to be written, short of its acknowledgement.
  await delay(200);

  const interruptedAt = Date.now();
  await manager.interrupt(session.id);
  assert.ok(
    Date.now() - interruptedAt < 200,
    'asking to stop must not wait for the child to name the turn',
  );

  // The turn cannot be interrupted until the child names it, so the session is
  // still occupied — and says so. A turn asked for now is refused rather than
  // dispatched ahead of the interrupt.
  assert.equal(manager.get(session.id).status, 'running');
  await assert.rejects(
    (async () => {
      for await (const _event of manager.streamTurn(session.id, { input: 'too soon' })) break;
    })(),
    /already has a running turn/i,
  );

  await delay(700);
  assert.equal(manager.get(session.id).status, 'ready', 'the acknowledgement frees the session');

  const next = [];
  for await (const event of manager.streamTurn(session.id, { input: 'DEBUG_PAYLOAD' })) next.push(event);
  assert.equal(next.at(-1).event, 'cli.completed', 'the next turn runs');

  assert.deepEqual(
    (await receivedMethods(methodLog)).filter((m) => m === 'turn/start' || m === 'turn/interrupt'),
    ['turn/start', 'turn/interrupt', 'turn/start'],
    'the child must hear the interrupt before it is asked for the next turn',
  );
});

test('a claude turn abandoned mid-flight leaves a session that still answers', { timeout: 20_000 }, async () => {
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

test('the claude runtime\'s deadline bounds silence, not duration: a turn streaming past the budget completes, a turn that fell silent ends (r51-codex)', { timeout: 20_000 }, async () => {
  // The runtime armed its own timer once at the turn's start, so a turn that
  // streamed for longer than the budget was cut at the budget — while the
  // manager's deadline, restarted by every event, would have let it run.
  const cwd = await mkdtemp(join(tmpdir(), 'interrupt-claude-cwd-'));
  tempDirs.push(cwd);
  const session = await ClaudeNativeCliChatSession.create({
    command: fakeClaude,
    cwd,
    model: 'claude-opus-4-8',
    timeoutMs: 300,
  });
  openSessions.push(() => session.close());
  try {
    const startedAt = Date.now();
    // Six deltas 100 ms apart, the result at ~700 ms: past the budget, never silent for it.
    assert.equal(await turnText(session, 'SLOW'), 'SLOW-DONE');
    assert.ok(Date.now() - startedAt >= 600, `the turn ran its whole length: ${Date.now() - startedAt} ms`);
    // One event and then silence: the deadline still ends it, at the budget.
    const silentAt = Date.now();
    await assert.rejects(turnText(session, 'PARTIAL'), /timed out after 300ms of silence/);
    assert.ok(Date.now() - silentAt < 1000, `silence ended at the budget: ${Date.now() - silentAt} ms`);
  } finally {
    await session.close();
  }
});

test('the manager\'s deadline restarts on every event: with the runtime\'s own timer out of the way, a turn streaming past the budget completes and a silent one ends at it (r52-fable mutant)', { timeout: 20_000 }, async () => {
  // The only silence bound the codex runtime has is this re-arm; without it
  // the manager's deadline was a duration cap, and no fixture said otherwise.
  const cwd = await mkdtemp(join(tmpdir(), 'interrupt-claude-cwd-'));
  tempDirs.push(cwd);
  const manager = new LocalCliChatSessionManager({
    defaultCwd: cwd,
    runtimes: {
      claude: async (input) => ClaudeNativeCliChatSession.create({
        command: fakeClaude,
        cwd: input.cwd,
        model: 'claude-opus-4-8',
        timeoutMs: 20_000,
      }),
    },
  });
  openSessions.push(() => manager.closeAll());
  const session = await manager.create({ runtime: 'claude' });
  const startedAt = Date.now();
  const slow = await manager.runTurn(session.id, { input: 'SLOW' }, { timeoutMs: 300 });
  assert.equal(slow.status, 'completed');
  assert.equal(slow.final.text, '0 1 2 3 4 5 ');
  assert.ok(Date.now() - startedAt >= 600, `the turn ran its whole length: ${Date.now() - startedAt} ms`);
  const silentAt = Date.now();
  const partial = await manager.runTurn(session.id, { input: 'PARTIAL' }, { timeoutMs: 300 });
  assert.equal(partial.status, 'error');
  assert.match(partial.events.at(-1).raw.message, /aborted/, 'the manager\'s deadline answers, on both runtimes (t1 B-res)');
  assert.ok(Date.now() - silentAt < 1000, `silence ended at the budget: ${Date.now() - silentAt} ms`);
});

test('an interrupted claude turn leaves a session that still answers', { timeout: 20_000 }, async () => {
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

test('an abandoned turn does not release the turn that replaced it', { timeout: 20_000 }, async () => {
  // A stream nobody is reading finalizes late — after its turn was interrupted
  // and the next one started. The session's status is shared, so an ownerless
  // reset there hands the running turn's slot to whoever asks next, and two
  // turns then run on one thread.
  process.env.FAKE_CODEX_NO_TURN_COMPLETION = '1';
  const { manager } = await startCodexManager();
  const session = await manager.create({ runtime: 'codex' });

  const abandoned = manager.streamTurn(session.id, { input: 'hello' })[Symbol.asyncIterator]();
  await abandoned.next();
  await manager.interrupt(session.id);

  const replacement = manager.streamTurn(session.id, { input: 'hello again' })[Symbol.asyncIterator]();
  await replacement.next();
  assert.equal(manager.get(session.id).status, 'running');

  // The abandoned stream is torn down now, the way the HTTP layer tears down
  // the response it belonged to.
  await abandoned.return();

  assert.equal(
    manager.get(session.id).status,
    'running',
    'the replacement still owns the session',
  );
  // Admission is decided at the call, before anything is committed (r55-codex).
  assert.throws(
    () => manager.streamTurn(session.id, { input: 'third' }),
    /already has a running turn/i,
    'a third turn must still be refused while the replacement runs',
  );
  await replacement.return();
});

test('a claude turn whose caller left before it started writes nothing to the child', { timeout: 20_000 }, async () => {
  // The prompt is assembled asynchronously — a path-based image is file I/O —
  // and the child can be replaced while that runs. Writing afterwards sends the
  // abandoned turn's prompt down a pipe that belongs to nobody: either a killed
  // child's stdin, whose EPIPE has no listener, or the replacement's.
  const cwd = await mkdtemp(join(tmpdir(), 'interrupt-claude-cwd-'));
  tempDirs.push(cwd);
  const imagePath = join(cwd, 'pixel.png');
  await writeFile(imagePath, Buffer.from('89504e470d0a1a0a', 'hex'));
  const session = await ClaudeNativeCliChatSession.create({
    command: fakeClaude,
    cwd,
    model: 'claude-opus-4-8',
    timeoutMs: 20_000,
  });
  openSessions.push(() => session.close());

  const controller = new AbortController();
  const turn = session.startTurn({
    input: [
      { type: 'image', source: { type: 'path', path: imagePath } },
      { type: 'text', text: 'describe it' },
    ],
  }, controller.signal)[Symbol.asyncIterator]();
  const first = turn.next();
  // Synchronously, while the body is suspended reading the image.
  controller.abort();
  await assert.rejects(first, /abort|interrupt/i);

  assert.equal(await turnText(session, 'Say OK'), 'OK', 'the session still answers');
});

test('an interrupted claude turn cannot time out the turn that replaced it', { timeout: 20_000 }, async () => {
  // A turn's deadline belongs to that turn. An abandoned generator never
  // reaches its `finally`, so the interrupt that retires it leaves the timer
  // armed — and the callback retired whatever turn was active when it fired,
  // child and all.
  const cwd = await mkdtemp(join(tmpdir(), 'interrupt-claude-cwd-'));
  tempDirs.push(cwd);
  const session = await ClaudeNativeCliChatSession.create({
    command: fakeClaude,
    cwd,
    model: 'claude-opus-4-8',
    timeoutMs: 1_000,
  });
  openSessions.push(() => session.close());

  // Pulled once and then left alone: the generator is suspended at a yield, so
  // failing its queue does not resume it and its `finally` never runs. A reader
  // that is merely awaiting the next event WOULD resume and clear the timer, so
  // this state is the one the finding is about.
  const abandoned = session.startTurn({ input: 'PARTIAL' })[Symbol.asyncIterator]();
  await abandoned.next();
  // Late in the abandoned turn's budget, so its stale deadline fires well
  // before the replacement's own — otherwise the replacement timing out on
  // schedule would look exactly like the defect.
  await delay(800);
  await session.interrupt();

  const replacement = session.startTurn({ input: 'HANG' })[Symbol.asyncIterator]();
  let replacementEnded = null;
  replacement.next().then(
    () => { replacementEnded = 'resolved'; },
    (err) => { replacementEnded = err; },
  );

  // Past the abandoned turn's deadline (1000ms from its start), and 600ms short
  // of the replacement's own.
  await delay(400);
  assert.equal(
    replacementEnded,
    null,
    `the replacement turn was failed by an abandoned turn's deadline: ${replacementEnded}`,
  );
  // The signature of the defect is not an error — it is silence. The stale
  // callback clears whatever turn is active and replaces the child, and the
  // exit of a child nobody is tracking fails nothing, so the replacement just
  // never answers. What proves it survived is that it still owns the session.
  await assert.rejects(
    (async () => {
      for await (const _event of session.startTurn({ input: 'Say OK' })) break;
    })(),
    /already has a running turn/i,
    'the replacement must still hold the session after the stale deadline',
  );
});

test('a completed turn nobody read cannot time out the turn after it', { timeout: 20_000 }, async () => {
  // The other way a turn ends without its generator finishing: the child
  // answered, `handleLine` closed the queue and retired the turn, but the
  // reader had stopped advancing — so `startTurn`'s `finally`, the other place
  // the deadline is cleared, never ran. Retiring a turn has to take its
  // deadline with it wherever the turn ends.
  const cwd = await mkdtemp(join(tmpdir(), 'interrupt-claude-cwd-'));
  tempDirs.push(cwd);
  const session = await ClaudeNativeCliChatSession.create({
    command: fakeClaude,
    cwd,
    model: 'claude-opus-4-8',
    timeoutMs: 1_000,
  });
  openSessions.push(() => session.close());

  const finished = session.startTurn({ input: 'Say OK' })[Symbol.asyncIterator]();
  await finished.next();
  await delay(800);

  const replacement = session.startTurn({ input: 'HANG' })[Symbol.asyncIterator]();
  let replacementEnded = null;
  replacement.next().then(
    () => { replacementEnded = 'resolved'; },
    (err) => { replacementEnded = err; },
  );
  // Past the finished turn's deadline, far short of the replacement's own.
  await delay(400);

  assert.equal(replacementEnded, null, `the replacement was failed by a finished turn's deadline: ${replacementEnded}`);
  await assert.rejects(
    (async () => {
      for await (const _event of session.startTurn({ input: 'Say OK' })) break;
    })(),
    /already has a running turn/i,
    'the replacement must still hold the session',
  );
});

const PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('an interrupt while the input is being prepared keeps the turn off the child', { timeout: 20_000 }, async () => {
  // Preparing the input is file I/O — a temp file per image — and it happens
  // before the child is asked for anything. A turn that cannot be seen during
  // that window cannot be stopped there either: the interrupt answered `200`
  // while the turn went on to start on the child and run to completion.
  const { manager, methodLog } = await startCodexManager();
  const session = await manager.create({ runtime: 'codex' });
  const stream = manager.streamTurn(session.id, {
    input: [
      { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: PIXEL_PNG } },
      { type: 'text', text: 'describe it' },
    ],
  })[Symbol.asyncIterator]();
  // The generator body runs to its first await — preparing the input — so the
  // interrupt lands inside that window.
  const first = stream.next();

  await manager.interrupt(session.id);
  const event = await first;

  assert.equal(event.value?.event, 'cli.error', `the turn ends for its caller: ${JSON.stringify(event)}`);
  assert.deepEqual(
    (await receivedMethods(methodLog)).filter((method) => method === 'turn/start'),
    [],
    'a turn stopped before it was sent must never reach the child',
  );
});

test('a close while the input is being prepared keeps the turn off the child being archived (r55-fable)', { timeout: 20_000 }, async () => {
  // The same window, closed by a DELETE instead of a stop. The child lives
  // through the archive's grace — up to two seconds — and a turn whose input
  // finished preparing inside it was sent to that child: `turn/start` after
  // `thread/archive`, real work on a deleted session's credentials. The close
  // stops the turn it finds, and the turn re-checks that before it writes.
  process.env.FAKE_CODEX_ARCHIVE_DELAY_MS = '900';
  const { manager, methodLog } = await startCodexManager();
  const session = await manager.create({ runtime: 'codex' });
  const stream = manager.streamTurn(session.id, {
    input: [
      { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: PIXEL_PNG } },
      { type: 'text', text: 'describe it' },
    ],
  })[Symbol.asyncIterator]();
  const first = stream.next();

  const closed = await manager.close(session.id);
  assert.equal(closed.status, 'closed');
  const event = await first;
  assert.equal(event.value?.event, 'cli.error', `the turn ends for its caller: ${JSON.stringify(event)}`);
  await delay(100);
  const methods = await receivedMethods(methodLog);
  assert.equal(methods.filter((method) => method === 'thread/archive').length, 1, 'the close archived the thread');
  assert.deepEqual(methods.filter((method) => method === 'turn/start'), [], 'a turn stopped by the close must never reach the child');
});

test('a session survives an interrupt whose runtime stop throws', { timeout: 20_000 }, async () => {
  // One route to stopping means one route to failing. Leaving the status at
  // `running` because the runtime threw answers every later turn with 409 for
  // the life of the process.
  const manager = new LocalCliChatSessionManager({
    defaultCwd: process.cwd(),
    runtimes: {
      codex: async () => ({
        runtime: 'codex',
        native: {},
        busy: false,
        async *startTurn() {
          this.busy = true;
          try {
            yield { raw: { method: 'item/agentMessage/delta' }, textDelta: 'hi' };
            // Still running: the turn has to be live when the interrupt fails, or
            // the status this is about was already restored by its own stream.
            await new Promise(() => {});
          } finally {
            this.busy = false;
          }
        },
        async interrupt() {
          throw new Error('the pipe died under the interrupt');
        },
        isBusy() { return this.busy; },
        async close() {},
      }),
    },
  });
  openSessions.push(() => manager.closeAll());
  const session = await manager.create({ runtime: 'codex' });
  const running = manager.streamTurn(session.id, { input: 'one' })[Symbol.asyncIterator]();
  await running.next();
  assert.equal(manager.get(session.id).status, 'running');

  await assert.rejects(manager.interrupt(session.id), /pipe died/);

  assert.equal(manager.get(session.id).status, 'ready', 'the session is not wedged');
  const next = manager.streamTurn(session.id, { input: 'two' })[Symbol.asyncIterator]();
  const first = await next.next();
  assert.equal(first.value?.event, 'cli.event', 'a later turn is admitted');
});

test('a turn that is still starting already occupies the session', { timeout: 20_000 }, async () => {
  // Occupancy used to begin at the child's acknowledgement, so a second turn
  // could be dispatched into the same window and overwrite the first turn's
  // stop — leaving the first stoppable and the second not.
  const { manager } = await startCodexManager();
  const created = await manager.create({ runtime: 'codex' });
  const cwd = process.cwd();
  const session = await CodexNativeCliChatSession.create({ command: fakeCodex, cwd, timeoutMs: 20_000 });
  openSessions.push(() => session.close());
  void created;

  const first = session.startTurn({ input: 'hello' })[Symbol.asyncIterator]();
  void first.next().catch(() => undefined);

  await assert.rejects(
    (async () => {
      for await (const _event of session.startTurn({ input: 'again' })) break;
    })(),
    /already has a running turn/i,
  );
  await session.interrupt();
});

test('an interrupted turn does not report its tail as the next turn', { timeout: 20_000 }, async () => {
  // A child keeps talking for a moment after being told to stop, and what it
  // says without a turn id used to be held and replayed into whatever turn came
  // next — reported as that turn's events, and its usage.
  process.env.FAKE_CODEX_NO_TURN_COMPLETION = '1';
  process.env.FAKE_CODEX_TRAILING_NOTIFICATION = '1';
  const { manager } = await startCodexManager();
  const session = await manager.create({ runtime: 'codex' });
  const abandoned = manager.streamTurn(session.id, { input: 'hello' })[Symbol.asyncIterator]();
  await abandoned.next();
  await manager.interrupt(session.id);
  await delay(100);

  delete process.env.FAKE_CODEX_NO_TURN_COMPLETION;
  const next = [];
  for await (const event of manager.streamTurn(session.id, { input: 'DEBUG_PAYLOAD' })) next.push(event);

  assert.equal(next.at(-1).event, 'cli.completed');
  assert.equal(
    next.some((event) => event.usage?.totalTokens === 999),
    false,
    `the interrupted turn's tail was reported as this turn's: ${JSON.stringify(next.map((e) => e.usage))}`,
  );
});

test('an abandoned turn\'s deadline cannot reach the turn after it', { timeout: 20_000 }, async () => {
  // The manager's idle deadline lived only in the stream's `finally`, which an
  // abandoned reader never reaches: it stayed armed for the whole budget and
  // then aborted a signal whose turn was long over, stopping whoever was
  // running by then.
  process.env.FAKE_CODEX_NO_TURN_COMPLETION = '1';
  const { manager } = await startCodexManager();
  const session = await manager.create({ runtime: 'codex' });
  const abandoned = manager.streamTurn(session.id, { input: 'hello' }, { timeoutMs: 400 })[Symbol.asyncIterator]();
  await abandoned.next();
  await manager.interrupt(session.id);

  delete process.env.FAKE_CODEX_NO_TURN_COMPLETION;
  const replacement = manager.streamTurn(session.id, { input: 'DEBUG_PAYLOAD' })[Symbol.asyncIterator]();
  await replacement.next();
  // Past the abandoned turn's deadline.
  await delay(600);

  const events = [];
  let event = await replacement.next();
  while (!event.done) {
    events.push(event.value);
    event = await replacement.next();
  }
  assert.equal(
    events.at(-1)?.event,
    'cli.completed',
    `the replacement was stopped by an abandoned turn's deadline: ${JSON.stringify(events.at(-1))}`,
  );
});

test('an abandoned turn\'s abort cannot stop the turn that replaced it', { timeout: 20_000 }, async () => {
  // A turn's abort listener is removed in its generator's `finally`, which an
  // abandoned reader never reaches — so the listener outlives the turn. The
  // manager's own idle deadline for that abandoned turn fires exactly this
  // signal, and without an identity check it stopped whoever was running then.
  const cwd = await mkdtemp(join(tmpdir(), 'interrupt-claude-cwd-'));
  tempDirs.push(cwd);
  const session = await ClaudeNativeCliChatSession.create({
    command: fakeClaude,
    cwd,
    model: 'claude-opus-4-8',
    timeoutMs: 20_000,
  });
  openSessions.push(() => session.close());

  const controller = new AbortController();
  const abandoned = session.startTurn({ input: 'PARTIAL' }, controller.signal)[Symbol.asyncIterator]();
  await abandoned.next();
  await session.interrupt();

  const replacement = session.startTurn({ input: 'HANG' })[Symbol.asyncIterator]();
  let replacementEnded = null;
  replacement.next().then(
    () => { replacementEnded = 'resolved'; },
    (err) => { replacementEnded = err; },
  );
  await delay(100);

  controller.abort();
  await delay(200);

  assert.equal(replacementEnded, null, `a stale abort stopped the running turn: ${replacementEnded}`);
  await assert.rejects(
    (async () => {
      for await (const _event of session.startTurn({ input: 'Say OK' })) break;
    })(),
    /already has a running turn/i,
    'the replacement must still hold the session',
  );
});

test('closing a session tells a streaming caller its turn ended, not that it finished', { timeout: 20_000 }, async () => {
  // A closed queue reads as a turn that completed: the caller was handed an
  // answer that was never produced, indistinguishable from a real one.
  const cwd = await mkdtemp(join(tmpdir(), 'interrupt-claude-cwd-'));
  tempDirs.push(cwd);
  const session = await ClaudeNativeCliChatSession.create({
    command: fakeClaude,
    cwd,
    model: 'claude-opus-4-8',
    timeoutMs: 20_000,
  });
  const streaming = session.startTurn({ input: 'HANG' })[Symbol.asyncIterator]();
  const pending = streaming.next();
  // Past the prompt write, so the turn is parked on its queue — otherwise the
  // close races the write and the cancellation guard there answers first,
  // which says nothing about how a closed queue reads.
  await delay(100);

  // The rejection is expected before the close is awaited: the close now
  // spans the child's exit (t1 B-child gap 6), and a rejection left without a
  // handler across that wait is the process's, not this test's.
  const ended = assert.rejects(pending, /session closed/i);
  await session.close();
  await ended;
});

test('a reservation whose reader cancels before the first read is released: the session answers ready and the next turn runs (t1 B-res, gap 1)', { timeout: 20_000 }, async () => {
  // Admission is at the call; the reader may never read. An async generator's
  // `finally` does not run for a `return()` before its first `next()`, so the
  // slot taken at admission was held for the session's life — every later turn
  // a 409 (r56-codex, on the round-55 synchronous admission).
  const { manager, session, state } = await countingManager();
  const iterator = manager.streamTurn(session.id, { input: 'reserved, never read' })[Symbol.asyncIterator]();
  assert.equal(manager.get(session.id).status, 'running', 'admitted at the call');
  assert.deepEqual(await iterator.return(), { done: true, value: undefined });
  assert.equal(manager.get(session.id).status, 'ready', 'a reader that cancelled holds nothing');
  const second = await manager.runTurn(session.id, { input: 'second' });
  assert.equal(second.status, 'completed');
  assert.equal(state.starts, 1, 'only the second turn reached the runtime');
});

test('a deadline that fires on a reservation nobody read releases it: the session answers ready, and the stale iterable dispatches nothing (t1 B-res, gap 1)', { timeout: 20_000 }, async () => {
  const { manager, session, state } = await countingManager();
  const iterable = manager.streamTurn(session.id, { input: 'reserved, never read' }, { timeoutMs: 50 });
  await waitFor(() => manager.get(session.id).status === 'ready', 1_000, 'the deadline to release the reservation');
  const events = [];
  for await (const event of iterable) events.push(event.event);
  assert.deepEqual(events, ['cli.error'], 'the stale reader hears the end and nothing else');
  assert.equal(state.starts, 0, 'nothing was dispatched for the timed-out reservation');
  const second = await manager.runTurn(session.id, { input: 'second' });
  assert.equal(second.status, 'completed');
  assert.equal(state.starts, 1);
});

test('an interrupt before the first read ends the turn: nothing is dispatched, the reader hears the stop, the session answers ready (t1 B-res, gap 2)', { timeout: 20_000 }, async () => {
  // Between admission and the first read the runtime has no turn, so its
  // interrupt found nothing, and the reservation's signal was not fired because
  // the runtime implements `interrupt`: the endpoint answered `ready` and the
  // turn it said it stopped ran on the next read (r56-codex).
  const { manager, session, state } = await countingManager();
  const iterable = manager.streamTurn(session.id, { input: 'admitted then interrupted' });
  assert.equal(manager.get(session.id).status, 'running');
  const snapshot = await manager.interrupt(session.id);
  assert.equal(snapshot.status, 'ready');
  const events = [];
  for await (const event of iterable) events.push(event);
  assert.equal(events.length, 1, JSON.stringify(events));
  assert.equal(events[0].event, 'cli.error');
  assert.match(String(events[0].raw?.message), /aborted/);
  assert.equal(state.starts, 0, 'the turn the endpoint said it stopped never ran');
  assert.equal(manager.get(session.id).status, 'ready');
});

test('a stop while turn/start is in flight ends the caller within the stop, not at the acknowledgement — and still precedes the next turn on the child (t1 B-res, gap 4)', { timeout: 20_000 }, async () => {
  // The stop failed the turn's queue, but the caller was parked in the
  // `turn/start` RPC, not on the queue: it heard the stop only when the child
  // acknowledged the start — a whole RPC budget against a child that never
  // does (r56-codex). What must not move is the order on the child: the
  // interrupt is written before the next turn's start.
  process.env.FAKE_CODEX_TURN_START_DELAY_MS = '800';
  process.env.FAKE_CODEX_NO_TURN_COMPLETION = '1';
  const { manager, methodLog } = await startCodexManager(2_000);
  const session = await manager.create({ runtime: 'codex' });
  delete process.env.FAKE_CODEX_TURN_START_DELAY_MS;
  delete process.env.FAKE_CODEX_NO_TURN_COMPLETION;
  const stream = manager.streamTurn(session.id, { input: 'slow acknowledgement' })[Symbol.asyncIterator]();
  const pending = stream.next();
  await waitFor(async () => (await receivedMethods(methodLog)).includes('turn/start'), 2_000, 'turn/start to reach the child');
  const stoppedAt = Date.now();
  await manager.interrupt(session.id);
  const first = await pending;
  const callerMs = Date.now() - stoppedAt;
  assert.equal(first.value?.event, 'cli.error', JSON.stringify(first));
  assert.ok(callerMs < 300, `the caller hears the stop within the stop, not at the child's acknowledgement (${callerMs}ms)`);
  assert.equal(manager.get(session.id).status, 'running', 'the session stays occupied until the child has been told');
  assert.throws(() => manager.streamTurn(session.id, { input: 'too soon' }), /already has a running turn/);
  await waitFor(() => manager.get(session.id).status === 'ready', 3_000, 'the acknowledgement to retire the turn');
  const second = await manager.runTurn(session.id, { input: 'after the stop' }, { timeoutMs: 500 });
  assert.equal(second.status, 'error', 'the fake never completes a turn; the deadline ends it');
  const methods = (await receivedMethods(methodLog)).filter((m) => m === 'turn/start' || m === 'turn/interrupt');
  assert.deepEqual(methods.slice(0, 3), ['turn/start', 'turn/interrupt', 'turn/start'], `the interrupt precedes the next start: ${methods.join(',')}`);
});

test('a stop that lands between two reads still closes the runtime\'s iteration: a runtime that retires in its finally is retired, even for a reader that never reads again (t1 r1-codex F1)', { timeout: 20_000 }, async () => {
  // Between reads the runtime's generator is suspended at its `yield`; a stop
  // that only answered the caller left it there for good, and a runtime whose
  // retirement lives in `finally` held the session at 409 for its life.
  let release;
  const stopped = new Promise((resolve) => { release = resolve; });
  const state = { busy: false, finalizers: 0, starts: 0 };
  const manager = new LocalCliChatSessionManager({
    defaultCwd: process.cwd(),
    runtimes: {
      codex: async () => ({
        runtime: 'codex',
        native: {},
        async *startTurn() {
          state.starts += 1;
          state.busy = true;
          try {
            yield { raw: { stage: 'first' }, textDelta: 'one' };
            await stopped;
            throw new Error('runtime interrupted');
          } finally {
            state.busy = false;
            state.finalizers += 1;
          }
        },
        async interrupt() { release(); },
        isBusy() { return state.busy; },
        async close() { release(); },
      }),
    },
  });
  openSessions.push(() => manager.closeAll());
  const session = await manager.create({ runtime: 'codex' });
  const iterator = manager.streamTurn(session.id, { input: 'first' })[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value?.event, 'cli.event');
  await manager.interrupt(session.id);
  // Nobody reads again. The runtime must still be retired.
  await waitFor(() => state.finalizers === 1, 1_000, 'the runtime generator to be finalized by the stop');
  assert.equal(manager.get(session.id).status, 'ready', 'the runtime retired in its finally, and the session is free');
  const events = [];
  for await (const event of { [Symbol.asyncIterator]: () => iterator }) events.push(event.event);
  assert.deepEqual(events, ['cli.error'], 'the walked-away reader, coming back, hears the stop once');
  const second = await manager.runTurn(session.id, { input: 'second' });
  assert.equal(second.status, 'error', 'the double ends every turn by throwing after its stop');
  assert.equal(state.starts, 2, 'the next turn was admitted');
});

test('a runtime whose interrupt acknowledges late keeps the session occupied until it does: 409 in the window, ready after — the runtime answers, the manager keeps no fallback lifetime (t1 r1-codex F2)', { timeout: 20_000 }, async () => {
  let ack; const stopAck = new Promise((resolve) => { ack = resolve; });
  let releaseTurn; const turnReleased = new Promise((resolve) => { releaseTurn = resolve; });
  // A runtime that counts itself occupied until its stop is acknowledged
  // says so through `isBusy` — the manager keeps no fallback for it, and its
  // generator may be returned by the stop before the acknowledgement.
  const state = { open: false, stopping: false, finalizers: 0 };
  const manager = new LocalCliChatSessionManager({
    defaultCwd: process.cwd(),
    runtimes: {
      codex: async () => ({
        runtime: 'codex',
        native: {},
        async *startTurn() {
          if (state.open || state.stopping) throw new Error('runtime already has a running turn');
          state.open = true;
          try {
            yield { raw: { stage: 'first' }, textDelta: 'one' };
            await turnReleased;
            throw new Error('runtime interrupted');
          } finally {
            state.open = false;
            state.finalizers += 1;
          }
        },
        async interrupt() {
          state.stopping = true;
          try {
            await stopAck;
            releaseTurn();
          } finally {
            state.stopping = false;
          }
        },
        isBusy() { return state.open || state.stopping; },
        async close() { ack(); releaseTurn(); },
      }),
    },
  });
  openSessions.push(() => manager.closeAll());
  const session = await manager.create({ runtime: 'codex' });
  const first = manager.streamTurn(session.id, { input: 'first' })[Symbol.asyncIterator]();
  assert.equal((await first.next()).value?.event, 'cli.event');
  const pending = first.next();
  const interrupting = manager.interrupt(session.id);
  await delay(20);
  assert.equal(manager.get(session.id).status, 'running', 'the runtime has not acknowledged the stop');
  assert.throws(() => manager.streamTurn(session.id, { input: 'second' }), /already has a running turn/);
  ack();
  await interrupting;
  assert.equal((await pending).value?.event, 'cli.error');
  await waitFor(() => manager.get(session.id).status === 'ready', 1_000, 'the runtime to retire the turn');
  assert.equal(state.finalizers, 1);
});

for (const terminal of ['completed', 'error']) {
  for (const route of ['interrupt', 'close', 'deadline']) {
    test(`a stop that lands after the terminal event (${terminal}) and before the read after it appends nothing: the terminal event is the end (route: ${route}) (t1 r1-codex F3)`, { timeout: 20_000 }, async () => {
      // The HTTP loop awaits the terminal SSE write before it reads again;
      // an interrupt racing that write, or a deadline outlasting it, found the
      // reservation still attached and appended a second terminal event.
      const state = { busy: false, interrupts: 0 };
      const manager = new LocalCliChatSessionManager({
        defaultCwd: process.cwd(),
        runtimes: {
          codex: async () => ({
            runtime: 'codex',
            native: {},
            async *startTurn() {
              state.busy = true;
              try {
                if (terminal === 'error') throw new Error('runtime failed');
              } finally {
                state.busy = false;
              }
            },
            async interrupt() { state.interrupts += 1; },
            isBusy() { return state.busy; },
            async close() {},
          }),
        },
      });
      openSessions.push(() => manager.closeAll());
      const session = await manager.create({ runtime: 'codex' });
      const iterator = manager.streamTurn(session.id, { input: 'x' }, route === 'deadline' ? { timeoutMs: 20 } : {})[Symbol.asyncIterator]();
      const first = await iterator.next();
      assert.equal(first.value?.event, terminal === 'completed' ? 'cli.completed' : 'cli.error', JSON.stringify(first));
      if (terminal === 'error') assert.match(String(first.value.raw?.message), /runtime failed/);
      assert.equal(manager.get(session.id).status, 'ready', 'the terminal event released the slot');
      if (route === 'interrupt') await manager.interrupt(session.id);
      else if (route === 'close') assert.equal((await manager.close(session.id)).status, 'closed');
      else await delay(60);
      const after = await iterator.next();
      assert.deepEqual(after, { done: true, value: undefined }, `no second terminal event: ${JSON.stringify(after)}`);
      assert.deepEqual(await iterator.next(), { done: true, value: undefined });
    });
  }
}

test('a turn admitted before the close and read after it hears the close on the claude runtime too (t1 B-res, two paths)', { timeout: 20_000 }, async () => {
  // The codex runtime answered "closed" here (r55-fable); the claude runtime
  // answered "not running" — a different fact for the same sequence.
  const cwd = await mkdtemp(join(tmpdir(), 'interrupt-claude-cwd-'));
  tempDirs.push(cwd);
  const manager = new LocalCliChatSessionManager({
    defaultCwd: cwd,
    runtimes: {
      claude: async (input) => ClaudeNativeCliChatSession.create({ command: fakeClaude, cwd: input.cwd, model: 'claude-opus-4-8', timeoutMs: 2_000 }),
    },
  });
  openSessions.push(() => manager.closeAll());
  const session = await manager.create({ runtime: 'claude' });
  const stream = manager.streamTurn(session.id, { input: 'admitted first' })[Symbol.asyncIterator]();
  const closed = await manager.close(session.id);
  assert.equal(closed.status, 'closed');
  const event = await stream.next();
  assert.equal(event.value?.event, 'cli.error', JSON.stringify(event));
  assert.match(String(event.value.raw?.message), /session closed/, 'the close is the reason — not "not running"');
  assert.equal((await stream.next()).done, true);
});

/** A manager over an in-process runtime that only counts what it was asked. */
async function countingManager() {
  const state = { starts: 0, interrupts: 0, closes: 0 };
  const manager = new LocalCliChatSessionManager({
    defaultCwd: process.cwd(),
    runtimes: {
      codex: async () => ({
        runtime: 'codex',
        native: {},
        busy: false,
        async *startTurn() {
          state.starts += 1;
          this.busy = true;
          try {
            yield { raw: { method: 'item/agentMessage/delta' }, textDelta: 'ok' };
          } finally {
            this.busy = false;
          }
        },
        async interrupt() { state.interrupts += 1; },
        isBusy() { return this.busy; },
        async close() { state.closes += 1; },
      }),
    },
  });
  openSessions.push(() => manager.closeAll());
  const session = await manager.create({ runtime: 'codex' });
  return { manager, session, state };
}

/** Polls a condition instead of sleeping for it: the bound is on the wait, not on the timing. */
async function waitFor(check, timeoutMs = 3_000, what = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(10);
  }
}

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

// ---------------------------------------------------------------------------
// Track 1, bundle B-child: the child handle and the abandoned turn (gaps 3, 6, 7).

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Kills a fixture child this test spawned — by the pid it published, never by name. */
function reapFixtureChild(pid) {
  if (Number.isSafeInteger(pid) && pid > 1 && processAlive(pid)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}

async function publishedPid(pidFile) {
  await waitFor(() => existsSync(pidFile), 3_000, 'the fixture child to publish its pid');
  const pid = Number(await readFile(pidFile, 'utf8'));
  assert.ok(Number.isSafeInteger(pid) && pid > 1, `the fixture published no safe pid: ${pid}`);
  return pid;
}

/** A manager whose claude runtime is the real session over the fake child. */
async function startClaudeManager(timeoutMs = 20_000) {
  const cwd = await mkdtemp(join(tmpdir(), 'interrupt-claude-cwd-'));
  tempDirs.push(cwd);
  const manager = new LocalCliChatSessionManager({
    defaultCwd: cwd,
    runtimes: {
      claude: async (input) => ClaudeNativeCliChatSession.create({ command: fakeClaude, cwd: input.cwd, model: 'claude-opus-4-8', timeoutMs }),
    },
  });
  openSessions.push(() => manager.closeAll());
  return { manager };
}

test('closing a codex session whose child ignores SIGTERM leaves no child: the close escalates and resolves only after the exit (t1 B-child gap 6)', { timeout: 20_000 }, async () => {
  const pidDir = await mkdtemp(join(tmpdir(), 'interrupt-pid-'));
  tempDirs.push(pidDir);
  process.env.FAKE_CODEX_PID_FILE = join(pidDir, 'pid');
  process.env.FAKE_CODEX_IGNORE_SIGTERM = '1';
  const { manager, methodLog } = await startCodexManager(1_000);
  const session = await manager.create({ runtime: 'codex' });
  const pid = await publishedPid(process.env.FAKE_CODEX_PID_FILE);
  try {
    const closingAt = Date.now();
    const closed = await manager.close(session.id);
    assert.equal(closed.status, 'closed');
    assert.equal(processAlive(pid), false, 'the child is gone when the close resolves');
    assert.ok(Date.now() - closingAt < 4_000, `the close stayed within its bound: ${Date.now() - closingAt} ms`);
    assert.ok((await receivedMethods(methodLog)).includes('thread/archive'), 'the courtesy archive still went first');
  } finally {
    reapFixtureChild(pid);
  }
});

test('closing a claude session whose child ignores SIGTERM leaves no child: the close escalates and resolves only after the exit (t1 B-child gap 6)', { timeout: 20_000 }, async () => {
  const pidDir = await mkdtemp(join(tmpdir(), 'interrupt-pid-'));
  tempDirs.push(pidDir);
  process.env.FAKE_CLAUDE_PID_FILE = join(pidDir, 'pid');
  process.env.FAKE_CLAUDE_IGNORE_SIGTERM = '1';
  const { manager } = await startClaudeManager(1_000);
  const session = await manager.create({ runtime: 'claude' });
  const pid = await publishedPid(process.env.FAKE_CLAUDE_PID_FILE);
  try {
    const closingAt = Date.now();
    const closed = await manager.close(session.id);
    assert.equal(closed.status, 'closed');
    assert.equal(processAlive(pid), false, 'the child is gone when the close resolves');
    assert.ok(Date.now() - closingAt < 4_000, `the close stayed within its bound: ${Date.now() - closingAt} ms`);
  } finally {
    reapFixtureChild(pid);
  }
});

test('a codex child replaced after ignoring SIGTERM has exited before its successor serves a turn: the replacement is serialized behind the exit (t1 B-child gap 6)', { timeout: 20_000 }, async () => {
  const pidDir = await mkdtemp(join(tmpdir(), 'interrupt-pid-'));
  tempDirs.push(pidDir);
  process.env.FAKE_CODEX_PID_FILE = join(pidDir, 'pid');
  process.env.FAKE_CODEX_IGNORE_SIGTERM = '1';
  process.env.FAKE_CODEX_TURN_START_DELAY_MS = '650';
  process.env.FAKE_CODEX_NO_TURN_COMPLETION = '1';
  const { manager, methodLog } = await startCodexManager(300);
  const session = await manager.create({ runtime: 'codex' });
  const oldPid = await publishedPid(process.env.FAKE_CODEX_PID_FILE);
  // The child already spawned keeps its environment; its replacement will not.
  delete process.env.FAKE_CODEX_IGNORE_SIGTERM;
  delete process.env.FAKE_CODEX_TURN_START_DELAY_MS;
  delete process.env.FAKE_CODEX_NO_TURN_COMPLETION;
  try {
    const first = await manager.runTurn(session.id, { input: 'hello' }, { timeoutMs: 2000 });
    assert.equal(first.status, 'error');
    assert.match(first.events.at(-1).raw.message, /turn\/start timed out after 300ms/);
    const second = await manager.runTurn(session.id, { input: 'again' }, { timeoutMs: 3000 });
    assert.equal(second.status, 'completed', 'the next turn ran on the replacement');
    assert.equal(processAlive(oldPid), false, 'the replaced child had exited before its successor served a turn');
    const newPid = Number(await readFile(process.env.FAKE_CODEX_PID_FILE, 'utf8'));
    assert.notEqual(newPid, oldPid, 'a fresh child');
    assert.equal((await receivedMethods(methodLog)).filter((method) => method === 'thread/start').length, 2, 'a fresh thread on the fresh child');
  } finally {
    reapFixtureChild(oldPid);
  }
});

test('a codex session whose replacement failed names no thread, tries again on the next turn, and runs once the child can start: a session that answers ready can be asked (t1 B-child gap 3)', { timeout: 20_000 }, async () => {
  process.env.FAKE_CODEX_TURN_START_DELAY_MS = '650';
  process.env.FAKE_CODEX_NO_TURN_COMPLETION = '1';
  const { manager, methodLog } = await startCodexManager(300);
  const session = await manager.create({ runtime: 'codex' });
  delete process.env.FAKE_CODEX_TURN_START_DELAY_MS;
  delete process.env.FAKE_CODEX_NO_TURN_COMPLETION;
  assert.equal(manager.get(session.id).native.thread_id, 'thread_1', 'the live child\'s thread is named');
  // Slower than the RPC budget: the replacement's `initialize` times out.
  process.env.FAKE_CODEX_INITIALIZE_DELAY_MS = '850';
  const first = await manager.runTurn(session.id, { input: 'hello' }, { timeoutMs: 2000 });
  assert.equal(first.status, 'error');
  assert.match(first.events.at(-1).raw.message, /turn\/start timed out after 300ms/);
  // Let the replacement fail: its `initialize` is received, then the budget expires.
  await waitFor(async () => (await receivedMethods(methodLog)).filter((method) => method === 'initialize').length === 2, 3_000, 'the replacement to start its handshake');
  await delay(600);
  const afterFailure = manager.get(session.id);
  assert.equal(afterFailure.status, 'ready', 'a turn will be attempted');
  assert.equal(afterFailure.native.thread_id, undefined, 'no thread is named while no child holds one');
  // The next turn makes one attempt of its own — and reports that attempt's failure.
  const second = await manager.runTurn(session.id, { input: 'again' }, { timeoutMs: 3000 });
  assert.equal(second.status, 'error');
  assert.match(second.events.at(-1).raw.message, /initialize timed out after 300ms/, 'the turn reports why the child could not start');
  assert.equal((await receivedMethods(methodLog)).filter((method) => method === 'initialize').length, 3, 'one attempt per turn');
  assert.equal(manager.get(session.id).native.thread_id, undefined);
  // The fault clears: the next turn starts a child, a fresh thread, and runs.
  delete process.env.FAKE_CODEX_INITIALIZE_DELAY_MS;
  const third = await manager.runTurn(session.id, { input: 'once more' }, { timeoutMs: 3000 });
  assert.equal(third.status, 'completed', JSON.stringify(third.final));
  assert.match(third.final.text, /OK$/);
  // A fresh child counts its threads from one again: what says it is fresh is the second `thread/start` below.
  assert.equal(manager.get(session.id).native.thread_id, 'thread_1', 'the fresh child\'s thread is named');
  const methods = await receivedMethods(methodLog);
  assert.equal(methods.filter((method) => method === 'initialize').length, 4);
  assert.equal(methods.filter((method) => method === 'thread/start').length, 2);
});

test('a claude session whose child died starts one for the next turn: the session that answers ready can be asked (t1 B-child gap 3)', { timeout: 20_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'interrupt-claude-cwd-'));
  tempDirs.push(cwd);
  const session = await ClaudeNativeCliChatSession.create({ command: fakeClaude, cwd, model: 'claude-opus-4-8', timeoutMs: 2_000 });
  openSessions.push(() => session.close());
  await assert.rejects(turnText(session, 'EXIT'), /claude code exited/);
  assert.equal(session.isBusy(), false);
  assert.equal(await turnText(session, 'Say OK'), 'OK', 'the next turn ran on a child started for it');
});

test('a claude turn whose reader walked away without a stop is the session\'s until its result: the next turn is refused meanwhile and never receives it (t1 B-child gap 7)', { timeout: 20_000 }, async () => {
  const { manager } = await startClaudeManager(2_000);
  const session = await manager.create({ runtime: 'claude' });
  let writerError;
  try {
    for await (const event of manager.streamTurn(session.id, { input: 'LATE_RESULT' })) {
      if (event.event === 'cli.event') throw new Error('writeSseEvent failed');
    }
  } catch (err) {
    writerError = err.message;
  }
  assert.equal(writerError, 'writeSseEvent failed');
  assert.equal(manager.get(session.id).status, 'running', 'the turn outlives its caller');
  assert.throws(() => manager.streamTurn(session.id, { input: 'DELAYED' }), /running turn/, 'refused, not dispatched on top of it');
  await waitFor(() => manager.get(session.id).status === 'ready', 3_000, 'the abandoned turn to reach its result');
  const second = await manager.runTurn(session.id, { input: 'DELAYED' }, { timeoutMs: 2_000 });
  assert.equal(second.status, 'completed', JSON.stringify(second.final));
  assert.equal(second.final.text, 'DELAYED_REAL');
  const results = second.events.map((event) => event.raw).filter((raw) => raw?.type === 'result').map((raw) => raw.result);
  assert.deepEqual(results, ['DELAYED_REAL'], 'the earlier turn\'s result reached nobody');
});

test('a codex turn whose reader walked away without a stop is the session\'s until it completes: the next turn is refused meanwhile and its completion is its own (t1 B-child gap 7)', { timeout: 20_000 }, async () => {
  process.env.FAKE_CODEX_TURN_COMPLETION_DELAY_MS = '300';
  const { manager, methodLog } = await startCodexManager();
  const session = await manager.create({ runtime: 'codex' });
  let writerError;
  try {
    for await (const event of manager.streamTurn(session.id, { input: 'hello' })) {
      if (event.event === 'cli.event') throw new Error('writeSseEvent failed');
    }
  } catch (err) {
    writerError = err.message;
  }
  assert.equal(writerError, 'writeSseEvent failed');
  assert.equal(manager.get(session.id).status, 'running', 'the turn outlives its caller');
  assert.throws(() => manager.streamTurn(session.id, { input: 'again' }), /running turn/, 'refused, not dispatched on top of it');
  await waitFor(() => manager.get(session.id).status === 'ready', 3_000, 'the abandoned turn to complete');
  const second = await manager.runTurn(session.id, { input: 'again' }, { timeoutMs: 2_000 });
  assert.equal(second.status, 'completed');
  const completions = second.events.map((event) => event.raw).filter((raw) => raw?.method === 'turn/completed').map((raw) => raw.params.turn.id);
  assert.deepEqual(completions, ['turn_2'], 'the second turn ended on its own completion, not the abandoned turn\'s');
  assert.deepEqual((await receivedMethods(methodLog)).filter((method) => method.startsWith('turn/')), ['turn/start', 'turn/start']);
});

test('a codex turn whose reader walked away is ended by the idle deadline the caller gave it, with the child told: the session comes back ready (t1 B-child gap 7)', { timeout: 20_000 }, async () => {
  process.env.FAKE_CODEX_NO_TURN_COMPLETION = '1';
  const { manager, methodLog } = await startCodexManager();
  const session = await manager.create({ runtime: 'codex' });
  let writerError;
  try {
    for await (const event of manager.streamTurn(session.id, { input: 'hello' }, { timeoutMs: 300 })) {
      if (event.event === 'cli.event') throw new Error('writeSseEvent failed');
    }
  } catch (err) {
    writerError = err.message;
  }
  assert.equal(writerError, 'writeSseEvent failed');
  assert.equal(manager.get(session.id).status, 'running', 'the turn outlives its caller');
  await waitFor(async () => (await receivedMethods(methodLog)).filter((method) => method === 'turn/interrupt').length === 1, 3_000, 'the idle deadline to end the abandoned turn on the child');
  await waitFor(() => manager.get(session.id).status === 'ready', 3_000, 'the session to come back');
  assert.deepEqual((await receivedMethods(methodLog)).filter((method) => method.startsWith('turn/')), ['turn/start', 'turn/interrupt']);
});

test('a claude close that lands while a replacement waits for the previous child to exit resolves after that exit, and no successor outlives it (t1 B-child gap 6)', { timeout: 20_000 }, async () => {
  // Cannot fail before B-child: the wait the close lands in is the one the
  // escalating teardown introduced. Pinned here against that head.
  const pidDir = await mkdtemp(join(tmpdir(), 'interrupt-pid-'));
  tempDirs.push(pidDir);
  const pidFile = join(pidDir, 'pid');
  process.env.FAKE_CLAUDE_PID_FILE = pidFile;
  process.env.FAKE_CLAUDE_IGNORE_SIGTERM = '1';
  const { manager } = await startClaudeManager(20_000);
  const session = await manager.create({ runtime: 'claude' });
  const oldPid = await publishedPid(pidFile);
  try {
    const drain = (async () => {
      for await (const _event of manager.streamTurn(session.id, { input: 'HANG' })) { /* the child answers this prompt with nothing */ }
    })();
    await delay(100);
    // The interrupt is a replacement on this runtime: it now waits for the old child's exit — a second, since it ignores SIGTERM.
    await manager.interrupt(session.id);
    await drain.catch(() => undefined);
    const closed = await manager.close(session.id);
    assert.equal(closed.status, 'closed');
    assert.equal(processAlive(oldPid), false, 'the previous child is gone when the close resolves');
    await delay(200);
    assert.equal(Number(await readFile(pidFile, 'utf8')), oldPid, 'no successor was spawned after the close');
  } finally {
    reapFixtureChild(oldPid);
    reapFixtureChild(Number(await readFile(pidFile, 'utf8').catch(() => '0')));
  }
});

test('a closed claude session starts no child for a turn asked of it: the turn is refused as closed (t1 B-child gap 3)', { timeout: 20_000 }, async () => {
  // Restart on demand must not outlive the close: a turn asked of a closed
  // session directly — the manager refuses one before it gets here — would
  // otherwise start a child nobody closes.
  const pidDir = await mkdtemp(join(tmpdir(), 'interrupt-pid-'));
  tempDirs.push(pidDir);
  const pidFile = join(pidDir, 'pid');
  process.env.FAKE_CLAUDE_PID_FILE = pidFile;
  const cwd = await mkdtemp(join(tmpdir(), 'interrupt-claude-cwd-'));
  tempDirs.push(cwd);
  const session = await ClaudeNativeCliChatSession.create({ command: fakeClaude, cwd, model: 'claude-opus-4-8', timeoutMs: 2_000 });
  const pid = await publishedPid(pidFile);
  try {
    await session.close();
    assert.equal(processAlive(pid), false);
    await assert.rejects(turnText(session, 'Say OK'), /closed/);
    await delay(300);
    assert.equal(Number(await readFile(pidFile, 'utf8')), pid, 'no child was started for the turn');
  } finally {
    reapFixtureChild(Number(await readFile(pidFile, 'utf8').catch(() => '0')));
  }
});

test('a claude turn whose reader walked away keeps its idle deadline alive with its own events: a turn streaming past the budget drains to its result on the same child (t1 B-child gap 7)', { timeout: 20_000 }, async () => {
  const pidDir = await mkdtemp(join(tmpdir(), 'interrupt-pid-'));
  tempDirs.push(pidDir);
  const pidFile = join(pidDir, 'pid');
  process.env.FAKE_CLAUDE_PID_FILE = pidFile;
  const { manager } = await startClaudeManager(20_000);
  const session = await manager.create({ runtime: 'claude' });
  const pid = await publishedPid(pidFile);
  let writerError;
  try {
    // Six deltas 100 ms apart, the result at ~700 ms: past a 300 ms budget, never silent for it.
    for await (const event of manager.streamTurn(session.id, { input: 'SLOW' }, { timeoutMs: 300 })) {
      if (event.event === 'cli.event') throw new Error('writeSseEvent failed');
    }
  } catch (err) {
    writerError = err.message;
  }
  assert.equal(writerError, 'writeSseEvent failed');
  assert.equal(manager.get(session.id).status, 'running');
  const drainingAt = Date.now();
  await waitFor(() => manager.get(session.id).status === 'ready', 3_000, 'the abandoned turn to drain to its result');
  assert.ok(Date.now() - drainingAt >= 500, `the drain ran to the result, past the budget: ${Date.now() - drainingAt} ms`);
  // A replacement — the deadline's stop on this runtime — writes a new pid once it is up.
  await delay(300);
  assert.equal(Number(await readFile(pidFile, 'utf8')), pid, 'the deadline never fired: the same child, no replacement');
  const next = await manager.runTurn(session.id, { input: 'Say OK' }, { timeoutMs: 2_000 });
  assert.equal(next.status, 'completed');
  assert.equal(next.final.text, 'OK');
});

// ---------------------------------------------------------------------------
// Track 1, bundle B-shutdown: the closing epoch (gap 5).

test('a global close that lands while a session is still being created ends that session too: the create is refused, its child is gone when closeAll resolves, and nothing is listed (t1 B-shutdown gap 5)', { timeout: 20_000 }, async () => {
  const pidDir = await mkdtemp(join(tmpdir(), 'interrupt-pid-'));
  tempDirs.push(pidDir);
  const pidFile = join(pidDir, 'pid');
  process.env.FAKE_CODEX_PID_FILE = pidFile;
  // The handshake is slow: the close lands inside it.
  process.env.FAKE_CODEX_INITIALIZE_DELAY_MS = '450';
  const { manager, methodLog } = await startCodexManager(2_000);
  // Only the child's credentials copy lands here: the manager's own temp dirs were made above.
  const privateTmp = await mkdtemp(join(tmpdir(), 'interrupt-isolation-'));
  const originalTmp = process.env.TMPDIR;
  process.env.TMPDIR = privateTmp;
  let pid = 0;
  try {
    const creating = manager.create({ runtime: 'codex' }).then(
      (created) => ({ kind: 'created', id: created.id }),
      (err) => ({ kind: 'refused', status: err.statusCode, code: err.code, message: err.message }),
    );
    await waitFor(async () => (await receivedMethods(methodLog)).includes('initialize'), 3_000, 'the handshake to be in flight');
    pid = await publishedPid(pidFile);
    await manager.closeAll();
    assert.equal(processAlive(pid), false, 'the child is gone when closeAll resolves');
    const outcome = await creating;
    assert.equal(outcome.kind, 'refused', JSON.stringify(outcome));
    assert.equal(outcome.status, 503);
    assert.equal(outcome.code, 'shutting_down');
    assert.deepEqual(await readdir(privateTmp), [], 'no credentials copy outlives the close');
    // A create after the close is refused the same way.
    await assert.rejects(manager.create({ runtime: 'codex' }), (err) => err.statusCode === 503 && err.code === 'shutting_down');
  } finally {
    reapFixtureChild(pid);
    if (originalTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTmp;
    tempDirs.push(privateTmp);
  }
});

// ---------------------------------------------------------------------------
// Track 1, round 3 (codex seat) on B-child.

/** The one isolation root under a private TMPDIR, as the r53 fixtures find it. */
async function onlyIsolationRoot(privateTmp) {
  const roots = (await readdir(privateTmp)).map((name) => join(privateTmp, name));
  assert.equal(roots.length, 1, `one isolation root: ${JSON.stringify(roots)}`);
  return roots[0];
}

test('a codex child that died on its own leaves its credentials copy to the close: a removal that fails there is the close\'s error, not lost to a continuation nobody awaited (t1 r3-codex F1)', { timeout: 20_000 }, async () => {
  const pidDir = await mkdtemp(join(tmpdir(), 'interrupt-pid-'));
  tempDirs.push(pidDir);
  process.env.FAKE_CODEX_PID_FILE = join(pidDir, 'pid');
  const { manager } = await startCodexManager(2_000);
  const privateTmp = await mkdtemp(join(tmpdir(), 'interrupt-isolation-'));
  const originalTmp = process.env.TMPDIR;
  process.env.TMPDIR = privateTmp;
  const originalRm = fs.promises.rm;
  let releaseRemoval;
  const removalGate = new Promise((resolve_) => { releaseRemoval = resolve_; });
  let removalStarted = false;
  try {
    const session = await manager.create({ runtime: 'codex' });
    const pid = await publishedPid(process.env.FAKE_CODEX_PID_FILE);
    const isolationRoot = await onlyIsolationRoot(privateTmp);
    // The removal of THIS root blocks until released, then fails.
    fs.promises.rm = async (target, options) => {
      if (resolve(String(target)) !== resolve(isolationRoot)) return originalRm(target, options);
      removalStarted = true;
      await removalGate;
      throw Object.assign(new Error('fixture isolation removal denied'), { code: 'EACCES' });
    };
    syncBuiltinESMExports();
    // The child dies on its own — killed by pid, which this test owns.
    process.kill(pid, 'SIGKILL');
    await waitFor(() => !processAlive(pid), 3_000, 'the child to be gone');
    await delay(200);
    let closeSettled = false;
    const closing = manager.close(session.id).then(
      () => { closeSettled = true; return { kind: 'resolved' }; },
      (err) => { closeSettled = true; return { kind: 'rejected', message: err.message }; },
    );
    await waitFor(() => removalStarted, 3_000, 'the isolation removal to be attempted');
    await delay(100);
    assert.equal(closeSettled, false, 'the close waits for the removal it owns');
    releaseRemoval();
    const outcome = await closing;
    assert.equal(outcome.kind, 'rejected', JSON.stringify(outcome));
    assert.match(outcome.message, /credentials copy could not be removed/);
  } finally {
    releaseRemoval();
    fs.promises.rm = originalRm;
    syncBuiltinESMExports();
    if (originalTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTmp;
    tempDirs.push(privateTmp);
  }
});

test('a claude turn stopped while it waits for a replacement never reaches the successor: the stop ends the wait, and the session is free once the replacement is done (t1 r3-codex F2)', { timeout: 20_000 }, async () => {
  const pidDir = await mkdtemp(join(tmpdir(), 'interrupt-pid-'));
  tempDirs.push(pidDir);
  const pidFile = join(pidDir, 'pid');
  process.env.FAKE_CLAUDE_PID_FILE = pidFile;
  process.env.FAKE_CLAUDE_IGNORE_SIGTERM = '1';
  const { manager } = await startClaudeManager(10_000);
  const session = await manager.create({ runtime: 'claude' });
  const oldPid = await publishedPid(pidFile);
  delete process.env.FAKE_CLAUDE_IGNORE_SIGTERM;
  try {
    const first = manager.streamTurn(session.id, { input: 'PARTIAL' })[Symbol.asyncIterator]();
    assert.equal((await first.next()).value?.event, 'cli.event');
    // The interrupt is a replacement on this runtime, and the old child ignores SIGTERM: the replacement waits a second for its exit.
    await manager.interrupt(session.id);
    await delay(50);
    const second = manager.streamTurn(session.id, { input: 'HANG' })[Symbol.asyncIterator]();
    const pending = second.next();
    await delay(50);
    assert.equal(manager.get(session.id).status, 'running', 'the waiting turn occupies the session');
    const interruptedAt = Date.now();
    await manager.interrupt(session.id);
    assert.ok(Date.now() - interruptedAt < 300, `the stop ended the wait, not the replacement: ${Date.now() - interruptedAt} ms`);
    assert.equal((await pending).value?.event, 'cli.error', 'the waiting caller heard the stop');
    // The replacement finishes — a successor publishes its pid — and only then is the session asked again.
    await waitFor(async () => Number(await readFile(pidFile, 'utf8').catch(() => '0')) !== oldPid, 5_000, 'the successor to come up');
    await delay(300);
    assert.equal(manager.get(session.id).status, 'ready', 'the stopped turn was never written to the successor');
    const third = await manager.runTurn(session.id, { input: 'Say OK' }, { timeoutMs: 3_000 });
    assert.equal(third.status, 'completed', JSON.stringify(third.final));
    assert.equal(third.final.text, 'OK');
  } finally {
    reapFixtureChild(oldPid);
  }
});

test('a codex close that lands while the replacement is still copying credentials starts no successor: the close returns within its own work (t1 r3-codex F3)', { timeout: 20_000 }, async () => {
  process.env.FAKE_CODEX_TURN_START_DELAY_MS = '1200';
  process.env.FAKE_CODEX_NO_TURN_COMPLETION = '1';
  const { manager, methodLog } = await startCodexManager(1_000);
  const session = await manager.create({ runtime: 'codex' });
  delete process.env.FAKE_CODEX_TURN_START_DELAY_MS;
  delete process.env.FAKE_CODEX_NO_TURN_COMPLETION;
  // A successor that would take three seconds to answer `initialize`.
  process.env.FAKE_CODEX_INITIALIZE_DELAY_MS = '3000';
  const originalCopyFile = fs.promises.copyFile;
  let releaseCopy;
  const copyGate = new Promise((resolve_) => { releaseCopy = resolve_; });
  let copyStarted = false;
  fs.promises.copyFile = async (source, target, ...rest) => {
    if (String(target).includes('local-oauth-cli-codex-proxy-')) {
      copyStarted = true;
      await copyGate;
    }
    return originalCopyFile(source, target, ...rest);
  };
  syncBuiltinESMExports();
  try {
    const first = await manager.runTurn(session.id, { input: 'hello' }, { timeoutMs: 5_000 });
    assert.equal(first.status, 'error');
    assert.match(first.events.at(-1).raw.message, /turn\/start timed out after 1000ms/);
    await waitFor(() => copyStarted, 3_000, 'the replacement to start copying the credentials');
    const closingAt = Date.now();
    const closing = manager.close(session.id);
    await delay(100);
    releaseCopy();
    const closed = await closing;
    assert.equal(closed.status, 'closed');
    assert.ok(Date.now() - closingAt < 800, `the close did not wait out a successor's handshake: ${Date.now() - closingAt} ms`);
    await delay(200);
    assert.equal((await receivedMethods(methodLog)).filter((method) => method === 'initialize').length, 1, 'no successor was spoken to');
  } finally {
    releaseCopy();
    fs.promises.copyFile = originalCopyFile;
    syncBuiltinESMExports();
  }
});

test('interrupting a drained codex turn answers when the child has been told, not when it acknowledges: the session is free at the write (t1 r3-codex F4)', { timeout: 20_000 }, async () => {
  process.env.FAKE_CODEX_NO_TURN_COMPLETION = '1';
  process.env.FAKE_CODEX_NO_INTERRUPT_ACK = '1';
  const { manager, methodLog } = await startCodexManager(1_500);
  const session = await manager.create({ runtime: 'codex' });
  let writerError;
  try {
    for await (const event of manager.streamTurn(session.id, { input: 'hello' }, { timeoutMs: 10_000 })) {
      if (event.event === 'cli.event') throw new Error('writeSseEvent failed');
    }
  } catch (err) {
    writerError = err.message;
  }
  assert.equal(writerError, 'writeSseEvent failed');
  assert.equal(manager.get(session.id).status, 'running');
  const interruptAt = Date.now();
  const interrupted = await manager.interrupt(session.id);
  assert.ok(Date.now() - interruptAt < 500, `the endpoint answered at the write, not at the RPC budget: ${Date.now() - interruptAt} ms`);
  assert.equal(interrupted.status, 'ready');
  // Written before the endpoint answered; received by the child a moment later.
  await waitFor(async () => (await receivedMethods(methodLog)).includes('turn/interrupt'), 2_000, 'the child to receive the interrupt');
  assert.deepEqual((await receivedMethods(methodLog)).filter((method) => method.startsWith('turn/')), ['turn/start', 'turn/interrupt']);
});

test('a codex child that did not exit gets no successor: the replacement refuses while it lives, and starts one once it is gone (t1 r3-codex F5)', { timeout: 30_000 }, async () => {
  const pidDir = await mkdtemp(join(tmpdir(), 'interrupt-pid-'));
  tempDirs.push(pidDir);
  const pidFile = join(pidDir, 'pid');
  process.env.FAKE_CODEX_PID_FILE = pidFile;
  process.env.FAKE_CODEX_TURN_START_DELAY_MS = '800';
  process.env.FAKE_CODEX_NO_TURN_COMPLETION = '1';
  const { manager } = await startCodexManager(500);
  const session = await manager.create({ runtime: 'codex' });
  const oldPid = await publishedPid(pidFile);
  delete process.env.FAKE_CODEX_TURN_START_DELAY_MS;
  delete process.env.FAKE_CODEX_NO_TURN_COMPLETION;
  // A child no signal reaches: its handle's `kill` does nothing, so it stays.
  const handle = manager.sessions.get(session.id).nativeSession.child;
  assert.ok(handle, 'the runtime\'s child handle');
  handle.kill = () => true;
  try {
    const first = await manager.runTurn(session.id, { input: 'hello' }, { timeoutMs: 5_000 });
    assert.equal(first.status, 'error');
    assert.match(first.events.at(-1).raw.message, /turn\/start timed out after 500ms/);
    const second = await manager.runTurn(session.id, { input: 'again' }, { timeoutMs: 8_000 });
    assert.equal(second.status, 'error', JSON.stringify(second.final));
    assert.match(second.events.at(-1).raw.message, /did not exit/, 'the turn reports why no child could be started');
    assert.equal(Number(await readFile(pidFile, 'utf8')), oldPid, 'no successor while the child lives');
    assert.equal(processAlive(oldPid), true);
    // Gone at last — by the pid this test owns — and the next turn gets its child.
    process.kill(oldPid, 'SIGKILL');
    await waitFor(() => !processAlive(oldPid), 3_000, 'the old child to be gone');
    const third = await manager.runTurn(session.id, { input: 'once more' }, { timeoutMs: 8_000 });
    assert.equal(third.status, 'completed', JSON.stringify(third.final));
    assert.notEqual(Number(await readFile(pidFile, 'utf8')), oldPid, 'a successor, now');
  } finally {
    reapFixtureChild(oldPid);
    reapFixtureChild(Number(await readFile(pidFile, 'utf8').catch(() => '0')));
  }
});

test('a claude child that did not exit gets no successor either: the same rule on the other runtime (t1 r3-codex F5, two paths)', { timeout: 30_000 }, async () => {
  const pidDir = await mkdtemp(join(tmpdir(), 'interrupt-pid-'));
  tempDirs.push(pidDir);
  const pidFile = join(pidDir, 'pid');
  process.env.FAKE_CLAUDE_PID_FILE = pidFile;
  const { manager } = await startClaudeManager(10_000);
  const session = await manager.create({ runtime: 'claude' });
  const oldPid = await publishedPid(pidFile);
  const handle = manager.sessions.get(session.id).nativeSession.child;
  assert.ok(handle, 'the runtime\'s child handle');
  handle.kill = () => true;
  try {
    const first = manager.streamTurn(session.id, { input: 'PARTIAL' })[Symbol.asyncIterator]();
    assert.equal((await first.next()).value?.event, 'cli.event');
    await manager.interrupt(session.id);
    // The replacement waits out both graces and refuses to spawn over a child that stayed.
    const second = await manager.runTurn(session.id, { input: 'again' }, { timeoutMs: 8_000 });
    assert.equal(second.status, 'error', JSON.stringify(second.final));
    assert.match(second.events.at(-1).raw.message, /did not exit/);
    assert.equal(Number(await readFile(pidFile, 'utf8')), oldPid, 'no successor while the child lives');
    process.kill(oldPid, 'SIGKILL');
    await waitFor(() => !processAlive(oldPid), 3_000, 'the old child to be gone');
    const third = await manager.runTurn(session.id, { input: 'Say OK' }, { timeoutMs: 8_000 });
    assert.equal(third.status, 'completed', JSON.stringify(third.final));
    assert.equal(third.final.text, 'OK');
  } finally {
    reapFixtureChild(oldPid);
    reapFixtureChild(Number(await readFile(pidFile, 'utf8').catch(() => '0')));
  }
});
