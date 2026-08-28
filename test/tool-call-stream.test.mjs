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
