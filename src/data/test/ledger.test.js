'use strict';
process.env.TZ = 'Asia/Karachi';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createCollector } = require('../index');
const { createLedger, VERSION } = require('../ledger');
const { CLAUDE_ROWS, createPricing } = require('../pricing');
const { validateSnapshot } = require('./schema');
const { mkTmp, rmrf, claudeLine, writeLines, setMtime, codexMeta, codexTurn, codexTokens } = require('./helpers');

const NOW = Date.parse('2026-10-02T12:00:00.000Z'); // range (30 days) = 3 Sep .. 2 Oct, local
const DAY = 86400e3;

// opus-5 at $5 in / $25 out: old messages, 50 days before NOW
const O1 = { id: 'o1', req: 'o1', session: 'old', model: 'claude-opus-5', input: 1000, output: 2000, ts: '2026-08-10T08:00:00Z' };
const O2 = { id: 'o2', req: 'o2', session: 'old', model: 'claude-opus-5', input: 500, output: 500, cacheRead: 10000, ts: '2026-08-11T08:00:00Z' };
// opus-5.5 at $4 / $20: inside the range
const N1 = { id: 'n1', req: 'n1', session: 'new', model: 'claude-opus-5-5', input: 100, output: 300, ts: '2026-10-01T08:00:00Z' };
const N2 = { id: 'n2', req: 'n2', session: 'new', model: 'claude-opus-5-5', input: 10, output: 40, cacheWrite: 1000, cw5: 0, cw1: 1000, ts: '2026-10-02T08:00:00Z' };
const tok = (m) => (m.input || 0) + (m.output || 0) + (m.cacheRead || 0) + (m.cacheWrite || 0);
const OLD_TOKENS = tok(O1) + tok(O2); // 14,000
const NEW_TOKENS = tok(N1) + tok(N2); // 1,450
const OLD_USD = (1000 * 5 + 2000 * 25 + 500 * 5 + 500 * 25 + 10000 * 0.5) / 1e6;
const NEW_USD = (100 * 4 + 300 * 20 + 10 * 4 + 40 * 20 + 1000 * 8) / 1e6;
// Codex in May (gpt-5.5, unpriced offline): 400 input + 600 cached + 100 output
const CODEX_TOKENS = 1100;

function build() {
  const root = mkTmp('ledger');
  const home = path.join(root, 'home');
  const proj = path.join(home, '.claude', 'projects', 'D--fake');
  const oldFile = path.join(proj, 'old.jsonl');
  const newFile = path.join(proj, 'new.jsonl');
  writeLines(oldFile, [claudeLine(O1), claudeLine(O2)]);
  setMtime(oldFile, Date.parse('2026-08-11T09:00:00Z')); // last written long before the range
  writeLines(newFile, [claudeLine(N1), claudeLine(N2)]);
  setMtime(newFile, NOW - 3600e3); // pin mtimes to the fixed clock, not the real one
  const sid = '77777777-0000-0000-0000-000000000001';
  const codexFile = path.join(home, '.codex', 'sessions', '2026', '05', '14', `rollout-2026-05-14T10-00-00-${sid}.jsonl`);
  writeLines(codexFile, [
    codexMeta({ ts: '2026-05-14T10:00:00.000Z', id: sid }),
    codexTurn({ ts: '2026-05-14T10:00:01.000Z', model: 'gpt-5.5' }),
    codexTokens({ ts: '2026-05-14T10:00:02.000Z', last: [1000, 600, 100], total: [1000, 600, 100] }),
  ]);
  setMtime(codexFile, Date.parse('2026-05-14T10:01:00Z'));
  const state = path.join(root, 'state');
  return { root, home, proj, oldFile, newFile, state, appData: path.join(root, 'appdata') };
}

const collector = (f, extra = {}) =>
  createCollector({ stateDir: f.state, rangeDays: 30, home: f.home, appData: f.appData, now: NOW, allowNetwork: false, ...extra });

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-4, `${a} != ${b}`);
const readLedger = (f) => JSON.parse(fs.readFileSync(path.join(f.state, 'ledger.json'), 'utf8'));
const dayTokens = (l, date, prov = 'claude') =>
  Object.values((l.days[date] && l.days[date][prov] && l.days[date][prov].m) || {}).reduce((a, r) => a + r[0] + r[1] + r[2] + r[3] + r[4], 0);

test('seed: the first snapshot reads ALL history on disk, not just the range', async () => {
  const f = build();
  try {
    const c = collector(f);
    const s = await c.snapshot();
    assert.deepEqual(validateSnapshot(s, { requireLifetime: true, requireHeadline: true }), []);
    assert.ok(c.lastStats.seed, 'a seed ran');
    const claude = s.providers[0];
    assert.equal(claude.spend.d30Tokens, NEW_TOKENS, 'the range sees only the recent file');
    assert.deepEqual(claude.spend.lifetime, { tokens: OLD_TOKENS + NEW_TOKENS, costUSD: claude.spend.lifetime.costUSD, sessions: 2, since: '2026-08-10' });
    near(claude.spend.lifetime.costUSD, OLD_USD + NEW_USD);
    // Codex history from May is in the ledger too, unpriced offline
    assert.deepEqual(s.providers[1].spend.lifetime, { tokens: CODEX_TOKENS, costUSD: 0, sessions: 1, since: '2026-05-14' });
    // ...but that Codex is not active inside the range, so the panel's total is Claude's alone
    assert.equal(s.providers[1].available, false);
    assert.deepEqual(s.overview.lifetime, claude.spend.lifetime);
    // the scan index went back to the range after the seed: old dedupe keys and buckets gone
    const idx = JSON.parse(fs.readFileSync(path.join(f.state, 'scan-index-claude.json'), 'utf8'));
    assert.ok(Object.keys(idx.buckets).every((k) => k >= '2026-08-31'));
    // ...but old.jsonl stays indexed with its Claude-app sums: it is inside the app's
    // 182-day file window, so the app still counts it
    const oldEntry = Object.entries(idx.files).find(([p]) => p.endsWith('old.jsonl'));
    assert.ok(oldEntry && oldEntry[1][6], 'old.jsonl keeps its Claude-app sums in the index');
  } finally {
    rmrf(f.root);
  }
});

test('a transcript deleted after a snapshot changes neither lifetime nor its days', async () => {
  const f = build();
  try {
    // a second transcript with usage on the same day and model as N1
    const side = path.join(f.proj, 'side.jsonl');
    const S1 = { id: 's1', req: 's1', session: 'side', model: 'claude-opus-5-5', input: 1, output: 1, ts: '2026-10-01T09:00:00Z' };
    writeLines(side, [claudeLine(S1)]);
    setMtime(side, NOW - 3600e3);
    const before = await collector(f).snapshot();
    const ledgerBefore = readLedger(f);
    fs.unlinkSync(f.newFile); // Claude's cleanup
    fs.unlinkSync(f.oldFile);
    const s1 = await collector(f).snapshot();
    assert.deepEqual(s1.overview.lifetime, before.overview.lifetime);
    // even if the scan index is lost too: the rebuilt scan now sees LESS for 1 Oct
    // (only side.jsonl), and that smaller record must not replace the stored one
    fs.unlinkSync(path.join(f.state, 'scan-index-claude.json'));
    const s2 = await collector(f).snapshot();
    assert.equal(s2.providers[0].spend.d30Tokens, tok(S1), 'the deleted transcripts really are gone from the scan');
    assert.deepEqual(s2.overview.lifetime, before.overview.lifetime);
    assert.deepEqual(s2.providers[0].spend.lifetime, before.providers[0].spend.lifetime);
    const ledgerAfter = readLedger(f);
    for (const d of ['2026-08-10', '2026-08-11', '2026-10-01', '2026-10-02']) {
      assert.deepEqual(ledgerAfter.days[d], ledgerBefore.days[d], d + ' unchanged');
    }
  } finally {
    rmrf(f.root);
  }
});

test('an append to today grows lifetime by exactly the appended usage', async () => {
  const f = build();
  try {
    const c = collector(f);
    const s1 = await c.snapshot();
    const N3 = { id: 'n3', req: 'n3', session: 'new', model: 'claude-opus-5-5', input: 7, output: 11, cacheRead: 200, ts: '2026-10-02T10:00:00Z' };
    writeLines(f.newFile, [claudeLine(N3), claudeLine(N2) /* a repeat: must not count */], { append: true });
    const s2 = await c.snapshot();
    assert.equal(s2.overview.lifetime.tokens - s1.overview.lifetime.tokens, tok(N3));
    near(s2.overview.lifetime.costUSD - s1.overview.lifetime.costUSD, (7 * 4 + 11 * 20 + 200 * 0.2) / 1e6);
    assert.equal(s2.overview.lifetime.sessions, s1.overview.lifetime.sessions);
    assert.equal(s2.providers[0].spend.todayTokens - s1.providers[0].spend.todayTokens, tok(N3));
  } finally {
    rmrf(f.root);
  }
});

test('a restart reloads the ledger without a rescan or a second seed', async () => {
  const f = build();
  try {
    const s1 = await collector(f).snapshot();
    const c2 = collector(f);
    const s2 = await c2.snapshot();
    assert.equal(c2.lastStats.seed, null, 'no second seed');
    assert.equal(c2.lastStats.claude.filesWork, 0, 'no file re-read');
    assert.equal(c2.lastStats.codex.filesScanned, 0);
    assert.deepEqual(s2.overview.lifetime, s1.overview.lifetime);
  } finally {
    rmrf(f.root);
  }
});

test('a price-table change reprices stored history, even days with no transcript left', async () => {
  const f = build();
  try {
    await collector(f).snapshot();
    fs.unlinkSync(f.oldFile);
    fs.unlinkSync(f.newFile);
    // opus-5 doubles; opus-5.5 unchanged
    const rows = CLAUDE_ROWS.map((r) => (r[0] === 'claude-opus-5' ? [r[0], ...r.slice(1).map((v) => v * 2)] : r));
    const s = await collector(f, { priceTable: rows }).snapshot();
    near(s.providers[0].spend.lifetime.costUSD, OLD_USD * 2 + NEW_USD);
    assert.equal(s.providers[0].spend.lifetime.tokens, OLD_TOKENS + NEW_TOKENS, 'tokens are untouched');
    // The price list is fetched only for a provider the panel SHOWS. Hidden Codex
    // history (May) has an unpriced gpt-5.5, and that alone must not cost a download.
    let fetches = 0;
    const fetchJson = async () => {
      fetches++;
      return { 'gpt-5.5': { input_cost_per_token: 5e-6, output_cost_per_token: 30e-6, cache_read_input_token_cost: 0.5e-6 } };
    };
    const hidden = collector(f, { allowNetwork: true, fetchJson });
    const h1 = await hidden.snapshot();
    assert.equal(h1.providers[1].available, false);
    assert.equal(hidden.pricingPending, null, 'no fetch started');
    await hidden.snapshot();
    assert.equal(fetches, 0, 'no fetch while Codex is hidden');
    assert.ok(!h1.warnings.some((w) => /gpt-5\.5/.test(w)), 'no warning about a hidden model');
    // Codex is used again inside the range: now it is shown, and its price is fetched
    const sid = '77777777-0000-0000-0000-000000000002';
    const fresh = path.join(f.home, '.codex', 'sessions', '2026', '10', '02', `rollout-2026-10-02T10-00-00-${sid}.jsonl`);
    writeLines(fresh, [
      codexMeta({ ts: '2026-10-02T10:00:00.000Z', id: sid }),
      codexTurn({ ts: '2026-10-02T10:00:01.000Z', model: 'gpt-5.5' }),
      codexTokens({ ts: '2026-10-02T10:00:02.000Z', last: [100, 0, 10], total: [100, 0, 10] }),
    ]);
    setMtime(fresh, NOW - 60e3);
    const active = collector(f, { allowNetwork: true, fetchJson });
    const a1 = await active.snapshot();
    assert.equal(a1.providers[1].available, true);
    assert.equal(a1.providers[1].spend.lifetime.costUSD, 0, 'this snapshot did not wait for the fetch');
    assert.ok(active.pricingPending, 'a fetch started');
    await active.pricingPending;
    assert.equal(fetches, 1);
    const a2 = await active.snapshot();
    near(a2.providers[1].spend.lifetime.costUSD, (400 * 5 + 600 * 0.5 + 100 * 30 + 100 * 5 + 10 * 30) / 1e6);
  } finally {
    rmrf(f.root);
  }
});

test('a corrupt ledger recovers from .bak; with both bad it rebuilds from disk and warns', async () => {
  const f = build();
  try {
    const c = collector(f);
    await c.snapshot(); // save 1: ledger.json
    writeLines(f.newFile, [claudeLine({ id: 'n5', req: 'n5', session: 'new', input: 1, output: 1, ts: '2026-10-02T11:00:00Z' })], { append: true });
    const good = await c.snapshot(); // save 2: the first ledger.json becomes ledger.json.bak
    assert.ok(fs.existsSync(path.join(f.state, 'ledger.json.bak')));

    fs.unlinkSync(f.oldFile); // the old days now exist ONLY in the ledger files
    fs.writeFileSync(path.join(f.state, 'ledger.json'), '{"version":1,"days":{"2026-08-10":{"claude":{"m":{"x\\t0":[1,2,');
    const r = await collector(f).snapshot();
    assert.deepEqual(r.overview.lifetime, good.overview.lifetime, 'nothing lost: old days from .bak, n5 from the scan');
    assert.ok(r.warnings.some((w) => /restored from its backup/.test(w)));
    assert.equal(readLedger(f).version, VERSION, 'the good ledger was written back');

    fs.writeFileSync(path.join(f.state, 'ledger.json'), 'garbage');
    fs.writeFileSync(path.join(f.state, 'ledger.json.bak'), 'garbage');
    const c3 = collector(f);
    const rebuilt = await c3.snapshot();
    assert.ok(c3.lastStats.seed, 'rebuilt by a fresh seed');
    assert.ok(rebuilt.warnings.some((w) => /rebuilt from the transcripts/.test(w)));
    assert.equal(rebuilt.providers[0].spend.lifetime.tokens, NEW_TOKENS + 2, 'only what is still on disk');
    assert.deepEqual(validateSnapshot(rebuilt, { requireLifetime: true, requireHeadline: true }), []);
  } finally {
    rmrf(f.root);
  }
});

test('lifetime is never below the 30-day figures', async () => {
  const f = build();
  try {
    const s = await collector(f).snapshot();
    assert.ok(s.overview.lifetime.tokens >= s.overview.tokens);
    assert.ok(s.overview.lifetime.costUSD >= s.overview.costUSD);
    assert.ok(s.overview.lifetime.sessions >= s.overview.sessions);
    for (const p of s.providers) {
      assert.ok(p.spend.lifetime.tokens >= p.spend.d30Tokens, p.id);
      assert.ok(p.spend.lifetime.costUSD >= p.spend.d30USD, p.id);
      assert.ok(p.spend.lifetime.sessions >= p.spend.sessions30d, p.id);
    }
  } finally {
    rmrf(f.root);
  }
});

test('no double count across the range boundary: a later file repeating an old message', async () => {
  const f = build();
  try {
    const s1 = await collector(f).snapshot();
    // (a) a resumed session copies the OLD (pre-range, seeded) message into a new file
    const N4 = { id: 'n4', req: 'n4', session: 'resumed', model: 'claude-opus-5-5', input: 3, output: 3, ts: '2026-10-02T11:30:00Z' };
    const resumed = path.join(f.proj, 'resumed.jsonl');
    writeLines(resumed, [claudeLine({ ...O1, session: 'resumed' }), claudeLine(N4)]);
    setMtime(resumed, NOW - 60e3); // written inside the range, so it IS read
    const s2 = await collector(f).snapshot();
    assert.equal(s2.overview.lifetime.tokens - s1.overview.lifetime.tokens, tok(N4));

    // (b) 40 days later N1/N2 have left the range; a new file repeats them
    const later = NOW + 40 * DAY;
    const s3 = await collector(f, { now: later }).snapshot();
    assert.equal(s3.overview.lifetime.tokens, s2.overview.lifetime.tokens, 'sliding the window loses nothing');
    assert.equal(s3.providers[0].spend.d30Tokens, 0);
    const copy = path.join(f.proj, 'copy-later.jsonl');
    writeLines(copy, [claudeLine({ ...N1, session: 'copy' }), claudeLine({ ...N2, session: 'copy' })]);
    setMtime(copy, later - 60e3); // written inside the NEW range, so it IS read
    const c4 = collector(f, { now: later });
    const s4 = await c4.snapshot();
    assert.equal(c4.lastStats.claude.filesScanned, 1, 'the copy was read');
    assert.equal(s4.overview.lifetime.tokens, s3.overview.lifetime.tokens);
  } finally {
    rmrf(f.root);
  }
});

test('merge rule: per (day, provider, model) the larger record wins; sessions are a union', () => {
  const root = mkTmp('ledger');
  try {
    const l = createLedger({ stateDir: root });
    assert.equal(l.load(NOW).status, 'missing');
    l.merge({ '2026-09-01\tdefault\ts1\tclaude-opus-5\t0': [10, 10, 0, 0, 0, 1], '2026-09-01\tdefault\ts1\tclaude-sonnet-5\t0': [5, 5, 0, 0, 0, 1] }, 'claude');
    // a later scan sees less for opus (a transcript was deleted) and more for sonnet
    const changed = l.merge({ '2026-09-01\tdefault\ts2\tclaude-opus-5\t0': [1, 1, 0, 0, 0, 1], '2026-09-01\tdefault\ts2\tclaude-sonnet-5\t0': [6, 6, 0, 0, 0, 2] }, 'claude');
    assert.equal(changed, true);
    const day = l.data.days['2026-09-01'].claude;
    assert.deepEqual(day.m['claude-opus-5\t0'], [10, 10, 0, 0, 0, 1]);
    assert.deepEqual(day.m['claude-sonnet-5\t0'], [6, 6, 0, 0, 0, 2]);
    assert.equal(day.s.length, 2);
    assert.equal(l.merge({ '2026-09-01\tdefault\ts1\tclaude-opus-5\t0': [10, 10, 0, 0, 0, 1] }, 'claude'), false, 'equal is not a change');
    l.save();
    const again = createLedger({ stateDir: root });
    assert.equal(again.load(NOW).status, 'loaded');
    const life = again.lifetime('claude', createPricing({ allowNetwork: false }));
    assert.equal(life.tokens, 32);
    assert.equal(life.sessions, 2);
    assert.equal(life.since, '2026-09-01');
  } finally {
    rmrf(root);
  }
});
