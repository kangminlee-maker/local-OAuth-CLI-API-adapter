import type {
  NormalizedReasoningEffort,
  OpenAiImageGenerationRequest,
  OpenAiImageProxyRoute,
} from './types.js';

export interface Image2ViaGpt55PromptOptions {
  readonly prompt: string;
  readonly proxyRoute?: OpenAiImageProxyRoute;
}

export function image2QualityToGpt55ReasoningEffort(
  quality: string | undefined,
): NormalizedReasoningEffort {
  // `low`, `medium`, `high`, `auto` — the direct API's own set (the dall-e
  // aliases `standard`/`hd` are refused at the door since 2026-08-30, as the
  // direct API refuses them). `auto` and an omitted quality run at high.
  if (quality === 'low') return 'low';
  if (quality === 'medium') return 'medium';
  return 'high';
}

export function image2ViaGpt55PromptFromRequest(
  request: OpenAiImageGenerationRequest,
): string {
  return image2ViaGpt55Prompt({
    prompt: request.prompt,
    proxyRoute: request.proxyRoute,
  });
}

/**
 * The caller's prompt, verbatim, plus the translation of the one Images API
 * option that has no slot on the backend tool: the proxy-only
 * `x_proxy_image_route` hint. Every standard option (`size`, `quality`,
 * `output_format`, `output_compression`, `background`, `moderation`,
 * `input_fidelity`, `mask`) is SENT on the `image_generation` tool payload
 * (`codexBackendImageGenerationTool` in `codex-backend-transport.ts`) and is
 * not described here — saying a field in prose as well as in the field is the
 * adapter talking to the model about a request it has already made
 * structurally, and the prose is the half that drifts.
 *
 * Nothing here reads the caller's prompt. The rules that used to — squares,
 * circles, "no text", "white background", flat/solid/vector styling, colour
 * replacement on edits — fired on regexes over the caller's own words, matched
 * no Images API field, and steered the image rather than translating a request.
 * Without a route hint the prompt goes through untouched.
 */
export function image2ViaGpt55Prompt(
  options: Image2ViaGpt55PromptOptions,
): string {
  const prompt = options.prompt.trim();
  const constraints = proxyRouteConstraints(options.proxyRoute);
  if (constraints.length === 0) return prompt;
  return [
    'Original Images API prompt:',
    prompt,
    '',
    'image2_via_gpt55 translation constraints:',
    '- Preserve the user prompt exactly as the visual intent; the following constraints only translate Images API options for the image_generation tool.',
    ...constraints.map((constraint) => `- ${constraint}`),
  ].join('\n');
}

function proxyRouteConstraints(route: OpenAiImageProxyRoute | undefined): string[] {
  if (!route) return [];
  return [
    ...visualClassConstraints(route.visualClass),
    ...geometryModeConstraints(route.geometryMode),
  ];
}

function visualClassConstraints(
  visualClass: OpenAiImageProxyRoute['visualClass'] | undefined,
): string[] {
  if (!visualClass) return [];
  switch (visualClass) {
    case 'primitive_flat_shape':
      return [
        'Proxy route visual_class=primitive_flat_shape: treat the request as exact flat primitive geometry, not an illustration.',
        'Use uniform fills, crisp edges, plain background, and the minimum number of shapes needed to satisfy the prompt.',
      ];
    case 'geometric_icon':
      return [
        'Proxy route visual_class=geometric_icon: treat the request as a precise flat icon made from simple geometric shapes.',
        'When the prompt names a primitive shape such as circle, semicircle, square, rectangle, star, or line, keep that primitive exact and avoid decorative substitutions.',
        'Do not add waves, scallops, rays, badges, outlines, or extra marks unless the prompt explicitly asks for them.',
      ];
    case 'badge_or_emblem':
      return [
        'Proxy route visual_class=badge_or_emblem: treat the request as a centered flat badge/emblem with clear contained geometry.',
        'Keep the full badge inside the canvas with visible margin; do not crop or let the outer shape touch the frame edge.',
        'Keep the outer shape visually distinct from the background, and keep inner symbols smaller than the containing badge unless the prompt says otherwise.',
      ];
    case 'photoreal_raster':
      return [
        'Proxy route visual_class=photoreal_raster: prioritize a natural photographic raster image with realistic light, material, and camera behavior.',
      ];
    case 'product_identity':
      return [
        'Proxy route visual_class=product_identity: preserve product identity, proportions, brand-like visual consistency, and clean inspection-friendly framing.',
      ];
    case 'reference_or_edit':
      return [
        'Proxy route visual_class=reference_or_edit: use attached images as binding references for identity, composition, style, and unchanged regions.',
      ];
    case 'unknown_hybrid':
      return [
        'Proxy route visual_class=unknown_hybrid: avoid over-specialized assumptions and satisfy explicit prompt requirements conservatively.',
      ];
  }
}

function geometryModeConstraints(
  geometryMode: OpenAiImageProxyRoute['geometryMode'] | undefined,
): string[] {
  if (!geometryMode || geometryMode === 'auto') return [];
  if (geometryMode === 'strict') {
    return [
      'Proxy route geometry_mode=strict: resolve ambiguous terms toward exact requested geometry instead of decorative interpretation.',
      'Keep positions, relative sizes, containment, margins, and named primitive shapes visibly correct.',
    ];
  }
  return [
    'Proxy route geometry_mode=loose: allow natural or stylized geometry when that better fits the prompt, while preserving explicit required objects and colors.',
  ];
}
