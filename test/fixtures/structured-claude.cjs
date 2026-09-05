#!/usr/bin/env node
// A `claude` stand-in that emits a `structured_output` member with EXACT source
// bytes chosen by the test, so a number too large for IEEE-754 can be checked
// end to end. It writes the line by string concatenation rather than
// JSON.stringify, because stringify would round the value before the proxy
// ever saw it.
const readline = require('node:readline');
const args = process.argv.slice(2);
const isPersistent = args.includes('--input-format') && args.includes('stream-json');
const raw = process.env.STRUCTURED_RAW ?? '{}';

function emit() {
  process.stdout.write(
    '{"type":"result","subtype":"success","result":"","structured_output":' + raw
    + ',"stop_reason":"end_turn","session_id":"fake_session"'
    + ',"usage":{"input_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":1}}\n',
  );
}

if (isPersistent) {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', () => emit());
  rl.on('close', () => process.exit(0));
} else {
  emit();
  process.exit(0);
}
