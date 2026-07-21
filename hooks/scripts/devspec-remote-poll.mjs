#!/usr/bin/env node
/**
 * devspec-remote-poll — long-lived background poller for DevSpec remote control
 * (CONNECTION-NATIVE, item fd51d80b).
 *
 * Runs outside the model context (plain Node HTTP MCP — **no LLM tokens**).
 * Heartbeats a CONNECTION for its whole lifetime and delivers two clearly separated
 * streams to the local agent:
 *
 *   1. OWNER COMMANDS — server-stamped same-token owner dispatches. Sources:
 *        • connection-native work dispatches  (get_connection_dispatch)
 *        • owner instructions in an attached session's transcript (is_owner_instruction)
 *      Delivered as `owner_messages` inbox entries + a `wake` line → the agent ACTS.
 *   2. ADVISORY ROOM CONTEXT — everything else in an attached session (teammate
 *      posts, Dev/in-session-AI responses, other agents). Delivered as
 *      `advisory_context` inbox entries only (NO wake) → the agent reads it for
 *      AWARENESS when it next acts, but it NEVER authorizes a tool action or an
 *      autonomous reply. Only a server-stamped owner command may cause execution.
 *
 * A connection may be SESSIONLESS (available, no room) or ATTACHED to one session
 * (optional shared context). When sessionless it only polls its dispatch inbox;
 * when attached it also polls the room transcript. Attach/detach is picked up live
 * from the server (the heartbeat echo is the SOLE attachment authority), so the
 * poller adapts without a restart — local state is never used to override it.
 *
 * Owner commands do **NOT** terminate this process — heartbeats keep the Agents UI
 * Live while the agent works.
 *
 * Exit only for terminal conditions:
 *   1  — disabled / UI end / idle_timeout / auth failure / connection ended / error
 *   2  — bad args
 *
 * Two cadences, chosen by connection STATE: attended (attached to a session OR a
 * turn active) polls + heartbeats every 15s; idle (sessionless + no turn) every
 * 60s. A fully idle connection disconnects cleanly at the 72h cap. Heartbeat and
 * poll are independent timers.
 *
 * Usage:
 *   node devspec-remote-poll.mjs --connection-id <uuid> [--session <uuid>] [--owner-pid <pid>]
 *
 * Requires token in per-connection state / ~/.devspec/remote-control.json or DEVSPEC_MCP_TOKEN.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mcpToolsCall } from './mcp-call.mjs'
import { resolveDevspecMcpAuth, hostTokenFromEnv } from './resolve-mcp-auth.mjs'
import { AGENT_NAME } from './agent-identity.mjs'

const LEGACY_STATE_PATH = path.join(os.homedir(), '.devspec', 'remote-control.json')
const CONNECTIONS_DIR = path.join(os.homedir(), '.devspec', 'remote-control', 'connections')

function inboxPathForConnection(connectionId) {
  return path.join(CONNECTIONS_DIR, `${connectionId}.inbox.jsonl`)
}

// Two cadences, chosen by connection STATE (not elapsed idle time):
//   attended — attached to a session OR a turn is active. Someone may be watching
//              and pickup latency matters, so poll + heartbeat fast (15s).
//   idle     — sessionless AND no active turn. Poll + heartbeat slow (60s).
// The wait/inbox path stays event-driven for owner commands regardless of cadence.
/** @type {{ pollMs: number, heartbeatMs: number, tier: 'attended' }} */
const ATTENDED_CADENCE = { pollMs: 15_000, heartbeatMs: 15_000, tier: 'attended' }
/** @type {{ pollMs: number, heartbeatMs: number, tier: 'idle' }} */
const IDLE_CADENCE = { pollMs: 60_000, heartbeatMs: 60_000, tier: 'idle' }
// Hard idle-disconnect cap: a fully idle connection disconnects cleanly at 72h.
const IDLE_DISCONNECT_MS = 72 * 60 * 60 * 1000
const MAX_TURN_MS = 60 * 60 * 1000

function turnMarkerPath(connectionId) {
  return path.join(CONNECTIONS_DIR, `${connectionId}.turn`)
}
function readTurnMarker(connectionId) {
  try {
    const p = turnMarkerPath(connectionId)
    if (!fs.existsSync(p)) return null
    const m = JSON.parse(fs.readFileSync(p, 'utf8'))
    return typeof m?.startedAt === 'number' ? m : null
  } catch {
    return null
  }
}
/**
 * Start a turn at honest owner-command pickup (remote UI / dispatch delivery).
 * The long-lived poller re-asserts busy while this marker is fresh; Stop /
 * mirror-turn clears it when the agent turn ends.
 */
function writeTurnMarker(connectionId) {
  if (!connectionId) return
  try {
    fs.mkdirSync(CONNECTIONS_DIR, { recursive: true })
    fs.writeFileSync(turnMarkerPath(connectionId), JSON.stringify({ startedAt: Date.now() }), {
      mode: 0o600,
    })
  } catch {
    /* non-fatal — immediate busy heartbeat at call site still fires */
  }
}

/** Owner (agent) process liveness — see the anti-zombie contract. EPERM = alive. */
function ownerAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return !!e && e.code === 'EPERM'
  }
}

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--connection-id' || a === '--connection_id' || a === '--connection') {
      out.connectionId = argv[++i]
    } else if (a === '--session' || a === '--session_id') out.session = argv[++i]
    else if (a === '--cursor') out.cursor = argv[++i]
    else if (a === '--owner-user-id') out.ownerUserId = argv[++i]
    else if (a === '--owner-pid') out.ownerPid = argv[++i]
    else if (a === '--interval-ms' || a === '--heartbeat-ms' || a === '--max-ms') i++
  }
  return out
}

/** Prefer per-connection state so concurrent remotes do not clobber each other. */
function readState(connectionId) {
  const tryPaths = []
  if (connectionId) tryPaths.push(path.join(CONNECTIONS_DIR, `${connectionId}.json`))
  tryPaths.push(LEGACY_STATE_PATH)
  for (const p of tryPaths) {
    try {
      if (!fs.existsSync(p)) continue
      const s = JSON.parse(fs.readFileSync(p, 'utf8'))
      if (
        connectionId &&
        s.connection_id &&
        s.connection_id !== connectionId &&
        p === LEGACY_STATE_PATH
      ) {
        continue
      }
      return s
    } catch {
      /* try next */
    }
  }
  return null
}

function writeState(state, connectionId) {
  const cid = connectionId || state.connection_id
  const paths = []
  if (cid) paths.push(path.join(CONNECTIONS_DIR, `${cid}.json`))
  try {
    const legacy = fs.existsSync(LEGACY_STATE_PATH)
      ? JSON.parse(fs.readFileSync(LEGACY_STATE_PATH, 'utf8'))
      : null
    if (!legacy || !legacy.connection_id || legacy.connection_id === cid) {
      paths.push(LEGACY_STATE_PATH)
    }
  } catch {
    paths.push(LEGACY_STATE_PATH)
  }
  for (const p of paths) {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
  }
}

/**
 * Append a batch to the connection inbox. `type` is 'owner_messages' (commands the
 * agent acts on — woken by the wait watcher) or 'advisory_context' (room awareness
 * the agent reads but never acts on — the wait watcher ignores it, so it never
 * forces a model wake / autonomous response).
 */
function appendInbox(connectionId, messages, { type = 'owner_messages', nextCursor = null, sessionId = null } = {}) {
  if (!connectionId || !messages?.length) return
  try {
    fs.mkdirSync(CONNECTIONS_DIR, { recursive: true })
    const line = JSON.stringify({
      type,
      connection_id: connectionId,
      session_id: sessionId,
      received_at: new Date().toISOString(),
      count: messages.length,
      next_after_message_id: nextCursor,
      messages,
    })
    fs.appendFileSync(inboxPathForConnection(connectionId), line + '\n', { mode: 0o600 })
  } catch (e) {
    process.stderr.write(`devspec-remote-poll: inbox write failed: ${e.message}\n`)
  }
}

/** Disable THIS connection only — never other remotes on the machine. */
function disableLocalState({ connectionId, reason }) {
  try {
    const prev = readState(connectionId) || {}
    writeState(
      {
        ...prev,
        enabled: false,
        connection_id: connectionId || prev.connection_id,
        ended_from_ui: reason === 'ended_from_ui',
        end_reason: reason,
        updated_at: new Date().toISOString(),
      },
      connectionId,
    )
  } catch (e) {
    process.stderr.write(`devspec-remote-poll: failed to disable state: ${e.message}\n`)
  }
}

function isEndedFromUi(hb) {
  if (!hb || typeof hb !== 'object') return false
  if (hb.ended_from_ui === true) return true
  if (hb.end_reason === 'ui') return true
  if (hb.result && hb.result.ended_from_ui === true) return true
  return false
}

function isTerminalEnded(hb) {
  if (!hb || typeof hb !== 'object') return false
  if (isEndedFromUi(hb)) return true
  // Connection-native: heartbeat_connection returns status 'not_found' (connection
  // ended server-side, e.g. an Agents-page End) — terminal.
  if (hb.status === 'not_found') return true
  if (hb.live === false && hb.end_reason && hb.end_reason !== null) return true
  return false
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Poll/heartbeat cadence from connection STATE. attended (15s) when attached to a
 * session OR a turn is active — someone may be watching and pickup latency
 * matters; idle (60s) otherwise. Elapsed idle time no longer changes the cadence;
 * it only feeds the 72h IDLE_DISCONNECT_MS cap.
 */
export function cadenceFor({ attached = false, turnActive = false } = {}) {
  return attached || turnActive ? ATTENDED_CADENCE : IDLE_CADENCE
}

/**
 * Map a turn-active transition (previous loop tick → this loop tick) to the
 * connection activity verb the poller emits DIRECTLY (item 71a8b201). This is the
 * clean end state: the poller drives the activity state machine from its own
 * turn-active signal instead of leaving the server to translate the legacy
 * busy-heartbeat (syncActivityFromBusy). Driven by the poller's turn marker, so it
 * is host-agnostic (Grok works too — no per-host Stop hook needed).
 *
 *   false → true  = a turn just started (owner-command pickup / local turn) → 'pickup'
 *   true  → true  = still working this turn (per heartbeat/loop tick)        → 'keepalive'
 *   true  → false = the turn ended (marker cleared by Stop / wait re-arm)    → 'complete'
 *   false → false = idle, nothing to report                                  → null
 *
 * @returns {'pickup'|'keepalive'|'complete'|null}
 */
export function verbForTurnTransition(prev, next) {
  if (!prev && next) return 'pickup'
  if (prev && next) return 'keepalive'
  if (prev && !next) return 'complete'
  return null
}

/** Activity verb → connection-native MCP tool name. */
const ACTIVITY_VERB_TOOL = {
  pickup: 'report_pickup',
  keepalive: 'report_keepalive',
  complete: 'report_complete',
}

/**
 * Server-authoritative attachment decision — the SOLE attachment-adoption path.
 * The heartbeat echo (`hb.session_id`) is the one source of truth for which
 * session this connection is attached to; local state is written FROM it, never
 * used to override it (item edea1a91). A `not_found` heartbeat means the
 * connection must re-register and omits session_id, so it must NEVER be read as a
 * detach → no change. `changed` is the ONE trigger to reseed the transcript
 * cursor, and it flips only when the server-reported session actually differs.
 */
export function resolveServerAttachment(currentSessionId, hb) {
  if (!hb || typeof hb !== 'object' || hb.status === 'not_found') {
    return { sessionId: currentSessionId, changed: false }
  }
  const hbSession = typeof hb.session_id === 'string' && hb.session_id ? hb.session_id : null
  return { sessionId: hbSession, changed: hbSession !== currentSessionId }
}

/**
 * COMMAND gate (unchanged authority model). True only for a server-stamped
 * same-token owner instruction, or (degraded fallback for untagged rows) an
 * explicit local_agent_dispatch authored by this connection's owner. Command
 * authority is per-token, NEVER inferred from session ownership or message body.
 */
export function isOwnerMessage(msg, ownerUserId) {
  if (!msg) return false
  if (msg.remote_control && typeof msg.remote_control.is_owner_instruction === 'boolean') {
    return msg.remote_control.is_owner_instruction === true
  }
  if (msg.message_type === 'local_agent_dispatch') {
    if (!ownerUserId) return false
    const author = msg.author
    if (author?.kind && author.kind !== 'human') return false
    const uid = author?.user_id || msg.user_id
    return uid === ownerUserId
  }
  return false
}

/**
 * Classify a room transcript message: 'command' (owner instruction — act on it),
 * 'advisory' (teammate / Dev / other-agent context — awareness only), or 'skip'
 * (system boundary markers and other noise). Advisory NEVER authorizes action.
 */
export function classifyRoomMessage(msg, ownerUserId) {
  if (isOwnerMessage(msg, ownerUserId)) return 'command'
  // Explicitly advisory: the server marks non-owner rows is_advisory on RC sessions.
  if (msg?.remote_control && msg.remote_control.is_advisory === true) return 'advisory'
  const kind = msg?.author?.kind
  if (kind === 'human' || kind === 'in_session_ai' || kind === 'external_agent') return 'advisory'
  return 'skip'
}

/**
 * Deliver owner commands without exiting — heartbeats keep running. Writes an
 * `owner_messages` inbox entry (woken by the wait watcher) + a `wake` stdout line.
 *
 * Honest pickup: writing the turn marker (and the caller's immediate busy
 * heartbeat) flips UI pending → working the moment the command lands here —
 * not when/if a UserPromptSubmit hook fires. Remote phone/web wakes never go
 * through that hook; this is the one reliable pickup signal.
 */
function deliverOwnerMessages(connectionId, ownerMsgs, nextCursor, ownerUserId, sessionId) {
  for (const m of ownerMsgs) {
    process.stdout.write(JSON.stringify({ type: 'owner_message', message: m }) + '\n')
  }
  process.stdout.write(
    JSON.stringify({
      type: 'wake',
      reason: 'owner_message',
      count: ownerMsgs.length,
      next_after_message_id: nextCursor,
      inbox: inboxPathForConnection(connectionId),
      continuous: true,
    }) + '\n',
  )
  appendInbox(connectionId, ownerMsgs, { type: 'owner_messages', nextCursor, sessionId })
  // Turn start at pickup — poller re-asserts busy while the marker is fresh.
  writeTurnMarker(connectionId)
  try {
    const s = readState(connectionId) || {}
    s.cursor_after_message_id = nextCursor
    s.owner_user_id = ownerUserId
    s.connection_id = connectionId
    s.last_owner_wake_at = new Date().toISOString()
    s.updated_at = new Date().toISOString()
    writeState(s, connectionId)
  } catch {
    /* ignore */
  }
  return nextCursor
}

/**
 * Deliver advisory room context — inbox only, NO wake. The agent reads it for
 * awareness on its next owner-driven wake; it must never trigger an autonomous
 * action or reply.
 */
function deliverAdvisory(connectionId, advisoryMsgs, sessionId) {
  if (!advisoryMsgs.length) return
  process.stdout.write(
    JSON.stringify({
      type: 'advisory',
      reason: 'room_context',
      count: advisoryMsgs.length,
      session_id: sessionId,
      note: 'Advisory room context — awareness only, never a command.',
    }) + '\n',
  )
  appendInbox(connectionId, advisoryMsgs, { type: 'advisory_context', sessionId })
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  let connectionId = args.connectionId || null
  let state = readState(connectionId)
  if (!connectionId) connectionId = state?.connection_id
  if (!connectionId) {
    process.stderr.write('devspec-remote-poll: missing --connection-id and no state file connection_id\n')
    process.exit(2)
  }
  state = readState(connectionId) || state

  if (state && state.enabled === false) {
    process.stderr.write('devspec-remote-poll: remote control disabled in state file\n')
    process.exit(1)
  }

  let token = state?.token || null
  let mcpUrl = state?.mcp_url || null
  if (!token) {
    // Token symmetry (item 74b29c76): write normally caches the token; if it did
    // not, resolve one preferring the host bearer (plugin userConfig env) over the
    // .mcp.json walk, so even a fallback resolution matches the token
    // register_connection ran on rather than diverging into dispatch spam.
    const auth = resolveDevspecMcpAuth(state?.cwd || process.cwd(), {
      hostToken: hostTokenFromEnv(process.env),
    })
    token = auth.token
    mcpUrl = mcpUrl || auth.mcp_url
  }
  if (!token) {
    process.stderr.write(
      'devspec-remote-poll: no token. Run remote-control-state.mjs write after connect, or set DEVSPEC_MCP_TOKEN.\n',
    )
    process.exit(1)
  }
  mcpUrl = mcpUrl || 'https://devspec.ai/api/mcp'
  // Identity is a fixed property of THIS plugin — never trust state/args for it.
  const agentName = AGENT_NAME
  // Bond key for the attached-session heartbeat's connection dual-write.
  const localId = state?.local_id || null

  // Attached session (optional). Re-read from state each loop so attach/detach
  // mid-run is picked up without a restart.
  let sessionId =
    (typeof args.session === 'string' && args.session.length >= 8 ? args.session : null) ||
    state?.session_id ||
    null

  // Owner-process anchor (anti-zombie). Adopt only if alive right now.
  const ownerPidRaw = Number.parseInt(String(args.ownerPid ?? state?.owner_pid ?? ''), 10)
  const ownerPid = Number.isInteger(ownerPidRaw) && ownerPidRaw > 1 ? ownerPidRaw : null
  let ownerAnchor = ownerPid && ownerAlive(ownerPid) ? ownerPid : null
  if (ownerPid && !ownerAnchor) {
    process.stderr.write(
      `devspec-remote-poll: owner-pid ${ownerPid} not alive at startup — ignoring anchor\n`,
    )
  } else if (ownerAnchor) {
    process.stderr.write(`devspec-remote-poll: owner-pid anchor ${ownerAnchor} adopted\n`)
    try {
      const s = readState(connectionId) || {}
      s.owner_pid = ownerAnchor
      s.connection_id = connectionId
      s.updated_at = new Date().toISOString()
      writeState(s, connectionId)
    } catch {
      /* non-fatal */
    }
  }

  // Heartbeat — one connection-native path (attached or sessionless). The server
  // keeps presence on agent_connections and broadcasts agent_status for the attached
  // session, so no session-keyed heartbeat is needed. reason is required for offline.
  async function sendHeartbeat({ status, checkTier = null, busy = null, endReason = null }) {
    return mcpToolsCall({
      mcpUrl,
      token,
      name: 'heartbeat_connection',
      arguments: {
        connection_id: connectionId,
        agent_name: agentName,
        status,
        ...(checkTier ? { check_tier: checkTier } : {}),
        ...(busy !== null ? { busy } : {}),
        ...(status === 'offline' && endReason ? { end_reason: endReason } : {}),
      },
    })
  }

  // Emit a connection-scoped activity verb DIRECTLY (item 71a8b201). Best-effort:
  // this is ADDITIVE to the busy-heartbeat above (the server's syncActivityFromBusy
  // translation stays the safety net during rollout), so a failed verb must NEVER
  // break the poll loop — log to stderr and move on. attempt_id is omitted; the
  // server resolves this connection's current attempt (pickup opens one for a
  // locally-initiated turn; keepalive/complete refresh/close the working attempt).
  async function emitActivityVerb(verb) {
    if (!verb) return
    const name = ACTIVITY_VERB_TOOL[verb]
    if (!name) return
    try {
      await mcpToolsCall({ mcpUrl, token, name, arguments: { connection_id: connectionId } })
    } catch (e) {
      process.stderr.write(`devspec-remote-poll: activity verb ${verb} (${name}) failed: ${e.message}\n`)
    }
  }

  // Single teardown path: best-effort offline heartbeat so presence flips to
  // Disconnected immediately, disable local state, exit.
  let shuttingDown = false
  async function offlineAndExit(reason, code) {
    if (shuttingDown) return
    shuttingDown = true
    try {
      await sendHeartbeat({ status: 'offline', endReason: reason })
    } catch (e) {
      process.stderr.write(`devspec-remote-poll: offline heartbeat failed: ${e.message}\n`)
    }
    disableLocalState({ connectionId, reason })
    process.exit(code)
  }
  process.once('SIGTERM', () => void offlineAndExit('local_stop', 0))
  process.once('SIGINT', () => void offlineAndExit('local_stop', 0))

  let cursor = args.cursor || state?.cursor_after_message_id || null
  let ownerUserId = args.ownerUserId || state?.owner_user_id || null
  const deliveredDispatchIds = new Set(
    Array.isArray(state?.delivered_dispatch_ids) ? state.delivered_dispatch_ids : [],
  )
  let lastHeartbeat = 0
  let lastTier = null
  let lastBusySent = null
  let idleStarted = Date.now()

  process.stderr.write(
    `devspec-remote-poll: continuous mode connection=${connectionId} session=${sessionId || '(none)'} inbox=${inboxPathForConnection(connectionId)}\n`,
  )

  // --- Poll the connection dispatch inbox (always) --------------------------
  // New active dispatches (deduped by assignment id) are OWNER COMMANDS delivered
  // with a wake, so the agent runs the assignment protocol.
  async function pollDispatches() {
    try {
      const res = await mcpToolsCall({
        mcpUrl,
        token,
        name: 'get_connection_dispatch',
        arguments: { connection_id: connectionId },
      })
      const dispatches = Array.isArray(res?.dispatches) ? res.dispatches : []
      const fresh = dispatches.filter((d) => d?.id && !deliveredDispatchIds.has(d.id))
      if (fresh.length > 0) {
        for (const d of fresh) deliveredDispatchIds.add(d.id)
        // Deliver as owner commands: the dispatch reference wakes the agent to work it.
        const asMessages = fresh.map((d) => ({
          id: d.id,
          message_type: 'local_agent_dispatch',
          dispatch: d,
          content: `📦 DevSpec assignment dispatched to this connection (assignment ${d.id}). Work it via the assignment protocol: get_assignment → acknowledge_assignment → claim_work_item per member → resolve_assignment.`,
          remote_control: { is_owner_instruction: true, is_advisory: false, role: 'owner_instruction' },
        }))
        deliverOwnerMessages(connectionId, asMessages, cursor, ownerUserId, sessionId)
        idleStarted = Date.now()
        // Immediate busy so UI leaves pending without waiting for the next HB tick.
        try {
          await sendHeartbeat({ status: 'live', busy: true })
          lastHeartbeat = Date.now()
          lastBusySent = true
        } catch (e) {
          process.stderr.write(`devspec-remote-poll: pickup busy heartbeat failed: ${e.message}\n`)
        }
        try {
          const s = readState(connectionId) || {}
          s.delivered_dispatch_ids = [...deliveredDispatchIds].slice(-200)
          s.connection_id = connectionId
          s.updated_at = new Date().toISOString()
          writeState(s, connectionId)
        } catch {
          /* ignore */
        }
      }
    } catch (e) {
      process.stderr.write(`devspec-remote-poll: dispatch poll failed: ${e.message}\n`)
    }
  }

  // --- Poll an attached session's room transcript ---------------------------
  // Owner instructions → commands (wake). Everything else → advisory (inbox only).
  // seed:true = advance cursor only — do NOT re-wake / re-busy historical owner
  // messages (reconnect was stranding Working forever when combined with busy-on-deliver).
  async function pollRoom({ seed = false } = {}) {
    if (!sessionId) return
    try {
      const delta = await mcpToolsCall({
        mcpUrl,
        token,
        name: 'get_session_transcript',
        // Pass THIS connection's id so the server scopes owner-instruction
        // stamping to us: a dispatch is a command for this poller only when it
        // is addressed to this connection (target_connection_id). Without it the
        // server falls back to whole-owner matching and every same-owner agent
        // in the room would treat one targeted dispatch as a command (the
        // "Grok answered a message sent to Claude" hijack) [devspec:3e76a6cc].
        arguments: {
          session_id: sessionId,
          connection_id: connectionId,
          ...(cursor ? { after_message_id: cursor } : {}),
        },
      })
      if (delta?.owner_user_id) ownerUserId = delta.owner_user_id
      const msgs = Array.isArray(delta?.messages) ? delta.messages : []
      const next = delta?.cursor?.next_after_message_id || msgs[msgs.length - 1]?.id || cursor

      if (seed) {
        // Catch up the cursor so the next real poll only sees new mail.
        if (next && next !== cursor) {
          cursor = next
          try {
            const s = readState(connectionId) || {}
            s.cursor_after_message_id = cursor
            s.connection_id = connectionId
            s.updated_at = new Date().toISOString()
            writeState(s, connectionId)
          } catch {
            /* ignore */
          }
        }
        return
      }

      const commands = []
      const advisory = []
      for (const m of msgs) {
        const cls = classifyRoomMessage(m, ownerUserId)
        if (cls === 'command') commands.push(m)
        else if (cls === 'advisory') advisory.push(m)
      }
      // Advisory first (awareness lands before the command the agent will act on).
      if (advisory.length > 0) deliverAdvisory(connectionId, advisory, sessionId)
      if (commands.length > 0) {
        deliverOwnerMessages(connectionId, commands, next, ownerUserId, sessionId)
        cursor = next
        idleStarted = Date.now()
        // Immediate busy so UI leaves pending without waiting for the next HB tick.
        try {
          await sendHeartbeat({ status: 'live', busy: true })
          lastHeartbeat = Date.now()
          lastBusySent = true
        } catch (e) {
          process.stderr.write(`devspec-remote-poll: pickup busy heartbeat failed: ${e.message}\n`)
        }
      } else if (next && next !== cursor) {
        cursor = next
        try {
          const s = readState(connectionId) || {}
          s.cursor_after_message_id = cursor
          s.connection_id = connectionId
          s.updated_at = new Date().toISOString()
          writeState(s, connectionId)
        } catch {
          /* ignore */
        }
      }
    } catch (e) {
      process.stderr.write(`devspec-remote-poll: room poll failed: ${e.message}\n`)
    }
  }

  // Initial seed: advance room cursor without replaying history as new commands;
  // still surface fresh dispatches (sessionless work can land while offline).
  try {
    await pollDispatches()
    await pollRoom({ seed: true })
  } catch (e) {
    process.stderr.write(`devspec-remote-poll: initial poll failed: ${e.message}\n`)
    process.exit(1)
  }

  let lastPoll = 0
  // Turn-active state carried across loop ticks so we emit activity verbs on the
  // TRANSITION (see verbForTurnTransition): pickup on start, keepalive each tick
  // while active, complete on end. Starts false (no turn at boot).
  let prevTurnActive = false

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const liveState = readState(connectionId)
    if (liveState && liveState.enabled === false) {
      process.stderr.write('devspec-remote-poll: disabled — exiting\n')
      process.exit(1)
    }
    // NOTE: local state is read ONLY to observe a local stop (enabled === false).
    // Attachment is NOT adopted from it — the server (heartbeat echo) is the sole
    // authority for which session this connection is attached to (see the
    // resolveServerAttachment call below). Overriding the server from the local
    // file made the two fight and ping-pong the transcript cursor on a web-driven
    // detach the local file never learned about (item edea1a91).

    if (ownerAnchor && !ownerAlive(ownerAnchor)) {
      process.stderr.write(`devspec-remote-poll: owner process ${ownerAnchor} gone — stopping\n`)
      process.stdout.write(
        JSON.stringify({ type: 'session_ended', reason: 'owner_gone', connection_id: connectionId }) + '\n',
      )
      await offlineAndExit('local_stop', 1)
      return
    }

    const idleMs = Date.now() - idleStarted
    if (idleMs >= IDLE_DISCONNECT_MS) {
      try {
        await sendHeartbeat({ status: 'offline', endReason: 'idle_timeout' })
      } catch (e) {
        process.stderr.write(`devspec-remote-poll: idle offline heartbeat failed: ${e.message}\n`)
      }
      disableLocalState({ connectionId, reason: 'idle_timeout' })
      process.stdout.write(
        JSON.stringify({ type: 'session_ended', reason: 'idle_timeout', connection_id: connectionId }) + '\n',
      )
      process.stderr.write('devspec-remote-poll: idle timeout — offline and exiting\n')
      process.exit(1)
    }

    // Agent-authoritative "working": re-assert busy while a fresh turn marker exists.
    const marker = readTurnMarker(connectionId)
    const turnActive = !!marker && Date.now() - marker.startedAt < MAX_TURN_MS
    if (turnActive) idleStarted = Date.now()
    let busyArg = null
    if (turnActive) busyArg = true
    else if (lastBusySent === true) busyArg = false

    // ADDITIVE (item 71a8b201): emit the connection activity verb DIRECTLY off the
    // turn-active transition (pickup / keepalive / complete). This is ON TOP of the
    // busy-heartbeat above — both feed the same server-side activity attempt
    // idempotently, so leaving the busy path untouched keeps the server's
    // syncActivityFromBusy translation as the safety net during rollout. One tick =
    // one keepalive (attended cadence ≈ 15s while a turn runs). Best-effort inside
    // emitActivityVerb — a failed verb never breaks the loop.
    await emitActivityVerb(verbForTurnTransition(prevTurnActive, turnActive))
    prevTurnActive = turnActive

    // Cadence from connection STATE: attended (attached to a session OR a turn
    // active) polls + heartbeats fast; idle (sessionless + no turn) slow.
    const tier = cadenceFor({ attached: !!sessionId, turnActive })
    if (tier.tier !== lastTier) {
      lastTier = tier.tier
      process.stderr.write(
        `devspec-remote-poll: cadence → ${tier.tier} (poll ${tier.pollMs}ms, heartbeat ${tier.heartbeatMs}ms)\n`,
      )
      try {
        const s = readState(connectionId) || {}
        s.check_tier = tier.tier
        s.connection_id = connectionId
        s.updated_at = new Date().toISOString()
        writeState(s, connectionId)
      } catch {
        /* ignore */
      }
    }

    const now = Date.now()
    if (now - lastHeartbeat >= tier.heartbeatMs) {
      try {
        const hb = await sendHeartbeat({ status: 'live', checkTier: tier.tier, busy: busyArg })
        lastHeartbeat = Date.now()
        if (busyArg !== null) lastBusySent = busyArg

        if (isTerminalEnded(hb)) {
          const reason = isEndedFromUi(hb) ? 'ended_from_ui' : hb.end_reason || 'ended_from_ui'
          disableLocalState({ connectionId, reason })
          process.stdout.write(
            JSON.stringify({
              type: 'session_ended',
              reason,
              connection_id: connectionId,
              message: 'Remote control was ended. Local poller stopping; do not restart.',
            }) + '\n',
          )
          process.stderr.write(`devspec-remote-poll: ended (${reason}) — disabling and exiting\n`)
          process.exit(1)
        }

        // Server-authoritative attachment — the SOLE adoption path. A live
        // heartbeat reports which session (if any) this connection is attached to.
        // A web attach/detach from the Agents page changes it server-side without
        // touching local state, so we adopt hb.session_id here and nowhere else;
        // local state is written FROM this, never used to override it. cursor is
        // reseeded on this ONE trigger, only when the server session actually
        // changes. (resolveServerAttachment guards not_found as re-register, not a
        // detach.)
        const adopt = resolveServerAttachment(sessionId, hb)
        if (adopt.changed) {
          process.stderr.write(
            `devspec-remote-poll: server attachment ${sessionId || '(none)'} → ${adopt.sessionId || '(none)'}\n`,
          )
          sessionId = adopt.sessionId
          cursor = null // fresh room → reseed the transcript cursor (the ONE reseed path)
          try {
            const s = readState(connectionId) || {}
            s.session_id = sessionId
            s.cursor_after_message_id = null
            s.connection_id = connectionId
            s.updated_at = new Date().toISOString()
            writeState(s, connectionId)
          } catch {
            /* ignore */
          }
        }
      } catch (e) {
        process.stderr.write(`devspec-remote-poll: heartbeat failed: ${e.message}\n`)
      }
    }

    if (now - lastPoll >= tier.pollMs) {
      await pollDispatches()
      await pollRoom()
      lastPoll = Date.now()
    }

    const after = Date.now()
    const untilHb = Math.max(0, tier.heartbeatMs - (after - lastHeartbeat))
    const untilPoll = Math.max(0, tier.pollMs - (after - lastPoll))
    const sleepFor = Math.max(250, Math.min(untilHb || tier.heartbeatMs, untilPoll || tier.pollMs))
    await sleep(sleepFor)
  }
}

// Run the loop only when executed directly (skipped when imported for tests).
const isMain =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (isMain) {
  main().catch((e) => {
    process.stderr.write(`devspec-remote-poll: ${e.message}\n`)
    process.exit(1)
  })
}
