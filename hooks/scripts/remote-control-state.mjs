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

if (cmd === 'list') {
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
            updated_at: s.updated_at || null,
            path: path.join(SESSIONS_DIR, f),
          })
        }
      }
    }
  } catch {
    /* ignore */
  }
  const legacy = readJson(LEGACY_PATH)
  process.stdout.write(
    JSON.stringify({ sessions: out, legacy: legacy ? { session_id: legacy.session_id, enabled: legacy.enabled } : null }, null, 2) +
      '\n',
  )
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
