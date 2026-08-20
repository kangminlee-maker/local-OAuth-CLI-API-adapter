// The parts of the benchmark that decide what a run's verdict MEANS: which
// option values are in force, which cases are selected, and whether a baseline
// is comparable at all. They live here because the benchmark script itself is
// a top-level program — importing it starts proxies and calls providers — so
// nothing could test the rules that turn measurements into a pass or a fail.

/**
 * Fields that decide what a row means rather than how it scored. A baseline
 * captured under a different value is a different basis, so its deltas are not
 * evidence.
 *
 * `targets` scopes the damage: a Claude-side difference says nothing about an
 * OpenAI row, and voiding every delta over an unrelated field is how a check
 * gets switched off.
 */
export const COMPARISON_BASIS_FIELDS = [
  { field: 'openAiModel', targets: 'openai' },
  { field: 'openAiImageApiModel', targets: 'openai' },
  { field: 'codexModel', targets: 'openai' },
  { field: 'codexImageModel', targets: 'openai' },
  // Which transport carried the image turns decides what a Codex image row
  // measured, so a run that switched it is not comparable with one that did not.
  { field: 'codexImageTransport', targets: 'openai' },
  { field: 'claudeCliModel', targets: 'anthropic' },
  { field: 'claudeIsolateUserSettings', targets: 'anthropic' },
  { field: 'anthropicModels', targets: 'anthropic' },
  // These change what every row measures.
  // A median over five samples and a single sample are different statistics,
  // and the quality gates read the minimum across repeats — so the sample count
  // decides what every number in the artifact means.
  { field: 'repeats', targets: 'all' },
  { field: 'semanticQualityJudgeModel', targets: 'all' },
  { field: 'imageQualityJudgeModel', targets: 'all' },
  { field: 'semanticQualityReference', targets: 'all' },
  { field: 'semanticQualitySuite', targets: 'all' },
  { field: 'requestReasoningEffort', targets: 'all' },
  { field: 'expectProviderErrors', targets: 'all' },
  { field: 'codexProxyMode', targets: 'all' },
];

/** Which family a row's target belongs to, for scoping a basis mismatch. */
export function targetFamily(target) {
  const name = String(target ?? '');
  if (name.includes('claude') || name.includes('anthropic')) return 'anthropic';
  return 'openai';
}

/**
 * Splits basis fields into ones that genuinely differ and ones the baseline
 * never recorded.
 *
 * An older artifact simply lacks a key that was added later; its absence is not
 * evidence that the basis differed, and treating it as one voided the
 * comparison against every artifact captured before the field existed. Those
 * are reported as `unknown` — visible, but not grounds for discarding deltas.
 */
export function basisMismatches(baseline, current) {
  const mismatched = [];
  const unknown = [];
  for (const { field, targets } of COMPARISON_BASIS_FIELDS) {
    const recordedInBaseline = baseline !== null && baseline !== undefined && field in baseline;
    const recordedInCurrent = current !== null && current !== undefined && field in current;
    if (!recordedInCurrent) continue;
    if (!recordedInBaseline) {
      unknown.push({ field, current: current[field] ?? null });
      continue;
    }
    if (JSON.stringify(baseline[field] ?? null) !== JSON.stringify(current[field] ?? null)) {
      mismatched.push({ field, targets, baseline: baseline[field] ?? null, current: current[field] ?? null });
    }
  }
  return { mismatched, unknown };
}

/** True when a mismatch on these fields makes this row's delta meaningless. */
export function basisVoidsRow(mismatched, target) {
  const family = targetFamily(target);
  return mismatched.some((entry) => entry.targets === 'all' || entry.targets === family);
}

/** Which rows the regression gate is scoped to, by `--regression-targets`. */
export function shouldCompareRegressionTarget(target, filter) {
  if (filter === 'all') return true;
  if (filter === 'proxy') return target.startsWith('proxy-');
  return target.includes(filter);
}

function rowKey(row) {
  return `${row.target}\t${row.case}`;
}

function medianOf(summary) {
  return typeof summary?.median === 'number' ? summary.median : Number.NaN;
}

/**
 * The regression gate: what this run's rows did against the baseline's, and —
 * just as load-bearing — how much of the run the comparison actually covered.
 */
export function compareWithBaseline(baseline, current, options) {
  const basisDrift = basisMismatches(baseline, current);
  const baselineRows = new Map(
    (baseline.rows ?? [])
      .filter((row) => row?.ok)
      .map((row) => [rowKey(row), row]),
  );
  const regressions = [];
  const improvements = [];
  const compared = [];
  const skipped = [];
  // Counted per row, not per metric entry: the verdict has to tell "compared
  // nothing" from "compared a lot", and a target the operator scoped out was
  // never eligible in the first place.
  let eligibleRows = 0;
  let comparedRows = 0;
  for (const row of (current.rows ?? []).filter((item) => item.ok)) {
    if (!shouldCompareRegressionTarget(row.target, options.regressionTargets)) {
      skipped.push({ target: row.target, case: row.case, reason: 'target-filter' });
      continue;
    }
    eligibleRows += 1;
    // Only the rows a differing field actually governs lose their comparison;
    // a Claude-side difference says nothing about an OpenAI row.
    if (basisVoidsRow(basisDrift.mismatched, row.target)) {
      skipped.push({ target: row.target, case: row.case, reason: 'basis-mismatch' });
      continue;
    }
    const baselineRow = baselineRows.get(rowKey(row));
    if (!baselineRow) {
      skipped.push({ target: row.target, case: row.case, reason: 'missing-baseline' });
      continue;
    }
    const comparedBefore = compared.length;
    for (const metric of ['totalMs', 'firstDataMs', 'firstTextMs', 'firstToolArgumentMs', 'firstImageMs']) {
      const before = medianOf(baselineRow[metric]);
      const after = medianOf(row[metric]);
      if (!Number.isFinite(before) || !Number.isFinite(after)) continue;
      const delta = after - before;
      const threshold = Math.max(options.latencyRegressionMs, Math.abs(before) * options.latencyRegressionPct / 100);
      const entry = {
        target: row.target,
        case: row.case,
        metric,
        before,
        after,
        delta,
        threshold: Math.round(threshold),
      };
      compared.push(entry);
      if (delta > threshold) regressions.push(entry);
      else if (delta < -threshold) improvements.push(entry);
    }
    // semanticRelativeQuality is the metric the gate reads, so a baseline that
    // does not compare it cannot see the authoritative quality drift.
    for (const metric of ['quality', 'semanticQuality', 'semanticRelativeQuality', 'imageQuality']) {
      const qualityBefore = medianOf(baselineRow[metric]);
      const qualityAfter = medianOf(row[metric]);
      if (!Number.isFinite(qualityBefore) || !Number.isFinite(qualityAfter)) continue;
      const delta = qualityAfter - qualityBefore;
      const entry = {
        target: row.target,
        case: row.case,
        metric,
        before: qualityBefore,
        after: qualityAfter,
        delta,
        threshold: options.qualityRegressionPoints,
      };
      compared.push(entry);
      if (delta < -options.qualityRegressionPoints) regressions.push(entry);
      else if (delta > options.qualityRegressionPoints) improvements.push(entry);
    }
    // A row both sides recorded but no shared finite metric is a row the gate
    // did not actually cover, whatever the entry count says.
    if (compared.length > comparedBefore) comparedRows += 1;
  }
  return {
    baseline: options.baselinePath ?? null,
    targets: options.regressionTargets,
    latencyRegressionPct: options.latencyRegressionPct,
    latencyRegressionMs: options.latencyRegressionMs,
    qualityRegressionPoints: options.qualityRegressionPoints,
    compared: compared.length,
    comparedRows,
    eligibleRows,
    skipped: skipped.length,
    skippedByReason: skipped.reduce((counts, entry) => {
      counts[entry.reason] = (counts[entry.reason] ?? 0) + 1;
      return counts;
    }, {}),
    // A differing basis does not weaken the deltas, it voids them: they are
    // differences in configuration. Reporting them as regressions or
    // improvements would be a finding about nothing, so the comparison is
    // withheld and only the mismatch is reported.
    ...(basisDrift.mismatched.length > 0 ? { basisMismatch: basisDrift.mismatched } : {}),
    // Fields this run records that the baseline never did: not evidence that
    // the basis differed, but worth seeing before trusting a delta.
    ...(basisDrift.unknown.length > 0 ? { basisUnknown: basisDrift.unknown } : {}),
    regressions,
    improvements,
  };
}

/**
 * The number the semantic gate reads for one sample: quality relative to the
 * same-model direct reference, falling back to the absolute score when a run
 * carried no reference. Single-sourced so the row summary, the gate, and the
 * kept sample cannot read three different numbers.
 */
export function semanticGateScore(sample) {
  return sample?.semanticQuality?.relativeQuality ?? sample?.semanticQuality?.score;
}

/** The number the image gate reads for one sample. */
export function imageGateScore(sample) {
  return sample?.imageQuality?.score;
}

/**
 * The sample the gate actually read. Quality gates take the minimum across
 * repeats, so retaining the last sample left artifacts whose kept rationale
 * praised an answer the row was failed for — the failing text, its issues and
 * its reference were gone.
 *
 * `score` is the caller's gate metric, because taking the minimum ACROSS
 * metrics compared three different scales: a sample scoring 120 relative to the
 * reference and 80 absolute ranked below one at 96 relative, so the artifact
 * kept a sample the gate never decided on.
 */
export function decidingSample(samples, score) {
  const scored = samples.filter((sample) => Number.isFinite(score(sample)));
  if (scored.length === 0) return samples.at(-1);
  return scored.reduce((worst, sample) => (score(sample) < score(worst) ? sample : worst));
}

export function readFilters(value) {
  if (value === undefined || value === null || value === '' || value === 'all') return null;
  const filters = String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return filters.length > 0 ? filters : null;
}

/**
 * An explicit `--cases` selection NARROWS a suite rather than widening it: the
 * operator asked for those cases, and a union silently ran the whole suite —
 * including `release-gate`, whose `all` swallowed the request entirely.
 */
export function mergeFilters(explicit, suite) {
  const chosen = explicit ?? null;
  if (chosen && chosen.length > 0) return chosen.includes('all') ? ['all'] : [...new Set(chosen)];
  const fallback = suite ?? null;
  if (!fallback || fallback.length === 0) return null;
  return fallback.includes('all') ? ['all'] : [...new Set(fallback)];
}

export function matchesFilter(value, filter) {
  if (filter === 'all') return true;
  if (filter.includes('*')) {
    const pattern = filter
      .split('*')
      .map((part) => part.replace(/[|\\{}()[\]^$+?.]/g, '\\$&'))
      .join('.*');
    return new RegExp(`^${pattern}$`).test(value);
  }
  return value === filter || value.includes(filter);
}

/**
 * A threshold the operator wrote and the run did not apply is worse than no
 * threshold: `Number.parseInt('0.9')` is 0, and 0 means "no gate", so a
 * fractional threshold silently disabled the gate it was meant to raise.
 */
export function nonNegativeNumberOption(value, fallback, flag = 'option') {
  if (value === undefined) return fallback;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) throw new Error(`${flag} expects a whole number, got: ${value}`);
  return Number.parseInt(text, 10);
}

/**
 * Everything that makes this run a failure, in the order an operator reads it.
 * The exit code is derived from this list rather than from the regression count
 * alone, because a gate that COULD NOT RUN is not a gate that passed: an
 * unreadable `--baseline` and a comparison whose every row was voided both
 * exited 0 while the summary claimed a regression check.
 *
 * The measurements are still kept and still written — an unreadable baseline is
 * a comparison problem, not a reason to discard a run that was already paid
 * for. It is the verdict that must not claim more than was checked.
 */
export function benchmarkFailureReasons({
  failedRows = 0,
  baselineLoadError = null,
  regressionGate = null,
} = {}) {
  const reasons = [];
  if (failedRows > 0) reasons.push(`${failedRows} row(s) failed`);
  if (baselineLoadError) reasons.push(`baseline unreadable, so no comparison ran: ${baselineLoadError}`);
  if (regressionGate) {
    const regressions = regressionGate.regressions?.length ?? 0;
    if (regressions > 0) reasons.push(`${regressions} regression(s) against ${regressionGate.baseline ?? 'the baseline'}`);
    const eligibleRows = regressionGate.eligibleRows ?? 0;
    const comparedRows = regressionGate.comparedRows ?? 0;
    if (eligibleRows > 0 && comparedRows === 0) {
      const causes = Object.entries(regressionGate.skippedByReason ?? {})
        .filter(([reason]) => reason !== 'target-filter')
        .map(([reason, count]) => `${reason}: ${count}`)
        .join(', ');
      reasons.push(`baseline comparison covered none of its ${eligibleRows} eligible row(s)${causes ? ` (${causes})` : ''}`);
    }
  }
  return reasons;
}
