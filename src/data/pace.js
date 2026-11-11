'use strict';
// Pace of a limit window (CONTRACT section 2).
//
//   expectedPct  share of the window already elapsed, 0..100: using the limit evenly
//                you would be at exactly this percentage now.
//   deltaPct     usedPct - expectedPct. > 0 means ahead of pace ("in deficit").
//   state        usedPct >= 100 => "full"; |delta| < 3 => "on-pace";
//                delta > 0 => "deficit"; otherwise "reserve".
//   runsOutAt    when 100% is reached at the AVERAGE rate since the window started
//                (usedPct / elapsed), reported only if that lands before resetsAt.
//   lastsUntilReset  false when full or when runsOutAt is set.

const { clamp, round } = require('./util');

const ON_PACE_BAND = 3;

function computePace({ usedPct, resetsAt, windowMinutes, now }) {
  const used = clamp(Number(usedPct) || 0, 0, 100);
  const nowMs = typeof now === 'number' ? now : new Date(now).getTime();
  const resetMs = resetsAt ? Date.parse(resetsAt) : NaN;
  const windowMs = (Number(windowMinutes) || 0) * 60000;

  let expected = 0;
  let startMs = NaN;
  if (Number.isFinite(resetMs) && windowMs > 0) {
    startMs = resetMs - windowMs;
    expected = clamp(((nowMs - startMs) / windowMs) * 100, 0, 100);
  }
  const delta = used - expected;

  let state;
  if (used >= 100) state = 'full';
  else if (Math.abs(delta) < ON_PACE_BAND) state = 'on-pace';
  else if (delta > 0) state = 'deficit';
  else state = 'reserve';

  let runsOutAt = null;
  let lastsUntilReset = used < 100;
  if (used > 0 && used < 100 && Number.isFinite(startMs)) {
    const elapsed = nowMs - startMs;
    if (elapsed > 0) {
      const fullMs = startMs + (elapsed * 100) / used;
      if (fullMs < resetMs) {
        runsOutAt = new Date(fullMs).toISOString();
        lastsUntilReset = false;
      }
    }
  }

  return {
    expectedPct: round(expected, 1),
    deltaPct: round(delta, 1),
    state,
    runsOutAt,
    lastsUntilReset,
  };
}

module.exports = { computePace, ON_PACE_BAND };
