'use strict';
// UI checks for the panel page: electron scripts/ui-check.js   (npm run test:ui)
//
// Loads src/renderer/index.html with the example data (?mock=1&variant=...) in an
// off-screen window (offscreen rendering: nothing ever reaches a monitor) and checks the
// rules of design round 4 (2026-10-03) in the real DOM:
//   - every Claude account has the same rows: 5-hour, Weekly, then Fable
//   - no pace stripe or pace sentences, no "Updated ... ago", no "Claude app" label, no footer
//   - the status line says the right thing for a full account, a full model limit, a limit
//     that runs out before its reset, and says nothing otherwise
//   - an unchanged refresh touches no DOM; a changed one updates the numbers
//   - every view reports a height, and nothing logs a console error
// Exit code 0 when every check passes.

const path = require('node:path');
const { app, BrowserWindow } = require('electron');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('in-process-gpu');
app.setPath('userData', path.join(require('node:os').tmpdir(), 'agent-meter-ui-check'));

const PAGE = path.join(__dirname, '..', 'src', 'renderer', 'index.html');
const results = [];
const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail });

// One off-screen window, navigated to each variant (a fresh window per variant raced its
// predecessor's teardown: ERR_FAILED on the second load).
let shared = null;
async function open(variant) {
  if (!shared) {
    const win = new BrowserWindow({
      show: false,
      width: 424,
      height: 900,
      // An in-memory partition: nothing a run stores (a dismissed notice, the last tab) leaks into the next.
      webPreferences: { offscreen: true, contextIsolation: true, sandbox: true, backgroundThrottling: false, partition: 'ui-check-' + process.pid },
    });
    shared = { win, errors: [] };
    win.webContents.on('console-message', (d) => {
      if (d && d.level === 'error') shared.errors.push(d.message);
    });
  }
  const { win } = shared;
  shared.errors.length = 0;
  await win.loadFile(PAGE, { query: { mock: '1', ...(variant ? { variant } : {}), motion: '0' } });
  const js = (s) => win.webContents.executeJavaScript(s).catch((err) => {
    throw new Error(`page script failed [${variant}]: ${String(s).slice(0, 120)} :: console: ${shared.errors.join(' | ')} :: ${err.message}`);
  });
  // wait for the first real render (rows, or a state block)
  for (let i = 0; i < 100; i++) {
    if (await js('!!document.querySelector(".acct, .state-block")')) break;
    await new Promise((r) => setTimeout(r, 30));
  }
  return { win, js, errors: shared.errors };
}

const FACTS = `(() => {
  const text = document.getElementById('app').innerText;
  const accts = [...document.querySelectorAll('.acct')].map((a) => ({
    name: a.querySelector('.acct-name') && a.querySelector('.acct-name').textContent,
    status: a.querySelector('.acct-status') ? a.querySelector('.acct-status').textContent : null,
    blocked: a.classList.contains('is-blocked'),
    rows: [...a.querySelectorAll('.row')].map((r) => ({
      label: r.querySelector('.row-label').textContent,
      pct: r.querySelector('.row-pct').textContent,
      reset: r.querySelector('.row-reset').textContent,
      fill: r.querySelector('.meter-fill') ? r.querySelector('.meter-fill').style.width : null,
    })),
  }));
  return {
    text,
    accts,
    canvases: document.querySelectorAll('canvas').length,
    footer: !!document.querySelector('footer, .foot, #btn-refresh, #btn-settings, #btn-quit'),
    colHead: (document.querySelector('.col-head') || {}).textContent || null,
    height: Number(document.documentElement.dataset.reportedHeight || 0),
    peak: (document.querySelector('.chart-peak') || {}).textContent || null,
    axis: [...document.querySelectorAll('.chart-axis span')].map((s) => s.textContent),
  };
})()`;

const BANNED = [/in reserve/i, /in deficit/i, /on pace/i, /lasts until reset/i, /updated .*ago/i, /updated just now/i, /claude app/i, /refreshing/i];

async function variantChecks(variant, expect) {
  const { win, js, errors } = await open(variant);
  try {
    const f = await js(FACTS);
    const tag = (s) => `[${variant || 'plain'}] ${s}`;
    for (const re of BANNED) check(tag(`no "${re.source}" text`), !re.test(f.text), re.test(f.text) ? f.text.match(re)[0] : undefined);
    check(tag('no pace stripe canvas, no footer controls'), f.canvases === 0 && !f.footer, { canvases: f.canvases, footer: f.footer });
    check(tag('height reported'), f.height > 100 && f.height < 1000, f.height);
    check(tag('no console errors'), errors.length === 0, errors);
    if (expect.claudeRows) {
      const claude = f.accts.filter((a) => !/ChatGPT/.test(a.name || ''));
      check(tag('every Claude account has 5-hour, Weekly, Fable'), claude.length >= 2 && claude.every((a) => JSON.stringify(a.rows.map((r) => r.label)) === JSON.stringify(['5-hour', 'Weekly', 'Fable'])), claude.map((a) => a.rows.map((r) => r.label)));
      check(tag('"Resets in" heads the reset column'), f.colHead === 'Resets in', f.colHead);
      check(tag('chart: peak labelled, axis = first day + Today'), !!f.peak && f.axis.length === 2 && f.axis[1] === 'Today', { peak: f.peak, axis: f.axis });
    }
    if (expect.status) {
      const got = f.accts.map((a) => a.status);
      check(tag('status lines'), JSON.stringify(got) === JSON.stringify(expect.status.map((s) => (s instanceof RegExp ? got[expect.status.indexOf(s)] && s.test(got[expect.status.indexOf(s)]) ? got[expect.status.indexOf(s)] : '!' + s.source : s))), got);
    }
    if (expect.blocked) check(tag('blocked accounts dimmed'), JSON.stringify(f.accts.map((a) => a.blocked)) === JSON.stringify(expect.blocked), f.accts.map((a) => a.blocked));
    if (expect.more) await expect.more({ f, js, check: (n, ok, d) => check(tag(n), ok, d) });
    return f;
  } finally {
    void win;
  }
}

app.whenReady().then(async () => {
  try {
    // The usual state: Subscription 1 ahead of pace on its week, Subscription 2 at its weekly limit.
    await variantChecks('one-full', {
      claudeRows: true,
      status: [/^Weekly runs out in \d/, /^Limit reached · back in \d/],
      blocked: [false, true],
      more: async ({ f, check: c }) => {
        const k = f.accts[1].rows.find((r) => r.label === 'Weekly');
        c('a full limit reads 100% with a full bar', k.pct === '100%' && k.fill === '100%', k);
        const fable = f.accts[1].rows.find((r) => r.label === 'Fable');
        c('Fable row has its own figure and reset', fable.pct === '64%' && /\d/.test(fable.reset), fable);
      },
    });
    // runsOutAt is now + 1d 18h: "1d 18h", or "1d 17h" once a minute has passed
    await variantChecks('at-risk', { claudeRows: true, status: [/^Weekly runs out in 1d 1[78]h$/, null], blocked: [false, false] });
    await variantChecks('fable-full', { claudeRows: true, status: ['Fable limit reached', null], blocked: [false, false] });
    // both accounts below their limits: nothing to say, nothing dimmed
    await variantChecks('both-room', { claudeRows: true, blocked: [false, false] });
    await variantChecks('error', {
      claudeRows: true,
      more: async ({ f, check: c }) => c('an unreadable account says so', f.accts[1].status === 'Can’t read limits', f.accts[1].status),
    });
    await variantChecks('stale', {
      claudeRows: true,
      more: async ({ f, check: c }) => c('old limits are called out', /Usage Monitor hasn’t updated limits for 2 h/.test(f.text), null),
    });
    await variantChecks('missing', {
      more: async ({ f, check: c }) => {
        const a = f.accts[1];
        c('an account with no windows: dashes, "No reading yet"', a && a.status === 'No reading yet' && a.rows.every((r) => r.pct === '–'), a);
      },
    });
    await variantChecks('long-email', { claudeRows: true });
    await variantChecks('huge', { claudeRows: true });
    await variantChecks('warnings', {
      claudeRows: true,
      more: async ({ js, check: c }) => {
        const before = await js('document.querySelectorAll(".notice").length');
        await js('document.querySelector(".notice-x").click()');
        await new Promise((r) => setTimeout(r, 50));
        const after = await js('document.querySelectorAll(".notice").length');
        c('a warning can be dismissed', before === 1 && after === 0, { before, after });
      },
    });
    // Two providers (Codex active): tabs appear; Codex rows are its own windows.
    await variantChecks('', {
      more: async ({ js, check: c }) => {
        const tabs = await js('[...document.querySelectorAll(".tab")].map((t) => t.textContent)');
        c('two providers: Overview / Claude / Codex tabs', JSON.stringify(tabs) === JSON.stringify(['Overview', 'Claude', 'Codex']), tabs);
      },
    });
    await variantChecks('loading', {
      more: async ({ f, check: c }) => c('loading view', /Reading your history/.test(f.text), null),
    });
    await variantChecks('broken', {
      more: async ({ f, check: c }) => c('error view with Try again', /Could not read usage/.test(f.text) && /Try again/.test(f.text), null),
    });

    // Render skipping and live updates, on the plain one-account view.
    {
      const { win, js } = await open('one-full');
      try {
        const snap = await js('JSON.stringify(window.__MOCK_SNAPSHOT__)');
        const emit = `(() => { const v = window.__MOCK_VARIANTS__['one-full']; const s = JSON.parse(${JSON.stringify(snap)}); window.__agentMeterDev.snapshot(v(s, 0)); })()`;
        await js(emit); // snapshot A (different times from the loaded one: it renders)
        const s0 = await js('window.__agentMeterDev.stats()');
        await js('window.__n0 = document.querySelector(".row"); window.__h0 = document.querySelector(".hero"); true');
        await js(emit); // A again: identical page
        await js(emit);
        const s1 = await js('window.__agentMeterDev.stats()');
        const same = await js('document.querySelector(".row") === window.__n0 && document.querySelector(".hero") === window.__h0');
        check('an identical refresh is skipped (no DOM work)', s1.skipped === s0.skipped + 2 && s1.renders === s0.renders && same, { s0, s1, sameNodes: same });
        // change one number: the page updates it
        await js(`(() => { const v = window.__MOCK_VARIANTS__['one-full']; const s = v(JSON.parse(${JSON.stringify(snap)}), 0); s.overview.headline.todayUSD = 777.77; window.__agentMeterDev.snapshot(s); })()`);
        const today = await js('document.querySelector(".hero-sub .hero-sub-v").textContent');
        const s2 = await js('window.__agentMeterDev.stats()');
        check('a changed figure is rendered', today === '$778' && s2.renders === s1.renders + 1, { today, s2 });
      } finally {
        void win;
      }
    }
  } catch (err) {
    check('ui-check ran without throwing', false, String((err && err.stack) || err));
  }
  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log((r.ok ? 'ok   ' : 'FAIL ') + r.name + (r.ok || r.detail === undefined ? '' : '  ' + JSON.stringify(r.detail)));
  console.log(`\nui-check: ${results.length - failed.length}/${results.length} passed`);
  app.exit(failed.length ? 1 : 0);
});
