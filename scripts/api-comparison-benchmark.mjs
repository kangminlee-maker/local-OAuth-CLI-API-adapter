#!/usr/bin/env node
import fs from 'node:fs';
import { ClaudeCodeBackend } from '../dist/proxy/claude-code-backend.js';
import { CodexAppServerBackend } from '../dist/proxy/codex-app-server-backend.js';
import { startLocalApiProxy } from '../dist/proxy/http-server.js';

loadEnvFile('.env');

const options = parseArgs(process.argv.slice(2));
const timeoutMs = numberOption(options.timeoutMs, 240_000);
const repeats = numberOption(options.repeats, 1);
const cwd = options.cwd ?? process.cwd();
const openAiModel = options.openaiModel ?? 'gpt-5.5';
const anthropicModels = {
  opus: options.anthropicOpusModel ?? 'claude-opus-4-8',
  sonnet: options.anthropicSonnetModel ?? 'claude-sonnet-4-6',
  haiku: options.anthropicHaikuModel ?? 'claude-haiku-4-5-20251001',
};

const rows = [];
const servers = [];

try {
  const proxyCodex = await startProxy(new CodexAppServerBackend({
    command: options.codexCommand,
    cwd,
    model: options.codexModel,
    timeoutMs,
    reasoningEffort: reasoningEffort(options.reasoningEffort),
  }));
  const proxyClaude = await startProxy(new ClaudeCodeBackend({
    command: options.claudeCommand,
    cwd,
    model: options.claudeCliModel ?? 'sonnet',
    timeoutMs,
  }));

  await benchmarkOpenAiCompatible('proxy-codex', proxyCodex.url, proxyCodex.model, false);
  await benchmarkOpenAiCompatible('proxy-claude', proxyClaude.url, proxyClaude.model, false);
  if (process.env.OPENAI_API_KEY) {
    await benchmarkOpenAiCompatible('openai-api:gpt-5.5', 'https://api.openai.com', openAiModel, true);
  } else {
    rows.push({ target: 'openai-api:gpt-5.5', ok: false, skipped: true, error: 'OPENAI_API_KEY missing' });
  }

  await benchmarkAnthropicCompatible('proxy-codex', proxyCodex.url, proxyCodex.model, false);
  await benchmarkAnthropicCompatible('proxy-claude', proxyClaude.url, proxyClaude.model, false);
  if (process.env.ANTHROPIC_API_KEY) {
    for (const [family, model] of Object.entries(anthropicModels)) {
      await benchmarkAnthropicCompatible(`anthropic-api:${family}`, 'https://api.anthropic.com', model, true);
    }
  } else {
    rows.push({ target: 'anthropic-api', ok: false, skipped: true, error: 'ANTHROPIC_API_KEY missing' });
  }
} finally {
  for (const server of servers.reverse()) await server.close().catch(() => undefined);
}

const failed = rows.filter((row) => !row.ok && !row.skipped);
const summary = {
  repeats,
  openAiModel,
  anthropicModels,
  passed: rows.length - failed.length,
  failed: failed.length,
  rows,
};
console.log(`\nAPI_COMPARISON_SUMMARY ${JSON.stringify(summary, null, 2)}`);
process.exit(failed.length > 0 ? 1 : 0);

async function startProxy(backend) {
  const server = await startLocalApiProxy({
    backend,
    host: '127.0.0.1',
    port: 0,
    requestTimeoutMs: timeoutMs,
  });
  servers.push(server);
  return { url: server.url, model: backend.model };
}

async function benchmarkOpenAiCompatible(target, baseUrl, model, isApi) {
  await benchmarkCase(target, 'openai.responses.text', repeats, async (index) => {
    const token = tokenFor(target, 'OPENAI_TEXT', index);
    const response = await postJson(`${baseUrl}/v1/responses`, {
      model,
      input: exactPrompt(token),
      max_output_tokens: 64,
    }, openAiHeaders(isApi));
    const text = response.body.output_text ?? extractOpenAiResponseText(response.body);
    assertEqual(text, token, 'output_text');
    return { totalMs: response.totalMs, text };
  });

  await benchmarkCase(target, 'openai.responses.stream', repeats, async (index) => {
    const token = tokenFor(target, 'OPENAI_STREAM', index);
    const response = await postSse(`${baseUrl}/v1/responses`, {
      model,
      input: exactPrompt(token),
      max_output_tokens: 64,
      stream: true,
      stream_options: isApi ? { include_obfuscation: false } : undefined,
    }, openAiHeaders(isApi), (event, payload) => {
      if (event === 'response.output_text.delta') return payload.delta ?? '';
      if (payload?.type === 'response.output_text.delta') return payload.delta ?? '';
      return '';
    });
    assertEqual(response.text, token, 'stream text');
    return response;
  });

  await benchmarkCase(target, 'openai.responses.tool_call', repeats, async () => {
    const response = await postJson(`${baseUrl}/v1/responses`, {
      model,
      input: 'Use get_weather for Seoul. Return a tool call only.',
      max_output_tokens: 128,
      tools: [openAiWeatherTool()],
      tool_choice: 'required',
    }, openAiHeaders(isApi));
    const call = extractOpenAiFunctionCall(response.body);
    assertEqual(call?.name, 'get_weather', 'tool name');
    const args = parseJson(call?.arguments, 'tool arguments');
    assertEqual(args.city, 'Seoul', 'tool city');
    return { totalMs: response.totalMs, toolName: call.name, args };
  });
}

async function benchmarkAnthropicCompatible(target, baseUrl, model, isApi) {
  await benchmarkCase(target, 'anthropic.messages.text', repeats, async (index) => {
    const token = tokenFor(target, 'ANTHROPIC_TEXT', index);
    const response = await postJson(`${baseUrl}/v1/messages`, {
      model,
      max_tokens: 64,
      messages: [{ role: 'user', content: exactPrompt(token) }],
    }, anthropicHeaders(isApi));
    const text = response.body.content?.find((block) => block.type === 'text')?.text;
    assertEqual(text, token, 'message text');
    assertEqual(response.body.stop_reason, 'end_turn', 'stop_reason');
    return { totalMs: response.totalMs, text };
  });

  await benchmarkCase(target, 'anthropic.messages.stream', repeats, async (index) => {
    const token = tokenFor(target, 'ANTHROPIC_STREAM', index);
    const response = await postSse(`${baseUrl}/v1/messages`, {
      model,
      max_tokens: 64,
      stream: true,
      messages: [{ role: 'user', content: exactPrompt(token) }],
    }, anthropicHeaders(isApi), (event, payload) => {
      if (event === 'content_block_delta') return payload?.delta?.text ?? '';
      if (payload?.type === 'content_block_delta') return payload?.delta?.text ?? '';
      return '';
    });
    assertEqual(response.text, token, 'stream text');
    return response;
  });

  await benchmarkCase(target, 'anthropic.messages.tool_use', repeats, async () => {
    const response = await postJson(`${baseUrl}/v1/messages`, {
      model,
      max_tokens: 128,
      messages: [{ role: 'user', content: 'Use get_weather for Seoul. Return a tool call only.' }],
      tools: [{
        name: 'get_weather',
        description: 'Get current weather by city.',
        input_schema: weatherSchema(),
      }],
      tool_choice: { type: 'any' },
    }, anthropicHeaders(isApi));
    const call = response.body.content?.find((block) => block.type === 'tool_use');
    assertEqual(response.body.stop_reason, 'tool_use', 'stop_reason');
    assertEqual(call?.name, 'get_weather', 'tool name');
    assertEqual(call?.input?.city, 'Seoul', 'tool city');
    return { totalMs: response.totalMs, toolName: call.name, args: call.input };
  });
}

async function benchmarkCase(target, caseName, count, fn) {
  const samples = [];
  for (let i = 0; i < count; i += 1) {
    try {
      const sample = await fn(i + 1);
      samples.push(sample);
      console.log(`PASS ${target} ${caseName} #${i + 1}: ${JSON.stringify(sample)}`);
    } catch (err) {
      const row = {
        target,
        case: caseName,
        ok: false,
        error: errorMessage(err),
      };
      rows.push(row);
      console.log(`FAIL ${target} ${caseName} #${i + 1}: ${row.error}`);
      return;
    }
  }
  rows.push({
    target,
    case: caseName,
    ok: true,
    totalMs: summarize(samples.map((sample) => sample.totalMs)),
    firstTextMs: summarize(samples.map((sample) => sample.firstTextMs).filter(Number.isFinite)),
    chunks: samples.map((sample) => sample.chunks).filter(Number.isFinite),
    sample: samples.at(-1),
  });
}

async function postJson(url, body, headers) {
  const startedAt = performance.now();
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(stripUndefined(body)),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  if (!res.ok) throw new Error(`${url} ${res.status}: ${truncate(text)}`);
  return { body: parsed, totalMs: elapsed(startedAt) };
}

async function postSse(url, body, headers, collectText) {
  const startedAt = performance.now();
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(stripUndefined(body)),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${url} ${res.status}: ${truncate(await res.text())}`);
  if (!res.body) throw new Error(`${url} did not return a readable stream`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let firstDataMs = null;
  let firstTextMs = null;
  let chunks = 0;
  let text = '';

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
      if (!data || data === '[DONE]') continue;
      if (firstDataMs === null) firstDataMs = elapsed(startedAt);
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
  return { totalMs: elapsed(startedAt), firstDataMs, firstTextMs, chunks, text };
}

function openAiHeaders(isApi) {
  return {
    'content-type': 'application/json',
    ...(isApi
      ? { authorization: `Bearer ${process.env.OPENAI_API_KEY}` }
      : { authorization: 'Bearer local' }),
  };
}

function anthropicHeaders(isApi) {
  return {
    'content-type': 'application/json',
    ...(isApi
      ? { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }
      : { 'x-api-key': 'local', 'anthropic-version': '2023-06-01' }),
  };
}

function openAiWeatherTool() {
  return {
    type: 'function',
    name: 'get_weather',
    description: 'Get current weather by city.',
    parameters: weatherSchema(),
    strict: true,
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

function extractOpenAiResponseText(body) {
  return body.output
    ?.flatMap((item) => item.content ?? [])
    ?.find((content) => content.type === 'output_text')
    ?.text;
}

function extractOpenAiFunctionCall(body) {
  return body.output?.find((item) => item.type === 'function_call');
}

function exactPrompt(token) {
  return `Reply with exactly this text and no extra characters: ${token}`;
}

function tokenFor(target, name, index) {
  const safeTarget = target.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');
  return `BENCH_${safeTarget}_${name}_${index}_OK`;
}

function parseJson(value, label) {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  try {
    return JSON.parse(value);
  } catch (err) {
    throw new Error(`${label} is not JSON: ${value}; ${errorMessage(err)}`);
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function summarize(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    min: sorted[0],
    median: sorted[Math.floor((sorted.length - 1) / 2)],
    max: sorted[sorted.length - 1],
    samples: values,
  };
}

function stripUndefined(value) {
  return JSON.parse(JSON.stringify(value));
}

function truncate(value) {
  return value.length > 2000 ? `${value.slice(0, 2000)}...` : value;
}

function elapsed(startedAt) {
  return Math.round(performance.now() - startedAt);
}

function loadEnvFile(path) {
  if (!fs.existsSync(path)) return;
  for (const line of fs.readFileSync(path, 'utf8').split(/\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
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
  return out;
}

function numberOption(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function reasoningEffort(value) {
  if (['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(value)) return value;
  return 'low';
}

function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}
