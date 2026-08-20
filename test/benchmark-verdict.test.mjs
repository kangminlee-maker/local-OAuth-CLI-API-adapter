import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  basisMismatches,
  basisVoidsRow,
  benchmarkFailureReasons,
  compareWithBaseline,
  decidingSample,
  imageGateScore,
  matchesFilter,
  mergeFilters,
  nonNegativeNumberOption,
  readFilters,
  semanticGateScore,
} from '../scripts/lib/benchmark-verdict.mjs';

const benchmarkScript = resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/api-comparison-benchmark.mjs');

const gateOptions = {
  baselinePath: '/tmp/baseline.json',
  regressionTargets: 'proxy',
  latencyRegressionPct: 30,
  latencyRegressionMs: 750,
  qualityRegressionPoints: 5,
};

/** One measured row, in the shape the benchmark writes. */
function summary(fields, rows) {
  return { repeats: 1, openAiModel: 'gpt-5.5', semanticQualityJudgeModel: 'gpt-5.5', ...fields, rows };
}

function latencyRow(target, totalMs) {
  return { target, case: 'openai.chat.text.schema_exact', ok: true, totalMs: { median: totalMs, samples: [totalMs] } };
}

// Nothing tested the benchmark's verdict rules, because the script is a
// top-level program: importing it starts proxies and calls providers. These
// rules decide whether a run's exit code means what it says, so they live in a
// module that can be imported without any of that.

test('a field the baseline never recorded is unknown, not a mismatch', () => {
  // Every artifact captured before a field existed lacks its key. Reading that
  // absence as a differing basis voided the comparison against all of them,
  // which turned a real regression into a green run.
  const { mismatched, unknown } = basisMismatches(
    { openAiModel: 'gpt-5.5' },
    { openAiModel: 'gpt-5.5', claudeIsolateUserSettings: false },
  );
  assert.deepEqual(mismatched, []);
  assert.deepEqual(unknown.map((entry) => entry.field), ['claudeIsolateUserSettings']);
});

test('a field recorded on both sides with different values is a mismatch', () => {
  const { mismatched } = basisMismatches(
    { openAiModel: 'gpt-5.5' },
    { openAiModel: 'gpt-5.6-terra' },
  );
  assert.deepEqual(mismatched.map((entry) => [entry.field, entry.baseline, entry.current]), [
    ['openAiModel', 'gpt-5.5', 'gpt-5.6-terra'],
  ]);
});

test('the fields that decide what every row measures are compared', () => {
  // A run scored against no reference is not comparable with one scored
  // against a reference, whatever the numbers look like.
  const { mismatched } = basisMismatches(
    { semanticQualityReference: true, expectProviderErrors: false },
    { semanticQualityReference: false, expectProviderErrors: true },
  );
  assert.deepEqual(mismatched.map((entry) => entry.field).sort(), ['expectProviderErrors', 'semanticQualityReference']);
});

test('a mismatch voids only the rows its field governs', () => {
  const { mismatched } = basisMismatches(
    { claudeCliModel: 'opus' },
    { claudeCliModel: 'claude-sonnet-5' },
  );
  assert.equal(basisVoidsRow(mismatched, 'proxy-claude'), true);
  assert.equal(basisVoidsRow(mismatched, 'anthropic-api:claude-opus-4-8'), true);
  assert.equal(basisVoidsRow(mismatched, 'proxy-codex'), false, 'a Claude-side change says nothing about a Codex row');
});

test('a judge-model mismatch voids every row', () => {
  const { mismatched } = basisMismatches(
    { semanticQualityJudgeModel: 'gpt-5.5' },
    { semanticQualityJudgeModel: 'gpt-5.6-luna' },
  );
  assert.equal(basisVoidsRow(mismatched, 'proxy-codex'), true);
  assert.equal(basisVoidsRow(mismatched, 'proxy-claude'), true);
});

test('an explicit case selection narrows a suite instead of widening it', () => {
  const suite = ['openai.chat.text.schema_exact', 'openai.chat.stream.schema_exact', 'anthropic.messages.text'];
  assert.deepEqual(mergeFilters(['openai.chat.text.schema_exact'], suite), ['openai.chat.text.schema_exact']);
});

test('an explicit case selection survives a suite whose filter is "all"', () => {
  // release-gate selects every case; a union collapsed to `all` and ran the
  // most expensive suite in full when the operator asked for one case.
  assert.deepEqual(mergeFilters(['openai.chat.text.schema_exact'], ['all']), ['openai.chat.text.schema_exact']);
});

test('with no explicit selection the suite decides', () => {
  assert.deepEqual(mergeFilters(null, ['openai.chat.text.schema_exact']), ['openai.chat.text.schema_exact']);
  assert.equal(mergeFilters(null, null), null);
  assert.deepEqual(mergeFilters(null, ['all']), ['all']);
});

test('a threshold that is not a whole number is an error, never a silent zero', () => {
  // `Number.parseInt('0.9')` is 0, and 0 means "no gate" — so writing the
  // threshold as a fraction disabled the gate it was meant to raise.
  assert.throws(() => nonNegativeNumberOption('0.9', 95, '--min-semantic-quality'), /whole number/);
  assert.throws(() => nonNegativeNumberOption('oops', 95, '--min-semantic-quality'), /whole number/);
  assert.equal(nonNegativeNumberOption(undefined, 95), 95);
  assert.equal(nonNegativeNumberOption('0', 95), 0, 'an explicit zero still disables the gate on purpose');
  assert.equal(nonNegativeNumberOption('90', 95), 90);
});

test('filters match by exact name, substring, and glob', () => {
  assert.equal(matchesFilter('openai-api:gpt-5.5', 'openai-api'), true);
  assert.equal(matchesFilter('openai-api:gpt-5.5', 'openai-api:gpt-5.5'), true);
  assert.equal(matchesFilter('openai.images.edit.schema_exact', 'openai.images.*'), true);
  assert.equal(matchesFilter('proxy-codex', 'proxy-claude'), false);
  assert.equal(matchesFilter('anything', 'all'), true);
});

test('readFilters treats "all" and empty input as no filter', () => {
  assert.equal(readFilters('all'), null);
  assert.equal(readFilters(''), null);
  assert.equal(readFilters(undefined), null);
  assert.deepEqual(readFilters('proxy-codex, proxy-claude'), ['proxy-codex', 'proxy-claude']);
});

test('an unreadable baseline fails the run instead of passing it', () => {
  // The measurements are kept — they are already paid for — but the operator
  // asked for a comparison and did not get one, so the exit code cannot say the
  // regression check passed.
  const reasons = benchmarkFailureReasons({
    failedRows: 0,
    baselineLoadError: "ENOENT: no such file or directory, open '/tmp/gone.json'",
  });
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /baseline unreadable/);
});

test('a run with nothing wrong and no baseline is a pass', () => {
  assert.deepEqual(benchmarkFailureReasons({ failedRows: 0 }), []);
});

test('a comparison whose every row was voided fails instead of reporting no regressions', () => {
  // `compared: 0` with `regressions: []` read as green: the gate reported
  // nothing wrong because it had measured nothing at all.
  const rows = [latencyRow('proxy-codex', 5000)];
  const gate = compareWithBaseline(
    summary({ openAiModel: 'gpt-5.5' }, rows),
    summary({ openAiModel: 'gpt-5.6-terra' }, rows),
    gateOptions,
  );
  assert.equal(gate.comparedRows, 0);
  assert.equal(gate.eligibleRows, 1);
  assert.deepEqual(gate.skippedByReason, { 'basis-mismatch': 1 });
  assert.deepEqual(benchmarkFailureReasons({ failedRows: 0, regressionGate: gate }), [
    'baseline comparison covered none of its 1 eligible row(s) (basis-mismatch: 1)',
  ]);
});

test('a comparison that covered its rows and found nothing is a pass', () => {
  // The control for the test above: same shape, same basis, so the green means
  // a comparison happened.
  const gate = compareWithBaseline(
    summary({}, [latencyRow('proxy-codex', 5000)]),
    summary({}, [latencyRow('proxy-codex', 5050)]),
    gateOptions,
  );
  assert.equal(gate.comparedRows, 1);
  assert.deepEqual(benchmarkFailureReasons({ failedRows: 0, regressionGate: gate }), []);
});

test('a baseline that shares no row with the run fails rather than comparing nothing', () => {
  const gate = compareWithBaseline(
    summary({}, [latencyRow('proxy-codex', 5000)]),
    summary({}, [latencyRow('proxy-claude', 5000)]),
    gateOptions,
  );
  assert.deepEqual(gate.skippedByReason, { 'missing-baseline': 1 });
  assert.match(benchmarkFailureReasons({ regressionGate: gate })[0], /missing-baseline: 1/);
});

test('a row both sides recorded but share no metric on is not a covered row', () => {
  // An older artifact stores a metric in a shape `medianOf` cannot read, so
  // every metric is skipped while the row itself is neither voided nor missing.
  // Counting it as compared would make an empty comparison look covered.
  const gate = compareWithBaseline(
    summary({}, [{ target: 'proxy-codex', case: 'openai.chat.text.schema_exact', ok: true, totalMs: 5000 }]),
    summary({}, [latencyRow('proxy-codex', 5000)]),
    gateOptions,
  );
  assert.equal(gate.eligibleRows, 1);
  assert.equal(gate.comparedRows, 0);
  assert.equal(gate.compared, 0);
  assert.match(benchmarkFailureReasons({ regressionGate: gate })[0], /covered none of its 1 eligible row/);
});

test('a target the operator scoped out is not an uncompared row', () => {
  // `--regression-targets=proxy` excluding the direct rows is the operator's
  // own scoping, so it must not read as a comparison that failed to run.
  const gate = compareWithBaseline(
    summary({}, [latencyRow('openai-api:gpt-5.5', 5000)]),
    summary({}, [latencyRow('openai-api:gpt-5.5', 5000)]),
    gateOptions,
  );
  assert.equal(gate.eligibleRows, 0);
  assert.deepEqual(gate.skippedByReason, { 'target-filter': 1 });
  assert.deepEqual(benchmarkFailureReasons({ regressionGate: gate }), []);
});

test('a real regression is still what it was', () => {
  const gate = compareWithBaseline(
    summary({}, [latencyRow('proxy-codex', 5000)]),
    summary({}, [latencyRow('proxy-codex', 30_000)]),
    gateOptions,
  );
  assert.equal(gate.regressions.length, 1);
  assert.match(benchmarkFailureReasons({ regressionGate: gate })[0], /1 regression\(s\)/);
});

test('the sample count and the image transport are part of the comparison basis', () => {
  // A median over five samples is not the same statistic as a single sample,
  // and a Codex image row measured over a different transport measured
  // something else — both used to compare as if nothing had changed.
  const drift = basisMismatches(
    { repeats: 5, codexImageTransport: 'codex-backend' },
    { repeats: 1, codexImageTransport: 'app-server' },
  );
  assert.deepEqual(drift.mismatched.map((entry) => entry.field).sort(), ['codexImageTransport', 'repeats']);
  assert.equal(basisVoidsRow(drift.mismatched, 'proxy-claude'), true, 'the sample count governs every row');
  const transportOnly = basisMismatches(
    { codexImageTransport: 'codex-backend' },
    { codexImageTransport: 'app-server' },
  );
  assert.equal(basisVoidsRow(transportOnly.mismatched, 'proxy-codex'), true);
  assert.equal(basisVoidsRow(transportOnly.mismatched, 'proxy-claude'), false, 'a Codex transport says nothing about a Claude row');
});

test('the kept sample is the one the gate read, on the gate\'s own scale', () => {
  // The gate reads relativeQuality; ranking by the minimum ACROSS
  // relativeQuality, absolute score and imageQuality.score compared three
  // scales, so the artifact kept a sample the gate had not decided on.
  const beatsReferenceButScoresLow = { semanticQuality: { relativeQuality: 120, score: 80 } };
  const theOneTheGateFailed = { semanticQuality: { relativeQuality: 96, score: 97 } };
  assert.equal(
    decidingSample([beatsReferenceButScoresLow, theOneTheGateFailed], semanticGateScore),
    theOneTheGateFailed,
  );
  assert.equal(
    decidingSample([{ imageQuality: { score: 91 } }, { imageQuality: { score: 88 } }], imageGateScore).imageQuality.score,
    88,
  );
  // A run with no reference scores only absolutes, and a row with no score at
  // all keeps the last sample rather than none.
  assert.equal(decidingSample([{ semanticQuality: { score: 90 } }, { semanticQuality: { score: 70 } }], semanticGateScore).semanticQuality.score, 70);
  assert.equal(decidingSample([{ totalMs: 1 }, { totalMs: 2 }], semanticGateScore).totalMs, 2);
});

test('a fractional repeat count stops the benchmark instead of disabling its gate', () => {
  // `--semantic-quality-repeats=0.9` parsed to 0, and 0 repeats means no
  // quality rows at all — the run then reported success having measured none.
  // Spawned against the real script: the flag is read before any proxy starts.
  const result = spawnSync(
    process.execPath,
    [benchmarkScript, '--targets=zzz-none', '--cases=zzz-none', '--semantic-quality-repeats=0.9'],
    { encoding: 'utf8' },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--semantic-quality-repeats expects a whole number/);
});
