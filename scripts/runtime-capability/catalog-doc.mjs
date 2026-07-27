// Reads claims out of the catalog markdown: which commands, options, value
// domains and request contracts the document asserts.
import { uniqueCapture, uniqueMatches } from './text.mjs';

// Commands appear two ways in the catalog: fully qualified in prose and
// examples (`codex app-server --listen stdio://`), and bare in the command
// inventory tables (`exec`). Both are claims about the installed CLI, so both
// are checked; keeping only the qualified form would let a renamed command sit
// in the inventory table without ever failing the gate.
export function documentedCommandPaths(section, binaryName) {
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

// Name and description cells of tables that inventory commands. Scoped by
// header so value tables (`| Field | Domain |`) and flag tables cannot
// contribute names. The description cell counts because inventory rows name
// their children there (`app-server daemon`, `auth login`); reading only the
// first cell would leave those documented commands unchecked while reporting
// the live ones as undocumented forever.
export function commandInventoryCells(section) {
  const cells = [];
  let inInventory = false;
  for (const line of String(section).split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) {
      inInventory = false;
      continue;
    }
    const columns = line.split('|').slice(1, -1).map((value) => value.trim());
    const first = columns[0] ?? '';
    if (/^(root subcommand|command)$/i.test(first)) {
      inInventory = true;
      continue;
    }
    if (/^:?-{2,}:?$/.test(first)) continue;
    if (!inInventory) continue;
    if (first) cells.push(first);
    if (columns[1]) cells.push(columns[1]);
  }
  return cells;
}

export function documentedRequestContracts(section) {
  const rows = new Map();
  let inTable = false;
  for (const line of String(section).split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) {
      inTable = false;
      continue;
    }
    const columns = line.split('|').slice(1, -1).map((value) => value.trim());
    const first = columns[0] ?? '';
    if (/^request$/i.test(first)) {
      inTable = true;
      continue;
    }
    if (/^:?-{2,}:?$/.test(first)) continue;
    if (!inTable) continue;
    const method = uniqueCapture(first, /`([a-z][A-Za-z0-9]*\/[A-Za-z0-9/_]+)`/g)[0];
    if (!method) continue;
    rows.set(method, {
      required: uniqueCapture(columns[1] ?? '', /`([A-Za-z][A-Za-z0-9_]*)`/g).sort(),
      optional: uniqueCapture(columns[2] ?? '', /`([A-Za-z][A-Za-z0-9_]*)`/g).sort(),
    });
  }
  return rows;
}

export function documentedFlagUses(section, binaryName) {
  const uses = new Map();
  // Walk line by line so a row that qualifies its first invocation and then
  // lists sibling flags in shorthand still binds those flags to the same
  // command. Reading each backticked span in isolation would drop them.
  for (const line of String(section).split(/\r?\n/)) {
    let currentCommand = null;
    for (const raw of String(line).matchAll(/`([^`]+)`/g)) {
      const command = [];
      const flags = [];
      let qualified = false;
      for (const token of raw[1].trim().split(/\s+/)) {
        if (token.startsWith('--')) {
          const name = token.split('=')[0];
          // Codex ships underscore-bearing flags (`--experimental_issuer`), so
          // the extractor accepts the same syntax the CLI does.
          if (/^--[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) flags.push(name);
          continue;
        }
        if (flags.length > 0) continue;
        if (command.length === 0 && token === binaryName) {
          qualified = true;
          continue;
        }
        if (/^[A-Za-z][A-Za-z0-9-]*$/.test(token)) command.push(token);
      }
      if (flags.length === 0) continue;
      if (qualified) currentCommand = command.join(' ');
      else if (currentCommand === null) continue;
      const target = qualified ? command.join(' ') : currentCommand;
      for (const flag of flags) {
        uses.set(`${target} ${flag}`, { command: target, flag });
      }
    }
  }
  return [...uses.values()];
}

export function documentedOptionDomains(section) {
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

export function normalizeDomainValue(value) {
  return String(value).trim().replace(/^["'`]+|["'`.]+$/g, '').toLowerCase();
}
