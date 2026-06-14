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
