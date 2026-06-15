import assert from 'node:assert/strict';
import { chmod } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { before, test } from 'node:test';
import { ClaudeCodeBackend } from '../dist/proxy/claude-code-backend.js';

const here = dirname(fileURLToPath(import.meta.url));
const fakeClaude = resolve(here, 'fixtures/fake-claude.cjs');
const echoArgvClaude = resolve(here, 'fixtures/echo-argv-claude.cjs');

before(async () => {
  await chmod(fakeClaude, 0o755);
  await chmod(echoArgvClaude, 0o755);
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

async function spawnedArgv(request, model) {
  const backend = new ClaudeCodeBackend({
    command: echoArgvClaude,
    cwd: process.cwd(),
    model,
    timeoutMs: 30_000,
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
