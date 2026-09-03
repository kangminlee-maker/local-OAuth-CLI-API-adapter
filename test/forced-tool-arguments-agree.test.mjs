import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KnownToolArgumentsDeltaExtractor, missingToolCallArgumentDelta } from '../dist/proxy/tool-call-stream.js';
import { parseBackendOutput } from '../dist/proxy/backend-contract.js';

/**
 * What a client accumulates from the argument deltas must be the tool input
 * the turn actually made.
 *
 * On the forced-tool path the whole CLI answer IS the arguments, and the
 * buffered reading normalizes it: a JSON *string* holding the object is
 * unwrapped, and an answer that is not JSON at all is wrapped as
 * `{"input": …}`. The stream forwarded the raw bytes, so those two shapes
 * accumulated to something the buffered body of the SAME turn contradicted —
 * a quoted string whose `.city` is undefined, and a payload that is not JSON.
 * The reconciler could not close the gap because it only appends when the
 * final value starts with what was already sent.
 *
 * Each case below runs one payload through both readings and asserts the
 * client ends up holding exactly what the body reports.
 */

const request = {
  model: 'm',
  shape: 'anthropic-messages',
  messages: [],
  jsonMode: false,
  tools: [{ name: 'get_weather', inputSchema: { type: 'object', properties: { city: { type: 'string' } } } }],
  toolChoice: { type: 'tool', name: 'get_weather' },
  raw: {},
};

function clientAccumulated(payload, chunkSize = payload.length) {
  const extractor = new KnownToolArgumentsDeltaExtractor(0, 'call_1', 'get_weather');
  let streamed = '';
  for (let at = 0; at < payload.length; at += chunkSize) {
    for (const event of extractor.push(payload.slice(at, at + chunkSize))) {
      if (event.argumentsDelta) streamed += event.argumentsDelta;
    }
  }
  const [call] = parseBackendOutput(request, payload).toolCalls;
  return { streamed, client: streamed + missingToolCallArgumentDelta(streamed, call), body: call.arguments };
}

for (const [label, payload] of [
  ['a well-formed object', '{"city":"Seoul"}'],
  ['an array', '[1,2]'],
  ['a JSON string holding the object', '"{\\"city\\":\\"Seoul\\"}"'],
  ['an answer that is not JSON at all', 'Seoul'],
  ['leading whitespace before an object', '   {"city":"Seoul"}'],
  // Opens as an object but does not parse. The rule is decided by the opening
  // character precisely so the streaming reader can apply it before the answer
  // is complete; a rule decided by `JSON.parse` succeeding cannot be applied
  // early, and the two readings came apart on exactly these.
  ['a truncated object', '{"city":"Seo'],
  ['an object with a trailing comma', '{"city":"Seoul",}'],
  ['a truncated array', '[1,2'],
  ['an object with trailing whitespace', '{"a":1}\n'],
]) {
  for (const chunkSize of [payload.length, 3, 1]) {
    test(`${label}, delivered ${chunkSize === payload.length ? 'in one piece' : `in ${chunkSize}-char chunks`}`, () => {
      const { client, body } = clientAccumulated(payload, chunkSize);
      assert.equal(client, body, 'the client accumulated something the body contradicts');
      // A payload that opens as an object or array is reported as it stands,
      // well-formed or not; everything else is rewritten into parseable JSON.
      if (!payload.trim().startsWith('{') && !payload.trim().startsWith('[')) {
        assert.doesNotThrow(() => JSON.parse(client));
      }
    });
  }
}

test('an object payload still streams live rather than waiting for the end', () => {
  // The withholding must be scoped to the shapes normalization rewrites; this
  // is the deliberate feature it must not cost.
  const { streamed } = clientAccumulated('{"city":"Seoul"}', 3);
  assert.equal(streamed, '{"city":"Seoul"}', 'an object payload must arrive as it is produced');
});

test('a rewritten payload streams nothing before the end', () => {
  // Nothing may be delivered that the completed result would contradict.
  for (const payload of ['"{\\"city\\":\\"Seoul\\"}"', 'Seoul']) {
    const { streamed } = clientAccumulated(payload, 3);
    assert.equal(streamed, '', `${payload} put bytes on the wire that the body would contradict`);
  }
});

test('the call is still announced at the first byte, even when its arguments wait', () => {
  const extractor = new KnownToolArgumentsDeltaExtractor(0, 'call_1', 'get_weather');
  const [announcement] = extractor.push('Seoul');
  assert.deepEqual(announcement, {
    type: 'tool_call_delta', index: 0, id: 'call_1', name: 'get_weather', argumentsDelta: '',
  });
});
