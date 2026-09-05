// A message's content is an ORDERED SEQUENCE, and every backend gets that
// order — the last two doors of it.
//
// The first is one level DOWN from the turn. A `tool_result` whose own content
// is `[text, image, text]` was reduced to an `output` string plus a pile of
// pictures, so the words that FOLLOWED the picture were joined to the words
// before it and the picture arrived behind both. Measured on the real
// `CodexBackendTransport` request body:
//
//   client: tool_result(c1, [text "BEFORE_RESULT", <image>, text "AFTER_RESULT"])
//   wire:   out("BEFORE_RESULT\nAFTER_RESULT")   msg["[tool result] imag", IMG]
//                    ^ AFTER_RESULT moved ahead of the image it followed
//
// The second is the two PROMPT backends. `buildPrompt` renders what the claude
// runtime and the codex app-server send, and it routed every tool turn through
// a branch that announced every picture at the head of the turn — while the
// codex transport was already sending the client's order:
//
//   normalized parts : ["result", "text", "image", "text"]
//   codex transport  : out("ONE")  msg["BEFORE_STANDALONE"]  msg[IMG]  msg["AFTER_STANDALONE"]
//   buildPrompt      : "[image 1] source=base6"  "[tool result]"  "BEFORE_STANDALONE"  "AFTER_STANDALONE"
//                       ^ the picture announced before everything, on both prompt backends
//
// One conversation, two backends describing it differently — which is what this
// file asserts against directly: every surface is read into the SAME order
// tokens and compared to the client's own.
//
// `tool-history-image-position.test.mjs` pins where a result's picture lands
// among the TURN's items; this pins where it lands inside ONE result, and what
// the prompt backends do with either.
//
// What the wire cannot do: `function_call_output.output` is a single string, so
// a picture cannot ride inside the answer and neither can the prose that came
// after one. The output carries the result's text up to its first picture; the
// picture and everything after it ride in the companion message that follows.
// The prompt has no such limit — a `[image N]` reference line sits wherever the
// picture sat, inside the result's body.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { CodexBackendTransport } from '../dist/proxy/codex-backend-transport.js';
import { buildPrompt } from '../dist/proxy/backend-contract.js';
import { claudeMessageContentFor } from '../dist/proxy/multimodal.js';
import { normalizeAnthropicMessagesRequest, normalizeOpenAiChatRequest } from '../dist/proxy/normalizers.js';

const RED_PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const BLUE_PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const originalFetch = globalThis.fetch;
const tempDirs = [];

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function jwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.signature`;
}

async function createCodexHome() {
  const dir = await mkdtemp(join(tmpdir(), 'tool-result-inner-order-'));
  tempDirs.push(dir);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'auth.json'), JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: {
      id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'account-1' } }),
      access_token: 'codex-oauth-token',
      refresh_token: 'codex-refresh-token',
      account_id: 'account-1',
    },
    last_refresh: new Date().toISOString(),
  }), { mode: 0o600 });
  return dir;
}

const sse = (events) => events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');

/** The `input` array the DEFAULT Codex transport actually puts on the wire. */
async function upstreamInput(request) {
  const codexHome = await createCodexHome();
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(sse([
      { type: 'response.output_text.delta', delta: 'OK' },
      { type: 'response.completed', response: { id: 'resp_1', model: 'gpt-5.5' } },
    ]), { status: 200 });
  };
  const backend = new CodexBackendTransport({ codexHome, timeoutMs: 30_000, model: 'gpt-5.5' });
  await backend.generate(request);
  await backend.close();
  return JSON.parse(calls[0].init.body).input;
}

const anthTool = {
  name: 'get_image',
  description: 'd',
  input_schema: { type: 'object', properties: {}, additionalProperties: false },
};
const anthImage = (data) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } });
const toolUse = (id) => ({ type: 'tool_use', id, name: 'get_image', input: {} });
const conversation = (messages, extra = {}) => normalizeAnthropicMessagesRequest({
  model: 'gpt-5.5',
  max_tokens: 64,
  tools: [anthTool],
  messages,
  ...extra,
});

/**
 * The ORDER each surface delivers, as one token per ordered thing.
 *
 * The point of the file is that three surfaces agree, so they are read into one
 * alphabet: the caller's own words for prose, `IMG` for a picture wherever it
 * is really a picture, and `IMG_REF` where the surface can only name one.
 * Anything else the surface carries — the marker lines, the call ids, the
 * instructions — is not order and is dropped.
 */
const WORDS = /^(BEFORE_RESULT|AFTER_RESULT|ONE|TWO|BEFORE_STANDALONE|AFTER_STANDALONE|ONLY_TEXT|R1_BEFORE|R1_AFTER|R2_BEFORE|R2_AFTER|A|B)$/;

/** Wire order: the transport's own items, flattened block by block. */
function wireOrder(input) {
  const out = [];
  for (const item of input) {
    if (item.type === 'function_call_output') {
      for (const line of String(item.output).split('\n')) if (WORDS.test(line)) out.push(line);
      continue;
    }
    for (const block of item.content ?? []) {
      if (block.type === 'input_image' || block.type === 'output_image') out.push('IMG');
      else for (const line of String(block.text ?? '').split('\n')) if (WORDS.test(line)) out.push(line);
    }
  }
  return out;
}

/** Prompt order: what a flattened-prompt backend reads, top to bottom. */
function promptOrder(prompt) {
  return prompt
    .split('\n')
    .map((line) => (/^\[image \d+\]/.test(line) ? 'IMG_REF' : line))
    .filter((line) => line === 'IMG_REF' || WORDS.test(line));
}

/** The `[image N]` names the prompt uses, in prompt order. */
const promptLabels = (prompt) => [...prompt.matchAll(/\[image \d+\]/g)].map((match) => match[0]);

/** The turn a prompt ends with, whole — the block this file is about. */
function lastTurn(prompt) {
  const open = prompt.lastIndexOf('<user>');
  return prompt.slice(open);
}

/** What the claude runtime is handed: hoisted pictures, then the prompt. */
async function claudeOrder(request) {
  const content = await claudeMessageContentFor(request, buildPrompt(request));
  return content.map((block) => {
    if (block.type === 'image') return `IMG(${block.source.data === RED_PIXEL_PNG ? 'red' : 'blue'})`;
    return block.text.startsWith('[tool result] image for tool_call_id: ')
      ? `CAPTION(${block.text.replace('[tool result] image for tool_call_id: ', '')})`
      : 'PROMPT';
  });
}

// --- One result's own content ----------------------------------------------

const INNER_ORDER = conversation([
  { role: 'user', content: 'go' },
  { role: 'assistant', content: [toolUse('c1')] },
  {
    role: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: 'c1',
      content: [
        { type: 'text', text: 'BEFORE_RESULT' },
        anthImage(RED_PIXEL_PNG),
        { type: 'text', text: 'AFTER_RESULT' },
      ],
    }],
  },
]);

test("text that FOLLOWED a picture inside one result does not overtake it on the wire", async () => {
  const input = await upstreamInput(INNER_ORDER);

  assert.deepEqual(
    wireOrder(input),
    ['BEFORE_RESULT', 'IMG', 'AFTER_RESULT'],
    'the client wrote text, picture, text',
  );
  // As WHOLE items, because what makes this correct is the split: the output
  // string stops at the picture, and the rest rides in the companion. An
  // assertion that only counted tokens would also pass if the output still
  // carried AFTER_RESULT and the companion repeated it.
  const results = input.filter((item) => item.type === 'function_call_output');
  assert.deepEqual(results, [
    { type: 'function_call_output', call_id: 'c1', output: 'BEFORE_RESULT' },
  ], `the output stops at the picture: ${JSON.stringify(results)}`);
  assert.deepEqual(input.at(-1), {
    type: 'message',
    role: 'user',
    content: [
      { type: 'input_text', text: '[tool result] image for tool_call_id: c1' },
      { type: 'input_image', image_url: `data:image/png;base64,${RED_PIXEL_PNG}` },
      { type: 'input_text', text: 'AFTER_RESULT' },
    ],
  }, `the picture and the words after it ride together: ${JSON.stringify(input.at(-1))}`);
});

test('the prompt backends name the picture inside the result, where it sat', () => {
  const prompt = buildPrompt(INNER_ORDER);

  assert.equal(lastTurn(prompt), [
    '<user>',
    '[tool result]',
    'tool_call_id: c1',
    'BEFORE_RESULT',
    `[image 1] source=base64 media_type=image/png`,
    'AFTER_RESULT',
    '</user>',
  ].join('\n'), JSON.stringify(lastTurn(prompt)));
});

test('the wire and the two prompt backends describe ONE conversation the same way', async () => {
  // The shape this project treats as its most expensive recurring defect: two
  // backends given the same body and told two different stories. Both prompt
  // backends read the SAME string, so `buildPrompt` is where both are settled.
  const expected = ['BEFORE_RESULT', 'IMG', 'AFTER_RESULT'];
  const prompt = buildPrompt(INNER_ORDER);

  assert.deepEqual(wireOrder(await upstreamInput(INNER_ORDER)), expected, 'codex transport');
  assert.deepEqual(
    promptOrder(prompt).map((token) => (token === 'IMG_REF' ? 'IMG' : token)),
    expected,
    'buildPrompt — the claude runtime and the codex app-server',
  );
  // And the reference the prompt writes names a picture the runtime is really
  // handed: the number is a position in that hoisted list, so a prompt that got
  // the position right while the list was empty would say nothing at all.
  assert.deepEqual(promptLabels(prompt), ['[image 1]'], JSON.stringify(promptLabels(prompt)));
  assert.deepEqual(await claudeOrder(INNER_ORDER), ['CAPTION(c1)', 'IMG(red)', 'PROMPT']);
});

test('the openai chat shape has the same door, and it is shut too', async () => {
  // The tool-result content array is the same block list on this shape, read by
  // a different function — a fix in one flattener only is half a fix.
  const request = normalizeOpenAiChatRequest({
    model: 'gpt-5.5',
    messages: [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_image', arguments: '{}' } }] },
      {
        role: 'tool',
        tool_call_id: 'c1',
        content: [
          { type: 'text', text: 'BEFORE_RESULT' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${RED_PIXEL_PNG}` } },
          { type: 'text', text: 'AFTER_RESULT' },
        ],
      },
    ],
    tools: [{ type: 'function', function: { name: 'get_image', description: 'd', parameters: { type: 'object', properties: {} } } }],
  });

  assert.deepEqual(wireOrder(await upstreamInput(request)), ['BEFORE_RESULT', 'IMG', 'AFTER_RESULT']);
  assert.deepEqual(
    promptOrder(buildPrompt(request)),
    ['BEFORE_RESULT', 'IMG_REF', 'AFTER_RESULT'],
  );
});

// --- The turn's own sequence, on the prompt backends ------------------------

const TURN_ORDER = conversation([
  { role: 'user', content: 'go' },
  { role: 'assistant', content: [toolUse('c1')] },
  {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'c1', content: [{ type: 'text', text: 'ONE' }] },
      { type: 'text', text: 'BEFORE_STANDALONE' },
      anthImage(RED_PIXEL_PNG),
      { type: 'text', text: 'AFTER_STANDALONE' },
    ],
  },
]);

test('a standalone picture in a tool turn is named where it sat, not at the head', async () => {
  const prompt = buildPrompt(TURN_ORDER);

  assert.equal(lastTurn(prompt), [
    '<user>',
    '[tool result]',
    'tool_call_id: c1',
    'ONE',
    '',
    'BEFORE_STANDALONE',
    '',
    '[image 1] source=base64 media_type=image/png',
    '',
    'AFTER_STANDALONE',
    '</user>',
  ].join('\n'), JSON.stringify(lastTurn(prompt)));

  // The transport already sent this order. The prompt now agrees with it.
  assert.deepEqual(
    wireOrder(await upstreamInput(TURN_ORDER)),
    ['ONE', 'BEFORE_STANDALONE', 'IMG', 'AFTER_STANDALONE'],
  );
  assert.deepEqual(
    promptOrder(prompt).map((token) => (token === 'IMG_REF' ? 'IMG' : token)),
    ['ONE', 'BEFORE_STANDALONE', 'IMG', 'AFTER_STANDALONE'],
  );
});

test('an assistant turn carrying both pictures and calls renders its calls in place', () => {
  // The walk renders a `call` part with the grammar's own writer, so a turn
  // that carries pictures AND calls keeps them in the client's order rather
  // than announcing every picture first.
  //
  // The turn's blocks are a blank line apart here, which is what the Anthropic
  // shape's `content` already used between them. The OpenAI chat shape renders
  // its own `content` with a single newline between two consecutive calls, so
  // for THIS shape — an assistant turn carrying pictures and two or more calls
  // — the prompt gains one blank line the image-free rendering does not have.
  // Measured, deliberate, and the two shapes agree with each other; nothing
  // moves and nothing is dropped.
  const parts = [
    { type: 'text', text: 'A' },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${RED_PIXEL_PNG}` } },
  ];
  const request = normalizeOpenAiChatRequest({
    model: 'gpt-5.5',
    messages: [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: parts,
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } },
          { id: 'c2', type: 'function', function: { name: 'g', arguments: '{}' } },
        ],
      },
    ],
    tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object', properties: {} } } }],
  });
  const prompt = buildPrompt(request);

  assert.equal(prompt.slice(prompt.lastIndexOf('<assistant>')), [
    '<assistant>',
    'A',
    '',
    '[image 1] source=base64 media_type=image/png',
    '',
    '[assistant tool_call]',
    'id: c1',
    'name: f',
    'arguments: {}',
    '',
    '[assistant tool_call]',
    'id: c2',
    'name: g',
    'arguments: {}',
    '</assistant>',
  ].join('\n'), JSON.stringify(prompt.slice(prompt.lastIndexOf('<assistant>'))));
});

// --- Controls: the opposite answer ------------------------------------------

test('CONTROL: a result with text only is byte for byte what it always was', async () => {
  const request = conversation([
    { role: 'user', content: 'go' },
    { role: 'assistant', content: [toolUse('c1')] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: [{ type: 'text', text: 'ONLY_TEXT' }] }] },
  ]);

  assert.deepEqual(
    (await upstreamInput(request)).filter((item) => item.type === 'function_call_output'),
    [{ type: 'function_call_output', call_id: 'c1', output: 'ONLY_TEXT' }],
    'the whole output still goes in the output field when nothing splits it',
  );
  const prompt = buildPrompt(request);
  assert.equal(lastTurn(prompt), '<user>\n[tool result]\ntool_call_id: c1\nONLY_TEXT\n</user>', JSON.stringify(lastTurn(prompt)));
  assert.ok(!prompt.includes('[image'), 'and it says nothing about pictures');
});

test('CONTROL: a result with an image only still sends an output field to pair with', async () => {
  // The opposite answer for the split: with no text before the picture the
  // output is empty, and it must still be SENT — the call it answers is
  // unanswered without it, which is a 400 from this API.
  const request = conversation([
    { role: 'user', content: 'go' },
    { role: 'assistant', content: [toolUse('c1')] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: [anthImage(RED_PIXEL_PNG)] }] },
  ]);
  const input = await upstreamInput(request);

  assert.deepEqual(
    input.filter((item) => item.type === 'function_call_output'),
    [{ type: 'function_call_output', call_id: 'c1', output: '' }],
  );
  assert.deepEqual(input.at(-1), {
    type: 'message',
    role: 'user',
    content: [
      { type: 'input_text', text: '[tool result] image for tool_call_id: c1' },
      { type: 'input_image', image_url: `data:image/png;base64,${RED_PIXEL_PNG}` },
    ],
  }, JSON.stringify(input.at(-1)));
  assert.equal(
    lastTurn(buildPrompt(request)),
    '<user>\n[tool result]\ntool_call_id: c1\n[image 1] source=base64 media_type=image/png\n</user>',
  );
});

test('CONTROL: a message with no tool parts renders exactly as it did', async () => {
  // The path this change must not touch. A walk that started rendering markers
  // for every message would put tool grammar in an ordinary turn.
  const request = conversation([
    { role: 'user', content: [{ type: 'text', text: 'A' }, anthImage(RED_PIXEL_PNG), { type: 'text', text: 'B' }] },
  ]);
  const prompt = buildPrompt(request);

  assert.equal(
    lastTurn(prompt),
    '<user>\nA\n[image 1] source=base64 media_type=image/png\nB\n</user>',
    JSON.stringify(lastTurn(prompt)),
  );
  assert.ok(!prompt.includes('[tool result]'), 'no tool grammar in a turn that ran no tool');
  assert.deepEqual(wireOrder(await upstreamInput(request)), ['A', 'IMG', 'B']);
});

test('CONTROL: two results with a picture each keep two distinct numbers, in order', async () => {
  // A fix that placed the reference correctly but renumbered from the result
  // would call both of them `[image 1]` — two different pictures, one name.
  const request = conversation([
    { role: 'user', content: 'go' },
    { role: 'assistant', content: [toolUse('c1'), toolUse('c2')] },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'c1', content: [{ type: 'text', text: 'R1_BEFORE' }, anthImage(RED_PIXEL_PNG), { type: 'text', text: 'R1_AFTER' }] },
        { type: 'tool_result', tool_use_id: 'c2', content: [{ type: 'text', text: 'R2_BEFORE' }, anthImage(BLUE_PIXEL_PNG), { type: 'text', text: 'R2_AFTER' }] },
      ],
    },
  ]);
  const prompt = buildPrompt(request);

  const labels = promptLabels(prompt);
  assert.deepEqual(labels, ['[image 1]', '[image 2]'], JSON.stringify(labels));
  assert.equal(new Set(labels).size, labels.length, 'and the names are distinct');
  assert.equal(lastTurn(prompt), [
    '<user>',
    '[tool result]',
    'tool_call_id: c1',
    'R1_BEFORE',
    '[image 1] source=base64 media_type=image/png',
    'R1_AFTER',
    '',
    '[tool result]',
    'tool_call_id: c2',
    'R2_BEFORE',
    '[image 2] source=base64 media_type=image/png',
    'R2_AFTER',
    '</user>',
  ].join('\n'), JSON.stringify(lastTurn(prompt)));

  // The numbers name positions in the list the runtime is really handed.
  assert.deepEqual(await claudeOrder(request), ['CAPTION(c1)', 'IMG(red)', 'CAPTION(c2)', 'IMG(blue)', 'PROMPT']);
  assert.deepEqual(
    wireOrder(await upstreamInput(request)),
    ['R1_BEFORE', 'IMG', 'R1_AFTER', 'R2_BEFORE', 'IMG', 'R2_AFTER'],
  );
});
