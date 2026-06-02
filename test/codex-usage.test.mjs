import assert from 'node:assert/strict';
import { test } from 'node:test';
import { usageFromCodexTokenUsage } from '../dist/proxy/codex-app-server-backend.js';

test('Codex token usage notifications preserve provider breakdown fields', () => {
  const usage = usageFromCodexTokenUsage({
    total: {
      totalTokens: 99,
      inputTokens: 10,
      cachedInputTokens: 4,
      outputTokens: 8,
      reasoningOutputTokens: 3,
    },
    last: {
      totalTokens: 25,
      inputTokens: 12,
      cachedInputTokens: 5,
      outputTokens: 8,
      reasoningOutputTokens: 4,
    },
    modelContextWindow: 100000,
  });

  assert.equal(usage.inputTokens, 12);
  assert.equal(usage.outputTokens, 8);
  assert.equal(usage.totalTokens, 25);
  assert.equal(usage.cachedInputTokens, 5);
  assert.equal(usage.reasoningOutputTokens, 4);
  assert.equal(usage.source, 'provider');
});
