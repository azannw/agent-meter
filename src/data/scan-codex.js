'use strict';
// Incremental scanner over Codex rollout logs (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl).
//
// Tokens: an `event_msg` with payload.type "token_count" carries
//   info.last_token_usage  - this turn's usage
//   info.total_token_usage - the session's running total
// Codex repeats token_count events with an unchanged total (12 of 428 on this
// machine), so an event counts only when the session total moved. Verified on the
// real files: summing last_token_usage over the counted events reproduces every
// file's final total_token_usage exactly.
// Mapping: input = input_tokens - cached_input_tokens (cached is a subset of
// input), cacheRead = cached_input_tokens, output = output_tokens (already includes
// reasoning_output_tokens: total_tokens == input + output on every event), cacheWrite = 0.
// Model: the most recent turn_context payload.model before the event.
// Limits: the newest token_count rate_limits with at least one window, across all files.
//
// Index (stateDir/scan-index-codex.json): per file [size, mtimeMs, offset, headLen,
// headHash, model, session, lastTotal], the same bucket shape as the Claude scanner,
// a bounded seen set (copied events in a forked rollout must not count twice), and
// the newest rate-limit reading.

const path = require('node:path');
const {
  HEAD_LEN,
  localDateKey,
  timeZoneId,
  hashKey,
  num,
  readJsonSafe,
  writeJsonAtomic,
  listFiles,
  readCompleteLines,
  headHash,
  resumeOffset,
  removeStaleTemps,
} = require('./util');

const INDEX_FILE = 'scan-index-codex.json';
const INDEX_VERSION = 1;
const SOURCE_ID = 'codex';

function emptyIndex(tz, fromDate) {
  return { version: INDEX_VERSION, tz, fromDate, files: {}, buckets: {}, seen: {}, rate: null, plan: null };
}

function loadIndex(file, tz, fromDate) {
  const raw = readJsonSafe(file);
  if (
    !raw ||
    raw.version !== INDEX_VERSION ||
    raw.tz !== tz ||
    typeof raw.fromDate !== 'string' ||
    raw.fromDate > fromDate ||
    typeof raw.files !== 'object' ||
    typeof raw.buckets !== 'object' ||
    typeof raw.seen !== 'object'
  ) {
    return emptyIndex(tz, fromDate);
  }
  return raw;
}

function sessionFromName(p) {
  const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(p);
  return m ? m[1] : path.basename(p, '.jsonl');
}

function createCodexScanner({ stateDir, home }) {
  const indexFile = stateDir ? path.join(stateDir, INDEX_FILE) : null;
  const sessionsDir = path.join(home, '.codex', 'sessions');
  let index = null;
  let seen = null; // Map<hash, date>

  // fresh: ignore the saved index and read everything again (the ledger seed).
  async function scan({ retentionStartMs, fromDate, now, onProgress, fresh = false } = {}) {
    const tz = timeZoneId(now);
    if (fresh || !index || index.tz !== tz || index.fromDate > fromDate) {
      if (indexFile) removeStaleTemps(indexFile); // temps of processes that died mid-write
      index = indexFile && !fresh ? loadIndex(indexFile, tz, fromDate) : emptyIndex(tz, fromDate);
      seen = new Map();
      for (const [date, s] of Object.entries(index.seen || {})) {
        if (typeof s === 'string' && s) for (const h of s.split(',')) seen.set(h, date);
      }
      index.seen = {};
    }

    const all = listFiles(sessionsDir, (n) => n.startsWith('rollout-') && n.endsWith('.jsonl'));
    const sizeBytes = all.reduce((a, f) => a + f.size, 0);
    const live = new Set();
    const work = [];
    const old = [];
    for (const f of all) {
      if (f.mtimeMs >= retentionStartMs) {
        live.add(f.path);
        const e = index.files[f.path];
        const entry = e ? { size: e[0], mtimeMs: e[1], offset: e[2], headLen: e[3], head: e[4] } : null;
        const start = resumeOffset(f.path, f, entry);
        if (start >= 0) work.push({ f, start, e: start > 0 ? e : null });
      } else {
        old.push(f);
      }
    }
    // Files older than the range hold no counted tokens, but the newest rate-limit
    // reading may live in one. Read old files newest first, only while a file is
    // newer than the best reading found so far; each old file is read at most once
    // (oldSeen remembers it by size+mtime).
    old.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const oldSeen = index.oldSeen || (index.oldSeen = {});

    const stats = { filesScanned: 0, eventsCounted: 0, repeats: 0, duplicates: 0, badLines: 0, errors: 0 };
    let changed = false;
    let done = 0;
    if (onProgress) onProgress(0, work.length);

    const readFile = async (f, start, e) => {
      const st = {
        model: e ? e[5] : null,
        session: e ? e[6] : sessionFromName(f.path),
        lastTotal: e ? e[7] : null,
      };
      const ctx = { st, retentionStartMs, index, seen, stats };
      const offset = await readCompleteLines(f.path, start, f.size, (region) => scanRegion(region, ctx));
      stats.filesScanned++;
      changed = true;
      return { offset, st };
    };

    for (const w of work) {
      try {
        const { offset, st } = await readFile(w.f, w.start, w.e);
        const headLen = Math.min(HEAD_LEN, offset);
        index.files[w.f.path] = [w.f.size, w.f.mtimeMs, offset, headLen, headHash(w.f.path, headLen), st.model, st.session, st.lastTotal];
      } catch {
        stats.errors++;
      }
      done++;
      if (onProgress) onProgress(done, work.length);
    }
    for (const f of old) {
      const bestMs = index.rate ? Date.parse(index.rate.timestamp) : 0;
      if (f.mtimeMs <= bestMs) break;
      const sig = f.size + ':' + f.mtimeMs;
      if (oldSeen[f.path] === sig) continue;
      try {
        await readFile(f, 0, null);
        oldSeen[f.path] = sig;
      } catch {
        stats.errors++;
      }
    }

    for (const p of Object.keys(index.files)) {
      if (!live.has(p)) {
        delete index.files[p];
        changed = true;
      }
    }
    const present = new Set(all.map((f) => f.path));
    for (const p of Object.keys(oldSeen)) {
      if (!present.has(p)) delete oldSeen[p];
    }
    if (index.fromDate !== fromDate) {
      for (const k of Object.keys(index.buckets)) if (k.slice(0, 10) < fromDate) delete index.buckets[k];
      for (const [h, d] of seen) if (d < fromDate) seen.delete(h);
      index.fromDate = fromDate;
      changed = true;
    }
    if (changed && indexFile) {
      const byDate = {};
      for (const [h, d] of seen) (byDate[d] || (byDate[d] = [])).push(h);
      const seenObj = {};
      for (const d of Object.keys(byDate).sort()) seenObj[d] = byDate[d].join(',');
      try {
        writeJsonAtomic(indexFile, { ...index, seen: seenObj });
      } catch {
        stats.errors++;
      }
    }

    return {
      available: all.length > 0,
      source: { id: SOURCE_ID, label: 'Codex sessions', path: sessionsDir, accountName: null, sizeBytes, files: all.length },
      buckets: index.buckets,
      rate: index.rate,
      plan: index.plan,
      stats: { ...stats, filesInRange: live.size, filesWork: work.length },
    };
  }

  return { scan };
}

const TOKEN_PAT = Buffer.from('"token_count"');
const TURN_PAT = Buffer.from('"turn_context"');
const META_PAT = Buffer.from('"session_meta"');

function scanRegion(region, ctx) {
  let s = 0;
  while (s < region.length) {
    let le = region.indexOf(10, s);
    if (le < 0) le = region.length;
    const line = region.subarray(s, le);
    s = le + 1;
    let kind = 0;
    if (line.indexOf(TOKEN_PAT) >= 0) kind = 1;
    else if (line.indexOf(TURN_PAT) >= 0) kind = 2;
    else if (line.indexOf(META_PAT) >= 0) kind = 3;
    if (!kind) continue;
    let o;
    try {
      o = JSON.parse(line.toString('utf8'));
    } catch {
      ctx.stats.badLines++;
      continue;
    }
    if (!o || typeof o !== 'object' || !o.payload || typeof o.payload !== 'object') continue;
    if (o.type === 'turn_context') {
      if (typeof o.payload.model === 'string' && o.payload.model) ctx.st.model = o.payload.model;
    } else if (o.type === 'session_meta') {
      const id = o.payload.id || o.payload.session_id;
      if (typeof id === 'string' && id) ctx.st.session = id;
    } else if (o.type === 'event_msg' && o.payload.type === 'token_count') {
      countTokenEvent(o, ctx);
    }
  }
}

function windowOf(w, eventMs) {
  if (!w || typeof w !== 'object') return null;
  const used = typeof w.used_percent === 'number' ? w.used_percent : null;
  if (used === null) return null;
  let resetsAt = typeof w.resets_at === 'number' ? w.resets_at * 1000 : null;
  if (resetsAt === null && typeof w.resets_in_seconds === 'number') resetsAt = eventMs + w.resets_in_seconds * 1000;
  return {
    usedPct: used,
    windowMinutes: typeof w.window_minutes === 'number' ? w.window_minutes : null,
    resetsAt: resetsAt === null ? null : new Date(resetsAt).toISOString(),
  };
}

function countTokenEvent(o, ctx) {
  const p = o.payload;
  const ts = Date.parse(o.timestamp);
  const { index, st } = ctx;

  const rl = p.rate_limits;
  if (rl && typeof rl === 'object' && Number.isFinite(ts)) {
    if (typeof rl.plan_type === 'string' && (!index.plan || ts > Date.parse(index.plan.timestamp))) {
      index.plan = { timestamp: o.timestamp, planType: rl.plan_type };
    }
    const primary = windowOf(rl.primary, ts);
    const secondary = windowOf(rl.secondary, ts);
    if ((primary || secondary) && (!index.rate || ts > Date.parse(index.rate.timestamp))) {
      index.rate = {
        timestamp: o.timestamp,
        planType: typeof rl.plan_type === 'string' ? rl.plan_type : null,
        primary,
        secondary,
      };
    }
  }

  const info = p.info;
  if (!info || typeof info !== 'object') return;
  const total = info.total_token_usage && typeof info.total_token_usage.total_tokens === 'number'
    ? info.total_token_usage.total_tokens
    : null;
  if (total !== null) {
    if (st.lastTotal !== null && st.lastTotal !== undefined && total === st.lastTotal) {
      ctx.stats.repeats++;
      return; // repeated event, nothing new happened
    }
    st.lastTotal = total;
  }
  const last = info.last_token_usage;
  if (!last || typeof last !== 'object') return;
  if (!Number.isFinite(ts) || ts < ctx.retentionStartMs) return;

  // A forked rollout copies earlier events verbatim; the same (timestamp, running
  // total, turn usage) must not count twice.
  const h = hashKey(o.timestamp + '|' + total + '|' + last.total_tokens + '|' + last.input_tokens);
  if (ctx.seen.has(h)) {
    ctx.stats.duplicates++;
    return;
  }
  const date = localDateKey(ts);
  ctx.seen.set(h, date);

  const cached = num(last.cached_input_tokens);
  const input = Math.max(0, num(last.input_tokens) - cached);
  const output = num(last.output_tokens);
  const model = st.model || 'unknown';
  const key = date + '\t' + SOURCE_ID + '\t' + (st.session || 'unknown') + '\t' + model + '\t0';
  let b = index.buckets[key];
  if (!b) b = index.buckets[key] = [0, 0, 0, 0, 0, 0];
  b[0] += input;
  b[1] += output;
  b[2] += cached;
  b[5] += 1;
  ctx.stats.eventsCounted++;
}

module.exports = { createCodexScanner, INDEX_FILE, SOURCE_ID };
