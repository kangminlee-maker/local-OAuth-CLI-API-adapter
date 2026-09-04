import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  codexProxyTransport,
  codexProxyImageTransport,
  codexProxyImageModel,
  codexProxyFallbackReasoningEffort,
  codexProxyFallbackVerbosity,
  holdToolTurnsUntilComplete,
  isCodexProxyTransport,
  isCodexProxyImageTransport,
  isReasoningEffort,
  isVerbosity,
  loadSettings,
} from '../dist/settings.js';

test('settings.json provides the Codex proxy fallback reasoning effort', () => {
  assert.equal(loadSettings().codexProxy.transport, 'codex-backend');
  assert.equal(codexProxyTransport(), 'codex-backend');
  assert.equal(loadSettings().codexProxy.imageTransport, 'codex-backend');
  assert.equal(codexProxyImageTransport(), 'codex-backend');
  assert.equal(loadSettings().codexProxy.fallbackReasoningEffort, 'medium');
  assert.equal(codexProxyFallbackReasoningEffort(), 'medium');
  assert.equal(loadSettings().codexProxy.fallbackVerbosity, 'medium');
  assert.equal(codexProxyFallbackVerbosity(), 'medium');
  assert.equal(loadSettings().codexProxy.imageModel, 'gpt-5.5');
  assert.equal(codexProxyImageModel(), 'gpt-5.5');
});

test('settings.json holds tool turns until their completed reading by default', () => {
  // The packaged file says so explicitly, and the loader's own fallback for an
  // absent key is the same answer — an install that predates the key is on too;
  // `false` is the rollback.
  assert.equal(loadSettings().holdToolTurnsUntilComplete, true);
  assert.equal(holdToolTurnsUntilComplete(), true);
});

test('settings reasoning effort validator shares the provider effort enum', () => {
  assert.equal(isCodexProxyTransport('codex-backend'), true);
  assert.equal(isCodexProxyTransport('direct-api'), false);
  assert.equal(isCodexProxyImageTransport('codex-backend'), true);
  assert.equal(isCodexProxyImageTransport('direct-api'), false);
  assert.equal(isReasoningEffort('medium'), true);
  assert.equal(isReasoningEffort('tiny'), false);
  assert.equal(isVerbosity('medium'), true);
  assert.equal(isVerbosity('tiny'), false);
});
