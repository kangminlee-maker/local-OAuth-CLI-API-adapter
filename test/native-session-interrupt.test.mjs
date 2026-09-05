import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
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

  assert.equal(
    (await receivedMethods(methodLog)).filter((method) => method === 'turn/interrupt').length,
    1,
    'the turn must be interrupted on the child, whenever the interrupt lands',
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
  const first = await manager.runTurn(session.id, { input: 'hello' }, { timeoutMs: 300 });
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
    const first = await manager.runTurn(session.id, { input: 'hello' }, { timeoutMs: 300 });
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
  const first = await manager.runTurn(session.id, { input: 'hello' }, { timeoutMs: 300 });
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
  const first = await manager.runTurn(session.id, { input: 'hello' }, { timeoutMs: 300 });
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
  const first = await manager.runTurn(session.id, { input: 'hello' }, { timeoutMs: 1000 });
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

test('a replacement whose handshake fails leaves no child: the waiting turn reports not running and reaches nothing on the old thread (r55-codex)', { timeout: 20_000 }, async () => {
  process.env.FAKE_CODEX_TURN_START_DELAY_MS = '650';
  process.env.FAKE_CODEX_NO_TURN_COMPLETION = '1';
  const { manager, methodLog } = await startCodexManager(300);
  const session = await manager.create({ runtime: 'codex' });
  delete process.env.FAKE_CODEX_TURN_START_DELAY_MS;
  delete process.env.FAKE_CODEX_NO_TURN_COMPLETION;
  // Slower than the RPC budget: the replacement's `initialize` times out.
  process.env.FAKE_CODEX_INITIALIZE_DELAY_MS = '850';
  const first = await manager.runTurn(session.id, { input: 'hello' }, { timeoutMs: 300 });
  assert.equal(first.status, 'error');
  // A deadline longer than the failing handshake: what ends this turn is the
  // replacement's failure, not the idle budget.
  const second = await manager.runTurn(session.id, { input: 'again' }, { timeoutMs: 2000 });
  assert.equal(second.status, 'error');
  assert.match(second.events.at(-1).raw.message, /not running/);
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
    const first = await manager.runTurn(session.id, { input: 'hello' }, { timeoutMs: 300 });
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
  assert.match(partial.events.at(-1).raw.message, /interrupted/);
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
        async *startTurn() {
          yield { raw: { method: 'item/agentMessage/delta' }, textDelta: 'hi' };
          // Still running: the turn has to be live when the interrupt fails, or
          // the status this is about was already restored by its own stream.
          await new Promise(() => {});
        },
        async interrupt() {
          throw new Error('the pipe died under the interrupt');
        },
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

  await session.close();

  await assert.rejects(pending, /session closed/i);
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
