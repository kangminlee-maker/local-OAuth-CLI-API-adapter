#!/usr/bin/env node
import { ClaudeCodeBackend } from '../dist/proxy/claude-code-backend.js';
import { CodexAppServerBackend } from '../dist/proxy/codex-app-server-backend.js';
import { startLocalApiProxy } from '../dist/proxy/http-server.js';

const options = parseArgs(process.argv.slice(2));
const runtime = options.runtime ?? 'codex';
const timeoutMs = numberOption(options.timeoutMs, 180_000);
const speedRepeats = numberOption(options.speedRepeats, 0);
const cwd = options.cwd ?? process.cwd();
const backend = runtime === 'claude'
  ? new ClaudeCodeBackend({
      command: options.command,
      cwd,
      model: options.model,
      timeoutMs,
    })
  : new CodexAppServerBackend({
      command: options.command,
      cwd,
      model: options.model,
      timeoutMs,
      reasoningEffort: reasoningEffort(options.reasoningEffort),
    });

const started = await startLocalApiProxy({
  backend,
  host: '127.0.0.1',
  port: 0,
  requestTimeoutMs: timeoutMs,
});

const requestModel = runtime === 'claude'
  ? options.requestModel ?? 'claude-code-cli'
  : options.requestModel ?? backend.model;
const rows = [];

try {
  await runExactSmoke(started.url, requestModel);
  if (speedRepeats > 0) await runSpeedSmoke(started.url, requestModel, speedRepeats);
} finally {
  await started.close();
}

const failed = rows.filter((row) => !row.ok);
console.log(`\nREAL_SMOKE_SUMMARY ${JSON.stringify({
  runtime,
  model: requestModel,
  passed: rows.length - failed.length,
  failed: failed.length,
  rows,
}, null, 2)}`);
process.exit(failed.length > 0 ? 1 : 0);

async function runExactSmoke(baseUrl, model) {
  await run('models', async () => {
    const startedAt = performance.now();
    const res = await fetch(`${baseUrl}/v1/models`, { signal: AbortSignal.timeout(10_000) });
    const body = await res.json();
    assert(res.ok, `models failed with ${res.status}`);
    assert(typeof body.data?.[0]?.id === 'string', 'missing model id');
    return { totalMs: elapsed(startedAt), model: body.data[0].id };
  });

  await run('openai_chat_text_exact', async () => {
    const token = tokenFor('CHAT');
    const { body, totalMs } = await postJson(baseUrl, '/v1/chat/completions', {
      model,
      messages: [{ role: 'user', content: exactPrompt(token) }],
    });
    const text = body.choices?.[0]?.message?.content;
    assertEqual(text, token, 'chat content');
    assertEqual(body.choices?.[0]?.finish_reason, 'stop', 'chat finish_reason');
    return { totalMs, text };
  });

  await run('openai_chat_stream_exact', async () => {
    const token = tokenFor('CHAT_STREAM');
    const result = await postSse(baseUrl, '/v1/chat/completions', {
      model,
      stream: true,
      messages: [{ role: 'user', content: exactPrompt(token) }],
    }, (event, payload) => payload?.choices?.[0]?.delta?.content ?? '');
    assertEqual(result.text, token, 'chat stream text');
    assert(result.done, 'chat stream missing DONE');
    return result;
  });

  await run('openai_chat_json_exact', async () => {
    const { body, totalMs } = await postJson(baseUrl, '/v1/chat/completions', {
      model,
      messages: [{
        role: 'user',
        content: 'Return JSON with adapter exactly "local-oauth-cli" and ok exactly true.',
      }],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'adapter_exactness',
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              adapter: { type: 'string' },
              ok: { type: 'boolean' },
            },
            required: ['adapter', 'ok'],
          },
        },
      },
    });
    const parsed = parseJson(body.choices?.[0]?.message?.content, 'chat json content');
    assertEqual(parsed.adapter, 'local-oauth-cli', 'json adapter');
    assertEqual(parsed.ok, true, 'json ok');
    return { totalMs, parsed };
  });

  let toolCall;
  await run('openai_chat_tool_call_exact', async () => {
    const { body, totalMs } = await postJson(baseUrl, '/v1/chat/completions', {
      model,
      messages: [{ role: 'user', content: 'Use get_weather for Seoul. Return a tool call only.' }],
      tools: [weatherTool()],
      tool_choice: 'required',
    });
    toolCall = body.choices?.[0]?.message?.tool_calls?.[0];
    assertEqual(body.choices?.[0]?.finish_reason, 'tool_calls', 'tool finish_reason');
    assertEqual(toolCall?.function?.name, 'get_weather', 'tool name');
    const args = parseJson(toolCall?.function?.arguments, 'tool arguments');
    assertEqual(args.city, 'Seoul', 'tool city');
    return { totalMs, id: toolCall.id, toolName: toolCall.function.name, args };
  });

  await run('openai_chat_tool_result_exact', async () => {
    if (!toolCall) throw new Error('tool call did not run');
    const expected = 'WEATHER_RESULT_CITY=Seoul;TEMP_C=23;CONDITION=clear';
    const { body, totalMs } = await postJson(baseUrl, '/v1/chat/completions', {
      model,
      messages: [
        {
          role: 'user',
          content: `Use get_weather, then reply with exactly: ${expected}`,
        },
        { role: 'assistant', content: null, tool_calls: [toolCall] },
        {
          role: 'tool',
          tool_call_id: toolCall.id,
          content: '{"city":"Seoul","temperature_c":23,"condition":"clear"}',
        },
      ],
      tools: [weatherTool()],
      tool_choice: 'auto',
    });
    const text = body.choices?.[0]?.message?.content;
    assertEqual(text, expected, 'tool result follow-up text');
    assertEqual(body.choices?.[0]?.finish_reason, 'stop', 'tool result finish_reason');
    return { totalMs, text };
  });

  await run('openai_responses_text_exact', async () => {
    const token = tokenFor('RESPONSES');
    const { body, totalMs } = await postJson(baseUrl, '/v1/responses', {
      model,
      input: exactPrompt(token),
    });
    assertEqual(body.output_text, token, 'responses output_text');
    return { totalMs, text: body.output_text };
  });

  await run('openai_responses_stream_exact', async () => {
    const token = tokenFor('RESPONSES_STREAM');
    const result = await postSse(baseUrl, '/v1/responses', {
      model,
      stream: true,
      input: exactPrompt(token),
    }, (event, payload) => event === 'response.output_text.delta' ? payload.delta ?? '' : '');
    assertEqual(result.text, token, 'responses stream text');
    assert(result.done, 'responses stream missing DONE');
    return result;
  });

  await run('anthropic_messages_text_exact', async () => {
    const token = tokenFor('ANTHROPIC');
    const { body, totalMs } = await postJson(baseUrl, '/v1/messages', {
      model,
      max_tokens: 64,
      messages: [{ role: 'user', content: exactPrompt(token) }],
    });
    const text = body.content?.[0]?.text;
    assertEqual(text, token, 'anthropic text');
    assertEqual(body.stop_reason, 'end_turn', 'anthropic stop_reason');
    return { totalMs, text };
  });

  await run('anthropic_messages_stream_exact', async () => {
    const token = tokenFor('ANTHROPIC_STREAM');
    const result = await postSse(baseUrl, '/v1/messages', {
      model,
      stream: true,
      max_tokens: 64,
      messages: [{ role: 'user', content: exactPrompt(token) }],
    }, (event, payload) => event === 'content_block_delta' ? payload?.delta?.text ?? '' : '');
    assertEqual(result.text, token, 'anthropic stream text');
    return result;
  });

  await run('anthropic_tool_use_exact', async () => {
    const { body, totalMs } = await postJson(baseUrl, '/v1/messages', {
      model,
      max_tokens: 128,
      messages: [{ role: 'user', content: 'Use get_weather for Seoul. Return a tool call only.' }],
      tools: [{
        name: 'get_weather',
        description: 'Get current weather by city.',
        input_schema: weatherSchema(),
      }],
      tool_choice: { type: 'any' },
    });
    const toolUse = body.content?.[0];
    assertEqual(body.stop_reason, 'tool_use', 'anthropic tool stop_reason');
    assertEqual(toolUse?.type, 'tool_use', 'anthropic content type');
    assertEqual(toolUse?.name, 'get_weather', 'anthropic tool name');
    assertEqual(toolUse?.input?.city, 'Seoul', 'anthropic tool city');
    return { totalMs, toolName: toolUse.name, input: toolUse.input };
  });
}

async function runSpeedSmoke(baseUrl, model, repeats) {
  await runSpeed('speed_chat_nonstream', repeats, async (index) => {
    const token = tokenFor(`SPEED_CHAT_${index}`);
    const { body, totalMs } = await postJson(baseUrl, '/v1/chat/completions', {
      model,
      messages: [{ role: 'user', content: exactPrompt(token) }],
    });
    assertEqual(body.choices?.[0]?.message?.content, token, 'speed chat text');
    return { totalMs };
  });

  await runSpeed('speed_chat_stream', repeats, async (index) => {
    const token = tokenFor(`SPEED_CHAT_STREAM_${index}`);
    const result = await postSse(baseUrl, '/v1/chat/completions', {
      model,
      stream: true,
      messages: [{ role: 'user', content: exactPrompt(token) }],
    }, (event, payload) => payload?.choices?.[0]?.delta?.content ?? '');
    assertEqual(result.text, token, 'speed chat stream text');
    return result;
  });

  await runSpeed('speed_responses_stream', repeats, async (index) => {
    const token = tokenFor(`SPEED_RESPONSES_STREAM_${index}`);
    const result = await postSse(baseUrl, '/v1/responses', {
      model,
      stream: true,
      input: exactPrompt(token),
    }, (event, payload) => event === 'response.output_text.delta' ? payload.delta ?? '' : '');
    assertEqual(result.text, token, 'speed responses stream text');
    return result;
  });
}

async function run(name, fn) {
  try {
    const detail = await fn();
    rows.push({ ok: true, ...detail, name });
    console.log(`PASS ${name}: ${JSON.stringify(detail)}`);
  } catch (err) {
    rows.push({ name, ok: false, error: errorMessage(err) });
    console.log(`FAIL ${name}: ${errorMessage(err)}`);
  }
}

async function runSpeed(name, repeats, fn) {
  const samples = [];
  for (let i = 0; i < repeats; i += 1) {
    const sample = await fn(i + 1);
    samples.push(sample);
    console.log(`SAMPLE ${name} #${i + 1}: ${JSON.stringify(sample)}`);
  }
  const totals = samples.map((sample) => sample.totalMs);
  const firstTexts = samples
    .map((sample) => sample.firstTextMs)
    .filter((value) => typeof value === 'number');
  rows.push({
    name,
    ok: true,
    totalMs: summary(totals),
    ...(firstTexts.length > 0 ? { firstTextMs: summary(firstTexts) } : {}),
    chunks: samples.map((sample) => sample.chunks).filter((value) => typeof value === 'number'),
  });
}

async function postJson(baseUrl, path, body) {
  const startedAt = performance.now();
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  const totalMs = elapsed(startedAt);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  assert(res.ok, `${path} ${res.status}: ${text}`);
  return { body: parsed, totalMs };
}

async function postSse(baseUrl, path, body, collectText) {
  const startedAt = performance.now();
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`${path} ${res.status}: ${await res.text()}`);
  }
  assert(res.body, `${path} did not return a readable stream`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let firstDataMs = null;
  let firstTextMs = null;
  let chunks = 0;
  let text = '';
  let done = false;

  while (true) {
    const read = await reader.read();
    if (read.done) break;
    buffer += decoder.decode(read.value, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const lines = frame.split(/\n/);
      const event = lines.find((line) => line.startsWith('event: '))?.slice(7) ?? 'message';
      const data = lines.find((line) => line.startsWith('data: '))?.slice(6);
      if (!data) continue;
      if (firstDataMs === null) firstDataMs = elapsed(startedAt);
      if (data === '[DONE]') {
        done = true;
        continue;
      }
      let payload;
      try {
        payload = JSON.parse(data);
      } catch {
        continue;
      }
      const delta = collectText(event, payload);
      if (delta) {
        if (firstTextMs === null) firstTextMs = elapsed(startedAt);
        chunks += 1;
        text += delta;
      }
    }
  }

  return {
    totalMs: elapsed(startedAt),
    firstDataMs,
    firstTextMs,
    chunks,
    text,
    done,
  };
}

function exactPrompt(token) {
  return `Reply with exactly this text and no extra characters: ${token}`;
}

function tokenFor(name) {
  return `EXACT_${name}_OK`;
}

function weatherTool() {
  return {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Get current weather by city.',
      parameters: weatherSchema(),
    },
  };
}

function weatherSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      city: { type: 'string' },
    },
    required: ['city'],
  };
}

function parseJson(value, label) {
  assert(typeof value === 'string', `${label} must be a string`);
  try {
    return JSON.parse(value);
  } catch (err) {
    throw new Error(`${label} is not valid JSON: ${value}; ${errorMessage(err)}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function summary(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    min: sorted[0],
    median: sorted[Math.floor((sorted.length - 1) / 2)],
    max: sorted[sorted.length - 1],
    samples: values,
  };
}

function elapsed(startedAt) {
  return Math.round(performance.now() - startedAt);
}

function headers() {
  return {
    'content-type': 'application/json',
    authorization: 'Bearer local',
    'x-api-key': 'local',
    'anthropic-version': '2023-06-01',
  };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    const key = arg.slice(2, eq === -1 ? undefined : eq).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const value = eq === -1 ? argv[i + 1] : arg.slice(eq + 1);
    if (eq === -1 && (!value || value.startsWith('--'))) out[key] = 'true';
    else {
      if (eq === -1) i += 1;
      out[key] = value;
    }
  }
  if (out.runtime && out.runtime !== 'codex' && out.runtime !== 'claude') {
    throw new Error(`Unsupported runtime: ${out.runtime}`);
  }
  return out;
}

function numberOption(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function reasoningEffort(value) {
  if (['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(value)) return value;
  return 'low';
}

function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}
