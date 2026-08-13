import assert from 'node:assert/strict';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';
import { codexModels, resetCodexModelCatalogCache } from '../dist/proxy/codex-model-catalog.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = resolve(here, 'fixtures/fake-codex-models-ok.cjs');
const dirs = [];

afterEach(async () => {
  delete process.env.CODEX_MODELS_CALL_LOG;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

// A path-like `--codex-command` must be resolved against the directory the
// runtime spawns from — not the proxy's own cwd, and certainly not the private
// probe directory the lookup runs in. Otherwise the catalogue silently queries a
// different executable, or none, and fails open.
test('a relative command resolves against the runtime cwd, not the proxy cwd', async () => {
  const runtimeCwd = await mkdtemp(join(tmpdir(), 'codex-runtime-cwd-'));
  dirs.push(runtimeCwd);
  await mkdir(join(runtimeCwd, 'bin'), { recursive: true });
  await copyFile(fixture, join(runtimeCwd, 'bin', 'codex'));
  // The fixture requires this sibling module by relative path.
  await copyFile(
    resolve(here, 'fixtures/record-models-call.cjs'),
    join(runtimeCwd, 'bin', 'record-models-call.cjs'),
  );
  await chmod(join(runtimeCwd, 'bin', 'codex'), 0o755);

  const callLog = join(await mkdtemp(join(tmpdir(), 'codex-cmd-log-')), 'calls.log');
  dirs.push(dirname(callLog));
  process.env.CODEX_MODELS_CALL_LOG = callLog;

  // The lookup must run somewhere OTHER than the runtime cwd, exactly as
  // production does (a private probe directory). Otherwise the OS would resolve
  // `./bin/codex` from the lookup's own cwd and the test would pass even if
  // command resolution were removed entirely.
  const lookupCwd = await mkdtemp(join(tmpdir(), 'codex-lookup-cwd-'));
  dirs.push(lookupCwd);

  resetCodexModelCatalogCache();
  const models = await codexModels({
    command: './bin/codex',
    commandCwd: runtimeCwd,
    cwd: lookupCwd,
  });

  assert.ok(Array.isArray(models), 'expected the runtime-relative executable to be found');
  assert.deepEqual(models.map((m) => m.slug), ['fixture-model-a', 'fixture-model-b']);
  assert.equal(existsSync(callLog), true);
  assert.equal((await readFile(callLog, 'utf8')).trim(), 'debug models');
});

test('a relative command that does not exist under the runtime cwd is unknown', async () => {
  const runtimeCwd = await mkdtemp(join(tmpdir(), 'codex-runtime-cwd-'));
  const lookupCwd = await mkdtemp(join(tmpdir(), 'codex-lookup-cwd-'));
  dirs.push(runtimeCwd, lookupCwd);
  resetCodexModelCatalogCache();
  assert.equal(
    await codexModels({ command: './bin/codex', commandCwd: runtimeCwd, cwd: lookupCwd }),
    null,
  );
});

test('the lookup cwd is not what resolves the command', async () => {
  // Control for the test above: put the executable under the LOOKUP directory
  // instead. Resolution keys off commandCwd, so it must not be found there.
  const runtimeCwd = await mkdtemp(join(tmpdir(), 'codex-runtime-cwd-'));
  const lookupCwd = await mkdtemp(join(tmpdir(), 'codex-lookup-cwd-'));
  dirs.push(runtimeCwd, lookupCwd);
  await mkdir(join(lookupCwd, 'bin'), { recursive: true });
  await copyFile(fixture, join(lookupCwd, 'bin', 'codex'));
  await copyFile(
    resolve(here, 'fixtures/record-models-call.cjs'),
    join(lookupCwd, 'bin', 'record-models-call.cjs'),
  );
  await chmod(join(lookupCwd, 'bin', 'codex'), 0o755);

  resetCodexModelCatalogCache();
  assert.equal(
    await codexModels({ command: './bin/codex', commandCwd: runtimeCwd, cwd: lookupCwd }),
    null,
  );
});
