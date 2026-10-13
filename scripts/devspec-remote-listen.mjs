#!/usr/bin/env node
/**
 * Antigravity DevSpec Remote Listener & Sidecar (`devspec-remote-listen.mjs`).
 *
 * Used by `sidecars/devspec-remote/sidecar.json` or as a background listener task:
 * 1. Resolves (or auto-connects when enabled) the active Antigravity DevSpec connection.
 * 2. Ensures `devspec-remote-poll.mjs` is running for that connection.
 * 3. Watches the connection's JSONL inbox (`~/.devspec/remote-inbox-<connectionId>.jsonl`)
 *    for newly delivered `owner_messages` wakes.
 * 4. Emits structured wake events on stdout AND (when `conversationId` is known and
 *    `agentapi` is available) invokes `agentapi send-message <conversationId> <message>`
 *    to wake an idle Antigravity conversation immediately.
 */

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadState } from './mirror-turn.mjs'
import {
  ensurePollerForConnection,
  readStateFile,
  resolveOwnerPid,
} from './remote-control-state.mjs'
import { autoConnectAtStartup, connectAtStartupEnabled } from './session-start.mjs'

function inboxPathForConnection(connectionId) {
  return path.join(os.homedir(), '.devspec', 'remote-control', 'connections', `${connectionId}.inbox.jsonl`)
}

export function parseListenArgs(argv = []) {
  const out = {
    connectionId: null,
    conversationId: null,
    cwd: null,
    once: false,
    useAgentApi: true,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--connection-id') out.connectionId = argv[++i] || null
    else if (a === '--conversation-id' || a === '--local-id') out.conversationId = argv[++i] || null
    else if (a === '--cwd') out.cwd = argv[++i] || null
    else if (a === '--once') out.once = true
    else if (a === '--no-agentapi') out.useAgentApi = false
  }
  return out
}

/**
 * Format an `owner_messages` inbox entry into a human/agent readable wake prompt
 * suitable for `agentapi send-message <conversationId> <message>`.
 */
export function buildWakeDeliveryMessage(entry) {
  if (!entry || entry.type !== 'owner_messages') return null
  const msgs = Array.isArray(entry.messages) ? entry.messages : []
  if (msgs.length === 0) return null

  const lines = ['[DevSpec Remote Wake]']
  if (entry.session_id) {
    lines.push(`Session: ${entry.session_id}`)
  }
  for (const m of msgs) {
    const sender =
      m?.author?.display_name ||
      m?.requester?.display_name ||
      m?.author_name ||
      (m?.message_type === 'automation_run' ? 'Automation Dispatch' : 'Owner')
    const content = typeof m?.content === 'string' ? m.content.trim() : ''
    if (content) {
      lines.push(`${sender}: ${content}`)
    }
  }
  return lines.join('\n\n')
}

/**
 * Deliver a wake message to an Antigravity conversation via `agentapi send-message`.
 * Best-effort: resolves `{ ok: true }` on success or `{ ok: false, error }` when
 * `agentapi` is absent or returns non-zero.
 */
export function deliverWakeViaAgentApi({
  conversationId,
  message,
  execFileImpl = execFile,
  timeoutMs = 5_000,
} = {}) {
  if (!conversationId || !message) {
    return Promise.resolve({ ok: false, error: 'missing_conversation_or_message' })
  }
  return new Promise((resolve) => {
    try {
      execFileImpl(
        'agentapi',
        ['send-message', String(conversationId), String(message)],
        { timeout: timeoutMs },
        (err, stdout, stderr) => {
          if (err) {
            resolve({
              ok: false,
              error: (stderr || err.message || 'agentapi_failed').toString().trim(),
            })
            return
          }
          resolve({ ok: true, stdout: (stdout || '').toString().trim() })
        },
      )
    } catch (err) {
      resolve({ ok: false, error: err?.message || 'agentapi_spawn_failed' })
    }
  })
}

/**
 * Read newly appended JSONL entries from `inboxPath` starting at `offsetBytes`.
 */
export function readNewInboxEntries(inboxPath, offsetBytes = 0) {
  if (!inboxPath || !fs.existsSync(inboxPath)) {
    return { entries: [], nextOffset: 0 }
  }
  try {
    const buf = fs.readFileSync(inboxPath)
    const start = offsetBytes > 0 && offsetBytes <= buf.length ? offsetBytes : 0
    const slice = buf.subarray(start).toString('utf8')
    const entries = []
    for (const line of slice.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        entries.push(JSON.parse(trimmed))
      } catch {
        /* ignore malformed line */
      }
    }
    return { entries, nextOffset: buf.length }
  } catch {
    return { entries: [], nextOffset: offsetBytes }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function main() {
  const args = parseListenArgs(process.argv.slice(2))
  const cwd = args.cwd || process.env.ANTIGRAVITY_WORKSPACE_DIR || process.cwd()
  let conversationId =
    args.conversationId ||
    process.env.ANTIGRAVITY_CONVERSATION_ID ||
    process.env.AGY_CONVERSATION_ID ||
    null

  let state = args.connectionId
    ? readStateFile(args.connectionId)
    : loadState(conversationId)

  if (!state?.connection_id && connectAtStartupEnabled(process.env, { cwd })) {
    try {
      const connected = await autoConnectAtStartup({ cwd, conversationId, env: process.env })
      if (connected?.connection_id) {
        state = readStateFile(connected.connection_id) || connected
      }
    } catch {
      /* non-fatal */
    }
  }

  const connectionId = args.connectionId || state?.connection_id || null
  if (!connectionId) {
    process.stderr.write('devspec-remote-listen: no active connection found\n')
    process.exit(0)
  }

  state = readStateFile(connectionId) || state
  if (!conversationId && state?.local_id) {
    conversationId = state.local_id
  }

  const ownerPid = resolveOwnerPid('auto', state?.owner_pid)
  if (state?.token) {
    try {
      ensurePollerForConnection(connectionId, {
        cwd: state?.cwd || cwd,
        ownerPid,
        sessionId: state?.session_id || null,
        reuseRunning: true,
      })
    } catch {
      /* non-fatal */
    }
  }

  const inboxPath = inboxPathForConnection(connectionId)
  let offset = fs.existsSync(inboxPath) ? fs.statSync(inboxPath).size : 0

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const live = readStateFile(connectionId)
    if (live && live.enabled === false) {
      process.exit(0)
    }
    if (live?.local_id && !conversationId) {
      conversationId = live.local_id
    }

    const { entries, nextOffset } = readNewInboxEntries(inboxPath, offset)
    offset = nextOffset
    for (const entry of entries) {
      if (entry?.type !== 'owner_messages') continue
      const message = buildWakeDeliveryMessage(entry)
      if (!message) continue
      let deliveredVia = 'stdout'
      if (args.useAgentApi && conversationId) {
        const res = await deliverWakeViaAgentApi({ conversationId, message })
        if (res.ok) deliveredVia = 'agentapi'
      }
      process.stdout.write(
        JSON.stringify({
          type: 'wake_delivery',
          connection_id: connectionId,
          conversation_id: conversationId,
          delivered_via: deliveredVia,
          message,
        }) + '\n',
      )
    }

    if (args.once) break
    await sleep(1_500)
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  main().catch((e) => {
    process.stderr.write(`devspec-remote-listen: ${e.message}\n`)
    process.exit(1)
  })
}
