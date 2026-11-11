'use strict';
// One-column Usage Monitor themes, one per Claude profile, for following the account
// the Claude desktop app is using (src/main/follow-account.js switches between them).
// Built from the Monitor's own Classic theme, whose Claude layers show the SELECTED
// profile: themes\agent-meter-default.json is blue (Subscription 1, acme) and
// themes\agent-meter-account_1.json the Classic orange (Subscription 2, gmail). A used-up
// week dims the column and shows "FULL" in place of the 5-hour value, as the
// two-column theme did.
// Usage: node scripts/make-monitor-themes.js
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const THEMES = path.join(appData, 'ClaudeCodeUsageMonitor', 'themes');
const BLUE = { '#D97757FF': '#5B9BE0FF', '#F09A7AFF': '#8EC1F5FF', '#A94F32FF': '#2F6DB0FF' };
const FULL_COLOUR = { dark: '#FF7B72FF', light: '#B3261EFF' };
const DIM = 35; // percent opacity of a used-up column
const FULL = '(claude.weekly.percentage >= 100)';
const PROFILES = [
  { id: 'default', name: 'Subscription 1', recolour: BLUE },
  { id: 'account_1', name: 'Subscription 2', recolour: null },
];

function rewrite(node, fn) {
  if (Array.isArray(node)) return node.map((v) => rewrite(v, fn));
  if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, rewrite(v, fn)]));
  return typeof node === 'string' ? fn(node) : node;
}

function claudeLayers(layers, recolour) {
  const out = [];
  for (const layer of layers) {
    const d = recolour ? rewrite(layer, (s) => recolour[s] || s) : structuredClone(layer);
    if (d.id === 'claude-provider') {
      out.push(d);
      continue;
    }
    d.visibility = `100 - (100 - ${DIM}) * ${FULL}`;
    if (d.id.includes('-session-value-')) {
      const mode = d.id.endsWith('-dark') ? 'dark' : 'light';
      const label = structuredClone(d);
      label.id = d.id.replace('-session-value-', '-full-label-');
      label.name = d.name.replace('5-hour value', 'weekly limit used up');
      label.render = `(${d.render}) && ${FULL}`;
      label.visibility = '100';
      label.content.template = 'FULL';
      label.content.weight = 'bold';
      label.content.color = { color: FULL_COLOUR[mode], opacity: '1' };
      d.render = `(${d.render}) && !${FULL}`;
      out.push(d, label);
      continue;
    }
    out.push(d);
  }
  return out;
}

const classic = JSON.parse(fs.readFileSync(path.join(THEMES, 'classic-usage-widget.json'), 'utf8'));
for (const p of PROFILES) {
  const theme = structuredClone(classic);
  theme.id = `agent-meter-${p.id}`;
  theme.name = `Classic, ${p.name} (Agent Meter)`;
  const main = theme.surfaces[0];
  if (main.id !== 'main') throw new Error('Classic theme layout changed: no "main" surface first');
  const kids = main.children;
  const first = kids.findIndex((c) => c.id.startsWith('claude-'));
  const claude = claudeLayers(kids.filter((c) => c.id.startsWith('claude-')), p.recolour);
  const rest = kids.filter((c) => !c.id.startsWith('claude-'));
  main.children = [...rest.slice(0, first), ...claude, ...rest.slice(first)];
  const out = path.join(THEMES, `${theme.id}.json`);
  fs.writeFileSync(out, JSON.stringify(theme, null, 2));
  const ids = main.children.map((c) => c.id);
  console.log('wrote', out, 'layers:', ids.length, 'unique:', new Set(ids).size);
}
