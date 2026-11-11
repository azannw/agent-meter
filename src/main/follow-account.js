'use strict';
// Follows the account the Claude desktop app is using (his ask, 2026-10-03): the Usage
// Monitor's taskbar bars show that account only, the tray number shows it, and the panel
// keeps every account ("both subscriptions in dashboard, only the active one in the
// taskbar bars").
//
// Which account: the app keeps one folder per account,
//   %APPDATA%\Claude\claude-code-sessions\<accountUuid>\<orgUuid>\local_<session>.json,
// and rewrites the session file in use on every turn, so the newest file names the
// account in use. Which Usage Monitor profile that is: every profile's login folder
// holds a .claude.json whose oauthAccount.accountUuid names its account. No token or
// credential file is read.
//
// The Monitor's one-column themes show its "selected" profile. Switching writes
// accounts.claude.selected, plus that profile's theme (themes\agent-meter-<id>.json, from
// scripts/make-monitor-themes.js) when it exists, into the Monitor's settings.json, then
// posts its window WM_APP_SETTINGS_UPDATED, the message its own settings window sends,
// so it reloads in place.

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { execFile } = require('node:child_process');
const { readClaudeProfiles } = require('../data/limits');
const { createLogger } = require('./log');

const log = createLogger('follow');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_FILE = /^local_.+\.json$/i;
const MONITOR_CLASS = 'ClaudeCodeUsageMonitor';
const WM_APP_SETTINGS_UPDATED = 0x8000 + 5; // native_interop.rs in the Monitor's source
const DEBOUNCE_MS = 1500; // a turn rewrites its session file many times
const RECHECK_MS = 60 * 1000; // in case a change event is missed

function sessionsRoot(appData) {
  return path.join(appData, 'Claude', 'claude-code-sessions');
}

function list(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** The account whose session file the Claude app wrote last -> { accountUuid, at } | null. */
function newestDesktopAccount(appData) {
  const root = sessionsRoot(appData);
  let best = null;
  for (const account of list(root)) {
    if (!UUID.test(account)) continue;
    for (const org of list(path.join(root, account))) {
      const dir = path.join(root, account, org);
      for (const name of list(dir)) {
        if (!SESSION_FILE.test(name)) continue;
        let mtimeMs;
        try {
          ({ mtimeMs } = fs.statSync(path.join(dir, name)));
        } catch {
          continue;
        }
        if (!best || mtimeMs > best.at) best = { accountUuid: account.toLowerCase(), at: mtimeMs };
      }
    }
  }
  return best;
}

const accountCache = new Map(); // .claude.json path -> { mtimeMs, uuid }

/** oauthAccount.accountUuid from a login folder's .claude.json, or null. */
function folderAccount(configDir) {
  const file = path.join(configDir, '.claude.json');
  let mtimeMs;
  try {
    ({ mtimeMs } = fs.statSync(file));
  } catch {
    return null;
  }
  const hit = accountCache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit.uuid;
  let uuid = null;
  try {
    const o = JSON.parse(fs.readFileSync(file, 'utf8')).oauthAccount;
    if (o && typeof o.accountUuid === 'string' && UUID.test(o.accountUuid)) uuid = o.accountUuid.toLowerCase();
  } catch {
    uuid = null;
  }
  accountCache.set(file, { mtimeMs, uuid });
  return uuid;
}

/** The enabled Usage Monitor profile signed in to that account, or null. */
function profileForAccount(appData, accountUuid) {
  if (!accountUuid) return null;
  const want = accountUuid.toLowerCase();
  const p = readClaudeProfiles(appData).find((x) => x.enabled && x.config_dir && folderAccount(x.config_dir) === want);
  return p ? p.id : null;
}

/** A limits block naming the followed account (activeId); the block as it is when that account is not in it. */
function markActive(block, profileId) {
  if (!block || !profileId || !Array.isArray(block.accounts)) return block;
  return block.accounts.some((a) => a && a.id === profileId) ? { ...block, activeId: profileId } : block;
}

/** PowerShell that posts WM_APP_SETTINGS_UPDATED to every Usage Monitor window (top-level or set into the taskbar). */
function postScript() {
  return [
    'Add-Type -TypeDefinition @"',
    'using System; using System.Runtime.InteropServices; using System.Text;',
    'public static class AgentMeterPost {',
    '  delegate bool EnumProc(IntPtr h, IntPtr l);',
    '  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);',
    '  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr p, EnumProc f, IntPtr l);',
    '  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);',
    '  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);',
    '  public static int Post(string cls, uint msg) {',
    '    int n = 0;',
    '    EnumProc check = (h, l) => { var sb = new StringBuilder(64); GetClassName(h, sb, 64);',
    '      if (sb.ToString() == cls && PostMessage(h, msg, IntPtr.Zero, IntPtr.Zero)) n++; return true; };',
    '    EnumWindows((h, l) => { check(h, l); EnumChildWindows(h, check, IntPtr.Zero); return true; }, IntPtr.Zero);',
    '    return n;',
    '  }',
    '}',
    '"@',
    `[AgentMeterPost]::Post('${MONITOR_CLASS}', ${WM_APP_SETTINGS_UPDATED})`,
  ].join('\n');
}

/** Tell a running Usage Monitor to re-read its settings. cb(err, windowsPosted). */
function postSettingsUpdated(cb = () => {}, run = execFile) {
  const encoded = Buffer.from(postScript(), 'utf16le').toString('base64');
  run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, timeout: 20000 }, (err, stdout) => {
    if (err) return cb(err, 0);
    cb(null, Number.parseInt(String(stdout).trim(), 10) || 0);
  });
}

/**
 * Point the Usage Monitor at a profile: its "selected" account and, when
 * themes\agent-meter-<id>.json exists, that theme. Returns 'applied' (written, reload
 * posted), 'unchanged', or 'no-settings'.
 */
function applyToMonitor(appData, profileId, post = postSettingsUpdated) {
  const dir = path.join(appData, 'ClaudeCodeUsageMonitor');
  const file = path.join(dir, 'settings.json');
  let s;
  try {
    s = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return 'no-settings';
  }
  const claude = s && s.accounts && s.accounts.claude;
  if (!claude || typeof claude !== 'object') return 'no-settings';
  const theme = path.join(dir, 'themes', `agent-meter-${profileId}.json`);
  const useTheme = fs.existsSync(theme);
  const themeOk = !useTheme || (s.active_theme_path === theme && s.custom_theme_enabled === true);
  if (claude.selected === profileId && themeOk) return 'unchanged';
  claude.selected = profileId;
  if (useTheme) {
    s.active_theme_path = theme;
    s.custom_theme_enabled = true;
  }
  const tmp = file + '.agent-meter.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, file);
  post((err, n) => {
    if (err) log.warn('could not tell the Usage Monitor to reload', err.message);
    else log.info('Usage Monitor told to reload', { windows: n });
  });
  return 'applied';
}

class AccountFollower extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.appData
   * @param {boolean} [o.monitor]  also switch the Usage Monitor (off in tests and dev runs)
   * @param {Function} [o.post]    reload poster, injectable for tests
   */
  constructor({ appData, monitor = true, post = postSettingsUpdated }) {
    super();
    this.appData = appData;
    this.monitor = monitor;
    this.post = post;
    this.profileId = null;
    this.watcher = null;
    this.timer = null;
    this.recheck = null;
  }

  /** Re-read which account the app is using; emits 'change' with the profile id when it moves. */
  evaluate() {
    const newest = newestDesktopAccount(this.appData);
    const id = newest ? profileForAccount(this.appData, newest.accountUuid) : null;
    if (id === this.profileId) return id;
    this.profileId = id;
    log.info('following', { profile: id, account: newest ? newest.accountUuid.slice(0, 8) : null });
    if (id && this.monitor) {
      try {
        log.info('Usage Monitor', { profile: id, result: applyToMonitor(this.appData, id, this.post) });
      } catch (err) {
        log.warn('could not switch the Usage Monitor', err.message);
      }
    }
    this.emit('change', id);
    return id;
  }

  start() {
    this.evaluate();
    const later = () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.evaluate(), DEBOUNCE_MS);
    };
    try {
      this.watcher = fs.watch(sessionsRoot(this.appData), { recursive: true, persistent: false }, later);
      this.watcher.on('error', (err) => log.warn('session watch failed', err.message));
    } catch (err) {
      log.warn('cannot watch Claude app sessions', err.message);
    }
    this.recheck = setInterval(() => this.evaluate(), RECHECK_MS);
    this.recheck.unref?.();
    return this;
  }

  stop() {
    clearTimeout(this.timer);
    clearInterval(this.recheck);
    if (this.watcher) this.watcher.close();
    this.watcher = null;
  }
}

module.exports = {
  AccountFollower,
  newestDesktopAccount,
  folderAccount,
  profileForAccount,
  markActive,
  applyToMonitor,
  postSettingsUpdated,
  postScript,
  WM_APP_SETTINGS_UPDATED,
};
