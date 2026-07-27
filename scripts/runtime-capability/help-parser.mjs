// `--help` text to structure. Turns clap and commander output into commands,
// options, value placeholders, choice lists and defaults.
import { OPTION_ENTRY_MAX_INDENT } from './options.mjs';
import { uniqueCapture, uniqueMatches } from './text.mjs';

// Both runtimes print clap/commander-shaped help: `Usage:` line, a description
// block, then `Commands:` / `Options:` / `Arguments:` sections whose entries all
// sit at one indent with the description separated by two or more spaces.
// Anything deeper is continuation text — wrapped descriptions, clap's
// `[possible values: ...]`, and the multi-line usage examples Claude Code embeds
// inside `claude mcp add`'s description. Pinning each section's entry indent to
// its first entry is what keeps those example lines from parsing as commands.
export function parseHelpText(text) {
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

export function structureOption(entry) {
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

export function structureSubcommand(entry) {
  const [head = '', ...aliases] = entry.signature.split(/\s+/)[0].split('|');
  return { name: head, aliases, description: entry.description };
}

export function extractChoices(text) {
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

export function rootOptionsOf(commandTree) {
  return commandTree?.commands?.find((entry) => entry.command === '(root)')?.options ?? [];
}

export function extractHelpFlags(helpByCommand) {
  const flags = new Set();
  for (const command of Object.values(helpByCommand)) {
    if (!command?.stdout) continue;
    for (const flag of extractOptionDefinitionFlags(command.stdout)) {
      flags.add(flag);
    }
  }
  return [...flags].sort();
}

export function extractOptionDefinitionFlags(text) {
  const flags = new Set();
  for (const line of String(text).split(/\r?\n/)) {
    if (!/^\s*(?:-[A-Za-z0-9],\s*)?--[A-Za-z0-9]/.test(line)) continue;
    for (const flag of uniqueMatches(line, /--[A-Za-z0-9][A-Za-z0-9_-]+/g)) {
      flags.add(flag);
    }
  }
  return [...flags].sort();
}
