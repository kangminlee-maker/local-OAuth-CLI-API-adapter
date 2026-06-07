import { deflateSync, inflateSync } from 'node:zlib';
import { asksForFlatGraphicPrompt } from './image2-via-gpt55.js';
import type {
  OpenAiGeneratedImage,
  OpenAiImageGenerationRequest,
} from './types.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_FLAT_POSTPROCESS_PIXELS = 4_194_304;
const FLAT_REFERENCE_MAX_COLORS = 24;
const BACKGROUND_DISTANCE_SQUARED = 52 * 52;
const EDGE_DISTANCE_SQUARED = 34 * 34;

interface DecodedPng {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
}

interface ColorBin {
  count: number;
  r: number;
  g: number;
  b: number;
}

interface WeightedColor {
  readonly count: number;
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export function postprocessFlatGraphicImageIfNeeded(
  request: OpenAiImageGenerationRequest,
  image: OpenAiGeneratedImage,
): OpenAiGeneratedImage {
  if (!shouldPostprocessFlatGraphic(request)) return image;
  const processed = flattenPngBase64(image.b64Json);
  return processed ? { ...image, b64Json: processed } : image;
}

function shouldPostprocessFlatGraphic(request: OpenAiImageGenerationRequest): boolean {
  return isFlatReferenceStyleRequest(request)
    && (request.outputFormat === undefined || request.outputFormat === 'png')
    && asksForFlatGraphicPrompt(request.prompt);
}

function isFlatReferenceStyleRequest(request: OpenAiImageGenerationRequest): boolean {
  if (request.images.length === 0 || request.mask) return false;
  if (request.operation === 'generation') return true;
  if (request.operation !== 'edit') return false;
  return /\b(?:reference|style)\b/i.test(request.prompt);
}

function flattenPngBase64(b64Json: string): string | null {
  try {
    const decoded = decodePng(Buffer.from(stripDataUrl(b64Json), 'base64'));
    if (!decoded) return null;
    if (decoded.width * decoded.height > MAX_FLAT_POSTPROCESS_PIXELS) return null;
    const rgba = new Uint8Array(decoded.rgba);
    const background = flattenDominantBorderBackground(rgba, decoded.width, decoded.height);
    const edgeMask = edgePixelMask(rgba, decoded.width, decoded.height);
    quantizeOpaquePixels(rgba, FLAT_REFERENCE_MAX_COLORS, background, edgeMask);
    return encodePng({ width: decoded.width, height: decoded.height, rgba }).toString('base64');
  } catch {
    return null;
  }
}

function stripDataUrl(value: string): string {
  return value.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, '').replace(/\s/g, '');
}

function decodePng(buffer: Buffer): DecodedPng | null {
  if (buffer.length < PNG_SIGNATURE.length || !buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return null;
  }
  let position = PNG_SIGNATURE.length;
  let width = 0;
  let height = 0;
  let colorType = -1;
  const idatChunks: Buffer[] = [];
  while (position + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(position);
    const type = buffer.toString('ascii', position + 4, position + 8);
    const dataStart = position + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) return null;
    const data = buffer.subarray(dataStart, dataEnd);
    if (type === 'IHDR') {
      if (data.length !== 13) return null;
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth = data[8];
      colorType = data[9];
      const compression = data[10];
      const filter = data[11];
      const interlace = data[12];
      if (bitDepth !== 8 || compression !== 0 || filter !== 0 || interlace !== 0) return null;
      if (colorType !== 2 && colorType !== 6) return null;
    } else if (type === 'IDAT') {
      idatChunks.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    position = dataEnd + 4;
  }
  if (width <= 0 || height <= 0 || idatChunks.length === 0) return null;
  const channels = colorType === 6 ? 4 : 3;
  const scanlineLength = width * channels;
  const inflated = inflateSync(Buffer.concat(idatChunks));
  if (inflated.length < height * (scanlineLength + 1)) return null;
  const unfiltered = unfilterPng(inflated, width, height, channels);
  const rgba = new Uint8Array(width * height * 4);
  for (let src = 0, dst = 0; src < unfiltered.length; src += channels, dst += 4) {
    rgba[dst] = unfiltered[src] ?? 0;
    rgba[dst + 1] = unfiltered[src + 1] ?? 0;
    rgba[dst + 2] = unfiltered[src + 2] ?? 0;
    rgba[dst + 3] = channels === 4 ? unfiltered[src + 3] ?? 255 : 255;
  }
  return { width, height, rgba };
}

function unfilterPng(
  inflated: Buffer,
  width: number,
  height: number,
  channels: number,
): Uint8Array {
  const stride = width * channels;
  const out = new Uint8Array(stride * height);
  let inputOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[inputOffset++];
    const rowOffset = y * stride;
    const previousRowOffset = rowOffset - stride;
    for (let x = 0; x < stride; x += 1) {
      const raw = inflated[inputOffset++] ?? 0;
      const left = x >= channels ? out[rowOffset + x - channels] ?? 0 : 0;
      const up = y > 0 ? out[previousRowOffset + x] ?? 0 : 0;
      const upLeft = y > 0 && x >= channels ? out[previousRowOffset + x - channels] ?? 0 : 0;
      out[rowOffset + x] = (raw + pngFilterPredictor(filter, left, up, upLeft)) & 0xff;
    }
  }
  return out;
}

function pngFilterPredictor(filter: number, left: number, up: number, upLeft: number): number {
  if (filter === 0) return 0;
  if (filter === 1) return left;
  if (filter === 2) return up;
  if (filter === 3) return Math.floor((left + up) / 2);
  if (filter === 4) return paeth(left, up, upLeft);
  throw new Error(`Unsupported PNG filter ${filter}`);
}

function paeth(left: number, up: number, upLeft: number): number {
  const p = left + up - upLeft;
  const pa = Math.abs(p - left);
  const pb = Math.abs(p - up);
  const pc = Math.abs(p - upLeft);
  if (pa <= pb && pa <= pc) return left;
  if (pb <= pc) return up;
  return upLeft;
}

function flattenDominantBorderBackground(
  rgba: Uint8Array,
  width: number,
  height: number,
): WeightedColor | null {
  const background = dominantBorderColor(rgba, width, height);
  if (!background) return null;
  for (let offset = 0; offset < rgba.length; offset += 4) {
    if ((rgba[offset + 3] ?? 0) < 128) continue;
    if (colorDistanceSquared(rgba, offset, background) > BACKGROUND_DISTANCE_SQUARED) continue;
    rgba[offset] = background.r;
    rgba[offset + 1] = background.g;
    rgba[offset + 2] = background.b;
  }
  return background;
}

function dominantBorderColor(
  rgba: Uint8Array,
  width: number,
  height: number,
): WeightedColor | null {
  const pad = Math.max(2, Math.floor(Math.min(width, height) * 0.04));
  const bins = new Map<number, ColorBin>();
  for (let y = 0; y < height; y += 1) {
    const isBorderY = y < pad || y >= height - pad;
    for (let x = 0; x < width; x += 1) {
      if (!isBorderY && x >= pad && x < width - pad) continue;
      const offset = (y * width + x) * 4;
      addColorBin(bins, rgba, offset);
    }
  }
  return [...bins.values()].sort((a, b) => b.count - a.count)[0] ?? null;
}

function quantizeOpaquePixels(
  rgba: Uint8Array,
  maxColors: number,
  background: WeightedColor | null,
  edgeMask: Uint8Array,
): void {
  const bins = new Map<number, ColorBin>();
  for (let offset = 0; offset < rgba.length; offset += 4) addColorBin(bins, rgba, offset);
  const colors = [...bins.values()].map((bin) => ({
    count: bin.count,
    r: Math.round(bin.r / bin.count),
    g: Math.round(bin.g / bin.count),
    b: Math.round(bin.b / bin.count),
  }));
  if (colors.length === 0) return;
  const palette = colors.length <= maxColors
    ? colors
    : flatGraphicPalette(colors, maxColors, background);
  for (let offset = 0; offset < rgba.length; offset += 4) {
    if ((rgba[offset + 3] ?? 0) < 128) continue;
    if (edgeMask[offset / 4]) continue;
    const color = nearestPaletteColor(rgba, offset, palette);
    rgba[offset] = color.r;
    rgba[offset + 1] = color.g;
    rgba[offset + 2] = color.b;
  }
}

function edgePixelMask(
  rgba: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (x + 1 < width) markEdgePair(rgba, mask, index, index + 1);
      if (y + 1 < height) markEdgePair(rgba, mask, index, index + width);
    }
  }
  return mask;
}

function markEdgePair(
  rgba: Uint8Array,
  mask: Uint8Array,
  leftIndex: number,
  rightIndex: number,
): void {
  const leftOffset = leftIndex * 4;
  const rightOffset = rightIndex * 4;
  if ((rgba[leftOffset + 3] ?? 0) < 128 || (rgba[rightOffset + 3] ?? 0) < 128) return;
  if (pixelDistanceSquared(rgba, leftOffset, rightOffset) <= EDGE_DISTANCE_SQUARED) return;
  mask[leftIndex] = 1;
  mask[rightIndex] = 1;
}

function flatGraphicPalette(
  colors: readonly WeightedColor[],
  maxColors: number,
  background: WeightedColor | null,
): WeightedColor[] {
  const protectedColors = protectedAccentColors(colors, background, Math.min(10, maxColors));
  const medianColors = medianCutPalette(colors, maxColors);
  return mergePalette([...protectedColors, ...medianColors], maxColors);
}

function protectedAccentColors(
  colors: readonly WeightedColor[],
  background: WeightedColor | null,
  limit: number,
): WeightedColor[] {
  const protectedColors: WeightedColor[] = [];
  if (background) protectedColors.push(background);
  const candidates = colors
    .filter((color) => !background || distanceBetweenColors(color, background) > 24 * 24)
    .sort((a, b) => colorSalience(b, background) - colorSalience(a, background));
  for (const color of candidates) {
    if (protectedColors.length >= limit) break;
    if (protectedColors.some((existing) => distanceBetweenColors(existing, color) < 28 * 28)) continue;
    protectedColors.push(color);
  }
  return protectedColors;
}

function mergePalette(
  candidates: readonly WeightedColor[],
  maxColors: number,
): WeightedColor[] {
  const palette: WeightedColor[] = [];
  for (const color of candidates) {
    if (palette.some((existing) => distanceBetweenColors(existing, color) < 18 * 18)) continue;
    palette.push(color);
    if (palette.length >= maxColors) break;
  }
  return palette.length > 0 ? palette : candidates.slice(0, maxColors);
}

function colorSalience(
  color: WeightedColor,
  background: WeightedColor | null,
): number {
  const saturation = colorSaturation(color);
  const backgroundDistance = background ? Math.sqrt(distanceBetweenColors(color, background)) : 64;
  return Math.sqrt(color.count) * (1 + saturation / 48) * (1 + backgroundDistance / 96);
}

function colorSaturation(color: Pick<WeightedColor, 'r' | 'g' | 'b'>): number {
  return Math.max(color.r, color.g, color.b) - Math.min(color.r, color.g, color.b);
}

function distanceBetweenColors(
  left: Pick<WeightedColor, 'r' | 'g' | 'b'>,
  right: Pick<WeightedColor, 'r' | 'g' | 'b'>,
): number {
  const dr = left.r - right.r;
  const dg = left.g - right.g;
  const db = left.b - right.b;
  return dr * dr + dg * dg + db * db;
}

function addColorBin(
  bins: Map<number, ColorBin>,
  rgba: Uint8Array,
  offset: number,
): void {
  if ((rgba[offset + 3] ?? 0) < 128) return;
  const r = rgba[offset] ?? 0;
  const g = rgba[offset + 1] ?? 0;
  const b = rgba[offset + 2] ?? 0;
  const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
  const bin = bins.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
  bin.count += 1;
  bin.r += r;
  bin.g += g;
  bin.b += b;
  bins.set(key, bin);
}

function medianCutPalette(colors: readonly WeightedColor[], maxColors: number): WeightedColor[] {
  const buckets: WeightedColor[][] = [colors.slice()];
  while (buckets.length < maxColors) {
    const index = bucketToSplit(buckets);
    const bucket = buckets[index];
    if (!bucket || bucket.length <= 1) break;
    const [left, right] = splitBucket(bucket);
    buckets.splice(index, 1, left, right);
  }
  return buckets.map(averageBucketColor);
}

function bucketToSplit(buckets: readonly WeightedColor[][]): number {
  let bestIndex = 0;
  let bestScore = -1;
  for (const [index, bucket] of buckets.entries()) {
    if (bucket.length <= 1) continue;
    const range = bucketRange(bucket);
    const score = Math.max(range.r, range.g, range.b) * Math.sqrt(bucketWeight(bucket));
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }
  return bestIndex;
}

function splitBucket(bucket: readonly WeightedColor[]): [WeightedColor[], WeightedColor[]] {
  const range = bucketRange(bucket);
  const channel = range.r >= range.g && range.r >= range.b
    ? 'r'
    : range.g >= range.b
      ? 'g'
      : 'b';
  const sorted = bucket.slice().sort((a, b) => a[channel] - b[channel]);
  const halfWeight = bucketWeight(sorted) / 2;
  let cumulative = 0;
  let splitIndex = 1;
  for (let i = 0; i < sorted.length - 1; i += 1) {
    cumulative += sorted[i]?.count ?? 0;
    if (cumulative >= halfWeight) {
      splitIndex = i + 1;
      break;
    }
  }
  return [sorted.slice(0, splitIndex), sorted.slice(splitIndex)];
}

function bucketRange(bucket: readonly WeightedColor[]): { r: number; g: number; b: number } {
  let minR = 255;
  let minG = 255;
  let minB = 255;
  let maxR = 0;
  let maxG = 0;
  let maxB = 0;
  for (const color of bucket) {
    minR = Math.min(minR, color.r);
    minG = Math.min(minG, color.g);
    minB = Math.min(minB, color.b);
    maxR = Math.max(maxR, color.r);
    maxG = Math.max(maxG, color.g);
    maxB = Math.max(maxB, color.b);
  }
  return { r: maxR - minR, g: maxG - minG, b: maxB - minB };
}

function bucketWeight(bucket: readonly WeightedColor[]): number {
  return bucket.reduce((sum, color) => sum + color.count, 0);
}

function averageBucketColor(bucket: readonly WeightedColor[]): WeightedColor {
  let count = 0;
  let r = 0;
  let g = 0;
  let b = 0;
  for (const color of bucket) {
    count += color.count;
    r += color.r * color.count;
    g += color.g * color.count;
    b += color.b * color.count;
  }
  return {
    count,
    r: Math.round(r / count),
    g: Math.round(g / count),
    b: Math.round(b / count),
  };
}

function nearestPaletteColor(
  rgba: Uint8Array,
  offset: number,
  palette: readonly WeightedColor[],
): WeightedColor {
  let best = palette[0] ?? { count: 1, r: rgba[offset] ?? 0, g: rgba[offset + 1] ?? 0, b: rgba[offset + 2] ?? 0 };
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const color of palette) {
    const distance = colorDistanceSquared(rgba, offset, color);
    if (distance < bestDistance) {
      best = color;
      bestDistance = distance;
    }
  }
  return best;
}

function colorDistanceSquared(
  rgba: Uint8Array,
  offset: number,
  color: Pick<WeightedColor, 'r' | 'g' | 'b'>,
): number {
  const dr = (rgba[offset] ?? 0) - color.r;
  const dg = (rgba[offset + 1] ?? 0) - color.g;
  const db = (rgba[offset + 2] ?? 0) - color.b;
  return dr * dr + dg * dg + db * db;
}

function pixelDistanceSquared(
  rgba: Uint8Array,
  leftOffset: number,
  rightOffset: number,
): number {
  const dr = (rgba[leftOffset] ?? 0) - (rgba[rightOffset] ?? 0);
  const dg = (rgba[leftOffset + 1] ?? 0) - (rgba[rightOffset + 1] ?? 0);
  const db = (rgba[leftOffset + 2] ?? 0) - (rgba[rightOffset + 2] ?? 0);
  return dr * dr + dg * dg + db * db;
}

function encodePng(image: DecodedPng): Buffer {
  const stride = 1 + image.width * 4;
  const raw = Buffer.alloc(stride * image.height);
  for (let y = 0; y < image.height; y += 1) {
    const rowOffset = y * stride;
    raw[rowOffset] = 0;
    const sourceStart = y * image.width * 4;
    raw.set(image.rgba.subarray(sourceStart, sourceStart + image.width * 4), rowOffset + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(image.width, 0);
  ihdr.writeUInt32BE(image.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])), 0);
  return Buffer.concat([length, name, data, crc]);
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  }
  return value >>> 0;
});
