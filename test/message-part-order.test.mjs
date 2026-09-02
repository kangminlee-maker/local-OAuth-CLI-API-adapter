// A message's content is an ORDERED SEQUENCE, and every backend gets that order.
//
// `content` was "all the text, joined" and `images` was "the pictures,
// collected", so the order BETWEEN text and pictures inside one message was
// gone before any backend saw it. Measured on the real `CodexBackendTransport`
// request body — the client's blocks on the left, what reached the model on the
// right:
//
//   chat      content [image, text "WHATIS"]   ->   "WHATIS"  IMG
//   responses input   [image, text "WHATIS"]   ->   "WHATIS"  IMG
//   messages  content [image, text "WHATIS"]   ->   "WHATIS"  IMG
//   chat CONTROL      [text, image]            ->   "WHATIS"  IMG   (right by luck)
//
// A client who shows a picture and then asks about it had the question
// delivered ahead of the picture. With captions the pairing was destroyed
// outright: `["THIS_IS_A", <red>, "THIS_IS_B", <blue>]` arrived as
// `"THIS_IS_A\n\nTHIS_IS_B"  IMG  IMG` — two captions merged into one block with
// both pictures behind them, so the model could only match them by position.
// That is the position-matching the tool-result labels exist to end, arriving
// one level up, on ordinary content blocks.
//
// The three shapes are asserted separately because they read their blocks in
// three different functions, and the CONTROL row is here because `[text, image]`
// was already right — a fix that only moved pictures to the front would pass
// every "the picture arrives" assertion and break this one.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { CodexBackendTransport } from '../dist/proxy/codex-backend-transport.js';
import { buildPrompt } from '../dist/proxy/backend-contract.js';
import { claudeMessageContentFor } from '../dist/proxy/multimodal.js';
import {
  normalizeAnthropicMessagesRequest,
  normalizeOpenAiChatRequest,
  normalizeOpenAiResponsesRequest,
} from '../dist/proxy/normalizers.js';

const RED = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const BLUE = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

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
  const dir = await mkdtemp(join(tmpdir(), 'part-order-'));
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

/**
 * Every content block of the whole request in wire order, one readable token
 * each, so a wrong ORDER names itself in the failure. A picture is named by the
 * data it carries, because "an image arrived" would pass with the wrong one.
 */
const blocks = (input) => input.flatMap((item) => (item.content ?? []).map((block) => {
  if (block.type !== 'input_image' && block.type !== 'output_image') return `text(${block.text})`;
  const url = block.image_url ?? '';
  if (url.includes(RED)) return 'IMG(red)';
  if (url.includes(BLUE)) return 'IMG(blue)';
  return 'IMG(?)';
}));

const anthImage = (data) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } });
const chatImage = (data) => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${data}` } });
const respImage = (data) => ({ type: 'input_image', image_url: `data:image/png;base64,${data}` });

const chat = (content) => normalizeOpenAiChatRequest({ model: 'gpt-5.5', messages: [{ role: 'user', content }] });
const responses = (content) => normalizeOpenAiResponsesRequest({ model: 'gpt-5.5', input: [{ role: 'user', content }] });
const messages = (content) => normalizeAnthropicMessagesRequest({ model: 'gpt-5.5', max_tokens: 64, messages: [{ role: 'user', content }] });

test('a picture sent BEFORE the question reaches the model before it — chat', async () => {
  const input = await upstreamInput(chat([chatImage(RED), { type: 'text', text: 'WHATIS' }]));
  assert.deepEqual(blocks(input), ['IMG(red)', 'text(WHATIS)'], JSON.stringify(blocks(input)));
});

test('a picture sent BEFORE the question reaches the model before it — responses', async () => {
  const input = await upstreamInput(responses([respImage(RED), { type: 'input_text', text: 'WHATIS' }]));
  assert.deepEqual(blocks(input), ['IMG(red)', 'text(WHATIS)'], JSON.stringify(blocks(input)));
});

test('a picture sent BEFORE the question reaches the model before it — messages', async () => {
  const input = await upstreamInput(messages([anthImage(RED), { type: 'text', text: 'WHATIS' }]));
  assert.deepEqual(blocks(input), ['IMG(red)', 'text(WHATIS)'], JSON.stringify(blocks(input)));
});

test('CONTROL: the question BEFORE the picture still arrives that way round', async () => {
  // This row was already right, by coincidence rather than by rule: the old
  // projection put all the text first. A "fix" that simply hoisted pictures
  // would satisfy the three rows above and break this one.
  for (const [label, request] of [
    ['chat', chat([{ type: 'text', text: 'WHATIS' }, chatImage(RED)])],
    ['responses', responses([{ type: 'input_text', text: 'WHATIS' }, respImage(RED)])],
    ['messages', messages([{ type: 'text', text: 'WHATIS' }, anthImage(RED)])],
  ]) {
    const input = await upstreamInput(request);
    assert.deepEqual(blocks(input), ['text(WHATIS)', 'IMG(red)'], `${label}: ${JSON.stringify(blocks(input))}`);
  }
});

test('two captioned pictures each keep the caption they were sent with', async () => {
  // The pairing case. Merged into `"THIS_IS_A\n\nTHIS_IS_B"  IMG  IMG`, nothing
  // said which caption named which picture — the model could only match them by
  // position, which is the failure the tool-result labels exist to end.
  for (const [label, request] of [
    ['messages', messages([
      { type: 'text', text: 'THIS_IS_A' },
      anthImage(RED),
      { type: 'text', text: 'THIS_IS_B' },
      anthImage(BLUE),
    ])],
    ['chat', chat([
      { type: 'text', text: 'THIS_IS_A' },
      chatImage(RED),
      { type: 'text', text: 'THIS_IS_B' },
      chatImage(BLUE),
    ])],
    ['responses', responses([
      { type: 'input_text', text: 'THIS_IS_A' },
      respImage(RED),
      { type: 'input_text', text: 'THIS_IS_B' },
      respImage(BLUE),
    ])],
  ]) {
    const input = await upstreamInput(request);
    assert.deepEqual(
      blocks(input),
      ['text(THIS_IS_A)', 'IMG(red)', 'text(THIS_IS_B)', 'IMG(blue)'],
      `${label}: ${JSON.stringify(blocks(input))}`,
    );
  }
});

test('CONTROL: a message with no pictures is one text block, joined as it always was', async () => {
  // The separator is the one each shape's `content` string uses — `\n` inside an
  // OpenAI content array, `\n\n` between Anthropic blocks. A sequence that
  // joined its runs its own way would rewrite messages that have no picture in
  // them at all, which is most of them.
  for (const [label, request, expected] of [
    ['chat', chat([{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }]), 'text(A\nB)'],
    ['responses', responses([{ type: 'input_text', text: 'A' }, { type: 'input_text', text: 'B' }]), 'text(A\nB)'],
    ['messages', messages([{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }]), 'text(A\n\nB)'],
    ['chat string', chat('PLAIN'), 'text(PLAIN)'],
  ]) {
    const input = await upstreamInput(request);
    assert.deepEqual(blocks(input), [expected], `${label}: ${JSON.stringify(blocks(input))}`);
  }
});

test('CONTROL: a message that is nothing but a picture is nothing but a picture', async () => {
  for (const [label, request] of [
    ['chat', chat([chatImage(RED)])],
    ['responses', responses([respImage(RED)])],
    ['messages', messages([anthImage(RED)])],
  ]) {
    const input = await upstreamInput(request);
    assert.deepEqual(blocks(input), ['IMG(red)'], `${label}: ${JSON.stringify(blocks(input))}`);
  }
});

test('CONTROL: a whole conversation with no pictures is unchanged, turn for turn', async () => {
  const input = await upstreamInput(normalizeAnthropicMessagesRequest({
    model: 'gpt-5.5',
    max_tokens: 64,
    messages: [
      { role: 'user', content: 'Q1' },
      { role: 'assistant', content: 'A1' },
      { role: 'user', content: 'Q2' },
    ],
  }));
  assert.deepEqual(blocks(input), ['text(Q1)', 'text(A1)', 'text(Q2)'], JSON.stringify(blocks(input)));
});

test('the sequence and the tool turn are ONE array, so they cannot disagree', () => {
  // `tool` is still the provenance signal — presence means a call or a result —
  // and it now holds the very array the message carries. Two arrays built
  // separately would be two orders waiting to drift apart.
  const { messages: normalized } = normalizeOpenAiChatRequest({
    model: 'gpt-5.5',
    messages: [
      { role: 'user', content: [chatImage(RED), { type: 'text', text: 'WHATIS' }] },
      {
        role: 'assistant',
        content: 'let me check',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'f', arguments: '{}' } }],
      },
    ],
  });
  const [user, assistant] = normalized;

  assert.equal(user.tool, undefined, 'an ordinary picture message is not tool history');
  assert.deepEqual(user.parts.map((part) => part.kind), ['image', 'text'], 'and it records the order it was sent in');
  assert.equal(user.parts[0].image, user.images[0], 'the sequence places the very picture the message lists');

  assert.ok(assistant.tool, 'a turn with a call is tool history');
  assert.equal(assistant.tool.parts, assistant.parts, "and its parts ARE the message's sequence, not a copy");
});

test('the Claude runtime names each picture where its sender put it', async () => {
  // That runtime cannot interleave pictures with prose — every picture is
  // hoisted ahead of one prompt — so the `[image N]` reference line is the only
  // thing that can say where a picture sat. Every reference used to be emitted
  // at the head of the message, ahead of all of its text, so a caption written
  // before its picture was rendered after it.
  const request = messages([
    { type: 'text', text: 'THIS_IS_A' },
    anthImage(RED),
    { type: 'text', text: 'THIS_IS_B' },
    anthImage(BLUE),
  ]);
  const prompt = buildPrompt(request);
  const body = prompt.slice(prompt.indexOf('<user>'));
  assert.match(
    body,
    /THIS_IS_A\n\[image 1\][^\n]*\nTHIS_IS_B\n\[image 2\]/,
    `each caption precedes its own picture: ${JSON.stringify(body)}`,
  );

  const content = await claudeMessageContentFor(request, prompt);
  assert.deepEqual(
    content.map((block) => (block.type === 'image' ? `IMG(${block.source.data === RED ? 'red' : 'blue'})` : 'PROMPT')),
    ['IMG(red)', 'IMG(blue)', 'PROMPT'],
    'the pictures still arrive in the order they were sent, ahead of the prompt',
  );
});

test('CONTROL: a Claude prompt for a message with no pictures is unchanged', () => {
  const prompt = buildPrompt(normalizeAnthropicMessagesRequest({
    model: 'gpt-5.5',
    max_tokens: 64,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }] }],
  }));
  assert.ok(prompt.endsWith('<user>\nA\n\nB\n</user>'), JSON.stringify(prompt));
  assert.ok(!prompt.includes('[image'), 'and it says nothing about pictures');
});

// --- Naming a picture the runtime cannot place inline -----------------------
//
// Two runtimes (the claude CLI and the codex app-server) take one flat list of
// pictures and one prompt string, so nothing in the prompt can BE a picture —
// only name one. That makes the `[image N]` placeholder load-bearing, and it was
// counted over the wrong array: `formatImageReference` numbered from
// `message.images` while `prepareCodexInput` walks a request-global
// concatenation, so a two-turn conversation with one picture in each user
// message put `[image 1]` on both of them. Measured before the fix:
//
//   prompt labels : ["[image 1] so", "[image 1] so"]   <- two DIFFERENT pictures
//   images in the request: 2
//
// The second half is the same file's own rule applied to its third writer: a
// picture that answers a tool call says which call, and this path hoisted every
// tool-result picture with no caption at all while the other two writers had
// been given one.
import { prepareCodexInput } from '../dist/proxy/multimodal.js';

const anthTool = {
  name: 'get_image',
  description: 'd',
  input_schema: { type: 'object', properties: {}, additionalProperties: false },
};
const toolUseBlock = (id) => ({ type: 'tool_use', id, name: 'get_image', input: {} });
const conversation = (msgs, extra = {}) => normalizeAnthropicMessagesRequest({
  model: 'gpt-5.5',
  max_tokens: 64,
  messages: msgs,
  ...extra,
});

/** The placeholder lines the prompt carries, in prompt order. */
const promptLabels = (prompt) => [...prompt.matchAll(/\[image \d+\]/g)].map((match) => match[0]);

/** What the codex runtime is actually handed, one readable token per item. */
async function codexItems(request, options) {
  const prepared = await prepareCodexInput(request, buildPrompt(request, options));
  try {
    return prepared.input.map((item) => {
      if (item.type !== 'text') return `${item.type}`;
      return `text(${item.text.split('\n')[0].slice(0, 40)})`;
    });
  } finally {
    await prepared.cleanup();
  }
}

test('two turns with one picture each do not both call it "[image 1]"', async () => {
  const request = conversation([
    { role: 'user', content: [{ type: 'text', text: 'FIRST' }, anthImage(RED)] },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: [{ type: 'text', text: 'SECOND' }, anthImage(BLUE)] },
  ]);
  const labels = promptLabels(buildPrompt(request));
  assert.deepEqual(labels, ['[image 1]', '[image 2]'], `two pictures, two names: ${JSON.stringify(labels)}`);
  assert.equal(new Set(labels).size, labels.length, 'and the names are distinct');

  // The number has to mean the position in the list the runtime is handed, so
  // both hoisting walks are checked, not just the one that produced the bug.
  const content = await claudeMessageContentFor(request, buildPrompt(request));
  assert.deepEqual(
    content.filter((block) => block.type === 'image').map((block) => block.source.data),
    [RED, BLUE],
    'the claude runtime receives them in the order the placeholders number',
  );
  const prepared = await prepareCodexInput(request, buildPrompt(request));
  try {
    assert.equal(
      prepared.input.filter((item) => item.type !== 'text').length,
      2,
      'and the codex runtime receives exactly the two the prompt names',
    );
  } finally {
    await prepared.cleanup();
  }
});

test('CONTROL: two pictures in ONE turn are still 1 and 2', async () => {
  // The case that was already right. A fix that made the number global by
  // restarting it somewhere else would break this without touching the row above.
  const labels = promptLabels(buildPrompt(conversation([
    { role: 'user', content: [{ type: 'text', text: 'A' }, anthImage(RED), { type: 'text', text: 'B' }, anthImage(BLUE)] },
  ])));
  assert.deepEqual(labels, ['[image 1]', '[image 2]'], JSON.stringify(labels));
});

test('CONTROL: a single picture is "[image 1]", wherever its turn sits', async () => {
  // The opposite answer for the offset: if the count leaked across turns that
  // carry no picture, a late turn's only picture would be numbered above 1.
  const labels = promptLabels(buildPrompt(conversation([
    { role: 'user', content: 'Q1' },
    { role: 'assistant', content: 'A1' },
    { role: 'user', content: [{ type: 'text', text: 'Q2' }, anthImage(RED)] },
  ])));
  assert.deepEqual(labels, ['[image 1]'], JSON.stringify(labels));
});

test('dropping the instruction turns from the prompt does not renumber the pictures', async () => {
  // `codex-app-server-backend` builds its prompt with those turns removed and
  // then hoists over the UNFILTERED message list. A count that ran over the
  // filtered list would agree only while no instruction turn preceded a picture.
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'FIRST' }, anthImage(RED)] },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: [{ type: 'text', text: 'SECOND' }, anthImage(BLUE)] },
  ];
  const request = normalizeAnthropicMessagesRequest({
    model: 'gpt-5.5',
    max_tokens: 64,
    system: 'be terse',
    messages,
  });
  assert.deepEqual(
    promptLabels(buildPrompt(request, { includeInstructionMessages: false })),
    ['[image 1]', '[image 2]'],
    'the same numbers the unfiltered prompt uses',
  );
  assert.deepEqual(promptLabels(buildPrompt(request)), ['[image 1]', '[image 2]']);
});

test('a tool-result picture names its call on the codex input path too', async () => {
  // The third writer of a hoisted picture, and the one that had no caption: a
  // picture arrived ahead of the prompt with nothing saying which call returned
  // it, which is the position-matching the labels exist to end.
  const items = await codexItems(conversation([
    { role: 'user', content: 'go' },
    { role: 'assistant', content: [toolUseBlock('c1')] },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'c1', content: [{ type: 'text', text: 'ONE' }, anthImage(RED)] }],
    },
  ], { tools: [anthTool] }));
  assert.equal(items[0], 'text([tool result] image for tool_call_id: c1)', JSON.stringify(items));
  assert.equal(items[1], 'localImage', `the caption comes immediately before its picture: ${JSON.stringify(items)}`);
});

test('two results each returning a picture caption them apart on the codex path', async () => {
  const items = await codexItems(conversation([
    { role: 'user', content: 'go' },
    { role: 'assistant', content: [toolUseBlock('c1'), toolUseBlock('c2')] },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'c1', content: [{ type: 'text', text: 'ONE' }, anthImage(RED)] },
        { type: 'tool_result', tool_use_id: 'c2', content: [{ type: 'text', text: 'TWO' }, anthImage(BLUE)] },
      ],
    },
  ], { tools: [anthTool] }));
  assert.equal(items[0], 'text([tool result] image for tool_call_id: c1)', JSON.stringify(items));
  assert.equal(items[1], 'localImage', JSON.stringify(items));
  assert.equal(items[2], 'text([tool result] image for tool_call_id: c2)', JSON.stringify(items));
  assert.equal(items[3], 'localImage', JSON.stringify(items));
});

test('CONTROL: a picture that answers no call is captioned by nobody', async () => {
  // Without this the row above would also pass if the path captioned every
  // hoisted picture on principle — which would attribute an ordinary picture to
  // a call that never ran.
  const items = await codexItems(conversation([
    { role: 'user', content: [{ type: 'text', text: 'LOOK' }, anthImage(RED)] },
  ]));
  assert.deepEqual(items.map((item) => (item === 'localImage' ? 'IMG' : 'TEXT')), ['IMG', 'TEXT'], JSON.stringify(items));
  assert.ok(!items.some((item) => item.includes('tool_call_id')), `no call is named: ${JSON.stringify(items)}`);
});

test('CONTROL: a request with no pictures hands the runtime the prompt and nothing else', async () => {
  const items = await codexItems(conversation([{ role: 'user', content: 'PLAIN' }]));
  assert.equal(items.length, 1, JSON.stringify(items));
  assert.ok(items[0].startsWith('text('), JSON.stringify(items));
});
