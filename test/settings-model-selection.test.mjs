import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { after, before, test } from 'node:test';

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const fakeCodexModelsOk = resolve(here, 'fixtures/fake-codex-models-ok.cjs');
const fakeCodex = resolve(here, 'fixtures/fake-codex.cjs');
const rejectModelClaude = resolve(here, 'fixtures/reject-model-claude.cjs');

// Every other honour-on test injects `honorRequestModel: true` directly, which
// would keep passing even if a backend stopped consulting settings.json —
// leaving the documented setting inert for a real proxy process. These run the
// production path instead: the value is read from a settings.json by the loader.
//
// The tree is a copy, never the checked-in settings.json. Rewriting the tracked
// file would race the other test files, which run concurrently and cache their
// settings on first read.
const trees = [];

before(async () => {
  for (const command of [fakeCodexModelsOk, fakeCodex, rejectModelClaude]) {
    await chmod(command, 0o755);
  }
});

after(async () => {
  await Promise.all(trees.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function treeWithSetting(honorRequestModel) {
  const root = await mkdtemp(join(tmpdir(), 'model-selection-tree-'));
  trees.push(root);
  // The loader resolves `../settings.json` from dist/, so the copied tree needs
  // both, and only the copy is ever modified.
  await cp(join(repoRoot, 'dist'), join(root, 'dist'), { recursive: true });
  // `dist` resolves its runtime dependencies (`ajv`) from a `node_modules`
  // beside it, the way an installed package does.
  await symlink(join(repoRoot, 'node_modules'), join(root, 'node_modules'));
  const settings = JSON.parse(await readFile(join(repoRoot, 'settings.json'), 'utf8'));
  // `undefined` writes a settings file with no modelSelection block at all, which
  // is what an install predating this setting looks like.
  const { modelSelection: _drop, ...rest } = settings;
  const next = honorRequestModel === undefined
    ? rest
    : { ...rest, modelSelection: { honorRequestModel } };
  await writeFile(join(root, 'settings.json'), `${JSON.stringify(next, null, 2)}\n`);
  return root;
}

async function codexHomeWithAuth(root) {
  const home = join(root, 'codex-home');
  await mkdir(home, { recursive: true });
  await writeFile(
    join(home, 'auth.json'),
    `${JSON.stringify({
      tokens: { access_token: 'codex-oauth-token', account_id: 'account-1', refresh_token: 'r' },
    })}\n`,
  );
  return home;
}

async function runInTree(root, body) {
  const scriptPath = join(root, 'probe.mjs');
  await writeFile(scriptPath, body);
  const { stdout } = await execFileAsync(process.execPath, [scriptPath], { cwd: root });
  return JSON.parse(stdout);
}

const REQUEST = (model) => JSON.stringify({
  shape: 'openai-chat',
  model,
  messages: [{ role: 'user', content: 'hi', images: [] }],
  stream: false,
  streamOptions: { includeUsage: false, includeObfuscation: false },
  jsonMode: false,
  tools: [],
  toolChoice: { type: 'auto' },
  raw: {},
});

const REPORT = `
    process.stdout.write(JSON.stringify({ outcome: 'allowed' }));
  } catch (err) {
    process.stdout.write(JSON.stringify({ outcome: 'rejected', status: err.statusCode, code: err.code }));
  }
`;

async function codexBackendOutcome(honorRequestModel) {
  const root = await treeWithSetting(honorRequestModel);
  const home = await codexHomeWithAuth(root);
  return runInTree(root, `
    import { CodexBackendTransport } from ${JSON.stringify(join(root, 'dist/proxy/codex-backend-transport.js'))};
    globalThis.fetch = async () => new Response(
      'data: ' + JSON.stringify({ type: 'response.completed', response: { id: 'r', model: 'x' } }) + '\\n\\n',
      { status: 200 },
    );
    const backend = new CodexBackendTransport({
      codexHome: ${JSON.stringify(home)},
      timeoutMs: 30000,
      model: 'gpt-5.5',
      codexCommand: ${JSON.stringify(fakeCodexModelsOk)},
    });
    try {
      await backend.generate(${REQUEST('zzz-never-advertised')});${REPORT}
  `);
}

async function appServerOutcome(honorRequestModel) {
  const root = await treeWithSetting(honorRequestModel);
  const home = await codexHomeWithAuth(root);
  return runInTree(root, `
    process.env.CODEX_HOME = ${JSON.stringify(home)};
    import { CodexAppServerBackend } from ${JSON.stringify(join(root, 'dist/proxy/codex-app-server-backend.js'))};
    const backend = new CodexAppServerBackend({
      command: ${JSON.stringify(fakeCodex)},
      cwd: ${JSON.stringify(root)},
      timeoutMs: 30000,
      model: 'gpt-5.5',
    });
    try {
      await backend.generate(${REQUEST('zzz-never-advertised')});${REPORT}
    finally { await backend.close(); }
  `);
}

async function claudeOutcome(honorRequestModel) {
  const root = await treeWithSetting(honorRequestModel);
  return runInTree(root, `
    import { ClaudeCodeBackend } from ${JSON.stringify(join(root, 'dist/proxy/claude-code-backend.js'))};
    const backend = new ClaudeCodeBackend({
      command: ${JSON.stringify(rejectModelClaude)},
      cwd: ${JSON.stringify(root)},
      timeoutMs: 30000,
      model: 'claude-opus-4-8',
    });
    try {
      await backend.generate(${REQUEST('claude-not-a-model')});${REPORT}
    finally { await backend.close(); }
  `);
}

function assertOffModeOutcome(label, result) {
  if (label === 'claude') {
    // The Claude fixture always refuses, so off mode means a plain backend
    // failure rather than the surface's model 404.
    assert.equal(result.outcome, 'rejected', label);
    assert.equal(result.status, undefined, `${label}: must not be a ProxyRequestError`);
    return;
  }
  // The Codex paths must actually complete: "not a 404" would also be satisfied
  // by an unrelated 500 or a thrown error.
  assert.equal(result.outcome, 'allowed', `${label}: off must let the request through`);
}

// Each runtime, both settings values. The false case is the control: without it,
// a "rejected" result could come from something other than the setting.
const PATHS = [
  ['codex-backend (default transport)', codexBackendOutcome],
  ['codex app-server', appServerOutcome],
  ['claude', claudeOutcome],
];

for (const [label, run] of PATHS) {
  test(`settings.json honorRequestModel:true reaches ${label}`, async () => {
    const result = await run(true);
    assert.equal(result.outcome, 'rejected', `${label}: the setting must enable validation`);
    assert.equal(result.status, 404);
  });

  test(`settings.json honorRequestModel:false leaves ${label} unvalidated`, async () => {
    const result = await run(false);
    assertOffModeOutcome(label, result);
  });

  test(`settings.json without modelSelection behaves as off for ${label}`, async () => {
    // The backward-compatible default. If the loader's fallback flipped to true,
    // an older install would start rejecting requests it used to accept.
    const result = await run(undefined);
    assertOffModeOutcome(label, result);
  });
}

test('the checked-in settings file is never written by these tests', async () => {
  const content = JSON.parse(await readFile(join(repoRoot, 'settings.json'), 'utf8'));
  assert.equal(content.modelSelection.honorRequestModel, false);
});
