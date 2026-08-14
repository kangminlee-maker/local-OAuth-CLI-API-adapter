import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, before, test } from 'node:test';
import { CodexAppServerBackend } from '../dist/proxy/codex-app-server-backend.js';
import { resetCodexModelCatalogCache } from '../dist/proxy/codex-model-catalog.js';

const here = dirname(fileURLToPath(import.meta.url));
const fakeCodex = resolve(here, 'fixtures/fake-codex.cjs');
const originalCodexHome = process.env.CODEX_HOME;
const originalProviderEnv = snapshotProviderEnv();
const tempDirs = [];

before(async () => {
  await chmod(fakeCodex, 0o755);
});

afterEach(async () => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  restoreProviderEnv(originalProviderEnv);
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test('CodexAppServerBackend resolves when delayed provider usage arrives after completion', async () => {
  process.env.CODEX_HOME = await createCodexHome();
  const backend = new CodexAppServerBackend({
    command: fakeCodex,
    cwd: process.cwd(),
    timeoutMs: 30_000,
  });

  try {
    await backend.generate(textRequest());

    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 90);
    let result;
    try {
      result = await backend.generate(textRequest(), controller.signal);
    } finally {
      clearTimeout(abortTimer);
    }

    assert.equal(result.text, 'MEDIUM_OK');
    assert.equal(result.usage.source, 'provider');
    assert.equal(result.usage.inputTokens, 5);
    assert.equal(result.usage.outputTokens, 2);
    assert.equal(result.usage.cachedInputTokens, 2);
  } finally {
    await backend.close();
  }
});

test('CodexAppServerBackend follows per-request reasoning effort over backend fallback', async () => {
  process.env.CODEX_HOME = await createCodexHome();
  const backend = new CodexAppServerBackend({
    command: fakeCodex,
    cwd: process.cwd(),
    timeoutMs: 30_000,
    reasoningEffort: 'low',
  });

  try {
    const result = await backend.generate({
      ...textRequest(),
      reasoningEffort: 'minimal',
    });

    assert.equal(result.text, 'MINIMAL_OK');
    assert.equal(result.usage.source, 'provider');
  } finally {
    await backend.close();
  }
});

test('CodexAppServerBackend buffers notifications that arrive before turn/start response', async () => {
  process.env.CODEX_HOME = await createCodexHome();
  const backend = new CodexAppServerBackend({
    command: fakeCodex,
    cwd: process.cwd(),
    timeoutMs: 30_000,
  });

  try {
    const result = await backend.generate(earlyDeltaRequest());

    assert.equal(result.text, 'EARLY_OK');
    assert.equal(result.usage.source, 'provider');
    assert.equal(result.usage.inputTokens, 7);
    assert.equal(result.usage.outputTokens, 2);
    assert.equal(result.usage.cachedInputTokens, 3);
    assert.equal(result.usage.reasoningOutputTokens, 1);
  } finally {
    await backend.close();
  }
});

test('CodexAppServerBackend streams buffered text deltas', async () => {
  process.env.CODEX_HOME = await createCodexHome();
  const backend = new CodexAppServerBackend({
    command: fakeCodex,
    cwd: process.cwd(),
    timeoutMs: 30_000,
  });

  try {
    const events = [];
    for await (const event of backend.stream(earlyDeltaRequest())) {
      events.push(event);
    }

    assert.equal(events[0].type, 'text_delta');
    assert.equal(events[0].delta, 'EARLY_OK');
    assert.equal(events.at(-1).type, 'completed');
    assert.equal(events.at(-1).result.text, 'EARLY_OK');
    assert.equal(events.at(-1).result.usage.source, 'provider');
  } finally {
    await backend.close();
  }
});

test('CodexAppServerBackend records app-server tool stream timing checkpoints', async () => {
  process.env.CODEX_HOME = await createCodexHome();
  const timings = [];
  const backend = new CodexAppServerBackend({
    command: fakeCodex,
    cwd: process.cwd(),
    timeoutMs: 30_000,
    onTiming: (timing) => timings.push(timing),
  });

  try {
    const events = [];
    for await (const event of backend.stream(toolStreamRequest())) {
      events.push(event);
    }

    const toolDeltas = events.filter((event) => event.type === 'tool_call_delta');
    assert.equal(toolDeltas.length, 3);
    assert.equal(toolDeltas[0].name, 'get_weather');
    assert.equal(toolDeltas[1].argumentsDelta, '{"city"');
    assert.equal(toolDeltas[2].argumentsDelta, ':"Seoul"}');
    assert.equal(events.at(-1).type, 'completed');
    assert.equal(events.at(-1).result.toolCalls[0].arguments, '{"city":"Seoul"}');
    assert.equal(timings.length, 1);
    assert.equal(Number.isFinite(timings[0].firstTextDeltaMs), true);
    assert.equal(Number.isFinite(timings[0].firstToolCallDeltaMs), true);
    assert.equal(Number.isFinite(timings[0].firstToolArgumentDeltaMs), true);
    assert.equal(timings[0].firstTextDeltaMs <= timings[0].firstToolArgumentDeltaMs, true);
  } finally {
    await backend.close();
  }
});

test('CodexAppServerBackend does not pass direct provider env to child CLI', async () => {
  process.env.CODEX_HOME = await createCodexHome();
  setProviderEnv();
  const backend = new CodexAppServerBackend({
    command: fakeCodex,
    cwd: process.cwd(),
    timeoutMs: 30_000,
  });

  try {
    const result = await backend.generate(textRequest());
    assert.equal(result.text, 'MEDIUM_OK');
  } finally {
    await backend.close();
  }
});

test('CodexAppServerBackend keeps API-isolated proxy mode as the default app-server surface', async () => {
  process.env.CODEX_HOME = await createCodexHome();
  const backend = new CodexAppServerBackend({
    command: fakeCodex,
    cwd: process.cwd(),
    timeoutMs: 30_000,
  });

  try {
    const payload = await debugAppServerPayload(backend);

    assert.match(payload.threadStart.baseInstructions, /API proxy completion only/);
    assert.match(payload.threadStart.developerInstructions, /Follow API request instruction messages/);
    assert.match(payload.threadStart.developerInstructions, /first_tool_argument/);
    assert.equal(payload.threadStart.config.model_verbosity, 'medium');
    assert.equal(payload.threadStart.personality, 'none');
    assert.equal(payload.turnStart.personality, 'none');
    assert.equal(payload.turnStart.summary, 'none');
  } finally {
    await backend.close();
  }
});

test('CodexAppServerBackend lifts API system and developer messages into thread instructions', async () => {
  process.env.CODEX_HOME = await createCodexHome();
  const backend = new CodexAppServerBackend({
    command: fakeCodex,
    cwd: process.cwd(),
    timeoutMs: 30_000,
  });

  try {
    const payload = await debugAppServerPayload(backend, {
      messages: [
        { role: 'system', content: 'Answer in Korean.', images: [] },
        { role: 'developer', content: 'Prioritize operational detail.', images: [] },
        { role: 'user', content: 'DEBUG_PAYLOAD\nWrite the report.', images: [] },
      ],
    });
    const inputText = JSON.stringify(payload.turnStart.input);

    assert.match(payload.threadStart.developerInstructions, /<system>\nAnswer in Korean\.\n<\/system>/);
    assert.match(payload.threadStart.developerInstructions, /<developer>\nPrioritize operational detail\.\n<\/developer>/);
    assert.doesNotMatch(inputText, /Answer in Korean/);
    assert.doesNotMatch(inputText, /Prioritize operational detail/);
    assert.match(inputText, /<user>\\nDEBUG_PAYLOAD\\nWrite the report\./);
  } finally {
    await backend.close();
  }
});

test('CodexAppServerBackend maps request verbosity into app-server config', async () => {
  process.env.CODEX_HOME = await createCodexHome();
  const backend = new CodexAppServerBackend({
    command: fakeCodex,
    cwd: process.cwd(),
    timeoutMs: 30_000,
  });

  try {
    const payload = await debugAppServerPayload(backend, { verbosity: 'high' });

    assert.equal(payload.threadStart.config.model_verbosity, 'high');
  } finally {
    await backend.close();
  }
});

test('CodexAppServerBackend can probe alternate proxy mode surfaces', async () => {
  process.env.CODEX_HOME = await createCodexHome();

  const cases = [
    {
      proxyMode: 'omit-personality',
      expected: {
        threadPersonality: false,
        turnPersonality: false,
        baseInstructions: true,
        developerInstructions: true,
      },
    },
    {
      proxyMode: 'base-only',
      expected: {
        threadPersonality: true,
        turnPersonality: true,
        baseInstructions: true,
        developerInstructions: false,
      },
    },
    {
      proxyMode: 'no-instructions',
      expected: {
        threadPersonality: true,
        turnPersonality: true,
        baseInstructions: false,
        developerInstructions: false,
      },
    },
  ];

  for (const item of cases) {
    const backend = new CodexAppServerBackend({
      command: fakeCodex,
      cwd: process.cwd(),
      timeoutMs: 30_000,
      proxyMode: item.proxyMode,
    });
    try {
      const payload = await debugAppServerPayload(backend);
      assert.equal(Object.hasOwn(payload.threadStart, 'personality'), item.expected.threadPersonality, `${item.proxyMode} thread personality`);
      assert.equal(Object.hasOwn(payload.turnStart, 'personality'), item.expected.turnPersonality, `${item.proxyMode} turn personality`);
      assert.equal(Object.hasOwn(payload.threadStart, 'baseInstructions'), item.expected.baseInstructions, `${item.proxyMode} base instructions`);
      assert.equal(Object.hasOwn(payload.threadStart, 'developerInstructions'), item.expected.developerInstructions, `${item.proxyMode} developer instructions`);
      assert.equal(payload.turnStart.summary, 'none', `${item.proxyMode} summary`);
    } finally {
      await backend.close();
    }
  }
});

test('honorRequestModel off with nothing configured: the request model applies unvalidated', async () => {
  // The other half of app-server's preserved default-off behaviour: with no
  // configured model the request model is used, and nothing is checked against
  // the catalogue — `zzz-unadvertised-model` is absent from the fake's list.
  process.env.CODEX_HOME = await createCodexHome();
  resetCodexModelCatalogCache();
  const backend = new CodexAppServerBackend({
    command: fakeCodex,
    cwd: process.cwd(),
    timeoutMs: 30_000,
  });
  try {
    const payload = await debugAppServerPayload(backend, { model: 'zzz-unadvertised-model' });
    assert.equal(payload.turnStart.model, 'zzz-unadvertised-model');
  } finally {
    await backend.close();
  }
});

test('honorRequestModel off: the request model never reaches turn/start', async () => {
  process.env.CODEX_HOME = await createCodexHome();
  const backend = new CodexAppServerBackend({
    command: fakeCodex,
    cwd: process.cwd(),
    timeoutMs: 30_000,
    model: 'gpt-5.5',
  });
  try {
    const payload = await debugAppServerPayload(backend, { model: 'gpt-5.6-sol' });
    assert.equal(payload.turnStart.model, 'gpt-5.5');
  } finally {
    await backend.close();
  }
});

test('honorRequestModel on: a supported request model wins over the configured one', async () => {
  process.env.CODEX_HOME = await createCodexHome();
  resetCodexModelCatalogCache();
  const backend = new CodexAppServerBackend({
    command: fakeCodex,
    cwd: process.cwd(),
    timeoutMs: 30_000,
    model: 'gpt-5.5',
    honorRequestModel: true,
  });
  const callLog = join(await mkdtemp(join(tmpdir(), 'codex-models-call-')), 'calls.log');
  process.env.CODEX_MODELS_CALL_LOG = callLog;
  try {
    // `fixture-only-model` is advertised solely by the fake CLI, so accepting it
    // can only happen if the catalogue was actually collected from it. Because
    // an uncollectable catalogue deliberately fails open, acceptance alone would
    // also pass with no lookup at all — so assert the lookup happened.
    const payload = await debugAppServerPayload(backend, { model: 'fixture-only-model' });
    assert.equal(payload.turnStart.model, 'fixture-only-model');
    assert.equal(existsSync(callLog), true, 'expected debug models to have been invoked');
    assert.equal((await readFile(callLog, 'utf8')).trim(), 'debug models');
  } finally {
    delete process.env.CODEX_MODELS_CALL_LOG;
    await backend.close();
  }
});

test('honorRequestModel on: a request carrying no model falls back to the configured one', async () => {
  process.env.CODEX_HOME = await createCodexHome();
  resetCodexModelCatalogCache();
  const backend = new CodexAppServerBackend({
    command: fakeCodex,
    cwd: process.cwd(),
    timeoutMs: 30_000,
    model: 'fixture-only-model',
    honorRequestModel: true,
  });
  try {
    // Normalization rejects a model-less body; the backend keeps a defensive
    // fallback for direct callers.
    const payload = await debugAppServerPayload(backend, { model: '' });
    assert.equal(payload.turnStart.model, 'fixture-only-model');
  } finally {
    await backend.close();
  }
});

test('honorRequestModel on: an omitted model still validates the configured fallback', async () => {
  process.env.CODEX_HOME = await createCodexHome();
  resetCodexModelCatalogCache();
  const backend = new CodexAppServerBackend({
    command: fakeCodex,
    cwd: process.cwd(),
    timeoutMs: 30_000,
    model: 'retired-model',
    honorRequestModel: true,
  });
  try {
    await assert.rejects(
      () => debugAppServerPayload(backend, { model: '' }),
      (err) => {
        assert.equal(err.statusCode, 404);
        assert.equal(err.code, 'model_not_found');
        return true;
      },
    );
  } finally {
    await backend.close();
  }
});

test('honorRequestModel on: a request naming the configured model is still validated', async () => {
  process.env.CODEX_HOME = await createCodexHome();
  resetCodexModelCatalogCache();
  const backend = new CodexAppServerBackend({
    command: fakeCodex,
    cwd: process.cwd(),
    timeoutMs: 30_000,
    // Configured to a model the served catalogue does not list, as happens when
    // a slug is retired. Naming it explicitly must not skip validation.
    model: 'retired-model',
    honorRequestModel: true,
  });
  try {
    await assert.rejects(
      () => debugAppServerPayload(backend, { model: 'retired-model' }),
      (err) => {
        assert.equal(err.statusCode, 404);
        assert.equal(err.code, 'model_not_found');
        return true;
      },
    );
  } finally {
    await backend.close();
  }
});

test('honorRequestModel on: a model the CLI does not advertise is rejected as not found', async () => {
  process.env.CODEX_HOME = await createCodexHome();
  resetCodexModelCatalogCache();
  const backend = new CodexAppServerBackend({
    command: fakeCodex,
    cwd: process.cwd(),
    timeoutMs: 30_000,
    model: 'gpt-5.5',
    honorRequestModel: true,
  });
  try {
    await assert.rejects(
      () => debugAppServerPayload(backend, { model: 'zzz-not-a-model' }),
      (err) => {
        assert.equal(err.statusCode, 404);
        assert.equal(err.code, 'model_not_found');
        assert.equal(err.param, 'model');
        return true;
      },
    );
  } finally {
    await backend.close();
  }
});

test('honorRequestModel on: the backend identifier is rejected, not read as omission', async () => {
  // `codex-app-server` used to be a sentinel meaning "no model chosen", so a
  // request naming it ran the configured model instead. It is now an ordinary
  // model name and the served catalogue does not list it, so it must 404. The
  // configured model is one the catalogue *does* list, so reintroducing the
  // sentinel would make this a silent 200 on `gpt-5.5` rather than a rejection
  // for some other reason.
  process.env.CODEX_HOME = await createCodexHome();
  resetCodexModelCatalogCache();
  const backend = new CodexAppServerBackend({
    command: fakeCodex,
    cwd: process.cwd(),
    timeoutMs: 30_000,
    model: 'gpt-5.5',
    honorRequestModel: true,
  });
  try {
    await assert.rejects(
      () => debugAppServerPayload(backend, { model: 'codex-app-server' }),
      (err) => {
        assert.equal(err.statusCode, 404, `expected 404, got: ${err.message}`);
        assert.equal(err.code, 'model_not_found');
        assert.equal(err.param, 'model');
        return true;
      },
    );
  } finally {
    await backend.close();
  }
});

test('honorRequestModel on: the reported model is the identifier too, not the configured one', async () => {
  // `resolvedModel` feeds the model echoed back to the client and is a separate
  // code path from `modelOverrideFor`, which decides what executes. A sentinel
  // restored in only one of them would leave the rejection test above green
  // while the two disagreed, so pin this one directly. It does not validate, so
  // it answers for the identifier even though executing it would 404.
  const backend = new CodexAppServerBackend({
    command: fakeCodex,
    cwd: process.cwd(),
    timeoutMs: 30_000,
    model: 'gpt-5.5',
    honorRequestModel: true,
  });
  try {
    const reported = await backend.resolvedModel({ ...textRequest(), model: 'codex-app-server' });
    assert.equal(reported, 'codex-app-server');
  } finally {
    await backend.close();
  }
});

test('honorRequestModel on: an anthropic-shaped request is rejected in the anthropic error shape', async () => {
  process.env.CODEX_HOME = await createCodexHome();
  resetCodexModelCatalogCache();
  const backend = new CodexAppServerBackend({
    command: fakeCodex,
    cwd: process.cwd(),
    timeoutMs: 30_000,
    model: 'gpt-5.5',
    honorRequestModel: true,
  });
  try {
    await assert.rejects(
      () => debugAppServerPayload(backend, { model: 'zzz-not-a-model', shape: 'anthropic-messages' }),
      (err) => {
        assert.equal(err.statusCode, 404);
        assert.equal(err.provider, 'anthropic');
        assert.equal(err.type, 'not_found_error');
        return true;
      },
    );
  } finally {
    await backend.close();
  }
});

test('CodexAppServerBackend can collect imageGeneration items for image-2 proxy requests', async () => {
  process.env.CODEX_HOME = await createCodexHome();
  setProviderEnv();
  const timings = [];
  const backend = new CodexAppServerBackend({
    command: fakeCodex,
    cwd: process.cwd(),
    timeoutMs: 30_000,
    model: 'gpt-5.5',
    imageGeneration: true,
    onTiming: (timing) => timings.push(timing),
  });

  try {
    const result = await backend.generate(imageRequest());

    assert.equal(result.images.length, 1);
    assert.match(Buffer.from(result.images[0].b64Json, 'base64').toString('utf8'), /fake-codex-image-result/);
    assert.equal(result.images[0].revisedPrompt, 'fake revised image prompt');
    assert.equal(result.quality, 'medium');
    assert.equal(result.size, '1024x1536');
    assert.equal(result.usage.source, 'provider');
    assert.equal(result.usage.inputTokens, 11);
    assert.equal(timings.length, 1);
    assert.equal(Number.isFinite(timings[0].turnWaitMs), true);
    assert.equal(Number.isFinite(timings[0].totalMs), true);
  } finally {
    await backend.close();
  }
});

test('CodexAppServerBackend runs non-streaming image-2 n requests concurrently', async () => {
  process.env.CODEX_HOME = await createCodexHome();
  setProviderEnv();
  const timings = [];
  const backend = new CodexAppServerBackend({
    command: fakeCodex,
    cwd: process.cwd(),
    timeoutMs: 30_000,
    model: 'gpt-5.5',
    imageGeneration: true,
    onTiming: (timing) => timings.push(timing),
  });

  try {
    const result = await backend.generate({
      ...imageRequest(),
      prompt: 'PARALLEL_IMAGE_DELAY A simple flat red square centered on a white background. No text.',
      n: 3,
    });

    assert.equal(result.images.length, 3);
    assert.ok(
      result.images.some((image) => image.revisedPrompt?.includes('max-active:3')),
      'expected all image turns to be active before the first delayed result completed',
    );
    assert.equal(result.usage.inputTokens, 33);
    assert.equal(result.usage.outputTokens, 18);
    assert.equal(timings.length, 1);
    assert.equal(Number.isFinite(timings[0].turnWaitMs), true);
  } finally {
    await backend.close();
  }
});

test('CodexAppServerBackend streams imageGeneration completed events', async () => {
  process.env.CODEX_HOME = await createCodexHome();
  const backend = new CodexAppServerBackend({
    command: fakeCodex,
    cwd: process.cwd(),
    timeoutMs: 30_000,
    model: 'gpt-5.5',
    imageGeneration: true,
  });

  try {
    const events = [];
    for await (const event of backend.stream(imageRequest())) {
      events.push(event);
    }

    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'completed');
    assert.equal(events[0].quality, 'medium');
    assert.match(Buffer.from(events[0].image.b64Json, 'base64').toString('utf8'), /fake-codex-image-result/);
  } finally {
    await backend.close();
  }
});

async function createCodexHome() {
  const dir = await mkdtemp(join(tmpdir(), 'codex-test-home-'));
  tempDirs.push(dir);
  await writeFile(join(dir, 'auth.json'), '{"token":"local"}\n');
  await writeFile(join(dir, 'config.toml'), 'model = "gpt-test-model"\n');
  return dir;
}

function imageRequest() {
  return {
    operation: 'generation',
    model: 'image-2',
    prompt: 'A simple flat red square centered on a white background. No text.',
    n: 1,
    images: [],
    size: '1024x1536',
    quality: 'medium',
    outputFormat: 'webp',
    outputCompression: 80,
    background: 'opaque',
    moderation: 'low',
    responseFormat: 'b64_json',
    stream: false,
    partialImages: 0,
    raw: {},
  };
}

function textRequest() {
  return {
    shape: 'openai-chat',
    model: 'codex-app-server',
    messages: [{ role: 'user', content: 'Say OK' }],
    stream: false,
    streamOptions: { includeUsage: false, includeObfuscation: false },
    jsonMode: false,
    tools: [],
    toolChoice: { type: 'auto' },
    raw: {},
  };
}

function earlyDeltaRequest() {
  return {
    ...textRequest(),
    messages: [{ role: 'user', content: 'EARLY_DELTA' }],
  };
}

function toolStreamRequest() {
  return {
    ...textRequest(),
    shape: 'openai-responses',
    messages: [{ role: 'user', content: 'TOOL_STREAM_DIAGNOSTIC' }],
    stream: true,
    tools: [{
      name: 'get_weather',
      description: 'Get weather.',
      inputSchema: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
      },
      raw: {},
    }],
    toolChoice: { type: 'required' },
  };
}

async function debugAppServerPayload(backend, overrides = {}) {
  const messages = overrides.messages
    ? overrides.messages
    : [{ role: 'user', content: 'DEBUG_PAYLOAD', images: [] }];
  const result = await backend.generate({
    ...textRequest(),
    ...overrides,
    messages,
  });
  return JSON.parse(result.text);
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
