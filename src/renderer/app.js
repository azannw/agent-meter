// Agent Meter - the popup page. Talks to window.meter (CONTRACT section 5). Example data
// (../shared/mock-snapshot.js) is used ONLY with ?mock=1 or when there is no bridge at all.
//
// The window is transparent; this page draws the panel inside a 12 px margin and animates it in
// and out itself (CONTRACT 8). One page (design round 4): a pinned header with the all-time
// tokens and API cost, today and the last 30 days; then "Usage limits", one aligned row per
// limit (5-hour, Weekly, then each model limit such as Fable) for every account; then the daily
// cost chart. Words appear only when something needs attention. Tabs appear only when two or
// more providers have data.
//
// The shell pushes a snapshot every 9 s while the panel is open. A render that would produce the
// same page as the last one touches nothing, so an idle refresh costs no layout or paint.
(function () {
  'use strict';
  const AM = window.AM;
  const F = AM.format;
  const U = AM.ui;
  const h = U.h;

  const params = new URLSearchParams(location.search);
  const TAB_KEY = 'agentMeter.tab';
  const DISMISSED_KEY = 'agentMeter.dismissed';
  const TABS = ['overview', 'claude', 'codex'];
  // Opening the panel asks the shell for a fresh snapshot; it lands well inside this window.
  // That update is part of opening, so it lands at once like the rest of the page instead of
  // counting up.
  const OPEN_SETTLE_MS = 1000;
  const TICK_MS = 15 * 1000; // countdowns, only while the panel is on screen
  const ENTER = { duration: 250, easing: 'cubic-bezier(0.1, 0.9, 0.2, 1)', distance: 16 };
  const EXIT = { duration: 120, easing: 'cubic-bezier(0.7, 0, 1, 0.5)', distance: 8 };
  const EDGE = { bottom: [0, 1], top: [0, -1], left: [-1, 0], right: [1, 0] };
  // Claude accounts always get these rows first, in this order, so every account has the same
  // shape; model limits (Fable...) follow.
  const CORE_ROWS = [
    { key: 'session', minutes: 300, label: '5-hour' },
    { key: 'weekly', minutes: 10080, label: 'Weekly' },
  ];
  const motionQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const reducedMotion = () => document.documentElement.classList.contains('no-motion') || !!(motionQuery && motionQuery.matches);

  const $ = (sel) => document.querySelector(sel);
  const el = {
    app: $('#app'),
    top: $('#top'),
    tabs: $('#tabs'),
    hero: $('#hero'),
    scroller: $('#scroller'),
    content: $('#content'),
  };

  const state = {
    bridge: null,
    snapshot: null,
    loadError: null, // the engine failed before any snapshot: full error view
    engineError: null, // it failed after one: a quiet notice above the content
    tab: readTab(),
    progress: null,
    shown: false, // the panel is on screen (after onShow, until onHide)
    shownAt: 0, // performance.now() at the last onShow
    edge: 'bottom',
    anim: null,
    showFallback: 0,
    dismissed: readDismissed(),
    lastHeight: 0,
    renderedKind: null,
    sig: { hero: null, content: null },
    renders: 0, // DOM updates actually made (the dev hook reads these)
    skipped: 0, // renders that found nothing to change
  };

  // ---------------------------------------------------------------- storage
  function readTab() {
    const asked = params.get('tab'); // --tab <name> on the command line, for captures
    if (TABS.indexOf(asked) >= 0) return asked;
    try {
      const t = localStorage.getItem(TAB_KEY);
      return TABS.indexOf(t) >= 0 ? t : 'overview';
    } catch (e) {
      return 'overview';
    }
  }
  function writeTab(t) {
    try { localStorage.setItem(TAB_KEY, t); } catch (e) { /* private mode / blocked storage */ }
  }
  // A dismissed notice stays dismissed across restarts; a new wording shows again.
  function readDismissed() {
    try {
      const v = JSON.parse(localStorage.getItem(DISMISSED_KEY) || '[]');
      return new Set(Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
    } catch (e) {
      return new Set();
    }
  }
  function writeDismissed() {
    try { localStorage.setItem(DISMISSED_KEY, JSON.stringify(Array.from(state.dismissed).slice(-20))); } catch (e) { /* ignore */ }
  }

  // ---------------------------------------------------------------- snapshot access (all guarded)
  const arr = (v) => (Array.isArray(v) ? v.filter((x) => x !== null && x !== undefined) : []);
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  const str = (v, fb) => (typeof v === 'string' && v.trim() ? v.trim() : fb === undefined ? '' : fb);

  function providers(s) {
    return arr(s && s.providers).filter((p) => p && typeof p === 'object');
  }
  function availableProviders(s) {
    return providers(s).filter((p) => p.available === true);
  }
  function accountsOf(p) {
    return arr(obj(obj(p).limits).accounts);
  }
  function windowsOf(a) {
    return arr(obj(a).windows);
  }
  function lastDay(days) {
    const d = arr(days);
    return d.length ? obj(d[d.length - 1]) : {};
  }

  // ---------------------------------------------------------------- bridge
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Could not load ' + src));
      document.head.appendChild(s);
    });
  }

  // Mock data is a fixed moment in time; shift its timestamps so "now" is just after
  // generatedAt and every countdown reads like the real thing.
  const TIME_KEYS = { generatedAt: 1, updatedAt: 1, resetsAt: 1, runsOutAt: 1 };
  function rebase(snap) {
    const gen = F.parseIso(snap && snap.generatedAt);
    if (gen === null) return snap;
    const delta = Date.now() - 40 * 1000 - gen;
    (function walk(o) {
      if (!o || typeof o !== 'object') return;
      for (const k of Object.keys(o)) {
        const v = o[k];
        if (TIME_KEYS[k] && typeof v === 'string') {
          const t = F.parseIso(v);
          if (t !== null) o[k] = new Date(t + delta).toISOString();
        } else if (v && typeof v === 'object') walk(v);
      }
    })(snap);
    return snap;
  }

  // ?mock=1 fakes the DATA (snapshot, progress, refresh, errors). Window calls still go to the
  // real bridge when there is one, so a mock run inside Electron sizes and shows for real.
  function createMockBridge(real) {
    const has = (name) => !!(real && typeof real[name] === 'function');
    const variant = params.get('variant') || '';
    const subs = { snapshot: new Set(), progress: new Set(), show: new Set(), hide: new Set(), error: new Set() };
    let calls = 0;
    const on = (kind) => (cb) => { subs[kind].add(cb); return () => subs[kind].delete(cb); };
    const emit = (kind, v) => subs[kind].forEach((cb) => { try { cb(v); } catch (e) { console.error(e); } });
    const both = (kind, realName) => (cb) => {
      const off = on(kind)(cb);
      const offReal = has(realName) ? real[realName](cb) : null;
      return () => { off(); if (typeof offReal === 'function') offReal(); };
    };

    function makeSnapshot() {
      const base = window.__MOCK_SNAPSHOT__ ? JSON.parse(JSON.stringify(window.__MOCK_SNAPSHOT__)) : null;
      if (!base) return null;
      const variants = window.__MOCK_VARIANTS__ || {};
      const fn = variant && typeof variants[variant] === 'function' ? variants[variant] : null;
      // Rebase first, so a variant can set times relative to "now". n counts snapshots.
      const snap = rebase(base);
      return fn ? fn(snap, calls++) : snap;
    }
    function scan(total, ms, endless) {
      return new Promise((resolve) => {
        let done = 0;
        const step = Math.max(1, Math.round(total / (ms / 50)));
        emit('progress', { phase: 'scanning', filesDone: 0, filesTotal: total });
        const t = setInterval(() => {
          done = Math.min(total, done + step);
          if (endless && done >= total * 0.3) done = Math.round(total * 0.3);
          emit('progress', { phase: done >= total ? 'pricing' : 'scanning', filesDone: done, filesTotal: total });
          if (!endless && done >= total) { clearInterval(t); setTimeout(resolve, 150); }
        }, 50);
      });
    }

    return {
      getSnapshot() {
        if (variant === 'loading') { setTimeout(() => scan(1600, 8000, true), 50); return Promise.resolve(null); }
        if (variant === 'first-run') {
          setTimeout(() => scan(1600, 2400).then(() => emit('snapshot', makeSnapshot())), 50);
          return Promise.resolve(null);
        }
        if (variant === 'broken') return Promise.reject(new Error('The data engine stopped (exit code 1)'));
        // The engine fails after a good snapshot: the page keeps it and says so quietly.
        if (variant === 'engine-error') setTimeout(() => emit('error', { message: 'The data engine stopped (exit code 1)' }), 600);
        return Promise.resolve(makeSnapshot());
      },
      onSnapshot: on('snapshot'),
      onProgress: on('progress'),
      onError: on('error'),
      onShow: both('show', 'onShow'),
      onHide: both('hide', 'onHide'),
      refresh() {
        scan(64, 900).then(() => {
          if (variant === 'engine-error') emit('error', { message: 'The data engine stopped (exit code 1)' });
          else emit('snapshot', makeSnapshot());
        });
        return Promise.resolve();
      },
      setContentHeight(px) {
        document.documentElement.dataset.reportedHeight = String(px);
        if (has('setContentHeight')) real.setContentHeight(px);
      },
      __emit: emit,
    };
  }

  function call(name, ...args) {
    const b = state.bridge;
    if (!b || typeof b[name] !== 'function') return undefined;
    try {
      return b[name](...args);
    } catch (e) {
      console.error('meter.' + name + ' failed', e);
      return undefined;
    }
  }

  // ---------------------------------------------------------------- tabs
  // Tabs exist only when two or more providers have data. With one, the page is single.
  function visibleTabs(s) {
    const ids = availableProviders(s).map((p) => p.id).filter((id) => TABS.indexOf(id) > 0);
    return ids.length > 1 ? ['overview'].concat(ids) : ['overview'];
  }

  // The buttons are built from the providers that have data, so a provider without any
  // leaves no trace in the page, not even hidden text.
  function syncTabs() {
    const s = state.snapshot;
    const vis = s ? visibleTabs(s) : ['overview'];
    // Before the first snapshot only Overview is "visible"; resetting then would
    // throw away the remembered (or --tab) choice on every launch.
    if (s && vis.indexOf(state.tab) < 0) state.tab = 'overview';
    const showTabs = !!s && vis.length > 1;
    const ids = showTabs ? vis.join(',') : '';
    if (el.tabs.dataset.ids !== ids) {
      el.tabs.dataset.ids = ids;
      el.tabs.textContent = '';
      vis.forEach((id) => {
        if (!showTabs) return;
        const p = id === 'overview' ? null : availableProviders(s).find((x) => x.id === id);
        el.tabs.appendChild(h('button', {
          class: 'tab', type: 'button', role: 'tab', id: 'tab-' + id, 'aria-controls': 'content', dataset: { tab: id },
        }, id === 'overview' ? 'Overview' : str(p && p.name, id)));
      });
    }
    el.tabs.hidden = !showTabs;
    el.tabs.querySelectorAll('[role="tab"]').forEach((btn) => {
      const sel = btn.dataset.tab === state.tab;
      btn.setAttribute('aria-selected', sel ? 'true' : 'false');
      btn.tabIndex = sel ? 0 : -1;
    });
    if (showTabs) el.content.setAttribute('aria-labelledby', 'tab-' + state.tab);
    else el.content.removeAttribute('aria-labelledby');
    el.content.setAttribute('role', showTabs ? 'tabpanel' : 'region');
  }

  function setTab(id, focus) {
    const vis = state.snapshot ? visibleTabs(state.snapshot) : ['overview'];
    if (vis.indexOf(id) < 0 || id === state.tab) {
      if (focus) focusTab(id);
      return;
    }
    state.tab = id;
    writeTab(id);
    render({ resetScroll: true });
    if (focus) focusTab(id);
  }
  function focusTab(id) {
    const btn = el.tabs.querySelector('[data-tab="' + id + '"]');
    if (btn && !btn.hidden) btn.focus();
  }

  // ---------------------------------------------------------------- figures
  // The header figures, from the best source the snapshot has:
  //   overview.headline (CONTRACT 2): all-time tokens counted the way the Claude app counts, and
  //   cost on the basis the user picked; else the ledger's lifetime block; else the last 30 days.
  function headlineOf(v) {
    const x = obj(v);
    if (F.num(x.tokens) === null && F.num(x.costUSD) === null) return null;
    return {
      allTime: true,
      tokens: F.num(x.tokens),
      cost: F.num(x.costUSD),
      today: F.num(x.todayUSD),
      d30: F.num(x.d30CostUSD),
      d30Tokens: F.num(x.d30Tokens),
      since: F.parseYmd(x.since) ? x.since : null,
    };
  }
  function lifetimeOf(v) {
    const x = obj(v);
    if (F.num(x.tokens) === null && F.num(x.costUSD) === null) return null;
    return { tokens: F.num(x.tokens), cost: F.num(x.costUSD), since: F.parseYmd(x.since) ? x.since : null };
  }
  const minus = (a, b) => (a === null ? null : Math.max(0, a - F.nz(b)));

  function figuresFor(s, one) {
    const o = obj(s.overview);
    const hl = headlineOf(o.headline);
    if (!one) {
      if (hl) return hl;
      const lt = lifetimeOf(o.lifetime);
      const today = F.num(lastDay(o.daily).costUSD);
      if (lt) return { allTime: true, tokens: lt.tokens, cost: lt.cost, today, d30: F.num(o.costUSD), d30Tokens: null, since: lt.since, raw: true };
      return { allTime: false, tokens: F.num(o.tokens), cost: F.num(o.costUSD), today, d30: null, d30Tokens: null, since: null, raw: true };
    }
    const sp = obj(one.spend);
    // The headline is the Claude app count plus each other provider's own figures, so the Claude
    // tab is the headline minus the others.
    if (hl && one.id === 'claude') {
      const others = availableProviders(s).filter((p) => p !== one).map((p) => obj(p.spend));
      const sum = (f) => others.reduce((acc, x) => acc + F.nz(f(x)), 0);
      return {
        allTime: true,
        tokens: minus(hl.tokens, sum((x) => obj(x.lifetime).tokens)),
        cost: minus(hl.cost, sum((x) => obj(x.lifetime).costUSD)),
        today: minus(hl.today, sum((x) => x.todayUSD)),
        d30: minus(hl.d30, sum((x) => x.d30USD)),
        d30Tokens: minus(hl.d30Tokens, sum((x) => x.d30Tokens)),
        since: hl.since,
      };
    }
    const lt = lifetimeOf(sp.lifetime);
    if (lt) return { allTime: true, tokens: lt.tokens, cost: lt.cost, today: F.num(sp.todayUSD), d30: F.num(sp.d30USD), d30Tokens: null, since: lt.since, raw: true };
    return { allTime: false, tokens: F.num(sp.d30Tokens), cost: F.num(sp.d30USD), today: F.num(sp.todayUSD), d30: null, d30Tokens: null, since: null, raw: true };
  }

  // Daily bars for the scope, on the same basis as the header. The data has per-day figures only
  // per reply; on the Claude-app basis the days are scaled so today's bar is the header's Today and
  // the bars add up to its Last 30 days (exact in total, proportional within the days).
  function daysFor(s, provs, one, fig) {
    let days;
    if (one) {
      days = arr(obj(one.spend).daily).map((d) => ({
        date: d.date,
        total: Math.max(0, F.nz(d.costUSD)),
        tokens: F.nz(d.tokens),
        parts: [{ id: one.id, label: str(one.name, one.id), value: Math.max(0, F.nz(d.costUSD)), color: 'var(' + U.providerVar(one.id) + ')' }],
      }));
    } else {
      days = arr(obj(s.overview).daily).map((d) => {
        const by = obj(d.byProvider);
        return {
          date: d.date,
          total: Math.max(0, F.nz(d.costUSD)),
          tokens: F.nz(d.tokens),
          // Only providers with data get a series: an unavailable one never shows up by name.
          parts: provs.map((p) => ({ id: p.id, label: str(p.name, p.id), value: Math.max(0, F.nz(by[p.id])), color: 'var(' + U.providerVar(p.id) + ')' })),
        };
      });
    }
    if (fig.raw || !days.length) return days;
    const n = days.length;
    const all = days.reduce((a, d) => a + d.total, 0);
    const last = days[n - 1].total;
    let kRest = 1;
    let kToday = 1;
    if (fig.d30 !== null && all > 0) {
      if (fig.today !== null && last > 0 && all - last > 0) {
        kToday = fig.today / last;
        kRest = Math.max(0, fig.d30 - fig.today) / (all - last);
      } else {
        kRest = kToday = fig.d30 / all;
      }
    }
    const tok = days.reduce((a, d) => a + d.tokens, 0);
    const kTok = fig.d30Tokens !== null && tok > 0 ? fig.d30Tokens / tok : 1;
    return days.map((d, i) => {
      const k = i === n - 1 ? kToday : kRest;
      return Object.assign({}, d, {
        total: d.total * k,
        tokens: d.tokens * kTok,
        parts: d.parts.map((p) => Object.assign({}, p, { value: p.value * k })),
      });
    });
  }

  // ---------------------------------------------------------------- header
  // Two headline facts (all-time tokens and API cost), then today and the last 30 days.
  function renderHero(s, fig, key) {
    const range = F.num(s.rangeDays) || 30;
    const k = (name) => key + ':' + name;
    const since = fig.since ? 'Since ' + F.dateSince(fig.since) : null;
    const sub = (label, name, value) => h('div', { class: 'hero-sub' }, [h('span', { text: label }), U.num(k(name), value, 'money', 'hero-sub-v')]);
    return h('div', { class: 'hero' }, [
      h('div', { class: 'hero-cap', text: fig.allTime ? 'All-time tokens' : 'Tokens, last ' + range + ' days' }),
      h('div', { class: 'hero-cap', text: fig.allTime ? 'All-time API cost' : 'API cost, last ' + range + ' days' }),
      h('div', { class: 'hero-value', title: since }, U.num(k('tokens'), fig.tokens, 'tokens')),
      h('div', { class: 'hero-value', title: since }, U.num(k('cost'), fig.cost, 'money')),
      sub('Today', 'today', fig.today),
      fig.d30 !== null ? sub('Last ' + range + ' days', 'd30', fig.d30) : h('div'),
    ]);
  }

  // ---------------------------------------------------------------- notices
  function dot(tone) {
    return h('span', { class: 'dot is-' + tone, 'aria-hidden': 'true' });
  }
  // Data warnings (spend side) and an engine failure after a good snapshot. Nothing when all is well.
  function notices(s) {
    const items = [];
    if (state.engineError) {
      const t = U.ts('failed', s.generatedAt, null, Date.now());
      items.push(h('div', { class: 'notice', role: 'status', title: state.engineError }, [dot('critical'), h('span', { class: 'notice-text' }, t || 'Couldn’t update')]));
    }
    arr(s.warnings).filter((w) => typeof w === 'string' && w.trim() && !state.dismissed.has(w)).forEach((w) => {
      items.push(h('div', { class: 'notice', role: 'status' }, [
        dot('warn'),
        h('span', { class: 'notice-text', text: w }),
        h('button', {
          class: 'notice-x icon',
          type: 'button',
          'aria-label': 'Dismiss',
          title: 'Dismiss',
          text: '',
          onclick: () => { state.dismissed.add(w); writeDismissed(); render(); },
        }),
      ]));
    });
    return items.length ? h('div', { class: 'notices' }, items) : null;
  }

  // ---------------------------------------------------------------- usage limits
  const isScopedKey = (k) => String(k || '').indexOf('weekly_scoped') === 0;
  // "Fable only" -> "Fable": the column is already a limit name.
  const scopedLabel = (w) => str(w.label, 'Model').replace(/\s+only$/i, '');

  // The rows every account of this provider gets. Claude: 5-hour, Weekly, then each model limit
  // any of its accounts reports (an account without it shows a dash). Others: their own windows.
  function rowDefs(p, accts) {
    if (p.id === 'claude' || accts.every((a) => a.kind !== 'codex')) {
      const defs = CORE_ROWS.map((r) => ({ key: r.key, minutes: r.minutes, label: r.label, scoped: false }));
      accts.forEach((a) => windowsOf(a).forEach((w) => {
        if (isScopedKey(w.key) && !defs.some((d) => d.key === w.key)) defs.push({ key: w.key, label: scopedLabel(w), scoped: true });
      }));
      return defs;
    }
    const defs = [];
    accts.forEach((a) => windowsOf(a).forEach((w, i) => {
      const key = str(w.key, String(i));
      if (!defs.some((d) => d.key === key)) defs.push({ key, label: str(w.label, 'Limit'), scoped: false });
    }));
    return defs;
  }
  function rowsFor(a, defs) {
    const wins = windowsOf(a);
    return defs.map((d) => ({
      id: d.key,
      label: d.label,
      scoped: d.scoped,
      w: wins.find((w) => w.key === d.key)
        || (d.minutes ? wins.find((w) => F.num(w.windowMinutes) === d.minutes && !isScopedKey(w.key)) : null)
        || null,
    }));
  }

  function limitsSection(provs, now, key) {
    const blocks = [];
    const warn = [];
    provs.forEach((p) => {
      const accts = accountsOf(p);
      arr(obj(p.limits).warnings).forEach((w) => { if (typeof w === 'string' && w.trim()) warn.push(w); });
      if (!accts.length) return;
      const defs = rowDefs(p, accts);
      accts.forEach((a, i) => {
        const name = str(a.name, p.id === 'codex' ? str(p.name, 'Codex') : 'Account');
        blocks.push(U.accountBlock({ a, rows: rowsFor(a, defs), providerId: p.id, key: key + ':' + p.id + ':' + str(a.id, String(i)), now, name }));
      });
    });
    if (!blocks.length && !warn.length) return null;
    return h('section', { class: 'limits', 'aria-label': 'Usage limits' }, [
      h('div', { class: 'section-head' }, [
        h('h2', { class: 'section-title', text: 'Usage limits' }),
        blocks.length ? h('span', { class: 'col-head', text: 'Resets in' }) : null,
      ]),
      warn.length ? h('div', { class: 'notices', style: { 'margin-bottom': '12px' } }, warn.map((w) => h('div', { class: 'notice', role: 'status' }, [dot('warn'), h('span', { class: 'notice-text', text: w })]))) : null,
      blocks.length ? blocks : h('div', { class: 'chart-note', text: 'No limit readings yet' }),
    ]);
  }

  // ---------------------------------------------------------------- daily cost
  function chartSection(days, provs, key) {
    const ids = [];
    days.forEach((d) => d.parts.forEach((pt) => { if (pt.value > 0 && ids.indexOf(pt.id) < 0) ids.push(pt.id); }));
    const legend = ids.length > 1
      ? h('span', { class: 'legend' }, ids.map((id) => {
        const p = provs.find((x) => x.id === id);
        return h('span', { class: 'legend-item' }, [h('span', { class: 'swatch', style: { background: 'var(' + U.providerVar(id) + ')' } }), str(p && p.name, id)]);
      }))
      : null;
    return h('section', { class: 'daily', 'aria-label': 'Daily cost' }, [
      h('div', { class: 'section-head' }, [h('h2', { class: 'section-title', text: 'Daily cost' }), legend]),
      U.chart({ days, height: 52, key: key + ':chart' }),
    ]);
  }

  // ---------------------------------------------------------------- loading / empty / error
  function progressText(p) {
    if (!p) return 'Starting';
    if (p.phase === 'pricing') return 'Pricing usage';
    const done = F.num(p.filesDone);
    const total = F.num(p.filesTotal);
    return total !== null && total > 0 && done !== null ? F.integer(done) + ' of ' + F.integer(total) + ' files' : 'Starting';
  }
  function progressFrac(p) {
    const done = p ? F.num(p.filesDone) : null;
    const total = p ? F.num(p.filesTotal) : null;
    if (done === null || total === null || total <= 0) return null;
    return Math.max(0, Math.min(1, done / total));
  }

  function stateBlock(title, sub, extra) {
    return [h('div', { class: 'state-block' }, [
      h('div', { class: 'state-title', text: title }),
      sub ? h('div', { class: 'state-sub', text: sub }) : null,
      extra,
    ])];
  }
  function renderLoading() {
    const frac = progressFrac(state.progress);
    return stateBlock('Reading your history', 'The first scan reads all of it and takes about ten seconds. Updates after that are instant.', [
      h('div', {
        class: 'progress' + (frac === null ? ' is-indeterminate' : ''),
        role: 'progressbar',
        'aria-valuemin': '0',
        'aria-valuemax': '100',
        'aria-valuenow': frac === null ? null : String(Math.round(frac * 100)),
        id: 'load-progress',
      }, h('div', { class: 'progress-fill', style: { width: frac === null ? null : (frac * 100).toFixed(1) + '%' } })),
      h('div', { class: 'state-meta', id: 'load-text', text: progressText(state.progress) }),
    ]);
  }
  function renderEmpty() {
    return stateBlock('No usage found yet', 'Usage appears here after your first Claude Code session.',
      h('button', { class: 'btn', type: 'button', onclick: doRefresh, text: 'Refresh' }));
  }
  function renderError() {
    return stateBlock('Could not read usage', str(state.loadError, 'Something went wrong while reading your history.'),
      h('button', { class: 'btn', type: 'button', onclick: doRefresh, text: 'Try again' }));
  }

  // ---------------------------------------------------------------- render
  // Numbers animate only on a change the user can see, and not while the panel is opening.
  function animateNow() {
    return state.shown && !reducedMotion() && performance.now() - state.shownAt >= OPEN_SETTLE_MS;
  }

  // Swap a region's children for new ones, unless they would be identical. The comparison is
  // against the markup the LAST render built (not the live DOM, which the tick and the chart
  // layout adjust), so an unchanged refresh skips all DOM, layout and paint work.
  function swap(region, nodes, sigKey, prefix, force) {
    const box = document.createElement('div');
    nodes.forEach((n) => { if (n) box.appendChild(n); });
    const sig = prefix + '|' + box.innerHTML;
    if (!force && sig === state.sig[sigKey]) return false;
    state.sig[sigKey] = sig;
    region.replaceChildren(...box.childNodes);
    return true;
  }

  function render(opts) {
    opts = opts || {};
    const now = Date.now();
    const s = state.snapshot;
    syncTabs();

    let kind;
    let hero = null;
    let nodes;
    if (!s) {
      kind = state.loadError ? 'error' : 'loading';
      nodes = state.loadError ? renderError() : renderLoading();
    } else if (!availableProviders(s).length) {
      kind = 'empty';
      nodes = renderEmpty();
    } else {
      kind = el.tabs.hidden ? 'overview' : state.tab;
      const all = availableProviders(s);
      const one = kind === 'overview' ? null : all.find((p) => p.id === kind) || null;
      const provs = one ? [one] : all;
      const fig = figuresFor(s, one);
      // Keys carry the view, so switching tabs never animates one tab's numbers into another's.
      hero = renderHero(s, fig, kind);
      nodes = [
        notices(s),
        limitsSection(provs, now, kind),
        chartSection(daysFor(s, provs, one, fig), provs, kind),
      ];
    }

    const before = U.snapshotValues(el.app);
    const heroChanged = swap(el.hero, hero ? [hero] : [], 'hero', kind, opts.force);
    el.hero.hidden = !hero;
    el.top.hidden = !hero && el.tabs.hidden;
    const keepScroll = !opts.resetScroll && state.renderedKind === kind ? el.scroller.scrollTop : 0;
    const contentChanged = swap(el.content, nodes, 'content', kind, opts.force || opts.resetScroll);
    if (!heroChanged && !contentChanged) {
      state.skipped += 1;
      return;
    }
    state.renders += 1;
    el.content.dataset.view = kind;
    if (contentChanged) {
      el.scroller.scrollTop = keepScroll;
      syncScrolled();
    }
    state.renderedKind = kind;
    U.placePeaks(el.content);
    U.animateChanges(el.app, before, animateNow());
    // Measured now, not later: the shell sizes the window from this before it shows anything.
    reportHeight();
  }

  // Loading view: update the bar in place so it does not rebuild 20 times a second.
  function updateLoading() {
    const bar = $('#load-progress');
    const text = $('#load-text');
    if (!bar || !text) { render(); return; }
    const frac = progressFrac(state.progress);
    bar.classList.toggle('is-indeterminate', frac === null);
    if (frac !== null) bar.setAttribute('aria-valuenow', String(Math.round(frac * 100)));
    bar.firstChild.style.width = frac === null ? '' : (frac * 100).toFixed(1) + '%';
    text.textContent = progressText(state.progress);
  }

  function doRefresh() {
    state.loadError = null;
    const r = call('refresh');
    if (r && typeof r.then === 'function') r.then(null, (e) => console.error('refresh failed', e));
    if (!state.snapshot) render();
  }

  // ---------------------------------------------------------------- entrance and exit (CONTRACT 8)
  // The shell shows the window with the panel invisible, then calls onShow({ edge }). The panel
  // comes 16 px in from the taskbar side; it leaves 8 px back towards it. Reduced motion: fades only.
  function play(frames, timing, done) {
    if (state.anim) state.anim.cancel();
    const a = el.app.animate(frames, Object.assign({ fill: 'both' }, timing));
    state.anim = a;
    const finish = () => {
      if (state.anim !== a) return;
      state.anim = null;
      if (done) done();
      a.cancel();
    };
    a.onfinish = finish;
    // A window that stops painting (hidden mid-exit) still lands in the end state.
    setTimeout(finish, timing.duration + 60);
  }
  function enter(edge) {
    if (EDGE[edge]) state.edge = edge;
    clearTimeout(state.showFallback);
    state.shown = true;
    state.shownAt = performance.now();
    el.app.classList.remove('is-concealed');
    const [dx, dy] = EDGE[state.edge];
    const d = ENTER.distance;
    play(reducedMotion()
      ? [{ opacity: 0 }, { opacity: 1 }]
      : [{ opacity: 0, transform: 'translate(' + dx * d + 'px, ' + dy * d + 'px)' }, { opacity: 1, transform: 'translate(0px, 0px)' }],
    { duration: ENTER.duration, easing: ENTER.easing });
  }
  function leave() {
    state.shown = false;
    const [dx, dy] = EDGE[state.edge];
    const d = EXIT.distance;
    play(reducedMotion()
      ? [{ opacity: 1 }, { opacity: 0 }]
      : [{ opacity: 1, transform: 'translate(0px, 0px)' }, { opacity: 0, transform: 'translate(' + dx * d + 'px, ' + dy * d + 'px)' }],
    { duration: EXIT.duration, easing: EXIT.easing }, () => {
      if (state.shown) return;
      el.app.classList.add('is-concealed');
      el.scroller.scrollTop = 0;
      syncScrolled();
    });
  }

  // ---------------------------------------------------------------- layout helpers
  // A hairline under the pinned header, only while content is scrolled beneath it.
  function syncScrolled() {
    el.top.classList.toggle('is-scrolled', el.scroller.scrollTop > 0);
  }

  // setContentHeight gets the PANEL's natural height (the shell adds the 12 px margins). The page
  // fills the window, so documentElement.scrollHeight would only echo the window back.
  let heightTimer = 0;
  function scheduleHeight() {
    clearTimeout(heightTimer);
    heightTimer = setTimeout(reportHeight, 40);
  }
  function reportHeight() {
    const cs = getComputedStyle(el.app);
    const border = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    const top = el.top.hidden ? 0 : el.top.getBoundingClientRect().height;
    const px = Math.ceil(border + top + el.content.getBoundingClientRect().height);
    if (px > 0 && Math.abs(px - state.lastHeight) >= 1) {
      state.lastHeight = px;
      call('setContentHeight', px);
    }
  }

  function wireChrome() {
    el.tabs.addEventListener('click', (e) => {
      const btn = e.target.closest('[role="tab"]');
      if (btn) setTab(btn.dataset.tab, false);
    });

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (!state.snapshot || el.tabs.hidden) return;
      const vis = visibleTabs(state.snapshot);
      const i = vis.indexOf(state.tab);
      const next = vis[(i + (e.key === 'ArrowRight' ? 1 : -1) + vis.length) % vis.length];
      e.preventDefault();
      const fromTab = document.activeElement && document.activeElement.getAttribute('role') === 'tab';
      setTab(next, fromTab);
    });

    // Overlay-style scrollbar: show the thumb while scrolling.
    let scrollT = 0;
    el.scroller.addEventListener('scroll', () => {
      syncScrolled();
      el.scroller.classList.add('is-scrolling');
      clearTimeout(scrollT);
      scrollT = setTimeout(() => el.scroller.classList.remove('is-scrolling'), 900);
    }, { passive: true });

    if (window.ResizeObserver) {
      const ro = new ResizeObserver(scheduleHeight);
      ro.observe(el.content);
      ro.observe(el.top);
    }
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { U.placePeaks(el.content); reportHeight(); }, () => {});
    window.addEventListener('resize', () => U.placePeaks(el.content));

    // If the window becomes visible but no onShow arrives (a lost message), show the panel anyway.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || state.shown) return;
      clearTimeout(state.showFallback);
      state.showFallback = setTimeout(() => { if (!state.shown) enter(state.edge); }, 400);
    });

    // Countdowns move only while someone can see them; onShow brings them current first.
    setInterval(() => { if (state.shown) U.tick(el.app, Date.now()); }, TICK_MS);
  }

  // ---------------------------------------------------------------- bridge events
  function onSnapshot(s) {
    state.snapshot = s && typeof s === 'object' ? s : null;
    state.loadError = null;
    state.engineError = null;
    state.progress = null;
    render();
  }
  function onProgress(p) {
    state.progress = obj(p);
    if (!state.snapshot) updateLoading(); // after the first snapshot, scans are silent
  }
  // Before any snapshot: the "Could not read usage / Try again" view. After one: keep showing it,
  // with a quiet notice on top.
  function onError(e) {
    const message = str(e && e.message, 'The data engine stopped');
    state.progress = null;
    if (!state.snapshot) state.loadError = message;
    else state.engineError = message;
    render();
  }
  function onShow(payload) {
    U.tick(el.app, Date.now());
    enter(obj(payload).edge);
  }
  function onHide() {
    leave();
  }

  function start(bridge) {
    state.bridge = bridge;
    wireChrome();
    const sub = (name, fn) => { const r = call(name, fn); return typeof r === 'function' ? r : null; };
    sub('onSnapshot', onSnapshot);
    sub('onProgress', onProgress);
    sub('onError', onError);
    sub('onShow', onShow);
    sub('onHide', onHide);
    render();
    const r = call('getSnapshot');
    if (r && typeof r.then === 'function') {
      r.then((s) => { if (s && !state.snapshot) onSnapshot(s); }, (e) => {
        if (state.snapshot) return;
        state.loadError = str(e && e.message, 'Could not read usage');
        render();
      });
    }
  }

  // ---------------------------------------------------------------- boot
  async function boot() {
    const forceMock = params.get('mock') === '1';
    if (window.meter && !forceMock) { start(window.meter); return; }
    try {
      await loadScript('../shared/mock-snapshot.js');
      if (params.get('variant')) await loadScript('dev/variants.js').catch(() => {});
    } catch (e) {
      console.error(e);
    }
    const bridge = createMockBridge(window.meter || null);
    // Dev hooks for reviewing in a plain browser.
    window.__agentMeterDev = {
      show: (edge) => bridge.__emit('show', { edge: edge || 'bottom' }),
      hide: () => bridge.__emit('hide'),
      progress: (done, total) => bridge.__emit('progress', { phase: 'scanning', filesDone: done, filesTotal: total }),
      snapshot: (s) => bridge.__emit('snapshot', s),
      error: (message) => bridge.__emit('error', { message }),
      stats: () => ({ renders: state.renders, skipped: state.skipped }),
    };
    start(bridge);
    // No shell to send onShow: play the entrance once the first view is on the page.
    if (!window.meter) setTimeout(() => enter('bottom'), 60);
  }

  boot();
})();
