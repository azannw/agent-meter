'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../position');

// The user's laptop: 2560x1440 at 125% => 2048x1152 DIP, bottom taskbar 48 DIP.
const laptop = {
  id: 1,
  scaleFactor: 1.25,
  bounds: { x: 0, y: 0, width: 2048, height: 1152 },
  workArea: { x: 0, y: 0, width: 2048, height: 1104 },
};
// A second monitor to the left at 100%, taskbar on top.
const left = {
  id: 2,
  scaleFactor: 1,
  bounds: { x: -1920, y: 0, width: 1920, height: 1080 },
  workArea: { x: -1920, y: 40, width: 1920, height: 1040 },
};

test('bottom taskbar: centred on the icon, 12 px above the work area', () => {
  const tray = { x: 1800, y: 1112, width: 32, height: 40 };
  const b = P.panelBounds({ trayBounds: tray, display: laptop, height: 600 });
  assert.equal(b.edge, 'bottom');
  assert.equal(b.anchored, true);
  assert.equal(b.width, 400);
  assert.equal(b.height, 600);
  assert.equal(b.x, 1816 - 200);
  assert.equal(b.y + b.height, 1104 - 12);
  assert.deepEqual(b.slide, { dx: 0, dy: 1 });
  const s = P.slideStart(b);
  assert.equal(s.y, b.y + 24);
});

test('bottom taskbar: clamped 12 px inside the work area near the right edge', () => {
  const tray = { x: 2010, y: 1112, width: 32, height: 40 };
  const b = P.panelBounds({ trayBounds: tray, display: laptop, height: 500 });
  assert.equal(b.x + b.width, 2048 - 12);
});

test('icon inside the overflow flyout (above the taskbar): bottom-right fallback', () => {
  const flyoutIcon = { x: 1700, y: 1000, width: 32, height: 32 };
  const b = P.panelBounds({ trayBounds: flyoutIcon, display: laptop, height: 500 });
  assert.equal(b.anchored, false);
  assert.equal(b.x + b.width, 2048 - 12);
  assert.equal(b.y + b.height, 1104 - 12);
});

test('empty or garbage tray rect: fallback, primary display', () => {
  for (const tb of [null, { x: 0, y: 0, width: 0, height: 0 }, { x: NaN, y: 1, width: 2, height: 2 }]) {
    const d = P.pickDisplay([left, laptop], laptop, tb);
    assert.equal(d.id, laptop.id);
    const b = P.panelBounds({ trayBounds: tb, display: d, height: 500 });
    assert.equal(b.anchored, false);
    assert.equal(b.x + b.width, 2036);
  }
});

test('top taskbar on a second monitor: below the bar, slides down from above', () => {
  const tray = { x: -300, y: 4, width: 32, height: 32 };
  const d = P.pickDisplay([left, laptop], laptop, tray);
  assert.equal(d.id, 2);
  const b = P.panelBounds({ trayBounds: tray, display: d, height: 500 });
  assert.equal(b.edge, 'top');
  assert.equal(b.anchored, true);
  assert.equal(b.y, 40 + 12);
  assert.equal(b.x, -284 - 200);
  assert.deepEqual(b.slide, { dx: 0, dy: -1 });
});

test('left and right taskbars slide sideways', () => {
  const leftBar = { id: 3, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 60, y: 0, width: 1860, height: 1080 } };
  const b = P.panelBounds({ trayBounds: { x: 10, y: 500, width: 40, height: 32 }, display: leftBar, height: 400 });
  assert.equal(b.edge, 'left');
  assert.equal(b.x, 72);
  assert.equal(b.y, 516 - 200);
  assert.deepEqual(b.slide, { dx: -1, dy: 0 });
  const rightBar = { id: 4, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1860, height: 1080 } };
  const r = P.panelBounds({ trayBounds: { x: 1870, y: 1040, width: 40, height: 32 }, display: rightBar, height: 400 });
  assert.equal(r.edge, 'right');
  assert.equal(r.x + r.width, 1860 - 12);
  assert.equal(r.y + r.height, 1080 - 12); // clamped
});

test('auto-hide taskbar: edge from the tray position, panel clears the bar', () => {
  const auto = { id: 5, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1080 } };
  const b = P.panelBounds({ trayBounds: { x: 1500, y: 1032, width: 32, height: 48 }, display: auto, height: 400 });
  assert.equal(b.edge, 'bottom');
  assert.equal(b.anchored, true);
  assert.equal(b.autoHide, true);
  assert.equal(b.y + b.height, 1080 - 48 - 12);
  assert.equal(b.x, 1516 - 200);
});

// What this laptop actually reports (2026-10-02): 131.25 %, auto-hide taskbar,
// workArea == bounds, the tray rect sitting mostly below the screen.
const autoHideLaptop = {
  id: 4090082943,
  scaleFactor: 1.3125,
  bounds: { x: 0, y: 0, width: 1951, height: 1098 },
  workArea: { x: 0, y: 0, width: 1951, height: 1098 },
};
const leftMonitor = {
  id: 2177413973,
  scaleFactor: 1.3125,
  bounds: { x: -1463, y: 0, width: 1463, height: 823 },
  workArea: { x: -1463, y: 0, width: 1463, height: 823 },
};

test('hidden auto-hide bar: tray rect below the screen still anchors to that display', () => {
  const tray = { x: 1752, y: 1096, width: 31, height: 47 };
  const d = P.pickDisplay([leftMonitor, autoHideLaptop], autoHideLaptop, tray);
  assert.equal(d.id, autoHideLaptop.id);
  const b = P.panelBounds({ trayBounds: tray, display: d, height: 560 });
  assert.equal(b.edge, 'bottom');
  assert.equal(b.anchored, true);
  assert.equal(b.y + b.height, 1098 - 47 - 12); // above where the bar slides up to
  assert.equal(b.x + b.width, 1951 - 12); // centring on 1767.5 would overflow: clamped
});

test('shown auto-hide bar (rect at click time): same resting place', () => {
  const tray = { x: 1752, y: 1051, width: 31, height: 47 };
  const b = P.panelBounds({ trayBounds: tray, display: autoHideLaptop, height: 560 });
  assert.equal(b.anchored, true);
  assert.equal(b.y + b.height, 1098 - 47 - 12);
});

test('a tray rect far from every display is ignored', () => {
  const far = { x: 5000, y: 5000, width: 30, height: 40 };
  const d = P.pickDisplay([leftMonitor, autoHideLaptop], autoHideLaptop, far);
  assert.equal(d.id, autoHideLaptop.id);
  assert.equal(P.panelBounds({ trayBounds: far, display: d, height: 400 }).anchored, false);
});

test('height clamps: min 240, max 85% of the work area', () => {
  assert.equal(P.clampHeight(100, laptop.workArea), 240);
  assert.equal(P.clampHeight(5000, laptop.workArea), Math.floor(1104 * 0.85));
  assert.equal(P.clampHeight(NaN, laptop.workArea), 240);
  assert.equal(P.clampHeight(612.4, laptop.workArea), 612);
});

test('easing is ease-out, clamped to 0..1', () => {
  assert.equal(P.easeOutCubic(0), 0);
  assert.equal(P.easeOutCubic(1), 1);
  assert.equal(P.easeOutCubic(2), 1);
  assert.ok(P.easeOutCubic(0.5) > 0.5);
});
