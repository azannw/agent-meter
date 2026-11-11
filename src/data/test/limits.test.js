'use strict';
process.env.TZ = 'Asia/Karachi';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { readClaudeLimits, buildCodexAccount, errorText, windowLabel } = require('../limits');
const { mkTmp, rmrf, writeMonitor } = require('./helpers');

const NOW = Date.parse('2026-10-02T12:00:00.000Z');
const S = (ms) => Math.floor(ms / 1000);
const H = 3600e3;

function twoAccounts(extra = {}) {
  return [
    { id: 'default', name: 'me@example.com', config_dir: '', session: 12, sessionReset: S(NOW + 2 * H), weekly: 90, weeklyReset: S(NOW + 48 * H), scoped: 0, ...extra.a },
    { id: 'account_1', name: 'work@example.com', config_dir: 'C:\\Users\\Fake\\.claude-acct2', session: 0, sessionReset: null, weekly: 100, weeklyReset: S(NOW + 20 * H), ...extra.b },
  ];
}

test('accounts: session, weekly, then model-scoped windows; names and kinds from the profiles', () => {
  const root = mkTmp('lim');
  try {
    writeMonitor(root, { updatedUnix: S(NOW - 30e3), accounts: twoAccounts() });
    const r = readClaudeLimits({ appData: root, now: NOW });
    assert.equal(r.found, true);
    assert.deepEqual(r.warnings, []);
    assert.equal(r.updatedAt, new Date(S(NOW - 30e3) * 1000).toISOString());
    assert.equal(r.accounts.length, 2);
    const [a, b] = r.accounts;
    assert.equal(a.id, 'default');
    assert.equal(a.kind, 'claude-app');
    assert.equal(a.status, 'ok');
    assert.equal(a.error, null);
    assert.deepEqual(a.windows.map((w) => [w.key, w.label, w.windowMinutes]), [
      ['session', 'Session', 300],
      ['weekly', 'Weekly', 10080],
      ['weekly_scoped_fable', 'Fable only', 10080],
    ]);
    assert.equal(a.windows[0].usedPct, 12);
    assert.equal(a.windows[0].resetsAt, new Date(S(NOW + 2 * H) * 1000).toISOString());
    assert.equal(a.windows[1].pace.state, 'deficit');
    assert.equal(b.kind, 'folder');
    assert.equal(b.name, 'work@example.com');
    assert.equal(b.windows[0].resetsAt, null, 'a session that has not started has no reset');
    assert.equal(b.windows[1].pace.state, 'full');
    assert.deepEqual(r.profiles.map((p) => p.id), ['default', 'account_1']);
  } finally {
    rmrf(root);
  }
});

test('error mapping: HTTP 429 with a last reading -> stale, windows kept; without one -> error', () => {
  const root = mkTmp('lim');
  try {
    // The usage endpoint refuses about every other check at a 60 s poll, so a 429
    // over a good reading is routine: keep the numbers and say they are the last ones.
    writeMonitor(root, { updatedUnix: S(NOW - 30e3), accounts: twoAccounts({ b: { error: { http_status: 429 } } }) });
    const r = readClaudeLimits({ appData: root, now: NOW });
    const b = r.accounts[1];
    assert.equal(b.status, 'stale');
    assert.equal(b.error, 'Claude is limiting usage checks: showing the last reading');
    assert.equal(b.windows.length, 2);
    assert.equal(r.accounts[0].status, 'ok');

    writeMonitor(root, { updatedUnix: S(NOW - 30e3), accounts: twoAccounts({ b: { error: { http_status: 429 }, usage: null } }) });
    assert.equal(readClaudeLimits({ appData: root, now: NOW }).accounts[1].status, 'error');

    writeMonitor(root, { updatedUnix: S(NOW - 30e3), accounts: twoAccounts({ b: { error: { http_status: 401 } } }) });
    assert.equal(readClaudeLimits({ appData: root, now: NOW }).accounts[1].status, 'error');
    assert.equal(errorText({ http_status: 401 }), 'Signed out: sign in to Claude Code again');
    assert.match(errorText({ http_status: 503 }), /HTTP 503/);
    assert.equal(errorText(null), null);
  } finally {
    rmrf(root);
  }
});

test('missing cache file: no accounts and a warning that the Usage Monitor is not running', () => {
  const root = mkTmp('lim');
  try {
    const r = readClaudeLimits({ appData: path.join(root, 'nothing-here'), now: NOW });
    assert.equal(r.found, false);
    assert.deepEqual(r.accounts, []);
    assert.equal(r.updatedAt, null);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /Usage Monitor/);
    assert.match(r.warnings[0], /not running/);
  } finally {
    rmrf(root);
  }
});

test('stale: updated_unix older than 10 min, or usage.stale, marks accounts stale with a warning', () => {
  const root = mkTmp('lim');
  try {
    writeMonitor(root, { updatedUnix: S(NOW - 2 * H), accounts: twoAccounts() });
    const r = readClaudeLimits({ appData: root, now: NOW });
    assert.ok(r.accounts.every((a) => a.status === 'stale'));
    assert.deepEqual(r.warnings, ['Usage Monitor hasn’t updated limits for 2 h']);

    writeMonitor(root, { updatedUnix: S(NOW - 60e3), accounts: twoAccounts(), stale: true });
    const r2 = readClaudeLimits({ appData: root, now: NOW });
    assert.ok(r2.accounts.every((a) => a.status === 'stale'));
    assert.deepEqual(r2.warnings, []);
  } finally {
    rmrf(root);
  }
});

test('a reading whose reset already passed reports the rolled-over window as 0%', () => {
  const root = mkTmp('lim');
  try {
    writeMonitor(root, { updatedUnix: S(NOW - 6 * H), accounts: twoAccounts({ a: { session: 80, sessionReset: S(NOW - H) } }) });
    const w = readClaudeLimits({ appData: root, now: NOW }).accounts[0].windows[0];
    assert.equal(w.usedPct, 0);
    assert.equal(w.resetsAt, null);
  } finally {
    rmrf(root);
  }
});

test('an enabled profile with no reading yet is listed as unavailable; a disabled one is not listed', () => {
  const root = mkTmp('lim');
  try {
    writeMonitor(root, {
      updatedUnix: S(NOW - 30e3),
      accounts: twoAccounts().slice(0, 1),
      profiles: [
        { id: 'default', name: 'me@example.com', config_dir: '', enabled: true },
        { id: 'account_1', name: 'work@example.com', config_dir: 'C:\\x\\.claude-a', enabled: true },
        { id: 'account_2', name: 'off@example.com', config_dir: 'C:\\x\\.claude-b', enabled: false },
      ],
    });
    const r = readClaudeLimits({ appData: root, now: NOW });
    assert.deepEqual(r.accounts.map((a) => [a.id, a.status]), [['default', 'ok'], ['account_1', 'unavailable']]);
  } finally {
    rmrf(root);
  }
});

test('Codex account: windows labelled from window_minutes, stale reading says when it was seen', () => {
  const rate = {
    timestamp: '2026-07-03T22:58:33.186Z',
    planType: 'free',
    primary: { usedPct: 87, windowMinutes: 43200, resetsAt: new Date(NOW + 9 * 86400e3).toISOString() },
    secondary: null,
  };
  const a = buildCodexAccount(rate, NOW);
  assert.equal(a.id, 'codex');
  assert.equal(a.kind, 'codex');
  assert.equal(a.status, 'stale');
  assert.equal(a.error, 'Last seen in a session on 4 Jul'); // 03:58 on 4 Jul in UTC+5
  assert.equal(a.windows.length, 1);
  assert.equal(a.windows[0].key, 'primary');
  assert.equal(a.windows[0].label, 'Monthly');
  assert.equal(a.windows[0].usedPct, 87);

  const fresh = buildCodexAccount({ ...rate, timestamp: new Date(NOW - 60e3).toISOString() }, NOW);
  assert.equal(fresh.status, 'ok');
  assert.equal(fresh.error, null);
  assert.equal(buildCodexAccount(null, NOW), null);
  assert.equal(windowLabel(300), 'Session');
  assert.equal(windowLabel(10080), 'Weekly');
  assert.equal(windowLabel(720), '12 h');
});

test("accounts follow the Monitor's settings order and names, not the cache's", () => {
  const root = mkTmp('lim');
  try {
    // The cache still carries the names from before a rename in the Monitor's settings.
    const acme = { id: 'default', name: 'me@example.com', config_dir: 'C:\\Users\\Fake\\.claude-acme', session: 12, sessionReset: S(NOW + 2 * H), weekly: 2, weeklyReset: S(NOW + 48 * H) };
    const gmail = { id: 'account_1', name: 'work@example.com', config_dir: 'C:\\Users\\Fake\\.claude-gmail', session: 0, sessionReset: null, weekly: 100, weeklyReset: S(NOW + 20 * H) };
    writeMonitor(root, {
      updatedUnix: S(NOW - 30e3),
      accounts: [gmail, acme],
      profiles: [
        { id: 'default', name: 'Subscription 1', config_dir: acme.config_dir, enabled: true },
        { id: 'account_1', name: 'Subscription 2', config_dir: gmail.config_dir, enabled: true },
      ],
    });
    const r = readClaudeLimits({ appData: root, now: NOW });
    assert.deepEqual(r.accounts.map((a) => [a.id, a.name, a.kind]), [
      ['default', 'Subscription 1', 'folder'],
      ['account_1', 'Subscription 2', 'folder'],
    ]);
  } finally {
    rmrf(root);
  }
});

test('a reading follows its login folder when settings move a profile to another folder', () => {
  const root = mkTmp('lim');
  try {
    // 2026-10-03: the cache was written while "default" was the gmail folder (with a
    // pasted tab in front) and "account_1" acme; then settings swapped them. Until
    // the Monitor polls again, the old readings must land on the new owners.
    writeMonitor(root, {
      updatedUnix: S(NOW - 30e3),
      accounts: [
        { id: 'default', name: 'Subscription 2', config_dir: '\tC:\\Users\\Fake\\.claude-gmail', session: 0, sessionReset: null, weekly: 100, weeklyReset: S(NOW + 20 * H) },
        { id: 'account_1', name: 'Subscription 1', config_dir: 'C:\\Users\\Fake\\.claude-acme', session: 12, sessionReset: S(NOW + 2 * H), weekly: 2, weeklyReset: S(NOW + 48 * H) },
      ],
      profiles: [
        { id: 'default', name: 'Subscription 1', config_dir: 'c:/users/fake/.claude-ACME/', enabled: true },
        { id: 'account_1', name: 'Subscription 2', config_dir: 'C:\\Users\\Fake\\.claude-gmail', enabled: true },
      ],
    });
    const r = readClaudeLimits({ appData: root, now: NOW });
    const weekly = (a) => a.windows.find((w) => w.key === 'weekly').usedPct;
    assert.deepEqual(r.accounts.map((a) => [a.id, a.name, weekly(a)]), [
      ['default', 'Subscription 1', 2],
      ['account_1', 'Subscription 2', 100],
    ]);
    assert.equal(r.accounts[0].configDir, 'c:/users/fake/.claude-ACME/');
  } finally {
    rmrf(root);
  }
});

test('a reading for a folder no profile points at any more is dropped', () => {
  const root = mkTmp('lim');
  try {
    writeMonitor(root, {
      updatedUnix: S(NOW - 30e3),
      accounts: [{ id: 'account_1', name: 'Old', config_dir: 'C:\\Users\\Fake\\.claude-acct2', session: 5, sessionReset: S(NOW + H), weekly: 50, weeklyReset: S(NOW + 48 * H) }],
      profiles: [{ id: 'account_1', name: 'Subscription 2', config_dir: 'C:\\Users\\Fake\\.claude-gmail', enabled: true }],
    });
    const r = readClaudeLimits({ appData: root, now: NOW });
    assert.deepEqual(r.accounts.map((a) => [a.id, a.name, a.status, a.windows.length]), [['account_1', 'Subscription 2', 'unavailable', 0]]);
  } finally {
    rmrf(root);
  }
});
