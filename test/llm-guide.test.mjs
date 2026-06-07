import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('CLI prints the LLM install guide', () => {
  const result = spawnSync(process.execPath, ['dist/proxy-cli.js', '--llm-guide'], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /LLM install and usage guide/);
  assert.match(result.stdout, /Required Runtime Boundaries/);
  assert.match(result.stdout, /x_proxy_image_route/);
  assert.match(result.stdout, /local-oauth-cli LLM INSTALL GUIDE START/);
});

test('postinstall prints the LLM install guide', () => {
  const result = spawnSync(process.execPath, ['postinstall.mjs'], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /LLM install and usage guide/);
  assert.match(result.stdout, /Required Runtime Boundaries/);
  assert.match(result.stdout, /local-oauth-cli --llm-guide/);
});

test('proxy command requires LLM guide acknowledgement', () => {
  const result = spawnSync(process.execPath, ['dist/proxy-cli.js', 'proxy', '--runtime', 'codex'], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /LLM install and usage guide/);
  assert.match(result.stderr, /--accept-llm-guide=v1/);
});
