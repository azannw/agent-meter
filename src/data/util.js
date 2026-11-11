'use strict';
// Small shared helpers for the data layer. No dependencies beyond node:*.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const DAY_MS = 86400000;

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

// LOCAL calendar date (the process time zone) of an epoch-ms instant, "YYYY-MM-DD".
function localDateKey(ms) {
  const d = new Date(ms);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

// Local midnight (epoch ms) of the local date `daysBack` days before the date of `ms`.
function localMidnight(ms, daysBack = 0) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - daysBack).getTime();
}

// The `n` local dates ending with the date of `ms`, oldest first.
function lastNDates(ms, n) {
  const d = new Date(ms);
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate() - i, 12);
    out.push(x.getFullYear() + '-' + pad2(x.getMonth() + 1) + '-' + pad2(x.getDate()));
  }
  return out;
}

// Identifies the zone the buckets were built in; if it changes, buckets are rebuilt.
function timeZoneId(ms) {
  let name = '';
  try {
    name = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    name = '';
  }
  return name + '|' + new Date(ms).getTimezoneOffset();
}

// 48-bit key hash, 8 base64url characters. Used for dedupe sets that are persisted,
// so the index stores 8 characters per message instead of a ~60 character id pair.
function hashKey(s) {
  return crypto.createHash('sha1').update(s).digest('base64url').slice(0, 8);
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function round(v, digits) {
  const f = Math.pow(10, digits);
  return Math.round(v * f) / f;
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Temp names carry the writer's pid ("<file>.<pid>.tmp"), so two processes sharing a
// state dir (a capture or selftest run beside the real app) never write the same temp.
function tempPath(file) {
  return file + '.' + process.pid + '.tmp';
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM'; // exists, owned by someone else
  }
}

// Temp files of `file` left by processes that are gone: "<file>.<pid>.tmp", plus the
// pid-less "<file>.tmp" an older build wrote. Returns [{ path, pid, mtimeMs }], newest first.
function staleTemps(file) {
  const dir = path.dirname(file);
  const base = path.basename(file);
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    let pid = null;
    if (n === base + '.tmp') pid = 0;
    else if (n.startsWith(base + '.') && n.endsWith('.tmp')) {
      const mid = n.slice(base.length + 1, -4);
      if (/^\d+$/.test(mid)) pid = Number(mid);
    }
    if (pid === null || (pid !== 0 && pidAlive(pid))) continue;
    const p = path.join(dir, n);
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(p).mtimeMs;
    } catch {
      continue;
    }
    out.push({ path: p, pid, mtimeMs });
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function removeStaleTemps(file) {
  let n = 0;
  for (const t of staleTemps(file)) {
    try {
      fs.unlinkSync(t.path);
      n++;
    } catch {
      /* still held open somewhere: try again next time */
    }
  }
  return n;
}

// Write via a temp file + rename so a crash mid-write never leaves half a JSON file.
function writeJsonAtomic(file, value) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = tempPath(file);
  const text = JSON.stringify(value);
  fs.writeFileSync(tmp, text);
  try {
    fs.renameSync(tmp, file);
  } catch {
    // Windows can refuse a rename onto a file another process holds open
    // (an indexer or antivirus); fall back to a plain overwrite.
    fs.writeFileSync(file, text);
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
  return text.length;
}

// Recursively list files under `dir` whose name passes `accept`, with their stats.
// Missing or unreadable directories yield nothing.
function listFiles(dir, accept) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        stack.push(p);
      } else if (e.isFile() && accept(e.name)) {
        try {
          const st = fs.statSync(p);
          out.push({ path: p, size: st.size, mtimeMs: st.mtimeMs });
        } catch {
          /* vanished between readdir and stat */
        }
      }
    }
  }
  return out;
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

const CHUNK = 4 * 1024 * 1024;
const MAX_LINE = 64 * 1024 * 1024;
let sharedBuf = null;

// Reads bytes [start, end) of a file and hands `onRegion` buffers that contain only
// COMPLETE lines (each region ends with "\n"). A trailing partial line is not
// consumed. Returns the offset just past the last newline consumed, which is where
// the next incremental read must start. Regions are views of a reused buffer:
// `onRegion` must finish with them before returning.
async function readCompleteLines(file, start, end, onRegion) {
  if (!sharedBuf) sharedBuf = Buffer.allocUnsafe(CHUNK);
  const buf = sharedBuf;
  const fh = await fsp.open(file, 'r');
  let consumed = start;
  try {
    let pos = start;
    let carry = null; // copy of an unfinished line from the previous chunk
    let skipping = false; // inside a line longer than MAX_LINE: drop it
    while (pos < end) {
      const want = Math.min(CHUNK, end - pos);
      const { bytesRead } = await fh.read(buf, 0, want, pos);
      if (bytesRead <= 0) break;
      const chunkStart = pos;
      pos += bytesRead;
      let data = buf.subarray(0, bytesRead);
      if (skipping) {
        const nl = data.indexOf(10);
        if (nl < 0) {
          consumed = pos;
          continue;
        }
        skipping = false;
        data = data.subarray(nl + 1);
        consumed = chunkStart + nl + 1;
      }
      if (carry) data = Buffer.concat([carry, data]);
      const lastNL = data.lastIndexOf(10);
      if (lastNL < 0) {
        if (data.length > MAX_LINE) {
          carry = null;
          skipping = true;
          consumed = pos;
        } else {
          carry = Buffer.from(data);
        }
        continue;
      }
      onRegion(data.subarray(0, lastNL + 1));
      const tail = data.length - (lastNL + 1);
      consumed = pos - tail;
      carry = tail > 0 ? Buffer.from(data.subarray(lastNL + 1)) : null;
    }
  } finally {
    await fh.close();
  }
  return consumed;
}

// Hash of the first `len` bytes of a file, used to notice a file that was replaced
// by a different one that happens to be at least as long.
function headHash(file, len) {
  if (len <= 0) return '';
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(len);
    const n = fs.readSync(fd, b, 0, len, 0);
    return crypto.createHash('sha1').update(b.subarray(0, n)).digest('base64url').slice(0, 12);
  } catch {
    return '';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// Is the byte at `offset - 1` a newline? (An incremental read must start on a line boundary.)
function endsLineAt(file, offset) {
  if (offset <= 0) return true;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(1);
    const n = fs.readSync(fd, b, 0, 1, offset - 1);
    return n === 1 && b[0] === 10;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

const HEAD_LEN = 256;

// Decide how to read a file given its previous index entry:
// returns the start offset (0 = whole file) for this scan.
function resumeOffset(file, st, entry) {
  if (!entry) return 0;
  if (st.size === entry.size && st.mtimeMs === entry.mtimeMs) return -1; // unchanged
  if (st.size < entry.size || st.mtimeMs < entry.mtimeMs) return 0; // truncated or rewritten
  if (entry.offset > st.size) return 0;
  if (entry.headLen > 0 && headHash(file, entry.headLen) !== entry.head) return 0; // replaced
  if (!endsLineAt(file, entry.offset)) return 0;
  return entry.offset;
}

module.exports = {
  DAY_MS,
  HEAD_LEN,
  localDateKey,
  localMidnight,
  lastNDates,
  timeZoneId,
  hashKey,
  num,
  clamp,
  round,
  readJsonSafe,
  writeJsonAtomic,
  tempPath,
  pidAlive,
  staleTemps,
  removeStaleTemps,
  listFiles,
  isDir,
  readCompleteLines,
  headHash,
  endsLineAt,
  resumeOffset,
};
