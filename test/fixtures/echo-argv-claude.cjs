#!/usr/bin/env node
// Minimal fake `claude` that echoes its spawned argv back as the result text, so
// tests can assert which per-request flags (--json-schema, --effort, --thinking,
// --task-budget) the backend forwarded.
const args = process.argv.slice(2);
const isPersistent = args.includes('--input-format') && args.includes('stream-json');

function write(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function emit() {
  write({
    type: 'result',
    subtype: 'success',
    result: JSON.stringify(args),
    stop_reason: 'end_turn',
    session_id: 'fake_session',
    usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 },
  });
}

if (isPersistent) {
  const readline = require('node:readline');
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', () => emit());
  rl.on('close', () => process.exit(0));
} else {
  emit();
  process.exit(0);
}
