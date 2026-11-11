'use strict';
// The tray tooltip leaves out providers with `available: false`. tray.js is
// required under plain Node here: `require('electron')` then returns the path
// to electron.exe, and nothing Electron-only runs until a TrayController is
// created.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { tooltipSnapshot } = require('../tray');
const { tooltipOf } = require('../summary');

const mock = require(path.join(__dirname, '..', '..', 'shared', 'mock-snapshot.json'));
const clone = () => JSON.parse(JSON.stringify(mock));

test('Codex with available:false is dropped from the tooltip', () => {
  const snap = clone();
  const codex = snap.providers.find((p) => p.id === 'codex');
  assert.ok(codex, 'mock has a Codex provider');
  // keep its limits, so only the flag can be what removes it
  codex.available = false;
  assert.match(tooltipOf(snap), /codex/, 'without the filter the stale Codex reading shows');
  const tip = tooltipOf(tooltipSnapshot(snap));
  assert.doesNotMatch(tip, /codex/i, tip);
  assert.match(tip, /^Agent Meter · Claude Subscription 1: \d+% weekly · Claude Subscription 2: full$/, tip);
  assert.equal(snap.providers.length, 2, 'the snapshot itself is not modified');
});

test('available Codex stays, and nothing else changes', () => {
  const snap = clone();
  snap.providers.find((p) => p.id === 'codex').available = true;
  assert.equal(tooltipSnapshot(snap), snap, 'same object when nothing is dropped');
  assert.match(tooltipOf(tooltipSnapshot(snap)), /· codex: \d+% /);
  assert.equal(tooltipSnapshot(null), null);
  assert.equal(tooltipOf(tooltipSnapshot(null)), 'Agent Meter · reading usage…');
});
