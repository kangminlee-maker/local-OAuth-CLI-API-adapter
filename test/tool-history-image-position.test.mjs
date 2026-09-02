// WHERE a tool result's picture lands in the backend's own item sequence.
//
// A tool turn is an ORDERED SEQUENCE of parts, and each result owns the images
// it returned. The projection claims to emit that sequence position for
// position — but every image of the MESSAGE used to be appended after the whole
// sequence, so this body
//
//   assistant [tool_use c1, tool_use c2]
//   user      [tool_result c1 ("ONE" + picture), text "BETWEEN", tool_result c2 ("TWO")]
//
// reached the model as
//
//   call c1, call c2, output c1, "BETWEEN", output c2, <anonymous input_image>
//
// The picture the FIRST call returned sat behind the SECOND call's output with
// nothing naming its origin — the position-guessing that per-result `images`
// exists to end, reintroduced one level down. `tool-history-images.test.mjs`
// pins the same rule on the claude runtime's content; this pins it where a
// backend actually builds items, on the real `CodexBackendTransport` request
// body. A test that stopped at `NormalizedRequest` saw nothing wrong: the
// normalizer's parts were already in order, and the reordering happened where
// they were read back.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { CodexBackendTransport } from '../dist/proxy/codex-backend-transport.js';
import { normalizeAnthropicMessagesRequest } from '../dist/proxy/normalizers.js';

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
  const dir = await mkdtemp(join(tmpdir(), 'image-position-'));
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

const anthropicRequest = (messages) => normalizeAnthropicMessagesRequest({
  model: 'gpt-5.5',
  max_tokens: 64,
  tools: [{ name: 'get_image', description: 'd', input_schema: { type: 'object', properties: {}, additionalProperties: false } }],
  messages,
});

const imageBlock = (data) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } });
const toolUse = (id) => ({ type: 'tool_use', id, name: 'get_image', input: {} });
const toolResult = (id, ...content) => ({ type: 'tool_result', tool_use_id: id, content });

/** One readable line per item, so a wrong ORDER names itself in the failure. */
const shape = (input) => input.map((item) => {
  if (item.type === 'function_call') return `call:${item.call_id}`;
  if (item.type === 'function_call_output') return `output:${item.call_id}`;
  const parts = (item.content ?? []).map((block) => (
    block.type === 'input_image' || block.type === 'image_url' ? 'IMAGE' : `text(${block.text})`
  ));
  return `message:${item.role}[${parts.join(' ')}]`;
});

/** Every image on the wire, with the item index it arrived in. */
function imagesWithIndex(input) {
  const found = [];
  for (const [index, item] of input.entries()) {
    for (const block of item.content ?? []) {
      if (block.type === 'input_image') found.push({ index, url: block.image_url });
    }
  }
  return found;
}

const captionsOf = (item) => (item.content ?? [])
  .filter((block) => block.type === 'input_text')
  .map((block) => block.text)
  .join('\n');

test("a result's image lands at ITS position, not after the whole tool turn", async () => {
  const input = await upstreamInput(anthropicRequest([
    { role: 'user', content: '두 장을 가져와줘.' },
    { role: 'assistant', content: [toolUse('c1'), toolUse('c2')] },
    {
      role: 'user',
      content: [
        toolResult('c1', { type: 'text', text: 'ONE' }, imageBlock(RED_PIXEL_PNG)),
        { type: 'text', text: 'BETWEEN' },
        toolResult('c2', { type: 'text', text: 'TWO' }),
      ],
    },
  ]));

  const lines = shape(input);
  const images = imagesWithIndex(input);
  assert.equal(images.length, 1, `exactly one picture was sent: ${JSON.stringify(lines)}`);
  assert.ok(images[0].url.includes(RED_PIXEL_PNG), 'and it is the one the tool returned');

  const outputC1 = lines.findIndex((line) => line === 'output:c1');
  const outputC2 = lines.findIndex((line) => line === 'output:c2');
  const between = lines.findIndex((line) => line.includes('text(BETWEEN)'));
  assert.ok(outputC1 >= 0 && outputC2 >= 0 && between >= 0, `all three parts arrived: ${JSON.stringify(lines)}`);

  // The picture answers c1, so it belongs to c1 — before the prose that came
  // after c1's result, and nowhere near c2's output.
  assert.equal(images[0].index, outputC1 + 1, `the picture sits right after c1's output: ${JSON.stringify(lines)}`);
  assert.ok(images[0].index < between, `and before BETWEEN: ${JSON.stringify(lines)}`);
  assert.ok(images[0].index < outputC2, `and before c2's output: ${JSON.stringify(lines)}`);

  // Position alone still leaves a reader counting. The companion says the id.
  const caption = captionsOf(input[images[0].index]);
  assert.ok(caption.includes('tool_call_id: c1'), `the picture names the call it answers: ${caption}`);
  assert.ok(!caption.includes('c2'), `and not the other call: ${caption}`);

  // The rest of the sequence is untouched: BETWEEN and c2's output keep the
  // positions and the ORDER the client gave them.
  assert.ok(between < outputC2, `BETWEEN still precedes c2's output: ${JSON.stringify(lines)}`);
  assert.deepEqual(lines.filter((line) => line.startsWith('call:')), ['call:c1', 'call:c2'], JSON.stringify(lines));
  assert.deepEqual(
    lines.filter((line) => line.startsWith('output:')),
    ['output:c1', 'output:c2'],
    `both calls stay answered, in order: ${JSON.stringify(lines)}`,
  );
});

test('two results each returning a picture keep them apart', async () => {
  const input = await upstreamInput(anthropicRequest([
    { role: 'user', content: '두 장을 가져와줘.' },
    { role: 'assistant', content: [toolUse('c1'), toolUse('c2')] },
    {
      role: 'user',
      content: [
        toolResult('c1', { type: 'text', text: 'ONE' }, imageBlock(RED_PIXEL_PNG)),
        toolResult('c2', { type: 'text', text: 'TWO' }, imageBlock(BLUE_PIXEL_PNG)),
      ],
    },
  ]));

  const lines = shape(input);
  const images = imagesWithIndex(input);
  assert.equal(images.length, 2, `both pictures were sent: ${JSON.stringify(lines)}`);

  const red = images.find((image) => image.url.includes(RED_PIXEL_PNG));
  const blue = images.find((image) => image.url.includes(BLUE_PIXEL_PNG));
  assert.ok(red && blue, `both pictures are identifiable: ${JSON.stringify(lines)}`);

  assert.equal(red.index, lines.indexOf('output:c1') + 1, `red follows c1: ${JSON.stringify(lines)}`);
  assert.equal(blue.index, lines.indexOf('output:c2') + 1, `blue follows c2: ${JSON.stringify(lines)}`);
  assert.ok(red.index < lines.indexOf('output:c2'), `red is not filed behind c2: ${JSON.stringify(lines)}`);

  // Neither is attributed to the other's call.
  const redCaption = captionsOf(input[red.index]);
  const blueCaption = captionsOf(input[blue.index]);
  assert.ok(redCaption.includes('tool_call_id: c1') && !redCaption.includes('c2'), redCaption);
  assert.ok(blueCaption.includes('tool_call_id: c2') && !blueCaption.includes('c1'), blueCaption);
});

test('CONTROL: a result with no picture gains neither an image nor a caption', async () => {
  // The opposite answer from the same harness: without it, "the caption names
  // c1" would also pass if the projection captioned every result on principle.
  const input = await upstreamInput(anthropicRequest([
    { role: 'user', content: '하나만.' },
    { role: 'assistant', content: [toolUse('c1')] },
    { role: 'user', content: [toolResult('c1', { type: 'text', text: 'ONE' })] },
  ]));

  const lines = shape(input);
  assert.equal(imagesWithIndex(input).length, 0, `nothing to send: ${JSON.stringify(lines)}`);
  assert.ok(!JSON.stringify(input).includes('tool_call_id: c1'), `no caption without a picture: ${JSON.stringify(lines)}`);
  assert.deepEqual(lines.filter((line) => line.startsWith('output:')), ['output:c1'], JSON.stringify(lines));
});

test('CONTROL: a message-level picture with no tool parts is still an ordinary message', async () => {
  // Nothing owns this one, so nothing may claim it: an unowned picture that
  // arrived captioned would be attributing it to a call that never ran.
  const input = await upstreamInput(anthropicRequest([
    { role: 'user', content: [{ type: 'text', text: 'LOOK' }, imageBlock(RED_PIXEL_PNG)] },
  ]));

  const lines = shape(input);
  const images = imagesWithIndex(input);
  assert.equal(images.length, 1, `the picture arrives: ${JSON.stringify(lines)}`);
  assert.ok(images[0].url.includes(RED_PIXEL_PNG), 'and it is the one that was sent');
  assert.equal(input.filter((item) => item.type === 'function_call_output').length, 0, JSON.stringify(lines));
  assert.ok(!JSON.stringify(input).includes('tool_call_id'), `and it names no call: ${JSON.stringify(lines)}`);
});

test("CONTROL: a lone result's picture is beside it, and one picture is sent once", async () => {
  // The single-result turn is where "append everything at the end" and "emit it
  // at the result's position" agree, so it proves the fix did not move the
  // simple case — and, because the message-level list and the result's list
  // hold the SAME picture, that the fix did not send it twice either.
  const input = await upstreamInput(anthropicRequest([
    { role: 'user', content: '하나만.' },
    { role: 'assistant', content: [toolUse('c1')] },
    { role: 'user', content: [toolResult('c1', { type: 'text', text: 'ONE' }, imageBlock(RED_PIXEL_PNG))] },
  ]));

  const lines = shape(input);
  const images = imagesWithIndex(input);
  assert.equal(images.length, 1, `sent once, not once per list: ${JSON.stringify(lines)}`);
  assert.equal(images[0].index, lines.indexOf('output:c1') + 1, JSON.stringify(lines));
  assert.ok(captionsOf(input[images[0].index]).includes('tool_call_id: c1'), JSON.stringify(lines));
});

test("a picture the MESSAGE carried, not a result, still arrives after the turn", async () => {
  // The turn records no part for a bare image block, so the sequence has no
  // position to give it — it keeps the one it has always had, after the tool
  // items, and stays anonymous because no result returned it.
  const input = await upstreamInput(anthropicRequest([
    { role: 'user', content: '하나만.' },
    { role: 'assistant', content: [toolUse('c1')] },
    {
      role: 'user',
      content: [toolResult('c1', { type: 'text', text: 'ONE' }, imageBlock(RED_PIXEL_PNG)), imageBlock(BLUE_PIXEL_PNG)],
    },
  ]));

  const lines = shape(input);
  const images = imagesWithIndex(input);
  assert.equal(images.length, 2, `both pictures arrive exactly once: ${JSON.stringify(lines)}`);

  const red = images.find((image) => image.url.includes(RED_PIXEL_PNG));
  const blue = images.find((image) => image.url.includes(BLUE_PIXEL_PNG));
  assert.ok(red && blue, JSON.stringify(lines));
  assert.equal(red.index, lines.indexOf('output:c1') + 1, `the result's own picture sits with it: ${JSON.stringify(lines)}`);
  assert.equal(blue.index, input.length - 1, `the message's own picture follows the turn: ${JSON.stringify(lines)}`);
  assert.ok(captionsOf(input[red.index]).includes('tool_call_id: c1'), JSON.stringify(lines));
  assert.equal(captionsOf(input[blue.index]), '', `and the unowned one claims no call: ${JSON.stringify(lines)}`);
});
