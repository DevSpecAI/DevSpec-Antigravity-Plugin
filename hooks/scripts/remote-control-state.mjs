#!/usr/bin/env node
/**
 * Read/write DevSpec remote-control state — **session-scoped** + **local conversation bonds**.
 *
 * Per-session files (preferred for concurrent remotes):
 *   ~/.devspec/remote-control/sessions/<session_id>.json
 *
 * Per-local-conversation bonds (create / soft-reconnect / already-live):
 *   ~/.devspec/remote-control/local/<agent-slug>/<local_id>.json
 *
 * Legacy single file (still written for older skills; "default" pointer only):
 *   ~/.devspec/remote-control.json
 *
 * Product rules:
 *   - Bare remote → create_session unless THIS local conversation is already live
 *     or has a recoverable local_stop bond (same local_id + agent).
 *   - Never pick a session just because it shared a cwd/repo.
 *   - --session attach is explicit only (skill path); this helper binds the bond.
 *   - Multiple terminals/agents never steal each other's sessions.
 *
 * Usage:
 *   node remote-control-state.mjs write --session <uuid> [--agent "Grok Build"] [--cwd <path>]
 *       [--codename "Colorful Possum"] [--title "…"] [--local-id <id>] [--owner-pid <pid>]
 *       [--no-poller]   (default: auto-start the continuous heartbeat poller after an auth-ok write)
 *   node remote-control-state.mjs ensure-poller --session <uuid> [--owner-pid <pid>]
 *     Stop any prior poller for this session, then spawn a detached continuous poller.
 *   node remote-control-state.mjs disable --session <uuid>
 *   node remote-control-state.mjs disable-local [--agent "Grok Build"] [--local-id <id>]
 *     SessionEnd teardown: resolve THIS conversation's bound session and disable it.
 *   node remote-control-state.mjs reap [--agent "Grok Build"] [--except-session <uuid>]
 *     Connect-time backstop: SIGTERM provably-dead pollers (disabled / ended / owner gone).
 *   node remote-control-state.mjs read [--session <uuid>]
 *   node remote-control-state.mjs list
 *   node remote-control-state.mjs mint-codename
 *   node remote-control-state.mjs mint-local-id
 *   node remote-control-state.mjs resolve-local-id [--local-id <id>] [--agent "Grok Build"]
 *     Resolve or mint the local conversation id (env → arg → mint).
 *   node remote-control-state.mjs resolve-local --agent "Grok Build" [--local-id <id>]
 *       [--max-age-minutes 30] [--force-new]
 *     → action: already_live | reconnect | create_session
 *   node remote-control-state.mjs find-reconnect …
 *     Deprecated alias of resolve-local (no cwd scanning).
 *   node remote-control-state.mjs stop-poller --session <uuid>
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
const SESSIONS_DIR = path.join(DEVSPEC_DIR, 'remote-control', 'sessions')
const THIS_DIR = path.dirname(fileURLToPath(import.meta.url))
const POLLER_SCRIPT = path.join(THIS_DIR, 'devspec-remote-poll.mjs')

function pollerPidPath(sessionId) {
  return path.join(SESSIONS_DIR, `${sessionId}.poll.pid`)
}

function pollerLogPath(sessionId) {
  return path.join(SESSIONS_DIR, `${sessionId}.poll.log`)
}
const LOCAL_DIR = path.join(DEVSPEC_DIR, 'remote-control', 'local')

/** Default window for stop → remote again in the same local conversation. */
const DEFAULT_RECONNECT_MAX_AGE_MINUTES = 30

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
    else if (a === '--codename' || a === '--session_codename') out.codename = argv[++i]
    else if (a === '--title') out.title = argv[++i]
    else if (a === '--local-id' || a === '--local_id' || a === '--conversation-id') {
      out['local-id'] = argv[++i]
    } else if (a === '--max-age-minutes' || a === '--max_age_minutes') {
      out['max-age-minutes'] = argv[++i]
    } else if (a === '--owner-pid') {
      out['owner-pid'] = argv[++i]
    } else if (a === '--except-session') {
      out['except-session'] = argv[++i]
    } else if (a === '--no-poller' || a === '--skip-poller') {
      out.noPoller = true
    } else if (a === '--force-new' || a === '--new') {
      out.forceNew = true
    } else out._.push(a)
  }
  return out
}

/**
 * Poller PIDs for this session — session-scoped, never matches other sessions.
 * Two sources, deduped: the pidfile the launcher records (all platforms) and a
 * Linux /proc cmdline scan (catches pollers with a missing/stale pidfile).
 */
function findPollerPidsForSession(sessionId) {
  if (!sessionId || sessionId.length < 8) return []
  const pids = new Set()

  // Pidfile — the detached-launch path records the poller pid here.
  try {
    const pidFile = pollerPidPath(sessionId)
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

  // /proc scan (Linux) — require the poller script AND session id in the cmdline.
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
      if (!cmd.includes(sessionId)) continue
      if (!/\bnode\b/.test(cmd) && !cmd.includes('node ')) continue
      pids.add(Number(name))
    }
  } catch {
    /* non-Linux or no /proc */
  }

  return [...pids]
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
  try {
    const pidFile = pollerPidPath(sessionId)
    if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile)
  } catch {
    /* ignore */
  }
  return { session_id: sessionId, pids_found: pids, pids_killed: killed }
}

/**
 * Ensure exactly one continuous heartbeat poller for this session: stop any prior
 * one (so reconnects never multiply orphans), then spawn a fresh detached poller.
 * Pass ownerPid so the spawned poller anchors to the owning agent process and
 * self-terminates when it dies (the two halves of the anti-zombie contract:
 * auto-start here, self-terminate in the poller). Detached spawn works uniformly
 * across hosts — no per-tool nohup/run_in_background dance.
 */
export function ensurePollerForSession(sessionId, opts = {}) {
  if (!sessionId || sessionId.length < 8) return { ok: false, error: 'missing session id' }
  if (!fs.existsSync(POLLER_SCRIPT)) {
    return { ok: false, error: `poller script missing: ${POLLER_SCRIPT}` }
  }
  const stopped = stopPollerForSession(sessionId)
  fs.mkdirSync(SESSIONS_DIR, { recursive: true })

  const ownerPidRaw = Number.parseInt(String(opts.ownerPid ?? ''), 10)
  const ownerPid = Number.isInteger(ownerPidRaw) && ownerPidRaw > 1 ? ownerPidRaw : null
  const logPath = pollerLogPath(sessionId)
  const pidPath = pollerPidPath(sessionId)
  const cwd = opts.cwd || process.cwd()

  let logFd
  try {
    logFd = fs.openSync(logPath, 'a')
  } catch (e) {
    return { ok: false, error: `could not open poll log: ${e.message}`, stopped }
  }

  const pollerArgs = [POLLER_SCRIPT, '--session', sessionId]
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

  return { ok: true, session_id: sessionId, pid, owner_pid: ownerPid, pid_file: pidPath, log: logPath, stopped }
}

/**
 * Session-scoped disable: mark this session's state disabled, stop its poller, and
 * mark matching local bonds stopped. Shared by the `disable` (explicit --session)
 * and `disable-local` (SessionEnd, resolve session from the conversation bond)
 * commands. Never touches another session's state or poller.
 */
function disableSessionState(sessionId, { agent = null, localId = null } = {}) {
  const perPath = sessionPath(sessionId)
  const prev = readJson(perPath) || readJson(LEGACY_PATH) || {}
  const next = {
    ...prev,
    session_id: sessionId,
    enabled: false,
    end_reason: prev.end_reason || 'local_stop',
    updated_at: new Date().toISOString(),
  }
  writeJson(perPath, next)
  // Update legacy only if it currently points at this session (or is empty).
  const legacy = readJson(LEGACY_PATH)
  if (!legacy || !legacy.session_id || legacy.session_id === sessionId) {
    writeJson(LEGACY_PATH, next)
  }
  // Mark the exact conversation bond stopped (so soft-reconnect can find it).
  if (localId && agent) {
    const bond = readLocalBond(agent, localId)
    if (bond && bond.session_id === sessionId) {
      writeLocalBond(agent, localId, {
        ...bond,
        status: 'stopped',
        end_reason: 'local_stop',
        session_id: sessionId,
      })
    }
  }
  const bonds = markBondsStoppedForSession(sessionId, 'local_stop')
  const killResult = stopPollerForSession(sessionId)
  return {
    ok: true,
    enabled: false,
    session_id: sessionId,
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

/** Every per-session state object on disk (raw). */
function scanSessionStates() {
  const out = []
  try {
    if (!fs.existsSync(SESSIONS_DIR)) return out
    for (const f of fs.readdirSync(SESSIONS_DIR)) {
      if (!f.endsWith('.json')) continue
      const s = readJson(path.join(SESSIONS_DIR, f))
      if (s && s.session_id) out.push(s)
    }
  } catch {
    /* ignore */
  }
  return out
}

/**
 * Reap PROVABLY-DEAD pollers — the connect-time / SessionStart backstop for the
 * self-terminating poller. A poller is reaped only when its session is provably
 * dead (state disabled, ended-from-UI, or its recorded owner process is gone), so
 * a live sibling terminal's poller is NEVER touched. A poller with no recorded
 * owner_pid and an enabled session cannot be proven dead → left alone (it either
 * self-terminates via its own owner anchor or ages out at the idle cap).
 * Injectable for tests.
 */
export function reapDeadPollers({
  agent = AGENT_NAME,
  exceptSessionId = null,
  listStates = scanSessionStates,
  findPids = findPollerPidsForSession,
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
    if (!s || !s.session_id) continue
    if (exceptSessionId && s.session_id === exceptSessionId) continue
    if (agent && s.agent_name && String(s.agent_name).toLowerCase() !== String(agent).toLowerCase()) {
      continue
    }
    const pids = findPids(s.session_id)
    if (!pids.length) continue
    const ownerPid = Number.isInteger(s.owner_pid) && s.owner_pid > 1 ? s.owner_pid : null
    const provablyDead =
      s.enabled === false ||
      s.ended_from_ui === true ||
      (ownerPid !== null && !isOwnerAlive(ownerPid))
    if (!provablyDead) continue
    const killed = pids.filter((pid) => kill(pid))
    reaped.push({
      session_id: s.session_id,
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

/** Mark every local bond that points at sessionId as stopped (session-scoped stop). */
function markBondsStoppedForSession(sessionId, endReason = 'local_stop') {
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
        if (!b || b.session_id !== sessionId) continue
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
 * Resolve what bare /devspec-remote should do for THIS local conversation.
 * Never scans by cwd.
 */
export function resolveLocalAction({
  agent = AGENT_NAME,
  localId = null,
  forceNew = false,
  maxAgeMinutes = DEFAULT_RECONNECT_MAX_AGE_MINUTES,
  now = Date.now(),
  readBond = readLocalBond,
  readSession = (id) => readJson(sessionPath(id)),
} = {}) {
  const agentName = agent || AGENT_NAME
  const maxAgeMs =
    Math.max(1, Number(maxAgeMinutes) || DEFAULT_RECONNECT_MAX_AGE_MINUTES) * 60 * 1000

  if (forceNew || !localId) {
    return {
      ok: true,
      action: 'create_session',
      found: false,
      local_id: localId || null,
      agent_name: agentName,
      session_id: null,
      session_codename: null,
      title: null,
      end_reason: null,
      enabled: null,
      cursor_after_message_id: null,
      age_ms: null,
      max_age_minutes: Math.max(1, Number(maxAgeMinutes) || DEFAULT_RECONNECT_MAX_AGE_MINUTES),
      note: forceNew
        ? 'force-new: open a fresh agent_remote_control channel.'
        : 'No local conversation id — create_session. Never rejoin a session by cwd/repo.',
    }
  }

  const bond = readBond(agentName, localId)
  if (!bond || !bond.session_id) {
    return {
      ok: true,
      action: 'create_session',
      found: false,
      local_id: localId,
      agent_name: agentName,
      session_id: null,
      session_codename: null,
      title: null,
      end_reason: null,
      enabled: null,
      cursor_after_message_id: null,
      age_ms: null,
      max_age_minutes: Math.max(1, Number(maxAgeMinutes) || DEFAULT_RECONNECT_MAX_AGE_MINUTES),
      note: 'No bond for this local conversation — create_session (mint a new codename).',
    }
  }

  const session = readSession(bond.session_id) || {}
  const enabled = session.enabled !== false && bond.status === 'live'
  const endReason = session.end_reason || bond.end_reason || null
  const endedFromUi =
    session.ended_from_ui === true || endReason === 'ui' || bond.end_reason === 'ui'
  const updatedAt = session.updated_at || bond.updated_at || null
  const t = Date.parse(updatedAt || '')
  const ageMs = Number.isFinite(t) ? now - t : null

  const base = {
    ok: true,
    found: true,
    local_id: localId,
    agent_name: bond.agent_name || agentName,
    session_id: bond.session_id,
    session_codename: bond.session_codename || session.session_codename || session.codename || null,
    title: bond.title || session.title || null,
    end_reason: endReason,
    enabled: session.enabled !== false,
    cursor_after_message_id:
      session.cursor_after_message_id || bond.cursor_after_message_id || null,
    updated_at: updatedAt,
    age_ms: ageMs,
    max_age_minutes: Math.max(1, Number(maxAgeMinutes) || DEFAULT_RECONNECT_MAX_AGE_MINUTES),
  }

  // Already live for this conversation — idempotent re-arm
  if (bond.status === 'live' && session.enabled !== false && !endedFromUi) {
    return {
      ...base,
      action: 'already_live',
      note: `This conversation is already connected to channel "${base.session_codename || bond.session_id.slice(0, 8)}". Re-arm wait/poller; do not create_session.`,
    }
  }

  // Soft reconnect: same conversation, recent recoverable stop
  if (
    !endedFromUi &&
    isRecoverableEndReason(endReason || bond.end_reason) &&
    ageMs != null &&
    ageMs <= maxAgeMs
  ) {
    return {
      ...base,
      action: 'reconnect',
      note: `Recent local stop of this conversation's channel "${base.session_codename || bond.session_id.slice(0, 8)}" — reconnect that session only.`,
    }
  }

  // Stale / UI-ended / non-recoverable → new channel for this conversation
  return {
    ...base,
    action: 'create_session',
    found: true,
    session_id: null, // do not auto-use old session
    prior_session_id: bond.session_id,
    note: endedFromUi
      ? 'Prior channel was ended from the UI. create_session unless user passed --session to re-attach explicitly.'
      : ageMs != null && ageMs > maxAgeMs
        ? `Prior bond is older than ${base.max_age_minutes}m — create_session.`
        : 'Prior bond is not recoverable — create_session.',
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

  /** Friendly unique channel labels (mirrors server generateRemoteControlCodename). */
  const CODENAME_ADJECTIVES = [
    'Amber', 'Bold', 'Bright', 'Calm', 'Clever', 'Colorful', 'Cosmic', 'Crimson',
    'Curious', 'Dapper', 'Ember', 'Fierce', 'Gentle', 'Golden', 'Hidden', 'Ivory',
    'Jade', 'Keen', 'Lucky', 'Mighty', 'Noble', 'Quiet', 'Rapid', 'Rusty',
    'Silent', 'Silver', 'Swift', 'Velvet', 'Wild', 'Zealous',
  ]
  const CODENAME_ANIMALS = [
    'Badger', 'Beaver', 'Coyote', 'Dolphin', 'Eagle', 'Falcon', 'Fox', 'Heron',
    'Ibis', 'Jaguar', 'Koala', 'Lynx', 'Marten', 'Newt', 'Otter', 'Panda',
    'Possum', 'Quail', 'Raven', 'Seal', 'Tiger', 'Urchin', 'Viper', 'Wolf',
    'Yak', 'Zebra',
  ]

  function mintCodename() {
    const adj = CODENAME_ADJECTIVES[Math.floor(Math.random() * CODENAME_ADJECTIVES.length)]
    const animal = CODENAME_ANIMALS[Math.floor(Math.random() * CODENAME_ANIMALS.length)]
    return `${adj} ${animal}`
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
              session_codename: s.session_codename || s.codename || null,
              title: s.title || null,
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
    const out = listSessionStates()
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
          sessions: out,
          local_bonds: bonds,
          legacy: legacy
            ? {
                session_id: legacy.session_id,
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

    // Compatibility fields for older skills that expected find-reconnect shape
    result.cwd = args.cwd ? path.resolve(args.cwd) : process.cwd()
    result.local_id_source = detected.source
    result.candidates = result.action === 'reconnect' || result.action === 'already_live'
      ? [
          {
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
    result.rejected = {
      no_local_id: !localId ? 1 : 0,
      cwd_scan_removed: 1,
    }
    if (cmd === 'find-reconnect' && !localId) {
      result.note =
        'find-reconnect no longer scans by cwd. No local conversation id — create_session. Prefer resolve-local after resolve-local-id.'
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

  if (cmd === 'reap') {
    // Connect-time / SessionStart backstop: SIGTERM provably-dead pollers only.
    const agentName = args.agent || AGENT_NAME
    const reaped = reapDeadPollers({
      agent: agentName,
      exceptSessionId: args['except-session'] || args.session || null,
    })
    process.stdout.write(JSON.stringify({ ok: true, agent: agentName, count: reaped.length, reaped }) + '\n')
    process.exit(0)
  }

  if (cmd === 'ensure-poller' || cmd === 'start-poller') {
    if (!args.session) {
      process.stderr.write('Usage: remote-control-state.mjs ensure-poller --session <uuid> [--owner-pid <pid>] [--cwd <path>]\n')
      process.exit(2)
    }
    const result = ensurePollerForSession(args.session, {
      cwd: args.cwd ? path.resolve(args.cwd) : process.cwd(),
      ownerPid: args['owner-pid'],
    })
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    process.exit(result.ok ? 0 : 1)
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
    const localId = detectLocalId(args, process.env).local_id
    const result = disableSessionState(sessionId, { agent: args.agent, localId })
    process.stdout.write(JSON.stringify(result) + '\n')
    process.exit(0)
  }

  if (cmd === 'disable-local') {
    // SessionEnd teardown: resolve THIS conversation's bound session (no --session
    // needed) and disable it. Bonus promptness for graceful ends (/clear, logout);
    // the self-terminating poller + reaper cover the ends SessionEnd never fires for.
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
    const sessionId = bond?.session_id || null
    if (!sessionId) {
      process.stdout.write(
        JSON.stringify({ ok: true, skipped: 'no live bond for this conversation', local_id: localId || null }) + '\n',
      )
      process.exit(0)
    }
    const result = disableSessionState(sessionId, { agent: agentName, localId })
    process.stdout.write(JSON.stringify({ ...result, local_id: localId }) + '\n')
    process.exit(0)
  }

  if (cmd === 'write') {
    if (!args.session) {
      process.stderr.write('Usage: remote-control-state.mjs write --session <uuid>\n')
      process.exit(2)
    }
    const cwd = args.cwd || process.cwd()
    const auth = resolveDevspecMcpAuth(cwd)
    const prev = readJson(sessionPath(args.session)) || {}
    const agentName = args.agent || prev.agent_name || AGENT_NAME
    // The conversation this write belongs to — stamped INTO the per-session state
    // so the mirror hook can bind strictly to THIS conversation (never a global
    // "latest session" pointer). See mirror-turn.mjs selectBoundState.
    const localId = detectLocalId(args, process.env).local_id
    // Owner-process anchor for self-termination (see devspec-remote-poll.mjs). The
    // poller also records this itself at startup; storing it here lets the reaper
    // and a re-launched poller pick it up too.
    const ownerPidArg = Number.parseInt(String(args['owner-pid'] ?? ''), 10)
    const ownerPid = Number.isInteger(ownerPidArg) && ownerPidArg > 1 ? ownerPidArg : prev.owner_pid ?? null
    const state = {
      ...prev,
      enabled: true,
      session_id: args.session,
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
    const perPath = sessionPath(args.session)
    writeJson(perPath, state)
    // Legacy pointer = most recently connected session (backward compatible)
    writeJson(LEGACY_PATH, state)

    // Bind local conversation → this session (live)
    let bond = null
    if (localId) {
      bond = writeLocalBond(agentName, localId, {
        status: 'live',
        session_id: args.session,
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

    // Default: start the continuous heartbeat poller after a successful write, so
    // Live presence never depends on the model remembering launch steps. The poller
    // is anchored to ownerPid, so it self-terminates when this session's process
    // dies (no zombie "Live" agents). Opt out with --no-poller (tests / callers that
    // manage the process themselves).
    const wantPoller = state.auth_ok && !args.noPoller
    if (wantPoller) {
      // Self-heal on connect: sweep provably-dead pollers for THIS agent (disabled /
      // ended / owner-gone), never a live sibling, before starting ours.
      try {
        const reaped = reapDeadPollers({ agent: agentName, exceptSessionId: args.session })
        if (reaped.length) result.reaped = reaped
      } catch {
        /* non-fatal */
      }
      const poller = ensurePollerForSession(args.session, { cwd, ownerPid })
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
