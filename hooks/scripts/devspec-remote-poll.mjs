#!/usr/bin/env node
/**
 * devspec-remote-poll — long-lived background poller for DevSpec remote control.
 *
 * Runs outside the model context (plain Node HTTP MCP — **no LLM tokens**).
 * Heartbeats the session for the whole connection lifetime and polls the
 * transcript for owner instructions.
 *
 * Owner instructions do **NOT** terminate this process. They are:
 *   1. Appended to ~/.devspec/remote-control/sessions/<id>.inbox.jsonl
 *   2. Printed as JSON lines on stdout (type: owner_message / wake)
 *   3. Cursor advanced in session state
 * Heartbeats continue so the Agents UI stays Live while the agent works.
 *
 * Exit only for terminal conditions:
 *   1  — disabled / UI end / idle_timeout / auth failure / error
 *   2  — bad args
 * (Exit 0 is reserved for clean manual stop if needed; owner messages never use it.)
 *
 * Stepped backoff (idle without owner message):
 *   0–10 min:   transcript ~15s, heartbeat ~15s, check_tier=responsive
 *   10 min–1 h: transcript ~30s, heartbeat ~30s, check_tier=normal
 *   1–2 h:      transcript ~60s, heartbeat ~60s, check_tier=normal
 *   2–12 h:     transcript ~5 min, heartbeat ~60s, check_tier=relaxed
 *   12–24 h:    transcript ~10 min, heartbeat ~60s, check_tier=sparse
 *   24–72 h:    transcript ~60 min, heartbeat ~60 min, check_tier=dormant
 *   >72 h idle: clean disconnect (offline + idle_timeout), exit 1
 *
 * Heartbeat and transcript poll are **independent**: the loop sleeps until the
 * next of (heartbeat due, poll due). Never sleep the full poll interval alone —
 * that made relaxed/sparse heartbeats only fire every 5–10 min and the UI
 * (90s default freshness) flipped to Disconnected while still connected.
 *
 * Usage:
 *   node devspec-remote-poll.mjs --session <uuid> [--cursor <id>]
 *
 * Start detached so tool shells cannot kill the process:
 *   nohup node …/devspec-remote-poll.mjs --session <uuid> >> ~/.devspec/remote-control/sessions/<uuid>.poll.log 2>&1 &
 *
 * Requires token in per-session state / ~/.devspec/remote-control.json or DEVSPEC_MCP_TOKEN.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mcpToolsCall } from './mcp-call.mjs'
import { resolveDevspecMcpAuth } from './resolve-mcp-auth.mjs'
import { AGENT_NAME } from './agent-identity.mjs'

const LEGACY_STATE_PATH = path.join(os.homedir(), '.devspec', 'remote-control.json')
const SESSIONS_DIR = path.join(os.homedir(), '.devspec', 'remote-control', 'sessions')

function statePathForSession(sessionId) {
  if (sessionId) {
    const per = path.join(SESSIONS_DIR, `${sessionId}.json`)
    if (fs.existsSync(per)) return per
  }
  return LEGACY_STATE_PATH
}

function inboxPathForSession(sessionId) {
  return path.join(SESSIONS_DIR, `${sessionId}.inbox.jsonl`)
}

function pollLogPathForSession(sessionId) {
  return path.join(SESSIONS_DIR, `${sessionId}.poll.log`)
}

/** @type {Array<{ untilMs: number, pollMs: number, heartbeatMs: number, tier: string }>} */
const BACKOFF_TIERS = [
  { untilMs: 10 * 60 * 1000, pollMs: 15_000, heartbeatMs: 15_000, tier: 'responsive' },
  { untilMs: 60 * 60 * 1000, pollMs: 30_000, heartbeatMs: 30_000, tier: 'normal' },
  { untilMs: 2 * 60 * 60 * 1000, pollMs: 60_000, heartbeatMs: 60_000, tier: 'normal' },
  { untilMs: 12 * 60 * 60 * 1000, pollMs: 5 * 60_000, heartbeatMs: 60_000, tier: 'relaxed' },
  { untilMs: 24 * 60 * 60 * 1000, pollMs: 10 * 60_000, heartbeatMs: 60_000, tier: 'sparse' },
  // Dormant: 24–72h idle. Back off to ~hourly checks so a very quiet connection
  // stays reachable up to the 72h lifetime cap without churn. Server freshness
  // for 'dormant' is 90 min, which covers the hourly heartbeat + grace.
  { untilMs: 72 * 60 * 60 * 1000, pollMs: 60 * 60_000, heartbeatMs: 60 * 60_000, tier: 'dormant' },
]
const IDLE_DISCONNECT_MS = 72 * 60 * 60 * 1000

// A turn's busy assertion is re-asserted on heartbeats while a turn marker
// (written by mirror-turn on turn start, removed on stop) is present and younger
// than this cap. The cap bounds a stranded "working" to at most this long if the
// agent is killed mid-turn (Stop never fires) while this poller survives: after
// the cap we stop re-asserting and the server's busy freshness decays it to idle.
const MAX_TURN_MS = 60 * 60 * 1000

function turnMarkerPath(sessionId) {
  return path.join(SESSIONS_DIR, `${sessionId}.turn`)
}
function readTurnMarker(sessionId) {
  try {
    const p = turnMarkerPath(sessionId)
    if (!fs.existsSync(p)) return null
    const m = JSON.parse(fs.readFileSync(p, 'utf8'))
    return typeof m?.startedAt === 'number' ? m : null
  } catch {
    return null
  }
}

/**
 * Owner (agent) process liveness. The poller is launched with --owner-pid = the
 * DURABLE agent process (e.g. the `claude` session process — a Bash-tool subshell's
 * PPID is that process). When the agent dies (terminal close, crash, SIGKILL,
 * /clear — every mode, including the ones SessionEnd never fires for) the poller
 * must stop heartbeating, or the Agents page shows a zombie "Live" agent for up to
 * 72h. EPERM means the pid exists but is not ours → still alive.
 */
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
    if (a === '--session' || a === '--session_id') out.session = argv[++i]
    else if (a === '--cursor') out.cursor = argv[++i]
    else if (a === '--owner-user-id') out.ownerUserId = argv[++i]
    else if (a === '--owner-pid') out.ownerPid = argv[++i]
    else if (a === '--interval-ms' || a === '--heartbeat-ms' || a === '--max-ms') i++
  }
  return out
}

/** Prefer per-session state so concurrent remotes do not clobber each other. */
function readState(sessionId) {
  const tryPaths = []
  if (sessionId) tryPaths.push(path.join(SESSIONS_DIR, `${sessionId}.json`))
  tryPaths.push(LEGACY_STATE_PATH)
  for (const p of tryPaths) {
    try {
      if (!fs.existsSync(p)) continue
      const s = JSON.parse(fs.readFileSync(p, 'utf8'))
      if (sessionId && s.session_id && s.session_id !== sessionId && p === LEGACY_STATE_PATH) {
        continue
      }
      return s
    } catch {
      /* try next */
    }
  }
  return null
}

function writeState(state, sessionId) {
  const sid = sessionId || state.session_id
  const paths = []
  if (sid) paths.push(path.join(SESSIONS_DIR, `${sid}.json`))
  try {
    const legacy = fs.existsSync(LEGACY_STATE_PATH)
      ? JSON.parse(fs.readFileSync(LEGACY_STATE_PATH, 'utf8'))
      : null
    if (!legacy || !legacy.session_id || legacy.session_id === sid) {
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
 * Append owner instructions for the coding agent to consume without killing this process.
 * Agents may also read stdout when attached; inbox survives detached nohup.
 */
function appendInbox(sessionId, ownerMsgs, meta = {}) {
  if (!sessionId || !ownerMsgs?.length) return
  try {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true })
    const line = JSON.stringify({
      type: 'owner_messages',
      session_id: sessionId,
      received_at: new Date().toISOString(),
      count: ownerMsgs.length,
      next_after_message_id: meta.next_after_message_id ?? null,
      messages: ownerMsgs,
    })
    fs.appendFileSync(inboxPathForSession(sessionId), line + '\n', { mode: 0o600 })
  } catch (e) {
    process.stderr.write(`devspec-remote-poll: inbox write failed: ${e.message}\n`)
  }
}

/** Disable THIS session only — never other remotes on the machine. */
function disableLocalState({ sessionId, reason }) {
  try {
    const prev = readState(sessionId) || {}
    writeState(
      {
        ...prev,
        enabled: false,
        session_id: sessionId || prev.session_id,
        ended_from_ui: reason === 'ended_from_ui',
        end_reason: reason,
        updated_at: new Date().toISOString(),
      },
      sessionId,
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
  if (hb.live === false && hb.end_reason && hb.end_reason !== null) {
    return true
  }
  return false
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function tierForIdleMs(idleMs) {
  for (const t of BACKOFF_TIERS) {
    if (idleMs < t.untilMs) return t
  }
  return null
}

function isOwnerMessage(msg, ownerUserId) {
  if (!msg) return false
  // PRIMARY GATE: the server-stamped remote_control flag, computed PER-TOKEN against
  // the caller's connected identity (is_owner_instruction === is_controller_instruction).
  // It already means "authored by the user whose token runs THIS agent" — NOT session
  // ownership — so trust it directly.
  if (msg.remote_control && typeof msg.remote_control.is_owner_instruction === 'boolean') {
    return msg.remote_control.is_owner_instruction === true
  }
  // DEGRADED FALLBACK for untagged rows only (server didn't stamp the flag): accept an
  // explicit local_agent_dispatch whose human author matches this connection's user
  // (ownerUserId = the token running this agent). Command authority is per-token —
  // never inferred from session ownership.
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
 * Deliver owner messages without exiting — heartbeats keep running.
 * @returns {string|null} next cursor id
 */
function deliverOwnerMessages(sessionId, ownerMsgs, nextCursor, ownerUserId) {
  for (const m of ownerMsgs) {
    process.stdout.write(JSON.stringify({ type: 'owner_message', message: m }) + '\n')
  }
  process.stdout.write(
    JSON.stringify({
      type: 'wake',
      reason: 'owner_message',
      count: ownerMsgs.length,
      next_after_message_id: nextCursor,
      // Hint for skills: process stays up; read inbox if stdout was discarded (nohup).
      inbox: inboxPathForSession(sessionId),
      continuous: true,
    }) + '\n',
  )
  appendInbox(sessionId, ownerMsgs, { next_after_message_id: nextCursor })
  try {
    const s = readState(sessionId) || {}
    s.cursor_after_message_id = nextCursor
    s.owner_user_id = ownerUserId
    s.session_id = sessionId
    s.last_owner_wake_at = new Date().toISOString()
    s.updated_at = new Date().toISOString()
    writeState(s, sessionId)
  } catch {
    /* ignore */
  }
  return nextCursor
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  let sessionId = args.session || null
  let state = readState(sessionId)
  if (!sessionId) sessionId = state?.session_id
  if (!sessionId) {
    process.stderr.write('devspec-remote-poll: missing --session and no state file session_id\n')
    process.exit(2)
  }
  state = readState(sessionId) || state

  if (state && state.enabled === false) {
    process.stderr.write('devspec-remote-poll: remote control disabled in state file\n')
    process.exit(1)
  }

  let token = state?.token || null
  let mcpUrl = state?.mcp_url || null
  if (!token) {
    const auth = resolveDevspecMcpAuth(state?.cwd || process.cwd())
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

  // Owner-process anchor. Adopt --owner-pid (or a value persisted in state) ONLY if
  // it is alive right now: a pid already gone at startup was mis-captured (e.g. a
  // transient launch shell), so ignore it and fall back to the reaper + idle
  // timeout rather than exiting immediately. Once adopted, the loop exits the moment
  // the owner disappears — this is the primary defence against zombie "Live" agents.
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
      const s = readState(sessionId) || {}
      s.owner_pid = ownerAnchor
      s.session_id = sessionId
      s.updated_at = new Date().toISOString()
      writeState(s, sessionId)
    } catch {
      /* non-fatal */
    }
  }

  // Single teardown path: best-effort offline heartbeat so the Agents page flips to
  // Disconnected immediately (not after the ~90s freshness window), disable local
  // state so nothing restarts this session, then exit. Used by owner-death, SIGTERM
  // (the reaper) and SIGINT.
  let shuttingDown = false
  async function offlineAndExit(reason, code) {
    if (shuttingDown) return
    shuttingDown = true
    try {
      await mcpToolsCall({
        mcpUrl,
        token,
        name: 'report_remote_agent_heartbeat',
        arguments: { session_id: sessionId, agent_name: agentName, status: 'offline', end_reason: reason },
      })
    } catch (e) {
      process.stderr.write(`devspec-remote-poll: offline heartbeat failed: ${e.message}\n`)
    }
    disableLocalState({ sessionId, reason })
    process.exit(code)
  }
  process.once('SIGTERM', () => void offlineAndExit('local_stop', 0))
  process.once('SIGINT', () => void offlineAndExit('local_stop', 0))

  let cursor = args.cursor || state?.cursor_after_message_id || null
  let ownerUserId = args.ownerUserId || state?.owner_user_id || null
  let lastHeartbeat = 0
  let lastTier = null
  // Tracks the last busy value we sent so we clear "working" exactly once when a
  // turn ends (marker gone) rather than spamming busy:false on every idle beat.
  let lastBusySent = null
  // Idle clock resets when we deliver owner messages (connection still active).
  let idleStarted = Date.now()

  process.stderr.write(
    `devspec-remote-poll: continuous mode session=${sessionId} inbox=${inboxPathForSession(sessionId)}\n`,
  )

  // Initial transcript to seed cursor + owner id; deliver any pending owner msgs without exiting.
  try {
    const initial = await mcpToolsCall({
      mcpUrl,
      token,
      name: 'get_session_transcript',
      arguments: {
        session_id: sessionId,
        ...(cursor ? { after_message_id: cursor } : {}),
      },
    })
    if (initial?.owner_user_id) ownerUserId = initial.owner_user_id
    if (initial?.cursor?.next_after_message_id) {
      if (!cursor) cursor = initial.cursor.next_after_message_id
    }
    const msgs = Array.isArray(initial?.messages) ? initial.messages : []
    const ownerMsgs = msgs.filter((m) => isOwnerMessage(m, ownerUserId))
    if (ownerMsgs.length > 0) {
      const next =
        initial?.cursor?.next_after_message_id ||
        ownerMsgs[ownerMsgs.length - 1]?.id ||
        cursor
      deliverOwnerMessages(sessionId, ownerMsgs, next, ownerUserId)
      cursor = next
      idleStarted = Date.now()
    }
  } catch (e) {
    process.stderr.write(`devspec-remote-poll: initial transcript failed: ${e.message}\n`)
    process.exit(1)
  }

  // Heartbeat and transcript poll are independent timers. Sleep until the
  // sooner of "next heartbeat" / "next poll" so long transcript backoff never
  // starves presence updates.
  let lastPoll = 0

  // Long-running loop — never exit solely because an owner instruction arrived.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const liveState = readState(sessionId)
    if (liveState && liveState.enabled === false) {
      process.stderr.write('devspec-remote-poll: disabled — exiting\n')
      process.exit(1)
    }

    // Owner gone (terminal closed / crashed / SIGKILLed) → stop being a zombie.
    if (ownerAnchor && !ownerAlive(ownerAnchor)) {
      process.stderr.write(`devspec-remote-poll: owner process ${ownerAnchor} gone — stopping\n`)
      process.stdout.write(
        JSON.stringify({ type: 'session_ended', reason: 'owner_gone', session_id: sessionId }) + '\n',
      )
      await offlineAndExit('local_stop', 1)
      return
    }

    const idleMs = Date.now() - idleStarted
    if (idleMs >= IDLE_DISCONNECT_MS) {
      try {
        await mcpToolsCall({
          mcpUrl,
          token,
          name: 'report_remote_agent_heartbeat',
          arguments: {
            session_id: sessionId,
            agent_name: agentName,
            status: 'offline',
            end_reason: 'idle_timeout',
          },
        })
      } catch (e) {
        process.stderr.write(`devspec-remote-poll: idle offline heartbeat failed: ${e.message}\n`)
      }
      disableLocalState({ sessionId, reason: 'idle_timeout' })
      process.stdout.write(
        JSON.stringify({
          type: 'session_ended',
          reason: 'idle_timeout',
          session_id: sessionId,
        }) + '\n',
      )
      process.stderr.write('devspec-remote-poll: idle timeout — offline and exiting\n')
      process.exit(1)
    }

    const tier = tierForIdleMs(idleMs)
    if (!tier) {
      process.stderr.write('devspec-remote-poll: no backoff tier — exiting\n')
      process.exit(1)
    }
    if (tier.tier !== lastTier) {
      lastTier = tier.tier
      process.stderr.write(
        `devspec-remote-poll: check tier → ${tier.tier} (poll ${tier.pollMs}ms, heartbeat ${tier.heartbeatMs}ms)\n`,
      )
      try {
        const s = readState(sessionId) || {}
        s.check_tier = tier.tier
        s.session_id = sessionId
        s.updated_at = new Date().toISOString()
        writeState(s, sessionId)
      } catch {
        /* ignore */
      }
    }

    // Agent-authoritative "working": re-assert busy while a fresh turn marker is
    // present (mirror-turn writes it on turn start, removes it on stop). This
    // refreshes the server's busy freshness so long turns stay "working"; when
    // the turn ends we send busy:false exactly once. An active turn also keeps
    // the poller responsive so the re-assert cadence stays tight.
    const marker = readTurnMarker(sessionId)
    const turnActive = !!marker && Date.now() - marker.startedAt < MAX_TURN_MS
    if (turnActive) idleStarted = Date.now()
    let busyArg = null
    if (turnActive) busyArg = true
    else if (lastBusySent === true) busyArg = false

    const now = Date.now()
    if (now - lastHeartbeat >= tier.heartbeatMs) {
      try {
        const hb = await mcpToolsCall({
          mcpUrl,
          token,
          name: 'report_remote_agent_heartbeat',
          arguments: {
            session_id: sessionId,
            agent_name: agentName,
            status: 'live',
            check_tier: tier.tier,
            ...(busyArg !== null ? { busy: busyArg } : {}),
          },
        })
        lastHeartbeat = Date.now()
        if (busyArg !== null) lastBusySent = busyArg

        if (isTerminalEnded(hb)) {
          const reason = isEndedFromUi(hb) ? 'ended_from_ui' : hb.end_reason || 'ended_from_ui'
          disableLocalState({ sessionId, reason })
          process.stdout.write(
            JSON.stringify({
              type: 'session_ended',
              reason,
              session_id: sessionId,
              message:
                'Remote control was ended. Local poller stopping; do not restart this session.',
            }) + '\n',
          )
          process.stderr.write(
            `devspec-remote-poll: session ended (${reason}) — disabling and exiting\n`,
          )
          process.exit(1)
        }
      } catch (e) {
        process.stderr.write(`devspec-remote-poll: heartbeat failed: ${e.message}\n`)
      }
    }

    if (now - lastPoll >= tier.pollMs) {
      try {
        const delta = await mcpToolsCall({
          mcpUrl,
          token,
          name: 'get_session_transcript',
          arguments: {
            session_id: sessionId,
            ...(cursor ? { after_message_id: cursor } : {}),
          },
        })
        lastPoll = Date.now()
        if (delta?.owner_user_id) ownerUserId = delta.owner_user_id
        const msgs = Array.isArray(delta?.messages) ? delta.messages : []
        const ownerMsgs = msgs.filter((m) => isOwnerMessage(m, ownerUserId))
        if (ownerMsgs.length > 0) {
          const next =
            delta?.cursor?.next_after_message_id ||
            ownerMsgs[ownerMsgs.length - 1]?.id ||
            cursor
          deliverOwnerMessages(sessionId, ownerMsgs, next, ownerUserId)
          cursor = next
          idleStarted = Date.now()
          // Continue loop — do NOT process.exit(0). Heartbeats keep the UI live.
        } else if (delta?.cursor?.next_after_message_id) {
          cursor = delta.cursor.next_after_message_id
          try {
            const s = readState(sessionId) || {}
            s.cursor_after_message_id = cursor
            s.session_id = sessionId
            s.updated_at = new Date().toISOString()
            writeState(s, sessionId)
          } catch {
            /* ignore */
          }
        }
      } catch (e) {
        process.stderr.write(`devspec-remote-poll: poll failed: ${e.message}\n`)
        lastPoll = Date.now()
      }
    }

    const after = Date.now()
    const untilHb = Math.max(0, tier.heartbeatMs - (after - lastHeartbeat))
    const untilPoll = Math.max(0, tier.pollMs - (after - lastPoll))
    // Wake for the sooner of heartbeat or transcript poll (floor 250ms).
    const sleepFor = Math.max(250, Math.min(untilHb || tier.heartbeatMs, untilPoll || tier.pollMs))
    await sleep(sleepFor)
  }
}

main().catch((e) => {
  process.stderr.write(`devspec-remote-poll: ${e.message}\n`)
  process.exit(1)
})
