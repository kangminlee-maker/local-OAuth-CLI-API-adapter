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
const skipFlagProbe = args.includes('--skip-flag-probe');
const skipCommandTree = args.includes('--skip-command-tree');
// Collection runs from a top-level await below, so anything the collectors read
// has to be initialized before it, not merely declared somewhere in the file.
const COMMAND_TREE_MAX_DEPTH = 4;
const COMMAND_TREE_MAX_COMMANDS = 300;
const OPTION_ENTRY_MAX_INDENT = 6;
const VALUE_DOMAIN_PROBE_MAX = 40;
// Options whose argument the CLI is known to validate, so the probe ends at the
// parser. Anything absent from the installed surface is simply skipped.
const VALUE_DOMAIN_PROBE_CANDIDATES = {
  codex: ['--ask-for-approval', '--sandbox'],
  claude: [
    '--effort',
    '--setting-sources',
    '--max-budget-usd',
    '--session-id',
    '--permission-mode',
    // Hidden but validated, and the adapter's Anthropic parity path depends on
    // their domains, so they are probed even though help never lists them.
    '--thinking',
    '--thinking-display',
    '--task-budget',
    '--teammate-mode',
  ],
};
const FLAG_PROBE_CONTROL = '--zzz-catalog-probe-control';
const FLAG_PROBE_CONTROLS = ['--zzz-not-a-real-flag', '--zzz-catalog-probe-absent'];
// Probes run outside the repository. Some options treat their argument as an
// output path (`--debug-file` writes a log plus a `latest` symlink beside it),
// so probing from the repo root would litter the working tree.
let probeScratchPromise = null;
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
if (args.includes('--fail-on-stale')
  && (report.catalogValidity?.staleCount > 0 || report.catalogValidity?.inconclusive)) {
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

async function cleanupProbeScratch() {
  const pending = probeScratchPromise;
  probeScratchPromise = null;
  if (!pending) return;
  const dir = await pending.catch(() => null);
  if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 3 });
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
  const { path: binary, scanPath, wrapper } = await runtimeBinaryPath('codex');
  const base = await collectRuntimeBase('codex', binary, { scanPath, wrapper });
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
  const commandTree = await collectCommandTree(binary);
  return {
    ...base,
    help,
    helpFlags: extractHelpFlags(help),
    commandTree,
    optionValueDomains: await probeOptionValueDomains(binary, rootOptionsOf(commandTree), VALUE_DOMAIN_PROBE_CANDIDATES.codex),
    schema,
    binaryScan: skipBinaryScan ? { skipped: true } : await collectBinaryScan(scanPath),
  };
}

async function collectClaude() {
  const { path: binary, scanPath, wrapper } = await runtimeBinaryPath('claude');
  const base = await collectRuntimeBase('claude', binary, { scanPath, wrapper });
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
  const docsOnlyCandidates = [
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
  ];
  const hiddenFlags = [
    ...hiddenProbedFlags.map((flag) => flag.item),
    ...hiddenL0CandidateFlags,
  ];
  // Docs-only items are probed alongside the hidden set: a flag the official
  // docs list still has to be accepted by this binary to belong in the catalog.
  // The scan receives the same set, so the report's "strings in binary" column
  // is answered for every probed flag instead of only the hidden ones.
  const probedFlags = [...hiddenFlags, ...docsOnlyCandidates.map((item) => item.item)];
  const binaryScan = skipBinaryScan
    ? { skipped: true }
    : await collectBinaryScan(scanPath, probedFlags);
  const flagProbe = skipFlagProbe
    ? { skipped: true }
    : await probeFlagRegistration(binary, probedFlags);
  const commandTree = await collectCommandTree(binary);
  return {
    ...base,
    help,
    helpFlags: extractHelpFlags(help),
    commandTree,
    optionValueDomains: await probeOptionValueDomains(binary, rootOptionsOf(commandTree), VALUE_DOMAIN_PROBE_CANDIDATES.claude),
    flagProbe,
    docsOnlyCandidates,
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
  // hideHelp() flags are allowed only when the parse probe shows the installed CLI
  // still accepts them. The binary scan is not sufficient authority here: a release
  // can keep a flag's strings while removing it from the parser, which reads as
  // "present" to a string scan and "unknown option" to the user. The probe is only
  // trusted when its negative controls came back unregistered; otherwise there is no
  // authority and the declared list is used, so a reduced-authority run does not
  // manufacture a stale signal. Whichever path is taken is reported as
  // `hiddenFlagAuthority` so a degraded run cannot read as a verified one.
  const probe = data.claude.flagProbe;
  const probeIsAuthoritative = Boolean(probe && !probe.skipped && probe.controlsOk);
  const declaredHiddenFlags = [
    ...(data.claude.hiddenProbedFlags ?? []).map((item) => item.item),
    ...(data.claude.hiddenL0CandidateFlags ?? []),
  ];
  const declaredDocsOnlyFlags = (data.claude.docsOnlyCandidates ?? []).map((item) => item.item);
  const acceptedHiddenFlags = probeIsAuthoritative
    ? probe.registered
    : [...declaredHiddenFlags, ...declaredDocsOnlyFlags];
  const claudeAllowedFlags = uniqueSorted([
    ...(data.claude.helpFlags ?? []),
    ...acceptedHiddenFlags,
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

  const codexCommands = await validateDocumentedCommands(data.codex, codexSection, 'codex');
  const claudeCommands = await validateDocumentedCommands(data.claude, claudeSection, 'claude');

  const codexDomains = validateDocumentedOptionDomains(data.codex, codexSection);
  const claudeDomains = validateDocumentedOptionDomains(data.claude, claudeSection);
  const optionDomains = [...codexDomains.mismatches, ...claudeDomains.mismatches];
  const unverifiedDomains = [...codexDomains.unverified, ...claudeDomains.unverified];

  const staleCount = codexCommands.absent.length
    + claudeCommands.absent.length
    + optionDomains.length
    + versionDrift.length
    + documentedCodexMethodMissingFromSchema.length
    + documentedClaudeFlagMissingFromHelpOrDocs.length;
  const updateCandidateCount = schemaCodexMethodUndocumented.length
    + claudeHelpFlagUndocumented.length
    + codexCommands.undocumented.length
    + claudeCommands.undocumented.length;

  // A run that could not check something must not read as a run that checked it
  // and found nothing. Without this, skipping the probe or losing its controls
  // makes every declared hidden flag "supported", drives stale to zero, and lets
  // the verdict claim validity the run never established.
  const inconclusiveReasons = [];
  if (!probeIsAuthoritative) {
    inconclusiveReasons.push(probe?.skipped
      ? 'hidden flag parse probe skipped'
      : 'hidden flag parse probe controls did not come back unregistered');
  }
  if ((probe?.indeterminate?.length ?? 0) > 0) {
    inconclusiveReasons.push(`indeterminate flag probes: ${probe.indeterminate.join(', ')}`);
  }
  if (unverifiedDomains.length > 0) {
    inconclusiveReasons.push(`documented value domains not verified: ${unverifiedDomains.map((entry) => `${entry.runtime} ${entry.flag} (${entry.reason})`).join(', ')}`);
  }
  for (const [runtime, check] of [['codex', codexCommands], ['claude', claudeCommands]]) {
    if (check.authority === 'not_collected' && check.documentedCount > 0) {
      inconclusiveReasons.push(`${runtime} command surface not collected`);
    }
    // A walk that stopped at a cap inspected only part of the surface, so it
    // cannot support a "nothing changed" verdict for the part it never saw.
    if (data[runtime]?.commandTree?.truncated) {
      inconclusiveReasons.push(`${runtime} command walk truncated at the collection cap`);
    }
  }
  const inconclusive = inconclusiveReasons.length > 0;

  return {
    exists: true,
    verdict: staleCount > 0
      ? 'needs_update'
      : (inconclusive ? 'inconclusive_reduced_authority' : 'valid_against_collected_authorities'),
    inconclusive,
    inconclusiveReasons,
    staleCount,
    updateCandidateCount,
    versionDrift,
    commands: {
      codex: codexCommands,
      claude: claudeCommands,
    },
    optionDomainMismatches: optionDomains,
    optionDomainsUnverified: unverifiedDomains,
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
      hiddenFlagAuthority: probeIsAuthoritative ? 'parse_probe' : 'declared_fallback',
      hiddenFlagsRejectedByParser: probeIsAuthoritative ? probe.unregistered : [],
      documentedFlagsStillSupportedOrDocsOnly: intersection(documentedClaudeFlags, claudeAllowedFlags),
      documentedFlagsMissingFromHelpOrDocs: documentedClaudeFlagMissingFromHelpOrDocs,
      helpFlagsUndocumentedInCatalog: claudeHelpFlagUndocumented,
    },
  };
}

// The command tree is only an authority if the validity check consumes it.
// Every command the catalog names is required to be either in the walked tree
// or, for the documented hidden ones, to answer `--help` for itself; anything
// else is a catalog entry the installed CLI no longer has.
async function validateDocumentedCommands(runtime, section, binaryName) {
  const documented = documentedCommandPaths(section, binaryName);
  const tree = runtime.commandTree;
  if (!runtime.binary || !tree || tree.skipped) {
    return {
      authority: 'not_collected',
      documentedCount: documented.length,
      visible: [],
      hiddenConfirmed: [],
      absent: [],
      undocumented: [],
    };
  }
  const known = new Set((tree.commands ?? []).map((entry) => entry.command));
  const usageOf = new Map((tree.commands ?? []).map((entry) => [entry.command, entry.usage]));
  const visible = documented.filter((command) => known.has(command));
  const hiddenConfirmed = [];
  const absent = [];
  for (const command of documented.filter((entry) => !known.has(entry))) {
    const parent = command.split(' ').slice(0, -1).join(' ');
    // The parent of a hidden command is often hidden too, so it is absent from
    // the tree. Falling back to the root usage there would accept a removed
    // child whose invocation lands on its still-present parent's help, since
    // that help differs from the root's. Probe the real parent instead.
    let parentUsage = usageOf.get(parent || '(root)');
    if (parentUsage === undefined) {
      parentUsage = await commandUsage(runtime.binary, parent);
      usageOf.set(parent || '(root)', parentUsage);
    }
    if (await commandAnswersForItself(runtime.binary, binaryName, command, parentUsage)) {
      hiddenConfirmed.push(command);
    } else {
      absent.push(command);
    }
  }
  // Commands the installed CLI has but the catalog never mentions are additive
  // candidates: not stale, but the only signal that the surface grew.
  const documentedSet = new Set(documented);
  const undocumented = (tree.commands ?? [])
    .map((entry) => entry.command)
    .filter((command) => command !== '(root)' && !documentedSet.has(command));
  return {
    authority: 'command_tree_plus_probe',
    documentedCount: documented.length,
    visible,
    hiddenConfirmed,
    absent,
    undocumented,
  };
}

// Commands appear two ways in the catalog: fully qualified in prose and
// examples (`codex app-server --listen stdio://`), and bare in the command
// inventory tables (`exec`). Both are claims about the installed CLI, so both
// are checked; keeping only the qualified form would let a renamed command sit
// in the inventory table without ever failing the gate.
function documentedCommandPaths(section, binaryName) {
  const paths = new Set();
  const add = (raw) => {
    const words = [];
    for (const token of String(raw).trim().split(/\s+/)) {
      if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(token)) break;
      words.push(token);
    }
    if (words[0] === binaryName) words.shift();
    if (words.length > 0) paths.add(words.join(' '));
  };
  for (const raw of uniqueCapture(section, new RegExp(`\`${binaryName} ([^\`]+)\``, 'g'))) add(raw);
  for (const cell of commandInventoryCells(section)) {
    for (const token of uniqueCapture(cell, /`([^`]+)`/g)) add(token);
  }
  return [...paths].sort();
}

// The catalog states value domains for options. Collected evidence — help
// choice lists and probe replies — is compared against them, so a CLI that
// changes an accepted value set makes the catalog stale instead of quietly
// disagreeing with it. Only enumerable domains are compared; prose like
// "a positive number greater than 0" describes no value set.
function validateDocumentedOptionDomains(runtime, section) {
  const observed = collectedOptionDomains(runtime);
  const probe = runtime.optionValueDomains ?? {};
  const unresolved = new Set(probe.unresolved ?? []);
  const mismatches = [];
  const unverified = [];
  for (const [flag, documented] of documentedOptionDomains(section)) {
    const collected = observed.get(flag);
    if (!collected || collected.size === 0) {
      // A documented domain with no evidence is only acceptable when nothing
      // tried to read it. If the probe ran and came back empty, or was skipped
      // entirely, the catalog's claim went unchecked and the run must say so.
      if (probe.skipped || unresolved.has(flag)) {
        unverified.push({ runtime: runtime.name, flag, reason: probe.skipped ? 'probe skipped' : 'probe returned no domain' });
      }
      continue;
    }
    const missing = [...documented].filter((value) => !collected.has(value));
    const unexpected = [...collected].filter((value) => !documented.has(value));
    if (missing.length > 0 || unexpected.length > 0) {
      mismatches.push({
        runtime: runtime.name,
        flag,
        documented: [...documented],
        observed: [...collected],
        documentedButNotAccepted: missing,
        acceptedButNotDocumented: unexpected,
      });
    }
  }
  return { mismatches, unverified };
}

function collectedOptionDomains(runtime) {
  const domains = new Map();
  for (const option of rootOptionsOf(runtime.commandTree)) {
    if (!option.choices?.length) continue;
    const values = new Set(option.choices.map(normalizeDomainValue).filter(Boolean));
    for (const flag of option.flags) domains.set(flag, values);
  }
  for (const [flag, domain] of Object.entries(runtime.optionValueDomains?.domains ?? {})) {
    const values = String(domain).split(',').map(normalizeDomainValue).filter(Boolean);
    if (values.length > 1) domains.set(flag, new Set(values));
  }
  return domains;
}

function documentedOptionDomains(section) {
  const rows = new Map();
  let inFlagTable = false;
  for (const line of String(section).split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) {
      inFlagTable = false;
      continue;
    }
    const columns = line.split('|').slice(1, -1).map((value) => value.trim());
    const first = columns[0] ?? '';
    if (/^flag$/i.test(first)) {
      inFlagTable = true;
      continue;
    }
    if (/^:?-{2,}:?$/.test(first)) continue;
    if (!inFlagTable) continue;
    const flag = uniqueCapture(first, /`(--[A-Za-z0-9][A-Za-z0-9-]*)`/g)[0];
    const domain = uniqueCapture(columns[1] ?? '', /`([^`]+)`/g)
      .map(normalizeDomainValue)
      .filter(Boolean);
    if (flag && domain.length > 1) rows.set(flag, new Set(domain));
  }
  return rows;
}

function normalizeDomainValue(value) {
  return String(value).trim().replace(/^["'`]+|["'`.]+$/g, '').toLowerCase();
}

// First-column cells of tables that inventory commands. Scoped by header so
// value tables (`| Field | Domain |`) and flag tables cannot contribute names.
function commandInventoryCells(section) {
  const cells = [];
  let inInventory = false;
  for (const line of String(section).split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) {
      inInventory = false;
      continue;
    }
    const first = (line.split('|')[1] ?? '').trim();
    if (/^(root subcommand|command)$/i.test(first)) {
      inInventory = true;
      continue;
    }
    if (/^:?-{2,}:?$/.test(first)) continue;
    if (inInventory && first) cells.push(first);
  }
  return cells;
}

async function commandUsage(binary, commandPath) {
  const argv = commandPath ? [...commandPath.split(' '), '--help'] : ['--help'];
  const result = await run(binary, argv, {
    timeoutMs: 20_000,
    maxBuffer: 8_000_000,
    cwd: await probeScratchDir(),
  });
  return parseHelpText(`${result.stdout ?? ''}\n${result.stderr ?? ''}`).usage;
}

// A hidden command prints usage for itself; an unknown name falls back to the
// parent's help. An alias prints the canonical command's usage instead of its
// own name, so a usage line that differs from the parent's also counts.
async function commandAnswersForItself(binary, binaryName, commandPath, parentUsage) {
  const result = await run(binary, [...commandPath.split(' '), '--help'], {
    timeoutMs: 20_000,
    maxBuffer: 8_000_000,
    cwd: await probeScratchDir(),
  });
  const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (new RegExp(`(^|\\s)${escapeRegExp(binaryName)}\\s+${escapeRegExp(commandPath)}(\\s|$)`, 'im').test(text)) {
    return true;
  }
  const usage = parseHelpText(text).usage;
  return Boolean(usage) && Boolean(parentUsage) && usage !== parentUsage;
}

async function collectRuntimeBase(name, binary, { scanPath = binary, wrapper = null } = {}) {
  const version = binary ? await run(binary, ['--version'], { timeoutMs: 10_000 }) : null;
  const readlink = binary ? await run('readlink', [binary], { timeoutMs: 10_000 }) : null;
  const file = binary ? await run('file', [binary], { timeoutMs: 10_000 }) : null;
  return {
    name,
    binary,
    wrapper,
    scanBinary: scanPath,
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

// Empirical command surface: walk `<binary> <path...> --help` breadth-first and
// record every subcommand, option, value placeholder, choice list, and default
// the installed binary advertises. The catalog's command spec is derived from
// this walk instead of a hand-listed subset, so a renamed or dropped command
// shows up as a diff in the report rather than going unnoticed. `--help`
// short-circuits before any command action runs, so the walk performs no work
// beyond printing help.
async function collectCommandTree(binary) {
  if (skipCommandTree) return { skipped: true };
  const queue = [[]];
  const seen = new Set();
  const commands = [];
  let truncated = false;
  while (queue.length > 0) {
    if (commands.length >= COMMAND_TREE_MAX_COMMANDS) {
      truncated = true;
      break;
    }
    const path = queue.shift();
    const key = path.join(' ');
    if (seen.has(key)) continue;
    seen.add(key);
    const result = await run(binary, [...path, '--help'], {
      timeoutMs: 20_000,
      maxBuffer: 8_000_000,
    });
    const parsed = parseHelpText(`${result.stdout ?? ''}\n${result.stderr ?? ''}`);
    // Commander answers an unknown subcommand by printing its parent's help, so
    // a misparsed name would otherwise be recorded as real and re-enqueue the
    // parent's whole command list under it. Require the help we got back to be
    // about the command we asked for.
    // The usage line spells aliases as `plugin|plugins`, so `|` bounds a token
    // just like whitespace does.
    const leaf = path[path.length - 1];
    if (leaf && parsed.usage && !new RegExp(`(^|[\\s|])${escapeRegExp(leaf)}([\\s|]|$)`).test(parsed.usage)) {
      continue;
    }
    commands.push({
      command: key || '(root)',
      path,
      ok: result.ok,
      usage: parsed.usage,
      description: parsed.description,
      arguments: parsed.arguments,
      options: parsed.options,
      subcommands: parsed.subcommands.map((entry) => entry.name),
    });
    const children = parsed.subcommands.filter((entry) => entry.name !== 'help');
    if (path.length >= COMMAND_TREE_MAX_DEPTH) {
      // Stopping at the cap while still reporting a complete surface would hide
      // every command below it.
      if (children.length > 0) truncated = true;
      continue;
    }
    for (const entry of children) queue.push([...path, entry.name]);
  }
  return {
    maxDepth: COMMAND_TREE_MAX_DEPTH,
    truncated,
    commandCount: commands.length,
    optionCount: commands.reduce((total, entry) => total + entry.options.length, 0),
    commands,
  };
}

// Both runtimes print clap/commander-shaped help: `Usage:` line, a description
// block, then `Commands:` / `Options:` / `Arguments:` sections whose entries all
// sit at one indent with the description separated by two or more spaces.
// Anything deeper is continuation text — wrapped descriptions, clap's
// `[possible values: ...]`, and the multi-line usage examples Claude Code embeds
// inside `claude mcp add`'s description. Pinning each section's entry indent to
// its first entry is what keeps those example lines from parsing as commands.
function parseHelpText(text) {
  const out = { usage: '', description: '', options: [], arguments: [], subcommands: [] };
  const preamble = [];
  const rawEntries = { subcommands: [], options: [], arguments: [] };
  const entryIndent = {};
  let section = 'preamble';
  let current = null;
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/u, '');
    const body = line.trim();
    // A blank line does not end an entry: clap separates an option's description
    // from its `[possible values: ...]` line with one, and dropping the entry
    // there would lose every choice list in the long help form.
    if (!body) continue;
    const header = /^([A-Za-z][A-Za-z /]*):$/.exec(body);
    if (header && !/^\s/.test(line)) {
      const name = header[1].toLowerCase();
      if (name.includes('command')) section = 'subcommands';
      else if (name.includes('option') || name.includes('flag')) section = 'options';
      else if (name.includes('argument')) section = 'arguments';
      else section = 'other';
      current = null;
      continue;
    }
    if (/^usage:/i.test(body)) {
      out.usage = body.replace(/^usage:\s*/i, '');
      section = 'preamble';
      current = null;
      continue;
    }
    if (section === 'preamble') {
      preamble.push(body);
      continue;
    }
    if (section === 'other') continue;
    const indent = line.length - line.trimStart().length;
    if (entryIndent[section] === undefined) entryIndent[section] = indent;
    // clap's long help aligns on the `--`, so a long-only option sits at indent 6
    // while an option carrying a short form sits at 2. Options are therefore
    // recognised by shape within a small indent window; every other section
    // keeps the strict "same indent as the first entry" rule.
    const isEntry = section === 'options'
      ? /^-{1,2}[A-Za-z0-9]/.test(body) && indent <= OPTION_ENTRY_MAX_INDENT
      : indent <= entryIndent[section];
    if (!isEntry) {
      if (current) current.description = `${current.description} ${body}`.trim();
      continue;
    }
    const [signature, ...rest] = body.split(/\s{2,}/);
    current = { signature: signature.trim(), description: rest.join(' ').trim() };
    rawEntries[section].push(current);
  }
  out.description = preamble.join(' ').trim();
  out.options = rawEntries.options.filter((entry) => entry.signature.startsWith('-')).map(structureOption);
  out.subcommands = rawEntries.subcommands
    .map(structureSubcommand)
    .filter((entry) => /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(entry.name));
  out.arguments = rawEntries.arguments.map((entry) => ({
    name: entry.signature,
    description: entry.description,
  }));
  return out;
}

function rootOptionsOf(commandTree) {
  return commandTree?.commands?.find((entry) => entry.command === '(root)')?.options ?? [];
}

function structureOption(entry) {
  const text = `${entry.signature} ${entry.description}`;
  const value = /[<[][^>\]]+[>\]]/.exec(entry.signature);
  const defaultMatch = /\(default:\s*([^)]+)\)|\[default:\s*([^\]]+)\]/i.exec(text);
  return {
    flags: uniqueCapture(entry.signature, /(--[A-Za-z0-9][A-Za-z0-9-]*)/g),
    shortFlags: uniqueCapture(entry.signature, /(?:^|[\s,])(-[A-Za-z0-9])(?![A-Za-z0-9-])/g),
    takesValue: Boolean(value),
    valuePlaceholder: value ? value[0] : null,
    choices: extractChoices(text),
    default: defaultMatch ? (defaultMatch[1] ?? defaultMatch[2]).trim() : null,
    description: entry.description,
  };
}

function structureSubcommand(entry) {
  const [head = '', ...aliases] = entry.signature.split(/\s+/)[0].split('|');
  return { name: head, aliases, description: entry.description };
}

function probeScratchDir() {
  probeScratchPromise ??= mkdtemp(join(tmpdir(), 'runtime-capability-probe-'));
  return probeScratchPromise;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractChoices(text) {
  const raw = /\(choices:\s*([^)]+)\)/i.exec(text)?.[1]
    ?? /\[possible values:\s*([^\]]+)\]/i.exec(text)?.[1];
  if (!raw) return [];
  // commander can append annotations inside the same parentheses, e.g.
  // `(choices: "true", "false", preset: "true")`. Those carry a colon and are
  // not accepted values.
  return raw
    .split(',')
    .map((value) => value.trim().replace(/^["']|["']$/g, ''))
    .filter((value) => value && !value.includes(':'));
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

// Parse probe: the only authority that answers "does the installed CLI accept
// this flag today". A string in the binary proves the token is compiled in, not
// that the parser is wired to it — Claude Code 2.1.220 still ships strings for
// flags it now rejects.
//
// The probe pairs the flag with a bogus control flag rather than a plain value.
// A value would be consumed as the prompt when the probed flag turns out to be
// boolean, which runs a real model turn; a flag-shaped argument never can be.
// The parser then names whichever option it could not resolve, which separates
// all three cases: it names the probed flag when unregistered, names the control
// when the probed flag is a registered boolean that consumed nothing, and
// reports a value-validation failure when the probed flag takes a value.
async function probeFlagRegistration(binary, flags) {
  const results = {};
  const cwd = await probeScratchDir();
  for (const flag of [...FLAG_PROBE_CONTROLS, ...flags]) {
    if (results[flag]) continue;
    const result = await run(binary, [flag, FLAG_PROBE_CONTROL], {
      timeoutMs: 12_000,
      maxBuffer: 4_000_000,
      cwd,
    });
    results[flag] = classifyFlagProbe(`${result.stdout ?? ''}\n${result.stderr ?? ''}`, flag, result);
  }
  const controlsOk = FLAG_PROBE_CONTROLS.every((flag) => results[flag] === 'unregistered');
  const probed = flags.filter((flag) => results[flag]);
  const indeterminate = probed.filter((flag) => results[flag] === 'indeterminate');
  return {
    controls: Object.fromEntries(FLAG_PROBE_CONTROLS.map((flag) => [flag, results[flag]])),
    controlsOk,
    results: Object.fromEntries(probed.map((flag) => [flag, results[flag]])),
    registered: controlsOk
      ? probed.filter((flag) => results[flag] !== 'unregistered' && results[flag] !== 'indeterminate')
      : [],
    unregistered: controlsOk ? probed.filter((flag) => results[flag] === 'unregistered') : [],
    indeterminate,
  };
}

// Help does not always advertise a value domain: `claude --effort` and `codex
// --ask-for-approval` both take a value that no help text enumerates. The domain
// is still observable — hand the option an argument it cannot accept and read
// what the CLI says it wanted. Uses the same control-flag form as the
// registration probe so no argument can be mistaken for a prompt.
//
// Only options known to validate their argument are probed. For an unrestricted
// option (`--system-prompt`, `--settings`, `--debug-file`) the control flag is a
// perfectly good value, so the CLI parses it and proceeds into startup: real
// side effects, and one timeout's wait per option. Enumeration of the surface
// stays exhaustive; only this execution step is bounded.
async function probeOptionValueDomains(binary, options, candidates) {
  if (skipFlagProbe) return { skipped: true };
  const optionByFlag = new Map();
  for (const option of options) {
    for (const flag of option.flags) optionByFlag.set(flag, option);
  }
  // Candidates absent from help are hidden flags, which is exactly where a probe
  // is the only way to learn the domain. Candidates whose help already lists
  // choices need no probe.
  const targets = candidates
    .filter((flag) => (optionByFlag.get(flag)?.choices.length ?? 0) === 0)
    .slice(0, VALUE_DOMAIN_PROBE_MAX);
  const domains = {};
  const unresolved = [];
  const cwd = await probeScratchDir();
  for (const flag of targets) {
    const result = await run(binary, [flag, FLAG_PROBE_CONTROL], {
      timeoutMs: 8_000,
      maxBuffer: 4_000_000,
      cwd,
    });
    const domain = extractValueDomain(`${result.stdout ?? ''}\n${result.stderr ?? ''}`);
    if (domain) domains[flag] = domain;
    // A probe that timed out, failed, or whose diagnostic wording changed yields
    // no domain. Recording the miss is what lets the validity check tell "this
    // option has no enumerable domain" apart from "we failed to read it".
    else unresolved.push(flag);
  }
  return { probedCount: targets.length, domains, unresolved };
}

function extractValueDomain(text) {
  // Only a value rejection describes a domain. An option that accepted the
  // control argument and then failed for lack of a prompt says "Input must be
  // provided ..." — matching `must be` there would record the missing-prompt
  // error as if it were the option's value domain.
  if (!/is invalid|unknown --|valid values|valid options are|allowed choices are|possible values/i.test(text)) {
    return null;
  }
  const match = /(?:valid values|valid options are|allowed choices are|possible values)\s*:?\s*([^.\n]+)/i.exec(text)
    ?? /must be ([^.\n]+)/i.exec(text);
  if (!match) return null;
  return match[1].trim().replace(/\s+/g, ' ').slice(0, 160);
}

function classifyFlagProbe(text, flag, result) {
  if (new RegExp(`(unknown option|unexpected argument|unrecognized (option|argument))[^\\n]*${escapeRegExp(flag)}`, 'i').test(text)) {
    return 'unregistered';
  }
  if (/is invalid|allowed choices|valid values|valid options|must be/i.test(text)) return 'registered_value_validated';
  // A probe that was killed, timed out, or said nothing recognisable carries no
  // parser evidence. Falling through to "registered" here would let a failed
  // invocation vouch for a flag the CLI may have dropped.
  if (result?.signal || result?.code === null || text.trim() === '') return 'indeterminate';
  // The parser reached the control instead of consuming it, so the probed flag
  // is registered and takes no value there (boolean, or an optional-value form).
  if (new RegExp(`unknown option[^\\n]*${escapeRegExp(FLAG_PROBE_CONTROL)}`, 'i').test(text)) {
    return 'registered_no_value_consumed';
  }
  return 'registered_parsed';
}

async function collectBinaryScan(binary, knownHiddenFlags = []) {
  if (!binary) {
    return { available: false, reason: 'no native binary confirmed for the PATH-selected command' };
  }
  const stringsPath = await commandPath('strings');
  if (!stringsPath) return { available: false, reason: 'strings command not found' };
  // Scanning a wrapper script yields an empty flag set that looks exactly like a
  // binary that dropped every hidden flag. Refuse unless the target is known to
  // be native; an undeterminable type is not evidence that it is.
  const kind = await executableKind(binary);
  if (kind !== true) {
    return {
      available: true,
      ok: false,
      reason: kind === false ? 'target is not a native executable' : 'executable type could not be determined',
      binary,
    };
  }
  // The buffer has to hold the whole `strings` dump; Claude Code's bundle alone
  // is ~38MB of strings and grows with every release. A too-small buffer fails
  // the scan, which silently costs the hidden-flag authority.
  const result = await run(stringsPath, [binary], {
    timeoutMs: 60_000,
    maxBuffer: 512_000_000,
  });
  if (!result.ok) {
    return {
      available: true,
      ok: false,
      reason: 'strings failed',
      // The failure payload is raw binary; keep a bounded, readable slice only.
      error: trimEnd(String(result.stderr || result.stdout)).slice(0, 300),
    };
  }

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

// A PATH entry can be a shell wrapper that re-dispatches to the real CLI. The
// wrapper is what actually runs, so every behavioural authority — version, help,
// schema, parse probes — must keep using it. It carries none of the real
// binary's strings though, so the string scan needs the native target instead.
//
// The native target is not simply "the next same-named file on PATH": a wrapper
// can pin a different installation or select per-account binaries, and scanning
// an unrelated build would describe a runtime nobody is running. A candidate is
// accepted only when it reports the same version as the wrapper; otherwise the
// scan is left without a target and reports itself unavailable.
async function runtimeBinaryPath(name) {
  const primary = await commandPath(name);
  if (!primary) return { path: null, scanPath: null, wrapper: null };
  if (await executableKind(primary) !== false) {
    return { path: primary, scanPath: primary, wrapper: null };
  }
  const wrapperVersion = firstLine((await run(primary, ['--version'], { timeoutMs: 10_000 })).stdout);
  for (const dir of String(process.env.PATH ?? '').split(':')) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (candidate === primary || !existsSync(candidate)) continue;
    if (await executableKind(candidate) !== true) continue;
    const candidateVersion = firstLine((await run(candidate, ['--version'], { timeoutMs: 10_000 })).stdout);
    if (wrapperVersion && candidateVersion === wrapperVersion) {
      return { path: primary, scanPath: candidate, wrapper: primary };
    }
  }
  return { path: primary, scanPath: null, wrapper: primary };
}

// Returns true (native), false (not native), or null (undeterminable). Null is
// not "native": without `file` there is no evidence either way, and treating the
// unknown case as native is exactly what lets a PATH wrapper be scanned as if it
// were the binary.
async function executableKind(binary) {
  // `-L` because a CLI is often installed as a symlink to the real executable
  // (Homebrew does this for codex). GNU file does not follow symlinks unless
  // POSIXLY_CORRECT is set, and would answer "symbolic link to ..." — which
  // reads as "not native" and would misclassify the install as a wrapper.
  const result = await run('file', ['-b', '-L', binary], { timeoutMs: 10_000 });
  if (!result.ok) return null;
  return /Mach-O|ELF|PE32/i.test(result.stdout);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

async function run(command, commandArgs, options = {}) {
  try {
    const result = await execFileAsync(command, commandArgs, {
      cwd: options.cwd ?? repoRoot,
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

| Runtime | Exists | Version | Command on PATH | Scan target |
| --- | --- | --- | --- | --- |
| Codex CLI | ${yesNo(data.codex.exists)} | ${inline(firstLine(data.codex.version?.stdout))} | ${inline(data.codex.binary)} | ${data.codex.scanBinary ? inline(data.codex.scanBinary) : 'none confirmed'} |
| Claude Code | ${yesNo(data.claude.exists)} | ${inline(firstLine(data.claude.version?.stdout))} | ${inline(data.claude.binary)} | ${data.claude.scanBinary ? inline(data.claude.scanBinary) : 'none confirmed'} |

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
| Documented commands the CLI no longer has | ${(data.catalogValidity?.commands?.codex?.absent?.length ?? 0) + (data.catalogValidity?.commands?.claude?.absent?.length ?? 0)} |
| Documented option domains that disagree with the CLI | ${data.catalogValidity?.optionDomainMismatches?.length ?? 0} |
| Commands present but undocumented | ${(data.catalogValidity?.commands?.codex?.undocumented?.length ?? 0) + (data.catalogValidity?.commands?.claude?.undocumented?.length ?? 0)} |

### Documented Commands

| Runtime | Authority | Documented | In command tree | Hidden, probe-confirmed | Absent |
| --- | --- | ---: | ---: | ---: | --- |
${['codex', 'claude'].map((runtime) => {
  const check = data.catalogValidity?.commands?.[runtime];
  const absent = check?.absent ?? [];
  return `| ${runtime} | \`${check?.authority ?? 'not_checked'}\` | ${check?.documentedCount ?? 0} | ${check?.visible?.length ?? 0} | ${check?.hiddenConfirmed?.length ?? 0} | ${absent.length > 0 ? absent.map((value) => inline(value)).join(', ') : 'none'} |`;
}).join('\n')}

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

## Claude Hidden Flag Parse Probe

Flags registered with \`hideHelp()\` are absent from \`--help\`, so acceptance is measured by passing an invalid value and reading the parser's answer. \`unregistered\` means the installed CLI rejects the flag with "unknown option" and the catalog entry is stale. Controls must be \`unregistered\` for the probe to carry authority.

Authority: \`${data.catalogValidity?.claude?.hiddenFlagAuthority ?? 'not_checked'}\` — controls ${data.claude.flagProbe?.controlsOk ? 'passed' : 'FAILED (probe not trusted)'}.

| Flag | Parse probe | Strings in binary |
| --- | --- | --- |
${renderFlagProbeRows(data.claude)}

## Binary Scan Summary

Discovery-only (L0). String presence proves a token is compiled in, not that the parser accepts it — compare against the parse probe above.

| Runtime | Status | Flags | Method-like strings |
| --- | --- | ---: | ---: |
| Codex CLI | ${renderScanStatus(data.codex.binaryScan)} | ${data.codex.binaryScan?.flagCandidateCount ?? 0} | ${data.codex.binaryScan?.methodCandidateCount ?? 0} |
| Claude Code | ${renderScanStatus(data.claude.binaryScan)} | ${data.claude.binaryScan?.flagCandidateCount ?? 0} | ${data.claude.binaryScan?.methodCandidateCount ?? 0} |

## Probed Option Value Domains

Root options whose help advertises no choice list, with the domain the CLI reported when handed an argument it could not accept.

| Runtime | Option | Reported domain |
| --- | --- | --- |
${renderValueDomains(data)}

## Command Surface

Every command reachable by walking \`--help\` from the root, with the options each one advertises.

| Runtime | Commands | Options | Truncated |
| --- | ---: | ---: | --- |
| Codex CLI | ${data.codex.commandTree?.commandCount ?? 0} | ${data.codex.commandTree?.optionCount ?? 0} | ${yesNo(data.codex.commandTree?.truncated)} |
| Claude Code | ${data.claude.commandTree?.commandCount ?? 0} | ${data.claude.commandTree?.optionCount ?? 0} | ${yesNo(data.claude.commandTree?.truncated)} |

### Codex CLI

${renderCommandTree(data.codex.commandTree, 'codex')}

### Claude Code

${renderCommandTree(data.claude.commandTree, 'claude')}

## Update Guidance

1. Validate existing entries in \`${data.updateGuidance.catalog}\` before adding new entries.
2. Remove, rename, or downgrade stale entries when collected authorities no longer support them.
3. Keep source levels separate. Do not promote L0/L1/L2/L3 items into production defaults without L4 runtime probes.
4. Follow \`${data.updateGuidance.playbook}\` for LLM-assisted document updates.
`;
}

function renderFlagProbeRows(runtime) {
  const probe = runtime.flagProbe;
  if (!probe || probe.skipped) return '| _(probe skipped)_ | | |';
  const scanned = runtime.binaryScan?.ok === true ? runtime.binaryScan : null;
  const rows = Object.entries(probe.results ?? {});
  if (rows.length === 0) return '| _(no flags probed)_ | | |';
  return rows
    .map(([flag, verdict]) => {
      const strings = scanned
        ? yesNo((scanned.hiddenFlagsPresent ?? []).includes(flag))
        : 'unknown';
      return `| ${inline(flag)} | \`${verdict}\` | ${strings} |`;
    })
    .join('\n');
}

function renderValueDomains(data) {
  const rows = [];
  for (const [label, runtime] of [['Codex CLI', data.codex], ['Claude Code', data.claude]]) {
    const domains = runtime.optionValueDomains?.domains ?? {};
    for (const [flag, domain] of Object.entries(domains)) {
      rows.push(`| ${label} | ${inline(flag)} | ${escapeMarkdown(domain)} |`);
    }
  }
  return rows.length > 0 ? rows.join('\n') : '| _(none probed)_ | | |';
}

function renderScanStatus(scan) {
  if (!scan) return 'not collected';
  if (scan.skipped) return 'skipped';
  if (scan.available === false) return `unavailable (${escapeMarkdown(scan.reason ?? 'unknown')})`;
  if (!scan.ok) return `failed (${escapeMarkdown(scan.reason ?? 'unknown')})`;
  return 'ok';
}

function renderCommandTree(tree, binaryName) {
  if (!tree || tree.skipped) return '_(command tree skipped)_';
  if (!tree.commands?.length) return 'No commands collected.';
  return tree.commands
    .map((entry) => {
      const invocation = entry.command === '(root)' ? binaryName : `${binaryName} ${entry.command}`;
      const header = `#### \`${invocation}\``;
      const usage = entry.usage ? `\nUsage: \`${entry.usage}\`\n` : '';
      const subcommands = entry.subcommands?.length
        ? `\nSubcommands: ${entry.subcommands.map((name) => inline(name)).join(', ')}\n`
        : '';
      const options = entry.options?.length
        ? [
            '',
            '| Option | Value | Choices | Default |',
            '| --- | --- | --- | --- |',
            ...entry.options.map((option) => [
              option.flags.concat(option.shortFlags).map((flag) => inline(flag)).join(', '),
              option.valuePlaceholder ? inline(option.valuePlaceholder) : '—',
              option.choices?.length ? option.choices.map((choice) => inline(choice)).join(', ') : '—',
              option.default ? inline(option.default) : '—',
            ].join(' | ')).map((row) => `| ${row} |`),
            '',
          ].join('\n')
        : '\nNo options advertised.\n';
      return `${header}\n${usage}${subcommands}${options}`;
    })
    .join('\n');
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
