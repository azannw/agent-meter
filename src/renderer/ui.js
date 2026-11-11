// Agent Meter - DOM helper and the reusable pieces: the meter, a limit row, an account
// block, the daily chart, and the change-only motion. Everything is built with
// createElement + textContent. No HTML strings anywhere: snapshot strings (emails, error
// text) are data and stay data.
(function () {
  'use strict';
  const AM = (window.AM = window.AM || {});
  const F = AM.format;

  // Provider colours live in styles.css :root; elements reference them as var(--x).
  const PROVIDER_VAR = { claude: '--claude', codex: '--codex' };
  const TRACK_VAR = { claude: '--claude-track', codex: '--codex-track' };
  function providerVar(id) {
    return PROVIDER_VAR[id] || '--series-other';
  }
  function trackVar(id) {
    return TRACK_VAR[id] || '--other-track';
  }

  function append(el, kid) {
    if (kid === null || kid === undefined || kid === false || kid === '') return;
    if (Array.isArray(kid)) { kid.forEach((k) => append(el, k)); return; }
    if (typeof kid === 'string' || typeof kid === 'number') {
      el.appendChild(document.createTextNode(String(kid)));
      return;
    }
    el.appendChild(kid);
  }

  // h('div', { class: 'x', text: 'y', style: { width: '3px' }, onclick: fn, 'aria-label': 'z' }, kids)
  function h(tag, props, kids) {
    const el = document.createElement(tag);
    if (props) {
      for (const k of Object.keys(props)) {
        const v = props[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = String(v);
        else if (k === 'style') {
          for (const s of Object.keys(v)) {
            if (v[s] !== null && v[s] !== undefined) el.style.setProperty(s, String(v[s]));
          }
        } else if (k === 'dataset') {
          for (const d of Object.keys(v)) {
            if (v[d] !== null && v[d] !== undefined) el.dataset[d] = String(v[d]);
          }
        } else if (k.slice(0, 2) === 'on' && typeof v === 'function') {
          el.addEventListener(k.slice(2), v);
        } else {
          el.setAttribute(k, v === true ? '' : String(v));
        }
      }
    }
    append(el, kids);
    return el;
  }

  // A time text that the tick keeps current (see tick()).
  function ts(kind, iso, cls, now) {
    if (F.parseIso(iso) === null) return null;
    return h('span', { class: cls || null, dataset: { ts: iso, kind }, text: F.timeText(kind, iso, now) });
  }
  function tick(root, now) {
    const at = typeof now === 'number' ? now : Date.now();
    (root || document).querySelectorAll('[data-ts]').forEach((el) => {
      const text = F.timeText(el.dataset.kind, el.dataset.ts, at);
      if (el.textContent !== text) el.textContent = text;
    });
  }

  const clampPct = (v) => Math.max(0, Math.min(100, F.nz(v)));

  // ---------------------------------------------------------------- meter
  // A 6 px pill. Under 0.5% it draws empty and from 99.5% full, so the bar never
  // disagrees with the rounded percentage beside it.
  function shownFill(p) {
    const c = clampPct(p);
    const r = Math.round(c);
    if (r <= 0) return 0;
    if (r >= 100) return 100;
    return c;
  }
  function meter({ pct, providerId, key, label }) {
    const fill = shownFill(pct);
    const bar = keyed(h('div', {
      class: 'meter-fill',
      style: { width: fill + '%', background: 'var(' + providerVar(providerId) + ')' },
    }), key, fill, 'meter');
    return h('div', {
      class: 'meter',
      role: 'meter',
      'aria-valuemin': '0',
      'aria-valuemax': '100',
      'aria-valuenow': String(Math.round(clampPct(pct))),
      'aria-label': label || null,
      style: { background: 'var(' + trackVar(providerId) + ')' },
    }, bar);
  }

  // ---------------------------------------------------------------- limit rows
  function isFull(w) {
    return !!w && F.nz(w.usedPct) >= 100;
  }

  // One row of the table: label | meter | % | time until reset.
  // r: { w (may be null), label, providerId, key, now }
  function limitRow(r) {
    const w = r.w;
    if (!w) {
      return h('div', { class: 'row is-empty' }, [
        h('span', { class: 'row-label', text: r.label }),
        meter({ pct: 0, providerId: r.providerId, label: r.label + ', no reading' }),
        h('span', { class: 'row-pct tnum', text: F.pct(null) }),
        h('span', { class: 'row-reset tnum', text: F.pct(null) }),
      ]);
    }
    const reset = ts('left', w.resetsAt, null, r.now);
    const when = F.when(w.resetsAt, r.now);
    return h('div', { class: 'row', title: when ? r.label + ' resets ' + when : null }, [
      h('span', { class: 'row-label', text: r.label }),
      meter({ pct: w.usedPct, providerId: r.providerId, key: r.key + ':meter', label: r.label + ' ' + F.pct(w.usedPct) + ' used' }),
      num(r.key + ':pct', F.nz(w.usedPct), 'pct', 'row-pct tnum'),
      h('span', { class: 'row-reset tnum' }, reset || F.pct(null)),
    ]);
  }

  // What an account's status line says, if anything:
  //   blocked: its 5-hour or weekly limit is used up -> "Limit reached · back in 1d 2h" (red dot);
  //            the account stays unusable until the LAST full one of those resets.
  //   scoped:  only a model limit is used up -> "Fable limit reached" (red dot), nothing dims.
  //   risk:    at the average pace so far a limit runs out before it resets -> "Weekly runs
  //            out in 2d 3h" (yellow dot). Early in a window that projection is noise, so it
  //            needs 20% used first. The rule is shared/limit-rules.js: the tray's amber uses it too.
  // rows: [{ id, label, w, scoped }]
  function accountState(rows, now) {
    const core = rows.filter((r) => r.w && !r.scoped);
    const fullCore = core.filter((r) => isFull(r.w));
    if (fullCore.length) {
      let blocking = fullCore[0];
      fullCore.forEach((r) => { if ((F.parseIso(r.w.resetsAt) || 0) > (F.parseIso(blocking.w.resetsAt) || 0)) blocking = r; });
      return { kind: 'blocked', row: blocking };
    }
    const fullScoped = rows.find((r) => r.w && r.scoped && isFull(r.w));
    if (fullScoped) return { kind: 'scoped', row: fullScoped };
    let risk = null;
    rows.forEach((r) => {
      if (!AM.rules.runsOutEarly(r.w, now)) return;
      if (!risk || F.parseIso(r.w.pace.runsOutAt) < F.parseIso(risk.w.pace.runsOutAt)) risk = r;
    });
    return risk ? { kind: 'risk', row: risk } : null;
  }

  // The dot and ONE text span: the flex gap belongs between the two, not inside the sentence.
  function statusLine(st, now) {
    if (!st) return null;
    const line = (tone, title, words) => h('span', { class: 'acct-status', title }, [
      h('span', { class: 'dot is-' + tone, 'aria-hidden': 'true' }),
      h('span', null, words),
    ]);
    const w = st.row.w;
    if (st.kind === 'blocked') {
      const back = ts('left', w.resetsAt, null, now);
      return line('critical', st.row.label + ' limit resets ' + F.when(w.resetsAt, now), ['Limit reached', back ? [' · back in ', back] : null]);
    }
    if (st.kind === 'scoped') return line('critical', st.row.label + ' limit resets ' + F.when(w.resetsAt, now), st.row.label + ' limit reached');
    return line('warn', 'At the average pace of this window so far, it runs out before it resets ' + F.when(w.resetsAt, now),
      [st.row.label + ' runs out in ', ts('left', w.pace.runsOutAt, null, now)]);
  }

  // a: the account; rows: [{ id, label, w, scoped }] (the same row set for every account)
  function accountBlock({ a, rows, providerId, key, now, name }) {
    let status = null;
    let blocked = false;
    if (a.status === 'error') {
      status = h('span', { class: 'acct-status', title: a.error || null }, [h('span', { class: 'dot is-critical', 'aria-hidden': 'true' }), h('span', { text: 'Can’t read limits' })]);
    } else if (a.status === 'unavailable' || !rows.some((r) => r.w)) {
      status = h('span', { class: 'acct-status is-quiet', title: a.error || null, text: 'No reading yet' });
    } else {
      const st = accountState(rows, now);
      blocked = !!st && st.kind === 'blocked';
      status = statusLine(st, now);
    }
    return h('div', { class: 'acct' + (blocked ? ' is-blocked' : '') }, [
      h('div', { class: 'acct-head' }, [
        h('span', { class: 'acct-name', title: name, text: name }),
        status,
      ]),
      rows.map((r) => limitRow({ w: r.w, label: r.label, providerId, key: key + ':' + r.id, now })),
    ]);
  }

  // ---------------------------------------------------------------- chart
  // Daily bars. days: [{ date, total, tokens, parts: [{ id, label, value, color }] }]
  // Today is the last day and is drawn at full strength; the tallest day is labelled at
  // its tip; the first date and "Today" mark the axis; the tooltip has the rest.
  const PEAK_BAND = 16; // px above the plot for the peak label
  function chart(opts) {
    const days = (Array.isArray(opts.days) ? opts.days : []).filter(Boolean);
    const H = opts.height || 56;
    const n = days.length;
    // No days at all means the data is missing: one line, not an empty plot.
    if (n === 0) return h('div', { class: 'chart-note', text: 'No daily breakdown yet' });
    let max = 0;
    let maxIdx = -1;
    days.forEach((d, i) => { if (d.total > max) { max = d.total; maxIdx = i; } });

    // One day that dwarfs the rest would flatten every other bar to a sliver. When the peak is
    // over 3x the next-highest day, scale to just above that day and draw the outliers with a
    // visible break. The peak label and the tooltip still give the real numbers.
    const sorted = days.map((d) => d.total).filter((v) => v > 0).sort((a, b) => b - a);
    const second = sorted.length > 1 ? sorted[1] : 0;
    const broken = second > 0 && max > 3 * second;
    const scale = broken ? second * 1.2 : max;

    const wrap = h('div', { class: 'chart' });
    const plot = h('div', { class: 'chart-plot', style: { height: H + PEAK_BAND + 'px' } });
    const bars = h('div', { class: 'chart-bars', style: { height: H + 'px' } });
    if (!(max > 0)) plot.appendChild(h('div', { class: 'chart-note chart-empty', text: 'No usage in the last ' + n + ' days' }));

    const cols = days.map((d, i) => {
      // data-t / data-n: the tooltip's figures, in the markup so a change to them is a change
      // to the page (app.js skips renders whose markup is identical).
      const col = h('div', {
        class: 'chart-col' + (i === n - 1 ? ' is-today' : ''),
        dataset: { t: F.nz(d.total).toFixed(2), n: String(Math.round(F.nz(d.tokens))) },
      });
      if (d.total > 0 && max > 0) {
        const clipped = broken && d.total > scale;
        const px = clipped ? H : Math.max(2, Math.round((d.total / scale) * H));
        const stack = keyed(
          h('div', { class: 'chart-stack' + (clipped ? ' is-clipped' : ''), style: { height: px + 'px' } }),
          opts.key && d.date ? opts.key + ':day:' + d.date : null, px, 'height');
        (d.parts || []).filter((p) => p && p.value > 0).forEach((p) => {
          stack.appendChild(h('div', { class: 'chart-seg', style: { 'flex-grow': String(p.value), background: p.color } }));
        });
        col.appendChild(stack);
      }
      bars.appendChild(col);
      return col;
    });
    plot.appendChild(bars);
    // The peak, labelled at its tip. Its left edge is set once the plot has a width (place()).
    let peak = null;
    if (max > 0) {
      peak = num(opts.key ? opts.key + ':peak' : null, max, 'money', 'chart-peak tnum');
      const clipped = broken && max > scale;
      const barPx = clipped ? H : Math.max(2, Math.round((max / scale) * H));
      peak.style.top = Math.max(0, H + PEAK_BAND - barPx - 15) + 'px';
      peak.dataset.col = String(maxIdx);
      plot.appendChild(peak);
    }
    wrap.appendChild(plot);
    wrap.appendChild(h('div', { class: 'chart-axis', 'aria-hidden': 'true' }, [
      h('span', { text: F.dateShort(days[0].date) }),
      h('span', { text: 'Today' }),
    ]));

    const tip = h('div', { class: 'chart-tip', role: 'tooltip', hidden: true });
    wrap.appendChild(tip);
    let hover = -1;
    function show(i) {
      if (i === hover) return;
      if (hover >= 0 && cols[hover]) cols[hover].classList.remove('is-hover');
      hover = i;
      if (i < 0) {
        tip.hidden = true;
        bars.classList.remove('has-hover');
        return;
      }
      const d = days[i];
      cols[i].classList.add('is-hover');
      bars.classList.add('has-hover');
      tip.textContent = '';
      tip.appendChild(h('div', { class: 'tip-date', text: (i === n - 1 ? 'Today, ' : '') + F.dateLong(d.date) }));
      tip.appendChild(h('div', { class: 'tip-main' }, [
        h('span', { class: 'tip-money', text: F.money(d.total) }),
        h('span', { class: 'tip-tokens', text: F.tokens(d.tokens) + ' tokens' }),
      ]));
      const parts = (d.parts || []).filter((p) => p && p.label);
      if (parts.length > 1) {
        parts.forEach((p) => {
          tip.appendChild(h('div', { class: 'tip-part' }, [
            h('span', { class: 'swatch', style: { background: p.color } }),
            h('span', { text: p.label }),
            h('span', { class: 'tip-part-value', text: F.money(p.value) }),
          ]));
        });
      }
      tip.hidden = false;
      // Beside the hovered column (right of it in the left half, left of it in the right half),
      // at the top of the plot, so it never hides the bar it describes.
      const wrapRect = wrap.getBoundingClientRect();
      const colRect = cols[i].getBoundingClientRect();
      const tw = tip.offsetWidth;
      const cx = colRect.left + colRect.width / 2 - wrapRect.left;
      let x = cx < wrapRect.width / 2 ? colRect.right - wrapRect.left + 8 : colRect.left - wrapRect.left - tw - 8;
      x = Math.max(0, Math.min(wrapRect.width - tw, x));
      tip.style.left = Math.round(x) + 'px';
    }
    bars.addEventListener('mousemove', (e) => {
      const r = bars.getBoundingClientRect();
      if (!n || r.width <= 0) return;
      show(Math.max(0, Math.min(n - 1, Math.floor(((e.clientX - r.left) / r.width) * n))));
    });
    bars.addEventListener('mouseleave', () => show(-1));

    wrap.setAttribute('role', 'img');
    wrap.setAttribute('aria-label', max > 0
      ? 'Daily API cost, ' + n + ' days. Highest ' + F.money(max) + ' on ' + F.dateLong(days[maxIdx].date)
        + '. Today ' + F.money(days[n - 1].total) + '.'
      : 'Daily API cost: none in this period.');
    return wrap;
  }

  // Centre each peak label over its column, kept inside the plot. Runs after layout.
  function placePeaks(root) {
    (root || document).querySelectorAll('.chart-peak').forEach((el) => {
      const plot = el.parentElement;
      const col = plot && plot.querySelectorAll('.chart-col')[Number(el.dataset.col)];
      if (!col) return;
      const pw = plot.clientWidth;
      const c = col.offsetLeft + col.offsetWidth / 2;
      const w = el.offsetWidth;
      el.style.left = Math.round(Math.max(0, Math.min(pw - w, c - w / 2))) + 'px';
    });
  }

  // ---------------------------------------------------------------- change-only motion
  // Nothing moves when the panel opens. An element that carries data-k (a stable key),
  // data-v (its number) and data-f (how to show it) animates only when a re-render gives the
  // SAME key a DIFFERENT number while the panel is visible: text counts from the old value to
  // the new one, a meter slides from its old fill, a chart bar grows. No old value: it just shows.
  const TEXT_FMT = {
    money: (v) => F.moneyShort(v),
    tokens: (v) => F.tokens(v),
    int: (v) => F.integer(v),
    pct: (v) => F.pct(v),
  };
  const MOVE_MS = 600;
  const ease = (k) => 1 - Math.pow(1 - k, 3);

  function keyed(el, key, value, fmt) {
    if (key && F.num(value) !== null) {
      el.dataset.k = key;
      el.dataset.v = String(value);
      el.dataset.f = fmt;
    }
    return el;
  }
  // <span>formatted value</span>, animatable when key is given.
  function num(key, value, fmt, cls) {
    return keyed(h('span', { class: cls || null, text: TEXT_FMT[fmt](value) }), key, value, fmt);
  }

  function snapshotValues(root) {
    const out = new Map();
    root.querySelectorAll('[data-k]').forEach((el) => {
      const v = Number(el.dataset.v);
      if (Number.isFinite(v)) out.set(el.dataset.k, v);
    });
    return out;
  }

  // Runs step(k) for k in 0..1 over MOVE_MS. A timer lands the last step even when rAF is paused.
  function tween(step) {
    const t0 = performance.now();
    let done = false;
    const frame = (t) => {
      if (done) return;
      const k = Math.max(0, Math.min(1, (t - t0) / MOVE_MS));
      step(ease(k));
      if (k < 1) requestAnimationFrame(frame);
      else done = true;
    };
    step(0);
    requestAnimationFrame(frame);
    setTimeout(() => { if (!done) { done = true; step(1); } }, MOVE_MS + 120);
  }

  // CSS-driven moves: set the old value, let one frame pass, then the new one with a transition.
  function slide(el, prop, from, to, unit) {
    el.style[prop] = from + unit;
    void el.offsetWidth;
    el.classList.add('is-moving');
    const go = () => { el.style[prop] = to + unit; };
    requestAnimationFrame(go);
    setTimeout(go, 50);
    setTimeout(() => el.classList.remove('is-moving'), MOVE_MS + 120);
  }

  function animateChanges(root, prev, enabled) {
    if (!enabled || !prev || !prev.size) return;
    root.querySelectorAll('[data-k]').forEach((el) => {
      const from = prev.get(el.dataset.k);
      const to = Number(el.dataset.v);
      if (from === undefined || !Number.isFinite(to) || Math.abs(from - to) < 1e-9) return;
      const f = el.dataset.f;
      if (TEXT_FMT[f]) tween((k) => { el.textContent = TEXT_FMT[f](k >= 1 ? to : from + (to - from) * k); });
      else if (f === 'meter') slide(el, 'width', from, to, '%');
      else if (f === 'height') slide(el, 'height', from, to, 'px');
    });
  }

  AM.ui = {
    h, ts, tick, num, meter, limitRow, accountBlock, accountState, chart, placePeaks, providerVar,
    snapshotValues, animateChanges,
  };
})();
