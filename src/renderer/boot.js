// Runs in <head>, before first paint (CSP forbids inline scripts).
//   ?motion=0  behaves like prefers-reduced-motion (handy for still review captures)
(function () {
  'use strict';
  try {
    if (new URLSearchParams(location.search).get('motion') === '0') {
      document.documentElement.classList.add('no-motion');
    }
  } catch (e) { /* keep defaults */ }
})();
