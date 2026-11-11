'use strict';
// Following the account the Claude desktop app is using: which account wrote last,
// which Usage Monitor profile that is, what the panel shows, and how the Monitor is
// switched (settings + one reload message), all against temporary folders.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const F = require('../follow-account');
const { WorkerHost } = require('../worker-host');

const ACME = '11111111-1111-4111-8111-111111111111';
const GMAIL = '22222222-2222-4222-8222-222222222222';
const ORG = '33333333-3333-4333-8333-333333333333';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'am-follow-'));
}
function session(appData, account, name, mtimeSec) {
  const dir = path.join(appData, 'Claude', 'claude-code-sessions', account, ORG);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, name);
  fs.writeFileSync(f, '{}');
  fs.utimesSync(f, mtimeSec, mtimeSec);
}
function login(home, folder, accountUuid) {
  const dir = path.join(home, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ numStartups: 3, oauthAccount: accountUuid ? { accountUuid, emailAddress: 'x@example.com' } : undefined }));
  return dir;
}
function monitor(appData, profiles, extra = {}) {
  const dir = path.join(appData, 'ClaudeCodeUsageMonitor');
  fs.mkdirSync(path.join(dir, 'themes'), { recursive: true });
  const s = { poll_interval_ms: 60000, custom_theme_enabled: true, active_theme_path: 'C:\\themes\\two-columns.json', accounts: { claude: { profiles, selected: 'default' } }, ...extra };
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(s, null, 2));
  return dir;
}
const readSettings = (appData) => JSON.parse(fs.readFileSync(path.join(appData, 'ClaudeCodeUsageMonitor', 'settings.json'), 'utf8'));

/** Two logins, the Monitor set up for both, the app last used on `last`. */
function world(last = ACME) {
  const root = tmp();
  const acme = login(root, '.claude-acme', ACME);
  const gmail = login(root, '.claude-gmail', GMAIL);
  monitor(root, [
    { id: 'default', name: 'Subscription 1', config_dir: acme, enabled: true },
    { id: 'account_1', name: 'Subscription 2', config_dir: gmail, enabled: true },
  ]);
  const t = 1790900000;
  session(root, ACME, 'local_a.json', last === ACME ? t + 60 : t);
  session(root, GMAIL, 'local_b.json', last === GMAIL ? t + 60 : t);
  return root;
}

test('the account in use is the one whose session file the Claude app wrote last', () => {
  const root = tmp();
  try {
    assert.equal(F.newestDesktopAccount(root), null, 'no app data: no account');
    session(root, ACME, 'local_1.json', 1000);
    session(root, ACME, 'local_2.json', 3000);
    session(root, GMAIL, 'local_3.json', 2000);
    session(root, GMAIL, 'notes.txt', 9000); // not a session file
    session(root, 'skills-plugin', 'local_4.json', 9000); // not an account folder
    assert.deepEqual(F.newestDesktopAccount(root), { accountUuid: ACME, at: 3000 * 1000 });
    session(root, GMAIL, 'local_5.json', 4000);
    assert.equal(F.newestDesktopAccount(root).accountUuid, GMAIL);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the Monitor profile is the one whose login folder names that account', () => {
  const root = world();
  try {
    assert.equal(F.profileForAccount(root, ACME), 'default');
    assert.equal(F.profileForAccount(root, GMAIL.toUpperCase()), 'account_1', 'case does not matter');
    assert.equal(F.profileForAccount(root, '11111111-2222-3333-4444-555555555555'), null, 'an account no profile is signed in to');
    assert.equal(F.profileForAccount(root, null), null);
    // a disabled profile is never followed
    const s = readSettings(root);
    s.accounts.claude.profiles[1].enabled = false;
    fs.writeFileSync(path.join(root, 'ClaudeCodeUsageMonitor', 'settings.json'), JSON.stringify(s));
    assert.equal(F.profileForAccount(root, GMAIL), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a login folder that signs in to another account is read again', () => {
  const root = tmp();
  try {
    const dir = login(root, '.claude-x', ACME);
    assert.equal(F.folderAccount(dir), ACME);
    login(root, '.claude-x', GMAIL);
    const f = path.join(dir, '.claude.json');
    fs.utimesSync(f, new Date(), new Date(Date.now() + 5000));
    assert.equal(F.folderAccount(dir), GMAIL);
    fs.writeFileSync(f, 'not json');
    fs.utimesSync(f, new Date(), new Date(Date.now() + 10000));
    assert.equal(F.folderAccount(dir), null, 'unreadable: no account');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the panel keeps every account; the followed one is named in activeId', () => {
  const block = { updatedAt: null, source: 'x', accounts: [{ id: 'default' }, { id: 'account_1' }], warnings: [] };
  const marked = F.markActive(block, 'account_1');
  assert.equal(marked.activeId, 'account_1');
  assert.deepEqual(marked.accounts, block.accounts, 'both accounts stay');
  assert.equal(F.markActive(block, null), block);
  assert.equal(F.markActive(block, 'account_9'), block, 'not in the block: no activeId');
  assert.equal(F.markActive(null, 'default'), null);
  assert.equal('activeId' in block, false, 'the block itself is not modified');
});

test('switching the Monitor writes its selected profile and that profile theme, then posts one reload', () => {
  const root = world();
  try {
    const themes = path.join(root, 'ClaudeCodeUsageMonitor', 'themes');
    fs.writeFileSync(path.join(themes, 'agent-meter-account_1.json'), '{}');
    let posts = 0;
    const post = () => posts++;
    assert.equal(F.applyToMonitor(root, 'account_1', post), 'applied');
    let s = readSettings(root);
    assert.equal(s.accounts.claude.selected, 'account_1');
    assert.equal(s.active_theme_path, path.join(themes, 'agent-meter-account_1.json'));
    assert.equal(s.custom_theme_enabled, true);
    assert.equal(s.poll_interval_ms, 60000, 'other settings kept');
    assert.equal(s.accounts.claude.profiles.length, 2, 'profiles kept');
    assert.equal(posts, 1);
    assert.equal(F.applyToMonitor(root, 'account_1', post), 'unchanged');
    assert.equal(posts, 1, 'nothing to say: no reload');
    // no theme for this profile: only the selection changes
    assert.equal(F.applyToMonitor(root, 'default', post), 'applied');
    s = readSettings(root);
    assert.equal(s.accounts.claude.selected, 'default');
    assert.equal(s.active_theme_path, path.join(themes, 'agent-meter-account_1.json'));
    assert.equal(posts, 2);
    assert.equal(fs.existsSync(path.join(root, 'ClaudeCodeUsageMonitor', 'settings.json.agent-meter.tmp')), false, 'no temp file left');
    const empty = tmp();
    assert.equal(F.applyToMonitor(empty, 'default', post), 'no-settings');
    fs.rmSync(empty, { recursive: true, force: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the follower says so once per switch, and switches the Monitor only when asked to', () => {
  const root = world(ACME);
  try {
    let posts = 0;
    const f = new F.AccountFollower({ appData: root, post: () => posts++ });
    const seen = [];
    f.on('change', (id) => seen.push(id));
    assert.equal(f.evaluate(), 'default');
    assert.equal(f.evaluate(), 'default');
    session(root, GMAIL, 'local_b.json', 1790900000 + 120);
    assert.equal(f.evaluate(), 'account_1');
    assert.deepEqual(seen, ['default', 'account_1']);
    assert.equal(readSettings(root).accounts.claude.selected, 'account_1');
    assert.equal(posts, 1, 'selected was already "default": one reload, for the switch');

    const other = world(GMAIL);
    try {
      const quiet = new F.AccountFollower({ appData: other, monitor: false, post: () => posts++ });
      assert.equal(quiet.evaluate(), 'account_1');
      assert.equal(posts, 1, 'monitor: false never writes or posts');
      assert.equal(readSettings(other).accounts.claude.selected, 'default');
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the reload message is WM_APP + 5 to every ClaudeCodeUsageMonitor window', () => {
  assert.equal(F.WM_APP_SETTINGS_UPDATED, 0x8005);
  const s = F.postScript();
  assert.match(s, /\[AgentMeterPost\]::Post\('ClaudeCodeUsageMonitor', 32773\)/);
  assert.match(s, /EnumChildWindows/, 'finds it inside the taskbar too');
});

test('the worker host keeps both accounts and republishes the active one on a switch', () => {
  const block = { updatedAt: null, source: 'Claude Code Usage Monitor', accounts: [{ id: 'default', windows: [] }, { id: 'account_1', windows: [] }], warnings: [] };
  let active = 'default';
  const dir = tmp();
  const host = new WorkerHost({ appDir: dir, stateDir: dir, fork: () => null, readLimits: () => block, watchLimits: false, activeAccount: () => active });
  assert.equal(host._freshLimits().activeId, 'default');
  host.snapshot = { schemaVersion: 1, overview: {}, providers: [{ id: 'claude', limits: block }] };
  const published = [];
  host.on('snapshot', (snap) => {
    const l = snap.providers[0].limits;
    published.push([l.accounts.map((a) => a.id).join('+'), l.activeId || null]);
  });
  assert.equal(host.refreshActive(), true);
  active = 'account_1';
  assert.equal(host.refreshActive(), true);
  assert.equal(host.refreshActive(), false, 'no switch: nothing published');
  active = null;
  host.refreshActive();
  assert.deepEqual(published, [
    ['default+account_1', 'default'],
    ['default+account_1', 'account_1'],
    ['default+account_1', null],
  ]);
  host.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});
