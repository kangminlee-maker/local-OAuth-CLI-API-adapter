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
  assert.equal(completeTopLevelMembers('  {"a": {"b": [1, 2]}, "c": {"d"'), '{"a":{"b":[1,2]}}', 'a nested value closes as a whole');
  assert.equal(completeTopLevelMembers('{"q": "say \\"hi\\"", "n": 12, "m": 1'), '{"q":"say \\"hi\\"","n":12}', 'escaped quotes and a number that ends at a comma');
  assert.equal(completeTopLevelMembers('"just a string'), '{}', 'not an object');
  assert.equal(completeTopLevelMembers('{"a":1}'), '{"a":1}', 'a whole object is itself');
});
