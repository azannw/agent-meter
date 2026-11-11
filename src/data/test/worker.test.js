'use strict';
process.env.TZ = 'Asia/Karachi';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { fork } = require('node:child_process');
const { validateSnapshot } = require('./schema');
const { mkTmp, rmrf, claudeLine, writeLines } = require('./helpers');

const WORKER = path.join(__dirname, '..', 'worker.js');
const NOW = Date.parse('2026-10-02T12:00:00.000Z');

function start() {
  const child = fork(WORKER, [], { env: { ...process.env, TZ: 'Asia/Karachi' }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const messages = [];
  const waiters = [];
  child.on('message', (m) => {
    messages.push(m);
    for (const w of [...waiters]) if (w.pred(m)) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(m);
    }
  });
  const waitFor = (pred, ms = 10000) =>
    new Promise((resolve, reject) => {
      const hit = messages.find(pred);
      if (hit) return resolve(hit);
      const w = { pred, resolve };
      waiters.push(w);
      setTimeout(() => reject(new Error('timeout waiting for worker message')), ms).unref();
    });
  return { child, messages, waitFor };
}

test('worker (child_process.fork): init, snapshot, progress, coalesced duplicates, errors', async () => {
  const root = mkTmp('worker');
  const w = start();
  try {
    // a snapshot before init is an error, not a crash
    w.child.send({ type: 'snapshot', requestId: 'early' });
    const early = await w.waitFor((m) => m.requestId === 'early');
    assert.equal(early.type, 'error');
    assert.match(early.message, /not initialised/);

    const home = path.join(root, 'home');
    const proj = path.join(home, '.claude', 'projects', 'p');
    for (let i = 0; i < 5; i++) {
      writeLines(path.join(proj, `s${i}.jsonl`), [claudeLine({ id: 'm' + i, req: 'r' + i, session: 's' + i, input: 1, output: 10, ts: '2026-10-02T08:00:00Z' })]);
    }
    w.child.send({
      type: 'init',
      stateDir: path.join(root, 'state'),
      rangeDays: 30,
      // test-only extras: fixture folders, fixed clock, no network
      home,
      appData: path.join(root, 'appdata'),
      now: NOW,
      allowNetwork: false,
    });
    // three requests at once: one scan runs, the two that arrive while it runs share the next one
    w.child.send({ type: 'snapshot', requestId: 'a' });
    w.child.send({ type: 'snapshot', requestId: 'b' });
    w.child.send({ type: 'snapshot', requestId: 'b' }); // exact duplicate id: answered once
    w.child.send({ type: 'snapshot', requestId: 'c', force: true });
    const [a, b, c] = await Promise.all(['a', 'b', 'c'].map((id) => w.waitFor((m) => m.type === 'snapshot' && m.requestId === id)));
    for (const r of [a, b, c]) {
      assert.deepEqual(validateSnapshot(r.snapshot, { requireLifetime: true, requireHeadline: true }), []);
      assert.equal(r.snapshot.providers[0].spend.d30Tokens, 55);
      assert.equal(r.snapshot.providers[0].spend.sessions30d, 5);
    }
    assert.equal(w.messages.filter((m) => m.type === 'snapshot' && m.requestId === 'b').length, 1);
    const progress = w.messages.filter((m) => m.type === 'progress' && m.requestId === 'a');
    assert.ok(progress.length >= 2, 'progress was reported');
    const scanning = progress.filter((p) => p.phase === 'scanning');
    assert.ok(scanning.some((p) => p.filesTotal === 5 && p.filesDone === 5));
    assert.ok(progress.some((p) => p.phase === 'pricing'));
    for (const p of progress) assert.deepEqual(Object.keys(p).sort(), ['filesDone', 'filesTotal', 'phase', 'requestId', 'type']);
  } finally {
    w.child.kill();
    rmrf(root);
  }
});

test('worker: init without costBasis means per-reply; a re-init that only changes it switches without a rescan', async () => {
  const root = mkTmp('worker');
  const w = start();
  try {
    const home = path.join(root, 'home');
    const proj = path.join(home, '.claude', 'projects', 'p');
    // one reply written as 2 content-block lines: app style counts it twice
    const line = claudeLine({ id: 'm', req: 'r', session: 's', input: 1000, output: 1000, ts: '2026-10-02T08:00:00Z' });
    writeLines(path.join(proj, 's.jsonl'), [line, line]);
    const init = { type: 'init', stateDir: path.join(root, 'state'), rangeDays: 30, home, appData: path.join(root, 'appdata'), now: NOW, allowNetwork: false };
    w.child.send(init);
    w.child.send({ type: 'snapshot', requestId: 'default' });
    const d = (await w.waitFor((m) => m.type === 'snapshot' && m.requestId === 'default')).snapshot;
    assert.equal(d.overview.headline.basis, 'per-reply');
    assert.equal(d.overview.headline.tokens, 4000);
    assert.equal(d.overview.headline.costUSD, (1000 * 4 + 1000 * 20) / 1e6);

    w.child.send({ ...init, costBasis: 'claude-app' });
    w.child.send({ type: 'snapshot', requestId: 'app' });
    const a = (await w.waitFor((m) => m.type === 'snapshot' && m.requestId === 'app')).snapshot;
    assert.equal(a.overview.headline.basis, 'claude-app');
    assert.equal(a.overview.headline.tokens, 4000);
    assert.equal(a.overview.headline.costUSD, (2 * (1000 * 4 + 1000 * 20)) / 1e6);
    const scanning = w.messages.filter((m) => m.type === 'progress' && m.requestId === 'app' && m.phase === 'scanning');
    assert.ok(scanning.every((p) => p.filesTotal === 0), 'same collector: nothing re-read');
  } finally {
    w.child.kill();
    rmrf(root);
  }
});

test('worker: shutdown writes the batched index and ledger, exits 0, and a new worker resumes without re-reading', async () => {
  const fs = require('node:fs');
  const root = mkTmp('worker');
  const w = start();
  try {
    const home = path.join(root, 'home');
    const state = path.join(root, 'state');
    const proj = path.join(home, '.claude', 'projects', 'p');
    const file = path.join(proj, 's.jsonl');
    writeLines(file, [claudeLine({ id: 'm1', req: 'r1', session: 's', input: 5, output: 5, ts: '2026-10-02T08:00:00Z' })]);
    const init = { type: 'init', stateDir: state, rangeDays: 30, home, appData: path.join(root, 'appdata'), now: NOW, allowNetwork: false, persistEveryMs: 3600000 };
    w.child.send(init);
    w.child.send({ type: 'snapshot', requestId: 'one' });
    await w.waitFor((m) => m.type === 'snapshot' && m.requestId === 'one');
    const indexFile = path.join(state, 'scan-index-claude.json');
    const before = fs.readFileSync(indexFile, 'utf8');
    // a second message lands inside the hour: held in memory
    writeLines(file, [claudeLine({ id: 'm2', req: 'r2', session: 's', input: 7, output: 7, ts: '2026-10-02T08:01:00Z' })], { append: true });
    w.child.send({ type: 'snapshot', requestId: 'two', force: true }); // force: inside REUSE_MS a plain request is answered from the last scan
    const two = (await w.waitFor((m) => m.type === 'snapshot' && m.requestId === 'two')).snapshot;
    assert.equal(two.providers[0].spend.d30Tokens, 24);
    assert.equal(fs.readFileSync(indexFile, 'utf8'), before, 'not yet written');

    const exited = new Promise((resolve) => w.child.once('exit', (code) => resolve(code)));
    w.child.send({ type: 'shutdown' });
    assert.equal(await exited, 0);
    assert.notEqual(fs.readFileSync(indexFile, 'utf8'), before, 'written on the way out');

    const w2 = start();
    try {
      w2.child.send(init);
      w2.child.send({ type: 'snapshot', requestId: 'again' });
      const again = (await w2.waitFor((m) => m.type === 'snapshot' && m.requestId === 'again')).snapshot;
      assert.equal(again.providers[0].spend.d30Tokens, 24, 'same totals, nothing counted twice');
      const scanning = w2.messages.filter((m) => m.type === 'progress' && m.requestId === 'again' && m.phase === 'scanning');
      assert.ok(scanning.every((p) => p.filesTotal === 0), 'nothing re-read after the flush');
    } finally {
      w2.child.kill();
    }
  } finally {
    w.child.kill();
    rmrf(root);
  }
});
