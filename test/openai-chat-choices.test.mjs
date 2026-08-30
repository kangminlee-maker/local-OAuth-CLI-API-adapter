import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startLocalApiProxy } from '../dist/proxy/http-server.js';

// Chat `n`, realized as n backend turns. The direct API returns n independent
// samples (measured 2026-08-30: `n: 2` gives two choices, and its stream
// interleaves them one choice per chunk with their own `index`); the runtimes
// behind this proxy have no such slot, so the turns are the realization.

function countingBackend({ fail = -1, toolCalls = false } = {}) {
  const state = { generates: 0, streams: 0, aborted: 0, signals: [] };
  const result = (turn) => ({
    id: `turn-${turn}`,
    model: 'configured-model',
    text: `answer ${turn}`,
    toolCalls: toolCalls ? [{ id: `call_${turn}`, name: 'f', arguments: '{}' }] : [],
    usage: { inputTokens: 10, outputTokens: 3 + turn, totalTokens: 13 + turn, source: 'provider' },
    latencyMs: 1,
  });
  return {
    state,
    backend: {
      name: 'test',
      model: 'configured-model',
      async generate(_request, signal) {
        const turn = state.generates++;
        state.signals.push(signal);
        if (turn === fail) throw new Error('this turn failed');
        // Give the sibling a tick to be cancelled before this one resolves.
        await new Promise((resolve) => setImmediate(resolve));
        if (signal?.aborted) {
          state.aborted += 1;
          throw new Error('aborted');
        }
        return result(turn);
      },
      async *stream(_request, signal) {
        const turn = state.streams++;
        state.signals.push(signal);
        if (turn === fail) throw new Error('this turn failed');
        if (!toolCalls) yield { type: 'text_delta', delta: `answer ${turn}` };
        else yield { type: 'tool_call_delta', index: 0, id: `call_${turn}`, name: 'f', argumentsDelta: '{}' };
        yield { type: 'completed', result: result(turn) };
      },
      async close() {},
    },
  };
}

async function post(backend, body) {
  const started = await startLocalApiProxy({ backend, host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000 });
  try {
    const res = await fetch(`${started.url}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'a-model', messages: [{ role: 'user', content: 'ping' }], ...body }),
    });
    const text = await res.text();
    return { status: res.status, text, json: text.startsWith('{') ? JSON.parse(text) : null };
  } finally {
    await started.close();
  }
}

function chunksOf(wire) {
  return [...wire.matchAll(/^data: (\{.+)$/gm)].map(([, data]) => JSON.parse(data));
}

test('n runs one backend turn per choice and reports them in order', async () => {
  const { backend, state } = countingBackend();
  const { status, json } = await post(backend, { n: 3 });
  assert.equal(status, 200);
  assert.equal(state.generates, 3, 'one turn per requested choice');
  assert.equal(json.choices.length, 3);
  for (const [index, choice] of json.choices.entries()) {
    assert.equal(choice.index, index, 'choices carry their own dense index');
    assert.equal(choice.message.role, 'assistant');
    assert.equal(choice.finish_reason, 'stop');
  }
  // Every turn's answer is present exactly once: a fan-out that returned the
  // same result three times would pass a length check and fail this.
  assert.deepEqual(
    json.choices.map((choice) => choice.message.content).sort(),
    ['answer 0', 'answer 1', 'answer 2'],
  );
});

test('a fan-out reports the prompt once and sums the completions', async () => {
  // The direct API's own shape, measured on `n: 2`: `prompt_tokens` unchanged,
  // `completion_tokens` doubled. Summing the prompt too would hand a client a
  // number no direct response can produce.
  const { backend } = countingBackend();
  const { json } = await post(backend, { n: 3 });
  assert.equal(json.usage.prompt_tokens, 10);
  assert.equal(json.usage.completion_tokens, 3 + 4 + 5);
  assert.equal(json.usage.total_tokens, 10 + 12);
});

test('n: 1 is the single-choice response it has always been', async () => {
  const { backend, state } = countingBackend();
  const { json } = await post(backend, { n: 1 });
  assert.equal(state.generates, 1);
  assert.equal(json.choices.length, 1);
  assert.equal(json.choices[0].index, 0);
  assert.equal(json.usage.completion_tokens, 3);
});

test('an omitted n is one turn, one choice', async () => {
  const { backend, state } = countingBackend();
  const { json } = await post(backend, {});
  assert.equal(state.generates, 1);
  assert.equal(json.choices.length, 1);
});

test('a failed turn fails the request and cancels its siblings', async () => {
  // The caller has its error; every sibling still running is a turn nothing
  // will read, holding a serialized backend's queue.
  const { backend, state } = countingBackend({ fail: 0 });
  const { status } = await post(backend, { n: 3 });
  assert.notEqual(status, 200);
  assert.equal(state.generates, 3, 'the siblings were started');
  assert.ok(state.signals.slice(1).every((signal) => signal?.aborted), 'and then cancelled');
});

test('the stream carries each choice under its own index, and ends once', async () => {
  const { backend, state } = countingBackend();
  const { status, text } = await post(backend, { n: 2, stream: true });
  assert.equal(status, 200);
  assert.equal(state.streams, 2);
  const chunks = chunksOf(text);
  assert.ok(chunks.every((chunk) => chunk.choices.length <= 1), 'one choice per chunk, as the direct API streams a fan-out');
  for (const index of [0, 1]) {
    const mine = chunks.filter((chunk) => chunk.choices[0]?.index === index);
    assert.equal(mine.filter((chunk) => chunk.choices[0].delta.role === 'assistant').length, 1, `choice ${index} opens exactly once`);
    assert.equal(mine.filter((chunk) => chunk.choices[0].finish_reason === 'stop').length, 1, `choice ${index} finishes exactly once`);
    assert.equal(
      mine.map((chunk) => chunk.choices[0].delta.content ?? '').join(''),
      `answer ${index}`,
      `choice ${index} carries its own turn's text`,
    );
  }
  assert.equal(text.match(/data: \[DONE\]/g).length, 1);
});

test('the streamed usage chunk reports the whole fan-out, once', async () => {
  const { backend } = countingBackend();
  const { text } = await post(backend, { n: 2, stream: true, stream_options: { include_usage: true } });
  const usageChunks = chunksOf(text).filter((chunk) => chunk.usage);
  assert.equal(usageChunks.length, 1);
  assert.deepEqual(usageChunks[0].choices, []);
  assert.equal(usageChunks[0].usage.prompt_tokens, 10);
  assert.equal(usageChunks[0].usage.completion_tokens, 3 + 4);
});

test('streamed tool calls carry the choice index, not a hard-coded zero', async () => {
  const { backend } = countingBackend({ toolCalls: true });
  const { text } = await post(backend, { n: 2, stream: true });
  const chunks = chunksOf(text);
  const toolChunks = chunks.filter((chunk) => chunk.choices[0]?.delta?.tool_calls);
  assert.ok(toolChunks.length >= 2, 'both choices streamed a tool call');
  assert.deepEqual(
    [...new Set(toolChunks.map((chunk) => chunk.choices[0].index))].sort(),
    [0, 1],
    'the tool chunks are attributed to their own choices',
  );
  for (const index of [0, 1]) {
    const mine = chunks.filter((chunk) => chunk.choices[0]?.index === index);
    assert.equal(mine.filter((chunk) => chunk.choices[0].finish_reason === 'tool_calls').length, 1);
    const ids = mine.flatMap((chunk) => (chunk.choices[0].delta.tool_calls ?? []).map((call) => call.id).filter(Boolean));
    assert.deepEqual([...new Set(ids)], [`call_${index}`], `choice ${index} reports its own turn's call id`);
  }
});

test('a failed streamed turn cancels its siblings instead of waiting out the timeout', async () => {
  // Measured before the fix: the client's error arrived at exactly
  // `requestTimeoutMs` (3003ms on a 3000ms timeout) because the merge awaited
  // `iterator.return()` on a sibling suspended inside `next()`, and that return
  // queues behind the pending call. The sibling's abort came from its own
  // timer, not from the failure.
  const state = { aborted: false, turns: 0 };
  const backend = {
    name: 'test', model: 'configured-model',
    async generate() { throw new Error('unused'); },
    async *stream(_request, signal) {
      const turn = state.turns++;
      if (turn === 0) throw new Error('this turn failed');
      // Blocks until something aborts it — which, without a shared cancel, is
      // only this turn's own request timer.
      await new Promise((resolve) => {
        if (signal?.aborted) { state.aborted = true; resolve(); return; }
        signal?.addEventListener('abort', () => { state.aborted = true; resolve(); }, { once: true });
      });
      throw new Error('aborted');
    },
    async close() {},
  };
  const started = await startLocalApiProxy({ backend, host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000 });
  try {
    const began = Date.now();
    const res = await fetch(`${started.url}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'a-model', messages: [{ role: 'user', content: 'ping' }], n: 2, stream: true }),
    });
    const text = await res.text();
    const elapsed = Date.now() - began;
    assert.equal(res.status, 200, 'the stream had already committed');
    assert.match(text, /"error"/);
    assert.ok(state.aborted, 'the surviving turn was cancelled');
    // The request timeout is 30s; anything near it means the cancel did not
    // reach the sibling and the timer is what ended the wait.
    assert.ok(elapsed < 5_000, `the client waited ${elapsed}ms for an error it should have had at once`);
  } finally {
    await started.close();
  }
});

test('a failed turn on the stream is an in-band error, not a truncated fan-out', async () => {
  const { backend } = countingBackend({ fail: 1 });
  const { status, text } = await post(backend, { n: 2, stream: true });
  assert.equal(status, 200, 'the stream had already committed');
  assert.match(text, /"error"/);
  assert.equal(text.match(/data: \[DONE\]/g).length, 1);
  const stops = chunksOf(text).filter((chunk) => chunk.choices?.[0]?.finish_reason === 'stop');
  assert.ok(stops.length < 2, 'the surviving choice must not be reported as a complete fan-out');
});
