import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  image2QualityToGpt55ReasoningEffort,
  image2ViaGpt55Prompt,
  image2ViaGpt55PromptFromRequest,
} from '../dist/proxy/image2-via-gpt55.js';

test('Images quality maps to gpt-5.5 reasoning effort — the whole documented table', () => {
  // Every cell of the direct API's set (`standard`/`hd` were dall-e aliases;
  // the direct API refuses them now, and so does the request parser).
  for (const [quality, effort] of [
    ['low', 'low'],
    ['medium', 'medium'],
    ['high', 'high'],
    ['auto', 'high'],
    [undefined, 'high'],
  ]) {
    assert.equal(image2QualityToGpt55ReasoningEffort(quality), effort,
      `${quality ?? 'omitted'} must map to ${effort}`);
  }
});

// Nothing in the prompt builder reads the caller's prompt any more. The rules
// that did — square/circle/centered geometry, "no text", "white background",
// flat/solid/vector styling, colour-replacement and background-only edit
// preservation — fired on regexes over the caller's own words, matched no
// Images API field, and were the reason the image benchmark's sentence drew
// twelve lines of constraints while an ordinary prompt drew one.
test('image2_via_gpt55 passes the benchmark sentence through verbatim', () => {
  const prompt = 'A simple flat red square centered on a white background. No text.';
  assert.equal(image2ViaGpt55Prompt({ prompt }), prompt);
  assert.equal(image2ViaGpt55Prompt({ prompt: `  ${prompt}\n` }), prompt, 'whitespace-trimmed only');
});

test('image2_via_gpt55 passes an edit prompt through verbatim, options and all', () => {
  const prompt = 'Change only the white background to uniform pale blue. Keep the red square unchanged. No text.';
  const translated = image2ViaGpt55PromptFromRequest({
    operation: 'edit',
    model: 'gpt-image-1',
    prompt,
    n: 1,
    images: [{ source: { type: 'url', url: 'https://example.com/red.png' }, raw: {} }],
    mask: { source: { type: 'url', url: 'https://example.com/mask.png' }, raw: {} },
    size: '1024x1536',
    quality: 'low',
    background: 'opaque',
    moderation: 'low',
    inputFidelity: 'high',
    stream: false,
    partialImages: 0,
    raw: {},
  });
  // `size`, `quality`, `background`, `moderation`, `input_fidelity` and `mask`
  // ride on the image_generation tool payload (`codexBackendImageGenerationTool`);
  // none of them is restated here.
  assert.equal(translated, prompt);
});

test('image2_via_gpt55 applies proxy image route hints without rewriting intent', () => {
  const prompt = image2ViaGpt55Prompt({
    prompt: 'Create a simple flat circular badge: teal outer circle, white inner circle, and one small orange star in the center. No text.',
    proxyRoute: {
      visualClass: 'badge_or_emblem',
      outputFormat: 'webp',
      outputCompression: 95,
      geometryMode: 'strict',
    },
  });

  assert.match(prompt, /Original Images API prompt:/);
  assert.match(prompt, /teal outer circle, white inner circle, and one small orange star/);
  assert.match(prompt, /visual_class=badge_or_emblem/);
  assert.match(prompt, /full badge inside the canvas with visible margin/);
  assert.match(prompt, /outer shape visually distinct from the background/);
  assert.match(prompt, /geometry_mode=strict/);
  assert.match(prompt, /exact requested geometry/);
  // The route's `output_format` / `output_compression` are resolved into the
  // request's standard fields and sent on the tool payload, not restated here;
  // and nothing about "circular", "centered" or "no text" is added either.
  assert.doesNotMatch(prompt, /webp|95|keep it circular|centered in the frame|Do not render any letters/);
});

test('image2_via_gpt55 adds the route translation only when a route hint translates to something', () => {
  const prompt = 'A teal circle. No text.';
  const withRoute = image2ViaGpt55Prompt({ prompt, proxyRoute: { geometryMode: 'strict' } });
  assert.match(withRoute, /Original Images API prompt:\nA teal circle\. No text\./);
  assert.match(withRoute, /geometry_mode=strict/);
  // A route object that translates to nothing is no route at all — no header,
  // no preamble promising constraints that do not follow.
  assert.equal(image2ViaGpt55Prompt({ prompt, proxyRoute: { geometryMode: 'auto' } }), prompt);
  assert.equal(image2ViaGpt55Prompt({ prompt, proxyRoute: { outputFormat: 'png' } }), prompt);
});
