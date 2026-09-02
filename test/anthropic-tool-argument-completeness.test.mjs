// What a `/v1/messages` client accumulates from `input_json_delta` must be the
// tool input the turn actually made.
//
// A backend withholds `argumentsDone` exactly when the completed result still
// has to reconcile the value — the codex transport says so in as many words:
// "stay silent and let the end of the turn reconcile, which is the path for a
// backend that never says where arguments end". Narration then stopped that
// call's block to open its own, and a stopped block takes no more deltas, so
// `finish()` skipped the reconciliation and the turn read:
//
//   /v1/responses       streamed args {"city":"Seoul"}   valid JSON
//   /v1/chat/completions streamed args {"city":"Seoul"}  valid JSON
//   /v1/messages        streamed args {"city":           INVALID JSON
//   /v1/messages        buffered input {"city":"Seoul"}
//
// The narration waits for the call to settle now. The call was produced first
// either way, so its block still comes first — nothing about the order moves,
// only when the text block is allowed to open.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startLocalApiProxy } from '../dist/proxy/http-server.js';

const PARAMS = { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false };
const FULL = '{"city":"Seoul"}';
const CALL = { id: 'call_1', name: 'get_weather', arguments: FULL };
const JSON_HEADERS = { 'content-type': 'application/json' };
const ANTHROPIC_HEADERS = { ...JSON_HEADERS, 'x-api-key': 'local', 'anthropic-version': '2023-06-01' };

/** A tool delta the backend does NOT declare final — the reconcile-later path. */
const unfinishedCall = { type: 'tool_call_delta', index: 0, id: CALL.id, name: CALL.name, argumentsDelta: '{"city":' };
/** The same call, declared final on the wire — nothing left to reconcile. */
const finishedCall = { ...unfinishedCall, argumentsDelta: FULL, argumentsDone: true };
const narrate = { type: 'text_delta', delta: 'narration' };

function backendFor({ steps, text = 'narration', toolCalls = [CALL], textOrdinal }) {
  const result = {
    id: 'x', model: 'configured-model', text, toolCalls,
    ...(textOrdinal === undefined ? {} : { textOrdinal }),
    usage: { inputTokens: 1, outputTokens: 1, source: 'estimated' }, latencyMs: 1,
  };
  return {
    name: 'test', model: 'configured-model',
    async generate() { return result; },
    async *stream() { for (const step of steps) yield step; yield { type: 'completed', result }; },
    async close() {},
  };
}

const sseEvents = (wire) => wire.split('\n')
  .filter((line) => line.startsWith('data:'))
  .map((line) => line.slice(5).trim())
  .filter((data) => data && data !== '[DONE]')
  .map((data) => JSON.parse(data));

/**
 * One turn on all three streaming surfaces, plus the Messages buffered body.
 * Deltas are accumulated PER BLOCK — joining them across blocks would splice
 * two calls' arguments together and report a defect that is not there.
 */
async function readings(backend) {
  const server = await startLocalApiProxy({ backend, host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000 });
  const post = (path, body, headers) => fetch(`${server.url}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  try {
    const responsesTools = [{ type: 'function', name: 'get_weather', description: 'w', parameters: PARAMS, strict: true }];
    const chatTools = [{ type: 'function', function: { name: 'get_weather', description: 'w', parameters: PARAMS } }];
    const messagesTools = [{ name: 'get_weather', description: 'w', input_schema: PARAMS }];
    const responses = sseEvents(await (await post('/v1/responses', { model: 'm', input: 'w', stream: true, tools: responsesTools }, JSON_HEADERS)).text());
    const chat = sseEvents(await (await post('/v1/chat/completions', { model: 'm', stream: true, messages: [{ role: 'user', content: 'w' }], tools: chatTools }, JSON_HEADERS)).text());
    const messagesBody = { model: 'm', max_tokens: 64, messages: [{ role: 'user', content: 'w' }], tools: messagesTools };
    const messages = sseEvents(await (await post('/v1/messages', { ...messagesBody, stream: true }, ANTHROPIC_HEADERS)).text());
    const buffered = await (await post('/v1/messages', messagesBody, ANTHROPIC_HEADERS)).json();

    const blocks = new Map();
    const order = [];
    let open = 0;
    let maxOpen = 0;
    for (const event of messages) {
      if (event.type === 'content_block_start') {
        open += 1; maxOpen = Math.max(maxOpen, open);
        blocks.set(event.index, { type: event.content_block?.type, accumulated: '' });
        order.push(event.index);
      }
      if (event.type === 'content_block_stop') open -= 1;
      if (event.type === 'content_block_delta') {
        const block = blocks.get(event.index);
        if (block) block.accumulated += event.delta?.partial_json ?? event.delta?.text ?? '';
      }
    }
    return {
      responsesArguments: responses.filter((e) => e.type === 'response.function_call_arguments.delta').map((e) => e.delta).join(''),
      chatArguments: chat.flatMap((e) => e.choices?.[0]?.delta?.tool_calls ?? []).map((t) => t.function?.arguments ?? '').join(''),
      messagesBlocks: order.map((index) => ({ index, ...blocks.get(index) })),
      messagesDeltaCount: messages.filter((e) => e.type === 'content_block_delta' && e.delta?.type === 'input_json_delta').length,
      messagesMaxOpen: maxOpen,
      messagesLeftOpen: open,
      bufferedInput: buffered.content?.find((c) => c.type === 'tool_use')?.input,
      bufferedText: buffered.content?.filter((c) => c.type === 'text').map((c) => c.text).join('') ?? '',
    };
  } finally { await server.close(); }
}

const toolBlocks = (r) => r.messagesBlocks.filter((b) => b.type === 'tool_use');
const textBlocks = (r) => r.messagesBlocks.filter((b) => b.type === 'text');

/** Every surface's accumulation of the same turn, and it has to parse. */
function assertArgumentsComplete(r, label) {
  const streamed = toolBlocks(r).map((b) => b.accumulated);
  assert.deepEqual(streamed, [FULL], `${label}: the Messages client accumulates the whole tool input`);
  assert.deepEqual(JSON.parse(streamed[0]), { city: 'Seoul' }, `${label}: and it parses`);
  assert.equal(r.responsesArguments, FULL, `${label}: /v1/responses says the same`);
  assert.equal(r.chatArguments, FULL, `${label}: /v1/chat/completions says the same`);
  assert.deepEqual(r.bufferedInput, { city: 'Seoul' }, `${label}: and so does the buffered body`);
  assert.equal(r.messagesMaxOpen, 1, `${label}: never two content blocks open at once`);
  assert.equal(r.messagesLeftOpen, 0, `${label}: and none left open`);
}

test('narration does not truncate a tool input the backend never declared final', async () => {
  const r = await readings(backendFor({ steps: [unfinishedCall, narrate], textOrdinal: 1 }));
  assertArgumentsComplete(r, 'unfinished call, then live narration');
  assert.deepEqual(
    r.messagesBlocks.map((b) => b.type), ['tool_use', 'text'],
    'the call was produced first, so its block is still first',
  );
  assert.deepEqual(textBlocks(r).map((b) => b.accumulated), ['narration'], 'and the held narration is written exactly once');
});

test('the completed result\'s own tail text does not truncate it either', async () => {
  // No live text delta at all: the completed handler writes the turn's text,
  // and THAT opened the block that stopped the call. Same defect, a path a
  // test built only on live narration never reaches.
  const r = await readings(backendFor({ steps: [unfinishedCall], textOrdinal: 1 }));
  assertArgumentsComplete(r, 'unfinished call, text only at completed');
  assert.deepEqual(textBlocks(r).map((b) => b.accumulated), ['narration']);
});

test('a turn with no text at all reconciles the same arguments', async () => {
  const r = await readings(backendFor({ steps: [unfinishedCall], text: '' }));
  assertArgumentsComplete(r, 'unfinished call, no text');
  assert.deepEqual(r.messagesBlocks.map((b) => b.type), ['tool_use'], 'and opens no text block');
});

test('CONTROL: a call the backend declared final is not rewritten', async () => {
  // The opposite expected answer for the reconciliation: there is nothing to
  // add, so exactly one delta carries the value and nothing follows it.
  const r = await readings(backendFor({ steps: [finishedCall, narrate], textOrdinal: 1 }));
  assertArgumentsComplete(r, 'finished call, then narration');
  assert.equal(r.messagesDeltaCount, 1, 'a finished call takes exactly one arguments delta');
  assert.deepEqual(r.messagesBlocks.map((b) => b.type), ['tool_use', 'text']);
});

test('CONTROL: an unfinished call takes a second delta to complete it', async () => {
  const r = await readings(backendFor({ steps: [unfinishedCall, narrate], textOrdinal: 1 }));
  assert.equal(r.messagesDeltaCount, 2, 'the streamed prefix plus the reconciled tail');
});

test('narration held for a call still reaches a turn that ends without completing', async () => {
  // The gate's other exit: no completed result exists to reconcile from, so the
  // call closes on what it streamed — but the narration waiting on it may not
  // vanish with it.
  const server = await startLocalApiProxy({
    backend: {
      name: 'test', model: 'configured-model',
      async generate() { throw new Error('this test is about the stream'); },
      async *stream() { yield unfinishedCall; yield narrate; },
      async close() {},
    },
    host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
  });
  try {
    const wire = await (await fetch(`${server.url}/v1/messages`, {
      method: 'POST', headers: ANTHROPIC_HEADERS,
      body: JSON.stringify({
        model: 'm', max_tokens: 64, stream: true,
        messages: [{ role: 'user', content: 'w' }],
        tools: [{ name: 'get_weather', description: 'w', input_schema: PARAMS }],
      }),
    })).text();
    const events = sseEvents(wire);
    const starts = events.filter((e) => e.type === 'content_block_start').map((e) => e.content_block?.type);
    const text = events
      .filter((e) => e.type === 'content_block_delta' && e.delta?.type === 'text_delta')
      .map((e) => e.delta.text).join('');
    assert.deepEqual(starts, ['tool_use', 'text'], `the held narration takes its own block: ${starts.join(',')}`);
    assert.equal(text, 'narration', 'and carries the text the backend produced');
  } finally { await server.close(); }
});

const CALL_B = { id: 'call_2', name: 'get_weather', arguments: '{"city":"B"}' };
const secondCall = { type: 'tool_call_delta', index: 1, id: CALL_B.id, name: CALL_B.name, argumentsDelta: CALL_B.arguments, argumentsDone: true };

test('a second call may not open its block inside one still taking arguments', async () => {
  // Holding the narration keeps the first call's block OPEN, so a call
  // produced after it would nest a second block inside — a shape this wire has
  // no way to express and a client assembling by index cannot read. The held
  // text goes out first instead, which closes the unfinished block.
  //
  // KNOWN HOLE, deliberately not asserted as contract: closing that block is
  // the one case where its arguments cannot be reconciled, because no completed
  // result has arrived — so block 0 still carries only what was streamed. What
  // is asserted here is what the wire owes regardless: one block at a time, in
  // production order.
  const r = await readings(backendFor({
    steps: [unfinishedCall, narrate, secondCall], toolCalls: [CALL, CALL_B], textOrdinal: 1,
  }));
  assert.equal(r.messagesMaxOpen, 1,
    `two content blocks open at once: ${JSON.stringify(r.messagesBlocks.map((b) => [b.index, b.type]))}`);
  assert.equal(r.messagesLeftOpen, 0, 'and none left open');
  assert.deepEqual(
    r.messagesBlocks.map((b) => b.type), ['tool_use', 'text', 'tool_use'],
    'production order: the call, the narration it interrupted, then the next call',
  );
  assert.equal(toolBlocks(r)[1].accumulated, CALL_B.arguments, 'the second call carries its whole input');
  assert.deepEqual(textBlocks(r).map((b) => b.accumulated), ['narration'], 'and the narration is written once');
});

test('CONTROL: two calls around narration, the first declared final', async () => {
  // The same three-part turn with nothing held open — the reconciliation path
  // is never entered, and both calls carry their whole input.
  const r = await readings(backendFor({
    steps: [finishedCall, narrate, secondCall], toolCalls: [CALL, CALL_B], textOrdinal: 1,
  }));
  assert.equal(r.messagesMaxOpen, 1);
  assert.deepEqual(r.messagesBlocks.map((b) => b.type), ['tool_use', 'text', 'tool_use']);
  assert.deepEqual(toolBlocks(r).map((b) => b.accumulated), [FULL, CALL_B.arguments],
    'both calls carry their whole input');
});
