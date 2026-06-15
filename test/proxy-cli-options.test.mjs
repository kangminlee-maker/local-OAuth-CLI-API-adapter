import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseOptions } from '../dist/proxy-cli.js';

const builtCli = resolve(dirname(fileURLToPath(import.meta.url)), '../dist/proxy-cli.js');

test('built entrypoint runs main() when invoked directly (isMainModule guard)', () => {
  const result = spawnSync(process.execPath, [builtCli, 'help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /local-oauth-cli/);
});

test('parseOptions takes a dashed --extra-arg value in the space form', () => {
  const options = parseOptions(['proxy', '--extra-arg', '--effort', '--extra-arg', 'high', '--port', '8925']);
  assert.deepEqual(options.extraArg, ['--effort', 'high']);
  assert.equal(options.port, '8925');
});

test('parseOptions takes a dashed --extra-arg value in the = form', () => {
  const options = parseOptions(['proxy', '--extra-arg=--effort', '--extra-arg=high']);
  assert.deepEqual(options.extraArg, ['--effort', 'high']);
});

test('parseOptions treats a bare flag followed by another -- flag as a boolean', () => {
  // Exercises the boolean-collapse branch: --verbose has no value and is followed by
  // another flag, so it must become 'true' and NOT consume '--runtime' as its value.
  const options = parseOptions(['proxy', '--verbose', '--runtime', 'claude']);
  assert.equal(options.verbose, 'true');
  assert.equal(options.runtime, 'claude');
});

test('parseOptions ignores a trailing --extra-arg with no value', () => {
  const options = parseOptions(['proxy', '--extra-arg']);
  assert.ok(options.extraArg === undefined || Array.isArray(options.extraArg));
});
