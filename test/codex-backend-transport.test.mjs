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
  for await (const event of backend.stream(toolRequest())) events.push(event);

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
  for await (const event of backend.stream(toolRequest())) events.push(event);

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
        output: [
          { type: 'function_call', id: 'fc_9', call_id: 'call_9', name: 'get_time', arguments: '{"tz":"KST"}' },
          { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"Seoul"}' },
        ],
      },
    },
  ]), { status: 200 });
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });

  const events = [];
  for await (const event of backend.stream(toolRequest())) events.push(event);

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

  const result = await backend.generate(toolRequest());
  assert.deepEqual(result.toolCalls.map((call) => [call.name, call.arguments]), [['get_time', '{}']]);
});

test('an anonymous completed call cannot rewrite what the stream already delivered', async () => {
  // Position is not identity. With two calls listed in an order the stream did
  // not use, overwriting gave each streamed call the other call's name and
  // arguments under its own id, so a client answered the wrong call.
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

  const events = [];
  for await (const event of backend.stream(toolRequest())) events.push(event);

  assert.deepEqual(
    events.at(-1).result.toolCalls.map((call) => [call.id, call.name, call.arguments]),
    [['call_1', 'get_weather', '{"city":"Seoul"}'], ['call_2', 'get_time', '{"tz":"KST"}']],
  );
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

test('an id-less completed call never overwrites a different streamed call', async () => {
  // When the completed output holds fewer function calls than the stream did,
  // positional alignment would land an anonymous item on whichever streamed
  // call shares its position — replacing that call's name and arguments with
  // another call's payload. A client would then run the wrong tool, twice.
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

  const events = [];
  for await (const event of backend.stream(toolRequest())) events.push(event);

  const toolCalls = events.at(-1).result.toolCalls;
  assert.deepEqual(
    toolCalls.map((call) => [call.id, call.name, call.arguments]),
    [
      ['call_1', 'get_weather', '{"city":"Seoul"}'],
      ['call_2', 'delete_file', '{"path":"/tmp/x"}'],
    ],
  );
});

test('Images requests ignore honorRequestModel: the configured image model runs', async () => {
  // The contract exempts `/v1/images/*` from the switch: the request `model` is
  // an Images route selector (`image-2`), not a Codex slug. Honouring it would
  // send `image-2` where a Codex model belongs. The exemption currently holds by
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
  await backend.generate({ ...imageRequest(), model: 'image-2' });
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, 'gpt-5.5', 'the configured Codex model runs, not the Images route selector');
  assert.notEqual(body.model, 'image-2');
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

// The two tool turns below carry `toolHistory: true` because that is what the
// normalizer sets when it flattens them — this fixture simulates its output, so
// it has to match it. Dropping the flag makes the transport read these as
// ordinary prose, which is the correct behaviour for text a CALLER wrote and the
// wrong behaviour for a turn this proxy flattened itself.
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
        toolHistory: true,
      },
      {
        role: 'tool',
        content: [
          '[tool result]',
          'tool_call_id: call_weather',
          '{"city":"Seoul","temperature_c":23,"condition":"clear"}',
        ].join('\n'),
        images: [],
        toolHistory: true,
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
