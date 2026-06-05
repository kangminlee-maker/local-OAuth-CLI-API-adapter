import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
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
