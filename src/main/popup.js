'use strict';
// The panel window (CONTRACT section 8): transparent, frameless, no OS shadow,
// sized to the panel plus a 12 px margin on every side. The page draws the
// panel and plays its own entrance/exit; the window never moves while visible.
//
// Open:  place at rest while hidden -> wait until the page has painted the
//        current content and its height has settled -> show at full opacity ->
//        send show { edge }.
// Close: send hide -> the page plays its 120 ms exit -> hide the window 140 ms
//        later. A show inside those 140 ms cancels the hide.
// Margin: a transparent margin pixel counts as INSIDE on Windows (measured with
//        WindowFromPoint, 2026-10-03), so while visible a cursor poll makes the
//        window ignore the mouse over the margin (setIgnoreMouseEvents): an
//        outside click there reaches the window below, which blurs and closes us.

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { BrowserWindow, screen: electronScreen } = require('electron');
const P = require('./position');
const { gateState } = require('./gate');
const { createLogger } = require('./log');

const log = createLogger('popup');

const DEFAULT_PANEL_HEIGHT = 560;
const HIDE_DELAY_MS = 140; // the page's exit is 120 ms
const GATE_MAX_MS = 500; // never wait longer than this for the page
const GATE_QUIET_MS = 60; // no paint/height/resize for this long = settled (the page debounces height 40 ms)
const HOVER_POLL_MS = 16;
const BLUR_ON_TRAY_SUPPRESS_MS = 1000; // blur caused by pressing the tray icon itself
const BLUR_GENERIC_SUPPRESS_MS = 300; // blur from anything, then a click arriving right after
const STALE_BLUR_MS = 250;

class Panel extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.appDir
   * @param {boolean} [o.mock]         load the page with ?mock=1
   * @param {string} [o.tab]           ?tab= for captures
   * @param {string} [o.variant]       ?variant= (mock captures only)
   * @param {boolean} [o.pinned]       never hide on blur (capture / self-test)
   * @param {boolean} [o.headless]     never put the window on screen (captures)
   * @param {boolean} [o.activate]     false: showInactive, never take focus (self-test)
   * @param {object} [o.screenApi]     { getAllDisplays, getPrimaryDisplay, getCursorScreenPoint } (self-test: off-screen)
   * @param {Function} o.getTrayBounds () => Rectangle | null
   * @param {string} [o.icon]
   */
  constructor(o) {
    super();
    this.o = { activate: true, ...o };
    this.scr = o.screenApi || electronScreen;
    this.win = null;
    this.state = 'hidden'; // hidden | opening | shown | hiding
    this.contentHeight = DEFAULT_PANEL_HEIGHT; // PANEL height reported by the page
    this.heightReported = false;
    this.anchorTray = null;
    this.anchorDisplayId = null;
    this.placedDisplayId = null;
    this.placed = null; // window bounds last asked for
    this.edge = 'bottom';
    this.sizeFix = {}; // scaleFactor -> { dw, dh } DIP added so the page gets its full size
    this.gate = { loaded: false, contentSeq: 0, paintedSeq: -1, paintedAt: 0, lastHeightAt: 0, lastResizeAt: 0 };
    this.openTimer = null;
    this.openStartedAt = 0;
    this.hideTimer = null;
    this.hoverTimer = null;
    this.ignoring = false;
    this.suppressClickUntil = 0;
    this.shownAt = 0;
    this.blurRecheck = null;
    this.lastOpen = null; // { gateMs, reason } of the last reveal, for the self-test
    this.loaded = null;
  }

  create() {
    const win = new BrowserWindow({
      width: P.PANEL_WIDTH + 2 * P.WINDOW_MARGIN,
      height: this.contentHeight + 2 * P.WINDOW_MARGIN,
      show: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      backgroundColor: '#00000000',
      roundedCorners: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      title: 'Agent Meter',
      icon: this.o.icon,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: false,
        // The page must paint while hidden, so the window can be shown already
        // painted at the right height. Measured 2026-10-03: a hidden throttled
        // window produces 0 frames and no ResizeObserver callbacks; unthrottled,
        // 60 fps on demand and the same memory. Idle (nothing changing) = no frames.
        backgroundThrottling: false,
      },
    });
    this.win = win;
    // 'pop-up-menu' and up sit above the taskbar on Windows; 'floating'..'status' go behind it.
    win.setAlwaysOnTop(true, 'pop-up-menu');
    // Constant full opacity, never animated. It makes the window WS_EX_LAYERED once,
    // so setIgnoreMouseEvents only flips WS_EX_TRANSPARENT afterwards instead of
    // adding and removing the layered style every time the cursor crosses the margin.
    win.setOpacity(1);
    win.setMenu(null);

    win.on('blur', () => this._onBlur());
    win.on('close', (e) => {
      if (!this.allowClose) {
        e.preventDefault();
        this.hide('close');
      }
    });
    const wc = win.webContents;
    wc.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') {
        event.preventDefault();
        this.hide('esc');
      }
    });
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', (e) => e.preventDefault());
    wc.on('render-process-gone', (_e, details) => {
      log.error('renderer gone', details);
      if (!this.allowClose) setTimeout(() => this.load(), 1000);
    });
    this.load();
    return win;
  }

  load() {
    const index = path.join(this.o.appDir, 'src', 'renderer', 'index.html');
    const query = {};
    if (this.o.mock) query.mock = '1';
    if (this.o.tab) query.tab = this.o.tab;
    if (this.o.variant) query.variant = this.o.variant;
    const wc = this.win.webContents;
    this.gate.loaded = false;
    this.gate.paintedSeq = -1;
    this.loaded = new Promise((resolve) =>
      wc.once('did-finish-load', () => {
        this.gate.loaded = true;
        resolve();
      }),
    );
    if (fs.existsSync(index)) {
      wc.loadFile(index, { query }).catch((err) => log.error('load failed', err.message));
    } else {
      log.warn('renderer missing, loading placeholder', index);
      const html = `<!doctype html><meta charset="utf-8"><body style="margin:12px;font:14px 'Segoe UI';color:#ccc;background:#000;padding:24px">Agent Meter: src/renderer/index.html is not built yet.</body>`;
      wc.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    }
    return this.loaded;
  }

  get isVisible() {
    return this.state === 'opening' || this.state === 'shown';
  }

  get windowShown() {
    return this.state === 'shown' || this.state === 'hiding';
  }

  send(channel, ...args) {
    if (this.win && !this.win.isDestroyed() && !this.win.webContents.isDestroyed()) {
      this.win.webContents.send(channel, ...args);
    }
  }

  // ---- paint gate (fed by main.js) ---------------------------------------

  /** main.js sent the page new content (snapshot or error) numbered seq. */
  contentSent(seq) {
    this.gate.contentSeq = Math.max(this.gate.contentSeq, seq);
  }

  /** The page painted content seq (preload: two animation frames after applying it). */
  painted(seq) {
    if (typeof seq !== 'number') return;
    this.gate.paintedSeq = Math.max(this.gate.paintedSeq, seq);
    this.gate.paintedAt = Date.now();
  }

  gateNow() {
    return gateState({ ...this.gate, now: Date.now(), quietMs: GATE_QUIET_MS });
  }

  // ---- placement --------------------------------------------------------

  _display() {
    const displays = this.scr.getAllDisplays();
    const byId = displays.find((d) => d.id === this.anchorDisplayId);
    return byId || P.pickDisplay(displays, this.scr.getPrimaryDisplay(), this.anchorTray);
  }

  /** Panel rect at rest, plus the window rect around it. */
  restBounds() {
    const panel = P.panelBounds({ trayBounds: this.anchorTray, display: this._display(), height: this.contentHeight });
    return { ...panel, window: P.windowBoundsFor(panel) };
  }

  _anchor(trayBounds) {
    const tb = P.validRect(trayBounds) ? trayBounds : this.o.getTrayBounds();
    this.anchorTray = P.validRect(tb) ? tb : null;
    this.anchorDisplayId = P.pickDisplay(this.scr.getAllDisplays(), this.scr.getPrimaryDisplay(), this.anchorTray).id;
  }

  /** Put the window at rest. setBounds with the size spelled out, never setPosition (size creep). */
  _place() {
    const rest = this.restBounds();
    this.edge = rest.edge;
    const scale = this._display().scaleFactor;
    const fix = this.sizeFix[scale] || { dw: 0, dh: 0 };
    const b = { ...rest.window, width: rest.window.width + fix.dw, height: rest.window.height + fix.dh };
    // At a fractional scale (1.3125 here) getBounds rounds outward and setPosition
    // writes that size back: a 14-frame slide grew 400x560 to 425x577 (2026-10-02).
    this.win.setBounds(b);
    // Crossing into a display with another scale factor resizes the window once
    // more on WM_DPICHANGED; a second setBounds lands it at the asked size.
    if (this.placedDisplayId !== this.anchorDisplayId) {
      this.win.setBounds(b);
      this.placedDisplayId = this.anchorDisplayId;
    }
    if (!this.sizeFix[scale]) this._calibrate(scale);
    const resized = !this.placed || this.placed.width !== rest.window.width || this.placed.height !== rest.window.height;
    this.placed = { ...rest.window };
    if (resized) this.gate.lastResizeAt = Date.now(); // the page re-lays out; a pure move does not
    return rest;
  }

  /**
   * At 1.3125 a 400 DIP frameless window had a 524 px client (viewport 399).
   * Measure the shortfall once per scale factor and ask for that much more.
   */
  // Measured against the page's own viewport: getContentBounds rounds too, and
  // over-corrected the transparent window to 425 (2026-10-03).
  _calibrate(scale) {
    this.sizeFix[scale] = { dw: 0, dh: 0, pending: true };
    const measure = async () => {
      if (!this.gate.loaded) await this.loaded;
      await new Promise((r) => setTimeout(r, 80)); // let the resize reach the page
      if (!this.win || this.win.isDestroyed() || !this.placed) return;
      const vp = await this.win.webContents.executeJavaScript('({ w: innerWidth, h: innerHeight })');
      const dw = this.placed.width - vp.w;
      const dh = this.placed.height - vp.h;
      const fix = { dw: dw > 0 && dw <= 3 ? dw : 0, dh: dh > 0 && dh <= 3 ? dh : 0 };
      this.sizeFix[scale] = fix;
      log.info('size calibration', { scale, window: { w: this.placed.width, h: this.placed.height }, viewport: vp, fix });
      if (fix.dw || fix.dh) this._place();
    };
    measure().catch((err) => log.warn('size calibration failed', err.message));
  }

  // ---- show / hide ------------------------------------------------------

  show({ trayBounds } = {}) {
    if (!this.win || this.win.isDestroyed()) this.create();
    if (this.state === 'opening' || this.state === 'shown') {
      if (this.state === 'shown' && this.o.activate && !this.o.headless) this.win.focus();
      return;
    }
    if (this.state === 'hiding') {
      // re-shown inside the 140 ms exit: keep the window, play the entrance again
      clearTimeout(this.hideTimer);
      this.state = 'shown';
      this.shownAt = Date.now();
      this._setIgnore(false);
      this._startHover();
      if (this.o.activate && !this.o.headless) this.win.focus();
      this.send('meter:show', { edge: this.edge });
      log.info('show (re-shown during hide)');
      this.emit('visibility', true);
      return;
    }
    this._anchor(trayBounds);
    this.state = 'opening';
    this.openStartedAt = Date.now();
    this._place();
    this.emit('visibility', true);
    this._waitGate();
  }

  _waitGate() {
    clearTimeout(this.openTimer);
    if (this.state !== 'opening') return;
    const g = this.gateNow();
    const waited = Date.now() - this.openStartedAt;
    if (g === 'ready' || waited >= GATE_MAX_MS) return this._reveal(g === 'ready' ? 'painted' : `timeout (${g})`);
    this.openTimer = setTimeout(() => this._waitGate(), 8);
  }

  _reveal(reason) {
    this.state = 'shown';
    this.shownAt = Date.now();
    this.lastOpen = { gateMs: this.shownAt - this.openStartedAt, reason, height: this.contentHeight };
    if (!this.o.headless) {
      if (this.o.activate) {
        this.win.show();
        this.win.focus();
        // If focus was refused, blur would never fire and the panel would stay up.
        setTimeout(() => {
          if (this.state === 'shown' && !this.win.isDestroyed() && !this.win.isFocused()) this.win.focus();
        }, 120);
      } else {
        this.win.showInactive();
      }
      this._startHover();
    }
    this.send('meter:show', { edge: this.edge });
    log.info('show', { gateMs: this.lastOpen.gateMs, reason, window: this.placed, edge: this.edge });
  }

  hide(reason = 'api') {
    if (this.state === 'hidden' || this.state === 'hiding') return;
    clearTimeout(this.blurRecheck);
    if (this.state === 'opening') {
      clearTimeout(this.openTimer);
      this.state = 'hidden'; // the window was never shown
      log.info('hide before show', reason);
      this.emit('visibility', false);
      return;
    }
    this.state = 'hiding';
    this._stopHover();
    this._setIgnore(true); // clicks during the exit go to whatever is below
    this.send('meter:hide');
    this.hideTimer = setTimeout(() => this._finishHide(), HIDE_DELAY_MS);
    log.info('hide', reason);
    this.emit('visibility', false);
  }

  _finishHide() {
    if (this.state !== 'hiding') return;
    this.state = 'hidden';
    if (this.win && !this.win.isDestroyed()) {
      if (!this.o.headless) this.win.hide();
      this._setIgnore(false);
    }
  }

  /** Left click on the tray icon. Pressing it while open blurs the panel first; that must not reopen it. */
  handleTrayClick(trayBounds) {
    if (this.isVisible) {
      this.hide('tray');
      return 'hidden';
    }
    if (Date.now() < this.suppressClickUntil) {
      this.suppressClickUntil = 0;
      log.info('tray click swallowed: it is the click that just closed the panel');
      return 'suppressed';
    }
    this.show({ trayBounds });
    return 'shown';
  }

  /** The page saw a press on the transparent margin (the cursor poll had not caught up yet). */
  marginClick() {
    if (this.state !== 'shown') return;
    this.suppressClickUntil = Date.now() + BLUR_GENERIC_SUPPRESS_MS;
    this.hide('margin');
  }

  _onBlur() {
    if (this.state !== 'shown' || this.o.pinned) return;
    // A blur right after show() can be the late echo of the hide just before it.
    const sinceShow = Date.now() - this.shownAt;
    if (sinceShow < STALE_BLUR_MS) {
      clearTimeout(this.blurRecheck);
      this.blurRecheck = setTimeout(() => {
        if (this.state === 'shown' && this.win && !this.win.isDestroyed() && !this.win.isFocused()) this._onBlurNow();
      }, STALE_BLUR_MS - sinceShow);
      return;
    }
    this._onBlurNow();
  }

  _onBlurNow() {
    let overTray = false;
    try {
      const tb = this.o.getTrayBounds();
      const c = this._cursor();
      overTray = P.validRect(tb) && c.x >= tb.x - 4 && c.x <= tb.x + tb.width + 4 && c.y >= tb.y - 4 && c.y <= tb.y + tb.height + 4;
    } catch {
      overTray = false;
    }
    this.suppressClickUntil = Date.now() + (overTray ? BLUR_ON_TRAY_SUPPRESS_MS : BLUR_GENERIC_SUPPRESS_MS);
    this.hide(overTray ? 'blur-on-tray' : 'blur');
  }

  // ---- click-through margin ---------------------------------------------

  _cursor() {
    return (this.o.getCursor || (() => this.scr.getCursorScreenPoint()))();
  }

  _setIgnore(on) {
    if (!this.win || this.win.isDestroyed() || this.ignoring === on) return;
    this.ignoring = on;
    this.win.setIgnoreMouseEvents(on);
  }

  hoverTick() {
    if (this.state !== 'shown') return;
    let zone = 'outside';
    try {
      zone = P.hitZone(this.placed, this._cursor());
    } catch {
      zone = 'outside';
    }
    this._setIgnore(zone === 'margin');
  }

  _startHover() {
    if (this.hoverTimer || this.o.headless) return;
    this.hoverTick();
    this.hoverTimer = setInterval(() => this.hoverTick(), HOVER_POLL_MS);
  }

  _stopHover() {
    clearInterval(this.hoverTimer);
    this.hoverTimer = null;
  }

  // ---- size -------------------------------------------------------------

  /** px is the PANEL height; the window adds the margins. */
  setContentHeight(px) {
    if (typeof px !== 'number' || !Number.isFinite(px) || px < 0) return;
    const h = Math.ceil(px);
    this.gate.lastHeightAt = Date.now();
    const changed = h !== this.contentHeight || !this.heightReported;
    this.heightReported = true;
    this.contentHeight = h;
    if (!changed || !this.win || this.win.isDestroyed()) return;
    this.emit('content-height', h);
    if (!this.anchorDisplayId) this._anchor(null);
    this._place();
  }

  /** Displays changed (resolution, scale, taskbar moved): place it again. */
  reanchor() {
    if (!this.win || this.win.isDestroyed()) return;
    this._anchor(this.o.getTrayBounds());
    this._place();
  }

  destroy() {
    this.allowClose = true;
    clearTimeout(this.openTimer);
    clearTimeout(this.hideTimer);
    this._stopHover();
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }
}

module.exports = { Panel, HIDE_DELAY_MS, GATE_MAX_MS, GATE_QUIET_MS };
