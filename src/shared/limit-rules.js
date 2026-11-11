// When a limit is at risk: the ONE rule behind the panel's yellow "Weekly runs out in
// 2d 3h" (renderer/ui.js) and the tray number's amber tile (main/summary.js), so the two
// never disagree. They did on 2026-10-03: the tray went amber at 14 % used, a few hours
// into a fresh week, while the panel, which waits for 20 %, rightly said nothing.
// A classic script for the page (window.AM.rules) and a CommonJS module for the main process.
(function (root) {
  'use strict';

  const RISK_MIN_USED = 20; // early in a window the pace projection is noise

  function parse(iso) {
    const t = typeof iso === 'string' ? Date.parse(iso) : NaN;
    return Number.isFinite(t) ? t : null;
  }

  /** At the average pace so far the window runs out before it resets (and 20 %+ is used). */
  function runsOutEarly(w, now) {
    const pace = w && w.pace;
    if (!pace || pace.state !== 'deficit' || !(Number(w.usedPct) >= RISK_MIN_USED)) return false;
    const out = parse(pace.runsOutAt);
    const reset = parse(w.resetsAt);
    return out !== null && out > now && (reset === null || out < reset);
  }

  const rules = { RISK_MIN_USED, runsOutEarly };
  if (typeof module === 'object' && module.exports) module.exports = rules;
  else (root.AM = root.AM || {}).rules = rules;
})(typeof window !== 'undefined' ? window : globalThis);
