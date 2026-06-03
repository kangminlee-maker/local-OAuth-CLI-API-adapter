#!/usr/bin/env node
const readline = require('node:readline');

let threadSeq = 0;
let turnSeq = 0;

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
    result(payload.id, { thread: { id: `thread_${threadSeq}` } });
    return;
  }
  if (payload.method === 'turn/start') {
    turnSeq += 1;
    const threadId = payload.params?.threadId ?? `thread_${threadSeq}`;
    const turnId = `turn_${turnSeq}`;
    if (inputText(payload).includes('EARLY_DELTA')) {
      emitEarlyTurn(threadId, turnId);
      result(payload.id, { turn: { id: turnId } });
      return;
    }
    const effort = payload.params?.effort;
    const text = effort === 'minimal'
      ? 'MINIMAL_OK'
      : effort === 'medium'
        ? 'MEDIUM_OK'
        : 'OK';
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
