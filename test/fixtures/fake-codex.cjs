#!/usr/bin/env node
const readline = require('node:readline');

assertNoDirectProviderEnv();

// `codex debug models` is the proxy's authority for which models exist, so the
// fake answers it with a fixed catalogue instead of contacting a server.
if (process.argv.includes('debug') && process.argv.includes('models')) {
  require('./record-models-call.cjs')();
  // `fixture-only-model` exists nowhere but here, so a test that accepts it
  // proves the list was fetched from this CLI rather than hard-coded anywhere.
  process.stdout.write(`${JSON.stringify({
    models: [
      { slug: 'gpt-5.5', supported_in_api: true, supported_reasoning_levels: [{ effort: 'medium' }] },
      { slug: 'gpt-5.6-sol', supported_in_api: true, supported_reasoning_levels: [{ effort: 'low' }] },
      { slug: 'fixture-only-model', supported_in_api: true, supported_reasoning_levels: [{ effort: 'low' }] },
    ],
  })}\n`);
  process.exit(0);
}

let threadSeq = 0;
let turnSeq = 0;
let lastThreadStartParams = null;
let lastTurnStartParams = null;
let activeImageTurns = 0;
let maxActiveImageTurns = 0;

function write(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function result(id, value = {}) {
  write({ id, result: value });
}

function emitTurn(threadId, turnId, text = 'OK') {
  write({
    method: 'item/agentMessage/delta',
    params: { threadId, turnId, delta: text },
  });
  write({
    method: 'turn/completed',
    params: {
      threadId,
      turn: { id: turnId, status: 'completed' },
    },
  });
  setTimeout(() => {
    write({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId,
        turnId,
        tokenUsage: {
          last: {
            totalTokens: 9,
            inputTokens: 5,
            cachedInputTokens: 2,
            outputTokens: 2,
            reasoningOutputTokens: 0,
          },
        },
      },
    });
  }, 0);
}

function emitEarlyTurn(threadId, turnId) {
  write({
    method: 'item/agentMessage/delta',
    params: { threadId, turnId, delta: 'EARLY_OK' },
  });
  write({
    method: 'thread/tokenUsage/updated',
    params: {
      threadId,
      turnId,
      tokenUsage: {
        last: {
          totalTokens: 11,
          inputTokens: 7,
          cachedInputTokens: 3,
          outputTokens: 2,
          reasoningOutputTokens: 1,
        },
      },
    },
  });
  write({
    method: 'turn/completed',
    params: {
      threadId,
      turn: { id: turnId, status: 'completed' },
    },
  });
}

function emitToolTurn(threadId, turnId) {
  write({
    method: 'item/agentMessage/delta',
    params: {
      threadId,
      turnId,
      delta: '{"status":"tool_calls","text":"","toolCalls":[{"arguments":"{\\"city\\"',
    },
  });
  write({
    method: 'item/agentMessage/delta',
    params: {
      threadId,
      turnId,
      delta: ':\\"Seoul\\"}","id":"call_1","name":"get_weather"}]}',
    },
  });
  write({
    method: 'thread/tokenUsage/updated',
    params: {
      threadId,
      turnId,
      tokenUsage: {
        last: {
          totalTokens: 15,
          inputTokens: 9,
          cachedInputTokens: 2,
          outputTokens: 4,
          reasoningOutputTokens: 0,
        },
      },
    },
  });
  write({
    method: 'turn/completed',
    params: {
      threadId,
      turn: { id: turnId, status: 'completed' },
    },
  });
}

function emitToolArgumentsOnlyTurn(threadId, turnId) {
  write({
    method: 'item/agentMessage/delta',
    params: {
      threadId,
      turnId,
      delta: '{"city"',
    },
  });
  write({
    method: 'item/agentMessage/delta',
    params: {
      threadId,
      turnId,
      delta: ':"Seoul"}',
    },
  });
  write({
    method: 'thread/tokenUsage/updated',
    params: {
      threadId,
      turnId,
      tokenUsage: {
        last: {
          totalTokens: 11,
          inputTokens: 7,
          cachedInputTokens: 2,
          outputTokens: 4,
          reasoningOutputTokens: 0,
        },
      },
    },
  });
  write({
    method: 'turn/completed',
    params: {
      threadId,
      turn: { id: turnId, status: 'completed' },
    },
  });
}

function emitImageTurn(threadId, turnId, options = {}) {
  const revisedPrompt = options.revisedPrompt ?? 'fake revised image prompt';
  write({
    method: 'item/completed',
    params: {
      threadId,
      turnId,
      item: {
        type: 'imageGeneration',
        id: `image_${turnId}`,
        status: 'completed',
        revisedPrompt,
        result: Buffer.from('fake-codex-image-result'.repeat(80)).toString('base64'),
      },
    },
  });
  write({
    method: 'thread/tokenUsage/updated',
    params: {
      threadId,
      turnId,
      tokenUsage: {
        last: {
          totalTokens: 17,
          inputTokens: 11,
          cachedInputTokens: 4,
          outputTokens: 6,
          reasoningOutputTokens: 2,
        },
      },
    },
  });
  write({
    method: 'turn/completed',
    params: {
      threadId,
      turn: { id: turnId, status: 'completed' },
    },
  });
}

function inputText(payload) {
  return JSON.stringify(payload.params?.input ?? []);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let payload;
  try {
    payload = JSON.parse(line);
  } catch {
    return;
  }

  if (payload.id === undefined) return;
  if (payload.method === 'initialize') {
    result(payload.id);
    return;
  }
  if (payload.method === 'thread/start') {
    threadSeq += 1;
    lastThreadStartParams = payload.params ?? null;
    result(payload.id, { thread: { id: `thread_${threadSeq}` } });
    return;
  }
  // A child that started and then stopped answering — a real failure mode the
  // proxy has to survive without waiting out a turn timeout on shutdown.
  if (process.env.FAKE_CODEX_SILENT_AFTER_START === '1') return;
  if (payload.method === 'turn/start') {
    turnSeq += 1;
    const threadId = payload.params?.threadId ?? `thread_${threadSeq}`;
    const turnId = `turn_${turnSeq}`;
    const input = inputText(payload);
    lastTurnStartParams = payload.params ?? null;
    if (input.includes('imageGeneration result')) {
      result(payload.id, { turn: { id: turnId } });
      if (input.includes('PARALLEL_IMAGE_DELAY')) {
        activeImageTurns += 1;
        maxActiveImageTurns = Math.max(maxActiveImageTurns, activeImageTurns);
        setTimeout(() => {
          emitImageTurn(threadId, turnId, {
            revisedPrompt: `fake revised image prompt max-active:${maxActiveImageTurns}`,
          });
          activeImageTurns -= 1;
        }, 80);
        return;
      }
      setTimeout(() => emitImageTurn(threadId, turnId), 0);
      return;
    }
    if (input.includes('EARLY_DELTA')) {
      emitEarlyTurn(threadId, turnId);
      result(payload.id, { turn: { id: turnId } });
      return;
    }
    if (input.includes('TOOL_STREAM_DIAGNOSTIC')) {
      result(payload.id, { turn: { id: turnId } });
      const schema = payload.params?.outputSchema;
      const argsOnly = schema?.properties?.city;
      setTimeout(() => {
        if (argsOnly) emitToolArgumentsOnlyTurn(threadId, turnId);
        else emitToolTurn(threadId, turnId);
      }, 0);
      return;
    }
    if (input.includes('DEBUG_PAYLOAD')) {
      result(payload.id, { turn: { id: turnId } });
      setTimeout(() => emitTurn(threadId, turnId, JSON.stringify(debugPayload())), 0);
      return;
    }
    const effort = payload.params?.effort;
    const text = effort === 'minimal'
      ? 'MINIMAL_OK'
      : effort === 'medium'
        ? 'MEDIUM_OK'
        : 'OK';
    // A turn that opens and then produces nothing: the child accepted the work
    // and stopped answering, so nothing ever closes the turn.
    if (process.env.FAKE_CODEX_NO_TURN_COMPLETION === '1') {
      result(payload.id, { turn: { id: turnId } });
      return;
    }
    result(payload.id, { turn: { id: turnId } });
    setTimeout(() => emitTurn(threadId, turnId, text), 0);
    return;
  }
  if (payload.method === 'turn/interrupt' || payload.method === 'thread/archive') {
    result(payload.id);
    return;
  }

  write({
    id: payload.id,
    error: { code: -32601, message: `unsupported fake Codex method: ${payload.method}` },
  });
});

rl.on('close', () => process.exit(0));

function assertNoDirectProviderEnv() {
  if (process.env.FAKE_ASSERT_NO_DIRECT_PROVIDER_ENV !== '1') return;
  const found = Object.keys(process.env).filter(isDirectProviderEnvName);
  if (found.length > 0) {
    process.stderr.write(`direct provider env leaked to fake codex: ${found.join(',')}\n`);
    process.exit(91);
  }
}

function debugPayload() {
  // cwd and the files visible there let a test PROVE ambient isolation end to
  // end: the thread must run in the isolated temp workspace, not the caller's.
  let cwdFiles = null;
  try {
    cwdFiles = lastThreadStartParams?.cwd
      ? require('node:fs').readdirSync(lastThreadStartParams.cwd)
      : null;
  } catch {
    cwdFiles = ['<unreadable>'];
  }
  return {
    turnCount: turnSeq,
    threadCwd: lastThreadStartParams?.cwd ?? null,
    threadCwdFiles: cwdFiles,
    threadStart: pick(lastThreadStartParams, [
      'baseInstructions',
      'developerInstructions',
      'personality',
      'experimentalRawEvents',
      'persistExtendedHistory',
      'config',
    ]),
    turnStart: pick(lastTurnStartParams, [
      'effort',
      'summary',
      'personality',
      'outputSchema',
      'input',
      'model',
    ]),
  };
}

function pick(value, keys) {
  const out = {};
  for (const key of keys) {
    if (Object.hasOwn(value ?? {}, key)) out[key] = value[key];
  }
  return out;
}

function isDirectProviderEnvName(name) {
  const prefixes = [
    'ANTHROPIC',
    'AZURE_OPENAI',
    'COHERE',
    'DEEPSEEK',
    'GEMINI',
    'GOOGLE',
    'GROQ',
    'MISTRAL',
    'OPENAI',
    'OPENROUTER',
    'PERPLEXITY',
    'TOGETHER',
    'XAI',
  ];
  const suffixes = [
    'ACCESS_TOKEN',
    'API_BASE',
    'API_KEY',
    'AUTH_TOKEN',
    'BASE_URL',
    'ENDPOINT',
    'ORG_ID',
    'ORGANIZATION',
    'PROJECT',
  ];
  return prefixes.some((prefix) => suffixes.some((suffix) => name === `${prefix}_${suffix}`));
}
