// The noise-floor runner, started the only way a test may start it: in plan mode.
//
// `scripts/aa-noise-floor.mjs` hardcodes the vendor URLs and spends metered calls
// under `--live`, so `test/aa-sampler.test.mjs` drives the library instead. The
// library cannot say what the RUNNER hands it, and a review found the defect at
// that call: the runner passed both model pins and the bytes of the tasks file
// whatever the cohort, so an Anthropic-only partition became a new run — a new
// ledger and a fresh ceiling — when the OpenAI pin or a comment changed.
//
// Plan mode prints the identity and makes no call. These cases never pass
// `--live` or `--resume`, strip both vendor keys, and preload a module that ends
// the process on any fetch.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
import { runIdentity } from '../scripts/lib/aa-sampler.mjs';
import { saveLedger } from '../scripts/lib/ledger.mjs';
import { qualityTasks } from '../scripts/lib/quality-tasks.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REFUSE = pathToFileURL(join(repoRoot, 'test/fixtures/refuse-network.mjs')).href;

const roots = [];
after(() => { for (const dir of roots) rmSync(dir, { recursive: true, force: true }); });

function start(root, ...args) {
  assert.ok(!args.includes('--live') && !args.includes('--resume'), 'a test starts the runner in plan mode only');
  const env = { ...process.env };
  delete env.OPENAI_API_KEY;
  delete env.ANTHROPIC_API_KEY;
  return spawnSync(process.execPath,
    ['--import', REFUSE, join(root, 'scripts/aa-noise-floor.mjs'), ...args],
    { cwd: root, env, encoding: 'utf8' });
}

function planned(root, ...args) {
  const result = start(root, ...args);
  assert.equal(result.status, 0, result.stderr);
  const printed = JSON.parse(result.stdout.slice(0, result.stdout.indexOf('\n}\n') + 2));
  assert.match(printed.note, /no call was made/);
  return printed;
}

const plan = (root, ...args) => planned(root, ...args).plan;

// The name a run's ledger is derived from, with the day taken out: two calls a
// test makes can straddle midnight UTC, and the day is not what these compare.
const nameOf = (printed) => basename(printed.wouldWrite).replace(/-\d{8}-/, '-<day>-');

// A copy of the runner and its libraries, so a test can edit the tasks file
// without touching the tree under test. They import nothing but `node:` and
// each other.
function copiedRunner() {
  const root = mkdtempSync(join(tmpdir(), 'aa-plan-'));
  roots.push(root);
  mkdirSync(join(root, 'scripts'), { recursive: true });
  cpSync(join(repoRoot, 'scripts/aa-noise-floor.mjs'), join(root, 'scripts/aa-noise-floor.mjs'));
  cpSync(join(repoRoot, 'scripts/lib'), join(root, 'scripts/lib'), { recursive: true });
  return root;
}

test('a partition is the same run whatever the pin of the provider it leaves out', () => {
  const cap = ['--max-tokens', '1536'];
  const anthropic = (openai, pin = 'claude-sonnet-5') => plan(repoRoot,
    '--only', 'anthropic/', '--anthropic-model', pin, '--openai-model', openai, ...cap);
  const base = anthropic('gpt-5.6-terra');
  assert.equal(base.rows, qualityTasks().length);
  assert.equal(anthropic('gpt-5.6-luna').identity, base.identity,
    'an Anthropic-only run changed identity with the OpenAI pin');
  assert.notEqual(anthropic('gpt-5.6-terra', 'claude-opus-5').identity, base.identity);
  // ...and the same NAME, which is what the ledger is derived from. Identity
  // alone was the stand-in: a name that carried the pin beside the identity
  // re-opened the defect with every assertion above still true.
  const named = (openai) => planned(repoRoot,
    '--only', 'anthropic/', '--anthropic-model', 'claude-sonnet-5', '--openai-model', openai, ...cap);
  const terra = named('gpt-5.6-terra');
  assert.equal(nameOf(named('gpt-5.6-luna')), nameOf(terra),
    'an Anthropic-only run changed its ledger with the OpenAI pin');
  assert.equal(nameOf(terra), `aa-noise-floor-<day>-anthropic-${terra.plan.identity}.json`);

  const openai = (anthropicPin, pin = 'gpt-5.6-terra') => plan(repoRoot,
    '--only', 'openai/', '--openai-model', pin, '--anthropic-model', anthropicPin, ...cap);
  const other = openai('claude-sonnet-5');
  assert.equal(openai('claude-opus-5').identity, other.identity,
    'an OpenAI-only run changed identity with the Anthropic pin');
  assert.notEqual(openai('claude-sonnet-5', 'gpt-5.6-sol').identity, other.identity);
});

test('the runner\'s identity is its selected prompts, their providers\' pins and the cap', () => {
  const models = { openai: 'gpt-5.6-sol', anthropic: 'claude-opus-5' };
  const pins = ['--openai-model', models.openai, '--anthropic-model', models.anthropic, '--max-tokens', '777'];
  const tasks = qualityTasks();
  const rowsFor = (providers) => providers.flatMap((provider) =>
    tasks.map((task) => ({ provider, task: task.id, prompt: task.prompt })));
  assert.equal(plan(repoRoot, '--only', 'openai/', ...pins).identity,
    runIdentity({ rows: rowsFor(['openai']), models, maxTokens: 777 }));
  assert.equal(plan(repoRoot, ...pins).identity,
    runIdentity({ rows: rowsFor(['openai', 'anthropic']), models, maxTokens: 777 }));
});

test('an edit to the tasks file is a new run only where it changes a selected prompt', async () => {
  const root = copiedRunner();
  const pins = ['--openai-model', 'gpt-5.6-terra', '--anthropic-model', 'claude-sonnet-5', '--max-tokens', '1536'];
  const whole = plan(root, ...pins);
  const unedited = plan(root, '--only', 'anthropic/handoff_summary', ...pins);
  const edited = plan(root, '--only', 'anthropic/release_gate_decision', ...pins);

  const tasksPath = join(root, 'scripts/lib/quality-tasks.mjs');
  const original = readFileSync(tasksPath, 'utf8');
  writeFileSync(tasksPath, `${original}\n// A comment changes the file and no prompt.\n`);
  const commented = plan(root, ...pins);
  assert.notEqual(commented.tasksDigest, whole.tasksDigest, 'the comment did not reach the file the runner reads');
  assert.equal(commented.identity, whole.identity, 'a comment in the tasks file made a new run');

  const marker = 'One bullet must say when to pass.';
  assert.equal(original.split(marker).length, 2, 'the marker must name exactly one line');
  writeFileSync(tasksPath, original.replace(marker, 'One bullet must say when to ship.'));
  // The edit changes the prompt of one task and no other, or the assertions
  // below are about an edit that did not happen.
  const rewritten = (await import(pathToFileURL(tasksPath).href)).qualityTasks();
  const shipped = qualityTasks();
  assert.deepEqual(rewritten.filter((task, i) => task.prompt !== shipped[i].prompt).map((task) => task.id),
    ['release_gate_decision']);

  assert.notEqual(plan(root, ...pins).identity, whole.identity,
    'a changed prompt in the cohort left the run the same');
  assert.notEqual(plan(root, '--only', 'anthropic/release_gate_decision', ...pins).identity, edited.identity,
    'a changed prompt in the cohort left the run the same');
  assert.equal(plan(root, '--only', 'anthropic/handoff_summary', ...pins).identity, unedited.identity,
    'an edit to a row this run does not select made it a new run');
});

test('an unfinished run under another day\'s name is refused, and a finished one is not', () => {
  // The day is in the ledger's name and not in identity. A review interrupted a
  // run after thirty paid calls and re-ran the same command after midnight UTC:
  // a new name, no ledger, and the whole ceiling granted again.
  const root = copiedRunner();
  const args = ['--only', 'anthropic/', '--openai-model', 'gpt-5.6-terra', '--anthropic-model', 'claude-sonnet-5',
    '--max-tokens', '1536'];
  const { identity } = plan(root, ...args);
  const results = join(root, 'bench-results');
  const yesterday = join(results, `aa-noise-floor-20000101-anthropic-${identity}.json`);
  saveLedger(`${yesterday}.state.json`, { identity, rows: {}, spent: 30 });

  const refused = start(root, ...args);
  assert.equal(refused.status, 1, 'a run started beside an unfinished run of its own configuration');
  assert.match(refused.stderr, new RegExp(`${basename(yesterday)}\\.state\\.json is an unfinished run`));
  assert.match(refused.stderr, /30 call\(s\) paid for, artifact missing/);
  assert.match(refused.stderr, /--resume <ledger>/);
  assert.equal(refused.stdout, '', 'a refused run printed a plan');
  // Naming the artifact somewhere else does not step around it — that is what
  // the "already exists" refusal used to tell an operator to do.
  const elsewhere = start(root, ...args, '--out', join(root, 'elsewhere', 'mine.json'));
  assert.equal(elsewhere.status, 1, '--out stepped around an unfinished run');
  // A configuration that is not this one is not in the way.
  plan(root, '--only', 'openai/', '--openai-model', 'gpt-5.6-terra', '--max-tokens', '1536');
  // The ledger this invocation would use itself is resumed, not refused.
  const own = join(results, 'mine.json');
  saveLedger(`${own}.state.json`, { identity, rows: {}, spent: 4 });
  writeFileSync(yesterday, JSON.stringify({ aborted: null }));
  plan(root, ...args, '--out', own);
  // From anywhere else it is another unfinished run of this configuration.
  assert.match(start(root, ...args).stderr, /mine\.json\.state\.json is an unfinished run/);
  // A finished run is finished: a new day may start a new one.
  writeFileSync(own, JSON.stringify({ aborted: null }));
  plan(root, ...args);
});
