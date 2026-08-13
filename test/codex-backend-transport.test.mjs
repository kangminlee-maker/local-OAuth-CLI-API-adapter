import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, before, test } from 'node:test';
import { CodexBackendTransport } from '../dist/proxy/codex-backend-transport.js';
import { resetCodexModelCatalogCache } from '../dist/proxy/codex-model-catalog.js';

const here = dirname(fileURLToPath(import.meta.url));
const fakeCodexModelsOk = resolve(here, 'fixtures/fake-codex-models-ok.cjs');
const fakeCodexModelsFail = resolve(here, 'fixtures/fake-codex-models-fail.cjs');

before(async () => {
  await chmod(fakeCodexModelsOk, 0o755);
  await chmod(fakeCodexModelsFail, 0o755);
});

const originalFetch = globalThis.fetch;
const tempDirs = [];

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

// This is the DEFAULT Codex transport (`codexProxy.transport: codex-backend`),
// so the model-selection contract has to hold here, not only on the diagnostic
// app-server path.
function okSse() {
  return sse([
    { type: 'response.created', response: { id: 'resp_m', model: 'x', status: 'in_progress' } },
    { type: 'response.output_text.delta', delta: 'OK' },
    { type: 'response.completed', response: { id: 'resp_m', model: 'x' } },
  ]);
}

async function transportBody(request, options) {
  const codexHome = await createCodexHome();
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(okSse(), { status: 200 });
  };
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000, ...options });
  await backend.generate(request);
  return JSON.parse(calls[0].init.body);
}

test('default transport, honorRequestModel off: the request model still wins (unchanged behaviour)', async () => {
  const body = await transportBody(
    { ...textRequest(), model: 'gpt-5.6-sol' },
    { model: 'gpt-5.5' },
  );
  assert.equal(body.model, 'gpt-5.6-sol');
});

test('default transport, honorRequestModel off: an empty model uses the configured one', async () => {
  // Normalization rejects an empty model before this point; the backend keeps a
  // defensive fallback for direct callers.
  const body = await transportBody(
    { ...textRequest(), model: '' },
    { model: 'gpt-5.5' },
  );
  assert.equal(body.model, 'gpt-5.5');
});

test('default transport: the backend identifier is now a model name, not an omission', async () => {
  // It is no longer special-cased, so it is forwarded like any other value —
  // and `GET /v1/models` no longer advertises it.
  const body = await transportBody(
    { ...textRequest(), model: 'codex-backend' },
    { model: 'gpt-5.5' },
  );
  assert.equal(body.model, 'codex-backend');
});

test('default transport, honorRequestModel off: no catalogue lookup happens at all', async () => {
  // Removing the honour guard around validation would still let the other
  // off-mode tests pass whenever the lookup fails open or happens to advertise
  // the tested slug. This pins the stronger property: off mode does not consult
  // the catalogue, and an unadvertised model goes straight through.
  resetCodexModelCatalogCache();
  const callLog = join(await mkdtemp(join(tmpdir(), 'codex-models-call-')), 'calls.log');
  process.env.CODEX_MODELS_CALL_LOG = callLog;
  try {
    const body = await transportBody(
      { ...textRequest(), model: 'zzz-never-advertised' },
      { model: 'gpt-5.5', codexCommand: fakeCodexModelsOk },
    );
    assert.equal(body.model, 'zzz-never-advertised');
    assert.equal(existsSync(callLog), false, 'off mode must not run debug models');
  } finally {
    delete process.env.CODEX_MODELS_CALL_LOG;
  }
});

test('default transport, honorRequestModel on: an advertised model is accepted', async () => {
  resetCodexModelCatalogCache();
  const callLog = join(await mkdtemp(join(tmpdir(), 'codex-models-call-')), 'calls.log');
  process.env.CODEX_MODELS_CALL_LOG = callLog;
  try {
    const body = await transportBody(
      { ...textRequest(), model: 'fixture-model-a' },
      { model: 'gpt-5.5', honorRequestModel: true, codexCommand: fakeCodexModelsOk },
    );
    // `fixture-model-a` is advertised only by the fake catalogue CLI. Acceptance
    // alone would also pass with no lookup at all, since an uncollectable
    // catalogue fails open — so assert the lookup actually ran.
    assert.equal(body.model, 'fixture-model-a');
    assert.equal(existsSync(callLog), true, 'expected debug models to have been invoked');
    assert.equal((await readFile(callLog, 'utf8')).trim(), 'debug models');
  } finally {
    delete process.env.CODEX_MODELS_CALL_LOG;
  }
});

test('default transport, honorRequestModel on: an omitted model validates the configured fallback', async () => {
  resetCodexModelCatalogCache();
  await assert.rejects(
    () => transportBody(
      // `codex-app-server` is the omitted-model sentinel the normalizers insert.
      { ...textRequest(), model: '' },
      { model: 'retired-model', honorRequestModel: true, codexCommand: fakeCodexModelsOk },
    ),
    (err) => {
      assert.equal(err.statusCode, 404);
      assert.equal(err.code, 'model_not_found');
      return true;
    },
  );
});

test('default transport, honorRequestModel on: an omitted model uses a supported configured fallback', async () => {
  resetCodexModelCatalogCache();
  const body = await transportBody(
    { ...textRequest(), model: '' },
    { model: 'fixture-model-a', honorRequestModel: true, codexCommand: fakeCodexModelsOk },
  );
  assert.equal(body.model, 'fixture-model-a');
});

test('default transport, honorRequestModel on: an unadvertised model is rejected as not found', async () => {
  resetCodexModelCatalogCache();
  await assert.rejects(
    () => transportBody(
      { ...textRequest(), model: 'zzz-not-a-model' },
      { model: 'gpt-5.5', honorRequestModel: true, codexCommand: fakeCodexModelsOk },
    ),
    (err) => {
      assert.equal(err.statusCode, 404);
      assert.equal(err.code, 'model_not_found');
      assert.equal(err.param, 'model');
      return true;
    },
  );
});

test('default transport, honorRequestModel on: an uncollectable catalogue passes the model through', async () => {
  resetCodexModelCatalogCache();
  const body = await transportBody(
    { ...textRequest(), model: 'unknown-to-a-broken-lookup' },
    { model: 'gpt-5.5', honorRequestModel: true, codexCommand: fakeCodexModelsFail },
  );
  assert.equal(body.model, 'unknown-to-a-broken-lookup');
});

test('CodexBackendTransport posts to ChatGPT Codex backend with OAuth auth and maps text usage', async () => {
  const codexHome = await createCodexHome();
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(sse([
      {
        type: 'response.created',
        response: { id: 'resp_1', model: 'gpt-5.5', status: 'in_progress' },
      },
      { type: 'response.output_text.delta', delta: 'OK' },
      {
        type: 'response.completed',
        response: {
          id: 'resp_1',
          model: 'gpt-5.5',
          usage: {
            input_tokens: 18,
            input_tokens_details: { cached_tokens: 3 },
            output_tokens: 4,
            output_tokens_details: { reasoning_tokens: 1 },
            total_tokens: 22,
          },
        },
      },
    ]), { status: 200 });
  };
  const backend = new CodexBackendTransport({
    codexHome,
    timeoutMs: 30_000,
    reasoningEffort: 'minimal',
    verbosity: 'low',
  });

  const result = await backend.generate(textRequest());

  assert.equal(result.id, 'resp_1');
  assert.equal(result.model, 'gpt-5.5');
  assert.equal(result.text, 'OK');
  assert.equal(result.usage.source, 'provider');
  assert.equal(result.usage.inputTokens, 18);
  assert.equal(result.usage.cachedInputTokens, 3);
  assert.equal(result.usage.reasoningOutputTokens, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://chatgpt.com/backend-api/codex/responses');
  assert.equal(calls[0].init.headers.authorization, 'Bearer codex-oauth-token');
  assert.equal(calls[0].init.headers['ChatGPT-Account-ID'], 'account-1');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.reasoning.effort, 'low');
  assert.equal(Object.hasOwn(body, 'max_output_tokens'), false);
  assert.equal(Object.hasOwn(body, 'temperature'), false);
  assert.equal(body.text.verbosity, 'low');
  assert.match(body.instructions, /API proxy completion only/);
  assert.deepEqual(body.input, [{
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: 'Return OK.' }],
  }]);
});

test('CodexBackendTransport maps Chat tool history to native Responses items', async () => {
  const codexHome = await createCodexHome();
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(sse([
      { type: 'response.output_text.delta', delta: 'WEATHER_RESULT_CITY=Seoul;TEMP_C=23;CONDITION=clear' },
      { type: 'response.completed', response: { id: 'resp_tool_result', model: 'gpt-5.5' } },
    ]), { status: 200 });
  };
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });

  const result = await backend.generate(chatToolResultRequest());
  const body = JSON.parse(calls[0].init.body);

  assert.equal(result.text, 'WEATHER_RESULT_CITY=Seoul;TEMP_C=23;CONDITION=clear');
  assert.deepEqual(body.input, [
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'Use get_weather, then reply with the result.' }],
    },
    {
      type: 'function_call',
      call_id: 'call_weather',
      name: 'get_weather',
      arguments: '{"city":"Seoul"}',
    },
    {
      type: 'function_call_output',
      call_id: 'call_weather',
      output: '{"city":"Seoul","temperature_c":23,"condition":"clear"}',
    },
  ]);
});

test('CodexBackendTransport uses assistant output_text content parts', async () => {
  const codexHome = await createCodexHome();
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(sse([
      { type: 'response.output_text.delta', delta: 'OK' },
      { type: 'response.completed', response: { id: 'resp_assistant_history', model: 'gpt-5.5' } },
    ]), { status: 200 });
  };
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });

  await backend.generate({
    ...textRequest(),
    messages: [
      { role: 'user', content: 'Remember this.', images: [] },
      { role: 'assistant', content: 'I remember this.', images: [] },
      { role: 'user', content: 'Reply OK.', images: [] },
    ],
  });
  const body = JSON.parse(calls[0].init.body);

  assert.deepEqual(body.input[1], {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'I remember this.' }],
  });
});

test('CodexBackendTransport streams native function-call argument deltas', async () => {
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse([
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: {
        type: 'function_call',
        name: 'get_weather',
        call_id: 'call_1',
      },
    },
    {
      type: 'response.function_call_arguments.delta',
      output_index: 0,
      delta: '{"city"',
    },
    {
      type: 'response.function_call_arguments.delta',
      output_index: 0,
      delta: ':"Seoul"}',
    },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'function_call',
        name: 'get_weather',
        call_id: 'call_1',
        arguments: '{"city":"Seoul"}',
      },
    },
    {
      type: 'response.completed',
      response: {
        id: 'resp_tool',
        model: 'gpt-5.5',
        usage: {
          input_tokens: 10,
          output_tokens: 6,
          total_tokens: 16,
        },
      },
    },
  ]), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });

  const events = [];
  for await (const event of backend.stream(toolRequest())) events.push(event);

  const toolEvents = events.filter((event) => event.type === 'tool_call_delta');
  assert.equal(toolEvents.length, 3);
  assert.equal(toolEvents[0].name, 'get_weather');
  assert.equal(toolEvents[1].argumentsDelta, '{"city"');
  assert.equal(toolEvents[2].argumentsDelta, ':"Seoul"}');
  assert.equal(events.at(-1).type, 'completed');
  assert.equal(events.at(-1).result.toolCalls[0].arguments, '{"city":"Seoul"}');
  assert.equal(events.at(-1).result.usage.source, 'provider');
});

test('CodexBackendTransport maps Images API requests to backend image_generation tool results', async () => {
  const codexHome = await createCodexHome();
  const calls = [];
  const image = tinyPngBase64();
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(sse([
      { type: 'response.created', response: { id: 'resp_image', model: 'gpt-5.5' } },
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'image_generation_call', id: 'ig_1', status: 'in_progress' },
      },
      { type: 'response.image_generation_call.generating', output_index: 0, item_id: 'ig_1' },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'image_generation_call',
          id: 'ig_1',
          status: 'completed',
          revised_prompt: 'A simple green leaf icon.',
          result: image,
        },
      },
      {
        type: 'response.completed',
        response: {
          id: 'resp_image',
          model: 'gpt-5.5',
          usage: {
            input_tokens: 31,
            output_tokens: 12,
            total_tokens: 43,
          },
        },
      },
    ]), { status: 200 });
  };
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000, model: 'gpt-5.5' });

  const result = await backend.generate({
    ...imageRequest(),
    outputFormat: 'jpeg',
    outputCompression: 80,
  });
  const body = JSON.parse(calls[0].init.body);

  assert.equal(calls[0].url, 'https://chatgpt.com/backend-api/codex/responses');
  assert.equal(body.model, 'gpt-5.5');
  assert.deepEqual(body.tools, [{
    type: 'image_generation',
    action: 'generate',
    size: '1024x1024',
    quality: 'medium',
    output_format: 'jpeg',
    output_compression: 80,
  }]);
  assert.deepEqual(body.tool_choice, { type: 'image_generation' });
  assert.equal(body.reasoning.effort, 'medium');
  assert.match(body.instructions, /Use the image_generation tool/);
  assert.match(body.input[0].content[0].text, /Original Images API prompt:/);
  assert.match(body.input[0].content[0].text, /green leaf icon/);
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].b64Json, image);
  assert.equal(result.images[0].revisedPrompt, 'A simple green leaf icon.');
  assert.equal(result.quality, 'medium');
  assert.equal(result.size, '1024x1024');
  assert.equal(result.outputFormat, 'jpeg');
  assert.equal(result.usage.inputTokens, 31);
  assert.equal(result.usage.source, 'provider');
});

test('CodexBackendTransport includes reference images for backend image edits', async () => {
  const codexHome = await createCodexHome();
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(sse([
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'image_generation_call',
          id: 'ig_edit',
          status: 'completed',
          result: tinyPngBase64(),
        },
      },
      { type: 'response.completed', response: { id: 'resp_image_edit', model: 'gpt-5.5' } },
    ]), { status: 200 });
  };
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000, model: 'gpt-5.5' });

  await backend.generate({
    ...imageRequest(),
    operation: 'edit',
    prompt: 'Make the leaf blue while keeping the composition.',
    images: [{
      source: {
        type: 'base64',
        mediaType: 'image/png',
        data: tinyPngBase64(),
      },
      raw: {},
    }],
  });
  const body = JSON.parse(calls[0].init.body);

  assert.equal(body.tools[0].action, 'edit');
  assert.equal(body.input[0].content[1].type, 'input_image');
  assert.match(body.input[0].content[1].image_url, /^data:image\/png;base64,/);
  assert.match(body.input[0].content[0].text, /This is an edit request/);
  assert.match(body.input[0].content[0].text, /Attached images 1-1/);
});

test('CodexBackendTransport retries backend image completions that contain no image result', async () => {
  const codexHome = await createCodexHome();
  const calls = [];
  const diagnostics = [];
  const image = tinyPngBase64();
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    if (calls.length === 1) {
      return new Response(sse([
        { type: 'response.output_text.delta', delta: 'I cannot generate an image here.' },
        { type: 'response.completed', response: { id: 'resp_no_image', model: 'gpt-5.5' } },
      ]), { status: 200 });
    }
    return new Response(sse([
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'image_generation_call',
          id: 'ig_retry',
          status: 'completed',
          result: image,
        },
      },
      { type: 'response.completed', response: { id: 'resp_image_retry', model: 'gpt-5.5' } },
    ]), { status: 200 });
  };
  const backend = new CodexBackendTransport({
    codexHome,
    timeoutMs: 30_000,
    model: 'gpt-5.5',
    onImageAttempt: (diagnostic) => diagnostics.push(diagnostic),
  });

  const result = await backend.generate(imageRequest());
  const firstBody = JSON.parse(calls[0].init.body);
  const secondBody = JSON.parse(calls[1].init.body);

  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].b64Json, image);
  assert.equal(calls.length, 2);
  assert.doesNotMatch(firstBody.input[0].content[0].text, /Retry attempt/);
  assert.match(secondBody.instructions, /previous backend attempt completed without an image_generation_call result/i);
  assert.match(secondBody.input[0].content[0].text, /Retry attempt 2/);
  assert.deepEqual(secondBody.tool_choice, { type: 'image_generation' });
  assert.equal(diagnostics.length, 2);
  assert.equal(diagnostics[0].ok, false);
  assert.equal(diagnostics[0].retrying, true);
  assert.equal(diagnostics[0].textDeltaCount, 1);
  assert.match(diagnostics[0].textSample, /cannot generate an image/);
  assert.equal(diagnostics[0].imageResultCount, 0);
  assert.equal(diagnostics[1].ok, true);
  assert.equal(diagnostics[1].imageResultCount, 1);
  assert.deepEqual(diagnostics[1].outputItemTypes, ['image_generation_call']);
});

test('CodexBackendTransport streams completed image_generation results', async () => {
  const codexHome = await createCodexHome();
  const image = tinyPngBase64();
  globalThis.fetch = async () => new Response(sse([
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'image_generation_call', id: 'ig_stream', status: 'in_progress' },
    },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'image_generation_call',
        id: 'ig_stream',
        status: 'completed',
        result: image,
      },
    },
    { type: 'response.completed', response: { id: 'resp_image_stream', model: 'gpt-5.5' } },
  ]), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000, model: 'gpt-5.5' });

  const events = [];
  for await (const event of backend.stream({ ...imageRequest(), stream: true })) events.push(event);

  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'completed');
  assert.equal(events[0].image.b64Json, image);
  assert.equal(events[0].partialImageIndex, 0);
});

test('CodexBackendTransport retries streamed backend image completions before emitting an error', async () => {
  const codexHome = await createCodexHome();
  const calls = [];
  const image = tinyPngBase64();
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    if (calls.length === 1) {
      return new Response(sse([
        { type: 'response.completed', response: { id: 'resp_stream_no_image', model: 'gpt-5.5' } },
      ]), { status: 200 });
    }
    return new Response(sse([
      {
        type: 'raw_response_item_completed',
        item: {
          type: 'imageGeneration',
          id: 'ig_thread_style',
          status: 'completed',
          revisedPrompt: 'A green leaf icon.',
          result: `data:image/png;base64,${image}`,
        },
      },
      { type: 'response.completed', response: { id: 'resp_stream_image', model: 'gpt-5.5' } },
    ]), { status: 200 });
  };
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000, model: 'gpt-5.5' });

  const events = [];
  for await (const event of backend.stream({ ...imageRequest(), stream: true })) events.push(event);

  assert.equal(calls.length, 2);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'completed');
  assert.equal(events[0].image.b64Json, image);
  assert.equal(events[0].image.revisedPrompt, 'A green leaf icon.');
});

test('CodexBackendTransport forwards provider-style backend errors', async () => {
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: {
      message: 'bad effort',
      type: 'invalid_request_error',
      param: 'reasoning.effort',
      code: 'unsupported_value',
    },
  }), { status: 400 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });

  await assert.rejects(
    () => backend.generate(textRequest()),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.equal(err.type, 'invalid_request_error');
      assert.equal(err.param, 'reasoning.effort');
      assert.equal(err.code, 'unsupported_value');
      return true;
    },
  );
});

test('CodexBackendTransport retries transient backend connection failures', async () => {
  const codexHome = await createCodexHome();
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    if (calls.length === 1) {
      return new Response(
        'upstream connect error or disconnect/reset before headers. reset reason: connection timeout',
        { status: 503 },
      );
    }
    return new Response(sse([
      { type: 'response.output_text.delta', delta: 'OK' },
      { type: 'response.completed', response: { id: 'resp_retry_transient', model: 'gpt-5.5' } },
    ]), { status: 200 });
  };
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });

  const result = await backend.generate(textRequest());

  assert.equal(result.text, 'OK');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://chatgpt.com/backend-api/codex/responses');
  assert.equal(calls[1].url, 'https://chatgpt.com/backend-api/codex/responses');
});

test('CodexBackendTransport retries transient backend fetch exceptions', async () => {
  const codexHome = await createCodexHome();
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    if (calls.length === 1) throw new TypeError('fetch failed');
    return new Response(sse([
      { type: 'response.output_text.delta', delta: 'FETCH_RETRY_OK' },
      { type: 'response.completed', response: { id: 'resp_retry_fetch', model: 'gpt-5.5' } },
    ]), { status: 200 });
  };
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });

  const result = await backend.generate(textRequest());

  assert.equal(result.text, 'FETCH_RETRY_OK');
  assert.equal(calls.length, 2);
});

test('CodexBackendTransport refreshes an expired Codex OAuth token before request', async () => {
  const codexHome = await createCodexHome({
    accessToken: jwt({ exp: Math.floor(Date.now() / 1000) - 60 }),
    refreshToken: 'old-refresh-token',
    idToken: idTokenForAccount('account-1'),
    lastRefresh: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
  });
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    if (url === 'https://auth.openai.com/oauth/token') {
      assert.deepEqual(JSON.parse(init.body), {
        client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
        grant_type: 'refresh_token',
        refresh_token: 'old-refresh-token',
      });
      return Response.json({
        id_token: idTokenForAccount('account-2'),
        access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
        refresh_token: 'new-refresh-token',
      });
    }
    assert.equal(init.headers.authorization.startsWith('Bearer '), true);
    assert.equal(init.headers.authorization.includes('old-refresh-token'), false);
    assert.equal(init.headers['ChatGPT-Account-ID'], 'account-2');
    return new Response(sse([
      { type: 'response.output_text.delta', delta: 'OK' },
      { type: 'response.completed', response: { id: 'resp_refresh', model: 'gpt-5.5' } },
    ]), { status: 200 });
  };
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });

  const result = await backend.generate(textRequest());
  const persisted = JSON.parse(await readFile(join(codexHome, 'auth.json'), 'utf8'));

  assert.equal(result.text, 'OK');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://auth.openai.com/oauth/token');
  assert.equal(calls[1].url, 'https://chatgpt.com/backend-api/codex/responses');
  assert.equal(persisted.tokens.refresh_token, 'new-refresh-token');
  assert.equal(persisted.tokens.account_id, 'account-2');
  assert.equal(typeof persisted.last_refresh, 'string');
});

test('CodexBackendTransport refreshes after backend unauthorized and retries once', async () => {
  const codexHome = await createCodexHome({
    accessToken: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
    refreshToken: 'retry-refresh-token',
  });
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    if (url === 'https://auth.openai.com/oauth/token') {
      return Response.json({
        access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 7200 }),
        refresh_token: 'retry-refresh-token-2',
      });
    }
    const backendCallCount = calls.filter((call) => call.url === 'https://chatgpt.com/backend-api/codex/responses').length;
    if (backendCallCount === 1) {
      return new Response(JSON.stringify({
        error: { message: 'token expired', code: 'token_expired' },
      }), { status: 401 });
    }
    assert.equal(init.headers.authorization.includes('retry-refresh-token'), false);
    return new Response(sse([
      { type: 'response.output_text.delta', delta: 'RETRY_OK' },
      { type: 'response.completed', response: { id: 'resp_retry', model: 'gpt-5.5' } },
    ]), { status: 200 });
  };
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });

  const result = await backend.generate(textRequest());

  assert.equal(result.text, 'RETRY_OK');
  assert.deepEqual(calls.map((call) => call.url), [
    'https://chatgpt.com/backend-api/codex/responses',
    'https://auth.openai.com/oauth/token',
    'https://chatgpt.com/backend-api/codex/responses',
  ]);
});

test('CodexBackendTransport reports refresh token rotation failures without retrying backend', async () => {
  const codexHome = await createCodexHome({
    accessToken: jwt({ exp: Math.floor(Date.now() / 1000) - 60 }),
    refreshToken: 'used-refresh-token',
  });
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({
      error: {
        message: 'refresh token reused',
        type: 'invalid_request_error',
        code: 'refresh_token_reused',
      },
    }), { status: 401 });
  };
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });

  await assert.rejects(
    () => backend.generate(textRequest()),
    (err) => {
      assert.equal(err.statusCode, 401);
      assert.equal(err.code, 'refresh_token_reused');
      assert.match(err.message, /already used/);
      return true;
    },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://auth.openai.com/oauth/token');
});

async function createCodexHome(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'codex-backend-test-'));
  tempDirs.push(dir);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'auth.json'), JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: {
      id_token: options.idToken ?? idTokenForAccount(options.accountId ?? 'account-1'),
      access_token: options.accessToken ?? 'codex-oauth-token',
      refresh_token: options.refreshToken ?? 'codex-refresh-token',
      account_id: options.accountId ?? 'account-1',
    },
    last_refresh: options.lastRefresh ?? new Date().toISOString(),
  }), { mode: 0o600 });
  return dir;
}

function jwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.signature`;
}

function idTokenForAccount(accountId) {
  return jwt({
    'https://api.openai.com/auth': {
      chatgpt_account_id: accountId,
    },
  });
}

test('CodexBackendTransport preserves client json_schema name and strict (B1)', async () => {
  const codexHome = await createCodexHome();
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(sse([
      { type: 'response.created', response: { id: 'resp_b1', model: 'gpt-5.5', status: 'in_progress' } },
      { type: 'response.completed', response: { id: 'resp_b1', model: 'gpt-5.5' } },
    ]), { status: 200 });
  };
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });

  await backend.generate({
    ...textRequest(),
    jsonMode: true,
    jsonSchema: { type: 'object', additionalProperties: false, properties: {}, required: [] },
    jsonSchemaName: 'my_review_schema',
    jsonSchemaStrict: false,
  });

  const format = JSON.parse(calls[0].init.body).text.format;
  assert.equal(format.type, 'json_schema');
  assert.equal(format.name, 'my_review_schema');
  assert.equal(format.strict, false);
});

test('CodexBackendTransport defaults json_schema name/strict when the client omits them', async () => {
  const codexHome = await createCodexHome();
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(sse([
      { type: 'response.created', response: { id: 'resp_b1d', model: 'gpt-5.5', status: 'in_progress' } },
      { type: 'response.completed', response: { id: 'resp_b1d', model: 'gpt-5.5' } },
    ]), { status: 200 });
  };
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });

  await backend.generate({ ...textRequest(), jsonMode: true, jsonSchema: { type: 'object' } });

  const format = JSON.parse(calls[0].init.body).text.format;
  assert.equal(format.name, 'codex_output_schema');
  assert.equal(format.strict, true);
});

function sse(events) {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
}

function textRequest() {
  return {
    shape: 'openai-responses',
    model: 'gpt-5.5',
    messages: [
      { role: 'system', content: 'Reply tersely.', images: [] },
      { role: 'user', content: 'Return OK.', images: [] },
    ],
    stream: false,
    streamOptions: { includeUsage: false, includeObfuscation: false },
    jsonMode: false,
    tools: [],
    toolChoice: { type: 'auto' },
    raw: {},
    maxTokens: 64,
    temperature: 0,
  };
}

function toolRequest() {
  return {
    ...textRequest(),
    stream: true,
    messages: [
      { role: 'user', content: 'Call get_weather for Seoul.', images: [] },
    ],
    tools: [{
      name: 'get_weather',
      description: 'Get weather.',
      inputSchema: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
        additionalProperties: false,
      },
      raw: {},
    }],
    toolChoice: { type: 'tool', name: 'get_weather' },
  };
}

function imageRequest() {
  return {
    operation: 'generation',
    model: 'image-2',
    prompt: 'Create a simple green leaf icon on a white background. No text.',
    n: 1,
    images: [],
    size: '1024x1024',
    quality: 'medium',
    responseFormat: 'b64_json',
    stream: false,
    partialImages: 0,
    raw: {},
  };
}

function tinyPngBase64() {
  return 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
}

function chatToolResultRequest() {
  return {
    ...textRequest(),
    shape: 'openai-chat',
    messages: [
      { role: 'user', content: 'Use get_weather, then reply with the result.', images: [] },
      {
        role: 'assistant',
        content: [
          '[assistant tool_call]',
          'id: call_weather',
          'name: get_weather',
          'arguments: {"city":"Seoul"}',
        ].join('\n'),
        images: [],
      },
      {
        role: 'tool',
        content: [
          '[tool result]',
          'tool_call_id: call_weather',
          '{"city":"Seoul","temperature_c":23,"condition":"clear"}',
        ].join('\n'),
        images: [],
      },
    ],
    tools: [{
      name: 'get_weather',
      description: 'Get weather.',
      inputSchema: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
        additionalProperties: false,
      },
      raw: {},
    }],
    toolChoice: { type: 'auto' },
  };
}
