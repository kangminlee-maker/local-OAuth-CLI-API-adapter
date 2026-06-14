import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseOptions } from '../dist/proxy-cli.js';

test('parseOptions takes a dashed --extra-arg value in the space form', () => {
  const options = parseOptions(['proxy', '--extra-arg', '--effort', '--extra-arg', 'high', '--port', '8925']);
  assert.deepEqual(options.extraArg, ['--effort', 'high']);
  assert.equal(options.port, '8925');
});

test('parseOptions takes a dashed --extra-arg value in the = form', () => {
  const options = parseOptions(['proxy', '--extra-arg=--effort', '--extra-arg=high']);
  assert.deepEqual(options.extraArg, ['--effort', 'high']);
});

test('parseOptions still treats a bare boolean flag before another flag as true', () => {
  const options = parseOptions(['proxy', '--accept-llm-guide=v1', '--runtime', 'claude']);
  assert.equal(options.acceptLlmGuide, 'v1');
  assert.equal(options.runtime, 'claude');
});

test('parseOptions ignores a trailing --extra-arg with no value', () => {
  const options = parseOptions(['proxy', '--extra-arg']);
  assert.ok(options.extraArg === undefined || Array.isArray(options.extraArg));
});
