#!/usr/bin/env node
/**
 * devspec-remote-wait — wake the coding agent when a new owner instruction arrives.
 *
 * Complements continuous `devspec-remote-poll.mjs` (heartbeats + inbox writer).
 * This process does **not** heartbeat. It only watches the per-session inbox
 * written by the poller and **exits 0** when a new owner_messages line appears
 * after the saved byte offset — so:
 *   - Claude Code: run_in_background → process exit wakes the model
 *   - Grok Build:  monitor tool on this process stdout → chat notification
 *
 * After the agent acts, re-arm THIS wait process only (not the poller).
 *
 * Usage:
 *   node devspec-remote-wait.mjs --session <uuid> [--from-end]
 *
 * --from-end (default): ignore existing inbox contents; only wake on *new* lines
 *   written after start. Use when the agent already processed pending mail.
 * --from-offset / state: resume from session state `inbox_byte_offset` if set.
 * --pending: also emit any unconsumed lines from the current offset (then exit 0
 *   if any; else wait for new). Useful right after connect if inbox has mail.
 *
 * Exit codes:
 *   0  — one or more new owner_messages batches printed to stdout; agent should act
 *   1  — remote disabled / session ended in state / error
 *   2  — bad args
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SESSIONS_DIR = path.join(os.homedir(), '.devspec', 'remote-control', 'sessions')
const LEGACY_STATE_PATH = path.join(os.homedir(), '.devspec', 'remote-control.json')
const POLL_MS = 500
const MAX_WAIT_MS = 24 * 60 * 60 * 1000

function parseArgs(argv) {
  const out = { fromEnd: true, pending: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--session' || a === '--session_id') out.session = argv[++i]
    else if (a === '--from-end') out.fromEnd = true
    else if (a === '--pending') {
      out.pending = true
      out.fromEnd = false
    }
    else if (a === '--poll-ms') out.pollMs = Number(argv[++i]) || POLL_MS
  }
  return out
}

function statePath(sessionId) {
  return path.join(SESSIONS_DIR, `${sessionId}.json`)
}

function inboxPath(sessionId) {
  return path.join(SESSIONS_DIR, `${sessionId}.inbox.jsonl`)
}

function readState(sessionId) {
  const paths = [statePath(sessionId), LEGACY_STATE_PATH]
  for (const p of paths) {
    try {
      if (!fs.existsSync(p)) continue
      const s = JSON.parse(fs.readFileSync(p, 'utf8'))
      if (sessionId && s.session_id && s.session_id !== sessionId && p === LEGACY_STATE_PATH) continue
      return s
    } catch {
      /* next */
    }
  }
  return null
}

function writeStatePatch(sessionId, patch) {
  try {
    const prev = readState(sessionId) || { session_id: sessionId }
    const next = {
      ...prev,
      ...patch,
      session_id: sessionId,
      updated_at: new Date().toISOString(),
    }
    fs.mkdirSync(SESSIONS_DIR, { recursive: true })
    fs.writeFileSync(statePath(sessionId), JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
    // Mirror offset into legacy only if it points at this session
    try {
      if (fs.existsSync(LEGACY_STATE_PATH)) {
        const leg = JSON.parse(fs.readFileSync(LEGACY_STATE_PATH, 'utf8'))
        if (!leg.session_id || leg.session_id === sessionId) {
          fs.writeFileSync(
            LEGACY_STATE_PATH,
            JSON.stringify({ ...leg, ...patch, session_id: sessionId, updated_at: next.updated_at }, null, 2) + '\n',
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
 * Incomplete trailing line (no final \\n) is left for the next read.
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
  const sessionId = args.session
  if (!sessionId) {
    process.stderr.write('devspec-remote-wait: missing --session\n')
    process.exit(2)
  }

  const state = readState(sessionId)
  if (state && state.enabled === false) {
    process.stderr.write('devspec-remote-wait: remote control disabled\n')
    process.exit(1)
  }

  const file = inboxPath(sessionId)
  fs.mkdirSync(SESSIONS_DIR, { recursive: true })
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, '', { mode: 0o600 })
  }

  let offset = 0
  if (args.pending && typeof state?.inbox_byte_offset === 'number') {
    offset = state.inbox_byte_offset
  } else if (args.fromEnd) {
    offset = fileSize(file)
    writeStatePatch(sessionId, { inbox_byte_offset: offset })
  } else if (typeof state?.inbox_byte_offset === 'number') {
    offset = state.inbox_byte_offset
  } else {
    offset = fileSize(file)
  }

  const pollMs = args.pollMs || POLL_MS
  const started = Date.now()
  process.stderr.write(
    `devspec-remote-wait: watching ${file} offset=${offset} session=${sessionId}\n`,
  )

  while (Date.now() - started < MAX_WAIT_MS) {
    const live = readState(sessionId)
    if (live && live.enabled === false) {
      process.stderr.write('devspec-remote-wait: disabled — exit 1\n')
      process.exit(1)
    }
    if (live?.end_reason === 'ui' || live?.ended_from_ui) {
      process.stdout.write(
        JSON.stringify({ type: 'session_ended', reason: 'ended_from_ui', session_id: sessionId }) + '\n',
      )
      process.exit(1)
    }

    const { lines, newOffset } = readNewLines(file, offset)
    if (lines.length > 0) {
      const batches = parseOwnerBatches(lines)
      offset = newOffset
      writeStatePatch(sessionId, { inbox_byte_offset: offset })

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
