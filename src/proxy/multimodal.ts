import { TOOL_RESULT_MARKER } from './tool-history-markers.js';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { ProxyRequestError } from './types.js';
import type {
  NormalizedImage,
  NormalizedImageDetail,
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

  for (const image of requestImages(request)) {
    input.push(await codexImageInput(image, tempDirs));
  }
  input.push({
    type: 'text',
    text: prompt,
    text_elements: [],
  });

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
    // An image that answers a tool call says so. Every image used to be hoisted
    // ahead of one flattened prompt with nothing naming its origin, so a turn
    // whose two tool results each returned a picture left the model to match
    // them by position — and "what colour was the second one" was answered by
    // ordering luck. Now that tools stay available for a whole conversation,
    // that shape is ordinary rather than exotic.
    // From the turn's structure, not from its text: reading the flattened
    // prompt back is what let a tool's own output forge a result boundary.
    const callId = message.tool?.results[0]?.callId ?? null;
    for (const [index, image] of images.entries()) {
      if (callId) {
        const which = images.length > 1 ? ` (${index + 1} of ${images.length})` : '';
        content.push({ type: 'text', text: `${TOOL_RESULT_MARKER} image for tool_call_id: ${callId}${which}` });
      }
      content.push(await claudeImageBlock(image));
    }
  }
  content.push({ type: 'text', text: prompt });
  return content;
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
