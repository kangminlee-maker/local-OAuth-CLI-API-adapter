import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  isDirectProviderEnvName,
  proxyChildProcessEnv,
} from '../dist/proxy/process-env.js';

const fixtureRule = createRequire(import.meta.url)(
  resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/direct-provider-env.cjs'),
);

// Names the installed CLIs actually read — probed against Claude Code 2.1.237
// and codex 0.146.0, not taken from documentation. Each one either hands a
// child a direct provider credential or points it at a direct provider.
const stripped = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  // Read by the CLI and attached to every request it makes: a header set is a
  // credential channel, and the exact-name list never covered it.
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_PROFILE',
  'AWS_REGION',
  'AZURE_CLIENT_SECRET',
  'AZURE_OPENAI_ENDPOINT',
  'BEDROCK_RERANKING_MODEL',
  'GOOGLE_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_PROJECT',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_ORG_ID',
  'OPENROUTER_API_KEY',
  // Route selection: these put the child on a direct provider, using the
  // credentials above.
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  // A credential handed over by file descriptor is still a credential.
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
];

// The other direction, which matters just as much: a classifier that answered
// "provider" to everything would satisfy every assertion above while breaking
// the child. These are the runtime's OWN local-session env — the local OAuth
// path this proxy is built on — and the operator's suppression flags, which
// must survive: stripping a `SKIP_`/`DISABLE_` flag turns the behaviour it
// suppresses back ON.
const kept = [
  'CODEX_HOME',
  'CODEX_ACCESS_TOKEN',
  'CLAUDE_CODE_SKIP_REPO_UPLOAD',
  'CLAUDE_CODE_DISABLE_TELEMETRY',
  'CLAUDE_CONFIG_DIR',
  'HOME',
  'PATH',
  'PROXY_SAFE_ENV',
];

const managed = [...stripped, ...kept];
const original = new Map(managed.map((name) => [name, process.env[name]]));
const originalTerm = process.env.TERM;

afterEach(() => {
  for (const [name, value] of original) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  if (originalTerm === undefined) delete process.env.TERM;
  else process.env.TERM = originalTerm;
});

test('proxy child process env strips every direct provider namespace', () => {
  for (const name of managed) process.env[name] = `${name}_value`;
  process.env.TERM = 'dumb';

  const env = proxyChildProcessEnv({ CODEX_HOME: '/tmp/codex-home' });

  for (const name of stripped) {
    assert.equal(name in env, false, `${name} should be stripped`);
    assert.equal(isDirectProviderEnvName(name), true, `${name} should be classified`);
  }
  assert.equal(env.TERM, 'xterm-256color');
});

test('the child keeps its own session env and the operator\'s suppression flags', () => {
  for (const name of managed) process.env[name] = `${name}_value`;

  const env = proxyChildProcessEnv({ CODEX_HOME: '/tmp/codex-home' });

  for (const name of kept) {
    assert.equal(isDirectProviderEnvName(name), false, `${name} should not be classified`);
    // CODEX_HOME is supplied as an override, so its value is the caller's.
    if (name !== 'CODEX_HOME') assert.equal(env[name], `${name}_value`, `${name} should reach the child`);
  }
  assert.equal(env.CODEX_HOME, '/tmp/codex-home');
});

test('a namespace is blocked whole, not by a list of known names', () => {
  // The point of the change: a switch added by a later CLI version is blocked
  // by the namespace it lives in, without this list learning its name.
  assert.equal(isDirectProviderEnvName('ANTHROPIC_SOMETHING_INVENTED_LATER'), true);
  assert.equal(isDirectProviderEnvName('AWS_SOMETHING_INVENTED_LATER'), true);
  assert.equal(isDirectProviderEnvName('CLAUDE_CODE_USE_SOMETHING_INVENTED_LATER'), true);
  // Namespace boundaries are respected: a longer word that merely starts with
  // one of them is a different name.
  assert.equal(isDirectProviderEnvName('AWSOME_TOOL'), false);
  assert.equal(isDirectProviderEnvName('GOOGLEBOT_UA'), false);
  assert.equal(isDirectProviderEnvName('OPENAIRE_TOKEN'), false);
});

test('the fakes classify env exactly as the runtime does', () => {
  // The fakes assert this boundary from inside a spawned child, which is the
  // only place it can be proven — and they carried their own copy of the rule,
  // so when the runtime moved to namespaces the copies kept asserting the
  // boundary it had replaced. One copy remains, and this pins it.
  for (const name of [...managed, 'AWS_BEARER_TOKEN_BEDROCK', 'AWSOME_TOOL', 'CLAUDE_CODE_USE_VERTEX', 'XAI', 'XAILINE']) {
    assert.equal(
      fixtureRule.isDirectProviderEnvName(name),
      isDirectProviderEnvName(name),
      `${name}: the fixture rule and the runtime rule disagree`,
    );
  }
});
