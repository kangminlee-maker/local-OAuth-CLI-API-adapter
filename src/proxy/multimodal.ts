import { TOOL_RESULT_MARKER } from './tool-history-markers.js';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { ProxyRequestError } from './types.js';
import type {
  NormalizedImage,
  NormalizedImageDetail,
  NormalizedMessage,
  NormalizedRequest,
} from './types.js';

export interface PreparedCodexInput {
  readonly input: readonly unknown[];
  cleanup(): Promise<void>;
}

export function requestImages(request: NormalizedRequest): readonly NormalizedImage[] {
  return request.messages.flatMap((message) => message.images ?? []);
}

export function hasImageInputs(request: NormalizedRequest): boolean {
  return requestImages(request).length > 0;
}

export function unsupportedImageFileIds(request: NormalizedRequest): readonly string[] {
  return requestImages(request)
    .map((image) => image.source)
    .filter((source): source is { type: 'file_id'; fileId: string } => source.type === 'file_id')
    .map((source) => source.fileId);
}

export async function prepareCodexInput(
  request: NormalizedRequest,
  prompt: string,
): Promise<PreparedCodexInput> {
  const tempDirs: string[] = [];
  const input: unknown[] = [];

  // An image that answers a tool call says so here too. This was the third
  // writer of a hoisted picture and the only one left without the caption: the
  // claude runtime and the codex transport both name the call a picture answers,
  // while this path put every picture ahead of one flattened prompt with nothing
  // saying where any of them came from — the position-matching described above
  // this file's labeller, still happening on this route. The label is that
  // labeller's, not a fourth grammar written here.
  for (const message of request.messages) {
    const labels = toolResultImageLabels(message);
    // `images` is optional on the shape callers build by hand.
    for (const image of message.images ?? []) {
      const label = labels.get(image);
      if (label) input.push(codexTextInput(label));
      input.push(await codexImageInput(image, tempDirs));
    }
  }
  input.push(codexTextInput(prompt));

  return {
    input,
    async cleanup() {
      await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    },
  };
}

export async function claudeMessageContentFor(
  request: NormalizedRequest,
  prompt: string,
): Promise<readonly unknown[]> {
  const content: unknown[] = [];
  for (const message of request.messages) {
    // `images` is optional on the shape callers build by hand.
    const images = message.images ?? [];
    if (images.length === 0) continue;
    const labels = toolResultImageLabels(message);
    for (const image of images) {
      const label = labels.get(image);
      if (label) content.push({ type: 'text', text: label });
      content.push(await claudeImageBlock(image));
    }
  }
  content.push({ type: 'text', text: prompt });
  return content;
}

/**
 * What each image is called, keyed on the image itself.
 *
 * The value is the whole caption LINE, not the bare call id: two backends now
 * write a caption from this map — the claude runtime into its prompt content,
 * the codex transport beside the `function_call_output` the picture answers —
 * and a grammar with two writers is a grammar that drifts. One writer, here.
 *
 * An image that answers a tool call says so. Every image used to be hoisted
 * ahead of one flattened prompt with nothing naming its origin, so a turn whose
 * two tool results each returned a picture left the model to match them by
 * position — and "what colour was the second one" was answered by ordering
 * luck. Now that tools stay available for a whole conversation, that shape is
 * ordinary rather than exotic.
 *
 * Which is why the label comes from the image's OWN result. Reading the first
 * result's call id for every image in the message put both of a parallel turn's
 * pictures under the first call: the same position-matching, restored by the
 * fix meant to end it. And the count is within that result too — "1 of 2" means
 * the second of the two pictures THIS call returned.
 *
 * From the turn's structure, not from its text: reading the flattened prompt
 * back is what let a tool's own output forge a result boundary.
 */
export function toolResultImageLabels(message: NormalizedMessage): Map<NormalizedImage, string> {
  const labels = new Map<NormalizedImage, string>();
  for (const part of message.tool?.parts ?? []) {
    if (part.kind !== 'result') continue;
    const images = part.result.images ?? [];
    for (const [index, image] of images.entries()) {
      const which = images.length > 1 ? ` (${index + 1} of ${images.length})` : '';
      labels.set(image, `${TOOL_RESULT_MARKER} image for tool_call_id: ${part.result.callId}${which}`);
    }
  }
  return labels;
}

function codexTextInput(text: string): unknown {
  return {
    type: 'text',
    text,
    text_elements: [],
  };
}

async function codexImageInput(
  image: NormalizedImage,
  tempDirs: string[],
): Promise<unknown> {
  const detail = codexImageDetail(image.detail);
  if (image.source.type === 'url') {
    return {
      type: 'image',
      ...(detail ? { detail } : {}),
      url: image.source.url,
    };
  }
  if (image.source.type === 'path') {
    return {
      type: 'localImage',
      ...(detail ? { detail } : {}),
      path: image.source.path,
    };
  }
  if (image.source.type === 'base64') {
    const dir = await mkdtemp(join(tmpdir(), 'oauth-cli-image-'));
    tempDirs.push(dir);
    const path = join(dir, `image${extensionForMediaType(image.source.mediaType)}`);
    await writeFile(path, decodeBase64Image(image.source.data));
    return {
      type: 'localImage',
      ...(detail ? { detail } : {}),
      path,
    };
  }
  // A request the proxy cannot serve is the caller's problem, not the server's:
  // the codex-backend transport already rejects this as a 400, and an SDK
  // retries a 500 it should not.
  throw new ProxyRequestError(
    'file_id image sources are not supported by local CLI backends',
    400,
    'openai',
    'invalid_request_error',
    'image',
  );
}

async function claudeImageBlock(image: NormalizedImage): Promise<unknown> {
  if (image.source.type === 'url') {
    return {
      type: 'image',
      source: {
        type: 'url',
        url: image.source.url,
      },
    };
  }
  if (image.source.type === 'base64') {
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: image.source.mediaType,
        data: image.source.data,
      },
    };
  }
  if (image.source.type === 'path') {
    const data = await readFile(image.source.path, 'base64');
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: image.source.mediaType ?? mediaTypeForPath(image.source.path),
        data,
      },
    };
  }
  throw new Error('file_id image sources are not supported by local CLI backends');
}

function decodeBase64Image(value: string): Buffer {
  return Buffer.from(value.replace(/\s/g, ''), 'base64');
}

function codexImageDetail(detail: NormalizedImageDetail | undefined): 'high' | 'original' | undefined {
  return detail === 'high' || detail === 'original' ? detail : undefined;
}

function extensionForMediaType(mediaType: string): string {
  if (mediaType === 'image/jpeg') return '.jpg';
  if (mediaType === 'image/webp') return '.webp';
  if (mediaType === 'image/gif') return '.gif';
  return '.png';
}

function mediaTypeForPath(path: string): string {
  const ext = extname(path).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/png';
}
