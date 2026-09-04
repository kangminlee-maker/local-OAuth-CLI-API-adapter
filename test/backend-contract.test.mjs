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
  textMayBeRefused,
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

// The prompt is not a place to implement `max_tokens`. It used to be, for
// values <= 128, which made the cap a request rather than a promise: the
// option was accepted and echoed while a backend that ignored the sentence
// returned a full-length answer. Neither runtime has a channel that caps
// output the way the API does, so the cap is now declared unenforced instead
// of being asked for. This test fails if the sentence comes back at any value.
test('buildPrompt never asks the model for a token cap, at any value', () => {
  for (const maxTokens of [1, 16, 64, 128, 129, 640, 64_000]) {
    const prompt = buildPrompt(requestWithTools({
      tools: [],
      maxTokens,
      messages: [{ role: 'user', content: 'Write a detailed incident report.', images: [] }],
    }));
    assert.doesNotMatch(
      prompt,
      /Max output tokens|Output token limit|token limit|max_tokens/i,
      `maxTokens: ${maxTokens} put a cap instruction in the prompt`,
    );
  }
});

// The guard above only means something if this string would be caught.
test('CONTROL: the cap guard catches the sentence it is guarding against', () => {
  assert.match('Output token limit: 64.', /Max output tokens|Output token limit|token limit|max_tokens/i);
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
// the incremental reader of the time streamed `[call, text]` while their buffered body
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

test('CONTROL: the two key orders report opposite flags', () => {
  // A flag stuck on one answer would satisfy every consumer twice over. These
  // are the same parts in the opposite key order, and they must not read alike.
  const textFirst = parseBackendOutput(ORDER_REQUEST, `{"status":"tool_calls","text":"checking","toolCalls":[${CALL}]}`);
  const callsFirst = parseBackendOutput(ORDER_REQUEST, `{"status":"tool_calls","toolCalls":[${CALL}],"text":"checking"}`);
  assert.deepEqual(runPositions(textFirst), [0]);
  assert.deepEqual(runPositions(callsFirst), [1]);
});

test('an object that is not wrapper-shaped, and plain prose, are the answer', () => {
  // Only a wrapper this backend produced may be unwrapped. Reading a
  // non-wrapper object as a wrapper found no `text` and returned an empty
  // answer — the whole reply dropped on the floor.
  const request = {
    model: 'm', shape: 'openai-chat', messages: [], jsonMode: false,
    tools: [{ name: 'get_weather', inputSchema: { type: 'object' } }], toolChoice: { type: 'auto' }, raw: {},
  };
  assert.equal(parseBackendOutput(request, '{"my":"object"}').text, '{"my":"object"}');
  assert.equal(parseBackendOutput(request, 'plain prose').text, 'plain prose');
  assert.deepEqual(parseBackendOutput(request, 'plain prose').toolCalls, []);
});

// ---------------------------------------------------------------------------
// Conformance matrix §7 rows 8 and 10: the schema the client supplied is the
// runtime's output contract, and the response path refuses what breaks it.
// ---------------------------------------------------------------------------

const WEATHER_SCHEMA = { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] };

function forcedRequest(inputSchema = WEATHER_SCHEMA, strict = true) {
  return {
    model: 'm', shape: 'openai-chat', messages: [], jsonMode: false,
    tools: [{ name: 'get_weather', inputSchema, strict }], toolChoice: { type: 'required' }, raw: {},
  };
}

function refused(error, pattern) {
  return error.statusCode === 502 && pattern.test(error.message);
}

test('row 8: a forced call whose arguments are not JSON is refused at completion', () => {
  assert.throws(() => parseBackendOutput(forcedRequest(), '{"city":"Seo'), (e) => refused(e, /arguments that are not JSON/));
  // A stop reason that is not the output limit is no excuse either.
  assert.throws(() => parseBackendOutput(forcedRequest(), '{"city":"Seo', 'end_turn'), (e) => refused(e, /arguments that are not JSON/));
  // Prose is not JSON once wrapped as `{"input":…}` — so it is JSON, and
  // conforms to nothing the schema requires.
  assert.throws(() => parseBackendOutput(forcedRequest(), 'Seoul please'), (e) => refused(e, /outside the tool's schema/));
});

test('row 8: the fragment is kept only when the output limit cut the call off', () => {
  // Both readers of this function spell the limit the Messages API's way.
  const kept = parseBackendOutput(forcedRequest(), '{"city":"Seo', 'max_tokens');
  assert.deepEqual(kept.toolCalls, [{ id: 'call_1', name: 'get_weather', arguments: '{"city":"Seo' }]);
  // CONTROL: the Responses API's word is not one this reading ever receives
  // (r18-fable F7 — an arm nothing fed), so it is not an excuse.
  assert.throws(() => parseBackendOutput(forcedRequest(), '{"city":"Seo', 'length'), (e) => refused(e, /not JSON/));
});

// ---------------------------------------------------------------------------
// Round 18: what the two reviewers found in the row 8/10 closure.
// ---------------------------------------------------------------------------

test('r18: a turn cut off at the output limit is delivered whatever it holds (F4, codex C4)', () => {
  // The direct APIs deliver a limit-cut structured answer as the fragment it
  // is under `finish_reason: "length"` (measured 2026-09-04, M7), so none of
  // the completion rules apply to it.
  const partial = parseBackendOutput(forcedRequest(), '{"city":"Seoul"}', 'max_tokens');
  assert.equal(partial.toolCalls[0].arguments, '{"city":"Seoul"}', 'a parseable partial under a schema needing more');
  const strict = forcedRequest({ ...WEATHER_SCHEMA, required: ['city', 'country'] });
  assert.equal(parseBackendOutput(strict, '{"city":"Seoul"}', 'max_tokens').toolCalls[0].arguments, '{"city":"Seoul"}');
  assert.equal(parseBackendOutput(forcedRequest(), '{}', 'max_tokens').toolCalls[0].arguments, '{}');
  assert.equal(parseBackendOutput(schemaRequest(WEATHER_SCHEMA), '{"city":"Seo', 'max_tokens').text, '{"city":"Seo', 'json_schema fragment');
  const object = { ...schemaRequest(undefined), jsonSchema: undefined };
  assert.equal(parseBackendOutput(object, '{"a":', 'max_tokens').text, '{"a":', 'json_object fragment');
  // CONTROL: the same inputs with no stop reason are the refusals rows 8/10 promise.
  assert.throws(() => parseBackendOutput(strict, '{"city":"Seoul"}'), (e) => refused(e, /outside the tool's schema/));
  assert.throws(() => parseBackendOutput(schemaRequest(WEATHER_SCHEMA), '{"city":"Seo'), (e) => refused(e, /not JSON/));
  assert.throws(() => parseBackendOutput(object, '{"a":'), (e) => refused(e, /not a JSON object/));
});

test('r18: a schema this path cannot judge passes — $async, $id/$ref across requests, inexact numbers (F1, F3, codex C1/C3)', () => {
  // `$async: true` compiles to a promise-returning validator: a conforming
  // answer used to be refused (a promise is never `=== true`) and a
  // non-conforming one ended the process on an unhandled rejection.
  const async = forcedRequest({ $async: true, type: 'object', required: ['city'] });
  assert.equal(parseBackendOutput(async, '{"city":"Seoul"}').toolCalls[0].arguments, '{"city":"Seoul"}');
  assert.equal(parseBackendOutput(async, '{"town":"Seoul"}').toolCalls[0].arguments, '{"town":"Seoul"}');
  // One request's `$id` must not decide another's verdict.
  const a = schemaRequest({ $id: 'https://example.com/r18', type: 'object', required: ['zzz'] });
  assert.throws(() => parseBackendOutput(a, '{"ok":1}'), (e) => refused(e, /outside the request's JSON schema/));
  const b = schemaRequest({ $ref: 'https://example.com/r18' });
  assert.equal(parseBackendOutput(b, '{"ok":1}').text, '{"ok":1}', 'an unresolvable $ref judges nothing, even after A registered that id');
  const c = schemaRequest({ $id: 'https://example.com/r18', type: 'object', properties: { x: { const: 2 } }, required: ['x'] });
  assert.throws(() => parseBackendOutput(c, '{"x":1}'), (e) => refused(e, /outside the request's JSON schema/), 'a second schema under a taken $id is still judged');
  // The client is promised the runtime's bytes; a constraint judged on the
  // rounded double refused `9007199254740993` against `exclusiveMinimum: 9007199254740992`.
  const big = schemaRequest({ type: 'object', properties: { id: { type: 'integer', exclusiveMinimum: 9007199254740992 } }, required: ['id'] });
  assert.equal(parseBackendOutput(big, '{"id":9007199254740993}').text, '{"id":9007199254740993}');
  // CONTROL: an exact number under the same schema is still judged.
  assert.throws(() => parseBackendOutput(big, '{"id":5}'), (e) => refused(e, /outside the request's JSON schema/));
});

test('r18: a schema without a JSON format is not enforced, and the normalizers no longer produce that pair (F2)', () => {
  const stray = { ...schemaRequest(WEATHER_SCHEMA), jsonMode: false };
  assert.equal(parseBackendOutput(stray, 'hello world prose').text, 'hello world prose');
  assert.equal(textMayBeRefused(stray), false, 'and the gates agree: nothing to hold');
});

test('row 8: arguments outside the forced tool\'s schema are refused; conforming ones pass', () => {
  assert.throws(() => parseBackendOutput(forcedRequest(), '{"city":1}'), (e) => refused(e, /outside the tool's schema/));
  assert.throws(() => parseBackendOutput(forcedRequest(), '{"town":"Seoul"}'), (e) => refused(e, /outside the tool's schema/));
  assert.equal(parseBackendOutput(forcedRequest(), '{"city":"Seoul"}').toolCalls[0].arguments, '{"city":"Seoul"}');
  // CONTROL: a schema Ajv cannot compile judges nothing, so the same answer
  // that the weather schema refuses passes under it — the promise is
  // unverifiable, not broken.
  const uncompilable = { type: 'nonsense' };
  assert.equal(parseBackendOutput(forcedRequest(uncompilable), '{"city":1}').toolCalls[0].arguments, '{"city":1}');
  // CONTROL: no schema at all (a tool declared without one) is the same.
  const schemaless = { ...forcedRequest(), tools: [{ name: 'get_weather' }] };
  assert.equal(parseBackendOutput(schemaless, '{"city":1}').toolCalls[0].arguments, '{"city":1}');
});

function schemaRequest(jsonSchema, strict = true) {
  return { model: 'm', shape: 'openai-chat', messages: [], jsonMode: true, jsonSchema, jsonSchemaStrict: strict, tools: [], toolChoice: { type: 'auto' }, raw: {} };
}

test('r18: the schema is enforced only where the client took the promise (codex, `strict`)', () => {
  // The direct OpenAI APIs validate tool arguments and a `json_schema` answer
  // only under `strict: true`; without it the schema is a request to the
  // model. The Messages API's structured output is always exact.
  assert.equal(parseBackendOutput(forcedRequest(WEATHER_SCHEMA, false), '{"city":1}').toolCalls[0].arguments, '{"city":1}', 'non-strict tool: delivered');
  assert.throws(() => parseBackendOutput(forcedRequest(WEATHER_SCHEMA, false), '{"city":"Seo'), (e) => refused(e, /not JSON/), 'non-strict tool: still JSON');
  assert.equal(parseBackendOutput(schemaRequest(WEATHER_SCHEMA, false), '{"city":1}').text, '{"city":1}', 'non-strict json_schema: delivered');
  assert.throws(() => parseBackendOutput(schemaRequest(WEATHER_SCHEMA, false), 'prose'), (e) => refused(e, /not JSON/), 'non-strict json_schema: still JSON');
  const anthropic = { ...schemaRequest(WEATHER_SCHEMA, undefined), jsonSchemaStrict: undefined, shape: 'anthropic-messages' };
  assert.throws(() => parseBackendOutput(anthropic, '{"city":1}'), (e) => refused(e, /outside the request's JSON schema/), 'Messages: exact without a flag');
});

test('row 10: text outside the client\'s json_schema is refused; conforming text passes', () => {
  const request = schemaRequest(WEATHER_SCHEMA);
  assert.throws(() => parseBackendOutput(request, 'Seoul is sunny.'), (e) => refused(e, /not JSON for a request that supplied a JSON schema/));
  assert.throws(() => parseBackendOutput(request, '{"city":1}'), (e) => refused(e, /outside the request's JSON schema/));
  // The proxy's own grammar as the client's answer (matrix §7 row 10).
  assert.throws(() => parseBackendOutput(request, '{"status":"done","text":"Seoul","toolCalls":[]}'), (e) => refused(e, /outside the request's JSON schema/));
  assert.equal(parseBackendOutput(request, '{"city":"Seoul"}').text, '{"city":"Seoul"}');
  // A schema rooted at an array keeps its root: the object rule is
  // `json_object`'s alone, and an array answer under this schema conforms.
  const list = schemaRequest({ type: 'array', items: { type: 'integer' } });
  assert.equal(parseBackendOutput(list, '[1,2,3]').text, '[1,2,3]');
  assert.throws(() => parseBackendOutput(list, '{"0":1}'), (e) => refused(e, /outside the request's JSON schema/));
  // CONTROL: an uncompilable client schema passes everything that is JSON.
  assert.equal(parseBackendOutput(schemaRequest({ type: 'nonsense' }), '{"city":1}').text, '{"city":1}');
  assert.throws(() => parseBackendOutput(schemaRequest({ type: 'nonsense' }), 'prose'), (e) => refused(e, /not JSON/));
});

test('CONTROL: json_object keeps the object rule and nothing more', () => {
  const request = { ...schemaRequest(undefined), jsonSchema: undefined };
  assert.throws(() => parseBackendOutput(request, '[1,2,3]'), (e) => refused(e, /not a JSON object/));
  assert.equal(parseBackendOutput(request, '{"anything":true}').text, '{"anything":true}');
});
