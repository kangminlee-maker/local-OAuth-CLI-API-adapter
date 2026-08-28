import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  normalizeAnthropicMessagesRequest,
  normalizeOpenAiChatRequest,
  normalizeOpenAiResponsesRequest,
} from '../dist/proxy/normalizers.js';
import { claudeMessageContentFor } from '../dist/proxy/multimodal.js';
import { buildPrompt } from '../dist/proxy/backend-contract.js';

const RED_PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('OpenAI chat normalizer preserves request reasoning_effort', () => {
  const request = normalizeOpenAiChatRequest({
    model: 'codex-app-server',
    reasoning_effort: 'minimal',
    messages: [{ role: 'user', content: 'Say OK' }],
  });

  assert.equal(request.reasoningEffort, 'minimal');
});

test('OpenAI responses normalizer preserves request reasoning.effort', () => {
  const request = normalizeOpenAiResponsesRequest({
    model: 'codex-app-server',
    reasoning: { effort: 'high' },
    text: { verbosity: 'high' },
    input: 'Say OK',
  });

  assert.equal(request.reasoningEffort, 'high');
  assert.equal(request.verbosity, 'high');
});

test('OpenAI chat normalizer preserves request verbosity', () => {
  const request = normalizeOpenAiChatRequest({
    model: 'codex-app-server',
    verbosity: 'low',
    messages: [{ role: 'user', content: 'Say OK' }],
  });

  assert.equal(request.verbosity, 'low');
});

test('OpenAI chat normalizer preserves developer role', () => {
  const request = normalizeOpenAiChatRequest({
    model: 'codex-app-server',
    messages: [
      { role: 'developer', content: 'Use terse style.' },
      { role: 'user', content: 'Say OK' },
    ],
  });

  assert.equal(request.messages[0].role, 'developer');
  assert.equal(request.messages[0].content, 'Use terse style.');
});

test('OpenAI normalizer rejects invalid reasoning effort', () => {
  assert.throws(
    () => normalizeOpenAiChatRequest({
      model: 'codex-app-server',
      reasoning_effort: 'tiny',
      messages: [{ role: 'user', content: 'Say OK' }],
    }),
    /reasoning effort must be one of/,
  );
});

test('OpenAI normalizer rejects invalid verbosity', () => {
  assert.throws(
    () => normalizeOpenAiResponsesRequest({
      model: 'codex-app-server',
      text: { verbosity: 'tiny' },
      input: 'Say OK',
    }),
    /verbosity must be one of/,
  );
});

test('OpenAI chat normalizer preserves json_schema name and strict (B1)', () => {
  const request = normalizeOpenAiChatRequest({
    model: 'codex-app-server',
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'my_review_schema', strict: false, schema: { type: 'object' } },
    },
    messages: [{ role: 'user', content: 'x' }],
  });

  assert.equal(request.jsonSchemaName, 'my_review_schema');
  assert.equal(request.jsonSchemaStrict, false);
  assert.deepEqual(request.jsonSchema, { type: 'object' });
});

test('OpenAI responses normalizer preserves json_schema name and strict (B1)', () => {
  const request = normalizeOpenAiResponsesRequest({
    model: 'codex-app-server',
    text: { format: { type: 'json_schema', name: 'resp_schema', strict: true, schema: { type: 'object' } } },
    input: 'x',
  });

  assert.equal(request.jsonSchemaName, 'resp_schema');
  assert.equal(request.jsonSchemaStrict, true);
});

test('Anthropic normalizer reads output_config.format into jsonSchema/jsonMode', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['ok'],
    properties: { ok: { type: 'boolean' } },
  };
  const request = normalizeAnthropicMessagesRequest({
    model: 'claude-opus-4-8',
    max_tokens: 256,
    output_config: { format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content: 'Reply JSON' }],
  });

  assert.equal(request.jsonMode, true);
  assert.deepEqual(request.jsonSchema, schema);
});

test('Anthropic normalizer leaves jsonMode false without output_config.format', () => {
  const request = normalizeAnthropicMessagesRequest({
    model: 'claude-opus-4-8',
    max_tokens: 256,
    messages: [{ role: 'user', content: 'Say OK' }],
  });

  assert.equal(request.jsonMode, false);
  assert.equal(request.jsonSchema, undefined);
});

test('Anthropic normalizer reads output_config.effort', () => {
  const request = normalizeAnthropicMessagesRequest({
    model: 'claude-opus-4-8',
    max_tokens: 256,
    output_config: { effort: 'max' },
    messages: [{ role: 'user', content: 'Say OK' }],
  });

  assert.equal(request.effort, 'max');
});

test('Anthropic normalizer rejects invalid output_config.effort', () => {
  assert.throws(
    () => normalizeAnthropicMessagesRequest({
      model: 'claude-opus-4-8',
      max_tokens: 256,
      output_config: { effort: 'minimal' },
      messages: [{ role: 'user', content: 'Say OK' }],
    }),
    /output_config.effort must be one of/,
  );
});

test('Anthropic normalizer reads output_config.task_budget and thinking', () => {
  const request = normalizeAnthropicMessagesRequest({
    model: 'claude-opus-4-8',
    max_tokens: 256,
    output_config: { task_budget: { type: 'tokens', total: 20000 } },
    thinking: { type: 'adaptive', display: 'omitted' },
    messages: [{ role: 'user', content: 'Say OK' }],
  });

  assert.equal(request.taskBudgetTokens, 20000);
  assert.deepEqual(request.thinking, { type: 'adaptive', display: 'omitted' });
});

function anthropicBody(overrides) {
  return {
    model: 'claude-opus-4-8',
    max_tokens: 256,
    messages: [{ role: 'user', content: 'Say OK' }],
    ...overrides,
  };
}

test('Anthropic normalizer rejects non-tokens / sub-minimum / fractional task_budget', () => {
  assert.throws(
    () => normalizeAnthropicMessagesRequest(anthropicBody({ output_config: { task_budget: { type: 'duration_seconds', total: 30 } } })),
    /task_budget.type must be tokens/,
  );
  assert.throws(
    () => normalizeAnthropicMessagesRequest(anthropicBody({ output_config: { task_budget: { type: 'tokens', total: 5000 } } })),
    /at least 20000/,
  );
  assert.throws(
    () => normalizeAnthropicMessagesRequest(anthropicBody({ output_config: { task_budget: { type: 'tokens', total: 20000.5 } } })),
    /must be an integer/,
  );
});

test('Anthropic normalizer accepts thinking enabled and rejects unknown types', () => {
  // `enabled` requires budget_tokens on the direct API (>= 1024, < max_tokens).
  const enabled = normalizeAnthropicMessagesRequest(anthropicBody({
    max_tokens: 4096,
    thinking: { type: 'enabled', budget_tokens: 2048 },
  }));
  // deepEqual is the absence pin: budget_tokens is validated and deliberately
  // NOT carried — no backend consumes it, and a carried number would let a
  // mock assert a delivery no real backend performs.
  assert.deepEqual(enabled.thinking, { type: 'enabled', display: undefined });
  assert.throws(
    () => normalizeAnthropicMessagesRequest(anthropicBody({ thinking: { type: 'enabled' } })),
    /budget_tokens is required/,
  );
  assert.throws(
    () => normalizeAnthropicMessagesRequest(anthropicBody({ thinking: { type: 'sometimes' } })),
    /thinking.type must be one of/,
  );
});

test('Anthropic normalizer drops display for disabled thinking', () => {
  const request = normalizeAnthropicMessagesRequest(anthropicBody({ thinking: { type: 'disabled', display: 'summarized' } }));
  assert.deepEqual(request.thinking, { type: 'disabled', display: undefined });
});

test('Anthropic normalizer rejects json_schema format without a schema', () => {
  assert.throws(
    () => normalizeAnthropicMessagesRequest(anthropicBody({ output_config: { format: { type: 'json_schema' } } })),
    /requires a schema/,
  );
});

test('Anthropic normalizer rejects output_config.format combined with tools', () => {
  assert.throws(
    () => normalizeAnthropicMessagesRequest(anthropicBody({
      output_config: { format: { type: 'json_schema', schema: { type: 'object' } } },
      tools: [{ name: 'get_weather', input_schema: { type: 'object' } }],
    })),
    /not supported together with tools/,
  );
});

test('an image inside a tool_result reaches the runtime as an image, not as prose', async () => {
  // A consumer reported this as broken and worked around it. It was not: the
  // symptom belonged to the tool channel being closed on the turn AFTER a tool
  // result, so the call that would have fetched the image never went out. This
  // pins the part that was suspected, so the next such report is answered in
  // seconds rather than by reading the pipeline again.
  const request = normalizeAnthropicMessagesRequest({
    model: 'claude-opus-5',
    max_tokens: 100,
    tools: [{ name: 'get_image', description: 'd', input_schema: { type: 'object', properties: {}, additionalProperties: false } }],
    messages: [
      { role: 'user', content: '이미지를 가져와서 색을 말해줘.' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'get_image', input: {} }] },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 't1',
          content: [
            { type: 'text', text: '이미지입니다.' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: RED_PIXEL_PNG } },
          ],
        }],
      },
    ],
  });

  assert.equal(request.messages.at(-1).images.length, 1, 'the tool result carries its image');
  const prompt = buildPrompt(request);
  const content = await claudeMessageContentFor(request, prompt);
  const image = content.find((block) => block.type === 'image');
  assert.ok(image, `no image block reached the runtime: ${JSON.stringify(content).slice(0, 200)}`);
  assert.equal(image.source.data, RED_PIXEL_PNG);
  // And the text half still describes the result the image came with.
  assert.match(prompt, /tool result/);
});
