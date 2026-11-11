'use strict';
// Strict validator for the Snapshot shape in CONTRACT section 2: every field must be
// present with the right type, and no field outside the contract may appear.
// Returns a list of problems (empty = valid).
//
// `lifetime` (overview.lifetime, providers[].spend.lifetime) is optional in the
// contract (`lifetime?: Lifetime`), so the shared mock may omit it; when present it
// must be exactly { tokens, costUSD, sessions, since }. { requireLifetime: true }
// makes it mandatory, which is what the DATA layer's own snapshots must satisfy.
//
// `overview.headline` (Headline) is optional the same way: when present it must be
// exactly { basis, tokens, costUSD, d30CostUSD, todayUSD, d30Tokens, since } with basis
// "claude-app" | "per-reply". { requireHeadline: true } makes it mandatory.

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function validateSnapshot(s, { requireLifetime = false, requireHeadline = false } = {}) {
  const errs = [];
  const at = (p, m) => errs.push(p + ': ' + m);
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const keys = (p, o, want, optional = []) => {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return at(p, 'not an object');
    const have = Object.keys(o).sort();
    const w = [...want].sort();
    for (const k of w) if (!have.includes(k)) at(p, 'missing ' + k);
    for (const k of have) if (!w.includes(k) && !optional.includes(k)) at(p, 'unexpected ' + k);
  };
  const DATE_OR_NULL = (p, v) => v === null || (typeof v === 'string' && DATE.test(v)) || at(p, 'not YYYY-MM-DD|null: ' + v);
  const checkHeadline = (p, h) => {
    if (h === undefined) {
      if (requireHeadline) at(p, 'missing');
      return;
    }
    keys(p, h, ['basis', 'tokens', 'costUSD', 'd30CostUSD', 'todayUSD', 'd30Tokens', 'since']);
    if (!h || typeof h !== 'object') return;
    oneOf(p + '.basis', h.basis, ['claude-app', 'per-reply']);
    for (const k of ['tokens', 'costUSD', 'd30CostUSD', 'todayUSD', 'd30Tokens']) {
      num(p + '.' + k, h[k]);
      if (h[k] < 0) at(p + '.' + k, 'negative');
    }
    DATE_OR_NULL(p + '.since', h.since);
  };
  const checkLifetime = (p, l) => {
    if (l === undefined) {
      if (requireLifetime) at(p, 'missing');
      return;
    }
    keys(p, l, ['tokens', 'costUSD', 'sessions', 'since']);
    if (!l || typeof l !== 'object') return;
    num(p + '.tokens', l.tokens);
    num(p + '.costUSD', l.costUSD);
    num(p + '.sessions', l.sessions);
    DATE_OR_NULL(p + '.since', l.since);
  };
  const num = (p, v) => isNum(v) || at(p, 'not a finite number: ' + JSON.stringify(v));
  const str = (p, v) => typeof v === 'string' || at(p, 'not a string');
  const strOrNull = (p, v) => v === null || typeof v === 'string' || at(p, 'not string|null');
  const isoOrNull = (p, v) => v === null || (typeof v === 'string' && ISO.test(v)) || at(p, 'not ISO|null: ' + v);
  const bool = (p, v) => typeof v === 'boolean' || at(p, 'not a boolean');
  const oneOf = (p, v, list) => list.includes(v) || at(p, 'not one of ' + list.join('|') + ': ' + v);
  const arr = (p, v) => Array.isArray(v) || (at(p, 'not an array'), false);

  keys('snapshot', s, ['schemaVersion', 'generatedAt', 'rangeDays', 'overview', 'providers', 'warnings']);
  if (!s || typeof s !== 'object') return errs;
  if (s.schemaVersion !== 1) at('schemaVersion', 'not 1');
  if (!(typeof s.generatedAt === 'string' && ISO.test(s.generatedAt))) at('generatedAt', 'not ISO');
  num('rangeDays', s.rangeDays);

  const o = s.overview;
  keys('overview', o, ['costUSD', 'tokens', 'sessions', 'subscriptions', 'subscriptionsWithSpend', 'activeDays', 'priced', 'unpriced', 'daily'], ['lifetime', 'headline']);
  if (o) {
    checkLifetime('overview.lifetime', o.lifetime);
    checkHeadline('overview.headline', o.headline);
    for (const k of ['costUSD', 'tokens', 'sessions', 'subscriptions', 'subscriptionsWithSpend', 'activeDays', 'priced', 'unpriced']) num('overview.' + k, o[k]);
    if (arr('overview.daily', o.daily)) {
      if (o.daily.length !== s.rangeDays) at('overview.daily', 'length ' + o.daily.length + ' != rangeDays ' + s.rangeDays);
      o.daily.forEach((d, i) => {
        const p = 'overview.daily[' + i + ']';
        keys(p, d, ['date', 'costUSD', 'tokens', 'byProvider']);
        if (!d) return;
        if (!(typeof d.date === 'string' && DATE.test(d.date))) at(p + '.date', 'not YYYY-MM-DD');
        num(p + '.costUSD', d.costUSD);
        num(p + '.tokens', d.tokens);
        if (!d.byProvider || typeof d.byProvider !== 'object') at(p + '.byProvider', 'not an object');
        else for (const [k, v] of Object.entries(d.byProvider)) num(p + '.byProvider.' + k, v);
      });
    }
  }

  if (arr('providers', s.providers)) {
    const ids = s.providers.map((p) => p && p.id);
    if (JSON.stringify(ids) !== JSON.stringify(['claude', 'codex'])) at('providers', 'order is ' + ids.join(','));
    s.providers.forEach((pr, i) => {
      const p = 'providers[' + i + ']';
      keys(p, pr, ['id', 'name', 'available', 'plan', 'limits', 'spend', 'storageBytes']);
      if (!pr) return;
      oneOf(p + '.id', pr.id, ['claude', 'codex']);
      str(p + '.name', pr.name);
      bool(p + '.available', pr.available);
      strOrNull(p + '.plan', pr.plan);
      num(p + '.storageBytes', pr.storageBytes);
      // limits.warnings (2026-10-03): the limit warnings travel with the block the shell
      // swaps in. Optional so the shared mock may omit it; the DATA layer always sends it.
      keys(p + '.limits', pr.limits, ['updatedAt', 'source', 'accounts'], ['warnings', 'activeId']);
      if (pr.limits) {
        isoOrNull(p + '.limits.updatedAt', pr.limits.updatedAt);
        str(p + '.limits.source', pr.limits.source);
        if (pr.limits.warnings !== undefined && arr(p + '.limits.warnings', pr.limits.warnings)) {
          pr.limits.warnings.forEach((w, j) => str(p + '.limits.warnings[' + j + ']', w));
        }
        if (arr(p + '.limits.accounts', pr.limits.accounts)) pr.limits.accounts.forEach((a, j) => checkAccount(p + '.limits.accounts[' + j + ']', a));
      }
      checkSpend(p + '.spend', pr.spend, s.rangeDays);
    });
  }
  if (arr('warnings', s.warnings)) s.warnings.forEach((w, i) => str('warnings[' + i + ']', w));
  return errs;

  function checkAccount(p, a) {
    keys(p, a, ['id', 'name', 'kind', 'status', 'error', 'windows']);
    if (!a) return;
    str(p + '.id', a.id);
    str(p + '.name', a.name);
    oneOf(p + '.kind', a.kind, ['claude-app', 'folder', 'codex']);
    oneOf(p + '.status', a.status, ['ok', 'stale', 'error', 'unavailable']);
    strOrNull(p + '.error', a.error);
    if (arr(p + '.windows', a.windows)) a.windows.forEach((w, k) => checkWindow(p + '.windows[' + k + ']', w));
  }
  function checkWindow(p, w) {
    keys(p, w, ['key', 'label', 'usedPct', 'resetsAt', 'windowMinutes', 'pace']);
    if (!w) return;
    str(p + '.key', w.key);
    str(p + '.label', w.label);
    num(p + '.usedPct', w.usedPct);
    if (w.usedPct < 0 || w.usedPct > 100) at(p + '.usedPct', 'out of 0..100');
    isoOrNull(p + '.resetsAt', w.resetsAt);
    num(p + '.windowMinutes', w.windowMinutes);
    keys(p + '.pace', w.pace, ['expectedPct', 'deltaPct', 'state', 'runsOutAt', 'lastsUntilReset']);
    if (w.pace) {
      num(p + '.pace.expectedPct', w.pace.expectedPct);
      num(p + '.pace.deltaPct', w.pace.deltaPct);
      oneOf(p + '.pace.state', w.pace.state, ['reserve', 'on-pace', 'deficit', 'full']);
      isoOrNull(p + '.pace.runsOutAt', w.pace.runsOutAt);
      bool(p + '.pace.lastsUntilReset', w.pace.lastsUntilReset);
    }
  }
  function checkSpend(p, sp, rangeDays) {
    keys(p, sp, ['todayUSD', 'd30USD', 'todayTokens', 'd30Tokens', 'sessions30d', 'topModel', 'cacheSavingsUSD', 'tokenBreakdown', 'models', 'daily', 'sources'], ['lifetime']);
    if (!sp) return;
    checkLifetime(p + '.lifetime', sp.lifetime);
    for (const k of ['todayUSD', 'd30USD', 'todayTokens', 'd30Tokens', 'sessions30d', 'cacheSavingsUSD']) num(p + '.' + k, sp[k]);
    strOrNull(p + '.topModel', sp.topModel);
    keys(p + '.tokenBreakdown', sp.tokenBreakdown, ['input', 'output', 'cacheRead', 'cacheWrite']);
    if (sp.tokenBreakdown) for (const k of ['input', 'output', 'cacheRead', 'cacheWrite']) num(p + '.tokenBreakdown.' + k, sp.tokenBreakdown[k]);
    if (arr(p + '.models', sp.models)) {
      sp.models.forEach((m, i) => {
        const q = p + '.models[' + i + ']';
        keys(q, m, ['model', 'costUSD', 'tokens', 'share', 'priced']);
        if (!m) return;
        str(q + '.model', m.model);
        num(q + '.costUSD', m.costUSD);
        num(q + '.tokens', m.tokens);
        num(q + '.share', m.share);
        bool(q + '.priced', m.priced);
      });
    }
    if (arr(p + '.daily', sp.daily)) {
      if (sp.daily.length !== rangeDays) at(p + '.daily', 'length ' + sp.daily.length + ' != rangeDays');
      sp.daily.forEach((d, i) => {
        const q = p + '.daily[' + i + ']';
        keys(q, d, ['date', 'costUSD', 'tokens']);
        if (!d) return;
        if (!(typeof d.date === 'string' && DATE.test(d.date))) at(q + '.date', 'not YYYY-MM-DD');
        num(q + '.costUSD', d.costUSD);
        num(q + '.tokens', d.tokens);
      });
    }
    if (arr(p + '.sources', sp.sources)) {
      sp.sources.forEach((x, i) => {
        const q = p + '.sources[' + i + ']';
        keys(q, x, ['id', 'label', 'path', 'accountName', 'd30USD', 'd30Tokens', 'sessions30d', 'sizeBytes']);
        if (!x) return;
        str(q + '.id', x.id);
        str(q + '.label', x.label);
        str(q + '.path', x.path);
        strOrNull(q + '.accountName', x.accountName);
        for (const k of ['d30USD', 'd30Tokens', 'sessions30d', 'sizeBytes']) num(q + '.' + k, x[k]);
      });
    }
  }
}

module.exports = { validateSnapshot };
