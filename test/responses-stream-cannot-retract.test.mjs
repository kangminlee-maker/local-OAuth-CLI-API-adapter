import test from 'node:test';
import assert from 'node:assert/strict';
import { startLocalApiProxy } from '../dist/proxy/http-server.js';

/**
 * A stream's terminal frames report the bytes it delivered, not the result's
 * own copy of them.
 *
 * When a backend's `completed` result disagrees with the deltas it already
 * sent — `hello` on the wire, `hullo` at the end — the tail reconciler finds
 * no common prefix and adds nothing, so whatever the terminal frames read from
 * decides whether the stream contradicts itself. The tool branch read
 * `streamedText` and was right; the no-tool branch read `result.text`, so
 * text-only turns retracted bytes the client already had, across four frames.
 *
 * Both branches now go through one emitter, and this test runs the same
 * disagreement through both — the difference between them is the whole defect.
 */

const usage = { inputTokens: 1, outputTokens: 1, source: 'estimated' };

function eventsOf(body) {
  return body.split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter((chunk) => chunk && chunk !== '[DONE]')
    .map((chunk) => JSON.parse(chunk));
}

async function streamWith({ streamedDelta, finalText, toolCalls }) {
  const result = {
    id: 'x',
    model: 'm',
    text: finalText,
    toolCalls,
    textRuns: finalText ? [{ text: finalText, afterCalls: 0 }] : [],
    usage,
    latencyMs: 1,
  };
  const backend = {
    name: 't',
    model: 'm',
    async generate() { return result; },
    async *stream() {
      yield { type: 'text_delta', delta: streamedDelta };
      for (const [index, call] of toolCalls.entries()) {
        yield {
          type: 'tool_call_delta',
          index,
          id: call.id,
          name: call.name,
          argumentsDelta: call.arguments,
          argumentsDone: true,
        };
      }
      yield { type: 'completed', result };
    },
    async close() {},
  };
  const server = await startLocalApiProxy({ backend, host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000 });
  try {
    const res = await fetch(`${server.url}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer local' },
      body: JSON.stringify({
        model: 'm',
        input: 'x',
        stream: true,
        ...(toolCalls.length > 0
          ? { tools: [{ type: 'function', name: 'f', parameters: { type: 'object', properties: {}, additionalProperties: false } }] }
          : {}),
      }),
    });
    return eventsOf(await res.text());
  } finally {
    await server.close();
  }
}

function terminalTexts(events) {
  const at = (type) => events.find((event) => event.type === type);
  const message = (item) => (item?.content ?? []).map((part) => part.text).join('');
  return {
    'output_text.done': at('response.output_text.done')?.text,
    'content_part.done': at('response.content_part.done')?.part?.text,
    'output_item.done': message(at('response.output_item.done')?.item),
    'completed': (at('response.completed')?.response?.output ?? [])
      .filter((item) => item.type === 'message').map(message).join(''),
  };
}

for (const [label, toolCalls] of [
  ['a text-only turn', []],
  ['a turn that also calls a tool', [{ id: 'c1', name: 'f', arguments: '{}' }]],
]) {
  test(`${label} never retracts bytes it already delivered`, async () => {
    const events = await streamWith({ streamedDelta: 'hello', finalText: 'hullo', toolCalls });
    const delivered = events
      .filter((event) => event.type === 'response.output_text.delta')
      .map((event) => event.delta).join('');
    assert.equal(delivered, 'hello', 'precondition: the wire carried the deltas');
    for (const [frame, text] of Object.entries(terminalTexts(events))) {
      assert.equal(
        text,
        delivered,
        `${frame} said ${JSON.stringify(text)} after delivering ${JSON.stringify(delivered)}`,
      );
    }
  });
}

test('CONTROL: when the result agrees, the tail is still reconciled onto the wire', async () => {
  const events = await streamWith({ streamedDelta: 'hel', finalText: 'hello', toolCalls: [] });
  const delivered = events
    .filter((event) => event.type === 'response.output_text.delta')
    .map((event) => event.delta).join('');
  assert.equal(delivered, 'hello', 'the missing tail must still be sent as deltas');
  for (const [frame, text] of Object.entries(terminalTexts(events))) {
    assert.equal(text, 'hello', `${frame} dropped the reconciled tail`);
  }
});
