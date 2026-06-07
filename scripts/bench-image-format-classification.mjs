#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { CodexBackendTransport } from '../dist/proxy/codex-backend-transport.js';

const args = process.argv.slice(2);
const repoRoot = resolve(new URL('..', import.meta.url).pathname);
loadEnvFile('.env');

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = resolve(repoRoot, readValueArg('--out') ?? 'artifacts/image-format-classification');
const codexHome = resolve(readValueArg('--codex-home') ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'));
const model = readValueArg('--model') ?? 'gpt-5.5';
const judgeModel = readValueArg('--judge-model') ?? 'gpt-5.5';
const repeats = positiveIntegerArg('--repeats', 5);
const timeoutMs = positiveIntegerArg('--timeout-ms', 240_000);
const skipQualityJudge = args.includes('--skip-quality-judge');
const classFilters = readCsvArg('--classes');
const formatFilters = readCsvArg('--formats');
const formats = (formatFilters.length > 0 ? formatFilters : ['default', 'png', 'jpeg', 'webp'])
  .map((format) => format === 'omitted' ? 'default' : format);
const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

await mkdir(outDir, { recursive: true });

const sourceFixture = editSourceFixture();
const cases = benchmarkCases(sourceFixture)
  .filter((item) => classFilters.length === 0 || classFilters.includes(item.id));
if (cases.length === 0) {
  throw new Error(`No benchmark classes matched --classes=${classFilters.join(',')}`);
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
const jsonPath = join(outDir, `image-format-classification-${repeats}x.${timestamp}.json`);
const markdownPath = join(outDir, `image-format-classification-${repeats}x.${timestamp}.md`);

for (let repeat = 1; repeat <= repeats; repeat += 1) {
  for (const spec of cases) {
    for (const format of formats) {
      const row = await runOne({ backend, spec, format, repeat });
      report.rows.push(row);
      report.summary = summarize(report.rows);
      await writeArtifacts(report, jsonPath, markdownPath);
      process.stdout.write(JSON.stringify({
        repeat: row.repeat,
        class: row.class,
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
process.stdout.write(`${JSON.stringify(report.summary, null, 2)}\n`);

async function runOne({ backend, spec, format, repeat }) {
  const startedAt = Date.now();
  try {
    const request = imageRequest(spec, format);
    const result = await backend.generate(request);
    const image = result.images?.[0];
    if (!image?.b64Json) throw new Error('missing image b64Json');
    const buffer = Buffer.from(stripDataUrl(image.b64Json), 'base64');
    const detectedFormat = detectImageFormat(buffer);
    const imagePath = join(
      outDir,
      `${timestamp}.${repeat}.${spec.id}.${format}.${extensionForFormat(detectedFormat)}`,
    );
    await writeFile(imagePath, buffer);
    const imageQuality = report.judge.enabled
      ? await scoreImageQuality({
          operation: spec.operation,
          prompt: spec.prompt,
          requirements: spec.requirements,
          referenceImages: spec.referenceImages,
          b64Json: buffer.toString('base64'),
          mediaType: mediaTypeForFormat(detectedFormat),
        })
      : null;
    return {
      ok: true,
      repeat,
      class: spec.id,
      operation: spec.operation,
      requestedFormat: format,
      totalMs: Date.now() - startedAt,
      detectedFormat,
      surfaceMatches: format === 'default' || detectedFormat === normalizeFormat(format),
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
      class: spec.id,
      operation: spec.operation,
      requestedFormat: format,
      totalMs: Date.now() - startedAt,
      error: errorMessage(err),
    };
  }
}

function imageRequest(spec, format) {
  return {
    operation: spec.operation,
    model: 'image-2',
    prompt: spec.prompt,
    n: 1,
    images: spec.images ?? [],
    size: spec.size,
    quality: spec.quality,
    ...(format !== 'default' ? { outputFormat: format } : {}),
    ...(format === 'jpeg' || format === 'webp' ? { outputCompression: 85 } : {}),
    responseFormat: 'b64_json',
    stream: false,
    partialImages: 0,
    raw: {},
  };
}

function benchmarkCases(sourceFixture) {
  return [
    {
      id: 'simpleFlatGraphic',
      operation: 'generation',
      prompt: 'Create a simple flat red square centered on a plain white background. No text.',
      requirements: ['flat red square', 'plain white background', 'no text', 'centered composition'],
      size: '1024x1024',
      quality: 'low',
    },
    {
      id: 'textOrLogoGraphic',
      operation: 'generation',
      prompt: 'Create a clean flat promotional poster with the exact word SALE in large bold black letters centered on a white background, plus one small red circle below it. No other text.',
      requirements: ['exact word SALE', 'large bold black letters', 'white background', 'one small red circle', 'no other text'],
      size: '1024x1024',
      quality: 'medium',
    },
    {
      id: 'photorealRaster',
      operation: 'generation',
      prompt: 'Create a realistic studio product photo of a matte black ceramic mug on a light gray tabletop with soft natural shadows. No text or logo.',
      requirements: ['realistic black ceramic mug', 'light gray tabletop', 'soft natural shadows', 'no text', 'no logo'],
      size: '1024x1024',
      quality: 'medium',
    },
    {
      id: 'productIdentity',
      operation: 'generation',
      prompt: 'Create a realistic product packshot of a transparent glass perfume bottle with a square black cap, a thin gold band around the neck, and pale amber liquid inside. Plain light gray background. No text or logo.',
      requirements: ['transparent glass perfume bottle', 'square black cap', 'thin gold band', 'pale amber liquid', 'plain light gray background', 'no text', 'no logo'],
      size: '1024x1024',
      quality: 'medium',
    },
    {
      id: 'referenceOrEdit',
      operation: 'edit',
      prompt: 'Edit the provided image so only the red square becomes green. Keep the blue circle, white background, object positions, sizes, and all other details unchanged. No text.',
      requirements: ['red square changed to green', 'blue circle preserved', 'white background preserved', 'positions and sizes unchanged', 'no text'],
      images: [{
        source: {
          type: 'base64',
          mediaType: 'image/png',
          data: sourceFixture.b64Json,
        },
        raw: {},
      }],
      referenceImages: [`data:image/png;base64,${sourceFixture.b64Json}`],
      size: '1024x1024',
      quality: 'medium',
    },
    {
      id: 'unknownHybrid',
      operation: 'generation',
      prompt: 'Create a semi-realistic isometric illustration of a compact smart speaker on a desk, with clean geometric background shapes, soft shadows, and no text.',
      requirements: ['semi-realistic isometric illustration', 'compact smart speaker', 'desk', 'geometric background shapes', 'soft shadows', 'no text'],
      size: '1024x1024',
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
            'Score only what is visible in the candidate image against the request.',
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
  const content = [{ type: 'text', text: imageQualityJudgePrompt(spec) }];
  for (const [index, image] of (spec.referenceImages ?? []).entries()) {
    content.push({ type: 'text', text: `Reference/source image ${index + 1}:` });
    content.push({ type: 'image_url', image_url: { url: image, detail: 'high' } });
  }
  content.push({ type: 'text', text: 'Candidate output image to score:' });
  content.push({
    type: 'image_url',
    image_url: {
      url: `data:${spec.mediaType};base64,${spec.b64Json}`,
      detail: 'high',
    },
  });
  return content;
}

function imageQualityJudgePrompt(spec) {
  return [
    `Operation: ${spec.operation}`,
    'Original request:',
    spec.prompt,
    `Requirements: ${(spec.requirements ?? []).join('; ')}`,
    (spec.referenceImages ?? []).length > 0
      ? 'Reference/source images are provided before the candidate. For edits, penalize any unrequested change to preserved objects, positions, sizes, colors, or background.'
      : 'Reference/source images: none.',
    [
      'Rubric:',
      '- requirementFit: visible satisfaction of the explicit request and listed requirements.',
      '- visualCorrectness: correct objects, colors, composition, style, background, and aspect.',
      '- artifactControl: no blank/corrupt output, obvious distortions, malformed edges, compression artifacts, or geometry problems.',
      '- textAccuracy: visible text is absent when forbidden, or legible and spelled exactly when requested.',
      '- preservation: for edits/reference-guided cases, preserve requested source/reference details; for pure generation without references, score 100 unless preservation is applicable.',
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
      preservation: { type: 'integer' },
      rationale: { type: 'string' },
      issues: { type: 'array', items: { type: 'string' } },
    },
    required: [
      'score',
      'requirementFit',
      'visualCorrectness',
      'artifactControl',
      'textAccuracy',
      'preservation',
      'rationale',
      'issues',
    ],
  };
}

function summarize(rows) {
  const groups = [];
  for (const className of unique(rows.map((row) => row.class))) {
    for (const format of unique(rows.filter((row) => row.class === className).map((row) => row.requestedFormat))) {
      const groupRows = rows.filter((row) => row.class === className && row.requestedFormat === format);
      const okRows = groupRows.filter((row) => row.ok);
      groups.push({
        class: className,
        requestedFormat: format,
        count: groupRows.length,
        ok: okRows.length,
        detectedFormats: countBy(okRows.map((row) => row.detectedFormat)),
        surfaceMatches: okRows.filter((row) => row.surfaceMatches).length,
        totalMs: stats(okRows.map((row) => row.totalMs)),
        bytes: stats(okRows.map((row) => row.bytes)),
        score: stats(okRows.map((row) => row.imageQuality?.score).filter(Number.isFinite)),
      });
    }
  }
  return groups;
}

async function writeArtifacts(report, jsonPath, markdownPath) {
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(outDir, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(markdownPath, renderMarkdown(report));
  await writeFile(join(outDir, 'latest.md'), renderMarkdown(report));
}

function renderMarkdown(report) {
  const lines = [
    '# Image Format Classification Benchmark',
    '',
    `Generated: ${report.generatedAt}`,
    '',
    '| Class | Format | Count | OK | totalMs median | totalMs min-max | score median | score min-max | bytes median |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const row of report.summary ?? []) {
    lines.push([
      row.class,
      row.requestedFormat,
      row.count,
      row.ok,
      row.totalMs?.median ?? 'N/A',
      row.totalMs ? `${row.totalMs.min}-${row.totalMs.max}` : 'N/A',
      row.score?.median ?? 'N/A',
      row.score ? `${row.score.min}-${row.score.max}` : 'N/A',
      row.bytes?.median ?? 'N/A',
    ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
  }
  return `${lines.join('\n')}\n`;
}

function editSourceFixture() {
  const width = 512;
  const height = 512;
  const stride = 1 + width * 4;
  const rows = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    rows[y * stride] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = y * stride + 1 + x * 4;
      rows[offset] = 255;
      rows[offset + 1] = 255;
      rows[offset + 2] = 255;
      rows[offset + 3] = 255;
      if (x >= 80 && x <= 240 && y >= 120 && y <= 280) {
        rows[offset] = 220;
        rows[offset + 1] = 30;
        rows[offset + 2] = 30;
      }
      const dx = x - 350;
      const dy = y - 250;
      if (dx * dx + dy * dy <= 80 * 80) {
        rows[offset] = 35;
        rows[offset + 1] = 105;
        rows[offset + 2] = 220;
      }
    }
  }
  return { b64Json: pngFromFilteredRgbaRows(width, height, rows).toString('base64') };
}

function pngFromFilteredRgbaRows(width, height, rows) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(rows)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function pngChunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])), 0);
  return Buffer.concat([length, name, data, crc]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
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
