'use strict';
// settings.json in userData, and the Windows login item ("Start with Windows").
// Unpackaged, the login item must launch electron.exe WITH the app folder as
// its first argument, or Windows starts a bare Electron with no app.

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const { createLogger } = require('./log');

const log = createLogger('settings');
const LOGIN_NAME = 'Agent Meter';
// costBasis: what the panel's cost figures count. "claude-app" prices the Claude app's own
// token count, the 100B+ headline (his choice on 2026-10-05: "$14k doesn't fit 100B+";
// $54,870 vs $14,897 that day); "per-reply" prices each reply once (his choice on 10-03).
const COST_BASES = ['per-reply', 'claude-app'];
const DEFAULTS = { autostart: false, costBasis: 'claude-app' };

let cache = null;
let appDir = null;

function file() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function init(dir) {
  appDir = dir;
}

function load() {
  if (cache) return cache;
  try {
    cache = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file(), 'utf8')) };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

function save(patch) {
  cache = { ...load(), ...patch };
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    const tmp = file() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
    fs.renameSync(tmp, file());
  } catch (err) {
    log.error('could not save settings', err.message);
  }
  return cache;
}

/** Options shared by set/getLoginItemSettings, so the read compares like with like. */
function loginOptions() {
  if (app.isPackaged) return { name: LOGIN_NAME };
  // Electron 44 quotes the path and every arg itself: the Run value comes out as
  // "...\electron.exe" "D:\work\agent-meter". Pre-quoting the arg (as older docs advise)
  // produced "\\"D:workagent-meter\\"" with the backslashes lost. Measured 2026-10-02.
  return { name: LOGIN_NAME, path: process.execPath, args: [appDir] };
}

function loginState() {
  try {
    return app.getLoginItemSettings(loginOptions());
  } catch (err) {
    log.warn('getLoginItemSettings failed', err.message);
    return null;
  }
}

/**
 * Will Windows start us at login? NOT `openAtLogin`: on Windows Electron
 * computes that from a Run value named after the AppUserModelId, whatever
 * `name` was passed, so it reads false for our "Agent Meter" value. The
 * launch-item match (same exe + args, enabled in StartupApproved) is the truth.
 */
function getAutostart() {
  const s = loginState();
  if (!s) return !!load().autostart;
  return !!(s.executableWillLaunchAtLogin || s.openAtLogin);
}

function setAutostart(on) {
  const enable = !!on;
  app.setLoginItemSettings({ ...loginOptions(), openAtLogin: enable, enabled: enable });
  save({ autostart: enable });
  const actual = getAutostart();
  if (actual !== enable) log.warn('login item did not take', { wanted: enable, actual });
  else log.info('autostart', enable ? 'on' : 'off');
  return actual;
}

/**
 * Keep the login item in step with settings.json when the app folder moved
 * (our Run value exists but points elsewhere, or vanished). A value the user
 * disabled in Task Manager is left alone: that is their choice, not drift.
 */
function reconcileAutostart() {
  if (!load().autostart) return;
  const s = loginState();
  if (!s) return;
  const ours = (s.launchItems || []).find((i) => i.name === LOGIN_NAME);
  if (ours && ours.enabled === false) return;
  if (!s.executableWillLaunchAtLogin) setAutostart(true);
}

function getCostBasis() {
  const b = load().costBasis;
  return COST_BASES.includes(b) ? b : DEFAULTS.costBasis;
}

function setCostBasis(basis) {
  if (!COST_BASES.includes(basis)) throw new TypeError(`unknown cost basis: ${basis}`);
  save({ costBasis: basis });
  return basis;
}

module.exports = { init, load, save, getAutostart, setAutostart, reconcileAutostart, loginOptions, getCostBasis, setCostBasis, LOGIN_NAME, COST_BASES };
