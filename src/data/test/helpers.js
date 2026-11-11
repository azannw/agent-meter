'use strict';
// Synthetic fixtures for the data tests. Nothing here comes from real transcripts:
// ids, sessions and text are made up, and every fixture lives in a fresh temp dir.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function mkTmp(tag = 'x') {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-meter-' + tag + '-'));
}

function rmrf(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

// One Claude Code assistant transcript line.
function claudeLine({
  id = 'msg_test',
  req = 'req_test',
  model = 'claude-opus-5-5',
  ts = '2026-10-01T10:00:00.000Z',
  session = 'sess-1',
  input = 0,
  output = 0,
  cacheRead = 0,
  cacheWrite = 0,
  cw5 = undefined,
  cw1 = undefined,
  speed = 'standard',
  type = 'assistant',
  noRequestId = false,
  uuid = undefined,
  sidechain = false,
} = {}) {
  const usage = {
    input_tokens: input,
    cache_creation_input_tokens: cacheWrite,
    cache_read_input_tokens: cacheRead,
    output_tokens: output,
  };
  if (cw5 !== undefined || cw1 !== undefined) {
    usage.cache_creation = { ephemeral_5m_input_tokens: cw5 || 0, ephemeral_1h_input_tokens: cw1 || 0 };
  }
  if (speed !== undefined) usage.speed = speed;
  const o = {
    parentUuid: null,
    isSidechain: sidechain,
    message: { model, id, type: 'message', role: 'assistant', content: [{ type: 'text', text: 'synthetic' }], usage },
    type,
    uuid: uuid || 'u-' + id + '-' + output,
    timestamp: ts,
    sessionId: session,
  };
  if (!noRequestId) o.requestId = req;
  return JSON.stringify(o);
}

// A user line that happens to carry a nested "usage" object (as Task tool results do).
function userLineWithUsage({ ts = '2026-10-01T10:00:00.000Z', session = 'sess-1' } = {}) {
  return JSON.stringify({
    type: 'user',
    timestamp: ts,
    sessionId: session,
    message: { role: 'user', content: [{ type: 'tool_result', content: 'synthetic' }] },
    toolUseResult: { usage: { input_tokens: 999999, output_tokens: 999999 }, type: 'assistant' },
  });
}

function writeLines(file, lines, { append = false, trailingNewline = true } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = lines.join('\n') + (trailingNewline && lines.length ? '\n' : '');
  if (append) fs.appendFileSync(file, text);
  else fs.writeFileSync(file, text);
}

function setMtime(file, ms) {
  const d = new Date(ms);
  fs.utimesSync(file, d, d);
}

// Usage Monitor files. accounts: [{ id, name, config_dir, session, weekly, scoped, error, sessionReset, weeklyReset }]
function writeMonitor(appData, { updatedUnix, accounts, profiles, stale = false } = {}) {
  const dir = path.join(appData, 'ClaudeCodeUsageMonitor');
  fs.mkdirSync(dir, { recursive: true });
  const at = (secs) => (secs === null ? null : { secs_since_epoch: secs, nanos_since_epoch: 0 });
  const entries = accounts.map((a) => ({
    provider: 'claude',
    profile: { id: a.id, name: a.name, config_dir: a.config_dir || '', credentials_path: '', enabled: true },
    source_signature: 'test',
    source_path: null,
    usage:
      a.usage === null
        ? null
        : {
            session: { available: true, percentage: a.session, resets_at: at(a.sessionReset) },
            weekly: { available: true, percentage: a.weekly, resets_at: at(a.weeklyReset) },
            limits: [
              { key: 'session', kind: 'session', label: 'session', model: null, is_active: false, usage: { available: true, percentage: a.session, resets_at: at(a.sessionReset) } },
              { key: 'weekly_all', kind: 'weekly_all', label: 'weekly all', model: null, is_active: true, usage: { available: true, percentage: a.weekly, resets_at: at(a.weeklyReset) } },
              ...(a.scoped !== undefined
                ? [{ key: 'weekly_scoped_fable', kind: 'weekly_scoped', label: 'Fable', model: 'Fable', is_active: false, usage: { available: true, percentage: a.scoped, resets_at: at(a.weeklyReset) } }]
                : []),
            ],
            stale,
          },
    error: a.error === undefined ? null : a.error,
    selected: false,
  }));
  fs.writeFileSync(path.join(dir, 'usage-cache.json'), JSON.stringify({ updated_unix: updatedUnix, poll_ok: true, data: { accounts: entries } }));
  const profs = profiles || accounts.map((a) => ({ id: a.id, name: a.name, config_dir: a.config_dir || '', credentials_path: '', enabled: true }));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ accounts: { claude: { profiles: profs, selected: 'default' } } }));
  return dir;
}

// Codex rollout lines.
function codexMeta({ ts, id }) {
  return JSON.stringify({ timestamp: ts, type: 'session_meta', payload: { id, timestamp: ts, cwd: 'C:\\fake', originator: 'test', model_provider: 'openai' } });
}
function codexTurn({ ts, model }) {
  return JSON.stringify({ timestamp: ts, type: 'turn_context', payload: { turn_id: 't', cwd: 'C:\\fake', model, effort: 'medium' } });
}
function codexTokens({ ts, last, total, rate }) {
  const u = (x) => ({
    input_tokens: x[0],
    cached_input_tokens: x[1],
    output_tokens: x[2],
    reasoning_output_tokens: x[3] || 0,
    total_tokens: x[0] + x[2],
  });
  return JSON.stringify({
    timestamp: ts,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: last ? { total_token_usage: u(total), last_token_usage: u(last), model_context_window: 100000 } : null,
      rate_limits: rate === undefined ? null : rate,
    },
  });
}

module.exports = {
  mkTmp,
  rmrf,
  claudeLine,
  userLineWithUsage,
  writeLines,
  setMtime,
  writeMonitor,
  codexMeta,
  codexTurn,
  codexTokens,
};
