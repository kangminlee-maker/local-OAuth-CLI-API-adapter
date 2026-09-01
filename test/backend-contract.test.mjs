import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

test('the tool choice is what turns the decision schema off, and only `none` does', () => {
  const messages = [{ role: 'tool', content: '[tool result]\ntool_call_id: call_1\n{"ok":true}', images: [] }];
  for (const toolChoice of [{ type: 'auto' }, { type: 'required' }, { type: 'tool', name: 'get_weather' }]) {
    assert.equal(hasToolDecisionSchema(requestWithTools({ messages, toolChoice })), true, JSON.stringify(toolChoice));
  }
  assert.equal(hasToolDecisionSchema(requestWithTools({ messages, toolChoice: { type: 'none' } })), false);
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

test('a turn after a tool result can still call a tool', () => {
  // The model that wants a second lookup has to have somewhere to put it. With
  // the tools taken off this turn it wrote the call as prose and the turn came
  // back as an answer, so every question needing two lookups broke.
  const request = requestWithTools({
    messages: [{ role: 'tool', content: '[tool result]\ntool_call_id: call_1\n{"temperature":"21C"}', images: [] }],
  });

  assert.equal(hasToolDecisionSchema(request), true);
  assert.deepEqual(Object.keys(outputSchemaFor(request).properties).sort(), ['status', 'text', 'toolCalls']);
});

test('answering is still expressible on a turn after a tool result', () => {
  // Keeping the tools on must not force a call: the same schema carries the
  // answer case, which is what makes the continuation lose nothing.
  const request = requestWithTools({
    messages: [{ role: 'tool', content: '[tool result]\ntool_call_id: call_1\n{"temperature":"21C"}', images: [] }],
  });

  assert.deepEqual(
    parseBackendOutput(request, JSON.stringify({ status: 'message', text: '서울은 21도입니다.', toolCalls: [] })),
    { text: '서울은 21도입니다.', toolCalls: [] },
  );
});

test('a json-mode answer is not mistaken for an empty wrapper', () => {
  // With tools on every turn, a json-mode client's own object reaches this
  // parser. Read as a wrapper it has no `text`, and the answer came back empty
  // — the reply dropped on the floor rather than delivered.
  const request = requestWithTools({
    messages: [{ role: 'tool', content: '[tool result]\ntool_call_id: call_1\n{"ok":true}', images: [] }],
    jsonMode: true,
  });

  assert.deepEqual(
    parseBackendOutput(request, '{"answer":"OK"}'),
    { text: '{"answer":"OK"}', toolCalls: [] },
  );
});

test('a continuation keeps the requested JSON schema when the tools are off', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: { answer: { type: 'string' } },
    required: ['answer'],
  };
  // Tools are available for every turn now, so a client that wants its own
  // schema honoured says so the way the API already allows.
  const request = requestWithTools({
    messages: [{ role: 'user', content: '[tool result]\ntool_call_id: call_1\n{"answer":"OK"}', images: [] }],
    jsonMode: true,
    jsonSchema: schema,
    toolChoice: { type: 'none' },
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

// The old version of this test asserted each of 46 instruction phrases was
// present, which pinned the overfitting in place: every phrase tuned to one
// quality-suite question had a test defending it. A denylist replaced it and was
// no better — 12 patterns caught only a handful of the 38 deleted lines, so most
// of them could come back green. The set of lines the runtime injects is small
// and deliberate, so assert it exactly: anything added, removed or reworded
// fails here and has to be an explicit edit to this list, which is the decision
// the injected surface deserves.
const DEVELOPER_INSTRUCTION_LINES = [
  'Follow API request instruction messages and tagged conversation messages only.',
  'Return requested content exactly.',
  'No preface or caveat unless requested.',
  'Preserve counts, formats, and word limits.',
  'Preserve numbers, thresholds, labels, and technical identifiers exactly.',
  'Preserve every explicit fact, comparison, decision criterion, exception, and threshold from the request.',
  'When concise output is requested, omit filler rather than omitting required facts or criteria.',
  'JSON mode: JSON only.',
];

test('developer instructions are exactly the general request-fidelity rules', () => {
  assert.equal(developerInstructions(), DEVELOPER_INSTRUCTION_LINES.join(' '));
});

// Every surface that injects prose into a request, not just the one that grew.
// A line shaped to a quality-suite question is as harmful in the image builder
// as in the developer block, and the block that grew to 46 lines was the one
// nobody was watching.
test('no injected instruction surface names a quality-suite question', async () => {
  const { claudeSystemPrompt } = await import('../dist/proxy/backend-contract.js');
  const appServer = await readFile(new URL('../src/proxy/codex-app-server-backend.ts', import.meta.url), 'utf8');
  const imageBlocks = [...appServer.matchAll(/function image\w*Instructions\(\)[^}]*}/g)].map((m) => m[0]);
  assert.ok(imageBlocks.length >= 2, 'expected the image base and developer instruction builders');

  const surfaces = [
    ['developerInstructions', developerInstructions()],
    ['claudeSystemPrompt', claudeSystemPrompt()],
    ...imageBlocks.map((block, index) => [`image instruction block ${index + 1}`, block]),
  ];
  const questionShaped = [
    /incident report/i, /four-bullet|fixed-bullet/i, /benchmark plan|test plan/i,
    /vision judge|judge rubric/i, /baseline row/i, /error\.param|error\.code/i,
    /wrapper context/i, /turn wait|turnWaitMs/i, /first_tool_argument|firstToolArgument/i,
    /release gate/i, /zero-score/i, /one-to-one area mapping/i,
  ];
  for (const [name, text] of surfaces) {
    for (const pattern of questionShaped) {
      assert.doesNotMatch(text, pattern, `${name} returned question-shaped instruction: ${pattern}`);
    }
  }
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

test('narration that comes with a tool call survives the wrapper', () => {
  // Every surface reports text alongside tool calls; this parser used to make
  // the schema-driven runtimes the exception by discarding it.
  const request = requestWithTools({
    messages: [{ role: 'user', content: 'Use weather tool', images: [] }],
  });

  assert.deepEqual(
    parseBackendOutput(request, JSON.stringify({
      status: 'tool_calls',
      text: '날씨를 확인하겠습니다.',
      toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: '{"city":"서울"}' }],
    })),
    {
      text: '날씨를 확인하겠습니다.',
      toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: '{"city":"서울"}' }],
    },
  );
});

// Both ordered surfaces report a turn's parts in production order and read it
// from `textOrdinal` — how many calls came before the narration. Only
// `CodexBackendTransport` ever set it, so the two backends that go through
// `ToolCallDeltaExtractor` streamed `[call, text]` while their buffered body
// said `[text, call]`. The wrapper's own key order is the artifact BOTH paths
// see, so it is what decides. The wrapper holds one array and one text field,
// so it can only say all-before (the call count) or all-after (0).
const ORDER_REQUEST = {
  shape: 'openai-responses', model: 'm', messages: [], stream: false, streamOptions: {},
  tools: [{ name: 'get_weather', description: 'w', parameters: {} }], toolChoice: { type: 'auto' }, raw: {},
};
const CALL = '{"id":"c1","name":"get_weather","arguments":"{}"}';

for (const [label, raw, expected] of [
  ['text before toolCalls', `{"status":"tool_calls","text":"checking","toolCalls":[${CALL}]}`, 0],
  ['toolCalls before text', `{"status":"tool_calls","toolCalls":[${CALL}],"text":"checking"}`, 1],
  ['toolCalls with no text at all', `{"status":"tool_calls","toolCalls":[${CALL}]}`, 1],
  ['text with no calls', '{"status":"message","text":"just talking"}', 0],
]) {
  test(`the wrapper's key order decides production order: ${label}`, () => {
    const parsed = parseBackendOutput(ORDER_REQUEST, raw);
    assert.equal(parsed.textOrdinal ?? 0, expected);
  });
}

test('the extractor emits in the order the flag reports', async () => {
  // The flag is only worth anything if the STREAM agrees with it, so drive the
  // shipped extractor over the same two wrappers and compare.
  const { ToolCallDeltaExtractor } = await import('../dist/proxy/tool-call-stream.js');
  const firstKinds = (raw) => {
    const extractor = new ToolCallDeltaExtractor();
    const kinds = [];
    for (const chunk of raw.match(/.{1,8}/g) ?? []) {
      for (const event of extractor.push(chunk)) {
        if (kinds[kinds.length - 1] !== event.type) kinds.push(event.type);
      }
    }
    return kinds;
  };
  assert.equal(firstKinds(`{"status":"tool_calls","text":"checking","toolCalls":[${CALL}]}`)[0], 'text_delta');
  assert.equal(firstKinds(`{"status":"tool_calls","toolCalls":[${CALL}],"text":"checking"}`)[0], 'tool_call_delta');
});
