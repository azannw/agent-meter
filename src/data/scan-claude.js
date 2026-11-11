'use strict';
// Incremental scanner over Claude Code transcripts (every config folder's
// projects/**/*.jsonl). Only token COUNTS, model ids, session ids, timestamps and
// dedupe hashes are kept; transcript content is never stored or printed.
//
// Index (stateDir/scan-index-claude.json):
//   files:   path -> [size, mtimeMs, offset, headLen, headHash, sourceId, appMap|null]
//            offset = just past the last complete line read, so the next scan
//            only reads appended bytes. appMap: this file's Claude-app-style sums
//            (see below), "date\tmodel\tfast" -> [6 numbers], null if the file is
//            not one the Claude app counts.
//   buckets: "date\tsource\tsession\tmodel\tfast" ->
//            [input, output, cacheRead, cacheWrite5m, cacheWrite1h, messages]
//            date is the LOCAL calendar date. Costs are computed from these at
//            snapshot time, so a price change never needs a rescan.
//   seen:    date -> "<hash8><output base36>,..." one entry per counted message
//            (hash of message.id + ":" + requestId). Bounded: dates older than
//            the retention window are dropped together with their buckets.
//
// Why output is remembered per message: Claude Code writes one line per content
// block, all with the same message.id/requestId, and output_tokens GROWS across
// those lines (8 -> 190) while input and cache fields stay put. Counting the first
// line undercounts output; counting each line overcounts everything. So a message
// is counted once, and a later copy with a larger output adds only the difference.
//
// Claude-app style (CONTRACT section 2, Headline), counted in the SAME pass: the
// Claude desktop app's /usage figure sums EVERY assistant line's usage, no dedupe,
// over its own file set:
//   <config>/projects/<dir>/*.jsonl                         ("main", skips isSidechain lines)
//   <config>/projects/<dir>/<x>/subagents/agent-*.jsonl     ("sub", keeps them)
// (deeper files, e.g. workflow transcripts, are NOT in it), files with an mtime
// before local midnight of now - 182 days or larger than 1 GiB are skipped, and the
// line's LOCAL date is its day. With no seen set to stop a re-count, app-style sums
// are kept PER FILE (appMap): a rescan replaces that file's map instead of adding to
// it. The app count for a day is then the sum over the files on disk, which is what
// the app itself would show; the ledger keeps the largest value ever seen.

const path = require('node:path');
const fs = require('node:fs');
const {
  HEAD_LEN,
  localDateKey,
  timeZoneId,
  hashKey,
  num,
  readJsonSafe,
  writeJsonAtomic,
  listFiles,
  isDir,
  readCompleteLines,
  headHash,
  resumeOffset,
  removeStaleTemps,
} = require('./util');

const INDEX_FILE = 'scan-index-claude.json';
const INDEX_VERSION = 2; // 2: per-file appMap
const APP_MAX_BYTES = 1073741824; // the Claude app skips files over 1 GiB
const USAGE_PAT = Buffer.from('"usage":');
const ASSISTANT_PAT = Buffer.from('"type":"assistant"');
// Node's readline (which the replica of the Claude app uses) also breaks lines at
// U+2028 / U+2029, so a JSON line holding one never parses there: such lines are
// left out of the Claude-app count (15 lines / 6.7M tokens on this machine, 2026-10-03).
const LS_PAT = Buffer.from('\u2028');
const PS_PAT = Buffer.from('\u2029');

// Claude config folders: %USERPROFILE%\.claude, every %USERPROFILE%\.claude-* with a
// projects dir, and every folder a Usage Monitor profile names.
// profiles: [{ id, name, config_dir, enabled }] from the Usage Monitor settings.
function discoverClaudeSources(home, profiles = []) {
  const norm = (p) => path.resolve(p).toLowerCase();
  const byDir = new Map();
  for (const p of profiles) {
    if (!p || typeof p !== 'object') continue;
    const dir = p.config_dir ? p.config_dir : path.join(home, '.claude');
    if (!byDir.has(norm(dir))) byDir.set(norm(dir), p);
  }
  const sources = [];
  const seenDirs = new Set();
  const usedIds = new Set();
  const add = (dir, fallbackId, isDefault) => {
    const key = norm(dir);
    if (seenDirs.has(key)) return;
    seenDirs.add(key);
    const prof = byDir.get(key) || null;
    const base = path.basename(dir);
    // Ids are unique. ~/.claude is added first and keeps 'default' for good (its id is stored
    // in the scan index with every bucket). With one login folder per account (the setup
    // recommended since 2026-10-03) the Usage Monitor's first profile, id 'default', names
    // another folder: that source becomes 'default:.claude-gmail' instead of a second 'default'.
    let id = (prof && prof.id) || fallbackId;
    if (usedIds.has(id)) id = id + ':' + base;
    usedIds.add(id);
    sources.push({
      id,
      label: isDefault ? 'Claude app & CLI' : base + ' folder',
      path: dir,
      projectsDir: path.join(dir, 'projects'),
      accountName: (prof && prof.name) || null,
      profileId: (prof && prof.id) || null,
      isDefault,
    });
  };
  add(path.join(home, '.claude'), 'default', true);
  let entries = [];
  try {
    entries = fs.readdirSync(home, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith('.claude-')) continue;
    const dir = path.join(home, e.name);
    if (isDir(path.join(dir, 'projects'))) add(dir, e.name.slice(1), false);
  }
  // Profiles pointing elsewhere (or at a folder with no projects dir yet) still get
  // a source row, so the UI can show "second account: nothing yet".
  for (const p of profiles) {
    if (!p || !p.config_dir) continue;
    add(p.config_dir, p.id || path.basename(p.config_dir).replace(/^\./, ''), false);
  }
  return sources;
}

// Which Claude-app file class a transcript is in: 'main', 'sub' or null (not counted).
function appKind(projectsDir, file) {
  const rel = path.relative(projectsDir, file).split(/[\\/]/);
  if (rel.length === 2 && rel[1].endsWith('.jsonl')) return 'main';
  if (rel.length === 4 && rel[2] === 'subagents' && rel[3].startsWith('agent-') && rel[3].endsWith('.jsonl')) return 'sub';
  return null;
}

function cloneMap(m) {
  const out = {};
  if (m) for (const [k, v] of Object.entries(m)) out[k] = v.slice();
  return out;
}

function emptyIndex(tz, fromDate) {
  return { version: INDEX_VERSION, tz, fromDate, files: {}, buckets: {}, seen: {} };
}

function loadIndex(file, tz, fromDate) {
  const raw = readJsonSafe(file);
  if (
    !raw ||
    raw.version !== INDEX_VERSION ||
    raw.tz !== tz ||
    typeof raw.fromDate !== 'string' ||
    raw.fromDate > fromDate || // the range grew backwards: those days were never read
    typeof raw.files !== 'object' ||
    typeof raw.buckets !== 'object' ||
    typeof raw.seen !== 'object'
  ) {
    return { index: emptyIndex(tz, fromDate), fresh: true };
  }
  return { index: raw, fresh: false };
}

// seen: Map<hash, [output, date]> rebuilt from the per-date strings.
function decodeSeen(seenObj) {
  const map = new Map();
  for (const [date, s] of Object.entries(seenObj)) {
    if (typeof s !== 'string' || !s) continue;
    for (const item of s.split(',')) {
      if (item.length < 9) continue;
      map.set(item.slice(0, 8), [parseInt(item.slice(8), 36) || 0, date]);
    }
  }
  return map;
}

function encodeSeen(map, fromDate) {
  const byDate = {};
  for (const [h, [out, date]] of map) {
    if (date < fromDate) continue;
    (byDate[date] || (byDate[date] = [])).push(h + out.toString(36));
  }
  const obj = {};
  for (const d of Object.keys(byDate).sort()) obj[d] = byDate[d].join(',');
  return obj;
}

// persistEveryMs: write the index at most this often (0 = after every scan that changed
// it). The index is a cache of what has been read: a crash before the next write only
// means those bytes are read again, never counted twice, because offsets, buckets and the
// seen set are always written together from the same moment. flush() writes what is
// pending (the worker calls it before it exits).
function createClaudeScanner({ stateDir, home, persistEveryMs = 0 }) {
  const indexFile = stateDir ? path.join(stateDir, INDEX_FILE) : null;
  let state = null; // { index, seen: Map }
  let dirty = false; // the in-memory index has changes the file does not
  let persistedAt = 0;

  function persist() {
    if (!dirty || !indexFile || !state) return null;
    const bytes = writeJsonAtomic(indexFile, { ...state.index, seen: encodeSeen(state.seen, state.index.fromDate) });
    dirty = false;
    persistedAt = Date.now();
    return bytes;
  }

  // retentionStartMs: local midnight of the oldest date kept (range start minus margin).
  // appWindowStartMs: the Claude app's file window (local midnight of now - 182 days).
  //   App-class files with an mtime inside it stay indexed (and are read once) even
  //   when they are older than the range, so the app-style sum covers what the app sees.
  // fresh: ignore the saved index and read everything again (the ledger seed passes
  // fresh with retentionStartMs 0 to read ALL history once).
  // appMaxBytes: the app's 1 GiB file limit (a parameter only so a test can prove it).
  async function scan({ profiles = [], retentionStartMs, appWindowStartMs, appMaxBytes = APP_MAX_BYTES, fromDate, now, onProgress, fresh = false } = {}) {
    if (appWindowStartMs === undefined || appWindowStartMs === null) appWindowStartMs = retentionStartMs;
    const tz = timeZoneId(now);
    if (fresh || !state || state.index.tz !== tz || state.index.fromDate > fromDate) {
      if (indexFile) removeStaleTemps(indexFile); // temps of processes that died mid-write
      const loaded = indexFile && !fresh ? loadIndex(indexFile, tz, fromDate) : { index: emptyIndex(tz, fromDate), fresh: true };
      state = { index: loaded.index, seen: decodeSeen(loaded.index.seen) };
      state.index.seen = {}; // the Map is the live copy; re-encoded on save
    }
    const { index, seen } = state;
    const sources = discoverClaudeSources(home, profiles);

    // 1. List every transcript (sizes feed storageBytes even for files we skip).
    const sourceStats = new Map();
    const work = [];
    const liveFiles = new Set();
    for (const src of sources) {
      const files = listFiles(src.projectsDir, (n) => n.endsWith('.jsonl'));
      let size = 0;
      for (const f of files) {
        size += f.size;
        const kind = appKind(src.projectsDir, f.path);
        const inRange = f.mtimeMs >= retentionStartMs;
        const inAppWindow = kind !== null && f.mtimeMs >= appWindowStartMs;
        if (!inRange && !inAppWindow) continue; // last written before both windows
        liveFiles.add(f.path);
        const e = index.files[f.path];
        const entry = e ? { size: e[0], mtimeMs: e[1], offset: e[2], headLen: e[3], head: e[4], appMap: e[6] || null } : null;
        let start = resumeOffset(f.path, f, entry);
        if (start < 0) continue; // unchanged since the last scan
        if (kind && start > 0 && !entry.appMap) start = 0; // its app sums would be incomplete
        work.push({ file: f, src, start, entry, kind });
      }
      sourceStats.set(src.id, { sizeBytes: size, files: files.length });
    }

    // 2. Read only what is new.
    const stats = { filesScanned: 0, bytesRead: 0, linesCounted: 0, appLines: 0, duplicates: 0, badLines: 0, rescans: 0, errors: 0 };
    const buckets = index.buckets;
    let changed = false;
    let done = 0;
    if (onProgress) onProgress(0, work.length);
    for (const w of work) {
      const { file, src, start } = w;
      if (start === 0 && w.entry) stats.rescans++;
      const fileSession = sessionFromPath(file.path);
      // App sums go into a copy that is committed only when the read succeeds, so a
      // failed read can be retried without counting its lines twice.
      const appMap = w.kind ? (start > 0 ? cloneMap(w.entry.appMap) : {}) : null;
      const ctx = { srcId: src.id, fileSession, retentionStartMs, seen, buckets, stats, appMap, appSkipSidechain: w.kind === 'main' };
      try {
        const offset = await readCompleteLines(file.path, start, file.size, (region) => scanRegion(region, ctx));
        stats.bytesRead += file.size - start;
        const headLen = Math.min(HEAD_LEN, offset);
        const head = start === 0 || !w.entry || w.entry.headLen !== headLen ? headHash(file.path, headLen) : w.entry.head;
        index.files[file.path] = [file.size, file.mtimeMs, offset, headLen, head, src.id, appMap];
        changed = true;
      } catch {
        stats.errors++;
      }
      stats.filesScanned++;
      done++;
      if (onProgress) onProgress(done, work.length);
    }

    // 3. Keep the index bounded: forget files that left the range, buckets and
    //    dedupe hashes older than the retention window.
    for (const p of Object.keys(index.files)) {
      if (!liveFiles.has(p)) {
        delete index.files[p];
        changed = true;
      }
    }
    if (index.fromDate !== fromDate) {
      for (const k of Object.keys(buckets)) {
        if (k.slice(0, 10) < fromDate) delete buckets[k];
      }
      for (const [h, v] of seen) {
        if (v[1] < fromDate) seen.delete(h);
      }
      index.fromDate = fromDate;
      changed = true;
    }

    let indexBytes = null;
    if (changed) dirty = true;
    if (dirty && indexFile && (persistEveryMs <= 0 || Date.now() - persistedAt >= persistEveryMs)) {
      try {
        indexBytes = persist();
      } catch {
        stats.errors++;
      }
    }

    // 4. The Claude-app count as the app would compute it right now: the per-file
    //    sums of the app-class files on disk inside its window and under 1 GiB.
    const appBuckets = {};
    let appFiles = 0;
    for (const e of Object.values(index.files)) {
      const map = e[6];
      if (!map || e[0] > appMaxBytes || e[1] < appWindowStartMs) continue;
      appFiles++;
      for (const [k, v] of Object.entries(map)) {
        const tab = k.indexOf('\t');
        const key = k.slice(0, tab) + '\t' + e[5] + k.slice(tab);
        const b = appBuckets[key] || (appBuckets[key] = [0, 0, 0, 0, 0, 0]);
        for (let i = 0; i < 6; i++) b[i] += v[i];
      }
    }

    return {
      sources: sources.map((s) => ({ ...s, ...(sourceStats.get(s.id) || { sizeBytes: 0, files: 0 }) })),
      buckets,
      appBuckets, // "date\tsource\tmodel\tfast" -> [input, output, cacheRead, cw5m, cw1h, lines]
      stats: { ...stats, filesInRange: liveFiles.size, filesWork: work.length, appFiles, seenKeys: seen.size, indexBytes, indexPending: dirty },
    };
  }

  // Write a pending index now. Returns the bytes written, or null when nothing was pending.
  function flush() {
    return persist();
  }

  return { scan, flush, get pending() { return dirty; } };
}

// "<projects>/<project>/<session>.jsonl" or "<projects>/<project>/<session>/subagents/x.jsonl"
function sessionFromPath(p) {
  const parts = p.split(/[\\/]/);
  const i = parts.lastIndexOf('subagents');
  if (i > 0) return parts[i - 1];
  return path.basename(p, '.jsonl');
}

function scanRegion(region, ctx) {
  let s = 0;
  for (;;) {
    const h = region.indexOf(USAGE_PAT, s);
    if (h < 0) return;
    const ls = region.lastIndexOf(10, h) + 1;
    let le = region.indexOf(10, h);
    if (le < 0) le = region.length;
    s = le + 1;
    const line = region.subarray(ls, le);
    if (line.indexOf(ASSISTANT_PAT) < 0) continue; // cheap pre-filter before JSON.parse
    let o;
    try {
      o = JSON.parse(line.toString('utf8'));
    } catch {
      ctx.stats.badLines++;
      continue;
    }
    ctx.appBroken = line.indexOf(LS_PAT) >= 0 || line.indexOf(PS_PAT) >= 0;
    countRecord(o, ctx);
  }
}

function countRecord(o, ctx) {
  if (!o || o.type !== 'assistant') return;
  const m = o.message;
  if (!m || typeof m !== 'object') return;
  const u = m.usage;
  if (!u || typeof u !== 'object') return;
  const model = typeof m.model === 'string' && m.model ? m.model : 'unknown';
  if (model === '<synthetic>') return;
  const ts = Date.parse(o.timestamp);
  if (!Number.isFinite(ts)) return;

  const input = num(u.input_tokens);
  const output = num(u.output_tokens);
  const cacheRead = num(u.cache_read_input_tokens);
  const cwTotal = num(u.cache_creation_input_tokens);
  const cc = u.cache_creation && typeof u.cache_creation === 'object' ? u.cache_creation : null;
  const fast = u.speed === 'fast' ? 1 : 0;

  // Claude-app style: every qualifying line, whatever its date, no dedupe. The app's
  // token count adds cache_creation_input_tokens, so the 5m/1h split kept for
  // pricing is made to sum to exactly that.
  if (ctx.appMap && !ctx.appBroken && !(ctx.appSkipSidechain && o.isSidechain)) {
    const a1 = cc ? Math.min(num(cc.ephemeral_1h_input_tokens), cwTotal) : 0;
    const ak = localDateKey(ts) + '\t' + model + '\t' + fast;
    const r = ctx.appMap[ak] || (ctx.appMap[ak] = [0, 0, 0, 0, 0, 0]);
    r[0] += input;
    r[1] += output;
    r[2] += cacheRead;
    r[3] += cwTotal - a1;
    r[4] += a1;
    r[5] += 1;
    ctx.stats.appLines++;
  }

  if (ts < ctx.retentionStartMs) return;
  const date = localDateKey(ts);
  let cw5 = cwTotal;
  let cw1 = 0;
  if (cc) {
    cw1 = num(cc.ephemeral_1h_input_tokens);
    cw5 = Math.max(num(cc.ephemeral_5m_input_tokens), cwTotal - cw1);
  }
  const session = typeof o.sessionId === 'string' && o.sessionId ? o.sessionId : ctx.fileSession;
  const key = date + '\t' + ctx.srcId + '\t' + session + '\t' + model + '\t' + fast;

  const rawKey = m.id ? m.id + ':' + (o.requestId || '') : o.uuid ? 'uuid:' + o.uuid : null;
  if (rawKey) {
    const h = hashKey(rawKey);
    const prev = ctx.seen.get(h);
    if (prev) {
      ctx.stats.duplicates++;
      if (output > prev[0]) {
        addTo(ctx.buckets, key, 0, output - prev[0], 0, 0, 0, 0);
        prev[0] = output;
      }
      return;
    }
    ctx.seen.set(h, [output, date]);
  }
  addTo(ctx.buckets, key, input, output, cacheRead, cw5, cw1, 1);
  ctx.stats.linesCounted++;
}

function addTo(buckets, key, input, output, cacheRead, cw5, cw1, msgs) {
  let b = buckets[key];
  if (!b) b = buckets[key] = [0, 0, 0, 0, 0, 0];
  b[0] += input;
  b[1] += output;
  b[2] += cacheRead;
  b[3] += cw5;
  b[4] += cw1;
  b[5] += msgs;
}

module.exports = { createClaudeScanner, discoverClaudeSources, sessionFromPath, appKind, INDEX_FILE, APP_MAX_BYTES };
