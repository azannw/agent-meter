'use strict';
// Paint-before-show gate (CONTRACT section 8), pure so it is unit-tested.
// The window may be shown only when the page has painted the content main.js
// last sent it and nothing (a paint, a height report, a resize) moved for quietMs.

/**
 * @returns {'loading'|'painting'|'settling'|'ready'}
 */
function gateState({ loaded, contentSeq, paintedSeq, paintedAt = 0, lastHeightAt = 0, lastResizeAt = 0, now, quietMs }) {
  if (!loaded) return 'loading';
  if (paintedSeq < contentSeq) return 'painting';
  if (now - Math.max(paintedAt, lastHeightAt, lastResizeAt) < quietMs) return 'settling';
  return 'ready';
}

module.exports = { gateState };
