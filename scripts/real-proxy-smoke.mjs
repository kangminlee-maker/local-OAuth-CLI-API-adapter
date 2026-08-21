#!/usr/bin/env node
import { deflateSync } from 'node:zlib';
import { ClaudeCodeBackend } from '../dist/proxy/claude-code-backend.js';
import { CodexAppServerBackend } from '../dist/proxy/codex-app-server-backend.js';
import { startLocalApiProxy } from '../dist/proxy/http-server.js';
import { isReasoningEffort } from '../dist/settings.js';

const options = parseArgs(process.argv.slice(2));
const runtime = options.runtime ?? 'codex';
const timeoutMs = numberOption(options.timeoutMs, 180_000);
const speedRepeats = numberOption(options.speedRepeats, 0);
const only = options.only ?? 'all';
const cwd = options.cwd ?? process.cwd();
// A backend identifier is not a model. With no `--model` the backends fall back
// to their own placeholder (`codex-app-server`, `claude-code-cli`), and the
// smoke then sent that placeholder as the request model — asking the runtime to
// run a model by that name, which the Codex backend answers with
// `The 'codex-app-server' model is not supported...` and every row fails. The
// default is a real slug, the same way the benchmark defaults its models.
const model = options.model ?? (runtime === 'claude' ? 'opus' : 'gpt-5.5');
const backend = runtime === 'claude'
  ? new ClaudeCodeBackend({
      command: options.command,
      cwd,
      model,
      timeoutMs,
    })
  : new CodexAppServerBackend({
      command: options.command,
      cwd,
      model,
      timeoutMs,
      reasoningEffort: reasoningEffort(options.reasoningEffort),
    });

const started = await startLocalApiProxy({
  backend,
  host: '127.0.0.1',
  port: 0,
  requestTimeoutMs: timeoutMs,
});

const requestModel = options.requestModel ?? model;
const rows = [];

try {
  if (only === 'multimodal') {
    await runMultimodalSmoke(started.url, requestModel);
  } else {
    await runExactSmoke(started.url, requestModel);
    if (speedRepeats > 0) await runSpeedSmoke(started.url, requestModel, speedRepeats);
  }
} finally {
  await started.close();
}

const failed = rows.filter((row) => !row.ok);
console.log(`\nREAL_SMOKE_SUMMARY ${JSON.stringify({
  runtime,
  model: requestModel,
  only,
  passed: rows.length - failed.length,
  failed: failed.length,
  rows,
}, null, 2)}`);
process.exit(failed.length > 0 ? 1 : 0);

async function runExactSmoke(baseUrl, model) {
  const visionImage = visionDataUrl();

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

  await runOpenAiChatImageColor(baseUrl, model, visionImage);

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
    const text = responsesOutputText(body);
    assertEqual(text, token, 'responses output text');
    return { totalMs, text };
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

  await runOpenAiResponsesImageColor(baseUrl, model, visionImage);

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

  await runAnthropicMessagesImageColor(baseUrl, model, visionImage);

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

async function runMultimodalSmoke(baseUrl, model) {
  const visionImage = visionDataUrl();
  await runOpenAiChatImageColor(baseUrl, model, visionImage);
  await runOpenAiResponsesImageColor(baseUrl, model, visionImage);
  await runAnthropicMessagesImageColor(baseUrl, model, visionImage);
}

async function runOpenAiChatImageColor(baseUrl, model, visionImage) {
  await run('openai_chat_image_color_exact', async () => {
    const { body, totalMs } = await postJson(baseUrl, '/v1/chat/completions', {
      model,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Identify the dominant color of the attached image. Reply exactly one uppercase word: RED, GREEN, or BLUE.',
          },
          { type: 'image_url', image_url: { url: visionImage, detail: 'high' } },
        ],
      }],
    });
    const text = body.choices?.[0]?.message?.content;
    assertEqual(text, 'RED', 'chat image color text');
    return { totalMs, text };
  });
}

async function runOpenAiResponsesImageColor(baseUrl, model, visionImage) {
  await run('openai_responses_image_color_exact', async () => {
    const { body, totalMs } = await postJson(baseUrl, '/v1/responses', {
      model,
      input: [{
        role: 'user',
        content: [
          { type: 'input_image', image_url: visionImage, detail: 'high' },
          {
            type: 'input_text',
            text: 'Identify the dominant color of the attached image. Reply exactly one uppercase word: RED, GREEN, or BLUE.',
          },
        ],
      }],
    });
    const text = responsesOutputText(body);
    assertEqual(text, 'RED', 'responses image color text');
    return { totalMs, text };
  });
}

async function runAnthropicMessagesImageColor(baseUrl, model, visionImage) {
  await run('anthropic_messages_image_color_exact', async () => {
    const { body, totalMs } = await postJson(baseUrl, '/v1/messages', {
      model,
      max_tokens: 32,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: visionImage.split(',')[1],
            },
          },
          {
            type: 'text',
            text: 'Identify the dominant color of the attached image. Reply exactly one uppercase word: RED, GREEN, or BLUE.',
          },
        ],
      }],
    });
    const text = body.content?.[0]?.text;
    assertEqual(text, 'RED', 'anthropic image color text');
    return { totalMs, text };
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

// `/v1/responses` carries assistant text in the message item's `output_text`
// content parts. There is no top-level `output_text` convenience field; that is
// an SDK-side helper in the real API, and the proxy keeps parity by omitting it
// (see the contract in docs/api-interface-contract.md).
function responsesOutputText(body) {
  const message = (body?.output ?? []).find((item) => item?.type === 'message');
  return (message?.content ?? [])
    .filter((part) => part?.type === 'output_text')
    .map((part) => part?.text ?? '')
    .join('');
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

function visionDataUrl() {
  const width = 320;
  const height = 180;
  const rgba = Buffer.alloc(width * height * 4, 255);
  fillRect(rgba, width, 0, 0, width, height, 220, 20, 20);
  return `data:image/png;base64,${pngBuffer(width, height, rgba).toString('base64')}`;
}

function fillRect(rgba, width, x, y, w, h, r, g, b) {
  for (let yy = y; yy < y + h; yy += 1) {
    for (let xx = x; xx < x + w; xx += 1) {
      const index = (yy * width + xx) * 4;
      rgba[index] = r;
      rgba[index + 1] = g;
      rgba[index + 2] = b;
      rgba[index + 3] = 255;
    }
  }
}

function pngBuffer(width, height, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0;
    rgba.copy(raw, rowStart + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
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
  if (out.only && out.only !== 'all' && out.only !== 'multimodal') {
    throw new Error(`Unsupported --only value: ${out.only}`);
  }
  return out;
}

function numberOption(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function reasoningEffort(value) {
  if (value === undefined) return undefined;
  if (isReasoningEffort(value)) return value;
  throw new Error(`Unsupported reasoning effort: ${value}`);
}

function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}
