#!/usr/bin/env node
import { execFile } from 'node:child_process';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { arch, platform, release, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const args = process.argv.slice(2);
const outDir = resolve(repoRoot, readValueArg('--out') ?? 'artifacts/runtime-capability-catalog');
const catalogPath = resolve(repoRoot, readValueArg('--catalog') ?? 'docs/runtime-capability-catalog.md');
const skipBinaryScan = args.includes('--skip-binary-scan');
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

const codex = await collectCodex();
const claude = await collectClaude();
const report = {
  generatedAt: new Date().toISOString(),
  repoRoot,
  catalogPath,
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

await mkdir(outDir, { recursive: true });
const jsonPath = join(outDir, `runtime-capability-report.${timestamp}.json`);
const markdownPath = join(outDir, `runtime-capability-report.${timestamp}.md`);
await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
await writeFile(markdownPath, renderMarkdown(report));
await copyFile(jsonPath, join(outDir, 'latest.json'));
await copyFile(markdownPath, join(outDir, 'latest.md'));

process.stdout.write(`runtime capability report: ${jsonPath}\n`);
process.stdout.write(`runtime capability summary: ${markdownPath}\n`);
if (args.includes('--fail-on-stale') && report.catalogValidity?.staleCount > 0) {
  process.exitCode = 1;
}

function readValueArg(name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

async function collectCodex() {
  const binary = await commandPath('codex');
  const base = await collectRuntimeBase('codex', binary);
  if (!binary) return base;

  const helpCommands = [
    ['root', []],
    ['exec', ['exec', '--help']],
    ['exec-resume', ['exec', 'resume', '--help']],
    ['app-server', ['app-server', '--help']],
    ['app-server-generate-json-schema', ['app-server', 'generate-json-schema', '--help']],
    ['app-server-generate-ts', ['app-server', 'generate-ts', '--help']],
    ['debug', ['debug', '--help']],
    ['debug-app-server', ['debug', 'app-server', '--help']],
    ['debug-prompt-input', ['debug', 'prompt-input', '--help']],
    ['debug-models', ['debug', 'models', '--help']],
    ['features', ['features', '--help']],
    ['features-list', ['features', 'list']],
  ];

  const help = await collectHelp(binary, helpCommands);
  const schema = await collectCodexSchema(binary);
  return {
    ...base,
    help,
    helpFlags: extractHelpFlags(help),
    schema,
    binaryScan: skipBinaryScan ? { skipped: true } : await collectBinaryScan(binary),
  };
}

async function collectClaude() {
  const binary = await commandPath('claude');
  const base = await collectRuntimeBase('claude', binary);
  if (!binary) return base;

  const helpCommands = [
    ['root', ['--help']],
    ['mcp', ['mcp', '--help']],
    ['agents', ['agents', '--help']],
    ['project', ['project', '--help']],
    ['auth', ['auth', '--help']],
    ['doctor', ['doctor', '--help']],
  ];

  const help = await collectHelp(binary, helpCommands);
  // Flags registered with hideHelp() in the binary: absent from `--help` output but
  // functional and depended on by the proxy's Anthropic parity path. Tracked here so
  // the catalog can document them without the validity check treating them as stale.
  // Presence is confirmed against the binary scan (see hiddenFlagsPresent), which is
  // the deterministic authority for hideHelp() flags help scraping cannot reach.
  const hiddenProbedFlags = [
    {
      item: '--thinking',
      source: 'Binary scan + invalid-value parse probe',
      requiredProbe: 'Passing an invalid mode is rejected with choices enabled/adaptive/disabled.',
    },
    {
      item: '--thinking-display',
      source: 'Binary scan + invalid-value parse probe',
      requiredProbe: 'Passing an invalid display is rejected with choices summarized/omitted.',
    },
    {
      item: '--task-budget',
      source: 'Binary scan + invalid-value parse probe',
      requiredProbe: 'Passing a non-positive value is rejected with "must be a positive integer".',
    },
    {
      item: '--max-thinking-tokens',
      source: 'Binary scan (deprecated, superseded by --thinking)',
      requiredProbe: 'Present but deprecated; the adapter does not use it.',
    },
    {
      item: '--teammate-mode',
      source: 'Binary scan + invalid-value parse probe',
      requiredProbe: 'Passing an invalid mode is rejected with choices auto/tmux/iterm2/in-process. Not adapter-used; tracked for drift.',
    },
  ];
  // L0-only candidates named in the catalog's hidden-surface section: registered
  // option-spec strings found in the binary but absent from every collected help,
  // and not positively probeable because the CLI tolerates unknown options. Presence
  // is re-checked against the binary scan so a future version that drops one
  // surfaces as a stale catalog entry.
  const hiddenL0CandidateFlags = [
    '--append-system-prompt-file',
    '--judge-model',
    '--managed-settings',
    '--max-cost-usd',
    '--parent-session-id',
    '--plan-mode-instructions',
    '--prefill',
    '--prefill-b64',
    '--resume-session-at',
    '--runs',
    '--sdk-url',
    '--storybook-config',
    '--storybook-static',
    '--system-prompt-file',
  ];
  const binaryScan = skipBinaryScan
    ? { skipped: true }
    : await collectBinaryScan(binary, [
        ...hiddenProbedFlags.map((flag) => flag.item),
        ...hiddenL0CandidateFlags,
      ]);
  return {
    ...base,
    help,
    helpFlags: extractHelpFlags(help),
    docsOnlyCandidates: [
      {
        item: '--max-turns',
        source: 'https://code.claude.com/docs/en/cli-usage',
        requiredProbe: 'Verify accepted by the installed binary and behavior with non-interactive print mode.',
      },
      {
        item: '--permission-prompt-tool',
        source: 'https://code.claude.com/docs/en/cli-usage',
        requiredProbe: 'Verify MCP permission prompt event shape with stream-json.',
      },
      {
        item: '--maintenance',
        source: 'https://code.claude.com/docs/en/cli-usage',
        requiredProbe: 'Verify availability and startup latency impact.',
      },
      {
        item: '--prompt-suggestions',
        source: 'https://code.claude.com/docs/en/cli-usage',
        requiredProbe: 'Verify event shape and whether service chat UI should expose it.',
      },
    ],
    hiddenProbedFlags,
    hiddenL0CandidateFlags,
    binaryScan,
  };
}

async function validateCatalog(data) {
  if (!existsSync(catalogPath)) {
    return {
      exists: false,
      verdict: 'missing_catalog',
      staleCount: 0,
      updateCandidateCount: 0,
    };
  }

  const text = await readFile(catalogPath, 'utf8');
  const codexSection = sectionBetween(text, '## Codex capability list', '## Claude Code capability list');
  const claudeSection = sectionBetween(text, '## Claude Code capability list', '## Service chat runtime output list');
  const schemaMethods = uniqueSorted(Object.values(data.codex.schema?.methodEnums ?? {}).flat());
  const documentedCodexMethods = uniqueCapture(codexSection, /`([A-Za-z][A-Za-z0-9_]*(?:\/[A-Za-z][A-Za-z0-9_]*)+)`/g);
  const documentedClaudeFlags = uniqueMatches(claudeSection, /--[A-Za-z0-9][A-Za-z0-9_-]+/g);
  // hideHelp() flags are allowed only when the binary scan actually finds them, so a
  // future version that drops one still surfaces as stale. When the scan is skipped or
  // unavailable there is no binary authority, so fall back to the declared list to avoid
  // a false stale signal in reduced-authority mode.
  const scan = data.claude.binaryScan;
  const scanConfirmedHiddenFlags = scan && scan.ok && Array.isArray(scan.hiddenFlagsPresent)
    ? scan.hiddenFlagsPresent
    : [
        ...(data.claude.hiddenProbedFlags ?? []).map((item) => item.item),
        ...(data.claude.hiddenL0CandidateFlags ?? []),
      ];
  const claudeAllowedFlags = uniqueSorted([
    ...(data.claude.helpFlags ?? []),
    ...(data.claude.docsOnlyCandidates ?? []).map((item) => item.item),
    ...scanConfirmedHiddenFlags,
  ]);

  const documentedVersions = {
    codex: extractVersionCell(text, 'Codex CLI'),
    claude: extractVersionCell(text, 'Claude Code'),
  };
  const observedVersions = {
    codex: firstLine(data.codex.version?.stdout),
    claude: firstLine(data.claude.version?.stdout),
  };

  const versionDrift = [];
  for (const runtime of ['codex', 'claude']) {
    const documented = documentedVersions[runtime];
    const observed = observedVersions[runtime];
    if (documented && observed && normalizeVersion(documented) !== normalizeVersion(observed)) {
      versionDrift.push({ runtime, documented, observed });
    }
  }

  const documentedCodexMethodMissingFromSchema = difference(documentedCodexMethods, schemaMethods);
  const schemaCodexMethodUndocumented = difference(schemaMethods, documentedCodexMethods);
  const documentedClaudeFlagMissingFromHelpOrDocs = difference(documentedClaudeFlags, claudeAllowedFlags);
  const claudeHelpFlagUndocumented = difference(data.claude.helpFlags ?? [], documentedClaudeFlags);

  const staleCount = versionDrift.length
    + documentedCodexMethodMissingFromSchema.length
    + documentedClaudeFlagMissingFromHelpOrDocs.length;
  const updateCandidateCount = schemaCodexMethodUndocumented.length + claudeHelpFlagUndocumented.length;

  return {
    exists: true,
    verdict: staleCount > 0 ? 'needs_update' : 'valid_against_collected_authorities',
    staleCount,
    updateCandidateCount,
    versionDrift,
    codex: {
      documentedMethodCount: documentedCodexMethods.length,
      schemaMethodCount: schemaMethods.length,
      documentedMethodsStillInSchema: intersection(documentedCodexMethods, schemaMethods),
      documentedMethodsMissingFromSchema: documentedCodexMethodMissingFromSchema,
      schemaMethodsUndocumentedInCatalog: schemaCodexMethodUndocumented,
    },
    claude: {
      documentedFlagCount: documentedClaudeFlags.length,
      localHelpFlagCount: data.claude.helpFlags?.length ?? 0,
      documentedFlagsStillSupportedOrDocsOnly: intersection(documentedClaudeFlags, claudeAllowedFlags),
      documentedFlagsMissingFromHelpOrDocs: documentedClaudeFlagMissingFromHelpOrDocs,
      helpFlagsUndocumentedInCatalog: claudeHelpFlagUndocumented,
    },
  };
}

async function collectRuntimeBase(name, binary) {
  const version = binary ? await run(binary, ['--version'], { timeoutMs: 10_000 }) : null;
  const readlink = binary ? await run('readlink', [binary], { timeoutMs: 10_000 }) : null;
  const file = binary ? await run('file', [binary], { timeoutMs: 10_000 }) : null;
  return {
    name,
    binary,
    exists: Boolean(binary),
    version: summarizeCommand(version),
    symlinkTarget: summarizeCommand(readlink),
    file: summarizeCommand(file),
  };
}

async function collectHelp(binary, specs) {
  const result = {};
  for (const [id, commandArgs] of specs) {
    const actualArgs = commandArgs.length === 0 ? ['--help'] : commandArgs;
    result[id] = summarizeCommand(await run(binary, actualArgs, {
      timeoutMs: id === 'features-list' ? 20_000 : 12_000,
      maxBuffer: 8_000_000,
    }));
  }
  return result;
}

async function collectCodexSchema(binary) {
  const tmp = await mkdtemp(join(tmpdir(), 'codex-app-server-schema-'));
  try {
    const generated = await run(binary, [
      'app-server',
      'generate-json-schema',
      '--experimental',
      '--out',
      tmp,
    ], {
      timeoutMs: 30_000,
      maxBuffer: 20_000_000,
    });

    if (!generated.ok) {
      return { generated: summarizeCommand(generated), files: [], methodEnums: {} };
    }

    const files = await listFiles(tmp);
    const methodEnums = {};
    for (const name of [
      'ClientRequest.json',
      'ClientNotification.json',
      'ServerRequest.json',
      'ServerNotification.json',
    ]) {
      const filePath = join(tmp, name);
      if (!existsSync(filePath)) continue;
      const schema = JSON.parse(await readFile(filePath, 'utf8'));
      methodEnums[name.replace(/\.json$/, '')] = collectMethodEnums(schema);
    }

    return {
      generated: summarizeCommand(generated),
      files: files.map((filePath) => relative(tmp, filePath)).sort(),
      methodEnums,
    };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function collectBinaryScan(binary, knownHiddenFlags = []) {
  const stringsPath = await commandPath('strings');
  if (!stringsPath) return { available: false, reason: 'strings command not found' };
  const result = await run(stringsPath, [binary], {
    timeoutMs: 15_000,
    maxBuffer: 30_000_000,
  });
  if (!result.ok) return { available: true, ok: false, error: result.stderr || result.stdout };

  const flags = uniqueMatches(result.stdout, /--[A-Za-z0-9][A-Za-z0-9_-]+/g);
  const methodLike = uniqueMatches(result.stdout, /\b[A-Za-z][A-Za-z0-9]*(?:\/[A-Za-z][A-Za-z0-9]*)+\b/g);
  // Presence check for hideHelp() flags that `--help` scraping cannot see. The
  // membership test runs against the full flag set, not the truncated candidate
  // list, so it stays authoritative regardless of alphabetical position.
  const flagSet = new Set(flags);
  const hiddenFlagsPresent = knownHiddenFlags.filter((flag) => flagSet.has(flag));
  const hiddenFlagsMissing = knownHiddenFlags.filter((flag) => !flagSet.has(flag));
  return {
    available: true,
    ok: true,
    note: 'L0 candidates only. Treat as noisy evidence.',
    flagCandidateCount: flags.length,
    methodCandidateCount: methodLike.length,
    flagCandidates: flags.slice(0, 500),
    methodCandidates: methodLike.slice(0, 500),
    hiddenFlagsPresent,
    hiddenFlagsMissing,
  };
}

function collectMethodEnums(schema) {
  const values = new Set();
  walkJson(schema, (node) => {
    const methodEnum = node?.properties?.method?.enum;
    if (Array.isArray(methodEnum)) {
      for (const value of methodEnum) values.add(value);
    }
    if (Array.isArray(node?.enum) && node.enum.every((value) => typeof value === 'string' && value.includes('/'))) {
      for (const value of node.enum) values.add(value);
    }
  });
  return [...values].sort();
}

function sectionBetween(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  if (start === -1) return '';
  const end = text.indexOf(endMarker, start + startMarker.length);
  return end === -1 ? text.slice(start) : text.slice(start, end);
}

function extractVersionCell(text, runtimeLabel) {
  const line = text.split(/\r?\n/).find((item) => item.includes(`| ${runtimeLabel} |`));
  if (!line) return null;
  const match = line.match(/\|\s*[^|]+\|\s*`([^`]+)`\s*\|/);
  return match?.[1] ?? null;
}

function uniqueCapture(text, pattern) {
  const values = [];
  for (const match of String(text).matchAll(pattern)) {
    if (match[1]) values.push(match[1]);
  }
  return uniqueSorted(values);
}

function walkJson(value, visit) {
  if (!value || typeof value !== 'object') return;
  visit(value);
  if (Array.isArray(value)) {
    for (const item of value) walkJson(item, visit);
    return;
  }
  for (const item of Object.values(value)) walkJson(item, visit);
}

async function listFiles(dir) {
  const entries = [];
  for (const name of await readdir(dir)) {
    const filePath = join(dir, name);
    const fileStat = await stat(filePath);
    if (fileStat.isDirectory()) {
      entries.push(...await listFiles(filePath));
    } else if (fileStat.isFile()) {
      entries.push(filePath);
    }
  }
  return entries;
}

function extractHelpFlags(helpByCommand) {
  const flags = new Set();
  for (const command of Object.values(helpByCommand)) {
    if (!command?.stdout) continue;
    for (const flag of extractOptionDefinitionFlags(command.stdout)) {
      flags.add(flag);
    }
  }
  return [...flags].sort();
}

function extractOptionDefinitionFlags(text) {
  const flags = new Set();
  for (const line of String(text).split(/\r?\n/)) {
    if (!/^\s*(?:-[A-Za-z0-9],\s*)?--[A-Za-z0-9]/.test(line)) continue;
    for (const flag of uniqueMatches(line, /--[A-Za-z0-9][A-Za-z0-9_-]+/g)) {
      flags.add(flag);
    }
  }
  return [...flags].sort();
}

function uniqueMatches(text, pattern) {
  return uniqueSorted(String(text).match(pattern) ?? []);
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

function difference(left, right) {
  const rightSet = new Set(right);
  return left.filter((value) => !rightSet.has(value));
}

function intersection(left, right) {
  const rightSet = new Set(right);
  return left.filter((value) => rightSet.has(value));
}

async function commandPath(name) {
  const result = await run('/bin/sh', ['-lc', `command -v ${shellQuote(name)}`], {
    timeoutMs: 10_000,
  });
  if (!result.ok) return null;
  return result.stdout.trim().split(/\r?\n/).filter(Boolean)[0] ?? null;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

async function run(command, commandArgs, options = {}) {
  try {
    const result = await execFileAsync(command, commandArgs, {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: options.timeoutMs ?? 15_000,
      maxBuffer: options.maxBuffer ?? 4_000_000,
      env: process.env,
    });
    return {
      ok: true,
      code: 0,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  } catch (error) {
    return {
      ok: false,
      code: typeof error.code === 'number' ? error.code : null,
      signal: error.signal ?? null,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? error.message ?? '',
    };
  }
}

function summarizeCommand(result) {
  if (!result) return null;
  return {
    ok: result.ok,
    code: result.code,
    signal: result.signal ?? null,
    stdout: trimEnd(result.stdout),
    stderr: trimEnd(result.stderr),
  };
}

function trimEnd(value) {
  return String(value ?? '').replace(/\s+$/u, '');
}

function renderMarkdown(data) {
  return `# Runtime Capability Report

Generated at: ${data.generatedAt}

Repository: \`${data.repoRoot}\`

Catalog: \`${data.catalogPath}\`

Platform: \`${data.platform.os}/${data.platform.arch} ${data.platform.release}\`, Node \`${data.platform.node}\`

## Local Runtime Summary

| Runtime | Exists | Version | Binary |
| --- | --- | --- | --- |
| Codex CLI | ${yesNo(data.codex.exists)} | ${inline(firstLine(data.codex.version?.stdout))} | ${inline(data.codex.binary)} |
| Claude Code | ${yesNo(data.claude.exists)} | ${inline(firstLine(data.claude.version?.stdout))} | ${inline(data.claude.binary)} |

## Catalog Validity

Verdict: \`${data.catalogValidity?.verdict ?? 'not_checked'}\`

| Check | Count |
| --- | ---: |
| Stale or changed entries | ${data.catalogValidity?.staleCount ?? 0} |
| Additive update candidates | ${data.catalogValidity?.updateCandidateCount ?? 0} |
| Codex documented methods missing from schema | ${data.catalogValidity?.codex?.documentedMethodsMissingFromSchema?.length ?? 0} |
| Codex schema methods undocumented in catalog | ${data.catalogValidity?.codex?.schemaMethodsUndocumentedInCatalog?.length ?? 0} |
| Claude documented flags missing from help/docs-only list | ${data.catalogValidity?.claude?.documentedFlagsMissingFromHelpOrDocs?.length ?? 0} |
| Claude help flags undocumented in catalog | ${data.catalogValidity?.claude?.helpFlagsUndocumentedInCatalog?.length ?? 0} |

### Version Drift

${renderVersionDrift(data.catalogValidity?.versionDrift)}

### Stale Or Changed Entries

Codex documented methods missing from generated schema:

${renderInlineList(data.catalogValidity?.codex?.documentedMethodsMissingFromSchema)}

Claude documented flags missing from local help and docs-only candidates:

${renderInlineList(data.catalogValidity?.claude?.documentedFlagsMissingFromHelpOrDocs)}

### Additive Update Candidates

Codex generated schema methods not yet documented:

${renderInlineList(data.catalogValidity?.codex?.schemaMethodsUndocumentedInCatalog)}

Claude local help flags not yet documented:

${renderInlineList(data.catalogValidity?.claude?.helpFlagsUndocumentedInCatalog)}

## Codex Schema Methods

${renderMethodSection(data.codex.schema?.methodEnums)}

## Codex Help Flags

${renderInlineList(data.codex.helpFlags)}

## Claude Help Flags

${renderInlineList(data.claude.helpFlags)}

## Claude Docs-Only Candidates

| Item | Source | Required probe |
| --- | --- | --- |
${(data.claude.docsOnlyCandidates ?? []).map((item) => `| ${inline(item.item)} | ${item.source} | ${escapeMarkdown(item.requiredProbe)} |`).join('\n')}

## Claude Hidden Probe-Confirmed Flags

Registered with \`hideHelp()\`, so absent from \`--help\`. The \`Binary\` column marks whether the current binary scan found the flag; a \`no\` here means the flag was dropped and the catalog entry is stale.

| Item | Binary | Source | Required probe |
| --- | --- | --- | --- |
${(data.claude.hiddenProbedFlags ?? []).map((item) => `| ${inline(item.item)} | ${yesNo((data.claude.binaryScan?.hiddenFlagsPresent ?? []).includes(item.item))} | ${escapeMarkdown(item.source)} | ${escapeMarkdown(item.requiredProbe)} |`).join('\n')}

## Binary Scan Summary

| Runtime | Available | Flags | Method-like strings | Note |
| --- | --- | ---: | ---: | --- |
| Codex CLI | ${yesNo(data.codex.binaryScan?.available)} | ${data.codex.binaryScan?.flagCandidateCount ?? 0} | ${data.codex.binaryScan?.methodCandidateCount ?? 0} | L0 candidates only |
| Claude Code | ${yesNo(data.claude.binaryScan?.available)} | ${data.claude.binaryScan?.flagCandidateCount ?? 0} | ${data.claude.binaryScan?.methodCandidateCount ?? 0} | L0 candidates only |

## Update Guidance

1. Validate existing entries in \`${data.updateGuidance.catalog}\` before adding new entries.
2. Remove, rename, or downgrade stale entries when collected authorities no longer support them.
3. Keep source levels separate. Do not promote L0/L1/L2/L3 items into production defaults without L4 runtime probes.
4. Follow \`${data.updateGuidance.playbook}\` for LLM-assisted document updates.
`;
}

function renderMethodSection(methodEnums) {
  if (!methodEnums || Object.keys(methodEnums).length === 0) return 'No Codex schema methods collected.';
  return Object.entries(methodEnums)
    .map(([name, methods]) => `### ${name}\n\n${renderInlineList(methods)}`)
    .join('\n\n');
}

function renderInlineList(values) {
  if (!values || values.length === 0) return 'None collected.';
  return values.map((value) => `- ${inline(value)}`).join('\n');
}

function renderVersionDrift(items) {
  if (!items || items.length === 0) return 'None detected.';
  return ['| Runtime | Documented | Observed |', '| --- | --- | --- |']
    .concat(items.map((item) => `| ${item.runtime} | ${inline(item.documented)} | ${inline(item.observed)} |`))
    .join('\n');
}

function inline(value) {
  if (!value) return '';
  return `\`${String(value).replace(/`/g, '\\`')}\``;
}

function firstLine(value) {
  return String(value ?? '').split(/\r?\n/)[0] ?? '';
}

function normalizeVersion(value) {
  const text = String(value ?? '').trim();
  const codex = text.match(/codex-cli\s+\d+(?:\.\d+){1,3}/);
  if (codex) return codex[0];
  const semver = text.match(/\d+(?:\.\d+){1,3}/);
  if (semver) return semver[0];
  return text;
}

function yesNo(value) {
  return value ? 'yes' : 'no';
}

function escapeMarkdown(value) {
  return String(value ?? '').replace(/\|/g, '\\|');
}
