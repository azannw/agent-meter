'use strict';
// Pure placement maths for the panel. Everything is in DIP (Electron's screen
// coordinates). No Electron imports, so it is unit-tested under plain Node.

const PANEL_WIDTH = 400;
const MARGIN = 12;
const MIN_HEIGHT = 240;
const MAX_HEIGHT_SHARE = 0.85;
const SLIDE_DISTANCE = 24;
const NEAR = 64; // DIP: how far outside a display a tray rect may sit and still belong to it
const DEFAULT_BAR = 48; // Windows 11 taskbar thickness at 100 %, in DIP

const right = (r) => r.x + r.width;
const bottom = (r) => r.y + r.height;
const center = (r) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
const contains = (r, p, slack = 0) =>
  p.x >= r.x - slack && p.x <= right(r) + slack && p.y >= r.y - slack && p.y <= bottom(r) + slack;

function validRect(r) {
  return !!r && [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width > 0 && r.height > 0;
}

function gapsOf(display) {
  const b = display.bounds;
  const wa = display.workArea;
  return { bottom: bottom(b) - bottom(wa), top: wa.y - b.y, left: wa.x - b.x, right: right(b) - right(wa) };
}

/** Signed distance from each display edge to a point: negative = beyond that edge. */
function edgeDistances(b, c) {
  return { bottom: bottom(b) - c.y, top: c.y - b.y, left: c.x - b.x, right: right(b) - c.x };
}

/**
 * Which edge the taskbar is docked to, from workArea vs bounds. With several
 * bars, or none (auto-hide: workArea == bounds), the edge nearest the tray icon
 * wins. A hidden auto-hide taskbar keeps its icons just beyond the screen edge,
 * so a centre slightly outside the display still counts.
 */
function taskbarEdge(display, trayBounds) {
  const b = display.bounds;
  const docked = Object.entries(gapsOf(display)).filter(([, g]) => g > 0);
  if (docked.length === 1) return docked[0][0];
  if (validRect(trayBounds) && contains(b, center(trayBounds), NEAR)) {
    const dist = edgeDistances(b, center(trayBounds));
    const candidates = docked.length ? docked.map(([e]) => e) : Object.keys(dist);
    return candidates.sort((p, q) => dist[p] - dist[q])[0];
  }
  return docked.length ? docked.sort((p, q) => q[1] - p[1])[0][0] : 'bottom';
}

/** Depth of an auto-hide bar: the tray rect's size across the edge, if plausible. */
function autoHideThickness(edge, trayBounds) {
  if (!validRect(trayBounds)) return DEFAULT_BAR;
  const t = edge === 'bottom' || edge === 'top' ? trayBounds.height : trayBounds.width;
  return t >= 16 && t <= 160 ? Math.round(t) : DEFAULT_BAR;
}

/**
 * The taskbar's rectangle on that edge, where it is drawn when shown. An
 * auto-hide bar is not reserved in the work area, so its depth comes from the
 * tray rect (or 48 DIP).
 */
function taskbarRect(display, edge, trayBounds) {
  const b = display.bounds;
  const g = gapsOf(display)[edge];
  const autoHide = !(g > 0);
  const t = autoHide ? autoHideThickness(edge, trayBounds) : g;
  switch (edge) {
    case 'top':
      return { x: b.x, y: b.y, width: b.width, height: t, autoHide };
    case 'left':
      return { x: b.x, y: b.y, width: t, height: b.height, autoHide };
    case 'right':
      return { x: right(b) - t, y: b.y, width: t, height: b.height, autoHide };
    default:
      return { x: b.x, y: bottom(b) - t, width: b.width, height: t, autoHide };
  }
}

/** Is the tray icon on the taskbar (as opposed to inside the overflow flyout, or nowhere)? */
function onTaskbar(bar, edge, trayBounds) {
  if (!validRect(trayBounds)) return false;
  const c = center(trayBounds);
  if (!bar.autoHide) return contains(bar, c, 2);
  // a hidden auto-hide bar keeps its icons up to one bar-depth beyond the edge
  const g = { x: bar.x, y: bar.y, width: bar.width, height: bar.height };
  if (edge === 'bottom') g.height += bar.height;
  else if (edge === 'top') {
    g.y -= bar.height;
    g.height += bar.height;
  } else if (edge === 'left') {
    g.x -= bar.width;
    g.width += bar.width;
  } else g.width += bar.width;
  return contains(g, c, 2);
}

/** The area the panel may use: the work area, minus an auto-hide bar's band. */
function usableArea(display, edge, bar) {
  const wa = { ...display.workArea };
  if (!bar.autoHide) return wa;
  if (edge === 'bottom') wa.height -= bar.height;
  else if (edge === 'top') {
    wa.y += bar.height;
    wa.height -= bar.height;
  } else if (edge === 'left') {
    wa.x += bar.width;
    wa.width -= bar.width;
  } else wa.width -= bar.width;
  return wa;
}

/**
 * Pick the display the panel belongs to. displays: Electron Display[].
 * A tray rect is trusted when its centre lies inside a display, or within
 * NEAR DIP of one (hidden auto-hide bar); otherwise use the primary.
 */
function pickDisplay(displays, primary, trayBounds) {
  if (validRect(trayBounds)) {
    const c = center(trayBounds);
    const hit = displays.find((d) => contains(d.bounds, c));
    if (hit) return hit;
    let best = null;
    let bestDist = Infinity;
    for (const d of displays) {
      const dx = Math.max(d.bounds.x - c.x, 0, c.x - right(d.bounds));
      const dy = Math.max(d.bounds.y - c.y, 0, c.y - bottom(d.bounds));
      const dist = Math.hypot(dx, dy);
      if (dist < bestDist) {
        best = d;
        bestDist = dist;
      }
    }
    if (best && bestDist <= NEAR) return best;
  }
  return primary;
}

function clampHeight(height, workArea) {
  const max = Math.floor(workArea.height * MAX_HEIGHT_SHARE);
  const h = Number.isFinite(height) ? Math.round(height) : MIN_HEIGHT;
  return Math.max(Math.min(MIN_HEIGHT, max), Math.min(max, h));
}

const clamp = (v, lo, hi) => (hi < lo ? lo : Math.min(hi, Math.max(lo, v)));

/**
 * Resting bounds of the panel, plus the direction it slides in from.
 * - Tray icon on the taskbar: centred on the icon along the taskbar, MARGIN
 *   off the work area edge, clamped MARGIN inside the work area.
 * - Tray icon elsewhere (inside the overflow flyout, or its rect is odd):
 *   the work-area corner next to the clock (bottom-right for a bottom bar).
 */
function panelBounds({ trayBounds, display, height, width = PANEL_WIDTH, margin = MARGIN }) {
  const edge = taskbarEdge(display, trayBounds);
  const bar = taskbarRect(display, edge, trayBounds);
  const anchored = onTaskbar(bar, edge, trayBounds);
  const wa = usableArea(display, edge, bar);
  const h = clampHeight(height, wa);
  const w = Math.min(width, wa.width - 2 * margin);
  const minX = wa.x + margin;
  const maxX = right(wa) - margin - w;
  const minY = wa.y + margin;
  const maxY = bottom(wa) - margin - h;
  let x;
  let y;
  if (edge === 'bottom' || edge === 'top') {
    y = edge === 'bottom' ? maxY : minY;
    x = anchored ? center(trayBounds).x - w / 2 : maxX;
  } else {
    x = edge === 'left' ? minX : maxX;
    y = anchored ? center(trayBounds).y - h / 2 : maxY;
  }
  x = Math.round(clamp(x, minX, maxX));
  y = Math.round(clamp(y, minY, maxY));
  const slide = { bottom: [0, 1], top: [0, -1], left: [-1, 0], right: [1, 0] }[edge];
  return { x, y, width: w, height: h, edge, anchored, autoHide: bar.autoHide, slide: { dx: slide[0], dy: slide[1] } };
}

/** Bounds of the first animation frame: SLIDE_DISTANCE further out toward the taskbar. */
function slideStart(rest, distance = SLIDE_DISTANCE) {
  return { ...rest, x: rest.x + rest.slide.dx * distance, y: rest.y + rest.slide.dy * distance };
}

const easeOutCubic = (t) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);

// CONTRACT section 8: the window is the panel plus a transparent 12 px margin.
const WINDOW_MARGIN = 12;

function windowBoundsFor(panel, margin = WINDOW_MARGIN) {
  return { x: panel.x - margin, y: panel.y - margin, width: panel.width + 2 * margin, height: panel.height + 2 * margin };
}

/** Where a screen point falls on the window: 'panel' | 'margin' | 'outside' (half-open edges). */
function hitZone(win, point, margin = WINDOW_MARGIN) {
  if (!validRect(win) || !point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return 'outside';
  const inside = (x0, y0, x1, y1) => point.x >= x0 && point.x < x1 && point.y >= y0 && point.y < y1;
  if (!inside(win.x, win.y, win.x + win.width, win.y + win.height)) return 'outside';
  return inside(win.x + margin, win.y + margin, win.x + win.width - margin, win.y + win.height - margin) ? 'panel' : 'margin';
}

module.exports = {
  WINDOW_MARGIN,
  windowBoundsFor,
  hitZone,
  PANEL_WIDTH,
  MARGIN,
  MIN_HEIGHT,
  SLIDE_DISTANCE,
  validRect,
  taskbarEdge,
  taskbarRect,
  usableArea,
  pickDisplay,
  clampHeight,
  panelBounds,
  slideStart,
  easeOutCubic,
};
