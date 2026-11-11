'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { encodePNG, encodeICO, crc32 } = require('../png');
const { trayIconRGBA, appIconRGBA } = require('../icon');

test('crc32 matches the PNG spec check value', () => {
  assert.equal((crc32(Buffer.from('123456789')) ^ 0xffffffff) >>> 0, 0xcbf43926);
});

test('PNG round-trips: chunks, CRCs and pixels', () => {
  const size = 20;
  const rgba = trayIconRGBA(size, { pct: 90, tone: 'warn' });
  const png = encodePNG(size, size, rgba);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let off = 8;
  const idat = [];
  const types = [];
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString('ascii', off + 4, off + 8);
    const data = png.subarray(off + 8, off + 8 + len);
    const crc = png.readUInt32BE(off + 8 + len);
    assert.equal((crc32(data, crc32(Buffer.from(type))) ^ 0xffffffff) >>> 0, crc, `${type} CRC`);
    types.push(type);
    if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  assert.deepEqual(types, ['IHDR', 'IDAT', 'IEND']);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  assert.equal(raw.length, (size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    assert.equal(raw[y * (size * 4 + 1)], 0);
    assert.deepEqual(raw.subarray(y * (size * 4 + 1) + 1, (y + 1) * (size * 4 + 1)), rgba.subarray(y * size * 4, (y + 1) * size * 4));
  }
});

test('ICO directory points at every entry', () => {
  const ico = encodeICO([16, 32, 256].map((size) => ({ size, rgba: appIconRGBA(size) })));
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), 3);
  for (let i = 0; i < 3; i++) {
    const e = 6 + i * 16;
    const len = ico.readUInt32LE(e + 8);
    const at = ico.readUInt32LE(e + 12);
    assert.ok(at + len <= ico.length);
  }
  const last = 6 + 2 * 16;
  assert.equal(ico[last], 0); // 256 is stored as 0
  assert.equal(ico.toString('ascii', ico.readUInt32LE(last + 12) + 1, ico.readUInt32LE(last + 12) + 4), 'PNG');
});
