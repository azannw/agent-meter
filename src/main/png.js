'use strict';
// Minimal PNG and ICO encoders. No dependencies beyond node:zlib.
// Input everywhere is straight (non-premultiplied) RGBA, 8 bits per channel,
// rows top to bottom, as produced by icon.js.

const zlib = require('node:zlib');

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf, crc = 0xffffffff) {
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return crc;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE((crc32(data, crc32(typeBuf)) ^ 0xffffffff) >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Encode straight RGBA pixels as a PNG (colour type 6, filter 0 per row). */
function encodePNG(width, height, rgba) {
  if (rgba.length !== width * height * 4) throw new Error('encodePNG: buffer size mismatch');
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // no interlace
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type None
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/**
 * 32-bit BMP (DIB) payload for an ICO entry: BITMAPINFOHEADER with doubled
 * height, BGRA rows bottom-up, then a 1-bit AND mask (all zero: alpha decides).
 * Classic loaders (LoadImage for 16-48 px) are happiest with these.
 */
function encodeIcoBmp(width, height, rgba) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(width, 4);
  header.writeInt32LE(height * 2, 8);
  header.writeUInt16LE(1, 12); // planes
  header.writeUInt16LE(32, 14); // bpp
  header.writeUInt32LE(0, 16); // BI_RGB
  const xor = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const src = (height - 1 - y) * width * 4;
    const dst = y * width * 4;
    for (let x = 0; x < width; x++) {
      const s = src + x * 4;
      const d = dst + x * 4;
      xor[d] = rgba[s + 2];
      xor[d + 1] = rgba[s + 1];
      xor[d + 2] = rgba[s];
      xor[d + 3] = rgba[s + 3];
    }
  }
  const maskStride = Math.ceil(width / 32) * 4;
  const and = Buffer.alloc(maskStride * height);
  header.writeUInt32LE(xor.length + and.length, 20);
  return Buffer.concat([header, xor, and]);
}

/**
 * Multi-size ICO. images: [{ size, rgba }]. Entries >= 64 px are stored as
 * PNG (smaller file, Vista+ loaders read them), smaller ones as 32-bit DIBs.
 */
function encodeICO(images) {
  const sorted = [...images].sort((a, b) => a.size - b.size);
  const payloads = sorted.map(({ size, rgba }) =>
    size >= 64 ? encodePNG(size, size, rgba) : encodeIcoBmp(size, size, rgba),
  );
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2); // type icon
  head.writeUInt16LE(sorted.length, 4);
  const dir = Buffer.alloc(16 * sorted.length);
  let offset = 6 + dir.length;
  sorted.forEach(({ size }, i) => {
    const e = i * 16;
    dir[e] = size >= 256 ? 0 : size;
    dir[e + 1] = size >= 256 ? 0 : size;
    dir[e + 2] = 0; // palette
    dir[e + 3] = 0;
    dir.writeUInt16LE(1, e + 4); // planes
    dir.writeUInt16LE(32, e + 6); // bpp
    dir.writeUInt32LE(payloads[i].length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += payloads[i].length;
  });
  return Buffer.concat([head, dir, ...payloads]);
}

module.exports = { crc32, encodePNG, encodeICO, encodeIcoBmp };
