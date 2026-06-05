import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  codexProxyImageModel,
  codexProxyFallbackReasoningEffort,
  codexProxyFallbackVerbosity,
  isReasoningEffort,
  isVerbosity,
  loadSettings,
} from '../dist/settings.js';

test('settings.json provides the Codex proxy fallback reasoning effort', () => {
  assert.equal(loadSettings().codexProxy.fallbackReasoningEffort, 'medium');
  assert.equal(codexProxyFallbackReasoningEffort(), 'medium');
  assert.equal(loadSettings().codexProxy.fallbackVerbosity, 'medium');
  assert.equal(codexProxyFallbackVerbosity(), 'medium');
  assert.equal(loadSettings().codexProxy.imageModel, 'gpt-5.5');
  assert.equal(codexProxyImageModel(), 'gpt-5.5');
});

test('settings reasoning effort validator shares the provider effort enum', () => {
  assert.equal(isReasoningEffort('medium'), true);
  assert.equal(isReasoningEffort('tiny'), false);
  assert.equal(isVerbosity('medium'), true);
  assert.equal(isVerbosity('tiny'), false);
});
