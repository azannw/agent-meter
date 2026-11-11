'use strict';
// Tiny RGBA rasteriser for the tray icon and the app icon. No canvas exists in
// the main process, so shapes are tested per sub-sample (supersampled
// anti-aliasing) and composited source-over in premultiplied space.
// Output: straight-alpha RGBA Buffer, rows top to bottom.
//
// The tray mark (his pick on 2026-10-03, from eight drawn side by side, in the
// colour he chose from seven): the weekly share used as a number, white on a
// graphite tile that fills the cell, in every state but one: a white "!" on red
// once the limit is reached. There is no warning colour: an amber tile for "the
// week runs out early" turned up twice in a day at 14-21 % and he asked for it to
// stay grey for good (2026-10-04); that warning lives in the panel only.
// No data shows a dash, never a number. Digits are Segoe UI Variable masks from
// scripts/make-digits.js (no canvas here). Earlier the same day: a violet tile
// with a needle (flat at low readings, it read as a key), then a bare white
// gauge glyph; he swapped that for an exact number.
//
// The app icon (Start Menu, window) keeps the violet tile with the gauge.
//
// Rejected for the gauge after looking at them side by side (scripts/preview-icons.js):
// - a thin bare ring: read as a loading spinner next to solid brand marks;
// - a 270-degree ring: read as a horseshoe, and with a needle as an "@";
// - a state-coloured tile with a white arc: the amber tile is a second orange
//   square next to the Claude Code Usage Monitor's coral "93";
// - one colour for arc and needle: at 90 %+ they merge into a "G".

const DIGITS = require('./digits');

const TAU = Math.PI * 2;

// Brand tile. Violet is free in this flyout: Bitwarden and Bluetooth are blue,
// Discord is blurple (#5865F2, visibly bluer), NVIDIA green, the Usage Monitor
// coral. White on it: 5.7:1. Against a dark taskbar #202020: 2.9:1, light: 4.9:1.
const TILE = '#7C3AED';
// Pace colours, brighter cousins of the UI's limit-state tokens (--ok, --warn,
// --bad in src/renderer/styles.css): the UI tones are tuned for the dark panel
// and lose contrast on violet (green 2.8 -> 3.5, amber 3.1 -> 3.6, red 1.8 -> 2.2).
const ARC = {
  ok: '#5EE38A', // reserve / on-pace
  warn: '#FFC53D', // deficit
  full: '#FF7676', // full
  none: '#FFFFFF',
};
const NEEDLE = '#FFFFFF';
const TRACK_ALPHA = 0.28; // white over the tile: the unused part of the window
const APP_ICON_PCT = 62; // the app icon's fixed reading: no state, just a pleasant gauge
// The tray number's tile and digit colours. Graphite reads on a dark taskbar
// (#202020, a step lighter) and a light one alike; white on it is 11:1, white on
// the red 4:1.
const NUMBER = {
  ok: { tile: '#3A3A3A', ink: '#FFFFFF' },
  full: { tile: '#E5484D', ink: '#FFFFFF' },
};

function hex(color, alpha = 1) {
  const h = color.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), alpha];
}

/** Clockwise angle from 12 o'clock, 0..TAU. */
function clockAngle(dx, dy) {
  const a = Math.atan2(dx, -dy);
  return a < 0 ? a + TAU : a;
}

function inside(shape, x, y) {
  switch (shape.type) {
    case 'roundrect': {
      const hw = (shape.x1 - shape.x0) / 2;
      const hh = (shape.y1 - shape.y0) / 2;
      const qx = Math.abs(x - (shape.x0 + hw)) - (hw - shape.radius);
      const qy = Math.abs(y - (shape.y0 + hh)) - (hh - shape.radius);
      const ox = Math.max(qx, 0);
      const oy = Math.max(qy, 0);
      return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - shape.radius <= 0;
    }
    case 'disc':
      return Math.hypot(x - shape.cx, y - shape.cy) <= shape.r;
    case 'segment': {
      // capsule: distance from the point to the segment <= half the width
      const vx = shape.x1 - shape.x0;
      const vy = shape.y1 - shape.y0;
      const len2 = vx * vx + vy * vy || 1;
      const t = Math.max(0, Math.min(1, ((x - shape.x0) * vx + (y - shape.y0) * vy) / len2));
      return Math.hypot(x - (shape.x0 + t * vx), y - (shape.y0 + t * vy)) <= shape.width / 2;
    }
    case 'arc': {
      const dx = x - shape.cx;
      const dy = y - shape.cy;
      const r = Math.hypot(dx, dy);
      if (shape.sweep >= TAU) return r >= shape.rIn && r <= shape.rOut;
      const start = shape.start || 0;
      let rel = clockAngle(dx, dy) - start;
      if (rel < 0) rel += TAU;
      if (r >= shape.rIn && r <= shape.rOut && rel <= shape.sweep) return true;
      if (!shape.caps) return false;
      const rMid = (shape.rIn + shape.rOut) / 2;
      const capR = (shape.rOut - shape.rIn) / 2;
      // round caps at both ends of the sweep
      for (const ang of [start, start + shape.sweep]) {
        if (Math.hypot(dx - Math.sin(ang) * rMid, dy + Math.cos(ang) * rMid) <= capR) return true;
      }
      return false;
    }
    default:
      return false;
  }
}

/** Rasterise shapes (painter's order) into a size x size straight-alpha RGBA buffer. */
function rasterise(size, shapes, samples = size <= 64 ? 8 : 6) {
  const out = Buffer.alloc(size * size * 4);
  const n = samples * samples;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let ar = 0;
      let ag = 0;
      let ab = 0;
      let aa = 0;
      for (let sy = 0; sy < samples; sy++) {
        const y = py + (sy + 0.5) / samples;
        for (let sx = 0; sx < samples; sx++) {
          const x = px + (sx + 0.5) / samples;
          // premultiplied source-over per sample
          let r = 0;
          let g = 0;
          let b = 0;
          let a = 0;
          for (const s of shapes) {
            if (!inside(s, x, y)) continue;
            const [cr, cg, cb, ca] = s.color;
            r = cr * ca + r * (1 - ca);
            g = cg * ca + g * (1 - ca);
            b = cb * ca + b * (1 - ca);
            a = ca + a * (1 - ca);
          }
          ar += r;
          ag += g;
          ab += b;
          aa += a;
        }
      }
      const i = (py * size + px) * 4;
      const alpha = aa / n;
      if (alpha > 0) {
        out[i] = Math.round(Math.min(255, ar / n / alpha));
        out[i + 1] = Math.round(Math.min(255, ag / n / alpha));
        out[i + 2] = Math.round(Math.min(255, ab / n / alpha));
        out[i + 3] = Math.round(alpha * 255);
      }
    }
  }
  return out;
}

/**
 * Tile, gauge and needle geometry for one pixel size, snapped to the grid:
 * - tile edges, corner radius, gauge radius and stroke are whole pixels, and
 *   the gauge centre is a pixel corner, so the arc's top edge (12 o'clock) and
 *   its end faces (9 and 3 o'clock) fall on pixel boundaries;
 * - the needle is an even number of pixels wide about that centre, so at 0 %,
 *   50 % and 100 % (horizontal / vertical) it is crisp too;
 * - the centre sits low: the ink runs from the arc's top down to the hub, and
 *   that span is centred in the tile.
 * inset: transparent margin around the tile (the app icon has one, the tray
 * icon fills its cell like the other brand marks).
 */
function tileGeometry(size, { inset = 0 } = {}) {
  const tile = size - 2 * inset;
  const cx = size / 2;
  const half = size % 2 ? 0.5 : 0; // odd sizes: centre on a pixel middle, radius x.5
  const rOut = Math.round(tile * 0.42) - half;
  const stroke = Math.max(2, Math.round(tile * 0.15));
  const rIn = rOut - stroke;
  const hub = Math.max(1.5, Math.round((0.4 + tile * 0.068) * 2) / 2); // 1.5 at 16, 2 at 20-24, 2.5 at 32
  const width = Math.max(2, 2 * Math.round(tile * 0.045));
  const below = Math.max(stroke / 2, hub); // ink below the centre: end caps or hub
  const cy = Math.round(size / 2 + (rOut - below) / 2 - half) + half;
  return {
    size,
    inset,
    tileRadius: Math.max(2, Math.round(tile * 0.22 * 2) / 2),
    cx,
    cy,
    rOut,
    rIn,
    stroke,
    start: (TAU * 3) / 4, // 9 o'clock, clockwise over the top
    sweep: TAU / 2, // to 3 o'clock
    needle: { width, hub, len: rIn - Math.max(1, tile * 0.04) },
  };
}

/**
 * Shapes for the tile + gauge. pct 0..100 fills that share of the half circle
 * and points the needle at it; null (no data yet) draws the empty track and no
 * needle, so it never reads as "0 % used".
 */
function tileShapes(g, { tile, track, fill, needle, pct = null }) {
  const shapes = [];
  shapes.push({ type: 'roundrect', x0: g.inset, y0: g.inset, x1: g.size - g.inset, y1: g.size - g.inset, radius: g.tileRadius, color: tile });
  const ring = { cx: g.cx, cy: g.cy, rIn: g.rIn, rOut: g.rOut, start: g.start, caps: true };
  shapes.push({ type: 'arc', ...ring, sweep: g.sweep, color: track });
  if (pct == null || !Number.isFinite(pct)) return shapes;
  const sweep = (Math.max(0, Math.min(100, pct)) / 100) * g.sweep;
  shapes.push({ type: 'arc', ...ring, sweep, color: fill });
  const ang = g.start + sweep;
  const n = g.needle;
  shapes.push({
    type: 'segment',
    x0: g.cx,
    y0: g.cy,
    x1: g.cx + Math.sin(ang) * n.len,
    y1: g.cy - Math.cos(ang) * n.len,
    width: n.width,
    color: needle,
  });
  shapes.push({ type: 'disc', cx: g.cx, cy: g.cy, r: n.hub, color: needle });
  return shapes;
}

/** One tray size's digit masks: that size, or the nearest one generated. */
function digitSet(size) {
  if (DIGITS.sizes[size]) return DIGITS.sizes[size];
  const sizes = Object.keys(DIGITS.sizes).map(Number);
  return DIGITS.sizes[sizes.reduce((a, b) => (Math.abs(b - size) < Math.abs(a - size) ? b : a))];
}

/**
 * The characters' masks side by side at whole-pixel pen positions, as one alpha
 * box around the ink. At tray sizes the font's own spacing lets "47" touch, so
 * each character keeps at least one clear pixel column after the one before.
 */
function inkOf(glyphs, text) {
  let pen = 0;
  const placed = [];
  for (const ch of text) {
    const g = glyphs[ch];
    const prev = placed[placed.length - 1];
    const x = prev ? Math.max(pen + g.x, prev.x + prev.g.w + 1) : pen + g.x;
    placed.push({ g, x, y: g.y, a: Buffer.from(g.a, 'base64') });
    pen = x - g.x + Math.round(g.adv);
  }
  const x0 = Math.min(...placed.map((p) => p.x));
  const y0 = Math.min(...placed.map((p) => p.y));
  const w = Math.max(...placed.map((p) => p.x + p.g.w)) - x0;
  const h = Math.max(...placed.map((p) => p.y + p.g.h)) - y0;
  const alpha = new Uint8Array(w * h);
  for (const p of placed) {
    for (let y = 0; y < p.g.h; y++) {
      for (let x = 0; x < p.g.w; x++) {
        const i = (p.y - y0 + y) * w + (p.x - x0 + x);
        alpha[i] = Math.max(alpha[i], p.a[y * p.g.w + x]);
      }
    }
  }
  return { w, h, alpha };
}

/** What the tray shows for a reading: the colours and the characters. Only "full" changes the colours. */
function trayFace(pct, tone) {
  const known = pct != null && Number.isFinite(pct);
  if (tone === 'full' || (known && pct >= 100)) return { ...NUMBER.full, cls: 'bang', text: '!' };
  if (!known) return { ...NUMBER.ok, cls: 'one', text: '–' };
  // 99.6 % that is not full yet reads 99: three digits never appear
  const text = String(Math.min(99, Math.max(0, Math.round(pct))));
  return { ...NUMBER.ok, cls: text.length > 1 ? 'two' : 'one', text };
}

/**
 * Tray icon. pct: 0..100 or null (no data). tone: ok | warn | full | none; warn
 * draws like ok (graphite, his call), full draws the red "!".
 * The tile is its own background, so it reads on a light and a dark taskbar
 * alike (tray.js also passes lightTaskbar; it changes nothing).
 */
function trayIconRGBA(size, { pct = null, tone = 'none' } = {}) {
  const face = trayFace(pct, tone);
  const tile = { type: 'roundrect', x0: 0, y0: 0, x1: size, y1: size, radius: tileGeometry(size).tileRadius, color: hex(face.tile) };
  const out = rasterise(size, [tile]);
  const ink = inkOf(digitSet(size)[face.cls].glyphs, face.text);
  const [r, g, b] = hex(face.ink);
  const ox = Math.round((size - ink.w) / 2);
  const oy = Math.round((size - ink.h) / 2);
  for (let y = 0; y < ink.h; y++) {
    for (let x = 0; x < ink.w; x++) {
      const a = ink.alpha[y * ink.w + x] / 255;
      if (!a) continue;
      const i = ((oy + y) * size + (ox + x)) * 4;
      out[i] = Math.round(r * a + out[i] * (1 - a));
      out[i + 1] = Math.round(g * a + out[i + 1] * (1 - a));
      out[i + 2] = Math.round(b * a + out[i + 2] * (1 - a));
    }
  }
  return out;
}

/**
 * App icon (Start Menu shortcut, window icon): the violet tile with a fixed,
 * healthy reading and no live state. The arc is the reserve green, not white:
 * a white arc meets the white needle and the pair reads as a "7". A small
 * margin from 48 px up, like other Windows app icons; edge to edge below that,
 * where every pixel counts.
 */
function appIconRGBA(size) {
  const inset = size >= 48 ? Math.round(size / 16) : 0;
  const g = tileGeometry(size, { inset });
  return rasterise(
    size,
    tileShapes(g, {
      tile: hex(TILE),
      track: [255, 255, 255, TRACK_ALPHA],
      fill: hex(ARC.ok),
      needle: hex(NEEDLE),
      pct: APP_ICON_PCT,
    }),
  );
}

module.exports = { TILE, ARC, NUMBER, hex, rasterise, tileGeometry, trayIconRGBA, appIconRGBA };
