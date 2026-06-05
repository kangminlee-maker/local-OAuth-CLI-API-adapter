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
