import assert from 'node:assert/strict';
import { test } from 'node:test';
import { completeTopLevelMembers } from '../dist/proxy/tool-wrapper.js';

test('completeTopLevelMembers: the members that closed before the cut, as the direct Messages API publishes them', () => {
  assert.equal(completeTopLevelMembers('{"title": "The Sea", "body": "The sea is'), '{"title":"The Sea"}');
  assert.equal(completeTopLevelMembers('{"title": "The Sea"'), '{"title":"The Sea"}', 'a closed value before the end counts');
  assert.equal(completeTopLevelMembers('{"title": "The S'), '{}');
  assert.equal(completeTopLevelMembers('{"ti'), '{}', 'cut inside a key');
  assert.equal(completeTopLevelMembers('{'), '{}');
  assert.equal(completeTopLevelMembers(''), '{}');
  assert.equal(completeTopLevelMembers('  {"a": {"b": [1, 2]}, "c": {"d"'), '{"a":{"b": [1, 2]}}', 'a nested value closes as a whole, its bytes as written');
  assert.equal(completeTopLevelMembers('{"q": "say \\"hi\\"", "n": 12, "m": 1'), '{"q":"say \\"hi\\"","n":12}', 'escaped quotes and a number that ends at a comma');
  assert.equal(completeTopLevelMembers('"just a string'), '{}', 'not an object');
  assert.equal(completeTopLevelMembers('{"a":1}'), '{"a":1}', 'a whole object is itself');
});

test('completeTopLevelMembers: each member is the bytes the runtime wrote — no number is rounded, no whitespace inside a value canonicalized (r21-fable F1)', () => {
  assert.equal(completeTopLevelMembers('{"id": 9007199254740993, "w": 1e999, "cut": "Ko'), '{"id":9007199254740993,"w":1e999}');
  assert.equal(completeTopLevelMembers('{"a": [ 1,  2.50 ], "b": -0, "c": {"x" : null}, "d": "cu'), '{"a":[ 1,  2.50 ],"b":-0,"c":{"x" : null}}');
  assert.equal(completeTopLevelMembers('{"k\\u0041": "v", "n"'), '{"k\\u0041":"v"}', 'the key is its escaped spelling');
  assert.equal(completeTopLevelMembers('{"a": 1, "b": 2, "a": 3, "c": "cu'), '{"a":3,"b":2}', 'a repeated key keeps its first position and its last value, as JSON.parse reads it');
  for (const fragment of ['{"id": 9007199254740993, "w": 1e999, "cut": "Ko', '{"a": [ 1,  2.50 ], "b": -0, "c": {"x" : null}, "d": "cu', '{"a": 1, "b": 2, "a": 3, "c": "cu']) {
    assert.doesNotThrow(() => JSON.parse(completeTopLevelMembers(fragment)), 'the projection is itself JSON');
  }
});
