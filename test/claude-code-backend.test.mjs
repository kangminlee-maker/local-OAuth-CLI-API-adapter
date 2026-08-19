import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { before, test } from 'node:test';
import { ClaudeCodeBackend } from '../dist/proxy/claude-code-backend.js';

const here = dirname(fileURLToPath(import.meta.url));
const fakeClaude = resolve(here, 'fixtures/fake-claude.cjs');
const echoArgvClaude = resolve(here, 'fixtures/echo-argv-claude.cjs');
const rejectModelClaude = resolve(here, 'fixtures/reject-model-claude.cjs');
const resultShapes = resolve(here, 'fixtures/claude-result-shapes.cjs');

before(async () => {
  await chmod(fakeClaude, 0o755);
  await chmod(echoArgvClaude, 0o755);
  await chmod(rejectModelClaude, 0o755);
  await chmod(resultShapes, 0o755);
});

test('ClaudeCodeBackend streams persistent text deltas', async () => {
  const backend = new ClaudeCodeBackend({
    command: fakeClaude,
    cwd: process.cwd(),
    timeoutMs: 30_000,
  });
  try {
    const events = [];
    for await (const event of backend.stream(textRequest())) {
      events.push(event);
    }

    assert.deepEqual(
      events.filter((event) => event.type === 'text_delta').map((event) => event.delta),
      ['O', 'K'],
    );
    const completed = events.find((event) => event.type === 'completed');
    assert.equal(completed.result.text, 'OK');
    assert.equal(completed.result.usage.inputTokens, 3);
    assert.equal(completed.result.usage.outputTokens, 2);
    assert.equal(completed.result.usage.cachedInputTokens, 3);
    assert.equal(completed.result.usage.cacheCreationInputTokens, 2);
    assert.equal(completed.result.usage.cacheReadInputTokens, 1);
    assert.equal(completed.result.usage.totalTokens, 8);
  } finally {
    await backend.close();
  }
});

test('ClaudeCodeBackend streams one-shot image text deltas', async () => {
  const backend = new ClaudeCodeBackend({
    command: fakeClaude,
    cwd: process.cwd(),
    timeoutMs: 30_000,
  });
  try {
    const events = [];
    for await (const event of backend.stream(imageTextRequest())) {
      events.push(event);
    }

    assert.deepEqual(
      events.filter((event) => event.type === 'text_delta').map((event) => event.delta),
      ['O', 'K'],
    );
    const completed = events.find((event) => event.type === 'completed');
    assert.equal(completed.result.text, 'OK');
  } finally {
    await backend.close();
  }
});

test('ClaudeCodeBackend parses structured tool decisions from persistent schema prompt output', async () => {
  const backend = new ClaudeCodeBackend({
    command: fakeClaude,
    cwd: process.cwd(),
    timeoutMs: 30_000,
  });
  try {
    const result = await backend.generate(toolRequest());

    assert.equal(result.text, '');
    assert.equal(result.toolCalls[0].id, 'call_1');
    assert.equal(result.toolCalls[0].name, 'get_weather');
    assert.equal(result.toolCalls[0].arguments, '{"city":"Seoul"}');
  } finally {
    await backend.close();
  }
});

test('ClaudeCodeBackend uses persistent JSON mode without losing exact JSON output', async () => {
  const backend = new ClaudeCodeBackend({
    command: fakeClaude,
    cwd: process.cwd(),
    timeoutMs: 30_000,
  });
  try {
    const result = await backend.generate(jsonSchemaRequest());

    assert.equal(result.text, '{"adapter":"local-oauth-cli","ok":true}');
    assert.deepEqual(result.toolCalls, []);
  } finally {
    await backend.close();
  }
});

test('ClaudeCodeBackend extracts live tool argument deltas from structured output', async () => {
  const backend = new ClaudeCodeBackend({
    command: fakeClaude,
    cwd: process.cwd(),
    timeoutMs: 30_000,
  });
  try {
    const events = [];
    for await (const event of backend.stream(toolRequest())) {
      events.push(event);
    }

    const deltas = events
      .filter((event) => event.type === 'tool_call_delta')
      .map((event) => event.argumentsDelta ?? '')
      .join('');
    assert.equal(deltas, '{"city":"Seoul"}');
    const completed = events.find((event) => event.type === 'completed');
    assert.equal(completed.result.toolCalls[0].arguments, '{"city":"Seoul"}');
  } finally {
    await backend.close();
  }
});

test('ClaudeCodeBackend does not pass direct provider env to child CLI', async () => {
  const snapshot = snapshotProviderEnv();
  setProviderEnv();
  const backend = new ClaudeCodeBackend({
    command: fakeClaude,
    cwd: process.cwd(),
    timeoutMs: 30_000,
  });

  try {
    const result = await backend.generate({
      ...textRequest(),
      stream: false,
    });
    assert.equal(result.text, 'OK');
  } finally {
    await backend.close();
    restoreProviderEnv(snapshot);
  }
});

function textRequest() {
  return {
    shape: 'openai-chat',
    model: 'claude-code-cli',
    messages: [{ role: 'user', content: 'Say OK' }],
    stream: true,
    jsonMode: false,
    tools: [],
    toolChoice: { type: 'auto' },
    raw: {},
  };
}

function snapshotProviderEnv() {
  return new Map(providerEnvNames().map((name) => [name, process.env[name]]));
}

function restoreProviderEnv(snapshot) {
  for (const [name, value] of snapshot) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

function setProviderEnv() {
  for (const name of providerEnvNames()) {
    process.env[name] = name === 'FAKE_ASSERT_NO_DIRECT_PROVIDER_ENV' ? '1' : `${name}_secret`;
  }
}

function providerEnvNames() {
  return [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_BASE_URL',
    'FAKE_ASSERT_NO_DIRECT_PROVIDER_ENV',
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
  ];
}

function imageTextRequest() {
  return {
    shape: 'openai-chat',
    model: 'claude-code-cli',
    messages: [{
      role: 'user',
      content: 'Describe the image',
      images: [{
        source: {
          type: 'base64',
          mediaType: 'image/png',
          data: 'iVBORw0KGgo=',
        },
        raw: {},
      }],
    }],
    stream: true,
    jsonMode: false,
    tools: [],
    toolChoice: { type: 'auto' },
    raw: {},
  };
}

function jsonSchemaRequest() {
  return {
    shape: 'openai-chat',
    model: 'claude-code-cli',
    messages: [{ role: 'user', content: 'Return adapter JSON' }],
    stream: false,
    streamOptions: { includeUsage: false, includeObfuscation: false },
    jsonMode: true,
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        adapter: { type: 'string' },
        ok: { type: 'boolean' },
      },
      required: ['adapter', 'ok'],
    },
    tools: [],
    toolChoice: { type: 'auto' },
    raw: {},
  };
}

function toolRequest() {
  return {
    shape: 'openai-chat',
    model: 'claude-code-cli',
    messages: [{ role: 'user', content: 'Use weather tool' }],
    stream: false,
    jsonMode: false,
    tools: [
      {
        name: 'get_weather',
        inputSchema: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
        raw: {},
      },
    ],
    toolChoice: { type: 'required' },
    raw: {},
  };
}

async function spawnedArgv(request, model, options = {}) {
  const backend = new ClaudeCodeBackend({
    command: echoArgvClaude,
    cwd: process.cwd(),
    model,
    timeoutMs: 30_000,
    ...options,
  });
  try {
    const result = await backend.generate(request);
    // Non-tool turns echo argv in result.text; forced-tool turns route the echoed
    // CLI output into the tool call's arguments.
    const raw = result.text || result.toolCalls?.[0]?.arguments || '';
    return JSON.parse(raw);
  } finally {
    await backend.close();
  }
}

// Every value the CLI would read as a model selection, in argv order. The parser
// is last-value-wins, so only the whole sequence says which model actually runs.
function modelArgsIn(argv) {
  return argv.flatMap((arg, i) => (arg === '--model' ? [argv[i + 1]] : []));
}

const PREFIX = 'claude model rejection (reported as 404): ';

const PROBE_SCHEMA = { type: 'object', additionalProperties: false, properties: {}, required: [] };

function anthropicTuningRequest(overrides) {
  return {
    shape: 'anthropic-messages',
    model: 'claude-opus-4-8',
    messages: [{ role: 'user', content: 'Say OK', images: [] }],
    stream: false,
    streamOptions: { includeUsage: false, includeObfuscation: false },
    jsonMode: false,
    tools: [],
    toolChoice: { type: 'auto' },
    raw: {},
    ...overrides,
  };
}

test('default: the user setting source loads', async () => {
  const argv = await spawnedArgv(
    anthropicTuningRequest({ model: 'claude-sonnet-5', effort: 'low' }),
    'claude-opus-4-8',
  );
  const i = argv.indexOf('--setting-sources');
  assert.ok(i !== -1, `expected --setting-sources in argv: ${argv.join(' ')}`);
  assert.equal(argv[i + 1], 'user');
});

test('isolateUserSettings loads no setting source, so the operator CLAUDE.md stays out', async () => {
  const argv = await spawnedArgv(
    anthropicTuningRequest({ model: 'claude-sonnet-5', effort: 'low' }),
    'claude-opus-4-8',
    { isolateUserSettings: true },
  );
  const i = argv.indexOf('--setting-sources');
  assert.ok(i !== -1, `expected --setting-sources in argv: ${argv.join(' ')}`);
  assert.equal(argv[i + 1], '');
});

test('honorRequestModel off: the request model never reaches --model', async () => {
  const argv = await spawnedArgv(
    anthropicTuningRequest({ model: 'claude-sonnet-5', effort: 'low' }),
    'claude-opus-4-8',
  );
  const i = argv.indexOf('--model');
  assert.ok(i !== -1, `expected --model in argv: ${argv.join(' ')}`);
  assert.equal(argv[i + 1], 'claude-opus-4-8');
});

test('honorRequestModel off with nothing configured: no --model is forwarded at all', async () => {
  // Claude's pre-existing behaviour, kept exactly: with honouring off the request
  // model is never forwarded, even when there is no configured model to prefer.
  // The CLI's own default runs. This is where Claude differs from the Codex
  // transports, and the contract documents the difference rather than papering
  // over it.
  const argv = await spawnedArgv(
    anthropicTuningRequest({ model: 'claude-sonnet-5', effort: 'low' }),
    undefined,
  );
  assert.ok(!argv.includes('--model'), `did not expect --model in argv: ${argv.join(' ')}`);
});

test('honorRequestModel on: the request model wins over the configured one', async () => {
  const argv = await spawnedArgv(
    anthropicTuningRequest({ model: 'claude-sonnet-5', effort: 'low' }),
    'claude-opus-4-8',
    { honorRequestModel: true },
  );
  const i = argv.indexOf('--model');
  assert.ok(i !== -1, `expected --model in argv: ${argv.join(' ')}`);
  assert.equal(argv[i + 1], 'claude-sonnet-5');
});

test('honorRequestModel on: a request without a model falls back to the configured one', async () => {
  const argv = await spawnedArgv(
    anthropicTuningRequest({ model: '', effort: 'low' }),
    'claude-opus-4-8',
    { honorRequestModel: true },
  );
  const i = argv.indexOf('--model');
  assert.ok(i !== -1, `expected --model in argv: ${argv.join(' ')}`);
  assert.equal(argv[i + 1], 'claude-opus-4-8');
});

test('honorRequestModel on: the backend identifier is treated as a model name', async () => {
  // No longer special-cased. `GET /v1/models` stopped advertising it, so a
  // client has no reason to send it, and if one does the CLI validates it.
  const argv = await spawnedArgv(
    anthropicTuningRequest({ model: 'claude-code-cli', effort: 'low' }),
    'claude-opus-4-8',
    { honorRequestModel: true },
  );
  assert.equal(argv[argv.indexOf('--model') + 1], 'claude-code-cli');
});

test('honorRequestModel on, nothing configured: the identifier still reaches --model', async () => {
  // The case where the identifier could quietly succeed. With no configured
  // model `backend.model` IS `claude-code-cli`, so any routing that compared the
  // request against the public identifier instead of the configured model would
  // find them equal, reuse the persistent process — spawned without `--model`,
  // i.e. the CLI default — and return 200 for a model the contract promises 404
  // for. Forwarding it here is what proves the comparison is against the
  // configured model, and that one-shot is what runs.
  //
  // No tuning flags, so nothing else forces one-shot: the model comparison is
  // the only thing that can send this request off the persistent route.
  const argv = await spawnedArgv(
    anthropicTuningRequest({ model: 'claude-code-cli' }),
    undefined,
    { honorRequestModel: true },
  );
  assert.ok(argv.includes('-p'), `expected the one-shot path: ${argv.join(' ')}`);
  // Every `--model` value, not the first: the CLI is last-value-wins, so an argv
  // carrying `--model claude-code-cli --model sonnet` would run `sonnet` while a
  // first-occurrence check called it a pass. An exact array also fails when the
  // flag is absent entirely, which `indexOf(...) + 1` (0) would not.
  assert.deepEqual(modelArgsIn(argv), ['claude-code-cli']);
});

test('honorRequestModel on, nothing configured: the CLI refusing the identifier is a 404', async () => {
  // The other half: the refusal the previous test makes reachable is mapped to
  // the surface's own not-found error, not to a 500 — and never to a 200 from
  // the CLI default.
  //
  // The fixture refuses whatever it is given, including nothing, so the status
  // alone would not prove the model was forwarded. Assert the recorded argv too.
  const argvDir = await mkdtemp(join(tmpdir(), 'claude-argv-'));
  const argvLog = join(argvDir, 'argv.log');
  const previousLog = process.env.CLAUDE_TEST_ARGV_LOG;
  process.env.CLAUDE_TEST_ARGV_LOG = argvLog;
  try {
    await assert.rejects(
      () => runAgainstRejectingClaude(
        { ...anthropicTuningRequest({ model: 'claude-code-cli', effort: 'low' }), shape: 'openai-chat' },
        undefined,
        { honorRequestModel: true },
      ),
      (err) => {
        assert.equal(err.statusCode, 404, `expected 404, got: ${err.message}`);
        assert.equal(err.code, 'model_not_found');
        assert.equal(err.param, 'model');
        return true;
      },
    );
    // Validate every recorded spawn, not just the first line: a second spawn
    // with different argv would otherwise be invisible, and so would a repeated
    // `--model` within one spawn.
    const spawns = (await readFile(argvLog, 'utf8')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(spawns.length, 1, `expected exactly one spawn, got ${spawns.length}`);
    for (const argv of spawns) assert.deepEqual(modelArgsIn(argv), ['claude-code-cli']);
  } finally {
    if (previousLog === undefined) delete process.env.CLAUDE_TEST_ARGV_LOG;
    else process.env.CLAUDE_TEST_ARGV_LOG = previousLog;
    await rm(argvDir, { recursive: true, force: true });
  }
});


test('honorRequestModel on: an extra --model cannot override the requested model', async () => {
  // Operator extra arguments are appended after the resolved model, so leaving
  // one in would win on a last-value-wins parser.
  const argv = await spawnedArgv(
    anthropicTuningRequest({ model: 'claude-sonnet-5', effort: 'low' }),
    'claude-opus-4-8',
    { honorRequestModel: true, extraArgs: ['--model', 'claude-haiku-4-5', '--debug'] },
  );
  const models = argv.filter((arg, i) => argv[i - 1] === '--model');
  assert.deepEqual(models, ['claude-sonnet-5'], `expected exactly one model: ${argv.join(' ')}`);
  assert.ok(argv.includes('--debug'), 'other extra args must survive');
});

test('honorRequestModel on: an extra --fallback-model cannot substitute the requested model', async () => {
  // In print mode Claude switches to the fallback when the primary is
  // overloaded, which would run a model other than the one the response echoes.
  const argv = await spawnedArgv(
    anthropicTuningRequest({ model: 'claude-sonnet-5', effort: 'low' }),
    'claude-opus-4-8',
    { honorRequestModel: true, extraArgs: ['--fallback-model=claude-opus-4-8', '--debug'] },
  );
  assert.ok(!argv.some((arg) => arg.startsWith('--fallback-model')), `argv: ${argv.join(' ')}`);
  assert.ok(argv.includes('--debug'), 'other extra args must survive');
});

test('honorRequestModel on: a model string that cannot be an argument is a 404, not a spawn failure', async () => {
  // A raw client can send a JSON string containing NUL. Node refuses that argv
  // element before the CLI starts, which must not surface as a server fault.
  // Run against the ordinary echo fixture, not the refusing one: without the
  // guard this fails inside spawn with ERR_INVALID_ARG_VALUE, so the fixture
  // cannot manufacture the 404.
  const backend = new ClaudeCodeBackend({
    command: echoArgvClaude,
    cwd: process.cwd(),
    model: 'claude-opus-4-8',
    timeoutMs: 30_000,
    honorRequestModel: true,
  });
  try {
    await assert.rejects(
      () => backend.generate(anthropicTuningRequest({ model: 'bad\u0000model', effort: 'low' })),
      (err) => {
        assert.equal(err.statusCode, 404, `expected 404, got: ${err.message}`);
        assert.equal(err.type, 'not_found_error');
        return true;
      },
    );
  } finally {
    await backend.close();
  }
});


test('honorRequestModel off: extra args are left exactly as the operator gave them', async () => {
  const argv = await spawnedArgv(
    anthropicTuningRequest({ model: 'claude-sonnet-5', effort: 'low' }),
    'claude-opus-4-8',
    { extraArgs: ['--model', 'claude-haiku-4-5'] },
  );
  const models = argv.filter((arg, i) => argv[i - 1] === '--model');
  assert.deepEqual(models, ['claude-opus-4-8', 'claude-haiku-4-5']);
});

test('honorRequestModel on: an option-shaped model stays model data and cannot re-open tools', async () => {
  // Verified against the real CLI: the token after `--model` is consumed as its
  // value (`--help`, `--version`, `-p`, `--tools=Read,Glob,Grep` all produce the
  // model-refusal diagnostic). This pins our side of that contract: the value is
  // passed as the model argument and the tool isolation flags stay intact.
  const argv = await spawnedArgv(
    anthropicTuningRequest({ model: '--tools=Read,Glob,Grep', effort: 'low' }),
    'claude-opus-4-8',
    { honorRequestModel: true },
  );
  const modelIndex = argv.indexOf('--model');
  assert.notEqual(modelIndex, -1);
  assert.equal(argv[modelIndex + 1], '--tools=Read,Glob,Grep');
  // The isolation flag is still present, and still empty.
  const toolsIndex = argv.indexOf('--tools');
  assert.notEqual(toolsIndex, -1, `expected --tools isolation: ${argv.join(' ')}`);
  assert.equal(argv[toolsIndex + 1], '');
  // And it is applied before the model value, so the hostile token cannot be a
  // later override of an earlier isolation flag.
  assert.ok(toolsIndex < modelIndex, `expected --tools before --model: ${argv.join(' ')}`);
});

test('honorRequestModel on: tuning flags gate on the requested model, not the configured one', async () => {
  // Haiku supports neither effort nor adaptive thinking. With the request model
  // honoured it is the model the CLI actually runs, so the gate has to follow it
  // even though the configured model is Opus.
  const argv = await spawnedArgv(
    anthropicTuningRequest({ model: 'claude-haiku-4-5', effort: 'high' }),
    'claude-opus-4-8',
    { honorRequestModel: true },
  );
  assert.equal(argv[argv.indexOf('--model') + 1], 'claude-haiku-4-5');
  assert.ok(!argv.includes('--effort'), `did not expect --effort for Haiku: ${argv.join(' ')}`);
});

async function runAgainstRejectingClaude(request, model, options = {}) {
  const backend = new ClaudeCodeBackend({
    command: rejectModelClaude,
    cwd: process.cwd(),
    model,
    timeoutMs: 30_000,
    ...options,
  });
  try {
    return await backend.generate(request);
  } finally {
    await backend.close();
  }
}

test('honorRequestModel on: the CLI refusing the model becomes a 404 on OpenAI surfaces', async () => {
  await assert.rejects(
    () => runAgainstRejectingClaude(
      { ...anthropicTuningRequest({ model: 'claude-not-a-model', effort: 'low' }), shape: 'openai-chat' },
      'claude-opus-4-8',
      { honorRequestModel: true },
    ),
    (err) => {
      assert.equal(err.statusCode, 404);
      assert.equal(err.provider, 'openai');
      assert.equal(err.type, 'invalid_request_error');
      assert.equal(err.code, 'model_not_found');
      assert.equal(err.param, 'model');
      return true;
    },
  );
});

test('honorRequestModel on: the same refusal takes the anthropic error shape', async () => {
  await assert.rejects(
    () => runAgainstRejectingClaude(
      anthropicTuningRequest({ model: 'claude-not-a-model', effort: 'low' }),
      'claude-opus-4-8',
      { honorRequestModel: true },
    ),
    (err) => {
      assert.equal(err.statusCode, 404);
      assert.equal(err.provider, 'anthropic');
      assert.equal(err.type, 'not_found_error');
      return true;
    },
  );
});

test('honorRequestModel on: a refusal on the persistent path is a 404 too', async () => {
  // No tuning flags and a request naming the configured model, so this takes the
  // persistent route rather than one-shot. The same model must produce the same
  // status on either route.
  const argvLog = join(await mkdtemp(join(tmpdir(), 'claude-argv-')), 'argv.log');
  process.env.CLAUDE_TEST_ARGV_LOG = argvLog;
  try {
    await assert.rejects(
      () => runAgainstRejectingClaude(
        anthropicTuningRequest({ model: 'claude-retired' }),
        'claude-retired',
        { honorRequestModel: true },
      ),
      (err) => {
        assert.equal(err.statusCode, 404, `expected 404, got: ${err.message}`);
        assert.equal(err.type, 'not_found_error');
        return true;
      },
    );
    // Confirms the route: the one-shot path passes the prompt as an argument.
    // Without this the test would pass even if the request had silently fallen
    // back to one-shot, which the other tests already cover.
    const argv = JSON.parse((await readFile(argvLog, 'utf8')).trim().split('\n')[0]);
    assert.ok(
      !argv.some((arg) => arg.includes('Say OK')),
      `expected the persistent route (no prompt argument): ${argv.join(' ')}`,
    );
  } finally {
    delete process.env.CLAUDE_TEST_ARGV_LOG;
  }
});

// Each recognition branch gets its own shape, so a fixture cannot satisfy two
// branches and make either look proven. `assistant_only` and `result_only` carry
// result text that matches no pattern, so only their structured field can
// classify them; `sentence_only` carries neither field.
async function runShape(shape, request, model, options = {}) {
  const previous = process.env.CLAUDE_TEST_RESULT_SHAPE;
  process.env.CLAUDE_TEST_RESULT_SHAPE = shape;
  try {
    return await runAgainstRejectingClaude(request, model, { command: resultShapes, ...options });
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_TEST_RESULT_SHAPE;
    else process.env.CLAUDE_TEST_RESULT_SHAPE = previous;
  }
}

function openAiRefusalRequest(overrides) {
  return { ...anthropicTuningRequest(overrides), shape: 'openai-chat' };
}

for (const shape of ['assistant_only', 'result_only', 'sentence_only']) {
  test(`honorRequestModel on: the ${shape} refusal shape maps to 404`, async () => {
    await assert.rejects(
      () => runShape(
        shape,
        openAiRefusalRequest({ model: 'claude-not-a-model', effort: 'low' }),
        'claude-opus-4-8',
        { honorRequestModel: true },
      ),
      (err) => {
        assert.equal(err.statusCode, 404, `expected 404, got: ${err.message}`);
        assert.equal(err.code, 'model_not_found');
        assert.equal(err.param, 'model');
        return true;
      },
    );
  });
}

test('honorRequestModel on: an errored 404 carrying no model signal is not a model error', async () => {
  // The measured ambiguity has a floor: when NOTHING in the stream names the
  // model, the proxy must not invent `model_not_found` — and must not resolve an
  // `is_error` result as a 200 assistant reply either, which is the shape of the
  // original defect.
  await assert.rejects(
    () => runShape(
      'bare_404',
      openAiRefusalRequest({ model: 'claude-not-a-model', effort: 'low' }),
      'claude-opus-4-8',
      { honorRequestModel: true },
    ),
    (err) => {
      assert.notEqual(err.statusCode, 404, 'a bare gateway 404 must not be reported as a model error');
      assert.equal(err.code, undefined);
      assert.equal(err.param, undefined);
      assert.match(err.message, /upstream returned 404/);
      return true;
    },
  );
});

test('one-shot: a result record split across stream chunks still resolves', async () => {
  // NDJSON records are framed by newlines, not by pipe chunks: a result line
  // longer than one chunk arrives in pieces. Parsing each chunk alone dropped
  // both halves, and the clean exit then left the request hanging forever.
  // A different request model forces the one-shot route.
  const result = await runShape(
    'split_result',
    openAiRefusalRequest({ model: 'claude-split-probe', effort: 'low' }),
    'claude-opus-4-8',
    { honorRequestModel: true },
  );
  assert.match(result.text, /split-ok/);
});

test('one-shot: a clean exit with no result settles as a failure, not a hang', async () => {
  // The hang is converted into a bounded outcome here, so a regression fails
  // the assertion instead of stalling the whole suite.
  const timer = new Promise((resolve) => {
    setTimeout(() => resolve({ kind: 'hung' }), 5000).unref();
  });
  const outcome = await Promise.race([
    runShape(
      'silent_exit_zero',
      openAiRefusalRequest({ model: 'claude-split-probe', effort: 'low' }),
      'claude-opus-4-8',
      { honorRequestModel: true },
    ).then(
      (value) => ({ kind: 'resolved', value }),
      (err) => ({ kind: 'rejected', err }),
    ),
    timer,
  ]);
  assert.equal(outcome.kind, 'rejected', `a resultless 0 exit must reject the turn, got: ${outcome.kind}`);
  assert.match(outcome.err.message, /exited without a result/);
});

test('persistent route: a result carrying raw U+2028/U+2029 arrives intact', async () => {
  // JSON.stringify does not escape the Unicode line separators, so they appear
  // RAW inside a legal one-line NDJSON record. Records are framed by LF alone;
  // a reader that also breaks on U+2028/U+2029 (readline does) shreds the
  // record into unparseable fragments and the turn never settles. Same model
  // as configured and no tuning overrides, so this takes the persistent route;
  // the short timeout bounds the hang a regression would otherwise become.
  const result = await runShape(
    'ls_in_result',
    openAiRefusalRequest({ model: 'claude-opus-4-8' }),
    'claude-opus-4-8',
    { honorRequestModel: true, timeoutMs: 5000 },
  );
  assert.equal(result.text, 'kept\u2028and\u2029kept');
});

test('honorRequestModel on: the assistant-event refusal is a 404 on the persistent route too', async () => {
  // The one-shot cases above cannot reach `handlePersistentLine`, because forcing
  // a different model is what sends a request one-shot. Configure and request the
  // same model so the persistent route runs.
  //
  // The route is proved by process count, not by argv: a one-shot regression
  // would spawn once per turn, while the persistent process is spawned once and
  // reused. The older "no prompt in argv" check could not tell the persistent
  // route from one-shot-with-stream-JSON-stdin, which also keeps argv clean.
  const argvDir = await mkdtemp(join(tmpdir(), 'claude-argv-'));
  const argvLog = join(argvDir, 'argv.log');
  const previousLog = process.env.CLAUDE_TEST_ARGV_LOG;
  const previousShape = process.env.CLAUDE_TEST_RESULT_SHAPE;
  process.env.CLAUDE_TEST_ARGV_LOG = argvLog;
  process.env.CLAUDE_TEST_RESULT_SHAPE = 'assistant_only';
  const diagnostics = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  // Everything that needs undoing is installed inside the try: a throw during
  // construction would otherwise leave stderr, the environment and the temp tree
  // as they are, contaminating later tests.
  let backend = null;
  try {
    process.stderr.write = (chunk) => {
      const line = String(chunk);
      if (line.includes('claude model rejection')) diagnostics.push(line);
      return true;
    };
    backend = new ClaudeCodeBackend({
      command: resultShapes,
      cwd: process.cwd(),
      model: 'claude-retired',
      timeoutMs: 30_000,
      honorRequestModel: true,
    });
    const request = { ...anthropicTuningRequest({ model: 'claude-retired' }), shape: 'openai-chat' };
    for (const attempt of [1, 2]) {
      await assert.rejects(
        () => backend.generate(request),
        (err) => {
          assert.equal(err.statusCode, 404, `attempt ${attempt}: expected 404, got: ${err.message}`);
          assert.equal(err.code, 'model_not_found');
          assert.equal(err.param, 'model');
          return true;
        },
      );
    }
    // One child per request, by design: the conversation lives in the process, so
    // the process is retired with the request. Each spawn answers exactly one
    // turn, and the model reaches each of them.
    const lines = (await readFile(argvLog, 'utf8')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const spawns = lines.filter((l) => l[0] !== '#turn');
    const turns = lines.filter((l) => l[0] === '#turn');
    assert.equal(spawns.length, 2, `each request gets its own child, saw ${spawns.length} spawns`);
    assert.equal(turns.length, 2, `expected two answered user turns, saw ${turns.length}`);
    const argv = spawns[0];
    assert.equal(argv[argv.indexOf('--model') + 1], 'claude-retired');
    // Which result settled which waiter. Each child counts its own turns, so a
    // fresh child answers `turn-1` again — the point is that each diagnostic
    // comes from its own request rather than one answering twice.
    assert.deepEqual(diagnostics.map((d) => /\[turn-(\d+)\]/.exec(d)?.[1]), ['1', '1']);
    // And the operator diagnostic fires on this route too, not only on one-shot.
    assert.equal(diagnostics.length, 2, `expected one diagnostic per turn, saw ${diagnostics.length}`);
  } finally {
    process.stderr.write = originalWrite;
    await backend?.close();
    if (previousLog === undefined) delete process.env.CLAUDE_TEST_ARGV_LOG;
    else process.env.CLAUDE_TEST_ARGV_LOG = previousLog;
    if (previousShape === undefined) delete process.env.CLAUDE_TEST_RESULT_SHAPE;
    else process.env.CLAUDE_TEST_RESULT_SHAPE = previousShape;
    await rm(argvDir, { recursive: true, force: true });
  }
});

test('honorRequestModel on: a bare 404 on the persistent route is not a model error either', async () => {
  // The same floor as the one-shot case, on the other recognition site: an
  // `is_error` result must not resolve as a 200 assistant reply just because its
  // subtype says `success`.
  const previousShape = process.env.CLAUDE_TEST_RESULT_SHAPE;
  process.env.CLAUDE_TEST_RESULT_SHAPE = 'bare_404';
  const backend = new ClaudeCodeBackend({
    command: resultShapes,
    cwd: process.cwd(),
    model: 'claude-retired',
    timeoutMs: 30_000,
    honorRequestModel: true,
  });
  try {
    await assert.rejects(
      () => backend.generate({ ...anthropicTuningRequest({ model: 'claude-retired' }), shape: 'openai-chat' }),
      (err) => {
        assert.notEqual(err.statusCode, 404, 'a bare gateway 404 must not be reported as a model error');
        assert.match(err.message, /upstream returned 404/);
        return true;
      },
    );
  } finally {
    await backend.close();
    if (previousShape === undefined) delete process.env.CLAUDE_TEST_RESULT_SHAPE;
    else process.env.CLAUDE_TEST_RESULT_SHAPE = previousShape;
  }
});

test('honorRequestModel on: the operator gets the runtime message, flattened to one line', async () => {
  // The mapped 404 carries a fixed sentence, so this write is the operator's only
  // record of what the runtime actually said. It is also the only place a
  // client-chosen string reaches a log, so it must not be able to forge a second
  // entry: the model here contains a newline and an ANSI escape.
  // A newline, an ANSI escape, and U+2028 — which is not a C0 control but which
  // Unicode-aware terminals and log processors still treat as a line break.
  const hostileModel = 'evil\u001b[31m\nclaude model rejection (reported as 404): forged\u2028also\u2029forged';
  const written = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    written.push(String(chunk));
    return originalWrite(chunk, ...rest);
  };
  const previousShape = process.env.CLAUDE_TEST_RESULT_SHAPE;
  process.env.CLAUDE_TEST_RESULT_SHAPE = 'assistant_only';
  try {
    await assert.rejects(() => runAgainstRejectingClaude(
      openAiRefusalRequest({ model: hostileModel, effort: 'low' }),
      'claude-opus-4-8',
      { honorRequestModel: true, command: resultShapes },
    ));
    const lines = written.filter((line) => line.includes('claude model rejection'));
    assert.equal(lines.length, 1, `expected exactly one diagnostic, got ${lines.length}`);
    assert.match(lines[0], /^claude model rejection \(reported as 404\): /);
    assert.match(lines[0], /localized refusal text the proxy does not parse/);
    // One trailing newline and no other line break: a forged second entry is the
    // whole point of escaping, and a raw ESC would be acted on by a terminal.
    assert.equal(lines[0].split('\n').length, 2, `diagnostic must be one line: ${JSON.stringify(lines[0])}`);
    assert.ok(!lines[0].includes('\u001b'), 'escape sequences must not survive');
    assert.ok(!lines[0].includes('\u2028'), 'U+2028 must not survive');
    assert.ok(!lines[0].includes('\u2029'), 'U+2029 must not survive');
    assert.ok(!lines[0].includes('Say OK'), 'the prompt must not be logged');
  } finally {
    process.stderr.write = originalWrite;
    if (previousShape === undefined) delete process.env.CLAUDE_TEST_RESULT_SHAPE;
    else process.env.CLAUDE_TEST_RESULT_SHAPE = previousShape;
  }
});

test('an errored result with no diagnostic field does not hand the client the event', async () => {
  // `readErrorMessage` used to serialize the whole result event, which carries
  // `session_id`, cost and usage — and that string becomes an HTTP 500 message.
  const previousShape = process.env.CLAUDE_TEST_RESULT_SHAPE;
  process.env.CLAUDE_TEST_RESULT_SHAPE = 'error_no_text';
  try {
    await assert.rejects(
      () => runAgainstRejectingClaude(
        openAiRefusalRequest({ model: 'claude-not-a-model', effort: 'low' }),
        'claude-opus-4-8',
        { honorRequestModel: true, command: resultShapes },
      ),
      (err) => {
        assert.ok(!err.message.includes('sentinel-session'), `session id leaked: ${err.message}`);
        assert.ok(!err.message.includes('total_cost_usd'), `event serialized: ${err.message}`);
        assert.match(err.message, /without a diagnostic message/);
        return true;
      },
    );
  } finally {
    if (previousShape === undefined) delete process.env.CLAUDE_TEST_RESULT_SHAPE;
    else process.env.CLAUDE_TEST_RESULT_SHAPE = previousShape;
  }
});

test('child stderr is the operator\'s, not the client\'s', async () => {
  // Claude's stderr can carry gateway detail, settings values, paths and auth
  // diagnostics. It used to be appended to the error, which becomes an HTTP 500
  // message or an in-band SSE error.
  const written = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => { written.push(String(chunk)); return true; };
  const previousShape = process.env.CLAUDE_TEST_RESULT_SHAPE;
  process.env.CLAUDE_TEST_RESULT_SHAPE = 'stderr_only';
  try {
    await assert.rejects(
      () => runAgainstRejectingClaude(
        openAiRefusalRequest({ model: 'claude-not-a-model', effort: 'low' }),
        'claude-opus-4-8',
        { honorRequestModel: true, command: resultShapes },
      ),
      (err) => {
        assert.ok(!err.message.includes('SENTINEL_STDERR'), `stderr reached the client: ${err.message}`);
        assert.ok(!err.message.includes('internal.example'), `stderr reached the client: ${err.message}`);
        // A fixed description: the exit code, no path, no OS text.
        assert.match(err.message, /the local claude runtime exited \(code=3/);
        return true;
      },
    );
    const diag = written.filter((l) => l.includes('claude process failure'));
    assert.equal(diag.length, 1, `operator must still get it once, saw ${diag.length}`);
    assert.match(diag[0], /SENTINEL_STDERR/);
  } finally {
    process.stderr.write = originalWrite;
    if (previousShape === undefined) delete process.env.CLAUDE_TEST_RESULT_SHAPE;
    else process.env.CLAUDE_TEST_RESULT_SHAPE = previousShape;
  }
});

test('a structured-output failure carrying only subtype and errors stays retryable', async () => {
  // The retry keys on the error text. When the diagnostic lives in `errors` and
  // the kind in `subtype`, a fixed generic message would erase both and silently
  // turn a retryable failure into a hard one.
  const previousShape = process.env.CLAUDE_TEST_RESULT_SHAPE;
  process.env.CLAUDE_TEST_RESULT_SHAPE = 'ede_retry';
  const argvDir = await mkdtemp(join(tmpdir(), 'claude-argv-'));
  const argvLog = join(argvDir, 'argv.log');
  const previousLog = process.env.CLAUDE_TEST_ARGV_LOG;
  process.env.CLAUDE_TEST_ARGV_LOG = argvLog;
  try {
    await assert.rejects(
      () => runAgainstRejectingClaude(
        // Anthropic shape with a schema: that is what puts `--json-schema` on the
        // spawned argv and so takes the one-shot route, which is where the
        // validate-and-retry loop lives. The OpenAI shape keeps the persistent
        // path and never retries.
        { ...anthropicTuningRequest({ model: 'claude-opus-4-8' }), jsonMode: true, jsonSchema: PROBE_SCHEMA },
        'claude-opus-4-8',
        { honorRequestModel: true, command: resultShapes },
      ),
      (err) => {
        assert.match(err.message, /error_during_execution/);
        assert.match(err.message, /ede_diagnostic/);
        assert.ok(!err.message.includes('sentinel-session'), `event leaked: ${err.message}`);
        return true;
      },
    );
    // Retried means spawned more than once: the retry is what proves the marker
    // survived into the message the classifier reads.
    const spawns = (await readFile(argvLog, 'utf8')).trim().split('\n').filter(Boolean)
      .map((l) => JSON.parse(l)).filter((l) => l[0] !== '#turn');
    assert.ok(spawns.length > 1, `expected a retry, saw ${spawns.length} spawn(s)`);
  } finally {
    if (previousLog === undefined) delete process.env.CLAUDE_TEST_ARGV_LOG;
    else process.env.CLAUDE_TEST_ARGV_LOG = previousLog;
    if (previousShape === undefined) delete process.env.CLAUDE_TEST_RESULT_SHAPE;
    else process.env.CLAUDE_TEST_RESULT_SHAPE = previousShape;
    await rm(argvDir, { recursive: true, force: true });
  }
});

test('the operator diagnostic is bounded, marker included', async () => {
  // A client picks the model, the CLI echoes it, and this line is written per
  // rejected request. Without a bound one request could flood an operator's log.
  // The bound has to cover the truncation marker too, or the "500 characters"
  // it advertises is really 514.
  const longModel = 'm'.repeat(4000);
  const written = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { written.push(String(chunk)); return true; };
  const previousShape = process.env.CLAUDE_TEST_RESULT_SHAPE;
  process.env.CLAUDE_TEST_RESULT_SHAPE = 'assistant_only';
  try {
    await assert.rejects(() => runAgainstRejectingClaude(
      openAiRefusalRequest({ model: longModel, effort: 'low' }),
      'claude-opus-4-8',
      { honorRequestModel: true, command: resultShapes },
    ));
    const line = written.find((l) => l.includes('claude model rejection'));
    assert.ok(line, 'expected the diagnostic');
    const body = line.slice(PREFIX.length, -1);
    assert.ok(body.length <= 500, `diagnostic body must stay within 500, got ${body.length}`);
    assert.ok(body.endsWith('...[truncated]'), `expected the truncation marker: ${body.slice(-30)}`);
  } finally {
    process.stderr.write = originalWrite;
    if (previousShape === undefined) delete process.env.CLAUDE_TEST_RESULT_SHAPE;
    else process.env.CLAUDE_TEST_RESULT_SHAPE = previousShape;
  }
});

test('a plain-text refusal on stderr is still a 404, and the stderr stays operator-side', async () => {
  // No structured event at all — the CLI's other reporting mode. Recognising the
  // sentence in the child's stderr is the only thing that can classify this, and
  // the bytes it was recognised from must not travel to the client.
  const written = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  const previousShape = process.env.CLAUDE_TEST_RESULT_SHAPE;
  try {
    process.stderr.write = (chunk) => { written.push(String(chunk)); return true; };
    process.env.CLAUDE_TEST_RESULT_SHAPE = 'plaintext_refusal';
    await assert.rejects(
      () => runAgainstRejectingClaude(
        openAiRefusalRequest({ model: 'zzz', effort: 'low' }),
        'claude-opus-4-8',
        { honorRequestModel: true, command: resultShapes },
      ),
      (err) => {
        assert.equal(err.statusCode, 404, `expected 404, got: ${err.message}`);
        assert.equal(err.code, 'model_not_found');
        assert.ok(!err.message.includes('Run --model'), `stderr reached the client: ${err.message}`);
        return true;
      },
    );
    assert.ok(
      written.some((l) => l.includes('claude process failure') && l.includes('issue with the selected model')),
      'the operator must still see what the runtime said',
    );
  } finally {
    process.stderr.write = originalWrite;
    if (previousShape === undefined) delete process.env.CLAUDE_TEST_RESULT_SHAPE;
    else process.env.CLAUDE_TEST_RESULT_SHAPE = previousShape;
  }
});

test('a persistent child dying mid-turn keeps its stderr operator-side', async () => {
  // The `failCurrent` path. Every other stderr test forces one-shot by asking for
  // a model other than the configured one, so this route was uncovered.
  const written = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  const previousShape = process.env.CLAUDE_TEST_RESULT_SHAPE;
  let backend = null;
  try {
    process.stderr.write = (chunk) => { written.push(String(chunk)); return true; };
    process.env.CLAUDE_TEST_RESULT_SHAPE = 'persistent_stderr';
    backend = new ClaudeCodeBackend({
      command: resultShapes,
      cwd: process.cwd(),
      model: 'claude-retired',
      timeoutMs: 30_000,
      honorRequestModel: true,
    });
    await assert.rejects(
      () => backend.generate({ ...anthropicTuningRequest({ model: 'claude-retired' }), shape: 'openai-chat' }),
      (err) => {
        assert.ok(!err.message.includes('SENTINEL_STDERR'), `stderr reached the client: ${err.message}`);
        assert.ok(!err.message.includes('internal.example'), `stderr reached the client: ${err.message}`);
        assert.match(err.message, /the local claude runtime exited/);
        return true;
      },
    );
    assert.ok(
      written.some((l) => l.includes('claude process failure') && l.includes('SENTINEL_STDERR')),
      `the operator must still see it: ${JSON.stringify(written)}`,
    );
  } finally {
    process.stderr.write = originalWrite;
    await backend?.close();
    if (previousShape === undefined) delete process.env.CLAUDE_TEST_RESULT_SHAPE;
    else process.env.CLAUDE_TEST_RESULT_SHAPE = previousShape;
  }
});

test('an oversized runtime diagnostic is bounded before it reaches the client', async () => {
  // `errors[]` is unrestricted text an upstream can fill. Its size is not theirs
  // to choose for the client, though the operator still gets it.
  const previousShape = process.env.CLAUDE_TEST_RESULT_SHAPE;
  const originalWrite = process.stderr.write.bind(process.stderr);
  try {
    process.stderr.write = () => true;
    process.env.CLAUDE_TEST_RESULT_SHAPE = 'huge_errors';
    await assert.rejects(
      () => runAgainstRejectingClaude(
        { ...anthropicTuningRequest({ model: 'claude-opus-4-8' }), jsonMode: true, jsonSchema: PROBE_SCHEMA },
        'claude-opus-4-8',
        { honorRequestModel: true, command: resultShapes },
      ),
      (err) => {
        assert.ok(err.message.length <= 500, `client message must be bounded to 500, got ${err.message.length}`);
        assert.match(err.message, /error_during_execution/);
        return true;
      },
    );
  } finally {
    process.stderr.write = originalWrite;
    if (previousShape === undefined) delete process.env.CLAUDE_TEST_RESULT_SHAPE;
    else process.env.CLAUDE_TEST_RESULT_SHAPE = previousShape;
  }
});

test('a runtime that cannot be spawned does not name its path to the client', async () => {
  // `spawn /operator/private/path/claude ENOENT` discloses a configured path.
  const written = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  try {
    process.stderr.write = (chunk) => { written.push(String(chunk)); return true; };
    await assert.rejects(
      () => runAgainstRejectingClaude(
        openAiRefusalRequest({ model: 'claude-not-a-model', effort: 'low' }),
        'claude-opus-4-8',
        { honorRequestModel: true, command: '/nonexistent/operator/path/claude-binary' },
      ),
      (err) => {
        assert.ok(!err.message.includes('/nonexistent/operator/path'), `path leaked: ${err.message}`);
        assert.ok(!err.message.includes('ENOENT'), `OS detail leaked: ${err.message}`);
        assert.match(err.message, /the local claude runtime failed to start/);
        return true;
      },
    );
    // `close` arrives after the turn has already rejected, so counting now would
    // observe one line whether or not a duplicate is coming. Watch until a second
    // appears — failing fast if it does — or until the window has passed.
    const count = () => written.filter((l) => l.includes('claude process failure')).length;
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline && count() < 2) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(count(), 1, `expected exactly one diagnostic: ${JSON.stringify(written)}`);
    assert.ok(written.some((l) => l.includes('ENOENT')), 'the real cause must be in it');
  } finally {
    process.stderr.write = originalWrite;
  }
});

test('an oversized subtype cannot bypass the client-message bound', async () => {
  const previousShape = process.env.CLAUDE_TEST_RESULT_SHAPE;
  const originalWrite = process.stderr.write.bind(process.stderr);
  try {
    process.stderr.write = () => true;
    process.env.CLAUDE_TEST_RESULT_SHAPE = 'huge_subtype';
    await assert.rejects(
      () => runAgainstRejectingClaude(
        openAiRefusalRequest({ model: 'claude-opus-4-8', effort: 'low' }),
        'claude-opus-4-8',
        { honorRequestModel: true, command: resultShapes },
      ),
      (err) => {
        assert.ok(err.message.length <= 500, `bound must cover the whole message, got ${err.message.length}`);
        return true;
      },
    );
  } finally {
    process.stderr.write = originalWrite;
    if (previousShape === undefined) delete process.env.CLAUDE_TEST_RESULT_SHAPE;
    else process.env.CLAUDE_TEST_RESULT_SHAPE = previousShape;
  }
});

test('an authoritative subtype decides retries, not a mention in the text', async () => {
  // `error_max_turns` whose diagnostic mentions an earlier execution error. The
  // subtype says do not retry; the legacy text match would say retry.
  const previousShape = process.env.CLAUDE_TEST_RESULT_SHAPE;
  const previousLog = process.env.CLAUDE_TEST_ARGV_LOG;
  const argvDir = await mkdtemp(join(tmpdir(), 'claude-argv-'));
  const argvLog = join(argvDir, 'argv.log');
  const originalWrite = process.stderr.write.bind(process.stderr);
  try {
    process.stderr.write = () => true;
    process.env.CLAUDE_TEST_RESULT_SHAPE = 'max_turns_mentioning_ede';
    process.env.CLAUDE_TEST_ARGV_LOG = argvLog;
    await assert.rejects(
      () => runAgainstRejectingClaude(
        { ...anthropicTuningRequest({ model: 'claude-opus-4-8' }), jsonMode: true, jsonSchema: PROBE_SCHEMA },
        'claude-opus-4-8',
        { honorRequestModel: true, command: resultShapes },
      ),
      (err) => {
        assert.match(err.message, /error_max_turns/);
        return true;
      },
    );
    const spawns = (await readFile(argvLog, 'utf8')).trim().split('\n').filter(Boolean)
      .map((l) => JSON.parse(l)).filter((l) => l[0] !== '#turn');
    assert.equal(spawns.length, 1, `an authoritative subtype must not be retried, saw ${spawns.length} spawns`);
  } finally {
    process.stderr.write = originalWrite;
    if (previousShape === undefined) delete process.env.CLAUDE_TEST_RESULT_SHAPE;
    else process.env.CLAUDE_TEST_RESULT_SHAPE = previousShape;
    if (previousLog === undefined) delete process.env.CLAUDE_TEST_ARGV_LOG;
    else process.env.CLAUDE_TEST_ARGV_LOG = previousLog;
    await rm(argvDir, { recursive: true, force: true });
  }
});

test('a runtime that cannot even be spawned synchronously stays operator-side', async () => {
  // `spawn` throws before returning a child for an empty or NUL-bearing command,
  // and Node puts the offending value in the message. That throw never reaches
  // the child `error` handler.
  const written = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  try {
    process.stderr.write = (chunk) => { written.push(String(chunk)); return true; };
    await assert.rejects(
      () => runAgainstRejectingClaude(
        openAiRefusalRequest({ model: 'claude-not-a-model', effort: 'low' }),
        'claude-opus-4-8',
        { honorRequestModel: true, command: `/operator/private/path/claude${String.fromCharCode(0)}x` },
      ),
      (err) => {
        assert.ok(!err.message.includes('/operator/private/path'), `path leaked: ${err.message}`);
        assert.match(err.message, /the local claude runtime failed to start/);
        return true;
      },
    );
    assert.ok(
      written.some((l) => l.includes('claude process failure')),
      `the operator must still see it: ${JSON.stringify(written)}`,
    );
  } finally {
    process.stderr.write = originalWrite;
  }
});

test('an intentional shutdown is not reported as a process failure', async () => {
  const written = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  const previousShape = process.env.CLAUDE_TEST_RESULT_SHAPE;
  let backend = null;
  try {
    process.env.CLAUDE_TEST_RESULT_SHAPE = 'assistant_only';
    process.stderr.write = (chunk) => { written.push(String(chunk)); return true; };
    backend = new ClaudeCodeBackend({
      command: fakeClaude, cwd: process.cwd(), model: 'claude-opus-4-8', timeoutMs: 30_000,
    });
    // Capture across the WHOLE lifecycle, not from just before close: a report
    // emitted earlier would otherwise be invisible. `close()` awaits the child's
    // exit, so no sleep is needed and none can hide a late write.
    await backend.generate(textRequest());
    await backend.close();
    backend = null;
    assert.deepEqual(
      written.filter((l) => l.includes('claude process failure')),
      [],
      'closing the backend is not a failure',
    );
  } finally {
    process.stderr.write = originalWrite;
    await backend?.close();
    if (previousShape === undefined) delete process.env.CLAUDE_TEST_RESULT_SHAPE;
    else process.env.CLAUDE_TEST_RESULT_SHAPE = previousShape;
  }
});

test('the bound applies to the composed message, not to each half', async () => {
  // Bounding subtype and detail separately would let their concatenation exceed
  // the limit even though neither component did.
  const previousShape = process.env.CLAUDE_TEST_RESULT_SHAPE;
  const originalWrite = process.stderr.write.bind(process.stderr);
  try {
    process.stderr.write = () => true;
    process.env.CLAUDE_TEST_RESULT_SHAPE = 'huge_both';
    await assert.rejects(
      () => runAgainstRejectingClaude(
        openAiRefusalRequest({ model: 'claude-opus-4-8', effort: 'low' }),
        'claude-opus-4-8',
        { honorRequestModel: true, command: resultShapes },
      ),
      (err) => {
        assert.ok(err.message.length <= 500, `composed message must be bounded, got ${err.message.length}`);
        return true;
      },
    );
  } finally {
    process.stderr.write = originalWrite;
    if (previousShape === undefined) delete process.env.CLAUDE_TEST_RESULT_SHAPE;
    else process.env.CLAUDE_TEST_RESULT_SHAPE = previousShape;
  }
});

test('a persistent runtime that cannot be spawned synchronously stays operator-side too', async () => {
  // The one-shot NUL test cannot reach `spawnChild`: asking for the configured
  // model is what keeps a request on the persistent route.
  const written = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  let backend = null;
  try {
    process.stderr.write = (chunk) => { written.push(String(chunk)); return true; };
    backend = new ClaudeCodeBackend({
      command: `/operator/private/path/claude${String.fromCharCode(0)}x`,
      cwd: process.cwd(), model: 'claude-retired', timeoutMs: 30_000, honorRequestModel: true,
    });
    await assert.rejects(
      () => backend.generate({ ...anthropicTuningRequest({ model: 'claude-retired' }), shape: 'openai-chat' }),
      (err) => {
        assert.ok(!err.message.includes('/operator/private/path'), `path leaked: ${err.message}`);
        assert.match(err.message, /the local claude runtime failed to start/);
        return true;
      },
    );
    assert.ok(
      written.some((l) => l.includes('claude process failure')),
      `the operator must still see it: ${JSON.stringify(written)}`,
    );
  } finally {
    process.stderr.write = originalWrite;
    await backend?.close();
  }
});

test('a persistent child that has not answered yet can still be refused', async () => {
  // The complement of the stale-sentence test: before any model output, a
  // refusal on stderr is exactly what it looks like, and must still map to 404.
  const previousShape = process.env.CLAUDE_TEST_RESULT_SHAPE;
  const originalWrite = process.stderr.write.bind(process.stderr);
  let backend = null;
  try {
    process.stderr.write = () => true;
    process.env.CLAUDE_TEST_RESULT_SHAPE = 'plaintext_refusal';
    backend = new ClaudeCodeBackend({
      command: resultShapes, cwd: process.cwd(), model: 'claude-retired',
      timeoutMs: 30_000, honorRequestModel: true,
    });
    await assert.rejects(
      () => backend.generate({ ...anthropicTuningRequest({ model: 'claude-retired' }), shape: 'openai-chat' }),
      (err) => {
        assert.equal(err.statusCode, 404, `expected 404, got: ${err.message}`);
        assert.equal(err.code, 'model_not_found');
        return true;
      },
    );
  } finally {
    process.stderr.write = originalWrite;
    await backend?.close();
    if (previousShape === undefined) delete process.env.CLAUDE_TEST_RESULT_SHAPE;
    else process.env.CLAUDE_TEST_RESULT_SHAPE = previousShape;
  }
});

test('a backend used again after close still reports its new child\'s failures', async () => {
  // `close()` clears the cached start, so a later request spawns a NEW child. If
  // the shutdown flag belonged to the backend rather than to the child being
  // terminated, that child's failures would be silently unreported forever.
  const written = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  const previousShape = process.env.CLAUDE_TEST_RESULT_SHAPE;
  let backend = null;
  try {
    process.stderr.write = (chunk) => { written.push(String(chunk)); return true; };
    process.env.CLAUDE_TEST_RESULT_SHAPE = 'persistent_stderr';
    backend = new ClaudeCodeBackend({
      command: resultShapes, cwd: process.cwd(), model: 'claude-retired',
      timeoutMs: 30_000, honorRequestModel: true,
    });
    const request = { ...anthropicTuningRequest({ model: 'claude-retired' }), shape: 'openai-chat' };
    await assert.rejects(() => backend.generate(request));
    const afterFirst = written.filter((l) => l.includes('claude process failure')).length;
    assert.equal(afterFirst, 1, `expected one diagnostic for the first child, saw ${afterFirst}`);

    await backend.close();
    await assert.rejects(() => backend.generate(request));
    const afterSecond = written.filter((l) => l.includes('claude process failure')).length;
    assert.equal(afterSecond, 2, `the respawned child's failure must be reported too, saw ${afterSecond}`);
  } finally {
    process.stderr.write = originalWrite;
    await backend?.close();
    if (previousShape === undefined) delete process.env.CLAUDE_TEST_RESULT_SHAPE;
    else process.env.CLAUDE_TEST_RESULT_SHAPE = previousShape;
  }
});

test('honorRequestModel off: a refusal message is bounded even though nothing maps it', async () => {
  // With honouring on, the mapping site replaces this message with a fixed
  // sentence, so its size never mattered. With honouring off nothing replaces it
  // and it reaches the client as-is — which is where the bound has to already be.
  const previousShape = process.env.CLAUDE_TEST_RESULT_SHAPE;
  const originalWrite = process.stderr.write.bind(process.stderr);
  try {
    process.stderr.write = () => true;
    process.env.CLAUDE_TEST_RESULT_SHAPE = 'huge_refusal';
    await assert.rejects(
      () => runAgainstRejectingClaude(
        openAiRefusalRequest({ model: 'claude-opus-4-8', effort: 'low' }),
        'claude-opus-4-8',
        { command: resultShapes },
      ),
      (err) => {
        assert.equal(err.statusCode, undefined, 'honour-off keeps this a server-side failure');
        assert.ok(err.message.length <= 500, `refusal message must be bounded, got ${err.message.length}`);
        return true;
      },
    );
  } finally {
    process.stderr.write = originalWrite;
    if (previousShape === undefined) delete process.env.CLAUDE_TEST_RESULT_SHAPE;
    else process.env.CLAUDE_TEST_RESULT_SHAPE = previousShape;
  }
});

test('pre-answer stderr that merely mentions the words is not a refusal', async () => {
  // The matcher used to accept the phrase anywhere in a lifetime buffer, so a
  // hook echoing those words turned an unrelated exit into a client-facing 404.
  const previousShape = process.env.CLAUDE_TEST_RESULT_SHAPE;
  const originalWrite = process.stderr.write.bind(process.stderr);
  let backend = null;
  try {
    process.stderr.write = () => true;
    process.env.CLAUDE_TEST_RESULT_SHAPE = 'unrelated_prefix';
    backend = new ClaudeCodeBackend({
      command: resultShapes, cwd: process.cwd(), model: 'claude-retired',
      timeoutMs: 30_000, honorRequestModel: true,
    });
    await assert.rejects(
      () => backend.generate({ ...anthropicTuningRequest({ model: 'claude-retired' }), shape: 'openai-chat' }),
      (err) => {
        assert.notEqual(err.statusCode, 404, `not a refusal: ${err.message}`);
        return true;
      },
    );
  } finally {
    process.stderr.write = originalWrite;
    await backend?.close();
    if (previousShape === undefined) delete process.env.CLAUDE_TEST_RESULT_SHAPE;
    else process.env.CLAUDE_TEST_RESULT_SHAPE = previousShape;
  }
});

test('a persistent child failing asynchronously is reported exactly once', async () => {
  // `error` and `close` both fire for a failed spawn. Counting with `some` would
  // not notice a second line.
  const written = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  let backend = null;
  try {
    process.stderr.write = (chunk) => { written.push(String(chunk)); return true; };
    backend = new ClaudeCodeBackend({
      command: '/nonexistent/operator/path/claude-binary',
      cwd: process.cwd(), model: 'claude-retired', timeoutMs: 30_000, honorRequestModel: true,
    });
    await assert.rejects(
      () => backend.generate({ ...anthropicTuningRequest({ model: 'claude-retired' }), shape: 'openai-chat' }),
      (err) => {
        assert.match(err.message, /the local claude runtime failed to start/);
        return true;
      },
    );
    // `close` arrives after `error` and after the turn has already rejected, so
    // counting immediately would miss a duplicate rather than prove its absence.
    // Watch until one shows up — failing fast if it does — or until the window a
    // spawn failure needs has comfortably passed.
    const countLines = () => written.filter((l) => l.includes('claude process failure')).length;
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline && countLines() < 2) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const lines = written.filter((l) => l.includes('claude process failure'));
    assert.equal(lines.length, 1, `expected exactly one diagnostic: ${JSON.stringify(lines)}`);
  } finally {
    process.stderr.write = originalWrite;
    await backend?.close();
  }
});

async function persistentFailure(shape, model = 'claude-retired') {
  const previousShape = process.env.CLAUDE_TEST_RESULT_SHAPE;
  const originalWrite = process.stderr.write.bind(process.stderr);
  let backend = null;
  try {
    process.stderr.write = () => true;
    process.env.CLAUDE_TEST_RESULT_SHAPE = shape;
    backend = new ClaudeCodeBackend({
      command: resultShapes, cwd: process.cwd(), model,
      timeoutMs: 30_000, honorRequestModel: true,
    });
    let caught;
    await assert.rejects(
      () => backend.generate({ ...anthropicTuningRequest({ model }), shape: 'openai-chat' }),
      (err) => { caught = err; return true; },
    );
    return caught;
  } finally {
    process.stderr.write = originalWrite;
    await backend?.close();
    if (previousShape === undefined) delete process.env.CLAUDE_TEST_RESULT_SHAPE;
    else process.env.CLAUDE_TEST_RESULT_SHAPE = previousShape;
  }
}

test('a hook echoing the refusal phrase mid-line is not a refusal', async () => {
  // Parentheses alone were the whole test before; a hook can have those too. The
  // diagnostic has to be the line, not a fragment inside one.
  const err = await persistentFailure('hook_echo_parenthesised');
  assert.notEqual(err.statusCode, 404, `not a refusal: ${err.message}`);
  assert.match(err.message, /the local claude runtime exited \(code=6/);
});

test('output already seen means a later refusal-looking line is not a refusal', async () => {
  // The child produced assistant output, so its model demonstrably runs. What
  // follows on stderr is about something else.
  const err = await persistentFailure('output_then_refusal_text');
  assert.notEqual(err.statusCode, 404, `output proved the model: ${err.message}`);
  assert.match(err.message, /the local claude runtime exited \(code=8/);
});

test('an API-error assistant is not model output, so the refusal still lands', async () => {
  // Its `error` is not a string, which used to drop it into the model-output
  // branch and suppress the refusal the runtime was in the middle of reporting.
  const err = await persistentFailure('api_error_without_string_error');
  assert.equal(err.statusCode, 404, `expected the refusal to survive: ${err.message}`);
  assert.equal(err.code, 'model_not_found');
});

test('a streamed delta proves the model too', async () => {
  // Output does not have to be a finished assistant message. A child that dies
  // mid-stream has already shown its model runs.
  const err = await persistentFailure('delta_then_refusal');
  assert.notEqual(err.statusCode, 404, `a delta is output: ${err.message}`);
  assert.match(err.message, /the local claude runtime exited \(code=8/);
});

test('one-shot: output already seen means a later refusal-looking line is not a refusal', async () => {
  // The one-shot route has its own waiter and its own failure path; the
  // persistent test cannot reach it. Requesting a model other than the configured
  // one is what sends this off the persistent route.
  const previousShape = process.env.CLAUDE_TEST_RESULT_SHAPE;
  const originalWrite = process.stderr.write.bind(process.stderr);
  try {
    process.stderr.write = () => true;
    process.env.CLAUDE_TEST_RESULT_SHAPE = 'output_then_refusal_text';
    await assert.rejects(
      () => runAgainstRejectingClaude(
        openAiRefusalRequest({ model: 'claude-sonnet-5', effort: 'low' }),
        'claude-opus-4-8',
        { honorRequestModel: true, command: resultShapes },
      ),
      (err) => {
        assert.notEqual(err.statusCode, 404, `output proved the model: ${err.message}`);
        assert.match(err.message, /the local claude runtime exited \(code=8/);
        return true;
      },
    );
  } finally {
    process.stderr.write = originalWrite;
    if (previousShape === undefined) delete process.env.CLAUDE_TEST_RESULT_SHAPE;
    else process.env.CLAUDE_TEST_RESULT_SHAPE = previousShape;
  }
});

test('a timed-out turn does not forget what it already saw', async () => {
  // A timeout ends a turn just as a result does. If the proof it observed is
  // dropped when the waiter is detached, the child looks unanswered again and a
  // later refusal-looking line re-opens a question the delta already answered.
  const previousShape = process.env.CLAUDE_TEST_RESULT_SHAPE;
  const originalWrite = process.stderr.write.bind(process.stderr);
  let backend = null;
  try {
    process.stderr.write = () => true;
    process.env.CLAUDE_TEST_RESULT_SHAPE = 'delta_then_hang';
    backend = new ClaudeCodeBackend({
      command: resultShapes, cwd: process.cwd(), model: 'claude-retired',
      timeoutMs: 300, honorRequestModel: true,
    });
    const request = { ...anthropicTuningRequest({ model: 'claude-retired' }), shape: 'openai-chat' };
    await assert.rejects(() => backend.generate(request), /timed out/);
    await assert.rejects(
      () => backend.generate(request),
      (err) => {
        assert.notEqual(err.statusCode, 404, `the delta already proved the model: ${err.message}`);
        return true;
      },
    );
  } finally {
    process.stderr.write = originalWrite;
    await backend?.close();
    if (previousShape === undefined) delete process.env.CLAUDE_TEST_RESULT_SHAPE;
    else process.env.CLAUDE_TEST_RESULT_SHAPE = previousShape;
  }
});

test('a retired child cannot disturb its replacement', async () => {
  // `close()` returns on its own deadline when a child will not die. Everything
  // that child emits afterwards belongs to a backend that has moved on — and a
  // replacement may already be serving. Its late events must reach nothing.
  const previousShape = process.env.CLAUDE_TEST_RESULT_SHAPE;
  const previousLog = process.env.CLAUDE_TEST_ARGV_LOG;
  const argvDir = await mkdtemp(join(tmpdir(), 'claude-argv-'));
  const argvLog = join(argvDir, 'argv.log');
  const originalWrite = process.stderr.write.bind(process.stderr);
  let backend = null;
  try {
    process.stderr.write = () => true;
    process.env.CLAUDE_TEST_ARGV_LOG = argvLog;
    process.env.CLAUDE_TEST_RESULT_SHAPE = 'ignores_sigterm';
    backend = new ClaudeCodeBackend({
      command: resultShapes, cwd: process.cwd(), model: 'claude-retired',
      timeoutMs: 30_000, honorRequestModel: true,
    });
    const request = { ...anthropicTuningRequest({ model: 'claude-retired' }), shape: 'openai-chat' };
    assert.equal((await backend.generate(request)).text, 'OK');

    await backend.close();          // returns on the deadline; child 1 is alive
    assert.equal((await backend.generate(request)).text, 'OK');  // child 2 serves

    // Child 1 is killed as the deadline elapsed, so its close lands here. If its
    // handlers still spoke for the backend, this next turn would find its state
    // torn down.
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal((await backend.generate(request)).text, 'OK');

    // One child per request, and every request answered. An unscoped handler from
    // a retired child would have torn down a live one, which shows up as a turn
    // that fails rather than answers.
    const spawns = (await readFile(argvLog, 'utf8')).trim().split('\n').filter(Boolean)
      .map((l) => JSON.parse(l)).filter((l) => l[0] !== '#turn');
    assert.equal(spawns.length, 3, `one child per request, saw ${spawns.length}`);
  } finally {
    process.stderr.write = originalWrite;
    await backend?.close();
    if (previousShape === undefined) delete process.env.CLAUDE_TEST_RESULT_SHAPE;
    else process.env.CLAUDE_TEST_RESULT_SHAPE = previousShape;
    if (previousLog === undefined) delete process.env.CLAUDE_TEST_ARGV_LOG;
    else process.env.CLAUDE_TEST_ARGV_LOG = previousLog;
    await rm(argvDir, { recursive: true, force: true });
  }
});

test('one request\'s conversation does not reach the next', async () => {
  // The persistent child holds a conversation, and the reset between requests
  // used to be `/clear` — which the same spawn disables with
  // `--disable-slash-commands`, so it never happened. Measured against the real
  // CLI: a second request could read back a value that appeared only in the
  // first request's body. The fixture answers with everything it has been sent,
  // so a leak shows up as the first request's text in the second's answer.
  const previousShape = process.env.CLAUDE_TEST_RESULT_SHAPE;
  const originalWrite = process.stderr.write.bind(process.stderr);
  let backend = null;
  try {
    process.stderr.write = () => true;
    process.env.CLAUDE_TEST_RESULT_SHAPE = 'echo_history';
    backend = new ClaudeCodeBackend({
      command: resultShapes, cwd: process.cwd(), model: 'claude-retired', timeoutMs: 30_000,
    });
    const ask = (content) => backend.generate({
      ...anthropicTuningRequest({ model: 'claude-retired' }),
      shape: 'openai-chat',
      messages: [{ role: 'user', content, images: [] }],
    });
    const first = await ask('CANARY-FIRST-REQUEST');
    assert.match(first.text, /CANARY-FIRST-REQUEST/, 'the fixture echoes what it was sent');
    const second = await ask('SECOND-REQUEST');
    assert.ok(
      !second.text.includes('CANARY-FIRST-REQUEST'),
      `a later request must not see an earlier one: ${second.text}`,
    );
    assert.match(second.text, /SECOND-REQUEST/);
  } finally {
    process.stderr.write = originalWrite;
    await backend?.close();
    if (previousShape === undefined) delete process.env.CLAUDE_TEST_RESULT_SHAPE;
    else process.env.CLAUDE_TEST_RESULT_SHAPE = previousShape;
  }
});

test('a failed request does not leave its conversation for the next one', async () => {
  // Retirement runs in a `finally`. A turn that fails has still put its content
  // into the child's conversation, so leaving that child alive would hand it to
  // whoever asks next — the same leak as before, on the failure path.
  const previousShape = process.env.CLAUDE_TEST_RESULT_SHAPE;
  const previousLog = process.env.CLAUDE_TEST_ARGV_LOG;
  const argvDir = await mkdtemp(join(tmpdir(), 'claude-argv-'));
  const argvLog = join(argvDir, 'argv.log');
  const originalWrite = process.stderr.write.bind(process.stderr);
  let backend = null;
  try {
    process.stderr.write = () => true;
    process.env.CLAUDE_TEST_ARGV_LOG = argvLog;
    process.env.CLAUDE_TEST_RESULT_SHAPE = 'bare_404';
    backend = new ClaudeCodeBackend({
      command: resultShapes, cwd: process.cwd(), model: 'claude-retired',
      timeoutMs: 30_000, honorRequestModel: true,
    });
    const request = { ...anthropicTuningRequest({ model: 'claude-retired' }), shape: 'openai-chat' };
    await assert.rejects(() => backend.generate(request));
    await assert.rejects(() => backend.generate(request));
    // Two requests, two children. One would mean the failed request's child was
    // reused, conversation and all.
    const spawns = (await readFile(argvLog, 'utf8')).trim().split('\n').filter(Boolean)
      .map((l) => JSON.parse(l)).filter((l) => l[0] !== '#turn');
    assert.equal(spawns.length, 2, `each request needs its own child, saw ${spawns.length}`);
  } finally {
    process.stderr.write = originalWrite;
    await backend?.close();
    if (previousShape === undefined) delete process.env.CLAUDE_TEST_RESULT_SHAPE;
    else process.env.CLAUDE_TEST_RESULT_SHAPE = previousShape;
    if (previousLog === undefined) delete process.env.CLAUDE_TEST_ARGV_LOG;
    else process.env.CLAUDE_TEST_ARGV_LOG = previousLog;
    await rm(argvDir, { recursive: true, force: true });
  }
});

test('two requests in flight at once stay separate conversations', async () => {
  // The persistent turn is serialized end to end — `withLock` wraps
  // `ensureStarted` as well as the send — so overlapping requests queue rather
  // than share a child. Measured rather than assumed: this is what a reviewer
  // reading `runPersistentTurn` alone cannot see.
  const previousShape = process.env.CLAUDE_TEST_RESULT_SHAPE;
  const originalWrite = process.stderr.write.bind(process.stderr);
  let backend = null;
  try {
    process.stderr.write = () => true;
    process.env.CLAUDE_TEST_RESULT_SHAPE = 'echo_history';
    backend = new ClaudeCodeBackend({
      command: resultShapes, cwd: process.cwd(), model: 'claude-retired', timeoutMs: 30_000,
    });
    const ask = (content) => backend.generate({
      ...anthropicTuningRequest({ model: 'claude-retired' }),
      shape: 'openai-chat',
      messages: [{ role: 'user', content, images: [] }],
    });
    const [alpha, bravo] = await Promise.all([ask('CANARY-ALPHA'), ask('CANARY-BRAVO')]);
    assert.match(alpha.text, /CANARY-ALPHA/);
    assert.match(bravo.text, /CANARY-BRAVO/);
    assert.ok(!alpha.text.includes('CANARY-BRAVO'), `A saw B: ${alpha.text}`);
    assert.ok(!bravo.text.includes('CANARY-ALPHA'), `B saw A: ${bravo.text}`);
  } finally {
    process.stderr.write = originalWrite;
    await backend?.close();
    if (previousShape === undefined) delete process.env.CLAUDE_TEST_RESULT_SHAPE;
    else process.env.CLAUDE_TEST_RESULT_SHAPE = previousShape;
  }
});

test('the one-shot route is isolated too', async () => {
  // A request naming a model other than the configured one takes the one-shot
  // path, which has its own child per turn. The isolation tests above all run on
  // the persistent route, so this pins the other one.
  const previousShape = process.env.CLAUDE_TEST_RESULT_SHAPE;
  const originalWrite = process.stderr.write.bind(process.stderr);
  let backend = null;
  try {
    process.stderr.write = () => true;
    process.env.CLAUDE_TEST_RESULT_SHAPE = 'echo_history';
    backend = new ClaudeCodeBackend({
      command: resultShapes, cwd: process.cwd(), model: 'claude-opus-4-8',
      timeoutMs: 30_000, honorRequestModel: true,
    });
    const ask = (content) => backend.generate({
      ...anthropicTuningRequest({ model: 'claude-sonnet-5' }),
      shape: 'openai-chat',
      messages: [{ role: 'user', content, images: [] }],
    });
    const first = await ask('CANARY-ONESHOT');
    assert.match(first.text, /CANARY-ONESHOT/);
    const second = await ask('SECOND-ONESHOT');
    assert.ok(!second.text.includes('CANARY-ONESHOT'), `a later request saw an earlier one: ${second.text}`);
  } finally {
    process.stderr.write = originalWrite;
    await backend?.close();
    if (previousShape === undefined) delete process.env.CLAUDE_TEST_RESULT_SHAPE;
    else process.env.CLAUDE_TEST_RESULT_SHAPE = previousShape;
  }
});

test('honorRequestModel off: a CLI model refusal stays a server-side failure', async () => {
  // With honouring off the model came from local configuration, not the client,
  // so it must not be reported as a client-side not-found.
  await assert.rejects(
    () => runAgainstRejectingClaude(
      anthropicTuningRequest({ model: 'claude-not-a-model', effort: 'low' }),
      'claude-opus-4-8',
    ),
    (err) => {
      assert.equal(err.statusCode, undefined, 'expected a plain Error, not a ProxyRequestError');
      assert.match(err.message, /issue with the selected model/);
      return true;
    },
  );
});

test('forwards output_config effort to claude --effort (one-shot argv)', async () => {
  const argv = await spawnedArgv(anthropicTuningRequest({ effort: 'low' }));
  const i = argv.indexOf('--effort');
  assert.ok(i !== -1, `expected --effort in argv: ${argv.join(' ')}`);
  assert.equal(argv[i + 1], 'low');
});

test('gates effort out for every Haiku spelling on a one-shot turn', async () => {
  // Force one-shot via output_config.format so the spawned argv is inspectable, and
  // gate on the configured (CLI-run) model, not the client-supplied request.model.
  // Both the alias and the version-pinned name must gate; a narrowed
  // recogniser would forward --effort for the other spelling.
  for (const model of ['haiku', 'claude-haiku-4-5']) {
    const argv = await spawnedArgv(
      anthropicTuningRequest({ effort: 'high', jsonMode: true, jsonSchema: PROBE_SCHEMA }),
      model,
    );
    assert.ok(argv.includes('--json-schema'), `expected one-shot argv: ${argv.join(' ')}`);
    assert.ok(!argv.includes('--effort'), `did not expect --effort for ${model}: ${argv.join(' ')}`);
  }
});

test('forwards output_config.format schema to claude --json-schema', async () => {
  const schema = { type: 'object', additionalProperties: false, properties: {}, required: [] };
  const argv = await spawnedArgv(anthropicTuningRequest({ jsonMode: true, jsonSchema: schema }));
  const i = argv.indexOf('--json-schema');
  assert.ok(i !== -1, `expected --json-schema in argv: ${argv.join(' ')}`);
  assert.deepEqual(JSON.parse(argv[i + 1]), schema);
});

test('forwards task_budget to claude --task-budget', async () => {
  const argv = await spawnedArgv(anthropicTuningRequest({ taskBudgetTokens: 20000 }));
  const i = argv.indexOf('--task-budget');
  assert.ok(i !== -1, `expected --task-budget in argv: ${argv.join(' ')}`);
  assert.equal(argv[i + 1], '20000');
});

test('forwards thinking on capable models and gates adaptive on Haiku', async () => {
  const opus = await spawnedArgv(
    anthropicTuningRequest({ thinking: { type: 'adaptive', display: 'omitted' } }),
    'claude-opus-4-8',
  );
  const t = opus.indexOf('--thinking');
  assert.ok(t !== -1, `expected --thinking in argv: ${opus.join(' ')}`);
  assert.equal(opus[t + 1], 'adaptive');
  assert.equal(opus[opus.indexOf('--thinking-display') + 1], 'omitted');

  const haiku = await spawnedArgv(
    anthropicTuningRequest({ thinking: { type: 'adaptive' }, jsonMode: true, jsonSchema: PROBE_SCHEMA }),
    'claude-haiku-4-5',
  );
  assert.ok(haiku.includes('--json-schema'), `expected one-shot argv: ${haiku.join(' ')}`);
  assert.ok(!haiku.includes('--thinking'), `did not expect adaptive --thinking for Haiku: ${haiku.join(' ')}`);
});

test('forced tool + per-request effort: one-shot argv forwards both --json-schema and --effort', async () => {
  const argv = await spawnedArgv(
    { ...toolRequest(), shape: 'anthropic-messages', effort: 'low', streamOptions: { includeUsage: false, includeObfuscation: false } },
    'claude-opus-4-8',
  );
  assert.ok(argv.includes('--effort'), `expected --effort: ${argv.join(' ')}`);
  assert.ok(argv.includes('--json-schema'), `expected forced-tool --json-schema: ${argv.join(' ')}`);
});

test('forced tool + per-request effort: one-shot still returns the tool call', async () => {
  const backend = new ClaudeCodeBackend({
    command: fakeClaude,
    cwd: process.cwd(),
    model: 'claude-opus-4-8',
    timeoutMs: 30_000,
  });
  try {
    const result = await backend.generate({
      ...toolRequest(),
      shape: 'anthropic-messages',
      effort: 'low',
      streamOptions: { includeUsage: false, includeObfuscation: false },
    });
    assert.equal(result.toolCalls[0].name, 'get_weather');
    assert.equal(result.toolCalls[0].arguments, '{"city":"Seoul"}');
  } finally {
    await backend.close();
  }
});

test('honorRequestModel on: a model override does not put the prompt in argv', async () => {
  // The override forces the one-shot path. Without stream-JSON input the prompt
  // would become a command-line argument, readable by anything that can list
  // process arguments on this machine.
  const argv = await spawnedArgv(
    anthropicTuningRequest({ model: 'claude-sonnet-5' }),
    'claude-opus-4-8',
    { honorRequestModel: true },
  );
  assert.ok(
    !argv.some((arg) => arg.includes('Say OK')),
    `prompt must not appear in argv: ${argv.join(' ')}`,
  );
  assert.ok(argv.includes('--input-format'), `expected stdin input: ${argv.join(' ')}`);
  assert.equal(argv[argv.indexOf('--input-format') + 1], 'stream-json');
});

test('honorRequestModel off: the one-shot argv is unchanged', async () => {
  // Control: the pre-existing behaviour for a request that reaches one-shot for
  // other reasons is preserved exactly.
  const argv = await spawnedArgv(
    anthropicTuningRequest({ model: 'claude-sonnet-5', effort: 'low' }),
    'claude-opus-4-8',
  );
  assert.ok(argv.some((arg) => arg.includes('Say OK')), `argv: ${argv.join(' ')}`);
});
