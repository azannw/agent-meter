'use strict';
// Small file logger: <userData>/logs/main.log, rotated once at 1 MB.
// Also mirrors to stdout/stderr, which only shows when started from a terminal.

const fs = require('node:fs');
const path = require('node:path');

let file = null;
const MAX_BYTES = 1024 * 1024;

function init(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, 'main.log');
    const st = fs.statSync(file, { throwIfNoEntry: false });
    if (st && st.size > MAX_BYTES) fs.renameSync(file, file + '.1');
  } catch {
    file = null;
  }
}

function fmt(v) {
  if (v instanceof Error) return v.stack || v.message;
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function write(level, scope, args) {
  const line = `${new Date().toISOString()} ${level.padEnd(5)} [${scope}] ${args.map(fmt).join(' ')}`;
  try {
    (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
  } catch {
    /* no console attached */
  }
  if (file) {
    try {
      fs.appendFileSync(file, line + '\n');
    } catch {
      /* disk full or locked: logging must never take the app down */
    }
  }
}

function createLogger(scope) {
  return {
    info: (...a) => write('info', scope, a),
    warn: (...a) => write('warn', scope, a),
    error: (...a) => write('error', scope, a),
    debug: (...a) => (process.env.AGENT_METER_DEBUG ? write('debug', scope, a) : undefined),
  };
}

module.exports = { init, createLogger, get file() {
  return file;
} };
