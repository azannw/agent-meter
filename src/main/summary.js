'use strict';
// Snapshot -> what the tray shows: the gauge input and the tooltip text.
// Pure, no Electron, unit-tested.

const { runsOutEarly } = require('../shared/limit-rules');

const TOOLTIP_MAX = 127; // NOTIFYICONDATAW.szTip is 128 WCHARs including the NUL
const SEP = ' · ';
const APP = 'Agent Meter';

// Personal mail domains keep their own name ("gmail"); company domains lose a
// generic suffix ("acmelabs.com" -> "acme").
const GENERIC_SUFFIX = /(labs?|hq|inc|app|team|group|io)$/i;

function shortName(name) {
  if (!name || typeof name !== 'string') return null;
  const at = name.indexOf('@');
  // A name chosen in the Usage Monitor ("Subscription 1") reads as written: cut to one
  // word, two of them became the same "subscription" (2026-10-03).
  if (at < 0) return name.trim().replace(/\s+/g, ' ').slice(0, 24) || null;
  const label = name.slice(at + 1).split('.')[0].toLowerCase();
  const stripped = label.replace(GENERIC_SUFFIX, '');
  return (stripped.length >= 3 ? stripped : label).slice(0, 14) || null;
}

function localPart(name) {
  const at = typeof name === 'string' ? name.indexOf('@') : -1;
  return at > 0 ? name.slice(0, at).toLowerCase().slice(0, 14) : null;
}

function provider(snapshot, id) {
  return (snapshot && Array.isArray(snapshot.providers) && snapshot.providers.find((p) => p && p.id === id)) || null;
}

function accountsOf(p) {
  return (p && p.limits && Array.isArray(p.limits.accounts) && p.limits.accounts) || [];
}

/**
 * The account the tray number shows: the one the Claude app is using (limits.activeId,
 * follow-account.js), else the default profile.
 */
function headlineClaudeAccount(snapshot) {
  const p = provider(snapshot, 'claude');
  const accts = accountsOf(p);
  const active = p && p.limits && p.limits.activeId;
  return (active && accts.find((a) => a.id === active)) || accts.find((a) => a.id === 'default') || accts.find((a) => a.kind === 'claude-app') || accts[0] || null;
}

/** The window worth one glance: weekly for Claude, the first window for Codex. */
function headlineWindow(account) {
  const ws = (account && Array.isArray(account.windows) && account.windows) || [];
  return ws.find((w) => w.key === 'weekly') || ws.find((w) => w.key !== 'session') || ws[0] || null;
}

/** full: used up. warn: exactly when the panel says "Weekly runs out in ..." (shared/limit-rules.js). */
function toneOf(window, now = Date.now()) {
  if (!window || !Number.isFinite(window.usedPct)) return 'none';
  const state = window.pace && window.pace.state;
  if (state === 'full' || window.usedPct >= 100) return 'full';
  if (runsOutEarly(window, now)) return 'warn';
  return 'ok';
}

/** Tray icon input: the weekly window of the account the Claude app is using. */
function gaugeOf(snapshot) {
  const acct = headlineClaudeAccount(snapshot);
  if (!acct || acct.status === 'unavailable') return { pct: null, tone: 'none' };
  const w = (acct.windows || []).find((x) => x.key === 'weekly') || null;
  if (!w || !Number.isFinite(w.usedPct)) return { pct: null, tone: 'none' };
  return { pct: Math.max(0, Math.min(100, w.usedPct)), tone: toneOf(w) };
}

function fitTooltip(parts) {
  const list = parts.filter(Boolean);
  while (list.length > 1 && list.join(SEP).length > TOOLTIP_MAX) list.splice(list.length - 1, 1);
  const text = list.join(SEP);
  return text.length > TOOLTIP_MAX ? text.slice(0, TOOLTIP_MAX - 1) + '…' : text;
}

/**
 * Tooltip: "Agent Meter · gmail: 90% weekly · acme: full · codex: 87% monthly".
 * opts.progress: { filesDone, filesTotal } while the first scan runs.
 * opts.example: true when the snapshot is the bundled example data.
 */
function tooltipOf(snapshot, opts = {}) {
  if (!snapshot) {
    if (opts.error) return fitTooltip([APP, 'data engine not ready, retrying']);
    const p = opts.progress;
    if (p && Number.isFinite(p.filesTotal) && p.filesTotal > 0) {
      return fitTooltip([APP, `reading usage ${Math.min(p.filesDone, p.filesTotal)}/${p.filesTotal} files`]);
    }
    return fitTooltip([APP, 'reading usage…']);
  }
  const parts = [APP];
  if (opts.example) parts.push('example data');
  const entries = [];
  for (const p of snapshot.providers || []) {
    for (const acct of accountsOf(p)) {
      const w = headlineWindow(acct);
      if (!w || !Number.isFinite(w.usedPct)) continue;
      const short = p.id === 'claude' ? shortName(acct.name) || acct.id : (p.id || 'codex').toLowerCase();
      entries.push({ acct, w, short, provider: p.id });
    }
  }
  // two Claude accounts on the same mail provider: fall back to the mailbox name
  const counts = {};
  for (const e of entries) counts[e.short] = (counts[e.short] || 0) + 1;
  for (const e of entries) if (counts[e.short] > 1) e.short = localPart(e.acct.name) || e.short;
  for (const { w, short } of entries) {
    if (toneOf(w) === 'full') parts.push(`${short}: full`);
    else parts.push(`${short}: ${Math.round(w.usedPct)}% ${String(w.label || w.key).toLowerCase()}`);
  }
  if (entries.length === 0) parts.push('no limits found');
  return fitTooltip(parts);
}

module.exports = { TOOLTIP_MAX, shortName, headlineClaudeAccount, headlineWindow, toneOf, gaugeOf, tooltipOf };
