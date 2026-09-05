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

test('a call the vendor never names is refused on both paths — even when the client declares a tool named `tool` (r27-fable F1, r27-codex)', async () => {
  const vendor = [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: '{"a":1}' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', arguments: '{"a":1}' } },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [{ type: 'function_call', id: 'fc_1', call_id: 'call_1', arguments: '{"a":1}' }] } },
  ];
  // A declared tool literally named `tool` is what an undeclared-name check
  // alone lets through: the placeholder would pass as that tool's call.
  const DECLARES_TOOL = { ...CHAT, tools: [...CHAT.tools, { type: 'function', function: { name: 'tool', parameters: { type: 'object' } } }] };
  const DECLARES_TOOL_MESSAGES = { ...MESSAGES, tools: [...MESSAGES.tools, { name: 'tool', input_schema: { type: 'object' } }], tool_choice: { type: 'any' } };
  await withProxyEvents(vendor, async (url) => {
    const chat = await post(`${url}/v1/chat/completions`, OPENAI, DECLARES_TOOL);
    assert.equal(chat.status, 502, chat.text);
    assert.match(JSON.parse(chat.text).error.message, /missing its call_id or its name/);
    assert.ok(!chat.text.includes('"tool"'), chat.text);
    // Nothing was announced (no name, no identity), so the stream is still
    // uncommitted when the completion refuses: a clean 502, not an in-band error.
    const chatStream = await post(`${url}/v1/chat/completions`, OPENAI, { ...DECLARES_TOOL, stream: true });
    assert.equal(chatStream.status, 502, chatStream.text);
    assert.ok(!chatStream.text.includes('"name":"tool"'), 'never announced as tool');
    const messages = await post(`${url}/v1/messages`, ANTHROPIC, DECLARES_TOOL_MESSAGES);
    assert.equal(messages.status, 502, messages.text);
    assert.match(JSON.parse(messages.text).error.message, /missing its call_id or its name/);
    const messagesStream = await post(`${url}/v1/messages`, ANTHROPIC, { ...DECLARES_TOOL_MESSAGES, stream: true });
    assert.equal(messagesStream.status, 502, messagesStream.text);
    assert.ok(!messagesStream.text.includes('"name":"tool"'));
  });
});

test('a call the vendor never gives a call_id is refused on both paths: its item id is not the identifier the client echoes (r27-codex)', async () => {
  // Every frame names the call `probe` and carries the item id `fc_a`, none
  // carries a `call_id`. Publishing it under `fc_a` — or a minted `call_1` —
  // hands the client an identifier the backend never issued, which its tool
  // result then answers.
  const vendor = [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'backend_item_a', name: 'probe' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'backend_item_a', delta: '{"a":1}' },
    { type: 'response.function_call_arguments.done', output_index: 0, item_id: 'backend_item_a', arguments: '{"a":1}' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'backend_item_a', name: 'probe', arguments: '{"a":1}' } },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [{ type: 'function_call', id: 'backend_item_a', name: 'probe', arguments: '{"a":1}' }] } },
  ];
  await withProxyEvents(vendor, async (url) => {
    for (const [path, headers, body] of [
      ['/v1/chat/completions', OPENAI, CHAT],
      ['/v1/responses', OPENAI, { model: 'm', input: 'w', tools: [{ type: 'function', name: 'probe', parameters: { type: 'object' } }], tool_choice: 'required' }],
      ['/v1/messages', ANTHROPIC, MESSAGES],
    ]) {
      const buffered = await post(`${url}${path}`, headers, body);
      assert.equal(buffered.status, 502, `${path}: ${buffered.text}`);
      assert.match(JSON.parse(buffered.text).error.message, /missing its call_id or its name/);
      assert.ok(!buffered.text.includes('backend_item_a') && !buffered.text.includes('call_1'), buffered.text);
      // The call was never identified, so nothing was announced: the stream
      // is uncommitted when the completion refuses.
      const streamed = await post(`${url}${path}`, headers, { ...body, stream: true });
      assert.equal(streamed.status, 502, `${path} stream: ${streamed.text}`);
      assert.ok(!streamed.text.includes('backend_item_a') && !streamed.text.includes('call_1'), streamed.text);
    }
  });
});

test('a present arguments member that is not text is refused wherever it arrives: the object the runtime supplied is never published as {} (r27-codex)', async () => {
  const OBJECT = { a: 1 };
  const added = { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'probe' } };
  const doneText = { type: 'response.function_call_arguments.done', output_index: 0, item_id: 'fc_1', arguments: '{"a":1}' };
  const itemDoneText = { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'probe', arguments: '{"a":1}' } };
  const completedText = { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [{ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'probe', arguments: '{"a":1}' }] } };
  const variants = [
    ['on the finish event', [added, { ...doneText, arguments: OBJECT }, itemDoneText, completedText]],
    ['on the closed item', [added, doneText, { ...itemDoneText, item: { ...itemDoneText.item, arguments: OBJECT } }, completedText]],
    ['in the completed output', [added, doneText, itemDoneText, { ...completedText, response: { ...completedText.response, output: [{ ...completedText.response.output[0], arguments: OBJECT }] } }]],
    ['on a delta', [added, { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: OBJECT }, completedText]],
  ];
  const RESPONSES = { model: 'm', input: 'w', tools: [{ type: 'function', name: 'probe', parameters: { type: 'object' } }], tool_choice: 'required' };
  for (const [where, vendor] of variants) {
    await withProxyEvents(vendor, async (url) => {
      for (const [path, headers, body, terminal] of [
        ['/v1/chat/completions', OPENAI, CHAT, '"finish_reason":"tool_calls"'],
        ['/v1/responses', OPENAI, RESPONSES, 'event: response.completed'],
        ['/v1/messages', ANTHROPIC, MESSAGES, 'event: message_stop'],
      ]) {
        const buffered = await post(`${url}${path}`, headers, body);
        assert.equal(buffered.status, 502, `${where}, ${path}: ${buffered.text}`);
        assert.match(JSON.parse(buffered.text).error.message, /tool arguments that are not text/);
        // The call was announced before the bad member arrived, so the stream
        // has committed: the refusal is in-band, and the turn never completes.
        const streamed = await post(`${url}${path}`, headers, { ...body, stream: true });
        assert.match(streamed.text, /tool arguments that are not text/, `${where}, ${path} stream: ${streamed.text}`);
        assert.ok(!streamed.text.includes(terminal), `${where}, ${path} stream completed: ${streamed.text}`);
        // (`content_block_start` carries `"input":{}` by protocol; the bytes go
        // out as `partial_json`.)
        assert.ok(!streamed.text.includes('"arguments":"{}"') && !streamed.text.includes('"partial_json":"{}"'), `${where}, ${path} stream published {}: ${streamed.text}`);
      }
    });
  }
});

test('an argument event that names neither an item nor a position is refused, not spliced into the next call (r27-codex)', async () => {
  // Read as position 0, the first delta was flushed under `alpha` — the
  // stream carried `{"b":2}{"a":1}` behind a body that said `{"a":1}`.
  const vendor = [
    { type: 'response.function_call_arguments.delta', delta: '{"b":2}' },
    { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'probe' } },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_a', delta: '{"a":1}' },
    { type: 'response.output_item.done', item: { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'probe', arguments: '{"a":1}' } },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [
      { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'probe', arguments: '{"a":1}' },
      { type: 'function_call', id: 'fc_b', call_id: 'call_b', name: 'probe', arguments: '{"b":2}' },
    ] } },
  ];
  await withProxyEvents(vendor, async (url) => {
    for (const [path, headers, body] of [
      ['/v1/chat/completions', OPENAI, CHAT],
      ['/v1/responses', OPENAI, { model: 'm', input: 'w', tools: [{ type: 'function', name: 'probe', parameters: { type: 'object' } }], tool_choice: 'required' }],
      ['/v1/messages', ANTHROPIC, MESSAGES],
    ]) {
      const buffered = await post(`${url}${path}`, headers, body);
      assert.equal(buffered.status, 502, `${path}: ${buffered.text}`);
      assert.match(JSON.parse(buffered.text).error.message, /tool event that names no call/);
      // Refused on the first frame, before anything was announced.
      const streamed = await post(`${url}${path}`, headers, { ...body, stream: true });
      assert.equal(streamed.status, 502, `${path} stream: ${streamed.text}`);
      assert.ok(!streamed.text.includes('{"b":2}{"a":1}'), streamed.text);
    }
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

// ---- round 28 ---------------------------------------------------------------

const RESPONSES_PROBE = { model: 'm', input: 'w', tools: [{ type: 'function', name: 'probe', parameters: { type: 'object' } }], tool_choice: 'required' };
const messagesBlocks = (text) => {
  const frames = events(text);
  const starts = frames.filter((frame) => frame.type === 'content_block_start').map((frame) => [frame.index, frame.content_block.type]);
  const stops = frames.filter((frame) => frame.type === 'content_block_stop').map((frame) => frame.index);
  const partial = frames.filter((frame) => frame.type === 'content_block_delta' && frame.delta?.type === 'input_json_delta').map((frame) => frame.delta.partial_json).join('');
  return { frames, starts, stops, partial };
};

test('a fragment finish the vendor moved on from is final on every path: the completed output cannot extend a call whose block the stream has closed (r28: fable F1, codex F1)', async () => {
  const vendor = [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'probe' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: '{"city":' },
    { type: 'response.function_call_arguments.done', output_index: 0, item_id: 'fc_1', arguments: '{"city":' },
    { type: 'response.output_text.delta', output_index: 1, delta: 'after' },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [
      { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'probe', arguments: '{"city":"Seoul"}' },
      { type: 'message', id: 'msg_1', content: [{ type: 'output_text', text: 'after' }] },
    ] } },
  ];
  await withProxyEvents(vendor, async (url) => {
    // Chat and Responses publish the finished bytes — the fragment — on both paths.
    const chat = await post(`${url}/v1/chat/completions`, OPENAI, CHAT);
    assert.equal(chat.status, 200, chat.text);
    assert.equal(JSON.parse(chat.text).choices[0].message.tool_calls[0].function.arguments, '{"city":');
    const chatStream = events((await post(`${url}/v1/chat/completions`, OPENAI, { ...CHAT, stream: true })).text);
    assert.equal(chatStream.flatMap((chunk) => chunk.choices?.[0]?.delta?.tool_calls ?? []).map((call) => call.function?.arguments ?? '').join(''), '{"city":');
    // Messages: `input` must be a JSON object, so the fragment is refused on
    // BOTH paths — the block the narration closed carries the fragment, then
    // the in-band error; never a clean `message_stop` behind a body that
    // silently completed the value.
    const messages = await post(`${url}/v1/messages`, ANTHROPIC, { ...MESSAGES, tool_choice: { type: 'auto' } });
    assert.equal(messages.status, 502, messages.text);
    assert.match(JSON.parse(messages.text).error.message, /arguments that are not JSON/);
    const { frames, stops, partial } = messagesBlocks((await post(`${url}/v1/messages`, ANTHROPIC, { ...MESSAGES, tool_choice: { type: 'auto' }, stream: true })).text);
    assert.equal(partial, '{"city":');
    assert.ok(stops.includes(0), 'the narration closed the block');
    assert.ok(frames.some((frame) => frame.type === 'error'), 'in-band error');
    assert.ok(!frames.some((frame) => frame.type === 'message_stop'), 'no clean end');
  });
});

test('a late frame for an EARLIER item is not the vendor moving on: the cut call\'s block stays open (r28-fable F2)', async () => {
  const vendor = [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'alpha' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_a', delta: '{"a":1}' },
    { type: 'response.function_call_arguments.done', output_index: 0, item_id: 'fc_a', arguments: '{"a":1}' },
    { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc_b', call_id: 'call_b', name: 'beta' } },
    { type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'fc_b', delta: '{"b":' },
    { type: 'response.function_call_arguments.done', output_index: 1, item_id: 'fc_b', arguments: '{"b":' },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_a', delta: ',"x":2' },
    { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', id: 'fc_b', call_id: 'call_b', name: 'beta', arguments: '{"b":' } },
    { type: 'response.incomplete', response: { id: 'r', model: 'gpt-5.5', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [
      { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'alpha', arguments: '{"a":1}' },
      { type: 'function_call', id: 'fc_b', call_id: 'call_b', name: 'beta', arguments: '{"b":' },
    ] } },
  ];
  const TWO = { ...MESSAGES, tools: [{ name: 'alpha', input_schema: { type: 'object' } }, { name: 'beta', input_schema: { type: 'object' } }], tool_choice: { type: 'auto' } };
  await withProxyEvents(vendor, async (url) => {
    const buffered = await post(`${url}/v1/messages`, ANTHROPIC, TWO);
    assert.equal(buffered.status, 200, buffered.text);
    const body = JSON.parse(buffered.text);
    assert.equal(body.stop_reason, 'max_tokens');
    assert.deepEqual(body.content.filter((block) => block.type === 'tool_use').map((block) => [block.name, JSON.stringify(block.input)]), [['alpha', '{"a":1}'], ['beta', '{}']]);
    const streamed = await post(`${url}/v1/messages`, ANTHROPIC, { ...TWO, stream: true });
    const { frames, starts, stops } = messagesBlocks(streamed.text);
    assert.deepEqual(starts, [[0, 'tool_use'], [1, 'tool_use']]);
    assert.deepEqual(stops, [0], 'alpha closed (beta followed it); beta — the cut call — left open');
    assert.ok(!streamed.text.includes(',"x":2'), 'the late delta for the finished call is dropped');
    assert.equal(frames.find((frame) => frame.type === 'message_delta')?.delta?.stop_reason, 'max_tokens');
  });
});

test('a request that permits no call refuses every call: no tools declared, or tool_choice none (r28-codex F4)', async () => {
  const vendor = [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'probe' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: '{"a":1}' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'probe', arguments: '{"a":1}' } },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [{ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'probe', arguments: '{"a":1}' }] } },
  ];
  const cases = [
    ['chat, no tools', '/v1/chat/completions', OPENAI, { model: 'm', messages: [{ role: 'user', content: 'w' }] }, '"finish_reason":"tool_calls"'],
    ['chat, none', '/v1/chat/completions', OPENAI, { ...CHAT, tool_choice: 'none' }, '"finish_reason":"tool_calls"'],
    ['responses, no tools', '/v1/responses', OPENAI, { model: 'm', input: 'w' }, 'event: response.completed'],
    ['responses, none', '/v1/responses', OPENAI, { ...RESPONSES_PROBE, tool_choice: 'none' }, 'event: response.completed'],
    ['messages, no tools', '/v1/messages', ANTHROPIC, { model: 'm', max_tokens: 64, messages: [{ role: 'user', content: 'w' }] }, 'event: message_stop'],
    ['messages, none', '/v1/messages', ANTHROPIC, { ...MESSAGES, tool_choice: { type: 'none' } }, 'event: message_stop'],
  ];
  await withProxyEvents(vendor, async (url) => {
    for (const [label, path, headers, body, terminal] of cases) {
      const buffered = await post(`${url}${path}`, headers, body);
      assert.equal(buffered.status, 502, `${label}: ${buffered.text}`);
      assert.match(JSON.parse(buffered.text).error.message, /called a tool the request never declared/, label);
      // Refused at the FIRST tool event, before the call is announced: no
      // call frame precedes the refusal — a client that dispatches on the
      // block cannot take it back (r29-codex). (A tool-free Chat stream has
      // already committed its role chunk, so the envelope is in-band there.)
      const streamed = await post(`${url}${path}`, headers, { ...body, stream: true });
      assert.match(streamed.text, /called a tool the request never declared/, `${label} stream: ${streamed.text}`);
      assert.ok(!streamed.text.includes(terminal), `${label} stream completed: ${streamed.text}`);
      assert.ok(!/"tool_calls"|"type":"function_call"|"type":"tool_use"/.test(streamed.text), `${label} stream published the call: ${streamed.text}`);
    }
  });
});

test('a call_id supplied only by the completed item binds to the holder at its position: one call, never two (r28-codex F7)', async () => {
  const vendor = [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'backend_item_1', name: 'probe' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'backend_item_1', delta: '{"a":1}' },
    { type: 'response.function_call_arguments.done', output_index: 0, item_id: 'backend_item_1', arguments: '{"a":1}' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'backend_item_1', name: 'probe', arguments: '{"a":1}' } },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [{ type: 'function_call', call_id: 'call_1', name: 'probe', arguments: '{"a":1}' }] } },
  ];
  await withProxyEvents(vendor, async (url) => {
    const chat = await post(`${url}/v1/chat/completions`, OPENAI, CHAT);
    assert.equal(chat.status, 200, chat.text);
    assert.deepEqual(JSON.parse(chat.text).choices[0].message.tool_calls.map((call) => [call.id, call.function.name, call.function.arguments]), [['call_1', 'probe', '{"a":1}']]);
    const chatStream = (await post(`${url}/v1/chat/completions`, OPENAI, { ...CHAT, stream: true })).text;
    const announced = events(chatStream).flatMap((chunk) => chunk.choices?.[0]?.delta?.tool_calls ?? []).filter((call) => call.id).map((call) => call.id);
    assert.deepEqual(announced, ['call_1']);
    const responses = await post(`${url}/v1/responses`, OPENAI, RESPONSES_PROBE);
    assert.equal(responses.status, 200, responses.text);
    assert.deepEqual(JSON.parse(responses.text).output.filter((item) => item.type === 'function_call').map((item) => item.call_id), ['call_1']);
    const responsesStream = (await post(`${url}/v1/responses`, OPENAI, { ...RESPONSES_PROBE, stream: true })).text;
    assert.equal(events(responsesStream).filter((frame) => frame.type === 'response.output_item.done' && frame.item?.type === 'function_call').length, 1, responsesStream);
    const messages = await post(`${url}/v1/messages`, ANTHROPIC, MESSAGES);
    assert.equal(messages.status, 200, messages.text);
    assert.deepEqual(JSON.parse(messages.text).content.filter((block) => block.type === 'tool_use').map((block) => block.id), ['call_1']);
    const { starts } = messagesBlocks((await post(`${url}/v1/messages`, ANTHROPIC, { ...MESSAGES, stream: true })).text);
    assert.deepEqual(starts, [[0, 'tool_use']]);
    for (const text of [chat.text, chatStream, responses.text, responsesStream, messages.text]) assert.ok(!text.includes('backend_item_1'), text);
  });
});

test('declared: a call the vendor names only at completion is reported after the narration that reached the client first, on both paths (r28-codex F5)', async () => {
  // The order the client saw is the order it was told (the rule
  // `tool-stream-surface-parity` states): the stream could not announce a
  // call the vendor had not identified, so the narration went first, and the
  // body says the same. The protocol names a call on its first frame; the
  // shape is unmeasured.
  const vendor = [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: '{"a":1}' },
    { type: 'response.function_call_arguments.done', output_index: 0, item_id: 'fc_1', arguments: '{"a":1}' },
    { type: 'response.output_text.delta', output_index: 1, delta: 'after' },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [
      { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'probe', arguments: '{"a":1}' },
      { type: 'message', id: 'msg_1', content: [{ type: 'output_text', text: 'after' }] },
    ] } },
  ];
  await withProxyEvents(vendor, async (url) => {
    const AUTO = { ...MESSAGES, tool_choice: { type: 'auto' } };
    const buffered = await post(`${url}/v1/messages`, ANTHROPIC, AUTO);
    assert.equal(buffered.status, 200, buffered.text);
    assert.deepEqual(JSON.parse(buffered.text).content.map((block) => block.type), ['text', 'tool_use']);
    const { starts } = messagesBlocks((await post(`${url}/v1/messages`, ANTHROPIC, { ...AUTO, stream: true })).text);
    assert.deepEqual(starts.map(([, type]) => type), ['text', 'tool_use']);
    const responses = await post(`${url}/v1/responses`, OPENAI, { ...RESPONSES_PROBE, tool_choice: 'auto' });
    assert.equal(responses.status, 200, responses.text);
    assert.deepEqual(JSON.parse(responses.text).output.map((item) => item.type), ['message', 'function_call']);
    const streamedTypes = events((await post(`${url}/v1/responses`, OPENAI, { ...RESPONSES_PROBE, tool_choice: 'auto', stream: true })).text)
      .filter((frame) => frame.type === 'response.output_item.added').map((frame) => frame.item.type);
    assert.deepEqual(streamedTypes, ['message', 'function_call']);
  });
});

test('a refusal thrown while the body is still open is the turn\'s outcome: a rejecting cancel of the unread body does not replace it (r29-fable F2)', async () => {
  const encoder = new TextEncoder();
  let cancels = 0;
  const body = () => {
    let pulled = false;
    return new ReadableStream({
      pull(controller) {
        if (pulled) return new Promise(() => {});
        pulled = true;
        controller.enqueue(encoder.encode(sse([
          { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'probe' } },
          // A present `delta` that is not text: refused from inside the pump.
          { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: { a: 1 } },
        ])));
      },
      cancel() { cancels += 1; throw new Error('fixture cancel failed mid-body'); },
    });
  };
  await withProxyResponse(() => new Response(body(), { status: 200 }), async (url) => {
    for (const [path, headers, request] of [['/v1/chat/completions', OPENAI, CHAT], ['/v1/messages', ANTHROPIC, MESSAGES]]) {
      const buffered = await post(`${url}${path}`, headers, request);
      assert.equal(buffered.status, 502, `${path}: ${buffered.text}`);
      assert.match(JSON.parse(buffered.text).error.message, /tool arguments that are not text/);
      assert.ok(!buffered.text.includes('fixture cancel failed'), buffered.text);
      // The call was announced before the bad delta, so the stream has
      // committed: the refusal is in-band, and it is the refusal.
      const streamed = await post(`${url}${path}`, headers, { ...request, stream: true });
      assert.match(streamed.text, /tool arguments that are not text/, `${path} stream: ${streamed.text}`);
      assert.ok(!streamed.text.includes('fixture cancel failed'), streamed.text);
    }
  });
  assert.ok(cancels >= 1, 'the unread body was released');
});

test('an identified event without an output_index claims no position: a later call really at position 0 is its own call, not swallowed (r29-codex)', async () => {
  // alpha's first frame carries no index; its later frames say position 1.
  // beta then arrives at position 0. Reading alpha's index as 0 bound `#0` to
  // alpha, and beta — bound to a state that had already started — vanished
  // from every surface.
  const vendor = [
    { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'alpha' } },
    { type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'fc_a', delta: '{"a":1}' },
    { type: 'response.function_call_arguments.done', output_index: 1, item_id: 'fc_a', arguments: '{"a":1}' },
    { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'alpha', arguments: '{"a":1}' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_b', delta: '{"b":2}' },
    { type: 'response.function_call_arguments.done', output_index: 0, item_id: 'fc_b', arguments: '{"b":2}' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_b', call_id: 'call_b', name: 'beta', arguments: '{"b":2}' } },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [
      { type: 'function_call', id: 'fc_b', call_id: 'call_b', name: 'beta', arguments: '{"b":2}' },
      { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'alpha', arguments: '{"a":1}' },
    ] } },
  ];
  const TWO_CHAT = { ...CHAT, tools: [{ type: 'function', function: { name: 'alpha', parameters: { type: 'object' } } }, { type: 'function', function: { name: 'beta', parameters: { type: 'object' } } }] };
  const TWO_RESPONSES = { model: 'm', input: 'w', tools: [{ type: 'function', name: 'alpha', parameters: { type: 'object' } }, { type: 'function', name: 'beta', parameters: { type: 'object' } }], tool_choice: 'required' };
  const TWO_MESSAGES = { ...MESSAGES, tools: [{ name: 'alpha', input_schema: { type: 'object' } }, { name: 'beta', input_schema: { type: 'object' } }], tool_choice: { type: 'any' } };
  const BOTH = [['call_a', 'alpha', '{"a":1}'], ['call_b', 'beta', '{"b":2}']];
  await withProxyEvents(vendor, async (url) => {
    const chat = await post(`${url}/v1/chat/completions`, OPENAI, TWO_CHAT);
    assert.equal(chat.status, 200, chat.text);
    assert.deepEqual(JSON.parse(chat.text).choices[0].message.tool_calls.map((call) => [call.id, call.function.name, call.function.arguments]), BOTH);
    const chatStream = events((await post(`${url}/v1/chat/completions`, OPENAI, { ...TWO_CHAT, stream: true })).text);
    assert.deepEqual(chatStream.flatMap((chunk) => chunk.choices?.[0]?.delta?.tool_calls ?? []).filter((call) => call.id).map((call) => [call.id, call.function.name]), BOTH.map(([id, name]) => [id, name]));
    const responses = await post(`${url}/v1/responses`, OPENAI, TWO_RESPONSES);
    assert.equal(responses.status, 200, responses.text);
    assert.deepEqual(JSON.parse(responses.text).output.filter((item) => item.type === 'function_call').map((item) => [item.call_id, item.name, item.arguments]), BOTH);
    const responsesStream = events((await post(`${url}/v1/responses`, OPENAI, { ...TWO_RESPONSES, stream: true })).text);
    assert.deepEqual(responsesStream.filter((frame) => frame.type === 'response.output_item.done' && frame.item?.type === 'function_call').map((frame) => [frame.item.call_id, frame.item.name, frame.item.arguments]), BOTH);
    const messages = await post(`${url}/v1/messages`, ANTHROPIC, TWO_MESSAGES);
    assert.equal(messages.status, 200, messages.text);
    assert.deepEqual(JSON.parse(messages.text).content.filter((block) => block.type === 'tool_use').map((block) => [block.id, block.name, JSON.stringify(block.input)]), BOTH);
    const { starts } = messagesBlocks((await post(`${url}/v1/messages`, ANTHROPIC, { ...TWO_MESSAGES, stream: true })).text);
    assert.deepEqual(starts, [[0, 'tool_use'], [1, 'tool_use']]);
  });
});

test('a present identity member that is not text is refused: an object call_id, name or item_id never crosses into a call (r29-codex)', async () => {
  const OBJECT = { backend: 'not-a-string' };
  const added = { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'probe' } };
  const delta = { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: '{"a":1}' };
  const done = { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'probe', arguments: '{"a":1}' } };
  const completed = { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [{ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'probe', arguments: '{"a":1}' }] } };
  const variants = [
    // Nothing is announced before the bad member: a clean 502 on every path.
    ['call_id on every frame', [{ ...added, item: { ...added.item, call_id: OBJECT } }, delta, { ...done, item: { ...done.item, call_id: OBJECT } }, { ...completed, response: { ...completed.response, output: [{ ...completed.response.output[0], call_id: OBJECT }] } }], false],
    ['name on the first frame', [{ ...added, item: { ...added.item, name: OBJECT } }, delta, done, completed], false],
    ['id on the first frame', [{ ...added, item: { ...added.item, id: OBJECT } }, delta, done, completed], false],
    // The call was announced first: the stream has committed, the refusal is in-band.
    ['item_id on a delta', [added, { ...delta, item_id: OBJECT }, done, completed], true],
    ['call_id in the completed output only', [added, delta, done, { ...completed, response: { ...completed.response, output: [{ ...completed.response.output[0], call_id: OBJECT }] } }], true],
  ];
  for (const [where, vendor, committed] of variants) {
    await withProxyEvents(vendor, async (url) => {
      for (const [path, headers, body] of [['/v1/chat/completions', OPENAI, CHAT], ['/v1/responses', OPENAI, RESPONSES_PROBE], ['/v1/messages', ANTHROPIC, MESSAGES]]) {
        const buffered = await post(`${url}${path}`, headers, body);
        assert.equal(buffered.status, 502, `${where}, ${path}: ${buffered.text}`);
        assert.match(JSON.parse(buffered.text).error.message, /named a tool call with something that is not text/);
        assert.ok(!buffered.text.includes('not-a-string'), buffered.text);
        const streamed = await post(`${url}${path}`, headers, { ...body, stream: true });
        if (committed) assert.match(streamed.text, /named a tool call with something that is not text/, `${where}, ${path} stream: ${streamed.text}`);
        else assert.equal(streamed.status, 502, `${where}, ${path} stream: ${streamed.text}`);
        assert.ok(!streamed.text.includes('not-a-string'), streamed.text);
      }
    });
  }
});

test('an anonymous holder at the position a known call is placed at is that call\'s own prefix: delivered whole, never refused as half an identity (r30-fable F1)', async () => {
  const ADDED = { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'probe' } };
  const anon = (index) => ({ type: 'response.function_call_arguments.delta', output_index: index, delta: '{"a"' });
  const rest = (index) => ({ type: 'response.function_call_arguments.delta', output_index: index, item_id: 'fc_1', delta: ':1}' });
  const done = (index) => ({ type: 'response.output_item.done', output_index: index, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'probe', arguments: '{"a":1}' } });
  const completed = (output) => ({ type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output } });
  const FULL = [{ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'probe', arguments: '{"a":1}' }];
  const variants = [
    ['anonymous delta, then the index-less added, then the id frames at 0', [anon(0), ADDED, rest(0), done(0), completed(FULL)]],
    ['index-less added, then the anonymous delta, then the id frames at 0', [ADDED, anon(0), rest(0), done(0), completed(FULL)]],
    ['the same at position 2', [{ type: 'response.output_text.delta', output_index: 1, delta: 'first' }, ADDED, anon(2), rest(2), done(2), completed([{ type: 'message', id: 'm', content: [{ type: 'output_text', text: 'first' }] }, ...FULL])]],
    // No id frame ever carries a position: the completed output places the call, and the holder there is its own.
    ['index-less id frames, placed by the completed output', [ADDED, { ...anon(0), delta: '{"a":1}' }, completed(FULL)]],
    // After the holder is adopted its ordinal is retired; an id-less completed item still aligns to the one streamed call.
    ['id-less completed item after the adoption', [anon(0), ADDED, rest(0), completed([{ type: 'function_call', name: 'probe', arguments: '{"a":1}' }])]],
  ];
  for (const [where, vendor] of variants) {
    await withProxyEvents(vendor, async (url) => {
      const chat = await post(`${url}/v1/chat/completions`, OPENAI, { ...CHAT, tool_choice: 'auto' });
      assert.equal(chat.status, 200, `${where}, chat: ${chat.text}`);
      assert.deepEqual(JSON.parse(chat.text).choices[0].message.tool_calls.map((call) => [call.id, call.function.name, call.function.arguments]), [['call_1', 'probe', '{"a":1}']], where);
      const chatStream = events((await post(`${url}/v1/chat/completions`, OPENAI, { ...CHAT, tool_choice: 'auto', stream: true })).text);
      const streamedCalls = new Map();
      for (const call of chatStream.flatMap((chunk) => chunk.choices?.[0]?.delta?.tool_calls ?? [])) {
        const key = call.index ?? 0;
        streamedCalls.set(key, { id: streamedCalls.get(key)?.id ?? call.id, args: `${streamedCalls.get(key)?.args ?? ''}${call.function?.arguments ?? ''}` });
      }
      assert.deepEqual([...streamedCalls.values()], [{ id: 'call_1', args: '{"a":1}' }], `${where}, chat stream`);
      const responses = await post(`${url}/v1/responses`, OPENAI, { ...RESPONSES_PROBE, tool_choice: 'auto' });
      assert.equal(responses.status, 200, `${where}, responses: ${responses.text}`);
      assert.deepEqual(JSON.parse(responses.text).output.filter((item) => item.type === 'function_call').map((item) => [item.call_id, item.arguments]), [['call_1', '{"a":1}']], where);
      const messages = await post(`${url}/v1/messages`, ANTHROPIC, { ...MESSAGES, tool_choice: { type: 'auto' } });
      assert.equal(messages.status, 200, `${where}, messages: ${messages.text}`);
      assert.deepEqual(JSON.parse(messages.text).content.filter((block) => block.type === 'tool_use').map((block) => [block.id, JSON.stringify(block.input)]), [['call_1', '{"a":1}']], where);
      const { starts, partial } = messagesBlocks((await post(`${url}/v1/messages`, ANTHROPIC, { ...MESSAGES, tool_choice: { type: 'auto' }, stream: true })).text);
      assert.deepEqual(starts.filter(([, type]) => type === 'tool_use').length, 1, `${where}, messages stream`);
      assert.equal(partial, '{"a":1}', `${where}, messages stream bytes`);
    });
  }
});

test('a holder whose bytes cannot be ordered against the call\'s own is refused, not guessed (r30)', async () => {
  // The call already carries bytes from an index-less delta when the holder
  // at its position is found: which came first is not reconstructible.
  const vendor = [
    { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'probe' } },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"a"' },
    { type: 'response.function_call_arguments.delta', output_index: 0, delta: ':1}' },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: '' },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [{ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'probe', arguments: '{"a":1}' }] } },
  ];
  await withProxyEvents(vendor, async (url) => {
    const chat = await post(`${url}/v1/chat/completions`, OPENAI, CHAT);
    assert.equal(chat.status, 502, chat.text);
    assert.match(JSON.parse(chat.text).error.message, /tool arguments the transport cannot place/);
    const messages = await post(`${url}/v1/messages`, ANTHROPIC, MESSAGES);
    assert.equal(messages.status, 502, messages.text);
  });
});

test('a non-text arguments member on output_item.added is refused like everywhere else, not read past into {} (r29-codex)', async () => {
  const vendor = [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'probe', arguments: { a: 1 } } },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'probe' } },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [{ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'probe' }] } },
  ];
  await withProxyEvents(vendor, async (url) => {
    for (const [path, headers, body] of [['/v1/chat/completions', OPENAI, CHAT], ['/v1/responses', OPENAI, RESPONSES_PROBE], ['/v1/messages', ANTHROPIC, MESSAGES]]) {
      const buffered = await post(`${url}${path}`, headers, body);
      assert.equal(buffered.status, 502, `${path}: ${buffered.text}`);
      assert.match(JSON.parse(buffered.text).error.message, /tool arguments that are not text/);
      // Nothing announced before the refusal: a clean 502 on the stream too.
      const streamed = await post(`${url}${path}`, headers, { ...body, stream: true });
      assert.equal(streamed.status, 502, `${path} stream: ${streamed.text}`);
      assert.ok(!streamed.text.includes('"arguments":"{}"') && !streamed.text.includes('"partial_json":"{}"'), streamed.text);
    }
  });
});

test('a known call claims only its accepted position: a later frame naming another one leaves that position to its real call (r30-codex)', async () => {
  const vendor = [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'alpha' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_a', delta: '{"a":1}' },
    { type: 'response.function_call_arguments.done', output_index: 0, item_id: 'fc_a', arguments: '{"a":1}' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'alpha', arguments: '{"a":1}' } },
    // A late duplicate of alpha's finish, carrying position 1 — not alpha's position.
    { type: 'response.function_call_arguments.done', output_index: 1, item_id: 'fc_a', arguments: '{"a":1}' },
    { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"b":2}' },
    { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', id: 'fc_b', call_id: 'call_b', name: 'beta', arguments: '{"b":2}' } },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [
      { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'alpha', arguments: '{"a":1}' },
      { type: 'function_call', id: 'fc_b', call_id: 'call_b', name: 'beta', arguments: '{"b":2}' },
    ] } },
  ];
  const TWO_CHAT = { ...CHAT, tools: [{ type: 'function', function: { name: 'alpha', parameters: { type: 'object' } } }, { type: 'function', function: { name: 'beta', parameters: { type: 'object' } } }] };
  const TWO_RESPONSES = { model: 'm', input: 'w', tools: [{ type: 'function', name: 'alpha', parameters: { type: 'object' } }, { type: 'function', name: 'beta', parameters: { type: 'object' } }], tool_choice: 'required' };
  const TWO_MESSAGES = { ...MESSAGES, tools: [{ name: 'alpha', input_schema: { type: 'object' } }, { name: 'beta', input_schema: { type: 'object' } }], tool_choice: { type: 'any' } };
  const BOTH = [['call_a', 'alpha', '{"a":1}'], ['call_b', 'beta', '{"b":2}']];
  await withProxyEvents(vendor, async (url) => {
    const chat = await post(`${url}/v1/chat/completions`, OPENAI, TWO_CHAT);
    assert.equal(chat.status, 200, chat.text);
    assert.deepEqual(JSON.parse(chat.text).choices[0].message.tool_calls.map((call) => [call.id, call.function.name, call.function.arguments]), BOTH);
    const chatStream = events((await post(`${url}/v1/chat/completions`, OPENAI, { ...TWO_CHAT, stream: true })).text);
    assert.deepEqual(chatStream.flatMap((chunk) => chunk.choices?.[0]?.delta?.tool_calls ?? []).filter((call) => call.id).map((call) => [call.id, call.function.name]), BOTH.map(([id, name]) => [id, name]));
    const responses = await post(`${url}/v1/responses`, OPENAI, TWO_RESPONSES);
    assert.equal(responses.status, 200, responses.text);
    assert.deepEqual(JSON.parse(responses.text).output.filter((item) => item.type === 'function_call').map((item) => [item.call_id, item.name, item.arguments]), BOTH);
    const messages = await post(`${url}/v1/messages`, ANTHROPIC, TWO_MESSAGES);
    assert.equal(messages.status, 200, messages.text);
    assert.deepEqual(JSON.parse(messages.text).content.filter((block) => block.type === 'tool_use').map((block) => [block.id, block.name, JSON.stringify(block.input)]), BOTH);
    const { starts } = messagesBlocks((await post(`${url}/v1/messages`, ANTHROPIC, { ...TWO_MESSAGES, stream: true })).text);
    assert.deepEqual(starts, [[0, 'tool_use'], [1, 'tool_use']]);
  });
});

test('a call_id and an item_id that first meet on a later frame are one call: announced once, never twice (r30-codex)', async () => {
  const vendor = [
    { type: 'response.output_item.added', item: { type: 'function_call', call_id: 'call_a', name: 'alpha' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_a', delta: '{"a":1}' },
    { type: 'response.function_call_arguments.done', output_index: 0, item_id: 'fc_a', arguments: '{"a":1}' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'alpha', arguments: '{"a":1}' } },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [{ type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'alpha', arguments: '{"a":1}' }] } },
  ];
  const ONE_CHAT = { ...CHAT, tools: [{ type: 'function', function: { name: 'alpha', parameters: { type: 'object' } } }] };
  const ONE_RESPONSES = { model: 'm', input: 'w', tools: [{ type: 'function', name: 'alpha', parameters: { type: 'object' } }], tool_choice: 'required' };
  const ONE_MESSAGES = { ...MESSAGES, tools: [{ name: 'alpha', input_schema: { type: 'object' } }], tool_choice: { type: 'any' } };
  await withProxyEvents(vendor, async (url) => {
    const chat = await post(`${url}/v1/chat/completions`, OPENAI, ONE_CHAT);
    assert.equal(chat.status, 200, chat.text);
    assert.deepEqual(JSON.parse(chat.text).choices[0].message.tool_calls.map((call) => [call.id, call.function.name, call.function.arguments]), [['call_a', 'alpha', '{"a":1}']]);
    const chatStream = events((await post(`${url}/v1/chat/completions`, OPENAI, { ...ONE_CHAT, stream: true })).text);
    const announced = chatStream.flatMap((chunk) => chunk.choices?.[0]?.delta?.tool_calls ?? []).filter((call) => call.id);
    assert.deepEqual(announced.map((call) => call.id), ['call_a'], chatStream.map((c) => JSON.stringify(c.choices?.[0]?.delta?.tool_calls)).join('\n'));
    assert.equal(chatStream.flatMap((chunk) => chunk.choices?.[0]?.delta?.tool_calls ?? []).map((call) => call.function?.arguments ?? '').join(''), '{"a":1}');
    const responses = await post(`${url}/v1/responses`, OPENAI, ONE_RESPONSES);
    assert.equal(responses.status, 200, responses.text);
    assert.deepEqual(JSON.parse(responses.text).output.filter((item) => item.type === 'function_call').map((item) => [item.call_id, item.arguments]), [['call_a', '{"a":1}']]);
    assert.equal(events((await post(`${url}/v1/responses`, OPENAI, { ...ONE_RESPONSES, stream: true })).text).filter((frame) => frame.type === 'response.output_item.done' && frame.item?.type === 'function_call').length, 1);
    const messages = await post(`${url}/v1/messages`, ANTHROPIC, ONE_MESSAGES);
    assert.equal(messages.status, 200, messages.text);
    assert.deepEqual(JSON.parse(messages.text).content.filter((block) => block.type === 'tool_use').map((block) => [block.id, JSON.stringify(block.input)]), [['call_a', '{"a":1}']]);
    const { starts, partial } = messagesBlocks((await post(`${url}/v1/messages`, ANTHROPIC, { ...ONE_MESSAGES, stream: true })).text);
    assert.deepEqual(starts, [[0, 'tool_use']]);
    assert.equal(partial, '{"a":1}');
  });
});

test('a cancellation that never settles does not hold back a decided outcome: the refusal, and a completed answer, reach the client (r30-codex)', async () => {
  const encoder = new TextEncoder();
  const hung = (frames) => () => {
    let pulled = false;
    return new ReadableStream({
      pull(controller) {
        if (pulled) return new Promise(() => {});
        pulled = true;
        controller.enqueue(encoder.encode(sse(frames)));
      },
      cancel() { return new Promise(() => {}); },
    });
  };
  const within = (promise, label) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${label}: no response within 3s`)), 3_000))]);
  // A refusal thrown from the pump, the body still open, its cancel hung.
  await withProxyResponse(() => new Response(hung([
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'probe' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: { not: 'text' } },
  ])(), { status: 200 }), async (url) => {
    const buffered = await within(post(`${url}/v1/chat/completions`, OPENAI, CHAT), 'refusal, buffered');
    assert.equal(buffered.status, 502, buffered.text);
    assert.match(JSON.parse(buffered.text).error.message, /tool arguments that are not text/);
    const streamed = await within(post(`${url}/v1/messages`, ANTHROPIC, { ...MESSAGES, stream: true }), 'refusal, stream');
    assert.match(streamed.text, /tool arguments that are not text/);
  });
  // A completed answer, the body still open after the terminal frame, its cancel hung.
  await withProxyResponse(() => new Response(hung([
    { type: 'response.output_text.delta', delta: 'complete answer' },
    { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [], usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 } } },
  ])(), { status: 200 }), async (url) => {
    const TEXT = { model: 'm', messages: [{ role: 'user', content: 'w' }] };
    const buffered = await within(post(`${url}/v1/chat/completions`, OPENAI, TEXT), 'completed, buffered');
    assert.equal(buffered.status, 200, buffered.text);
    assert.equal(JSON.parse(buffered.text).choices[0].message.content, 'complete answer');
    const streamed = await within(post(`${url}/v1/messages`, ANTHROPIC, { model: 'm', max_tokens: 64, messages: [{ role: 'user', content: 'w' }], stream: true }), 'completed, stream');
    assert.ok(events(streamed.text).some((frame) => frame.type === 'message_stop'), streamed.text);
  });
});
