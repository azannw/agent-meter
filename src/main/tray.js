'use strict';
// Notification-area icon: the weekly use of the account the Claude app is using
// (else the default profile) as a number on a graphite tile (see icon.js), drawn at
// runtime, plus the tooltip (every account) and the right-click menu.

const { execFile } = require('node:child_process');
const { Tray, Menu, nativeImage, nativeTheme, screen } = require('electron');
const { trayIconRGBA } = require('./icon');
const { encodePNG } = require('./png');
const { gaugeOf, tooltipOf } = require('./summary');
const { createLogger } = require('./log');

const log = createLogger('tray');

// Tray icon sizes Windows asks for per display scale (SM_CXSMICON).
const SCALES = [1, 1.25, 1.5, 1.75, 2, 2.5, 3];

/**
 * Multi-representation image for the tray. Electron's Windows tray turns the
 * image into an HICON from the representation CLOSEST TO 1x (NativeImage::
 * GetHICON -> gfx::Image::AsBitmap), not the one for the current scale. So the
 * set starts at the tray's real scale: at 125% the closest-to-1x entry is the
 * 20 px drawing, which is exactly what the shell shows, and nothing is resampled.
 * Larger scales stay in the set for any consumer that does pick by scale.
 */
function buildTrayImage(state, trayScale, displayScale = trayScale) {
  const img = nativeImage.createEmpty();
  const scales = [...new Set([trayScale, ...SCALES.filter((s) => s > trayScale)])];
  const pngs = new Map();
  for (const scale of scales) {
    const px = Math.round(16 * scale);
    const png = encodePNG(px, px, trayIconRGBA(px, state));
    pngs.set(scale, png);
    img.addRepresentation({ scaleFactor: scale, width: px, height: px, buffer: png });
  }
  // Chromium's display scale can include the text-size factor (1.3125 here).
  // A consumer asking for exactly that scale would otherwise get the NEXT
  // larger drawing (24 px, measured); give it the tray-size pixels instead.
  if (!scales.includes(displayScale)) {
    const px = Math.round(16 * trayScale);
    img.addRepresentation({ scaleFactor: displayScale, width: px, height: px, buffer: pngs.get(trayScale) });
  }
  return img;
}

function readRegDword(key, name) {
  return new Promise((resolve) => {
    execFile('reg', ['query', key, '/v', name], { windowsHide: true, timeout: 3000 }, (err, stdout) => {
      if (err) return resolve(null);
      const m = new RegExp(`${name}\\s+REG_DWORD\\s+0x([0-9a-f]+)`, 'i').exec(stdout);
      resolve(m ? parseInt(m[1], 16) : null);
    });
  });
}

const readLightTaskbar = () =>
  readRegDword('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize', 'SystemUsesLightTheme').then((v) => v === 1);

// Settings > Accessibility > Text size. Chromium folds it into the display
// scale factor (this laptop: 125 % display x 105 % text = 1.3125), but the
// taskbar draws notify icons at the monitor DPI alone (20 px at 125 %).
const readTextScale = () =>
  readRegDword('HKCU\\Software\\Microsoft\\Accessibility', 'TextScaleFactor').then((v) => (v >= 100 && v <= 225 ? v / 100 : 1));

/**
 * The snapshot the tooltip describes: providers with `available: false` (no
 * data at all, e.g. a Codex login unused inside the range) are left out, so
 * the tooltip never names a provider the panel does not show.
 */
function tooltipSnapshot(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.providers)) return snapshot;
  const providers = snapshot.providers.filter((p) => !(p && p.available === false));
  return providers.length === snapshot.providers.length ? snapshot : { ...snapshot, providers };
}

/** Icon scale for the tray: display scale without the text-size factor, snapped to Windows' 25 % steps. */
function trayScaleFor(displayScale, textScale) {
  const raw = (displayScale || 1) / (textScale || 1);
  const snapped = Math.round(raw * 4) / 4;
  return Math.abs(snapped - raw) < 0.03 ? snapped : raw;
}

class TrayController {
  /**
   * @param {object} h handlers: onToggle(bounds), onHover(), onOpen(), onRefresh(), onQuit(),
   *                   getAutostart(): boolean, setAutostart(on)
   */
  constructor(h) {
    this.h = h;
    this.tray = null;
    this.snapshot = null;
    this.opts = {};
    this.lightTaskbar = false;
    this.lastKey = null;
    this.lastTip = null;
  }

  create() {
    this.textScale = 1;
    this.trayScale = trayScaleFor(screen.getPrimaryDisplay().scaleFactor, this.textScale);
    this.tray = new Tray(buildTrayImage({ pct: null, tone: 'none' }, this.trayScale, screen.getPrimaryDisplay().scaleFactor));
    this.tray.setToolTip(tooltipOf(null));
    this.tray.on('click', (_event, bounds) => this.h.onToggle(bounds));
    this.tray.on('right-click', () => this.popUpMenu());
    // The pointer resting on the icon usually means a click is coming: refresh now, so the
    // panel opens on current numbers (WorkerHost.prewarm is throttled and cheap to call).
    if (this.h.onHover) this.tray.on('mouse-move', () => this.h.onHover());
    Promise.all([readLightTaskbar(), readTextScale()]).then(([light, textScale]) => {
      this.lightTaskbar = light;
      this.textScale = textScale;
      this.trayScale = trayScaleFor(screen.getPrimaryDisplay().scaleFactor, textScale);
      log.info('tray icon', { px: Math.round(16 * this.trayScale), trayScale: this.trayScale, textScale, lightTaskbar: light });
      this.render(true);
    });
    nativeTheme.on('updated', () =>
      readLightTaskbar().then((light) => {
        this.lightTaskbar = light;
        this.render(true);
      }),
    );
    screen.on('display-metrics-changed', () => {
      const s = trayScaleFor(screen.getPrimaryDisplay().scaleFactor, this.textScale);
      if (s !== this.trayScale) {
        this.trayScale = s;
        this.render(true);
      }
    });
    return this.tray;
  }

  getBounds() {
    try {
      return this.tray ? this.tray.getBounds() : null;
    } catch {
      return null;
    }
  }

  /** opts: { progress, example } */
  update(snapshot, opts = {}) {
    if (snapshot !== undefined) this.snapshot = snapshot;
    this.opts = { ...this.opts, ...opts };
    this.render(false);
  }

  render(force) {
    if (!this.tray || this.tray.isDestroyed()) return;
    const gauge = this.snapshot ? gaugeOf(this.snapshot) : { pct: null, tone: 'none' };
    const pct = gauge.pct == null ? null : Math.round(gauge.pct);
    const key = `${pct}|${gauge.tone}|${this.lightTaskbar}|${this.trayScale}`;
    if (force || key !== this.lastKey) {
      this.lastKey = key;
      this.tray.setImage(buildTrayImage({ pct, tone: gauge.tone, lightTaskbar: this.lightTaskbar }, this.trayScale, screen.getPrimaryDisplay().scaleFactor));
    }
    const tip = tooltipOf(tooltipSnapshot(this.snapshot), this.opts);
    if (tip !== this.lastTip) {
      this.lastTip = tip;
      this.tray.setToolTip(tip);
      log.info('tray state', { tooltip: tip, gauge: { pct, tone: gauge.tone } });
    }
  }

  popUpMenu() {
    const menu = Menu.buildFromTemplate([
      { label: 'Open', click: () => this.h.onOpen() },
      { label: 'Refresh now', click: () => this.h.onRefresh() },
      { type: 'separator' },
      {
        label: 'Start with Windows',
        type: 'checkbox',
        checked: this.h.getAutostart(),
        click: (item) => this.h.setAutostart(item.checked),
      },
      { type: 'separator' },
      { label: 'Quit', click: () => this.h.onQuit() },
    ]);
    this.tray.popUpContextMenu(menu);
  }

  destroy() {
    if (this.tray && !this.tray.isDestroyed()) this.tray.destroy();
    this.tray = null;
  }
}

module.exports = { TrayController, buildTrayImage, trayScaleFor, tooltipSnapshot };
