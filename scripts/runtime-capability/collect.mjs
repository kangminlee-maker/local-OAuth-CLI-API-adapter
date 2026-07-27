// Per-runtime collection. Assembles the authorities for codex and claude:
// version, help, command tree, schema, probes and binary scan.
import {
  COMMAND_TREE_MAX_COMMANDS,
  COMMAND_TREE_MAX_DEPTH,
  VALUE_DOMAIN_PROBE_CANDIDATES,
  skipBinaryScan,
  skipCommandTree,
  skipFlagProbe,
} from './options.mjs';
import {
  commandPath,
  executableKind,
  run,
  runtimeBinaryPath,
  summarizeCommand,
} from './exec.mjs';
import { extractHelpFlags, parseHelpText, rootOptionsOf } from './help-parser.mjs';
import { probeFlagRegistration, probeOptionValueDomains } from './probes.mjs';
import { collectCodexSchema } from './schema.mjs';
import { escapeRegExp, trimEnd, uniqueMatches } from './text.mjs';

export async function collectCodex() {
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

export async function collectClaude() {
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

export async function collectRuntimeBase(name, binary, { scanPath = binary, wrapper = null } = {}) {
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

export async function collectHelp(binary, specs) {
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
export async function collectCommandTree(binary) {
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

export async function collectBinaryScan(binary, knownHiddenFlags = []) {
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
