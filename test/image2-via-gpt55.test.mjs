import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  image2QualityToGpt55ReasoningEffort,
  image2ViaGpt55Prompt,
  image2ViaGpt55PromptFromRequest,
} from '../dist/proxy/image2-via-gpt55.js';

test('image-2 quality maps to gpt-5.5 reasoning effort — the whole documented table', () => {
  // Every documented cell, because a one-cell regression (standard->high, the
  // defect this table caught) survives spot checks.
  for (const [quality, effort] of [
    ['low', 'low'],
    ['medium', 'medium'],
    ['standard', 'medium'],
    ['high', 'high'],
    ['hd', 'high'],
    ['auto', 'high'],
    [undefined, 'high'],
  ]) {
    assert.equal(image2QualityToGpt55ReasoningEffort(quality), effort,
      `${quality ?? 'omitted'} must map to ${effort}`);
  }
});

test('image2_via_gpt55 prompt preserves square geometry on portrait canvas', () => {
  const prompt = image2ViaGpt55Prompt({
    action: 'generate',
    prompt: 'A simple flat red square centered on a white background. No text.',
    size: '1024x1536',
    quality: 'medium',
    outputFormat: 'webp',
    outputCompression: 80,
    background: 'opaque',
  });

  assert.match(prompt, /Original Images API prompt:/);
  assert.match(prompt, /A simple flat red square centered on a white background\. No text\./);
  assert.match(prompt, /portrait canvas matching 1024x1536/);
  assert.match(prompt, /do not stretch or deform/);
  assert.match(prompt, /true 1:1 square, not a rectangle/);
  assert.match(prompt, /equal pixel width and height/);
  assert.match(prompt, /centered at \(512, 768\)/);
  assert.match(prompt, /appropriate vertical margins/);
  assert.match(prompt, /Reject any vertical bar, tall rectangle, stretched square/);
  assert.match(prompt, /uniform color regions and crisp edges/);
  assert.match(prompt, /single uniform tone/);
  assert.match(prompt, /no internal shading/);
  assert.match(prompt, /do not add vignette/);
  assert.match(prompt, /Avoid depth cues/);
  assert.doesNotMatch(prompt, /CSS\/SVG test pattern/);
  assert.doesNotMatch(prompt, /#ff0000/);
  assert.doesNotMatch(prompt, /#ffffff/);
  assert.match(prompt, /uniformly pure white/);
  assert.match(prompt, /avoid off-white tinting, vignettes, gradients/);
  assert.match(prompt, /Do not render any letters/);
});

test('image2_via_gpt55 does not inset square format prompts on square canvas', () => {
  const prompt = image2ViaGpt55Prompt({
    action: 'generate',
    prompt: 'A clean square launch poster with a solid dark navy background. Text says LAUNCH DAY. No extra text.',
    size: '1024x1024',
    quality: 'medium',
    outputFormat: 'png',
  });

  assert.match(prompt, /Original Images API prompt:/);
  assert.match(prompt, /A clean square launch poster/);
  assert.match(prompt, /true 1:1 square, not a rectangle/);
  assert.doesNotMatch(prompt, /about 635x635px/);
  assert.doesNotMatch(prompt, /Leave about 195px/);
  assert.doesNotMatch(prompt, /use background margins around it as needed/);
});

test('image2_via_gpt55 prompt makes edit preservation explicit', () => {
  const prompt = image2ViaGpt55Prompt({
    action: 'edit',
    prompt: 'Edit this image so the red square becomes green. No text.',
    size: '1024x1024',
    quality: 'low',
    outputFormat: 'png',
    inputFidelity: 'high',
    imageCount: 1,
  });

  assert.match(prompt, /This is an edit request/);
  assert.match(prompt, /first 1 attached image is the source image/);
  assert.match(prompt, /preserve the source image canvas, subject size, position, background, margins, and composition/);
  assert.match(prompt, /Treat non-target regions as locked/);
  assert.match(prompt, /Apply only the requested visual change/);
  assert.match(prompt, /do not crop, zoom, repaint the whole frame/);
  assert.match(prompt, /replace the entire target object or color region/);
  assert.match(prompt, /do not leave visible remnants of the original target color/);
  assert.match(prompt, /never turn the original target color into a new background field or border/);
  assert.match(prompt, /single uniform flat fill with crisp edges/);
  assert.match(prompt, /Use high input fidelity/);
  assert.match(prompt, /Do not render any letters/);
});

test('image2_via_gpt55 prompt tightens flat reference style transfer', () => {
  const prompt = image2ViaGpt55Prompt({
    action: 'generate',
    prompt: 'Use the attached reference image to create a new flat vector icon. No text.',
    size: '1024x1024',
    quality: 'medium',
    outputFormat: 'png',
    imageCount: 1,
  });

  assert.match(prompt, /uniform color regions and crisp edges/);
  assert.match(prompt, /attached images are style references/);
  assert.match(prompt, /hard outlines, simple geometry, palette, margins, and uniform fills/);
  assert.match(prompt, /treat any gradient, shadow, vignette, texture, or soft tonal modeling as a style mismatch/);
});

test('image2_via_gpt55 prompt locks foreground for background-only edits', () => {
  const prompt = image2ViaGpt55Prompt({
    action: 'edit',
    prompt: 'Change only the white background to uniform pale blue. Keep the red square unchanged. No text.',
    size: '1024x1024',
    quality: 'low',
    outputFormat: 'png',
    imageCount: 1,
  });

  assert.match(prompt, /Treat non-target regions as locked/);
  assert.match(prompt, /keep every foreground subject unchanged/);
  assert.match(prompt, /one uniform flat region/);
  assert.match(prompt, /no gradient, vignette, lighting falloff, texture, or soft shading/);
});

test('image2_via_gpt55 prompt applies proxy image route hints without rewriting intent', () => {
  const prompt = image2ViaGpt55Prompt({
    action: 'generate',
    prompt: 'Create a simple flat circular badge: teal outer circle, white inner circle, and one small orange star in the center. No text.',
    size: '1024x1024',
    quality: 'low',
    outputFormat: 'webp',
    outputCompression: 95,
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
  assert.match(prompt, /suitable for webp output/);
  assert.match(prompt, /output_compression=95/);
});

test('image2_via_gpt55 treats image-2 input_fidelity as disabled API surface', () => {
  const prompt = image2ViaGpt55PromptFromRequest({
    operation: 'edit',
    model: 'image-2',
    prompt: 'Edit this image so the red square becomes green. No text.',
    n: 1,
    images: [{ source: { type: 'url', url: 'https://example.com/red.png' }, raw: {} }],
    size: '1024x1024',
    quality: 'low',
    inputFidelity: 'high',
    responseFormat: 'b64_json',
    stream: false,
    partialImages: 0,
    raw: {},
  });

  assert.doesNotMatch(prompt, /Use high input fidelity/);
  assert.match(prompt, /preserve the source image canvas/);
});
