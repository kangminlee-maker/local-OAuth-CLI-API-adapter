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
  const codexHome = await createCodexHome();
  globalThis.fetch = async () => new Response(sse(completedCall(args)), { status: 200 });
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
  for (const [args, sentence] of [['not json', 'arguments that are not JSON'], ['[1, 2]', 'arguments that are not a JSON object']]) {
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
