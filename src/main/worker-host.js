'use strict';
// Runs the DATA agent's src/data/worker.js in an Electron utility process at
// below-normal priority, schedules snapshots, and relays progress/snapshots.
//
// Cadence (2026-10-03): every 9 s while the panel is open, every 5 min while it
// is hidden, and on open when the last snapshot is more than a few seconds old.
// A hover over the tray icon starts that refresh early, so the panel usually
// opens on numbers that are already current.
//
// Memory: the worker holds the scan index (~85 MB resident). It is only needed
// while snapshots are being made, so once the panel is closed and nothing is in
// flight it is asked to write what is pending and exit; the next request starts
// a fresh one (~0.3 s). Index and ledger writes are batched (persistEveryMs) and
// flushed on that exit.
//
// Limits: the Usage Monitor's cache is small and changes on its own schedule, so
// the shell reads it itself (readLimits) and swaps the fresh block into the last
// snapshot: limit changes reach the panel and the tray at once, without waking
// the worker. Every worker snapshot gets the freshest block too.
//
// Failures (CONTRACT section 5, onError): example data is shown ONLY with
// --mock. Before the first real snapshot a failure publishes nothing: the host
// keeps the error (getState().error) and emits 'engine-error'; the UI shows its
// "Could not read usage" state. After a real snapshot, a failure keeps that
// snapshot and emits 'engine-error'. A worker that died is restarted with backoff.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createLogger } = require('./log');
const { markActive } = require('./follow-account');

const log = createLogger('worker');

const RANGE_DAYS = 30;
const OPEN_INTERVAL_MS = 9 * 1000;
const HIDDEN_INTERVAL_MS = 5 * 60 * 1000;
const STALE_ON_OPEN_MS = 3 * 1000;
const PREWARM_STALE_MS = 9 * 1000;
const PREWARM_THROTTLE_MS = 3 * 1000;
const LIMITS_OPEN_INTERVAL_MS = 30 * 1000; // pace and resets move with the clock
const LIMITS_DEBOUNCE_MS = 250;
const IDLE_AFTER_CLOSE_MS = 30 * 1000; // the panel is often reopened within seconds
const IDLE_AFTER_TICK_MS = 5 * 1000; // a background tick while hidden: give it back soon
const SHUTDOWN_GRACE_MS = 3000; // then it is killed
const PERSIST_EVERY_MS = 60 * 1000;
const FIRST_TIMEOUT_MS = 180 * 1000; // first scan budget is 60 s; leave room on a busy laptop
const LATER_TIMEOUT_MS = 90 * 1000;
const STALL_TIMEOUT_MS = 60 * 1000; // once progress flows, this long without any is a hang
const MISSING_RECHECK_MS = 30 * 1000;
const COST_BASES = ['per-reply', 'claude-app'];
const DEFAULT_COST_BASIS = 'per-reply';

function usageCacheDir() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'ClaudeCodeUsageMonitor');
}

/** The default limits reader: the same block the worker builds, read in this process. */
function defaultReadLimits() {
  const { readClaudeLimits, claudeLimitsBlock } = require('../data/limits');
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return claudeLimitsBlock(readClaudeLimits({ appData, now: Date.now() }));
}

function looksLikeSnapshot(s) {
  return !!s && typeof s === 'object' && s.schemaVersion === 1 && Array.isArray(s.providers) && !!s.overview;
}

/** A copy of the snapshot with the Claude provider's limits replaced (nothing else is copied). */
function withClaudeLimits(snapshot, block) {
  if (!snapshot || !block || !Array.isArray(snapshot.providers)) return snapshot;
  let hit = false;
  const providers = snapshot.providers.map((p) => {
    if (!p || p.id !== 'claude') return p;
    hit = true;
    return { ...p, limits: block };
  });
  return hit ? { ...snapshot, providers } : snapshot;
}

class WorkerHost extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.appDir        app folder (contains src/)
   * @param {string} o.stateDir      passed to the worker's init
   * @param {Function} o.fork        utilityProcess.fork (injected so tests can fake it)
   * @param {boolean} [o.mock]       never start the worker, serve the bundled example as-is
   * @param {string} [o.costBasis]   "per-reply" (default) | "claude-app", sent in init
   * @param {Function|null} [o.readLimits]  () => limits block | null; null turns the shell's
   *                                 own limit reads off (tests). Default: the Usage Monitor cache.
   * @param {boolean} [o.watchLimits]  watch the Usage Monitor's folder (default true)
   * @param {Function} [o.activeAccount]  () => the Usage Monitor profile the Claude app is using
   *                                 (limits.activeId, for the tray number), or null
   * @param {object} [o.timing]      test overrides for the timing constants above
   */
  constructor({ appDir, stateDir, fork, mock = false, costBasis = DEFAULT_COST_BASIS, readLimits = defaultReadLimits, watchLimits = true, activeAccount = () => null, timing = {} }) {
    super();
    this.appDir = appDir;
    this.stateDir = stateDir;
    this.fork = fork;
    this.mock = mock;
    this.costBasis = COST_BASES.includes(costBasis) ? costBasis : DEFAULT_COST_BASIS;
    this.readLimits = readLimits;
    this.watchLimits = watchLimits;
    this.activeAccount = activeAccount;
    this.t = {
      openInterval: OPEN_INTERVAL_MS,
      hiddenInterval: HIDDEN_INTERVAL_MS,
      staleOnOpen: STALE_ON_OPEN_MS,
      prewarmStale: PREWARM_STALE_MS,
      prewarmThrottle: PREWARM_THROTTLE_MS,
      limitsOpenInterval: LIMITS_OPEN_INTERVAL_MS,
      idleAfterClose: IDLE_AFTER_CLOSE_MS,
      idleAfterTick: IDLE_AFTER_TICK_MS,
      shutdownGrace: SHUTDOWN_GRACE_MS,
      ...timing,
    };
    // AGENT_METER_WORKER points at another worker file: only for testing the failure paths.
    this.workerPath = process.env.AGENT_METER_WORKER || path.join(appDir, 'src', 'data', 'worker.js');
    this.child = null;
    this.childReady = false;
    this.stopping = null; // the child asked to exit (idle); its exit is not a failure
    this.stopTimer = null;
    this.snapshot = null; // last REAL snapshot (or, with --mock only, the example)
    this.snapshotAt = 0; // Date.now() when the last WORKER snapshot arrived
    this.example = false; // true only in mock mode
    this.lastError = null; // message of the latest failure; cleared by a real snapshot
    this.inflight = null; // { id, force, reason, startedAt, sent, timer }
    this.pending = null; // { force, reason } queued while one is in flight
    this.reinitPending = false; // cost basis changed while a scan ran
    this.waiters = []; // resolve() of refresh() callers
    this.failures = 0;
    this.restartTimer = null;
    this.periodicTimer = null;
    this.idleTimer = null;
    this.limitsTimer = null;
    this.limitsTick = null;
    this.watcher = null;
    this.panelOpen = false;
    this.seq = 0;
    this.stopped = false;
    this.lastRequestAt = 0;
    this.lastPrewarmAt = 0;
    this.limitsKey = null; // JSON of the last limits block published
    this.stats = { spawned: 0, slept: 0, limitPatches: 0 };
  }

  start() {
    if (this.mock) {
      const ex = this._loadExample();
      if (ex) this._publish(ex, { example: true });
      return;
    }
    this._spawn();
    if (this.watchLimits && this.readLimits) this._watchUsageCache();
    this.request({ reason: 'start' });
  }

  stop() {
    this.stopped = true;
    for (const t of [this.restartTimer, this.periodicTimer, this.idleTimer, this.limitsTimer, this.stopTimer]) clearTimeout(t);
    clearInterval(this.limitsTick);
    if (this.inflight) clearTimeout(this.inflight.timer);
    if (this.watcher) this.watcher.close();
    for (const c of [this.child, this.stopping]) {
      if (!c) continue;
      try {
        c.kill();
      } catch {
        /* already gone */
      }
    }
    this._resolveWaiters();
  }

  /** The last real snapshot, or null. Never example data outside --mock. */
  getSnapshot() {
    return this.snapshot;
  }

  /**
   * What getSnapshot() should answer: { snapshot } when there is one, { error }
   * when there is none and the engine failed, {} while the first scan runs.
   */
  getState() {
    if (this.snapshot) return { snapshot: this.snapshot, example: this.example };
    if (this.lastError) return { error: this.lastError };
    return {};
  }

  get isExample() {
    return this.example;
  }

  /** True while a worker process exists (awake). */
  get awake() {
    return !!this.child;
  }

  setPanelOpen(open) {
    this.panelOpen = open;
    if (this.mock) return;
    clearInterval(this.limitsTick);
    this.limitsTick = null;
    if (open) {
      clearTimeout(this.idleTimer);
      this._patchLimits('open');
      if (this.readLimits) this.limitsTick = setInterval(() => this._patchLimits('open-tick'), this.t.limitsOpenInterval);
      if (!this.inflight && Date.now() - this.snapshotAt > this.t.staleOnOpen) this.request({ reason: 'open' });
      else this._schedulePeriodic();
    } else {
      this._schedulePeriodic();
      this._armIdle(this.t.idleAfterClose);
    }
  }

  /**
   * The pointer is over the tray icon: a click is likely. Start the open-time refresh now,
   * so the panel opens on current numbers. Cheap to call on every mouse-move.
   */
  prewarm() {
    if (this.mock || this.stopped || this.panelOpen || this.inflight) return;
    const now = Date.now();
    if (now - this.lastPrewarmAt < this.t.prewarmThrottle) return;
    if (now - this.snapshotAt <= this.t.prewarmStale) return;
    this.lastPrewarmAt = now;
    this.request({ reason: 'hover' });
  }

  /** Ask for a snapshot. Resolves when that request (or the one covering it) finishes. */
  request({ force = false, reason = 'manual' } = {}) {
    if (this.mock || this.stopped) return Promise.resolve();
    const done = new Promise((resolve) => this.waiters.push(resolve));
    clearTimeout(this.idleTimer);
    // A person asked (Try again, Refresh now): do not sit out a restart backoff.
    if (!this.child && this.restartTimer && ['ui', 'menu', 'cost-basis'].includes(reason)) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
      this.failures = 0;
      this._spawn();
    }
    if (this.inflight) {
      this.pending = { force: force || (this.pending && this.pending.force) || false, reason };
      return done;
    }
    this._send(force, reason);
    return done;
  }

  /**
   * Switch the cost basis: the worker is re-initialised with it (after the scan
   * in flight, if any) and asked for a fresh snapshot. Resolves when that lands.
   */
  setCostBasis(basis) {
    if (!COST_BASES.includes(basis)) return Promise.reject(new TypeError(`unknown cost basis: ${basis}`));
    if (basis === this.costBasis) return Promise.resolve();
    this.costBasis = basis;
    log.info('cost basis', basis);
    if (this.mock) return Promise.resolve();
    if (this.inflight) this.reinitPending = true;
    else this._postInit();
    return this.request({ force: true, reason: 'cost-basis' });
  }

  // ---- internals -------------------------------------------------------

  _initMessage() {
    return { type: 'init', stateDir: this.stateDir, rangeDays: RANGE_DAYS, costBasis: this.costBasis, persistEveryMs: PERSIST_EVERY_MS };
  }

  _postInit() {
    if (!this.child || !this.childReady) return; // the next spawn sends it
    try {
      this.child.postMessage(this._initMessage());
    } catch (err) {
      log.warn('could not re-init the worker', err.message);
    }
  }

  _spawn() {
    if (this.stopped || this.child) return;
    if (!fs.existsSync(this.workerPath)) {
      this._fail(`The data engine is missing (${path.relative(this.appDir, this.workerPath) || this.workerPath})`, { respawn: false });
      clearTimeout(this.restartTimer);
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        this._spawn();
        if (this.child && !this.inflight) this.request({ reason: 'restart' });
      }, MISSING_RECHECK_MS);
      return;
    }
    let child;
    try {
      child = this.fork(this.workerPath, [], {
        serviceName: 'Agent Meter data engine',
        stdio: 'pipe',
        cwd: this.appDir,
      });
    } catch (err) {
      this._fail(`The data engine could not start: ${err.message}`);
      return;
    }
    this.child = child;
    this.childReady = false;
    this.stats.spawned += 1;
    const pipe = (stream, level) => {
      if (!stream) return;
      let buf = '';
      stream.on('data', (d) => {
        buf += d.toString();
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trimEnd();
          buf = buf.slice(i + 1);
          if (line) log[level]('worker:', line.slice(0, 2000));
        }
      });
    };
    pipe(child.stdout, 'info');
    pipe(child.stderr, 'warn');
    child.on('spawn', () => {
      if (child !== this.child) return;
      try {
        os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
      } catch (err) {
        log.warn('could not lower worker priority', err.message);
      }
      log.info('worker started, pid', child.pid, { stateDir: this.stateDir, costBasis: this.costBasis });
      child.postMessage(this._initMessage());
      this.childReady = true;
      if (this.inflight && !this.inflight.sent) this._post(this.inflight);
    });
    child.on('message', (msg) => {
      if (child === this.child) this._onMessage(msg);
    });
    child.on('exit', (code) => {
      if (child === this.stopping) {
        this._onSlept(child, code);
        return;
      }
      if (child !== this.child) return;
      this.child = null;
      this.childReady = false;
      if (this.stopped) return;
      log.warn('worker exited with code', code);
      this._fail(`The data engine stopped unexpectedly (exit code ${code})`);
    });
  }

  // ---- sleep: give the worker's memory back while the panel is closed ----

  _armIdle(ms) {
    clearTimeout(this.idleTimer);
    if (this.stopped || this.mock || this.panelOpen) return;
    this.idleTimer = setTimeout(() => this._sleep(), ms);
  }

  _sleep() {
    const child = this.child;
    if (!child || this.stopped || this.panelOpen || this.inflight || this.pending || this.stopping) return;
    this.stopping = child;
    this.child = null;
    this.childReady = false;
    this.stats.slept += 1;
    log.info('worker idle: asking it to exit', { pid: child.pid });
    try {
      child.postMessage({ type: 'shutdown' });
    } catch {
      /* gone already: the exit handler (or the timer) finishes this */
    }
    clearTimeout(this.stopTimer);
    this.stopTimer = setTimeout(() => {
      if (this.stopping !== child) return;
      log.warn('worker did not exit after shutdown; killing it');
      try {
        child.kill();
      } catch {
        this._onSlept(child, null);
      }
    }, this.t.shutdownGrace);
  }

  _onSlept(child, code) {
    if (this.stopping !== child) return;
    clearTimeout(this.stopTimer);
    this.stopping = null;
    log.info('worker asleep', { code });
    // A request that came in while it was shutting down gets a fresh worker now.
    if (!this.stopped && this.inflight && !this.inflight.sent) this._spawn();
  }

  _send(force, reason) {
    const id = `r${++this.seq}`;
    const req = { id, force, reason, startedAt: Date.now(), sent: false, timer: null };
    this._arm(req, this.snapshot && !this.example ? LATER_TIMEOUT_MS : FIRST_TIMEOUT_MS);
    this.inflight = req;
    this.lastRequestAt = req.startedAt;
    clearTimeout(this.periodicTimer);
    if (this.child && this.childReady) this._post(req);
    else if (!this.child && !this.restartTimer && !this.stopping) this._spawn();
    // otherwise: spawning (posted on 'spawn'), restarting (backoff) or going to sleep (respawned on exit)
    log.info('snapshot requested', { id, force, reason });
  }

  _arm(req, ms) {
    clearTimeout(req.timer);
    req.timer = setTimeout(() => this._onTimeout(req, ms), ms);
  }

  _post(req) {
    try {
      this.child.postMessage({ type: 'snapshot', requestId: req.id, force: req.force || undefined });
      req.sent = true;
    } catch (err) {
      this._fail(`The data engine could not be reached: ${err.message}`);
    }
  }

  _onMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    const req = this.inflight;
    if (msg.type === 'progress') {
      if (req && msg.requestId === req.id) {
        this._arm(req, STALL_TIMEOUT_MS); // alive and working: only a stall times out now
        this.emit('progress', {
          phase: String(msg.phase || ''),
          filesDone: Number(msg.filesDone) || 0,
          filesTotal: Number(msg.filesTotal) || 0,
        });
      }
      return;
    }
    if (msg.type === 'snapshot') {
      if (!looksLikeSnapshot(msg.snapshot)) {
        this._finish(msg.requestId, 'The data engine sent data in an unexpected shape');
        return;
      }
      this.failures = 0;
      this.lastError = null;
      log.info('snapshot received', { id: msg.requestId, ms: req ? Date.now() - req.startedAt : null });
      const fresh = this._freshLimits();
      const snap = fresh ? withClaudeLimits(msg.snapshot, fresh) : msg.snapshot;
      this.limitsKey = fresh ? JSON.stringify(fresh) : null;
      this.snapshotAt = Date.now();
      this._publish(snap, { example: false });
      this._finish(msg.requestId, null);
      return;
    }
    if (msg.type === 'error') {
      log.warn('worker error', msg.message);
      // An init failure has no requestId: it fails whatever is in flight.
      this._finish(msg.requestId == null && req ? req.id : msg.requestId, String(msg.message || 'The data engine failed'));
    }
  }

  _onTimeout(req, ms) {
    if (this.inflight !== req) return;
    log.warn('snapshot timed out', req.id);
    if (this.child) {
      try {
        this.child.kill(); // the exit handler restarts it
      } catch {
        /* ignore */
      }
    }
    this._finish(req.id, `The data engine did not answer in ${Math.round(ms / 1000)} s`);
  }

  /** Close the in-flight request (success when error is null). */
  _finish(requestId, error) {
    const req = this.inflight;
    if (req && requestId && requestId !== req.id) return; // a stale answer
    if (req) clearTimeout(req.timer);
    this.inflight = null;
    if (error) this._degrade(error);
    this._resolveWaiters();
    if (this.reinitPending) {
      this.reinitPending = false;
      this._postInit();
    }
    if (this.pending && !this.stopped) {
      const { force, reason } = this.pending;
      this.pending = null;
      this._send(force, reason);
      return;
    }
    this._schedulePeriodic();
    if (!this.panelOpen) this._armIdle(req && req.reason === 'hidden-tick' ? this.t.idleAfterTick : this.t.idleAfterClose);
  }

  _fail(error, { respawn = true } = {}) {
    const req = this.inflight;
    if (req) {
      clearTimeout(req.timer);
      this.inflight = null;
    }
    this._degrade(error);
    this._resolveWaiters();
    if (respawn && !this.stopped) {
      this.failures += 1;
      const delay = Math.min(60_000, 1000 * 2 ** Math.min(6, this.failures - 1));
      clearTimeout(this.restartTimer);
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        this._spawn();
        if (!this.inflight) this.request({ reason: 'restart' });
      }, delay);
      log.info('worker restart in', delay, 'ms');
    }
  }

  /** A failure never invents data: keep the last real snapshot (if any) and report the error. */
  _degrade(error) {
    log.warn('degraded:', error, this.snapshot ? '(keeping the last snapshot)' : '(no snapshot yet)');
    this.lastError = error;
    this.emit('engine-error', { message: error }); // not 'error': an EventEmitter 'error' with no listener throws
  }

  _loadExample() {
    try {
      const file = path.join(this.appDir, 'src', 'shared', 'mock-snapshot.json');
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      log.error('example snapshot unreadable', err.message);
      return null;
    }
  }

  _publish(snapshot, { example }) {
    this.snapshot = snapshot;
    this.example = example;
    if (example) this.snapshotAt = 0;
    this.emit('snapshot', snapshot, { example });
  }

  _resolveWaiters() {
    const w = this.waiters;
    this.waiters = [];
    for (const resolve of w) resolve();
  }

  _schedulePeriodic() {
    clearTimeout(this.periodicTimer);
    if (this.stopped || this.mock) return;
    const interval = this.panelOpen ? this.t.openInterval : this.t.hiddenInterval;
    // measured from the last REQUEST, so a worker that keeps answering with an
    // error is asked again at the normal cadence, not in a tight loop
    const since = Date.now() - (this.lastRequestAt || 0);
    const wait = Math.max(1000, interval - Math.min(since, interval));
    this.periodicTimer = setTimeout(() => this.request({ reason: this.panelOpen ? 'open-tick' : 'hidden-tick' }), wait);
  }

  // ---- limits, read here ----------------------------------------------------

  _freshLimits() {
    if (!this.readLimits) return null;
    try {
      return markActive(this.readLimits() || null, this.activeAccount());
    } catch (err) {
      log.warn('limits read failed', err.message);
      return null;
    }
  }

  /** Re-read the limits and, if they changed, publish the last snapshot with them swapped in. */
  _patchLimits(reason) {
    if (this.mock || this.example || !this.snapshot) return false;
    const fresh = this._freshLimits();
    if (!fresh) return false;
    const key = JSON.stringify(fresh);
    if (key === this.limitsKey) return false;
    this.limitsKey = key;
    this.stats.limitPatches += 1;
    log.info('limits updated', { reason });
    this._publish(withClaudeLimits(this.snapshot, fresh), { example: false });
    return true;
  }

  /** The Claude app moved to another account: republish with the new activeId, now. */
  refreshActive() {
    return this._patchLimits('account');
  }

  /** The Usage Monitor replaces its cache file on every poll: watch its folder, not the file. */
  _watchUsageCache() {
    const dir = usageCacheDir();
    const retry = () => setTimeout(() => !this.stopped && this._watchUsageCache(), HIDDEN_INTERVAL_MS).unref?.();
    try {
      this.watcher = fs.watch(dir, { persistent: false }, (_event, filename) => {
        const f = filename ? String(filename).toLowerCase() : '';
        if (f && f !== 'usage-cache.json' && f !== 'settings.json') return;
        clearTimeout(this.limitsTimer);
        this.limitsTimer = setTimeout(() => this._patchLimits('usage-cache'), LIMITS_DEBOUNCE_MS);
      });
      this.watcher.on('error', (err) => {
        log.warn('usage-cache watch failed', err.message);
        this.watcher = null;
        retry();
      });
      log.info('watching', path.join(dir, 'usage-cache.json'));
    } catch (err) {
      log.warn('cannot watch usage cache yet', err.message);
      retry();
    }
  }
}

module.exports = { WorkerHost, usageCacheDir, looksLikeSnapshot, withClaudeLimits, COST_BASES, DEFAULT_COST_BASIS };
