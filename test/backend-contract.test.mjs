import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildPrompt,
  hasToolDecisionSchema,
  outputSchemaFor,
} from '../dist/proxy/backend-contract.js';

test('tool decision schema remains enabled before an auto tool call', () => {
  assert.equal(hasToolDecisionSchema(requestWithTools({
    messages: [{ role: 'user', content: 'Use weather tool', images: [] }],
  })), true);
});

test('tool decision schema remains enabled for required tool choice', () => {
  assert.equal(hasToolDecisionSchema(requestWithTools({
    messages: [{ role: 'tool', content: '[tool result]\ntool_call_id: call_1\n{"ok":true}', images: [] }],
    toolChoice: { type: 'required' },
  })), true);
});

test('auto tool result continuation uses final answer mode', () => {
  const request = requestWithTools({
    messages: [{ role: 'tool', content: '[tool result]\ntool_call_id: call_1\n{"temperature":"21C"}', images: [] }],
  });

  assert.equal(hasToolDecisionSchema(request), false);
  assert.equal(outputSchemaFor(request), null);
  assert.doesNotMatch(buildPrompt(request), /Schema JSON only/);
  assert.match(buildPrompt(request), /Return only the assistant response text/);
});

test('auto tool result continuation preserves requested JSON schema', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: { answer: { type: 'string' } },
    required: ['answer'],
  };
  const request = requestWithTools({
    messages: [{ role: 'user', content: '[tool result]\ntool_call_id: call_1\n{"answer":"OK"}', images: [] }],
    jsonMode: true,
    jsonSchema: schema,
  });

  assert.equal(hasToolDecisionSchema(request), false);
  assert.equal(outputSchemaFor(request), schema);
  assert.match(buildPrompt(request), /Valid JSON only/);
});

function requestWithTools(overrides = {}) {
  return {
    shape: 'openai-chat',
    model: 'fake-local-model',
    messages: [],
    stream: false,
    streamOptions: { includeUsage: false, includeObfuscation: false },
    jsonMode: false,
    tools: [
      {
        name: 'get_weather',
        description: 'Get weather',
        inputSchema: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
        raw: {},
      },
    ],
    toolChoice: { type: 'auto' },
    raw: {},
    ...overrides,
  };
}
