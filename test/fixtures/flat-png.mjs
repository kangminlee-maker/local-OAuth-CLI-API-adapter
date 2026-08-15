// PNG builders and inspectors shared by the postprocess unit tests and the
// HTTP-seam test: the same qualifying gradient must cross both.

import assert from 'node:assert/strict';
import { deflateSync, inflateSync } from 'node:zlib';

export function gradientFlatIconPngBase64() {
  const width = 64;
  const height = 48;
  const stride = 1 + width * 4;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    pixels[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 4;
      const inBoot = x >= 20 && x <= 44 && y >= 12 && y <= 36;
      const inPuddle = x >= 10 && x <= 54 && y >= 36 && y <= 42;
      const shade = Math.round((x * 2 + y * 3) / 4);
      if (inBoot) {
        const inStripe = y >= 16 && y <= 20 && x >= 24 && x <= 40;
        pixels[offset] = inStripe ? 230 - Math.floor(shade / 2) : 225 - shade;
        pixels[offset + 1] = inStripe ? 105 : 175 - Math.floor(shade / 2);
        pixels[offset + 2] = inStripe ? 92 : 40;
      } else if (inPuddle) {
        pixels[offset] = 45;
        pixels[offset + 1] = 135 + shade;
        pixels[offset + 2] = 205;
      } else {
        pixels[offset] = 242 - Math.floor(shade / 3);
        pixels[offset + 1] = 232 - Math.floor(shade / 3);
        pixels[offset + 2] = 211 - Math.floor(shade / 4);
      }
      pixels[offset + 3] = 255;
    }
  }
  return pngFromFilteredRgbaRows(width, height, pixels).toString('base64');
}

export function uniqueOpaqueColorCount(b64Json) {
  const png = Buffer.from(b64Json, 'base64');
  const idat = [];
  let width = 0;
  let height = 0;
  let position = 8;
  while (position + 8 <= png.length) {
    const length = png.readUInt32BE(position);
    const type = png.toString('ascii', position + 4, position + 8);
    const data = png.subarray(position + 8, position + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    position += 12 + length;
  }
  const rows = inflateSync(Buffer.concat(idat));
  const colors = new Set();
  const stride = 1 + width * 4;
  for (let y = 0; y < height; y += 1) {
    assert.equal(rows[y * stride], 0);
    for (let x = 0; x < width; x += 1) {
      const offset = y * stride + 1 + x * 4;
      if (rows[offset + 3] < 128) continue;
      colors.add(`${rows[offset]},${rows[offset + 1]},${rows[offset + 2]}`);
    }
  }
  return colors.size;
}

function pngFromFilteredRgbaRows(width, height, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(pixels)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function pngChunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])), 0);
  return Buffer.concat([length, name, data, crc]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  }
  return value >>> 0;
});

export function tinyPngBase64() {
  return 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
}
