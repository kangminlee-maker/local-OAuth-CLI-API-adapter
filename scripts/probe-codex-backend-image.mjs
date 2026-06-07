#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const args = process.argv.slice(2);
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = resolve(repoRoot, readValueArg('--out') ?? 'artifacts/codex-backend-image-probe');
const timeoutMs = Number(readValueArg('--timeout-ms') ?? 180_000);
const codexHome = resolve(readValueArg('--codex-home') ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'));
const model = readValueArg('--model') ?? 'gpt-5.5';
const prompt = readValueArg('--prompt')
  ?? 'Create a simple flat vector icon of a green leaf on a plain white background. No text.';
const size = readValueArg('--size') ?? '1024x1024';
const quality = readValueArg('--quality') ?? 'low';
const outputFormat = readValueArg('--output-format') ?? 'png';
const effort = readValueArg('--effort') ?? 'low';
const variantFilters = readCsvArg('--variant');
const repeatCount = positiveIntegerArg('--repeats', 1);
const stopAfterSuccess = !args.includes('--no-stop-after-success');
const skipLive = args.includes('--skip-live');

const CHATGPT_CODEX_BACKEND_URL = 'https://chatgpt.com/backend-api/codex/responses';
const CODEX_REFRESH_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const PRODUCT_SKU = 'codex';
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CHATGPT_AUTH_CLAIM_NAMESPACE = `https://api.${'openai'}.com/auth`;
const ACCESS_TOKEN_REFRESH_WINDOW_MS = 5 * 60 * 1000;
const allowedHosts = new Set(['chatgpt.com', 'auth.openai.com']);

await mkdir(outDir, { recursive: true });
const tempDir = await mkdtemp(join(tmpdir(), 'codex-backend-image-probe-'));

const report = {
  generatedAt: new Date().toISOString(),
  repoRoot,
  codexHome,
  liveProbeSkipped: skipLive,
  request: {
    model,
    prompt,
    size,
    quality,
    outputFormat,
    effort,
    timeoutMs,
    repeats: repeatCount,
  },
  authorities: {
    backend: CHATGPT_CODEX_BACKEND_URL,
    tokenRefresh: CODEX_REFRESH_TOKEN_URL,
    directProviderApiAllowed: false,
  },
  binary: await collectCodexBinaryEvidence(tempDir),
  variants: [],
};

try {
  if (!skipLive) {
    const auth = await readAuth();
    const variants = variantFilters.length > 0
      ? requestVariants().filter((variant) => variantFilters.includes(variant.id))
      : requestVariants();
    if (variants.length === 0) {
      throw new Error(`No probe variant matched --variant ${variantFilters.join(',')}`);
    }
    for (let repeat = 1; repeat <= repeatCount; repeat += 1) {
      for (const variant of variants) {
        const result = await runVariant(variant, auth, repeat);
        report.variants.push(result);
        process.stdout.write(`${variant.id} #${repeat}: ${result.ok ? 'ok' : 'fail'} ${result.imageCount} image(s), ${result.totalMs}ms\n`);
        if (stopAfterSuccess && result.imageCount > 0) break;
      }
    }
  }
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

report.summary = summarizeVariantResults(report.variants);

const jsonPath = join(outDir, `codex-backend-image-probe.${timestamp}.json`);
const markdownPath = join(outDir, `codex-backend-image-probe.${timestamp}.md`);
await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
await writeFile(markdownPath, renderMarkdown(report));
await writeFile(join(outDir, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`);
await writeFile(join(outDir, 'latest.md'), renderMarkdown(report));

process.stdout.write(`codex backend image probe report: ${jsonPath}\n`);
process.stdout.write(`codex backend image probe summary: ${markdownPath}\n`);

function readValueArg(name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function readCsvArg(name) {
  const value = readValueArg(name);
  return value
    ? value.split(',').map((item) => item.trim()).filter(Boolean)
    : [];
}

function positiveIntegerArg(name, fallback) {
  const value = readValueArg(name);
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function collectCodexBinaryEvidence(root) {
  const binary = await commandPath('codex');
  if (!binary) return { found: false };
  const version = await run(binary, ['--version'], { timeoutMs: 10_000, maxBuffer: 1_000_000 });
  const realpath = await run('/usr/bin/realpath', [binary], { timeoutMs: 10_000, maxBuffer: 1_000_000 });
  const schemaDir = join(root, 'schema-ts');
  await mkdir(schemaDir, { recursive: true });
  const schema = await run(binary, ['app-server', 'generate-ts', '--out', schemaDir], {
    timeoutMs: 45_000,
    maxBuffer: 30_000_000,
  });
  const responseItem = schema.ok
    ? await safeRead(join(schemaDir, 'ResponseItem.ts'))
    : '';
  const threadItem = schema.ok
    ? await safeRead(join(schemaDir, 'v2', 'ThreadItem.ts'))
    : '';
  const rawResponseItemCompleted = schema.ok
    ? await safeRead(join(schemaDir, 'v2', 'RawResponseItemCompletedNotification.ts'))
    : '';

  return {
    found: true,
    binary,
    realpath: firstLine(realpath.stdout) || binary,
    version: firstLine(version.stdout) || firstLine(version.stderr),
    schemaGenerated: schema.ok,
    schemaImageSnippets: [
      ...matchingLines(responseItem, /image_generation_call|ImageGeneration/i, 'ResponseItem.ts'),
      ...matchingLines(threadItem, /imageGeneration|ImageGeneration/i, 'v2/ThreadItem.ts'),
      ...matchingLines(rawResponseItemCompleted, /ResponseItem|RawResponse/i, 'v2/RawResponseItemCompletedNotification.ts'),
    ],
    binaryStringHits: await collectBinaryStringHits(firstLine(realpath.stdout) || binary),
  };
}

async function commandPath(command) {
  const result = await run('/bin/zsh', ['-lc', `command -v ${shellQuote(command)}`], {
    timeoutMs: 10_000,
    maxBuffer: 1_000_000,
  });
  return result.ok ? firstLine(result.stdout) : '';
}

async function collectBinaryStringHits(binary) {
  const result = await run('/usr/bin/strings', ['-a', binary], {
    timeoutMs: 60_000,
    maxBuffer: 80_000_000,
  });
  if (!result.ok) {
    return {
      ok: false,
      error: result.stderr || result.stdout,
      hits: [],
    };
  }
  const patterns = [
    /image_generation/i,
    /imageGeneration/i,
    /ImageGeneration/i,
    /image_generation_call/i,
    /images\/generations/i,
    /images\/edits/i,
    /revised_prompt/i,
    /saved_path/i,
    /backend-api\/codex/i,
  ];
  const hits = [];
  const seen = new Set();
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!patterns.some((pattern) => pattern.test(line))) continue;
    const clean = line.trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    hits.push(clean.length > 280 ? `${clean.slice(0, 280)}...` : clean);
    if (hits.length >= 120) break;
  }
  return {
    ok: true,
    hitCount: seen.size,
    hits,
  };
}

function requestVariants() {
  const base = {
    model,
    instructions: [
      'You are a probe for the ChatGPT Codex backend Responses image-generation path.',
      'Use image generation when an image_generation tool is available.',
      'Do not call direct provider APIs or external network APIs.',
      'If an image is generated, do not add prose.',
    ].join('\n'),
    input: [{
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: prompt }],
    }],
    parallel_tool_calls: true,
    reasoning: { effort },
    store: false,
    stream: true,
    include: [],
    text: { verbosity: 'low' },
  };
  return [
    {
      id: 'tool_image_generation_auto_with_controls',
      body: {
        ...base,
        tools: [{ type: 'image_generation', size, quality }],
        tool_choice: 'auto',
      },
    },
    {
      id: 'tool_image_generation_required_with_controls',
      body: {
        ...base,
        tools: [{ type: 'image_generation', size, quality }],
        tool_choice: { type: 'image_generation' },
      },
    },
    {
      id: 'tool_image_generation_required_action_format',
      body: {
        ...base,
        tools: [{
          type: 'image_generation',
          action: 'generate',
          size,
          quality,
          output_format: outputFormat,
        }],
        tool_choice: { type: 'image_generation' },
      },
    },
    {
      id: 'tool_image_generation_required_minimal_tool',
      body: {
        ...base,
        tools: [{ type: 'image_generation' }],
        tool_choice: { type: 'image_generation' },
      },
    },
    {
      id: 'tool_image_generation_required_no_parallel',
      body: {
        ...base,
        parallel_tool_calls: false,
        tools: [{ type: 'image_generation', size, quality }],
        tool_choice: { type: 'image_generation' },
      },
    },
    {
      id: 'tool_image_generation_required_terse_instructions',
      body: {
        ...base,
        instructions: 'Use the image_generation tool. Return an image result, not prose. Do not call external APIs.',
        tools: [{ type: 'image_generation', size, quality }],
        tool_choice: { type: 'image_generation' },
      },
    },
    {
      id: 'tool_image_generation_required_string_input',
      body: {
        ...base,
        instructions: 'Use the image_generation tool. Return an image result, not prose. Do not call external APIs.',
        input: prompt,
        tools: [{ type: 'image_generation', size, quality }],
        tool_choice: { type: 'image_generation' },
      },
    },
    {
      id: 'tool_image_generation_auto_minimal',
      body: {
        ...base,
        tools: [{ type: 'image_generation' }],
        tool_choice: 'auto',
      },
    },
    {
      id: 'prompt_only_implicit_image',
      body: {
        ...base,
        instructions: `${base.instructions}\nUse the image generation capability now; the final response must include an image_generation_call result.`,
        tools: [],
        tool_choice: 'auto',
      },
    },
  ];
}

async function runVariant(variant, auth, repeat) {
  const startedAt = Date.now();
  const timeline = [{ label: 'request_start', ms: 0 }];
  const outputImages = [];
  const eventSummaries = [];
  const requestBody = sanitize(variant.body);
  try {
    const response = await postBackend(variant.body, auth);
    timeline.push({ label: 'headers_received', ms: Date.now() - startedAt, status: response.status });
    if (!response.ok) {
      const raw = await response.text().catch(() => '');
      return {
        id: variant.id,
        repeat,
        ok: false,
        status: response.status,
        totalMs: Date.now() - startedAt,
        imageCount: 0,
        requestBody,
        timeline,
        error: safeJsonOrText(raw),
      };
    }
    let firstEvent = true;
    for await (const event of parseSseEvents(response)) {
      if (firstEvent) {
        timeline.push({ label: 'first_sse_event', ms: Date.now() - startedAt, type: event.type });
        firstEvent = false;
      }
      const candidates = imageCandidates(event);
      pushImageTimelineEvent(timeline, event, startedAt);
      if (candidates.length > 0 && outputImages.length === 0) {
        timeline.push({ label: 'first_image_result', ms: Date.now() - startedAt, type: event.type });
      }
      for (const candidate of candidates) {
        const image = await persistImageCandidate(variant.id, candidate);
        outputImages.push(image);
      }
      eventSummaries.push(summarizeEvent(event, candidates));
      if (event.type === 'response.completed') {
        timeline.push({ label: 'response_completed', ms: Date.now() - startedAt });
      }
    }
    timeline.push({ label: 'stream_end', ms: Date.now() - startedAt });
    return {
      id: variant.id,
      repeat,
      ok: true,
      status: response.status,
      totalMs: Date.now() - startedAt,
      imageCount: outputImages.length,
      requestBody,
      timeline,
      outputImages,
      eventSummaries,
    };
  } catch (err) {
    return {
      id: variant.id,
      repeat,
      ok: false,
      totalMs: Date.now() - startedAt,
      imageCount: outputImages.length,
      requestBody,
      timeline,
      outputImages,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function pushImageTimelineEvent(timeline, event, startedAt) {
  const item = asRecord(event.item);
  if (event.type === 'response.output_item.added' && item?.type === 'image_generation_call') {
    pushTimelineOnce(timeline, 'first_image_item', event, startedAt);
  }
  if (event.type === 'response.image_generation_call.generating') {
    pushTimelineOnce(timeline, 'image_generating', event, startedAt);
  }
  if (event.type === 'response.image_generation_call.partial_image') {
    pushTimelineOnce(timeline, 'first_partial_image', event, startedAt);
  }
}

function pushTimelineOnce(timeline, label, event, startedAt) {
  if (timeline.some((item) => item.label === label)) return;
  timeline.push({ label, ms: Date.now() - startedAt, type: event.type });
}

async function postBackend(body, auth) {
  return await guardedFetch(CHATGPT_CODEX_BACKEND_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${auth.accessToken}`,
      'ChatGPT-Account-ID': auth.accountId,
      'OAI-Product-Sku': PRODUCT_SKU,
      'Content-Type': 'application/json',
      accept: 'text/event-stream',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

async function guardedFetch(url, init) {
  const parsed = new URL(url);
  if (!allowedHosts.has(parsed.hostname)) {
    throw new Error(`Blocked non-Codex/backend network host: ${parsed.hostname}`);
  }
  return await fetch(url, init);
}

async function readAuth() {
  const authPath = join(codexHome, 'auth.json');
  const parsed = JSON.parse(await readFile(authPath, 'utf8'));
  if (shouldRefreshAuth(parsed)) {
    const refreshed = await refreshAuth(parsed);
    await saveAuthFile(authPath, refreshed);
    return authFromFile(refreshed);
  }
  return authFromFile(parsed);
}

function authFromFile(parsed) {
  const accessToken = parsed.tokens?.access_token;
  const accountId = parsed.tokens?.account_id ?? accountIdFromIdToken(parsed.tokens?.id_token);
  if (!accessToken || !accountId) {
    throw new Error('Codex OAuth auth.json must include tokens.access_token and tokens.account_id.');
  }
  return {
    accessToken,
    refreshToken: parsed.tokens?.refresh_token,
    accountId,
  };
}

function shouldRefreshAuth(parsed) {
  const accessToken = parsed.tokens?.access_token;
  if (!accessToken) return false;
  const expiresAtMs = jwtExpirationMs(accessToken);
  return Number.isFinite(expiresAtMs)
    && expiresAtMs <= Date.now() + ACCESS_TOKEN_REFRESH_WINDOW_MS;
}

async function refreshAuth(parsed) {
  const refreshToken = parsed.tokens?.refresh_token;
  if (!refreshToken) throw new Error('Codex OAuth auth.json must include tokens.refresh_token to refresh access.');
  const response = await guardedFetch(CODEX_REFRESH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: CODEX_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });
  if (!response.ok) {
    throw new Error(`Codex OAuth refresh failed with status ${response.status}: ${await response.text().catch(() => '')}`);
  }
  const refreshed = await response.json();
  const previousTokens = parsed.tokens ?? {};
  const tokens = {
    ...previousTokens,
    ...(refreshed.id_token ? { id_token: refreshed.id_token } : {}),
    ...(refreshed.access_token ? { access_token: refreshed.access_token } : {}),
    ...(refreshed.refresh_token ? { refresh_token: refreshed.refresh_token } : {}),
  };
  const accountId = accountIdFromIdToken(tokens.id_token) ?? tokens.account_id;
  return {
    ...parsed,
    tokens: {
      ...tokens,
      ...(accountId ? { account_id: accountId } : {}),
    },
    last_refresh: new Date().toISOString(),
  };
}

async function saveAuthFile(path, auth) {
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
  await rename(tempPath, path);
}

function jwtExpirationMs(jwt) {
  const payload = jwtPayload(jwt);
  return typeof payload?.exp === 'number' ? payload.exp * 1000 : Number.NaN;
}

function accountIdFromIdToken(idToken) {
  const auth = asRecord(jwtPayload(idToken)?.[CHATGPT_AUTH_CLAIM_NAMESPACE]);
  return typeof auth?.chatgpt_account_id === 'string'
    ? auth.chatgpt_account_id
    : undefined;
}

function jwtPayload(jwt) {
  if (!jwt) return null;
  const payload = jwt.split('.')[1];
  if (!payload) return null;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

async function* parseSseEvents(response) {
  const body = response.body;
  if (!body) return;
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let separator = /\r?\n\r?\n/.exec(buffer);
    while (separator) {
      const block = buffer.slice(0, separator.index);
      buffer = buffer.slice(separator.index + separator[0].length);
      const event = parseSseBlock(block);
      if (event) yield event;
      separator = /\r?\n\r?\n/.exec(buffer);
    }
  }
  buffer += decoder.decode();
  const event = parseSseBlock(buffer);
  if (event) yield event;
}

function parseSseBlock(block) {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice(6))
    .join('\n')
    .trim();
  if (!data || data === '[DONE]') return null;
  try {
    return JSON.parse(data);
  } catch {
    return { type: 'unparseable', raw: data.slice(0, 500) };
  }
}

function imageCandidates(value, path = []) {
  const out = [];
  collectImageCandidates(value, path, out);
  return out;
}

function collectImageCandidates(value, path, out) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectImageCandidates(item, [...path, index], out));
    return;
  }
  const obj = asRecord(value);
  if (!obj) return;
  const type = typeof obj.type === 'string' ? obj.type : '';
  for (const [key, child] of Object.entries(obj)) {
    if (
      typeof child === 'string'
      && (key === 'result' || key === 'b64_json')
      && looksLikeBase64Image(child)
    ) {
      out.push({
        path: [...path, key].join('.'),
        type,
        field: key,
        data: child,
        revisedPrompt: typeof obj.revised_prompt === 'string' ? obj.revised_prompt : undefined,
      });
    }
    collectImageCandidates(child, [...path, key], out);
  }
}

function looksLikeBase64Image(value) {
  if (value.length < 1000) return false;
  if (!/^[A-Za-z0-9+/=\s_-]+$/.test(value.slice(0, 2000))) return false;
  const bytes = Buffer.from(value.replace(/\s/g, ''), 'base64');
  return bytes.length > 100
    && (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      || bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
      || bytes.subarray(0, 4).toString('ascii') === 'RIFF');
}

async function persistImageCandidate(variantId, candidate) {
  const clean = candidate.data.replace(/\s/g, '');
  const bytes = Buffer.from(clean, 'base64');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const ext = imageExtension(bytes);
  const imagePath = join(outDir, `${timestamp}.${variantId}.${sha256.slice(0, 12)}.${ext}`);
  await writeFile(imagePath, bytes);
  return {
    path: imagePath,
    bytes: bytes.length,
    sha256,
    sourcePath: candidate.path,
    sourceType: candidate.type,
    sourceField: candidate.field,
    revisedPrompt: candidate.revisedPrompt,
  };
}

function imageExtension(bytes) {
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'jpg';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF') return 'webp';
  return 'png';
}

function summarizeEvent(event, candidates) {
  const item = asRecord(event.item);
  const response = asRecord(event.response);
  return {
    type: event.type,
    outputIndex: event.output_index,
    itemType: item?.type,
    itemStatus: item?.status,
    responseId: response?.id,
    responseStatus: response?.status,
    responseModel: response?.model,
    usage: response?.usage ? sanitize(response.usage) : undefined,
    deltaLength: typeof event.delta === 'string' ? event.delta.length : undefined,
    imageCandidateCount: candidates.length,
    sanitized: sanitize(event),
  };
}

function sanitize(value) {
  if (typeof value === 'string') {
    if (value.length > 500 && /^[A-Za-z0-9+/=\s_-]+$/.test(value.slice(0, 1000))) {
      const clean = value.replace(/\s/g, '');
      return `<base64-like len=${clean.length} sha256=${createHash('sha256').update(clean).digest('hex').slice(0, 16)}>`;
    }
    return value.length > 1000 ? `${value.slice(0, 1000)}...` : value;
  }
  if (Array.isArray(value)) return value.map(sanitize);
  const obj = asRecord(value);
  if (!obj) return value;
  return Object.fromEntries(Object.entries(obj).map(([key, child]) => [key, sanitize(child)]));
}

function safeJsonOrText(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return raw.slice(0, 2000);
  }
}

function summarizeVariantResults(variants) {
  const groups = new Map();
  for (const variant of variants ?? []) {
    const values = groups.get(variant.id) ?? [];
    values.push(variant);
    groups.set(variant.id, values);
  }
  return [...groups.entries()].map(([id, values]) => {
    const firstImageMs = values
      .map((value) => timelineMs(value, 'first_image_result'))
      .filter(Number.isFinite);
    const imageItemMs = values
      .map((value) => timelineMs(value, 'first_image_item'))
      .filter(Number.isFinite);
    const generatingMs = values
      .map((value) => timelineMs(value, 'image_generating'))
      .filter(Number.isFinite);
    const generatingToImageMs = values
      .map((value) => {
        const image = timelineMs(value, 'first_image_result');
        const generating = timelineMs(value, 'image_generating');
        return Number.isFinite(image) && Number.isFinite(generating) ? image - generating : Number.NaN;
      })
      .filter(Number.isFinite);
    return {
      id,
      attempts: values.length,
      successes: values.filter((value) => value.imageCount > 0).length,
      failures: values.filter((value) => value.imageCount === 0).length,
      totalMs: stats(values.map((value) => value.totalMs)),
      firstImageMs: stats(firstImageMs),
      firstImageItemMs: stats(imageItemMs),
      imageGeneratingMs: stats(generatingMs),
      generatingToImageMs: stats(generatingToImageMs),
      errors: values
        .filter((value) => value.imageCount === 0 && value.error)
        .map((value) => errorSummary(value.error)),
    };
  });
}

function errorSummary(error) {
  if (typeof error === 'string') return error.slice(0, 300);
  try {
    return JSON.stringify(error).slice(0, 300);
  } catch {
    return String(error).slice(0, 300);
  }
}

function timelineMs(variant, label) {
  const value = variant.timeline?.find((item) => item.label === label)?.ms;
  return Number.isFinite(value) ? value : Number.NaN;
}

function stats(values) {
  const clean = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (clean.length === 0) return null;
  return {
    min: clean[0],
    median: percentile(clean, 0.5),
    max: clean[clean.length - 1],
    samples: clean,
  };
}

function percentile(sortedValues, p) {
  const index = Math.floor((sortedValues.length - 1) * p);
  return sortedValues[index];
}

function matchingLines(text, pattern, file) {
  return text
    .split(/\r?\n/)
    .map((line, index) => ({ file, line: index + 1, text: line.trim() }))
    .filter((entry) => pattern.test(entry.text))
    .slice(0, 80);
}

async function safeRead(path) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}

async function run(command, commandArgs, options = {}) {
  try {
    const result = await execFileAsync(command, commandArgs, {
      timeout: options.timeoutMs ?? 30_000,
      maxBuffer: options.maxBuffer ?? 5_000_000,
      env: process.env,
    });
    return {
      ok: true,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (err) {
    return {
      ok: false,
      stdout: typeof err.stdout === 'string' ? err.stdout : '',
      stderr: typeof err.stderr === 'string' ? err.stderr : err instanceof Error ? err.message : String(err),
    };
  }
}

function renderMarkdown(data) {
  const lines = [];
  lines.push('# Codex backend image probe');
  lines.push('');
  lines.push(`- generatedAt: ${data.generatedAt}`);
  lines.push(`- binary: ${data.binary?.realpath ?? data.binary?.binary ?? 'not found'}`);
  lines.push(`- version: ${data.binary?.version ?? 'unknown'}`);
  lines.push(`- liveProbeSkipped: ${data.liveProbeSkipped}`);
  lines.push('');
  lines.push('## Binary evidence');
  lines.push('');
  for (const snippet of data.binary?.schemaImageSnippets ?? []) {
    lines.push(`- ${snippet.file}:${snippet.line} \`${snippet.text.replaceAll('`', '\\`')}\``);
  }
  lines.push('');
  lines.push('## Live variants');
  lines.push('');
  lines.push('| variant | repeat | ok | images | totalMs | firstImageItemMs | generatingMs | firstImageMs | status/error |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---|');
  for (const variant of data.variants ?? []) {
    const firstImage = variant.timeline?.find((item) => item.label === 'first_image_result')?.ms ?? '';
    const firstImageItem = variant.timeline?.find((item) => item.label === 'first_image_item')?.ms ?? '';
    const generating = variant.timeline?.find((item) => item.label === 'image_generating')?.ms ?? '';
    const status = variant.status ?? String(variant.error ?? '');
    lines.push(`| ${variant.id} | ${variant.repeat ?? ''} | ${variant.ok ? 'yes' : 'no'} | ${variant.imageCount} | ${variant.totalMs} | ${firstImageItem} | ${generating} | ${firstImage} | ${escapeTable(String(status).slice(0, 120))} |`);
  }
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| variant | success | total median | first image median | generating→image median |');
  lines.push('|---|---:|---:|---:|---:|');
  for (const item of data.summary ?? []) {
    lines.push(`| ${item.id} | ${item.successes}/${item.attempts} | ${item.totalMs?.median ?? ''} | ${item.firstImageMs?.median ?? ''} | ${item.generatingToImageMs?.median ?? ''} |`);
  }
  lines.push('');
  lines.push('## Output images');
  lines.push('');
  for (const variant of data.variants ?? []) {
    for (const image of variant.outputImages ?? []) {
      lines.push(`- ${variant.id}: ${image.path} (${image.bytes} bytes, sha256 ${image.sha256})`);
    }
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function escapeTable(value) {
  return value.replaceAll('|', '\\|').replace(/\s+/g, ' ');
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function firstLine(value) {
  return String(value ?? '').split(/\r?\n/).find((line) => line.trim())?.trim() ?? '';
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}
