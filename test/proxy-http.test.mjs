import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { openAiImageQualityReasoningEffort, startLocalApiProxy } from '../dist/proxy/http-server.js';

let started;
let seenRequests;
let seenImageGenerationRequests;
const pngDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

beforeEach(async () => {
  seenRequests = [];
  seenImageGenerationRequests = [];
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
    imageGenerationClient: {
      async generate(request) {
        seenImageGenerationRequests.push(request);
        return {
          created: 123,
          images: Array.from({ length: request.n }, (_, index) => ({
            b64Json: Buffer.from(`fake-image-${index + 1}:${request.prompt}`).toString('base64'),
            revisedPrompt: `revised ${index + 1}: ${request.prompt}`,
          })),
          background: request.background,
          outputFormat: request.outputFormat,
          quality: request.quality,
          size: request.size,
          usage: {
            inputTokens: 11,
            outputTokens: 6,
            totalTokens: 17,
            cachedInputTokens: 4,
            reasoningOutputTokens: 2,
            source: 'provider',
          },
          latencyMs: 1,
        };
      },
      async *stream(request) {
        seenImageGenerationRequests.push(request);
        if (request.prompt.includes('FAIL_IMAGE_STREAM_PROVIDER')) {
          throw new Error(JSON.stringify({
            message: JSON.stringify({
              status: 429,
              error: {
                type: 'insufficient_quota',
                message: 'Image quota exceeded.',
                param: null,
                code: 'insufficient_quota',
              },
            }),
          }));
        }
        yield {
          type: 'partial_image',
          created: 122,
          partialImageIndex: 0,
          image: {
            b64Json: Buffer.from(`partial:${request.prompt}`).toString('base64'),
          },
          background: request.background,
          outputFormat: request.outputFormat,
          quality: request.quality,
          size: request.size,
        };
        yield {
          type: 'completed',
          created: 123,
          image: {
            b64Json: Buffer.from(`final:${request.prompt}`).toString('base64'),
            revisedPrompt: `stream revised: ${request.prompt}`,
          },
          background: request.background,
          outputFormat: request.outputFormat,
          quality: request.quality,
          size: request.size,
        };
      },
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

test('image-2 quality maps to gpt-5.5 reasoning effort', () => {
  assert.equal(openAiImageQualityReasoningEffort(undefined), 'high');
  assert.equal(openAiImageQualityReasoningEffort('high'), 'high');
  assert.equal(openAiImageQualityReasoningEffort('medium'), 'medium');
  assert.equal(openAiImageQualityReasoningEffort('low'), 'low');
  assert.equal(openAiImageQualityReasoningEffort('auto'), 'high');
});

test('default Images API proxy rejects local CLI image generation without direct OpenAI fallback', async () => {
  const originalKey = process.env.OPENAI_API_KEY;
  const originalFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = 'fake-openai-key';
  let openAiCalls = 0;
  const localOnly = await startLocalApiProxy({
    host: '127.0.0.1',
    port: 0,
    requestTimeoutMs: 10_000,
    backend: {
      name: 'fake-backend',
      model: 'fake-local-model',
      async generate() {
        throw new Error('text backend should not be used for images');
      },
      async close() {},
    },
  });

  globalThis.fetch = async (url, init) => {
    const target = typeof url === 'string' ? url : url instanceof URL ? url.href : url?.url;
    if (typeof target === 'string' && target.startsWith('https://api.openai.com/')) {
      openAiCalls += 1;
      throw new Error('unexpected direct OpenAI API call');
    }
    return originalFetch(url, init);
  };

  try {
    const res = await fetch(`${localOnly.url}/v1/images/generations`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer local',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-image-1.5',
        prompt: 'A small red square.',
      }),
    });
    const body = await res.json();

    assert.equal(res.status, 501);
    assert.equal(body.error.type, 'unsupported_feature');
    assert.match(body.error.message, /Direct OpenAI API fallback is disabled/);
    assert.equal(openAiCalls, 0);
  } finally {
    await localOnly.close();
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  }
});

test('default streaming Images API proxy reports unsupported without direct OpenAI fallback', async () => {
  const localOnly = await startLocalApiProxy({
    host: '127.0.0.1',
    port: 0,
    requestTimeoutMs: 10_000,
    backend: {
      name: 'fake-backend',
      model: 'fake-local-model',
      async generate() {
        throw new Error('text backend should not be used for images');
      },
      async close() {},
    },
  });

  try {
    const res = await fetch(`${localOnly.url}/v1/images/generations`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer local',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-image-1.5',
        prompt: 'A streaming red square.',
        stream: true,
      }),
    });
    const text = await res.text();

    assert.equal(res.status, 200);
    assert.match(text, /event: error/);
    assert.match(text, /"type":"unsupported_feature"/);
    assert.match(text, /Direct OpenAI API fallback is disabled/);
  } finally {
    await localOnly.close();
  }
});

test('POST /v1/images/generations accepts image-2 through the local image2_via_gpt55 route', async () => {
  const res = await fetch(`${started.url}/v1/images/generations`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer local',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'image-2',
      prompt: 'A small red square.',
      response_format: 'b64_json',
    }),
  });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(seenImageGenerationRequests[0].model, 'image-2');
  assert.equal(seenImageGenerationRequests[0].responseFormat, 'b64_json');
  assert.equal(body.data[0].b64_json, Buffer.from('fake-image-1:A small red square.').toString('base64'));
});

test('POST /v1/images/generations reports image-2 transparent background as a disabled model value', async () => {
  const res = await postJson('/v1/images/generations', {
    model: 'image-2',
    prompt: 'A transparent sticker.',
    background: 'transparent',
    output_format: 'png',
  });
  const body = await res.json();

  assert.equal(res.status, 400);
  assert.equal(body.error.type, 'image_generation_user_error');
  assert.equal(body.error.param, 'tools');
  assert.equal(body.error.code, 'invalid_value');
  assert.match(body.error.message, /Transparent background is not supported/);
});

test('POST /v1/images/generations rejects response_format for GPT image models', async () => {
  const res = await fetch(`${started.url}/v1/images/generations`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer local',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-image-1.5',
      prompt: 'A small red square.',
      response_format: 'b64_json',
    }),
  });
  const body = await res.json();

  assert.equal(res.status, 400);
  assert.equal(body.error.type, 'invalid_request_error');
  assert.equal(body.error.param, 'response_format');
  assert.equal(body.error.code, 'unknown_parameter');
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
  // This backend reports no reasoning item (and 0 reasoning tokens), so the
  // response carries none: the surface reports what the runtime produced.
  assert.equal(body.output[0].type, 'message');
  assert.equal(body.output.some((item) => item.type === 'reasoning'), false);
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

test('POST /v1/images/generations maps GPT image requests to the image generation client', async () => {
  const res = await postJson('/v1/images/generations', {
    model: 'gpt-image-1.5',
    prompt: 'A small red square.',
    n: 2,
    size: '1024x1024',
    quality: 'low',
    output_format: 'webp',
    output_compression: 80,
    background: 'opaque',
    moderation: 'low',
    user: 'end-user-123',
  });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(seenRequests.length, 0);
  assert.equal(seenImageGenerationRequests.length, 1);
  assert.equal(seenImageGenerationRequests[0].model, 'gpt-image-1.5');
  assert.equal(seenImageGenerationRequests[0].prompt, 'A small red square.');
  assert.equal(seenImageGenerationRequests[0].n, 2);
  assert.equal(seenImageGenerationRequests[0].size, '1024x1024');
  assert.equal(seenImageGenerationRequests[0].quality, 'low');
  assert.equal(seenImageGenerationRequests[0].outputFormat, 'webp');
  assert.equal(seenImageGenerationRequests[0].outputCompression, 80);
  assert.equal(seenImageGenerationRequests[0].background, 'opaque');
  assert.equal(seenImageGenerationRequests[0].moderation, 'low');
  assert.equal(seenImageGenerationRequests[0].user, 'end-user-123');
  assert.equal(body.created, 123);
  assert.equal(body.size, '1024x1024');
  assert.equal(body.quality, 'low');
  assert.equal(body.output_format, 'webp');
  assert.equal(body.background, 'opaque');
  assert.equal(body.usage.input_tokens, 11);
  assert.equal(body.usage.output_tokens, 6);
  assert.equal(body.usage.total_tokens, 17);
  assert.equal(body.usage.input_tokens_details.cached_tokens, 4);
  assert.equal(body.usage.output_tokens_details.reasoning_tokens, 2);
  assert.equal(body.data.length, 2);
  assert.equal(body.data[0].b64_json, Buffer.from('fake-image-1:A small red square.').toString('base64'));
  assert.equal(body.data[0].revised_prompt, 'revised 1: A small red square.');
});

test('POST /v1/images/generations accepts proxy image route hints', async () => {
  const res = await postJson('/v1/images/generations', {
    model: 'image-2',
    prompt: 'Create a simple flat circular badge.',
    x_proxy_image_route: {
      visual_class: 'badge_or_emblem',
      output_format: 'webp',
      output_compression: 95,
      geometry_mode: 'strict',
    },
  });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(seenImageGenerationRequests[0].outputFormat, 'webp');
  assert.equal(seenImageGenerationRequests[0].outputCompression, 95);
  assert.deepEqual(seenImageGenerationRequests[0].proxyRoute, {
    visualClass: 'badge_or_emblem',
    outputFormat: 'webp',
    outputCompression: 95,
    geometryMode: 'strict',
  });
  assert.equal(body.output_format, 'webp');
});

test('POST /v1/images/generations keeps standard output_format ahead of proxy route output_format', async () => {
  const res = await postJson('/v1/images/generations', {
    model: 'image-2',
    prompt: 'Create a simple flat icon.',
    output_format: 'png',
    x_proxy_image_route: {
      visual_class: 'geometric_icon',
      output_format: 'webp',
      geometry_mode: 'strict',
    },
  });

  assert.equal(res.status, 200);
  assert.equal(seenImageGenerationRequests[0].outputFormat, 'png');
  assert.equal(seenImageGenerationRequests[0].proxyRoute.outputFormat, 'webp');
});

test('POST /v1/images/generations rejects invalid proxy image route hints', async () => {
  const res = await postJson('/v1/images/generations', {
    model: 'image-2',
    prompt: 'Create a simple flat icon.',
    x_proxy_image_route: {
      visual_class: 'flat_icon',
    },
  });
  const body = await res.json();

  assert.equal(res.status, 400);
  assert.match(body.error.message, /x_proxy_image_route\.visual_class/);
  assert.equal(seenImageGenerationRequests.length, 0);
});

test('POST /v1/images/generations supports URL response format with local image URLs', async () => {
  const res = await postJson('/v1/images/generations', {
    model: 'dall-e-2',
    prompt: 'A small red square.',
    response_format: 'url',
  });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(seenImageGenerationRequests[0].responseFormat, 'url');
  assert.equal(body.output_format, undefined);
  assert.equal(body.quality, undefined);
  assert.equal(body.size, undefined);
  assert.equal(body.background, undefined);
  assert.equal(body.data[0].b64_json, undefined);
  assert.match(body.data[0].url, /^http:\/\/127\.0\.0\.1:\d+\/v1\/images\/generated\//);

  const imageRes = await fetch(body.data[0].url);
  assert.equal(imageRes.status, 200);
  assert.equal(imageRes.headers.get('content-type'), 'image/png');
  assert.equal(
    Buffer.from(await imageRes.arrayBuffer()).toString('utf8'),
    'fake-image-1:A small red square.',
  );
});

test('POST /v1/images/generations streams completed image events without partial output', async () => {
  const res = await postJson('/v1/images/generations', {
    model: 'gpt-image-1.5',
    prompt: 'A streaming red square.',
    stream: true,
  });
  const text = await res.text();

  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
  assert.equal(seenImageGenerationRequests[0].stream, true);
  assert.equal(seenImageGenerationRequests[0].partialImages, 0);
  assert.doesNotMatch(text, /image_generation\.partial_image/);
  assert.match(text, /event: image_generation\.completed/);
  assert.match(text, /"type":"image_generation\.completed"/);
  assert.equal((text.match(/event: image_generation\.completed/g) ?? []).length, 1);
  assert.match(text, /"b64_json"/);
});

test('POST /v1/images/generations rejects partial_images because partial output is unsupported', async () => {
  const res = await postJson('/v1/images/generations', {
    model: 'gpt-image-1.5',
    prompt: 'A streaming red square.',
    stream: true,
    partial_images: 1,
  });
  const body = await res.json();

  assert.equal(res.status, 400);
  assert.equal(body.error.type, 'image_generation_user_error');
  assert.equal(body.error.param, 'partial_images');
  assert.equal(body.error.code, 'unsupported_value');
  assert.match(body.error.message, /partial_images is not supported/);
  assert.equal(seenImageGenerationRequests.length, 0);
});

test('POST /v1/images/generations stream preserves provider error fields', async () => {
  const res = await postJson('/v1/images/generations', {
    model: 'gpt-image-1.5',
    prompt: 'FAIL_IMAGE_STREAM_PROVIDER',
    stream: true,
  });
  const text = await res.text();

  assert.equal(res.status, 200);
  assert.match(text, /event: error/);
  assert.match(text, /"type":"insufficient_quota"/);
  assert.match(text, /"code":"insufficient_quota"/);
  assert.match(text, /"message":"Image quota exceeded\."/);
});

test('POST /v1/images/edits accepts JSON image references', async () => {
  const res = await postJson('/v1/images/edits', {
    model: 'gpt-image-1.5',
    prompt: 'Make the square green.',
    images: [{ image_url: pngDataUrl }],
    mask: { image_url: pngDataUrl },
    input_fidelity: 'high',
    output_format: 'jpeg',
    output_compression: 55,
    moderation: 'auto',
  });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(seenImageGenerationRequests[0].operation, 'edit');
  assert.equal(seenImageGenerationRequests[0].images.length, 1);
  assert.equal(seenImageGenerationRequests[0].images[0].source.type, 'base64');
  assert.equal(seenImageGenerationRequests[0].mask.source.type, 'base64');
  assert.equal(seenImageGenerationRequests[0].inputFidelity, 'high');
  assert.equal(seenImageGenerationRequests[0].outputFormat, 'jpeg');
  assert.equal(seenImageGenerationRequests[0].outputCompression, 55);
  assert.equal(seenImageGenerationRequests[0].moderation, 'auto');
  assert.equal(body.data[0].b64_json, Buffer.from('fake-image-1:Make the square green.').toString('base64'));
});

test('POST /v1/images/edits reports image-2 input_fidelity as an API-disabled field', async () => {
  const res = await postJson('/v1/images/edits', {
    model: 'image-2',
    prompt: 'Make the square green.',
    images: [{ image_url: pngDataUrl }],
    input_fidelity: 'high',
    response_format: 'b64_json',
  });
  const body = await res.json();

  assert.equal(res.status, 400);
  assert.equal(body.error.type, 'image_generation_user_error');
  assert.equal(body.error.param, 'tools');
  assert.equal(body.error.code, 'invalid_input_fidelity_model');
});

test('POST /v1/images/edits accepts multipart image array fields and string options', async () => {
  const form = new FormData();
  form.set('model', 'gpt-image-1.5');
  form.append('image[]', new Blob([Buffer.from('fake-png-1')], { type: 'image/png' }), 'source-1.png');
  form.append('image[]', new Blob([Buffer.from('fake-png-2')], { type: 'image/png' }), 'source-2.png');
  form.set('prompt', 'Combine these images.');
  form.set('n', '2');
  form.set('stream', 'true');
  form.set('x_proxy_image_route', JSON.stringify({
    visual_class: 'reference_or_edit',
    output_format: 'webp',
  }));
  const res = await fetch(`${started.url}/v1/images/edits`, {
    method: 'POST',
    headers: { authorization: 'Bearer local' },
    body: form,
  });
  const text = await res.text();

  assert.equal(res.status, 200);
  assert.equal(seenImageGenerationRequests[0].operation, 'edit');
  assert.equal(seenImageGenerationRequests[0].images.length, 2);
  assert.equal(seenImageGenerationRequests[0].n, 2);
  assert.equal(seenImageGenerationRequests[0].stream, true);
  assert.equal(seenImageGenerationRequests[0].partialImages, 0);
  assert.equal(seenImageGenerationRequests[0].outputFormat, 'webp');
  assert.equal(seenImageGenerationRequests[0].proxyRoute.visualClass, 'reference_or_edit');
  assert.doesNotMatch(text, /image_edit\.partial_image/);
  assert.match(text, /event: image_edit\.completed/);
});

test('POST /v1/images/variations accepts multipart image uploads', async () => {
  const form = new FormData();
  form.set('model', 'dall-e-2');
  form.set('image', new Blob([Buffer.from('fake-png')], { type: 'image/png' }), 'source.png');
  form.set('response_format', 'b64_json');
  const res = await fetch(`${started.url}/v1/images/variations`, {
    method: 'POST',
    headers: { authorization: 'Bearer local' },
    body: form,
  });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(seenImageGenerationRequests[0].operation, 'variation');
  assert.equal(seenImageGenerationRequests[0].prompt, 'Create a variation of the provided image.');
  assert.equal(seenImageGenerationRequests[0].images.length, 1);
  assert.equal(seenImageGenerationRequests[0].images[0].source.type, 'base64');
  assert.equal(seenImageGenerationRequests[0].images[0].source.mediaType, 'image/png');
  assert.equal(body.data[0].b64_json, Buffer.from('fake-image-1:Create a variation of the provided image.').toString('base64'));
});

test('POST /v1/images/variations accepts image-2 multipart uploads through image2_via_gpt55', async () => {
  const form = new FormData();
  form.set('model', 'image-2');
  form.set('image', new Blob([Buffer.from('fake-png')], { type: 'image/png' }), 'source.png');
  form.set('response_format', 'b64_json');
  const res = await fetch(`${started.url}/v1/images/variations`, {
    method: 'POST',
    headers: { authorization: 'Bearer local' },
    body: form,
  });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(seenImageGenerationRequests[0].operation, 'variation');
  assert.equal(seenImageGenerationRequests[0].model, 'image-2');
  assert.equal(body.data[0].b64_json, Buffer.from('fake-image-1:Create a variation of the provided image.').toString('base64'));
});

test('POST /v1/images/variations rejects JSON image input to match the Images API form-data shape', async () => {
  const res = await postJson('/v1/images/variations', {
    model: 'dall-e-2',
    image: pngDataUrl,
    response_format: 'b64_json',
  });
  const body = await res.json();

  assert.equal(res.status, 400);
  assert.equal(body.error.type, 'invalid_request_error');
  assert.match(body.error.message, /multipart\/form-data/);
});

test('POST /v1/images/generations rejects output compression without jpeg or webp output', async () => {
  const res = await postJson('/v1/images/generations', {
    model: 'gpt-image-1.5',
    prompt: 'A small red square.',
    output_format: 'png',
    output_compression: 80,
  });
  const body = await res.json();

  assert.equal(res.status, 400);
  assert.equal(body.error.type, 'image_generation_user_error');
  assert.equal(body.error.code, 'invalid_png_output_compression');
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

test('Anthropic messages response includes stop_details (null on end_turn)', async () => {
  const res = await postJson('/v1/messages', {
    model: 'fake-local-model',
    max_tokens: 16,
    messages: [{ role: 'user', content: 'Say OK' }],
  });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.stop_reason, 'end_turn');
  assert.equal(body.stop_sequence, null);
  assert.ok('stop_details' in body);
  assert.equal(body.stop_details, null);
});

test('Anthropic messages mirrors refusal stop_reason with empty content', async () => {
  const server = await startProxyWithBackend({
    name: 'refusal-backend',
    model: 'fake-local-model',
    async generate(request) {
      return {
        id: 'local_refusal',
        model: request.model,
        text: '',
        toolCalls: [],
        usage: { inputTokens: 3, outputTokens: 0, source: 'provider' },
        latencyMs: 1,
        stopReason: 'refusal',
        stopDetails: { type: 'refusal', category: 'bio' },
      };
    },
    async close() {},
  });
  try {
    const res = await postJsonTo(server.url, '/v1/messages', {
      model: 'fake-local-model',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'unsafe' }],
    });
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.stop_reason, 'refusal');
    assert.deepEqual(body.content, []);
    assert.deepEqual(body.stop_details, { type: 'refusal', category: 'bio' });
  } finally {
    await server.close();
  }
});

test('Anthropic refusal keeps assistant text when the model produced some', async () => {
  const server = await startProxyWithBackend({
    name: 'refusal-with-text-backend',
    model: 'fake-local-model',
    async generate(request) {
      return {
        id: 'local_refusal_text',
        model: request.model,
        text: 'I can help with that, but',
        toolCalls: [],
        usage: { inputTokens: 3, outputTokens: 5, source: 'provider' },
        latencyMs: 1,
        stopReason: 'refusal',
      };
    },
    async close() {},
  });
  try {
    const res = await postJsonTo(server.url, '/v1/messages', {
      model: 'fake-local-model',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'hi' }],
    });
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.stop_reason, 'refusal');
    assert.equal(body.content[0].type, 'text');
    assert.equal(body.content[0].text, 'I can help with that, but');
    assert.deepEqual(body.stop_details, { type: 'refusal', category: null });
  } finally {
    await server.close();
  }
});

test('Anthropic messages passes through max_tokens stop_reason', async () => {
  const server = await startProxyWithBackend({
    name: 'truncate-backend',
    model: 'fake-local-model',
    async generate(request) {
      return {
        id: 'local_trunc',
        model: request.model,
        text: 'partial',
        toolCalls: [],
        usage: { inputTokens: 3, outputTokens: 1, source: 'provider' },
        latencyMs: 1,
        stopReason: 'max_tokens',
      };
    },
    async close() {},
  });
  try {
    const res = await postJsonTo(server.url, '/v1/messages', {
      model: 'fake-local-model',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'long' }],
    });
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.stop_reason, 'max_tokens');
    assert.equal(body.stop_details, null);
    assert.equal(body.content[0].text, 'partial');
  } finally {
    await server.close();
  }
});

test('Anthropic messages drops stop_details that contradict a downgraded stop_reason', async () => {
  const server = await startProxyWithBackend({
    name: 'overflow-backend',
    model: 'fake-local-model',
    async generate(request) {
      return {
        id: 'local_of',
        model: request.model,
        text: 'partial',
        toolCalls: [],
        usage: { inputTokens: 3, outputTokens: 1, source: 'provider' },
        latencyMs: 1,
        // A reason not in the Anthropic passthrough set: stop_reason downgrades to
        // end_turn, so the raw details must not ride along.
        stopReason: 'model_context_window_exceeded',
        stopDetails: { type: 'model_context_window_exceeded' },
      };
    },
    async close() {},
  });
  try {
    const res = await postJsonTo(server.url, '/v1/messages', {
      model: 'fake-local-model',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'x' }],
    });
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.stop_reason, 'end_turn');
    assert.equal(body.stop_details, null);
  } finally {
    await server.close();
  }
});

test('Anthropic messages threads the matched stop_sequence', async () => {
  const server = await startProxyWithBackend({
    name: 'stopseq-backend',
    model: 'fake-local-model',
    async generate(request) {
      return {
        id: 'local_ss',
        model: request.model,
        text: 'up to here',
        toolCalls: [],
        usage: { inputTokens: 3, outputTokens: 2, source: 'provider' },
        latencyMs: 1,
        stopReason: 'stop_sequence',
        stopSequence: '###',
      };
    },
    async close() {},
  });
  try {
    const res = await postJsonTo(server.url, '/v1/messages', {
      model: 'fake-local-model',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'x' }],
    });
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.stop_reason, 'stop_sequence');
    assert.equal(body.stop_sequence, '###');
  } finally {
    await server.close();
  }
});

test('Anthropic stream emits refusal text + stop_reason when not pre-streamed', async () => {
  const server = await startProxyWithBackend({
    name: 'stream-refusal-backend',
    model: 'fake-local-model',
    async generate(request) {
      return {
        id: 'local_sr',
        model: request.model,
        text: 'I cannot help with that.',
        toolCalls: [],
        usage: { inputTokens: 3, outputTokens: 6, source: 'provider' },
        latencyMs: 1,
        stopReason: 'refusal',
      };
    },
    async close() {},
  });
  try {
    const res = await postJsonTo(server.url, '/v1/messages', {
      model: 'fake-local-model',
      stream: true,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'x' }],
    });
    const text = await res.text();

    assert.equal(res.status, 200);
    // Before the fix, a refusal with non-streamed text emitted zero content blocks.
    assert.match(text, /event: content_block_start/);
    assert.match(text, /"text":"I cannot help with that\."/);
    assert.match(text, /"stop_reason":"refusal"/);
  } finally {
    await server.close();
  }
});

test('Anthropic stream carries max_tokens stop_reason in message_delta', async () => {
  const server = await startProxyWithBackend({
    name: 'stream-maxtokens-backend',
    model: 'fake-local-model',
    async generate(request) {
      return {
        id: 'local_smt',
        model: request.model,
        text: 'partial',
        toolCalls: [],
        usage: { inputTokens: 3, outputTokens: 1, source: 'provider' },
        latencyMs: 1,
        stopReason: 'max_tokens',
      };
    },
    async close() {},
  });
  try {
    const res = await postJsonTo(server.url, '/v1/messages', {
      model: 'fake-local-model',
      stream: true,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'x' }],
    });
    const text = await res.text();

    assert.equal(res.status, 200);
    assert.match(text, /"stop_reason":"max_tokens"/);
    assert.match(text, /"text":"partial"/);
  } finally {
    await server.close();
  }
});

test('Anthropic stream closes the text block and offsets tool_use index when both occur', async () => {
  const server = await startProxyWithBackend({
    name: 'text-then-tool-backend',
    model: 'fake-local-model',
    async generate(request) {
      return { id: 'g', model: request.model, text: '', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, source: 'provider' }, latencyMs: 1 };
    },
    async *stream(request) {
      yield { type: 'text_delta', delta: 'let me check ' };
      yield {
        type: 'completed',
        result: {
          id: 'tt',
          model: request.model,
          text: '',
          toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: '{"city":"Seoul"}' }],
          usage: { inputTokens: 1, outputTokens: 1, source: 'provider' },
          latencyMs: 1,
        },
      };
    },
    async close() {},
  });
  try {
    const res = await postJsonTo(server.url, '/v1/messages', {
      model: 'fake-local-model',
      stream: true,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'weather?' }],
    });
    const text = await res.text();

    assert.equal(res.status, 200);
    // text block 0 opened then closed; tool_use opens at index 1 (no index collision).
    assert.match(text, /"type":"content_block_stop","index":0/);
    assert.match(text, /"type":"content_block_start","index":1,"content_block":\{"type":"tool_use"/);
    assert.match(text, /"stop_reason":"tool_use"/);
  } finally {
    await server.close();
  }
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

function authTextBackend() {
  return {
    name: 'fake-backend',
    model: 'fake-local-model',
    async generate() {
      return {
        id: 'local_test',
        model: 'fake-local-model',
        text: 'OK',
        toolCalls: [],
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          cachedInputTokens: 0,
          reasoningOutputTokens: 0,
          source: 'provider',
        },
        latencyMs: 1,
      };
    },
    async close() {},
  };
}

function startAuthProxy(authKey) {
  return startLocalApiProxy({
    host: '127.0.0.1',
    port: 0,
    requestTimeoutMs: 10_000,
    authKey,
    backend: authTextBackend(),
  });
}

const authChatBody = JSON.stringify({
  model: 'fake-local-model',
  messages: [{ role: 'user', content: 'hi' }],
});
const authMessagesBody = JSON.stringify({
  model: 'fake-local-model',
  max_tokens: 16,
  messages: [{ role: 'user', content: 'hi' }],
});

test('auth-key gate: missing key returns OpenAI-shaped 401', async () => {
  const proxy = await startAuthProxy('secret-key');
  try {
    const res = await fetch(`${proxy.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: authChatBody,
    });
    const body = await res.json();
    assert.equal(res.status, 401);
    assert.equal(body.error.type, 'invalid_request_error');
    assert.equal(body.error.code, 'invalid_api_key');
  } finally {
    await proxy.close();
  }
});

test('auth-key gate: wrong key returns 401', async () => {
  const proxy = await startAuthProxy('secret-key');
  try {
    const res = await fetch(`${proxy.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer nope' },
      body: authChatBody,
    });
    assert.equal(res.status, 401);
  } finally {
    await proxy.close();
  }
});

test('auth-key gate: correct Bearer key passes', async () => {
  const proxy = await startAuthProxy('secret-key');
  try {
    const res = await fetch(`${proxy.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer secret-key' },
      body: authChatBody,
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.choices[0].message.content, 'OK');
  } finally {
    await proxy.close();
  }
});

test('auth-key gate: x-api-key passes and anthropic 401 keeps provider error shape', async () => {
  const proxy = await startAuthProxy('secret-key');
  try {
    const ok = await fetch(`${proxy.url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'secret-key' },
      body: authMessagesBody,
    });
    assert.equal(ok.status, 200);

    const denied = await fetch(`${proxy.url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'wrong' },
      body: authMessagesBody,
    });
    const body = await denied.json();
    assert.equal(denied.status, 401);
    assert.equal(body.type, 'error');
    assert.equal(body.error.type, 'authentication_error');
  } finally {
    await proxy.close();
  }
});

test('auth-key gate: a real CORS preflight bypasses the gate', async () => {
  // A preflight is the browser's permission question, sent before it will
  // attach credentials — which is why it is exempt. It always names the method
  // it is asking about; that header is what identifies it.
  const proxy = await startAuthProxy('secret-key');
  try {
    const res = await fetch(`${proxy.url}/v1/chat/completions`, {
      method: 'OPTIONS',
      headers: { 'access-control-request-method': 'POST', origin: 'http://localhost:3000' },
    });
    assert.equal(res.status, 204);
  } finally {
    await proxy.close();
  }
});

test('auth-key gate: a bare OPTIONS is an ordinary request and does not skip the gate', async () => {
  // Without the preflight header this is just a request with an unusual method.
  // Answering 204 let an unauthenticated caller distinguish served paths.
  const proxy = await startAuthProxy('secret-key');
  try {
    const res = await fetch(`${proxy.url}/v1/chat/completions`, { method: 'OPTIONS' });
    assert.equal(res.status, 401);
  } finally {
    await proxy.close();
  }
});

test('auth-key gate: open proxy without a key allows unauthenticated requests', async () => {
  const proxy = await startAuthProxy(undefined);
  try {
    const res = await fetch(`${proxy.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: authChatBody,
    });
    assert.equal(res.status, 200);
  } finally {
    await proxy.close();
  }
});
