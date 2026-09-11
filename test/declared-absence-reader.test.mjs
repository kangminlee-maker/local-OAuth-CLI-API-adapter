// One declaration, one reader.
//
// Three functions used to answer "is this path a declared absence": the shape
// comparison walked ancestors, the supplied-echo gate matched exactly, and the
// echoed-defaults gate matched exactly WITHOUT stripping the `[]#` suffix. So a
// declaration naming a subtree — the only form in which a whole absent feature
// can be declared — credited every path under it on one side and nothing on the
// other, and a declaration naming an array read differently again on the third.
//
// Two of those disagreements were latent: no capture in the store had a declared
// subtree, and no defaults capture had a declared array. Latent is not absent,
// and "the two paths must agree" is the defect this repository produces most.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { creditedAbsences, isDeclaredAbsent, keyPaths, leafValues } from '../scripts/lib/response-comparison.mjs';

test('a declared subtree answers for every leaf beneath it', () => {
  const absent = new Set(['.moderation']);
  for (const path of [
    '.moderation.input.model:string',
    '.moderation.output.results[].flagged:boolean',
    '.moderation.output.results[0].category_scores.hate:number',
    '.moderation.output.results[]#',
  ]) {
    assert.ok(isDeclaredAbsent(absent, path, new Set()), `${path} was not answered for`);
  }
});

test('a declared ancestor stops answering the moment we report it ourselves', () => {
  const absent = new Set(['.moderation']);
  const path = '.moderation.output.results[0].flagged:boolean';
  assert.ok(isDeclaredAbsent(absent, path, new Set()), 'the premise of this case does not hold');
  // We now emit a `moderation` block of our own. The declaration says we do not
  // report it, so it has stopped being true and must stop crediting — otherwise
  // every leaf under it is silently exempted here while the shape comparison
  // goes red, which is the two-readers disagreement all over again.
  assert.equal(isDeclaredAbsent(absent, path, new Set(['.moderation'])), false);
});

test('an unrelated path is not answered for by a neighbouring declaration', () => {
  const absent = new Set(['.moderation']);
  assert.equal(isDeclaredAbsent(absent, '.moderation_score:number', new Set()), false);
  assert.equal(isDeclaredAbsent(absent, '.usage.input_tokens:number', new Set()), false);
});

test('an exact declaration still reads exactly, index or no index', () => {
  const absent = new Set(['.usage.service_tier']);
  assert.ok(isDeclaredAbsent(absent, '.usage.service_tier:string', new Set()) === false,
    'a typed leaf is not the field itself');
  assert.ok(isDeclaredAbsent(new Set(['.usage.service_tier:string']), '.usage.service_tier:string', new Set()));
  assert.ok(isDeclaredAbsent(new Set(['.a.b[]#']), '.a.b[]#', new Set()));
  assert.ok(isDeclaredAbsent(new Set(['.a.b']), '.a.b[]#', new Set()), 'the `[]#` suffix was not stripped');
});

test('both readers answer for the same subtree, over the paths each one sees', () => {
  // The two comparisons walk different path spaces on purpose — the shape one
  // over typed key paths, the echo one over leaf values — so agreeing means
  // each answering for everything under the declaration IT sees, not producing
  // identical strings.
  const vendor = { moderation: { output: { results: [{ flagged: false, scores: { hate: 0.1 } }] } }, id: 'x' };
  const ours = { id: 'x' };
  const theirs = keyPaths(vendor);
  const mine = keyPaths(ours);
  const onlyVendor = new Map([...theirs].filter(([path]) => !mine.has(path)).sort());
  const ourFields = new Set(mine.values());
  assert.ok(onlyVendor.size >= 4, 'this body does not exercise a subtree');

  const { uncredited } = creditedAbsences(['.moderation'], [], onlyVendor, mine);
  assert.deepEqual(uncredited, [], 'the shape reader left paths uncredited');

  const leaves = [...leafValues(vendor, '', new Map()).keys()].filter((path) => path.startsWith('.moderation'));
  assert.ok(leaves.length >= 2, 'this body has no moderation leaves to read');
  const unanswered = leaves.filter((path) => !isDeclaredAbsent(new Set(['.moderation']), path, ourFields));
  assert.deepEqual(unanswered, [], 'the echo reader answered for fewer paths than the shape reader');

  // And both stop together once we report the subtree ourselves.
  const weReportIt = new Set(keyPaths({ ...ours, moderation: {} }).values());
  const stillAnswered = leaves.filter((path) => isDeclaredAbsent(new Set(['.moderation']), path, weReportIt));
  assert.deepEqual(stillAnswered, [], 'the echo reader kept crediting a declaration that had stopped being true');
});

test('an exactly-declared leaf stops being exempt once we report it', () => {
  const absent = new Set(['.reasoning.mode']);
  const path = '.reasoning.mode';
  assert.ok(isDeclaredAbsent(absent, path, new Set()), 'the premise of this case does not hold');
  // We now emit `reasoning.mode` — with a wrong value, say. The declaration has
  // stopped being true, and the echo comparison must stop crediting it just as
  // the shape comparison does. The guard used to apply only to the ancestor
  // walk, so an EXACT declaration kept the two readers disagreeing.
  assert.equal(isDeclaredAbsent(absent, path, new Set(['.reasoning.mode'])), false);
});

test('an indexed leaf declared without its index stops being exempt too', () => {
  const absent = new Set(['.output[].summary']);
  assert.ok(isDeclaredAbsent(absent, '.output[0].summary', new Set()));
  assert.equal(isDeclaredAbsent(absent, '.output[0].summary', new Set(['.output[].summary'])), false);
});

test('a declared cardinality path stops being exempt once we report the array', () => {
  const absent = new Set(['.tool_usage']);
  assert.ok(isDeclaredAbsent(absent, '.tool_usage[]#', new Set()));
  assert.equal(isDeclaredAbsent(absent, '.tool_usage[]#', new Set(['.tool_usage'])), false);
});
