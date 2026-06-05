import assert from 'node:assert/strict';
import { chmod } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { before, test } from 'node:test';
import { ClaudeCodeBackend } from '../dist/proxy/claude-code-backend.js';

const here = dirname(fileURLToPath(import.meta.url));
const fakeClaude = resolve(here, 'fixtures/fake-claude.cjs');

before(async () => {
  await chmod(fakeClaude, 0o755);
});

test('ClaudeCodeBackend streams persistent text deltas', async () => {
  const backend = new ClaudeCodeBackend({
    command: fakeClaude,
    cwd: process.cwd(),
    timeoutMs: 10_000,
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
    timeoutMs: 10_000,
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
    timeoutMs: 10_000,
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
    timeoutMs: 10_000,
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
    timeoutMs: 10_000,
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
    timeoutMs: 10_000,
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
