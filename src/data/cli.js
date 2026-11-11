#!/usr/bin/env node
'use strict';
// node src/data/cli.js [--pretty] [--state <dir>] [--days N] [--basis per-reply|claude-app] [--offline] [--stats]
//
// Prints one Snapshot (CONTRACT section 2) as JSON on stdout.
//   --state <dir>  index + price cache folder. Default %APPDATA%\agent-meter-cli, kept
//                  apart from the app's own state so a CLI run never disturbs it.
//   --days N       range in days (default 30).
//   --basis B      headline cost basis: per-reply (default, the real API cost) or claude-app.
//   --offline      never fetch the LiteLLM price list.
//   --stats        scan timings / counters on stderr (counts only, no content).

const os = require('node:os');
const path = require('node:path');
const { createCollector } = require('./index');

function parseArgs(argv) {
  const out = { pretty: false, state: null, days: 30, basis: undefined, offline: false, stats: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pretty') out.pretty = true;
    else if (a === '--offline') out.offline = true;
    else if (a === '--stats') out.stats = true;
    else if (a === '--state') out.state = argv[++i];
    else if (a.startsWith('--state=')) out.state = a.slice(8);
    else if (a === '--days') out.days = Number(argv[++i]);
    else if (a === '--basis') out.basis = argv[++i];
    else if (a.startsWith('--basis=')) out.basis = a.slice(8);
    else if (a.startsWith('--days=')) out.days = Number(a.slice(7));
    else if (a === '--help' || a === '-h') out.help = true;
    else {
      process.stderr.write('unknown argument: ' + a + '\n');
      out.help = true;
    }
  }
  if (!Number.isFinite(out.days) || out.days < 1) out.days = 30;
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stderr.write('usage: node src/data/cli.js [--pretty] [--state <dir>] [--days N] [--basis per-reply|claude-app] [--offline] [--stats]\n');
    process.exitCode = 2;
    return;
  }
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const stateDir = args.state ? path.resolve(args.state) : path.join(appData, 'agent-meter-cli');
  const collector = createCollector({ stateDir, rangeDays: args.days, allowNetwork: !args.offline, costBasis: args.basis });
  const snap = await collector.snapshot();
  process.stdout.write(JSON.stringify(snap, null, args.pretty ? 2 : 0) + '\n');
  if (args.stats) process.stderr.write(JSON.stringify(collector.lastStats) + '\n');
  // Let a price-list fetch this run started finish, so the next run has prices.
  const pending = collector.pricingPending;
  if (pending) await pending;
}

main().catch((err) => {
  process.stderr.write('agent-meter cli: ' + (err && err.stack ? err.stack : String(err)) + '\n');
  process.exitCode = 1;
});
