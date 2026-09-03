#!/usr/bin/env node
// A `claude` stand-in that answers with exactly the string the test chose, so a
// decision wrapper can be driven through the REAL `ClaudeCodeBackend` instead
// of through a double that copies its mapping. The double could not fail when
// the backend's own propagation line broke.
const readline = require('node:readline');
const args = process.argv.slice(2);
const isPersistent = args.includes('--input-format') && args.includes('stream-json');
const raw = process.env.WRAPPER_RAW ?? '';

function emit() {
  process.stdout.write(`${JSON.stringify({
    type: 'result',
    subtype: 'success',
    result: raw,
    stop_reason: 'end_turn',
    session_id: 'fake_session',
    usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 },
  })}\n`);
}

if (isPersistent) {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', () => emit());
  rl.on('close', () => process.exit(0));
} else {
  emit();
  process.exit(0);
}
