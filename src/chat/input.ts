import type { LocalCliChatInputPart, LocalCliChatTurnInput } from './types.js';
import { LocalCliChatError } from './types.js';
import type { NormalizedImage, NormalizedRequest } from '../proxy/types.js';

export function chatPromptText(input: LocalCliChatTurnInput): string {
  return chatInputParts(input)
    .filter((part): part is Extract<LocalCliChatInputPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

export function chatNormalizedRequest(
  input: LocalCliChatTurnInput,
  model: string,
): NormalizedRequest {
  const parts = chatInputParts(input);
  const text = parts
    .filter((part): part is Extract<LocalCliChatInputPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
  const images = parts
    .filter((part): part is Extract<LocalCliChatInputPart, { type: 'image' }> => part.type === 'image')
    .map((part): NormalizedImage => ({
      source: part.source,
      detail: part.detail,
      raw: part,
    }));
  if (!text.trim() && images.length === 0) {
    throw new LocalCliChatError('turn input must include text or image content.');
  }
  return {
    shape: 'openai-chat',
    model,
    messages: [{
      role: 'user',
      content: text,
      images,
    }],
    stream: Boolean(input.stream),
    streamOptions: {
      includeUsage: false,
      includeObfuscation: false,
    },
    jsonMode: false,
    tools: [],
    toolChoice: { type: 'auto' },
    raw: input,
  };
}

export function chatInputParts(input: LocalCliChatTurnInput): readonly LocalCliChatInputPart[] {
  if (typeof input.input === 'string') {
    return [{ type: 'text', text: input.input }];
  }
  if (!Array.isArray(input.input)) {
    throw new LocalCliChatError('turn input must be a string or an array of input parts.');
  }
  return input.input.map(normalizePart);
}

function normalizePart(part: LocalCliChatInputPart): LocalCliChatInputPart {
  if (!part || typeof part !== 'object') {
    throw new LocalCliChatError('turn input parts must be objects.');
  }
  if (part.type === 'text') {
    if (typeof part.text !== 'string') throw new LocalCliChatError('text input part requires a text string.');
    return { type: 'text', text: part.text };
  }
  if (part.type === 'image') {
    if (!part.source || typeof part.source !== 'object') {
      throw new LocalCliChatError('image input part requires a source object.');
    }
    if (part.source.type === 'file_id') {
      throw new LocalCliChatError('file_id image sources are not supported by local CLI chat sessions.');
    }
    if (part.source.type === 'url' && typeof part.source.url === 'string') return part;
    if (
      part.source.type === 'base64'
      && typeof part.source.mediaType === 'string'
      && typeof part.source.data === 'string'
    ) return part;
    if (part.source.type === 'path' && typeof part.source.path === 'string') return part;
    throw new LocalCliChatError('image source must be url, base64, or path.');
  }
  throw new LocalCliChatError('input part type must be text or image.');
}
