'use strict';
// Snapshot worker (CONTRACT section 4).
//
//   parent -> worker  { type: "init", stateDir, rangeDays, costBasis?, persistEveryMs? }
//                     costBasis "per-reply" (default) | "claude-app"; persistEveryMs: batch the
//                     index/ledger writes (0 = write after every snapshot, the default)
//   parent -> worker  { type: "snapshot", requestId, force? }
//   parent -> worker  { type: "shutdown" }   write what is pending, then exit 0 (the shell
//                     sends it when the panel has been closed a while, to give the memory back)
//   worker -> parent  { type: "progress", requestId, phase, filesDone, filesTotal }
//   worker -> parent  { type: "snapshot", requestId, snapshot }
//   worker -> parent  { type: "error", requestId, message }
//
// Runs under Electron utilityProcess.fork() (process.parentPort, payload in
// event.data) and under plain child_process.fork() (process.on('message') /
// process.send), so it can be tested without Electron.
//
// One scan at a time. Requests that arrive while a scan runs are batched into ONE
// follow-up scan and all answered with its result (so nobody gets data older than
// their request). A non-forced request that arrives within REUSE_MS of a finished
// scan, with nothing running, is answered from that scan.
//
// Test-only init extras (ignored by the app): home, appData, now, allowNetwork.
//
// A second init that changes ONLY costBasis (the shell's setting) keeps the same
// collector, so the switch costs no rescan; any other change builds a new collector.

const os = require('node:os');
const { createCollector } = require('./index');

const REUSE_MS = 1500;
const PROGRESS_EVERY_MS = 200;

const port = process.parentPort || null;
const isWorker = !!port || typeof process.send === 'function';

function send(msg) {
  try {
    if (port) port.postMessage(msg);
    else if (typeof process.send === 'function') process.send(msg);
  } catch {
    /* parent went away */
  }
}

let collector = null;
let collectorKey = null; // the init fields other than costBasis
let running = false;
let batch = []; // waiting requests: { requestId, force }
let last = null; // { at, snapshot }

let closing = false;

function errMessage(err) {
  return err && err.message ? err.message : String(err);
}

// Flush waits for a scan in flight (the collector chains it), so nothing is cut in half.
function shutdown() {
  if (closing) return;
  closing = true;
  const exit = () => {
    if (isWorker) process.exit(0);
  };
  const pending = collector ? collector.flush() : Promise.resolve();
  pending.then(exit, exit);
}

async function runBatch() {
  if (running || batch.length === 0) return;
  running = true;
  const reqs = batch;
  batch = [];
  const force = reqs.some((r) => r.force);
  let lastProgress = 0;
  let lastPhase = '';
  try {
    if (!collector) throw new Error('worker not initialised: send { type: "init", stateDir, rangeDays } first');
    const snapshot = await collector.snapshot({
      force,
      onProgress: (p) => {
        const t = Date.now();
        const edge = p.filesDone === 0 || p.filesDone === p.filesTotal || p.phase !== lastPhase;
        if (!edge && t - lastProgress < PROGRESS_EVERY_MS) return;
        lastProgress = t;
        lastPhase = p.phase;
        for (const r of reqs) send({ type: 'progress', requestId: r.requestId, phase: p.phase, filesDone: p.filesDone, filesTotal: p.filesTotal });
      },
    });
    last = { at: Date.now(), snapshot };
    for (const r of reqs) send({ type: 'snapshot', requestId: r.requestId, snapshot });
  } catch (err) {
    for (const r of reqs) send({ type: 'error', requestId: r.requestId, message: errMessage(err) });
  } finally {
    running = false;
    if (batch.length) setImmediate(runBatch);
  }
}

function handle(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'init') {
    try {
      const opts = {
        stateDir: msg.stateDir,
        rangeDays: msg.rangeDays || 30,
        home: msg.home,
        appData: msg.appData,
        now: msg.now,
        allowNetwork: msg.allowNetwork !== false,
        persistEveryMs: Number(msg.persistEveryMs) > 0 ? Number(msg.persistEveryMs) : 0,
      };
      const key = JSON.stringify(opts);
      if (collector && key === collectorKey) {
        collector.setCostBasis(msg.costBasis);
      } else {
        collector = createCollector({ ...opts, costBasis: msg.costBasis });
        collectorKey = key;
      }
      last = null; // the next snapshot reflects the new settings
    } catch (err) {
      send({ type: 'error', requestId: null, message: 'init failed: ' + errMessage(err) });
    }
    return;
  }
  if (msg.type === 'shutdown') {
    shutdown();
    return;
  }
  if (msg.type === 'snapshot') {
    if (closing) return; // the shell starts a fresh worker for anything sent after shutdown
    const requestId = msg.requestId === undefined ? null : msg.requestId;
    const force = !!msg.force;
    if (!running && !force && last && Date.now() - last.at < REUSE_MS && batch.length === 0) {
      send({ type: 'snapshot', requestId, snapshot: last.snapshot });
      return;
    }
    if (!batch.some((r) => r.requestId === requestId)) batch.push({ requestId, force });
    runBatch();
  }
}

if (isWorker) {
  try {
    os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {
    /* not permitted: SHELL lowers it anyway */
  }
  if (port) {
    port.on('message', (event) => handle(event && event.data !== undefined ? event.data : event));
  } else {
    process.on('message', handle);
    // Exit with the parent instead of lingering as an orphan.
    process.on('disconnect', () => process.exit(0));
  }
}

module.exports = { handle };
