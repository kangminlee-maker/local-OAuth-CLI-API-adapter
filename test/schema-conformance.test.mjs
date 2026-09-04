import assert from 'node:assert/strict';
import { test } from 'node:test';
import { conformsToSchema, hasInexactNumber, judgeJsonText } from '../dist/proxy/schema-conformance.js';

test('hasInexactNumber: integers past 2^53 and decimals past 15 digits, and nothing inside a string', () => {
  assert.equal(hasInexactNumber('{"id":9007199254740993}'), true);
  assert.equal(hasInexactNumber('{"id":9007199254740991}'), false, 'MAX_SAFE_INTEGER is exact');
  assert.equal(hasInexactNumber('{"id":-9007199254740993}'), true);
  assert.equal(hasInexactNumber('{"x":0.1234567890123456}'), true, '16 significant digits');
  assert.equal(hasInexactNumber('{"x":0.123456789012345}'), false, '15 significant digits');
  assert.equal(hasInexactNumber('{"x":1.5e300}'), false);
  assert.equal(hasInexactNumber('{"s":"9007199254740993","n":1}'), false, 'digits inside a string are text');
  assert.equal(hasInexactNumber('{"s":"a\\"9007199254740993","n":1}'), false, 'an escaped quote does not end the string');
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
  assert.equal(judgeJsonText('{"city":"Seoul","n":9007199254740993}', schema), 'unjudged', 'inexact number');
});

test('conformsToSchema: one instance per schema, so $id never crosses requests', () => {
  assert.equal(conformsToSchema({ ok: 1 }, { $id: 'urn:r18:a', type: 'object', required: ['zzz'] }), false);
  assert.equal(conformsToSchema({ ok: 1 }, { $ref: 'urn:r18:a' }), null, 'unresolvable in its own instance');
  assert.equal(conformsToSchema({ x: 1 }, { $id: 'urn:r18:a', type: 'object', properties: { x: { const: 2 } } }), false, 'a second schema under the same $id compiles');
  assert.equal(conformsToSchema({ x: 2 }, { $id: 'urn:r18:a', type: 'object', properties: { x: { const: 2 } } }), true);
});
