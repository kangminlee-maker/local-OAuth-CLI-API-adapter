import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  normalizeAnthropicMessagesRequest,
  normalizeOpenAiChatRequest,
  normalizeOpenAiResponsesRequest,
} from '../dist/proxy/normalizers.js';

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
  const enabled = normalizeAnthropicMessagesRequest(anthropicBody({ thinking: { type: 'enabled' } }));
  assert.deepEqual(enabled.thinking, { type: 'enabled', display: undefined });
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
