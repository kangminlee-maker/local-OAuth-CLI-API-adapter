import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import {
  codexContextIsolationArgs,
  createCodexIsolation,
  minimalCodexConfigToml,
} from '../dist/proxy/codex-app-server-backend.js';

const originalCodexHome = process.env.CODEX_HOME;
const tempDirs = [];

afterEach(async () => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test('Codex proxy isolation copies auth but not user MCP, plugins, hooks, or project config', async () => {
  const sourceHome = await mkdtemp(join(tmpdir(), 'codex-source-home-'));
  tempDirs.push(sourceHome);
  process.env.CODEX_HOME = sourceHome;
  await writeFile(join(sourceHome, 'auth.json'), '{"token":"local"}\n');
  await writeFile(join(sourceHome, 'config.toml'), [
    'model = "gpt-test-model"',
    'model_reasoning_effort = "xhigh"',
    '',
    '[features]',
    'hooks = true',
    'goals = true',
    '',
    '[mcp_servers.noisy]',
    'command = "noisy-mcp"',
    '',
    '[plugins."browser@openai-bundled"]',
    'enabled = true',
    '',
    '[projects."/repo"]',
    'trust_level = "trusted"',
    '',
  ].join('\n'));

  const isolation = await createCodexIsolation({ reasoningEffort: 'low', verbosity: 'medium' });
  tempDirs.push(isolation.rootDir);

  assert.notEqual(isolation.homeDir, sourceHome);
  assert.notEqual(isolation.workDir, process.cwd());
  assert.equal(await readFile(join(isolation.homeDir, 'auth.json'), 'utf8'), '{"token":"local"}\n');

  const config = await readFile(join(isolation.homeDir, 'config.toml'), 'utf8');
  assert.match(config, /model = "gpt-test-model"/);
  assert.match(config, /model_reasoning_effort = "low"/);
  assert.match(config, /model_reasoning_summary = "none"/);
  assert.match(config, /model_verbosity = "medium"/);
  assert.match(config, /web_search = "disabled"/);
  assert.match(config, /hooks = false/);
  assert.match(config, /goals = false/);
  assert.match(config, /plugins = false/);
  assert.match(config, /apps = false/);
  assert.match(config, /shell_tool = false/);
  assert.doesNotMatch(config, /mcp_servers/);
  assert.doesNotMatch(config, /projects/);
});

test('Codex app-server args pin deterministic proxy-only config overrides', () => {
  const args = codexContextIsolationArgs({
    model: 'gpt-test-model',
    reasoningEffort: 'minimal',
    verbosity: 'medium',
  });

  assert.deepEqual(args.slice(0, 10), [
    '-c',
    'model="gpt-test-model"',
    '-c',
    'model_reasoning_effort="minimal"',
    '-c',
    'model_reasoning_summary="none"',
    '-c',
    'model_verbosity="medium"',
    '-c',
    'web_search="disabled"',
  ]);
  assert.ok(args.includes('shell_environment_policy.inherit="none"'));
  assert.ok(args.includes('features.hooks=false'));
  assert.ok(args.includes('features.goals=false'));
  assert.ok(args.includes('features.plugins=false'));
  assert.ok(args.includes('features.apps=false'));
  assert.ok(args.includes('features.image_generation=false'));
  assert.ok(args.includes('features.shell_tool=false'));
  assert.ok(args.includes('notify=[]'));
  assert.ok(args.includes('analytics.enabled=false'));
});

test('Codex image backend isolation enables only image_generation explicitly', () => {
  const args = codexContextIsolationArgs({
    model: 'gpt-5.5',
    reasoningEffort: 'xhigh',
    verbosity: 'medium',
    imageGeneration: true,
  });

  assert.ok(args.includes('features.image_generation=true'));
  assert.ok(args.includes('features.shell_tool=false'));
  assert.ok(args.includes('features.plugins=false'));
  assert.ok(args.includes('features.apps=false'));
});

test('minimal Codex config preserves selected model while disabling ambient context sources', () => {
  const config = minimalCodexConfigToml({
    model: 'gpt-test-model',
    reasoningEffort: 'low',
    verbosity: 'medium',
  });

  assert.match(config, /model = "gpt-test-model"/);
  assert.match(config, /model_reasoning_summary = "none"/);
  assert.match(config, /model_verbosity = "medium"/);
  assert.match(config, /web_search = "disabled"/);
  assert.match(config, /\[shell_environment_policy\]\ninherit = "none"/);
  assert.match(config, /\[features\][\s\S]*goals = false/);
  assert.match(config, /\[features\][\s\S]*hooks = false/);
  assert.match(config, /\[features\][\s\S]*plugins = false/);
  assert.match(config, /\[features\][\s\S]*apps = false/);
  assert.match(config, /\[features\][\s\S]*image_generation = false/);
  assert.doesNotMatch(config, /mcp_servers/);
});

test('minimal Codex image config enables image generation without enabling ambient tools', () => {
  const config = minimalCodexConfigToml({
    model: 'gpt-5.5',
    reasoningEffort: 'xhigh',
    verbosity: 'medium',
    imageGeneration: true,
  });

  assert.match(config, /\[features\][\s\S]*image_generation = true/);
  assert.match(config, /\[features\][\s\S]*shell_tool = false/);
  assert.match(config, /\[features\][\s\S]*plugins = false/);
  assert.match(config, /\[features\][\s\S]*apps = false/);
});
