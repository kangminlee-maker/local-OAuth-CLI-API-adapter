import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { startLocalApiProxy } from '../dist/proxy/http-server.js';

let started;
let seenRequests;

beforeEach(async () => {
  seenRequests = [];
  started = await startLocalApiProxy({
    host: '127.0.0.1',
    port: 0,
    requestTimeoutMs: 10_000,
    backend: {
      name: 'fake-backend',
      model: 'fake-local-model',
      async generate(request) {
        seenRequests.push(request);
        const tool = request.tools[0];
        const toolCalls = tool && request.toolChoice.type !== 'none'
          ? [
              {
                id: 'call_1',
                name: tool.name,
                arguments: '{"city":"Seoul"}',
              },
            ]
          : [];
        return {
          id: 'local_test',
          model: request.model,
          text: toolCalls.length > 0 ? '' : 'OK',
          toolCalls,
          usage: {
            inputTokens: 7,
            outputTokens: toolCalls.length > 0 ? 8 : 1,
          },
          latencyMs: 1,
        };
      },
      async close() {},
    },
  });
});

afterEach(async () => {
  await started?.close();
  started = undefined;
});

test('GET /v1/models returns an OpenAI-compatible model list', async () => {
  const res = await fetch(`${started.url}/v1/models`);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.object, 'list');
  assert.equal(body.data[0].id, 'fake-local-model');
});

test('POST /v1/chat/completions returns text in OpenAI chat shape', async () => {
  const res = await postJson('/v1/chat/completions', {
    model: 'fake-local-model',
    messages: [{ role: 'user', content: 'Say OK' }],
  });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.choices[0].message.content, 'OK');
  assert.equal(body.choices[0].finish_reason, 'stop');
  assert.equal(seenRequests[0].shape, 'openai-chat');
});

test('POST /v1/chat/completions returns OpenAI tool calls', async () => {
  const res = await postJson('/v1/chat/completions', {
    model: 'fake-local-model',
    messages: [{ role: 'user', content: 'Use weather tool' }],
    tools: [
      {
        type: 'function',
        function: {
          name: 'get_weather',
          parameters: {
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city'],
          },
        },
      },
    ],
    tool_choice: 'required',
  });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.choices[0].finish_reason, 'tool_calls');
  assert.equal(body.choices[0].message.tool_calls[0].function.name, 'get_weather');
  assert.equal(body.choices[0].message.tool_calls[0].function.arguments, '{"city":"Seoul"}');
});

test('OpenAI chat stream emits completion chunks and DONE', async () => {
  const res = await postJson('/v1/chat/completions', {
    model: 'fake-local-model',
    stream: true,
    messages: [{ role: 'user', content: 'Say OK' }],
  });
  const text = await res.text();

  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
  assert.match(text, /"object":"chat\.completion\.chunk"/);
  assert.match(text, /"content":"OK"/);
  assert.match(text, /data: \[DONE\]/);
});

test('OpenAI responses stream emits output_text deltas', async () => {
  const res = await postJson('/v1/responses', {
    model: 'fake-local-model',
    stream: true,
    input: 'Say OK',
  });
  const text = await res.text();

  assert.equal(res.status, 200);
  assert.match(text, /event: response\.created/);
  assert.match(text, /event: response\.output_text\.delta/);
  assert.match(text, /"delta":"OK"/);
  assert.match(text, /event: response\.completed/);
});

test('Anthropic messages stream emits text deltas', async () => {
  const res = await postJson('/v1/messages', {
    model: 'fake-local-model',
    stream: true,
    max_tokens: 16,
    messages: [{ role: 'user', content: 'Say OK' }],
  });
  const text = await res.text();

  assert.equal(res.status, 200);
  assert.match(text, /event: message_start/);
  assert.match(text, /event: content_block_delta/);
  assert.match(text, /"text":"OK"/);
  assert.match(text, /event: message_stop/);
});

test('Anthropic messages returns tool_use for tool requests', async () => {
  const res = await postJson('/v1/messages', {
    model: 'fake-local-model',
    max_tokens: 128,
    messages: [{ role: 'user', content: 'Use weather tool' }],
    tools: [
      {
        name: 'get_weather',
        input_schema: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
      },
    ],
    tool_choice: { type: 'any' },
  });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.stop_reason, 'tool_use');
  assert.equal(body.content[0].type, 'tool_use');
  assert.equal(body.content[0].name, 'get_weather');
  assert.deepEqual(body.content[0].input, { city: 'Seoul' });
});

test('OpenAI chat stream forwards live backend text deltas', async () => {
  const live = await startProxyWithBackend(streamingBackend());
  try {
    const res = await postJsonTo(live.url, '/v1/chat/completions', {
      model: 'fake-local-model',
      stream: true,
      messages: [{ role: 'user', content: 'Say OK' }],
    });
    const text = await res.text();

    assert.equal(res.status, 200);
    assert.match(text, /"content":"O"/);
    assert.match(text, /"content":"K"/);
    assert.doesNotMatch(text, /"content":"OK"/);
    assert.match(text, /data: \[DONE\]/);
  } finally {
    await live.close();
  }
});

test('Anthropic stream forwards live backend text deltas', async () => {
  const live = await startProxyWithBackend(streamingBackend());
  try {
    const res = await postJsonTo(live.url, '/v1/messages', {
      model: 'fake-local-model',
      stream: true,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'Say OK' }],
    });
    const text = await res.text();

    assert.equal(res.status, 200);
    assert.match(text, /event: content_block_delta/);
    assert.match(text, /"text":"O"/);
    assert.match(text, /"text":"K"/);
    assert.doesNotMatch(text, /"text":"OK"/);
  } finally {
    await live.close();
  }
});

async function postJson(path, body) {
  return postJsonTo(started.url, path, body);
}

async function postJsonTo(url, path, body) {
  return fetch(`${url}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer local',
      'x-api-key': 'local',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
}

async function startProxyWithBackend(backend) {
  return startLocalApiProxy({
    host: '127.0.0.1',
    port: 0,
    requestTimeoutMs: 10_000,
    backend,
  });
}

function streamingBackend() {
  return {
    name: 'streaming-fake-backend',
    model: 'fake-local-model',
    async generate() {
      return completionResult();
    },
    async *stream() {
      yield { type: 'text_delta', delta: 'O' };
      yield { type: 'text_delta', delta: 'K' };
      yield { type: 'completed', result: completionResult() };
    },
    async close() {},
  };
}

function completionResult() {
  return {
    id: 'local_test',
    model: 'fake-local-model',
    text: 'OK',
    toolCalls: [],
    usage: {
      inputTokens: 7,
      outputTokens: 1,
    },
    latencyMs: 1,
  };
}
