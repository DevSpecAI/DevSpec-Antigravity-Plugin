#!/usr/bin/env node
/**
 * devspec-remote-wait — wake the coding agent when a new OWNER COMMAND arrives
 * (CONNECTION-NATIVE, item fd51d80b).
 *
 * Complements continuous `devspec-remote-poll.mjs` (heartbeats + inbox writer).
 * This process does **not** heartbeat. It watches the per-connection inbox written
 * by the poller and **exits 0** when a new `owner_messages` line appears after the
 * saved byte offset — so:
 *   - Claude Code: run_in_background → process exit wakes the model
 *   - Grok Build:  monitor tool on this process stdout → chat notification
 *
 * It wakes ONLY on `owner_messages` (server-stamped owner commands / dispatches).
 * `advisory_context` inbox entries (teammate / Dev / other-agent room context) are
 * DELIBERATELY ignored here — advisory must never force a model wake or an
 * autonomous response; the agent reads accumulated advisory when it next acts.
 *
 * After the agent acts, re-arm THIS wait process only (not the poller).
 *
 * Usage:
 *   node devspec-remote-wait.mjs --connection-id <uuid> [--from-end] [--owner-pid <pid>]
 *
 * Exit codes:
 *   0  — one or more new owner_messages batches printed to stdout; agent should act
 *   1  — remote disabled / connection ended in state / owner gone / error
 *   2  — bad args
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const CONNECTIONS_DIR = path.join(os.homedir(), '.devspec', 'remote-control', 'connections')
const LEGACY_STATE_PATH = path.join(os.homedir(), '.devspec', 'remote-control.json')
const POLL_MS = 500
const MAX_WAIT_MS = 24 * 60 * 60 * 1000

/**
 * Idle = wait is armed (agent not mid-turn). Clear the connection turn marker so
 * the continuous poller stops re-asserting busy. Without this, Grok (no Stop
 * hook) and reconnect seeds leave a phantom "working" forever.
 */
function clearTurnMarker(connectionId) {
  if (!connectionId) return
  try {
    fs.rmSync(path.join(CONNECTIONS_DIR, `${connectionId}.turn`), { force: true })
  } catch {
    /* ignore */
  }
}

function parseArgs(argv) {
  const out = { fromEnd: true, pending: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--connection-id' || a === '--connection_id' || a === '--connection') {
      out.connectionId = argv[++i]
    } else if (a === '--from-end') out.fromEnd = true
    else if (a === '--pending') {
      out.pending = true
      out.fromEnd = false
    } else if (a === '--poll-ms') out.pollMs = Number(argv[++i]) || POLL_MS
    else if (a === '--owner-pid') out.ownerPid = argv[++i]
  }
  return out
}

/** Owner (agent) process liveness — see devspec-remote-poll.mjs. EPERM = alive. */
function ownerAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return !!e && e.code === 'EPERM'
  }
}

function statePath(connectionId) {
  return path.join(CONNECTIONS_DIR, `${connectionId}.json`)
}

function inboxPath(connectionId) {
  return path.join(CONNECTIONS_DIR, `${connectionId}.inbox.jsonl`)
}

function readState(connectionId) {
  const paths = [statePath(connectionId), LEGACY_STATE_PATH]
  for (const p of paths) {
    try {
      if (!fs.existsSync(p)) continue
      const s = JSON.parse(fs.readFileSync(p, 'utf8'))
      if (connectionId && s.connection_id && s.connection_id !== connectionId && p === LEGACY_STATE_PATH)
        continue
      return s
    } catch {
      /* next */
    }
  }
  return null
}

function writeStatePatch(connectionId, patch) {
  try {
    const prev = readState(connectionId) || { connection_id: connectionId }
    const next = {
      ...prev,
      ...patch,
      connection_id: connectionId,
      updated_at: new Date().toISOString(),
    }
    fs.mkdirSync(CONNECTIONS_DIR, { recursive: true })
    fs.writeFileSync(statePath(connectionId), JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
    // Mirror offset into legacy only if it points at this connection.
    try {
      if (fs.existsSync(LEGACY_STATE_PATH)) {
        const leg = JSON.parse(fs.readFileSync(LEGACY_STATE_PATH, 'utf8'))
        if (!leg.connection_id || leg.connection_id === connectionId) {
          fs.writeFileSync(
            LEGACY_STATE_PATH,
            JSON.stringify(
              { ...leg, ...patch, connection_id: connectionId, updated_at: next.updated_at },
              null,
              2,
            ) + '\n',
            { mode: 0o600 },
          )
        }
      }
    } catch {
      /* ignore legacy */
    }
  } catch (e) {
    process.stderr.write(`devspec-remote-wait: state write failed: ${e.message}\n`)
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function fileSize(p) {
  try {
    return fs.statSync(p).size
  } catch {
    return 0
  }
}

/**
 * Read new bytes from offset; return { lines, newOffset }.
 * Incomplete trailing line (no final \n) is left for the next read.
 */
function readNewLines(file, offset) {
  const size = fileSize(file)
  if (size <= offset) return { lines: [], newOffset: offset }
  const fd = fs.openSync(file, 'r')
  try {
    const len = size - offset
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, offset)
    const text = buf.toString('utf8')
    const lastNl = text.lastIndexOf('\n')
    if (lastNl === -1) return { lines: [], newOffset: offset }
    const completeText = text.slice(0, lastNl + 1)
    const lines = completeText.split('\n').filter((l) => l.trim().length > 0)
    const newOffset = offset + Buffer.byteLength(completeText, 'utf8')
    return { lines, newOffset }
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Owner-command batches ONLY. `advisory_context` entries are intentionally excluded
 * so room awareness never wakes the model or triggers an autonomous response.
 */
function parseOwnerBatches(lines) {
  const batches = []
  for (const line of lines) {
    try {
      const obj = JSON.parse(line)
      if (obj?.type === 'owner_messages' && Array.isArray(obj.messages) && obj.messages.length > 0) {
        batches.push(obj)
      }
    } catch {
      /* skip garbage */
    }
  }
  return batches
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const connectionId = args.connectionId
  if (!connectionId) {
    process.stderr.write('devspec-remote-wait: missing --connection-id\n')
    process.exit(2)
  }

  const state = readState(connectionId)
  if (state && state.enabled === false) {
    process.stderr.write('devspec-remote-wait: remote control disabled\n')
    process.exit(1)
  }

  const ownerPidRaw = Number.parseInt(String(args.ownerPid ?? state?.owner_pid ?? ''), 10)
  const ownerPid = Number.isInteger(ownerPidRaw) && ownerPidRaw > 1 ? ownerPidRaw : null
  const ownerAnchor = ownerPid && ownerAlive(ownerPid) ? ownerPid : null

  const file = inboxPath(connectionId)
  fs.mkdirSync(CONNECTIONS_DIR, { recursive: true })
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, '', { mode: 0o600 })
  }

  let offset = 0
  if (args.pending && typeof state?.inbox_byte_offset === 'number') {
    offset = state.inbox_byte_offset
  } else if (args.fromEnd) {
    offset = fileSize(file)
    writeStatePatch(connectionId, { inbox_byte_offset: offset })
  } else if (typeof state?.inbox_byte_offset === 'number') {
    offset = state.inbox_byte_offset
  } else {
    offset = fileSize(file)
  }

  // Agent is idle while waiting — end any leftover working phase from a prior
  // turn or from a reconnect seed that re-delivered history with busy:true.
  clearTurnMarker(connectionId)

  const pollMs = args.pollMs || POLL_MS
  const started = Date.now()
  process.stderr.write(
    `devspec-remote-wait: watching ${file} offset=${offset} connection=${connectionId}\n`,
  )

  while (Date.now() - started < MAX_WAIT_MS) {
    const live = readState(connectionId)
    if (live && live.enabled === false) {
      process.stderr.write('devspec-remote-wait: disabled — exit 1\n')
      process.exit(1)
    }
    if (ownerAnchor && !ownerAlive(ownerAnchor)) {
      process.stdout.write(
        JSON.stringify({ type: 'session_ended', reason: 'owner_gone', connection_id: connectionId }) + '\n',
      )
      process.stderr.write(`devspec-remote-wait: owner process ${ownerAnchor} gone — exit 1\n`)
      process.exit(1)
    }
    if (live?.end_reason === 'ui' || live?.ended_from_ui) {
      process.stdout.write(
        JSON.stringify({ type: 'session_ended', reason: 'ended_from_ui', connection_id: connectionId }) + '\n',
      )
      process.exit(1)
    }

    const { lines, newOffset } = readNewLines(file, offset)
    if (lines.length > 0) {
      const batches = parseOwnerBatches(lines)
      offset = newOffset
      writeStatePatch(connectionId, { inbox_byte_offset: offset })

      if (batches.length > 0) {
        for (const batch of batches) {
          for (const m of batch.messages) {
            process.stdout.write(JSON.stringify({ type: 'owner_message', message: m }) + '\n')
          }
          process.stdout.write(
            JSON.stringify({
              type: 'wake',
              reason: 'owner_message',
              count: batch.messages.length,
              next_after_message_id: batch.next_after_message_id ?? null,
              inbox: file,
              continuous_poller: true,
              rearm: 'devspec-remote-wait',
            }) + '\n',
          )
        }
        process.stderr.write(
          `devspec-remote-wait: wake (${batches.reduce((n, b) => n + b.messages.length, 0)} msg) — exit 0\n`,
        )
        process.exit(0)
      }
    }

    await sleep(pollMs)
  }

  process.stderr.write('devspec-remote-wait: max wait elapsed — exit 1\n')
  process.exit(1)
}

main().catch((e) => {
  process.stderr.write(`devspec-remote-wait: ${e.message}\n`)
  process.exit(1)
})
