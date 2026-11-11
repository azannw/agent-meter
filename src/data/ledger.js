'use strict';
// The all-time ledger (CONTRACT section 2, Lifetime and Headline).
//
// Claude Code deletes transcripts after ~30 days, so totals read from transcripts
// shrink. The ledger is Agent Meter's own record: per LOCAL day, per provider, per
// model+speed, the token components needed to price it again, plus short hashes of
// the sessions active that day. A day, once seen, is never forgotten and a record
// never goes down.
//
// Two counts per Claude day:
//   m  once per reply (deduped by message.id + requestId): the real API usage, every
//      transcript including workflow ones. Feeds Lifetime and the "per-reply" basis.
//   a  Claude-app style: every assistant line of the Claude app's file set, no
//      dedupe (see scan-claude.js). Feeds Headline.tokens and the "claude-app" basis.
//
// File: <stateDir>/ledger.json. A save writes ledger.json.<pid>.tmp, renames the
// current good ledger.json to ledger.json.bak, then renames the temp to ledger.json.
// The pid in the temp name keeps two processes sharing a state dir (a capture or a
// selftest beside the real app) off each other's temp file. Loading tries
// ledger.json, then a complete temp left by a process that died between the renames,
// then .bak. Temps of dead processes are removed once a good ledger is on disk.
//
//   {
//     "version": 2,
//     "fields": ["input","output","cacheRead","cacheWrite5m","cacheWrite1h","messages"],
//     "createdAt": "2026-10-03T...Z",
//     "days": {
//       "2026-08-06": {
//         "claude": { "m": { "claude-opus-5\t0": [in, out, cr, cw5m, cw1h, msgs] },
//                     "s": ["<hash8>", ...],
//                     "a": { "claude-opus-5\t0": [in, out, cr, cw5m, cw1h, lines] } },
//         "codex":  { "m": { ... }, "s": [ ... ] }
//       }
//     }
//   }
//
// Version 1 (no "a") is migrated by re-seeding from disk once, then merging the old
// file's m/s records in with the same larger-wins rule, so nothing it held is lost.
//
// Merge rule: for each (day, provider, model+speed) the record with the LARGER token
// total wins (scan or stored), and a day's session hashes are the union. Days the
// scan no longer covers keep what is stored. Costs are never stored: they are
// recomputed from the components with the current price table on every snapshot.

const fs = require('node:fs');
const path = require('node:path');
const { hashKey, tempPath, staleTemps, removeStaleTemps } = require('./util');
const { costUSD } = require('./pricing');

const FILE = 'ledger.json';
const VERSION = 2;
const FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h', 'messages'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PROVIDERS = ['claude', 'codex'];

const total = (r) => r[0] + r[1] + r[2] + r[3] + r[4];

function emptyLedger(nowMs) {
  return { version: VERSION, fields: FIELDS, createdAt: new Date(nowMs).toISOString(), days: {} };
}

function validRecords(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  for (const r of Object.values(obj)) {
    if (!Array.isArray(r) || r.length !== 6) return false;
    for (const v of r) if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return false;
  }
  return true;
}

// Strict: one bad record makes the whole file "corrupt", so a half-written or
// hand-mangled file is never trusted as the record of everything.
function isValid(l) {
  if (!l || typeof l !== 'object' || (l.version !== 1 && l.version !== VERSION)) return false;
  if (!l.days || typeof l.days !== 'object') return false;
  for (const [date, day] of Object.entries(l.days)) {
    if (!DATE.test(date) || !day || typeof day !== 'object') return false;
    for (const [prov, pv] of Object.entries(day)) {
      if (!PROVIDERS.includes(prov) || !pv || typeof pv !== 'object') return false;
      if (!validRecords(pv.m) || !Array.isArray(pv.s)) return false;
      for (const h of pv.s) if (typeof h !== 'string') return false;
      if (pv.a !== undefined && (l.version === 1 || prov !== 'claude' || !validRecords(pv.a))) return false;
    }
  }
  return true;
}

function readValid(file) {
  try {
    const l = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isValid(l) ? l : null;
  } catch {
    return null;
  }
}

function exists(file) {
  try {
    fs.accessSync(file);
    return true;
  } catch {
    return false;
  }
}

// Fold records into `into` (larger total wins). Returns true when anything changed.
function foldRecords(into, recs) {
  let changed = false;
  for (const [rec, r] of recs) {
    const cur = into[rec];
    if (!cur || total(r) > total(cur)) {
      into[rec] = r.slice();
      changed = true;
    }
  }
  return changed;
}

function foldSessions(pv, hashes) {
  const have = new Set(pv.s);
  let added = false;
  for (const h of hashes) {
    if (!have.has(h)) {
      pv.s.push(h);
      have.add(h);
      added = true;
    }
  }
  if (added) pv.s.sort();
  return added;
}

function createLedger({ stateDir }) {
  const file = stateDir ? path.join(stateDir, FILE) : null;
  const bak = file ? file + '.bak' : null;
  let data = null;
  let legacy = null; // a version-1 ledger waiting to be merged after the re-seed
  let dirty = false;
  let mainIsGood = false; // ledger.json on disk is a valid ledger (safe to rotate into .bak)

  // -> { status: 'loaded' | 'restored' | 'migrate' | 'missing' | 'corrupt', warning }
  //   loaded:   ledger.json was a good current ledger
  //   restored: ledger.json was missing or bad, a temp/.bak was good
  //   migrate:  the best copy is a version-1 ledger: re-seed, then mergeLegacy()
  //   missing:  nothing on disk (first run): the caller seeds from all history
  //   corrupt:  files exist but none is readable: the caller rebuilds and warns
  function load(nowMs) {
    data = null;
    legacy = null;
    dirty = false;
    mainIsGood = false;
    if (!file) {
      data = emptyLedger(nowMs);
      return { status: 'missing', warning: null };
    }
    const adopt = (l, fromMain) => {
      if (l.version === VERSION) {
        data = l;
        return null;
      }
      legacy = l;
      data = emptyLedger(nowMs);
      dirty = true;
      mainIsGood = fromMain; // a valid v1 main still becomes the .bak on the first save
      return 'migrate';
    };
    const main = readValid(file);
    if (main) {
      const m = adopt(main, true);
      if (!m) {
        mainIsGood = true;
        removeStaleTemps(file);
        return { status: 'loaded', warning: null };
      }
      return { status: 'migrate', warning: null };
    }
    const hadMain = exists(file);
    const candidates = [...staleTemps(file).map((t) => t.path), bak];
    for (const candidate of candidates) {
      const l = readValid(candidate);
      if (!l) continue;
      if (adopt(l, false)) return { status: 'migrate', warning: null };
      dirty = true; // write it back as ledger.json
      return {
        status: 'restored',
        warning: hadMain ? 'Lifetime ledger was damaged and has been restored from its backup' : null,
      };
    }
    data = emptyLedger(nowMs);
    dirty = true;
    // Only a ledger that existed and is now unreadable is "corrupt"; a half-written
    // temp from a first run that died is just a first run (the next save removes it).
    if (hadMain || exists(bak)) {
      return {
        status: 'corrupt',
        warning: 'Lifetime ledger was unreadable and has been rebuilt from the transcripts still on disk; older days may be missing',
      };
    }
    return { status: 'missing', warning: null };
  }

  function dayOf(date, provider) {
    const day = data.days[date] || (data.days[date] = {});
    return day[provider] || (day[provider] = { m: {}, s: [] });
  }

  // buckets: the scanners' "date\tsource\tsession\tmodel\tfast" -> [6 numbers]
  function merge(buckets, provider) {
    if (!data) throw new Error('ledger not loaded');
    const byDay = new Map();
    for (const [key, b] of Object.entries(buckets)) {
      const p = key.split('\t');
      const date = p[0];
      if (!DATE.test(date)) continue;
      let d = byDay.get(date);
      if (!d) byDay.set(date, (d = { m: new Map(), s: new Set() }));
      const rec = p[3] + '\t' + p[4];
      let r = d.m.get(rec);
      if (!r) d.m.set(rec, (r = [0, 0, 0, 0, 0, 0]));
      for (let i = 0; i < 6; i++) r[i] += b[i];
      if (total(b) > 0) d.s.add(hashKey(p[1] + '\t' + p[2]));
    }
    let changed = false;
    for (const [date, d] of byDay) {
      const pv = dayOf(date, provider);
      if (foldRecords(pv.m, d.m)) changed = true;
      if (foldSessions(pv, d.s)) changed = true;
    }
    if (changed) dirty = true;
    return changed;
  }

  // appBuckets: the Claude scanner's "date\tsource\tmodel\tfast" -> [6 numbers]
  // (Claude-app style). Summed over sources, then larger-wins per (day, model+speed).
  function mergeApp(appBuckets) {
    if (!data) throw new Error('ledger not loaded');
    const byDay = new Map();
    for (const [key, b] of Object.entries(appBuckets)) {
      const p = key.split('\t');
      const date = p[0];
      if (!DATE.test(date)) continue;
      let d = byDay.get(date);
      if (!d) byDay.set(date, (d = new Map()));
      const rec = p[2] + '\t' + p[3];
      let r = d.get(rec);
      if (!r) d.set(rec, (r = [0, 0, 0, 0, 0, 0]));
      for (let i = 0; i < 6; i++) r[i] += b[i];
    }
    let changed = false;
    for (const [date, d] of byDay) {
      const pv = dayOf(date, 'claude');
      if (!pv.a) pv.a = {};
      if (foldRecords(pv.a, d)) changed = true;
    }
    if (changed) dirty = true;
    return changed;
  }

  // After a migration re-seed: fold the version-1 file's records back in, so days it
  // held whose transcripts are gone survive the format change.
  function mergeLegacy() {
    if (!legacy || !data) return false;
    let changed = false;
    for (const [date, day] of Object.entries(legacy.days)) {
      for (const [provider, lpv] of Object.entries(day)) {
        const pv = dayOf(date, provider);
        if (foldRecords(pv.m, Object.entries(lpv.m))) changed = true;
        if (foldSessions(pv, lpv.s)) changed = true;
      }
    }
    legacy = null;
    if (changed) dirty = true;
    return changed;
  }

  function save() {
    if (!data || !dirty || !file) return false;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const text = JSON.stringify(data);
    const tmp = tempPath(file);
    fs.writeFileSync(tmp, text);
    try {
      if (mainIsGood) fs.renameSync(file, bak); // the previous good copy becomes the backup
    } catch {
      /* no main yet, or it is locked: keep the existing .bak */
    }
    try {
      fs.renameSync(tmp, file);
    } catch {
      fs.writeFileSync(file, text);
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    }
    mainIsGood = true;
    dirty = false;
    removeStaleTemps(file); // a good ledger is on disk now: dead processes' temps can go
    return true;
  }

  // Once-per-reply lifetime -> { tokens, costUSD, sessions, since, sessionSet, unpricedModels,
  //   d30Tokens, d30CostUSD, todayTokens, todayUSD }  (the last four over `dates` / `today`,
  //   from the ledger, so they never shrink either)
  function lifetime(provider, pricing, { dates = [], today = null } = {}) {
    const inRange = new Set(dates);
    let tokens = 0;
    let cost = 0;
    let since = null;
    const range = { d30Tokens: 0, d30CostUSD: 0, todayTokens: 0, todayUSD: 0 };
    const sessionSet = new Set();
    const unpricedModels = new Set();
    if (!data) return { tokens, costUSD: cost, sessions: 0, since, sessionSet, unpricedModels, ...range };
    for (const date of Object.keys(data.days).sort()) {
      const pv = data.days[date][provider];
      if (!pv) continue;
      let dayTokens = 0;
      for (const [rec, r] of Object.entries(pv.m)) {
        const t = total(r);
        if (!t) continue;
        dayTokens += t;
        let c = priceRecord(rec, r, pricing);
        if (c === null) {
          unpricedModels.add(rec.slice(0, rec.lastIndexOf('\t')));
          c = 0;
        }
        cost += c;
        if (inRange.has(date)) {
          range.d30Tokens += t;
          range.d30CostUSD += c;
        }
        if (date === today) {
          range.todayTokens += t;
          range.todayUSD += c;
        }
      }
      if (dayTokens > 0) {
        tokens += dayTokens;
        if (since === null) since = date;
      }
      for (const h of pv.s) sessionSet.add(h);
    }
    return { tokens, costUSD: cost, sessions: sessionSet.size, since, sessionSet, unpricedModels, ...range };
  }

  // Claude-app style totals: all time, the given range dates, and today.
  function appTotals(pricing, { dates = [], today = null } = {}) {
    const inRange = new Set(dates);
    const out = { tokens: 0, costUSD: 0, d30Tokens: 0, d30CostUSD: 0, todayTokens: 0, todayUSD: 0, since: null, unpricedModels: new Set() };
    if (!data) return out;
    for (const date of Object.keys(data.days).sort()) {
      const pv = data.days[date].claude;
      if (!pv || !pv.a) continue;
      let dayTokens = 0;
      for (const [rec, r] of Object.entries(pv.a)) {
        const t = total(r);
        if (!t) continue;
        dayTokens += t;
        let c = priceRecord(rec, r, pricing);
        if (c === null) {
          out.unpricedModels.add(rec.slice(0, rec.lastIndexOf('\t')));
          c = 0;
        }
        out.tokens += t;
        out.costUSD += c;
        if (inRange.has(date)) {
          out.d30Tokens += t;
          out.d30CostUSD += c;
        }
        if (date === today) {
          out.todayTokens += t;
          out.todayUSD += c;
        }
      }
      if (dayTokens > 0 && out.since === null) out.since = date;
    }
    return out;
  }

  return {
    load,
    merge,
    mergeApp,
    mergeLegacy,
    save,
    lifetime,
    appTotals,
    get data() {
      return data;
    },
    get dirty() {
      return dirty;
    },
    file,
  };
}

// Cost of one stored record with the current prices, or null when unpriced.
function priceRecord(rec, r, pricing) {
  const tab = rec.lastIndexOf('\t');
  const model = rec.slice(0, tab);
  const fast = rec.slice(tab + 1) === '1';
  const price = pricing.priceFor(model);
  if (!price) return null;
  return costUSD({ input: r[0], output: r[1], cacheRead: r[2], cacheWrite5m: r[3], cacheWrite1h: r[4] }, price, fast);
}

module.exports = { createLedger, isValid, FILE, FIELDS, VERSION };
