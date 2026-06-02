import { createClaudeRuntime } from './claude.js';
import { createCodexRuntime } from './codex.js';
import { createMockRuntime } from './mock.js';
import type {
  CliRuntime,
  RuntimeFactoryOptions,
  RuntimeName,
} from '../types.js';

export function createRuntime(
  name: RuntimeName,
  options: RuntimeFactoryOptions = {},
): CliRuntime {
  if (name === 'codex') return createCodexRuntime(options);
  if (name === 'claude') return createClaudeRuntime(options);
  return createMockRuntime(options);
}
