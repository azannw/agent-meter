'use strict';
process.env.TZ = 'Asia/Karachi';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createCollector } = require('../index');
const { validateSnapshot } = require('./schema');
const { mkTmp, rmrf, claudeLine, writeLines, writeMonitor, codexMeta, codexTurn, codexTokens } = require('./helpers');

const NOW = Date.parse('2026-10-02T12:00:00.000Z'); // 17:00 on 2 Oct, local
const S = (ms) => Math.floor(ms / 1000);
const H = 3600e3;

// A home with two Claude folders, one Codex session and a running Usage Monitor.
function buildFixture() {
  const root = mkTmp('snap');
  const home = path.join(root, 'home');
  const appData = path.join(root, 'appdata');
  const proj = path.join(home, '.claude', 'projects', 'D--fake');
  writeLines(path.join(proj, 'main.jsonl'), [
    // today (local): opus 5.5 with 1h cache writes
    claudeLine({ id: 'm1', req: 'r1', session: 'main', model: 'claude-opus-5-5', input: 1000, output: 2000, cacheRead: 100000, cacheWrite: 5000, cw5: 0, cw1: 5000, ts: '2026-10-02T08:00:00Z' }),
    // yesterday: haiku with a date suffix
    claudeLine({ id: 'm2', req: 'r2', session: 'main', model: 'claude-haiku-4-5-20251001', input: 10, output: 20, ts: '2026-10-01T08:00:00Z' }),
  ]);
  // a fork of "main" carrying a copy of m1 plus its own message
  writeLines(path.join(proj, 'fork.jsonl'), [
    claudeLine({ id: 'm1', req: 'r1', session: 'fork', model: 'claude-opus-5-5', input: 1000, output: 2000, cacheRead: 100000, cacheWrite: 5000, cw5: 0, cw1: 5000, ts: '2026-10-02T08:00:00Z' }),
    claudeLine({ id: 'm3', req: 'r3', session: 'fork', model: 'claude-sonnet-5', input: 100, output: 100, ts: '2026-09-20T08:00:00Z' }),
  ]);
  writeLines(path.join(home, '.claude-acct2', 'projects', 'p', 'w.jsonl'), [
    claudeLine({ id: 'w1', req: 'w1', session: 'work', model: 'claude-opus-5', input: 1, output: 1, ts: '2026-10-02T09:00:00Z' }),
  ]);
  const sid = '99999999-0000-0000-0000-000000000001';
  writeLines(path.join(home, '.codex', 'sessions', '2026', '10', '01', `rollout-2026-10-01T10-00-00-${sid}.jsonl`), [
    codexMeta({ ts: '2026-10-01T10:00:00.000Z', id: sid }),
    codexTurn({ ts: '2026-10-01T10:00:01.000Z', model: 'gpt-5.5' }),
    codexTokens({
      ts: '2026-10-01T10:00:02.000Z',
      last: [1000, 600, 100],
      total: [1000, 600, 100],
      rate: { limit_id: 'codex', primary: { used_percent: 40, window_minutes: 300, resets_at: S(NOW + 2 * H) }, secondary: null, plan_type: 'plus' },
    }),
  ]);
  writeMonitor(appData, {
    updatedUnix: S(NOW - 30e3),
    accounts: [
      { id: 'default', name: 'me@example.com', config_dir: '', session: 12, sessionReset: S(NOW + 2 * H), weekly: 90, weeklyReset: S(NOW + 48 * H), scoped: 0 },
      { id: 'account_1', name: 'work@example.com', config_dir: path.join(home, '.claude-acct2'), session: 0, sessionReset: null, weekly: 100, weeklyReset: S(NOW + 20 * H), error: { http_status: 429 } },
    ],
  });
  return { root, home, appData, state: path.join(root, 'state') };
}

test('snapshot shape: every contract field present with the right type, nothing extra', async () => {
  const f = buildFixture();
  try {
    const c = createCollector({ stateDir: f.state, rangeDays: 30, home: f.home, appData: f.appData, now: NOW, allowNetwork: false });
    const s = await c.snapshot();
    assert.deepEqual(validateSnapshot(s, { requireLifetime: true, requireHeadline: true }), []);
    assert.equal(s.generatedAt, new Date(NOW).toISOString());

    // daily: exactly rangeDays local dates, oldest first, zero-filled, ending today
    assert.equal(s.overview.daily.length, 30);
    assert.equal(s.overview.daily[0].date, '2026-09-03');
    assert.equal(s.overview.daily[29].date, '2026-10-02');
    const zeros = s.overview.daily.filter((d) => d.tokens === 0);
    assert.equal(zeros.length, 27);
    assert.ok(zeros.every((d) => d.costUSD === 0 && d.byProvider.claude === 0 && d.byProvider.codex === 0));
    for (const p of s.providers) {
      assert.deepEqual(p.spend.daily.map((d) => d.date), s.overview.daily.map((d) => d.date));
    }
  } finally {
    rmrf(f.root);
  }
});

test('snapshot numbers: dedupe, pricing, sessions, sources, limits and overview agree', async () => {
  const f = buildFixture();
  try {
    const c = createCollector({ stateDir: f.state, rangeDays: 30, home: f.home, appData: f.appData, now: NOW, allowNetwork: false });
    const s = await c.snapshot();
    const [claude, codex] = s.providers;

    // m1 (counted once) + m2 + m3 + w1
    const m1 = (1000 * 4 + 2000 * 20 + 100000 * 0.2 + 5000 * 8) / 1e6;
    const m2 = (10 * 1 + 20 * 5) / 1e6;
    const m3 = (100 * 2 + 100 * 10) / 1e6;
    const w1 = (1 * 5 + 1 * 25) / 1e6;
    assert.equal(claude.spend.d30Tokens, 108000 + 30 + 200 + 2);
    assert.ok(Math.abs(claude.spend.d30USD - (m1 + m2 + m3 + w1)) < 1e-4);
    assert.equal(claude.spend.todayTokens, 108000 + 2);
    assert.deepEqual(claude.spend.tokenBreakdown, { input: 1111, output: 2121, cacheRead: 100000, cacheWrite: 5000 });
    assert.equal(claude.spend.topModel, 'claude-opus-5-5');
    assert.ok(claude.spend.models.some((m) => m.model === 'claude-haiku-4-5'), 'date suffix stripped for display');
    assert.ok(Math.abs(claude.spend.cacheSavingsUSD - (100000 * (4 - 0.2)) / 1e6) < 1e-4);
    assert.equal(claude.spend.sessions30d, 3); // main, fork, work
    const [def, acct] = claude.spend.sources;
    assert.equal(def.id, 'default');
    assert.equal(def.accountName, 'me@example.com');
    assert.equal(def.sessions30d, 2);
    assert.equal(acct.id, 'account_1');
    assert.equal(acct.accountName, 'work@example.com');
    assert.equal(acct.d30Tokens, 2);
    assert.ok(claude.storageBytes > 0);

    // Codex: gpt-5.5 has no price offline -> unpriced, tokens still counted
    assert.equal(codex.available, true);
    assert.equal(codex.plan, 'plus');
    assert.equal(codex.spend.d30Tokens, 400 + 600 + 100);
    assert.equal(codex.spend.d30USD, 0);
    assert.deepEqual(codex.spend.models, [{ model: 'gpt-5.5', costUSD: 0, tokens: 1100, share: 1, priced: false }]);
    assert.equal(codex.limits.accounts[0].status, 'stale'); // the reading is a day old
    assert.equal(codex.limits.accounts[0].windows[0].label, 'Session');

    // limits
    assert.deepEqual(claude.limits.accounts.map((a) => [a.id, a.kind, a.status]), [
      ['default', 'claude-app', 'ok'],
      ['account_1', 'folder', 'stale'],
    ]);
    assert.equal(claude.limits.accounts[1].error, 'Claude is limiting usage checks: showing the last reading');

    // overview
    const o = s.overview;
    assert.equal(o.tokens, claude.spend.d30Tokens + codex.spend.d30Tokens);
    assert.ok(Math.abs(o.costUSD - claude.spend.d30USD - codex.spend.d30USD) < 1e-9);
    assert.equal(o.sessions, 4);
    assert.equal(o.unpriced, 1);
    assert.equal(o.priced, 3);
    assert.equal(o.subscriptions, 3);
    assert.equal(o.subscriptionsWithSpend, 3);
    assert.equal(o.activeDays, 3);
    assert.ok(s.warnings.some((w) => /gpt-5\.5/.test(w)));
  } finally {
    rmrf(f.root);
  }
});

test('Codex last used before the range: not available, not counted as a subscription', async () => {
  const f = buildFixture();
  try {
    // Replace the 1 Oct Codex session with one from July, file timestamps to match.
    fs.rmSync(path.join(f.home, '.codex'), { recursive: true, force: true });
    const sid = '99999999-0000-0000-0000-000000000002';
    const file = path.join(f.home, '.codex', 'sessions', '2026', '07', '03', `rollout-2026-07-03T10-00-00-${sid}.jsonl`);
    writeLines(file, [
      codexMeta({ ts: '2026-07-03T10:00:00.000Z', id: sid }),
      codexTurn({ ts: '2026-07-03T10:00:01.000Z', model: 'gpt-5.5' }),
      codexTokens({
        ts: '2026-07-03T10:00:02.000Z',
        last: [1000, 600, 100],
        total: [1000, 600, 100],
        rate: { limit_id: 'codex', primary: { used_percent: 87, window_minutes: 43200, resets_at: S(Date.parse('2026-08-01T00:00:00Z')) }, secondary: null, plan_type: 'free' },
      }),
    ]);
    const july = new Date('2026-07-03T10:00:03Z');
    fs.utimesSync(file, july, july);

    const s = await createCollector({ stateDir: f.state, rangeDays: 30, home: f.home, appData: f.appData, now: NOW, allowNetwork: false }).snapshot();
    assert.deepEqual(validateSnapshot(s, { requireLifetime: true, requireHeadline: true }), []);
    const codex = s.providers.find((p) => p.id === 'codex');
    assert.equal(codex.available, false);
    assert.equal(codex.spend.d30Tokens, 0);
    assert.equal(s.overview.subscriptions, 2); // the two Claude accounts only
    const claude = s.providers.find((p) => p.id === 'claude');
    assert.equal(claude.available, true);
    // the July Codex session is in Codex's own lifetime, not in the panel's total
    assert.ok(codex.spend.lifetime.tokens > 0);
    assert.deepEqual(s.overview.lifetime, claude.spend.lifetime);
  } finally {
    rmrf(f.root);
  }
});

test('a shorter range has exactly rangeDays entries; older usage drops out', async () => {
  const f = buildFixture();
  try {
    const s = await createCollector({ stateDir: f.state, rangeDays: 7, home: f.home, appData: f.appData, now: NOW, allowNetwork: false }).snapshot();
    assert.deepEqual(validateSnapshot(s, { requireLifetime: true, requireHeadline: true }), []);
    assert.equal(s.overview.daily.length, 7);
    assert.equal(s.overview.daily[0].date, '2026-09-26');
    assert.ok(!s.providers[0].spend.models.some((m) => m.model === 'claude-sonnet-5'), 'the 20 Sep message is outside 7 days');

    // growing the range again on the same state dir rebuilds instead of missing days
    const s30 = await createCollector({ stateDir: f.state, rangeDays: 30, home: f.home, appData: f.appData, now: NOW, allowNetwork: false }).snapshot();
    assert.ok(s30.providers[0].spend.models.some((m) => m.model === 'claude-sonnet-5'));
  } finally {
    rmrf(f.root);
  }
});

test('nothing installed: still a valid snapshot, providers unavailable, warnings explain why', async () => {
  const root = mkTmp('snap');
  try {
    const s = await createCollector({
      stateDir: path.join(root, 'state'),
      home: path.join(root, 'empty-home'),
      appData: path.join(root, 'empty-appdata'),
      now: NOW,
      allowNetwork: false,
    }).snapshot();
    assert.deepEqual(validateSnapshot(s, { requireLifetime: true, requireHeadline: true }), []);
    assert.equal(s.providers[0].available, false);
    assert.equal(s.providers[1].available, false);
    assert.equal(s.overview.tokens, 0);
    // limit warnings travel with the limits block (the shell swaps that block whole)
    assert.ok(s.providers[0].limits.warnings.some((w) => /Usage Monitor/.test(w)));
    assert.ok(!s.warnings.some((w) => /Usage Monitor/.test(w)), 'not repeated at the top level');
    assert.deepEqual(s.providers[1].limits.warnings, []);
    assert.ok(s.warnings.some((w) => /No Claude Code transcripts/.test(w)));
  } finally {
    rmrf(root);
  }
});

test('the shared mock snapshot passes the same validator (validator sanity check)', () => {
  const mock = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'shared', 'mock-snapshot.json'), 'utf8'));
  assert.deepEqual(validateSnapshot(mock), []);
});
