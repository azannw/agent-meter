'use strict';
process.env.TZ = 'Asia/Karachi';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createCodexScanner } = require('../scan-codex');
const { localMidnight, lastNDates } = require('../util');
const { mkTmp, rmrf, writeLines, setMtime, codexMeta, codexTurn, codexTokens } = require('./helpers');

const NOW = Date.parse('2026-10-02T12:00:00.000Z');
const opts = (now = NOW) => ({ retentionStartMs: localMidnight(now, 31), fromDate: lastNDates(now, 32)[0], now });

function fixture() {
  const root = mkTmp('codex');
  const home = path.join(root, 'home');
  const dir = path.join(home, '.codex', 'sessions', '2026', '10', '01');
  fs.mkdirSync(dir, { recursive: true });
  return { root, home, dir, state: path.join(root, 'state') };
}

function sum(buckets) {
  const t = [0, 0, 0, 0, 0, 0];
  for (const b of Object.values(buckets)) for (let i = 0; i < 6; i++) t[i] += b[i];
  return t;
}

const RATE = (pct, resetsAtSecs, plan = 'plus') => ({
  limit_id: 'codex',
  primary: { used_percent: pct, window_minutes: 300, resets_at: resetsAtSecs },
  secondary: { used_percent: pct / 2, window_minutes: 10080, resets_at: resetsAtSecs + 86400 },
  credits: null,
  plan_type: plan,
});

test('repeated token_count with an unchanged total is not double counted', async () => {
  const f = fixture();
  try {
    const sid = '11111111-2222-3333-4444-555555555555';
    writeLines(path.join(f.dir, `rollout-2026-10-01T10-00-00-${sid}.jsonl`), [
      codexMeta({ ts: '2026-10-01T10:00:00.000Z', id: sid }),
      codexTurn({ ts: '2026-10-01T10:00:01.000Z', model: 'gpt-5.5' }),
      codexTokens({ ts: '2026-10-01T10:00:02.000Z', last: [1000, 800, 50, 20], total: [1000, 800, 50] }),
      codexTokens({ ts: '2026-10-01T10:00:03.000Z', last: [1000, 800, 50, 20], total: [1000, 800, 50] }), // repeat
      codexTokens({ ts: '2026-10-01T10:00:04.000Z', last: [500, 100, 30, 0], total: [1500, 900, 80], rate: RATE(12, 1790960000) }),
      codexTokens({ ts: '2026-10-01T10:00:05.000Z' }), // info null
    ]);
    const r = await createCodexScanner({ stateDir: f.state, home: f.home }).scan(opts());
    // input = input - cached: (1000-800) + (500-100); cacheRead = cached; output includes reasoning
    assert.deepEqual(sum(r.buckets), [600, 80, 900, 0, 0, 2]);
    assert.equal(r.stats.repeats, 1);
    const key = Object.keys(r.buckets)[0].split('\t');
    assert.equal(key[0], '2026-10-01');
    assert.equal(key[2], sid);
    assert.equal(key[3], 'gpt-5.5');
    assert.equal(r.rate.primary.usedPct, 12);
    assert.equal(r.rate.primary.windowMinutes, 300);
    assert.equal(r.rate.primary.resetsAt, new Date(1790960000 * 1000).toISOString());
    assert.equal(r.plan.planType, 'plus');
  } finally {
    rmrf(f.root);
  }
});

test('incremental Codex append keeps the running total across scans', async () => {
  const f = fixture();
  try {
    const file = path.join(f.dir, 'rollout-2026-10-01T10-00-00-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl');
    writeLines(file, [
      codexTurn({ ts: '2026-10-01T10:00:01.000Z', model: 'gpt-5.5' }),
      codexTokens({ ts: '2026-10-01T10:00:02.000Z', last: [100, 0, 10], total: [100, 0, 10] }),
    ]);
    const scanner = createCodexScanner({ stateDir: f.state, home: f.home });
    await scanner.scan(opts());
    writeLines(file, [
      codexTokens({ ts: '2026-10-01T10:00:03.000Z', last: [100, 0, 10], total: [100, 0, 10] }), // repeat, across scans
      codexTurn({ ts: '2026-10-01T10:00:04.000Z', model: 'gpt-5.6' }),
      codexTokens({ ts: '2026-10-01T10:00:05.000Z', last: [50, 0, 5], total: [150, 0, 15] }),
    ], { append: true });
    const r = await createCodexScanner({ stateDir: f.state, home: f.home }).scan(opts()); // restart in between
    assert.deepEqual(sum(r.buckets).slice(0, 3), [150, 15, 0]);
    const models = Object.keys(r.buckets).map((k) => k.split('\t')[3]).sort();
    assert.deepEqual(models, ['gpt-5.5', 'gpt-5.6']);
  } finally {
    rmrf(f.root);
  }
});

test('limits come from the newest reading with a window, even in a file older than the range', async () => {
  const f = fixture();
  try {
    const oldDir = path.join(f.home, '.codex', 'sessions', '2026', '07', '03');
    const a = path.join(oldDir, 'rollout-2026-07-03T10-00-00-aaaaaaaa-0000-0000-0000-000000000001.jsonl');
    const b = path.join(oldDir, 'rollout-2026-07-02T10-00-00-aaaaaaaa-0000-0000-0000-000000000002.jsonl');
    writeLines(a, [
      codexTokens({ ts: '2026-07-03T22:58:00.000Z', last: [10, 0, 1], total: [10, 0, 1], rate: RATE(87, 1785543232, 'plus') }),
      // the very last event carries no windows at all: it must not wipe the reading above
      codexTokens({ ts: '2026-07-03T23:04:00.000Z', last: [10, 0, 1], total: [20, 0, 2], rate: { limit_id: 'codex', primary: null, secondary: null, plan_type: 'free' } }),
    ]);
    writeLines(b, [codexTokens({ ts: '2026-07-02T09:00:00.000Z', last: [10, 0, 1], total: [10, 0, 1], rate: RATE(5, 1785000000) })]);
    setMtime(a, Date.parse('2026-07-03T23:04:01Z'));
    setMtime(b, Date.parse('2026-07-02T09:00:01Z'));
    const scanner = createCodexScanner({ stateDir: f.state, home: f.home });
    const r = await scanner.scan(opts());
    assert.equal(r.rate.timestamp, '2026-07-03T22:58:00.000Z');
    assert.equal(r.rate.primary.usedPct, 87);
    assert.equal(r.plan.planType, 'free', 'plan from the newest event');
    assert.deepEqual(sum(r.buckets), [0, 0, 0, 0, 0, 0], 'old tokens are outside the range');
    assert.equal(r.stats.filesScanned, 1, 'the older file b could not hold a newer reading, so it was not read');
    const again = await scanner.scan(opts());
    assert.equal(again.stats.filesScanned, 0, 'old files are read once');
    assert.equal(again.rate.primary.usedPct, 87);
  } finally {
    rmrf(f.root);
  }
});

test('a forked rollout that copies earlier events does not count them twice', async () => {
  const f = fixture();
  try {
    const ev = codexTokens({ ts: '2026-10-01T10:00:02.000Z', last: [100, 40, 10], total: [100, 40, 10] });
    writeLines(path.join(f.dir, 'rollout-2026-10-01T10-00-00-aaaaaaaa-0000-0000-0000-00000000000a.jsonl'), [codexTurn({ ts: '2026-10-01T10:00:00.000Z', model: 'gpt-5.5' }), ev]);
    writeLines(path.join(f.dir, 'rollout-2026-10-01T11-00-00-aaaaaaaa-0000-0000-0000-00000000000b.jsonl'), [
      codexTurn({ ts: '2026-10-01T10:00:00.000Z', model: 'gpt-5.5' }),
      ev,
      codexTokens({ ts: '2026-10-01T11:00:02.000Z', last: [5, 0, 1], total: [105, 40, 11] }),
    ]);
    const r = await createCodexScanner({ stateDir: f.state, home: f.home }).scan(opts());
    assert.deepEqual(sum(r.buckets).slice(0, 3), [65, 11, 40]);
    assert.equal(r.stats.duplicates, 1);
  } finally {
    rmrf(f.root);
  }
});

test('no ~/.codex at all: unavailable, empty', async () => {
  const root = mkTmp('codex');
  try {
    const r = await createCodexScanner({ stateDir: path.join(root, 's'), home: path.join(root, 'nohome') }).scan(opts());
    assert.equal(r.available, false);
    assert.equal(r.rate, null);
    assert.deepEqual(r.buckets, {});
  } finally {
    rmrf(root);
  }
});
