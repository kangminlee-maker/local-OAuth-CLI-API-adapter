import { readFile } from 'node:fs/promises';
import type { Sharp } from 'sharp';
import type { NormalizedImage, OpenAiGeneratedImage, OpenAiImageGenerationRequest } from './types.js';
import { ProxyRequestError } from './types.js';

/**
 * Realizes, on the returned bytes, the Images API options that a transport
 * has no slot for. The default `codex-backend` transport sends every option on
 * the `image_generation` tool and needs only `realizeRequestedSize` (the one
 * slot the backend has been seen not to honour); the diagnostic `app-server`
 * transport starts a Codex turn with the prompt and the attached images only,
 * so `size`, `output_format`, `output_compression`, `background` and `mask`
 * would otherwise be accepted, echoed, and never applied.
 *
 * What is realized, in order: the `mask` (the generated image replaces the
 * source where the mask is transparent, the source is kept where it is
 * opaque — the direct API's semantics), then `size` (the canvas the caller
 * asked for, covered), then `background: opaque` (alpha flattened onto white),
 * then `output_format` with `output_compression` as the codec quality. A
 * request that asks for none of these returns the bytes untouched, undecoded.
 * `moderation` and `input_fidelity` have nothing to realize; the transport
 * answers `input_fidelity` and `background: transparent` as the backend's
 * image model does.
 */
export interface PreparedImageRealization {
  readonly sourceBytes?: Buffer;
  readonly maskBytes?: Buffer;
}

/**
 * Everything the realization needs from the CALLER is checked here, before
 * the transport starts a turn: a mask or source that cannot be read (a remote
 * URL, a file id) or cannot be decoded is the caller's 400 now, not a 500
 * after a billed generation that an SDK would then retry.
 */
export async function prepareImageRealization(
  request: OpenAiImageGenerationRequest,
): Promise<PreparedImageRealization> {
  if (!request.mask) return {};
  const source = request.images[0];
  if (!source) throw new ProxyRequestError('an edit with a mask carries no source image', 400);
  const sharp = await loadSharp();
  const decodable = async (bytes: Buffer, field: string): Promise<Buffer> => {
    try {
      await sharp(bytes).metadata();
    } catch {
      throw new ProxyRequestError(`${field} is not a decodable image.`, 400, 'openai', 'invalid_request_error', field);
    }
    return bytes;
  };
  return {
    sourceBytes: await decodable(await imageBytes(source, 'image'), 'image'),
    maskBytes: await decodable(await imageBytes(request.mask, 'mask'), 'mask'),
  };
}

export async function realizeImageOptions(
  request: OpenAiImageGenerationRequest,
  image: OpenAiGeneratedImage,
  prepared: PreparedImageRealization = {},
): Promise<OpenAiGeneratedImage> {
  const size = requestedSize(request.size);
  const format = request.outputFormat === 'jpeg' || request.outputFormat === 'webp' ? request.outputFormat : 'png';
  const flatten = request.background === 'opaque' || format === 'jpeg';
  const needsWork = Boolean(request.mask) || size !== null || format !== 'png' || request.background === 'opaque';
  if (!needsWork) return image;

  // Loaded here, not at module load: the codec is needed only on this
  // transport and only for a request that asks for one of these options, and
  // the rest of the runtime must not depend on it being resolvable.
  const sharp = await loadSharp();
  let pipeline = sharp(Buffer.from(image.b64Json, 'base64'));
  if (request.mask) {
    const { sourceBytes, maskBytes } = Object.keys(prepared).length > 0
      ? prepared
      : await prepareImageRealization(request);
    if (!sourceBytes || !maskBytes) throw new Error('an edit with a mask carries no source image');
    pipeline = await compositeThroughMask(sharp, pipeline, sourceBytes, maskBytes);
  }
  if (size) pipeline = pipeline.resize(size.width, size.height, { fit: 'cover' });
  if (flatten) pipeline = pipeline.flatten({ background: '#ffffff' });
  const encoded = encodeAs(pipeline, format, clampQuality(request.outputCompression));
  return { ...image, b64Json: (await encoded.toBuffer()).toString('base64') };
}

/**
 * The default `codex-backend` transport sends `size` on the tool slot, and the
 * backend does not always honour it: an edit of a 256×256 source asked for
 * `1024x1024` came back 1254×1254 (measured 2026-08-29). The direct API
 * returns the requested canvas and echoes it, so a returned canvas that
 * differs is brought to it here — covered, re-encoded in the codec it came
 * back in (with `output_compression` as the quality, as the tool was told).
 * A request with no concrete size, a canvas already at it, or bytes the
 * codec cannot read (there is nothing to realize on those, and the caller is
 * better served by the backend's bytes than by a failure after a billed turn)
 * come back untouched.
 */
export async function realizeRequestedSize(
  request: OpenAiImageGenerationRequest,
  image: OpenAiGeneratedImage,
): Promise<OpenAiGeneratedImage> {
  const size = requestedSize(request.size);
  if (!size) return image;
  const sharp = await loadSharp();
  const bytes = Buffer.from(image.b64Json, 'base64');
  let format: string | undefined;
  let width: number | undefined;
  let height: number | undefined;
  try {
    ({ format, width, height } = await sharp(bytes).metadata());
  } catch {
    return image;
  }
  if (width === size.width && height === size.height) return image;
  const pipeline = sharp(bytes).resize(size.width, size.height, { fit: 'cover' });
  const encoded = encodeAs(pipeline, format === 'jpeg' || format === 'webp' ? format : 'png', clampQuality(request.outputCompression));
  try {
    return { ...image, b64Json: (await encoded.toBuffer()).toString('base64') };
  } catch {
    // A header the codec could read over pixels it could not decode.
    return image;
  }
}

/**
 * Whether `realizeRequestedSize` will need the codec for this request, checked
 * BEFORE the transport starts a turn: a codec that cannot load (a platform
 * without a prebuilt binary, a broken install) is the operator's 500 now, not
 * a failure after a billed generation — the same rule `prepareImageRealization`
 * applies to the caller's bytes on the app-server transport.
 */
export async function prepareRequestedSize(
  request: OpenAiImageGenerationRequest,
  load: () => Promise<unknown> = loadSharp,
): Promise<void> {
  if (!requestedSize(request.size)) return;
  try {
    await load();
  } catch (err) {
    throw new ProxyRequestError(
      `The image codec (sharp) could not be loaded, and a request with a concrete size needs it to hold the canvas it asked for: ${err instanceof Error ? err.message : String(err)}`,
      500,
      'openai',
      'server_error',
    );
  }
}

function encodeAs(pipeline: Sharp, format: 'png' | 'jpeg' | 'webp', quality: number): Sharp {
  return format === 'jpeg'
    ? pipeline.jpeg({ quality })
    : format === 'webp'
      ? pipeline.webp({ quality })
      : pipeline.png();
}

// The generated image is laid over the source through the mask: where the
// mask is transparent the generated pixels show, where it is opaque the
// source's do, with the mask's alpha as the blend. Everything is brought to
// the source's dimensions first — the direct API requires the mask to match
// the source, and the generator returns whatever canvas it returns.
type SharpFactory = typeof import('sharp').default;

async function loadSharp(): Promise<SharpFactory> {
  const mod = await import('sharp');
  return mod.default;
}

async function compositeThroughMask(
  sharp: SharpFactory,
  generated: Sharp,
  sourceBytes: Buffer,
  maskBytes: Buffer,
): Promise<Sharp> {
  const source = await sharp(sourceBytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = source.info;
  const gen = await generated.resize(width, height, { fit: 'fill' }).ensureAlpha().raw().toBuffer();
  const mask = await sharp(maskBytes).resize(width, height, { fit: 'fill', kernel: 'nearest' }).ensureAlpha().raw().toBuffer();
  const out = Buffer.alloc(width * height * 4);
  for (let i = 0; i < out.length; i += 4) {
    const keep = mask[i + 3] / 255;
    for (let c = 0; c < 4; c += 1) {
      out[i + c] = Math.round(gen[i + c] * (1 - keep) + source.data[i + c] * keep);
    }
  }
  return sharp(out, { raw: { width, height, channels: 4 } });
}

async function imageBytes(image: NormalizedImage, field: string): Promise<Buffer> {
  const { source } = image;
  if (source.type === 'base64') return Buffer.from(source.data, 'base64');
  if (source.type === 'path') return readFile(source.path);
  if (source.type === 'url' && source.url.startsWith('data:')) {
    const comma = source.url.indexOf(',');
    return Buffer.from(source.url.slice(comma + 1), 'base64');
  }
  // The proxy runtime makes no outbound requests of its own (a remote image
  // URL is handed to the backend, which fetches it), so a mask composite that
  // needs the bytes locally cannot start from a remote URL.
  throw new ProxyRequestError(
    source.type === 'url'
      ? `The app-server image transport composites a mask from a data URL, base64 or local path source; a remote image URL for '${field}' cannot be fetched by the proxy.`
      : `file_id image sources are not supported by the app-server image transport; use a data URL, base64, or local path source for '${field}'.`,
    400,
    'openai',
    'invalid_request_error',
    field,
  );
}

function requestedSize(size: string | undefined): { width: number; height: number } | null {
  if (!size || size === 'auto') return null;
  const match = /^(\d+)x(\d+)$/.exec(size);
  if (!match) return null;
  return { width: Number(match[1]), height: Number(match[2]) };
}

// `output_compression` is 0-100 on the API; the codecs take 1-100.
function clampQuality(compression: number | undefined): number {
  if (compression === undefined) return 100;
  return Math.min(100, Math.max(1, Math.round(compression)));
}
