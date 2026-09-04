import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { after, test } from 'node:test';
import { CodexBackendTransport } from '../dist/proxy/codex-backend-transport.js';
import { startLocalApiProxy } from '../dist/proxy/http-server.js';

// A completed native call's arguments are the vendor's own answer. The
// transport used to wrap what did not parse as `{"input": …}` on the
// buffered path while the stream had already carried the bytes — one answer,
// two calls (round 21, codex C3). Chat and Responses now publish the bytes on
// both paths, as the direct API does; `/v1/messages`, whose `input` is a JSON
// value, refuses a call that is not a JSON object with the wrapper reading's
// own 502 — bytes first, then an in-band `error`, on the stream.

const realFetch = globalThis.fetch;
after(() => { globalThis.fetch = realFetch; });

const b64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
async function createCodexHome() {
  const dir = await mkdtemp(join(tmpdir(), 'native-call-arguments-'));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'auth.json'), JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: {
      id_token: `${b64url({ alg: 'none' })}.${b64url({ 'https://api.openai.com/auth': { chatgpt_account_id: 'a1' } })}.s`,
      access_token: 't',
      refresh_token: 'r',
      account_id: 'a1',
    },
    last_refresh: new Date().toISOString(),
  }));
  return dir;
}
const sse = (events) => events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');

function completedCall(args) {
  return [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'probe' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: args },
    { type: 'response.function_call_arguments.done', output_index: 0, item_id: 'fc_1', arguments: args },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'probe', arguments: args } },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [] } },
  ];
}

// The fetch double stands in for the vendor; the proxy is reached over
// node:http so the double never answers for it.
function post(url, headers, body) {
  return new Promise((resolvePromise, reject) => {
    const target = new URL(url);
    const req = request({ host: target.hostname, port: target.port, path: target.pathname, method: 'POST', headers }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolvePromise({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

function events(text) {
  return text.split('\n').filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]').map((line) => JSON.parse(line.slice(6)));
}

async function withProxy(args, run) {
  return withProxyEvents(completedCall(args), run);
}

async function withProxyEvents(vendorEvents, run) {
  return withProxyResponse(() => new Response(sse(vendorEvents), { status: 200 }), run);
}

async function withProxyResponse(respond, run) {
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => respond();
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000 });
  const server = await startLocalApiProxy({ backend, host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000 });
  try {
    await run(server.url);
  } finally {
    await server.close();
    await backend.close();
  }
}

const OPENAI = { 'content-type': 'application/json', authorization: 'Bearer local' };
const ANTHROPIC = { 'content-type': 'application/json', 'x-api-key': 'local', 'anthropic-version': '2023-06-01' };
const CHAT = { model: 'm', messages: [{ role: 'user', content: 'w' }], tools: [{ type: 'function', function: { name: 'probe', parameters: { type: 'object' } } }], tool_choice: 'required' };
const MESSAGES = { model: 'm', max_tokens: 64, messages: [{ role: 'user', content: 'w' }], tools: [{ name: 'probe', input_schema: { type: 'object' } }], tool_choice: { type: 'tool', name: 'probe' } };

test('chat over the native transport: a completed call that is not JSON is the same bytes on both paths', async () => {
  await withProxy('not json', async (url) => {
    const buffered = await post(`${url}/v1/chat/completions`, OPENAI, CHAT);
    const body = JSON.parse(buffered.text);
    assert.equal(buffered.status, 200, buffered.text);
    assert.equal(body.choices[0].message.tool_calls[0].function.arguments, 'not json');
    const streamed = await post(`${url}/v1/chat/completions`, OPENAI, { ...CHAT, stream: true });
    const chunks = events(streamed.text);
    const streamedArguments = chunks.flatMap((chunk) => chunk.choices?.[0]?.delta?.tool_calls ?? []).map((call) => call.function?.arguments ?? '').join('');
    assert.equal(streamedArguments, 'not json');
  });
});

test('messages over the native transport: a completed call that is not a JSON object is refused, bytes first on the stream', async () => {
  // Whitespace-only arguments are bytes the vendor wrote, not "wrote none"
  // (r22-fable F2: the body said `{}` behind a stream that carried spaces).
  for (const [args, sentence] of [['not json', 'arguments that are not JSON'], ['[1, 2]', 'arguments that are not a JSON object'], ['   ', 'arguments that are not JSON']]) {
    await withProxy(args, async (url) => {
      const buffered = await post(`${url}/v1/messages`, ANTHROPIC, MESSAGES);
      const body = JSON.parse(buffered.text);
      assert.equal(buffered.status, 502, buffered.text);
      assert.match(body.error.message, new RegExp(sentence));
      const streamed = await post(`${url}/v1/messages`, ANTHROPIC, { ...MESSAGES, stream: true });
      const frames = events(streamed.text);
      const partial = frames.filter((frame) => frame.type === 'content_block_delta' && frame.delta?.type === 'input_json_delta').map((frame) => frame.delta.partial_json).join('');
      assert.equal(partial, args, 'the bytes the vendor wrote reach the stream');
      const error = frames.find((frame) => frame.type === 'error');
      assert.ok(error, JSON.stringify(frames.map((frame) => frame.type)));
      assert.match(error.error.message, new RegExp(sentence));
      assert.ok(!frames.some((frame) => frame.type === 'message_stop'), 'a refused turn does not end as a delivered one');
    });
  }
});

test('messages over the native transport: a completed call that is a JSON object goes out as its bytes', async () => {
  const ARGS = '{"id":9007199254740993,"spaced" : [ 1, 2 ]}';
  await withProxy(ARGS, async (url) => {
    const buffered = await post(`${url}/v1/messages`, ANTHROPIC, MESSAGES);
    const text = buffered.text;
    assert.equal(buffered.status, 200, text);
    assert.ok(text.includes(`"input":${ARGS}`), text);
    const streamed = await post(`${url}/v1/messages`, ANTHROPIC, { ...MESSAGES, stream: true });
    const frames = events(streamed.text);
    const partial = frames.filter((frame) => frame.type === 'content_block_delta' && frame.delta?.type === 'input_json_delta').map((frame) => frame.delta.partial_json).join('');
    assert.equal(partial, ARGS);
    assert.ok(frames.some((frame) => frame.type === 'message_stop'));
  });
});

test('chat over the native transport: whitespace-only arguments are the same three bytes on both paths; only the empty string is `{}`', async () => {
  for (const [args, expected] of [['   ', '   '], ['', '{}']]) {
    await withProxy(args, async (url) => {
      const buffered = await post(`${url}/v1/chat/completions`, OPENAI, CHAT);
      assert.equal(buffered.status, 200, buffered.text);
      assert.equal(JSON.parse(buffered.text).choices[0].message.tool_calls[0].function.arguments, expected);
      const streamed = await post(`${url}/v1/chat/completions`, OPENAI, { ...CHAT, stream: true });
      const streamedArguments = events(streamed.text).flatMap((chunk) => chunk.choices?.[0]?.delta?.tool_calls ?? []).map((call) => call.function?.arguments ?? '').join('');
      assert.equal(streamedArguments, expected);
    });
  }
});

test('a delta after the vendor\'s own "finished" signal is folded into neither path (r22-fable F4)', async () => {
  const late = (delta) => [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'probe' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: '{"a":1}' },
    { type: 'response.function_call_arguments.done', output_index: 0, item_id: 'fc_1', arguments: '{"a":1}' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'probe', arguments: '{"a":1}' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [] } },
  ];
  for (const delta of ['  ', ',"b":2}']) {
    await withProxyEvents(late(delta), async (url) => {
      const buffered = await post(`${url}/v1/messages`, ANTHROPIC, MESSAGES);
      assert.equal(buffered.status, 200, buffered.text);
      assert.ok(buffered.text.includes('"input":{"a":1}}'), buffered.text);
      const streamed = await post(`${url}/v1/messages`, ANTHROPIC, { ...MESSAGES, stream: true });
      const frames = events(streamed.text);
      const partial = frames.filter((frame) => frame.type === 'content_block_delta' && frame.delta?.type === 'input_json_delta').map((frame) => frame.delta.partial_json).join('');
      assert.equal(partial, '{"a":1}');
      assert.ok(frames.some((frame) => frame.type === 'message_stop'), JSON.stringify(frames.map((frame) => frame.type)));
      const chat = await post(`${url}/v1/chat/completions`, OPENAI, CHAT);
      assert.equal(JSON.parse(chat.text).choices[0].message.tool_calls[0].function.arguments, '{"a":1}');
    });
  }
});

test('an item closed without its arguments promises nothing: a whole-JSON prefix is not latched as final (r22-codex F3)', async () => {
  // `1` parses, so it used to be announced as the call's final arguments and
  // the completed output's `12` was then refused; both paths reported `1`.
  const vendor = [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'probe' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: '1' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'probe' } },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [{ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'probe', arguments: '12' }] } },
  ];
  await withProxyEvents(vendor, async (url) => {
    const buffered = await post(`${url}/v1/chat/completions`, OPENAI, CHAT);
    assert.equal(buffered.status, 200, buffered.text);
    assert.equal(JSON.parse(buffered.text).choices[0].message.tool_calls[0].function.arguments, '12');
    const streamed = await post(`${url}/v1/chat/completions`, OPENAI, { ...CHAT, stream: true });
    const streamedArguments = events(streamed.text).flatMap((chunk) => chunk.choices?.[0]?.delta?.tool_calls ?? []).map((call) => call.function?.arguments ?? '').join('');
    assert.equal(streamedArguments, '12');
  });
});

test('a completed non-object call inside a cut-off turn goes out as written on both paths; only the call the cut hit is projected (r23-fable F1)', async () => {
  const vendor = [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'probe' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: '[1, 2]' },
    { type: 'response.function_call_arguments.done', output_index: 0, item_id: 'fc_1', arguments: '[1, 2]' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'probe', arguments: '[1, 2]' } },
    { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'probe' } },
    { type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'fc_2', delta: '{"x":' },
    { type: 'response.incomplete', response: { id: 'r', model: 'gpt-5.5', output: [], incomplete_details: { reason: 'max_output_tokens' } } },
  ];
  const TWO = { ...MESSAGES, tool_choice: { type: 'any' } };
  await withProxyEvents(vendor, async (url) => {
    const buffered = await post(`${url}/v1/messages`, ANTHROPIC, TWO);
    assert.equal(buffered.status, 200, buffered.text);
    assert.ok(buffered.text.includes('"input":[1, 2]'), buffered.text);
    assert.ok(buffered.text.includes('"input":{}'), buffered.text);
    assert.equal(JSON.parse(buffered.text).stop_reason, 'max_tokens');
    const streamed = await post(`${url}/v1/messages`, ANTHROPIC, { ...TWO, stream: true });
    const frames = events(streamed.text);
    const blocks = frames.filter((frame) => frame.type === 'content_block_start' && frame.content_block?.type === 'tool_use').map((frame) => frame.index);
    assert.equal(blocks.length, 2);
    const partialOf = (index) => frames.filter((frame) => frame.type === 'content_block_delta' && frame.index === index && frame.delta?.type === 'input_json_delta').map((frame) => frame.delta.partial_json).join('');
    assert.equal(partialOf(blocks[0]), '[1, 2]');
    assert.equal(partialOf(blocks[1]), '{"x":');
    assert.ok(frames.some((frame) => frame.type === 'content_block_stop' && frame.index === blocks[0]), 'the completed call closes');
    assert.ok(!frames.some((frame) => frame.type === 'content_block_stop' && frame.index === blocks[1]), 'the cut call stays open');
    const chat = await post(`${url}/v1/chat/completions`, OPENAI, { ...CHAT, tool_choice: 'auto' });
    const calls = JSON.parse(chat.text).choices[0].message.tool_calls.map((call) => call.function.arguments);
    assert.deepEqual(calls, ['[1, 2]', '{"x":']);
    assert.equal(JSON.parse(chat.text).choices[0].finish_reason, 'length');
  });
});

test('function_call_arguments.done is the finish signal: a delta after it is folded into neither path, whatever output_item.done carries (r23-codex)', async () => {
  const vendor = [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'probe' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: '{"a":1}' },
    { type: 'response.function_call_arguments.done', output_index: 0, item_id: 'fc_1', arguments: '{"a":1}' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'probe' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: ',"b":2}' },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [{ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'probe', arguments: '{"a":1}' }] } },
  ];
  await withProxyEvents(vendor, async (url) => {
    const chat = await post(`${url}/v1/chat/completions`, OPENAI, CHAT);
    assert.equal(JSON.parse(chat.text).choices[0].message.tool_calls[0].function.arguments, '{"a":1}');
    const chatStream = await post(`${url}/v1/chat/completions`, OPENAI, { ...CHAT, stream: true });
    assert.equal(events(chatStream.text).flatMap((chunk) => chunk.choices?.[0]?.delta?.tool_calls ?? []).map((call) => call.function?.arguments ?? '').join(''), '{"a":1}');
    const messages = await post(`${url}/v1/messages`, ANTHROPIC, MESSAGES);
    assert.equal(messages.status, 200, messages.text);
    assert.ok(messages.text.includes('"input":{"a":1}}'), messages.text);
    const messagesStream = await post(`${url}/v1/messages`, ANTHROPIC, { ...MESSAGES, stream: true });
    const frames = events(messagesStream.text);
    assert.equal(frames.filter((frame) => frame.type === 'content_block_delta' && frame.delta?.type === 'input_json_delta').map((frame) => frame.delta.partial_json).join(''), '{"a":1}');
    assert.ok(frames.some((frame) => frame.type === 'message_stop'));
  });
});

test('the terminal frame settles the turn: a delta after response.completed changes nothing on any path (r23-codex)', async () => {
  const vendor = [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'probe' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: '{"a":' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'probe' } },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [{ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'probe', arguments: '{"a":1}' }] } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: ',"b":2}' },
    { type: 'response.output_text.delta', delta: 'late narration' },
  ];
  await withProxyEvents(vendor, async (url) => {
    const chat = await post(`${url}/v1/chat/completions`, OPENAI, CHAT);
    const message = JSON.parse(chat.text).choices[0].message;
    assert.equal(message.tool_calls[0].function.arguments, '{"a":1}');
    assert.ok(!chat.text.includes('late narration'), chat.text);
    const chatStream = await post(`${url}/v1/chat/completions`, OPENAI, { ...CHAT, stream: true });
    assert.equal(events(chatStream.text).flatMap((chunk) => chunk.choices?.[0]?.delta?.tool_calls ?? []).map((call) => call.function?.arguments ?? '').join(''), '{"a":1}');
    const messages = await post(`${url}/v1/messages`, ANTHROPIC, MESSAGES);
    assert.equal(messages.status, 200, messages.text);
    assert.ok(messages.text.includes('"input":{"a":1}}'), messages.text);
    const frames = events((await post(`${url}/v1/messages`, ANTHROPIC, { ...MESSAGES, stream: true })).text);
    assert.equal(frames.filter((frame) => frame.type === 'content_block_delta' && frame.delta?.type === 'input_json_delta').map((frame) => frame.delta.partial_json).join(''), '{"a":1}');
    assert.ok(frames.some((frame) => frame.type === 'message_stop'));
  });
});

test('an identity the stream announced is kept by the body: the completed output cannot rename call_1/probe (r23-codex)', async () => {
  const vendor = [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'probe' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: '{}' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'probe', arguments: '{}' } },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [{ type: 'function_call', id: 'fc_1', call_id: 'call_2', name: 'other', arguments: '{}' }] } },
  ];
  const TWO = { ...CHAT, tools: [...CHAT.tools, { type: 'function', function: { name: 'other', parameters: { type: 'object' } } }] };
  const TWO_MESSAGES = { ...MESSAGES, tools: [...MESSAGES.tools, { name: 'other', input_schema: { type: 'object' } }], tool_choice: { type: 'any' } };
  await withProxyEvents(vendor, async (url) => {
    const chat = JSON.parse((await post(`${url}/v1/chat/completions`, OPENAI, TWO)).text).choices[0].message.tool_calls[0];
    assert.equal(chat.id, 'call_1');
    assert.equal(chat.function.name, 'probe');
    const chatStream = events((await post(`${url}/v1/chat/completions`, OPENAI, { ...TWO, stream: true })).text);
    const announced = chatStream.flatMap((chunk) => chunk.choices?.[0]?.delta?.tool_calls ?? []).find((call) => call.id);
    assert.equal(announced.id, 'call_1');
    assert.equal(announced.function.name, 'probe');
    const messages = await post(`${url}/v1/messages`, ANTHROPIC, TWO_MESSAGES);
    assert.equal(messages.status, 200, messages.text);
    const block = JSON.parse(messages.text).content.find((item) => item.type === 'tool_use');
    assert.equal(block.id, 'call_1');
    assert.equal(block.name, 'probe');
  });
});

test('an announced identity is frozen at every door: output_item.done and a repeated output_item.added cannot rename call_1/probe either (r25-fable)', async () => {
  const renameBy = (frame) => [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'probe' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: '{}' },
    frame,
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_2', name: 'other', arguments: '{}' } },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [{ type: 'function_call', id: 'fc_1', call_id: 'call_2', name: 'other', arguments: '{}' }] } },
  ];
  const TWO = { ...CHAT, tools: [...CHAT.tools, { type: 'function', function: { name: 'other', parameters: { type: 'object' } } }] };
  const TWO_MESSAGES = { ...MESSAGES, tools: [...MESSAGES.tools, { name: 'other', input_schema: { type: 'object' } }], tool_choice: { type: 'any' } };
  const repeatedAdded = { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_2', name: 'other' } };
  const doneOnly = { type: 'response.function_call_arguments.done', output_index: 0, item_id: 'fc_1', arguments: '{}' };
  for (const frame of [repeatedAdded, doneOnly]) {
    await withProxyEvents(renameBy(frame), async (url) => {
      const chat = JSON.parse((await post(`${url}/v1/chat/completions`, OPENAI, TWO)).text).choices[0].message.tool_calls[0];
      assert.equal(chat.id, 'call_1');
      assert.equal(chat.function.name, 'probe');
      const announced = events((await post(`${url}/v1/chat/completions`, OPENAI, { ...TWO, stream: true })).text).flatMap((chunk) => chunk.choices?.[0]?.delta?.tool_calls ?? []).filter((call) => call.id);
      assert.deepEqual(announced.map((call) => [call.id, call.function.name]), [['call_1', 'probe']]);
      const messages = await post(`${url}/v1/messages`, ANTHROPIC, TWO_MESSAGES);
      assert.equal(messages.status, 200, messages.text);
      const blocks = JSON.parse(messages.text).content.filter((item) => item.type === 'tool_use');
      assert.deepEqual(blocks.map((block) => [block.id, block.name]), [['call_1', 'probe']]);
    });
  }
});

test('anonymous argument deltas belong to the call that names their position: the completed output does not leave a second call named tool (r25-codex)', async () => {
  const vendor = [
    { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{}' },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [{ type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'other', arguments: '{}' }] } },
  ];
  const TWO = { ...CHAT, tools: [...CHAT.tools, { type: 'function', function: { name: 'other', parameters: { type: 'object' } } }] };
  const TWO_MESSAGES = { ...MESSAGES, tools: [...MESSAGES.tools, { name: 'other', input_schema: { type: 'object' } }], tool_choice: { type: 'any' } };
  await withProxyEvents(vendor, async (url) => {
    const chat = JSON.parse((await post(`${url}/v1/chat/completions`, OPENAI, TWO)).text).choices[0].message.tool_calls;
    assert.deepEqual(chat.map((call) => [call.id, call.function.name, call.function.arguments]), [['call_2', 'other', '{}']]);
    const announced = events((await post(`${url}/v1/chat/completions`, OPENAI, { ...TWO, stream: true })).text).flatMap((chunk) => chunk.choices?.[0]?.delta?.tool_calls ?? []).filter((call) => call.id);
    assert.deepEqual(announced.map((call) => [call.id, call.function.name]), [['call_2', 'other']]);
    const messages = await post(`${url}/v1/messages`, ANTHROPIC, TWO_MESSAGES);
    assert.equal(messages.status, 200, messages.text);
    assert.deepEqual(JSON.parse(messages.text).content.filter((item) => item.type === 'tool_use').map((block) => [block.id, block.name]), [['call_2', 'other']]);
  });
});

test('the terminal frame ends the read: a transport failure after response.completed does not overturn the completed answer (r25-codex)', async () => {
  const encoder = new TextEncoder();
  const body = () => new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(sse([
        { type: 'response.output_text.delta', delta: 'complete answer' },
        { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [] } },
      ])));
      setTimeout(() => { try { controller.error(new Error('post-terminal transport failure')); } catch {} }, 20);
    },
  });
  const TEXT = { model: 'm', messages: [{ role: 'user', content: 'w' }] };
  await withProxyResponse(() => new Response(body(), { status: 200 }), async (url) => {
    const buffered = await post(`${url}/v1/chat/completions`, OPENAI, TEXT);
    assert.equal(buffered.status, 200, buffered.text);
    const choice = JSON.parse(buffered.text).choices[0];
    assert.equal(choice.message.content, 'complete answer');
    assert.equal(choice.finish_reason, 'stop');
    const streamed = await post(`${url}/v1/chat/completions`, OPENAI, { ...TEXT, stream: true });
    const chunks = events(streamed.text);
    assert.equal(chunks.map((chunk) => chunk.choices?.[0]?.delta?.content ?? '').join(''), 'complete answer');
    assert.ok(chunks.some((chunk) => chunk.choices?.[0]?.finish_reason === 'stop'), streamed.text);
    assert.ok(!chunks.some((chunk) => chunk.error), streamed.text);
    const messages = await post(`${url}/v1/messages`, ANTHROPIC, { model: 'm', max_tokens: 64, messages: [{ role: 'user', content: 'w' }] });
    assert.equal(messages.status, 200, messages.text);
    assert.equal(JSON.parse(messages.text).stop_reason, 'end_turn');
  });
});

test('a call is announced on a call_id AND a name: one named only by the completed output is reported as probe on every path, never as tool (r25-codex)', async () => {
  const vendor = [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: '{}' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', arguments: '{}' } },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [{ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'probe', arguments: '{}' }] } },
  ];
  await withProxyEvents(vendor, async (url) => {
    const chat = await post(`${url}/v1/chat/completions`, OPENAI, CHAT);
    assert.equal(chat.status, 200, chat.text);
    assert.deepEqual(JSON.parse(chat.text).choices[0].message.tool_calls.map((call) => [call.id, call.function.name]), [['call_1', 'probe']]);
    const announced = events((await post(`${url}/v1/chat/completions`, OPENAI, { ...CHAT, stream: true })).text).flatMap((chunk) => chunk.choices?.[0]?.delta?.tool_calls ?? []).filter((call) => call.id);
    assert.deepEqual(announced.map((call) => [call.id, call.function.name]), [['call_1', 'probe']]);
    const messages = await post(`${url}/v1/messages`, ANTHROPIC, MESSAGES);
    assert.equal(messages.status, 200, messages.text);
    const frames = events((await post(`${url}/v1/messages`, ANTHROPIC, { ...MESSAGES, stream: true })).text);
    const starts = frames.filter((frame) => frame.type === 'content_block_start' && frame.content_block?.type === 'tool_use').map((frame) => [frame.content_block.id, frame.content_block.name]);
    assert.deepEqual(starts, [['call_1', 'probe']]);
  });
});

test('the finish signal waits for the terminal frame: a call the vendor finished inside a cut-off turn keeps its bytes and its open block (r24-codex F4)', async () => {
  const cutAfterDone = (value) => [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'probe' } },
    ...(value === '' ? [] : [{ type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: value }]),
    { type: 'response.function_call_arguments.done', output_index: 0, item_id: 'fc_1', arguments: value },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'probe' } },
    { type: 'response.incomplete', response: { id: 'r', model: 'gpt-5.5', output: [], incomplete_details: { reason: 'max_output_tokens' } } },
  ];
  for (const value of ['', '[1, 2]']) {
    await withProxyEvents(cutAfterDone(value), async (url) => {
      const chat = await post(`${url}/v1/chat/completions`, OPENAI, CHAT);
      const choice = JSON.parse(chat.text).choices[0];
      assert.equal(choice.message.tool_calls[0].function.arguments, value, 'the bytes the vendor wrote, empty included');
      assert.equal(choice.finish_reason, 'length');
      const chatStream = events((await post(`${url}/v1/chat/completions`, OPENAI, { ...CHAT, stream: true })).text);
      assert.equal(chatStream.flatMap((chunk) => chunk.choices?.[0]?.delta?.tool_calls ?? []).map((call) => call.function?.arguments ?? '').join(''), value);
      const messages = await post(`${url}/v1/messages`, ANTHROPIC, MESSAGES);
      assert.equal(messages.status, 200, messages.text);
      assert.ok(messages.text.includes('"input":{}'), messages.text);
      assert.equal(JSON.parse(messages.text).stop_reason, 'max_tokens');
      const frames = events((await post(`${url}/v1/messages`, ANTHROPIC, { ...MESSAGES, stream: true })).text);
      const block = frames.find((frame) => frame.type === 'content_block_start' && frame.content_block?.type === 'tool_use');
      assert.equal(frames.filter((frame) => frame.type === 'content_block_delta' && frame.delta?.type === 'input_json_delta').map((frame) => frame.delta.partial_json).join(''), value, 'no invented `{}` on the stream');
      assert.ok(!frames.some((frame) => frame.type === 'content_block_stop' && frame.index === block.index), 'the cut call\'s block stays open');
      assert.equal(frames.find((frame) => frame.type === 'message_delta')?.delta?.stop_reason, 'max_tokens');
    });
  }
});

test('one coordinate system: a call identified late keeps the block the stream opened for it — the cut call\'s block stays open and Chat indices follow the body (r26-fable F2)', async () => {
  const vendor = [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_a', name: 'alpha' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_a', delta: '{"x":' },
    { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc_b', call_id: 'call_b', name: 'beta' } },
    { type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'fc_b', delta: '{"b":2}' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'alpha' } },
    { type: 'response.incomplete', response: { id: 'r', model: 'gpt-5.5', output: [{ type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'alpha', arguments: '{"x":' }, { type: 'function_call', id: 'fc_b', call_id: 'call_b', name: 'beta', arguments: '{"b":2}' }], incomplete_details: { reason: 'max_output_tokens' } } },
  ];
  const TOOLS = [{ type: 'function', function: { name: 'alpha', parameters: { type: 'object' } } }, { type: 'function', function: { name: 'beta', parameters: { type: 'object' } } }];
  const CHAT2 = { ...CHAT, tools: TOOLS, tool_choice: 'auto' };
  const MESSAGES2 = { ...MESSAGES, tools: [{ name: 'alpha', input_schema: { type: 'object' } }, { name: 'beta', input_schema: { type: 'object' } }], tool_choice: { type: 'any' } };
  await withProxyEvents(vendor, async (url) => {
    const body = JSON.parse((await post(`${url}/v1/chat/completions`, OPENAI, CHAT2)).text).choices[0].message.tool_calls.map((call) => [call.id, call.function.arguments]);
    assert.deepEqual(body, [['call_b', '{"b":2}'], ['call_a', '{"x":']], 'announcement order');
    const chunks = events((await post(`${url}/v1/chat/completions`, OPENAI, { ...CHAT2, stream: true })).text);
    const byIndex = new Map();
    for (const call of chunks.flatMap((chunk) => chunk.choices?.[0]?.delta?.tool_calls ?? [])) {
      const entry = byIndex.get(call.index) ?? { id: undefined, args: '' };
      if (call.id) entry.id = call.id;
      entry.args += call.function?.arguments ?? '';
      byIndex.set(call.index, entry);
    }
    assert.deepEqual([...byIndex.entries()].sort(([a], [b]) => a - b).map(([index, entry]) => [index, entry.id, entry.args]), [[0, 'call_b', '{"b":2}'], [1, 'call_a', '{"x":']]);
    const messages = await post(`${url}/v1/messages`, ANTHROPIC, MESSAGES2);
    assert.equal(messages.status, 200, messages.text);
    assert.deepEqual(JSON.parse(messages.text).content.filter((item) => item.type === 'tool_use').map((block) => [block.id, JSON.stringify(block.input)]), [['call_b', '{"b":2}'], ['call_a', '{}']]);
    const frames = events((await post(`${url}/v1/messages`, ANTHROPIC, { ...MESSAGES2, stream: true })).text);
    const starts = frames.filter((frame) => frame.type === 'content_block_start' && frame.content_block?.type === 'tool_use').map((frame) => [frame.index, frame.content_block.id]);
    assert.deepEqual(starts.map(([, id]) => id), ['call_b', 'call_a']);
    const cutIndex = starts[1][0];
    assert.equal(frames.filter((frame) => frame.type === 'content_block_delta' && frame.index === cutIndex).map((frame) => frame.delta.partial_json).join(''), '{"x":');
    assert.ok(!frames.some((frame) => frame.type === 'content_block_stop' && frame.index === cutIndex), 'the cut call\'s block stays open');
    assert.ok(frames.some((frame) => frame.type === 'content_block_stop' && frame.index === starts[0][0]), 'the completed call\'s block closes');
  });
});

test('a completed item whose id and call_id name two different announced calls is left alone: the streamed pairing wins on both paths (r26-codex F2)', async () => {
  const vendor = [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'probe' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: '{"target":"one"}' },
    { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'other' } },
    { type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'fc_2', delta: '{"target":"two"}' },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [
      { type: 'function_call', id: 'fc_2', call_id: 'call_1', name: 'probe', arguments: '{"target":"one"}' },
      { type: 'function_call', id: 'fc_1', call_id: 'call_2', name: 'other', arguments: '{"target":"two"}' },
    ] } },
  ];
  const TWO = { ...CHAT, tools: [...CHAT.tools, { type: 'function', function: { name: 'other', parameters: { type: 'object' } } }], tool_choice: 'auto' };
  const TWO_MESSAGES = { ...MESSAGES, tools: [...MESSAGES.tools, { name: 'other', input_schema: { type: 'object' } }], tool_choice: { type: 'any' } };
  await withProxyEvents(vendor, async (url) => {
    const body = JSON.parse((await post(`${url}/v1/chat/completions`, OPENAI, TWO)).text).choices[0].message.tool_calls.map((call) => [call.id, call.function.name, call.function.arguments]);
    assert.deepEqual(body, [['call_1', 'probe', '{"target":"one"}'], ['call_2', 'other', '{"target":"two"}']]);
    const byId = new Map();
    for (const call of events((await post(`${url}/v1/chat/completions`, OPENAI, { ...TWO, stream: true })).text).flatMap((chunk) => chunk.choices?.[0]?.delta?.tool_calls ?? [])) {
      const key = call.index; const entry = byId.get(key) ?? { id: undefined, args: '' };
      if (call.id) entry.id = call.id; entry.args += call.function?.arguments ?? ''; byId.set(key, entry);
    }
    assert.deepEqual([...byId.values()].map((entry) => [entry.id, entry.args]), [['call_1', '{"target":"one"}'], ['call_2', '{"target":"two"}']]);
    const messages = await post(`${url}/v1/messages`, ANTHROPIC, TWO_MESSAGES);
    assert.equal(messages.status, 200, messages.text);
    assert.deepEqual(JSON.parse(messages.text).content.filter((item) => item.type === 'tool_use').map((block) => [block.id, block.name, JSON.stringify(block.input)]), [['call_1', 'probe', '{"target":"one"}'], ['call_2', 'other', '{"target":"two"}']]);
  });
});

test('an identifier introduced later at the same explicit output_index is the same call: one call, announced once (r24-codex F5/F6)', async () => {
  const callIdFirst = [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'call_1', name: 'probe' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: '{"a":1}' },
    { type: 'response.function_call_arguments.done', output_index: 0, item_id: 'fc_1', arguments: '{"a":1}' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'probe', arguments: '{"a":1}' } },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [{ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'probe', arguments: '{"a":1}' }] } },
  ];
  const doneFirst = [
    { type: 'response.function_call_arguments.done', output_index: 0, item_id: 'fc_1', arguments: '{"a":1}' },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'call_1', name: 'probe' } },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'probe', arguments: '{"a":1}' } },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [{ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'probe', arguments: '{"a":1}' }] } },
  ];
  for (const vendor of [callIdFirst, doneFirst]) {
    await withProxyEvents(vendor, async (url) => {
      const body = JSON.parse((await post(`${url}/v1/chat/completions`, OPENAI, CHAT)).text).choices[0].message.tool_calls.map((call) => [call.id, call.function.arguments]);
      assert.deepEqual(body, [['call_1', '{"a":1}']]);
      const chunks = events((await post(`${url}/v1/chat/completions`, OPENAI, { ...CHAT, stream: true })).text).flatMap((chunk) => chunk.choices?.[0]?.delta?.tool_calls ?? []);
      assert.deepEqual([...new Set(chunks.map((call) => call.index))], [0], 'one wire index');
      assert.deepEqual(chunks.filter((call) => call.id).map((call) => call.id), ['call_1'], 'announced once');
      assert.equal(chunks.map((call) => call.function?.arguments ?? '').join(''), '{"a":1}');
      const messages = await post(`${url}/v1/messages`, ANTHROPIC, MESSAGES);
      assert.equal(messages.status, 200, messages.text);
      assert.deepEqual(JSON.parse(messages.text).content.filter((item) => item.type === 'tool_use').map((block) => [block.id, JSON.stringify(block.input)]), [['call_1', '{"a":1}']]);
      const frames = events((await post(`${url}/v1/messages`, ANTHROPIC, { ...MESSAGES, stream: true })).text);
      assert.equal(frames.filter((frame) => frame.type === 'content_block_start' && frame.content_block?.type === 'tool_use').length, 1);
    });
  }
});

test('a call the vendor never names is refused as a call the request never declared, on both paths (r27-fable F1)', async () => {
  const vendor = [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: '{"a":1}' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', arguments: '{"a":1}' } },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [{ type: 'function_call', id: 'fc_1', call_id: 'call_1', arguments: '{"a":1}' }] } },
  ];
  await withProxyEvents(vendor, async (url) => {
    const chat = await post(`${url}/v1/chat/completions`, OPENAI, CHAT);
    assert.equal(chat.status, 502, chat.text);
    assert.match(JSON.parse(chat.text).error.message, /called a tool the request never declared/);
    assert.ok(!chat.text.includes('"tool"'), chat.text);
    // Nothing was announced (no name, no identity), so the stream is still
    // uncommitted when the completion refuses: a clean 502, not an in-band error.
    const chatStream = await post(`${url}/v1/chat/completions`, OPENAI, { ...CHAT, stream: true });
    assert.equal(chatStream.status, 502, chatStream.text);
    assert.ok(!chatStream.text.includes('"name":"tool"'), 'never announced as tool');
    const messages = await post(`${url}/v1/messages`, ANTHROPIC, MESSAGES);
    assert.equal(messages.status, 502, messages.text);
    const messagesStream = await post(`${url}/v1/messages`, ANTHROPIC, { ...MESSAGES, stream: true });
    assert.equal(messagesStream.status, 502, messagesStream.text);
    assert.ok(!messagesStream.text.includes('"name":"tool"'));
  });
});

test('a fragment finish event is completed by an output that extends it — the signal had not gone out (r27-fable F2)', async () => {
  const vendor = [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'probe' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: '{"city":' },
    { type: 'response.function_call_arguments.done', output_index: 0, item_id: 'fc_1', arguments: '{"city":' },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [{ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'probe', arguments: '{"city":"Seoul"}' }] } },
  ];
  await withProxyEvents(vendor, async (url) => {
    const chat = await post(`${url}/v1/chat/completions`, OPENAI, CHAT);
    assert.equal(chat.status, 200, chat.text);
    assert.equal(JSON.parse(chat.text).choices[0].message.tool_calls[0].function.arguments, '{"city":"Seoul"}');
    const chatStream = events((await post(`${url}/v1/chat/completions`, OPENAI, { ...CHAT, stream: true })).text);
    assert.equal(chatStream.flatMap((chunk) => chunk.choices?.[0]?.delta?.tool_calls ?? []).map((call) => call.function?.arguments ?? '').join(''), '{"city":"Seoul"}');
    const messages = await post(`${url}/v1/messages`, ANTHROPIC, MESSAGES);
    assert.equal(messages.status, 200, messages.text);
    assert.ok(messages.text.includes('"input":{"city":"Seoul"}'), messages.text);
    const frames = events((await post(`${url}/v1/messages`, ANTHROPIC, { ...MESSAGES, stream: true })).text);
    assert.equal(frames.filter((frame) => frame.type === 'content_block_delta' && frame.delta?.type === 'input_json_delta').map((frame) => frame.delta.partial_json).join(''), '{"city":"Seoul"}');
    assert.ok(frames.some((frame) => frame.type === 'content_block_stop'));
    assert.ok(frames.some((frame) => frame.type === 'message_stop'));
  });
});

test('the Messages stream stays live after a finished call: narration goes out before the terminal frame (r27-fable F3)', async () => {
  // The vendor writes the call, its finish event, and narration, then waits
  // for the client to have RECEIVED the narration before sending the terminal
  // frame. A writer that held the narration behind the open block would wait
  // forever here — the handshake, not a timer, is the instrument.
  const encoder = new TextEncoder();
  let release; const released = new Promise((resolve) => { release = resolve; });
  const body = () => new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode(sse([
        { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'probe' } },
        { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: '{"a":1}' },
        { type: 'response.function_call_arguments.done', output_index: 0, item_id: 'fc_1', arguments: '{"a":1}' },
        { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'probe', arguments: '{"a":1}' } },
        { type: 'response.output_text.delta', output_index: 1, delta: 'NARRATION-AFTER-CALL' },
      ])));
      await released;
      controller.enqueue(encoder.encode(sse([{ type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [] } }])));
      controller.close();
    },
  });
  await withProxyResponse(() => new Response(body(), { status: 200 }), async (url) => {
    const target = new URL(`${url}/v1/messages`);
    const text = await new Promise((resolvePromise, reject) => {
      // On failure, let the vendor finish and drop the request so nothing
      // hangs the run (a mutant that withholds the narration must fail fast).
      const timer = setTimeout(() => { release(); req.destroy(); reject(new Error('the narration never arrived before the terminal frame')); }, 5_000);
      const req = request({ host: target.hostname, port: target.port, path: target.pathname, method: 'POST', headers: ANTHROPIC }, (res) => {
        let buffer = '';
        res.on('data', (chunk) => {
          buffer += chunk;
          if (buffer.includes('NARRATION-AFTER-CALL')) release();
        });
        res.on('end', () => { clearTimeout(timer); resolvePromise(buffer); });
      });
      req.on('error', reject);
      req.end(JSON.stringify({ ...MESSAGES, tool_choice: { type: 'auto' }, stream: true }));
    });
    const frames = events(text);
    const types = frames.map((frame) => frame.type);
    const stopIndex = types.indexOf('content_block_stop');
    const narrationIndex = frames.findIndex((frame) => frame.delta?.text === 'NARRATION-AFTER-CALL');
    assert.ok(stopIndex !== -1 && narrationIndex > stopIndex, JSON.stringify(types));
    assert.ok(types.includes('message_stop'));
  });
});

test('reversed arrival: an anonymous delta at output_index 1 is adopted by the completed item at that position — two calls, not three (r27-codex)', async () => {
  const vendor = [
    { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"a":1}' },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_b', call_id: 'call_b', name: 'beta' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_b', delta: '{"b":2}' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_b', call_id: 'call_b', name: 'beta', arguments: '{"b":2}' } },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [
      { type: 'function_call', id: 'fc_b', call_id: 'call_b', name: 'beta', arguments: '{"b":2}' },
      { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'alpha', arguments: '{"a":1}' },
    ] } },
  ];
  const TOOLS = ['alpha', 'beta'].map((name) => ({ type: 'function', function: { name, parameters: { type: 'object' } } }));
  const CHAT2 = { ...CHAT, tools: TOOLS, tool_choice: 'auto' };
  const MESSAGES2 = { ...MESSAGES, tools: ['alpha', 'beta'].map((name) => ({ name, input_schema: { type: 'object' } })), tool_choice: { type: 'any' } };
  await withProxyEvents(vendor, async (url) => {
    const body = JSON.parse((await post(`${url}/v1/chat/completions`, OPENAI, CHAT2)).text).choices[0].message.tool_calls.map((call) => [call.id, call.function.name, call.function.arguments]);
    assert.deepEqual(body, [['call_b', 'beta', '{"b":2}'], ['call_a', 'alpha', '{"a":1}']]);
    const announced = events((await post(`${url}/v1/chat/completions`, OPENAI, { ...CHAT2, stream: true })).text).flatMap((chunk) => chunk.choices?.[0]?.delta?.tool_calls ?? []).filter((call) => call.id).map((call) => call.function.name);
    assert.deepEqual(announced, ['beta', 'alpha']);
    const messages = await post(`${url}/v1/messages`, ANTHROPIC, MESSAGES2);
    assert.equal(messages.status, 200, messages.text);
    assert.deepEqual(JSON.parse(messages.text).content.filter((item) => item.type === 'tool_use').map((block) => block.name), ['beta', 'alpha']);
  });
});

test('an identity whose id and name arrive on different frames is announced where the backend finished the call — before the narration that followed (r27-codex)', async () => {
  const vendor = [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_a', call_id: 'call_a' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_a', delta: '{"a":1}' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_a', name: 'alpha', arguments: '{"a":1}' } },
    { type: 'response.output_text.delta', output_index: 1, delta: 'after' },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [{ type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'alpha', arguments: '{"a":1}' }] } },
  ];
  const MESSAGES2 = { ...MESSAGES, tools: [{ name: 'alpha', input_schema: { type: 'object' } }], tool_choice: { type: 'auto' } };
  await withProxyEvents(vendor, async (url) => {
    const messages = await post(`${url}/v1/messages`, ANTHROPIC, MESSAGES2);
    assert.equal(messages.status, 200, messages.text);
    assert.deepEqual(JSON.parse(messages.text).content.map((item) => item.type), ['tool_use', 'text']);
    const frames = events((await post(`${url}/v1/messages`, ANTHROPIC, { ...MESSAGES2, stream: true })).text);
    assert.deepEqual(frames.filter((frame) => frame.type === 'content_block_start').map((frame) => frame.content_block.type), ['tool_use', 'text']);
    assert.equal(frames.find((frame) => frame.type === 'content_block_start').content_block.name, 'alpha');
  });
});

test('a rejected cancel of the unread body after the terminal frame does not overturn the completed answer (r27-codex)', async () => {
  const encoder = new TextEncoder();
  let cancels = 0;
  const body = () => {
    let pulled = false;
    return new ReadableStream({
      pull(controller) {
        // After the terminal frame the body never closes on its own, so
        // ending the read is the only way out — and cancel() rejects.
        if (pulled) return new Promise(() => {});
        pulled = true;
        controller.enqueue(encoder.encode(sse([
          { type: 'response.output_text.delta', delta: 'complete answer' },
          { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [], usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 } } },
        ])));
      },
      cancel() { cancels += 1; throw new Error('fixture cancel failed after terminal'); },
    });
  };
  const TEXT = { model: 'm', messages: [{ role: 'user', content: 'w' }] };
  await withProxyResponse(() => new Response(body(), { status: 200 }), async (url) => {
    const buffered = await post(`${url}/v1/chat/completions`, OPENAI, TEXT);
    assert.equal(buffered.status, 200, buffered.text);
    const parsed = JSON.parse(buffered.text);
    assert.equal(parsed.choices[0].message.content, 'complete answer');
    assert.equal(parsed.usage.prompt_tokens, 11);
    const streamed = await post(`${url}/v1/chat/completions`, OPENAI, { ...TEXT, stream: true });
    const chunks = events(streamed.text);
    assert.ok(chunks.some((chunk) => chunk.choices?.[0]?.finish_reason === 'stop'), streamed.text);
    assert.ok(!chunks.some((chunk) => chunk.error), streamed.text);
    const messages = await post(`${url}/v1/messages`, ANTHROPIC, { model: 'm', max_tokens: 64, messages: [{ role: 'user', content: 'w' }] });
    assert.equal(messages.status, 200, messages.text);
    const frames = events((await post(`${url}/v1/messages`, ANTHROPIC, { model: 'm', max_tokens: 64, messages: [{ role: 'user', content: 'w' }], stream: true })).text);
    assert.ok(frames.some((frame) => frame.type === 'message_stop'), JSON.stringify(frames.map((frame) => frame.type)));
  });
  assert.ok(cancels >= 1, 'the unread body was released');
});
