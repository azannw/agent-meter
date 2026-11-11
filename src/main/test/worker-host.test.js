'use strict';
// WorkerHost against a fake utilityProcess: no example data outside --mock,
// error reporting, relay, restart, coalescing, cost basis, the idle sleep,
// limits read by the shell, the open cadence and the hover prewarm.
const test = require('node:test');
const { afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { WorkerHost, withClaudeLimits } = require('../worker-host');

const realMock = path.join(__dirname, '..', '..', 'shared', 'mock-snapshot.json');

function fakeApp({ withWorker }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-wh-'));
  fs.mkdirSync(path.join(dir, 'src', 'shared'), { recursive: true });
  fs.copyFileSync(realMock, path.join(dir, 'src', 'shared', 'mock-snapshot.json'));
  if (withWorker) {
    fs.mkdirSync(path.join(dir, 'src', 'data'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'data', 'worker.js'), '// fake');
  }
  return dir;
}

// behaviour(child, msg, childCount) answers 'snapshot' requests. A child answers
// 'shutdown' by exiting 0 unless opts.ignoreShutdown.
function fakeFork(behaviour, opts = {}) {
  const children = [];
  const fork = () => {
    const child = new EventEmitter();
    child.pid = process.pid; // setPriority on ourselves is harmless
    child.sent = [];
    child.exited = false;
    const exit = (code) => {
      if (child.exited) return;
      child.exited = true;
      child.emit('exit', code);
    };
    child.postMessage = (m) => {
      if (child.exited) throw new Error('posted to an exited child');
      child.sent.push(m);
      if (m.type === 'snapshot') setImmediate(() => behaviour(child, m, children.length));
      if (m.type === 'shutdown' && !opts.ignoreShutdown) setTimeout(() => exit(0), opts.shutdownMs || 5);
    };
    child.kill = () => setImmediate(() => exit(1));
    children.push(child);
    setImmediate(() => child.emit('spawn'));
    return child;
  };
  return { fork, children };
}

const goodSnapshot = () => ({ ...JSON.parse(fs.readFileSync(realMock, 'utf8')), warnings: [], generatedAt: new Date().toISOString() });
const answer = (child, m) => child.emit('message', { type: 'snapshot', requestId: m.requestId, snapshot: goodSnapshot() });
const nextEvent = (em, name) => new Promise((r) => em.once(name, (...a) => r(a)));
const never = (em, name, ms) =>
  new Promise((resolve, reject) => {
    const f = () => reject(new Error(`unexpected ${name}`));
    em.once(name, f);
    setTimeout(() => {
      em.off(name, f);
      resolve();
    }, ms);
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 2000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await sleep(5);
  }
};
const snapshotsSent = (child) => child.sent.filter((m) => m.type === 'snapshot').length;
// Hermetic hosts: no reads of the real Usage Monitor cache unless a test passes readLimits.
// Every host is stopped after its test, also when an assertion failed half way: a live host
// keeps its timers, and a leftover 5-minute tick would keep the test process alive.
const live = new Set();
const host = (o) => {
  const h = new WorkerHost({ readLimits: null, watchLimits: false, ...o });
  live.add(h);
  return h;
};
afterEach(() => {
  for (const h of live) h.stop();
  live.clear();
});

test('missing worker.js: no data published, an error instead, getState carries it', async () => {
  const h = host({ appDir: fakeApp({ withWorker: false }), stateDir: os.tmpdir(), fork: () => assert.fail('must not fork') });
  const err = nextEvent(h, 'engine-error');
  const noSnap = never(h, 'snapshot', 100);
  h.start();
  const [e] = await err;
  await noSnap;
  assert.match(e.message, /missing/);
  assert.equal(h.getSnapshot(), null);
  assert.deepEqual(h.getState(), { error: e.message });
  h.stop();
});

test('init carries stateDir, rangeDays, the cost basis (default per-reply) and batched writes; progress and snapshot relayed', async () => {
  const { fork, children } = fakeFork((child, m) => {
    child.emit('message', { type: 'progress', requestId: m.requestId, phase: 'scanning', filesDone: 3, filesTotal: 9 });
    answer(child, m);
  });
  const h = host({ appDir: fakeApp({ withWorker: true }), stateDir: 'C:\\state', fork });
  const progress = nextEvent(h, 'progress');
  const snapEv = nextEvent(h, 'snapshot');
  h.start();
  assert.deepEqual((await progress)[0], { phase: 'scanning', filesDone: 3, filesTotal: 9 });
  const [snap, meta] = await snapEv;
  assert.equal(meta.example, false);
  assert.deepEqual(snap.warnings, []);
  assert.deepEqual(children[0].sent[0], { type: 'init', stateDir: 'C:\\state', rangeDays: 30, costBasis: 'per-reply', persistEveryMs: 60000 });
  assert.equal(children[0].sent[1].type, 'snapshot');
  assert.equal(h.getState().snapshot, snap);
  h.stop();
});

test('worker error before any snapshot: error event, nothing published; refresh() still resolves', async () => {
  const { fork } = fakeFork((child, m) => child.emit('message', { type: 'error', requestId: m.requestId, message: 'boom' }));
  const h = host({ appDir: fakeApp({ withWorker: true }), stateDir: os.tmpdir(), fork });
  const err = nextEvent(h, 'engine-error');
  const noSnap = never(h, 'snapshot', 150);
  h.start();
  assert.equal((await err)[0].message, 'boom');
  await noSnap;
  assert.equal(h.getSnapshot(), null);
  await h.request({ force: true, reason: 'test' });
  h.stop();
});

test('a crashed worker is restarted and asked again; the error is cleared by the real snapshot', async () => {
  let calls = 0;
  const { fork, children } = fakeFork((child, m) => {
    calls += 1;
    if (calls === 1) child.emit('exit', 3); // crash on the first request
    else answer(child, m);
  });
  const h = host({ appDir: fakeApp({ withWorker: true }), stateDir: os.tmpdir(), fork });
  const err = nextEvent(h, 'engine-error');
  const real = nextEvent(h, 'snapshot');
  h.start();
  assert.match((await err)[0].message, /exit code 3/);
  await real; // after the 1 s backoff
  assert.equal(children.length, 2);
  assert.equal(children[1].sent[0].type, 'init');
  assert.equal(h.getState().error, undefined);
  h.stop();
});

test('after a real snapshot, a failure keeps it untouched and emits an error', async () => {
  let calls = 0;
  const { fork } = fakeFork((child, m) => {
    calls += 1;
    if (calls === 1) answer(child, m);
    else child.emit('message', { type: 'error', requestId: m.requestId, message: 'disk on fire' });
  });
  const h = host({ appDir: fakeApp({ withWorker: true }), stateDir: os.tmpdir(), fork });
  h.start();
  const [first] = await nextEvent(h, 'snapshot');
  const err = nextEvent(h, 'engine-error');
  const noSnap = never(h, 'snapshot', 150);
  h.request({ force: true });
  assert.equal((await err)[0].message, 'disk on fire');
  await noSnap;
  assert.equal(h.getSnapshot(), first);
  assert.deepEqual(first.warnings, []);
  assert.equal(h.getState().snapshot, first);
  h.stop();
});

test('requests while one is in flight are coalesced into one more', async () => {
  const { fork, children } = fakeFork((child, m) => setTimeout(() => answer(child, m), 30));
  const h = host({ appDir: fakeApp({ withWorker: true }), stateDir: os.tmpdir(), fork });
  h.start();
  await Promise.all([h.request({ reason: 'a' }), h.request({ force: true, reason: 'b' })]);
  await sleep(80);
  const reqs = children[0].sent.filter((m) => m.type === 'snapshot');
  assert.equal(reqs.length, 2, JSON.stringify(reqs));
  assert.equal(reqs[1].force, true);
  h.stop();
});

test('setCostBasis re-inits the worker (after the scan in flight) and forces a snapshot', async () => {
  const { fork, children } = fakeFork((child, m) => setTimeout(() => answer(child, m), 30));
  const h = host({ appDir: fakeApp({ withWorker: true }), stateDir: os.tmpdir(), fork });
  h.start(); // the start request is in flight
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  await h.setCostBasis('claude-app');
  const sent = children[0].sent.map((m) => (m.type === 'init' ? `init:${m.costBasis}` : `snapshot:${m.force ? 'force' : 'plain'}`));
  assert.deepEqual(sent, ['init:per-reply', 'snapshot:plain', 'init:claude-app', 'snapshot:force']);
  await assert.rejects(h.setCostBasis('bogus'), TypeError);
  h.stop();
});

test('mock mode publishes the example, flagged as example', async () => {
  const h = host({ appDir: fakeApp({ withWorker: false }), stateDir: os.tmpdir(), fork: () => assert.fail('no fork in mock'), mock: true });
  const ev = nextEvent(h, 'snapshot');
  h.start();
  const [snap, meta] = await ev;
  assert.equal(meta.example, true);
  assert.ok(snap.providers.length > 0);
  h.stop();
});

// ---- idle sleep -------------------------------------------------------------

test('closed and idle: the worker is asked to exit, its exit is not a failure, the next request starts a fresh one', async () => {
  const { fork, children } = fakeFork(answer);
  const h = host({ appDir: fakeApp({ withWorker: true }), stateDir: os.tmpdir(), fork, timing: { idleAfterClose: 30 } });
  const noErr = never(h, 'engine-error', 400);
  h.start();
  await nextEvent(h, 'snapshot');
  await waitFor(() => children[0].exited);
  assert.deepEqual(children[0].sent.at(-1), { type: 'shutdown' });
  assert.equal(h.awake, false);
  assert.equal(h.stats.slept, 1);
  const snap = nextEvent(h, 'snapshot');
  await h.request({ reason: 'later' });
  await snap;
  assert.equal(children.length, 2, 'a fresh worker answered');
  assert.equal(children[1].sent[0].type, 'init');
  await noErr;
  h.stop();
});

test('an open panel keeps the worker awake; closing it starts the idle clock', async () => {
  const { fork, children } = fakeFork(answer);
  const h = host({ appDir: fakeApp({ withWorker: true }), stateDir: os.tmpdir(), fork, timing: { idleAfterClose: 40, openInterval: 60_000 } });
  h.start();
  await nextEvent(h, 'snapshot');
  h.setPanelOpen(true);
  await sleep(150);
  assert.equal(children[0].exited, false, 'stays up while open');
  h.setPanelOpen(false);
  await waitFor(() => children[0].exited);
  assert.ok(children[0].sent.some((m) => m.type === 'shutdown'));
  h.stop();
});

test('a request that arrives while the worker is shutting down waits for its exit, then gets a fresh worker', async () => {
  const { fork, children } = fakeFork(answer, { shutdownMs: 80 });
  const h = host({ appDir: fakeApp({ withWorker: true }), stateDir: os.tmpdir(), fork, timing: { idleAfterClose: 10 } });
  h.start();
  await nextEvent(h, 'snapshot');
  await waitFor(() => children[0].sent.some((m) => m.type === 'shutdown'));
  const done = h.request({ reason: 'during-shutdown' });
  await sleep(20);
  assert.equal(children.length, 1, 'no second worker while the first is still exiting');
  assert.equal(snapshotsSent(children[0]), 1, 'nothing posted to the exiting worker');
  await done;
  assert.equal(children.length, 2);
  assert.equal(snapshotsSent(children[1]), 1);
  h.stop();
});

test('a worker that ignores shutdown is killed after the grace period, still without an error', async () => {
  const { fork, children } = fakeFork(answer, { ignoreShutdown: true });
  const h = host({ appDir: fakeApp({ withWorker: true }), stateDir: os.tmpdir(), fork, timing: { idleAfterClose: 10, shutdownGrace: 40 } });
  const noErr = never(h, 'engine-error', 300);
  h.start();
  await nextEvent(h, 'snapshot');
  await waitFor(() => children[0].exited, 1000);
  await noErr;
  assert.equal(h.stopping, null);
  h.stop();
});

// ---- cadence and prewarm ----------------------------------------------------

test('while open, snapshots repeat at the open interval; when closed they stop', async () => {
  const { fork, children } = fakeFork(answer);
  const h = host({ appDir: fakeApp({ withWorker: true }), stateDir: os.tmpdir(), fork, timing: { openInterval: 40, idleAfterClose: 60_000 } });
  h.start();
  await nextEvent(h, 'snapshot');
  h.setPanelOpen(true);
  await sleep(1200); // at least 1 s apart (the floor), so 2 or 3 ticks
  const whileOpen = snapshotsSent(children[0]);
  assert.ok(whileOpen >= 2, `open ticks: ${whileOpen}`);
  h.setPanelOpen(false);
  await sleep(1200);
  assert.ok(snapshotsSent(children[0]) <= whileOpen + 1, 'no open-rate ticks after close');
  h.stop();
});

test('opening asks for a refresh only when the last snapshot is older than the open threshold', async () => {
  const { fork, children } = fakeFork(answer);
  const h = host({ appDir: fakeApp({ withWorker: true }), stateDir: os.tmpdir(), fork, timing: { staleOnOpen: 100, openInterval: 60_000, idleAfterClose: 60_000 } });
  h.start();
  await nextEvent(h, 'snapshot');
  h.setPanelOpen(true);
  await sleep(20);
  assert.equal(snapshotsSent(children[0]), 1, 'fresh: no refresh on open');
  h.setPanelOpen(false);
  await sleep(150);
  const ev = nextEvent(h, 'snapshot');
  h.setPanelOpen(true);
  await ev;
  assert.equal(snapshotsSent(children[0]), 2, 'stale: refreshed on open');
  h.stop();
});

test('hover prewarm: refreshes a stale snapshot once, throttled, never while open or in flight', async () => {
  const { fork, children } = fakeFork((child, m) => setTimeout(() => answer(child, m), 20));
  const h = host({ appDir: fakeApp({ withWorker: true }), stateDir: os.tmpdir(), fork, timing: { prewarmStale: 0, prewarmThrottle: 200, idleAfterClose: 60_000 } });
  h.start();
  await nextEvent(h, 'snapshot');
  await sleep(5);
  h.prewarm();
  h.prewarm(); // in flight: ignored
  await nextEvent(h, 'snapshot');
  h.prewarm(); // throttled
  await sleep(40);
  assert.equal(snapshotsSent(children[0]), 2);
  h.setPanelOpen(true);
  await sleep(250);
  const before = snapshotsSent(children[0]);
  h.prewarm(); // open: the open cadence owns refreshes
  await sleep(40);
  assert.equal(snapshotsSent(children[0]), before);
  h.stop();
});

// ---- limits read by the shell -------------------------------------------------

const block = (pct) => ({
  updatedAt: new Date().toISOString(),
  source: 'Claude Code Usage Monitor',
  accounts: [{ id: 'default', name: 'a@example.com', kind: 'claude-app', status: 'ok', error: null, windows: [{ key: 'weekly', label: 'Weekly', usedPct: pct, resetsAt: null, windowMinutes: 10080, pace: { expectedPct: 0, deltaPct: 0, state: 'on-pace', runsOutAt: null, lastsUntilReset: true } }] }],
  warnings: [],
});
const claudeOf = (s) => s.providers.find((p) => p.id === 'claude');

test('worker snapshots carry the freshest limits; a limits change republishes without asking the worker', async () => {
  let current = block(10);
  const { fork, children } = fakeFork(answer);
  const h = host({ appDir: fakeApp({ withWorker: true }), stateDir: os.tmpdir(), fork, readLimits: () => current, timing: { openInterval: 60_000, idleAfterClose: 60_000, staleOnOpen: 60_000 } });
  h.start();
  const [first] = await nextEvent(h, 'snapshot');
  assert.equal(claudeOf(first).limits.accounts[0].windows[0].usedPct, 10);
  current = block(55);
  const ev = nextEvent(h, 'snapshot');
  assert.equal(h._patchLimits('test'), true);
  const [patched] = await ev;
  assert.equal(claudeOf(patched).limits.accounts[0].windows[0].usedPct, 55);
  assert.equal(patched.overview, first.overview, 'spend is the same object, not a copy');
  assert.equal(snapshotsSent(children[0]), 1, 'the worker was not asked');
  assert.equal(h._patchLimits('same again'), false, 'unchanged limits publish nothing');
  h.stop();
});

test('a limits read that throws keeps the last limits and never fails the snapshot', async () => {
  const { fork } = fakeFork(answer);
  const h = host({ appDir: fakeApp({ withWorker: true }), stateDir: os.tmpdir(), fork, readLimits: () => { throw new Error('locked'); } });
  h.start();
  const [snap] = await nextEvent(h, 'snapshot');
  assert.ok(Array.isArray(claudeOf(snap).limits.accounts), 'the worker’s own limits stay');
  assert.equal(h._patchLimits('test'), false);
  h.stop();
});

test('withClaudeLimits swaps only the Claude limits block', () => {
  const s = goodSnapshot();
  const b = block(77);
  const out = withClaudeLimits(s, b);
  assert.notEqual(out, s);
  assert.equal(claudeOf(out).limits, b);
  assert.equal(out.overview, s.overview);
  assert.equal(out.providers.find((p) => p.id === 'codex'), s.providers.find((p) => p.id === 'codex'));
  assert.equal(claudeOf(s).limits === b, false, 'the input is untouched');
});

test('hover prewarm leaves a fresh snapshot alone', async () => {
  const { fork, children } = fakeFork(answer);
  const h = host({ appDir: fakeApp({ withWorker: true }), stateDir: os.tmpdir(), fork, timing: { prewarmStale: 5_000, prewarmThrottle: 0, idleAfterClose: 60_000 } });
  h.start();
  await nextEvent(h, 'snapshot');
  h.prewarm(); // the snapshot is milliseconds old
  await sleep(40);
  assert.equal(snapshotsSent(children[0]), 1, 'no refresh for a fresh snapshot');
});
