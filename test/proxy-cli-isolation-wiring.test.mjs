import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { chmod } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Everything else about the isolation switch is tested by constructing the
// backend directly, which cannot see the one seam that decides whether the CLI
// flag reaches it at all: delete the argument in proxy-cli and every other test
// stays green while the spawned child loads the operator's settings. This test
// starts the real CLI and reads the argv the child was actually spawned with.

const here = dirname(fileURLToPath(import.meta.url));
const builtCli = resolve(here, '../dist/proxy-cli.js');
const echoArgvClaude = resolve(here, 'fixtures/echo-argv-claude.cjs');

before(async () => { await chmod(echoArgvClaude, 0o755); });

/**
 * A port the OS just handed out and released. `--port 0` is not an ephemeral
 * request here — the CLI's option parser rejects a non-positive port and falls
 * back to its 8787 default — so the test picks a concrete free port instead of
 * racing whatever already owns the default.
 */
function freePort() {
  return new Promise((resolvePort, rejectPort) => {
    const probe = createServer();
    probe.on('error', rejectPort);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
}

/** Starts the proxy, resolves its base URL from the ready banner. */
function startProxy(extraArgs, port) {
  const child = spawn(process.execPath, [
    builtCli, 'proxy',
    '--accept-llm-guide=v1',
    '--runtime', 'claude',
    '--command', echoArgvClaude,
    '--port', String(port),
    ...extraArgs,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const url = new Promise((resolveUrl, rejectUrl) => {
    let out = '';
    let err = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { err += chunk; });
    const timer = setTimeout(() => rejectUrl(new Error(`proxy did not report a baseUrl: ${out}`)), 20_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      out += chunk;
      const match = out.match(/baseUrl: (http:\/\/\S+)\/v1/);
      if (match) {
        clearTimeout(timer);
        resolveUrl(match[1]);
      }
    });
    child.on('error', rejectUrl);
    child.on('exit', (code) => {
      clearTimeout(timer);
      rejectUrl(new Error(`proxy exited early (code=${code}): stdout=${out} stderr=${err}`));
    });
  });
  return { child, url };
}

/** The fixture echoes its argv as the turn's text, so the response carries it. */
async function childArgvThroughProxy(extraArgs) {
  const { child, url } = startProxy(extraArgs, await freePort());
  try {
    const baseUrl = await url;
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'local', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-opus-4-8', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }),
    });
    const body = await res.json();
    const text = body.content?.find((block) => block.type === 'text')?.text ?? '';
    return JSON.parse(text);
  } finally {
    child.kill('SIGTERM');
  }
}

function settingSourcesIn(argv) {
  const index = argv.indexOf('--setting-sources');
  assert.ok(index !== -1, `expected --setting-sources in child argv: ${argv.join(' ')}`);
  return argv[index + 1];
}

test('the CLI flag reaches the spawned child: isolated', async () => {
  const argv = await childArgvThroughProxy(['--isolate-user-settings']);
  assert.equal(settingSourcesIn(argv), '');
});

test('the spawned child isolates by default', async () => {
  const argv = await childArgvThroughProxy([]);
  assert.equal(settingSourcesIn(argv), '');
});

test('the CLI flag reaches the spawned child: opted out', async () => {
  const argv = await childArgvThroughProxy(['--isolate-user-settings', 'false']);
  assert.equal(settingSourcesIn(argv), 'user');
});

/** The native chat surface spawns its own child through the same CLI flag. */
async function chatSessionArgvThroughProxy(extraArgs) {
  const { child, url } = startProxy(extraArgs, await freePort());
  try {
    const baseUrl = await url;
    const created = await fetch(`${baseUrl}/local/cli/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer local' },
      body: JSON.stringify({ runtime: 'claude' }),
    });
    const session = await created.json();
    assert.equal(created.status, 201, `session create failed: ${JSON.stringify(session)}`);
    const turn = await fetch(`${baseUrl}/local/cli/sessions/${session.id}/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer local' },
      body: JSON.stringify({ input: [{ type: 'text', text: 'hi' }] }),
    });
    const body = await turn.json();
    // The fixture echoes its argv as the turn's result text, which the surface
    // carries through in the runtime event's raw payload.
    const echoed = (body.events ?? [])
      .map((event) => event?.raw?.result)
      .find((result) => typeof result === 'string');
    assert.ok(echoed, `no echoed argv in turn body: ${JSON.stringify(body).slice(0, 300)}`);
    return JSON.parse(echoed);
  } finally {
    child.kill('SIGTERM');
  }
}

test('the CLI flag reaches the native chat session child: isolated', async () => {
  const argv = await chatSessionArgvThroughProxy(['--isolate-user-settings']);
  assert.equal(settingSourcesIn(argv), '');
});

test('the native chat session child isolates by default', async () => {
  const argv = await chatSessionArgvThroughProxy([]);
  assert.equal(settingSourcesIn(argv), '');
});

test('the CLI flag reaches the native chat session child: opted out', async () => {
  const argv = await chatSessionArgvThroughProxy(['--isolate-user-settings', 'false']);
  assert.equal(settingSourcesIn(argv), 'user');
});
