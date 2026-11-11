'use strict';
// API-equivalent pricing. USD per MILLION tokens.
//
// Claude models come from the table in CONTRACT section 3 (Anthropic first-party
// list prices as of 2026-09-25). Anything else (Codex gpt-*, an unknown Claude id)
// is looked up in LiteLLM's public price list, cached in the state dir for 24 h.
// The lookup never blocks a snapshot: a model with no price yet is "unpriced"
// (cost 0, tokens still counted) and picks up its price on a later snapshot.

const path = require('node:path');
const https = require('node:https');
const { readJsonSafe, writeJsonAtomic, removeStaleTemps } = require('./util');

const LITELLM_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const LITELLM_FILE = 'litellm-prices.json';
const LITELLM_TTL_MS = 24 * 3600 * 1000;
const LITELLM_RETRY_MS = 3600 * 1000; // after a FAILED attempt (offline laptop)
const LITELLM_TIMEOUT_MS = 20000;
const LITELLM_MAX_BYTES = 40 * 1024 * 1024;
const FAST_MULTIPLIER = 2;

// [model prefix, input, output, cache write 5m, cache write 1h, cache read]
const CLAUDE_ROWS = [
  ['claude-fable-5-1', 10, 50, 12.5, 20, 0.25],
  ['claude-fable-5', 10, 50, 12.5, 20, 1.0],
  ['claude-opus-5-5', 4, 20, 5.0, 8, 0.2],
  ['claude-opus-5', 5, 25, 6.25, 10, 0.5],
  ['claude-opus-4-8', 5, 25, 6.25, 10, 0.5],
  ['claude-opus-4-7', 5, 25, 6.25, 10, 0.5],
  ['claude-opus-4-6', 5, 25, 6.25, 10, 0.5],
  ['claude-sonnet-5-5', 2, 10, 2.5, 4, 0.2],
  ['claude-sonnet-5', 2, 10, 2.5, 4, 0.2],
  ['claude-sonnet-4-6', 3, 15, 3.75, 6, 0.3],
  ['claude-haiku-4-5', 1, 5, 1.25, 2, 0.1],
];

// Longest prefix first, so "claude-opus-5-5" wins over "claude-opus-5".
function buildTable(rows) {
  return rows
    .map(([prefix, input, output, cw5, cw1, cr]) => ({
      prefix,
      price: Object.freeze({
        input,
        output,
        cacheWrite5m: cw5,
        cacheWrite1h: cw1,
        cacheRead: cr,
        source: 'table',
      }),
    }))
    .sort((a, b) => b.prefix.length - a.prefix.length);
}
const CLAUDE_TABLE = buildTable(CLAUDE_ROWS);

// Canonical id used for display and table matching:
//   "claude-haiku-4-5-20251001"            -> "claude-haiku-4-5"
//   "us.anthropic.claude-opus-4-6-v1:0"    -> "claude-opus-4-6"
//   "claude-opus-4-6@20260101"             -> "claude-opus-4-6"
//   "claude-opus-5-5[1m]"                  -> "claude-opus-5-5"
//   "gpt-5.5"                              -> "gpt-5.5" (non-Claude ids keep their name)
function normalizeModelId(id) {
  if (typeof id !== 'string' || !id.trim()) return 'unknown';
  let m = id.trim().toLowerCase();
  const at = m.indexOf('claude-');
  if (at > 0) m = m.slice(at);
  m = m.replace(/\[[^\]]*\]$/, '');
  if (m.startsWith('claude-')) {
    m = m.replace(/@.*$/, '');
    m = m.replace(/-v\d+(:\d+)?$/, '');
    m = m.replace(/-latest$/, '');
  }
  m = m.replace(/-\d{8}$/, '');
  return m;
}

function tablePrice(normalized, table = CLAUDE_TABLE) {
  for (const row of table) {
    if (normalized === row.prefix || normalized.startsWith(row.prefix + '-')) return row.price;
  }
  return null;
}

// tokens: { input, output, cacheRead, cacheWrite5m, cacheWrite1h } (plain counts)
function costUSD(tokens, price, fast = false) {
  if (!price) return 0;
  const usd =
    ((tokens.input || 0) * price.input +
      (tokens.output || 0) * price.output +
      (tokens.cacheRead || 0) * price.cacheRead +
      (tokens.cacheWrite5m || 0) * price.cacheWrite5m +
      (tokens.cacheWrite1h || 0) * price.cacheWrite1h) /
    1e6;
  return fast ? usd * FAST_MULTIPLIER : usd;
}

// What the cache reads would have cost as plain input, minus what they did cost.
function cacheSavingsUSD(cacheRead, price, fast = false) {
  if (!price || !cacheRead) return 0;
  const usd = (cacheRead * Math.max(0, price.input - price.cacheRead)) / 1e6;
  return fast ? usd * FAST_MULTIPLIER : usd;
}

// LiteLLM per-token USD -> our per-million shape. Missing cache prices fall back to
// the input price (no discount claimed), 1h writes to 1.6x the 5m write (2x vs 1.25x input).
function fromLiteLLM(e) {
  const per = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v * 1e6 : null);
  const input = per(e.input_cost_per_token);
  const output = per(e.output_cost_per_token);
  if (input === null && output === null) return null;
  const inP = input ?? 0;
  const cw5 = per(e.cache_creation_input_token_cost) ?? inP;
  const cw1 = per(e.cache_creation_input_token_cost_above_1hr) ?? cw5 * 1.6;
  const cr = per(e.cache_read_input_token_cost) ?? inP;
  return [inP, output ?? 0, cw5, cw1, cr];
}

function trimLiteLLM(raw) {
  const models = {};
  if (!raw || typeof raw !== 'object') return models;
  for (const [name, e] of Object.entries(raw)) {
    if (!e || typeof e !== 'object' || name === 'sample_spec') continue;
    const row = fromLiteLLM(e);
    if (row) models[name.toLowerCase()] = row;
  }
  return models;
}

function defaultFetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: LITELLM_TIMEOUT_MS, headers: { 'user-agent': 'agent-meter' } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error('HTTP ' + res.statusCode));
        return;
      }
      const parts = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > LITELLM_MAX_BYTES) {
          req.destroy(new Error('price list too large'));
          return;
        }
        parts.push(c);
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(parts).toString('utf8')));
        } catch (err) {
          reject(err);
        }
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

// createPricing({ stateDir, allowNetwork, now, fetchJson })
//   priceFor(rawModelId)  -> price | null      (synchronous, never touches the network)
//   refreshIfDue()        -> Promise | null    (starts at most one background fetch)
//   pending               -> the in-flight fetch promise, or null
// tableRows: replaces CLAUDE_ROWS (same row shape). Used by tests to prove that a
// price-table fix reprices stored history; the app never passes it.
function createPricing({ stateDir, allowNetwork = true, now = Date.now, fetchJson = defaultFetchJson, tableRows } = {}) {
  const table = Array.isArray(tableRows) ? buildTable(tableRows) : CLAUDE_TABLE;
  const file = stateDir ? path.join(stateDir, LITELLM_FILE) : null;
  if (file) removeStaleTemps(file);
  let cache = (file && readJsonSafe(file)) || null;
  if (!cache || typeof cache !== 'object' || typeof cache.models !== 'object' || cache.models === null) {
    cache = { fetchedAt: 0, attemptedAt: 0, models: {} };
  }
  let pending = null;
  const memo = new Map();

  function liteLLMRow(raw, normalized) {
    const models = cache.models;
    const lower = String(raw || '').toLowerCase();
    const bare = lower.includes('/') ? lower.slice(lower.lastIndexOf('/') + 1) : lower;
    for (const k of [lower, bare, normalized, 'openai/' + normalized, 'anthropic/' + normalized]) {
      if (k && Object.prototype.hasOwnProperty.call(models, k)) return models[k];
    }
    return null;
  }

  function priceFor(rawModel) {
    if (memo.has(rawModel)) return memo.get(rawModel);
    const normalized = normalizeModelId(rawModel);
    let price = tablePrice(normalized, table);
    if (!price) {
      const row = liteLLMRow(rawModel, normalized);
      if (row) {
        price = Object.freeze({
          input: row[0],
          output: row[1],
          cacheWrite5m: row[2],
          cacheWrite1h: row[3],
          cacheRead: row[4],
          source: 'litellm',
        });
      }
    }
    memo.set(rawModel, price || null);
    return price || null;
  }

  // A successful fetch is reused for 24 h. A failed attempt (offline, HTTP error) is
  // retried after 1 h rather than on every snapshot. Failures are silent.
  // force (a user-requested refresh) skips the 1 h failure backoff, never the 24 h reuse.
  function refreshIfDue({ force = false } = {}) {
    if (!allowNetwork || !file || pending) return pending;
    const t = now();
    if (t - (cache.fetchedAt || 0) < LITELLM_TTL_MS) return null;
    if (!force && t - (cache.attemptedAt || 0) < LITELLM_RETRY_MS) return null;
    cache.attemptedAt = t;
    try {
      writeJsonAtomic(file, cache);
    } catch {
      /* state dir not writable: still try the fetch */
    }
    pending = Promise.resolve()
      .then(() => fetchJson(LITELLM_URL))
      .then((raw) => {
        const models = trimLiteLLM(raw);
        if (Object.keys(models).length === 0) return false;
        cache = { fetchedAt: now(), attemptedAt: cache.attemptedAt, models };
        memo.clear();
        try {
          writeJsonAtomic(file, cache);
        } catch {
          /* ignore */
        }
        return true;
      })
      .catch(() => false)
      .finally(() => {
        pending = null;
      });
    return pending;
  }

  return {
    priceFor,
    refreshIfDue,
    get pending() {
      return pending;
    },
    get liteLLMFetchedAt() {
      return cache.fetchedAt || 0;
    },
  };
}

module.exports = {
  CLAUDE_ROWS,
  FAST_MULTIPLIER,
  LITELLM_URL,
  normalizeModelId,
  tablePrice,
  costUSD,
  cacheSavingsUSD,
  trimLiteLLM,
  createPricing,
};

