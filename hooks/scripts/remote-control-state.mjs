#!/usr/bin/env node
/**
 * Read/write DevSpec remote-control state — **session-scoped**.
 *
 * Per-session files (preferred for concurrent remotes):
 *   ~/.devspec/remote-control/sessions/<session_id>.json
 *
 * Legacy single file (still written for older skills; "default" pointer only):
 *   ~/.devspec/remote-control.json
 *
 * Usage:
 *   node remote-control-state.mjs write --session <uuid> [--agent "Claude Code"] [--cwd <path>]
 *   node remote-control-state.mjs disable --session <uuid>
 *   node remote-control-state.mjs read [--session <uuid>]
 *   node remote-control-state.mjs list
 *   node remote-control-state.mjs find-reconnect [--cwd <path>] [--agent "Grok Build"] [--max-age-minutes 30]
 *     Rejoin ONLY after a recent local stop of the same control channel.
 *     Default: create_session. Does NOT pick arbitrary old sessions for this cwd —
 *     a fresh agent conversation that never ran remote must open a new channel.
 *   node remote-control-state.mjs stop-poller --session <uuid>
 *     Kill only poller processes whose argv includes this session UUID.
 *     Never kills other sessions' pollers.
 *   node remote-control-state.mjs resolve-auth
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveDevspecMcpAuth } from './resolve-mcp-auth.mjs'

const DEVSPEC_DIR = path.join(os.homedir(), '.devspec')
const LEGACY_PATH = path.join(DEVSPEC_DIR, 'remote-control.json')
const SESSIONS_DIR = path.join(DEVSPEC_DIR, 'remote-control', 'sessions')

function sessionPath(sessionId) {
  return path.join(SESSIONS_DIR, `${sessionId}.json`)
}

function readJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

function writeJson(filePath, state) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
}

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--session' || a === '--session_id') out.session = argv[++i]
    else if (a === '--agent' || a === '--agent_name') out.agent = argv[++i]
    else if (a === '--cwd') out.cwd = argv[++i]
    else if (a === '--url') out.url = argv[++i]
    else if (a === '--max-age-minutes' || a === '--max_age_minutes') out['max-age-minutes'] = argv[++i]
    else out._.push(a)
  }
  return out
}

/**
 * List node poller PIDs whose cmdline includes both the poller script and session id.
 * Session-scoped: never match other sessions.
 */
function findPollerPidsForSession(sessionId) {
  if (!sessionId || sessionId.length < 8) return []
  const pids = []
  let entries
  try {
    entries = fs.readdirSync('/proc')
  } catch {
    return []
  }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue
    let cmd
    try {
      cmd = fs.readFileSync(`/proc/${name}/cmdline`).toString().replace(/\0/g, ' ')
    } catch {
      continue
    }
    if (!cmd.includes('devspec-remote-poll')) continue
    // Require session id as its own argv token (poller always passes --session <uuid>)
    if (!cmd.includes(sessionId)) continue
    // Prefer node processes (skip shells that only mention the path in their script text)
    if (!/\bnode\b/.test(cmd) && !cmd.includes('node ')) continue
    pids.push(Number(name))
  }
  return pids
}

function stopPollerForSession(sessionId) {
  const pids = findPollerPidsForSession(sessionId)
  const killed = []
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM')
      killed.push(pid)
    } catch {
      /* already gone */
    }
  }
  return { session_id: sessionId, pids_found: pids, pids_killed: killed }
}

const args = parseArgs(process.argv.slice(2))
const cmd = args._[0] || 'read'

if (cmd === 'resolve-auth') {
  const auth = resolveDevspecMcpAuth(args.cwd || process.cwd())
  if (process.argv.includes('--mask') && auth.token) {
    auth.token_preview = auth.token.slice(0, 8) + '…' + auth.token.slice(-4)
    delete auth.token
  }
  process.stdout.write(JSON.stringify(auth, null, 2) + '\n')
  process.exit(auth.ok ? 0 : 1)
}

function listSessionStates() {
  const out = []
  try {
    if (fs.existsSync(SESSIONS_DIR)) {
      for (const f of fs.readdirSync(SESSIONS_DIR)) {
        if (!f.endsWith('.json')) continue
        const s = readJson(path.join(SESSIONS_DIR, f))
        if (s) {
          out.push({
            session_id: s.session_id || f.replace(/\.json$/, ''),
            enabled: s.enabled !== false,
            agent_name: s.agent_name || null,
            cwd: s.cwd || null,
            end_reason: s.end_reason || null,
            ended_from_ui: s.ended_from_ui === true,
            cursor_after_message_id: s.cursor_after_message_id || null,
            updated_at: s.updated_at || null,
            path: path.join(SESSIONS_DIR, f),
          })
        }
      }
    }
  } catch {
    /* ignore */
  }
  return out
}

/**
 * Recoverable ends a live heartbeat can clear (mirrors server isRecoverableRemoteEndReason).
 * UI end is non-recoverable — skill must create_session.
 */
function isRecoverableEndReason(endReason) {
  return endReason === 'local_stop' || endReason === 'idle_timeout' || endReason === 'auth'
}

/** Default window for stop → remote again in the same local conversation. */
const DEFAULT_RECONNECT_MAX_AGE_MINUTES = 30

if (cmd === 'list') {
  const out = listSessionStates()
  const legacy = readJson(LEGACY_PATH)
  process.stdout.write(
    JSON.stringify(
      {
        sessions: out,
        legacy: legacy
          ? {
              session_id: legacy.session_id,
              enabled: legacy.enabled,
              cwd: legacy.cwd || null,
              end_reason: legacy.end_reason || null,
            }
          : null,
      },
      null,
      2,
    ) + '\n',
  )
  process.exit(0)
}

if (cmd === 'find-reconnect') {
  // Product rule: reconnect is ONLY for "remote → stop → remote soon" in the same
  // local agent conversation. A brand-new agent chat that turns remote on for the
  // first time must create_session — even if this cwd has old remote state files.
  const cwd = path.resolve(args.cwd || process.cwd())
  const preferAgent = (args.agent || '').trim().toLowerCase()
  const maxAgeMinutesRaw = args['max-age-minutes'] ?? args.maxAgeMinutes
  const maxAgeMinutes = Math.max(
    1,
    Number.parseInt(String(maxAgeMinutesRaw ?? DEFAULT_RECONNECT_MAX_AGE_MINUTES), 10) ||
      DEFAULT_RECONNECT_MAX_AGE_MINUTES,
  )
  const maxAgeMs = maxAgeMinutes * 60 * 1000
  const now = Date.now()
  const sessions = listSessionStates()

  const rejected = { wrong_cwd: 0, still_enabled: 0, not_recoverable: 0, stale: 0, no_timestamp: 0 }

  const candidates = sessions
    .filter((s) => {
      if (!s.session_id || !s.cwd || path.resolve(s.cwd) !== cwd) {
        rejected.wrong_cwd++
        return false
      }
      // Never "steal" or re-arm another terminal's still-enabled session
      if (s.enabled !== false) {
        rejected.still_enabled++
        return false
      }
      if (s.ended_from_ui === true || s.end_reason === 'ui' || !isRecoverableEndReason(s.end_reason)) {
        rejected.not_recoverable++
        return false
      }
      const t = Date.parse(s.updated_at || '')
      if (!Number.isFinite(t)) {
        rejected.no_timestamp++
        return false
      }
      if (now - t > maxAgeMs) {
        rejected.stale++
        return false
      }
      return true
    })
    .map((s) => {
      let score = Date.parse(s.updated_at || '') || 0
      if (preferAgent && (s.agent_name || '').toLowerCase() === preferAgent) score += 60_000
      // Prefer an intentional local stop over idle/auth within the window
      if (s.end_reason === 'local_stop') score += 30_000
      return { ...s, score, age_ms: now - (Date.parse(s.updated_at || '') || now) }
    })
    .sort((a, b) => b.score - a.score)

  const best = candidates[0] || null
  const result = {
    ok: true,
    cwd,
    max_age_minutes: maxAgeMinutes,
    found: !!best,
    session_id: best?.session_id || null,
    agent_name: best?.agent_name || null,
    end_reason: best?.end_reason || null,
    enabled: best ? best.enabled : null,
    cursor_after_message_id: best?.cursor_after_message_id || null,
    updated_at: best?.updated_at || null,
    age_ms: best?.age_ms ?? null,
    candidates: candidates.slice(0, 5).map((c) => ({
      session_id: c.session_id,
      agent_name: c.agent_name,
      enabled: c.enabled,
      end_reason: c.end_reason,
      updated_at: c.updated_at,
      age_ms: c.age_ms,
    })),
    rejected,
    action: best ? 'reconnect' : 'create_session',
    note: best
      ? 'Recent local stop found — reconnect: live heartbeat → write state → post reconnect → poller. If live refuses (UI end), create_session instead.'
      : `No recent recoverable local stop for this cwd within ${maxAgeMinutes}m (or only stale/unrelated sessions). Call create_session — do NOT invent a reconnect to an old channel.`,
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  process.exit(0)
}

if (cmd === 'stop-poller') {
  if (!args.session) {
    process.stderr.write('Usage: remote-control-state.mjs stop-poller --session <uuid>\n')
    process.exit(2)
  }
  const result = stopPollerForSession(args.session)
  process.stdout.write(JSON.stringify({ ok: true, ...result }) + '\n')
  process.exit(0)
}

if (cmd === 'read') {
  let s = null
  if (args.session) {
    s = readJson(sessionPath(args.session))
  }
  if (!s) {
    s = readJson(LEGACY_PATH)
    if (args.session && s && s.session_id && s.session_id !== args.session) {
      s = null
    }
  }
  process.stdout.write(JSON.stringify(s, null, 2) + '\n')
  process.exit(s ? 0 : 1)
}

if (cmd === 'disable') {
  // Session-scoped disable. Without --session, only disable legacy pointer —
  // never kill all pollers.
  const sessionId = args.session || readJson(LEGACY_PATH)?.session_id
  if (!sessionId) {
    process.stderr.write(
      'Usage: remote-control-state.mjs disable --session <uuid>\n' +
        '(Required when multiple remotes may be active; refusing global kill.)\n',
    )
    process.exit(2)
  }

  const perPath = sessionPath(sessionId)
  const prev = readJson(perPath) || readJson(LEGACY_PATH) || {}
  if (prev.session_id && prev.session_id !== sessionId && !readJson(perPath)) {
    // Legacy file points at a different session — do not clobber it with wrong id
  }
  const next = {
    ...prev,
    session_id: sessionId,
    enabled: false,
    end_reason: prev.end_reason || 'local_stop',
    updated_at: new Date().toISOString(),
  }
  writeJson(perPath, next)

  // Update legacy only if it currently points at this session (or is empty)
  const legacy = readJson(LEGACY_PATH)
  if (!legacy || !legacy.session_id || legacy.session_id === sessionId) {
    writeJson(LEGACY_PATH, next)
  }

  const killResult = stopPollerForSession(sessionId)

  process.stdout.write(
    JSON.stringify({
      ok: true,
      enabled: false,
      session_id: sessionId,
      path: perPath,
      poller: killResult,
    }) + '\n',
  )
  process.exit(0)
}

if (cmd === 'write') {
  if (!args.session) {
    process.stderr.write('Usage: remote-control-state.mjs write --session <uuid>\n')
    process.exit(2)
  }
  const cwd = args.cwd || process.cwd()
  const auth = resolveDevspecMcpAuth(cwd)
  const state = {
    enabled: true,
    session_id: args.session,
    agent_name: args.agent || 'Claude Code',
    mcp_url: args.url || auth.mcp_url || 'https://devspec.ai/api/mcp',
    token: auth.token || undefined,
    auth_source: auth.source || auth.error || null,
    auth_ok: !!auth.ok,
    cwd,
    ended_from_ui: false,
    end_reason: null,
    updated_at: new Date().toISOString(),
  }
  const perPath = sessionPath(args.session)
  writeJson(perPath, state)
  // Legacy pointer = most recently connected session (backward compatible)
  writeJson(LEGACY_PATH, state)

  const result = {
    ok: true,
    path: perPath,
    legacy_path: LEGACY_PATH,
    session_id: state.session_id,
    mcp_url: state.mcp_url,
    auth_ok: state.auth_ok,
    auth_source: state.auth_source,
    token_present: !!state.token,
  }
  if (!state.auth_ok) {
    result.warning = auth.error
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  process.exit(0)
}

process.stderr.write(`Unknown command: ${cmd}\n`)
process.exit(2)
