import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ClaudeNativeCliChatSession } from '../dist/chat/claude-native-session.js';

const here = dirname(fileURLToPath(import.meta.url));
const echoArgvClaude = resolve(here, 'fixtures/echo-argv-claude.cjs');

// The native chat surface spawns its own child, so it needs its own coverage:
// the API backend and this session are separate spawn sites, and an operator
// enabling isolation on the proxy expects both to honour it.
async function sessionArgv(options = {}) {
  const session = await ClaudeNativeCliChatSession.create({
    command: echoArgvClaude,
    cwd: process.cwd(),
    model: 'claude-opus-4-8',
    timeoutMs: 30_000,
    ...options,
  });
  try {
    let text = '';
    for await (const event of session.startTurn({ input: 'Say OK' })) {
      if (typeof event.textDelta === 'string') text += event.textDelta;
      const result = event.raw;
      if (result && typeof result === 'object' && result.type === 'result') {
        text = typeof result.result === 'string' ? result.result : text;
      }
    }
    return JSON.parse(text).argv;
  } finally {
    await session.close();
  }
}

function settingSourcesIn(argv) {
  const i = argv.indexOf('--setting-sources');
  assert.ok(i !== -1, `expected --setting-sources in argv: ${argv.join(' ')}`);
  return argv[i + 1];
}

test('native chat session: the user setting source loads by default', async () => {
  assert.equal(settingSourcesIn(await sessionArgv()), 'user');
});

test('native chat session: isolateUserSettings loads no setting source', async () => {
  assert.equal(settingSourcesIn(await sessionArgv({ isolateUserSettings: true })), '');
});
