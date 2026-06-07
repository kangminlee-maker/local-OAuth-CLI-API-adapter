#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

try {
  const packageRoot = dirname(fileURLToPath(import.meta.url));
  const guide = readFileSync(join(packageRoot, 'LLM_INSTALL.md'), 'utf8');
  process.stdout.write([
    '',
    '=== local-oauth-cli LLM INSTALL GUIDE START ===',
    guide.trimEnd(),
    '=== local-oauth-cli LLM INSTALL GUIDE END ===',
    '',
    'Re-read later with: local-oauth-cli --llm-guide',
    '',
  ].join('\n'));
} catch (err) {
  process.stderr.write(
    `local-oauth-cli postinstall failed to read LLM_INSTALL.md: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exitCode = 1;
}
