#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { CodexBackendTransport } from '../dist/proxy/codex-backend-transport.js';

const execFileAsync = promisify(execFile);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
loadEnvFile('.env');

const args = process.argv.slice(2);
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = resolve(repoRoot, readValueArg('--out') ?? 'artifacts/image-runtime-poc');
const codexHome = resolve(readValueArg('--codex-home') ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'));
const model = readValueArg('--model') ?? 'gpt-5.5';
const repeats = positiveIntegerArg('--repeats', 1);
const timeoutMs = positiveIntegerArg('--timeout-ms', 240_000);
const cases = readCsvArg('--cases').length > 0 ? readCsvArg('--cases') : ['flat-webp', 'photo-jpeg'];
const skipQualityJudge = args.includes('--skip-quality-judge');
const judgeModel = readValueArg('--judge-model') ?? readValueArg('--openai-model') ?? 'gpt-5.5';

const tempDir = await mkdtemp(join(tmpdir(), 'image-runtime-poc-'));
await mkdir(outDir, { recursive: true });

const report = {
  generatedAt: new Date().toISOString(),
  repoRoot,
  codexHome,
  model,
  repeats,
  timeoutMs,
  judge: {
    enabled: !skipQualityJudge && Boolean(process.env.OPENAI_API_KEY),
    model: judgeModel,
    skippedReason: skipQualityJudge
      ? 'disabled by --skip-quality-judge'
      : process.env.OPENAI_API_KEY
        ? undefined
        : 'OPENAI_API_KEY missing',
  },
  authority: {
    generation: 'codex-backend OAuth image_generation',
    qualityJudge: 'OpenAI API only for benchmark judging',
    directProviderApiInRuntime: false,
  },
  cases: [],
};

try {
  const backend = new CodexBackendTransport({
    codexHome,
    model,
    timeoutMs,
  });
  for (const caseName of cases) {
    const spec = caseSpec(caseName);
    for (let repeat = 1; repeat <= repeats; repeat += 1) {
      const modelFormatted = await runModelFormattedVariant(backend, spec, repeat);
      const runtimeTransformed = await runRuntimeTransformedVariant(backend, spec, repeat);
      const summary = compareVariants(modelFormatted, runtimeTransformed);
      report.cases.push({
        case: spec.id,
        repeat,
        prompt: spec.prompt,
        size: spec.size,
        quality: spec.quality,
        targetFormat: spec.targetFormat,
        outputCompression: spec.outputCompression,
        variants: [modelFormatted, runtimeTransformed],
        comparison: summary,
      });
      process.stdout.write([
        `${spec.id} #${repeat}`,
        `model=${modelFormatted.totalMs}ms/${modelFormatted.detectedFormat}/q${qualityLabel(modelFormatted)}`,
        `runtime=${runtimeTransformed.totalMs}ms/${runtimeTransformed.detectedFormat}/q${qualityLabel(runtimeTransformed)}`,
        `runtime/model=${summary.runtimeToModelTotalPct}%`,
      ].join(' ') + '\n');
    }
  }
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

report.summary = summarizeReport(report.cases);
const jsonPath = join(outDir, `image-runtime-poc.${timestamp}.json`);
const markdownPath = join(outDir, `image-runtime-poc.${timestamp}.md`);
await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
await writeFile(markdownPath, renderMarkdown(report));
await writeFile(join(outDir, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`);
await writeFile(join(outDir, 'latest.md'), renderMarkdown(report));

process.stdout.write(`image runtime PoC report: ${jsonPath}\n`);
process.stdout.write(`image runtime PoC summary: ${markdownPath}\n`);

async function runModelFormattedVariant(backend, spec, repeat) {
  const request = imageRequest(spec, {
    outputFormat: spec.targetFormat,
    outputCompression: spec.outputCompression,
  });
  const startedAt = Date.now();
  const result = await backend.generate(request);
  const modelMs = Date.now() - startedAt;
  const image = firstImage(result);
  return await finalizeVariant({
    id: 'model-formatted',
    spec,
    repeat,
    image,
    modelMs,
    transformMs: 0,
    totalMs: modelMs,
    requestedModelOutputFormat: spec.targetFormat,
    requestedSurfaceFormat: spec.targetFormat,
    notes: ['backend image_generation receives output_format/output_compression directly'],
  });
}

async function runRuntimeTransformedVariant(backend, spec, repeat) {
  const request = imageRequest(spec, {
    outputFormat: undefined,
    outputCompression: undefined,
  });
  const startedAt = Date.now();
  const result = await backend.generate(request);
  const modelMs = Date.now() - startedAt;
  const image = firstImage(result);
  const transformStartedAt = Date.now();
  const transformed = await transformImageWithPillow({
    b64Json: image.b64Json,
    targetFormat: spec.targetFormat,
    outputCompression: spec.outputCompression,
  });
  const transformMs = Date.now() - transformStartedAt;
  return await finalizeVariant({
    id: 'runtime-transformed',
    spec,
    repeat,
    image: { ...image, b64Json: transformed.b64Json },
    modelMs,
    transformMs,
    totalMs: modelMs + transformMs,
    requestedModelOutputFormat: 'backend-default',
    requestedSurfaceFormat: spec.targetFormat,
    canonical: transformed.input,
    notes: ['backend image_generation omits output_format/output_compression; runtime converts final image bytes'],
  });
}

async function finalizeVariant(input) {
  const buffer = Buffer.from(stripDataUrl(input.image.b64Json), 'base64');
  const detectedFormat = detectImageFormat(buffer);
  const mediaType = mediaTypeForFormat(detectedFormat);
  const imagePath = await saveImageArtifact(input.spec, input.repeat, input.id, buffer, detectedFormat);
  const quality = report.judge.enabled
    ? await scoreImageQuality({
        prompt: input.spec.prompt,
        requirements: input.spec.requirements,
        b64Json: buffer.toString('base64'),
        mediaType,
        kind: 'image generation',
      })
    : null;
  return {
    id: input.id,
    modelMs: input.modelMs,
    transformMs: input.transformMs,
    totalMs: input.totalMs,
    requestedModelOutputFormat: input.requestedModelOutputFormat,
    requestedSurfaceFormat: input.requestedSurfaceFormat,
    detectedFormat,
    surfaceFormatMatches: detectedFormat === normalizeFormat(input.requestedSurfaceFormat),
    bytes: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    revisedPrompt: input.image.revisedPrompt ?? '',
    imagePath,
    ...(input.canonical ? { canonical: input.canonical } : {}),
    ...(quality ? { imageQuality: quality } : {}),
    notes: input.notes,
  };
}

async function transformImageWithPillow({ b64Json, targetFormat, outputCompression }) {
  const inputBuffer = Buffer.from(stripDataUrl(b64Json), 'base64');
  const inputFormat = detectImageFormat(inputBuffer);
  const inputPath = join(tempDir, `input-${Date.now()}-${Math.random().toString(16).slice(2)}.${extensionForFormat(inputFormat)}`);
  const outputPath = join(tempDir, `output-${Date.now()}-${Math.random().toString(16).slice(2)}.${extensionForFormat(targetFormat)}`);
  await writeFile(inputPath, inputBuffer);
  const python = [
    'from PIL import Image',
    'import sys',
    'src, dst, fmt, quality_s = sys.argv[1:5]',
    'quality = int(quality_s) if quality_s else 90',
    'img = Image.open(src)',
    'fmt = fmt.lower()',
    'if fmt in ("jpeg", "jpg") and img.mode in ("RGBA", "LA", "P"):',
    '    base = Image.new("RGB", img.size, (255, 255, 255))',
    '    rgba = img.convert("RGBA")',
    '    base.paste(rgba, mask=rgba.getchannel("A"))',
    '    img = base',
    'elif fmt in ("webp", "png") and img.mode not in ("RGB", "RGBA"):',
    '    img = img.convert("RGBA")',
    'save_fmt = "JPEG" if fmt in ("jpeg", "jpg") else fmt.upper()',
    'kwargs = {}',
    'if save_fmt in ("JPEG", "WEBP"):',
    '    kwargs["quality"] = quality',
    '    kwargs["optimize"] = True',
    'if save_fmt == "WEBP":',
    '    kwargs["method"] = 4',
    'img.save(dst, save_fmt, **kwargs)',
  ].join('\n');
  await execFileAsync('python3', ['-c', python, inputPath, outputPath, normalizeFormat(targetFormat), String(outputCompression ?? 90)], {
    timeout: 60_000,
    maxBuffer: 4_000_000,
  });
  const outputBuffer = await readFile(outputPath);
  return {
    b64Json: outputBuffer.toString('base64'),
    input: {
      detectedFormat: inputFormat,
      bytes: inputBuffer.length,
    },
  };
}

function imageRequest(spec, options) {
  return {
    operation: 'generation',
    model: 'image-2',
    prompt: spec.prompt,
    n: 1,
    images: [],
    size: spec.size,
    quality: spec.quality,
    ...(options.outputFormat ? { outputFormat: options.outputFormat } : {}),
    ...(options.outputCompression !== undefined ? { outputCompression: options.outputCompression } : {}),
    responseFormat: 'b64_json',
    stream: false,
    partialImages: 0,
    raw: {},
  };
}

function firstImage(result) {
  const image = result.images?.[0];
  if (!image?.b64Json) throw new Error('image_generation result did not include b64_json');
  return image;
}

function caseSpec(name) {
  if (name === 'flat-webp') {
    return {
      id: name,
      prompt: 'Create a simple flat red square centered on a plain white background. No text.',
      requirements: ['flat red square', 'plain white background', 'no text', 'centered composition'],
      size: '1024x1024',
      quality: 'low',
      targetFormat: 'webp',
      outputCompression: 80,
    };
  }
  if (name === 'photo-jpeg') {
    return {
      id: name,
      prompt: 'Create a realistic studio product photo of a matte black ceramic mug on a light gray tabletop with soft natural shadows. No text or logo.',
      requirements: ['realistic black ceramic mug', 'light gray tabletop', 'soft natural shadows', 'no text', 'no logo'],
      size: '1024x1024',
      quality: 'medium',
      targetFormat: 'jpeg',
      outputCompression: 85,
    };
  }
  throw new Error(`unknown PoC case: ${name}. Supported cases: flat-webp, photo-jpeg`);
}

async function saveImageArtifact(spec, repeat, variant, buffer, format) {
  const path = join(outDir, `${spec.id}.${repeat}.${variant}.${extensionForFormat(format)}`);
  await writeFile(path, buffer);
  return path;
}

function compareVariants(modelFormatted, runtimeTransformed) {
  const runtimeToModelTotalPct = ratioPct(runtimeTransformed.totalMs, modelFormatted.totalMs);
  const runtimeToModelModelMsPct = ratioPct(runtimeTransformed.modelMs, modelFormatted.modelMs);
  const runtimeToModelBytesPct = ratioPct(runtimeTransformed.bytes, modelFormatted.bytes);
  const modelQuality = modelFormatted.imageQuality?.score;
  const runtimeQuality = runtimeTransformed.imageQuality?.score;
  return {
    runtimeToModelTotalPct,
    runtimeToModelModelMsPct,
    runtimeToModelBytesPct,
    totalMsDelta: runtimeTransformed.totalMs - modelFormatted.totalMs,
    modelMsDelta: runtimeTransformed.modelMs - modelFormatted.modelMs,
    bytesDelta: runtimeTransformed.bytes - modelFormatted.bytes,
    qualityDelta: Number.isFinite(modelQuality) && Number.isFinite(runtimeQuality)
      ? runtimeQuality - modelQuality
      : null,
  };
}

function summarizeReport(cases) {
  const byCase = [];
  for (const name of [...new Set(cases.map((item) => item.case))]) {
    const rows = cases.filter((item) => item.case === name);
    byCase.push({
      case: name,
      repeats: rows.length,
      runtimeToModelTotalPctMedian: median(rows.map((item) => item.comparison.runtimeToModelTotalPct)),
      runtimeToModelModelMsPctMedian: median(rows.map((item) => item.comparison.runtimeToModelModelMsPct)),
      runtimeToModelBytesPctMedian: median(rows.map((item) => item.comparison.runtimeToModelBytesPct)),
      qualityDeltaMedian: median(rows.map((item) => item.comparison.qualityDelta).filter(Number.isFinite)),
      modelSurfacePasses: rows.filter((item) => item.variants[0]?.surfaceFormatMatches).length,
      runtimeSurfacePasses: rows.filter((item) => item.variants[1]?.surfaceFormatMatches).length,
    });
  }
  return { byCase };
}

function renderMarkdown(value) {
  const lines = [
    '# Image Runtime Pipeline PoC',
    '',
    `Generated: ${value.generatedAt}`,
    '',
    '| Case | Repeats | Runtime/Model total | Runtime/Model model time | Runtime/Model bytes | Quality delta | Model surface | Runtime surface |',
    '|---|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const item of value.summary.byCase) {
    lines.push([
      item.case,
      item.repeats,
      pctCell(item.runtimeToModelTotalPctMedian),
      pctCell(item.runtimeToModelModelMsPctMedian),
      pctCell(item.runtimeToModelBytesPctMedian),
      item.qualityDeltaMedian ?? 'N/A',
      `${item.modelSurfacePasses}/${item.repeats}`,
      `${item.runtimeSurfacePasses}/${item.repeats}`,
    ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
  }
  lines.push('', '## Runs', '');
  for (const row of value.cases) {
    lines.push(`### ${row.case} #${row.repeat}`, '');
    lines.push('| Variant | totalMs | modelMs | transformMs | detected | bytes | quality | image |');
    lines.push('|---|---:|---:|---:|---|---:|---:|---|');
    for (const variant of row.variants) {
      lines.push([
        variant.id,
        variant.totalMs,
        variant.modelMs,
        variant.transformMs,
        `${variant.detectedFormat}${variant.surfaceFormatMatches ? '' : ' (surface mismatch)'}`,
        variant.bytes,
        variant.imageQuality?.score ?? 'N/A',
        variant.imagePath,
      ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

async function scoreImageQuality(spec) {
  const startedAt = Date.now();
  const response = await postJson('https://api.openai.com/v1/chat/completions', {
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
      {
        role: 'user',
        content: imageQualityJudgeContent(spec),
      },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'image_quality_score',
        strict: true,
        schema: imageQualityScoreSchema(),
      },
    },
    max_completion_tokens: 1200,
  }, {
    authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    'Content-Type': 'application/json',
  });
  const parsed = JSON.parse(response.body.choices?.[0]?.message?.content ?? '{}');
  return {
    ...parsed,
    judgeMs: Date.now() - startedAt,
    usage: response.body.usage,
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
    `Operation: ${spec.kind ?? 'image generation'}`,
    'Original request:',
    spec.prompt,
    `Requirements: ${(spec.requirements ?? []).join('; ')}`,
    [
      'Rubric:',
      '- requirementFit: visible satisfaction of the explicit request and listed requirements.',
      '- visualCorrectness: correct objects, colors, composition, background, aspect, and style.',
      '- artifactControl: no blank/corrupt output, obvious distortions, duplicate artifacts, or malformed geometry.',
      '- textAccuracy: visible text is absent when forbidden, or legible and spelled correctly when requested.',
      '- preservation: for pure generation without references, score 100 unless preservation is applicable.',
      'Overall score is 0 to 100. Penalize hard for blank images, wrong primary object/color, unwanted text, or compression artifacts that harm the output.',
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

async function postJson(url, body, headers) {
  const startedAt = Date.now();
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  if (!response.ok) {
    throw new Error(`POST ${url} failed ${response.status}: ${text.slice(0, 500)}`);
  }
  return {
    status: response.status,
    totalMs: Date.now() - startedAt,
    body: parsed,
  };
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
  if (format === 'jpeg' || format === 'jpg') return 'image/jpeg';
  if (format === 'webp') return 'image/webp';
  return 'image/png';
}

function extensionForFormat(format) {
  const normalized = normalizeFormat(format);
  if (normalized === 'jpeg') return 'jpg';
  if (normalized === 'webp') return 'webp';
  return 'png';
}

function normalizeFormat(value) {
  if (value === 'jpg') return 'jpeg';
  if (value === 'webp') return 'webp';
  return value === 'jpeg' ? 'jpeg' : 'png';
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

function ratioPct(value, base) {
  if (!Number.isFinite(value) || !Number.isFinite(base) || base === 0) return null;
  return Math.round((value / base) * 1000) / 10;
}

function median(values) {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function pctCell(value) {
  return Number.isFinite(value) ? `${value}%` : 'N/A';
}

function qualityLabel(variant) {
  return variant.imageQuality?.score ?? 'N/A';
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
    // .env is optional for this PoC.
  }
}
