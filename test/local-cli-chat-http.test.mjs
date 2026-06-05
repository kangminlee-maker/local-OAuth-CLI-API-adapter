import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { LocalCliChatSessionManager } from '../dist/chat/session-manager.js';
import { startLocalApiProxy } from '../dist/proxy/http-server.js';

let started;
let closed = 0;
let interrupted = 0;

beforeEach(async () => {
  closed = 0;
  interrupted = 0;
  const chatSessionManager = new LocalCliChatSessionManager({
    defaultCwd: process.cwd(),
    runtimes: {
      codex: async (input) => ({
        runtime: 'codex',
        native: { thread_id: 'thread_fake', cwd: input.cwd },
        async *startTurn(turn) {
          const text = typeof turn.input === 'string'
            ? turn.input
            : turn.input.find((part) => part.type === 'text')?.text ?? '';
          yield {
            raw: { method: 'item/agentMessage/delta', params: { delta: 'HELLO ' } },
            textDelta: 'HELLO ',
          };
          yield {
            raw: { method: 'item/agentMessage/delta', params: { delta: text } },
            textDelta: text,
          };
          yield {
            raw: { method: 'thread/tokenUsage/updated', params: { totalTokens: 3 } },
            usage: { totalTokens: 3 },
          };
        },
        async interrupt() {
          interrupted += 1;
        },
        async close() {
          closed += 1;
        },
      }),
    },
  });
  started = await startLocalApiProxy({
    host: '127.0.0.1',
    port: 0,
    requestTimeoutMs: 10_000,
    chatSessionManager,
    backend: {
      name: 'fake-backend',
      model: 'fake-local-model',
      async generate() {
        throw new Error('provider-compatible backend should not be used by local chat tests');
      },
      async close() {},
    },
  });
});

afterEach(async () => {
  await started?.close();
  started = undefined;
});

test('local CLI chat session lifecycle and non-stream turn', async () => {
  const created = await postJson('/local/cli/sessions', {
    runtime: 'codex',
    title: 'Test chat',
  });
  const session = await created.json();
  assert.equal(created.status, 201);
  assert.match(session.id, /^sess_/);
  assert.equal(session.runtime, 'codex');
  assert.equal(session.status, 'ready');
  assert.equal(session.native.thread_id, 'thread_fake');

  const inspected = await fetch(`${started.url}/local/cli/sessions/${session.id}`);
  const inspectedBody = await inspected.json();
  assert.equal(inspected.status, 200);
  assert.equal(inspectedBody.id, session.id);

  const turn = await postJson(`/local/cli/sessions/${session.id}/turns`, {
    input: 'WORLD',
    stream: false,
  });
  const turnBody = await turn.json();
  assert.equal(turn.status, 200);
  assert.match(turnBody.id, /^turn_/);
  assert.equal(turnBody.status, 'completed');
  assert.equal(turnBody.final.text, 'HELLO WORLD');
  assert.equal(turnBody.usage.totalTokens, 3);
  assert.equal(turnBody.events.at(-1).event, 'cli.completed');

  const close = await fetch(`${started.url}/local/cli/sessions/${session.id}`, {
    method: 'DELETE',
  });
  const closeBody = await close.json();
  assert.equal(close.status, 200);
  assert.equal(closeBody.status, 'closed');
  assert.equal(closed, 1);
});

test('local CLI chat stream emits native SSE envelope', async () => {
  const created = await postJson('/local/cli/sessions', { runtime: 'codex' });
  const session = await created.json();
  const response = await postJson(`/local/cli/sessions/${session.id}/turns`, {
    input: [{ type: 'text', text: 'STREAM' }],
    stream: true,
  });
  assert.equal(response.status, 200);
  const events = parseSse(await response.text());
  assert.equal(events.at(-1).event, 'cli.completed');
  assert.equal(events[0].event, 'cli.event');
  assert.equal(events[0].payload.session_id, session.id);
  assert.equal(events[0].payload.runtime, 'codex');
  assert.equal(events[0].payload.text_delta, 'HELLO ');
  assert.equal(events[1].payload.raw.method, 'item/agentMessage/delta');
});

test('local CLI chat interrupt delegates to runtime session', async () => {
  const created = await postJson('/local/cli/sessions', { runtime: 'codex' });
  const session = await created.json();
  const response = await postJson(`/local/cli/sessions/${session.id}/interrupt`, {});
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.status, 'interrupting');
  assert.equal(interrupted, 1);
});

test('disabled runtime returns local chat error shape', async () => {
  const response = await postJson('/local/cli/sessions', { runtime: 'claude' });
  const body = await response.json();
  assert.equal(response.status, 400);
  assert.equal(body.error.type, 'local_cli_chat_error');
  assert.equal(body.error.code, 'runtime_not_enabled');
});

async function postJson(path, body) {
  return await fetch(`${started.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function parseSse(text) {
  return text.trim().split(/\n\n/).map((chunk) => {
    const event = /^event: (.+)$/m.exec(chunk)?.[1];
    const data = /^data: (.+)$/m.exec(chunk)?.[1];
    return {
      event,
      payload: JSON.parse(data),
    };
  });
}
