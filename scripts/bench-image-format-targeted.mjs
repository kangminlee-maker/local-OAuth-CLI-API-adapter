#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexBackendTransport } from '../dist/proxy/codex-backend-transport.js';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
loadEnvFile('.env');

const args = process.argv.slice(2);
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = resolve(repoRoot, readValueArg('--out') ?? 'artifacts/image-format-targeted');
const codexHome = resolve(readValueArg('--codex-home') ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'));
const model = readValueArg('--model') ?? 'gpt-5.5';
const judgeModel = readValueArg('--judge-model') ?? 'gpt-5.5';
const repeats = positiveIntegerArg('--repeats', 3);
const timeoutMs = positiveIntegerArg('--timeout-ms', 240_000);
const classFilters = readCsvArg('--classes');
const promptFilters = readCsvArg('--prompts');
const formatFilters = readCsvArg('--formats');
const formats = formatFilters.length > 0 ? formatFilters : ['png', 'jpeg', 'webp'];
const skipQualityJudge = args.includes('--skip-quality-judge');

await mkdir(outDir, { recursive: true });

const prompts = targetedPrompts()
  .filter((item) => classFilters.length === 0 || classFilters.includes(item.class))
  .filter((item) => promptFilters.length === 0 || promptFilters.includes(item.id));

if (prompts.length === 0) {
  throw new Error('No targeted prompt matched the provided filters.');
}

const report = {
  generatedAt: new Date().toISOString(),
  repoRoot,
  codexHome,
  model,
  repeats,
  timeoutMs,
  formats,
  judge: {
    enabled: !skipQualityJudge && Boolean(process.env.OPENAI_API_KEY),
    model: judgeModel,
    skippedReason: skipQualityJudge
      ? 'disabled by --skip-quality-judge'
      : process.env.OPENAI_API_KEY
        ? undefined
        : 'OPENAI_API_KEY missing',
  },
  rows: [],
};

const backend = new CodexBackendTransport({ codexHome, model, timeoutMs });
const jsonPath = join(outDir, `image-format-targeted-${repeats}x.${timestamp}.json`);
const markdownPath = join(outDir, `image-format-targeted-${repeats}x.${timestamp}.md`);

for (let repeat = 1; repeat <= repeats; repeat += 1) {
  for (const spec of prompts) {
    for (const format of formats) {
      const row = await runOne({ backend, spec, format, repeat });
      report.rows.push(row);
      report.summary = summarize(report.rows);
      await writeArtifacts(report, jsonPath, markdownPath);
      process.stdout.write(JSON.stringify({
        repeat: row.repeat,
        class: row.class,
        prompt: row.promptId,
        requestedFormat: row.requestedFormat,
        ok: row.ok,
        totalMs: row.totalMs,
        detectedFormat: row.detectedFormat,
        bytes: row.bytes,
        score: row.imageQuality?.score,
        error: row.error,
      }) + '\n');
    }
  }
}

report.completedAt = new Date().toISOString();
report.summary = summarize(report.rows);
await writeArtifacts(report, jsonPath, markdownPath);
process.stdout.write(`report=${jsonPath}\n`);
process.stdout.write(`${JSON.stringify(report.summary.byClassFormat, null, 2)}\n`);

async function runOne({ backend, spec, format, repeat }) {
  const startedAt = Date.now();
  try {
    const result = await backend.generate({
      operation: 'generation',
      model: 'image-2',
      prompt: spec.prompt,
      n: 1,
      images: [],
      size: '1024x1024',
      quality: spec.quality,
      outputFormat: format,
      ...(format === 'jpeg' || format === 'webp' ? { outputCompression: 85 } : {}),
      responseFormat: 'b64_json',
      stream: false,
      partialImages: 0,
      raw: {},
    });
    const image = result.images?.[0];
    if (!image?.b64Json) throw new Error('missing image b64Json');
    const buffer = Buffer.from(stripDataUrl(image.b64Json), 'base64');
    const detectedFormat = detectImageFormat(buffer);
    const imagePath = join(
      outDir,
      `${timestamp}.${repeat}.${spec.class}.${spec.id}.${format}.${extensionForFormat(detectedFormat)}`,
    );
    await writeFile(imagePath, buffer);
    const imageQuality = report.judge.enabled
      ? await scoreImageQuality({
          prompt: spec.prompt,
          requirements: spec.requirements,
          b64Json: buffer.toString('base64'),
          mediaType: mediaTypeForFormat(detectedFormat),
        })
      : null;
    return {
      ok: true,
      repeat,
      class: spec.class,
      promptId: spec.id,
      requestedFormat: format,
      totalMs: Date.now() - startedAt,
      detectedFormat,
      surfaceMatches: detectedFormat === normalizeFormat(format),
      bytes: buffer.length,
      sha256: createHash('sha256').update(buffer).digest('hex'),
      imageQuality,
      revisedPrompt: image.revisedPrompt ?? '',
      imagePath,
    };
  } catch (err) {
    return {
      ok: false,
      repeat,
      class: spec.class,
      promptId: spec.id,
      requestedFormat: format,
      totalMs: Date.now() - startedAt,
      error: errorMessage(err),
    };
  }
}

function targetedPrompts() {
  return [
    {
      class: 'simpleFlatGraphic',
      id: 'solid-square',
      prompt: 'Create a simple flat red square centered on a plain white background. No text.',
      requirements: ['flat red square', 'plain white background', 'centered composition', 'no text'],
      quality: 'low',
    },
    {
      class: 'simpleFlatGraphic',
      id: 'two-color-icon',
      prompt: 'Create a simple flat vector icon of a yellow sun above a blue semicircle wave on a white background. Use only clean solid colors. No text.',
      requirements: ['yellow sun', 'blue semicircle wave', 'white background', 'solid flat colors', 'no text'],
      quality: 'low',
    },
    {
      class: 'simpleFlatGraphic',
      id: 'badge-emblem',
      prompt: 'Create a simple flat circular badge: teal outer circle, white inner circle, and one small orange star in the center. No text, no gradients, no shadows.',
      requirements: ['teal outer circle', 'white inner circle', 'orange center star', 'no text', 'no gradients', 'no shadows'],
      quality: 'low',
    },
    {
      class: 'simpleFlatGraphic',
      id: 'geometric-illustration',
      prompt: 'Create a simple flat geometric illustration of three overlapping rectangles in red, blue, and yellow on a white background. Crisp edges, no text.',
      requirements: ['three overlapping rectangles', 'red blue yellow', 'white background', 'crisp edges', 'no text'],
      quality: 'low',
    },
    {
      class: 'photorealRaster',
      id: 'ceramic-mug',
      prompt: 'Create a realistic studio product photo of a matte black ceramic mug on a light gray tabletop with soft natural shadows. No text or logo.',
      requirements: ['realistic black ceramic mug', 'light gray tabletop', 'soft natural shadows', 'no text', 'no logo'],
      quality: 'medium',
    },
    {
      class: 'photorealRaster',
      id: 'food-photo',
      prompt: 'Create a realistic close-up food photo of a croissant on a white ceramic plate near a window, with soft morning light. No text or logo.',
      requirements: ['realistic croissant', 'white ceramic plate', 'window light', 'soft morning light', 'no text', 'no logo'],
      quality: 'medium',
    },
    {
      class: 'photorealRaster',
      id: 'indoor-object',
      prompt: 'Create a realistic indoor photo of a small green potted plant on a wooden desk beside a closed silver laptop. Natural shadows. No text or logo.',
      requirements: ['realistic green potted plant', 'wooden desk', 'closed silver laptop', 'natural shadows', 'no text', 'no logo'],
      quality: 'medium',
    },
    {
      class: 'photorealRaster',
      id: 'fabric-closeup',
      prompt: 'Create a realistic macro photo of folded navy linen fabric showing detailed weave texture under soft diffused light. No text or logo.',
      requirements: ['realistic navy linen fabric', 'folded fabric', 'detailed weave texture', 'soft diffused light', 'no text', 'no logo'],
      quality: 'medium',
    },
  ];
}

async function scoreImageQuality(spec) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: judgeModel,
      messages: [
        {
          role: 'system',
          content: [
            'You are a strict image quality judge for API compatibility benchmarks.',
            'Score only what is visible in the generated image against the request.',
            'Return only JSON matching the requested schema.',
          ].join(' '),
        },
        { role: 'user', content: imageQualityJudgeContent(spec) },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'image_quality_score',
          strict: true,
          schema: imageQualityScoreSchema(),
        },
      },
      max_completion_tokens: 1000,
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`image quality judge failed ${response.status}: ${text.slice(0, 400)}`);
  }
  const body = JSON.parse(text);
  return {
    ...JSON.parse(body.choices?.[0]?.message?.content ?? '{}'),
    usage: body.usage,
  };
}

function imageQualityJudgeContent(spec) {
  return [
    { type: 'text', text: imageQualityJudgePrompt(spec) },
    { type: 'text', text: 'Candidate output image to score:' },
    {
      type: 'image_url',
      image_url: {
        url: `data:${spec.mediaType};base64,${spec.b64Json}`,
        detail: 'high',
      },
    },
  ];
}

function imageQualityJudgePrompt(spec) {
  return [
    'Original request:',
    spec.prompt,
    `Requirements: ${(spec.requirements ?? []).join('; ')}`,
    [
      'Rubric:',
      '- requirementFit: visible satisfaction of the explicit request and listed requirements.',
      '- visualCorrectness: correct objects, colors, composition, style, background, and aspect.',
      '- artifactControl: no blank/corrupt output, obvious distortions, malformed edges, compression artifacts, or geometry problems.',
      '- textAccuracy: visible text is absent when forbidden, or legible and spelled exactly when requested.',
      'Overall score is 0 to 100.',
      'List concrete visible violations only; use an empty array if none.',
    ].join('\n'),
  ].join('\n\n');
}

function imageQualityScoreSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      score: { type: 'integer' },
      requirementFit: { type: 'integer' },
      visualCorrectness: { type: 'integer' },
      artifactControl: { type: 'integer' },
      textAccuracy: { type: 'integer' },
      rationale: { type: 'string' },
      issues: { type: 'array', items: { type: 'string' } },
    },
    required: [
      'score',
      'requirementFit',
      'visualCorrectness',
      'artifactControl',
      'textAccuracy',
      'rationale',
      'issues',
    ],
  };
}

function summarize(rows) {
  return {
    byClassFormat: summarizeBy(rows, ['class', 'requestedFormat']),
    byClassPromptFormat: summarizeBy(rows, ['class', 'promptId', 'requestedFormat']),
  };
}

function summarizeBy(rows, keys) {
  const groups = [];
  const groupKeys = unique(rows.map((row) => keys.map((key) => row[key]).join('\u0000')));
  for (const groupKey of groupKeys) {
    const values = groupKey.split('\u0000');
    const groupRows = rows.filter((row) => keys.every((key, index) => row[key] === values[index]));
    const okRows = groupRows.filter((row) => row.ok);
    const group = Object.fromEntries(keys.map((key, index) => [key, values[index]]));
    groups.push({
      ...group,
      count: groupRows.length,
      ok: okRows.length,
      detectedFormats: countBy(okRows.map((row) => row.detectedFormat)),
      surfaceMatches: okRows.filter((row) => row.surfaceMatches).length,
      totalMs: stats(okRows.map((row) => row.totalMs)),
      bytes: stats(okRows.map((row) => row.bytes)),
      score: stats(okRows.map((row) => row.imageQuality?.score).filter(Number.isFinite)),
    });
  }
  return groups;
}

async function writeArtifacts(report, jsonPath, markdownPath) {
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(jsonPath, serialized);
  await writeFile(join(outDir, 'latest.json'), serialized);
  await writeFile(markdownPath, renderMarkdown(report));
  await writeFile(join(outDir, 'latest.md'), renderMarkdown(report));
}

function renderMarkdown(report) {
  const lines = [
    '# Targeted Image Format Benchmark',
    '',
    `Generated: ${report.generatedAt}`,
    '',
    '## By Class And Format',
    '',
    '| Class | Format | Count | OK | totalMs median | totalMs min-max | score median | score min-max | bytes median |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const row of report.summary?.byClassFormat ?? []) {
    lines.push(summaryRow([
      row.class,
      row.requestedFormat,
      row.count,
      row.ok,
      row.totalMs?.median ?? 'N/A',
      row.totalMs ? `${row.totalMs.min}-${row.totalMs.max}` : 'N/A',
      row.score?.median ?? 'N/A',
      row.score ? `${row.score.min}-${row.score.max}` : 'N/A',
      row.bytes?.median ?? 'N/A',
    ]));
  }
  lines.push('', '## By Prompt', '');
  lines.push('| Class | Prompt | Format | Count | OK | totalMs median | score median | score min-max |');
  lines.push('|---|---|---|---:|---:|---:|---:|---:|');
  for (const row of report.summary?.byClassPromptFormat ?? []) {
    lines.push(summaryRow([
      row.class,
      row.promptId,
      row.requestedFormat,
      row.count,
      row.ok,
      row.totalMs?.median ?? 'N/A',
      row.score?.median ?? 'N/A',
      row.score ? `${row.score.min}-${row.score.max}` : 'N/A',
    ]));
  }
  return `${lines.join('\n')}\n`;
}

function summaryRow(values) {
  return values.join(' | ').replace(/^/, '| ').replace(/$/, ' |');
}

function stripDataUrl(value) {
  return String(value).replace(/^data:image\/[a-z0-9.+-]+;base64,/i, '').replace(/\s/g, '');
}

function detectImageFormat(buffer) {
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return 'unknown';
}

function mediaTypeForFormat(format) {
  if (format === 'jpeg') return 'image/jpeg';
  if (format === 'webp') return 'image/webp';
  return 'image/png';
}

function extensionForFormat(format) {
  if (format === 'jpeg') return 'jpg';
  if (format === 'webp') return 'webp';
  return 'png';
}

function normalizeFormat(format) {
  if (format === 'jpg') return 'jpeg';
  return format === 'jpeg' || format === 'webp' ? format : 'png';
}

function stats(values) {
  const nums = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (nums.length === 0) return null;
  return {
    min: nums[0],
    median: percentile(nums, 0.5),
    max: nums[nums.length - 1],
    mean: Math.round(nums.reduce((sum, value) => sum + value, 0) / nums.length),
  };
}

function percentile(sorted, p) {
  if (sorted.length === 1) return sorted[0];
  const index = (sorted.length - 1) * p;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  if (low === high) return sorted[low];
  return Math.round(sorted[low] + (sorted[high] - sorted[low]) * (index - low));
}

function countBy(values) {
  const out = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}

function unique(values) {
  return [...new Set(values)];
}

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
  return value ? value.split(',').map((item) => item.trim()).filter(Boolean) : [];
}

function positiveIntegerArg(name, fallback) {
  const value = readValueArg(name);
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function loadEnvFile(path) {
  try {
    const content = readFileSync(resolve(repoRoot, path), 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
      if (!match) continue;
      const [, key, rawValue] = match;
      if (process.env[key] !== undefined) continue;
      process.env[key] = rawValue.replace(/^['"]|['"]$/g, '');
    }
  } catch {
    // .env is optional.
  }
}

function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}
