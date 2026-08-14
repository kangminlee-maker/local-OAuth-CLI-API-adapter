import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { before, beforeEach, test } from 'node:test';
import {
  assertCodexModelSupported,
  codexModels,
  resetCodexModelCatalogCache,
} from '../dist/proxy/codex-model-catalog.js';

const here = dirname(fileURLToPath(import.meta.url));
const okCommand = resolve(here, 'fixtures/fake-codex-models-ok.cjs');
const failCommand = resolve(here, 'fixtures/fake-codex-models-fail.cjs');
const malformedCommand = resolve(here, 'fixtures/fake-codex-models-malformed.cjs');
const partialCommand = resolve(here, 'fixtures/fake-codex-models-partial.cjs');
const emptyCommand = resolve(here, 'fixtures/fake-codex-models-empty.cjs');
const mutableCommand = resolve(here, 'fixtures/fake-codex-models-mutable.cjs');

before(async () => {
  // Without this a non-executable fixture would make execFile fail, production
  // code would return null, and the malformed/partial tests would pass without
  // ever exercising the parser.
  for (const command of [okCommand, failCommand, malformedCommand, partialCommand, emptyCommand, mutableCommand]) {
    await chmod(command, 0o755);
  }
});

beforeEach(() => {
  resetCodexModelCatalogCache();
});

async function callCount(home) {
  const log = join(home, 'debug-models-calls.log');
  if (!existsSync(log)) return 0;
  const raw = await readFile(log, 'utf8');
  return raw.split('\n').filter((line) => line.trim()).length;
}

const newHome = () => mkdtemp(join(tmpdir(), 'codex-model-catalog-'));

test('collects the slugs the CLI advertises, and actually runs debug models', async () => {
  const codexHome = await newHome();
  const models = await codexModels({ command: okCommand, codexHome });
  assert.deepEqual(models?.map((m) => m.slug), ['fixture-model-a', 'fixture-model-b']);
  assert.equal(models?.[0].supportedInApi, true);
  assert.equal(models?.[1].supportedInApi, false);
  assert.deepEqual(models?.[0].reasoningEfforts, ['low', 'max']);
  // Proves the list came from the CLI rather than from anything hard-coded.
  assert.equal(await callCount(codexHome), 1, 'expected debug models to be invoked once');
});

test('a successful list is cached instead of re-spawning the CLI', async () => {
  const codexHome = await newHome();
  await codexModels({ command: okCommand, codexHome });
  await codexModels({ command: okCommand, codexHome });
  assert.equal(await callCount(codexHome), 1);
});

test('a failing lookup is unknown, not empty', async () => {
  const codexHome = await newHome();
  assert.equal(await codexModels({ command: failCommand, codexHome }), null);
  assert.equal(await callCount(codexHome), 1);
});

test('malformed output is unknown, not empty', async () => {
  const codexHome = await newHome();
  assert.equal(await codexModels({ command: malformedCommand, codexHome }), null);
  // Proves the null came from parsing, not from a fixture that never ran.
  assert.equal(await callCount(codexHome), 1);
});

test('one unreadable entry makes the whole catalogue unknown, not a shorter list', async () => {
  // Otherwise a model whose slug the parser could not read would be reported as
  // "not advertised" and rejected, even though collection never determined it.
  const codexHome = await newHome();
  assert.equal(await codexModels({ command: partialCommand, codexHome }), null);
  assert.equal(await callCount(codexHome), 1);
});

test('a model missing from a partially unreadable catalogue is passed through, not rejected', async () => {
  const codexHome = await newHome();
  await assertCodexModelSupported('fixture-model-renamed-field', 'openai-chat', {
    command: partialCommand,
    codexHome,
  });
});

test('a failing lookup is remembered, so it does not respawn on every request', async () => {
  const codexHome = await newHome();
  for (let i = 0; i < 5; i += 1) {
    assert.equal(await codexModels({ command: failCommand, codexHome }), null);
  }
  assert.equal(await callCount(codexHome), 1, 'expected the failure to be cached');
});

test('a remembered failure is retried once its shorter window elapses', async () => {
  const codexHome = await newHome();
  let now = 1_000_000;
  const clock = () => now;
  assert.equal(await codexModels({ command: failCommand, codexHome, now: clock }), null);
  now += 31_000;
  assert.equal(await codexModels({ command: failCommand, codexHome, now: clock }), null);
  assert.equal(await callCount(codexHome), 2, 'expected a retry after the failure window');
});

test('a supported model passes and an unadvertised one is rejected', async () => {
  const codexHome = await newHome();
  await assertCodexModelSupported('fixture-model-a', 'openai-chat', { command: okCommand, codexHome });
  await assert.rejects(
    () => assertCodexModelSupported('fixture-model-zzz', 'openai-chat', { command: okCommand, codexHome }),
    (err) => {
      assert.equal(err.statusCode, 404);
      assert.equal(err.code, 'model_not_found');
      return true;
    },
  );
});

test('an uncollectable list passes any model through rather than rejecting it', async () => {
  // The fail-open branch: without this the proxy would reject every model
  // whenever `codex debug models` is unavailable.
  const codexHome = await newHome();
  await assertCodexModelSupported('anything-at-all', 'openai-chat', { command: failCommand, codexHome });
});

test('fail-open survives the failure window: a retry that also fails still passes models through', async () => {
  // The retry is a different branch from the first lookup. If it ever produced
  // an empty list instead of `null`, the proxy would serve every model for 30
  // seconds and then start 404-ing all of them — with nothing in the request to
  // explain the change. The retry-count test above stays green either way.
  const codexHome = await newHome();
  let now = 1_000_000;
  const clock = () => now;
  const options = { command: failCommand, codexHome, now: clock };

  await assertCodexModelSupported('anything-at-all', 'openai-chat', options);
  now += 31_000;
  await assertCodexModelSupported('anything-at-all', 'openai-chat', options);
  assert.equal(await callCount(codexHome), 2, 'the window must have elapsed for this to prove anything');
  now += 31_000;
  await assertCodexModelSupported('a-different-model', 'openai-chat', options);
});

test('a successfully collected empty catalogue is authoritative, not unknown', async () => {
  // An account entitled to nothing is a conclusive answer. Reporting it as
  // unknown would let every model through instead of rejecting it here.
  const codexHome = await newHome();
  assert.deepEqual(await codexModels({ command: emptyCommand, codexHome }), []);
});

test('an empty catalogue rejects every model', async () => {
  const codexHome = await newHome();
  await assert.rejects(
    () => assertCodexModelSupported('anything', 'openai-chat', { command: emptyCommand, codexHome }),
    (err) => {
      assert.equal(err.statusCode, 404);
      assert.equal(err.code, 'model_not_found');
      return true;
    },
  );
});

test('a probe directory that cannot be created is unknown, not a request failure', async () => {
  // The default transport supplies no cwd, so the lookup creates its own private
  // directory. An unwritable temp volume must not turn into a server error.
  const originalTmp = process.env.TMPDIR;
  process.env.TMPDIR = join(originalTmp ?? '/tmp', 'definitely-not-a-directory-xyz');
  try {
    resetCodexModelCatalogCache();
    assert.equal(await codexModels({ command: okCommand }), null);
    // And it must not latch: once the volume works again, lookups resume.
    // Restoring an absent TMPDIR means deleting it, not assigning undefined.
    if (originalTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTmp;
    resetCodexModelCatalogCache();
    const models = await codexModels({ command: okCommand });
    assert.ok(Array.isArray(models), 'expected the lookup to recover');
  } finally {
    if (originalTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTmp;
  }
});

test('an unavailable configured model does not leak its name to the client', async () => {
  const codexHome = await newHome();
  await assert.rejects(
    () => assertCodexModelSupported(
      'corp-private-retired',
      'openai-chat',
      { command: okCommand, codexHome },
      false,
    ),
    (err) => {
      assert.equal(err.statusCode, 404);
      assert.ok(!err.message.includes('corp-private-retired'), err.message);
      return true;
    },
  );
});

test('a different account in the same CODEX_HOME does not reuse the cached catalogue', async () => {
  // The served list is account-scoped, so a login change must retire the entry
  // rather than answering the new account from the old one's entitlements.
  const codexHome = await newHome();
  await writeFile(join(codexHome, 'auth.json'), `${JSON.stringify({ tokens: { account_id: 'a' } })}\n`);
  await codexModels({ command: okCommand, codexHome });
  assert.equal(await callCount(codexHome), 1);

  // Same home, same command — a second call is served from cache.
  await codexModels({ command: okCommand, codexHome });
  assert.equal(await callCount(codexHome), 1, 'unchanged credentials should still cache');

  // Now the operator logs in as someone else.
  await new Promise((r) => setTimeout(r, 10));
  await writeFile(
    join(codexHome, 'auth.json'),
    `${JSON.stringify({ tokens: { account_id: 'b', extra: 'longer-file' } })}\n`,
  );
  await codexModels({ command: okCommand, codexHome });
  assert.equal(await callCount(codexHome), 2, 'a credential change must force a fresh lookup');
});

test('a same-sized credential swap with unchanged metadata still forces a fresh lookup', async () => {
  // File metadata is not account identity: `cp -p`, an equal-length rewrite, or a
  // coarse-timestamp filesystem all preserve mtime and size.
  const codexHome = await newHome();
  const authPath = join(codexHome, 'auth.json');
  const a = `${JSON.stringify({ tokens: { account_id: 'acct-aaaa' } })}\n`;
  const b = `${JSON.stringify({ tokens: { account_id: 'acct-bbbb' } })}\n`;
  assert.equal(a.length, b.length, 'the two credential files must be the same size');

  await writeFile(authPath, a);
  const stamp = new Date(1_700_000_000_000);
  await utimes(authPath, stamp, stamp);
  await codexModels({ command: okCommand, codexHome });
  assert.equal(await callCount(codexHome), 1);

  await writeFile(authPath, b);
  await utimes(authPath, stamp, stamp);
  await codexModels({ command: okCommand, codexHome });
  assert.equal(await callCount(codexHome), 2, 'a different account must not reuse the catalogue');
});

test('a successful catalogue is refreshed once its TTL elapses', async () => {
  // Without this, raising MODEL_LIST_TTL_MS to infinity would leave every
  // catalogue test green while a served change never took effect.
  const codexHome = await newHome();
  let now = 5_000_000;
  const clock = () => now;
  await codexModels({ command: okCommand, codexHome, now: clock });
  assert.equal(await callCount(codexHome), 1);

  now += 9 * 60 * 1000;
  await codexModels({ command: okCommand, codexHome, now: clock });
  assert.equal(await callCount(codexHome), 1, 'still inside the success TTL');

  now += 2 * 60 * 1000;
  await codexModels({ command: okCommand, codexHome, now: clock });
  assert.equal(await callCount(codexHome), 2, 'past ten minutes the list is re-collected');
});

test('a slug added to the runtime inside the cache window is rejected until the entry expires', async () => {
  // The contract states this as a client-observable consequence of caching: one
  // request's collection decides what a later one may name. Nothing tested it —
  // the existing cache tests keep the advertised list fixed, so a lookup that
  // silently refreshed on a miss would have stayed green while this promise
  // stopped holding.
  const codexHome = await newHome();
  const advertised = join(codexHome, 'advertised.json');
  await writeFile(advertised, JSON.stringify(['old-slug']));
  let now = 5_000_000;
  const options = { command: mutableCommand, codexHome, now: () => now };

  await assertCodexModelSupported('old-slug', 'openai-chat', options);
  await assert.rejects(
    () => assertCodexModelSupported('new-slug', 'openai-chat', options),
    (err) => {
      assert.equal(err.statusCode, 404);
      return true;
    },
  );

  await writeFile(advertised, JSON.stringify(['old-slug', 'new-slug']));
  await assert.rejects(
    () => assertCodexModelSupported('new-slug', 'openai-chat', options),
    (err) => {
      assert.equal(err.statusCode, 404, 'the cached list still decides inside the window');
      return true;
    },
  );
  assert.equal(await callCount(codexHome), 1, 'the runtime must not have been re-consulted');

  now += 10 * 60 * 1000 + 1;
  await assertCodexModelSupported('new-slug', 'openai-chat', options);
  assert.equal(await callCount(codexHome), 2, 'the expired entry must force a fresh collection');
});
