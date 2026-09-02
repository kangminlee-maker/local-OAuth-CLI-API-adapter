import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  KnownToolArgumentsDeltaExtractor,
  ToolCallDeltaExtractor,
} from '../dist/proxy/tool-call-stream.js';

test('ToolCallDeltaExtractor waits for id and name before streaming arguments', () => {
  const extractor = new ToolCallDeltaExtractor();

  const early = extractor.push('{"status":"tool_calls","toolCalls":[{"arguments":"{\\"city\\"');
  assert.deepEqual(early, []);

  const events = extractor.push(':\\"Seoul\\"}","id":"call_1","name":"get_weather"}]}');
  assert.deepEqual(events, [
    {
      type: 'tool_call_delta',
      index: 0,
      id: 'call_1',
      name: 'get_weather',
      argumentsDelta: '',
    },
    {
      type: 'tool_call_delta',
      index: 0,
      id: 'call_1',
      name: 'get_weather',
      argumentsDelta: '{"city":"Seoul"}',
    },
  ]);
});

test('KnownToolArgumentsDeltaExtractor streams known tool arguments immediately', () => {
  const extractor = new KnownToolArgumentsDeltaExtractor(0, 'call_1', 'get_weather');

  assert.deepEqual(extractor.push('   '), []);
  assert.deepEqual(extractor.push(' {"city"'), [
    {
      type: 'tool_call_delta',
      index: 0,
      id: 'call_1',
      name: 'get_weather',
      argumentsDelta: '',
    },
    {
      type: 'tool_call_delta',
      index: 0,
      id: 'call_1',
      name: 'get_weather',
      argumentsDelta: '{"city"',
    },
  ]);
  assert.deepEqual(extractor.push(':"Seoul"}'), [
    {
      type: 'tool_call_delta',
      index: 0,
      id: 'call_1',
      name: 'get_weather',
      argumentsDelta: ':"Seoul"}',
    },
  ]);
});

test('the wrapper streams its answer text, not only its tool calls', () => {
  // Tools stay available for the whole conversation, so the turn that ANSWERS
  // comes through this extractor too. Reading only tool calls left such a turn
  // silent until it finished and then delivered it in one piece.
  const extractor = new ToolCallDeltaExtractor();
  const events = [
    ...extractor.push('{"status":"message","text":"서울은 '),
    ...extractor.push('3도입니다."'),
    ...extractor.push(',"toolCalls":[]}'),
  ];
  const streamed = events.filter((event) => event.type === 'text_delta').map((event) => event.delta);
  assert.deepEqual(streamed, ['서울은 ', '3도입니다.']);
  assert.equal(events.some((event) => event.type === 'tool_call_delta'), false);
});

test('a wrapper that calls a tool streams no answer text', () => {
  const extractor = new ToolCallDeltaExtractor();
  const events = [
    ...extractor.push('{"status":"tool_calls","text":"",'),
    ...extractor.push('"toolCalls":[{"id":"call_1","name":"get_weather","arguments":"{\\"city\\":\\"서울\\"}"}]}'),
  ];
  assert.equal(events.some((event) => event.type === 'text_delta'), false);
  assert.equal(events.filter((event) => event.type === 'tool_call_delta').length > 0, true);
});

// A turn's parts have ONE order, and the wrapper is what says it. The extractor
// used to emit whatever its incremental decoder happened to produce first, so
// the same wrapper streamed [call, text] when it arrived in small pieces and
// [text, call] when one delta carried the whole thing — 19 of the 94 chunk
// sizes below took the second reading, while the buffered parse of the same
// string said [call, text] every time. Which answer a client got was decided by
// where the backend cut its deltas.
//
// So the property is asserted over EVERY chunking, not a hand-picked one: the
// eight-character guard that stood here passed throughout, because eight
// characters happens to be one of the 75 sizes that already agreed.
const CALL = (n) => `{"id":"c${n}","name":"get","arguments":"{\\"n\\":${n}}"}`;
const THREE_CALLS = `[${CALL(1)},${CALL(2)},${CALL(3)}]`;

/** The turn's parts in emission order, each part named once. */
function emissionOrder(raw, chunkSize) {
  const extractor = new ToolCallDeltaExtractor();
  const order = [];
  for (let at = 0; at < raw.length; at += chunkSize) {
    for (const event of extractor.push(raw.slice(at, at + chunkSize))) {
      const part = event.type === 'text_delta' ? 'text' : `call#${event.index}`;
      if (order[order.length - 1] !== part) order.push(part);
    }
  }
  return order;
}

for (const [label, raw, expected] of [
  [
    'one call, then the narration',
    `{"status":"tool_calls","toolCalls":[${CALL(1)}],"text":"AFTER"}`,
    ['call#0', 'text'],
  ],
  [
    'the narration, then one call',
    `{"status":"tool_calls","text":"BEFORE","toolCalls":[${CALL(1)}]}`,
    ['text', 'call#0'],
  ],
  [
    'three calls, then the narration',
    `{"status":"tool_calls","toolCalls":${THREE_CALLS},"text":"AFTER the calls"}`,
    ['call#0', 'call#1', 'call#2', 'text'],
  ],
  [
    'the narration, then three calls',
    `{"status":"tool_calls","text":"BEFORE the calls","toolCalls":${THREE_CALLS}}`,
    ['text', 'call#0', 'call#1', 'call#2'],
  ],
  [
    'calls with no narration key at all',
    `{"status":"tool_calls","toolCalls":[${CALL(1)}]}`,
    ['call#0'],
  ],
]) {
  test(`the extractor reads one order for every chunking: ${label}`, () => {
    // Every size from a single character to the whole string in one delta —
    // the arrangement a backend that never splits its output produces, and the
    // one the old guard could not reach.
    const readings = new Map();
    for (let size = 1; size <= raw.length; size += 1) {
      const key = JSON.stringify(emissionOrder(raw, size));
      readings.set(key, (readings.get(key) ?? 0) + 1);
    }
    assert.equal(
      readings.size,
      1,
      `chunk boundaries changed the turn's order: ${JSON.stringify([...readings])}`,
    );
    assert.equal([...readings.values()][0], raw.length, 'every chunk size was measured');
    assert.deepEqual(emissionOrder(raw, raw.length), expected, 'the whole wrapper in ONE delta');
    assert.deepEqual(emissionOrder(raw, 1), expected, 'one character at a time');
    assert.deepEqual(emissionOrder(raw, 8), expected, 'the eight-character chunking');
  });
}

test('CONTROL: swapping the wrapper\'s two keys swaps the order it reads', () => {
  // Without this the sweep above would pass just as well on an extractor that
  // always answered the same way — the two wrappers carry identical parts, and
  // only their key order differs.
  const callsFirst = `{"status":"tool_calls","toolCalls":[${CALL(1)}],"text":"N"}`;
  const textFirst = `{"status":"tool_calls","text":"N","toolCalls":[${CALL(1)}]}`;
  for (const size of [1, 8, callsFirst.length]) {
    assert.deepEqual(emissionOrder(callsFirst, size), ['call#0', 'text']);
    assert.deepEqual(emissionOrder(textFirst, size), ['text', 'call#0']);
  }
});

// The rule reads the wrapper's KEY order, so it has to find keys. A substring
// search for `"text"` finds the tool named `text` and the stray value below
// just as readily, and when it lands on one the two readers agree on the same
// wrong answer — which puts the order straight back on the chunk boundary,
// because the events themselves still arrive in the wrapper's real order.
for (const [label, raw, expected] of [
  ['a tool NAMED text, and no narration key at all',
    '{"status":"tool_calls","toolCalls":[{"id":"c1","name":"text","arguments":"{}"}]}',
    ['call#0']],
  ['a call whose id is the string "text"',
    '{"status":"tool_calls","toolCalls":[{"id":"text","name":"g","arguments":"{}"}],"text":"AFTER"}',
    ['call#0', 'text']],
  ['an arguments payload carrying a "text" field of its own',
    '{"status":"tool_calls","toolCalls":[{"id":"c1","name":"g","arguments":"{\\"text\\":\\"x\\"}"}],"text":"AFTER"}',
    ['call#0', 'text']],
  // Not a wrapper the decision schema permits — it declares
  // `additionalProperties: false` — but a backend is not a promise, and this is
  // the shape where a substring search reads a position that is not a key.
  ['a stray key whose VALUE is the string "text", ahead of the calls',
    '{"status":"tool_calls","note":"text","toolCalls":[{"id":"c1","name":"g","arguments":"{}"}],"text":"AFTER"}',
    ['call#0', 'text']],
]) {
  test(`a value that spells a key name does not move the turn's order: ${label}`, () => {
    const readings = new Set();
    for (let size = 1; size <= raw.length; size += 1) readings.add(JSON.stringify(emissionOrder(raw, size)));
    assert.equal(readings.size, 1, `chunk boundaries changed the order: ${[...readings].join(' vs ')}`);
    assert.deepEqual(emissionOrder(raw, raw.length), expected, 'the whole wrapper in ONE delta');
    assert.deepEqual(emissionOrder(raw, 1), expected, 'one character at a time');
  });
}

test('CONTROL: a real narration key ahead of the calls still puts the text first', () => {
  // The cases above all read calls-first; without this they would pass on a
  // rule that had stopped finding the narration key at all.
  const raw = '{"status":"tool_calls","note":"text","text":"BEFORE","toolCalls":[{"id":"c1","name":"g","arguments":"{}"}]}';
  for (const size of [1, 8, raw.length]) {
    assert.deepEqual(emissionOrder(raw, size), ['text', 'call#0']);
  }
});
