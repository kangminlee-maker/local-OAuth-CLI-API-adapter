#!/usr/bin/env node
// A `claude` stand-in with BOTH channels the CLI actually has when it is given
// an output schema: it streams model text AND reports `structured_output`.
//
// The repo had no such double. `streaming-claude.cjs` reports `result: <text>`
// and no `structured_output`; `structured-claude.cjs` reports
// `structured_output` and streams nothing. A `--json-schema` turn always
// produces the shape below, and the gap is why a regression that made the
// streamed text disagree with the published answer could not fail the suite.
const readline = require('node:readline');
const args = process.argv.slice(2);
const isPersistent = args.includes('--input-format') && args.includes('stream-json');
const prose = process.env.SCHEMA_PROSE ?? '';
const structured = process.env.SCHEMA_STRUCTURED ?? '{}';

function write(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }

function emit() {
  write({ type: 'stream_event', event: { type: 'message_start' }, session_id: 'fake_session' });
  write({
    type: 'stream_event',
    event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    session_id: 'fake_session',
  });
  for (const ch of prose) {
    write({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ch } },
      session_id: 'fake_session',
    });
  }
  write({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 }, session_id: 'fake_session' });
  // `result` is empty and the answer is the structured member — the shape the
  // repo's own `fake-claude.cjs::emitStructured()` and `structured-claude.cjs`
  // both model. Written by concatenation so the member keeps its exact bytes.
  process.stdout.write(
    '{"type":"result","subtype":"success","result":"","structured_output":' + structured
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
