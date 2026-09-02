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
      // The wrapper put its `text` key first, so the narration is one run
      // before the call — stated, not left to a reader's default.
      textRuns: [{ text: '날씨를 확인하겠습니다.', afterCalls: 0 }],
    },
  );
});

// Both ordered surfaces report a turn's parts in production order and read it
// from `textRuns` — where each run of the narration sits among the calls. Only
// `CodexBackendTransport` ever set it, so the two backends that go through
// `ToolCallDeltaExtractor` streamed `[call, text]` while their buffered body
// said `[text, call]`. The wrapper's own key order is the artifact BOTH paths
// see, so it is what decides. The wrapper holds one array and one text field,
// so the turn it describes has at most ONE run: all-before (the call count) or
// all-after (0). A wrapper with no narration has no run at all — there is
// nothing to place, and inventing one would put an empty block on a surface
// that reports none.
const ORDER_REQUEST = {
  shape: 'openai-responses', model: 'm', messages: [], stream: false, streamOptions: {},
  tools: [{ name: 'get_weather', description: 'w', parameters: {} }], toolChoice: { type: 'auto' }, raw: {},
};
const CALL = '{"id":"c1","name":"get_weather","arguments":"{}"}';
const CALLS = (n) => Array.from({ length: n }, (_, i) => `{"id":"c${i + 1}","name":"get_weather","arguments":"{}"}`).join(',');

/** Where each run of the parsed turn's narration sits among its calls. */
const runPositions = (parsed) => (parsed.textRuns ?? []).map((run) => run.afterCalls);

for (const [label, raw, expected] of [
  ['text before toolCalls', `{"status":"tool_calls","text":"checking","toolCalls":[${CALL}]}`, [0]],
  ['toolCalls before text', `{"status":"tool_calls","toolCalls":[${CALL}],"text":"checking"}`, [1]],
  ['toolCalls with no text at all', `{"status":"tool_calls","toolCalls":[${CALL}]}`, []],
  ['text with no calls', '{"status":"message","text":"just talking"}', []],
  // Above one call, "the number of calls that came first" and the constant 1
  // stop being the same number — and every fixture here used to carry exactly
  // one call, so nothing could tell them apart.
  ['TWO calls before text', `{"status":"tool_calls","toolCalls":[${CALLS(2)}],"text":"checking"}`, [2]],
  ['THREE calls before text', `{"status":"tool_calls","toolCalls":[${CALLS(3)}],"text":"checking"}`, [3]],
  ['THREE calls after text', `{"status":"tool_calls","text":"checking","toolCalls":[${CALLS(3)}]}`, [0]],
  ['THREE calls and no text at all', `{"status":"tool_calls","toolCalls":[${CALLS(3)}]}`, []],
]) {
  test(`the wrapper's key order decides production order: ${label}`, () => {
    const parsed = parseBackendOutput(ORDER_REQUEST, raw);
    assert.deepEqual(runPositions(parsed), expected);
    // One run at most, and it carries the whole narration: the wrapper has one
    // `text` field, so a parse that split it would be inventing structure.
    assert.equal((parsed.textRuns ?? []).map((run) => run.text).join(''), parsed.textRuns ? parsed.text : '');
  });
}

test('the ordinal is the CALL COUNT, not a fixed one', () => {
  // The ordinal says how many calls came before the narration, so on a
  // calls-first wrapper it has to track the array's length. Read as a constant
  // it puts the text after the FIRST call, which is an order the turn never
  // had — and no single-call fixture can see the difference.
  const ordinals = [];
  for (let count = 1; count <= 4; count += 1) {
    const parsed = parseBackendOutput(
      ORDER_REQUEST,
      `{"status":"tool_calls","toolCalls":[${CALLS(count)}],"text":"checking"}`,
    );
    assert.equal(parsed.toolCalls.length, count, 'the wrapper carried the calls it claims');
    assert.deepEqual(runPositions(parsed), [count], `${count} calls came before the narration`);
    ordinals.push(runPositions(parsed)[0]);
  }
  assert.deepEqual(ordinals, [1, 2, 3, 4]);
  // CONTROL: a constant would satisfy the count-1 case alone, so the values
  // must actually differ across the four.
  assert.equal(new Set(ordinals).size, 4, 'the ordinal moved with the call count');
});

// The flag is only worth anything if the STREAM agrees with it. This drove the
// shipped extractor at ONE chunk size — eight characters — and passed while a
// backend that delivered the same wrapper in a single delta streamed the turn
// in the opposite order from the buffered body this file measures above. A
// fixed arrangement cannot establish a property that holds for any arrangement,
// so the comparison runs at every chunk size the wrapper admits.
for (const [label, raw] of [
  ['text before toolCalls', `{"status":"tool_calls","text":"checking","toolCalls":[${CALL}]}`],
  ['toolCalls before text', `{"status":"tool_calls","toolCalls":[${CALL}],"text":"checking"}`],
]) {
  test(`the extractor emits in the order the flag reports, at every chunking: ${label}`, async () => {
    const { ToolCallDeltaExtractor } = await import('../dist/proxy/tool-call-stream.js');
    const firstKind = (chunkSize) => {
      const extractor = new ToolCallDeltaExtractor();
      for (let at = 0; at < raw.length; at += chunkSize) {
        for (const event of extractor.push(raw.slice(at, at + chunkSize))) return event.type;
      }
      return null;
    };
    // What the buffered body says came first, read off the very flag under test.
    const buffered = (runPositions(parseBackendOutput(ORDER_REQUEST, raw))[0] ?? 0) > 0
      ? 'tool_call_delta'
      : 'text_delta';
    const disagreed = [];
    for (let size = 1; size <= raw.length; size += 1) {
      if (firstKind(size) !== buffered) disagreed.push(size);
    }
    assert.deepEqual(
      disagreed,
      [],
      `chunk sizes where the stream contradicted the buffered body (of ${raw.length}): ${disagreed.join(',')}`,
    );
    assert.equal(firstKind(raw.length), buffered, 'the whole wrapper in ONE delta');
  });
}

test('CONTROL: the two key orders report opposite flags', () => {
  // The sweep above compares the stream against the flag, so a flag stuck on
  // one answer would satisfy it twice over. These are the same parts in the
  // opposite key order, and they must not read alike.
  const textFirst = parseBackendOutput(ORDER_REQUEST, `{"status":"tool_calls","text":"checking","toolCalls":[${CALL}]}`);
  const callsFirst = parseBackendOutput(ORDER_REQUEST, `{"status":"tool_calls","toolCalls":[${CALL}],"text":"checking"}`);
  assert.deepEqual(runPositions(textFirst), [0]);
  assert.deepEqual(runPositions(callsFirst), [1]);
});
