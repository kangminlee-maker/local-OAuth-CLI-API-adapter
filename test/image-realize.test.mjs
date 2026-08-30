import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { realizeImageOptions, realizeRequestedSize } from '../dist/proxy/image-realize.js';

// The app-server image transport has no tool declaration to carry the Images
// API options, so the ones with a meaning on bytes are applied to the bytes.
// Each test pins one option against decoded output, not against the request
// echo.

async function solid(width, height, rgba) {
  return sharp({ create: { width, height, channels: 4, background: rgba } }).png().toBuffer();
}
const b64 = (buf) => buf.toString('base64');
const meta = (image) => sharp(Buffer.from(image.b64Json, 'base64')).metadata();
const pixel = async (image, x, y) => {
  const { data, info } = await sharp(Buffer.from(image.b64Json, 'base64')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * 4;
  return [data[i], data[i + 1], data[i + 2], data[i + 3]];
};
function request(extra) {
  return { operation: 'generation', model: 'gpt-image-2', prompt: 'x', n: 1, images: [], stream: false, partialImages: 0, raw: {}, ...extra };
}

test('a request with nothing to realize returns the bytes untouched, undecoded', async () => {
  const image = { b64Json: Buffer.from('not an image at all').toString('base64') };
  const out = await realizeImageOptions(request({}), image);
  assert.equal(out, image);
});

test('size is realized by resizing the returned canvas', async () => {
  const image = { b64Json: b64(await solid(8, 8, { r: 10, g: 20, b: 30, alpha: 1 })) };
  const out = await realizeImageOptions(request({ size: '32x16' }), image);
  const m = await meta(out);
  assert.equal(`${m.width}x${m.height}`, '32x16');
  assert.equal(m.format, 'png');
});

test('output_format and output_compression are realized as the codec', async () => {
  const image = { b64Json: b64(await solid(8, 8, { r: 200, g: 0, b: 0, alpha: 1 })) };
  for (const [format, expected] of [['jpeg', 'jpeg'], ['webp', 'webp']]) {
    const out = await realizeImageOptions(request({ outputFormat: format, outputCompression: 60 }), image);
    assert.equal((await meta(out)).format, expected, format);
  }
});

test('background opaque flattens alpha onto white', async () => {
  const image = { b64Json: b64(await solid(4, 4, { r: 0, g: 0, b: 255, alpha: 0 })) };
  const out = await realizeImageOptions(request({ background: 'opaque' }), image);
  assert.deepEqual(await pixel(out, 1, 1), [255, 255, 255, 255]);
});

test('a mask keeps the source where it is opaque and takes the generated image where it is transparent', async () => {
  // Source: 4x4 red. Mask: left half transparent (editable), right half opaque.
  // Generated: 4x4 green. Expected: left half green, right half red.
  const source = await solid(4, 4, { r: 255, g: 0, b: 0, alpha: 1 });
  const generated = await solid(4, 4, { r: 0, g: 255, b: 0, alpha: 1 });
  const raw = Buffer.alloc(4 * 4 * 4);
  for (let y = 0; y < 4; y += 1) for (let x = 0; x < 4; x += 1) raw.set([0, 0, 0, x < 2 ? 0 : 255], (y * 4 + x) * 4);
  const mask = await sharp(raw, { raw: { width: 4, height: 4, channels: 4 } }).png().toBuffer();
  const out = await realizeImageOptions(request({
    operation: 'edit',
    images: [{ source: { type: 'base64', mediaType: 'image/png', data: b64(source) }, raw: {} }],
    mask: { source: { type: 'base64', mediaType: 'image/png', data: b64(mask) }, raw: {} },
  }), { b64Json: b64(generated) });
  assert.deepEqual((await pixel(out, 0, 1)).slice(0, 3), [0, 255, 0], 'masked-out (transparent) region takes the generated pixels');
  assert.deepEqual((await pixel(out, 3, 1)).slice(0, 3), [255, 0, 0], 'opaque region keeps the source pixels');
  const m = await meta(out);
  assert.equal(`${m.width}x${m.height}`, '4x4', 'the composite is at the source dimensions');
});

test('a mask with a size resizes the composite to the requested canvas', async () => {
  const source = await solid(4, 4, { r: 255, g: 0, b: 0, alpha: 1 });
  const mask = await solid(4, 4, { r: 0, g: 0, b: 0, alpha: 0 });
  const out = await realizeImageOptions(request({
    operation: 'edit', size: '16x16',
    images: [{ source: { type: 'base64', mediaType: 'image/png', data: b64(source) }, raw: {} }],
    mask: { source: { type: 'url', url: `data:image/png;base64,${b64(mask)}` }, raw: {} },
  }), { b64Json: b64(await solid(4, 4, { r: 0, g: 0, b: 255, alpha: 1 })) });
  const m = await meta(out);
  assert.equal(`${m.width}x${m.height}`, '16x16');
  assert.deepEqual((await pixel(out, 8, 8)).slice(0, 3), [0, 0, 255], 'a fully transparent mask means the whole canvas is generated');
});

// `realizeRequestedSize` is the one realization the DEFAULT transport runs:
// it corrects a canvas the backend returned at another size and touches
// nothing else.
test('realizeRequestedSize: no concrete size — bytes untouched, undecoded', async () => {
  const image = { b64Json: Buffer.from('not an image at all').toString('base64') };
  assert.equal(await realizeRequestedSize(request({}), image), image);
  assert.equal(await realizeRequestedSize(request({ size: 'auto' }), image), image);
});

test('realizeRequestedSize: a canvas at the requested size is the same object', async () => {
  const image = { b64Json: b64(await solid(32, 16, { r: 1, g: 2, b: 3, alpha: 1 })) };
  assert.equal(await realizeRequestedSize(request({ size: '32x16' }), image), image);
});

test('realizeRequestedSize: another canvas is covered to the requested size, in the codec it came back in', async () => {
  const png = { b64Json: b64(await solid(8, 8, { r: 1, g: 2, b: 3, alpha: 1 })), revisedPrompt: 'kept' };
  const out = await realizeRequestedSize(request({ size: '32x16' }), png);
  const m = await meta(out);
  assert.equal(`${m.width}x${m.height}`, '32x16');
  assert.equal(m.format, 'png');
  assert.equal(out.revisedPrompt, 'kept');

  const jpegBytes = await sharp(Buffer.from(png.b64Json, 'base64')).jpeg().toBuffer();
  const asJpeg = await realizeRequestedSize(request({ size: '32x16', outputFormat: 'jpeg', outputCompression: 70 }), { b64Json: b64(jpegBytes) });
  const j = await meta(asJpeg);
  assert.equal(`${j.width}x${j.height}`, '32x16');
  assert.equal(j.format, 'jpeg');
});

test('realizeRequestedSize: bytes the codec cannot read come back untouched, not as a failure', async () => {
  const image = { b64Json: Buffer.from('garbage after a billed turn').toString('base64') };
  assert.equal(await realizeRequestedSize(request({ size: '32x16' }), image), image);
});

test('prepareRequestedSize: nothing to prepare without a concrete size; the codec loads for one', async () => {
  const { prepareRequestedSize } = await import('../dist/proxy/image-realize.js');
  await prepareRequestedSize(request({}));
  await prepareRequestedSize(request({ size: 'auto' }));
  await prepareRequestedSize(request({ size: '32x16' }));
});
