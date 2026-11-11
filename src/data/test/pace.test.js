'use strict';
process.env.TZ = 'Asia/Karachi';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computePace } = require('../pace');

const H = 3600e3;
const NOW = Date.parse('2026-10-02T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const near = (isoStr, ms) => assert.ok(Math.abs(Date.parse(isoStr) - ms) <= 1, `${isoStr} vs ${iso(ms)}`);

test('full: usedPct >= 100 is full, no projection, does not last', () => {
  const p = computePace({ usedPct: 100, resetsAt: iso(NOW + 24 * H), windowMinutes: 10080, now: NOW });
  assert.equal(p.state, 'full');
  assert.equal(p.runsOutAt, null);
  assert.equal(p.lastsUntilReset, false);
  assert.equal(computePace({ usedPct: 130, resetsAt: iso(NOW + H), windowMinutes: 300, now: NOW }).state, 'full');
});

test('deficit with runsOutAt: weekly window, 90% used with 72% elapsed', () => {
  // 7-day window, resets in 47.04 h => elapsed 120.96 h of 168 h = 72%
  const resetsAt = iso(NOW + 47.04 * H);
  const p = computePace({ usedPct: 90, resetsAt, windowMinutes: 10080, now: NOW });
  assert.equal(p.expectedPct, 72);
  assert.equal(p.deltaPct, 18);
  assert.equal(p.state, 'deficit');
  // average rate 90% per 120.96 h => 100% at 134.4 h after the start, before the reset at 168 h
  const start = NOW + 47.04 * H - 168 * H;
  near(p.runsOutAt, start + 134.4 * H);
  assert.equal(p.lastsUntilReset, false);
});

test('reserve with lastsUntilReset: session window, 12% used with 50% elapsed', () => {
  const p = computePace({ usedPct: 12, resetsAt: iso(NOW + 2.5 * H), windowMinutes: 300, now: NOW });
  assert.equal(p.expectedPct, 50);
  assert.equal(p.deltaPct, -38);
  assert.equal(p.state, 'reserve');
  assert.equal(p.runsOutAt, null);
  assert.equal(p.lastsUntilReset, true);
});

test('on-pace band is |delta| < 3', () => {
  const resetsAt = iso(NOW + 2.5 * H); // 50% elapsed
  assert.equal(computePace({ usedPct: 52.9, resetsAt, windowMinutes: 300, now: NOW }).state, 'on-pace');
  assert.equal(computePace({ usedPct: 47.1, resetsAt, windowMinutes: 300, now: NOW }).state, 'on-pace');
  assert.equal(computePace({ usedPct: 53, resetsAt, windowMinutes: 300, now: NOW }).state, 'deficit');
  assert.equal(computePace({ usedPct: 47, resetsAt, windowMinutes: 300, now: NOW }).state, 'reserve');
  // on-pace but slightly ahead: the average rate still runs out just before the reset
  const slight = computePace({ usedPct: 52, resetsAt, windowMinutes: 300, now: NOW });
  assert.equal(slight.state, 'on-pace');
  near(slight.runsOutAt, NOW - 2.5 * H + (2.5 * H * 100) / 52);
  assert.equal(slight.lastsUntilReset, false);
  // slightly behind: lasts
  const behind = computePace({ usedPct: 48, resetsAt, windowMinutes: 300, now: NOW });
  assert.equal(behind.runsOutAt, null);
  assert.equal(behind.lastsUntilReset, true);
});

test('no reset time (e.g. a session that has not started): nothing elapsed, nothing projected', () => {
  const p = computePace({ usedPct: 0, resetsAt: null, windowMinutes: 300, now: NOW });
  assert.equal(p.expectedPct, 0);
  assert.equal(p.deltaPct, 0);
  assert.equal(p.runsOutAt, null);
  assert.equal(p.lastsUntilReset, true);
});
