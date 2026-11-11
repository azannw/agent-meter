'use strict';
// window.meter, CONTRACT section 5 (plus the optional setCostBasis). Sandboxed
// preload: only contextBridge and ipcRenderer, nothing else is exposed.
// Bad arguments throw a TypeError in the page, so a UI bug is loud, not silent.
//
// Two things happen here that the page never sees:
// - paint acks: after a snapshot/error has been handed to the page, two
//   animation frames later the preload tells main.js "painted seq N". The
//   window is shown only after that (CONTRACT section 8: no blank frame, no
//   height jump).
// - margin presses: a press on the transparent 12 px margin closes the panel,
//   for the moment before main's cursor poll makes the margin click-through.

const { contextBridge, ipcRenderer } = require('electron');

const MARGIN = 12;
const subs = { snapshot: new Set(), progress: new Set(), show: new Set(), hide: new Set(), error: new Set() };

function emit(kind, payload, withPayload) {
  for (const cb of [...subs[kind]]) {
    try {
      if (withPayload) cb(payload);
      else cb();
    } catch (err) {
      console.error(`meter: ${kind} callback threw`, err);
    }
  }
}

function ackPaint(seq) {
  if (typeof seq !== 'number') return;
  requestAnimationFrame(() => requestAnimationFrame(() => ipcRenderer.send('meter:painted', seq)));
}

ipcRenderer.on('meter:snapshot', (_e, snap, seq) => {
  emit('snapshot', snap, true);
  ackPaint(seq);
});
ipcRenderer.on('meter:error', (_e, err, seq) => {
  emit('error', { message: String((err && err.message) || 'The data engine failed') }, true);
  ackPaint(seq);
});
ipcRenderer.on('meter:progress', (_e, p) => emit('progress', p, true));
ipcRenderer.on('meter:show', (_e, payload) => emit('show', payload && typeof payload === 'object' ? payload : {}, true));
ipcRenderer.on('meter:hide', () => emit('hide', null, false));

// The page's first paint (whatever it shows before any data) is content seq 0.
window.addEventListener('DOMContentLoaded', () => setTimeout(() => ackPaint(0), 0));

window.addEventListener(
  'pointerdown',
  (e) => {
    const x = e.clientX;
    const y = e.clientY;
    if (x < MARGIN || y < MARGIN || x >= innerWidth - MARGIN || y >= innerHeight - MARGIN) ipcRenderer.send('meter:margin-click');
  },
  true,
);

function subscribe(kind, cb) {
  if (typeof cb !== 'function') throw new TypeError(`meter: on${kind[0].toUpperCase()}${kind.slice(1)} needs a callback function`);
  subs[kind].add(cb);
  return () => subs[kind].delete(cb);
}

contextBridge.exposeInMainWorld('meter', {
  getSnapshot: async () => {
    const r = await ipcRenderer.invoke('meter:get-snapshot');
    // ack after the page's own .then() has applied the answer
    if (r && typeof r.seq === 'number') setTimeout(() => ackPaint(r.seq), 0);
    if (r && r.error) throw new Error(r.error);
    return (r && r.snapshot) || null;
  },
  onSnapshot: (cb) => subscribe('snapshot', cb),
  onProgress: (cb) => subscribe('progress', cb),
  onShow: (cb) => subscribe('show', cb),
  onHide: (cb) => subscribe('hide', cb),
  onError: (cb) => subscribe('error', cb),
  refresh: () => ipcRenderer.invoke('meter:refresh').then(() => undefined),
  setContentHeight: (px) => {
    if (typeof px !== 'number' || !Number.isFinite(px) || px < 0) {
      throw new TypeError(`meter.setContentHeight: expected a finite, non-negative number, got ${String(px)}`);
    }
    ipcRenderer.send('meter:set-content-height', Math.ceil(px));
  },
  openExternal: (url) => {
    let parsed = null;
    try {
      parsed = typeof url === 'string' ? new URL(url) : null;
    } catch {
      parsed = null;
    }
    if (!parsed || parsed.protocol !== 'https:') throw new TypeError('meter.openExternal: only https:// URLs are allowed');
    ipcRenderer.send('meter:open-external', parsed.href);
  },
  getSettings: () => ipcRenderer.invoke('meter:get-settings'),
  setAutostart: (on) => {
    if (typeof on !== 'boolean') return Promise.reject(new TypeError('meter.setAutostart: expected a boolean'));
    return ipcRenderer.invoke('meter:set-autostart', on).then(() => undefined);
  },
  setCostBasis: (basis) => {
    if (basis !== 'per-reply' && basis !== 'claude-app') {
      return Promise.reject(new TypeError('meter.setCostBasis: expected "per-reply" or "claude-app"'));
    }
    return ipcRenderer.invoke('meter:set-cost-basis', basis).then(() => undefined);
  },
  quit: () => ipcRenderer.send('meter:quit'),
});
