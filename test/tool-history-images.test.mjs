import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeAnthropicMessagesRequest } from '../dist/proxy/normalizers.js';
import { claudeMessageContentFor } from '../dist/proxy/multimodal.js';
import { buildPrompt } from '../dist/proxy/backend-contract.js';

// What a tool turn's IMAGES become on the way to a runtime. The pieces live in
// three modules — the normalizer writes the tool markers, the multimodal
// builder turns images into content blocks, the prompt builder writes the text
// half — so the behaviour only exists where they meet, which is here.

const RED_PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const BLUE_PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function toolResultRequest(results) {
  const messages = [{ role: 'user', content: '이미지를 가져와서 설명해줘.' }];
  for (const [index, result] of results.entries()) {
    const id = `t${index + 1}`;
    messages.push({ role: 'assistant', content: [{ type: 'tool_use', id, name: 'get_image', input: {} }] });
    messages.push({
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: id,
        content: [
          { type: 'text', text: result.text },
          ...result.images.map((data) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } })),
        ],
      }],
    });
  }
  return normalizeAnthropicMessagesRequest({
    model: 'claude-opus-5',
    max_tokens: 100,
    tools: [{ name: 'get_image', description: 'd', input_schema: { type: 'object', properties: {}, additionalProperties: false } }],
    messages,
  });
}

test('an image inside a tool_result reaches the runtime as an image, not as prose', async () => {
  // A consumer reported this as broken and worked around it. It was not: the
  // symptom belonged to the tool channel being closed on the turn AFTER a tool
  // result, so the call that would have fetched the image never went out. This
  // pins the part that was suspected, so the next such report is answered in
  // seconds rather than by reading the pipeline again.
  const request = normalizeAnthropicMessagesRequest({
    model: 'claude-opus-5',
    max_tokens: 100,
    tools: [{ name: 'get_image', description: 'd', input_schema: { type: 'object', properties: {}, additionalProperties: false } }],
    messages: [
      { role: 'user', content: '이미지를 가져와서 색을 말해줘.' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'get_image', input: {} }] },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 't1',
          content: [
            { type: 'text', text: '이미지입니다.' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: RED_PIXEL_PNG } },
          ],
        }],
      },
    ],
  });

  assert.equal(request.messages.at(-1).images.length, 1, 'the tool result carries its image');
  const prompt = buildPrompt(request);
  const content = await claudeMessageContentFor(request, prompt);
  const image = content.find((block) => block.type === 'image');
  assert.ok(image, `no image block reached the runtime: ${JSON.stringify(content).slice(0, 200)}`);
  assert.equal(image.source.data, RED_PIXEL_PNG);
  // The text half names the call the image answers — the marker alone proves
  // nothing, since `buildPrompt` writes it whether or not the image survived.
  assert.match(prompt, /tool_call_id: t1/);
});

test('each tool result names the call its image answers', async () => {
  // Every image used to be hoisted ahead of one flattened prompt with nothing
  // saying where it came from, so two tool results returning a picture each
  // left the model matching them by position — and a follow-up about "the
  // second one" was answered by ordering luck.
  const request = toolResultRequest([
    { text: '첫째', images: [RED_PIXEL_PNG] },
    { text: '둘째', images: [BLUE_PIXEL_PNG] },
  ]);
  const content = await claudeMessageContentFor(request, buildPrompt(request));

  const labelled = [];
  for (const [index, block] of content.entries()) {
    if (block.type !== 'image') continue;
    const before = content[index - 1];
    assert.equal(before?.type, 'text', 'an image must be introduced by the call it answers');
    labelled.push([before.text.match(/tool_call_id: (\S+)/)?.[1], block.source.data]);
  }
  assert.deepEqual(labelled, [['t1', RED_PIXEL_PNG], ['t2', BLUE_PIXEL_PNG]]);
});

/**
 * Parallel results in ONE user message — the shape the helper above cannot make.
 *
 * `toolResultRequest` puts every result in a message of its own, so each
 * message had exactly one result and reading `results[0]` for the whole message
 * was right by accident. A turn answering two parallel calls carries BOTH
 * results, and the labeller then put both pictures under the first call.
 * Measured on `claudeMessageContentFor` before the fix:
 *
 *   image labels    : ["t1 (1 of 2)", "t1 (2 of 2)"]   <- both say t1
 *   results in turn : ["t1", "t2"]                      <- the second answers t2
 *
 * Which is the position-matching the labels exist to end, reintroduced by the
 * fix that ended it. A `results[0]` -> last-result mutant changed both labels
 * and survived the whole suite.
 */
function parallelResultsRequest(results) {
  return normalizeAnthropicMessagesRequest({
    model: 'claude-opus-5',
    max_tokens: 100,
    tools: [{ name: 'get_image', description: 'd', input_schema: { type: 'object', properties: {}, additionalProperties: false } }],
    messages: [
      { role: 'user', content: '두 장을 가져와서 설명해줘.' },
      { role: 'assistant', content: results.map((_result, index) => (
        { type: 'tool_use', id: `t${index + 1}`, name: 'get_image', input: {} }
      )) },
      { role: 'user', content: results.map((result, index) => ({
        type: 'tool_result',
        tool_use_id: `t${index + 1}`,
        content: [
          { type: 'text', text: result.text },
          ...result.images.map((data) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } })),
        ],
      })) },
    ],
  });
}

/** Every image the CLI receives, paired with the label introducing it. */
function labelledImages(content) {
  const pairs = [];
  for (const [index, block] of content.entries()) {
    if (block.type !== 'image') continue;
    const before = content[index - 1];
    const label = before?.type === 'text' && before.text.startsWith('[tool result] image for')
      ? before.text.replace('[tool result] image for tool_call_id: ', '')
      : null;
    pairs.push([label, block.source.data]);
  }
  return pairs;
}

test('parallel tool results in ONE message each label their own image', async () => {
  const request = parallelResultsRequest([
    { text: '빨강', images: [RED_PIXEL_PNG] },
    { text: '파랑', images: [BLUE_PIXEL_PNG] },
  ]);
  const content = await claudeMessageContentFor(request, buildPrompt(request));

  assert.deepEqual(
    labelledImages(content),
    [['t1', RED_PIXEL_PNG], ['t2', BLUE_PIXEL_PNG]],
    'each image must name the call that returned it, not the turn\'s first call',
  );
});

test('parallel results in one message: two pictures each are numbered within their own result', async () => {
  // Both halves of the label at once. Under `results[0]` this read
  // `t1 (1 of 4)` … `t1 (4 of 4)` — one call id and one running count across
  // pictures from two different calls.
  const request = parallelResultsRequest([
    { text: '첫째', images: [RED_PIXEL_PNG, BLUE_PIXEL_PNG] },
    { text: '둘째', images: [BLUE_PIXEL_PNG, RED_PIXEL_PNG] },
  ]);
  const content = await claudeMessageContentFor(request, buildPrompt(request));

  assert.deepEqual(labelledImages(content).map(([label]) => label), [
    't1 (1 of 2)',
    't1 (2 of 2)',
    't2 (1 of 2)',
    't2 (2 of 2)',
  ]);
});

test('CONTROL: an image a tool result never returned carries no label at all', async () => {
  // The opposite answer from the same reader. Without it, "every image is
  // labelled with its own result" would also pass under a labeller that put a
  // call id on every picture in a conversation that has a tool turn anywhere.
  const request = normalizeAnthropicMessagesRequest({
    model: 'claude-opus-5',
    max_tokens: 100,
    tools: [{ name: 'get_image', description: 'd', input_schema: { type: 'object', properties: {}, additionalProperties: false } }],
    messages: [
      { role: 'user', content: [
        { type: 'text', text: '이건 내가 붙인 사진이야.' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: RED_PIXEL_PNG } },
      ] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'get_image', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [
        { type: 'text', text: '도구가 가져온 사진' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: BLUE_PIXEL_PNG } },
      ] }] },
    ],
  });
  const content = await claudeMessageContentFor(request, buildPrompt(request));

  assert.deepEqual(
    labelledImages(content),
    [[null, RED_PIXEL_PNG], ['t1', BLUE_PIXEL_PNG]],
    'the user\'s own picture is not a tool result, and the tool\'s is',
  );
});

test('several images from one tool result are numbered within it', async () => {
  const request = toolResultRequest([{ text: '두 장', images: [RED_PIXEL_PNG, BLUE_PIXEL_PNG] }]);
  const content = await claudeMessageContentFor(request, buildPrompt(request));
  // Only the labels, not the prompt — which embeds the whole conversation and
  // therefore mentions the call id too.
  const labels = content
    .filter((block) => block.type === 'text' && block.text.startsWith('[tool result] image for'))
    .map((block) => block.text);
  assert.deepEqual(labels, [
    '[tool result] image for tool_call_id: t1 (1 of 2)',
    '[tool result] image for tool_call_id: t1 (2 of 2)',
  ]);
});
