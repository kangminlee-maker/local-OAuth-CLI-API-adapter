import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildPrompt,
  claudeSystemPrompt,
  developerInstructions,
  forcedSingleToolCall,
  hasToolDecisionSchema,
  outputSchemaFor,
  parseBackendOutput,
  requestInstructionText,
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

test('forced single tool calls use arguments-only schema and parser', () => {
  const request = requestWithTools({
    messages: [{ role: 'user', content: 'Use get_weather for Seoul.', images: [] }],
    toolChoice: { type: 'required' },
  });

  const forced = forcedSingleToolCall(request);
  assert.equal(forced?.name, 'get_weather');
  assert.deepEqual(outputSchemaFor(request), request.tools[0].inputSchema);
  assert.match(buildPrompt(request), /Return only the JSON object for that tool's arguments/);
  assert.doesNotMatch(buildPrompt(request), /"toolCalls"/);

  const parsed = parseBackendOutput(request, '{"city":"Seoul"}');
  assert.equal(parsed.text, '');
  assert.equal(parsed.toolCalls[0].id, 'call_1');
  assert.equal(parsed.toolCalls[0].name, 'get_weather');
  assert.equal(parsed.toolCalls[0].arguments, '{"city":"Seoul"}');
});

test('auto tool decisions keep the full decision wrapper schema', () => {
  const request = requestWithTools({
    messages: [{ role: 'user', content: 'Use a tool if needed.', images: [] }],
    toolChoice: { type: 'auto' },
  });

  assert.equal(forcedSingleToolCall(request), null);
  assert.match(buildPrompt(request), /toolCalls/);
  assert.deepEqual(Object.keys(outputSchemaFor(request).properties).sort(), ['status', 'text', 'toolCalls']);
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

test('buildPrompt does not turn generous token caps into style instructions', () => {
  const generous = buildPrompt(requestWithTools({
    tools: [],
    maxTokens: 640,
    messages: [{ role: 'user', content: 'Write a detailed incident report.', images: [] }],
  }));
  assert.doesNotMatch(generous, /Max output tokens|Output token limit/);

  const narrow = buildPrompt(requestWithTools({
    tools: [],
    maxTokens: 64,
    messages: [{ role: 'user', content: 'Reply briefly.', images: [] }],
  }));
  assert.match(narrow, /Output token limit: 64/);
});

test('buildPrompt can split API instruction messages from conversation input', () => {
  const request = requestWithTools({
    tools: [],
    messages: [
      { role: 'system', content: 'Answer in Korean.', images: [] },
      { role: 'developer', content: 'Prioritize operational details.', images: [] },
      { role: 'user', content: 'Write the report.', images: [] },
    ],
  });

  const prompt = buildPrompt(request, { includeInstructionMessages: false });
  assert.doesNotMatch(prompt, /Answer in Korean/);
  assert.doesNotMatch(prompt, /Prioritize operational details/);
  assert.match(prompt, /<user>\nWrite the report\.\n<\/user>/);

  const instructions = requestInstructionText(request);
  assert.match(instructions, /<system>\nAnswer in Korean\.\n<\/system>/);
  assert.match(instructions, /<developer>\nPrioritize operational details\.\n<\/developer>/);
});

test('buildPrompt keeps instruction messages by default for non-Codex backends', () => {
  const prompt = buildPrompt(requestWithTools({
    tools: [],
    messages: [
      { role: 'system', content: 'Answer in Korean.', images: [] },
      { role: 'user', content: 'Write the report.', images: [] },
    ],
  }));

  assert.match(prompt, /<system>\nAnswer in Korean\.\n<\/system>/);
  assert.match(prompt, /<user>\nWrite the report\.\n<\/user>/);
});

test('developer instructions preserve request facts without compactness bias', () => {
  const instructions = developerInstructions();

  assert.match(instructions, /explicit fact/);
  assert.match(instructions, /negative constraints/);
  assert.match(instructions, /condition-to-consequence links/);
  assert.match(instructions, /Preserve requiredness and conditionality exactly/);
  assert.match(instructions, /error\.param/);
  assert.match(instructions, /relevant error\.param values/);
  assert.match(instructions, /provider-compatible error\.code values/);
  assert.match(instructions, /Mention null for error\.param or error\.code only for concrete cases/);
  assert.match(instructions, /OpenAI-compatible error body/);
  assert.match(instructions, /include error\.param as a stable field/);
  assert.match(instructions, /relevant request parameter or null/);
  assert.match(instructions, /include error\.code as a stable field/);
  assert.match(instructions, /provider-compatible value or null/);
  assert.match(instructions, /Do not summarize error\.param and error\.code as vague stable param\/code fields/);
  assert.match(instructions, /attach the stated HTTP status to both invalid and unsupported options/);
  assert.match(instructions, /silently falling back/);
  assert.match(instructions, /URL accessibility\/expiry\/MIME parity/);
  assert.match(instructions, /cross-cutting authority/);
  assert.match(instructions, /one-to-one area mapping/);
  assert.match(instructions, /zero-score enforcement/);
  assert.match(instructions, /vision judge rubric/);
  assert.match(instructions, /direct Images API positive and negative baseline rows plus proxy generation rows/);
  assert.match(instructions, /no-direct-provider rule on that route itself/);
  assert.match(instructions, /keep each bullet compact/);
  assert.match(instructions, /state global rules once/);
  assert.match(instructions, /generation routes in generation coverage/);
  assert.match(instructions, /supported combinations/);
  assert.match(instructions, /decision criterion/);
  assert.match(instructions, /event timeline/);
  assert.match(instructions, /complete valid arguments/);
  assert.match(instructions, /do not invent them when schema, usage, or data integrity are stated as normal/);
  assert.match(instructions, /first_tool_argument/);
  assert.match(instructions, /direct provider behavior/);
  assert.match(instructions, /payload delivery/);
  assert.match(instructions, /percentage and absolute thresholds are alternatives or combined criteria/);
  assert.match(instructions, /fixed number of bullets/);
  assert.match(instructions, /compact clauses/);
  assert.match(instructions, /affected scope/);
  assert.match(instructions, /connect each named cause candidate/);
  assert.match(instructions, /wrapper context growth/);
  assert.match(instructions, /separate usage collection from streaming delivery/);
  assert.match(instructions, /compare proxy latency against direct provider latency/);
  assert.match(instructions, /Avoid vague remediation verbs/);
  assert.match(instructions, /answering in Korean/);
  assert.match(instructions, /do not introduce non-Korean operational terms/);
  assert.match(instructions, /observed elapsed times from derived additional delay/);
  assert.match(instructions, /one compact sentence per bullet/);
  assert.match(instructions, /affected paths or data flows/);
  assert.match(instructions, /omit filler/);
  assert.match(instructions, /candidates remain candidates/);
  assert.doesNotMatch(instructions, /compact concrete factors/);
  assert.doesNotMatch(instructions, /generic direction-only wording/);
});

test('Claude system prompt shares the API backend semantic contract', () => {
  const prompt = claudeSystemPrompt();

  assert.match(prompt, /API completion backend/);
  assert.match(prompt, /standalone provider API request/);
  assert.match(prompt, /Preserve every explicit fact/);
  assert.doesNotMatch(prompt, /compact concrete factors/);
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
