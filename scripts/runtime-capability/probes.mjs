// Runtime probes (L4). Everything here answers a question help text cannot:
// does the CLI accept this flag, what values does it take, is this a real
// command. All probes use flag-shaped arguments so nothing becomes a prompt.
import {
  FLAG_PROBE_CONTROL,
  FLAG_PROBE_CONTROLS,
  VALUE_DOMAIN_PROBE_MAX,
  skipFlagProbe,
} from './options.mjs';
import { probeScratchDir, run } from './exec.mjs';
import { parseHelpText } from './help-parser.mjs';
import { escapeRegExp } from './text.mjs';

// Parse probe: the only authority that answers "does the installed CLI accept
// this flag today". A string in the binary proves the token is compiled in, not
// that the parser is wired to it — Claude Code 2.1.231 still ships strings for
// flags it now rejects.
//
// The probe pairs the flag with a bogus control flag rather than a plain value.
// A value would be consumed as the prompt when the probed flag turns out to be
// boolean, which runs a real model turn; a flag-shaped argument never can be.
// The parser then names whichever option it could not resolve, which separates
// all three cases: it names the probed flag when unregistered, names the control
// when the probed flag is a registered boolean that consumed nothing, and
// reports a value-validation failure when the probed flag takes a value.
export async function probeFlagRegistration(binary, flags) {
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

export function classifyFlagProbe(text, flag, result) {
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
export async function probeOptionValueDomains(binary, options, candidates) {
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

export function extractValueDomain(text) {
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

export async function probeFlagInCommand(binary, command, flag) {
  const result = await run(binary, [...(command ? command.split(' ') : []), flag, FLAG_PROBE_CONTROL], {
    timeoutMs: 12_000,
    maxBuffer: 4_000_000,
    cwd: await probeScratchDir(),
  });
  return classifyFlagProbe(`${result.stdout ?? ''}\n${result.stderr ?? ''}`, flag, result);
}

// The same negative control the hidden-flag probe insists on, for the other
// runtime. `classifyFlagProbe` decides "unregistered" by matching the CLI's
// rejection wording, so a release that rewords it makes every probe fall
// through to `registered_parsed` — every documented option would read as
// confirmed and nothing would look wrong. Probing a flag the CLI cannot have
// is what distinguishes "the parser rejected it" from "the matcher stopped
// working". Controls are probed per command because subcommands can differ.
export async function probeFlagControls(binary, command) {
  const verdicts = {};
  for (const control of FLAG_PROBE_CONTROLS) {
    verdicts[control] = await probeFlagInCommand(binary, command, control);
  }
  return {
    verdicts,
    ok: FLAG_PROBE_CONTROLS.every((control) => verdicts[control] === 'unregistered'),
  };
}

export async function commandUsage(binary, commandPath) {
  const argv = commandPath ? [...commandPath.split(' '), '--help'] : ['--help'];
  const result = await run(binary, argv, {
    timeoutMs: 20_000,
    maxBuffer: 8_000_000,
    cwd: await probeScratchDir(),
  });
  // A help that never ran carries no usage line, and an absent usage line is
  // how a command gets called removed. Say the run failed instead.
  if (!result.ok) return null;
  // `parseHelpText` initialises usage to '' and never returns null, so an empty
  // string here means "help ran and printed no usage line" — not a usage of
  // zero length. It is not a value the caller can compare against.
  return parseHelpText(`${result.stdout ?? ''}\n${result.stderr ?? ''}`).usage || null;
}

// A hidden command prints usage for itself; an unknown name falls back to the
// parent's help. An alias prints the canonical command's usage instead of its
// own name, so a usage line that differs from the parent's also counts.
export async function commandAnswersForItself(binary, binaryName, commandPath, parentUsage) {
  const result = await run(binary, [...commandPath.split(' '), '--help'], {
    timeoutMs: 20_000,
    maxBuffer: 8_000_000,
    cwd: await probeScratchDir(),
  });
  // Nothing this run printed is evidence unless the run itself completed. A
  // killed or non-zero invocation can still have emitted partial output that
  // mentions the command — an error line naming it is enough — and reading that
  // as "the command answered for itself" confirms an entry the CLI may have
  // removed. The failure check has to come before any inspection of the text.
  if (!result.ok) return 'indeterminate';
  const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (new RegExp(`(^|\\s)${escapeRegExp(binaryName)}\\s+${escapeRegExp(commandPath)}(\\s|$)`, 'im').test(text)) {
    return 'yes';
  }
  const usage = parseHelpText(text).usage;
  // Both sides must be a real usage line. `parseHelpText` returns '' rather than
  // null when it finds none, so a `=== null` guard here lets '' through and the
  // `usage !== parentUsage` comparison below then reports a REMOVED command as
  // confirmed — the inverted verdict this function exists to avoid. Compare
  // truthiness, not nullness.
  if (!usage || !parentUsage) return 'indeterminate';
  return usage !== parentUsage ? 'yes' : 'no';
}
