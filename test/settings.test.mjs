import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  codexProxyFallbackReasoningEffort,
  isReasoningEffort,
  loadSettings,
} from '../dist/settings.js';

test('settings.json provides the Codex proxy fallback reasoning effort', () => {
  assert.equal(loadSettings().codexProxy.fallbackReasoningEffort, 'medium');
  assert.equal(codexProxyFallbackReasoningEffort(), 'medium');
});

test('settings reasoning effort validator shares the provider effort enum', () => {
  assert.equal(isReasoningEffort('medium'), true);
  assert.equal(isReasoningEffort('tiny'), false);
});
