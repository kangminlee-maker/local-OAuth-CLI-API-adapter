#!/usr/bin/env node
const readline = require('node:readline');

require('./direct-provider-env.cjs').assertNoDirectProviderEnv('fake claude');

const args = process.argv.slice(2);
const isPersistent = args.includes('--input-format') && args.includes('stream-json');
const hasSchema = args.includes('--json-schema');
const systemPromptIndex = args.indexOf('--system-prompt');
const jsonSchema = readJsonSchemaArg();
const isToolArgumentsOnlySchema = Boolean(jsonSchema?.properties?.city)
  && !jsonSchema?.properties?.toolCalls;

if (
  systemPromptIndex === -1
  || !args[systemPromptIndex + 1]?.includes('API completion backend')
  || !args.includes('--disable-slash-commands')
  || !args.includes('--strict-mcp-config')
  || args[args.indexOf('--mcp-config') + 1] !== '{"mcpServers":{}}'
) {
  process.stderr.write(`missing Claude context isolation args: ${args.join(' ')}\n`);
  process.exit(2);
}

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
      cache_creation_input_tokens: 2,
      cache_read_input_tokens: 1,
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
  const streamed = JSON.stringify(structured_output);
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
  for (const delta of streamed.match(/.{1,12}/g) ?? []) {
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
  write({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 }, session_id: 'fake_session' });
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

function emitToolArgumentsOnly() {
  const structured_output = { city: 'Seoul' };
  const streamed = '{"city":"Seoul"}';
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
  for (const delta of ['{"city"', ':"Seoul"}']) {
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
  write({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 }, session_id: 'fake_session' });
  write({
    type: 'result',
    subtype: 'success',
    result: streamed,
    structured_output,
    session_id: 'fake_session',
    usage: {
      input_tokens: 5,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 4,
    },
  });
}

function emitJsonObject() {
  const text = '{"adapter":"local-oauth-cli","ok":true}';
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
  for (const delta of text.match(/.{1,12}/g) ?? []) {
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
      input_tokens: 4,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 4,
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
    else if (isToolArgumentsOnlySchema || text.includes('Return only the JSON object for that tool\'s arguments.')) {
      emitToolArgumentsOnly();
    }
    else if (hasSchema || text.includes('Schema JSON only.')) emitStructured();
    else if (text.includes('Valid JSON only.')) emitJsonObject();
    else emitText('OK');
  });
  rl.on('close', () => process.exit(0));
} else if (hasSchema) {
  if (isToolArgumentsOnlySchema) emitToolArgumentsOnly();
  else emitStructured();
} else {
  emitText('OK');
}

function readJsonSchemaArg() {
  const index = args.indexOf('--json-schema');
  if (index === -1) return null;
  try {
    return JSON.parse(args[index + 1] ?? 'null');
  } catch {
    return null;
  }
}

