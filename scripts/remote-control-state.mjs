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
 *       [--agent "Antigravity"] [--project-id <uuid>] [--cwd <path>] [--codename "Colorful Possum"]
 *       [--title "…"] [--local-id <id>] [--owner-pid <pid>] [--host-token <bearer>] [--no-poller]
 *   node remote-control-state.mjs ensure-poller --connection-id <uuid> [--session <uuid>] [--owner-pid <pid>]
 *   node remote-control-state.mjs disable --connection-id <uuid>
 *   node remote-control-state.mjs disable-local [--agent "Antigravity"] [--local-id <id>]
 *   node remote-control-state.mjs reap [--agent "Antigravity"] [--except-connection <uuid>]
 *   node remote-control-state.mjs read [--connection-id <uuid>]
 *   node remote-control-state.mjs list
 *   node remote-control-state.mjs mint-codename
 *   node remote-control-state.mjs mint-local-id
 *   node remote-control-state.mjs resolve-local-id [--local-id <id>] [--agent "Antigravity"]
 *   node remote-control-state.mjs resolve-local --agent "Antigravity" [--local-id <id>]
 *       [--max-age-minutes 30] [--force-new]
 *     → action: already_live | reconnect | register | create_and_attach
 *   node remote-control-state.mjs stop-poller --connection-id <uuid>
 *   node remote-control-state.mjs resolve-auth
 */

import crypto from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDevspecMcpAuth, hostTokenFromEnv } from './resolve-mcp-auth.mjs'
import { mcpToolsCall } from './mcp-call.mjs'
import {
  applyConnectionCapabilityRotation,
  stripConnectionCapability,
} from './connection-capability-state.mjs'
import { AGENT_NAME } from './agent-identity.mjs'
import { saveConversationProject } from './conversation-project.mjs'
import { findProjectPin, gitRemoteOrigin } from './devspec-scope.mjs'

const DEVSPEC_DIR = path.join(os.homedir(), '.devspec')
const LEGACY_PATH = path.join(DEVSPEC_DIR, 'remote-control.json')
const CONNECTIONS_DIR = path.join(DEVSPEC_DIR, 'remote-control', 'connections')
const THIS_DIR = path.dirname(fileURLToPath(import.meta.url))
const POLLER_SCRIPT = path.join(THIS_DIR, 'devspec-remote-poll.mjs')
const LISTENER_SCRIPT = path.join(THIS_DIR, 'devspec-remote-listen.mjs')

function pollerPidPath(connectionId) {
  return path.join(CONNECTIONS_DIR, `${connectionId}.poll.pid`)
}

function pollerLogPath(connectionId) {
  return path.join(CONNECTIONS_DIR, `${connectionId}.poll.log`)
}

export function listenerInfoPath(connectionId, connDir = CONNECTIONS_DIR) {
  return path.join(connDir, `${connectionId}.listener.json`)
}

export function isListenerAlive(connectionId, connDir = CONNECTIONS_DIR) {
  if (!connectionId) return false
  const info = readJson(listenerInfoPath(connectionId, connDir))
  const pid = Number(info?.pid)
  if (!Number.isInteger(pid) || pid <= 1) return false
  return ownerAlive(pid)
}

export function stopListenerForConnection(connectionId, connDir = CONNECTIONS_DIR) {
  const file = listenerInfoPath(connectionId, connDir)
  const info = readJson(file)
  const pid = Number(info?.pid)
  let killed = false
  if (Number.isInteger(pid) && pid > 1) {
    try {
      process.kill(pid, 'SIGTERM')
      killed = true
    } catch {
      /* already gone */
    }
  }
  try {
    fs.rmSync(file, { force: true })
  } catch {
    /* ignore */
  }
  return { connection_id: connectionId, pid: Number.isInteger(pid) ? pid : null, killed }
}

export function ensureListenerForConnection(connectionId, opts = {}) {
  if (!connectionId || connectionId.length < 8) return { ok: false, error: 'missing connection id' }
  if (!fs.existsSync(LISTENER_SCRIPT)) {
    return { ok: false, error: `listener script missing: ${LISTENER_SCRIPT}` }
  }
  const connDir = opts.connDir || CONNECTIONS_DIR
  if (opts.reuseRunning && isListenerAlive(connectionId, connDir)) {
    const info = readJson(listenerInfoPath(connectionId, connDir))
    return {
      ok: true,
      reused: true,
      connection_id: connectionId,
      pid: info?.pid || null,
      owner_pid: info?.owner_pid || null,
    }
  }
  const resolveOwnerPidFn = opts.resolveOwnerPid || resolveOwnerPid
  const ownerPid = resolveOwnerPidFn(opts.ownerPid, null)
  if (ownerPid === null) {
    return { ok: false, error: 'missing owner_pid for listener' }
  }
  stopListenerForConnection(connectionId, connDir)
  fs.mkdirSync(connDir, { recursive: true })
  const logPath = path.join(connDir, `${connectionId}.listen.log`)
  let logFd
  try {
    logFd = fs.openSync(logPath, 'a')
  } catch (e) {
    return { ok: false, error: `could not open listen log: ${e.message}` }
  }
  const listenArgs = [LISTENER_SCRIPT, '--connection-id', connectionId, '--owner-pid', String(ownerPid)]
  if (opts.conversationId) listenArgs.push('--conversation-id', String(opts.conversationId))
  if (opts.cwd) listenArgs.push('--cwd', String(opts.cwd))

  let child
  try {
    child = spawn(process.execPath, listenArgs, {
      cwd: opts.cwd || process.cwd(),
      detached: true,
      stdio: ['ignore', logFd, logFd],
      windowsHide: true,
      env: opts.env || process.env,
    })
  } catch (e) {
    try {
      fs.closeSync(logFd)
    } catch {
      /* ignore */
    }
    return { ok: false, error: `listener spawn failed: ${e.message}` }
  }
  try {
    fs.closeSync(logFd)
  } catch {
    /* ignore */
  }
  child.unref()
  const pid = child.pid
  if (!pid) return { ok: false, error: 'listener spawn returned no pid' }
  const payload = {
    pid,
    owner_pid: ownerPid,
    connection_id: connectionId,
    conversation_id: opts.conversationId || null,
    status: 'serving',
    started_at: new Date().toISOString(),
  }
  writeJson(listenerInfoPath(connectionId, connDir), payload)
  return { ok: true, connection_id: connectionId, pid, owner_pid: ownerPid }
}

export function knownInstructionTiersFor(connectionId, connDir = CONNECTIONS_DIR) {
  if (!connectionId) return null
  const state = readStateFile(connectionId, connDir)
  if (
    state?.instruction_tiers_version === 1 &&
    typeof state.instruction_tiers_hash === 'string' &&
    /^sha256:[a-f0-9]{64}$/.test(state.instruction_tiers_hash)
  ) {
    return { version: 1, hash: state.instruction_tiers_hash }
  }
  return null
}
const LOCAL_DIR = path.join(DEVSPEC_DIR, 'remote-control', 'local')

/** Default window for stop → remote again in the same local conversation. */
const DEFAULT_RECONNECT_MAX_AGE_MINUTES = 30

function connectionPath(connectionId, connDir = CONNECTIONS_DIR) {
  return path.join(connDir, `${connectionId}.json`)
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

export function readStateFile(connectionId, connDir = CONNECTIONS_DIR) {
  if (!connectionId) return null
  return readJson(connectionPath(connectionId, connDir))
}

export function writeStateFile(idOrState, stateOrDir = CONNECTIONS_DIR, maybeDir = CONNECTIONS_DIR) {
  if (idOrState && typeof idOrState === 'object') {
    const connId = idOrState.connection_id
    if (!connId) return null
    const dir = typeof stateOrDir === 'string' ? stateOrDir : CONNECTIONS_DIR
    const next = { ...idOrState, connection_id: connId }
    writeJson(connectionPath(connId, dir), next)
    return next
  }
  if (!idOrState || !stateOrDir || typeof stateOrDir !== 'object') return null
  const next = { ...stateOrDir, connection_id: idOrState }
  writeJson(connectionPath(idOrState, maybeDir), next)
  return next
}

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--session' || a === '--session_id') out.session = argv[++i]
    else if (a === '--connection-id' || a === '--connection_id' || a === '--connection') {
      out['connection-id'] = argv[++i]
    } else if (a === '--agent' || a === '--agent_name') out.agent = argv[++i]
    else if (a === '--project-id' || a === '--project_id') out['project-id'] = argv[++i]
    else if (a === '--cwd') out.cwd = argv[++i]
    else if (a === '--url') out.url = argv[++i]
    else if (a === '--codename' || a === '--session_codename') out.codename = argv[++i]
    else if (a === '--title') out.title = argv[++i]
    else if (a === '--local-id' || a === '--local_id' || a === '--conversation-id') {
      out['local-id'] = argv[++i]
    } else if (a === '--transcript-path' || a === '--transcript_path') {
      out['transcript-path'] = argv[++i]
    } else if (a === '--event') {
      out.event = argv[++i]
    } else if (a === '--max-age-minutes' || a === '--max_age_minutes') {
      out['max-age-minutes'] = argv[++i]
    } else if (a === '--owner-pid') {
      out['owner-pid'] = argv[++i]
    } else if (a === '--host-token' || a === '--host_token') {
      out['host-token'] = argv[++i]
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

/**
 * Linux /proc owner-pid self-resolution. Walks parent process ancestry up to maxHops
 * looking for the owning Antigravity host process (`agy`, `antigravity`, or
 * `language_server_*`) so callers inside subshells or hooks that cannot rely on
 * `$PPID` still anchor the poller to the real Antigravity process.
 */
export function resolveOwnerPidAutoLinux(
  startPid = process.pid,
  { maxHops = 12, procRoot = '/proc' } = {},
) {
  if (process.platform !== 'linux' && procRoot === '/proc') return null
  let pid = Number.parseInt(String(startPid), 10)
  if (!Number.isInteger(pid) || pid <= 1) return null
  for (let i = 0; i < maxHops && pid > 1; i++) {
    let statusText = ''
    try {
      statusText = fs.readFileSync(path.join(procRoot, String(pid), 'status'), 'utf8')
    } catch {
      break
    }
    const nameMatch = statusText.match(/^Name:\s*(.+)$/m)
    const ppidMatch = statusText.match(/^PPid:\s*(\d+)$/m)
    const comm = (nameMatch?.[1] || '').trim()
    let cmdline = ''
    try {
      cmdline = fs
        .readFileSync(path.join(procRoot, String(pid), 'cmdline'), 'utf8')
        .replace(/\0/g, ' ')
        .trim()
    } catch {
      /* ignore */
    }
    if (
      /^(agy|antigravity|language_server_[a-z0-9_.-]+)$/i.test(comm) ||
      /(^|[\s/])(agy|antigravity|language_server_[a-z0-9_.-]+)(\s|$)/i.test(cmdline)
    ) {
      return pid
    }
    const nextPid = Number.parseInt(ppidMatch?.[1] || '', 10)
    if (!Number.isInteger(nextPid) || nextPid <= 1 || nextPid === pid) break
    pid = nextPid
  }
  return null
}

/**
 * Windows-only owner-pid self-resolution (item 3cddb3b4). On win32 this process is
 * commonly invoked from Git Bash (MSYS), whose own `$$`/`$PPID` are MSYS-internal
 * numbers that do NOT correspond to any real Win32 process — querying Win32_Process
 * for bash's reported pid returns nothing, so a caller-supplied `--owner-pid "$PPID"`
 * from that shell is never a trustworthy anchor (verified: MSYS bash reports PPID=1,
 * an orphan sentinel, not a resolvable process). node.exe itself, unlike the MSYS
 * shell, IS a genuine Win32 process, so `process.pid` (this script's own pid) is a
 * real, queryable anchor — walk its Win32_Process ancestry until we reach the owning
 * host process (`agy.exe`, `antigravity.exe`, or `claude.exe`), however many shell
 * layers sit in between. A single short-lived PowerShell call does the whole walk.
 */
export function resolveOwnerPidAutoWindows(startPid = process.pid, { maxHops = 12, timeoutMs = 4000 } = {}) {
  if (process.platform !== 'win32') return null
  const pid = Number.parseInt(String(startPid), 10)
  if (!Number.isInteger(pid) || pid < 1) return null
  const script = [
    `$p = ${pid}`,
    `for ($i = 0; $i -lt ${maxHops}; $i++) {`,
    '  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$p" -ErrorAction SilentlyContinue',
    '  if (-not $proc) { break }',
    "  if ($proc.Name -ieq 'agy.exe' -or $proc.Name -ieq 'antigravity.exe' -or $proc.Name -ieq 'claude.exe') { Write-Output $proc.ProcessId; break }",
    '  if (-not $proc.ParentProcessId -or $proc.ParentProcessId -eq $p) { break }',
    '  $p = $proc.ParentProcessId',
    '}',
  ].join('\n')
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      timeout: timeoutMs,
      encoding: 'utf8',
      windowsHide: true,
    }).trim()
    const found = Number.parseInt(out, 10)
    return Number.isInteger(found) && found > 1 ? found : null
  } catch {
    return null
  }
}

/**
 * Resolve the effective owner-pid for this call: an explicit, valid `--owner-pid`
 * always wins (any platform); otherwise attempt Linux `/proc` or Windows ancestry
 * self-resolution above; otherwise fall back to a previously-recorded value.
 */
export function resolveOwnerPid(explicitArg, prevValue) {
  const explicit = Number.parseInt(String(explicitArg ?? ''), 10)
  if (Number.isInteger(explicit) && explicit > 1) return explicit
  const autoLinux = resolveOwnerPidAutoLinux()
  if (autoLinux) return autoLinux
  const autoWin = resolveOwnerPidAutoWindows()
  if (autoWin) return autoWin
  const prev = Number.parseInt(String(prevValue ?? ''), 10)
  return Number.isInteger(prev) && prev > 1 ? prev : null
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

  // Reuse a live poller instead of kill→respawn (item b9e02835). A running poller
  // needs NO restart for a session attach/detach — the server heartbeat echo is
  // its sole attachment authority — so a restart is only warranted when its
  // startup-cached identity (token / mcp_url / owner anchor) went stale. Callers
  // that verified nothing changed pass reuseRunning: true; with no live poller
  // this falls through to the normal spawn (and its guards) below.
  const findPids = opts.findPids || findPollerPidsForConnection
  if (opts.reuseRunning) {
    const running = findPids(connectionId)
    if (running.length) {
      return {
        ok: true,
        reused: true,
        connection_id: connectionId,
        session_id:
          typeof opts.sessionId === 'string' && opts.sessionId.length >= 8 ? opts.sessionId : null,
        pid: running[0],
        pid_file: pollerPidPath(connectionId),
        log: pollerLogPath(connectionId),
      }
    }
  }

  // Owner-process anchor — REQUIRED before we spawn anything. A poller with no
  // recorded owner_pid can never be proven dead by the reaper (owner-death is the
  // liveness proof it keys on), so it lingers as a zombie "Live" agent
  // (item 00bd4f6e). We refuse rather than fall back to process.ppid: inside this
  // short-lived state-writer subprocess ppid is the ephemeral invoking shell, not
  // the owning agent — recording it would make the reaper SIGTERM a LIVE agent's
  // poller the instant that shell exits. Callers pass the agent explicitly as
  // --owner-pid "$PPID" (POSIX: correct and cheap). On win32 that shell-reported
  // pid is commonly unusable (Git Bash's MSYS pid space isn't a real Win32 pid —
  // see resolveOwnerPidAutoWindows), so there we self-resolve by walking THIS
  // process's own (genuinely real) pid up to the owning claude.exe instead of
  // refusing (item 3cddb3b4). Injectable so tests get a deterministic "no anchor
  // found" case regardless of host OS or whether a real claude.exe happens to be
  // an ancestor of the test runner itself.
  const resolveOwnerPidFn = opts.resolveOwnerPid || resolveOwnerPid
  const ownerPid = resolveOwnerPidFn(opts.ownerPid, null)
  if (ownerPid === null) {
    return {
      ok: false,
      error:
        'refusing to spawn a poller without a valid --owner-pid (no trustworthy owner anchor → the reaper could never prove it dead → zombie "Live" agent). Pass --owner-pid "$PPID" (POSIX) — on Windows this is normally self-resolved automatically; if you see this, the automatic walk to claude.exe failed too.',
    }
  }

  const stopped = stopPollerForConnection(connectionId)
  fs.mkdirSync(CONNECTIONS_DIR, { recursive: true })

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
    ...stripConnectionCapability(prev),
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
  const listenerResult = stopListenerForConnection(connectionId)
  return {
    ok: true,
    enabled: false,
    connection_id: connectionId,
    path: perPath,
    poller: killResult,
    listener: listenerResult,
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
 * Legacy backstop threshold. A still-running poller whose connection state carries
 * NO recorded owner_pid can't be proven dead by owner-death — this was the exact
 * zombie gap (item 00bd4f6e). New pollers always record an owner_pid
 * (ensurePollerForConnection refuses to spawn without one), so a live no-owner_pid
 * state is a pre-fix artifact. We reap it only once its local state has been
 * untouched this long, so a freshly-active legacy poller is never killed.
 */
const STALE_NO_OWNER_REAP_MS = 60 * 60 * 1000 // 1h

/** Clear a dead connection's local capability from both state pointers. */
function clearStoredConnectionCapability(connectionId) {
  const perPath = connectionPath(connectionId)
  const perState = readJson(perPath)
  if (perState) writeJson(perPath, stripConnectionCapability(perState))
  const legacy = readJson(LEGACY_PATH)
  if (legacy?.connection_id === connectionId) {
    writeJson(LEGACY_PATH, stripConnectionCapability(legacy))
  }
}

/**
 * Reap PROVABLY-DEAD pollers — the connect-time / SessionStart backstop for the
 * self-terminating poller. A poller is reaped when its connection is provably dead
 * (state disabled, ended-from-UI, or its recorded owner process is gone), so a live
 * sibling terminal's poller is NEVER touched. As a legacy safety net, a poller with
 * NO recorded owner_pid (pre-owner-pid-contract artifact — new spawns always record
 * one) is reaped only once its local state has gone stale beyond STALE_NO_OWNER_REAP_MS,
 * so a freshly-active one is left alone. Injectable for tests.
 */
export function reapDeadPollers({
  agent = AGENT_NAME,
  exceptConnectionId = null,
  now = Date.now(),
  staleNoOwnerReapMs = STALE_NO_OWNER_REAP_MS,
  listStates = scanConnectionStates,
  findPids = findPollerPidsForConnection,
  isOwnerAlive = ownerAlive,
  clearCapability = clearStoredConnectionCapability,
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
    const ownerPid = Number.isInteger(s.owner_pid) && s.owner_pid > 1 ? s.owner_pid : null
    const ownerGone = ownerPid !== null && !isOwnerAlive(ownerPid)
    const provablyDead = s.enabled === false || s.ended_from_ui === true || ownerGone

    // Legacy backstop: with no owner_pid there is nothing to prove death by, so
    // reap only when the connection is still nominally enabled but its local state
    // has been untouched beyond the stale threshold (never a freshly-active one; a
    // missing/unparsable updated_at is treated as "unknown → leave alone").
    let staleNoOwner = false
    if (!provablyDead && ownerPid === null && s.enabled !== false && s.ended_from_ui !== true) {
      const t = Date.parse(s.updated_at || '')
      if (Number.isFinite(t) && now - t >= staleNoOwnerReapMs) staleNoOwner = true
    }

    if (!provablyDead && !staleNoOwner) continue
    clearCapability(s.connection_id)
    const pids = findPids(s.connection_id)
    if (!pids.length) continue
    const killed = pids.filter((pid) => kill(pid))
    reaped.push({
      connection_id: s.connection_id,
      agent_name: s.agent_name || null,
      killed,
      reason:
        s.enabled === false
          ? 'disabled'
          : s.ended_from_ui
            ? 'ended_from_ui'
            : ownerGone
              ? 'owner_gone'
              : 'stale_no_owner',
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

function resolveLocalDir(rcOrLocalDir = LOCAL_DIR) {
  if (!rcOrLocalDir || typeof rcOrLocalDir !== 'string') return LOCAL_DIR
  return path.basename(rcOrLocalDir) === 'local' ? rcOrLocalDir : path.join(rcOrLocalDir, 'local')
}

export function localBondPath(agent, localId, rcOrLocalDir = LOCAL_DIR) {
  return path.join(resolveLocalDir(rcOrLocalDir), agentSlug(agent), `${localId}.json`)
}

/**
 * Detect local conversation identity.
 * Prefer explicit arg / env that uniquely identifies this agent conversation.
 * Never use cwd.
 *
 * CONVERSATION-SCOPED IDS ONLY. Deliberately does NOT probe SHELL_SESSION_ID /
 * TERM_SESSION_ID: those identify the host TERMINAL, not this conversation, so one
 * shell running several conversations in sequence bonds them all to one id.
 *
 * The damage is worse than a wrong bond, because callers try env FIRST and fall back
 * to the host's own conversation id second (hooks: `resolveHookConversationId` reads
 * the stdin `session_id`). A shell id present in env HIJACKS that first leg and the
 * correct fallback is never reached. Stop then resolves a bond that matches no
 * connection, `selectBoundState` fails closed once 2+ connections of this agent are
 * live, the `.turn` marker is never cleared, and the poller re-asserts busy until
 * MAX_TURN_MS (1h). Live bug: Working / bouncing dots stuck after every remote reply
 * (Grok item a6b3f881, Claude item 87117120 — same root cause, both plugins).
 *
 * Antigravity hooks receive `conversationId` and `transcriptPath` on stdin JSON,
 * and subprocesses may carry `DEVSPEC_REMOTE_LOCAL_ID` or `ANTIGRAVITY_CONVERSATION_ID`.
 * Note: `ANTIGRAVITY_TRAJECTORY_ID` is a per-trajectory UUID (distinct from the
 * conversation ID) and is intentionally NOT used as `local_id`.
 */
export function detectLocalId(args = {}, env = process.env) {
  const fromArg = sanitizeLocalId(
    args['local-id'] || args.localId || args.local_id || args.conversationId || args.conversation_id,
  )
  if (fromArg) return { local_id: fromArg, source: 'arg' }

  const envPairs = [
    ['DEVSPEC_REMOTE_LOCAL_ID', env.DEVSPEC_REMOTE_LOCAL_ID],
    ['ANTIGRAVITY_CONVERSATION_ID', env.ANTIGRAVITY_CONVERSATION_ID],
    ['CONVERSATION_ID', env.CONVERSATION_ID],
    ['CODEX_THREAD_ID', env.CODEX_THREAD_ID],
    ['CLAUDE_CODE_SESSION_ID', env.CLAUDE_CODE_SESSION_ID],
    ['CLAUDE_SESSION_ID', env.CLAUDE_SESSION_ID],
    ['GROK_SESSION_ID', env.GROK_SESSION_ID],
    ['GROK_CONVERSATION_ID', env.GROK_CONVERSATION_ID],
  ]
  for (const [name, val] of envPairs) {
    const id = sanitizeLocalId(val)
    if (id) return { local_id: id, source: `env:${name}` }
  }
  return { local_id: null, source: null }
}

/**
 * Infer the Antigravity conversation transcript path from a conversation UUID.
 * Antigravity stores conversation transcripts at:
 *   `<appDataDir>/brain/<conversationId>/.system_generated/logs/transcript.jsonl`
 */
export function inferAntigravityTranscriptPath(localId, env = process.env) {
  const id = sanitizeLocalId(localId)
  if (!id) return null
  const appDataDir =
    env.ANTIGRAVITY_APP_DATA_DIR || path.join(os.homedir(), '.gemini', 'antigravity-cli')
  const candidate = path.join(
    appDataDir,
    'brain',
    id,
    '.system_generated',
    'logs',
    'transcript.jsonl',
  )
  try {
    if (fs.existsSync(candidate)) return candidate
  } catch {
    /* ignore */
  }
  return null
}

export function mintLocalId() {
  return crypto.randomUUID()
}

/**
 * Recoverable ends: this conversation may soft-reconnect its own prior connection
 * rather than registering a fresh one. Purely a LOCAL decision — the server has no
 * end_reason allowlist (resolveActiveConnection filters on `ended_at is null` only,
 * and a live heartbeat clears both columns), so this list is not mirrored anywhere.
 *
 * `owner_gone` MUST be here: it is the single most common way a Claude Code
 * conversation's poller dies (the host process exited), and it is exactly the case
 * where the user relaunches and expects their agent back. Omitting it would silently
 * downgrade every restart to a brand-new connection — a new codename on the Agents
 * page and a lost bond (item 937c78b0).
 *
 * UI end stops this poller process; a new instance may re-attach only with explicit --session.
 */
export function isRecoverableEndReason(endReason) {
  return (
    endReason === 'local_stop' ||
    endReason === 'owner_gone' ||
    endReason === 'idle_timeout' ||
    endReason === 'auth'
  )
}

export function readLocalBond(agentOrLocalId, localIdOrDir = null, maybeDir = LOCAL_DIR) {
  // Support both readLocalBond(agent, localId, dir?) and readLocalBond(localId, dir?)
  const isPathSecond =
    typeof localIdOrDir === 'string' && (localIdOrDir.includes('/') || localIdOrDir.includes('\\'))
  const agent = isPathSecond || localIdOrDir === null ? AGENT_NAME : agentOrLocalId
  const localId = isPathSecond || localIdOrDir === null ? agentOrLocalId : localIdOrDir
  const dir = isPathSecond ? localIdOrDir : maybeDir
  if (!localId) return null
  return readJson(localBondPath(agent, localId, dir))
}

export function writeLocalBond(agentOrLocalId, localIdOrPatch, patchOrDir = null, maybeDir = LOCAL_DIR) {
  // Support both writeLocalBond(agent, localId, patch, dir?) and writeLocalBond(localId, patch, dir?)
  const isPatchSecond = localIdOrPatch && typeof localIdOrPatch === 'object'
  const agent = isPatchSecond ? AGENT_NAME : agentOrLocalId
  const localId = isPatchSecond ? agentOrLocalId : localIdOrPatch
  const patch = isPatchSecond ? localIdOrPatch : patchOrDir || {}
  const dir = isPatchSecond ? (typeof patchOrDir === 'string' ? patchOrDir : LOCAL_DIR) : maybeDir
  const p = localBondPath(agent, localId, dir)
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
  ownerPid = null,
  forceNew = false,
  maxAgeMinutes = DEFAULT_RECONNECT_MAX_AGE_MINUTES,
  now = Date.now(),
  readBond = readLocalBond,
  readConnection = (id) => readJson(connectionPath(id)),
  listStates = scanConnectionStates,
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

  let effectiveLocalId = localId
  let bond = effectiveLocalId ? readBond(agentName, effectiveLocalId) : null
  // If this conversation has no bond yet, check if this exact Antigravity window
  // (owner_pid) already auto-connected at startup with local_id === null.
  if (
    effectiveLocalId &&
    (!bond || !bond.connection_id) &&
    Number.isInteger(Number(ownerPid)) &&
    Number(ownerPid) > 1
  ) {
    const matchingStartup = listStates().find(
      (s) =>
        s &&
        s.enabled !== false &&
        !s.ended_from_ui &&
        !s.local_id &&
        String(s.agent_name || '').toLowerCase() === String(agentName).toLowerCase() &&
        Number(s.owner_pid) === Number(ownerPid),
    )
    if (matchingStartup?.connection_id) {
      rebondConnectionToConversation({
        agent: agentName,
        connectionId: matchingStartup.connection_id,
        localId: effectiveLocalId,
      })
      bond = readBond(agentName, effectiveLocalId)
    }
  } else if (
    !effectiveLocalId &&
    Number.isInteger(Number(ownerPid)) &&
    Number(ownerPid) > 1
  ) {
    // When invoked from a run_command shell where ANTIGRAVITY_CONVERSATION_ID is not
    // in process.env, reuse the active connection already bound to this window's owner_pid.
    const candidates = listStates().filter(
      (s) =>
        s &&
        !s.ended_from_ui &&
        String(s.agent_name || '').toLowerCase() === String(agentName).toLowerCase() &&
        Number(s.owner_pid) === Number(ownerPid),
    )
    const matchingOwnerConn =
      candidates.find((s) => s.enabled !== false && s.local_id) ||
      candidates.find((s) => s.enabled !== false) ||
      candidates.find((s) => s.local_id) ||
      null
    if (matchingOwnerConn?.connection_id) {
      if (matchingOwnerConn.local_id) {
        effectiveLocalId = matchingOwnerConn.local_id
        bond = readBond(agentName, effectiveLocalId)
      }
      if (!bond || !bond.connection_id) {
        bond = {
          status: matchingOwnerConn.enabled === false ? 'stopped' : 'live',
          connection_id: matchingOwnerConn.connection_id,
          agent_name: matchingOwnerConn.agent_name || agentName,
          local_id: effectiveLocalId || null,
          session_id: matchingOwnerConn.session_id || null,
          session_codename:
            matchingOwnerConn.session_codename || matchingOwnerConn.codename || null,
          title: matchingOwnerConn.title || null,
          end_reason: matchingOwnerConn.end_reason || null,
          updated_at: matchingOwnerConn.updated_at || null,
        }
      }
    }
  }

  if (!bond || !bond.connection_id) {
    return {
      ok: true,
      action: 'register',
      found: false,
      local_id: effectiveLocalId || null,
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
      note: !effectiveLocalId
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
    local_id: effectiveLocalId || conn.local_id || null,
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
      requires_state_write: true,
      note: `This conversation is already connected as "${base.session_codename || bond.connection_id.slice(0, 8)}". Run state write to mechanically re-register this bond and rotate capability before re-arming the wait; do not create a new connection.`,
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

/**
 * Re-register the stable token/local-id bond to rotate a version-1 plan capability.
 * The secret is read only from MCP result _meta, compared to the expected connection,
 * and persisted by the caller in a mode-0600 connection state file.
 */
export async function negotiateConnectionCapability({
  mcpUrl,
  token,
  projectId,
  gitRemote = null,
  localId,
  connectionId,
  agentName = AGENT_NAME,
  cwd = process.cwd(),
  call = mcpToolsCall,
  onProjectId = null,
} = {}) {
  if (!mcpUrl || !token || (!projectId && !gitRemote) || !localId || !connectionId) {
    return { ok: false, error: 'capability negotiation requires MCP auth, project-id, local-id, and connection-id' }
  }
  try {
    const result = await call({
      mcpUrl,
      token,
      name: 'register_connection',
      arguments: {
        ...(projectId ? { project_id: projectId } : {}),
        ...(gitRemote ? { git_remote: gitRemote } : {}),
        local_id: localId,
        agent_name: agentName,
        cwd,
        connection_capability_version: 1,
      },
      includeMeta: true,
      timeoutMs: 15_000,
    })
    if (result?.data?.connection_id !== connectionId) {
      return { ok: false, error: 'capability negotiation returned a different connection bond' }
    }
    if (typeof onProjectId === 'function' && typeof result?.data?.project_id === 'string' && result.data.project_id) {
      onProjectId(result.data.project_id)
    }
    const capability = result?.meta?.devspec?.connection_capability
    if (capability?.version !== 1 || typeof capability.value !== 'string' || !capability.value.startsWith('dvsc_')) {
      return { ok: false, error: 'server did not return connection capability version 1 in MCP result _meta' }
    }
    return { ok: true, version: 1, value: capability.value }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Move a live connection onto a new conversation of the SAME Antigravity process
 * (e.g. when a new conversation starts or resumes under a startup listener).
 */
export function rebondConnectionToConversation({
  agent = AGENT_NAME,
  connectionId,
  localId,
  transcriptPath = null,
} = {}) {
  const id = sanitizeLocalId(localId)
  if (!connectionId || !id) return { ok: false, reason: 'missing_ids' }
  const perPath = connectionPath(connectionId)
  const state = readJson(perPath)
  if (!state || state.enabled === false) return { ok: false, reason: 'connection_not_live' }
  const agentName = agent || state.agent_name || AGENT_NAME
  const resolvedTranscriptPath =
    (typeof transcriptPath === 'string' && transcriptPath.trim() ? transcriptPath.trim() : null) ||
    inferAntigravityTranscriptPath(id) ||
    state.transcript_path ||
    null
  const bond = writeLocalBond(agentName, id, {
    status: 'live',
    connection_id: connectionId,
    session_id: state.session_id ?? null,
    session_codename: state.session_codename ?? null,
    title: state.title ?? null,
    project_id: state.project_id ?? null,
    ...(state.project_name ? { project_name: state.project_name } : {}),
    cwd: state.cwd ?? null,
    end_reason: null,
    cursor_after_message_id: state.cursor_after_message_id || null,
    transcript_path: resolvedTranscriptPath,
  })
  if (state.project_id && state.project_name && state.mcp_url) {
    try {
      saveConversationProject(
        id,
        state.mcp_url,
        { id: state.project_id, name: state.project_name },
        'folder',
      )
    } catch {
      /* non-fatal */
    }
  }
  writeJson(perPath, {
    ...state,
    local_id: id,
    transcript_path: resolvedTranscriptPath,
    updated_at: new Date().toISOString(),
  })
  return {
    ok: true,
    connection_id: connectionId,
    local_id: id,
    transcript_path: resolvedTranscriptPath,
    bond_path: localBondPath(agentName, id),
    bond,
  }
}

/**
 * Shared connection state + bond + poller + listener writer used by
 * `devspec-remote-connect.mjs`, `session-start.mjs`, and `remote-control-state.mjs write`.
 */
export async function writeConnectionState({
  connectionId,
  sessionId: explicitSessionId = null,
  agent = AGENT_NAME,
  projectId: explicitProjectId = null,
  projectName: explicitProjectName = null,
  cwd = process.cwd(),
  localId: explicitLocalId = null,
  ownerPid: explicitOwnerPid = null,
  codename = null,
  title = null,
  instructionTiers = null,
  connectionCapability = null,
  noPoller = false,
  env = process.env,
  home = os.homedir(),
  transcriptPath: explicitTranscriptPath = null,
} = {}) {
  const connDir = path.join(home, '.devspec', 'remote-control', 'connections')
  const rcDir = path.join(home, '.devspec', 'remote-control')
  const legacyPath = path.join(home, '.devspec', 'remote-control.json')
  const prev = readJson(connectionPath(connectionId, connDir)) || {}
  const agentName = agent || prev.agent_name || AGENT_NAME
  const detected = detectLocalId({ 'local-id': explicitLocalId }, env)
  const localId = detected.local_id || prev.local_id || null
  const transcriptPath =
    explicitTranscriptPath ||
    prev.transcript_path ||
    inferAntigravityTranscriptPath(localId, env) ||
    null
  const sessionId =
    typeof explicitSessionId === 'string' && explicitSessionId.length >= 8
      ? explicitSessionId
      : prev.session_id ?? null
  const ownerPid = resolveOwnerPid(explicitOwnerPid, prev.owner_pid)
  const hostToken = hostTokenFromEnv(env, { cwd, home })
  const auth = resolveDevspecMcpAuth(cwd, { hostToken, env, home })
  let projectId =
    explicitProjectId || prev.project_id || findProjectPin(cwd, { home })?.project_id || null
  const projectName = explicitProjectName || prev.project_name || null
  const gitRemote = gitRemoteOrigin(cwd)

  let capability = null
  if (typeof connectionCapability === 'string' && connectionCapability.startsWith('dvsc_')) {
    capability = { ok: true, version: 1, value: connectionCapability }
  } else if (auth.ok && localId) {
    capability = await negotiateConnectionCapability({
      mcpUrl: auth.mcp_url || prev.mcp_url,
      token: auth.token || prev.token,
      projectId,
      gitRemote,
      localId,
      connectionId,
      agentName,
      cwd,
      onProjectId: (resolvedId) => {
        if (!projectId && resolvedId) projectId = resolvedId
      },
    })
  } else if (typeof prev.connection_capability === 'string' && prev.connection_capability.startsWith('dvsc_')) {
    capability = {
      ok: true,
      version: prev.connection_capability_version || 1,
      value: prev.connection_capability,
    }
  } else {
    capability = { ok: false, error: auth.error || 'MCP auth or local_id unavailable' }
  }

  const state = {
    ...applyConnectionCapabilityRotation(prev, capability),
    enabled: true,
    connection_id: connectionId,
    session_id: sessionId,
    agent_name: agentName,
    local_id: localId,
    transcript_path: transcriptPath,
    owner_pid: ownerPid,
    project_id: projectId,
    ...(projectName ? { project_name: projectName } : {}),
    mcp_url: auth.mcp_url || prev.mcp_url || 'https://devspec.ai/api/mcp',
    token: auth.token || prev.token || undefined,
    auth_source: auth.source || auth.error || prev.auth_source || null,
    auth_ok: !!auth.ok || !!prev.auth_ok,
    cwd,
    ...(gitRemote ? { git_remote: gitRemote } : {}),
    session_codename: codename || prev.session_codename || prev.codename || null,
    title: title || prev.title || null,
    ...(title && sessionId
      ? { session_title: title, session_title_for: sessionId }
      : {}),
    ...(instructionTiers?.hash && instructionTiers?.version
      ? {
          instruction_tiers_version: instructionTiers.version,
          instruction_tiers_hash: instructionTiers.hash,
        }
      : {}),
    ...(env.ANTIGRAVITY_LS_ADDRESS ? { ls_address: env.ANTIGRAVITY_LS_ADDRESS } : {}),
    ...(env.ANTIGRAVITY_CSRF_TOKEN ? { csrf_token: env.ANTIGRAVITY_CSRF_TOKEN } : {}),
    ...(env.ANTIGRAVITY_AGENTAPI_EXE ? { agentapi_exe: env.ANTIGRAVITY_AGENTAPI_EXE } : {}),
    ended_from_ui: false,
    end_reason: null,
    updated_at: new Date().toISOString(),
  }

  const perPath = connectionPath(connectionId, connDir)
  writeJson(perPath, state)
  writeJson(legacyPath, state)

  let bond = null
  if (localId) {
    bond = writeLocalBond(
      agentName,
      localId,
      {
        status: 'live',
        connection_id: connectionId,
        session_id: sessionId,
        session_codename: state.session_codename,
        title: state.title,
        project_id: projectId,
        ...(projectName ? { project_name: projectName } : {}),
        cwd,
        end_reason: null,
        cursor_after_message_id: prev.cursor_after_message_id || null,
        transcript_path: transcriptPath,
      },
      rcDir,
    )
    if (projectId && projectName && state.mcp_url) {
      try {
        saveConversationProject(
          localId,
          state.mcp_url,
          { id: projectId, name: projectName },
          'conversation',
          { home },
        )
      } catch {
        /* non-fatal */
      }
    }
  }

  const result = {
    ok: true,
    path: perPath,
    legacy_path: legacyPath,
    connection_id: state.connection_id,
    session_id: state.session_id,
    session_codename: state.session_codename,
    title: state.title,
    mcp_url: state.mcp_url,
    auth_ok: state.auth_ok,
    auth_source: state.auth_source,
    token_present: !!state.token,
    local_id: localId,
    owner_pid: ownerPid,
    transcript_path: transcriptPath,
    bond_path: bond ? localBondPath(agentName, localId, rcDir) : null,
    project_id: projectId,
    project_name: projectName,
    agentapi_ready: Boolean(state.ls_address && state.csrf_token),
    plan_capability: {
      ok: capability.ok,
      version: capability.ok ? capability.version : null,
      error: capability.ok ? null : capability.error,
    },
  }
  if (!state.auth_ok) result.warning = auth.error
  if (!localId) {
    result.warning_local =
      'No --local-id / conversation env; soft-reconnect and already_live will not work until write is called with a local id.'
  }

  const wantPoller = state.auth_ok && !noPoller
  if (wantPoller) {
    try {
      const reaped = reapDeadPollers({ agent: agentName, exceptConnectionId: connectionId })
      if (reaped.length) result.reaped = reaped
    } catch {
      /* non-fatal */
    }
    const reuseRunning =
      !!prev.token &&
      prev.token === state.token &&
      (prev.mcp_url || null) === (state.mcp_url || null) &&
      (Number(prev.owner_pid) || null) === (Number(state.owner_pid) || null) &&
      (prev.connection_capability || null) === (state.connection_capability || null)
    const poller = ensurePollerForConnection(connectionId, {
      cwd,
      ownerPid,
      sessionId,
      reuseRunning,
    })
    result.poller = poller
    if (!poller.ok) {
      result.warning_poller = poller.error
    }
    const listener = ensureListenerForConnection(connectionId, {
      cwd,
      ownerPid,
      conversationId: localId,
      reuseRunning: true,
      connDir,
      env,
    })
    result.listener = listener
  } else if (noPoller) {
    result.poller = { ok: true, skipped: true, reason: 'no-poller' }
  }
  return result
}

// --- CLI entry (skipped when imported for tests) ---
const isMain =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (isMain) {
  const args = parseArgs(process.argv.slice(2))
  const cmd = args._[0] || 'read'

  if (cmd === 'resolve-auth') {
    const hostToken =
      (typeof args['host-token'] === 'string' && args['host-token'].trim()
        ? args['host-token'].trim()
        : null) || hostTokenFromEnv(process.env)
    const auth = resolveDevspecMcpAuth(args.cwd || process.cwd(), { hostToken })
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
      ownerPid: resolveOwnerPid(args['owner-pid'], null),
      forceNew: !!args.forceNew,
      maxAgeMinutes,
    })

    result.cwd = args.cwd ? path.resolve(args.cwd) : process.cwd()
    result.local_id_source = detected.source || (result.local_id ? 'owner_pid_bond' : null)
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

  if (cmd === 'status') {
    const connectionId = args['connection-id'] || readJson(LEGACY_PATH)?.connection_id
    if (!connectionId) {
      process.stderr.write('Usage: remote-control-state.mjs status --connection-id <uuid>\n')
      process.exit(2)
    }
    const s = readJson(connectionPath(connectionId))
    if (!s) {
      process.stdout.write(
        JSON.stringify({
          ok: false,
          connection_id: connectionId,
          found: false,
          reconnect: {
            action: 'reconnect',
            instruction: 'State file not found; re-run devspec-remote-connect.mjs to establish the bond.',
          },
        }) + '\n',
      )
      process.exit(1)
    }
    const endedFromUi = s.ended_from_ui === true || s.end_reason === 'ui' || s.end_reason === 'ended_from_ui'
    const localStop = s.end_reason === 'local_stop'
    const ownerDead = Number.isInteger(s.owner_pid) && s.owner_pid > 1 && !ownerAlive(s.owner_pid)
    const standDown = endedFromUi || localStop || ownerDead
    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          connection_id: s.connection_id,
          session_id: s.session_id || null,
          enabled: s.enabled !== false,
          ended_from_ui: endedFromUi,
          end_reason: s.end_reason || null,
          owner_alive: !ownerDead,
          token_present: Boolean(s.token),
          connection_capability_present: typeof s.connection_capability === 'string',
          reconnect: {
            action: standDown ? 'stand_down' : 'reconnect',
            instruction: standDown
              ? 'Connection was deliberately ended or owner process exited. Stand down and do not re-register.'
              : 'Connection end was not attributed to a human stop. Re-run devspec-remote-connect.mjs once to resume.',
          },
        },
        null,
        2,
      ) + '\n',
    )
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
    const printable = s
      ? {
          ...s,
          connection_capability_present: typeof s.connection_capability === 'string',
          connection_capability: undefined,
        }
      : null
    process.stdout.write(JSON.stringify(printable, null, 2) + '\n')
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
      // "ensure" semantics: a live poller for this connection already satisfies
      // the call — never restart it from here (item b9e02835).
      reuseRunning: true,
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

  if (cmd === 'orient' || cmd === 'context') {
    const agentName = args.agent || AGENT_NAME
    let payload = null
    if (cmd === 'context' && !process.stdin.isTTY) {
      try {
        payload = JSON.parse(fs.readFileSync(0, 'utf8') || '{}')
      } catch {
        payload = null
      }
    }
    const stdinConvId = payload?.conversationId || payload?.session_id
    const detected = detectLocalId(
      stdinConvId ? { ...args, 'local-id': stdinConvId } : args,
      process.env,
    )
    const bond = detected.local_id ? readLocalBond(agentName, detected.local_id) : null
    const connectionId = args['connection-id'] || bond?.connection_id || null
    const state = connectionId ? readJson(connectionPath(connectionId)) : null
    if (!connectionId || !state) {
      if (cmd === 'context') process.exit(0)
      process.stdout.write(
        'This conversation is not connected to DevSpec. Nothing to orient on.\n',
      )
      process.exit(1)
    }
    if (cmd === 'context') {
      const additionalContext = [
        `DevSpec connection active: connection_id=${connectionId}`,
        state.session_codename ? `codename=${state.session_codename}` : '',
        state.session_id ? `session_id=${state.session_id}` : 'sessionless',
        detected.local_id ? `local_id=${detected.local_id}` : '',
      ]
        .filter(Boolean)
        .join(' | ')
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: args.event === 'SessionStart' ? 'SessionStart' : 'PreInvocation',
            additionalContext,
          },
        }) + '\n',
      )
      process.exit(0)
    }
    const lines = [
      `connection_id: ${connectionId}`,
      `codename: ${state.session_codename || '—'}`,
      `session_id: ${state.session_id || 'none (sessionless — there is no room to answer in)'}`,
      `local_id: ${state.local_id || detected.local_id || '—'}`,
      `transcript_path: ${state.transcript_path || '—'}`,
    ]
    process.stdout.write(lines.join('\n') + '\n')
    process.exit(0)
  }

  if (cmd === 'disable-local') {
    // SessionEnd teardown: resolve THIS conversation's bound connection (no
    // --connection-id needed) and disable it.
    const agentName = args.agent || AGENT_NAME
    let localId = detectLocalId(args, process.env).local_id
    // Hook delivers the conversation id on stdin as { conversationId } or { session_id }.
    if (!localId && !process.stdin.isTTY) {
      try {
        const raw = fs.readFileSync(0, 'utf8')
        const j = JSON.parse(raw || '{}')
        const stdinId = j.conversationId || j.session_id
        if (typeof stdinId === 'string') localId = sanitizeLocalId(stdinId)
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
    // Token symmetry (item 74b29c76): prefer the SAME bearer the host MCP client
    // used for register_connection so the poller heartbeats THIS connection under
    // the same identity — otherwise the server rejects with "connection belongs to
    // a different token" and dispatch delivery spams. The host token comes from an
    // explicit --host-token (the write "receives one") or the reachable plugin
    // userConfig env Claude Code exports (an env "carries it"); it wins over the
    // .mcp.json walk but not an explicit DEVSPEC_MCP_TOKEN. Absent on non-Claude
    // plugins / dev-from-source setups → resolution is unchanged. See resolve-mcp-auth.mjs.
    const hostToken =
      (typeof args['host-token'] === 'string' && args['host-token'].trim()
        ? args['host-token'].trim()
        : null) || hostTokenFromEnv(process.env)
    const auth = resolveDevspecMcpAuth(cwd, { hostToken })
    const prev = readJson(connectionPath(connectionId)) || {}
    const agentName = args.agent || prev.agent_name || AGENT_NAME
    // The conversation this write belongs to — stamped INTO the per-connection state
    // so the mirror hook can bind strictly to THIS conversation.
    const localId = detectLocalId(args, process.env).local_id
    const explicitTranscriptPath =
      typeof args['transcript-path'] === 'string' && args['transcript-path'].trim()
        ? args['transcript-path'].trim()
        : null
    const transcriptPath =
      explicitTranscriptPath ||
      prev.transcript_path ||
      inferAntigravityTranscriptPath(localId, process.env) ||
      null
    // Optional attached session (present for --session / --new; absent = sessionless).
    const sessionId =
      typeof args.session === 'string' && args.session.length >= 8 ? args.session : prev.session_id ?? null
    // Owner-process anchor for self-termination (see devspec-remote-poll.mjs and
    // resolveOwnerPid / resolveOwnerPidAutoWindows above for the win32 self-resolve path).
    const ownerPid = resolveOwnerPid(args['owner-pid'], prev.owner_pid)
    let projectId = args['project-id'] || prev.project_id || findProjectPin(cwd)?.project_id || null
    const gitRemote = gitRemoteOrigin(cwd)
    const capability = auth.ok
      ? await negotiateConnectionCapability({
          mcpUrl: args.url || auth.mcp_url || prev.mcp_url,
          token: auth.token || prev.token,
          projectId,
          gitRemote,
          localId,
          connectionId,
          agentName,
          cwd,
          onProjectId: (resolvedId) => {
            if (!projectId && resolvedId) projectId = resolvedId
          },
        })
      : { ok: false, error: auth.error || 'MCP auth unavailable' }
    const state = {
      ...applyConnectionCapabilityRotation(prev, capability),
      enabled: true,
      connection_id: connectionId,
      session_id: sessionId,
      agent_name: agentName,
      local_id: localId ?? prev.local_id ?? null,
      transcript_path: transcriptPath,
      owner_pid: ownerPid,
      project_id: projectId,
      mcp_url: args.url || auth.mcp_url || prev.mcp_url || 'https://api.devspec.ai/api/mcp',
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
        transcript_path: transcriptPath,
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
      transcript_path: transcriptPath,
      bond_path: bond ? localBondPath(agentName, localId) : null,
      project_id: projectId,
      plan_capability: {
        ok: capability.ok,
        version: capability.ok ? capability.version : null,
        error: capability.ok ? null : capability.error,
      },
    }
    if (!state.auth_ok) {
      result.warning = auth.error
    }
    if (!localId) {
      result.warning_local =
        'No --local-id / conversation env; soft-reconnect and already_live will not work until write is called with a local id.'
    }
    if (!capability.ok) {
      result.warning_plan =
        `Shared plans unavailable until capability negotiation succeeds: ${capability.error}`
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
      // Same token/url/owner → the live poller keeps serving this connection
      // (session attach/detach reaches it via the server heartbeat echo), so a
      // `write --session` never restarts it. Only a real identity change takes
      // the kill→respawn path — and even then the dying poller exits silently
      // (item b9e02835).
      const reuseRunning =
        !!prev.token &&
        prev.token === state.token &&
        (prev.mcp_url || null) === (state.mcp_url || null) &&
        (Number(prev.owner_pid) || null) === (Number(state.owner_pid) || null)
      const poller = ensurePollerForConnection(connectionId, {
        cwd,
        ownerPid,
        sessionId,
        reuseRunning,
      })
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
