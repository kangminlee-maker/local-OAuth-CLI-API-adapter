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
const trees = [];

before(async () => {
  await chmod(fakeCodexModelsOk, 0o755);
});

after(async () => {
  await Promise.all(trees.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

// A streaming response commits its 200 the moment SSE headers are written. If
// model validation ran after that, the contracted 404 could never reach the
// client — it would see a truncated 200 instead. These drive the real HTTP
// surface rather than the backend directly, because that ordering only exists
// in the server.
async function treeWithSetting(honorRequestModel) {
  const root = await mkdtemp(join(tmpdir(), 'streaming-model-'));
  trees.push(root);
  await cp(join(repoRoot, 'dist'), join(root, 'dist'), { recursive: true });
  // `dist` resolves its runtime dependencies (`ajv`) from a `node_modules`
  // beside it, the way an installed package does.
  await symlink(join(repoRoot, 'node_modules'), join(root, 'node_modules'));
  const settings = JSON.parse(await readFile(join(repoRoot, 'settings.json'), 'utf8'));
  await writeFile(
    join(root, 'settings.json'),
    `${JSON.stringify({ ...settings, modelSelection: { honorRequestModel } }, null, 2)}\n`,
  );
  const home = join(root, 'codex-home');
  await mkdir(home, { recursive: true });
  await writeFile(
    join(home, 'auth.json'),
    `${JSON.stringify({
      tokens: { access_token: 't', account_id: 'a', refresh_token: 'r' },
    })}\n`,
  );
  return { root, home };
}

async function streamRequest({ honorRequestModel, path, body }) {
  const { root, home } = await treeWithSetting(honorRequestModel);
  const script = `
    import { startLocalApiProxy } from ${JSON.stringify(join(root, 'dist/proxy/http-server.js'))};
    import { CodexBackendTransport } from ${JSON.stringify(join(root, 'dist/proxy/codex-backend-transport.js'))};
    globalThis.fetch = async (url, init) => {
      if (String(url).startsWith('http://127.0.0.1')) return realFetch(url, init);
      return new Response(
        'data: ' + JSON.stringify({ type: 'response.output_text.delta', delta: 'OK' }) + '\\n\\n' +
        'data: ' + JSON.stringify({ type: 'response.completed', response: { id: 'r', model: 'x' } }) + '\\n\\n',
        { status: 200 },
      );
    };
    const realFetch = (await import('node:undici' in globalThis ? 'node:undici' : 'node:https')).default ?? null;
    const backend = new CodexBackendTransport({
      codexHome: ${JSON.stringify(home)},
      timeoutMs: 30000,
      model: 'gpt-5.5',
      codexCommand: ${JSON.stringify(fakeCodexModelsOk)},
    });
    const started = await startLocalApiProxy({ backend, host: '127.0.0.1', port: 0, requestTimeoutMs: 30000 });
    try {
      const res = await new Promise((resolveP, rejectP) => {
        const req = require('node:http').request(
          started.url + ${JSON.stringify(path)},
          { method: 'POST', headers: { 'content-type': 'application/json' } },
          (r) => {
            let text = '';
            r.setEncoding('utf8');
            r.on('data', (c) => { text += c; });
            r.on('end', () => resolveP({ status: r.statusCode, contentType: r.headers['content-type'], text }));
          },
        );
        req.on('error', rejectP);
        req.end(${JSON.stringify(JSON.stringify(body))});
      });
      process.stdout.write(JSON.stringify(res));
    } finally {
      await started.close();
    }
  `;
  // `require` needs CJS interop inside an ESM file; a .cjs wrapper is simpler.
  const scriptPath = join(root, 'probe.mjs');
  await writeFile(scriptPath, `import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);\n${script}`);
  const { stdout } = await execFileAsync(process.execPath, [scriptPath], { cwd: root });
  return JSON.parse(stdout);
}

const CASES = [
  {
    label: 'OpenAI chat completions',
    path: '/v1/chat/completions',
    body: { model: 'zzz-never-advertised', stream: true, messages: [{ role: 'user', content: 'hi' }] },
    expectCode: 'model_not_found',
  },
  {
    label: 'OpenAI responses',
    path: '/v1/responses',
    body: { model: 'zzz-never-advertised', stream: true, input: 'hi' },
    expectCode: 'model_not_found',
  },
  {
    label: 'Anthropic messages',
    path: '/v1/messages',
    body: { model: 'zzz-never-advertised', stream: true, max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] },
    expectType: 'not_found_error',
  },
];

for (const testCase of CASES) {
  test(`streaming ${testCase.label}: an unsupported model is a 404, not a committed 200`, async () => {
    const res = await streamRequest({ honorRequestModel: true, path: testCase.path, body: testCase.body });
    assert.equal(res.status, 404, `body: ${res.text}`);
    assert.ok(!String(res.contentType).includes('event-stream'), `must not have committed SSE: ${res.contentType}`);
    const payload = JSON.parse(res.text);
    if (testCase.expectCode) assert.equal(payload.error.code, testCase.expectCode);
    if (testCase.expectType) assert.equal(payload.error.type, testCase.expectType);
  });
}

test('streaming with the switch off still streams, unvalidated', async () => {
  const res = await streamRequest({
    honorRequestModel: false,
    path: '/v1/chat/completions',
    body: { model: 'zzz-never-advertised', stream: true, messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.equal(res.status, 200);
  assert.ok(String(res.contentType).includes('event-stream'), res.contentType);
  // Committed headers alone would also be produced by a branch that returned an
  // empty stream without ever reaching the backend. Assert the backend's own
  // output arrived and the stream terminated properly.
  assert.ok(res.text.includes('OK'), `expected backend content in the stream: ${res.text}`);
  assert.ok(res.text.includes('[DONE]'), `expected a terminated stream: ${res.text}`);
});
