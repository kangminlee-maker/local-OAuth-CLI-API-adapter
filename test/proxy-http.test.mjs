import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { startLocalApiProxy } from '../dist/proxy/http-server.js';

let started;
let seenRequests;
const pngDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

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
        if (request.messages.some((message) => message.content.includes('FAIL_PROVIDER'))) {
          throw new Error(JSON.stringify({
            message: JSON.stringify({
              status: 400,
              error: {
                type: 'invalid_request_error',
                message: 'Unsupported value: requested effort is not supported with this model.',
                param: 'reasoning.effort',
                code: 'unsupported_value',
              },
            }),
          }));
        }
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
            totalTokens: toolCalls.length > 0 ? 15 : 8,
            cachedInputTokens: 2,
            reasoningOutputTokens: toolCalls.length > 0 ? 3 : 0,
            source: 'provider',
          },
          latencyMs: 1,
        };
      },
      async close() {},
    },
  });
});

test('OpenAI request reasoning effort reaches the backend', async () => {
  const chat = await postJson('/v1/chat/completions', {
    model: 'fake-local-model',
    reasoning_effort: 'high',
    messages: [{ role: 'user', content: 'Say OK' }],
  });
  await chat.json();

  const responses = await postJson('/v1/responses', {
    model: 'fake-local-model',
    reasoning: { effort: 'low' },
    input: 'Say OK',
  });
  await responses.json();

  assert.equal(chat.status, 200);
  assert.equal(responses.status, 200);
  assert.equal(seenRequests[0].reasoningEffort, 'high');
  assert.equal(seenRequests[1].reasoningEffort, 'low');
});

test('provider invalid request errors preserve OpenAI 4xx shape', async () => {
  const res = await postJson('/v1/chat/completions', {
    model: 'fake-local-model',
    messages: [{ role: 'user', content: 'FAIL_PROVIDER' }],
  });
  const body = await res.json();

  assert.equal(res.status, 400);
  assert.equal(body.error.type, 'invalid_request_error');
  assert.equal(body.error.param, 'reasoning_effort');
  assert.equal(body.error.code, 'unsupported_value');
  assert.match(body.error.message, /requested effort/);
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
  assert.match(body.id, /^chatcmpl-/);
  assert.equal(body.choices[0].message.refusal, null);
  assert.deepEqual(body.choices[0].message.annotations, []);
  assert.equal(body.choices[0].finish_reason, 'stop');
  assert.equal(seenRequests[0].shape, 'openai-chat');
});

test('OpenAI responses usage exposes provider token details', async () => {
  const res = await postJson('/v1/responses', {
    model: 'fake-local-model',
    input: 'Say OK',
  });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal('output_text' in body, false);
  assert.equal(body.output[0].type, 'reasoning');
  assert.equal(body.output[1].type, 'message');
  assert.equal(body.usage.input_tokens, 7);
  assert.equal(body.usage.output_tokens, 1);
  assert.equal(body.usage.total_tokens, 8);
  assert.equal(body.usage.input_tokens_details.cached_tokens, 2);
  assert.equal(body.usage.output_tokens_details.reasoning_tokens, 0);
});

test('POST /v1/chat/completions preserves OpenAI image_url input parts', async () => {
  const res = await postJson('/v1/chat/completions', {
    model: 'fake-local-model',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'Describe the image.' },
        { type: 'image_url', image_url: { url: pngDataUrl, detail: 'high' } },
      ],
    }],
  });
  await res.json();

  assert.equal(res.status, 200);
  assert.equal(seenRequests[0].messages[0].content, 'Describe the image.');
  assert.equal(seenRequests[0].messages[0].images[0].source.type, 'base64');
  assert.equal(seenRequests[0].messages[0].images[0].source.mediaType, 'image/png');
  assert.equal(seenRequests[0].messages[0].images[0].detail, 'high');
});

test('POST /v1/responses preserves input_image URL parts', async () => {
  const res = await postJson('/v1/responses', {
    model: 'fake-local-model',
    input: [{
      role: 'user',
      content: [
        { type: 'input_image', image_url: 'https://example.com/image.png', detail: 'low' },
        { type: 'input_text', text: 'Describe the image.' },
      ],
    }],
  });
  await res.json();

  assert.equal(res.status, 200);
  assert.equal(seenRequests[0].shape, 'openai-responses');
  assert.equal(seenRequests[0].messages[0].content, 'Describe the image.');
  assert.equal(seenRequests[0].messages[0].images[0].source.type, 'url');
  assert.equal(seenRequests[0].messages[0].images[0].source.url, 'https://example.com/image.png');
  assert.equal(seenRequests[0].messages[0].images[0].detail, 'low');
});

test('POST /v1/messages preserves Anthropic image blocks', async () => {
  const res = await postJson('/v1/messages', {
    model: 'fake-local-model',
    max_tokens: 16,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: pngDataUrl.split(',')[1],
          },
        },
        { type: 'text', text: 'Describe the image.' },
      ],
    }],
  });
  await res.json();

  assert.equal(res.status, 200);
  assert.equal(seenRequests[0].shape, 'anthropic-messages');
  assert.equal(seenRequests[0].messages[0].content, 'Describe the image.');
  assert.equal(seenRequests[0].messages[0].images[0].source.type, 'base64');
  assert.equal(seenRequests[0].messages[0].images[0].source.mediaType, 'image/png');
});

test('file_id image inputs return a clear error instead of pretending to see them', async () => {
  const res = await postJson('/v1/responses', {
    model: 'fake-local-model',
    input: [{
      role: 'user',
      content: [
        { type: 'input_image', file_id: 'file_abc123' },
        { type: 'input_text', text: 'Describe the image.' },
      ],
    }],
  });
  const body = await res.json();

  assert.equal(res.status, 400);
  assert.match(body.error.message, /file_id image sources are not supported/);
  assert.equal(seenRequests.length, 0);
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

test('OpenAI chat stream supports include_usage final chunk', async () => {
  const res = await postJson('/v1/chat/completions', {
    model: 'fake-local-model',
    stream: true,
    stream_options: { include_usage: true },
    messages: [{ role: 'user', content: 'Say OK' }],
  });
  const text = await res.text();

  assert.equal(res.status, 200);
  assert.match(text, /"usage":null/);
  assert.match(text, /"choices":\[\],"usage":\{"prompt_tokens":7,"completion_tokens":1,"total_tokens":8/);
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
  assert.match(text, /event: response\.in_progress/);
  assert.match(text, /event: response\.output_text\.delta/);
  assert.match(text, /"sequence_number":0/);
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

test('Anthropic messages usage preserves provider cache token fields', async () => {
  const usageServer = await startProxyWithBackend({
    name: 'usage-backend',
    model: 'fake-local-model',
    async generate(request) {
      return {
        id: 'local_usage',
        model: request.model,
        text: 'OK',
        toolCalls: [],
        usage: {
          inputTokens: 3,
          outputTokens: 2,
          totalTokens: 12,
          cachedInputTokens: 7,
          cacheCreationInputTokens: 4,
          cacheReadInputTokens: 3,
          source: 'provider',
        },
        latencyMs: 1,
      };
    },
    async close() {},
  });
  try {
    const res = await postJsonTo(usageServer.url, '/v1/messages', {
      model: 'fake-local-model',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'Say OK' }],
    });
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.usage.input_tokens, 3);
    assert.equal(body.usage.output_tokens, 2);
    assert.equal(body.usage.cache_creation_input_tokens, 4);
    assert.equal(body.usage.cache_read_input_tokens, 3);
  } finally {
    await usageServer.close();
  }
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

test('OpenAI chat stream forwards live tool call argument deltas', async () => {
  const live = await startProxyWithBackend(toolStreamingBackend());
  try {
    const res = await postJsonTo(live.url, '/v1/chat/completions', {
      model: 'fake-local-model',
      stream: true,
      messages: [{ role: 'user', content: 'Use weather tool' }],
      tools: [openAiWeatherTool()],
      tool_choice: 'required',
    });
    const text = await res.text();

    assert.equal(res.status, 200);
    assert.match(text, /"tool_calls"/);
    assert.match(text, /"name":"get_weather","arguments":""/);
    assert.match(text, /"arguments":"\{\\?"city\\?""/);
    assert.match(text, /"arguments":":\\?"Seoul\\?"\}"/);
    assert.doesNotMatch(text, /"arguments":"\{\\?"city\\?":\\?"Seoul\\?"\}"/);
    assert.match(text, /"finish_reason":"tool_calls"/);
    assert.ok(
      text.indexOf('"name":"get_weather","arguments":""') < text.indexOf('"arguments":"{\\\"city\\\""'),
      'tool start chunk should precede argument deltas',
    );
  } finally {
    await live.close();
  }
});

test('OpenAI responses stream forwards live function argument deltas', async () => {
  const live = await startProxyWithBackend(toolStreamingBackend());
  try {
    const res = await postJsonTo(live.url, '/v1/responses', {
      model: 'fake-local-model',
      stream: true,
      input: 'Use weather tool',
      tools: [openAiWeatherTool()],
      tool_choice: 'required',
    });
    const text = await res.text();

    assert.equal(res.status, 200);
    assert.match(text, /event: response\.output_item\.added/);
    assert.match(text, /event: response\.function_call_arguments\.delta/);
    assert.match(text, /"delta":"\{\\?"city\\?""/);
    assert.match(text, /"delta":":\\?"Seoul\\?"\}"/);
    assert.doesNotMatch(text, /"delta":"\{\\?"city\\?":\\?"Seoul\\?"\}"/);
    assert.match(text, /event: response\.function_call_arguments\.done/);
    assert.match(text, /event: response\.output_item\.done/);
    assert.match(text, /"name":"get_weather"/);
  } finally {
    await live.close();
  }
});

test('Anthropic messages stream forwards live tool input deltas', async () => {
  const live = await startProxyWithBackend(toolStreamingBackend());
  try {
    const res = await postJsonTo(live.url, '/v1/messages', {
      model: 'fake-local-model',
      stream: true,
      max_tokens: 128,
      messages: [{ role: 'user', content: 'Use weather tool' }],
      tools: [{
        name: 'get_weather',
        input_schema: weatherSchema(),
      }],
      tool_choice: { type: 'any' },
    });
    const text = await res.text();

    assert.equal(res.status, 200);
    assert.match(text, /event: content_block_start/);
    assert.match(text, /"partial_json":"\{\\?"city\\?""/);
    assert.match(text, /"partial_json":":\\?"Seoul\\?"\}"/);
    assert.doesNotMatch(text, /"partial_json":"\{\\?"city\\?":\\?"Seoul\\?"\}"/);
    assert.match(text, /event: content_block_stop/);
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

function toolStreamingBackend() {
  return {
    name: 'tool-streaming-fake-backend',
    model: 'fake-local-model',
    async generate(request) {
      return toolCompletionResult(request.model);
    },
    async *stream(request) {
      yield {
        type: 'tool_call_delta',
        index: 0,
        id: 'call_1',
        name: 'get_weather',
        argumentsDelta: '{"city"',
      };
      yield {
        type: 'tool_call_delta',
        index: 0,
        argumentsDelta: ':"Seoul"}',
      };
      yield { type: 'completed', result: toolCompletionResult(request.model) };
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

function toolCompletionResult(model) {
  return {
    id: 'local_tool_test',
    model,
    text: '',
    toolCalls: [
      {
        id: 'call_1',
        name: 'get_weather',
        arguments: '{"city":"Seoul"}',
      },
    ],
    usage: {
      inputTokens: 7,
      outputTokens: 8,
      totalTokens: 15,
      cachedInputTokens: 2,
      reasoningOutputTokens: 3,
      source: 'provider',
    },
    latencyMs: 1,
  };
}

function openAiWeatherTool() {
  return {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Get current weather by city.',
      parameters: weatherSchema(),
    },
  };
}

function weatherSchema() {
  return {
    type: 'object',
    properties: {
      city: { type: 'string' },
    },
    required: ['city'],
  };
}
