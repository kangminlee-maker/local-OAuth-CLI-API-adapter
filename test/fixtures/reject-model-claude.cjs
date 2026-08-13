#!/usr/bin/env node
// Reproduces how Claude Code refuses an unknown `--model`: it prints the
// diagnostic and exits non-zero before starting a session, so no model call
// happens. The real CLI writes this to both stdout and stderr; the backend reads
// stderr, so that is what matters here.
const argv = process.argv.slice(2);
const index = argv.indexOf('--model');
const model = index === -1 ? '(none)' : argv[index + 1];

// Lets a test tell which route it exercised: the one-shot path passes the prompt
// as an argument, the persistent path never does.
const log = process.env.CLAUDE_TEST_ARGV_LOG;
if (log) {
  require('node:fs').appendFileSync(log, `${JSON.stringify(argv)}\n`);
}

process.stderr.write(
  `There's an issue with the selected model (${model}). `
  + 'It may not exist or you may not have access to it. '
  + 'Run --model to pick a different model.\n',
);
process.exit(1);
