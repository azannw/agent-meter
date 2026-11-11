'use strict';
// Limits per account.
//   Claude: %APPDATA%\ClaudeCodeUsageMonitor\usage-cache.json, written every ~60 s
//           by the separately installed Claude Code Usage Monitor, plus its
//           settings.json for the profile names (CONTRACT section 1).
//   Codex:  the newest rate_limits reading the Codex scanner found in the logs.
// Never reads credential files: the cache only NAMES one in source_path, and that
// field is ignored.

const path = require('node:path');
const { readJsonSafe, clamp, localDateKey } = require('./util');
const { computePace } = require('./pace');

const STALE_MS = 10 * 60 * 1000;
const MONITOR_DIR = 'ClaudeCodeUsageMonitor';
const MONITOR_SOURCE = 'Claude Code Usage Monitor';
const CODEX_SOURCE = 'Codex session log';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function monitorPaths(appData) {
  const dir = path.join(appData, MONITOR_DIR);
  return { dir, cache: path.join(dir, 'usage-cache.json'), settings: path.join(dir, 'settings.json') };
}

// Profiles from settings.json -> accounts.claude.profiles[] ({ id, name, config_dir, enabled }).
function readClaudeProfiles(appData) {
  const s = readJsonSafe(monitorPaths(appData).settings);
  const list = s && s.accounts && s.accounts.claude && Array.isArray(s.accounts.claude.profiles) ? s.accounts.claude.profiles : [];
  return list
    .filter((p) => p && typeof p === 'object' && typeof p.id === 'string')
    .map((p) => ({
      id: p.id,
      name: typeof p.name === 'string' ? p.name : p.id,
      config_dir: typeof p.config_dir === 'string' ? p.config_dir.trim() : '',
      enabled: p.enabled !== false,
    }));
}

function formatAge(ms) {
  const min = Math.round(ms / 60000);
  if (min < 60) return min + ' min';
  const h = Math.round(ms / 3600000);
  if (h < 48) return h + ' h';
  return Math.round(ms / 86400000) + ' days';
}

function secsToIso(r) {
  if (r === null || r === undefined) return null;
  const secs = typeof r === 'number' ? r : r && typeof r.secs_since_epoch === 'number' ? r.secs_since_epoch : null;
  if (secs === null) return null;
  return new Date(secs * 1000).toISOString();
}

// One LimitWindow. A reading whose reset time has already passed describes a window
// that has since rolled over: report 0% with no known reset rather than a stale %.
function makeWindow(key, label, usedPct, resetsAt, windowMinutes, now) {
  let used = clamp(Number(usedPct) || 0, 0, 100);
  let reset = resetsAt;
  if (reset && Date.parse(reset) <= now) {
    used = 0;
    reset = null;
  }
  return {
    key,
    label,
    usedPct: Math.round(used * 10) / 10,
    resetsAt: reset,
    windowMinutes,
    pace: computePace({ usedPct: used, resetsAt: reset, windowMinutes, now }),
  };
}

function errorText(err) {
  if (!err) return null;
  if (typeof err === 'string') return err.slice(0, 160);
  const status = httpStatus(err);
  if (status === 429) return 'Claude is limiting usage checks: showing the last reading';
  if (status === 401 || status === 403) return 'Signed out: sign in to Claude Code again';
  if (status !== null && status >= 500) return 'Claude is having trouble (HTTP ' + status + '), retrying';
  if (status !== null) return 'Usage request failed (HTTP ' + status + ')';
  if (typeof err.message === 'string' && err.message) return err.message.slice(0, 160);
  return 'Usage request failed';
}

function httpStatus(err) {
  if (!err || typeof err !== 'object') return null;
  if (typeof err.http_status === 'number') return err.http_status;
  return typeof err.status === 'number' ? err.status : null;
}

// A refused or failed check over a reading we still hold: the numbers are the last
// good ones, not wrong ones. Signed-out (401/403) is never transient.
function isTransient(err) {
  const status = httpStatus(err);
  return status === 429 || (status !== null && status >= 500);
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

// A login folder compared the way Windows does: no case, either slash, no trailing
// slash, no stray whitespace (a pasted tab once sat in front of a real one).
function folderKey(dir) {
  return typeof dir === 'string' ? dir.trim().replace(/[\\/]+/g, '\\').replace(/\\$/, '').toLowerCase() : null;
}

function claudeWindows(usage, now) {
  const out = [];
  if (!usage || typeof usage !== 'object') return out;
  const limits = Array.isArray(usage.limits) ? usage.limits : [];
  const pick = (direct, kind) => {
    if (direct && typeof direct === 'object') return direct;
    const l = limits.find((x) => x && x.kind === kind);
    return l && l.usage ? l.usage : null;
  };
  const add = (key, label, u, minutes) => {
    if (!u || u.available === false || typeof u.percentage !== 'number') return;
    out.push(makeWindow(key, label, u.percentage, secsToIso(u.resets_at), minutes, now));
  };
  add('session', 'Session', pick(usage.session, 'session'), 300);
  add('weekly', 'Weekly', pick(usage.weekly, 'weekly_all'), 10080);
  for (const l of limits) {
    if (!l || l.kind !== 'weekly_scoped') continue;
    const name =
      (typeof l.model === 'string' && l.model) ||
      (l.scope && l.scope.model && l.scope.model.display_name) ||
      (typeof l.label === 'string' && l.label) ||
      'Model';
    const key = typeof l.key === 'string' && l.key ? l.key : 'weekly_scoped_' + slug(name);
    add(key, name + ' only', l.usage, 10080);
  }
  return out;
}

// -> { accounts, updatedAt, found, warnings, profiles }
function readClaudeLimits({ appData, now }) {
  const paths = monitorPaths(appData);
  const profiles = readClaudeProfiles(appData);
  const warnings = [];
  const cache = readJsonSafe(paths.cache);
  if (!cache || typeof cache !== 'object') {
    warnings.push('Claude Code Usage Monitor not found or not running: Claude limits unavailable');
    return { accounts: [], updatedAt: null, found: false, warnings, profiles };
  }
  const updatedMs = typeof cache.updated_unix === 'number' ? cache.updated_unix * 1000 : null;
  const age = updatedMs === null ? Infinity : now - updatedMs;
  const oldCache = age > STALE_MS;
  if (oldCache) {
    warnings.push(
      updatedMs === null
        ? 'Usage Monitor cache has no timestamp: Claude limits may be out of date'
        : 'Usage Monitor hasn’t updated limits for ' + formatAge(age)
    );
  }

  const data = cache.data && typeof cache.data === 'object' ? cache.data : {};
  let entries = Array.isArray(data.accounts) ? data.accounts.filter((a) => a && a.provider === 'claude') : [];
  let singleAccount = false;
  if (entries.length === 0 && data.claude_code) {
    // Single-account caches carry the usage at data.claude_code only.
    const def = profiles.find((p) => p.config_dir === '') || { id: 'default', name: 'Claude', config_dir: '' };
    entries = [{ provider: 'claude', profile: def, usage: data.claude_code, error: null }];
    singleAccount = true;
  }

  // Each reading carries its profile as it was when the Monitor took it, so after a
  // settings change (a profile pointed at another login folder) the same id can hold
  // the other account's numbers until the next poll. The folder is the account: match
  // readings to the current profiles by folder, by id only when a reading names none.
  const byProfile = new Map(profiles.map((p) => [p.id, p]));
  const currentProfile = (prof) => {
    if (singleAccount) return profiles.includes(prof) ? prof : null;
    const key = folderKey(prof.config_dir);
    if (key === null) return byProfile.get(prof.id) || null;
    const same = profiles.filter((p) => folderKey(p.config_dir) === key);
    return same.find((p) => p.id === prof.id) || same[0] || null;
  };
  const accounts = [];
  const seenIds = new Set();
  for (const a of entries) {
    const prof = (a.profile && typeof a.profile === 'object' ? a.profile : {}) || {};
    const settingsProf = currentProfile(prof);
    // A reading for a folder no profile points at any more belongs to no account.
    if (!settingsProf && profiles.length > 0 && !singleAccount) continue;
    const id = settingsProf ? settingsProf.id : typeof prof.id === 'string' ? prof.id : 'default';
    if (seenIds.has(id)) continue;
    if (settingsProf ? settingsProf.enabled === false : prof.enabled === false) continue;
    seenIds.add(id);
    const configDir = settingsProf ? settingsProf.config_dir : typeof prof.config_dir === 'string' ? prof.config_dir.trim() : '';
    const windows = claudeWindows(a.usage, now);
    const err = errorText(a.error);
    let status = 'ok';
    if (err) status = isTransient(a.error) && windows.length > 0 ? 'stale' : 'error';
    else if (!a.usage) status = 'unavailable';
    else if (oldCache || (a.usage && a.usage.stale === true)) status = 'stale';
    accounts.push({
      id,
      name: (settingsProf && settingsProf.name) || (typeof prof.name === 'string' && prof.name) || id,
      kind: configDir ? 'folder' : 'claude-app',
      status,
      error: err || (status === 'stale' && !oldCache ? 'Usage Monitor reports this reading as stale' : null),
      windows,
      configDir,
    });
  }
  // Enabled profiles the cache has nothing for yet.
  for (const p of profiles) {
    if (!p.enabled || seenIds.has(p.id)) continue;
    accounts.push({
      id: p.id,
      name: p.name,
      kind: p.config_dir ? 'folder' : 'claude-app',
      status: 'unavailable',
      error: 'No reading from the Usage Monitor yet',
      windows: [],
      configDir: p.config_dir,
    });
  }
  // The Usage Monitor's own order (its settings, which also lay out its taskbar columns
  // left to right); a reading no profile names keeps its cache order after them.
  const rank = (id) => {
    const i = profiles.findIndex((p) => p.id === id);
    return i < 0 ? profiles.length : i;
  };
  accounts.sort((x, y) => rank(x.id) - rank(y.id));
  return {
    accounts,
    updatedAt: updatedMs === null ? null : new Date(updatedMs).toISOString(),
    found: true,
    warnings,
    profiles,
  };
}

// The snapshot's providers[claude].limits block (CONTRACT section 2) from a
// readClaudeLimits() result. The worker builds it with every snapshot; the shell builds
// the same block on its own whenever the Usage Monitor's cache changes, and swaps it in.
function claudeLimitsBlock(r) {
  return {
    updatedAt: r.updatedAt,
    source: MONITOR_SOURCE,
    accounts: r.accounts.map((a) => ({ id: a.id, name: a.name, kind: a.kind, status: a.status, error: a.error, windows: a.windows })),
    warnings: r.warnings.slice(),
  };
}

function windowLabel(minutes, fallback) {
  if (minutes === 300) return 'Session';
  if (minutes === 10080) return 'Weekly';
  if (minutes === 43200) return 'Monthly';
  if (minutes === 1440) return 'Daily';
  if (typeof minutes === 'number' && minutes > 0) {
    if (minutes % 1440 === 0) return minutes / 1440 + ' days';
    if (minutes % 60 === 0) return minutes / 60 + ' h';
    return minutes + ' min';
  }
  return fallback;
}

function shortDate(ms) {
  const [, m, d] = localDateKey(ms).split('-');
  return Number(d) + ' ' + MONTHS[Number(m) - 1];
}

// rate: { timestamp, planType, primary, secondary } from the Codex scanner, or null.
function buildCodexAccount(rate, now) {
  if (!rate) return null;
  const ts = Date.parse(rate.timestamp);
  const windows = [];
  for (const key of ['primary', 'secondary']) {
    const w = rate[key];
    if (!w) continue;
    const minutes = typeof w.windowMinutes === 'number' ? w.windowMinutes : 0;
    windows.push(makeWindow(key, windowLabel(minutes, key === 'primary' ? 'Primary' : 'Secondary'), w.usedPct, w.resetsAt, minutes, now));
  }
  const age = now - ts;
  let status = 'ok';
  let error = null;
  if (!Number.isFinite(ts) || age > STALE_MS) {
    status = 'stale';
    if (Number.isFinite(ts)) {
      const sameDay = localDateKey(ts) === localDateKey(now);
      const d = new Date(ts);
      error = sameDay
        ? 'Last seen in a session at ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
        : 'Last seen in a session on ' + shortDate(ts);
    } else {
      error = 'Last reading has no time';
    }
  }
  return { id: 'codex', name: 'ChatGPT login', kind: 'codex', status, error, windows };
}

module.exports = {
  STALE_MS,
  MONITOR_SOURCE,
  CODEX_SOURCE,
  monitorPaths,
  readClaudeProfiles,
  readClaudeLimits,
  claudeLimitsBlock,
  buildCodexAccount,
  claudeWindows,
  errorText,
  windowLabel,
  formatAge,
};
