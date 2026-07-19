#!/usr/bin/env node
/**
 * Read/write DevSpec remote-control state — **connection-scoped** + **local
 * conversation bonds** (connection-native model, item fd51d80b).
 *
 * A CONNECTION is a first-class local agent presence, independent of any session
 * (server table agent_connections, mig 442). It is the stable unit here: it exists
 * the moment `register_connection` returns, with or without an attached session, and
 * a connection may later attach to a session (optional shared context). So all
 * client state + poller artifacts are keyed by the server `connection_id`, NOT by a
 * session id.
 *
 * Per-connection files (one per live connection):
 *   ~/.devspec/remote-control/connections/<connection_id>.json
 *   ~/.devspec/remote-control/connections/<connection_id>.poll.pid | .poll.log | .inbox.jsonl
 *
 * Per-local-conversation bonds (create / soft-reconnect / already-live):
 *   ~/.devspec/remote-control/local/<agent-slug>/<local_id>.json
 *   (maps this conversation → its connection_id + optional attached session_id)
 *
 * Legacy single file (still written as a "most recent connection" pointer):
 *   ~/.devspec/remote-control.json
 *
 * Product rules (connection-native):
 *   - bare `/devspec.remote` → register a SESSIONLESS connection for THIS
 *     conversation (no create_session), unless it is already live (re-arm) or has a
 *     recoverable local_stop bond (reconnect).
 *   - `--session <uuid>` → attach the connection to that session (explicit only).
 *   - `--new` → create a session then attach the connection.
 *   - Never pick a session/connection just because it shared a cwd/repo.
 *   - Multiple terminals/agents never steal each other's connections.
 *
 * Usage:
 *   node remote-control-state.mjs write --connection-id <uuid> [--session <uuid>]
 *       [--agent "Grok Build"] [--cwd <path>] [--codename "Colorful Possum"]
 *       [--title "…"] [--local-id <id>] [--owner-pid <pid>] [--no-poller]
 *   node remote-control-state.mjs ensure-poller --connection-id <uuid> [--session <uuid>] [--owner-pid <pid>]
 *   node remote-control-state.mjs disable --connection-id <uuid>
 *   node remote-control-state.mjs disable-local [--agent "Grok Build"] [--local-id <id>]
 *   node remote-control-state.mjs reap [--agent "Grok Build"] [--except-connection <uuid>]
 *   node remote-control-state.mjs read [--connection-id <uuid>]
 *   node remote-control-state.mjs list
 *   node remote-control-state.mjs mint-codename
 *   node remote-control-state.mjs mint-local-id
 *   node remote-control-state.mjs resolve-local-id [--local-id <id>] [--agent "Grok Build"]
 *   node remote-control-state.mjs resolve-local --agent "Grok Build" [--local-id <id>]
 *       [--max-age-minutes 30] [--force-new]
 *     → action: already_live | reconnect | register | create_and_attach
 *   node remote-control-state.mjs stop-poller --connection-id <uuid>
 *   node remote-control-state.mjs resolve-auth
 */

import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDevspecMcpAuth } from './resolve-mcp-auth.mjs'
import { AGENT_NAME } from './agent-identity.mjs'

const DEVSPEC_DIR = path.join(os.homedir(), '.devspec')
const LEGACY_PATH = path.join(DEVSPEC_DIR, 'remote-control.json')
const CONNECTIONS_DIR = path.join(DEVSPEC_DIR, 'remote-control', 'connections')
const THIS_DIR = path.dirname(fileURLToPath(import.meta.url))
const POLLER_SCRIPT = path.join(THIS_DIR, 'devspec-remote-poll.mjs')

function pollerPidPath(connectionId) {
  return path.join(CONNECTIONS_DIR, `${connectionId}.poll.pid`)
}

function pollerLogPath(connectionId) {
  return path.join(CONNECTIONS_DIR, `${connectionId}.poll.log`)
}
const LOCAL_DIR = path.join(DEVSPEC_DIR, 'remote-control', 'local')

/** Default window for stop → remote again in the same local conversation. */
const DEFAULT_RECONNECT_MAX_AGE_MINUTES = 30

function connectionPath(connectionId) {
  return path.join(CONNECTIONS_DIR, `${connectionId}.json`)
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
    else if (a === '--connection-id' || a === '--connection_id' || a === '--connection') {
      out['connection-id'] = argv[++i]
    } else if (a === '--agent' || a === '--agent_name') out.agent = argv[++i]
    else if (a === '--cwd') out.cwd = argv[++i]
    else if (a === '--url') out.url = argv[++i]
    else if (a === '--codename' || a === '--session_codename') out.codename = argv[++i]
    else if (a === '--title') out.title = argv[++i]
    else if (a === '--local-id' || a === '--local_id' || a === '--conversation-id') {
      out['local-id'] = argv[++i]
    } else if (a === '--max-age-minutes' || a === '--max_age_minutes') {
      out['max-age-minutes'] = argv[++i]
    } else if (a === '--owner-pid') {
      out['owner-pid'] = argv[++i]
    } else if (a === '--except-connection' || a === '--except-session') {
      out['except-connection'] = argv[++i]
    } else if (a === '--no-poller' || a === '--skip-poller') {
      out.noPoller = true
    } else if (a === '--force-new' || a === '--new') {
      out.forceNew = true
    } else out._.push(a)
  }
  return out
}

/**
 * Poller PIDs for this connection — connection-scoped, never matches another
 * connection. Two sources, deduped: the pidfile the launcher records (all
 * platforms) and a Linux /proc cmdline scan (catches pollers with a stale pidfile).
 */
function findPollerPidsForConnection(connectionId) {
  if (!connectionId || connectionId.length < 8) return []
  const pids = new Set()

  // Pidfile — the detached-launch path records the poller pid here.
  try {
    const pidFile = pollerPidPath(connectionId)
    if (fs.existsSync(pidFile)) {
      const n = Number(fs.readFileSync(pidFile, 'utf8').trim())
      if (Number.isFinite(n) && n > 0) {
        try {
          process.kill(n, 0)
          pids.add(n)
        } catch {
          /* stale pid file */
        }
      }
    }
  } catch {
    /* ignore */
  }

  // /proc scan (Linux) — require the poller script AND connection id in the cmdline.
  try {
    for (const name of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue
      let cmd
      try {
        cmd = fs.readFileSync(`/proc/${name}/cmdline`).toString().replace(/\0/g, ' ')
      } catch {
        continue
      }
      if (!cmd.includes('devspec-remote-poll')) continue
      if (!cmd.includes(connectionId)) continue
      if (!/\bnode\b/.test(cmd) && !cmd.includes('node ')) continue
      pids.add(Number(name))
    }
  } catch {
    /* non-Linux or no /proc */
  }

  return [...pids]
}

function stopPollerForConnection(connectionId) {
  const pids = findPollerPidsForConnection(connectionId)
  const killed = []
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM')
      killed.push(pid)
    } catch {
      /* already gone */
    }
  }
  try {
    const pidFile = pollerPidPath(connectionId)
    if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile)
  } catch {
    /* ignore */
  }
  return { connection_id: connectionId, pids_found: pids, pids_killed: killed }
}

/**
 * Ensure exactly one continuous heartbeat poller for this connection: stop any prior
 * one (so reconnects never multiply orphans), then spawn a fresh detached poller.
 * Pass ownerPid so the spawned poller anchors to the owning agent process and
 * self-terminates when it dies. Pass sessionId when the connection is attached, so
 * the poller also polls the session transcript for room context. Detached spawn
 * works uniformly across hosts — no per-tool nohup/run_in_background dance.
 */
export function ensurePollerForConnection(connectionId, opts = {}) {
  if (!connectionId || connectionId.length < 8) return { ok: false, error: 'missing connection id' }
  if (!fs.existsSync(POLLER_SCRIPT)) {
    return { ok: false, error: `poller script missing: ${POLLER_SCRIPT}` }
  }
  const stopped = stopPollerForConnection(connectionId)
  fs.mkdirSync(CONNECTIONS_DIR, { recursive: true })

  const ownerPidRaw = Number.parseInt(String(opts.ownerPid ?? ''), 10)
  const ownerPid = Number.isInteger(ownerPidRaw) && ownerPidRaw > 1 ? ownerPidRaw : null
  const logPath = pollerLogPath(connectionId)
  const pidPath = pollerPidPath(connectionId)
  const cwd = opts.cwd || process.cwd()
  const sessionId =
    typeof opts.sessionId === 'string' && opts.sessionId.length >= 8 ? opts.sessionId : null

  let logFd
  try {
    logFd = fs.openSync(logPath, 'a')
  } catch (e) {
    return { ok: false, error: `could not open poll log: ${e.message}`, stopped }
  }

  const pollerArgs = [POLLER_SCRIPT, '--connection-id', connectionId]
  if (sessionId) pollerArgs.push('--session', sessionId)
  if (ownerPid) pollerArgs.push('--owner-pid', String(ownerPid))

  let child
  try {
    child = spawn(process.execPath, pollerArgs, {
      cwd,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      windowsHide: true,
      env: process.env,
    })
  } catch (e) {
    try {
      fs.closeSync(logFd)
    } catch {
      /* ignore */
    }
    return { ok: false, error: `spawn failed: ${e.message}`, stopped }
  }
  try {
    fs.closeSync(logFd)
  } catch {
    /* ignore */
  }
  child.unref()

  const pid = child.pid
  if (!pid) return { ok: false, error: 'spawn returned no pid', stopped }
  try {
    fs.writeFileSync(pidPath, `${pid}\n`, { mode: 0o600 })
  } catch (e) {
    return { ok: false, error: `wrote poller but failed pid file: ${e.message}`, pid, log: logPath, stopped }
  }

  return {
    ok: true,
    connection_id: connectionId,
    session_id: sessionId,
    pid,
    owner_pid: ownerPid,
    pid_file: pidPath,
    log: logPath,
    stopped,
  }
}

/**
 * Connection-scoped disable: mark this connection's state disabled, stop its poller,
 * and mark matching local bonds stopped. Shared by `disable` (explicit
 * --connection-id) and `disable-local` (SessionEnd, resolve connection from the
 * conversation bond). Never touches another connection's state or poller.
 */
function disableConnectionState(connectionId, { agent = null, localId = null } = {}) {
  const perPath = connectionPath(connectionId)
  const prev = readJson(perPath) || readJson(LEGACY_PATH) || {}
  const next = {
    ...prev,
    connection_id: connectionId,
    enabled: false,
    end_reason: prev.end_reason || 'local_stop',
    updated_at: new Date().toISOString(),
  }
  writeJson(perPath, next)
  // Update legacy only if it currently points at this connection (or is empty).
  const legacy = readJson(LEGACY_PATH)
  if (!legacy || !legacy.connection_id || legacy.connection_id === connectionId) {
    writeJson(LEGACY_PATH, next)
  }
  // Mark the exact conversation bond stopped (so soft-reconnect can find it).
  if (localId && agent) {
    const bond = readLocalBond(agent, localId)
    if (bond && bond.connection_id === connectionId) {
      writeLocalBond(agent, localId, {
        ...bond,
        status: 'stopped',
        end_reason: 'local_stop',
        connection_id: connectionId,
      })
    }
  }
  const bonds = markBondsStoppedForConnection(connectionId, 'local_stop')
  const killResult = stopPollerForConnection(connectionId)
  return {
    ok: true,
    enabled: false,
    connection_id: connectionId,
    path: perPath,
    poller: killResult,
    bonds_stopped: bonds.length,
  }
}

/** Owner (agent) process liveness — see devspec-remote-poll.mjs. EPERM = alive. */
export function ownerAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return !!e && e.code === 'EPERM'
  }
}

/** Every per-connection state object on disk (raw). */
function scanConnectionStates() {
  const out = []
  try {
    if (!fs.existsSync(CONNECTIONS_DIR)) return out
    for (const f of fs.readdirSync(CONNECTIONS_DIR)) {
      if (!f.endsWith('.json')) continue
      const s = readJson(path.join(CONNECTIONS_DIR, f))
      if (s && s.connection_id) out.push(s)
    }
  } catch {
    /* ignore */
  }
  return out
}

/**
 * Reap PROVABLY-DEAD pollers — the connect-time / SessionStart backstop for the
 * self-terminating poller. A poller is reaped only when its connection is provably
 * dead (state disabled, ended-from-UI, or its recorded owner process is gone), so a
 * live sibling terminal's poller is NEVER touched. A poller with no recorded
 * owner_pid and an enabled connection cannot be proven dead → left alone.
 * Injectable for tests.
 */
export function reapDeadPollers({
  agent = AGENT_NAME,
  exceptConnectionId = null,
  listStates = scanConnectionStates,
  findPids = findPollerPidsForConnection,
  isOwnerAlive = ownerAlive,
  kill = (pid) => {
    try {
      process.kill(pid, 'SIGTERM')
      return true
    } catch {
      return false
    }
  },
} = {}) {
  const reaped = []
  for (const s of listStates()) {
    if (!s || !s.connection_id) continue
    if (exceptConnectionId && s.connection_id === exceptConnectionId) continue
    if (agent && s.agent_name && String(s.agent_name).toLowerCase() !== String(agent).toLowerCase()) {
      continue
    }
    const pids = findPids(s.connection_id)
    if (!pids.length) continue
    const ownerPid = Number.isInteger(s.owner_pid) && s.owner_pid > 1 ? s.owner_pid : null
    const provablyDead =
      s.enabled === false ||
      s.ended_from_ui === true ||
      (ownerPid !== null && !isOwnerAlive(ownerPid))
    if (!provablyDead) continue
    const killed = pids.filter((pid) => kill(pid))
    reaped.push({
      connection_id: s.connection_id,
      agent_name: s.agent_name || null,
      killed,
      reason: s.enabled === false ? 'disabled' : s.ended_from_ui ? 'ended_from_ui' : 'owner_gone',
    })
  }
  return reaped
}

function agentSlug(name) {
  const s = String(name || 'agent')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return s || 'agent'
}

function sanitizeLocalId(id) {
  if (id == null) return null
  const s = String(id).trim().replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 128)
  return s || null
}

function localBondPath(agent, localId) {
  return path.join(LOCAL_DIR, agentSlug(agent), `${localId}.json`)
}

/**
 * Detect local conversation identity.
 * Prefer explicit arg / env that uniquely identifies this agent conversation.
 * Never use cwd. SHELL_SESSION_ID is a last-resort same-terminal fallback.
 */
export function detectLocalId(args = {}, env = process.env) {
  const fromArg = sanitizeLocalId(args['local-id'] || args.localId || args.local_id)
  if (fromArg) return { local_id: fromArg, source: 'arg' }

  const envPairs = [
    ['DEVSPEC_REMOTE_LOCAL_ID', env.DEVSPEC_REMOTE_LOCAL_ID],
    ['CODEX_THREAD_ID', env.CODEX_THREAD_ID],
    ['CLAUDE_CODE_SESSION_ID', env.CLAUDE_CODE_SESSION_ID],
    ['CLAUDE_SESSION_ID', env.CLAUDE_SESSION_ID],
    ['GROK_SESSION_ID', env.GROK_SESSION_ID],
    ['GROK_CONVERSATION_ID', env.GROK_CONVERSATION_ID],
    ['SHELL_SESSION_ID', env.SHELL_SESSION_ID],
    ['TERM_SESSION_ID', env.TERM_SESSION_ID],
  ]
  for (const [name, val] of envPairs) {
    const id = sanitizeLocalId(val)
    if (id) return { local_id: id, source: `env:${name}` }
  }
  return { local_id: null, source: null }
}

export function mintLocalId() {
  return crypto.randomUUID()
}

/**
 * Recoverable ends a live heartbeat can clear (mirrors server isRecoverableRemoteEndReason).
 * UI end stops this poller process; a new instance may re-attach only with explicit --session.
 */
export function isRecoverableEndReason(endReason) {
  return endReason === 'local_stop' || endReason === 'idle_timeout' || endReason === 'auth'
}

function readLocalBond(agent, localId) {
  if (!localId) return null
  return readJson(localBondPath(agent, localId))
}

function writeLocalBond(agent, localId, patch) {
  const p = localBondPath(agent, localId)
  const prev = readJson(p) || {}
  const next = {
    ...prev,
    ...patch,
    local_id: localId,
    agent_name: patch.agent_name || prev.agent_name || agent,
    agent_slug: agentSlug(agent),
    updated_at: new Date().toISOString(),
  }
  writeJson(p, next)
  return next
}

/** Mark every local bond that points at connectionId as stopped. */
function markBondsStoppedForConnection(connectionId, endReason = 'local_stop') {
  const updated = []
  try {
    if (!fs.existsSync(LOCAL_DIR)) return updated
    for (const agentDir of fs.readdirSync(LOCAL_DIR)) {
      const dir = path.join(LOCAL_DIR, agentDir)
      let st
      try {
        st = fs.statSync(dir)
      } catch {
        continue
      }
      if (!st.isDirectory()) continue
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.json')) continue
        const p = path.join(dir, f)
        const b = readJson(p)
        if (!b || b.connection_id !== connectionId) continue
        const next = {
          ...b,
          status: 'stopped',
          end_reason: endReason || b.end_reason || 'local_stop',
          updated_at: new Date().toISOString(),
        }
        writeJson(p, next)
        updated.push({ path: p, local_id: b.local_id, agent_name: b.agent_name })
      }
    }
  } catch {
    /* ignore */
  }
  return updated
}

/**
 * Resolve what bare /devspec.remote should do for THIS local conversation
 * (connection-native). Never scans by cwd.
 *
 * Actions:
 *   - create_and_attach — forceNew (--new): create a session then attach a connection.
 *   - already_live       — this conversation already owns a live connection: re-arm.
 *   - reconnect          — recent recoverable stop of this conversation's connection: resume.
 *   - register           — no/stale bond: register a fresh SESSIONLESS connection.
 */
export function resolveLocalAction({
  agent = AGENT_NAME,
  localId = null,
  forceNew = false,
  maxAgeMinutes = DEFAULT_RECONNECT_MAX_AGE_MINUTES,
  now = Date.now(),
  readBond = readLocalBond,
  readConnection = (id) => readJson(connectionPath(id)),
} = {}) {
  const agentName = agent || AGENT_NAME
  const maxAgeMs =
    Math.max(1, Number(maxAgeMinutes) || DEFAULT_RECONNECT_MAX_AGE_MINUTES) * 60 * 1000
  const clampMax = Math.max(1, Number(maxAgeMinutes) || DEFAULT_RECONNECT_MAX_AGE_MINUTES)

  if (forceNew) {
    return {
      ok: true,
      action: 'create_and_attach',
      found: false,
      local_id: localId || null,
      agent_name: agentName,
      connection_id: null,
      session_id: null,
      session_codename: null,
      title: null,
      end_reason: null,
      enabled: null,
      cursor_after_message_id: null,
      age_ms: null,
      max_age_minutes: clampMax,
      note: 'force-new: create a fresh session and attach a connection to it.',
    }
  }

  const bond = localId ? readBond(agentName, localId) : null
  if (!localId || !bond || !bond.connection_id) {
    return {
      ok: true,
      action: 'register',
      found: false,
      local_id: localId || null,
      agent_name: agentName,
      connection_id: null,
      session_id: null,
      session_codename: null,
      title: null,
      end_reason: null,
      enabled: null,
      cursor_after_message_id: null,
      age_ms: null,
      max_age_minutes: clampMax,
      note: !localId
        ? 'No local conversation id — register a fresh sessionless connection. Never rejoin by cwd/repo.'
        : 'No connection bond for this conversation — register a fresh sessionless connection.',
    }
  }

  const conn = readConnection(bond.connection_id) || {}
  const endReason = conn.end_reason || bond.end_reason || null
  const endedFromUi = conn.ended_from_ui === true || endReason === 'ui' || bond.end_reason === 'ui'
  const updatedAt = conn.updated_at || bond.updated_at || null
  const t = Date.parse(updatedAt || '')
  const ageMs = Number.isFinite(t) ? now - t : null

  const base = {
    ok: true,
    found: true,
    local_id: localId,
    agent_name: bond.agent_name || agentName,
    connection_id: bond.connection_id,
    session_id: bond.session_id || conn.session_id || null,
    session_codename: bond.session_codename || conn.session_codename || conn.codename || null,
    title: bond.title || conn.title || null,
    end_reason: endReason,
    enabled: conn.enabled !== false,
    cursor_after_message_id: conn.cursor_after_message_id || bond.cursor_after_message_id || null,
    updated_at: updatedAt,
    age_ms: ageMs,
    max_age_minutes: clampMax,
  }

  // Already live for this conversation — idempotent re-arm.
  if (bond.status === 'live' && conn.enabled !== false && !endedFromUi) {
    return {
      ...base,
      action: 'already_live',
      note: `This conversation is already connected as "${base.session_codename || bond.connection_id.slice(0, 8)}". Re-arm wait/poller; do not re-register.`,
    }
  }

  // Soft reconnect: same conversation, recent recoverable stop.
  if (
    !endedFromUi &&
    isRecoverableEndReason(endReason || bond.end_reason) &&
    ageMs != null &&
    ageMs <= maxAgeMs
  ) {
    return {
      ...base,
      action: 'reconnect',
      note: `Recent local stop of this conversation's connection "${base.session_codename || bond.connection_id.slice(0, 8)}" — resume it (re-register the same connection; reattach its session if any).`,
    }
  }

  // Stale / UI-ended / non-recoverable → fresh sessionless connection.
  return {
    ...base,
    action: 'register',
    found: true,
    connection_id: null, // do not auto-reuse the old connection
    session_id: null,
    prior_connection_id: bond.connection_id,
    prior_session_id: bond.session_id || null,
    note: endedFromUi
      ? 'Prior connection was ended from the UI. Register a fresh sessionless connection unless the user passed --session.'
      : ageMs != null && ageMs > maxAgeMs
        ? `Prior bond is older than ${base.max_age_minutes}m — register a fresh connection.`
        : 'Prior bond is not recoverable — register a fresh connection.',
  }
}

// --- CLI entry (skipped when imported for tests) ---
const isMain =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (isMain) {
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

  /** Friendly unique channel labels (mirrors server generateRemoteControlCodename).
   *  First word: trait adjectives, colours, and motion verbs; second: animal.
   */
  const CODENAME_ADJECTIVES = [
    'Amber', 'Bold', 'Brave', 'Bright', 'Calm', 'Clever', 'Colorful', 'Cosmic',
    'Curious', 'Dapper', 'Daring', 'Eager', 'Ember', 'Fearless', 'Fierce', 'Gentle',
    'Hidden', 'Honest', 'Humble', 'Jolly', 'Keen', 'Lively', 'Lucky', 'Merry',
    'Mighty', 'Nimble', 'Noble', 'Patient', 'Playful', 'Proud', 'Quiet', 'Rapid',
    'Restless', 'Rusty', 'Silent', 'Steady', 'Sturdy', 'Swift', 'Velvet', 'Wary',
    'Wild', 'Witty', 'Zealous', 'Azure', 'Copper', 'Crimson', 'Emerald', 'Golden',
    'Green', 'Indigo', 'Ivory', 'Jade', 'Obsidian', 'Orange', 'Purple', 'Scarlet',
    'Silver', 'Teal', 'Violet', 'Bounding', 'Climbing', 'Dashing', 'Drifting', 'Flying',
    'Gliding', 'Leaping', 'Racing', 'Roaming', 'Running', 'Soaring', 'Sprinting', 'Vaulting',
    'Wandering',
  ]
  const CODENAME_ANIMALS = [
    'Alpaca', 'Badger', 'Beaver', 'Bison', 'Bobcat', 'Caracal', 'Condor', 'Coyote',
    'Crane', 'Crocodile', 'Dolphin', 'Dragonfly', 'Eagle', 'Egret', 'Falcon', 'Ferret',
    'Finch', 'Fox', 'Gecko', 'Gibbon', 'Hare', 'Hawk', 'Heron', 'Ibis',
    'Iguana', 'Jackal', 'Jaguar', 'Kestrel', 'Kingfisher', 'Koala', 'Lemur', 'Lizard',
    'Llama', 'Lynx', 'Mantis', 'Marten', 'Meerkat', 'Mongoose', 'Narwhal', 'Newt',
    'Ocelot', 'Octopus', 'Osprey', 'Otter', 'Owl', 'Panda', 'Panther', 'Pelican',
    'Penguin', 'Phoenix', 'Pika', 'Possum', 'Puma', 'Quail', 'Quokka', 'Rabbit',
    'Raccoon', 'Raven', 'Salmon', 'Seal', 'Sparrow', 'Squirrel', 'Stork', 'Tiger',
    'Toucan', 'Turtle', 'Urchin', 'Viper', 'Walrus', 'Weasel', 'Wombat', 'Wolf',
    'Yak', 'Zebra',
  ]

  function mintCodename() {
    const adj = CODENAME_ADJECTIVES[Math.floor(Math.random() * CODENAME_ADJECTIVES.length)]
    const animal = CODENAME_ANIMALS[Math.floor(Math.random() * CODENAME_ANIMALS.length)]
    return `${adj} ${animal}`
  }

  function listConnectionStates() {
    const out = []
    try {
      if (fs.existsSync(CONNECTIONS_DIR)) {
        for (const f of fs.readdirSync(CONNECTIONS_DIR)) {
          if (!f.endsWith('.json')) continue
          const s = readJson(path.join(CONNECTIONS_DIR, f))
          if (s) {
            out.push({
              connection_id: s.connection_id || f.replace(/\.json$/, ''),
              session_id: s.session_id || null,
              enabled: s.enabled !== false,
              agent_name: s.agent_name || null,
              cwd: s.cwd || null,
              session_codename: s.session_codename || s.codename || null,
              title: s.title || null,
              end_reason: s.end_reason || null,
              ended_from_ui: s.ended_from_ui === true,
              cursor_after_message_id: s.cursor_after_message_id || null,
              updated_at: s.updated_at || null,
              path: path.join(CONNECTIONS_DIR, f),
            })
          }
        }
      }
    } catch {
      /* ignore */
    }
    return out
  }

  if (cmd === 'mint-codename') {
    const codename = mintCodename()
    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          session_codename: codename,
          title_hint: codename,
          note: 'Pass session_codename (or title starting with this) to create_session; store on write --codename.',
        },
        null,
        2,
      ) + '\n',
    )
    process.exit(0)
  }

  if (cmd === 'mint-local-id') {
    const id = mintLocalId()
    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          local_id: id,
          note: 'Store this for the entire local agent conversation. Pass --local-id on resolve-local / write / stop.',
        },
        null,
        2,
      ) + '\n',
    )
    process.exit(0)
  }

  if (cmd === 'resolve-local-id') {
    const detected = detectLocalId(args, process.env)
    if (detected.local_id) {
      process.stdout.write(
        JSON.stringify({
          ok: true,
          local_id: detected.local_id,
          source: detected.source,
          minted: false,
        }) + '\n',
      )
      process.exit(0)
    }
    const id = mintLocalId()
    process.stdout.write(
      JSON.stringify({
        ok: true,
        local_id: id,
        source: 'minted',
        minted: true,
        note: 'No conversation id in env. Hold this local_id in working memory for the rest of this agent chat; pass --local-id on every remote-control-state call.',
      }) + '\n',
    )
    process.exit(0)
  }

  if (cmd === 'list') {
    const out = listConnectionStates()
    const legacy = readJson(LEGACY_PATH)
    const bonds = []
    try {
      if (fs.existsSync(LOCAL_DIR)) {
        for (const agentDir of fs.readdirSync(LOCAL_DIR)) {
          const dir = path.join(LOCAL_DIR, agentDir)
          if (!fs.statSync(dir).isDirectory()) continue
          for (const f of fs.readdirSync(dir)) {
            if (!f.endsWith('.json')) continue
            const b = readJson(path.join(dir, f))
            if (b) bonds.push(b)
          }
        }
      }
    } catch {
      /* ignore */
    }
    process.stdout.write(
      JSON.stringify(
        {
          connections: out,
          local_bonds: bonds,
          legacy: legacy
            ? {
                connection_id: legacy.connection_id || null,
                session_id: legacy.session_id || null,
                enabled: legacy.enabled,
                cwd: legacy.cwd || null,
                session_codename: legacy.session_codename || legacy.codename || null,
                title: legacy.title || null,
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

  if (cmd === 'resolve-local' || cmd === 'find-reconnect') {
    // find-reconnect is a deprecated alias — same bond-scoped logic, never cwd scan.
    const agentName = args.agent || AGENT_NAME
    const detected = detectLocalId(args, process.env)
    const localId = detected.local_id
    const maxAgeMinutesRaw = args['max-age-minutes']
    const maxAgeMinutes = Math.max(
      1,
      Number.parseInt(String(maxAgeMinutesRaw ?? DEFAULT_RECONNECT_MAX_AGE_MINUTES), 10) ||
        DEFAULT_RECONNECT_MAX_AGE_MINUTES,
    )

    const result = resolveLocalAction({
      agent: agentName,
      localId,
      forceNew: !!args.forceNew,
      maxAgeMinutes,
    })

    result.cwd = args.cwd ? path.resolve(args.cwd) : process.cwd()
    result.local_id_source = detected.source
    result.candidates =
      result.action === 'reconnect' || result.action === 'already_live'
        ? [
            {
              connection_id: result.connection_id,
              session_id: result.session_id,
              agent_name: result.agent_name,
              session_codename: result.session_codename,
              title: result.title,
              enabled: result.enabled,
              end_reason: result.end_reason,
              age_ms: result.age_ms,
            },
          ]
        : []
    result.rejected = { no_local_id: !localId ? 1 : 0, cwd_scan_removed: 1 }

    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    process.exit(0)
  }

  if (cmd === 'stop-poller') {
    const connectionId = args['connection-id']
    if (!connectionId) {
      process.stderr.write('Usage: remote-control-state.mjs stop-poller --connection-id <uuid>\n')
      process.exit(2)
    }
    const result = stopPollerForConnection(connectionId)
    process.stdout.write(JSON.stringify({ ok: true, ...result }) + '\n')
    process.exit(0)
  }

  if (cmd === 'read') {
    let s = null
    if (args['connection-id']) {
      s = readJson(connectionPath(args['connection-id']))
    }
    if (!s) {
      s = readJson(LEGACY_PATH)
      if (args['connection-id'] && s && s.connection_id && s.connection_id !== args['connection-id']) {
        s = null
      }
    }
    process.stdout.write(JSON.stringify(s, null, 2) + '\n')
    process.exit(s ? 0 : 1)
  }

  if (cmd === 'reap') {
    // Connect-time / SessionStart backstop: SIGTERM provably-dead pollers only.
    const agentName = args.agent || AGENT_NAME
    const reaped = reapDeadPollers({
      agent: agentName,
      exceptConnectionId: args['except-connection'] || args['connection-id'] || null,
    })
    process.stdout.write(
      JSON.stringify({ ok: true, agent: agentName, count: reaped.length, reaped }) + '\n',
    )
    process.exit(0)
  }

  if (cmd === 'ensure-poller' || cmd === 'start-poller') {
    const connectionId = args['connection-id']
    if (!connectionId) {
      process.stderr.write(
        'Usage: remote-control-state.mjs ensure-poller --connection-id <uuid> [--session <uuid>] [--owner-pid <pid>] [--cwd <path>]\n',
      )
      process.exit(2)
    }
    const result = ensurePollerForConnection(connectionId, {
      cwd: args.cwd ? path.resolve(args.cwd) : process.cwd(),
      ownerPid: args['owner-pid'],
      sessionId: args.session || null,
    })
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    process.exit(result.ok ? 0 : 1)
  }

  if (cmd === 'disable') {
    // Connection-scoped disable. Without --connection-id, only disable legacy pointer.
    const connectionId = args['connection-id'] || readJson(LEGACY_PATH)?.connection_id
    if (!connectionId) {
      process.stderr.write(
        'Usage: remote-control-state.mjs disable --connection-id <uuid>\n' +
          '(Required when multiple remotes may be active; refusing global kill.)\n',
      )
      process.exit(2)
    }
    const localId = detectLocalId(args, process.env).local_id
    const result = disableConnectionState(connectionId, { agent: args.agent, localId })
    process.stdout.write(JSON.stringify(result) + '\n')
    process.exit(0)
  }

  if (cmd === 'disable-local') {
    // SessionEnd teardown: resolve THIS conversation's bound connection (no
    // --connection-id needed) and disable it.
    const agentName = args.agent || AGENT_NAME
    let localId = detectLocalId(args, process.env).local_id
    // SessionEnd hook delivers the conversation id on stdin as { session_id }.
    if (!localId && !process.stdin.isTTY) {
      try {
        const raw = fs.readFileSync(0, 'utf8')
        const j = JSON.parse(raw || '{}')
        if (typeof j.session_id === 'string') localId = sanitizeLocalId(j.session_id)
      } catch {
        /* no stdin payload */
      }
    }
    const bond = localId ? readLocalBond(agentName, localId) : null
    const connectionId = bond?.connection_id || null
    if (!connectionId) {
      process.stdout.write(
        JSON.stringify({
          ok: true,
          skipped: 'no live bond for this conversation',
          local_id: localId || null,
        }) + '\n',
      )
      process.exit(0)
    }
    const result = disableConnectionState(connectionId, { agent: agentName, localId })
    process.stdout.write(JSON.stringify({ ...result, local_id: localId }) + '\n')
    process.exit(0)
  }

  if (cmd === 'write') {
    const connectionId = args['connection-id']
    if (!connectionId) {
      process.stderr.write(
        'Usage: remote-control-state.mjs write --connection-id <uuid> [--session <uuid>]\n',
      )
      process.exit(2)
    }
    const cwd = args.cwd || process.cwd()
    const auth = resolveDevspecMcpAuth(cwd)
    const prev = readJson(connectionPath(connectionId)) || {}
    const agentName = args.agent || prev.agent_name || AGENT_NAME
    // The conversation this write belongs to — stamped INTO the per-connection state
    // so the mirror hook can bind strictly to THIS conversation.
    const localId = detectLocalId(args, process.env).local_id
    // Optional attached session (present for --session / --new; absent = sessionless).
    const sessionId =
      typeof args.session === 'string' && args.session.length >= 8 ? args.session : prev.session_id ?? null
    // Owner-process anchor for self-termination (see devspec-remote-poll.mjs).
    const ownerPidArg = Number.parseInt(String(args['owner-pid'] ?? ''), 10)
    const ownerPid = Number.isInteger(ownerPidArg) && ownerPidArg > 1 ? ownerPidArg : prev.owner_pid ?? null
    const state = {
      ...prev,
      enabled: true,
      connection_id: connectionId,
      session_id: sessionId,
      agent_name: agentName,
      local_id: localId ?? prev.local_id ?? null,
      owner_pid: ownerPid,
      mcp_url: args.url || auth.mcp_url || prev.mcp_url || 'https://devspec.ai/api/mcp',
      token: auth.token || prev.token || undefined,
      auth_source: auth.source || auth.error || prev.auth_source || null,
      auth_ok: !!auth.ok || !!prev.auth_ok,
      cwd,
      session_codename: args.codename || prev.session_codename || prev.codename || null,
      title: args.title || prev.title || null,
      ended_from_ui: false,
      end_reason: null,
      updated_at: new Date().toISOString(),
    }
    const perPath = connectionPath(connectionId)
    writeJson(perPath, state)
    // Legacy pointer = most recently connected connection (backward compatible).
    writeJson(LEGACY_PATH, state)

    // Bind local conversation → this connection (live).
    let bond = null
    if (localId) {
      bond = writeLocalBond(agentName, localId, {
        status: 'live',
        connection_id: connectionId,
        session_id: sessionId,
        session_codename: state.session_codename,
        title: state.title,
        cwd,
        end_reason: null,
        cursor_after_message_id: prev.cursor_after_message_id || null,
      })
    }

    const result = {
      ok: true,
      path: perPath,
      legacy_path: LEGACY_PATH,
      connection_id: state.connection_id,
      session_id: state.session_id,
      session_codename: state.session_codename,
      title: state.title,
      mcp_url: state.mcp_url,
      auth_ok: state.auth_ok,
      auth_source: state.auth_source,
      token_present: !!state.token,
      local_id: localId,
      bond_path: bond ? localBondPath(agentName, localId) : null,
    }
    if (!state.auth_ok) {
      result.warning = auth.error
    }
    if (!localId) {
      result.warning_local =
        'No --local-id / conversation env; soft-reconnect and already_live will not work until write is called with a local id.'
    }

    // Default: start the continuous heartbeat poller after a successful write.
    const wantPoller = state.auth_ok && !args.noPoller
    if (wantPoller) {
      try {
        const reaped = reapDeadPollers({ agent: agentName, exceptConnectionId: connectionId })
        if (reaped.length) result.reaped = reaped
      } catch {
        /* non-fatal */
      }
      const poller = ensurePollerForConnection(connectionId, { cwd, ownerPid, sessionId })
      result.poller = poller
      if (!poller.ok) {
        result.warning_poller = poller.error
        process.stderr.write(`remote-control-state: ensure-poller failed — ${poller.error}\n`)
      }
    } else if (args.noPoller) {
      result.poller = { ok: true, skipped: true, reason: 'no-poller' }
    }

    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    process.exit(state.auth_ok ? 0 : 1)
  }

  process.stderr.write(`Unknown command: ${cmd}\n`)
  process.exit(2)
}
