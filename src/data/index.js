'use strict';
// The collector: scans, prices and assembles one Snapshot (CONTRACT section 2).
//
//   const { createCollector } = require('./src/data');
//   const c = createCollector({ stateDir, rangeDays: 30 });
//   const snap = await c.snapshot({ onProgress });
//
// home / appData / now are injectable so tests can point the collector at fixtures
// and a fixed clock. `now` may be a number, a Date, an ISO string or a function.
//
// Lifetime (ledger.js): the first snapshot with no ledger in stateDir reads ALL
// history on disk once (the seed), then every snapshot merges the range scan into
// the ledger with the never-goes-down rule and prices the ledger with today's table.
//
// Headline (CONTRACT section 2): tokens are ALWAYS the Claude desktop app's own count
// (every assistant line of its file set, no dedupe), ledgered; the cost fields follow
// costBasis: "per-reply" (default, the real API cost: the deduped figures over every
// transcript) or "claude-app" (the app-style components priced).

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { createPricing, normalizeModelId, costUSD, cacheSavingsUSD } = require('./pricing');
const { createClaudeScanner } = require('./scan-claude');
const { createCodexScanner } = require('./scan-codex');
const { readClaudeLimits, claudeLimitsBlock, buildCodexAccount, CODEX_SOURCE } = require('./limits');
const { createLedger } = require('./ledger');
const { localDateKey, localMidnight, lastNDates, round } = require('./util');

const SCHEMA_VERSION = 1;
// Days kept beyond the range, so a message near the range edge is still deduped
// and the window can slide a day without a rescan.
const RETENTION_MARGIN_DAYS = 2;
// The ledger seed reads every transcript still on disk, whatever its age.
const SEED_FROM_DATE = '0000-01-01';
// The Claude app only counts files written since local midnight of now - 182 days.
const APP_WINDOW_MS = 157248e5;
const COST_BASES = ['per-reply', 'claude-app'];
const normBasis = (b) => (COST_BASES.includes(b) ? b : 'per-reply');

function toClock(now) {
  if (typeof now === 'function') return () => +new Date(now());
  if (now !== undefined && now !== null) {
    const fixed = +new Date(now);
    return () => fixed;
  }
  return Date.now;
}

const usd = (v) => round(v, 4);

// Sum buckets that fall inside the range. Bucket key: date\tsource\tsession\tmodel\tfast.
function aggregate(buckets, { dates, today, pricing }) {
  const dateSet = new Set(dates);
  const daily = new Map(dates.map((d) => [d, { costUSD: 0, tokens: 0 }]));
  const models = new Map();
  const bySource = new Map();
  const sessions = new Set();
  const unpricedSessions = new Set();
  const unpricedModels = new Set();
  const breakdown = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let total = 0;
  let tokens = 0;
  let todayUSD = 0;
  let todayTokens = 0;
  let savings = 0;

  for (const [key, b] of Object.entries(buckets)) {
    const date = key.slice(0, 10);
    if (!dateSet.has(date)) continue;
    const parts = key.split('\t');
    const src = parts[1];
    const session = src + '\t' + parts[2];
    const rawModel = parts[3];
    const fast = parts[4] === '1';
    const [input, output, cacheRead, cw5, cw1] = b;
    const t = input + output + cacheRead + cw5 + cw1;
    if (t === 0) continue;
    const price = pricing.priceFor(rawModel);
    const model = normalizeModelId(rawModel);
    const cost = price ? costUSD({ input, output, cacheRead, cacheWrite5m: cw5, cacheWrite1h: cw1 }, price, fast) : 0;
    if (price) savings += cacheSavingsUSD(cacheRead, price, fast);
    else {
      unpricedSessions.add(session);
      unpricedModels.add(model);
    }

    total += cost;
    tokens += t;
    const day = daily.get(date);
    day.costUSD += cost;
    day.tokens += t;
    if (date === today) {
      todayUSD += cost;
      todayTokens += t;
    }
    breakdown.input += input;
    breakdown.output += output;
    breakdown.cacheRead += cacheRead;
    breakdown.cacheWrite += cw5 + cw1;
    sessions.add(session);

    let m = models.get(model);
    if (!m) models.set(model, (m = { model, costUSD: 0, tokens: 0, priced: true }));
    m.costUSD += cost;
    m.tokens += t;
    if (!price) m.priced = false;

    let s = bySource.get(src);
    if (!s) bySource.set(src, (s = { costUSD: 0, tokens: 0, sessions: new Set() }));
    s.costUSD += cost;
    s.tokens += t;
    s.sessions.add(session);
  }

  return { daily, models, bySource, sessions, unpricedSessions, unpricedModels, breakdown, total, tokens, todayUSD, todayTokens, savings };
}

function buildSpend(agg, sources) {
  const list = [...agg.models.values()];
  const modelRows = list
    .map((m) => ({
      model: m.model,
      costUSD: usd(m.costUSD),
      tokens: m.tokens,
      // share of cost for priced models; an unpriced model has no cost, so its
      // share is of tokens instead (CONTRACT: "share of cost (or tokens if unpriced)")
      share: m.priced
        ? agg.total > 0 ? round(m.costUSD / agg.total, 4) : 0
        : agg.tokens > 0 ? round(m.tokens / agg.tokens, 4) : 0,
      priced: m.priced,
    }))
    .sort((a, b) => b.costUSD - a.costUSD || b.tokens - a.tokens);
  let topModel = null;
  if (modelRows.length) {
    const byCost = modelRows.filter((m) => m.costUSD > 0);
    topModel = byCost.length ? byCost[0].model : [...modelRows].sort((a, b) => b.tokens - a.tokens)[0].model;
  }
  return {
    todayUSD: usd(agg.todayUSD),
    d30USD: usd(agg.total),
    todayTokens: agg.todayTokens,
    d30Tokens: agg.tokens,
    sessions30d: agg.sessions.size,
    topModel,
    cacheSavingsUSD: usd(agg.savings),
    tokenBreakdown: { ...agg.breakdown },
    models: modelRows,
    daily: [...agg.daily.entries()].map(([date, d]) => ({ date, costUSD: usd(d.costUSD), tokens: d.tokens })),
    sources: sources.map((s) => {
      const a = agg.bySource.get(s.id);
      return {
        id: s.id,
        label: s.label,
        path: s.path,
        accountName: s.accountName || null,
        d30USD: usd(a ? a.costUSD : 0),
        d30Tokens: a ? a.tokens : 0,
        sessions30d: a ? a.sessions.size : 0,
        sizeBytes: s.sizeBytes || 0,
      };
    }),
  };
}

function publicLifetime(l) {
  return { tokens: l.tokens, costUSD: usd(l.costUSD), sessions: l.sessions, since: l.since };
}

function publicAccount(a) {
  return { id: a.id, name: a.name, kind: a.kind, status: a.status, error: a.error, windows: a.windows };
}

// priceTable: test-only replacement for the Claude price rows (see pricing.js).
// costBasis: "per-reply" (default) or "claude-app"; see the Headline note above.
// persistEveryMs: write the scan index and the ledger at most this often (0 = after every
// snapshot that changed them). The app refreshes every few seconds while the panel is open,
// so it batches the writes and calls flush() before the worker exits. Both files are
// rebuilt from the transcripts by the next scan, so a crash in between loses nothing.
function createCollector({ stateDir, rangeDays = 30, home, appData, now, allowNetwork = true, fetchJson, priceTable, costBasis, persistEveryMs = 0 } = {}) {
  let basis = normBasis(costBasis);
  home = home || os.homedir();
  appData = appData || process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const clock = toClock(now);
  const days = Math.max(1, Math.min(366, Math.floor(Number(rangeDays) || 30)));
  if (stateDir) fs.mkdirSync(stateDir, { recursive: true });
  const pricing = createPricing({ stateDir, allowNetwork, now: clock, fetchJson, tableRows: priceTable });
  const claude = createClaudeScanner({ stateDir, home, persistEveryMs });
  const codex = createCodexScanner({ stateDir, home });
  const ledger = createLedger({ stateDir });
  let ledgerSavedAt = 0;
  let ledgerLoaded = false;
  let needSeed = false;
  // A damaged-ledger warning stays up until the process restarts, not one snapshot.
  const ledgerNotes = [];
  let lastStats = null;

  // Snapshots never overlap: two scans sharing one index would race on the file
  // offsets. The worker already serialises; this also protects a direct caller.
  let chain = Promise.resolve();
  function snapshot(opts = {}) {
    const run = chain.then(() => snapshotNow(opts));
    chain = run.catch(() => {});
    return run;
  }

  // force: a user-asked refresh. Every snapshot already re-reads the limits and the
  // appended transcript bytes, so force only lets a failed price-list fetch retry now.
  async function snapshotNow({ force = false, onProgress } = {}) {
    const started = Date.now();
    const t = clock();
    const dates = lastNDates(t, days);
    const today = dates[dates.length - 1];
    const fromDate = lastNDates(t, days + RETENTION_MARGIN_DAYS)[0];
    const retentionStartMs = localMidnight(t, days - 1 + RETENTION_MARGIN_DAYS);
    const appWindowStartMs = localMidnight(t - APP_WINDOW_MS, 0);

    const limits = readClaudeLimits({ appData, now: t });

    if (!ledgerLoaded) {
      const r = ledger.load(t);
      ledgerLoaded = true;
      if (r.warning) ledgerNotes.push(r.warning);
      // 'migrate': a version-1 ledger. Re-seed (it has no Claude-app counts), then fold
      // its records back in so nothing it held is lost.
      needSeed = r.status === 'missing' || r.status === 'corrupt' || r.status === 'migrate';
    }

    let cDone = 0;
    let cTotal = 0;
    let xDone = 0;
    let xTotal = 0;
    const report = (phase) =>
      onProgress && onProgress({ phase, filesDone: cDone + xDone, filesTotal: cTotal + xTotal });

    // Seed: no ledger yet (or an unreadable one). Read ALL history once, from a fresh
    // index, so lifetime starts at everything still on disk. The normal scan right
    // after it trims that index back to the range; the ledger keeps the old days.
    let seed = null;
    if (needSeed) {
      const seedStarted = Date.now();
      const cs = await claude.scan({
        profiles: limits.profiles,
        retentionStartMs: 0,
        appWindowStartMs,
        fromDate: SEED_FROM_DATE,
        now: t,
        fresh: true,
        onProgress: (d, n) => {
          cDone = d;
          cTotal = n;
          report('scanning');
        },
      });
      ledger.merge(cs.buckets, 'claude');
      ledger.mergeApp(cs.appBuckets);
      const xs = await codex.scan({
        retentionStartMs: 0,
        fromDate: SEED_FROM_DATE,
        now: t,
        fresh: true,
        onProgress: (d, n) => {
          xDone = d;
          xTotal = n;
          report('scanning');
        },
      });
      ledger.merge(xs.buckets, 'codex');
      ledger.mergeLegacy(); // no-op unless this seed is a version-1 migration
      seed = {
        ms: Date.now() - seedStarted,
        claudeFiles: cs.stats.filesScanned,
        claudeBytes: cs.stats.bytesRead,
        codexFiles: xs.stats.filesScanned,
        errors: cs.stats.errors + xs.stats.errors,
      };
      needSeed = false;
      cDone = cTotal = xDone = xTotal = 0;
    }

    const c = await claude.scan({
      profiles: limits.profiles,
      retentionStartMs,
      appWindowStartMs,
      fromDate,
      now: t,
      onProgress: (d, n) => {
        cDone = d;
        cTotal = n;
        report('scanning');
      },
    });
    const x = await codex.scan({
      retentionStartMs,
      fromDate,
      now: t,
      onProgress: (d, n) => {
        xDone = d;
        xTotal = n;
        report('scanning');
      },
    });
    report('pricing');

    // Days inside this scan come from the scan, but no stored record ever goes down.
    ledger.merge(c.buckets, 'claude');
    ledger.mergeApp(c.appBuckets);
    ledger.merge(x.buckets, 'codex');
    let ledgerSaveError = false;
    if (persistEveryMs <= 0 || Date.now() - ledgerSavedAt >= persistEveryMs) {
      try {
        if (ledger.save()) ledgerSavedAt = Date.now();
      } catch {
        ledgerSaveError = true;
      }
    }
    const cLife = ledger.lifetime('claude', pricing, { dates, today });
    const xLife = ledger.lifetime('codex', pricing, { dates, today });
    const cApp = ledger.appTotals(pricing, { dates, today });

    const cAgg = aggregate(c.buckets, { dates, today, pricing });
    const xAgg = aggregate(x.buckets, { dates, today, pricing });
    const claudeSpend = buildSpend(cAgg, c.sources);
    const codexSpend = buildSpend(xAgg, [x.source]);

    // A provider the user has not touched inside the range is not shown at all:
    // a months-old Codex reading is noise, not information. It reappears on its
    // own as soon as there is a session or a limit reading inside the range.
    const rangeStartMs = t - days * 86400e3;
    const codexRateMs = x.rate ? Date.parse(x.rate.timestamp) : NaN;
    const codexActive = x.available && (codexSpend.d30Tokens > 0 || codexRateMs >= rangeStartMs);
    const codexAccount = codexActive ? buildCodexAccount(x.rate, t) : null;
    const claudeAccounts = limits.accounts;

    // Which Claude accounts spent anything: an account's transcripts are in the
    // source with the same profile id (the default profile -> ~/.claude).
    const srcTokens = new Map(claudeSpend.sources.map((s) => [s.id, s.d30Tokens]));
    const defaultSrc = c.sources.find((s) => s.isDefault);
    let withSpend = 0;
    for (const a of claudeAccounts) {
      const srcId = c.sources.some((s) => s.id === a.id) ? a.id : a.kind === 'claude-app' && defaultSrc ? defaultSrc.id : null;
      if (srcId && (srcTokens.get(srcId) || 0) > 0) withSpend++;
    }
    if (codexAccount && codexSpend.d30Tokens > 0) withSpend++;

    const allAccounts = [...claudeAccounts, ...(codexAccount ? [codexAccount] : [])];
    const subscriptions = allAccounts.filter((a) => a.windows.length > 0).length;

    const overviewDaily = dates.map((date, i) => {
      const cd = claudeSpend.daily[i];
      const xd = codexSpend.daily[i];
      return {
        date,
        costUSD: usd(cd.costUSD + xd.costUSD),
        tokens: cd.tokens + xd.tokens,
        byProvider: { claude: cd.costUSD, codex: xd.costUSD },
      };
    });

    const unpricedCount = cAgg.unpricedSessions.size + xAgg.unpricedSessions.size;
    const sessionCount = cAgg.sessions.size + xAgg.sessions.size;

    // Limit warnings travel with the limits (providers[claude].limits.warnings): the shell
    // re-reads the limits between snapshots and replaces that block whole, warnings included.
    const warnings = [];
    // Only models of a provider the panel SHOWS can trigger the (at most daily)
    // price-list fetch: hidden Codex history would buy a 280 KB download a day for a
    // number nobody sees. It is priced the first snapshot Codex is active again.
    const unpricedShown = new Set([
      ...cAgg.unpricedModels,
      ...xAgg.unpricedModels,
      ...[...cLife.unpricedModels, ...cApp.unpricedModels].map(normalizeModelId),
    ]);
    if (codexActive) [...xLife.unpricedModels].forEach((m) => unpricedShown.add(normalizeModelId(m)));
    if (unpricedShown.size) {
      pricing.refreshIfDue({ force }); // this snapshot does not wait for it
      warnings.push('No price yet for ' + [...unpricedShown].join(', ') + ': tokens counted, cost shown as $0');
    }
    const readErrors = c.stats.errors + x.stats.errors;
    if (readErrors) warnings.push(readErrors + ' transcript file' + (readErrors === 1 ? '' : 's') + ' could not be read');
    warnings.push(...ledgerNotes);
    if (ledgerSaveError) warnings.push('Lifetime ledger could not be saved: lifetime totals may not survive a restart');
    const claudeFiles = c.sources.reduce((a, s) => a + (s.files || 0), 0);
    if (claudeFiles === 0) warnings.push('No Claude Code transcripts found under ' + path.join(home, '.claude', 'projects'));

    lastStats = {
      ms: Date.now() - started,
      claude: c.stats,
      codex: x.stats,
      seed,
      ledgerDays: ledger.data ? Object.keys(ledger.data.days).length : 0,
      appTokensLive: Object.values(c.appBuckets).reduce((a, b) => a + b[0] + b[1] + b[2] + b[3] + b[4], 0),
      rssMB: Math.round(process.memoryUsage().rss / 1e6),
      peakRssMB: Math.round(process.resourceUsage().maxRSS / 1024),
    };

    return {
      schemaVersion: SCHEMA_VERSION,
      generatedAt: new Date(t).toISOString(),
      rangeDays: days,
      overview: {
        costUSD: usd(cAgg.total + xAgg.total),
        tokens: cAgg.tokens + xAgg.tokens,
        sessions: sessionCount,
        subscriptions,
        subscriptionsWithSpend: withSpend,
        activeDays: overviewDaily.filter((d) => d.tokens > 0).length,
        priced: sessionCount - unpricedCount,
        unpriced: unpricedCount,
        daily: overviewDaily.map((d) => ({ ...d, byProvider: { claude: usd(d.byProvider.claude), codex: usd(d.byProvider.codex) } })),
        // Only providers the panel shows: a hidden Codex must not add a May start
        // date and $28 to a total that reads as Claude's.
        lifetime: {
          tokens: cLife.tokens + (codexActive ? xLife.tokens : 0),
          costUSD: usd(cLife.costUSD + (codexActive ? xLife.costUSD : 0)),
          sessions: cLife.sessions + (codexActive ? xLife.sessions : 0),
          since: [cLife.since, codexActive ? xLife.since : null].filter(Boolean).sort()[0] || null,
        },
        // Tokens: the Claude app's count, ledgered. Costs: on `basis`, also from the
        // ledger, so no headline figure can go down. Codex, when the panel shows it,
        // adds its own (single) count unchanged.
        headline: {
          basis,
          tokens: cApp.tokens + (codexActive ? xLife.tokens : 0),
          costUSD: usd((basis === 'claude-app' ? cApp.costUSD : cLife.costUSD) + (codexActive ? xLife.costUSD : 0)),
          d30CostUSD: usd((basis === 'claude-app' ? cApp.d30CostUSD : cLife.d30CostUSD) + (codexActive ? xLife.d30CostUSD : 0)),
          todayUSD: usd((basis === 'claude-app' ? cApp.todayUSD : cLife.todayUSD) + (codexActive ? xLife.todayUSD : 0)),
          d30Tokens: cApp.d30Tokens + (codexActive ? xLife.d30Tokens : 0),
          since: [cApp.since, cLife.since, codexActive ? xLife.since : null].filter(Boolean).sort()[0] || null,
        },
      },
      providers: [
        {
          id: 'claude',
          name: 'Claude',
          available: claudeFiles > 0 || claudeAccounts.length > 0,
          plan: null,
          limits: claudeLimitsBlock(limits),
          spend: { ...claudeSpend, lifetime: publicLifetime(cLife) },
          storageBytes: c.sources.reduce((a, s) => a + (s.sizeBytes || 0), 0),
        },
        {
          id: 'codex',
          name: 'Codex',
          available: codexActive,
          plan: (x.plan && x.plan.planType) || (x.rate && x.rate.planType) || null,
          limits: {
            updatedAt: x.rate ? new Date(Date.parse(x.rate.timestamp)).toISOString() : null,
            source: CODEX_SOURCE,
            accounts: codexAccount ? [publicAccount(codexAccount)] : [],
            warnings: [],
          },
          spend: { ...codexSpend, lifetime: publicLifetime(xLife) },
          storageBytes: x.source.sizeBytes,
        },
      ],
      warnings,
    };
  }

  // Write what persistEveryMs held back (scan index, ledger). Waits for a snapshot in
  // flight, so it never writes half a scan. -> { index: bytes|null, ledger: boolean }
  function flush() {
    const run = chain.then(() => {
      const index = claude.flush();
      let saved = false;
      if (ledgerLoaded) {
        saved = ledger.save();
        if (saved) ledgerSavedAt = Date.now();
      }
      return { index, ledger: saved };
    });
    chain = run.catch(() => {});
    return run;
  }

  return {
    snapshot,
    flush,
    // The shell's cost-basis setting changed: no rescan, the next snapshot uses it.
    setCostBasis(b) {
      basis = normBasis(b);
    },
    get costBasis() {
      return basis;
    },
    get lastStats() {
      return lastStats;
    },
    // The in-flight price-list fetch, if any (the CLI lets it finish before exiting
    // so the next run has prices; the app never waits on it).
    get pricingPending() {
      return pricing.pending;
    },
  };
}

module.exports = { createCollector, SCHEMA_VERSION, RETENTION_MARGIN_DAYS, localDateKey };
