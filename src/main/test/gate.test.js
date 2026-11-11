'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { gateState } = require('../gate');
const P = require('../position');

test('paint gate: loading, painting, settling, ready', () => {
  const base = { loaded: true, contentSeq: 3, paintedSeq: 3, paintedAt: 1000, lastHeightAt: 900, lastResizeAt: 950, quietMs: 60 };
  assert.equal(gateState({ ...base, loaded: false, now: 5000 }), 'loading');
  assert.equal(gateState({ ...base, paintedSeq: 2, now: 5000 }), 'painting');
  assert.equal(gateState({ ...base, now: 1030 }), 'settling'); // painted 30 ms ago
  assert.equal(gateState({ ...base, lastHeightAt: 1050, now: 1100 }), 'settling'); // height 50 ms ago
  assert.equal(gateState({ ...base, now: 1061 }), 'ready');
});

test('window = panel + 12 px margin; hit zones are half-open', () => {
  const w = P.windowBoundsFor({ x: 100, y: 200, width: 400, height: 500 });
  assert.deepEqual(w, { x: 88, y: 188, width: 424, height: 524 });
  assert.equal(P.hitZone(w, { x: 88, y: 300 }), 'margin');
  assert.equal(P.hitZone(w, { x: 99, y: 300 }), 'margin');
  assert.equal(P.hitZone(w, { x: 100, y: 300 }), 'panel');
  assert.equal(P.hitZone(w, { x: 499, y: 699 }), 'panel');
  assert.equal(P.hitZone(w, { x: 500, y: 300 }), 'margin');
  assert.equal(P.hitZone(w, { x: 512, y: 300 }), 'outside');
  assert.equal(P.hitZone(w, { x: 87, y: 300 }), 'outside');
  assert.equal(P.hitZone(null, { x: 0, y: 0 }), 'outside');
});
