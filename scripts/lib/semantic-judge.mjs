// The semantic judge's rubric, its output schema and its shape check — the
// definition of what a semantic score MEANS. One home, because two copies of a
// rubric are two different measurements wearing one name: a benchmark run and
// the re-judge probe that separates judge noise from candidate quality have to
// ask the model exactly the same thing to be comparable at all.
import assert from 'node:assert/strict';

export function semanticJudgePrompt({ target, caseName, prompt, text, reference }) {
  return [
    `Target: ${target}`,
    `Case: ${caseName}`,
    'Original user request:',
    prompt,
    reference
      ? [
          'Direct provider reference output for the same request:',
          reference.text,
        ].join('\n')
      : 'No direct provider reference is available; judge against the request and typical provider API output quality.',
    'Candidate output to score:',
    text,
    [
      'Rubric:',
      '- requirementFit: exact satisfaction of the original request, including language, format, count, ordering, forbidden claims, and required facts.',
      '- semanticRelevance: usefulness, correctness, and operational value for the requested local OAuth CLI API proxy scenario.',
      '- conciseness: dense, non-fluffy, and no extra headings, caveats, or follow-up questions unless the request asks for them.',
      '- providerSimilarity: if a reference is present, semantic similarity to the direct provider output; otherwise plausibility as a direct provider API answer.',
      '- relativeQuality: how well the candidate satisfies the original request RELATIVE to how well the reference satisfies it, as an integer percentage. 100 = meaningfully equivalent, above 100 = clearly better than the reference, below 100 = worse. Judge task outcome, not stylistic identity: a candidate that satisfies the request as fully as the reference scores 100 even when phrased differently. When no reference is present, set relativeQuality equal to score.',
      'Do not reward reference similarity when both the reference and candidate violate the explicit original request.',
      'Do not treat the reference as a style template when the candidate better satisfies the original request.',
      'For improvement-direction table cells, accept compact concrete mechanisms when they clearly express the direction and keep impact size separate.',
      'Overall score should be a weighted quality score from 0 to 100.',
      'List only concrete issues; use an empty array if none.',
    ].join('\n'),
  ].join('\n\n');
}

export function semanticQualityScoreSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      score: { type: 'integer' },
      relativeQuality: { type: 'integer' },
      requirementFit: { type: 'integer' },
      semanticRelevance: { type: 'integer' },
      conciseness: { type: 'integer' },
      providerSimilarity: { type: 'integer' },
      rationale: { type: 'string' },
      issues: {
        type: 'array',
        items: { type: 'string' },
      },
    },
    required: [
      'score',
      'relativeQuality',
      'requirementFit',
      'semanticRelevance',
      'conciseness',
      'providerSimilarity',
      'rationale',
      'issues',
    ],
  };
}

export function assertSemanticQualityShape(value) {
  assert(value && typeof value === 'object', 'semantic judge result must be object');
  for (const key of ['score', 'requirementFit', 'semanticRelevance', 'conciseness', 'providerSimilarity']) {
    assert(Number.isInteger(value[key]), `semantic judge ${key} must be integer`);
    assert(value[key] >= 0 && value[key] <= 100, `semantic judge ${key} must be 0..100`);
  }
  // relativeQuality may exceed 100: the candidate can beat the reference, and
  // the gate only reads a minimum — capping it here would turn a judge that
  // over-scores into a proxy quality failure, which is the wrong blame.
  assert(Number.isInteger(value.relativeQuality), 'semantic judge relativeQuality must be integer');
  assert(value.relativeQuality >= 0, 'semantic judge relativeQuality must be non-negative');
  assert(typeof value.rationale === 'string', 'semantic judge rationale must be string');
  assert(Array.isArray(value.issues), 'semantic judge issues must be array');
  for (const issue of value.issues) {
    assert(typeof issue === 'string', 'semantic judge issue must be string');
  }
}
