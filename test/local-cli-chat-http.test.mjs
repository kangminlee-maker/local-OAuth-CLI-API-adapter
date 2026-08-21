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

/**
 * A runtime whose turn produces one delta and then never finishes — the shape
 * of a CLI child that has stopped answering. It honors the abort signal, which
 * is the contract every backend in this proxy is held to.
 */
async function startHangingChatProxy(requestTimeoutMs) {
  const state = { aborted: false };
  const chatSessionManager = new LocalCliChatSessionManager({
    defaultCwd: process.cwd(),
    runtimes: {
      codex: async () => ({
        runtime: 'codex',
        native: { thread_id: 'thread_silent' },
        async *startTurn(_input, signal) {
          yield { raw: { method: 'item/agentMessage/delta' }, textDelta: 'thinking ' };
          await new Promise((_resolve, reject) => {
            const stop = () => {
              state.aborted = true;
              reject(new Error('turn aborted'));
            };
            if (signal?.aborted) stop();
            else signal?.addEventListener('abort', stop, { once: true });
          });
        },
        async close() {},
      }),
    },
  });
  const server = await startLocalApiProxy({
    host: '127.0.0.1',
    port: 0,
    requestTimeoutMs,
    chatSessionManager,
    backend: {
      name: 'fake-backend',
      model: 'fake-local-model',
      async generate() { throw new Error('unused'); },
      async close() {},
    },
  });
  return { server, state };
}

test('a native chat turn that never answers ends at the request timeout', async () => {
  // The surface applied no deadline of its own: `runTurn` was awaited with no
  // timeout and no signal, so a child that went quiet held the HTTP request
  // open forever AND left the session stuck in `running`, which answers every
  // later turn with 409.
  const { server, state } = await startHangingChatProxy(400);
  try {
    const created = await fetch(`${server.url}/local/cli/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runtime: 'codex' }),
    });
    const session = await created.json();
    const turn = await fetch(`${server.url}/local/cli/sessions/${session.id}/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'hello' }),
      // Fails the test fast instead of hanging the suite when the deadline is
      // missing; a passing run answers long before this.
      signal: AbortSignal.timeout(8_000),
    });
    const body = await turn.json();
    assert.equal(body.status, 'error');
    assert.equal(state.aborted, true, 'the turn should have been aborted, not abandoned');
    assert.match(JSON.stringify(body.events), /abort/i);

    const snapshot = await (await fetch(`${server.url}/local/cli/sessions/${session.id}`)).json();
    assert.equal(snapshot.status, 'ready', 'a timed-out turn must not leave the session running');
  } finally {
    await server.close();
  }
});

test('a turn that keeps producing is not cut off by the deadline', async () => {
  // The deadline bounds silence, not duration. A native turn is an agentic CLI
  // session that legitimately runs far longer than one request budget while
  // streaming the whole time; a total cap would kill a turn that is working.
  const chatSessionManager = new LocalCliChatSessionManager({
    defaultCwd: process.cwd(),
    runtimes: {
      codex: async () => ({
        runtime: 'codex',
        native: { thread_id: 'thread_slow' },
        async *startTurn() {
          for (let i = 0; i < 6; i += 1) {
            await new Promise((resolve) => { setTimeout(resolve, 120).unref(); });
            yield { raw: { method: 'item/agentMessage/delta' }, textDelta: `${i} ` };
          }
        },
        async close() {},
      }),
    },
  });
  // Every step is inside the budget; the turn as a whole runs well past it.
  const server = await startLocalApiProxy({
    host: '127.0.0.1',
    port: 0,
    requestTimeoutMs: 300,
    chatSessionManager,
    backend: { name: 'fake-backend', model: 'm', async generate() { throw new Error('unused'); }, async close() {} },
  });
  try {
    const created = await fetch(`${server.url}/local/cli/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runtime: 'codex' }),
    });
    const session = await created.json();
    const turn = await fetch(`${server.url}/local/cli/sessions/${session.id}/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'hello' }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await turn.json();
    assert.equal(body.status, 'completed');
    assert.equal(body.final.text, '0 1 2 3 4 5 ');
  } finally {
    await server.close();
  }
});

test('a native chat stream that never answers ends at the request timeout', async () => {
  const { server } = await startHangingChatProxy(400);
  try {
    const created = await fetch(`${server.url}/local/cli/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runtime: 'codex' }),
    });
    const session = await created.json();
    const response = await fetch(`${server.url}/local/cli/sessions/${session.id}/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'hello', stream: true }),
      signal: AbortSignal.timeout(8_000),
    });
    const events = parseSse(await response.text());
    assert.equal(events.at(-1).event, 'cli.error');
  } finally {
    await server.close();
  }
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
