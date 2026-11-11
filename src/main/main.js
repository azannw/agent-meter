'use strict';
// Agent Meter main process: single instance, tray, panel, data worker, IPC.
//
// Flags
//   --show                 open the panel at start
//   --mock                 load the page with ?mock=1 and skip the worker (the ONLY
//                          way example data is ever shown)
//   --capture <out.png>    show the panel on an off-screen fake display (never on a
//                          monitor, never focused), wait for the painted snapshot (or
//                          error), a settled height and the end of the entrance, write
//                          capturePage() as PNG, exit 0 (exit 1 after 30 s)
//   --selftest <out.json>  drive open/close/gate/margin logic on an OFF-SCREEN,
//                          never-focused window and report
//   --tab overview|claude|codex   open on that tab (captures)
//   --variant <name>       with --mock: one of the edge-case snapshots in renderer/dev/variants.js
//   --quit                 ask the running instance to quit
//
// Dev runs (--capture, --selftest) keep everything apart from the user's copy:
// Chromium session data, the worker's state (scan index, ledger) and the log go
// to %TEMP%\agent-meter-dev-*, persistent across dev runs.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, ipcMain, Menu, shell, screen, utilityProcess } = require('electron');

const APP_DIR = path.resolve(__dirname, '..', '..');
const APP_NAME = 'Agent Meter';
const APP_ID = 'AgentMeter.Tray';
const CAPTURE_TIMEOUT_MS = 30_000;
const CAPTURE_QUIET_MS = 700;
const DEV_STATE_DIR = path.join(os.tmpdir(), 'agent-meter-dev-state');

// ---- flags ---------------------------------------------------------------

function parseFlags(argv) {
  const f = { show: false, mock: false, quit: false, capture: null, selftest: null, tab: null, variant: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = (name) => {
      if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3);
      if (a === `--${name}` && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[++i];
      return null;
    };
    if (a === '--show') f.show = true;
    else if (a === '--mock') f.mock = true;
    else if (a === '--quit') f.quit = true;
    else if (a.startsWith('--capture')) f.capture = value('capture');
    else if (a.startsWith('--selftest')) f.selftest = value('selftest') || path.join(os.tmpdir(), 'agent-meter-selftest.json');
    else if (a.startsWith('--tab')) f.tab = value('tab');
    else if (a.startsWith('--variant')) f.variant = value('variant');
  }
  return f;
}

const flags = parseFlags(process.argv.slice(1));
const devRun = !!(flags.capture || flags.selftest);

// Footprint. Measured 2026-10-03 on this laptop with the panel page loaded: Chromium's GPU
// process held ~105 MB private and the network service ~12 MB, for a 400 px panel that
// needs neither (no WebGL, nothing fetched). Software compositing, with the compositor
// thread and the network service inside this process: 4 processes / 182 MB private ->
// 2 processes / 72 MB, and the entrance animation still gets every frame.
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('in-process-gpu');
app.commandLine.appendSwitch('enable-features', 'NetworkServiceInProcess2');

app.setName(APP_NAME);
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);
if (devRun) app.setPath('sessionData', path.join(os.tmpdir(), 'agent-meter-dev-session'));
const STATE_DIR = devRun ? DEV_STATE_DIR : app.getPath('userData');

const logger = require('./log');
logger.init(path.join(STATE_DIR, 'logs'));
const log = logger.createLogger('main');

// Single instance. Dev runs do not take part: they must work while the user's
// copy is running, and quit on their own.
if (!devRun) {
  const gotLock = app.requestSingleInstanceLock({ argv: process.argv.slice(1) });
  if (!gotLock) {
    log.info('another instance is running; handing over', process.argv.slice(1));
    // The hand-over already happened inside requestSingleInstanceLock. exit()
    // rather than quit(): leave before Chromium starts a GPU process.
    app.exit(0);
    return;
  }
}

if (flags.quit && !devRun) {
  app.exit(0); // we got the lock, so nothing else was running
  return;
}

const settings = require('./settings');
const { Panel } = require('./popup');
const { TrayController } = require('./tray');
const { WorkerHost } = require('./worker-host');
const { AccountFollower } = require('./follow-account');

let panel = null;
let tray = null;
let host = null;
let follower = null; // the account the Claude app is using (follow-account.js)
let quitting = false;
let contentSeq = 0; // numbers every snapshot/error handed to the page (paint gate)
const rendererState = { loadedAt: 0, lastHeightAt: 0 };

function iconPath() {
  const ico = path.join(APP_DIR, 'assets', 'icon.ico');
  return fs.existsSync(ico) ? ico : undefined;
}

function quit(code = 0) {
  if (quitting) return;
  quitting = true;
  log.info('quitting', code);
  try {
    if (follower) follower.stop();
    if (host) host.stop();
    if (tray) tray.destroy();
    if (panel) panel.destroy();
  } catch (err) {
    log.error('cleanup failed', err);
  }
  if (code === 0) app.quit();
  else app.exit(code);
}

app.on('second-instance', (_event, argv) => {
  const f = parseFlags(argv.slice(1));
  if (f.capture || f.selftest) return;
  if (f.quit) return quit(0);
  if (panel) panel.show({ trayBounds: tray && tray.getBounds() });
});

// A tray app keeps running with no windows; it quits only from the menu or the UI.
app.on('window-all-closed', () => {});
app.on('before-quit', () => {
  quitting = true;
  if (panel) panel.allowClose = true;
});

function fromPanel(event) {
  return !!(panel && panel.win && !panel.win.isDestroyed() && event.sender === panel.win.webContents);
}

/** Hand the page new content and number it, so the gate can wait for its paint. */
function pushContent(channel, payload) {
  if (!rendererState.loadedAt) return; // the page pulls it with getSnapshot on load
  contentSeq += 1;
  panel.contentSent(contentSeq);
  panel.send(channel, payload, contentSeq);
}

function wireIpc() {
  ipcMain.handle('meter:get-snapshot', (event) => {
    if (!fromPanel(event)) return null;
    const st = host ? host.getState() : {};
    if (st.snapshot) return { snapshot: st.snapshot, seq: contentSeq };
    if (st.error) return { error: st.error, seq: contentSeq };
    return { snapshot: null, seq: contentSeq }; // first scan still running
  });
  ipcMain.on('meter:painted', (event, seq) => {
    if (fromPanel(event)) panel.painted(seq);
  });
  ipcMain.on('meter:margin-click', (event) => {
    if (fromPanel(event)) panel.marginClick();
  });
  ipcMain.handle('meter:refresh', async (event) => {
    if (!fromPanel(event) || !host) return;
    await host.request({ force: true, reason: 'ui' });
  });
  ipcMain.on('meter:set-content-height', (event, px) => {
    if (!fromPanel(event) || typeof px !== 'number' || !Number.isFinite(px)) return;
    rendererState.lastHeightAt = Date.now();
    panel.setContentHeight(px);
  });
  ipcMain.on('meter:open-external', (event, url) => {
    if (!fromPanel(event) || typeof url !== 'string') return;
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }
    if (parsed.protocol !== 'https:') return;
    shell.openExternal(parsed.href).catch((err) => log.warn('openExternal failed', err.message));
    panel.hide('external');
  });
  ipcMain.handle('meter:get-settings', (event) => {
    if (!fromPanel(event)) return null;
    return { autostart: settings.getAutostart(), version: app.getVersion(), costBasis: settings.getCostBasis() };
  });
  ipcMain.handle('meter:set-autostart', (event, on) => {
    if (!fromPanel(event) || typeof on !== 'boolean') return;
    settings.setAutostart(on);
  });
  ipcMain.handle('meter:set-cost-basis', async (event, basis) => {
    if (!fromPanel(event) || !settings.COST_BASES.includes(basis)) return;
    if (!devRun) settings.setCostBasis(basis);
    if (host) await host.setCostBasis(basis);
  });
  ipcMain.on('meter:quit', (event) => {
    if (fromPanel(event)) quit(0);
  });
}

function startHost() {
  if (flags.selftest) {
    host = new (require('./selftest').FakeHost)(APP_DIR);
  } else {
    host = new WorkerHost({
      appDir: APP_DIR,
      stateDir: STATE_DIR,
      fork: (...a) => utilityProcess.fork(...a),
      mock: flags.mock,
      costBasis: settings.getCostBasis(),
      activeAccount: () => (follower ? follower.profileId : null),
    });
  }
  host.on('snapshot', (snap, { example }) => {
    tray.update(snap, { example, progress: null, error: false });
    pushContent('meter:snapshot', snap);
  });
  host.on('engine-error', (err) => {
    // No snapshot yet: the page shows "Could not read usage"; after one: a quiet stale note.
    if (!host.getSnapshot()) tray.update(null, { error: true, progress: null });
    pushContent('meter:error', { message: err.message });
  });
  host.on('progress', (p) => {
    panel.send('meter:progress', p);
    if (!host.getSnapshot()) tray.update(undefined, { progress: p, error: false });
  });
  host.start();
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  settings.init(APP_DIR);
  log.info('start', { version: app.getVersion(), electron: process.versions.electron, flags, appDir: APP_DIR, stateDir: STATE_DIR });

  tray = new TrayController({
    onToggle: (bounds) => panel.handleTrayClick(bounds),
    onHover: () => host && host.prewarm(),
    onOpen: () => panel.show({ trayBounds: tray.getBounds() }),
    onRefresh: () => host && host.request({ force: true, reason: 'menu' }),
    onQuit: () => quit(0),
    getAutostart: () => settings.getAutostart(),
    setAutostart: (on) => settings.setAutostart(on),
  });
  tray.create();

  // Dev runs put the real window on a fake display far off every monitor and never focus
  // it. A capture used to keep the window hidden instead, but a hidden window stops
  // compositing: capturePage then returned a frame from the middle of the entrance fade.
  const off = devRun ? require('./selftest').offscreen() : null;
  panel = new Panel({
    appDir: APP_DIR,
    mock: flags.mock && !flags.selftest,
    tab: flags.tab,
    variant: flags.mock ? flags.variant : null,
    pinned: !!flags.capture,
    activate: !devRun, // a dev run never takes focus from the user
    screenApi: off ? off.screenApi : undefined,
    getTrayBounds: () => (off ? off.trayBounds : tray.getBounds()),
    icon: iconPath(),
  });
  panel.create();
  panel.on('visibility', (open) => host && host.setPanelOpen(open));
  panel.win.webContents.on('did-finish-load', () => {
    rendererState.loadedAt = Date.now();
  });
  panel.win.webContents.on('console-message', (details) => {
    if (details && (details.level === 'error' || details.level === 'warning')) {
      log.warn('renderer console', details.level, details.message, details.sourceId ? `${details.sourceId}:${details.lineNumber}` : '');
    }
  });

  wireIpc();
  // Dev runs and the example data follow no account and never touch the Usage Monitor.
  if (!devRun && !flags.mock) {
    follower = new AccountFollower({ appData: app.getPath('appData') });
    follower.on('change', () => host && host.refreshActive());
    follower.start();
  }
  startHost();

  const reanchor = () => panel && panel.isVisible && panel.reanchor();
  screen.on('display-metrics-changed', reanchor);
  screen.on('display-added', reanchor);
  screen.on('display-removed', reanchor);

  if (!devRun) settings.reconcileAutostart();

  if (flags.capture) return runCapture();
  if (flags.selftest) return require('./selftest').run({ panel, host, quit, out: flags.selftest, off });
  if (flags.show) {
    await Promise.race([panel.loaded, delay(3000)]);
    panel.show({ trayBounds: tray.getBounds() });
  }
});

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- capture (headless: the window never reaches the screen) ---------------

async function runCapture() {
  const out = path.resolve(flags.capture);
  const timer = setTimeout(() => {
    log.error('capture timed out', { contentSeq, gate: panel.gate });
    quit(1);
  }, CAPTURE_TIMEOUT_MS);
  try {
    await panel.loaded;
    // something to show: a snapshot, or the error state (mock mode renders its own)
    while (!flags.mock && !(host.getSnapshot() || host.getState().error)) await delay(100);
    await delay(50);
    panel.show({ trayBounds: panel.o.getTrayBounds() });
    const running = () => panel.win.webContents.executeJavaScript('document.getAnimations().filter((a) => a.playState === "running").length');
    for (;;) {
      const t = Date.now();
      const quiet = t - Math.max(rendererState.lastHeightAt, panel.gate.paintedAt, panel.shownAt) >= CAPTURE_QUIET_MS;
      if (panel.state === 'shown' && panel.gate.paintedSeq >= contentSeq && quiet && (await running()) === 0) break;
      await delay(100);
    }
    const img = await panel.win.webContents.capturePage();
    const png = img.toPNG();
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, png);
    const info = { out, bytes: png.length, size: img.getSize(), panelHeight: panel.contentHeight, window: panel.placed, gate: panel.lastOpen };
    log.info('capture written', info);
    console.log(JSON.stringify(info));
    clearTimeout(timer);
    quit(0);
  } catch (err) {
    log.error('capture failed', err);
    clearTimeout(timer);
    quit(1);
  }
}

module.exports = { parseFlags };
