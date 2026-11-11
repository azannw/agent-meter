'use strict';
process.env.TZ = 'Asia/Karachi';

// The Claude-app count (CONTRACT section 2, Headline): every assistant line of the
// Claude desktop app's file set, no dedupe, ledgered, plus the cost basis switch.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createCollector } = require('../index');
const { createClaudeScanner } = require('../scan-claude');
const { VERSION } = require('../ledger');
const { localMidnight, lastNDates } = require('../util');
const { validateSnapshot } = require('./schema');
const { mkTmp, rmrf, claudeLine, writeLines, setMtime, codexMeta, codexTurn, codexTokens } = require('./helpers');

const NOW = Date.parse('2026-10-02T12:00:00.000Z'); // 17:00 local on 2 Oct; range 3 Sep .. 2 Oct
const H = 3600e3;
const STRICT = { requireLifetime: true, requireHeadline: true };

// opus-5.5: $4 in, $20 out, $8 1h write, $0.20 read (per million)
const R1 = { id: 'r1', req: 'r1', session: 'main', input: 10000, output: 100000, cacheRead: 1000000, cacheWrite: 200000, cw5: 0, cw1: 200000, ts: '2026-10-02T08:00:00Z' };
const SC = { id: 'sc', req: 'sc', session: 'main', input: 7000, output: 7000, sidechain: true, ts: '2026-10-02T08:05:00Z' }; // sidechain line in a MAIN file
const SB = { id: 'sb', req: 'sb', session: 'main', input: 5000, output: 5000, sidechain: true, ts: '2026-10-02T09:00:00Z' }; // in subagents/agent-*.jsonl
const W1 = { id: 'w1', req: 'w1', session: 'main', input: 3000, output: 3000, ts: '2026-10-02T09:30:00Z' }; // workflow transcript
const tok = (m) => (m.input || 0) + (m.output || 0) + (m.cacheRead || 0) + (m.cacheWrite || 0);
const usd = (m) => ((m.input || 0) * 4 + (m.output || 0) * 20 + (m.cacheRead || 0) * 0.2 + (m.cacheWrite || 0) * 8) / 1e6;

function fixture() {
  const root = mkTmp('headline');
  const home = path.join(root, 'home');
  const proj = path.join(home, '.claude', 'projects', 'D--fake');
  const f = { root, home, proj, state: path.join(root, 'state'), appData: path.join(root, 'appdata') };
  f.main = path.join(proj, 'main.jsonl');
  f.sub = path.join(proj, 'main', 'subagents', 'agent-a1.jsonl');
  f.flow = path.join(proj, 'main', 'subagents', 'workflows', 'wf_1', 'agent-w1.jsonl');
  f.other = path.join(proj, 'main', 'subagents', 'notes.jsonl'); // not agent-*: not in the app's set
  return f;
}
function put(file, lines, mtime = NOW - H) {
  writeLines(file, lines);
  setMtime(file, mtime);
}
// The full set: R1 as 3 content-block lines, a sidechain line in the main file, a
// sidechain line in a subagent file, a workflow transcript.
function full() {
  const f = fixture();
  put(f.main, [claudeLine(R1), claudeLine(R1), claudeLine(R1), claudeLine(SC)]);
  put(f.sub, [claudeLine(SB)]);
  put(f.flow, [claudeLine(W1)]);
  return f;
}
const collector = (f, extra = {}) =>
  createCollector({ stateDir: f.state, rangeDays: 30, home: f.home, appData: f.appData, now: NOW, allowNetwork: false, ...extra });
const readLedger = (f) => JSON.parse(fs.readFileSync(path.join(f.state, 'ledger.json'), 'utf8'));
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-4, `${a} != ${b}`);

test('a reply written as 3 content-block lines counts 3x Claude-app style and 1x per reply', async () => {
  const f = fixture();
  try {
    put(f.main, [claudeLine(R1), claudeLine(R1), claudeLine(R1)]);
    const s = await collector(f).snapshot();
    assert.deepEqual(validateSnapshot(s, STRICT), []);
    assert.equal(s.overview.headline.tokens, 3 * tok(R1));
    assert.equal(s.overview.headline.d30Tokens, 3 * tok(R1));
    assert.equal(s.providers[0].spend.lifetime.tokens, tok(R1));
    assert.equal(s.providers[0].spend.d30Tokens, tok(R1));
  } finally {
    rmrf(f.root);
  }
});

test('a sidechain line is skipped in a main file but counted in subagents/agent-*.jsonl (Claude-app style)', async () => {
  const f = fixture();
  try {
    put(f.main, [claudeLine(SC)]);
    put(f.sub, [claudeLine(SB)]);
    const s = await collector(f).snapshot();
    assert.equal(s.overview.headline.tokens, tok(SB), 'app style: only the subagent file sidechain line');
    assert.equal(s.providers[0].spend.lifetime.tokens, tok(SC) + tok(SB), 'per reply: both');
  } finally {
    rmrf(f.root);
  }
});

test('a deeper workflow transcript (and a non agent-* file) is outside the Claude-app count, inside per reply', async () => {
  const f = fixture();
  try {
    put(f.main, [claudeLine(R1)]);
    put(f.flow, [claudeLine(W1)]);
    put(f.other, [claudeLine({ ...W1, id: 'o1', req: 'o1' })]);
    const s = await collector(f).snapshot();
    assert.equal(s.overview.headline.tokens, tok(R1));
    assert.equal(s.providers[0].spend.lifetime.tokens, tok(R1) + 2 * tok(W1));
  } finally {
    rmrf(f.root);
  }
});

test('Claude-app days are LOCAL dates: UTC+5 midnight splits them, not UTC midnight', async () => {
  const f = fixture();
  try {
    put(f.main, [
      claudeLine({ id: 'a', req: 'a', output: 1, ts: '2026-09-30T18:59:59.000Z' }), // 23:59:59 on 30 Sep
      claudeLine({ id: 'a', req: 'a', output: 1, ts: '2026-09-30T18:59:59.000Z' }), // its second content block
      claudeLine({ id: 'b', req: 'b', output: 2, ts: '2026-09-30T19:00:00.000Z' }), // 00:00:00 on 1 Oct
      claudeLine({ id: 'c', req: 'c', output: 4, ts: '2026-09-30T23:30:00.000Z' }), // 04:30 on 1 Oct, still 30 Sep in UTC
    ]);
    await collector(f).snapshot();
    const days = readLedger(f).days;
    const appOut = (d) => Object.values(days[d].claude.a).reduce((x, r) => x + r[1], 0);
    assert.equal(appOut('2026-09-30'), 2);
    assert.equal(appOut('2026-10-01'), 6);
  } finally {
    rmrf(f.root);
  }
});

test('basis switching changes the costs, never the tokens; the default is per-reply', async () => {
  const f = full();
  try {
    const def = await collector(f).snapshot();
    assert.equal(def.overview.headline.basis, 'per-reply');
    const claude = def.providers[0].spend;
    // per-reply: the deduped figures over every transcript, workflow ones included
    const perReplyUSD = usd(R1) + usd(SC) + usd(SB) + usd(W1);
    near(claude.lifetime.costUSD, perReplyUSD);
    near(def.overview.headline.costUSD, perReplyUSD);
    near(def.overview.headline.d30CostUSD, claude.d30USD);
    near(def.overview.headline.todayUSD, claude.todayUSD);

    const app = await collector(f, { costBasis: 'claude-app' }).snapshot();
    assert.equal(app.overview.headline.basis, 'claude-app');
    const appUSD = 3 * usd(R1) + usd(SB);
    near(app.overview.headline.costUSD, appUSD);
    near(app.overview.headline.d30CostUSD, appUSD);
    near(app.overview.headline.todayUSD, appUSD);

    for (const k of ['tokens', 'd30Tokens', 'since']) assert.equal(app.overview.headline[k], def.overview.headline[k], k);
    assert.equal(def.overview.headline.tokens, 3 * tok(R1) + tok(SB));
    assert.deepEqual(app.providers, def.providers, 'nothing outside the headline depends on the basis');

    // the shell switching the setting: same collector, no rescan
    const c = collector(f, { costBasis: 'claude-app' });
    await c.snapshot();
    c.setCostBasis('per-reply');
    const back = await c.snapshot();
    assert.equal(c.lastStats.claude.filesWork, 0, 'no file re-read');
    assert.deepEqual(back.overview.headline, def.overview.headline);
    c.setCostBasis('nonsense');
    assert.equal(c.costBasis, 'per-reply', 'an unknown basis falls back to the default');
  } finally {
    rmrf(f.root);
  }
});

test('never shrinks: deleting a transcript keeps every Claude-app day as it was', async () => {
  const f = full();
  try {
    const c1 = collector(f);
    const before = await c1.snapshot();
    const liveBefore = c1.lastStats.appTokensLive;
    const ledgerBefore = readLedger(f);
    fs.unlinkSync(f.main); // Claude's cleanup
    const c2 = collector(f);
    const after = await c2.snapshot();
    assert.ok(c2.lastStats.appTokensLive < liveBefore, "the app's own live count dropped");
    assert.deepEqual(after.overview.headline, before.overview.headline);
    // even with the scan index gone as well
    fs.unlinkSync(path.join(f.state, 'scan-index-claude.json'));
    const again = await collector(f).snapshot();
    assert.deepEqual(again.overview.headline, before.overview.headline);
    assert.deepEqual(readLedger(f).days['2026-10-02'].claude.a, ledgerBefore.days['2026-10-02'].claude.a);
  } finally {
    rmrf(f.root);
  }
});

test('a rewritten (truncated) transcript is re-read without adding its Claude-app lines twice', async () => {
  const f = fixture();
  try {
    const X = { id: 'x', req: 'x', session: 'main', input: 1, output: 1, ts: '2026-10-02T10:00:00Z' };
    put(f.main, [claudeLine(R1), claudeLine(R1), claudeLine(R1), claudeLine(X)]);
    const s1 = await collector(f).snapshot();
    put(f.main, [claudeLine(R1), claudeLine(R1)]); // smaller: a rescan from byte 0
    const c2 = collector(f);
    const s2 = await c2.snapshot();
    assert.equal(c2.lastStats.claude.rescans, 1);
    assert.equal(c2.lastStats.appTokensLive, 2 * tok(R1), 'the file now holds two lines, and the live sum says so');
    assert.equal(s2.overview.headline.tokens, s1.overview.headline.tokens, 'kept (never shrinks), not added to');
  } finally {
    rmrf(f.root);
  }
});

test('app semantics: a later file copying an old line adds to that old day app-style, not per reply', async () => {
  const f = fixture();
  try {
    const O = { id: 'o', req: 'o', session: 'old', model: 'claude-opus-5', input: 100, output: 100, ts: '2026-08-10T08:00:00Z' };
    put(path.join(f.proj, 'old.jsonl'), [claudeLine(O)], Date.parse('2026-08-10T09:00:00Z'));
    const s1 = await collector(f).snapshot();
    put(path.join(f.proj, 'resumed.jsonl'), [claudeLine({ ...O, session: 'resumed' })]);
    const s2 = await collector(f).snapshot();
    assert.equal(s2.overview.headline.tokens - s1.overview.headline.tokens, tok(O), 'the app counts the copy');
    assert.equal(s2.providers[0].spend.lifetime.tokens, s1.providers[0].spend.lifetime.tokens, 'per reply does not');
    assert.equal(s2.overview.headline.d30Tokens, 0, 'on its own (old) date, outside the range');
  } finally {
    rmrf(f.root);
  }
});

test('the app window: a file last written before now - 182 days is outside the Claude-app count only', async () => {
  const f = fixture();
  try {
    const A = { id: 'z', req: 'z', session: 'ancient', input: 50, output: 50, ts: '2026-03-01T08:00:00Z' };
    put(path.join(f.proj, 'ancient.jsonl'), [claudeLine(A)], Date.parse('2026-03-01T09:00:00Z'));
    put(f.main, [claudeLine(R1)]);
    const s = await collector(f).snapshot();
    assert.equal(s.overview.headline.tokens, tok(R1));
    assert.equal(s.providers[0].spend.lifetime.tokens, tok(R1) + tok(A), 'the seed still reads it once per reply');
  } finally {
    rmrf(f.root);
  }
});

test('the 1 GiB rule: a file over the app limit is left out of the Claude-app sums', async () => {
  const f = fixture();
  try {
    put(f.main, [claudeLine(R1)]);
    put(f.sub, [claudeLine(SB)]);
    const scan = (appMaxBytes) =>
      createClaudeScanner({ stateDir: path.join(f.root, 's' + appMaxBytes), home: f.home }).scan({
        retentionStartMs: localMidnight(NOW, 31),
        appWindowStartMs: localMidnight(NOW - 157248e5, 0),
        appMaxBytes,
        fromDate: lastNDates(NOW, 32)[0],
        now: NOW,
      });
    const sum = (b) => Object.values(b).reduce((x, r) => x + r[0] + r[1] + r[2] + r[3] + r[4], 0);
    assert.equal(sum((await scan(1073741824)).appBuckets), tok(R1) + tok(SB));
    const subSize = fs.statSync(f.sub).size;
    const mainSize = fs.statSync(f.main).size;
    assert.ok(subSize !== mainSize);
    // a limit between the two sizes drops exactly the bigger file
    const limit = Math.min(subSize, mainSize);
    assert.equal(sum((await scan(limit)).appBuckets), subSize <= limit ? tok(SB) : tok(R1));
  } finally {
    rmrf(f.root);
  }
});

test('old-ledger migration: a version-1 ledger is re-seeded once and keeps the days only it had', async () => {
  const f = full();
  try {
    fs.mkdirSync(f.state, { recursive: true });
    const v1 = {
      version: 1,
      fields: ['input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h', 'messages'],
      createdAt: '2026-10-01T00:00:00.000Z',
      days: {
        // a day whose transcripts Claude has since deleted: only this file remembers it
        '2026-07-01': { claude: { m: { 'claude-opus-5\t0': [1000, 1000, 0, 0, 0, 1] }, s: ['ZZZZZZZZ'] } },
        // a day the disk still has, recorded smaller: the re-seed wins
        '2026-10-02': { claude: { m: { 'claude-opus-5-5\t0': [1, 1, 0, 0, 0, 1] }, s: [] } },
      },
    };
    fs.writeFileSync(path.join(f.state, 'ledger.json'), JSON.stringify(v1));
    const c = collector(f);
    const s = await c.snapshot();
    assert.ok(c.lastStats.seed, 're-seeded');
    assert.deepEqual(validateSnapshot(s, STRICT), []);
    const l = readLedger(f);
    assert.equal(l.version, VERSION);
    assert.ok(l.days['2026-10-02'].claude.a, 'the Claude-app count was built');
    assert.deepEqual(l.days['2026-07-01'].claude.m['claude-opus-5\t0'], [1000, 1000, 0, 0, 0, 1], 'the v1-only day survived');
    const life = s.providers[0].spend.lifetime;
    assert.equal(life.tokens, 2000 + tok(R1) + tok(SC) + tok(SB) + tok(W1));
    assert.equal(life.since, '2026-07-01');
    assert.equal(s.overview.headline.tokens, 3 * tok(R1) + tok(SB), 'the v1 day has no app-style count to add');
    assert.equal(s.overview.headline.since, '2026-07-01');
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.state, 'ledger.json.bak'), 'utf8')).version, 1, 'the v1 file is kept as the backup');
    // once only
    const c2 = collector(f);
    await c2.snapshot();
    assert.equal(c2.lastStats.seed, null);
  } finally {
    rmrf(f.root);
  }
});

test('Codex joins the headline only when the panel shows it, on its own single count', async () => {
  const f = full();
  try {
    const sid = '55555555-0000-0000-0000-000000000001';
    const file = path.join(f.home, '.codex', 'sessions', '2026', '10', '02', `rollout-2026-10-02T10-00-00-${sid}.jsonl`);
    put(file, [
      codexMeta({ ts: '2026-10-02T10:00:00.000Z', id: sid }),
      codexTurn({ ts: '2026-10-02T10:00:01.000Z', model: 'gpt-5.5' }),
      codexTokens({ ts: '2026-10-02T10:00:02.000Z', last: [1000, 600, 100], total: [1000, 600, 100] }),
    ]);
    const s = await collector(f).snapshot();
    assert.equal(s.providers[1].available, true);
    assert.equal(s.overview.headline.tokens, 3 * tok(R1) + tok(SB) + 1100);
    assert.equal(s.overview.headline.d30Tokens, 3 * tok(R1) + tok(SB) + 1100);
    // hidden again (its only session moved to May): out of the headline
    put(file, [
      codexMeta({ ts: '2026-05-02T10:00:00.000Z', id: sid }),
      codexTurn({ ts: '2026-05-02T10:00:01.000Z', model: 'gpt-5.5' }),
      codexTokens({ ts: '2026-05-02T10:00:02.000Z', last: [1000, 600, 100], total: [1000, 600, 100] }),
    ], Date.parse('2026-05-02T10:01:00Z'));
    rmrf(f.state);
    const hidden = await collector(f).snapshot();
    assert.equal(hidden.providers[1].available, false);
    assert.equal(hidden.overview.headline.tokens, 3 * tok(R1) + tok(SB));
  } finally {
    rmrf(f.root);
  }
});

test('temp files carry the pid; dead processes leave temps that are cleaned up, a live one is kept', async () => {
  const f = full();
  try {
    await collector(f).snapshot();
    const dir = f.state;
    const dead = path.join(dir, 'ledger.json.2147483646.tmp');
    const legacy = path.join(dir, 'ledger.json.tmp');
    const live = path.join(dir, `ledger.json.${process.ppid}.tmp`); // the test runner's parent is alive
    const deadIndex = path.join(dir, 'scan-index-claude.json.2147483646.tmp');
    for (const p of [dead, legacy, live, deadIndex]) fs.writeFileSync(p, 'partial');
    // a write happens (new usage), so the ledger saves and sweeps; watch which temp
    // names this process writes
    fs.appendFileSync(f.sub, claudeLine({ ...SB, id: 'sb2', req: 'sb2' }) + '\n');
    const written = [];
    const realWrite = fs.writeFileSync;
    fs.writeFileSync = function (p, ...rest) {
      written.push(path.basename(String(p)));
      return realWrite.call(this, p, ...rest);
    };
    try {
      await collector(f).snapshot();
    } finally {
      fs.writeFileSync = realWrite;
    }
    assert.ok(written.includes(`ledger.json.${process.pid}.tmp`), 'ledger temp carries the pid: ' + written.join(', '));
    assert.ok(written.includes(`scan-index-claude.json.${process.pid}.tmp`), 'index temp carries the pid');
    assert.ok(!fs.existsSync(dead), 'dead pid temp removed');
    assert.ok(!fs.existsSync(legacy), 'pid-less temp of an older build removed');
    assert.ok(fs.existsSync(live), 'a live process temp is left alone');
    assert.ok(!fs.existsSync(deadIndex), 'scan-index temp of a dead pid removed');
    assert.ok(!fs.readdirSync(dir).some((n) => n === `ledger.json.${process.pid}.tmp`), 'own temp renamed away');

    // a process that died between the renames left ONLY a complete temp: it is used
    const good = fs.readFileSync(path.join(dir, 'ledger.json'), 'utf8');
    fs.unlinkSync(path.join(dir, 'ledger.json'));
    fs.unlinkSync(path.join(dir, 'ledger.json.bak'));
    fs.unlinkSync(path.join(f.proj, 'main.jsonl')); // so the scan alone could not rebuild it
    fs.writeFileSync(dead, good);
    const c = collector(f);
    const s = await c.snapshot();
    assert.equal(c.lastStats.seed, null, 'restored, not re-seeded');
    assert.equal(s.overview.headline.tokens, 3 * tok(R1) + 2 * tok(SB));
    assert.ok(!fs.existsSync(dead));
  } finally {
    rmrf(f.root);
  }
});
