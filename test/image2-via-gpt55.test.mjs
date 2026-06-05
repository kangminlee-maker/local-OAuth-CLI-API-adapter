import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  image2QualityToGpt55ReasoningEffort,
  image2ViaGpt55Prompt,
  image2ViaGpt55PromptFromRequest,
} from '../dist/proxy/image2-via-gpt55.js';

test('image-2 quality maps to gpt-5.5 reasoning effort', () => {
  assert.equal(image2QualityToGpt55ReasoningEffort(undefined), 'high');
  assert.equal(image2QualityToGpt55ReasoningEffort('high'), 'high');
  assert.equal(image2QualityToGpt55ReasoningEffort('medium'), 'medium');
  assert.equal(image2QualityToGpt55ReasoningEffort('low'), 'low');
  assert.equal(image2QualityToGpt55ReasoningEffort('auto'), 'high');
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
  assert.match(prompt, /Apply only the requested visual change/);
  assert.match(prompt, /do not crop, zoom, repaint the whole frame/);
  assert.match(prompt, /Use high input fidelity/);
  assert.match(prompt, /Do not render any letters/);
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
