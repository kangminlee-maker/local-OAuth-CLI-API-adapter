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
const rejectModel232 = resolve(here, 'fixtures/reject-model-claude-2-1-232.cjs');

before(async () => {
  await chmod(fakeClaude, 0o755);
  await chmod(echoArgvClaude, 0o755);
  await chmod(rejectModelClaude, 0o755);
  await chmod(rejectModel232, 0o755);
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

test('honorRequestModel on: a 404 result with no structured error is still a 404', async () => {
  // Claude Code 2.1.232 drops `error: "model_not_found"` and sends `null`, and
  // the refusal sentence is a UI string that can be reworded or localized. The
  // structured 404 has to carry the mapping on its own — this fixture's result
  // text matches neither pattern, so only the `api_error_status` branch can
  // produce the 404 below.
  await assert.rejects(
    () => runAgainstRejectingClaude(
      { ...anthropicTuningRequest({ model: 'claude-not-a-model', effort: 'low' }), shape: 'openai-chat' },
      'claude-opus-4-8',
      { honorRequestModel: true, command: rejectModel232 },
    ),
    (err) => {
      assert.equal(err.statusCode, 404, `expected 404, got: ${err.message}`);
      assert.equal(err.code, 'model_not_found');
      assert.equal(err.param, 'model');
      return true;
    },
  );
});

test('honorRequestModel on: the 2.1.232 refusal is a 404 on the persistent route too', async () => {
  // The one-shot test above cannot reach `handlePersistentLine`, because forcing
  // a different model is what sends a request one-shot. Configure and request the
  // same model so the persistent route runs, and use the fixture whose text
  // matches neither pattern — only the structured assistant-event signal, carried
  // across to the result event and tagged on the way out, can produce this 404.
  const argvLog = join(await mkdtemp(join(tmpdir(), 'claude-argv-')), 'argv.log');
  const previousLog = process.env.CLAUDE_TEST_ARGV_LOG;
  process.env.CLAUDE_TEST_ARGV_LOG = argvLog;
  try {
    await assert.rejects(
      () => runAgainstRejectingClaude(
        { ...anthropicTuningRequest({ model: 'claude-retired' }), shape: 'openai-chat' },
        'claude-retired',
        { honorRequestModel: true, command: rejectModel232 },
      ),
      (err) => {
        assert.equal(err.statusCode, 404, `expected 404, got: ${err.message}`);
        assert.equal(err.code, 'model_not_found');
        assert.equal(err.param, 'model');
        return true;
      },
    );
    // Confirms the route rather than assuming it: the one-shot path passes the
    // prompt as an argument, the persistent one never does.
    const argv = JSON.parse((await readFile(argvLog, 'utf8')).trim().split('\n')[0]);
    assert.ok(
      !argv.some((arg) => arg.includes('Say OK')),
      `expected the persistent route (no prompt argument): ${argv.join(' ')}`,
    );
  } finally {
    if (previousLog === undefined) delete process.env.CLAUDE_TEST_ARGV_LOG;
    else process.env.CLAUDE_TEST_ARGV_LOG = previousLog;
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

test('gates effort out for the configured Haiku model on a one-shot turn', async () => {
  // Force one-shot via output_config.format so the spawned argv is inspectable, and
  // gate on the configured (CLI-run) model, not the client-supplied request.model.
  const argv = await spawnedArgv(
    anthropicTuningRequest({ effort: 'high', jsonMode: true, jsonSchema: PROBE_SCHEMA }),
    'claude-haiku-4-5',
  );
  assert.ok(argv.includes('--json-schema'), `expected one-shot argv: ${argv.join(' ')}`);
  assert.ok(!argv.includes('--effort'), `did not expect --effort for Haiku: ${argv.join(' ')}`);
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
