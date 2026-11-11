'use strict';
// Contact sheet for reviewing the tray icon and the app icon.
// Top: every tray size x state, nearest-neighbour zoomed so single pixels show,
// over the taskbar colour. Middle: a mock "show hidden icons" flyout at 1:1 and
// at 3x, with stand-ins for the marks it sits next to on this machine (a blue
// square, a blurple blob, a green NVIDIA-ish block, the Claude Code Usage
// Monitor's coral "93" square, a Bluetooth rune), so "can I find it" and "can
// I confuse it" are answered by looking. Right: the app icon at 256 and at
// every ICO size.
// Usage: node scripts/preview-icons.js <out.png> [--light] [--zoom 8]
const fs = require('node:fs');
const { encodePNG } = require('../src/main/png');
const { trayIconRGBA, appIconRGBA, rasterise, hex } = require('../src/main/icon');

const out = process.argv[2] || 'icon-preview.png';
const light = process.argv.includes('--light');
const zi = process.argv.indexOf('--zoom');
const zoom = zi > 0 ? Number(process.argv[zi + 1]) : 8;
const taskbar = light ? [238, 238, 238] : [32, 32, 32];
const flyout = light ? [249, 249, 249] : [44, 44, 44];

const sizes = [16, 20, 24, 32];
const states = [
  { pct: null, tone: 'none' },
  { pct: 0, tone: 'ok' },
  { pct: 12, tone: 'ok' },
  { pct: 47, tone: 'ok' },
  { pct: 93, tone: 'warn' },
  { pct: 100, tone: 'full' },
];
const tray = (size, st) => trayIconRGBA(size, { ...st, lightTaskbar: light });

// --- stand-ins for the neighbours (shapes only, no brand art) ---------------
const DIGITS = { 9: ['111', '101', '111', '001', '111'], 3: ['111', '001', '011', '001', '111'] };
const neighbours = {
  coral93(size) {
    const shapes = [{ type: 'roundrect', x0: 0, y0: 0, x1: size, y1: size, radius: size * 0.2, color: hex('#D97757') }];
    const sc = size <= 24 ? 2 : 3;
    const ox = Math.floor((size - 7 * sc) / 2);
    const oy = Math.floor((size - 5 * sc) / 2);
    [9, 3].forEach((d, k) =>
      DIGITS[d].forEach((row, ry) =>
        [...row].forEach((c, rx) => {
          if (c !== '1') return;
          const x0 = ox + k * 4 * sc + rx * sc;
          shapes.push({ type: 'roundrect', x0, y0: oy + ry * sc, x1: x0 + sc, y1: oy + (ry + 1) * sc, radius: 0, color: hex('#FFFFFF') });
        }),
      ),
    );
    return rasterise(size, shapes);
  },
  blueSquare: (size) =>
    rasterise(size, [
      { type: 'roundrect', x0: 1, y0: 1, x1: size - 1, y1: size - 1, radius: size * 0.2, color: hex('#175DDC') },
      { type: 'roundrect', x0: size * 0.3, y0: size * 0.25, x1: size * 0.7, y1: size * 0.72, radius: size * 0.12, color: hex('#FFFFFF') },
    ]),
  blurple: (size) =>
    rasterise(size, [
      { type: 'roundrect', x0: size * 0.08, y0: size * 0.2, x1: size * 0.92, y1: size * 0.85, radius: size * 0.28, color: hex('#5865F2') },
      { type: 'disc', cx: size * 0.36, cy: size * 0.52, r: size * 0.09, color: hex('#FFFFFF') },
      { type: 'disc', cx: size * 0.64, cy: size * 0.52, r: size * 0.09, color: hex('#FFFFFF') },
    ]),
  green: (size) =>
    rasterise(size, [
      { type: 'roundrect', x0: size * 0.05, y0: size * 0.2, x1: size * 0.95, y1: size * 0.8, radius: size * 0.05, color: hex('#76B900') },
      { type: 'disc', cx: size * 0.42, cy: size * 0.5, r: size * 0.2, color: hex('#FFFFFF') },
      { type: 'disc', cx: size * 0.42, cy: size * 0.5, r: size * 0.12, color: hex('#76B900') },
    ]),
  rune(size) {
    const c = hex(light ? '#1A1A1A' : '#FFFFFF');
    const p = (x, y) => [size * x, size * y];
    const seg = (a, b) => ({ type: 'segment', x0: a[0], y0: a[1], x1: b[0], y1: b[1], width: Math.max(1.4, size * 0.07), color: c });
    return rasterise(size, [
      seg(p(0.5, 0.12), p(0.5, 0.88)),
      seg(p(0.5, 0.12), p(0.72, 0.32)),
      seg(p(0.72, 0.32), p(0.3, 0.68)),
      seg(p(0.5, 0.88), p(0.72, 0.68)),
      seg(p(0.72, 0.68), p(0.3, 0.32)),
    ]);
  },
};

// --- layout ----------------------------------------------------------------
const cell = 32 * zoom + 16;
const gridW = 16 + cell * states.length;
const gridH = 16 + cell * sizes.length;
const FLY = 20; // this machine's notify-icon size (125 %)
const stripH = (z) => 12 + (FLY + 14) * z * 2 + 12;
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64];
const appW = 16 + Math.max(256, ICO_SIZES.reduce((a, s) => a + s + 6, 0)) + 16;
const W = gridW + appW;
const H = Math.max(gridH + stripH(1) + stripH(3), 16 + 256 + 16 + 64 + 16);
const sheet = Buffer.alloc(W * H * 4);
for (let i = 0; i < W * H; i++) sheet.set([...taskbar, 255], i * 4);

function fillRect(x0, y0, w, h, c) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) sheet.set([...c, 255], (y * W + x) * 4);
}
function blit(rgba, size, ox, oy, z) {
  for (let y = 0; y < size * z; y++) {
    for (let x = 0; x < size * z; x++) {
      const s = (Math.floor(y / z) * size + Math.floor(x / z)) * 4;
      const d = ((oy + y) * W + ox + x) * 4;
      const a = rgba[s + 3] / 255;
      for (let c = 0; c < 3; c++) sheet[d + c] = Math.round(rgba[s + c] * a + sheet[d + c] * (1 - a));
    }
  }
}

sizes.forEach((size, row) => states.forEach((st, col) => blit(tray(size, st), size, 16 + col * cell, 16 + row * cell, zoom)));

let y = gridH;
for (const z of [1, 3]) {
  fillRect(0, y, gridW, stripH(z), flyout);
  const pitch = (FLY + 12) * z;
  const row1 = [neighbours.blueSquare(FLY), neighbours.blurple(FLY), tray(FLY, { pct: 93, tone: 'warn' }), neighbours.green(FLY), neighbours.coral93(FLY), neighbours.rune(FLY)];
  const row2 = [tray(FLY, states[0]), tray(FLY, states[3]), tray(FLY, states[5]), neighbours.coral93(FLY), tray(FLY, states[1])];
  row1.forEach((img, k) => blit(img, FLY, 16 + k * pitch, y + 12, z));
  row2.forEach((img, k) => blit(img, FLY, 16 + k * pitch, y + 12 + (FLY + 14) * z, z));
  y += stripH(z);
}

blit(appIconRGBA(256), 256, gridW + 16, 16, 1);
let ax = gridW + 16;
for (const s of ICO_SIZES) {
  blit(appIconRGBA(s), s, ax, 16 + 256 + 16, 1);
  ax += s + 6;
}

fs.writeFileSync(out, encodePNG(W, H, sheet));
console.log('wrote', out, W + 'x' + H);
