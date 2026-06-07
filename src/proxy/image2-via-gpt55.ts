import type { OpenAiImageGenerationRequest } from './types.js';
import type { NormalizedReasoningEffort } from './types.js';

type Image2ViaGpt55Action = 'generate' | 'edit';

export interface Image2ViaGpt55PromptOptions {
  readonly action: Image2ViaGpt55Action;
  readonly prompt: string;
  readonly size?: string;
  readonly quality?: string;
  readonly outputFormat?: string;
  readonly outputCompression?: number;
  readonly background?: string;
  readonly moderation?: string;
  readonly inputFidelity?: string;
  readonly imageCount?: number;
  readonly hasMask?: boolean;
}

export function image2QualityToGpt55ReasoningEffort(
  quality: string | undefined,
): NormalizedReasoningEffort {
  if (quality === 'low') return 'low';
  if (quality === 'medium') return 'medium';
  return 'high';
}

export function image2ViaGpt55PromptFromRequest(
  request: OpenAiImageGenerationRequest,
): string {
  return image2ViaGpt55Prompt({
    action: request.operation === 'generation' ? 'generate' : 'edit',
    prompt: request.prompt,
    size: request.size,
    quality: request.quality,
    outputFormat: request.outputFormat,
    outputCompression: request.outputCompression,
    background: request.background,
    moderation: request.moderation,
    inputFidelity: request.model === 'image-2' ? undefined : request.inputFidelity,
    imageCount: request.images.length,
    hasMask: Boolean(request.mask),
  });
}

export function image2ViaGpt55Prompt(
  options: Image2ViaGpt55PromptOptions,
): string {
  const prompt = options.prompt.trim();
  const constraints = [
    'Preserve the user prompt exactly as the visual intent; the following constraints only translate Images API options for the image_generation tool.',
    ...canvasConstraints(options.size),
    ...geometryConstraints(prompt, options.size),
    ...backgroundConstraints(options.background),
    ...formatConstraints(options),
    ...editConstraints(options),
    ...flatGraphicConstraints(options),
    ...negativePromptConstraints(prompt),
  ];
  return [
    'Original Images API prompt:',
    prompt,
    '',
    'image2_via_gpt55 translation constraints:',
    ...constraints.map((constraint) => `- ${constraint}`),
  ].join('\n');
}

function canvasConstraints(size: string | undefined): string[] {
  if (!size || size === 'auto') return [];
  const parsed = parseSize(size);
  if (!parsed) return [`Use the requested output size/aspect ratio ${size}.`];
  const orientation = parsed.width === parsed.height
    ? 'square'
    : parsed.width < parsed.height
    ? 'portrait'
    : 'landscape';
  return [
    `Use a ${orientation} canvas matching ${size}.`,
    'Canvas aspect ratio controls the output frame only; do not stretch or deform the requested subject to fill the frame.',
    ...(orientation === 'portrait'
      ? ['For a portrait frame, center the subject with appropriate vertical margins instead of elongating it.']
      : []),
    ...(orientation === 'landscape'
      ? ['For a landscape frame, center the subject with appropriate horizontal margins instead of widening it.']
      : []),
  ];
}

function geometryConstraints(prompt: string, size: string | undefined): string[] {
  const lower = prompt.toLowerCase();
  const constraints: string[] = [];
  if (/\bsquare\b/.test(lower)) {
    constraints.push('If the prompt requests a square, the visible subject must be a true 1:1 square, not a rectangle.');
    const parsed = size && size !== 'auto' ? parseSize(size) : null;
    if (size && size !== 'auto' && shouldConstrainSquareSubject(lower, parsed)) {
      constraints.push('Keep the square shape independent from the canvas aspect ratio; use background margins around it as needed.');
      if (parsed) {
        const side = Math.round(Math.min(parsed.width, parsed.height) * 0.62);
        const horizontalMargin = Math.round((parsed.width - side) / 2);
        const verticalMargin = Math.round((parsed.height - side) / 2);
        constraints.push([
          `For the ${parsed.width}x${parsed.height} canvas, draw the square with equal pixel width and height, about ${side}x${side}px, centered at (${Math.round(parsed.width / 2)}, ${Math.round(parsed.height / 2)}).`,
          `Leave about ${Math.max(0, horizontalMargin)}px side margins and ${Math.max(0, verticalMargin)}px vertical margins.`,
        ].join(' '));
      }
    }
    constraints.push('Reject any vertical bar, tall rectangle, stretched square, or subject whose height differs from its width.');
  }
  if (/\bcircle\b/.test(lower) || /\bround\b/.test(lower)) {
    constraints.push('If the prompt requests a circle or round shape, keep it circular and do not stretch it into an oval.');
  }
  if (/\bcenter(?:ed|)\b/.test(lower)) {
    constraints.push('Keep the primary subject visually centered in the frame.');
  }
  return constraints;
}

function shouldConstrainSquareSubject(
  lowerPrompt: string,
  size: { width: number; height: number } | null,
): boolean {
  if (!size) return true;
  if (size.width !== size.height) return true;
  return !describesSquareFormat(lowerPrompt);
}

function describesSquareFormat(lowerPrompt: string): boolean {
  return /\bsquare\s+(?:(?:\w+)\s+){0,3}(?:poster|canvas|image|background|frame|layout|composition|card|cover|page)\b/.test(lowerPrompt)
    || /\b(?:poster|canvas|image|background|frame|layout|composition|card|cover|page)\s+(?:is\s+|should\s+be\s+|must\s+be\s+)?square\b/.test(lowerPrompt);
}

function backgroundConstraints(background: string | undefined): string[] {
  if (!background || background === 'auto') return [];
  if (background === 'opaque') return ['Use an opaque background; do not introduce transparency.'];
  if (background === 'transparent') return ['Use a transparent background when the output format supports it.'];
  return [`Respect the requested background option: ${background}.`];
}

function formatConstraints(options: Image2ViaGpt55PromptOptions): string[] {
  const constraints: string[] = [];
  if (options.outputFormat) {
    constraints.push(`Prepare output content suitable for ${options.outputFormat} output.`);
  }
  if (options.outputCompression !== undefined) {
    constraints.push(`Preserve visual quality while respecting output_compression=${options.outputCompression}.`);
  }
  if (options.quality) {
    constraints.push(`Honor the requested Images API quality level ${options.quality} without reducing prompt fidelity.`);
  }
  if (options.moderation) {
    constraints.push(`Use moderation=${options.moderation}; do not add safety-related visual elements or text.`);
  }
  return constraints;
}

function editConstraints(options: Image2ViaGpt55PromptOptions): string[] {
  if (options.action !== 'edit') return [];
  return [
    'This is an edit request: preserve the source image canvas, subject size, position, background, margins, and composition unless the prompt explicitly changes them.',
    'Treat non-target regions as locked: keep unchanged colors, edges, geometry, placement, margins, and flatness as close to the source image as possible.',
    ...targetedEditPreservationConstraints(options.prompt),
    ...(options.imageCount
      ? [`The first ${options.imageCount} attached image${options.imageCount === 1 ? ' is the source image' : 's are source images'}; keep source identity and composition unless the prompt asks otherwise.`]
      : []),
    'Apply only the requested visual change; do not crop, zoom, repaint the whole frame, or remove unchanged background regions.',
    ...(options.inputFidelity === 'high'
      ? ['Use high input fidelity: keep source identity and non-target pixels as close as possible.']
      : []),
    ...(options.imageCount && options.imageCount > 1
      ? [`Use all ${options.imageCount} source images only as references required by the prompt; do not ignore or invent extra references.`]
      : []),
    ...(options.hasMask
      ? ['When a mask is provided, the final attached image is the edit mask; constrain edits to the masked region and preserve unmasked pixels.']
      : []),
  ];
}

function targetedEditPreservationConstraints(prompt: string): string[] {
  const lower = prompt.toLowerCase();
  const constraints: string[] = [];
  if (/\bbackground\b/.test(lower) && /\b(change|replace|edit)\b/.test(lower)) {
    constraints.push('For background-only edits, keep every foreground subject unchanged and render the new background as one uniform flat region with no gradient, vignette, lighting falloff, texture, or soft shading.');
  }
  if (describesColorReplacement(lower)) {
    constraints.push('For color replacement edits, replace the entire target object or color region with the requested new color; do not leave visible remnants of the original target color on or around the changed object.');
    constraints.push('Keep surrounding background and non-target regions unchanged; never turn the original target color into a new background field or border unless the prompt explicitly asks for it.');
    constraints.push('If the source is a simple flat shape, keep the edited shape a single uniform flat fill with crisp edges and no mottling, gradient, texture, or partial recoloring.');
  }
  return constraints;
}

function describesColorReplacement(lowerPrompt: string): boolean {
  return /\b(?:change|replace|turn|make|convert|recolor|edit)\b/.test(lowerPrompt)
    && /\b(?:red|green|blue|yellow|orange|purple|pink|black|white|gray|grey|brown|navy|teal|cyan|magenta)\b/.test(lowerPrompt);
}

function negativePromptConstraints(prompt: string): string[] {
  const lower = prompt.toLowerCase();
  const constraints: string[] = [];
  if (/\bno text\b/.test(lower) || /\bwithout text\b/.test(lower)) {
    constraints.push('Do not render any letters, words, captions, logos, watermarks, UI labels, or text-like marks.');
  }
  if (/\bwhite background\b/.test(lower)) {
    constraints.push('Keep the background uniformly pure white unless another explicit instruction overrides it; avoid off-white tinting, vignettes, gradients, texture, or soft background shading.');
  }
  return constraints;
}

function flatGraphicConstraints(options: Image2ViaGpt55PromptOptions): string[] {
  const prompt = options.prompt;
  if (!asksForFlatGraphicPrompt(prompt)) return [];
  const constraints = [
    'If the prompt requests a flat, solid, vector, minimal, or simple graphic style, preserve that style with uniform color regions and crisp edges.',
    'For solid-color subjects, make each fill a single uniform tone with no internal shading, tonal variation, texture, glossy highlight, or painterly softness.',
    'Keep flat backgrounds equally uniform; do not add vignette, depth falloff, studio lighting, or paper/canvas texture.',
    'Avoid depth cues such as bevels, lighting, drop shadows, gradients, texture, material rendering, or soft shading unless the prompt explicitly asks for them.',
  ];
  if (options.imageCount && options.action === 'generate') {
    constraints.push('When attached images are style references for a flat/vector prompt, extract the reference grammar as hard outlines, simple geometry, palette, margins, and uniform fills; do not add plausible lighting, gradients, or soft shading.');
    constraints.push('For flat/vector reference style transfer, treat any gradient, shadow, vignette, texture, or soft tonal modeling as a style mismatch rather than an aesthetic improvement.');
  }
  return constraints;
}

export function asksForFlatGraphicPrompt(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  return /\bflat\b/.test(lower) ||
    /\bsolid\b/.test(lower) ||
    /\bvector\b/.test(lower) ||
    /\bminimal(?:ist|)\b/.test(lower) ||
    /\bsimple (?:icon|shape|graphic|illustration)\b/.test(lower);
}

function parseSize(size: string): { width: number; height: number } | null {
  const match = /^(\d+)x(\d+)$/.exec(size);
  if (!match) return null;
  return {
    width: Number(match[1]),
    height: Number(match[2]),
  };
}
