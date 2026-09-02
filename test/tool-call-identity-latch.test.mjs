// The first thing a client hears about a tool call is its IDENTITY, and it is
// the only thing it hears: every writer latches an index the first time it is
// announced and returns early after that, so a later delta carrying corrected
// values is dropped. The extractor decoding the backend's JSON wrapper read
// `id` and `name` out of string literals the delta boundary had not closed
// yet, so a chunking that split either one announced a PREFIX as the identity
// — a name no client has a tool for, an id the next turn cannot pair a result
// against — while the buffered reading of the same turn had them right.
//
// One hand-picked chunk size is what let that through: most sizes are fine.
// So these sweep EVERY chunking of the wrapper rather than sampling one.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ToolCallDeltaExtractor } from '../dist/proxy/tool-call-stream.js';

/** Feed `wrapper` in fixed-size pieces and record what a client would see. */
function replay(wrapper, size) {
  const extractor = new ToolCallDeltaExtractor();
  const announced = new Map();
  const streamedArguments = new Map();
  const argumentEvents = new Map();
  for (let at = 0; at < wrapper.length; at += size) {
    for (const event of extractor.push(wrapper.slice(at, at + size))) {
      if (event.type !== 'tool_call_delta') continue;
      if (!announced.has(event.index)) announced.set(event.index, event);
      if (event.argumentsDelta) {
        streamedArguments.set(
          event.index,
          (streamedArguments.get(event.index) ?? '') + event.argumentsDelta,
        );
        argumentEvents.set(event.index, (argumentEvents.get(event.index) ?? 0) + 1);
      }
    }
  }
  return { announced, streamedArguments, argumentEvents };
}

function wrapperFor(calls, { nameFirst = false } = {}) {
  return JSON.stringify({
    status: 'tool_calls',
    toolCalls: calls.map((call) =>
      nameFirst
        ? { name: call.name, id: call.id, arguments: call.arguments }
        : { id: call.id, name: call.name, arguments: call.arguments },
    ),
    text: '',
  });
}

/**
 * The invariant over every chunking: whatever the delta boundaries, the FIRST
 * event a client sees for a call carries the whole `id` and the whole `name`,
 * the call is still announced before the turn ends, and its arguments arrive
 * complete.
 */
function sweepEveryChunking(wrapper, calls) {
  let sizesSwept = 0;
  for (let size = 1; size <= wrapper.length; size += 1) {
    const { announced, streamedArguments } = replay(wrapper, size);
    for (const [index, call] of calls.entries()) {
      const first = announced.get(index);
      const at = `chunk=${size} call ${index}`;
      assert.ok(first, `${at}: never announced — withholding must delay, not cancel`);
      assert.equal(first.index, index, `${at}: announced under the wrong index`);
      assert.equal(first.id, call.id, `${at}: TRUNCATED id ${JSON.stringify(first.id)}`);
      assert.equal(first.name, call.name, `${at}: TRUNCATED name ${JSON.stringify(first.name)}`);
      assert.equal(first.argumentsDelta, '', `${at}: the announcement must carry no payload`);
      assert.equal(
        streamedArguments.get(index) ?? '',
        call.arguments,
        `${at}: streamed arguments do not reassemble the call's real input`,
      );
    }
    sizesSwept += 1;
  }
  // A sweep that ran zero times passes every assertion in it. Assert the
  // denominator rather than trusting it.
  assert.equal(sizesSwept, wrapper.length, 'the sweep did not cover every chunk size');
  assert.ok(sizesSwept > 50, `too few chunk sizes to be a sweep: ${sizesSwept}`);

  // ...and prove the identity latch did not buy its green by withholding the
  // payload too: at one byte per delta the arguments must still arrive in
  // pieces, not in a single lump at the end.
  const byteAtATime = replay(wrapper, 1);
  for (const index of calls.keys()) {
    assert.ok(
      (byteAtATime.argumentEvents.get(index) ?? 0) > 1,
      `call ${index}: arguments arrived in one lump — over-withheld`,
    );
  }
}

const ARGUMENTS = '{"city":"Seoul","units":"metric"}';

test('every chunking announces the complete identity: id before name', () => {
  const calls = [{ id: 'call_one', name: 'get_weather', arguments: ARGUMENTS }];
  sweepEveryChunking(wrapperFor(calls), calls);
});

test('every chunking announces the complete identity: name before id', () => {
  const calls = [{ id: 'call_one', name: 'get_weather', arguments: ARGUMENTS }];
  sweepEveryChunking(wrapperFor(calls, { nameFirst: true }), calls);
});

test('every chunking announces the complete identity: two calls in one wrapper', () => {
  const calls = [
    { id: 'call_one', name: 'get_weather', arguments: ARGUMENTS },
    { id: 'call_two', name: 'get_forecast', arguments: '{"days":3}' },
  ];
  sweepEveryChunking(wrapperFor(calls), calls);
});

// A prefix of a JSON string literal can look closed to a careless scanner. An
// escaped quote is a `"` that does not end the value, a backslash is a `\`
// that changes what the next byte means, and a multi-byte character is one
// value split across code units a delta boundary can land between.
test('every chunking announces the complete identity: quote, backslash, multi-byte', () => {
  const calls = [
    { id: 'call"one', name: 'get\\weather', arguments: '{"q":"\\""}' },
    { id: 'call\\two', name: '날씨_조회_🌤', arguments: '{"q":"날씨"}' },
  ];
  const wrapper = wrapperFor(calls);
  // The fixture is only a fixture if it really carries what it claims.
  assert.ok(wrapper.includes('call\\"one'), 'the fixture must carry an escaped quote');
  assert.ok(wrapper.includes('get\\\\weather'), 'the fixture must carry a backslash');
  assert.ok(wrapper.includes('🌤'), 'the fixture must carry a multi-byte character');
  sweepEveryChunking(wrapper, calls);
});

test('every chunking announces the complete identity: \\u escapes in the identity', () => {
  // Hand-built: a `\u` escape is the one identity spelling `JSON.stringify`
  // will not produce, and it is the one whose partial read is hardest — four
  // hex digits that a delta boundary can cut anywhere.
  const wrapper =
    '{"status":"tool_calls","toolCalls":[{"id":"call_\\u00e9one",' +
    '"name":"get_\\u0077eather","arguments":"{}"}],"text":""}';
  assert.ok(wrapper.includes('\\u00e9'), 'the fixture must carry a \\u escape');
  const calls = [{ id: 'call_éone', name: 'get_weather', arguments: '{}' }];
  sweepEveryChunking(wrapper, calls);
});

test('CONTROL: a wrapper delivered in one chunk is announced, complete, at once', () => {
  const calls = [{ id: 'call_one', name: 'get_weather', arguments: ARGUMENTS }];
  const wrapper = wrapperFor(calls);
  const extractor = new ToolCallDeltaExtractor();
  const events = extractor.push(wrapper).filter((event) => event.type === 'tool_call_delta');

  assert.equal(events.length, 2, 'one announcement and one arguments delta');
  assert.deepEqual(events[0], {
    type: 'tool_call_delta',
    index: 0,
    id: 'call_one',
    name: 'get_weather',
    argumentsDelta: '',
  });
  assert.equal(events[1].argumentsDelta, ARGUMENTS);
});

test('CONTROL: an OPEN arguments literal still streams — only the identity waits', () => {
  const extractor = new ToolCallDeltaExtractor();

  // The identity is complete here; the arguments literal has not even started.
  const opening = extractor.push(
    '{"status":"tool_calls","toolCalls":[{"id":"call_one","name":"get_weather","arguments":"',
  );
  assert.deepEqual(opening, [
    {
      type: 'tool_call_delta',
      index: 0,
      id: 'call_one',
      name: 'get_weather',
      argumentsDelta: '',
    },
  ], 'a complete identity is announced without waiting for the payload');

  // Every push below leaves the `arguments` literal unclosed, and every one of
  // them must still reach the client. A rule that withheld unclosed strings in
  // general would return [] here — that would be a new defect, not a fix.
  assert.deepEqual(extractor.push('{\\"city\\":').map((event) => event.argumentsDelta), ['{"city":']);
  assert.deepEqual(extractor.push('\\"Seo').map((event) => event.argumentsDelta), ['"Seo']);
  assert.deepEqual(extractor.push('ul\\"').map((event) => event.argumentsDelta), ['ul"']);
  assert.deepEqual(extractor.push('}').map((event) => event.argumentsDelta), ['}']);
});

test('CONTROL: a wrapper cut off mid-identity announces nothing rather than a prefix', () => {
  // The backend died with `name` half-written. There is no identity to give a
  // client, and the announcement cannot be taken back once made, so the right
  // answer is silence — the buffered reading of the turn still has the truth.
  const extractor = new ToolCallDeltaExtractor();
  const events = extractor.push(
    '{"status":"tool_calls","toolCalls":[{"id":"call_one","name":"get_weat',
  );
  assert.deepEqual(events.filter((event) => event.type === 'tool_call_delta'), []);
});
