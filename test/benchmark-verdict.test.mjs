import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  basisMismatches,
  basisVoidsRow,
  matchesFilter,
  mergeFilters,
  nonNegativeNumberOption,
  readFilters,
} from '../scripts/lib/benchmark-verdict.mjs';

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
