// Dev only: edge-case variants of the mock snapshot, picked with ?mock=1&variant=<name>.
// Loaded by app.js only in mock mode and only when ?variant= is set. Each function gets a
// deep copy of window.__MOCK_SNAPSHOT__ (already rebased so "now" is 40 s after generatedAt)
// and n, the number of snapshots made before this one; it returns the snapshot to render.
//
// The plain mock (no variant) has Codex available, so it is the two-provider, tabs path.
(function () {
  'use strict';

  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  const inMs = (ms) => new Date(Date.now() + ms).toISOString();
  const agoMs = (ms) => new Date(Date.now() - ms).toISOString();
  const claude = (s) => s.providers.find((p) => p.id === 'claude');
  const codex = (s) => s.providers.find((p) => p.id === 'codex');
  const weekly = (a) => a.windows.find((w) => w.key === 'weekly');
  const session = (a) => a.windows.find((w) => w.key === 'session');

  function fullWindow(w, resetsInMs) {
    w.usedPct = 100;
    if (resetsInMs) w.resetsAt = inMs(resetsInMs);
    w.pace = Object.assign({}, w.pace, { state: 'full', runsOutAt: null, lastsUntilReset: false });
  }

  // This user's real shape: Codex has no activity, so it is unavailable and not counted.
  function single(s) {
    const x = codex(s);
    x.available = false;
    x.limits.accounts = [];
    s.overview.subscriptions = 2;
    s.overview.daily.forEach((d) => { d.costUSD -= d.byProvider.codex || 0; delete d.byProvider.codex; });
    s.overview.costUSD = claude(s).spend.d30USD;
    s.overview.tokens = claude(s).spend.d30Tokens;
    s.overview.sessions = claude(s).spend.sessions30d;
    s.overview.unpriced = 0;
    return s;
  }

  // overview.headline (CONTRACT 2), hand-made at the values the contract quotes for 2026-10-03:
  // 102.0B tokens counted the Claude-app way, $53,019 all time on that basis.
  function headline(s) {
    single(s);
    s.overview.headline = {
      basis: 'claude-app',
      tokens: 102.02e9,
      costUSD: 53019.4,
      d30CostUSD: 20716.6,
      todayUSD: 600.53,
      d30Tokens: 39.33e9,
      since: '2026-04-04',
    };
    return s;
  }

  const V = {
    single,
    headline,

    // The user's usual state: one account full, the other with room.
    'one-full': headline,

    // Both accounts with room.
    'both-room': (s) => {
      headline(s);
      const w = weekly(claude(s).limits.accounts[1]);
      w.usedPct = 41;
      w.pace = Object.assign({}, w.pace, { state: 'reserve', deltaPct: -48.2, runsOutAt: null, lastsUntilReset: true });
      return s;
    },

    // Every account at its weekly limit.
    'all-full': (s) => {
      headline(s);
      claude(s).limits.accounts.forEach((a) => fullWindow(weekly(a)));
      weekly(claude(s).limits.accounts[0]).resetsAt = inMs(1 * 24 * HOUR + 15 * HOUR);
      return s;
    },

    'long-email': (s) => {
      headline(s);
      claude(s).limits.accounts[0].name = 'someone.with.a.really.long.mailbox.name@acmelabs-engineering.example.com';
      claude(s).limits.accounts[1].name = 'another.very.long.address.for.the.full.account@example.com';
      return s;
    },

    // An account the monitor could not read.
    error: (s) => {
      headline(s);
      const a = claude(s).limits.accounts[1];
      a.status = 'error';
      a.error = 'Could not sign in to this account';
      return s;
    },

    // The routine 429 over a held reading: fresh, so nothing extra shows.
    'routine-429': (s) => {
      headline(s);
      claude(s).limits.accounts.forEach((a) => { a.status = 'stale'; a.error = 'Claude is limiting usage checks: showing the last reading'; });
      claude(s).limits.updatedAt = agoMs(3 * MIN);
      return s;
    },

    // A reading that really is old: the limits block carries the warning (since 2026-10-03).
    stale: (s) => {
      headline(s);
      claude(s).limits.accounts.forEach((a) => { a.status = 'stale'; a.error = 'Claude is limiting usage checks: showing the last reading'; });
      claude(s).limits.updatedAt = agoMs(2 * HOUR + 5 * MIN);
      claude(s).limits.warnings = ['Usage Monitor hasn’t updated limits for 2 h'];
      return s;
    },

    // Both accounts usable, the first burning its week faster than the week is passing.
    'at-risk': (s) => {
      headline(s);
      const a = claude(s).limits.accounts[0];
      const w = weekly(a);
      w.usedPct = 62;
      w.resetsAt = inMs(3 * 24 * HOUR + 4 * HOUR);
      w.pace = Object.assign({}, w.pace, { state: 'deficit', deltaPct: 19.4, runsOutAt: inMs(1 * 24 * HOUR + 18 * HOUR), lastsUntilReset: false });
      const b = weekly(claude(s).limits.accounts[1]);
      b.usedPct = 23;
      b.pace = Object.assign({}, b.pace, { state: 'reserve', deltaPct: -30, runsOutAt: null, lastsUntilReset: true });
      return s;
    },

    // Only the Fable limit is used up: the account keeps working on other models.
    'fable-full': (s) => {
      headline(s);
      const a = claude(s).limits.accounts[0];
      fullWindow(a.windows.find((w) => w.key === 'weekly_scoped_fable'), 2 * 24 * HOUR);
      const w = weekly(a);
      w.usedPct = 48;
      w.pace = Object.assign({}, w.pace, { state: 'on-pace', deltaPct: 1, runsOutAt: null, lastsUntilReset: true });
      const b = weekly(claude(s).limits.accounts[1]);
      b.usedPct = 23;
      b.pace = Object.assign({}, b.pace, { state: 'reserve', deltaPct: -30, runsOutAt: null, lastsUntilReset: true });
      return s;
    },

    // The engine fails after a good snapshot (the mock bridge emits onError shortly after).
    'engine-error': headline,

    // No headline yet (older data engine): the header falls back to the ledger's lifetime block.
    lifetime: (s) => {
      single(s);
      s.overview.lifetime = { tokens: 29.0e9, costUSD: 14002.1, sessions: 81, since: '2026-08-06' };
      return s;
    },

    // Numbers move on every refresh, to see the change-only motion.
    live: (s, n) => {
      headline(s);
      const bump = 37.5 * n;
      const hl = s.overview.headline;
      hl.costUSD += bump; hl.d30CostUSD += bump; hl.todayUSD += bump; hl.tokens += n * 0.25e9;
      const w = claude(s).limits.accounts[0].windows;
      w[0].usedPct = Math.min(99, w[0].usedPct + 9 * n);
      w[1].usedPct = Math.min(99, w[1].usedPct + 2 * n);
      return s;
    },

    // Only Codex has data (single page, Codex rows).
    'codex-only': (s) => {
      claude(s).available = false;
      codex(s).limits.updatedAt = agoMs(40 * 1000);
      codex(s).limits.accounts[0].status = 'ok';
      codex(s).limits.accounts[0].error = null;
      return s;
    },

    empty: (s) => {
      s.providers.forEach((p) => { p.available = false; });
      return s;
    },

    'zero-spend': (s) => {
      single(s);
      s.overview.costUSD = 0;
      s.overview.tokens = 0;
      s.overview.sessions = 0;
      s.overview.daily.forEach((d) => { d.costUSD = 0; d.tokens = 0; Object.keys(d.byProvider).forEach((k) => { d.byProvider[k] = 0; }); });
      const sp = claude(s).spend;
      sp.todayUSD = 0; sp.d30USD = 0; sp.todayTokens = 0; sp.d30Tokens = 0; sp.sessions30d = 0;
      sp.daily.forEach((d) => { d.costUSD = 0; d.tokens = 0; });
      return s;
    },

    // Optional fields missing or null where they are allowed to be.
    missing: (s) => {
      single(s);
      const c = claude(s);
      c.limits.updatedAt = null;
      session(c.limits.accounts[0]).resetsAt = null;
      weekly(c.limits.accounts[0]).pace = { expectedPct: null, deltaPct: null, state: 'unknown', runsOutAt: null, lastsUntilReset: false };
      c.limits.accounts[1].windows = [];
      s.overview.daily = [];
      s.warnings = null;
      return s;
    },

    // One day dwarfs the rest of the month.
    spike: (s) => {
      single(s);
      const d = s.overview.daily[12];
      s.overview.costUSD += 4180.5 - d.costUSD;
      d.costUSD = 4180.5; d.byProvider.claude = 4180.5; d.tokens = 8.1e9;
      return s;
    },

    warnings: (s) => {
      headline(s);
      s.warnings = ['No price yet for claude-nova-1: tokens counted, cost shown as $0'];
      return s;
    },

    // Big numbers, to check widths.
    huge: (s) => {
      headline(s);
      const hl = s.overview.headline;
      hl.tokens = 9.87e12; hl.costUSD = 4567890.12; hl.d30CostUSD = 1234567.89; hl.todayUSD = 98765.43;
      return s;
    },
  };

  window.__MOCK_VARIANTS__ = V;
})();
