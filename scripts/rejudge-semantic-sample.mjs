#!/usr/bin/env node
// Re-judges a benchmark artifact's STORED candidates, several times each.
//
// The gate reads the minimum across repeats, and a run's repeats draw a fresh
// candidate AND a fresh reference every time — so raising them cannot tell a
// judge that wobbles from a candidate that is genuinely worse. This holds
// everything the judge sees fixed and varies only the judging, which is the
// only way to measure the instrument. Measured 2026-08-27 on gpt-5.5: ±3 points
// on a fixed candidate, and min and median never disagreed around the gate.
//
//   node scripts/rejudge-semantic-sample.mjs --artifact bench-results/<file>.json
//     [--repeats 5] [--case korean_incident_report] [--target proxy-codex]
import { readFile } from 'node:fs/promises';
import {
  assertSemanticQualityShape,
  semanticJudgePrompt,
  semanticQualityScoreSchema,
} from './lib/semantic-judge.mjs';

const options = parseArgs(process.argv.slice(2));
if (!options.artifact) {
  console.error('--artifact <bench-results/*.json> is required');
  process.exit(2);
}
if (!process.env.OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY is required: the judge is the direct API, as in a benchmark run');
  process.exit(2);
}

const artifact = JSON.parse(await readFile(options.artifact, 'utf8'));
const judgeModel = options.judgeModel ?? artifact.semanticQualityJudgeModel;
const gate = Number(options.minSemanticQuality ?? artifact.minSemanticQuality ?? 95);
const repeats = Number(options.repeats ?? 5);
// The prompts live with the cases, and the artifact does not carry them.
const runner = await readFile(new URL('./api-comparison-benchmark.mjs', import.meta.url), 'utf8');

const rows = (artifact.rows ?? []).filter((row) => (
  row.case?.includes('semantic_quality.')
  && row.sample?.semanticQuality
  && (!options.case || row.case.includes(options.case))
  && (!options.target || row.target === options.target)
));
if (rows.length === 0) {
  console.error('no judged semantic rows matched');
  process.exit(1);
}

const out = [];
for (const row of rows) {
  const caseId = row.case.split('semantic_quality.')[1];
  const prompt = promptFor(caseId);
  if (!prompt) {
    out.push({ case: caseId, target: row.target, error: 'prompt not found in the runner' });
    continue;
  }
  const scores = [];
  for (let attempt = 0; attempt < repeats; attempt += 1) {
    scores.push(await judge(row, prompt));
  }
  const absolute = scores.map((s) => s.score).sort((a, b) => a - b);
  const relative = scores.map((s) => s.relativeQuality).sort((a, b) => a - b);
  const gateScores = relative.every(Number.isFinite) ? relative : absolute;
  const median = gateScores[Math.floor(gateScores.length / 2)];
  out.push({
    case: caseId,
    target: row.target,
    storedScore: row.sample.semanticQuality.score,
    storedRelative: row.sample.semanticQuality.relativeQuality ?? null,
    absolute,
    relative,
    spread: gateScores.at(-1) - gateScores[0],
    minPasses: gateScores[0] >= gate,
    medianPasses: median >= gate,
    verdictsDisagree: (gateScores[0] >= gate) !== (median >= gate),
  });
}

console.log(JSON.stringify({
  artifact: options.artifact,
  judgeModel,
  gate,
  repeats,
  rows: out,
  // What the numbers are for: a spread that reaches the gate means a verdict
  // near it is not distinguishable from the instrument.
  maxSpread: Math.max(...out.filter((r) => !r.error).map((r) => r.spread), 0),
  rowsWhereMinAndMedianDisagree: out.filter((r) => r.verdictsDisagree).length,
}, null, 2));

function promptFor(caseId) {
  const at = runner.indexOf(`id: '${caseId}'`);
  if (at === -1) return null;
  const start = runner.indexOf('prompt: [', at);
  const end = runner.indexOf("].join(' ')", start);
  if (start === -1 || end === -1) return null;
  return runner.slice(start + 'prompt: ['.length, end)
    .split('\n')
    .map((line) => line.trim().replace(/^'/, '').replace(/',?$/, ''))
    .filter(Boolean)
    .join(' ');
}

async function judge(row, prompt) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: judgeModel,
      messages: [
        {
          role: 'system',
          content: [
            'You are a strict API benchmark judge.',
            'Score semantic answer quality for provider API compatibility tests.',
            'Return only JSON matching the requested schema.',
          ].join(' '),
        },
        {
          role: 'user',
          content: semanticJudgePrompt({
            target: row.target,
            caseName: row.case,
            prompt,
            text: row.sample.text,
            reference: row.sample.reference,
          }),
        },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'semantic_quality_score', strict: true, schema: semanticQualityScoreSchema() },
      },
      max_completion_tokens: 1600,
    }),
  });
  if (!response.ok) {
    throw new Error(`judge HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  const body = await response.json();
  const parsed = JSON.parse(body.choices?.[0]?.message?.content ?? 'null');
  assertSemanticQualityShape(parsed);
  return parsed;
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const [flag, inline] = arg.slice(2).split('=');
    const key = flag.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    parsed[key] = inline ?? (argv[i + 1]?.startsWith('--') ? 'true' : argv[++i]);
  }
  return parsed;
}
