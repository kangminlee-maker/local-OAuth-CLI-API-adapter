#!/usr/bin/env node
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { arch, platform, release } from 'node:os';
import { join } from 'node:path';
import { catalogPath, failOnStale, outDir, repoRoot } from './runtime-capability/options.mjs';
import { collectClaude, collectCodex } from './runtime-capability/collect.mjs';
import { cleanupProbeScratch, probeTelemetry } from './runtime-capability/exec.mjs';
import { renderMarkdown } from './runtime-capability/render.mjs';
import { validateCatalog } from './runtime-capability/validate.mjs';

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

const report = await collectReport();

await mkdir(outDir, { recursive: true });
const jsonPath = join(outDir, `runtime-capability-report.${timestamp}.json`);
const markdownPath = join(outDir, `runtime-capability-report.${timestamp}.md`);
await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
await writeFile(markdownPath, renderMarkdown(report));
await copyFile(jsonPath, join(outDir, 'latest.json'));
await copyFile(markdownPath, join(outDir, 'latest.md'));

process.stdout.write(`runtime capability report: ${jsonPath}\n`);
process.stdout.write(`runtime capability summary: ${markdownPath}\n`);
// An inconclusive run fails the gate too: "could not check" is not "passed".
if (failOnStale && (report.catalogValidity?.staleCount > 0 || report.catalogValidity?.inconclusive)) {
  process.exitCode = 1;
}

async function collectReport() {
  try {
    const codex = await collectCodex();
    const claude = await collectClaude();
    return {
      generatedAt: new Date().toISOString(),
      repoRoot,
      catalogPath,
      probes: probeTelemetry(),
      platform: {
        os: platform(),
        arch: arch(),
        release: release(),
        node: process.version,
      },
      trustLevels: {
        L0: 'Binary string scan candidate only',
        L1: 'Local --help or version output',
        L2: 'Generated protocol schema',
        L3: 'Official docs review required',
        L4: 'Runtime probe required',
      },
      codex,
      claude,
      catalogValidity: await validateCatalog({ codex, claude }),
      updateGuidance: {
        catalog: 'docs/runtime-capability-catalog.md',
        playbook: 'docs/runtime-capability-update-playbook.md',
        rule: 'Validate existing catalog entries first. Treat stale/changed entries as higher priority than additive candidates.',
      },
    };
  } finally {
    // Probed options can write into the scratch cwd, so it is removed on every
    // exit path rather than accumulating one directory per run under /tmp.
    await cleanupProbeScratch();
  }
}
