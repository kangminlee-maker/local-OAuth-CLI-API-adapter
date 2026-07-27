// Command-line inputs and collection limits, resolved once so every module
// reads the same run configuration.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));

export const repoRoot = resolve(scriptDir, '..', '..');
export const args = process.argv.slice(2);
export const outDir = resolve(repoRoot, readValueArg('--out') ?? 'artifacts/runtime-capability-catalog');
export const catalogPath = resolve(repoRoot, readValueArg('--catalog') ?? 'docs/runtime-capability-catalog.md');
export const skipBinaryScan = args.includes('--skip-binary-scan');
export const skipFlagProbe = args.includes('--skip-flag-probe');
export const skipCommandTree = args.includes('--skip-command-tree');
export const failOnStale = args.includes('--fail-on-stale');

export const COMMAND_TREE_MAX_DEPTH = 4;
export const COMMAND_TREE_MAX_COMMANDS = 300;
export const OPTION_ENTRY_MAX_INDENT = 6;
export const VALUE_DOMAIN_PROBE_MAX = 40;
export const HOT_PATH_REQUEST_METHODS = ['thread/start', 'turn/start'];
// Options whose argument the CLI is known to validate, so the probe ends at the
// parser. Anything absent from the installed surface is simply skipped.
export const VALUE_DOMAIN_PROBE_CANDIDATES = {
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
export const FLAG_PROBE_CONTROL = '--zzz-catalog-probe-control';
export const FLAG_PROBE_CONTROLS = ['--zzz-not-a-real-flag', '--zzz-catalog-probe-absent'];

export function readValueArg(name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}
