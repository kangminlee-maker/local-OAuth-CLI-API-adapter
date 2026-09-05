import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, before, test } from 'node:test';
import sharp from 'sharp';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startLocalApiProxy } from '../dist/proxy/http-server.js';
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

test('default transport, honorRequestModel on: the backend identifier is rejected, not read as omission', async () => {
  // `codex-backend` used to be a sentinel meaning "no model chosen", which made
  // a request naming it run the configured model. It is now an ordinary model
  // name, absent from the served catalogue, so it must 404. Reintroducing the
  // sentinel would turn this back into a silent 200 on `fixture-model-a`, which
  // the catalogue does list.
  resetCodexModelCatalogCache();
  await assert.rejects(
    () => transportBody(
      { ...textRequest(), model: 'codex-backend' },
      { model: 'fixture-model-a', honorRequestModel: true, codexCommand: fakeCodexModelsOk },
    ),
    (err) => {
      assert.equal(err.statusCode, 404, `expected 404, got: ${err.message}`);
      assert.equal(err.code, 'model_not_found');
      assert.equal(err.param, 'model');
      return true;
    },
  );
});

test('default transport, honorRequestModel on: what runs and what is reported agree on the identifier', async () => {
  // `resolvedModel` feeds the model echoed in streaming chunks and is a separate
  // code path from the one that builds the request. A sentinel restored in only
  // one of them would leave the rejection test above green while the two
  // disagreed. The uncollectable catalogue is what makes both observable at
  // once: validation fails open, so the identifier actually executes.
  resetCodexModelCatalogCache();
  const codexHome = await createCodexHome();
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(okSse(), { status: 200 });
  };
  const backend = new CodexBackendTransport({
    codexHome,
    timeoutMs: 30_000,
    model: 'fixture-model-a',
    honorRequestModel: true,
    codexCommand: fakeCodexModelsFail,
  });
  try {
    const request = { ...textRequest(), model: 'codex-backend' };
    // Resolve BEFORE generating, which is the production order — the streaming
    // path resolves the echoed model before the turn starts. Asking afterwards
    // would let a refactor that simply returns the last model `generate` used
    // pass, while a fresh backend still reported the configured one.
    assert.equal(await backend.resolvedModel(request), 'codex-backend', 'reported model');
    await backend.generate(request);
    assert.equal(JSON.parse(calls[0].init.body).model, 'codex-backend', 'executed model');
  } finally {
    await backend.close?.();
  }
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
  assert.equal(toolEvents.length, 4);
  assert.equal(toolEvents[0].name, 'get_weather');
  assert.equal(toolEvents[1].argumentsDelta, '{"city"');
  assert.equal(toolEvents[2].argumentsDelta, ':"Seoul"}');
  // The item the backend finished is announced as finished, once and last, so
  // a surface that holds the call open knows where it ends.
  assert.equal(toolEvents[3].argumentsDone, true);
  assert.equal(toolEvents[3].argumentsDelta, undefined);
  assert.equal(events.at(-1).type, 'completed');
  assert.equal(events.at(-1).result.toolCalls[0].arguments, '{"city":"Seoul"}');
  assert.equal(events.at(-1).result.usage.source, 'provider');
});

test('tool_call_delta index stays dense when a reasoning item shifts output_index', async () => {
  // Captured from gpt-5.6-terra (2026-08-19): a reasoning output item occupies
  // output_index 0, the function call arrives at output_index 1, and the final
  // response.completed output carries no function_call item. Forwarding the raw
  // output_index desynced streamed deltas (index 1) from the completed result's
  // dense positions (index 0), so the server re-emitted the full arguments.
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse([
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'reasoning', id: 'rs_1' },
    },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: { type: 'reasoning', id: 'rs_1' },
    },
    {
      type: 'response.output_item.added',
      output_index: 1,
      item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather' },
    },
    {
      type: 'response.function_call_arguments.delta',
      output_index: 1,
      item_id: 'fc_1',
      delta: '{"city"',
    },
    {
      type: 'response.function_call_arguments.delta',
      output_index: 1,
      item_id: 'fc_1',
      delta: ':"Seoul"}',
    },
    {
      type: 'response.function_call_arguments.done',
      output_index: 1,
      item_id: 'fc_1',
    },
    {
      type: 'response.output_item.done',
      output_index: 1,
      item: {
        type: 'function_call',
        id: 'fc_1',
        call_id: 'call_1',
        name: 'get_weather',
        arguments: '{"city":"Seoul"}',
      },
    },
    {
      type: 'response.completed',
      response: { id: 'resp_terra_tool', model: 'gpt-5.6-terra', output: [] },
    },
  ]), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });

  const events = [];
  for await (const event of backend.stream(toolRequest())) events.push(event);

  const toolEvents = events.filter((event) => event.type === 'tool_call_delta');
  assert.ok(toolEvents.length > 0);
  for (const event of toolEvents) assert.equal(event.index, 0);
  assert.equal(toolEvents.map((event) => event.argumentsDelta).join(''), '{"city":"Seoul"}');
  const result = events.at(-1).result;
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].id, 'call_1');
  assert.equal(result.toolCalls[0].arguments, '{"city":"Seoul"}');
});

test('an id-less completed function_call does not duplicate a call already streamed', async () => {
  // The completed output is its own coordinate system: it counts function calls
  // in an array that also holds reasoning items, while the stream's
  // output_index counts every item. Feeding an array position into the stream's
  // positional keyspace minted a second ordinal for the same call, so the
  // result carried the tool call twice and the server re-emitted its arguments.
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse([
    {
      type: 'response.output_item.added',
      output_index: 1,
      item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather' },
    },
    {
      type: 'response.function_call_arguments.delta',
      output_index: 1,
      item_id: 'fc_1',
      delta: '{"city":"Seoul"}',
    },
    {
      type: 'response.completed',
      response: {
        id: 'resp_idless_final',
        model: 'gpt-5.5',
        // The reasoning item is what makes the two views disagree: the call is
        // at array position 1 here and at dense tool position 0 in the stream.
        output: [
          { type: 'reasoning', id: 'rs_1' },
          { type: 'function_call', name: 'get_weather', arguments: '{"city":"Seoul"}' },
        ],
      },
    },
  ]), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });

  const events = [];
  for await (const event of backend.stream(toolRequest())) events.push(event);

  const toolCalls = events.at(-1).result.toolCalls;
  assert.equal(toolCalls.length, 1, `expected one tool call, got ${JSON.stringify(toolCalls)}`);
  assert.equal(toolCalls[0].arguments, '{"city":"Seoul"}');
  for (const event of events.filter((e) => e.type === 'tool_call_delta')) {
    assert.equal(event.index, 0);
  }
});

test('calls with ids stay separate when the stream omits output_index', async () => {
  // `readOutputIndex` reports 0 for an absent `output_index`, so a positional
  // fallback that identified events could inherit collapsed every call in such
  // a stream into one — the client saw a single call whose arguments were both
  // calls' JSON concatenated.
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse([
    { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather' } },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"city":"Seoul"}' },
    { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'get_time' } },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_2', delta: '{"tz":"KST"}' },
    { type: 'response.completed', response: { id: 'resp_no_output_index', model: 'gpt-5.5', output: [] } },
  ]), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });

  const events = [];
  for await (const event of backend.stream(withDeclared(toolRequest(), ['get_time']))) events.push(event);

  assert.deepEqual(
    events.at(-1).result.toolCalls.map((call) => [call.id, call.name, call.arguments]),
    [['call_1', 'get_weather', '{"city":"Seoul"}'], ['call_2', 'get_time', '{"tz":"KST"}']],
  );
  const perIndex = new Map();
  for (const event of events.filter((e) => e.type === 'tool_call_delta')) {
    perIndex.set(event.index, `${perIndex.get(event.index) ?? ''}${event.argumentsDelta ?? ''}`);
  }
  assert.deepEqual([...perIndex.entries()], [[0, '{"city":"Seoul"}'], [1, '{"tz":"KST"}']]);
});

test('a call is announced finished only when the backend finished it', async () => {
  // The signal is a promise to the surfaces that hold a call open: nothing more
  // is coming for it. A turn cut off mid-argument has no such point, so it must
  // not be claimed — the completed result is what carries the rest there.
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse([
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: '{"city":' },
    {
      type: 'response.completed',
      response: {
        id: 'resp_unfinished',
        model: 'gpt-5.5',
        output: [{ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"Seoul"}' }],
      },
    },
  ]), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });

  const events = [];
  for await (const event of backend.stream(toolRequest())) events.push(event);

  assert.equal(events.filter((event) => event.argumentsDone).length, 0);
  assert.equal(events.at(-1).result.toolCalls[0].arguments, '{"city":"Seoul"}');
});

test('a finished call with no arguments streams the value its result reports', async () => {
  // `{}` is what the completed result carries for a call that streamed nothing.
  // Announcing the call finished without it left a surface that closes on the
  // signal holding an empty string, which is not the JSON the body promises.
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse([
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'now' } },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'now', arguments: '' } },
    { type: 'response.completed', response: { id: 'resp_noargs', model: 'gpt-5.5', output: [] } },
  ]), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });

  const events = [];
  for await (const event of backend.stream(withDeclared(toolRequest(), ['now']))) events.push(event);

  const streamed = events
    .filter((event) => event.type === 'tool_call_delta')
    .map((event) => event.argumentsDelta ?? '')
    .join('');
  assert.equal(streamed, events.at(-1).result.toolCalls[0].arguments);
  assert.equal(streamed, '{}');
  assert.equal(events.filter((event) => event.argumentsDone).length, 1);
});

test('arguments that arrive before the call is named belong to that call', async () => {
  // These deltas carry nothing but an output position, so the item that names
  // the position is the call they belong to. Splitting them onto an ordinal of
  // their own invented a second call — named `tool`, holding a fragment of the
  // real arguments — and held the fragment back from the real one.
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse([
    { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"city":' },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: '"Seoul"}' },
    { type: 'response.completed', response: { id: 'resp_early_args', model: 'gpt-5.5', output: [] } },
  ]), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });

  const events = [];
  for await (const event of backend.stream(toolRequest())) events.push(event);

  assert.deepEqual(
    events.at(-1).result.toolCalls.map((call) => [call.id, call.name, call.arguments]),
    [['call_1', 'get_weather', '{"city":"Seoul"}']],
  );
  const perIndex = new Map();
  for (const event of events.filter((e) => e.type === 'tool_call_delta')) {
    perIndex.set(event.index, `${perIndex.get(event.index) ?? ''}${event.argumentsDelta ?? ''}`);
  }
  assert.deepEqual([...perIndex.entries()], [[0, '{"city":"Seoul"}']]);
});

test('an item repeated without its call_id does not un-name the call', async () => {
  // `identified` is a latch: the client has already been told `call_1`, so a
  // later item that omits the `call_id` cannot take the name away. Assigning
  // instead of latching sent every following delta back to the buffer, and only
  // an announced call is ever flushed — so the transport's own stream stopped
  // short of the arguments its completed result reports. The HTTP layer repairs
  // that gap before a client sees it, which is exactly why it has to be caught
  // here.
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse([
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: '{"city":' },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', name: 'get_weather' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: '"Seoul"}' },
    { type: 'response.completed', response: { id: 'resp_relabel', model: 'gpt-5.5', output: [] } },
  ]), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });

  const events = [];
  for await (const event of backend.stream(toolRequest())) events.push(event);

  const streamed = events
    .filter((event) => event.type === 'tool_call_delta')
    .map((event) => event.argumentsDelta ?? '')
    .join('');
  assert.equal(streamed, '{"city":"Seoul"}');
  assert.deepEqual(
    events.at(-1).result.toolCalls.map((call) => [call.id, call.arguments]),
    [['call_1', '{"city":"Seoul"}']],
  );
});

test('a completed call the stream never announced is added, not swapped in', async () => {
  // Its ids are unfamiliar, so it is a call of its own; taking the dense
  // position a streamed call already holds would drop that call instead.
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse([
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: '{"city":"Seoul"}' },
    {
      type: 'response.completed',
      response: {
        id: 'resp_unseen_call',
        model: 'gpt-5.5',
        // `call_1` at its accepted position 0; the unseen call after it.
        output: [
          { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"Seoul"}' },
          { type: 'function_call', id: 'fc_9', call_id: 'call_9', name: 'get_time', arguments: '{"tz":"KST"}' },
        ],
      },
    },
  ]), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });

  const events = [];
  for await (const event of backend.stream(withDeclared(toolRequest(), ['get_time']))) events.push(event);

  assert.deepEqual(
    events.at(-1).result.toolCalls.map((call) => [call.id, call.name, call.arguments]),
    [['call_1', 'get_weather', '{"city":"Seoul"}'], ['call_9', 'get_time', '{"tz":"KST"}']],
  );
});

for (const [label, terminal] of [
  ['response.failed', { type: 'response.failed', response: { id: 'r', error: { code: 'server_error', message: 'upstream exploded' } } }],
  ['an SSE error frame', { type: 'error', error: { message: 'stream aborted upstream' } }],
]) {
  test(`a turn ending in ${label} is a failure, not a finished answer`, async () => {
    // The deltas already forwarded used to be served as a complete answer:
    // HTTP 200, finish_reason "stop", and whatever text arrived before the
    // failure — indistinguishable from a turn that actually finished.
    const codexHome = await createCodexHome();
    globalThis.fetch = async () => new Response(sse([
      { type: 'response.output_text.delta', delta: 'The answer is ' },
      { type: 'response.output_text.delta', delta: '4' },
      terminal,
    ]), { status: 200 });
    const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });

    await assert.rejects(() => backend.generate(textRequest()), /codex backend turn failed/);
  });
}

test('a truncated turn returns what it generated, with a stop reason', async () => {
  // `response.incomplete` means the cap was hit, not that the turn broke: the
  // output is real and the provider returns it. Failing the request discarded
  // every generated token and, being a 500, invited a retry that would
  // deterministically hit the same cap.
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse([
    { type: 'response.output_text.delta', delta: 'Here is the first half' },
    {
      type: 'response.incomplete',
      response: { id: 'r', model: 'gpt-5.5', output: [], incomplete_details: { reason: 'max_output_tokens' } },
    },
  ]), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });

  const result = await backend.generate(textRequest());
  assert.equal(result.text, 'Here is the first half');
  assert.equal(result.stopReason, 'max_tokens');
});

test('a turn that completed is not undone by a later error frame', async () => {
  // Noise after the terminal frame — or a warning the backend recovered from —
  // used to discard a finished, correct answer as a 500.
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse([
    { type: 'response.output_text.delta', delta: 'complete answer' },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [] } },
    { type: 'error', error: { message: 'post-completion noise' } },
  ]), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });

  const result = await backend.generate(textRequest());
  assert.equal(result.text, 'complete answer');
});

test('a stream that ends with no terminal event is a failure', async () => {
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse([
    { type: 'response.output_text.delta', delta: 'partial' },
  ]), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });

  await assert.rejects(() => backend.generate(textRequest()), /ended without a terminal event/);
});

test('a tool call carrying no arguments reports an empty object', async () => {
  // `{"input":""}` invents a property: a strict schema rejects the call and a
  // loose one hands the tool a parameter the model never sent.
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse([
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_time' } },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_time' } },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [] } },
  ]), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });

  const result = await backend.generate(withDeclared(toolRequest(), ['get_time']));
  assert.deepEqual(result.toolCalls.map((call) => [call.name, call.arguments]), [['get_time', '{}']]);
});

test('an anonymous completed call cannot rewrite what the stream already delivered', async () => {
  // Position is not identity. With two calls listed in an order the stream did
  // not use, overwriting gave each streamed call the other call's name and
  // arguments under its own id, so a client answered the wrong call. The item
  // at index 1 (`get_weather`) is the call holding position 1, name and
  // value agreeing — applied, a no-op; the item at index 0 (`get_time`)
  // correlates with nothing: no call holds position 0, and the one call
  // left, `call_2`, sits at position 2. An item correlated with nothing is
  // a call without an identity: the turn is refused rather than guessed
  // (round 37).
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse([
    { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather' } },
    { type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'fc_1', delta: '{"city":"Seoul"}' },
    { type: 'response.output_item.added', output_index: 2, item: { type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'get_time' } },
    { type: 'response.function_call_arguments.delta', output_index: 2, item_id: 'fc_2', delta: '{"tz":"KST"}' },
    {
      type: 'response.completed',
      response: {
        id: 'r',
        model: 'gpt-5.5',
        output: [
          { type: 'function_call', name: 'get_time', arguments: '{"tz":"KST"}' },
          { type: 'function_call', name: 'get_weather', arguments: '{"city":"Seoul"}' },
        ],
      },
    },
  ]), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });
  await assert.rejects(async () => {
    for await (const event of backend.stream(withDeclared(toolRequest(), ['get_time']))) void event;
  }, /missing its call_id/);
});

test('a call is announced with the id the client must echo, not a placeholder', async () => {
  // When `call_id` only arrives on `output_item.done`, announcing at `added`
  // told the streaming client `fc_1` while the completed result said `call_1`.
  // A client cannot rename a call it already reported, so it answers under an
  // id the model never used.
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse([
    { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc_1', name: 'get_weather' } },
    { type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'fc_1', delta: '{"city":"Seoul"}' },
    { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"Seoul"}' } },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [] } },
  ]), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });

  const events = [];
  for await (const event of backend.stream(toolRequest())) events.push(event);

  const announced = events.filter((event) => event.type === 'tool_call_delta' && event.id);
  assert.ok(announced.length > 0);
  for (const event of announced) {
    assert.equal(event.id, 'call_1', 'streamed identity must match the completed result');
  }
  const streamedArguments = events
    .filter((event) => event.type === 'tool_call_delta')
    .map((event) => event.argumentsDelta ?? '')
    .join('');
  assert.equal(streamedArguments, '{"city":"Seoul"}', 'arguments held before naming are still delivered');
  assert.deepEqual(
    events.at(-1).result.toolCalls.map((call) => [call.id, call.arguments]),
    [['call_1', '{"city":"Seoul"}']],
  );
});

test('an id-less completed call never overwrites a different streamed call: naming another tool at a held position, it is refused (round 26 kept it out; round 41)', async () => {
  // When the completed output holds fewer function calls than the stream did,
  // positional alignment would land an anonymous item on whichever streamed
  // call shares its position — replacing that call's name and arguments with
  // another call's payload. A client would then run the wrong tool, twice.
  // The item at index 0 names `delete_file` where the stream put
  // `get_weather`: two calls named as one, refused.
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse([
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: '{"city":"Seoul"}' },
    { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'delete_file' } },
    { type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'fc_2', delta: '{"path":"/tmp/x"}' },
    {
      type: 'response.completed',
      response: {
        id: 'resp_mismatched_counts',
        model: 'gpt-5.5',
        output: [{ type: 'function_call', name: 'delete_file', arguments: '{"path":"/tmp/x"}' }],
      },
    },
  ]), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });
  await assert.rejects(async () => {
    for await (const event of backend.stream(withDeclared(toolRequest(), ['delete_file']))) void event;
  }, /named two tool calls as one/);
});

test('Images requests ignore honorRequestModel: the configured image model runs', async () => {
  // The contract exempts `/v1/images/*` from the switch: the request `model` is
  // an Images model name (`gpt-image-2`), not a Codex slug. Honouring it would
  // send `gpt-image-2` where a Codex model belongs. The exemption currently holds by
  // construction — the image path never consults the setting — which is exactly
  // the kind of fact that a later edit can undo silently.
  const codexHome = await createCodexHome();
  const calls = [];
  const image = tinyPngBase64();
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(sse([
      { type: 'response.created', response: { id: 'resp_image', model: 'gpt-5.5' } },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: { type: 'image_generation_call', id: 'ig_1', status: 'completed', result: image },
      },
      { type: 'response.completed', response: { id: 'resp_image', model: 'gpt-5.5' } },
    ]));
  };
  const backend = new CodexBackendTransport({
    codexHome, timeoutMs: 30_000, model: 'gpt-5.5', honorRequestModel: true,
  });
  await backend.generate({ ...imageRequest(), model: 'gpt-image-2' });
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, 'gpt-5.5', 'the configured Codex model runs, not the Images route selector');
  assert.notEqual(body.model, 'gpt-image-2');
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
    background: 'opaque',
    moderation: 'low',
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
    background: 'opaque',
    moderation: 'low',
  }]);
  assert.doesNotMatch(body.input[0].content[0].text, /opaque|moderation/i);
  assert.deepEqual(body.tool_choice, { type: 'image_generation' });
  assert.equal(body.reasoning.effort, 'medium');
  assert.match(body.instructions, /Use the image_generation tool/);
  assert.doesNotMatch(body.input[0].content[0].text, /translation constraints/, 'no route hint, no translation block');
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

test('an image item followed by response.failed is a failed turn, not a successful image: buffered (r47-codex)', async () => {
  const codexHome = await createCodexHome();
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(sse([
      { type: 'response.created', response: { id: 'resp_image', model: 'gpt-5.5' } },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'image_generation_call', id: 'ig_1', status: 'completed', result: tinyPngBase64() } },
      { type: 'response.failed', response: { id: 'resp_image', model: 'gpt-5.5', status: 'failed', error: { message: 'offline upstream failed after image item' } } },
    ]));
  };
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });
  await assert.rejects(() => backend.generate(imageRequest()), /codex backend turn failed: offline upstream failed after image item/);
  // A failed turn is the backend's answer, not the retryable "no image" turn.
  assert.equal(calls.length, 1);
});

test('...and streamed: the image event already written is followed by the failure, not by success (r47-codex)', async () => {
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse([
    { type: 'response.created', response: { id: 'resp_image', model: 'gpt-5.5' } },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'image_generation_call', id: 'ig_1', status: 'completed', result: tinyPngBase64() } },
    { type: 'response.failed', response: { id: 'resp_image', model: 'gpt-5.5', status: 'failed', error: { message: 'offline upstream failed after image item' } } },
  ]));
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });
  const events = [];
  await assert.rejects(async () => {
    for await (const event of backend.stream(imageRequest())) events.push(event);
  }, /codex backend turn failed: offline upstream failed after image item/);
  assert.deepEqual(events.map((event) => event.type), ['completed']);
});

test('an image stream that ends without a terminal event is a failure, image or no image (r47-codex)', async () => {
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse([
    { type: 'response.created', response: { id: 'resp_image', model: 'gpt-5.5' } },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'image_generation_call', id: 'ig_1', status: 'completed', result: tinyPngBase64() } },
  ]));
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });
  await assert.rejects(() => backend.generate(imageRequest()), /image stream ended without a terminal event/);
});

test('a settled image turn is finished, whatever follows: a failure frame after response.completed changes nothing (r47-codex)', async () => {
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse([
    { type: 'response.created', response: { id: 'resp_image', model: 'gpt-5.5' } },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'image_generation_call', id: 'ig_1', status: 'completed', result: tinyPngBase64() } },
    { type: 'response.completed', response: { id: 'resp_image', model: 'gpt-5.5' } },
    { type: 'response.failed', response: { id: 'resp_image', model: 'gpt-5.5', status: 'failed', error: { message: 'noise after the terminal' } } },
  ]));
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });
  const result = await backend.generate(imageRequest());
  assert.equal(result.images.length, 1);
});

// The backend has a `size` slot and does not always honour it (a 256×256
// source edited at `1024x1024` came back 1254×1254, measured 2026-08-29). The
// direct API returns the requested canvas; so does this transport, on the
// bytes, on both the buffered and the streamed path.
function imageSse(b64, { id = 'resp_size', model = 'gpt-5.5' } = {}) {
  return sse([
    { type: 'response.created', response: { id, model } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'image_generation_call', id: 'ig_1', status: 'in_progress' } },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'image_generation_call', id: 'ig_1', status: 'completed', result: b64 } },
    { type: 'response.completed', response: { id, model, output: [{ type: 'image_generation_call', id: 'ig_1', status: 'completed', result: b64 }] } },
  ]);
}
async function solidPng(width, height, background = { r: 10, g: 20, b: 30, alpha: 1 }) {
  return (await sharp({ create: { width, height, channels: 4, background } }).png().toBuffer()).toString('base64');
}
const dims = async (b64) => {
  const m = await sharp(Buffer.from(b64, 'base64')).metadata();
  return `${m.width}x${m.height}`;
};

test('a returned canvas that is not the requested size is brought to it (buffered)', async () => {
  const codexHome = await createCodexHome();
  const calls = [];
  const returned = await solidPng(8, 8);
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(imageSse(returned), { status: 200 });
  };
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000, model: 'gpt-5.5' });
  const result = await backend.generate({ ...imageRequest(), size: '32x16' });
  assert.equal(JSON.parse(calls[0].init.body).tools[0].size, '32x16', 'the slot is still sent; the bytes are corrected, not the request');
  assert.equal(result.images.length, 1);
  assert.equal(await dims(result.images[0].b64Json), '32x16');
  assert.equal(result.size, '32x16');
});

test('a returned canvas that is not the requested size is brought to it (streamed)', async () => {
  const codexHome = await createCodexHome();
  const returned = await solidPng(8, 8);
  globalThis.fetch = async () => new Response(imageSse(returned), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000, model: 'gpt-5.5' });
  const events = [];
  for await (const event of backend.stream({ ...imageRequest(), size: '32x16', stream: true })) events.push(event);
  const completed = events.filter((event) => event.type === 'completed');
  assert.equal(completed.length, 1);
  assert.equal(await dims(completed[0].image.b64Json), '32x16');
});

test('every image of every turn is corrected, in turn order (n > 1)', async () => {
  // The fan-out runs one backend turn per requested image; a correction that
  // only reached the first turn's images would leave the rest at whatever
  // canvas the backend chose, which is the defect this whole path exists for.
  const codexHome = await createCodexHome();
  const returned = [await solidPng(8, 8, { r: 255, g: 0, b: 0, alpha: 1 }), await solidPng(16, 4, { r: 0, g: 0, b: 255, alpha: 1 })];
  // Keyed by the TURN, read out of the prompt, not by the order the two
  // concurrent turns happen to reach fetch: an arrival-order stub decides the
  // colour of turn 0 by a coin flip, and this assertion then passed or failed
  // on the scheduler rather than on the transport.
  globalThis.fetch = async (_url, init) => {
    const body = JSON.stringify(JSON.parse(init.body).input);
    const turn = body.includes('Generate image 1 of 2') ? 0 : 1;
    assert.match(body, /Generate image [12] of 2/, 'the turn must be identifiable from its own request');
    return new Response(imageSse(returned[turn]), { status: 200 });
  };
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000, model: 'gpt-5.5' });
  const result = await backend.generate({ ...imageRequest(), n: 2, size: '32x16' });
  assert.equal(result.images.length, 2);
  for (const [index, image] of result.images.entries()) {
    assert.equal(await dims(image.b64Json), '32x16', `image ${index}`);
  }
  // Turn order is the response order: the red turn's image is first.
  const colour = async (b64) => {
    const { data } = await sharp(Buffer.from(b64, 'base64')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return [data[0], data[1], data[2]];
  };
  assert.deepEqual(await colour(result.images[0].b64Json), [255, 0, 0]);
  assert.deepEqual(await colour(result.images[1].b64Json), [0, 0, 255]);
});

test('the streamed completed frame reports the size its bytes actually have', async () => {
  // Through the HTTP surface, because the promise is what the CLIENT reads:
  // the event's `size` and the bytes beside it have to be the same canvas.
  const codexHome = await createCodexHome();
  const returned = await solidPng(8, 8);
  globalThis.fetch = async () => new Response(imageSse(returned), { status: 200 });
  const started = await startLocalApiProxy({
    backend: { name: 'unused', model: 'x', async generate() { throw new Error('unused'); }, async close() {} },
    imageGenerationClient: new CodexBackendTransport({ codexHome, timeoutMs: 30_000, model: 'gpt-5.5' }),
    host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
  });
  try {
    // The proxy's own fetch stub must not intercept the client's request.
    const res = await originalFetch(`${started.url}/v1/images/generations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-image-2', prompt: 'a green leaf icon', size: '32x16', stream: true }),
    });
    assert.equal(res.status, 200);
    const wire = await res.text();
    const frames = [...wire.matchAll(/^event: (\S+)\ndata: (.+)$/gm)].map(([, type, data]) => ({ type, data: JSON.parse(data) }));
    assert.equal(frames.length, 1, wire);
    assert.equal(frames[0].type, 'image_generation.completed');
    assert.equal(frames[0].data.size, '32x16');
    assert.equal(await dims(frames[0].data.b64_json), '32x16', 'the frame reports the canvas its own bytes carry');
  } finally {
    await started.close();
  }
});

// A codec that cannot load is answered before the first backend turn — which
// cannot be shown in-process, because this process has a working sharp. The
// child runs the same two requests under a resolve hook that makes
// `import('sharp')` fail, and the control arm (no hook) is what proves the
// probe's fetch counter can move at all.
test('a codec that cannot load is a 500 before any backend turn, buffered and streamed', async () => {
  const execFileAsync = promisify(execFile);
  const probe = resolve(here, 'fixtures/image-codec-failure-probe.mjs');
  const run = async (args) => JSON.parse((await execFileAsync(process.execPath, args, { cwd: resolve(here, '..') })).stdout);

  const failed = await run(['--import', './test/fixtures/register-fail-sharp.mjs', probe]);
  for (const arm of ['buffered', 'streamed']) {
    assert.equal(failed[arm].name, 'ProxyRequestError', arm);
    assert.equal(failed[arm].statusCode, 500, arm);
    assert.equal(failed[arm].type, 'server_error', arm);
    assert.equal(failed[arm].param, null, arm);
    assert.match(failed[arm].message, /sharp/, arm);
  }
  assert.equal(failed.fetchCallsAfterBuffered, 0, 'the buffered path did not start a turn');
  assert.equal(failed.fetchCalls, 0, 'neither path started a turn');

  const control = await run([probe]);
  assert.equal(control.fetchCalls, 2, 'with a loadable codec both paths do reach the backend — the counter is not stuck at 0');
  assert.notEqual(control.buffered.statusCode, 500);
});

test('a returned canvas already at the requested size is passed through byte for byte', async () => {
  const codexHome = await createCodexHome();
  const returned = await solidPng(32, 16);
  globalThis.fetch = async () => new Response(imageSse(returned), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000, model: 'gpt-5.5' });
  const result = await backend.generate({ ...imageRequest(), size: '32x16' });
  assert.equal(result.images[0].b64Json, returned);
});

test('a request with size auto takes whatever canvas the backend returns', async () => {
  const codexHome = await createCodexHome();
  const returned = await solidPng(8, 8);
  globalThis.fetch = async () => new Response(imageSse(returned), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000, model: 'gpt-5.5' });
  const result = await backend.generate({ ...imageRequest(), size: 'auto' });
  assert.equal(result.images[0].b64Json, returned);
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
  assert.match(body.input[0].content[0].text, /Make the leaf blue while keeping the composition\./, 'the caller prompt goes through verbatim');
  assert.match(body.input[0].content[0].text, /Attached images 1-1/);
});

test('CodexBackendTransport sends the edit mask and input_fidelity on the tool, not as prose', async () => {
  // The mask has a slot on the backend tool (`input_image_mask`, probed live
  // 2026-08-29). It used to be appended to the input images and the model told
  // in prose that the last picture was a mask; the tool never knew.
  const codexHome = await createCodexHome();
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(sse([
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: { type: 'image_generation_call', id: 'ig_mask', status: 'completed', result: tinyPngBase64() },
      },
      { type: 'response.completed', response: { id: 'resp_image_mask', model: 'gpt-5.5' } },
    ]), { status: 200 });
  };
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000, model: 'gpt-5.5' });
  const source = { source: { type: 'base64', mediaType: 'image/png', data: tinyPngBase64() }, raw: {} };

  await backend.generate({
    ...imageRequest(),
    model: 'gpt-image-1',
    operation: 'edit',
    prompt: 'Make the leaf blue.',
    images: [source],
    mask: { source: { type: 'base64', mediaType: 'image/png', data: 'bWFzaw==' }, raw: {} },
    inputFidelity: 'high',
  });
  const body = JSON.parse(calls[0].init.body);

  assert.deepEqual(body.tools[0].input_image_mask, { image_url: 'data:image/png;base64,bWFzaw==' });
  assert.equal(body.tools[0].input_fidelity, 'high');
  const images = body.input[0].content.filter((part) => part.type === 'input_image');
  assert.equal(images.length, 1, 'the mask is no longer attached as an input image');
  assert.doesNotMatch(body.input[0].content[0].text, /mask|fidelity/i);
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

test('turns that expire together refresh the Codex token once, not once each', async () => {
  // A refresh token is single-use and rotates: two turns that refresh
  // concurrently would spend it twice, and the second exchange invalidates the
  // credential the first one just wrote. The lock and the re-read inside it are
  // what makes the second caller adopt the first's result — nothing tested
  // that, so removing either left the whole suite green.
  const codexHome = await createCodexHome({
    accessToken: jwt({ exp: Math.floor(Date.now() / 1000) - 60 }),
    refreshToken: 'single-use-refresh-token',
    lastRefresh: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
  });
  let refreshes = 0;
  const refreshTokensSeen = [];
  const backendTokens = [];
  globalThis.fetch = async (url, init) => {
    if (url === 'https://auth.openai.com/oauth/token') {
      refreshes += 1;
      refreshTokensSeen.push(JSON.parse(init.body).refresh_token);
      // Long enough that a second caller reaches the refresh path while this
      // one is still in flight — the race the guard exists for.
      await new Promise((resolve) => { setTimeout(resolve, 50); });
      return Response.json({
        id_token: idTokenForAccount('account-1'),
        access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600, jti: 'refreshed' }),
        refresh_token: 'rotated-refresh-token',
      });
    }
    backendTokens.push(init.headers.authorization);
    return new Response(sse([
      { type: 'response.output_text.delta', delta: 'OK' },
      { type: 'response.completed', response: { id: 'resp_concurrent', model: 'gpt-5.5' } },
    ]), { status: 200 });
  };
  const first = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });
  const second = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });

  const results = await Promise.all([
    first.generate(textRequest()),
    second.generate(textRequest()),
  ]);
  await first.close();
  await second.close();

  assert.deepEqual(results.map((result) => result.text), ['OK', 'OK']);
  assert.equal(refreshes, 1, `expected one refresh, got ${refreshes} (${refreshTokensSeen.join(', ')})`);
  assert.deepEqual(refreshTokensSeen, ['single-use-refresh-token']);
  assert.equal(new Set(backendTokens).size, 1, 'both turns should carry the same refreshed token');
  const persisted = JSON.parse(await readFile(join(codexHome, 'auth.json'), 'utf8'));
  assert.equal(persisted.tokens.refresh_token, 'rotated-refresh-token');
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

/**
 * The native channel refuses a call the request never declared (round 27,
 * the wrapper reading's rule): a double that calls `get_time` or `now`
 * declares it, since what these tests measure is elsewhere.
 */
function withDeclared(request, names) {
  return { ...request, tools: [...request.tools, ...names.map((name) => ({ name, description: name, inputSchema: { type: 'object', properties: {}, additionalProperties: false } }))] };
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
    model: 'gpt-image-2',
    prompt: 'Create a simple green leaf icon on a white background. No text.',
    n: 1,
    images: [],
    size: '1024x1024',
    quality: 'medium',
    stream: false,
    partialImages: 0,
    raw: {},
  };
}

function tinyPngBase64() {
  return 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
}

// The two tool turns below carry a `tool` field because that is what the
// normalizer records when it flattens them — this fixture simulates its output,
// so it has to match it: a turn is an ORDERED sequence of parts, because three
// buckets could not say where the turn's prose sat among its calls. `content` is the same turn rendered as text, which is
// what the claude runtime reads; the codex transport builds its items from the
// field. Dropping the field makes the transport read these as ordinary prose,
// which is the correct behaviour for text a CALLER wrote and the wrong behaviour
// for a turn this proxy flattened itself.
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
        tool: {
          parts: [{ kind: 'call', call: { id: 'call_weather', name: 'get_weather', arguments: '{"city":"Seoul"}' } }],
        },
      },
      {
        role: 'tool',
        content: [
          '[tool result]',
          'tool_call_id: call_weather',
          '{"city":"Seoul","temperature_c":23,"condition":"clear"}',
        ].join('\n'),
        images: [],
        tool: {
          parts: [{ kind: 'result', result: { callId: 'call_weather', output: '{"city":"Seoul","temperature_c":23,"condition":"clear"}' } }],
        },
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

// Verbosity is a length-governing field, and the adapter used to fill it in with
// `'medium'` whenever the caller left it out — not from settings, not from the
// operator, but from a constructor default in this file. The direct API sends
// the field only when the caller does, so the proxy was authoring a parameter
// nobody set: the same class as injecting prose, one layer down. Captured on the
// wire, all four cases.
test('text.verbosity is sent only when someone actually asked for it', async () => {
  const codexHome = await createCodexHome();
  let sent = null;
  globalThis.fetch = async (_url, init) => {
    sent = JSON.parse(init.body);
    return new Response(sse([{ type: 'response.completed', response: { id: 'r', model: 'gpt-5.5' } }]), { status: 200 });
  };

  const base = textRequest();

  const silent = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });
  await silent.generate(base);
  assert.equal(sent.text, undefined, 'nobody asked, so no text object at all — not even an empty one');

  await silent.generate({ ...base, verbosity: 'high' });
  assert.deepEqual(sent.text, { verbosity: 'high' }, "the caller's value is what goes on the wire");

  const configured = new CodexBackendTransport({ codexHome, timeoutMs: 30_000, verbosity: 'low' });
  await configured.generate(base);
  assert.deepEqual(sent.text, { verbosity: 'low' }, 'an operator who sets one explicitly still gets it');

  await silent.generate({ ...base, jsonMode: true });
  assert.deepEqual(sent.text, { format: { type: 'json_object' } }, 'json mode still carries its format, with no verbosity added');
});

// `textRuns` is DERIVED here, from the upstream's own event order, and this is
// the only backend that can produce a turn one position could not describe: a
// call, then narration, then another call — and narration on BOTH SIDES of a
// call, which a count could not carry either. A surface test that hands the
// field to a stub proves the surfaces read it; only this proves anything
// writes it.
async function turnFor(events) {
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse(events), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000, model: 'gpt-5.5' });
  return backend.generate({
    ...textRequest(),
    tools: [{ name: 'get_weather', description: 'w', parameters: { type: 'object', properties: {} } }],
    toolChoice: { type: 'auto' },
  });
}

const CREATED = { type: 'response.created', response: { id: 'r', model: 'x', status: 'in_progress' } };
const DONE = { type: 'response.completed', response: { id: 'r', model: 'x' } };
const callAdded = (outputIndex, n) => ({
  type: 'response.output_item.added',
  output_index: outputIndex,
  item: { type: 'function_call', id: `fc${n}`, call_id: `c${n}`, name: 'get_weather', arguments: '' },
});
const callDone = (outputIndex, n) => ({
  type: 'response.output_item.done',
  output_index: outputIndex,
  item: { type: 'function_call', id: `fc${n}`, call_id: `c${n}`, name: 'get_weather', arguments: '{}' },
});

/** The runs the transport recorded, as [text, calls before it] pairs. */
const runsOf = (turn) => (turn.textRuns ?? []).map((run) => [run.text, run.afterCalls]);

test('the transport reports the text position for a call/text/call turn', async () => {
  const turn = await turnFor([
    CREATED, callAdded(0, 1), callDone(0, 1),
    { type: 'response.output_text.delta', delta: 'BETWEEN' },
    callAdded(2, 2), callDone(2, 2), DONE,
  ]);
  assert.equal(turn.toolCalls.length, 2);
  assert.deepEqual(runsOf(turn), [['BETWEEN', 1]], 'one call came before the narration');
});

test('the transport reports every call before the text as the full count', async () => {
  const turn = await turnFor([
    CREATED, callAdded(0, 1), callDone(0, 1), callAdded(1, 2), callDone(1, 2),
    { type: 'response.output_text.delta', delta: 'AFTER' }, DONE,
  ]);
  assert.deepEqual(runsOf(turn), [['AFTER', 2]]);
});

test('the transport reports text-first as no calls before it', async () => {
  const turn = await turnFor([
    CREATED, { type: 'response.output_text.delta', delta: 'FIRST' },
    callAdded(1, 1), callDone(1, 1), DONE,
  ]);
  assert.deepEqual(runsOf(turn), [['FIRST', 0]]);
});

test('the transport reports narration on BOTH SIDES of a call as two runs', async () => {
  // The shape a COUNT could not carry: "how many calls precede THE text" names
  // one position, and this turn's text has two. Read as a count the turn came
  // back as `[text, tool_use]` buffered against a streamed
  // `[text, tool_use, text]` — one turn, two orders, measured on this backend.
  const turn = await turnFor([
    CREATED, { type: 'response.output_text.delta', delta: 'BEFORE ' },
    callAdded(1, 1), callDone(1, 1),
    { type: 'response.output_text.delta', delta: 'AFTER' }, DONE,
  ]);
  assert.equal(turn.toolCalls.length, 1);
  assert.deepEqual(runsOf(turn), [['BEFORE ', 0], ['AFTER', 1]]);
  assert.equal(turn.text, 'BEFORE AFTER', 'and the flat text is still every byte, in order');
});

test('the transport reports several runs among several calls', async () => {
  const turn = await turnFor([
    CREATED, { type: 'response.output_text.delta', delta: 'A' },
    callAdded(1, 1), callDone(1, 1),
    { type: 'response.output_text.delta', delta: 'B' },
    callAdded(3, 2), callDone(3, 2),
    { type: 'response.output_text.delta', delta: 'C' }, DONE,
  ]);
  assert.deepEqual(runsOf(turn), [['A', 0], ['B', 1], ['C', 2]]);
});

test('deltas with no call between them are ONE run, not one per delta', async () => {
  // They open one block on the wire, so they are one block in the body: a run
  // per delta would report as many text blocks as the backend chose to chunk.
  const turn = await turnFor([
    CREATED, { type: 'response.output_text.delta', delta: 'A' },
    { type: 'response.output_text.delta', delta: 'B' },
    callAdded(1, 1), callDone(1, 1),
    { type: 'response.output_text.delta', delta: 'C' },
    { type: 'response.output_text.delta', delta: 'D' }, DONE,
  ]);
  assert.deepEqual(runsOf(turn), [['AB', 0], ['CD', 1]]);
});

test('a forced call cut off at the output limit keeps its fragment verbatim (r18-fable F7)', async () => {
  // The direct Responses API delivers the fragment under `status: incomplete`
  // (measured 2026-09-04); wrapping it as `{"input": …}` published an object
  // the model never produced.
  const events = (terminal) => [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: '{"city":"Seo' },
    terminal,
  ];
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse(events({
    type: 'response.incomplete',
    response: { id: 'r', model: 'gpt-5.5', output: [], incomplete_details: { reason: 'max_output_tokens' } },
  })), { status: 200 });
  const cut = await new CodexBackendTransport({ codexHome, timeoutMs: 30_000 }).generate({ ...toolRequest(), stream: false });
  assert.equal(cut.stopReason, 'max_tokens');
  assert.equal(cut.toolCalls[0].arguments, '{"city":"Seo');
  // CONTROL: a turn the backend reports as completed keeps its bytes too —
  // this transport has no completion backstop (matrix §7 row 8 is scoped to
  // `claude` and `app-server`); the direct API delivers what the model wrote,
  // and wrapping it as `{"input": …}` published an object the model never
  // produced while the stream had carried the bytes (round 21).
  globalThis.fetch = async () => new Response(sse(events({
    type: 'response.completed',
    response: { id: 'r', model: 'gpt-5.5', output: [] },
  })), { status: 200 });
  const whole = await new CodexBackendTransport({ codexHome, timeoutMs: 30_000 }).generate({ ...toolRequest(), stream: false });
  assert.equal(whole.stopReason, undefined);
  assert.equal(whole.toolCalls[0].arguments, '{"city":"Seo');
});

test('a call whose first frame carried no output_index learns its position from a later one: the finish signal fires when the vendor moves on (r29-fable F1)', async () => {
  // `toolOrdinal` resolved every later frame through the id binding and
  // returned before recording the position, so the call stayed positionless
  // and its finish signal waited for the terminal frame — the Messages block
  // held every later block behind it again (the r27 defect, one input family).
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse([
    { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: '{"city":"Seoul"}' },
    { type: 'response.function_call_arguments.done', output_index: 0, item_id: 'fc_1', arguments: '{"city":"Seoul"}' },
    { type: 'response.output_text.delta', output_index: 1, delta: 'after' },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [] } },
  ]), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });

  const events = [];
  for await (const event of backend.stream(toolRequest())) events.push(event);

  const finished = events.findIndex((event) => event.type === 'tool_call_delta' && event.argumentsDone === true);
  const narration = events.findIndex((event) => event.type === 'text_delta');
  assert.ok(finished >= 0, 'the call was announced finished');
  assert.ok(narration >= 0);
  assert.ok(finished < narration, `finish signal at ${finished} must precede the narration at ${narration}: ${JSON.stringify(events.map((event) => event.type))}`);
});

test('a finish event without its arguments member still names its position: the finished call below it is announced on it (r29-codex)', async () => {
  // alpha finished at 0; beta added at 1; beta's `function_call_arguments.done`
  // arrives WITHOUT `arguments` (the captured absent-member shape). Returning
  // before correlating it lost the event's position, so alpha's finish signal
  // waited for the terminal frame — and on Messages beta's block waited
  // behind alpha's. The vendor is released only after alpha's signal is seen.
  const codexHome = await createCodexHome();
  const encoder = new TextEncoder();
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  globalThis.fetch = async () => new Response(new ReadableStream({
    async pull(controller) {
      if (!pull.first) {
        pull.first = true;
        controller.enqueue(encoder.encode(sse([
          { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'get_weather' } },
          { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_a', delta: '{"city":"Seoul"}' },
          // beta is added while alpha is still open, so nothing releases alpha
          // here; alpha then finishes on its own frame (position 0 proves
          // nothing); beta's value-less finish at position 1 is the first
          // event that does.
          { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc_b', call_id: 'call_b', name: 'get_time' } },
          { type: 'response.function_call_arguments.done', output_index: 0, item_id: 'fc_a', arguments: '{"city":"Seoul"}' },
          { type: 'response.function_call_arguments.done', output_index: 1, item_id: 'fc_b' },
        ])));
        return;
      }
      await released;
      controller.enqueue(encoder.encode(sse([
        { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [] } },
      ])));
      controller.close();
    },
  }), { status: 200 });
  const pull = {};
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });

  const events = [];
  let alphaFinishedBeforeRelease = false;
  let timedOut = false;
  // The fallback release keeps a failing run terminating; a signal that
  // arrives only after it — at the terminal frame — must not count.
  const timer = setTimeout(() => { timedOut = true; release(); }, 2_000);
  for await (const event of backend.stream(withDeclared(toolRequest(), ['get_time']))) {
    events.push(event);
    if (event.type === 'tool_call_delta' && event.id === 'call_a' && event.argumentsDone === true) {
      if (!timedOut) alphaFinishedBeforeRelease = true;
      release();
    }
  }
  clearTimeout(timer);
  assert.ok(alphaFinishedBeforeRelease, `alpha's finish signal must arrive before the terminal frame: ${JSON.stringify(events.map((event) => [event.type, event.id, event.argumentsDone]))}`);
  assert.deepEqual(events.at(-1).result.toolCalls.map((call) => [call.id, call.arguments]), [['call_a', '{"city":"Seoul"}'], ['call_b', '{}']]);
});

// A vendor stream that pauses before its terminal frame: the test releases
// it once the awaited signal is seen, or on a fallback timer (which then
// disqualifies any later signal).
async function releasedAfter(frames, request, awaited) {
  const encoder = new TextEncoder();
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  let first = true;
  globalThis.fetch = async () => new Response(new ReadableStream({
    async pull(controller) {
      if (first) { first = false; controller.enqueue(encoder.encode(sse(frames))); return; }
      await released;
      controller.enqueue(encoder.encode(sse([{ type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [] } }])));
      controller.close();
    },
  }), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome: await createCodexHome(), timeoutMs: 30_000 });
  const events = [];
  let early = false;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; release(); }, 2_000);
  for await (const event of backend.stream(request)) {
    events.push(event);
    if (awaited(event)) { if (!timedOut) early = true; release(); }
  }
  clearTimeout(timer);
  return { events, early };
}

test('a call that learns its position after the vendor moved past it is released on that frame, not at the terminal (r30-codex)', async () => {
  const { events, early } = await releasedAfter([
    { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'get_weather' } },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_a', delta: '{"city":"Seoul"}' },
    { type: 'response.function_call_arguments.done', item_id: 'fc_a', arguments: '{"city":"Seoul"}' },
    { type: 'response.output_text.delta', output_index: 1, delta: 'after' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'get_weather', arguments: '{"city":"Seoul"}' } },
  ], toolRequest(), (event) => event.type === 'tool_call_delta' && event.id === 'call_a' && event.argumentsDone === true);
  assert.ok(early, `finish signal must precede the terminal frame: ${JSON.stringify(events.map((event) => [event.type, event.id, event.argumentsDone]))}`);
});

test('a call that finishes after the vendor moved past it is released on its own finish frame (r30-codex)', async () => {
  const { events, early } = await releasedAfter([
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'get_weather' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_a', delta: '{"city":"Seoul"}' },
    { type: 'response.output_text.delta', output_index: 1, delta: 'after' },
    { type: 'response.function_call_arguments.done', output_index: 0, item_id: 'fc_a', arguments: '{"city":"Seoul"}' },
  ], toolRequest(), (event) => event.type === 'tool_call_delta' && event.id === 'call_a' && event.argumentsDone === true);
  assert.ok(early, `finish signal must precede the terminal frame: ${JSON.stringify(events.map((event) => [event.type, event.id, event.argumentsDone]))}`);
});

test('a call identified by folding a finished holder into it on a delta frame is announced on that frame (r31-fable F1)', async () => {
  // A: `call_id` on an index-less frame, never named. A holder at position 2
  // is named and finished on frames carrying no id. The delta with A's item
  // id at position 2 folds the holder into A — identified and finished in
  // one step. Dropping the delta's bytes must not drop the announcement.
  const { events, early } = await releasedAfter([
    { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_a', call_id: 'call_a' } },
    { type: 'response.output_item.added', output_index: 2, item: { type: 'function_call', name: 'get_weather' } },
    { type: 'response.function_call_arguments.delta', output_index: 2, delta: '{"city":"Seoul"}' },
    { type: 'response.function_call_arguments.done', output_index: 2, arguments: '{"city":"Seoul"}' },
    { type: 'response.function_call_arguments.delta', output_index: 2, item_id: 'fc_a', delta: '' },
  ], toolRequest(), (event) => event.type === 'tool_call_delta' && event.id === 'call_a');
  assert.ok(early, `the call must be announced before the terminal frame: ${JSON.stringify(events.map((event) => [event.type, event.id, event.index, event.argumentsDone]))}`);
  assert.ok(!events.some((event) => event.type === 'tool_call_delta' && event.index < 0), 'no wire index below zero');
  assert.deepEqual(events.at(-1).result.toolCalls.map((call) => [call.id, call.name, call.arguments]), [['call_a', 'get_weather', '{"city":"Seoul"}']]);
});

test('two identifiers that first meet in the completed output fold into the one call the client knows (r31-fable F2)', async () => {
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse([
    { type: 'response.output_item.added', item: { type: 'function_call', call_id: 'call_a', name: 'get_weather' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_a', delta: '{"city":"Seoul"}' },
    { type: 'response.function_call_arguments.done', output_index: 0, item_id: 'fc_a', arguments: '{"city":"Seoul"}' },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [{ type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'get_weather', arguments: '{"city":"Seoul"}' }] } },
  ]), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });
  const events = [];
  for await (const event of backend.stream(toolRequest())) events.push(event);
  assert.deepEqual(events.at(-1).result.toolCalls.map((call) => [call.id, call.name, call.arguments]), [['call_a', 'get_weather', '{"city":"Seoul"}']]);
  const announced = events.filter((event) => event.type === 'tool_call_delta' && event.argumentsDelta === '').map((event) => [event.id, event.index]);
  assert.deepEqual(announced, [['call_a', 0]], JSON.stringify(events.map((event) => [event.type, event.id, event.index, event.argumentsDone])));
  assert.ok(!events.some((event) => event.type === 'tool_call_delta' && event.index < 0), 'no wire index below zero');
});

test('a value-less finish event is the frame a call can learn its position from: released on it once the vendor has moved past (r29-codex, r31-fable F3)', async () => {
  // Every earlier frame of the call carries no position; the narration at 1
  // moved the vendor on, but the call had no position to compare. The
  // value-less `function_call_arguments.done` at 0 is the first frame that
  // places it — returning before correlating it left the call held.
  const { events, early } = await releasedAfter([
    { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'get_weather' } },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_a', delta: '{"city":"Seoul"}' },
    { type: 'response.function_call_arguments.done', item_id: 'fc_a', arguments: '{"city":"Seoul"}' },
    { type: 'response.output_text.delta', output_index: 1, delta: 'after' },
    { type: 'response.function_call_arguments.done', output_index: 0, item_id: 'fc_a' },
  ], toolRequest(), (event) => event.type === 'tool_call_delta' && event.id === 'call_a' && event.argumentsDone === true);
  assert.ok(early, `finish signal must precede the terminal frame: ${JSON.stringify(events.map((event) => [event.type, event.id, event.argumentsDone]))}`);
});

test('a call identified only by the completed output folding a finished holder into it is announced with a real wire index before its finish signal (r31-fable F1)', async () => {
  // A: `call_id` only, index-less, never named live. B: an item id, a name and
  // finished bytes at position 0, no `call_id`. The completed item carries
  // both ids: A survives, absorbs B, and is identified for the first time —
  // at the terminal frame, where no branch announces it. The finish signal
  // must not go out for a call the client was never told about.
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse([
    { type: 'response.output_item.added', item: { type: 'function_call', call_id: 'call_a' } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_b', name: 'get_weather' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_b', delta: '{"city":"Seoul"}' },
    { type: 'response.function_call_arguments.done', output_index: 0, item_id: 'fc_b', arguments: '{"city":"Seoul"}' },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [{ type: 'function_call', id: 'fc_b', call_id: 'call_a', name: 'get_weather', arguments: '{"city":"Seoul"}' }] } },
  ]), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });
  const events = [];
  for await (const event of backend.stream(toolRequest())) events.push(event);
  const tool = events.filter((event) => event.type === 'tool_call_delta').map((event) => [event.id, event.index, event.argumentsDelta ?? null, event.argumentsDone ?? false]);
  assert.ok(!tool.some(([, index]) => index < 0), `no wire index below zero: ${JSON.stringify(tool)}`);
  const announced = tool.findIndex(([id, index, delta]) => id === 'call_a' && index === 0 && delta === '');
  const finished = tool.findIndex(([id, , , done]) => id === 'call_a' && done === true);
  assert.ok(announced >= 0 && finished > announced, `announced before finished: ${JSON.stringify(tool)}`);
  assert.deepEqual(events.at(-1).result.toolCalls.map((call) => [call.id, call.name, call.arguments]), [['call_a', 'get_weather', '{"city":"Seoul"}']]);
});

test('the fold\'s survivor is chosen by the one rule wherever two states meet: a holder the client knows absorbs the item-id half that learns its position, live (r31-codex F3)', async () => {
  // The item-id half's bytes belong to the announced holder the moment the
  // delta places them at its position — not at the terminal frame, where the
  // completed item's fold would join the two anyway. The vendor is paused
  // before the terminal: the bytes must reach the client first.
  const { events, early } = await releasedAfter([
    { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_a', name: 'get_weather' } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'call_a', name: 'get_weather' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_a', delta: '{"city":"Seoul"}' },
  ], toolRequest(), (event) => event.type === 'tool_call_delta' && event.id === 'call_a' && (event.argumentsDelta ?? '').includes('Seoul'));
  assert.ok(early, `the bytes must stream under call_a before the terminal frame: ${JSON.stringify(events.map((event) => [event.type, event.id, event.argumentsDelta]))}`);
  assert.deepEqual(events.filter((event) => event.type === 'tool_call_delta' && event.argumentsDelta === '').map((event) => [event.id, event.index]), [['call_a', 0]]);
  assert.deepEqual(events.at(-1).result.toolCalls.map((call) => [call.id, call.name, call.arguments]), [['call_a', 'get_weather', '{"city":"Seoul"}']]);
});

test('a frame joining a call\'s two halves at two positions is the vendor contradicting its positions: refused (r31-codex F4 folded them and left the other position to its real call; refused since round 45)', async () => {
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse([
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_x', call_id: 'call_a', name: 'get_weather' } },
    // A delta for alpha's item id at position 1 — not alpha's position.
    { type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'fc_a', delta: '{"city":"Seoul"}' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'get_weather', arguments: '{"city":"Seoul"}' } },
    { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc_b', call_id: 'call_b', name: 'get_time' } },
    { type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'fc_b', delta: '{"tz":"KST"}' },
    { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', id: 'fc_b', call_id: 'call_b', name: 'get_time', arguments: '{"tz":"KST"}' } },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [
      { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'get_weather', arguments: '{"city":"Seoul"}' },
      { type: 'function_call', id: 'fc_b', call_id: 'call_b', name: 'get_time', arguments: '{"tz":"KST"}' },
    ] } },
  ]), { status: 200 });
  // The fold across positions moved position 1's bytes under `call_a` at 0.
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });
  await assert.rejects(async () => {
    for await (const event of backend.stream(withDeclared(toolRequest(), ['get_time']))) void event;
  }, /cannot place/);
});

test('an id-less completed item is placed by its position, not by arrival order: reversed arrival does not swap the two calls\' arguments (r31-codex F6)', async () => {
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse([
    { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc_b', call_id: 'call_b', name: 'get_time' } },
    { type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'fc_b', delta: '{' },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'get_weather' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_a', delta: '{' },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [
      { type: 'function_call', name: 'get_weather', arguments: '{"city":"Seoul"}' },
      { type: 'function_call', name: 'get_time', arguments: '{"tz":"KST"}' },
    ] } },
  ]), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });
  const events = [];
  for await (const event of backend.stream(withDeclared(toolRequest(), ['get_time']))) events.push(event);
  const calls = new Map(events.at(-1).result.toolCalls.map((call) => [call.id, [call.name, call.arguments]]));
  assert.deepEqual(calls.get('call_a'), ['get_weather', '{"city":"Seoul"}'], JSON.stringify([...calls]));
  assert.deepEqual(calls.get('call_b'), ['get_time', '{"tz":"KST"}'], JSON.stringify([...calls]));
});

test('one call_id under two completed items is that call listed twice: the r32 fold refuses (r32-codex; refused since round 45 — the second listing resolves to a call already placed)', async () => {
  // The first completed item creates `call_a` at index 0; the second lists
  // `call_a` again at index 1, folding the finished holder in. Rounds 31–44
  // kept this door open as the split identity meeting (announced once, at a
  // real wire index — the r32 finding); it was one `call_id` at two indices.
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse([
    { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc_b', name: 'get_weather' } },
    { type: 'response.function_call_arguments.done', output_index: 1, item_id: 'fc_b', arguments: '{"city":"Seoul"}' },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [
      { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'get_weather' },
      { type: 'function_call', id: 'fc_b', call_id: 'call_a', name: 'get_weather' },
    ] } },
  ]), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });
  await assert.rejects(async () => {
    for await (const event of backend.stream(toolRequest())) void event;
  }, /named two tool calls as one/);
});

test('an anonymous completed item at a position no call holds completes the one standing call no item has placed, not the call a position already placed (r33-fable F1)', async () => {
  // `call_a` was announced index-less and never learned a position; `call_b`
  // holds `#0`. `output[0]` is `call_b` by position, so `output[1]` can only
  // be `call_a` — the dense arrival-order slot booked `call_b` twice.
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse([
    { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'get_weather' } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_b', call_id: 'call_b', name: 'get_time' } },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_a', delta: '{' },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_b', delta: '{' },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [
      { type: 'function_call', arguments: '{"tz":"KST"}' },
      { type: 'function_call', arguments: '{"city":"Seoul"}' },
    ] } },
  ]), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });
  const events = [];
  for await (const event of backend.stream(withDeclared(toolRequest(), ['get_time']))) events.push(event);
  const calls = new Map(events.at(-1).result.toolCalls.map((call) => [call.id, [call.name, call.arguments]]));
  assert.deepEqual(calls.get('call_a'), ['get_weather', '{"city":"Seoul"}'], JSON.stringify([...calls]));
  assert.deepEqual(calls.get('call_b'), ['get_time', '{"tz":"KST"}'], JSON.stringify([...calls]));
});

test('an anonymous completed item is placed by the call holding its position before any count, and the count is judged after every fold the completed output performs (r33-fable F2)', async () => {
  // The anonymous item comes FIRST and the fold (fc_b into call_a) second:
  // judged per item in array order, the count still read three standing
  // calls against two items and discarded the item that completes `call_c`.
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse([
    { type: 'response.output_item.added', item: { type: 'function_call', call_id: 'call_a', name: 'alpha' } },
    { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc_b' } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_c', call_id: 'call_c', name: 'beta' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_c', delta: '{"c' },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [
      { type: 'function_call', arguments: '{"c":3}' },
      { type: 'function_call', id: 'fc_b', call_id: 'call_a', name: 'alpha', arguments: '{"a":1}' },
    ] } },
  ]), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });
  const events = [];
  for await (const event of backend.stream(withDeclared(toolRequest(), ['alpha', 'beta']))) events.push(event);
  const calls = new Map(events.at(-1).result.toolCalls.map((call) => [call.id, [call.name, call.arguments]]));
  assert.deepEqual(calls.get('call_a'), ['alpha', '{"a":1}'], JSON.stringify([...calls]));
  assert.deepEqual(calls.get('call_c'), ['beta', '{"c":3}'], JSON.stringify([...calls]));
});

test('a frame carrying both ids of a call at a position other than the call_id\'s accepted one is the vendor contradicting its positions: refused (r32-codex, the third; refused since round 45)', async () => {
  // `call_a` was added at position 1; the done frame at position 0 says the
  // item there IS `call_a`. Rounds 32–44 folded the two and left position 0
  // to the real call arriving there; the fold moved `call_a` to a second
  // position, and a frame naming a known call elsewhere is refused now.
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse([
    { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', call_id: 'call_a' } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_b', name: 'probe' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_b', delta: '{"b":2}' },
    { type: 'response.function_call_arguments.done', output_index: 0, item_id: 'fc_b', arguments: '{"b":2}' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_b', call_id: 'call_a', name: 'probe' } },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [
      { type: 'function_call', id: 'fc_b', call_id: 'call_a', name: 'probe', arguments: '{"b":2}' },
    ] } },
  ]), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });
  await assert.rejects(async () => {
    for await (const event of backend.stream(withDeclared(toolRequest(), ['probe', 'other']))) void event;
  }, /cannot place/);
});

test('an anonymous completed item at a position a call holds completes that call whatever the two views count; only the count-aligned rest is gated (r33-fable F2)', async () => {
  // Two calls streamed, one completed item: the counts disagree, and the
  // item at `output_index: 0` is still the call holding `#0`.
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse([
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'get_weather' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_a', delta: '{"city' },
    { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc_b', call_id: 'call_b', name: 'get_time' } },
    { type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'fc_b', delta: '{"tz":"KST"}' },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [
      { type: 'function_call', arguments: '{"city":"Seoul"}' },
    ] } },
  ]), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });
  const events = [];
  for await (const event of backend.stream(withDeclared(toolRequest(), ['get_time']))) events.push(event);
  const calls = new Map(events.at(-1).result.toolCalls.map((call) => [call.id, [call.name, call.arguments]]));
  assert.deepEqual(calls.get('call_a'), ['get_weather', '{"city":"Seoul"}'], JSON.stringify([...calls]));
  assert.deepEqual(calls.get('call_b'), ['get_time', '{"tz":"KST"}'], JSON.stringify([...calls]));
});

test('a completed item at a held position completes that call even when the completed output also adds a call the stream never showed (r33-codex F1)', async () => {
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse([
    { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc_b', call_id: 'call_b', name: 'beta' } },
    { type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'fc_b', delta: '{"b":' },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [
      { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'alpha', arguments: '{"a":1}' },
      { type: 'function_call', name: 'beta', arguments: '{"b":2}' },
    ] } },
  ]), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });
  const events = [];
  for await (const event of backend.stream(withDeclared(toolRequest(), ['alpha', 'beta']))) events.push(event);
  const calls = new Map(events.at(-1).result.toolCalls.map((call) => [call.id, [call.name, call.arguments]]));
  assert.deepEqual(calls.get('call_a'), ['alpha', '{"a":1}'], JSON.stringify([...calls]));
  assert.deepEqual(calls.get('call_b'), ['beta', '{"b":2}'], JSON.stringify([...calls]));
});

test('the count-aligned rest never takes a call a position placed: a positioned call announced first, an index-less one second (r33-codex F2)', async () => {
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse([
    { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc_b', call_id: 'call_b', name: 'beta' } },
    { type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'fc_b', delta: '{' },
    { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'alpha' } },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_a', delta: '{' },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [
      { type: 'function_call', name: 'alpha', arguments: '{"a":1}' },
      { type: 'function_call', name: 'beta', arguments: '{"b":2}' },
    ] } },
  ]), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });
  const events = [];
  for await (const event of backend.stream(withDeclared(toolRequest(), ['alpha', 'beta']))) events.push(event);
  const calls = new Map(events.at(-1).result.toolCalls.map((call) => [call.id, [call.name, call.arguments]]));
  assert.deepEqual(calls.get('call_a'), ['alpha', '{"a":1}'], JSON.stringify([...calls]));
  assert.deepEqual(calls.get('call_b'), ['beta', '{"b":2}'], JSON.stringify([...calls]));
});

test('an item-id half at a later position joined to the cut call at 0 is the vendor contradicting its positions: refused (r33-codex F3 folded it without counting its position as progress; refused since round 45)', async () => {
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse([
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'alpha' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_a', delta: '{"a":' },
    { type: 'response.function_call_arguments.done', output_index: 0, item_id: 'fc_a', arguments: '{"a":' },
    { type: 'response.output_item.added', output_index: 9, item: { type: 'function_call', id: 'fc_shadow', name: 'alpha' } },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_shadow', call_id: 'call_a', name: 'alpha', arguments: '{"a":' } },
    { type: 'response.incomplete', response: { id: 'r', model: 'gpt-5.5', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [
      { type: 'function_call', id: 'fc_shadow', call_id: 'call_a', name: 'alpha', arguments: '{"a":' },
    ] } },
  ]), { status: 200 });
  // Two accepted positions, one call: the fold is refused before progress
  // or the cut call's block is in question.
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });
  await assert.rejects(async () => {
    for await (const event of backend.stream(withDeclared(toolRequest(), ['alpha', 'beta']))) void event;
  }, /cannot place/);
});

test('an anonymous item before the item whose fold settles the count is judged after that fold, whatever the split halves\' positions (r33-codex F4)', async () => {
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse([
    { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_c', call_id: 'call_c', name: 'beta' } },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_c', delta: '{"c":' },
    { type: 'response.output_item.added', item: { type: 'function_call', call_id: 'call_a' } },
    { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc_a', name: 'alpha' } },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [
      { type: 'function_call', name: 'beta', arguments: '{"c":3}' },
      { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'alpha', arguments: '{"a":1}' },
    ] } },
  ]), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });
  const events = [];
  for await (const event of backend.stream(withDeclared(toolRequest(), ['alpha', 'beta']))) events.push(event);
  const calls = new Map(events.at(-1).result.toolCalls.map((call) => [call.id, [call.name, call.arguments]]));
  assert.deepEqual(calls.get('call_a'), ['alpha', '{"a":1}'], JSON.stringify([...calls]));
  assert.deepEqual(calls.get('call_c'), ['beta', '{"c":3}'], JSON.stringify([...calls]));
});

test('the count-aligned rest never takes the survivor an earlier item folded and placed, even when that call\'s completed value is empty (r33-codex F5)', async () => {
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse([
    { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_a', name: 'alpha' } },
    { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_b', call_id: 'call_b', name: 'beta' } },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_b', delta: '{' },
    { type: 'response.output_item.added', item: { type: 'function_call', call_id: 'call_a', name: 'alpha' } },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [
      { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'alpha', arguments: '' },
      { type: 'function_call', name: 'beta', arguments: '{"b":2}' },
    ] } },
  ]), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });
  const events = [];
  for await (const event of backend.stream(withDeclared(toolRequest(), ['alpha', 'beta']))) events.push(event);
  const calls = new Map(events.at(-1).result.toolCalls.map((call) => [call.id, [call.name, call.arguments]]));
  assert.deepEqual(calls.get('call_b'), ['beta', '{"b":2}'], JSON.stringify([...calls]));
  assert.notDeepEqual(calls.get('call_a')?.[1], '{"b":2}', JSON.stringify([...calls]));
});

test('the count-aligned rest is judged on what is left: an item that adds a call the stream never showed does not outnumber the one index-less call the anonymous item completes (r34-fable F1)', async () => {
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse([
    { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_b', call_id: 'call_b', name: 'beta' } },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_b', delta: '{' },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [
      { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'alpha', arguments: '{"a":1}' },
      { type: 'function_call', name: 'beta', arguments: '{"b":2}' },
    ] } },
  ]), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });
  const events = [];
  for await (const event of backend.stream(withDeclared(toolRequest(), ['alpha', 'beta']))) events.push(event);
  const calls = new Map(events.at(-1).result.toolCalls.map((call) => [call.id, [call.name, call.arguments]]));
  assert.deepEqual(calls.get('call_a'), ['alpha', '{"a":1}'], JSON.stringify([...calls]));
  assert.deepEqual(calls.get('call_b'), ['beta', '{"b":2}'], JSON.stringify([...calls]));
});

test('an anonymous completed item no position places and no remainder pairs is a call without an identity: refused, not dropped under a 200 (r34-codex)', async () => {
  // One index-less streamed call, two anonymous completed items: which call
  // either completes is not knowable, and the runtime wrote two calls.
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse([
    { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'alpha' } },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_a', delta: '{"a":1}' },
    { type: 'response.function_call_arguments.done', item_id: 'fc_a', arguments: '{"a":1}' },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [
      { type: 'function_call', arguments: '{"dropped":1}' },
      { type: 'function_call', arguments: '{"dropped":2}' },
    ] } },
  ]), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });
  await assert.rejects(async () => {
    for await (const event of backend.stream(withDeclared(toolRequest(), ['alpha', 'beta']))) void event;
  }, /missing its call_id/);
});

test('two anonymous completed items against two index-less streamed calls are not paired by arrival order: behind a shared `{` the pairing is a guess, and each is refused as a call without an identity (r35-codex)', async () => {
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse([
    { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'alpha' } },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_a', delta: '{' },
    { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_b', call_id: 'call_b', name: 'beta' } },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_b', delta: '{' },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [
      { type: 'function_call', name: 'beta', arguments: '{"b":2}' },
      { type: 'function_call', name: 'alpha', arguments: '{"a":1}' },
    ] } },
  ]), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });
  await assert.rejects(async () => {
    for await (const event of backend.stream(withDeclared(toolRequest(), ['alpha', 'beta']))) void event;
  }, /missing its call_id/);
});

test('the one remaining pair still needs the names to agree: an anonymous item naming another tool than the one index-less call left is a call without an identity (r35-codex)', async () => {
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse([
    { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'alpha' } },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_a', delta: '{' },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [
      { type: 'function_call', name: 'beta', arguments: '{"b":2}' },
    ] } },
  ]), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });
  await assert.rejects(async () => {
    for await (const event of backend.stream(withDeclared(toolRequest(), ['alpha', 'beta']))) void event;
  }, /missing its call_id/);
});

test('an anonymous item at a held position naming another tool than the call there is two calls named as one: refused (r35-codex kept it out; r41-codex)', async () => {
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse([
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'alpha' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_a', delta: '{' },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [
      { type: 'function_call', name: 'beta', arguments: '{"b":2}' },
    ] } },
  ]), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });
  await assert.rejects(async () => {
    for await (const event of backend.stream(withDeclared(toolRequest(), ['alpha', 'beta']))) void event;
  }, /named two tool calls as one/);
});

test('a call_id spelled like a position key names nothing but itself: `#0` is a second call, not the holder of position 0 (r35-codex)', async () => {
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse([
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'alpha' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_a', delta: '{"a":1}' },
    { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_b', call_id: '#0', name: 'beta' } },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_b', delta: '{"b":2}' },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [
      { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'alpha', arguments: '{"a":1}' },
      { type: 'function_call', id: 'fc_b', call_id: '#0', name: 'beta', arguments: '{"b":2}' },
    ] } },
  ]), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });
  const events = [];
  for await (const event of backend.stream(withDeclared(toolRequest(), ['alpha', 'beta']))) events.push(event);
  const calls = new Map(events.at(-1).result.toolCalls.map((call) => [call.id, [call.name, call.arguments]]));
  assert.deepEqual(calls.get('call_a'), ['alpha', '{"a":1}'], JSON.stringify([...calls]));
  assert.deepEqual(calls.get('#0'), ['beta', '{"b":2}'], JSON.stringify([...calls]));
});

test('item ids and call ids are two namespaces: a spelling shared between one call\'s item id and another\'s call_id binds nothing across them (r35-codex)', async () => {
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse([
    { type: 'response.output_item.added', item: { type: 'function_call', id: 'shared', call_id: 'call_a', name: 'alpha' } },
    { type: 'response.function_call_arguments.delta', item_id: 'shared', delta: '{"a":1}' },
    { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_b', call_id: 'shared', name: 'beta' } },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_b', delta: '{"b":2}' },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [
      { type: 'function_call', id: 'shared', call_id: 'call_a', name: 'alpha', arguments: '{"a":1}' },
      { type: 'function_call', id: 'fc_b', call_id: 'shared', name: 'beta', arguments: '{"b":2}' },
    ] } },
  ]), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });
  const events = [];
  for await (const event of backend.stream(withDeclared(toolRequest(), ['alpha', 'beta']))) events.push(event);
  const calls = new Map(events.at(-1).result.toolCalls.map((call) => [call.id, [call.name, call.arguments]]));
  assert.deepEqual(calls.get('call_a'), ['alpha', '{"a":1}'], JSON.stringify([...calls]));
  assert.deepEqual(calls.get('shared'), ['beta', '{"b":2}'], JSON.stringify([...calls]));
});

test('the completed output cannot move a known call to another position: refused as arguments the transport cannot place (r36-codex, r41-codex)', async () => {
  // `call_a` accepted position 0 live; the completed output lists it at
  // index 1, where anonymous deltas had streamed. Adopting that holder handed
  // `call_a` the position-1 arguments under a 200.
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse([
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'alpha' } },
    { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"belongs":"position-1"}' },
    { type: 'response.function_call_arguments.done', output_index: 1, arguments: '{"belongs":"position-1"}' },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [
      { type: 'message', role: 'assistant', content: [] },
      { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'alpha', arguments: '{"belongs":"position-1"}' },
    ] } },
  ]), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });
  await assert.rejects(async () => {
    for await (const event of backend.stream(withDeclared(toolRequest(), ['alpha', 'beta']))) void event;
  }, /cannot place/);
});

test('the one remaining pair keeps the call at its accepted position: the one item at another index is not that call, refused (r37-fable)', async () => {
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse([
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'alpha' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_a', delta: '{' },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [
      { type: 'message', role: 'assistant', content: [] },
      { type: 'function_call', arguments: '{"evil":1}' },
    ] } },
  ]), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });
  await assert.rejects(async () => {
    for await (const event of backend.stream(withDeclared(toolRequest(), ['alpha', 'beta']))) void event;
  }, /missing its call_id/);
});

test('a call known by id does not adopt a holder of another name: the two are two calls, refused (r37-codex)', async () => {
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse([
    { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'alpha' } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', name: 'beta' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"belongs":"beta"}' },
    { type: 'response.function_call_arguments.done', output_index: 0, arguments: '{"belongs":"beta"}' },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_a', delta: '' },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [
      { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'alpha', arguments: '{"a":1}' },
    ] } },
  ]), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });
  await assert.rejects(async () => {
    for await (const event of backend.stream(withDeclared(toolRequest(), ['alpha', 'beta']))) void event;
  }, /named two tool calls as one/);
});

test('an identified event at a position held by a state of another name is refused before that holder\'s bytes go out under the new name (r37-codex)', async () => {
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse([
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', name: 'beta' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"belongs":"beta"}' },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'alpha' } },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [
      { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'alpha', arguments: '{"belongs":"beta"}' },
    ] } },
  ]), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });
  const events = [];
  await assert.rejects(async () => {
    for await (const event of backend.stream(withDeclared(toolRequest(), ['alpha', 'beta']))) events.push(event);
  }, /named two tool calls as one/);
  assert.equal(events.filter((event) => event.type === 'tool_call_delta').length, 0, 'nothing announced before the refusal');
});

test('a split identity whose halves carry different names does not fold: two calls named as one, refused (r37-codex)', async () => {
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse([
    { type: 'response.output_item.added', item: { type: 'function_call', call_id: 'call_a', name: 'alpha' } },
    { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc_b', name: 'beta' } },
    { type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'fc_b', delta: '{"b":2}' },
    { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', id: 'fc_b', call_id: 'call_a', name: 'alpha', arguments: '{"b":2}' } },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [
      { type: 'function_call', id: 'fc_b', call_id: 'call_a', name: 'alpha', arguments: '{"b":2}' },
    ] } },
  ]), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });
  await assert.rejects(async () => {
    for await (const event of backend.stream(withDeclared(toolRequest(), ['alpha', 'beta']))) void event;
  }, /named two tool calls as one/);
});

test('a call_id the completed output supplies names the call from then on: a second item carrying it is the call listed twice, refused — not a second call under the same id (r37-codex)', async () => {
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse([
    { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_a', name: 'alpha' } },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_a', delta: '{' },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [
      { type: 'function_call', id: 'fc_a', call_id: 'alias_a', name: 'alpha', arguments: '{"a":1}' },
      { type: 'function_call', id: 'fc_alias', call_id: 'alias_a', name: 'alpha', arguments: '{"a":1}' },
    ] } },
  ]), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });
  await assert.rejects(async () => {
    for await (const event of backend.stream(withDeclared(toolRequest(), ['alpha']))) void event;
  }, /named two tool calls as one/);
});

test('two nameless anonymous items against two index-less streamed calls are not paired by arrival order either: refused (r39-fable)', async () => {
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse([
    { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'alpha' } },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_a', delta: '{' },
    { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_b', call_id: 'call_b', name: 'beta' } },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_b', delta: '{' },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [
      { type: 'function_call', arguments: '{"b":2}' },
      { type: 'function_call', arguments: '{"a":1}' },
    ] } },
  ]), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });
  await assert.rejects(async () => {
    for await (const event of backend.stream(withDeclared(toolRequest(), ['alpha', 'beta']))) void event;
  }, /missing its call_id/);
});

test('a second listing folding a byteless state in under another value is refused — as every second listing is since round 45 (r39-fable: the fold door then passed only the call\'s own value)', async () => {
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse([
    { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_a', name: 'alpha' } },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [
      { type: 'function_call', id: 'fc_x', call_id: 'call_a', name: 'alpha', arguments: '{"a":1}' },
      { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'alpha', arguments: '{"evil":1}' },
    ] } },
  ]), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });
  await assert.rejects(async () => {
    for await (const event of backend.stream(withDeclared(toolRequest(), ['alpha']))) void event;
  }, /named two tool calls as one/);
});

test('an item at a held position naming another tool than the anonymous holder there is two calls named as one (r39-fable: the dense slot re-adopted the holder the name door declined; since round 45 the holder at the item\'s index is the one door, and it refuses)', async () => {
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse([
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', name: 'beta' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"belongs":"beta"}' },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [
      { type: 'function_call', id: 'fc_x', call_id: 'call_x', name: 'alpha', arguments: '{"belongs":"beta"}' },
    ] } },
  ]), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });
  await assert.rejects(async () => {
    for await (const event of backend.stream(withDeclared(toolRequest(), ['alpha', 'beta']))) void event;
  }, /named two tool calls as one/);
});

test('a call once named keeps that name before its announcement too: a later frame naming another tool for the same item is the vendor contradicting itself, refused (r39-fable, r39-codex)', async () => {
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse([
    { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_a', name: 'alpha' } },
    { type: 'response.output_item.done', item: { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'beta', arguments: '{"a":1}' } },
    // The completed output agrees with the FIRST name, so only the live
    // door can refuse this turn.
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [
      { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'alpha', arguments: '{"a":1}' },
    ] } },
  ]), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });
  await assert.rejects(async () => {
    for await (const event of backend.stream(withDeclared(toolRequest(), ['alpha', 'beta']))) void event;
  }, /named two tool calls as one/);
});

test('a completed item naming another tool for a known call is refused, not its arguments delivered under the announced name (r39-codex)', async () => {
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse([
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'alpha' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_a', delta: '{' },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [
      { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'beta', arguments: '{"belongs":"beta"}' },
    ] } },
  ]), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });
  await assert.rejects(async () => {
    for await (const event of backend.stream(withDeclared(toolRequest(), ['alpha', 'beta']))) void event;
  }, /named two tool calls as one/);
});

test('a known call listed at an index other than its accepted position is the vendor contradicting its own positions: refused as arguments the transport cannot place (r39-codex, r41-codex)', async () => {
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse([
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'alpha' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_a', delta: '{' },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [
      { type: 'message', role: 'assistant', content: [] },
      { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'alpha', arguments: '{"a":1}' },
    ] } },
  ]), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });
  await assert.rejects(async () => {
    for await (const event of backend.stream(withDeclared(toolRequest(), ['alpha']))) void event;
  }, /cannot place/);
});

test('a holder at position 1 is not the completed item at index 0: the item is a call of its own and the holder is refused at completion as a call missing its identity (r39-codex: the dense slot adopted position 1\'s bytes for the item at index 0; the slot is gone since round 45)', async () => {
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse([
    { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', name: 'alpha' } },
    { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"position":1}' },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [
      { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'alpha', arguments: '{"position":1}' },
    ] } },
  ]), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });
  await assert.rejects(async () => {
    for await (const event of backend.stream(withDeclared(toolRequest(), ['alpha']))) void event;
  }, /missing its call_id/);
});

test('the fold door takes exactly the value the call already holds: a second listing extending the first is another value, refused (r39-codex)', async () => {
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse([
    { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_b', name: 'alpha' } },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [
      { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'alpha', arguments: '{"a' },
      { type: 'function_call', id: 'fc_b', call_id: 'call_a', name: 'alpha', arguments: '{"a":1}' },
    ] } },
  ]), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });
  await assert.rejects(async () => {
    for await (const event of backend.stream(withDeclared(toolRequest(), ['alpha']))) void event;
  }, /named two tool calls as one/);
});

test('the listed-twice gate follows the fold\'s survivor: a first listing placed on a state a later item folds away still counts (r40-fable)', async () => {
  // The first listing places the item-id-only state `fc_b` (absorbable);
  // the second folds it into the announced `call_a` and carries another
  // value. Tracked by ordinal, the gate missed the survivor.
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse([
    // `call_a` announced index-less; the holder `fc_b` at position 1. The
    // completed array keeps the live positions: a reasoning item at 0, the
    // holder's own listing at 1, and the fold item after it.
    { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'alpha' } },
    { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc_b', name: 'alpha' } },
    { type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'fc_b', delta: '{"evil":1}' },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [
      { type: 'reasoning', id: 'rs' },
      { type: 'function_call', id: 'fc_b', name: 'alpha', arguments: '{"evil":1}' },
      { type: 'function_call', id: 'fc_b', call_id: 'call_a', name: 'alpha', arguments: '{"z":9}' },
    ] } },
  ]), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });
  await assert.rejects(async () => {
    for await (const event of backend.stream(withDeclared(toolRequest(), ['alpha']))) void event;
  }, /named two tool calls as one/);
});

test('a repeated output_item.added renaming a call before its announcement is refused at the known door (r40-fable coverage)', async () => {
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse([
    { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_a', name: 'alpha' } },
    { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'beta' } },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [
      { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'alpha', arguments: '{}' },
    ] } },
  ]), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });
  await assert.rejects(async () => {
    for await (const event of backend.stream(withDeclared(toolRequest(), ['alpha', 'beta']))) void event;
  }, /named two tool calls as one/);
});

test('the name is heard on the fold\'s survivor: an unnamed call adopting a holder of another name past a frame naming a third is refused, live (r42-fable)', async () => {
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse([
    { type: 'response.output_item.added', item: { type: 'function_call', call_id: 'call_a' } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', name: 'beta' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"b":2}' },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'alpha' } },
    // The completed output agrees with the name the survivor would wrongly
    // take (`beta`), so only the live door can refuse this turn.
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [
      { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'beta', arguments: '{"b":2}' },
    ] } },
  ]), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });
  await assert.rejects(async () => {
    for await (const event of backend.stream(withDeclared(toolRequest(), ['alpha', 'beta']))) void event;
  }, /named two tool calls as one/);
});

test('the name is heard on the fold\'s survivor: a completed item naming alpha for an unnamed call at a beta holder\'s position is refused (r42-fable)', async () => {
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse([
    { type: 'response.output_item.added', item: { type: 'function_call', call_id: 'call_a' } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', name: 'beta' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"b":2}' },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [
      { type: 'function_call', call_id: 'call_a', name: 'alpha', arguments: '{"b":2}' },
    ] } },
  ]), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });
  await assert.rejects(async () => {
    for await (const event of backend.stream(withDeclared(toolRequest(), ['alpha', 'beta']))) void event;
  }, /named two tool calls as one/);
});

test('a second listing folding the holder in is that call listed twice, own value or not: refused (r42-fable kept the own-value meeting open; refused since round 45)', async () => {
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse([
    { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc_b', name: 'alpha' } },
    { type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'fc_b', delta: '{"e":1}' },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [
      { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'alpha' },
      { type: 'function_call', id: 'fc_b', call_id: 'call_a', name: 'alpha', arguments: '{"e":1}' },
    ] } },
  ]), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });
  await assert.rejects(async () => {
    for await (const event of backend.stream(withDeclared(toolRequest(), ['alpha']))) void event;
  }, /named two tool calls as one/);
});




test('a name-bearing frame joining a fold\'s survivor that owns the call_id does not put its item id where the call_id stood (r43-codex)', async () => {
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse([
    // The holder at 0 owns `call_h` and no name (non-absorbable); `fc_a` is
    // known by its item id alone (absorbable); the frame naming `alpha` at 0
    // joins the two. The survivor is the holder — and the client echoes
    // `call_h`, not the frame's item id.
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'call_h' } },
    { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_a' } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_a', name: 'alpha' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_a', delta: '{"h":1}' },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [
      { type: 'function_call', id: 'fc_a', call_id: 'call_h', name: 'alpha', arguments: '{"h":1}' },
    ] } },
  ]), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });
  const events = [];
  for await (const event of backend.stream(withDeclared(toolRequest(), ['alpha']))) events.push(event);
  const announced = [...new Set(events.filter((event) => event.type === 'tool_call_delta').map((event) => event.id))];
  assert.deepEqual(announced, ['call_h']);
  assert.deepEqual(events.at(-1).result.toolCalls.map((call) => [call.id, call.name, call.arguments]), [['call_h', 'alpha', '{"h":1}']]);
});


test('the call_id latch is heard at the position-resolved door: a frame at an announced call\'s position naming another call_id is refused, not ratified under the latched id (r45-fable)', async () => {
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse([
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'call_h', name: 'alpha' } },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'call_x', name: 'alpha', arguments: '{"x":1}' } },
    // The completed output agrees with the latched id, so only the live door
    // hears the contradiction.
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [
      { type: 'function_call', call_id: 'call_h', name: 'alpha', arguments: '{"x":1}' },
    ] } },
  ]), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });
  await assert.rejects(async () => {
    for await (const event of backend.stream(withDeclared(toolRequest(), ['alpha']))) void event;
  }, /named two tool calls as one/);
});

test('...and before the announcement: a second frame at the position carrying another call_id does not replace the first (r45-fable)', async () => {
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse([
    // `call_h` at 0 without a name: not announced yet. The second frame at 0
    // says `call_x` — the completed output agrees with IT, so a door that
    // let it through would deliver `call_x` under a 200.
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'call_h' } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'call_x', name: 'alpha' } },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [
      { type: 'function_call', call_id: 'call_x', name: 'alpha', arguments: '{}' },
    ] } },
  ]), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });
  await assert.rejects(async () => {
    for await (const event of backend.stream(withDeclared(toolRequest(), ['alpha']))) void event;
  }, /named two tool calls as one/);
});



test('a live frame naming a known call at another position is the vendor contradicting its positions: refused as arguments the transport cannot place, not delivered (r45-codex)', async () => {
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse([
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'alpha' } },
    { type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'fc_a', delta: '{"from":1}' },
    { type: 'response.function_call_arguments.done', output_index: 1, item_id: 'fc_a', arguments: '{"from":1}' },
    // The completed output is coherent with the announcement, so only the
    // live door hears the contradiction.
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [
      { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'alpha', arguments: '{"from":1}' },
    ] } },
  ]), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });
  await assert.rejects(async () => {
    for await (const event of backend.stream(withDeclared(toolRequest(), ['alpha']))) void event;
  }, /cannot place/);
});

test('a completed item at a held position carrying another call_id is two calls named as one, not a second call at the one position (r45-codex)', async () => {
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse([
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_a', call_id: 'call_first', name: 'alpha' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_a', delta: '{"first":1}' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_a', call_id: 'call_first', name: 'alpha', arguments: '{"first":1}' } },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [
      { type: 'function_call', call_id: 'call_late', name: 'alpha', arguments: '{"late":2}' },
    ] } },
  ]), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });
  await assert.rejects(async () => {
    for await (const event of backend.stream(withDeclared(toolRequest(), ['alpha']))) void event;
  }, /named two tool calls as one/);
});

test('a completed item at a held position carrying only an item id binds to the call holding it, as the live frame does: one call under the latched call_id (r45-codex)', async () => {
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse([
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'call_a', name: 'alpha' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"x":1}' },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [
      { type: 'function_call', id: 'fc_a', name: 'alpha', arguments: '{"x":1}' },
    ] } },
  ]), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });
  const events = [];
  for await (const event of backend.stream(withDeclared(toolRequest(), ['alpha']))) events.push(event);
  assert.deepEqual(events.at(-1).result.toolCalls.map((call) => [call.id, call.name, call.arguments]), [['call_a', 'alpha', '{"x":1}']]);
});

test('a second listing of a created call\'s call_id at another index, folding a byte-bearing holder in with no value, is that call listed twice — it moved the call across the array (r45-codex)', async () => {
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse([
    { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc_b', name: 'alpha' } },
    { type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'fc_b', delta: '{"held":1}' },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [
      { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'alpha' },
      { type: 'function_call', id: 'fc_b', call_id: 'call_a', name: 'alpha' },
    ] } },
  ]), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });
  await assert.rejects(async () => {
    for await (const event of backend.stream(withDeclared(toolRequest(), ['alpha']))) void event;
  }, /named two tool calls as one/);
});

test('a frame joining two states at two accepted positions is the vendor contradicting its positions: refused, not the retired position\'s bytes moved under the survivor (r45-codex, known survives)', async () => {
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse([
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'call_a', name: 'alpha' } },
    { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc_b' } },
    { type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'fc_b', delta: '{"from":1}' },
    // At the survivor's own position, so the position door hears nothing;
    // the fold itself must.
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_b', call_id: 'call_a', name: 'alpha', arguments: '{"from":1}' } },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [
      { type: 'function_call', id: 'fc_b', call_id: 'call_a', name: 'alpha', arguments: '{"from":1}' },
    ] } },
  ]), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });
  await assert.rejects(async () => {
    for await (const event of backend.stream(withDeclared(toolRequest(), ['alpha']))) void event;
  }, /cannot place/);
});

test('...and with the holder surviving: a call_id holder at 1 joined to an item-id state at 0 is refused the same way (r45-codex, holder survives)', async () => {
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse([
    { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', call_id: 'call_h', name: 'alpha' } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_a' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_a', delta: '{"from":0}' },
    { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', id: 'fc_a', call_id: 'call_h', name: 'alpha', arguments: '{"from":0}' } },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [
      { type: 'function_call', id: 'fc_a', call_id: 'call_h', name: 'alpha', arguments: '{"from":0}' },
    ] } },
  ]), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });
  await assert.rejects(async () => {
    for await (const event of backend.stream(withDeclared(toolRequest(), ['alpha']))) void event;
  }, /cannot place/);
});

test('two calls the client knows at one position are two items at one index: a live frame placing an index-less announced call at a position another announced call holds is refused, not two calls delivered (r46-codex)', async () => {
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse([
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_b', call_id: 'call_b', name: 'beta' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_b', delta: '{"b":2}' },
    { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'alpha' } },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_a', delta: '{"a":1}' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'alpha', arguments: '{"a":1}' } },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [] } },
  ]), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });
  await assert.rejects(async () => {
    for await (const event of backend.stream(withDeclared(toolRequest(), ['alpha', 'beta']))) void event;
  }, /cannot place/);
});

test('...and from the completed output: the index-less announced call listed at the index another announced call holds is refused the same way (r46-codex)', async () => {
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse([
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_b', call_id: 'call_b', name: 'beta' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_b', delta: '{"b":2}' },
    { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'alpha' } },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_a', delta: '{"a":1}' },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [
      { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'alpha', arguments: '{"a":1}' },
    ] } },
  ]), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });
  await assert.rejects(async () => {
    for await (const event of backend.stream(withDeclared(toolRequest(), ['alpha', 'beta']))) void event;
  }, /cannot place/);
});

test('the first call_id is latched like the name: a live frame naming another call_id for the same item is refused (r41-codex)', async () => {
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse([
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'alpha' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_a', delta: '{"same":1}' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_a', call_id: 'call_b', name: 'alpha', arguments: '{"same":1}' } },
    // The completed output agrees with the latched id, so only the live door
    // hears the contradiction (a mutant there must not be caught at the
    // completed door instead).
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [
      { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'alpha', arguments: '{"same":1}' },
    ] } },
  ]), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });
  await assert.rejects(async () => {
    for await (const event of backend.stream(withDeclared(toolRequest(), ['alpha']))) void event;
  }, /named two tool calls as one/);
});

test('the first call_id is latched like the name: a completed item naming another call_id for the same item is refused, not kept on the announced id (r41-codex)', async () => {
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse([
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'alpha' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_a', delta: '{"same":1}' },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [
      { type: 'function_call', id: 'fc_a', call_id: 'call_b', name: 'alpha', arguments: '{"same":1}' },
    ] } },
  ]), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });
  await assert.rejects(async () => {
    for await (const event of backend.stream(withDeclared(toolRequest(), ['alpha']))) void event;
  }, /named two tool calls as one/);
});
