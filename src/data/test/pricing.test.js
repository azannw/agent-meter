'use strict';
process.env.TZ = 'Asia/Karachi';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeModelId, tablePrice, costUSD, cacheSavingsUSD, createPricing, CLAUDE_ROWS } = require('../pricing');
const { mkTmp, rmrf } = require('./helpers');

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('model ids: date suffix, provider prefixes and context tags are stripped', () => {
  assert.equal(normalizeModelId('claude-haiku-4-5-20251001'), 'claude-haiku-4-5');
  assert.equal(normalizeModelId('us.anthropic.claude-opus-4-6-v1:0'), 'claude-opus-4-6');
  assert.equal(normalizeModelId('anthropic/claude-sonnet-5'), 'claude-sonnet-5');
  assert.equal(normalizeModelId('claude-opus-4-7@20260101'), 'claude-opus-4-7');
  assert.equal(normalizeModelId('claude-opus-5-5[1m]'), 'claude-opus-5-5');
  assert.equal(normalizeModelId('gpt-5.5'), 'gpt-5.5');
  assert.equal(normalizeModelId(undefined), 'unknown');
  assert.equal(tablePrice(normalizeModelId('claude-haiku-4-5-20251001')).input, 1);
});

test('longest prefix wins: opus-5-5 is not priced as opus-5, fable-5-1 not as fable-5', () => {
  assert.equal(tablePrice('claude-opus-5-5').input, 4);
  assert.equal(tablePrice('claude-opus-5').input, 5);
  assert.equal(tablePrice('claude-fable-5-1').cacheRead, 0.25);
  assert.equal(tablePrice('claude-fable-5').cacheRead, 1.0);
  assert.equal(tablePrice('claude-sonnet-5-5').output, 10);
  assert.equal(tablePrice('claude-sonnet-4-6').output, 15);
  assert.equal(tablePrice('claude-opus-4-8').cacheWrite1h, 10);
  assert.equal(tablePrice('claude-3-opus'), null);
  assert.equal(CLAUDE_ROWS.length, 11);
});

test('cost uses separate 5m and 1h cache-write prices', () => {
  const p = tablePrice('claude-opus-5-5');
  const tokens = { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite5m: 1e6, cacheWrite1h: 1e6 };
  close(costUSD(tokens, p), 4 + 20 + 0.2 + 5 + 8);
  close(costUSD({ cacheWrite1h: 2e6 }, p), 16);
  close(costUSD({ cacheWrite5m: 2e6 }, p), 10);
});

test('fast mode doubles the whole message cost (and the cache savings)', () => {
  const p = tablePrice('claude-opus-5');
  const tokens = { input: 1000, output: 2000, cacheRead: 3000, cacheWrite5m: 400, cacheWrite1h: 500 };
  const std = costUSD(tokens, p, false);
  close(costUSD(tokens, p, true), std * 2);
  close(cacheSavingsUSD(1e6, p, false), 5 - 0.5);
  close(cacheSavingsUSD(1e6, p, true), (5 - 0.5) * 2);
});

test('unknown models are unpriced: null price, zero cost', () => {
  const dir = mkTmp('price');
  try {
    const pricing = createPricing({ stateDir: dir, allowNetwork: false });
    assert.equal(pricing.priceFor('gpt-5.5'), null);
    assert.equal(pricing.priceFor('claude-imaginary-9'), null);
    assert.equal(costUSD({ input: 1e6 }, null), 0);
    assert.equal(pricing.refreshIfDue(), null, 'no network allowed: no fetch');
  } finally {
    rmrf(dir);
  }
});

test('LiteLLM lookup: fetched once, cached in stateDir for 24 h, failures silent', async () => {
  const dir = mkTmp('price');
  try {
    let t = Date.parse('2026-10-01T00:00:00Z');
    let calls = 0;
    const fetchJson = async () => {
      calls++;
      return {
        sample_spec: { input_cost_per_token: 1 },
        'gpt-5.5': { input_cost_per_token: 5e-6, output_cost_per_token: 30e-6, cache_read_input_token_cost: 0.5e-6 },
        'claude-imaginary-9': { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 },
      };
    };
    const pricing = createPricing({ stateDir: dir, now: () => t, fetchJson });
    assert.equal(pricing.priceFor('gpt-5.5'), null, 'not known before the fetch');
    const pending = pricing.refreshIfDue();
    assert.ok(pending, 'a fetch started');
    assert.equal(pricing.refreshIfDue(), pending, 'no second fetch while one is in flight');
    assert.equal(await pending, true);
    const p = pricing.priceFor('gpt-5.5');
    assert.equal(p.source, 'litellm');
    close(p.input, 5);
    close(p.output, 30);
    close(p.cacheRead, 0.5);
    close(pricing.priceFor('claude-imaginary-9').cacheRead, 1, 1e-9); // missing cache price -> input price
    assert.ok(fs.existsSync(path.join(dir, 'litellm-prices.json')));

    t += 3600e3;
    assert.equal(pricing.refreshIfDue(), null, 'reused within 24 h');
    const again = createPricing({ stateDir: dir, now: () => t, fetchJson });
    close(again.priceFor('gpt-5.5').output, 30); // read back from the cache file
    assert.equal(again.refreshIfDue(), null);
    assert.equal(calls, 1);

    t += 24 * 3600e3;
    const failing = createPricing({ stateDir: dir, now: () => t, fetchJson: async () => { throw new Error('offline'); } });
    assert.equal(await failing.refreshIfDue(), false, 'failure resolves false, never throws');
    close(failing.priceFor('gpt-5.5').input, 5, 1e-9); // the old cache survives a failed refresh
    assert.equal(failing.refreshIfDue(), null, 'failed attempt backs off');
  } finally {
    rmrf(dir);
  }
});
