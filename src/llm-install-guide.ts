import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LLM_INSTALL_GUIDE_FILENAME = 'LLM_INSTALL.md';

export function readLlmInstallGuide(): string {
  return readFileSync(llmInstallGuidePath(), 'utf8');
}

export function llmInstallGuidePath(): string {
  const distDir = dirname(fileURLToPath(import.meta.url));
  return join(distDir, '..', LLM_INSTALL_GUIDE_FILENAME);
}

export function renderLlmInstallGuideNotice(guide = readLlmInstallGuide()): string {
  return [
    '',
    '=== local-oauth-cli LLM INSTALL GUIDE START ===',
    guide.trimEnd(),
    '=== local-oauth-cli LLM INSTALL GUIDE END ===',
    '',
    `Re-read later with: local-oauth-cli --llm-guide`,
    '',
  ].join('\n');
}
