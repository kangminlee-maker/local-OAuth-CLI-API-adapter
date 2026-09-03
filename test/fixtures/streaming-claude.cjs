#!/usr/bin/env node
// A `claude` stand-in that streams `WRAPPER_RAW` one character at a time and
// then reports it as the turn's result. It exists so a test can ask what the
// client RECEIVED on the wire before the response path refused the turn — the
// question a buffered-only probe cannot answer.
const readline = require('node:readline');
const args = process.argv.slice(2);
const isPersistent = args.includes('--input-format') && args.includes('stream-json');
const raw = process.env.WRAPPER_RAW ?? '';

function write(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }

function emit() {
  write({ type: 'stream_event', event: { type: 'message_start' }, session_id: 'fake_session' });
  write({
    type: 'stream_event',
    event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    session_id: 'fake_session',
  });
  for (const ch of raw) {
    write({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ch } },
      session_id: 'fake_session',
    });
  }
  write({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 }, session_id: 'fake_session' });
  write({
    type: 'result',
    subtype: 'success',
    result: raw,
    stop_reason: 'end_turn',
    session_id: 'fake_session',
    usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 },
  });
}

if (isPersistent) {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', () => emit());
  rl.on('close', () => process.exit(0));
} else {
  emit();
  process.exit(0);
}
