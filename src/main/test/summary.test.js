'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const S = require('../summary');

const mock = require(path.join(__dirname, '..', '..', 'shared', 'mock-snapshot.json'));

test('short names: gmail and acme from emails, chosen names as written', () => {
  assert.equal(S.shortName('you@gmail.com'), 'gmail');
  assert.equal(S.shortName('you@acmelabs.com'), 'acme');
  assert.equal(S.shortName('Subscription 1'), 'Subscription 1');
  assert.equal(S.shortName('  Work   account '), 'Work account');
  assert.equal(S.shortName(null), null);
});

test('gauge: default Claude account weekly window', () => {
  const g = S.gaugeOf(mock);
  const w = mock.providers[0].limits.accounts.find((a) => a.id === 'default').windows.find((x) => x.key === 'weekly');
  assert.equal(g.pct, w.usedPct);
  assert.equal(g.tone, S.toneOf(w));
  assert.deepEqual(S.gaugeOf(null), { pct: null, tone: 'none' });
  assert.deepEqual(S.gaugeOf({ providers: [] }), { pct: null, tone: 'none' });
});

test('the tray turns amber exactly when the panel says "Weekly runs out", never earlier', () => {
  const NOW = Date.parse('2026-10-03T14:00:00Z');
  const RESET = '2026-10-10T07:00:00Z';
  const w = (usedPct, state, runsOutAt) => ({ key: 'weekly', usedPct, resetsAt: RESET, pace: { state, runsOutAt } });
  // 2026-10-03: 14 % used hours into a fresh week projects "runs out Tuesday": too early to say
  assert.equal(S.toneOf(w(14, 'deficit', '2026-10-06T17:27:12Z'), NOW), 'ok');
  assert.equal(S.toneOf(w(25, 'deficit', '2026-10-06T17:27:12Z'), NOW), 'warn');
  assert.equal(S.toneOf(w(25, 'deficit', '2026-10-11T00:00:00Z'), NOW), 'ok', 'lasts until the reset');
  assert.equal(S.toneOf(w(25, 'deficit', '2026-10-03T13:00:00Z'), NOW), 'ok', 'a projection already past');
  assert.equal(S.toneOf(w(60, 'reserve', null), NOW), 'ok');
  assert.equal(S.toneOf(w(40, 'on-pace', '2026-10-09T00:00:00Z'), NOW), 'ok', 'only a deficit warns');
  assert.equal(S.toneOf(w(100, 'full', null), NOW), 'full');
  assert.equal(S.toneOf(null, NOW), 'none');
});

test('gauge: the account the Claude app is using (limits.activeId) wins; the tooltip keeps both', () => {
  const week = (usedPct, state) => [{ key: 'weekly', label: 'Weekly', usedPct, pace: { state } }];
  const snap = (activeId) => ({
    providers: [
      {
        id: 'claude',
        limits: {
          activeId,
          accounts: [
            { id: 'default', name: 'Subscription 1', windows: week(5, 'reserve') },
            { id: 'account_1', name: 'Subscription 2', windows: week(100, 'full') },
          ],
        },
      },
    ],
  });
  assert.deepEqual(S.gaugeOf(snap('account_1')), { pct: 100, tone: 'full' });
  assert.deepEqual(S.gaugeOf(snap('default')), { pct: 5, tone: 'ok' });
  assert.deepEqual(S.gaugeOf(snap(undefined)), { pct: 5, tone: 'ok' }, 'unknown: the default profile');
  assert.deepEqual(S.gaugeOf(snap('account_9')), { pct: 5, tone: 'ok' }, 'not listed: the default profile');
  assert.equal(S.tooltipOf(snap('account_1')), 'Agent Meter · Subscription 1: 5% weekly · Subscription 2: full');
});

test('tooltip from the mock snapshot', () => {
  const t = S.tooltipOf(mock);
  assert.match(t, /^Agent Meter · Claude Subscription 1: 90% weekly · Claude Subscription 2: full · codex: 87% /);
  assert.ok(t.length <= S.TOOLTIP_MAX, t);
});

test('tooltip before data and while scanning', () => {
  assert.equal(S.tooltipOf(null), 'Agent Meter · reading usage…');
  assert.equal(S.tooltipOf(null, { progress: { filesDone: 12, filesTotal: 400 } }), 'Agent Meter · reading usage 12/400 files');
});

test('tooltip flags example data and never exceeds 127 chars', () => {
  assert.match(S.tooltipOf(mock, { example: true }), /^Agent Meter · example data · Claude Subscription 1/);
  const many = JSON.parse(JSON.stringify(mock));
  for (let i = 0; i < 20; i++) {
    many.providers[0].limits.accounts.push({
      id: `a${i}`,
      name: `person${i}@company${i}.com`,
      kind: 'folder',
      status: 'ok',
      windows: [{ key: 'weekly', label: 'Weekly', usedPct: 50, pace: { state: 'on-pace' } }],
    });
  }
  const t = S.tooltipOf(many);
  assert.ok(t.length <= 127, String(t.length));
  assert.ok(!t.endsWith(' · '));
});

test('two accounts on the same mail domain fall back to the mailbox', () => {
  const snap = {
    providers: [
      {
        id: 'claude',
        limits: {
          accounts: [
            { id: 'default', name: 'one@gmail.com', windows: [{ key: 'weekly', label: 'Weekly', usedPct: 10, pace: { state: 'reserve' } }] },
            { id: 'account_1', name: 'two@gmail.com', windows: [{ key: 'weekly', label: 'Weekly', usedPct: 100, pace: { state: 'full' } }] },
          ],
        },
      },
    ],
  };
  assert.equal(S.tooltipOf(snap), 'Agent Meter · one: 10% weekly · two: full');
  snap.providers[0].limits.accounts[0].name = 'Subscription 1';
  snap.providers[0].limits.accounts[1].name = 'Subscription 2';
  assert.equal(S.tooltipOf(snap), 'Agent Meter · Subscription 1: 10% weekly · Subscription 2: full');
});

test('tooltip when the data engine failed before any snapshot', () => {
  assert.equal(S.tooltipOf(null, { error: true }), 'Agent Meter · data engine not ready, retrying');
});
