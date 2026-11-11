// Agent Meter - formatting helpers. Pure functions, no DOM.
// Every formatter accepts anything and never returns "NaN" or "undefined":
// a value that is not a finite number comes back as DASH.
(function () {
  'use strict';
  const AM = (window.AM = window.AM || {});

  const DASH = '–';
  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  const usd2 = new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
  const usd0 = new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0,
  });
  const int = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

  function num(v) {
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  }
  function nz(v) {
    const n = num(v);
    return n === null ? 0 : n;
  }

  // Exact: "$5,052.91". Used where the cents are the point (tooltips).
  function money(v) {
    let n = num(v);
    if (n === null) return DASH;
    if (Math.abs(n) < 0.005) n = 0;
    return usd2.format(n);
  }

  // Headline: whole dollars from $100 up ("$53,019", "$218"), cents below ("$34.77").
  function moneyShort(v) {
    const n = num(v);
    if (n === null) return DASH;
    return Math.abs(n) >= 100 ? usd0.format(n) : money(n);
  }

  function stripZeros(s) {
    return s.indexOf('.') < 0 ? s : s.replace(/\.?0+$/, '');
  }

  function integer(v) {
    const n = num(v);
    return n === null ? DASH : int.format(Math.round(n));
  }

  // From 100M up, always one decimal ("102.0B", "24.5B", "412.0M"), the way the Claude app writes
  // its totals; below that, compact ("76K", "3.76M", "99.5M").
  const UNITS = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
  function tokens(v) {
    let n = num(v);
    if (n === null) return DASH;
    if (n < 0) n = 0;
    if (n < 1000) return int.format(Math.round(n));
    for (let i = 0; i < UNITS.length; i++) {
      const [size, suffix] = UNITS[i];
      if (n < size) continue;
      const scaled = n / size;
      const fixed = n >= 1e8;
      const s = scaled.toFixed(fixed ? 1 : scaled < 10 ? 2 : scaled < 100 ? 1 : 0);
      // 999.96M rounds to "1000.0M": promote to the next unit instead.
      if (Number(s) >= 1000 && i > 0) return (n / UNITS[i - 1][0]).toFixed(1) + UNITS[i - 1][1];
      return (fixed ? s : stripZeros(s)) + suffix;
    }
    return int.format(Math.round(n));
  }

  // 0..100 -> "90%". Never shows 100% for something that is not full, never "0%" for a trace.
  function pct(v) {
    const n = num(v);
    if (n === null) return DASH;
    if (n <= 0) return '0%';
    if (n < 1) return '<1%';
    if (n < 100 && n > 99) return '99%';
    return Math.round(n) + '%';
  }

  function parseIso(iso) {
    if (typeof iso !== 'string' || !iso) return null;
    const t = Date.parse(iso);
    return Number.isFinite(t) ? t : null;
  }

  // "YYYY-MM-DD" as a LOCAL calendar date (new Date("2026-09-03") would be UTC midnight).
  function parseYmd(ymd) {
    if (typeof ymd !== 'string') return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return Number.isFinite(d.getTime()) ? d : null;
  }

  // Fixed English names: en-GB in current ICU writes 'Sept', which reads as a typo here.
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const pad2 = (n) => (n < 10 ? '0' : '') + n;
  const short = (d) => d.getDate() + ' ' + MONTHS[d.getMonth()];

  // "6 Aug", with the year only when it is not this year: "6 Aug 2025".
  function dateSince(ymd, now) {
    const d = parseYmd(ymd);
    if (!d) return DASH;
    const y = new Date(typeof now === 'number' ? now : Date.now()).getFullYear();
    return short(d) + (d.getFullYear() === y ? '' : ' ' + d.getFullYear());
  }
  function dateLong(ymd) {
    const d = parseYmd(ymd);
    return d ? WEEKDAYS[d.getDay()] + ' ' + short(d) : DASH;
  }

  // "today 12:00", "tomorrow 06:59", "Sat 12:00", "14 Oct 12:00". Rounded to the nearest
  // minute, so a reset at 11:59:59 reads 12:00.
  function when(iso, now) {
    const t = parseIso(iso);
    if (t === null) return '';
    const d = new Date(Math.round(t / MIN) * MIN);
    const n = new Date(typeof now === 'number' ? now : Date.now());
    const day0 = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
    const dd = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const days = Math.round((dd - day0) / DAY);
    const clock = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    if (days === 0) return 'today ' + clock;
    if (days === 1) return 'tomorrow ' + clock;
    if (days > 1 && days < 7) return WEEKDAYS[d.getDay()] + ' ' + clock;
    return short(d) + ' ' + clock;
  }

  // Remaining time, coarse: "1d 23h", "4h 36m", "18m", "<1m".
  function duration(ms) {
    const n = num(ms);
    if (n === null) return DASH;
    if (n < MIN) return '<1m';
    const totalMin = Math.floor(n / MIN);
    const d = Math.floor(totalMin / 1440);
    const hh = Math.floor((totalMin % 1440) / 60);
    const mm = totalMin % 60;
    if (d > 0) return hh > 0 ? d + 'd ' + hh + 'h' : d + 'd';
    if (hh > 0) return mm > 0 ? hh + 'h ' + mm + 'm' : hh + 'h';
    return mm + 'm';
  }

  // "just now", "40 s ago", "21 min ago", "3 h ago", "5 d ago", "on 4 Jul".
  function ago(iso, now) {
    const t = parseIso(iso);
    if (t === null) return '';
    const diff = (typeof now === 'number' ? now : Date.now()) - t;
    if (diff < 10 * 1000) return 'just now';
    if (diff < MIN) return Math.floor(diff / 1000) + ' s ago';
    if (diff < HOUR) return Math.floor(diff / MIN) + ' min ago';
    if (diff < DAY) return Math.floor(diff / HOUR) + ' h ago';
    if (diff < 7 * DAY) return Math.floor(diff / DAY) + ' d ago';
    return 'on ' + short(new Date(t));
  }

  // Text for a live time element. kind decides the sentence; the tick re-runs this every 30 s.
  function timeText(kind, iso, now) {
    const t = parseIso(iso);
    if (t === null) return '';
    const at = typeof now === 'number' ? now : Date.now();
    const left = t - at;
    switch (kind) {
      case 'left': return left > 0 ? duration(left) : 'now';
      case 'resets': return left > 0 ? 'Resets in ' + duration(left) : 'Resetting';
      case 'back': return left > 0 ? 'Back in ' + duration(left) : 'Back now';
      case 'runout': return left > 0 ? 'Runs out in ' + duration(left) : 'Running out';
      case 'updated': { const a = ago(iso, at); return a === 'just now' ? 'Updated just now' : a ? 'Updated ' + a : ''; }
      case 'failed': { const a = ago(iso, at); return 'Couldn’t update' + (a ? ', showing data from ' + a : ''); }
      default: return '';
    }
  }


  // "4 Sep": the chart's first-day axis label.
  function dateShort(ymd) {
    const d = parseYmd(ymd);
    return d ? short(d) : DASH;
  }

  AM.format = {
    num, nz, money, moneyShort, integer, tokens, pct, duration,
    parseIso, parseYmd, dateSince, dateLong, dateShort, when, timeText,
  };
})();
