'use strict';
process.env.TZ = 'Asia/Karachi'; // UTC+5, no DST: the user's zone

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createClaudeScanner, discoverClaudeSources, sessionFromPath } = require('../scan-claude');
const { localMidnight, lastNDates } = require('../util');
const { mkTmp, rmrf, claudeLine, userLineWithUsage, writeLines, setMtime } = require('./helpers');

const NOW = Date.parse('2026-10-02T12:00:00.000Z'); // 17:00 local
const RANGE = 30;

function scanOpts(extra = {}) {
  return {
    retentionStartMs: localMidnight(NOW, RANGE - 1 + 2),
    fromDate: lastNDates(NOW, RANGE + 2)[0],
    now: NOW,
    ...extra,
  };
}

// Sum bucket fields, optionally per date: [input, output, cacheRead, cw5, cw1, messages]
function totals(buckets, filter = () => true) {
  const t = [0, 0, 0, 0, 0, 0];
  for (const [k, b] of Object.entries(buckets)) {
    if (!filter(k.split('\t'))) continue;
    for (let i = 0; i < 6; i++) t[i] += b[i];
  }
  return t;
}

function fixture() {
  const root = mkTmp('claude');
  const home = path.join(root, 'home');
  const state = path.join(root, 'state');
  const proj = path.join(home, '.claude', 'projects', 'D--fake-project');
  fs.mkdirSync(proj, { recursive: true });
  return { root, home, state, proj };
}

test('dedupe across two files: a resumed session copies old lines into a new file', async () => {
  const f = fixture();
  try {
    const a = claudeLine({ id: 'msg_A', req: 'req_A', input: 10, output: 100, cacheRead: 1000, cacheWrite: 50, session: 's1' });
    const b = claudeLine({ id: 'msg_B', req: 'req_B', input: 20, output: 200, session: 's1' });
    writeLines(path.join(f.proj, 's1.jsonl'), [a, b]);
    // the fork: the same two lines (now under a new session id) plus one new message
    const aCopy = claudeLine({ id: 'msg_A', req: 'req_A', input: 10, output: 100, cacheRead: 1000, cacheWrite: 50, session: 's2' });
    const c = claudeLine({ id: 'msg_C', req: 'req_C', input: 1, output: 1, session: 's2' });
    writeLines(path.join(f.proj, 's2.jsonl'), [aCopy, b, c]);

    const r = await createClaudeScanner({ stateDir: f.state, home: f.home }).scan(scanOpts());
    const t = totals(r.buckets);
    assert.deepEqual(t, [31, 301, 1000, 50, 0, 3]);
    assert.equal(r.stats.duplicates, 2);
  } finally {
    rmrf(f.root);
  }
});

test('repeated content-block lines: count once, keep the largest output', async () => {
  const f = fixture();
  try {
    const lines = [8, 190, 120].map((out) =>
      claudeLine({ id: 'msg_X', req: 'req_X', input: 2, output: out, cacheRead: 500, cacheWrite: 40, cw5: 0, cw1: 40 })
    );
    writeLines(path.join(f.proj, 's.jsonl'), lines);
    const r = await createClaudeScanner({ stateDir: f.state, home: f.home }).scan(scanOpts());
    assert.deepEqual(totals(r.buckets), [2, 190, 500, 0, 40, 1]);
  } finally {
    rmrf(f.root);
  }
});

test('incremental append: a rescan reads only the new bytes and counts only new lines', async () => {
  const f = fixture();
  try {
    const file = path.join(f.proj, 's.jsonl');
    writeLines(file, [claudeLine({ id: 'm1', req: 'r1', input: 1, output: 10 }), claudeLine({ id: 'm2', req: 'r2', input: 1, output: 20 })]);
    const scanner = createClaudeScanner({ stateDir: f.state, home: f.home });
    const r1 = await scanner.scan(scanOpts());
    assert.deepEqual(totals(r1.buckets).slice(0, 2), [2, 30]);

    const sizeBefore = fs.statSync(file).size;
    // the part of a message that is still streaming (same id, bigger output) plus a new message
    writeLines(file, [claudeLine({ id: 'm2', req: 'r2', input: 1, output: 25 }), claudeLine({ id: 'm3', req: 'r3', input: 1, output: 5 })], { append: true });
    const appended = fs.statSync(file).size - sizeBefore;
    const r2 = await scanner.scan(scanOpts());
    assert.equal(r2.stats.filesWork, 1);
    assert.equal(r2.stats.bytesRead, appended, 'only the appended bytes were read');
    assert.deepEqual(totals(r2.buckets).slice(0, 2), [3, 40]); // 10 + 25 + 5

    // nothing changed: nothing read
    const r3 = await scanner.scan(scanOpts());
    assert.equal(r3.stats.filesWork, 0);
    assert.equal(r3.stats.bytesRead, 0);

    // a restart (new scanner, same stateDir) does not rescan either
    const r4 = await createClaudeScanner({ stateDir: f.state, home: f.home }).scan(scanOpts());
    assert.equal(r4.stats.filesWork, 0);
    assert.deepEqual(totals(r4.buckets).slice(0, 2), [3, 40]);

    // ...and an append after the restart still dedupes against the persisted keys
    writeLines(file, [claudeLine({ id: 'm3', req: 'r3', input: 1, output: 5 })], { append: true });
    const r5 = await createClaudeScanner({ stateDir: f.state, home: f.home }).scan(scanOpts());
    assert.deepEqual(totals(r5.buckets).slice(0, 2), [3, 40]);
  } finally {
    rmrf(f.root);
  }
});

test('a partial trailing line is not consumed until its newline arrives', async () => {
  const f = fixture();
  try {
    const file = path.join(f.proj, 's.jsonl');
    const whole = claudeLine({ id: 'm1', req: 'r1', input: 1, output: 10 });
    const late = claudeLine({ id: 'm2', req: 'r2', input: 1, output: 7 });
    const cut = Math.floor(late.length / 2);
    fs.writeFileSync(file, whole + '\n' + late.slice(0, cut));
    const scanner = createClaudeScanner({ stateDir: f.state, home: f.home });
    const r1 = await scanner.scan(scanOpts());
    assert.deepEqual(totals(r1.buckets).slice(0, 2), [1, 10]);
    assert.equal(r1.stats.badLines, 0, 'the half line was never parsed');

    fs.appendFileSync(file, late.slice(cut) + '\n');
    const r2 = await scanner.scan(scanOpts());
    assert.deepEqual(totals(r2.buckets).slice(0, 2), [2, 17]);
    // resumed exactly at the start of the half line: no rescan, line 1 not re-read
    assert.equal(r2.stats.rescans, 0);
    assert.equal(r2.stats.bytesRead, late.length + 1);
  } finally {
    rmrf(f.root);
  }
});

test('a truncated or rewritten file is rescanned without double counting', async () => {
  const f = fixture();
  try {
    const file = path.join(f.proj, 's.jsonl');
    writeLines(file, [1, 2, 3].map((i) => claudeLine({ id: 'm' + i, req: 'r' + i, input: 1, output: 10 })));
    const scanner = createClaudeScanner({ stateDir: f.state, home: f.home });
    await scanner.scan(scanOpts());

    // rewritten smaller: one old message kept, one new
    writeLines(file, [claudeLine({ id: 'm1', req: 'r1', input: 1, output: 10 }), claudeLine({ id: 'm9', req: 'r9', input: 1, output: 1 })]);
    const r = await scanner.scan(scanOpts());
    assert.equal(r.stats.rescans, 1);
    assert.deepEqual(totals(r.buckets).slice(0, 2), [4, 31]);

    // replaced by a different, LONGER file whose byte before the old offset is still a
    // newline (n1 has exactly m1's length): only the head hash can tell it was replaced
    const n1 = claudeLine({ id: 'n1', req: 'q1', input: 1, output: 10 });
    assert.equal(n1.length, claudeLine({ id: 'm1', req: 'r1', input: 1, output: 10 }).length);
    writeLines(file, [n1, claudeLine({ id: 'm9', req: 'r9', input: 1, output: 1 }), claudeLine({ id: 'x1', req: 'x1', input: 1, output: 1 })]);
    const r2 = await scanner.scan(scanOpts());
    assert.equal(r2.stats.rescans, 1);
    assert.deepEqual(totals(r2.buckets).slice(0, 2), [6, 42]);
  } finally {
    rmrf(f.root);
  }
});

test('local-day bucketing: UTC+5 midnight splits days, not UTC midnight', async () => {
  const f = fixture();
  try {
    writeLines(path.join(f.proj, 's.jsonl'), [
      claudeLine({ id: 'a', req: 'a', output: 1, ts: '2026-09-30T18:59:59.000Z' }), // 23:59:59 local, 30 Sep
      claudeLine({ id: 'b', req: 'b', output: 2, ts: '2026-09-30T19:00:00.000Z' }), // 00:00:00 local, 1 Oct
      claudeLine({ id: 'c', req: 'c', output: 4, ts: '2026-09-30T23:30:00.000Z' }), // 04:30 local, 1 Oct (still 30 Sep in UTC)
    ]);
    const r = await createClaudeScanner({ stateDir: f.state, home: f.home }).scan(scanOpts());
    assert.equal(totals(r.buckets, (k) => k[0] === '2026-09-30')[1], 1);
    assert.equal(totals(r.buckets, (k) => k[0] === '2026-10-01')[1], 6);
  } finally {
    rmrf(f.root);
  }
});

test('only assistant lines with usage count; <synthetic> and nested usage are skipped', async () => {
  const f = fixture();
  try {
    writeLines(path.join(f.proj, 's.jsonl'), [
      claudeLine({ id: 'ok', req: 'ok', input: 1, output: 1 }),
      claudeLine({ id: 'syn', req: 'syn', model: '<synthetic>', input: 50, output: 50 }),
      userLineWithUsage(),
      claudeLine({ id: 'u', req: 'u', type: 'user', input: 70, output: 70 }),
      '{"type":"assistant","message":{"usage":', // torn line in the middle of a file
      claudeLine({ id: 'old', req: 'old', input: 9, output: 9, ts: '2026-07-01T00:00:00Z' }), // before the range
      claudeLine({ id: 'noreq', noRequestId: true, input: 3, output: 3 }),
      claudeLine({ id: 'noreq', noRequestId: true, input: 3, output: 3 }),
    ]);
    const r = await createClaudeScanner({ stateDir: f.state, home: f.home }).scan(scanOpts());
    assert.deepEqual(totals(r.buckets).slice(0, 2), [4, 4]);
    assert.equal(r.stats.badLines, 1);
  } finally {
    rmrf(f.root);
  }
});

test('cache writes: 5m/1h split when present, all 5m otherwise; fast flag kept per bucket', async () => {
  const f = fixture();
  try {
    writeLines(path.join(f.proj, 's.jsonl'), [
      claudeLine({ id: 'a', req: 'a', cacheWrite: 300, cw5: 100, cw1: 200 }),
      claudeLine({ id: 'b', req: 'b', cacheWrite: 70 }),
      claudeLine({ id: 'c', req: 'c', output: 5, speed: 'fast' }),
    ]);
    const r = await createClaudeScanner({ stateDir: f.state, home: f.home }).scan(scanOpts());
    assert.deepEqual(totals(r.buckets).slice(3, 5), [170, 200]);
    assert.equal(totals(r.buckets, (k) => k[4] === '1')[1], 5);
  } finally {
    rmrf(f.root);
  }
});

test('files last written before the range are skipped without being opened', async () => {
  const f = fixture();
  try {
    const file = path.join(f.proj, 'old.jsonl');
    writeLines(file, [claudeLine({ id: 'a', req: 'a', output: 1, ts: '2026-10-01T00:00:00Z' })]);
    setMtime(file, Date.parse('2026-08-01T00:00:00Z'));
    const r = await createClaudeScanner({ stateDir: f.state, home: f.home }).scan(scanOpts());
    assert.equal(r.stats.filesWork, 0);
    assert.deepEqual(totals(r.buckets), [0, 0, 0, 0, 0, 0]);
    assert.equal(r.sources[0].files, 1, 'still counted for storage size');
    assert.ok(r.sources[0].sizeBytes > 0);
  } finally {
    rmrf(f.root);
  }
});

test('sources: default folder, .claude-* folders with projects, profile names; subagent sessions fold into the parent', async () => {
  const f = fixture();
  try {
    const acct = path.join(f.home, '.claude-acct2', 'projects', 'p');
    writeLines(path.join(acct, 'x.jsonl'), [claudeLine({ id: 'z', req: 'z', output: 3, session: 'other' })]);
    fs.mkdirSync(path.join(f.home, '.claude-empty'), { recursive: true }); // no projects dir: ignored
    const profiles = [
      { id: 'default', name: 'me@example.com', config_dir: '' },
      { id: 'account_1', name: 'work@example.com', config_dir: path.join(f.home, '.claude-acct2') },
      { id: 'account_2', name: 'later@example.com', config_dir: path.join(f.home, '.claude-new') },
    ];
    const sources = discoverClaudeSources(f.home, profiles);
    assert.deepEqual(sources.map((s) => s.id), ['default', 'account_1', 'account_2']);
    assert.equal(sources[0].accountName, 'me@example.com');
    assert.equal(sources[1].accountName, 'work@example.com');
    assert.equal(sources[0].label, 'Claude app & CLI');

    const r = await createClaudeScanner({ stateDir: f.state, home: f.home }).scan(scanOpts({ profiles }));
    assert.equal(totals(r.buckets, (k) => k[1] === 'account_1')[1], 3);
    assert.equal(sessionFromPath(path.join('p', 'proj', 'sess-9', 'subagents', 'agent-1.jsonl')), 'sess-9');
    assert.equal(sessionFromPath(path.join('p', 'proj', 'sess-9.jsonl')), 'sess-9');
  } finally {
    rmrf(f.root);
  }
});

test('the index stays bounded: old days and their dedupe keys are pruned as the window slides', async () => {
  const f = fixture();
  try {
    const file = path.join(f.proj, 's.jsonl');
    writeLines(file, [
      claudeLine({ id: 'early', req: 'e', output: 1, ts: '2026-09-02T10:00:00Z' }),
      claudeLine({ id: 'late', req: 'l', output: 1, ts: '2026-10-02T10:00:00Z' }),
    ]);
    const scanner = createClaudeScanner({ stateDir: f.state, home: f.home });
    const r1 = await scanner.scan(scanOpts());
    assert.equal(r1.stats.seenKeys, 2);
    const later = NOW + 5 * 86400e3;
    const r2 = await scanner.scan({
      retentionStartMs: localMidnight(later, RANGE - 1 + 2),
      fromDate: lastNDates(later, RANGE + 2)[0],
      now: later,
    });
    assert.equal(r2.stats.seenKeys, 1);
    assert.ok(Object.keys(r2.buckets).every((k) => k >= lastNDates(later, RANGE + 2)[0]));
    const saved = JSON.parse(fs.readFileSync(path.join(f.state, 'scan-index-claude.json'), 'utf8'));
    assert.equal(Object.keys(saved.seen).length, 1);
  } finally {
    rmrf(f.root);
  }
});

// ---- batched index writes (persistEveryMs, flush) ------------------------------

test('batched writes: the index waits for the interval, flush() writes it, and a crash in between never double-counts', async () => {
  const f = fixture();
  try {
    const file = path.join(f.proj, 's.jsonl');
    const indexFile = path.join(f.state, 'scan-index-claude.json');
    writeLines(file, [claudeLine({ id: 'msg_1', req: 'r1', input: 10, output: 1 })]);
    const s = createClaudeScanner({ stateDir: f.state, home: f.home, persistEveryMs: 60_000 });
    const r1 = await s.scan(scanOpts());
    assert.ok(fs.existsSync(indexFile), 'the first change is written at once (nothing written yet)');
    const writtenAfterFirst = fs.readFileSync(indexFile, 'utf8');

    writeLines(file, [claudeLine({ id: 'msg_2', req: 'r2', input: 20, output: 2 })], { append: true });
    const r2 = await s.scan(scanOpts());
    assert.deepEqual(totals(r2.buckets), [30, 3, 0, 0, 0, 2]);
    assert.equal(r2.stats.indexBytes, null, 'not written: inside the interval');
    assert.equal(r2.stats.indexPending, true);
    assert.equal(fs.readFileSync(indexFile, 'utf8'), writtenAfterFirst);

    // "crash" now: a new scanner starts from the older file and reads the second line again,
    // counting it exactly once.
    const crashed = await createClaudeScanner({ stateDir: f.state, home: f.home }).scan(scanOpts());
    assert.deepEqual(totals(crashed.buckets), [30, 3, 0, 0, 0, 2]);

    // flush writes the pending index; a scanner started after it reads nothing again
    assert.ok(s.flush() > 0);
    assert.equal(s.pending, false);
    assert.equal(s.flush(), null, 'nothing pending: no write');
    const fresh = createClaudeScanner({ stateDir: f.state, home: f.home });
    const r3 = await fresh.scan(scanOpts());
    assert.deepEqual(totals(r3.buckets), [30, 3, 0, 0, 0, 2]);
    assert.equal(r3.stats.bytesRead, 0, 'flushed offsets: no re-read');
    void r1;
  } finally {
    rmrf(f.root);
  }
});

test('persistEveryMs 0 (the default) still writes after every scan that changed something', async () => {
  const f = fixture();
  try {
    const file = path.join(f.proj, 's.jsonl');
    writeLines(file, [claudeLine({ id: 'msg_1', req: 'r1', input: 1 })]);
    const s = createClaudeScanner({ stateDir: f.state, home: f.home });
    assert.ok((await s.scan(scanOpts())).stats.indexBytes > 0);
    writeLines(file, [claudeLine({ id: 'msg_2', req: 'r2', input: 2 })], { append: true });
    assert.ok((await s.scan(scanOpts())).stats.indexBytes > 0);
    assert.equal((await s.scan(scanOpts())).stats.indexBytes, null, 'unchanged: no write');
  } finally {
    rmrf(f.root);
  }
});

test('one login folder per account: ~/.claude keeps the id default (and its history), ids stay unique, totals unchanged', async () => {
  const f = fixture();
  try {
    writeLines(path.join(f.proj, 's.jsonl'), [claudeLine({ id: 'm1', req: 'r1', input: 5, output: 7 })]);
    for (const d of ['.claude-gmail', '.claude-acme']) fs.mkdirSync(path.join(f.home, d), { recursive: true }); // login folders: no projects
    const profiles = [
      { id: 'default', name: 'me@gmail.example', config_dir: path.join(f.home, '.claude-gmail') },
      { id: 'account_1', name: 'me@work.example', config_dir: path.join(f.home, '.claude-acme') },
    ];
    const sources = discoverClaudeSources(f.home, profiles);
    assert.deepEqual(sources.map((s) => s.id), ['default', 'default:.claude-gmail', 'account_1']);
    assert.equal(new Set(sources.map((s) => s.id)).size, sources.length, 'unique ids');
    assert.equal(sources[0].isDefault, true);
    assert.equal(sources[0].path, path.join(f.home, '.claude'));
    const r = await createClaudeScanner({ stateDir: f.state, home: f.home }).scan(scanOpts({ profiles }));
    assert.deepEqual(totals(r.buckets), [5, 7, 0, 0, 0, 1]);
    assert.equal(totals(r.buckets, (k) => k[1] === 'default')[1], 7, 'counted under the home folder, as before the change');
    // the classic setup (first profile = the Claude app, no folder) keeps the id 'default'
    const classic = discoverClaudeSources(f.home, [{ id: 'default', name: 'x', config_dir: '' }]);
    assert.equal(classic[0].id, 'default');
  } finally {
    rmrf(f.root);
  }
});
