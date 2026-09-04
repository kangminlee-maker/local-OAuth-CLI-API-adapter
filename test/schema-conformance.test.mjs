import assert from 'node:assert/strict';
import { test } from 'node:test';
import { conformsToSchema, hasInexactNumber, judgeJsonText, numberIsInexact } from '../dist/proxy/schema-conformance.js';

test('hasInexactNumber: decided by value — what the double holds exactly is judged, nothing else (r19)', () => {
  assert.equal(hasInexactNumber('{"id":9007199254740993}'), true, '2^53+1 rounds');
  assert.equal(hasInexactNumber('{"id":9007199254740992}'), false, '2^53 is exact');
  assert.equal(hasInexactNumber('{"id":10000000000000000}'), false, '1e16 is exact');
  assert.equal(hasInexactNumber('{"id":9007199254740991}'), false);
  assert.equal(hasInexactNumber('{"id":-9007199254740993}'), true);
  assert.equal(hasInexactNumber('{"x":0.5}'), false, 'a dyadic fraction is exact');
  assert.equal(hasInexactNumber('{"x":0.3}'), true, '0.3 is not');
  assert.equal(hasInexactNumber('{"x":1e-999}'), true, 'underflows to zero');
  assert.equal(hasInexactNumber('{"x":1e999}'), true, 'overflows');
  assert.equal(hasInexactNumber('{"x":-0}'), false);
  // r20 F1: an exponent that underflows must be decided without scaling a
  // BigInt by it — `1e-999999999` used to throw "Maximum BigInt size
  // exceeded" (a 500) and sub-cap exponents burned seconds of CPU.
  const started = Date.now();
  assert.equal(hasInexactNumber('{"y":1e-999999999}'), true);
  assert.equal(hasInexactNumber('{"y":0e-999999999}'), false, 'a zero mantissa is exactly zero');
  assert.equal(hasInexactNumber('{"y":1e-40000000}'), true);
  assert.equal(hasInexactNumber(`{"y":1${'0'.repeat(5000)}}`), true, 'a 5001-digit integer overflows the double: decided without arithmetic');
  // Zero padding is not inexactness (r21-codex): the significant digits decide.
  assert.equal(hasInexactNumber(`{"y":0.${'0'.repeat(4096)}}`), false, 'zero however long is zero');
  assert.equal(hasInexactNumber(`{"y":-0.${'0'.repeat(5000)}e7}`), false, 'negative zero, padded, scaled');
  assert.equal(hasInexactNumber(`{"y":1${'0'.repeat(4096)}e-4096}`), false, 'one written with 4096 trailing zeros');
  assert.equal(hasInexactNumber(`{"y":0.${'0'.repeat(5000)}1e5001}`), false, 'one written with 5000 leading zeros');
  assert.equal(hasInexactNumber(`{"y":${'0'.repeat(5000)}25e-1}`), false, '2.5 behind 5000 leading zeros');
  assert.equal(hasInexactNumber(`{"y":1.${'1'.repeat(4096)}}`), true, '4097 significant digits: no double holds them, decided without arithmetic');
  assert.equal(hasInexactNumber(`{"y":1.${'0'.repeat(4000)}1}`), true, '4002 significant digits, exact zeros between: inexact by arithmetic');
  assert.equal(numberIsInexact(`0.${'0'.repeat(4096)}`), false);
  assert.equal(numberIsInexact(`1${'0'.repeat(4096)}e-4096`), false);
  assert.ok(Date.now() - started < 200, `decided in ${Date.now() - started}ms`);
  assert.equal(hasInexactNumber('{"x":2.5e3}'), false, '2500 is exact');
  assert.equal(hasInexactNumber('{"s":"9007199254740993","n":1}'), false, 'digits inside a string are text');
  assert.equal(hasInexactNumber('{"s":"a\\"0.3","n":1}'), false, 'an escaped quote does not end the string');
  assert.equal(hasInexactNumber('[1,2,3]'), false);
});

test('judgeJsonText: the four answers', () => {
  const schema = { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] };
  assert.equal(judgeJsonText('{"city":"Seoul"}', schema), 'conforms');
  assert.equal(judgeJsonText('{"city":1}', schema), 'violates');
  assert.equal(judgeJsonText('{"city":"Seo', schema), 'not-json');
  assert.equal(judgeJsonText('{"city":"Seoul"}', { type: 'nonsense' }), 'unjudged', 'uncompilable');
  assert.equal(judgeJsonText('{"city":"Seoul"}', undefined), 'unjudged', 'no schema');
  assert.equal(judgeJsonText('{"city":"Seoul"}', { $async: true, ...schema }), 'unjudged', '$async');
  // An inexact number downgrades only a VIOLATION: a conforming answer is
  // delivered, a violation that may be the rounding's is not a verdict.
  assert.equal(judgeJsonText('{"city":"Seoul","n":9007199254740993}', schema), 'conforms');
  assert.equal(judgeJsonText('{"city":1,"n":9007199254740993}', schema), 'unjudged');
  assert.equal(judgeJsonText('{"id":9007199254740992}', { properties: { id: { maximum: 100 } } }), 'violates', '2^53 is exact and judged (r19 F3)');
  assert.equal(judgeJsonText('{"x":0.3}', { properties: { x: { multipleOf: 0.1 } } }), 'unjudged', '0.3 % 0.1 on doubles is the rounding, not the runtime');
  assert.equal(judgeJsonText('{"x":1e-999}', { properties: { x: { exclusiveMinimum: 0 } } }), 'unjudged', 'underflow');
  assert.equal(judgeJsonText('{"x":0.5}', { properties: { x: { multipleOf: 0.25 } } }), 'conforms');
  assert.equal(judgeJsonText('{"x":0.75}', { properties: { x: { multipleOf: 0.5 } } }), 'violates', 'exact and judged');
});

test('conformsToSchema: one instance per schema, so $id never crosses requests', () => {
  assert.equal(conformsToSchema({ ok: 1 }, { $id: 'urn:r18:a', type: 'object', required: ['zzz'] }), false);
  assert.equal(conformsToSchema({ ok: 1 }, { $ref: 'urn:r18:a' }), null, 'unresolvable in its own instance');
  assert.equal(conformsToSchema({ x: 1 }, { $id: 'urn:r18:a', type: 'object', properties: { x: { const: 2 } } }), false, 'a second schema under the same $id compiles');
  assert.equal(conformsToSchema({ x: 2 }, { $id: 'urn:r18:a', type: 'object', properties: { x: { const: 2 } } }), true);
});
