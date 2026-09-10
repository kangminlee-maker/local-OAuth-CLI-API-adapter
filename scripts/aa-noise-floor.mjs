#!/usr/bin/env node
// The A/A noise floor: ask each vendor the SAME thing many times and measure how
// much it varies against itself.
//
// `docs/conformance-suite-design.md` has said since 2026-08-28 that the length
// axis of the direct-vs-proxy comparison is not a verdict until this exists:
// "vendor 대 vendor 분산이 측정하려는 효과만큼 크면 그 축은 판정 불가로 보고한다."
// The control taken that day used three samples per row — enough to see the
// variance, not to bound it.
//
// This file hardcodes the vendor URLs on purpose. Making them overridable would
// let a local fake produce an artifact that claims to be a vendor's own
// variance, and that number is about to decide whether other numbers mean
// anything. The part a test can drive is `scripts/lib/aa-sampler.mjs`, which
// takes its URL as a parameter; `test/aa-sampler.test.mjs` calls it.
//
// It refuses to make a call without `--live`. A plan is the default because the
// spend is real and metered, and a run that starts by accident is exactly what
// happened to the benchmark runner once already.
//
// Usage:
//   node scripts/aa-noise-floor.mjs                        # plan only, no calls
//   node scripts/aa-noise-floor.mjs --live [--reps 24] [--resume <state.json>]
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startCaptureRun, captureSummary } from './lib/capture-recorder.mjs';
import { qualityTasks, qualityTasksDigest } from './lib/quality-tasks.mjs';
import { abortedRow, defaultArtifactName, ledgerFor, noiseFloor, resumePlan, SamplingAbort, sampleRow, summarise, takeSample } from './lib/aa-sampler.mjs';
import { acquireStateLock, canonicalStatePath } from './lib/state-lock.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const num = (name, fallback) => {
  const value = opt(name, null);
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number, got ${value}`);
  return parsed;
};

const live = flag('--live');
// The design's sequential rule, in the design's own numbers: start at 24, stop
// when the interval decides, cap at 60 (`docs/conformance-suite-design.md`
// §"릴리즈 코호트는 vendor당 24개에서 시작해 60개를 상한으로 순차 표집"). The first version
// shipped 12/24 — half of both — directly under a comment quoting 24/60, so a
// row could stop at 12 and could never reach 25. The 2026-09-10 run was taken
// at those halved numbers and its artifact records them in `plan`.
const reps = num('--reps', 60);
const minReps = num('--min-reps', 24);
// "Decides" here is the 95% interval for the mean being inside this many
// percent of the mean.
const decisivePct = num('--decisive-pct', 3);
const budgetCalls = num('--budget', null);
const openAiModel = opt('--openai-model', 'gpt-5.6-terra');
const anthropicModel = opt('--anthropic-model', 'claude-sonnet-5');
const maxTokens = num('--max-tokens', 1536);
const resumePath = opt('--resume', null);
// Re-read a finished run's artifact and print its floor. Makes no vendor call.
const reportPath = opt('--report', null);
// A substring filter over `provider/task`, so the wiring can be proved on two
// calls before four hundred and eighty are committed to it.
const only = opt('--only', null);
// The name carries `--only`, because the artifact needs the same protection the
// ledger got and for the same reason. `--only` exists to partition a batch
// across processes; with a name that carried the date alone, two partitions of
// one batch — hundreds of metered calls each — wrote the same file and the
// second erased the first. Worse after the state lock than before it: the lock
// refuses two runs on one ledger, so the only way left to partition is separate
// ledgers, which is exactly the configuration where the artifacts collide.
const outPath = opt('--out', resolve(repoRoot, 'bench-results', defaultArtifactName(new Date(), only)));
// A ledger is a consequence of SPENDING, not of a flag: a live run without
// `--resume` used to keep every paid observation in memory until the last row,
// so an interrupt lost all of them. Canonical from here down — the lock, the
// reads and the writes all have to mean the same inode.
const statePath = canonicalStatePath(ledgerFor({ resume: resumePath, live, outPath }));

// Published list prices, read 2026-09-10 from developers.openai.com/api/docs/pricing
// and platform.claude.com/docs/en/about-claude/pricing. They are here so the plan
// can price itself before it spends anything; they are NOT authoritative, and a
// run's real cost is whatever the invoice says.
const PRICES = {
  'gpt-5.6-terra': { inPerM: 2, outPerM: 12 },
  'gpt-5.6-sol': { inPerM: 4, outPerM: 20 },
  'gpt-5.6-luna': { inPerM: 0.2, outPerM: 1.2 },
  'claude-sonnet-5': { inPerM: 2, outPerM: 10 },
  'claude-opus-5': { inPerM: 5, outPerM: 25 },
  'claude-haiku-4-5': { inPerM: 1, outPerM: 5 },
};

const PROVIDERS = {
  openai: {
    url: 'https://api.openai.com/v1/chat/completions',
    model: openAiModel,
    headers: () => ({
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'content-type': 'application/json',
    }),
    body: (prompt) => JSON.stringify({
      model: openAiModel,
      messages: [{ role: 'user', content: prompt }],
      max_completion_tokens: maxTokens,
    }),
    // Measured, not assumed: a two-call smoke on 2026-09-10 billed a
    // 1070-character prompt at 213 input tokens and a 365-character answer at 72
    // output tokens. The earlier estimate used one ratio for both vendors and
    // was wrong about this one in the cheap direction.
    charsPerToken: { in: 5.02, out: 5.07 },
    // Sampling controls are left at their defaults ON PURPOSE: this measures the
    // vendor as the comparison actually calls it, and pinning temperature would
    // measure a configuration nothing else uses.
    readAnswer: (parsed) => ({
      text: parsed.choices?.[0]?.message?.content ?? '',
      outputTokens: parsed.usage?.completion_tokens ?? null,
      thinkingTokens: parsed.usage?.completion_tokens_details?.reasoning_tokens ?? null,
      stopReason: parsed.choices?.[0]?.finish_reason ?? null,
    }),
  },
  anthropic: {
    url: 'https://api.anthropic.com/v1/messages',
    model: anthropicModel,
    headers: () => ({
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    }),
    body: (prompt) => JSON.stringify({
      model: anthropicModel,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
    // Measured on the same smoke: 367 input tokens for that prompt, and 290
    // OUTPUT tokens for a 405-character answer — because 154 of them were
    // thinking tokens that never appear in the text. Billed as output all the
    // same, so the price has to count them, and a ratio derived from visible
    // characters is the only honest way to carry them here.
    charsPerToken: { in: 2.92, out: 1.40 },
    readAnswer: (parsed) => ({
      text: parsed.content?.find((block) => block.type === 'text')?.text ?? '',
      outputTokens: parsed.usage?.output_tokens ?? null,
      thinkingTokens: parsed.usage?.output_tokens_details?.thinking_tokens ?? null,
      stopReason: parsed.stop_reason ?? null,
    }),
  },
};

const tasks = qualityTasks();
const rows = [];
for (const provider of Object.keys(PROVIDERS)) {
  for (const task of tasks) {
    if (only && !`${provider}/${task.id}`.includes(only)) continue;
    rows.push({ provider, task: task.id, prompt: task.prompt });
  }
}
if (rows.length === 0) {
  console.error(`--only ${only} matched no row; nothing to measure`);
  process.exit(2);
}

// The worst case by default: a budget larger than the plan cannot stop anything,
// and one smaller is a deliberate cap the operator asked for.
const budgetTotal = budgetCalls ?? rows.length * reps;

const plan = {
  rows: rows.length,
  reps,
  minReps,
  decisivePct,
  worstCaseCalls: rows.length * reps,
  budgetCalls: budgetTotal,
  openAiModel,
  anthropicModel,
  maxTokens,
  tasksDigest: qualityTasksDigest(),
  only,
};

/**
 * What the plan costs at list price, from measured token ratios.
 *
 * Observed answer lengths come from the 2026-08-28 control — the same rows, the
 * same prompts — so this is an estimate with its inputs named rather than a
 * guess. It is an UPPER bound in calls: every row taking all `reps`.
 */
function estimate() {
  const observed = existsSync(resolve(repoRoot, 'bench-results/aa-control-terra-sonnet5-20260828.json'))
    ? JSON.parse(readFileSync(resolve(repoRoot, 'bench-results/aa-control-terra-sonnet5-20260828.json'), 'utf8'))
    : null;
  const answerChars = {};
  for (const row of observed?.rows ?? []) {
    answerChars[row.provider] ??= {};
    answerChars[row.provider][row.task] = row.mean;
  }
  const lines = [];
  let usd = 0;
  for (const provider of new Set(rows.map((row) => row.provider))) {
    const vendor = PROVIDERS[provider];
    const price = PRICES[vendor.model];
    const mine = rows.filter((row) => row.provider === provider);
    const inTokens = mine.reduce((total, row) => total + row.prompt.length / vendor.charsPerToken.in, 0) * reps;
    // A row with no prior observation is priced at the observed mean, not at
    // zero: an unmeasured row is unknown, and unknown is not free.
    const means = Object.values(answerChars[provider] ?? {});
    const fallback = means.length ? means.reduce((a, b) => a + b, 0) / means.length : 800;
    const outTokens = mine.reduce(
      (total, row) => total + (answerChars[provider]?.[row.task] ?? fallback) / vendor.charsPerToken.out, 0) * reps;
    const cost = price
      ? (inTokens / 1e6) * price.inPerM + (outTokens / 1e6) * price.outPerM
      : null;
    if (cost !== null) usd += cost;
    lines.push({
      provider,
      model: vendor.model,
      priced: Boolean(price),
      calls: mine.length * reps,
      inputTokens: Math.round(inTokens),
      outputTokens: Math.round(outTokens),
      usd: cost === null ? null : Number(cost.toFixed(2)),
    });
  }
  return { perProvider: lines, usdTotal: Number(usd.toFixed(2)), pricesReadAt: '2026-09-10' };
}

// Re-derive the floor from a finished run's own samples. It makes no call — the
// samples are already on disk, and a reading that has to be re-taken to be
// re-read is a reading that costs money to correct. This exists because the
// first published floor covered one of the three series, and the run that
// produced it had already recorded all three.
if (reportPath) {
  const artifact = JSON.parse(readFileSync(resolve(reportPath), 'utf8'));
  console.log(JSON.stringify(noiseFloor(artifact.rows ?? []), null, 2));
  process.exit(0);
}

// One writer per state file. Without this, two invocations each start from the
// same ledger and each spend the whole ceiling — and because `saveState()`
// writes the WHOLE state object from its own snapshot, the second writer erases
// rows the first had paid for. Through `--only`, which exists to partition a
// batch across processes, that is the ordinary way to run it.
const hold = (path, what, options = {}) => {
  const { lockPath, heldBy, release } = acquireStateLock(path, options);
  if (!release) {
    console.error(`another run holds ${lockPath} (pid ${heldBy}). `
      + `Two runs sharing one ${what} each spend the whole budget and the second erases the `
      + "first's rows. If that process is gone, delete the lock deliberately.");
    process.exit(1);
  }
  process.on('exit', release);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => { release(); process.exit(130); });
  }
};

if (statePath) hold(statePath, 'state file');
// Taken whether or not there is a ledger. A partitioned run without `--resume`
// is the shortest way to run one, and it used to take no lock at all — while
// still writing the artifact every partition writes.
// `create: false` — the artifact must NOT exist, and a lock that made a
// placeholder would be this run refusing itself one line later.
if (live) hold(outPath, 'artifact', { create: false });
if (live && existsSync(outPath)) {
  console.error(`${outPath} already exists. Writing it would erase a run that has already been paid `
    + 'for; pass --out with a name of your own, or move the old artifact aside deliberately.');
  process.exit(1);
}

const state = statePath && existsSync(statePath)
  ? JSON.parse(readFileSync(statePath, 'utf8'))
  : { rows: {}, spent: 0 };
const saveState = () => {
  if (!statePath) return;
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
};

// A row whose state predates whole samples cannot say what its calls MEASURED —
// only how long their answers were. `sampleRow` refuses such a row, but only if
// it is handed one: reading `?.samples ?? []` turned a legacy row into an empty
// one, which then overwrote the observations it could not read. Losing paid
// measurements is worse than refusing to start.
const resume = resumePlan(state, budgetTotal);
const legacyRows = resume.legacy;
if (legacyRows.length > 0) {
  console.error(`this state file holds ${legacyRows.length} row(s) recorded before whole samples were kept `
    + `(${legacyRows.join(', ')}). They carry character lengths and no token, thinking or latency readings, `
    + 'so resuming them would report a partly-restored series as a complete one. Re-run those rows, or drop '
    + 'them from the state file deliberately.');
  process.exit(1);
}

// The budget is a property of the RUN, not of an invocation. It used to be
// rebuilt at full size every time the process started, so a resumed run spent
// the whole batch again — and again — while each invocation truthfully reported
// having spent its share. The ledger travels with the state.
if (state.spent === undefined) state.spent = 0;

if (!live) {
  const cost = estimate();
  console.log(JSON.stringify({ plan, cost, wouldWrite: outPath, note: 'no call was made; pass --live to run' }, null, 2));
  console.log(`\n${plan.worstCaseCalls} live vendor calls at worst (${rows.length} rows × ${reps}), `
    + `fewer if rows settle inside ±${decisivePct}% of their mean after ${minReps}.`);
  console.log(`Estimated list-price cost at the worst case: $${cost.usdTotal.toFixed(2)}.`);
  if (cost.perProvider.some((line) => !line.priced)) {
    console.log('A model in this plan has no published price on file; its cost is NOT in that total.');
  }
  process.exit(0);
}

for (const [name, key] of [['openai', 'OPENAI_API_KEY'], ['anthropic', 'ANTHROPIC_API_KEY']]) {
  if (!process.env[key]) {
    console.error(`${key} is required: this measures ${name}'s own variance against itself`);
    process.exit(2);
  }
}


startCaptureRun({
  dir: resolve(repoRoot, 'artifacts/aa-noise-floor'),
  meta: { probe: 'aa-noise-floor', openAiModel, anthropicModel, reps, tasksDigest: plan.tasksDigest },
});

// One budget across every row AND every resume of the run: `state.spent` is what
// this run has already paid, so the ceiling is the batch's, not the process's.
const budget = { remaining: resume.remaining, spent: resume.spent };
if (statePath && state.spent > 0) {
  process.stderr.write(`\nresuming: ${state.spent} of ${budgetTotal} calls already spent, `
    + `${budget.remaining} left\n`);
}
if (resume.exhausted) {
  console.error(`this run has already spent its ${budgetTotal}-call budget (${state.spent} used). `
    + 'Raise --budget deliberately if more calls are intended.');
  process.exit(1);
}
const started = Date.now();
const results = [];
let aborted = null;

for (const row of rows) {
  const key = `${row.provider}/${row.task}`;
  const vendor = PROVIDERS[row.provider];
  // Whole samples. The first version stored `lens` alone, so a resumed row came
  // back with five character readings and two token readings and reported both
  // as complete — and the floor is taken over the token series. `sampleRow`
  // refuses a bare-length state rather than restoring half a row.
  const existing = state.rows[key]?.samples ?? [];
  process.stderr.write(`\n[${key}] ${existing.length}/${reps} already, `
    + `${budget.remaining} calls left in budget\n`);
  let outcome;
  try {
    outcome = await sampleRow({
      reps,
      minReps,
      existing,
      budget,
      // The design's sequential rule, in the units this row is in.
      decisiveWhen: (reading) => (reading.ciHalfWidth / reading.mean) * 100 <= decisivePct,
      take: async () => takeSample({
        url: vendor.url,
        headers: vendor.headers(),
        body: vendor.body(row.prompt),
        label: key,
        timeoutMs: 180_000,
        readAnswer: vendor.readAnswer,
      }),
      // Before the call, so an interrupt cannot re-grant calls already made.
      onSpend: ({ spent }) => {
        state.spent = spent;
        saveState();
      },
      onSample: ({ index, chars, lens, samples }) => {
        state.rows[key] = { samples, updatedAt: new Date().toISOString() };
        // Booked from the sampler's own counter, not from the sample count: a
        // retried call and a call that failed outright are both spent money and
        // neither leaves a sample behind.
        state.spent = budget.spent;
        saveState();
        const reading = summarise(lens);
        process.stderr.write(`  ${index + 1}/${reps} ${chars} chars  `
          + `mean ${reading.mean} sd ${reading.sd ?? '-'} ci±${reading.ciHalfWidth ?? '-'}\n`);
      },
    });
  } catch (error) {
    if (!(error instanceof SamplingAbort)) throw error;
    aborted = error.message;
    state.spent = budget.spent;
    saveState();
    // The samples this row DID collect are paid for and already in the state
    // file. Breaking without recording them left them out of the artifact, which
    // is where `--report` re-derives the floor from — a paid observation the
    // published floor is not taken over.
    const paid = abortedRow(row, state.rows[key]?.samples);
    if (paid) results.push(paid);
    process.stderr.write(`\nSTOPPED: ${aborted}\n`);
    break;
  }

  // The stopping rule is applied HERE, on the row that just finished, because
  // "decisive" is a statement about this row's mean and not about a call.
  const settled = outcome.ciHalfWidth !== null && outcome.mean > 0
    && (outcome.ciHalfWidth / outcome.mean) * 100 <= decisivePct;
  results.push({ ...row, prompt: undefined, ...outcome, settled });
  state.rows[key] = { samples: outcome.samples, updatedAt: new Date().toISOString() };
  state.spent = budget.spent;
  saveState();
}

const artifact = {
  ranAt: new Date().toISOString(),
  elapsedMs: Date.now() - started,
  plan,
  budget,
  aborted,
  captures: captureSummary(),
  // The floor itself: the widest a row varies against itself, which is the bar a
  // direct-vs-proxy difference has to clear before it is a difference at all.
  //
  // Per SERIES, all three. The first version published the character series
  // alone and called it "the floor" — the tightest of the three, and the one
  // nobody is billed on. On this instrument's own first run that reads 16.7%
  // where the billed-token series reads 65.4%, so a cost difference of 30%
  // would have cleared the published floor and been inside the real one.
  floor: noiseFloor(results),
  rows: results,
};

mkdirSync(dirname(outPath), { recursive: true });
let wrote = outPath;
// `wx`, so a name collision is refused rather than resolved by overwriting. The
// check at startup is the one that saves the calls; this is the one that cannot
// be raced.
try {
  writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`, { flag: 'wx' });
} catch (error) {
  if (error?.code !== 'EEXIST') throw error;
  const fallback = `${outPath.replace(/\.json$/, '')}-${Date.now()}.json`;
  writeFileSync(fallback, `${JSON.stringify(artifact, null, 2)}\n`, { flag: 'wx' });
  console.error(`${outPath} appeared while this run was sampling; wrote ${fallback} instead. `
    + 'Neither run\'s calls were lost.');
  wrote = fallback;
}
console.log(JSON.stringify(artifact.floor, null, 2));
// The name this run actually wrote. The fallback branch used to print `outPath`,
// naming a file it had not written.
console.log(`\nwrote ${wrote}  (${budget.spent} live calls)`);
if (aborted) process.exit(1);
