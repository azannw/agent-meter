'use strict';
// The tray icon and the app icon. The tray icon is the weekly share used as a
// number on a graphite tile in every state but the limit (a white "!" on red), with
// no warning colour (he asked for grey for good, 2026-10-04); no data is a dash.
// These pin what makes it read at 16-48 px: the
// tile fills its cell, the number is the rounded percent (never three digits),
// centred, with a clear column between its digits, in the right colours per state.
// The app icon keeps the violet tile with the gauge.
const test = require('node:test');
const assert = require('node:assert/strict');
const { TILE, NUMBER, hex, trayIconRGBA, appIconRGBA } = require('../icon');
const DIGITS = require('../digits');

const TRAY_SIZES = [16, 20, 24, 28, 32, 40, 48]; // 16 px x every Windows scale tray.js builds
const rgbOf = (color) => hex(color).slice(0, 3);

function reader(px, size) {
  return {
    rgb: (x, y) => [...px.subarray((y * size + x) * 4, (y * size + x) * 4 + 3)],
    alpha: (x, y) => px[(y * size + x) * 4 + 3],
  };
}
function near(actual, expected, msg, tol = 1) {
  assert.ok(actual.every((v, i) => Math.abs(v - expected[i]) <= tol), `${msg}: got ${actual}, want ${expected}`);
}
/** Box around every pixel that differs from the tile colour: the characters. */
function inkBox(px, size, tile) {
  const { rgb, alpha } = reader(px, size);
  let x0 = size, y0 = size, x1 = -1, y1 = -1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (alpha(x, y) < 255 || rgb(x, y).every((v, i) => Math.abs(v - tile[i]) <= 2)) continue;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
  }
  return { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

test('the tile fills the tray cell edge to edge, with soft rounded corners', () => {
  for (const size of TRAY_SIZES) {
    const px = trayIconRGBA(size, { pct: 47, tone: 'ok' });
    assert.equal(px.length, size * size * 4);
    const { alpha, rgb } = reader(px, size);
    assert.equal(alpha(size / 2, 0), 255, `${size}: top edge opaque`);
    assert.equal(alpha(0, size / 2), 255, `${size}: left edge opaque`);
    assert.ok(alpha(size - 1, size - 1) < 255, `${size}: corner rounded`);
    assert.equal(alpha(0, 0), 0, `${size}: corner pixel outside the tile`);
    near(rgb(0, size / 2), rgbOf(NUMBER.ok.tile), `${size}: graphite`);
  }
});

test('the number is the rounded weekly percent in white, centred in the tile', () => {
  for (const size of TRAY_SIZES) {
    for (const pct of [4, 47, 88]) {
      const px = trayIconRGBA(size, { pct, tone: 'ok' });
      const box = inkBox(px, size, rgbOf(NUMBER.ok.tile));
      const tag = `${size}px ${pct}%`;
      assert.ok(Math.abs(box.x0 - (size - 1 - box.x1)) <= 1, `${tag}: centred across (${box.x0} | ${size - 1 - box.x1})`);
      assert.ok(Math.abs(box.y0 - (size - 1 - box.y1)) <= 1, `${tag}: centred down (${box.y0} | ${size - 1 - box.y1})`);
      assert.ok(box.x0 >= 1 && box.x1 <= size - 2, `${tag}: inside the tile`);
      const { rgb } = reader(px, size);
      let white = 0;
      for (let y = box.y0; y <= box.y1; y++) for (let x = box.x0; x <= box.x1; x++) if (rgb(x, y).every((v) => v >= 240)) white++;
      assert.ok(white >= 4, `${tag}: white digits (${white} px)`);
    }
    assert.deepEqual(trayIconRGBA(size, { pct: 47.4, tone: 'ok' }), trayIconRGBA(size, { pct: 47, tone: 'ok' }), `${size}: rounds down`);
    assert.deepEqual(trayIconRGBA(size, { pct: 46.6, tone: 'ok' }), trayIconRGBA(size, { pct: 47, tone: 'ok' }), `${size}: rounds up, like the panel`);
    assert.notDeepEqual(trayIconRGBA(size, { pct: 47, tone: 'ok' }), trayIconRGBA(size, { pct: 48, tone: 'ok' }), `${size}: 47 and 48 differ`);
    const one = inkBox(trayIconRGBA(size, { pct: 4, tone: 'ok' }), size, rgbOf(NUMBER.ok.tile));
    const two = inkBox(trayIconRGBA(size, { pct: 44, tone: 'ok' }), size, rgbOf(NUMBER.ok.tile));
    assert.ok(two.w > one.w * 1.5, `${size}: two digits are wider than one`);
    assert.ok(two.h < one.h, `${size}: two digits use the smaller font (${two.h} vs ${one.h} px tall)`);
  }
});

test('two digits keep a clear pixel column between them', () => {
  for (const size of TRAY_SIZES) {
    for (const pct of [47, 74, 11, 88, 99, 10]) {
      const px = trayIconRGBA(size, { pct, tone: 'ok' });
      const tile = rgbOf(NUMBER.ok.tile);
      const box = inkBox(px, size, tile);
      const { rgb } = reader(px, size);
      const clear = (x) => [...Array(box.h).keys()].every((k) => rgb(x, box.y0 + k).every((v, i) => Math.abs(v - tile[i]) <= 2));
      let gaps = 0;
      for (let x = box.x0 + 1; x < box.x1; x++) if (clear(x)) gaps++;
      assert.ok(gaps >= 1, `${size}px ${pct}: no clear column between the digits`);
    }
  }
});

test('a pace warning stays graphite with white digits, exactly like any reading; the limit is a white "!" on red', () => {
  for (const size of [16, 20, 24, 32]) {
    // 2026-10-04: 21 % used, on track to run out early, turned the tile amber; he wants grey for good
    assert.deepEqual(trayIconRGBA(size, { pct: 21, tone: 'warn' }), trayIconRGBA(size, { pct: 21, tone: 'ok' }), `${size}: warn draws like ok`);
    assert.deepEqual(trayIconRGBA(size, { pct: 99, tone: 'warn' }), trayIconRGBA(size, { pct: 99, tone: 'ok' }), `${size}: even at 99 %`);
    near(reader(trayIconRGBA(size, { pct: 78, tone: 'warn' }), size).rgb(0, size / 2), rgbOf(NUMBER.ok.tile), `${size}: graphite`);

    const full = trayIconRGBA(size, { pct: 100, tone: 'full' });
    near(reader(full, size).rgb(0, size / 2), rgbOf(NUMBER.full.tile), `${size}: red tile`);
    const fb = inkBox(full, size, rgbOf(NUMBER.full.tile));
    assert.ok(fb.w <= Math.ceil(size * 0.25) && fb.h >= size * 0.4, `${size}: a tall narrow "!" (${fb.w}x${fb.h})`);
  }
});

test('never three digits: 99.6 % reads 99, 100 % or more reads "!", below 0 reads 0', () => {
  for (const size of [16, 20, 32]) {
    assert.deepEqual(trayIconRGBA(size, { pct: 99.6, tone: 'warn' }), trayIconRGBA(size, { pct: 99, tone: 'warn' }), `${size}: 99.6`);
    assert.deepEqual(trayIconRGBA(size, { pct: 100, tone: 'warn' }), trayIconRGBA(size, { pct: 130, tone: 'full' }), `${size}: 100`);
    assert.deepEqual(trayIconRGBA(size, { pct: -3, tone: 'ok' }), trayIconRGBA(size, { pct: 0, tone: 'ok' }), `${size}: below 0`);
  }
});

test('no data shows a dash on graphite, never a number', () => {
  for (const size of TRAY_SIZES) {
    const px = trayIconRGBA(size, { pct: null, tone: 'none' });
    near(reader(px, size).rgb(0, size / 2), rgbOf(NUMBER.ok.tile), `${size}: graphite`);
    const box = inkBox(px, size, rgbOf(NUMBER.ok.tile));
    assert.ok(box.h <= Math.max(2, Math.ceil(size * 0.06)) && box.w >= size * 0.3, `${size}: a dash (${box.w}x${box.h})`);
  }
});

test('digit masks exist for every tray size', () => {
  for (const size of TRAY_SIZES) {
    const set = DIGITS.sizes[size];
    assert.ok(set, `${size}: masks`);
    for (const ch of '0123456789') {
      assert.ok(set.two.glyphs[ch] && set.one.glyphs[ch], `${size}: "${ch}"`);
    }
    assert.ok(set.one.glyphs['–'] && set.bang.glyphs['!'], `${size}: dash and "!"`);
  }
});

test('app icon: the violet tile with the gauge, a margin from 48 px, no state', () => {
  const big = reader(appIconRGBA(256), 256);
  assert.equal(big.alpha(0, 128), 0, 'transparent margin at 256');
  assert.equal(big.alpha(128, 20), 255, 'tile inside the margin');
  near(big.rgb(128, 240 - 8), rgbOf(TILE), 'tile colour');
  const small = reader(appIconRGBA(16), 16);
  assert.equal(small.alpha(8, 0), 255, 'edge to edge at 16');
  assert.deepEqual(appIconRGBA(32), appIconRGBA(32), 'deterministic');
});
