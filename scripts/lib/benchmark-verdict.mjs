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
  { field: 'claudeCliModel', targets: 'anthropic' },
  { field: 'claudeIsolateUserSettings', targets: 'anthropic' },
  { field: 'anthropicModels', targets: 'anthropic' },
  // These change what every row measures.
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
