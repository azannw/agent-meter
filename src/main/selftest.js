'use strict';
// --selftest <out.json>: drives open/close, the paint gate, the 140 ms hide,
// the margin and the error path on the REAL panel window, placed on a fake
// display at x = -20000 (no pixel on any monitor) and never focused, so the
// user sees nothing. Content comes from FakeHost, never from the worker.

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { screen } = require('electron');
const P = require('./position');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, timeoutMs, stepMs = 10) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (cond()) return true;
    await delay(stepMs);
  }
  return !!cond();
}

/** A display and a tray icon far off every real monitor. */
function offscreen() {
  const scaleFactor = screen.getPrimaryDisplay().scaleFactor;
  const display = {
    id: 990001,
    scaleFactor,
    bounds: { x: -20000, y: -20000, width: 2048, height: 1152 },
    workArea: { x: -20000, y: -20000, width: 2048, height: 1104 },
  };
  const trayBounds = { x: -20000 + 1500, y: -20000 + 1108, width: 32, height: 40 };
  let cursor = { x: -30000, y: -30000 };
  const screenApi = {
    getAllDisplays: () => [display],
    getPrimaryDisplay: () => display,
    getCursorScreenPoint: () => cursor,
  };
  return { display, trayBounds, screenApi, setCursor: (c) => (cursor = c) };
}

/** Stands in for WorkerHost: the test decides what the page gets. */
class FakeHost extends EventEmitter {
  constructor(appDir) {
    super();
    this.base = JSON.parse(fs.readFileSync(path.join(appDir, 'src', 'shared', 'mock-snapshot.json'), 'utf8'));
    this.snapshot = null;
    this.lastError = null;
  }
  start() {}
  stop() {}
  setPanelOpen() {}
  request() {
    return Promise.resolve();
  }
  setCostBasis() {
    return Promise.resolve();
  }
  getSnapshot() {
    return this.snapshot;
  }
  getState() {
    if (this.snapshot) return { snapshot: this.snapshot };
    if (this.lastError) return { error: this.lastError };
    return {};
  }
  publish(extraWarnings = []) {
    this.snapshot = { ...this.base, generatedAt: new Date().toISOString(), warnings: extraWarnings };
    this.lastError = null;
    this.emit('snapshot', this.snapshot, { example: false });
  }
  fail(message) {
    this.lastError = message;
    this.emit('engine-error', { message });
  }
}

async function run({ panel, host, quit, out, off }) {
  const results = [];
  const check = (name, ok, detail) => results.push({ name, ok: !!ok, ...(detail === undefined ? {} : { detail }) });
  const win = () => panel.win;
  const js = (s) => win().webContents.executeJavaScript(s);
  const tb = off.trayBounds;
  const heights = []; // [t, h] every height report
  panel.on('content-height', (h) => heights.push([Date.now(), h]));
  const timeout = setTimeout(() => {
    fs.writeFileSync(out, JSON.stringify({ timedOut: true, results }, null, 2));
    quit(1);
  }, 45_000);
  const settled = () => waitFor(() => panel.gateNow() === 'ready', 2000);

  try {
    await panel.loaded;
    host.publish();
    await settled();
    await delay(300);

    // 1. warm open: content painted while hidden -> shown at once, already the right size
    const t0 = Date.now();
    check('tray click while hidden opens', panel.handleTrayClick(tb) === 'shown');
    await waitFor(() => panel.state === 'shown', 1000);
    const warm = { clickToShownMs: panel.shownAt - t0, gate: panel.lastOpen };
    check('warm open: shown within 20 ms of the click', warm.clickToShownMs <= 20, warm);
    const rest = panel.restBounds();
    const got = win().getBounds();
    check('window = panel + 12 px margin each side (424 wide)', rest.window.width === 424 && rest.window.height === rest.height + 24 && Math.abs(got.width - 424) <= 3, { got, window: rest.window, panel: { x: rest.x, y: rest.y, w: rest.width, h: rest.height } });
    const d = off.display;
    check('panel bottom 12 px above the work area; window bottom on it', rest.y + rest.height === d.workArea.y + d.workArea.height - 12 && rest.window.y + rest.window.height === d.workArea.y + d.workArea.height);
    check('window is off every real monitor', screen.getAllDisplays().every((m) => got.x + got.width < m.bounds.x || got.x > m.bounds.x + m.bounds.width || got.y + got.height < m.bounds.y || got.y > m.bounds.y + m.bounds.height), got);
    check('never took focus', !win().isFocused());
    const vp = await js('({ w: innerWidth, h: innerHeight })');
    check('page viewport covers the window (424..425 x panel+24..+25: 1.3125 rounds up, never short)', vp.w >= 424 && vp.w <= 425 && vp.h >= panel.contentHeight + 24 && vp.h <= panel.contentHeight + 25, vp);
    await delay(400);
    check('the page entered (panel no longer concealed)', await js('!document.getElementById("app").classList.contains("is-concealed")'));

    // 2. close: hide sent now, window hidden 140 ms later
    const h0 = Date.now();
    win().webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    await waitFor(() => panel.state !== 'shown', 300);
    check('Esc starts the close', panel.state === 'hiding');
    await delay(70);
    const midway = win().isVisible();
    await waitFor(() => !win().isVisible(), 500, 2);
    const hiddenAfter = Date.now() - h0;
    check('window stays up for the exit, hidden ~140 ms after hide', midway && hiddenAfter >= 135 && hiddenAfter <= 220, { visibleAt70ms: midway, hiddenAfterMs: hiddenAfter });

    // 3. a toggle inside the 140 ms re-shows instead of leaving it hidden
    panel.handleTrayClick(tb);
    await waitFor(() => panel.state === 'shown', 1000);
    await delay(300);
    panel.hide('test-esc');
    await delay(40);
    const r3 = panel.handleTrayClick(tb);
    await delay(250);
    check('click inside the hide delay re-shows; window still up 250 ms later', r3 === 'shown' && panel.state === 'shown' && win().isVisible(), { r3, state: panel.state });
    await delay(300);

    // 4. pressing the icon while open: blur with the cursor on it, then the click -> stays closed
    off.setCursor({ x: tb.x + 16, y: tb.y + 20 });
    panel._onBlur();
    const r4 = panel.handleTrayClick(tb);
    await delay(200);
    check('the click that caused the blur is swallowed; closed', r4 === 'suppressed' && panel.state === 'hidden' && !win().isVisible(), { r4, state: panel.state });
    await delay(350);

    // 5. cold open: new, taller content arrives at the moment of the click
    host.publish(['Usage Monitor hasn’t updated limits for 2 h', 'A second line of warning text to grow the panel']);
    const t5 = Date.now();
    panel.handleTrayClick(tb);
    await waitFor(() => panel.state === 'shown', 1000);
    const cold = { clickToShownMs: panel.shownAt - t5, gate: panel.lastOpen };
    await delay(500);
    const lateHeights = heights.filter(([t]) => t > panel.shownAt).map(([, h]) => h);
    check('cold open waits for the paint and the new height, then no height change after showing', panel.lastOpen.reason === 'painted' && lateHeights.length === 0 && panel.lastOpen.height === panel.contentHeight, { ...cold, lateHeights, heightNow: panel.contentHeight });

    // 6. the transparent margin: click-through while the cursor is over it
    const w = panel.placed;
    off.setCursor({ x: w.x + 5, y: w.y + 200 });
    panel.hoverTick();
    const overMargin = panel.ignoring;
    off.setCursor({ x: w.x + 200, y: w.y + 200 });
    panel.hoverTick();
    const overPanel = panel.ignoring;
    off.setCursor({ x: w.x - 50, y: w.y + 200 });
    panel.hoverTick();
    const outside = panel.ignoring;
    check('margin ignores the mouse; panel and outside do not', overMargin && !overPanel && !outside, { overMargin, overPanel, outside });
    win().webContents.sendInputEvent({ type: 'mouseDown', x: 200, y: 200, button: 'left', clickCount: 1 });
    win().webContents.sendInputEvent({ type: 'mouseUp', x: 200, y: 200, button: 'left', clickCount: 1 });
    await delay(100);
    const afterPanelPress = panel.state;
    win().webContents.sendInputEvent({ type: 'mouseDown', x: 4, y: 200, button: 'left', clickCount: 1 });
    win().webContents.sendInputEvent({ type: 'mouseUp', x: 4, y: 200, button: 'left', clickCount: 1 });
    await waitFor(() => panel.state !== 'shown', 300);
    check('a press on the panel keeps it; a press on the margin closes it', afterPanelPress === 'shown' && panel.state === 'hiding', { afterPanelPress, afterMarginPress: panel.state });
    await delay(300);

    // 7. ten open/close cycles: no size creep
    for (let i = 0; i < 10; i++) {
      panel.show({ trayBounds: tb });
      await waitFor(() => panel.state === 'shown', 1000);
      panel.hide('cycle');
      await waitFor(() => panel.state === 'hidden', 500);
    }
    const after = win().getBounds();
    check('ten cycles: window size unchanged', Math.abs(after.width - 424) <= 3 && Math.abs(after.height - (panel.contentHeight + 24)) <= 3, after);

    // 8. no example data: before any snapshot, getSnapshot rejects with the engine's error
    host.snapshot = null;
    host.fail('The data engine stopped unexpectedly (exit code 1)');
    const answer = await js('window.meter.getSnapshot().then(() => "resolved", (e) => "rejected: " + e.message)');
    check('getSnapshot rejects with the error when there is no snapshot', /^rejected: .*exit code 1/.test(answer), answer);

    const passed = results.filter((r) => r.ok).length;
    fs.writeFileSync(out, JSON.stringify({ passed, total: results.length, results }, null, 2));
    console.log(`selftest ${passed}/${results.length} -> ${out}`);
    clearTimeout(timeout);
    quit(passed === results.length ? 0 : 1);
  } catch (err) {
    fs.writeFileSync(out, JSON.stringify({ crashed: String(err.stack || err), results }, null, 2));
    clearTimeout(timeout);
    quit(1);
  }
}

module.exports = { run, offscreen, FakeHost };
