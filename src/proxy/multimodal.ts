import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
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
  for (const image of requestImages(request)) {
    content.push(await claudeImageBlock(image));
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
  throw new Error('file_id image sources are not supported by local CLI backends');
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
