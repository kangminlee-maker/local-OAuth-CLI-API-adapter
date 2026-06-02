#!/usr/bin/env node
const readline = require('node:readline');

const args = process.argv.slice(2);
const isPersistent = args.includes('--input-format') && args.includes('stream-json');
const hasSchema = args.includes('--json-schema');

function write(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function emitText(text) {
  write({ type: 'system', subtype: 'init', session_id: 'fake_session' });
  write({ type: 'stream_event', event: { type: 'message_start' }, session_id: 'fake_session' });
  write({
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    },
    session_id: 'fake_session',
  });
  for (const delta of text.match(/.{1,1}/g) ?? []) {
    write({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: delta },
      },
      session_id: 'fake_session',
    });
  }
  write({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
    session_id: 'fake_session',
  });
  write({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 }, session_id: 'fake_session' });
  write({
    type: 'result',
    subtype: 'success',
    result: text,
    session_id: 'fake_session',
    usage: {
      input_tokens: 3,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: text.length,
    },
  });
}

function emitStructured() {
  const structured_output = {
    status: 'tool_calls',
    text: '',
    toolCalls: [
      {
        id: 'call_1',
        name: 'get_weather',
        arguments: '{"city":"Seoul"}',
      },
    ],
  };
  write({ type: 'system', subtype: 'init', session_id: 'fake_session' });
  write({
    type: 'result',
    subtype: 'success',
    result: '',
    structured_output,
    session_id: 'fake_session',
    usage: {
      input_tokens: 5,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 8,
    },
  });
}

if (isPersistent) {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    let payload;
    try {
      payload = JSON.parse(line);
    } catch {
      return;
    }
    const content = payload?.message?.content;
    const text = Array.isArray(content)
      ? content.map((part) => part?.text ?? '').join('')
      : String(content ?? '');
    if (text.trim() === '/clear') emitText('');
    else if (hasSchema) emitStructured();
    else emitText('OK');
  });
  rl.on('close', () => process.exit(0));
} else if (hasSchema) {
  emitStructured();
} else {
  emitText('OK');
}
