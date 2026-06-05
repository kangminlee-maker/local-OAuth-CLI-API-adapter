#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const args = process.argv.slice(2);
const keepTemp = args.includes('--keep-temp');
const outDir = resolve(repoRoot, readValueArg('--out-dir') ?? 'artifacts');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

const pkg = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
const artifactPath = join(outDir, packageArtifactName(pkg.name, pkg.version));

run(process.execPath, [join(repoRoot, 'scripts/package-adapter.mjs'), '--out-dir', outDir]);

const consumerDir = await mkdtemp(join(tmpdir(), 'ggui-oauth-cli-e2e-consumer-'));
const codexHome = join(consumerDir, '.codex-home');
const fakeCodexPath = join(consumerDir, 'fake-codex.cjs');
let proxyProcess;

try {
  await writeFile(join(consumerDir, 'package.json'), JSON.stringify({
    private: true,
    type: 'module',
  }, null, 2));
  await mkdir(codexHome, { recursive: true });
  await writeFile(join(codexHome, 'auth.json'), '{"token":"local-e2e"}\n');
  await writeFile(join(codexHome, 'config.toml'), 'model = "gpt-e2e-model"\n');
  await writeFile(fakeCodexPath, fakeCodexSource());
  await chmod(fakeCodexPath, 0o755);

  run(pnpm, ['add', '-D', artifactPath], { cwd: consumerDir });

  const port = await freePort();
  proxyProcess = startProxy(consumerDir, codexHome, fakeCodexPath, port);
  await waitForOutput(proxyProcess, 'local OAuth CLI API proxy ready', 10_000);

  const openAiBaseUrl = `http://127.0.0.1:${port}/v1`;
  await assertModels(openAiBaseUrl);
  await assertChatCompletion(openAiBaseUrl);
  await assertChatStream(openAiBaseUrl);
  await assertImage2Generation(openAiBaseUrl);

  process.stdout.write(`installed adapter E2E passed: ${openAiBaseUrl}\n`);
} finally {
  if (proxyProcess) await stopProcess(proxyProcess);
  if (keepTemp) {
    process.stdout.write(`kept E2E consumer temp dir: ${consumerDir}\n`);
  } else {
    await rm(consumerDir, { recursive: true, force: true });
  }
}

function readValueArg(name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd ?? repoRoot,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (options.capture) {
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
    }
    throw new Error(`${command} ${commandArgs.join(' ')} failed with exit code ${result.status}`);
  }
  return result.stdout ?? '';
}

function packageArtifactName(name, version) {
  const normalizedName = String(name).replace(/^@/, '').replace(/\//g, '-');
  return `${normalizedName}-${version}.tgz`;
}

function startProxy(consumerDir, codexHome, fakeCodexPath, port) {
  const child = spawn(pnpm, [
    'exec',
    'ggui-oauth-cli',
    'proxy',
    '--runtime',
    'codex',
    '--command',
    fakeCodexPath,
    '--port',
    String(port),
    '--cwd',
    consumerDir,
    '--timeout-ms',
    '10000',
  ], {
    cwd: consumerDir,
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: 'fake-anthropic-key',
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      CODEX_HOME: codexHome,
      FAKE_ASSERT_NO_DIRECT_PROVIDER_ENV: '1',
      OPENAI_API_KEY: 'fake-openai-key',
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.collectedStdout = '';
  child.collectedStderr = '';
  child.stdout.on('data', (chunk) => {
    child.collectedStdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    child.collectedStderr += chunk;
  });
  return child;
}

async function waitForOutput(child, text, timeoutMs) {
  if (child.collectedStdout.includes(text)) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error([
        `Timed out waiting for proxy output: ${text}`,
        '--- stdout ---',
        child.collectedStdout,
        '--- stderr ---',
        child.collectedStderr,
      ].join('\n')));
    }, timeoutMs);

    const onStdout = () => {
      if (!child.collectedStdout.includes(text)) return;
      cleanup();
      resolve();
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error([
        `Proxy exited before ready: code=${code ?? 'null'} signal=${signal ?? 'null'}`,
        '--- stdout ---',
        child.collectedStdout,
        '--- stderr ---',
        child.collectedStderr,
      ].join('\n')));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off('data', onStdout);
      child.off('exit', onExit);
    };

    child.stdout.on('data', onStdout);
    child.once('exit', onExit);
  });
}

async function assertModels(baseUrl) {
  const res = await fetch(`${baseUrl}/models`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.object, 'list');
  assert.equal(body.data[0].id, 'codex-app-server');
  assert.equal(body.data[0].owned_by, 'local-oauth-cli');
}

async function assertChatCompletion(baseUrl) {
  const res = await postJson(`${baseUrl}/chat/completions`, {
    model: 'codex-app-server',
    messages: [{ role: 'user', content: 'Say OK' }],
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.match(body.id, /^chatcmpl-local_/);
  assert.equal(body.choices[0].message.content, 'MEDIUM_OK');
  assert.equal(body.choices[0].finish_reason, 'stop');
  assert.equal(body.usage.prompt_tokens, 5);
  assert.equal(body.usage.completion_tokens, 2);
  assert.equal(body.usage.total_tokens, 9);
  assert.equal(body.usage.prompt_tokens_details.cached_tokens, 2);
}

async function assertChatStream(baseUrl) {
  const res = await postJson(`${baseUrl}/chat/completions`, {
    model: 'codex-app-server',
    stream: true,
    stream_options: { include_usage: true },
    messages: [{ role: 'user', content: 'EARLY_DELTA' }],
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
  const sseText = await res.text();
  const data = parseSseData(sseText);
  assert.ok(data.includes('[DONE]'));

  const chunks = data
    .filter((item) => item !== '[DONE]')
    .map((item) => JSON.parse(item));
  const streamedText = chunks
    .map((chunk) => chunk.choices?.[0]?.delta?.content ?? '')
    .join('');
  assert.equal(streamedText, 'EARLY_OK');
  assert.ok(chunks.some((chunk) => chunk.usage?.prompt_tokens === 7));
}

async function assertImage2Generation(baseUrl) {
  const res = await postJson(`${baseUrl}/images/generations`, {
    model: 'image-2',
    prompt: 'A small red square.',
    response_format: 'b64_json',
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.length, 1);
  assert.match(Buffer.from(body.data[0].b64_json, 'base64').toString('utf8'), /installed-fake-image/);
  assert.equal(body.data[0].revised_prompt, 'installed fake revised image prompt');
}

async function postJson(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: {
      authorization: 'Bearer local',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function parseSseData(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice('data: '.length));
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  if (!address || typeof address === 'string') throw new Error('Unable to allocate a local test port.');
  return address.port;
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode) return;
  const exited = once(child, 'exit').then(() => true);
  killProcess(child, 'SIGTERM');
  const graceful = await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(() => resolve(false), 2_000)),
  ]);
  if (!graceful && child.exitCode === null && !child.signalCode) {
    killProcess(child, 'SIGKILL');
    await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }
}

function killProcess(child, signal) {
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (err) {
    if (err?.code !== 'ESRCH') throw err;
  }
}

function fakeCodexSource() {
  return String.raw`#!/usr/bin/env node
const readline = require('node:readline');

assertNoDirectProviderEnv();

let threadSeq = 0;
let turnSeq = 0;

function write(value) {
  process.stdout.write(JSON.stringify(value) + '\n');
}

function result(id, value = {}) {
  write({ id, result: value });
}

function inputText(payload) {
  return JSON.stringify(payload.params && payload.params.input || []);
}

function usage(totalTokens, inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens) {
  return {
    totalTokens,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
  };
}

function emitTurn(threadId, turnId, text, tokenUsage) {
  write({
    method: 'item/agentMessage/delta',
    params: { threadId, turnId, delta: text },
  });
  write({
    method: 'turn/completed',
    params: {
      threadId,
      turn: { id: turnId, status: 'completed' },
    },
  });
  setTimeout(() => {
    write({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId,
        turnId,
        tokenUsage: { last: tokenUsage },
      },
    });
  }, 0);
}

function emitEarlyTurn(threadId, turnId) {
  write({
    method: 'item/agentMessage/delta',
    params: { threadId, turnId, delta: 'EARLY_OK' },
  });
  write({
    method: 'thread/tokenUsage/updated',
    params: {
      threadId,
      turnId,
      tokenUsage: { last: usage(11, 7, 3, 2, 1) },
    },
  });
  write({
    method: 'turn/completed',
    params: {
      threadId,
      turn: { id: turnId, status: 'completed' },
    },
  });
}

function emitImageTurn(threadId, turnId) {
  write({
    method: 'item/completed',
    params: {
      threadId,
      turnId,
      item: {
        type: 'imageGeneration',
        id: 'image_' + turnId,
        status: 'completed',
        revisedPrompt: 'installed fake revised image prompt',
        result: Buffer.from('installed-fake-image'.repeat(90)).toString('base64'),
      },
    },
  });
  write({
    method: 'thread/tokenUsage/updated',
    params: {
      threadId,
      turnId,
      tokenUsage: { last: usage(17, 11, 4, 6, 2) },
    },
  });
  write({
    method: 'turn/completed',
    params: {
      threadId,
      turn: { id: turnId, status: 'completed' },
    },
  });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let payload;
  try {
    payload = JSON.parse(line);
  } catch {
    return;
  }

  if (payload.id === undefined) return;
  if (payload.method === 'initialize') {
    result(payload.id);
    return;
  }
  if (payload.method === 'thread/start') {
    threadSeq += 1;
    result(payload.id, { thread: { id: 'thread_' + threadSeq } });
    return;
  }
  if (payload.method === 'turn/start') {
    turnSeq += 1;
    const threadId = payload.params && payload.params.threadId || 'thread_' + threadSeq;
    const turnId = 'turn_' + turnSeq;
    const input = inputText(payload);
    if (input.includes('imageGeneration result')) {
      result(payload.id, { turn: { id: turnId } });
      setTimeout(() => emitImageTurn(threadId, turnId), 0);
      return;
    }
    if (input.includes('EARLY_DELTA')) {
      emitEarlyTurn(threadId, turnId);
      result(payload.id, { turn: { id: turnId } });
      return;
    }
    const effort = payload.params && payload.params.effort;
    const text = effort === 'medium' ? 'MEDIUM_OK' : 'OK';
    result(payload.id, { turn: { id: turnId } });
    setTimeout(() => emitTurn(threadId, turnId, text, usage(9, 5, 2, 2, 0)), 0);
    return;
  }
  if (payload.method === 'turn/interrupt' || payload.method === 'thread/archive') {
    result(payload.id);
    return;
  }

  write({
    id: payload.id,
    error: { code: -32601, message: 'unsupported fake Codex method: ' + payload.method },
  });
});

rl.on('close', () => process.exit(0));

function assertNoDirectProviderEnv() {
  if (process.env.FAKE_ASSERT_NO_DIRECT_PROVIDER_ENV !== '1') return;
  const found = Object.keys(process.env).filter(isDirectProviderEnvName);
  if (found.length > 0) {
    process.stderr.write('direct provider env leaked to installed fake codex: ' + found.join(',') + '\n');
    process.exit(91);
  }
}

function isDirectProviderEnvName(name) {
  const prefixes = [
    'ANTHROPIC',
    'AZURE_OPENAI',
    'COHERE',
    'DEEPSEEK',
    'GEMINI',
    'GOOGLE',
    'GROQ',
    'MISTRAL',
    'OPENAI',
    'OPENROUTER',
    'PERPLEXITY',
    'TOGETHER',
    'XAI',
  ];
  const suffixes = [
    'ACCESS_TOKEN',
    'API_BASE',
    'API_KEY',
    'AUTH_TOKEN',
    'BASE_URL',
    'ENDPOINT',
    'ORG_ID',
    'ORGANIZATION',
    'PROJECT',
  ];
  return prefixes.some((prefix) => suffixes.some((suffix) => name === prefix + '_' + suffix));
}
`;
}
