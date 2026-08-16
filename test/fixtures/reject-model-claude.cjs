#!/usr/bin/env node
// Reproduces how Claude Code refuses an unknown `--model` under
// `--output-format stream-json`, which is the form the proxy always uses.
//
// Observed against the real CLI: the process exits 0, writes nothing to stderr,
// and reports the refusal inside the result event (`is_error`, `error:
// "model_not_found"`, `api_error_status: 404`). An earlier version of this
// fixture wrote to stderr and exited 1 — the plain-text-mode behaviour — which
// made the backend's mapping look correct in tests while it never fired live.
const argv = process.argv.slice(2);
const index = argv.indexOf('--model');
const model = index === -1 ? '(none)' : argv[index + 1];

const log = process.env.CLAUDE_TEST_ARGV_LOG;
if (log) {
  require('node:fs').appendFileSync(log, `${JSON.stringify(argv)}\n`);
}

const message = `There's an issue with the selected model (${model}). `
  + 'It may not exist or you may not have access to it. '
  + 'Run --model to pick a different model.';

const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

write({
  type: 'assistant',
  message: {
    id: 'msg_reject',
    model: '<synthetic>',
    role: 'assistant',
    type: 'message',
    content: [{ type: 'text', text: message }],
    usage: { input_tokens: 0, output_tokens: 0 },
  },
  error: 'model_not_found',
  is_api_error_message: true,
});
write({
  type: 'result',
  subtype: 'success',
  is_error: true,
  api_error_status: 404,
  error: 'model_not_found',
  result: message,
  usage: { input_tokens: 0, output_tokens: 0 },
});
process.exit(0);
