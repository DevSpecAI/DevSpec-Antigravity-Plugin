#!/usr/bin/env node
/**
 * Antigravity DevSpec Remote Listener & Sidecar (`devspec-remote-listen.mjs`).
 *
 * Persistent companion daemon anchored to the owning Antigravity (`agy`) process:
 * 1. Resolves (or auto-connects when enabled) the active Antigravity DevSpec connection.
 * 2. Writes `<connectionId>.listener.json` proof-of-life and self-terminates when
 *    `owner_pid` exits.
 * 3. Ensures `devspec-remote-poll.mjs` is running for that connection.
 * 4. Watches the connection's JSONL inbox (`~/.devspec/remote-control/connections/<connectionId>.inbox.jsonl`).
 * 5. When no in-conversation `devspec-remote-wait.mjs` task is currently armed,
 *    delivers wakes via `agentapi send-message <conversationId> <message>` (or
 *    `agentapi new-conversation <message>` before a conversation exists) and
 *    advances `inbox_byte_offset` on `<connectionId>.json`.
 */

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { formatInboxEntryForStream, formatSystemNoticeContent } from './devspec-remote-wait.mjs'
import { mcpToolsCall } from './mcp-call.mjs'
import { loadState, writeTurnMarker } from './mirror-turn.mjs'
import {
  ensurePollerForConnection,
  listenerInfoPath,
  ownerAlive,
  readStateFile,
  resolveOwnerPid,
  writeStateFile,
} from './remote-control-state.mjs'
import { recordDeliveredBatchRequests } from './requests.mjs'
import { autoConnectAtStartup, connectAtStartupEnabled } from './session-start.mjs'

const CONNECTIONS_DIR = path.join(os.homedir(), '.devspec', 'remote-control', 'connections')

function inboxPathForConnection(connectionId, dir = CONNECTIONS_DIR) {
  return path.join(dir, `${connectionId}.inbox.jsonl`)
}

function waitPidPath(connectionId, dir = CONNECTIONS_DIR) {
  return path.join(dir, `${connectionId}.wait.pid`)
}

export function isWaitProcessArmed(connectionId, dir = CONNECTIONS_DIR) {
  if (!connectionId) return false
  try {
    const pid = Number.parseInt(fs.readFileSync(waitPidPath(connectionId, dir), 'utf8').trim(), 10)
    if (Number.isInteger(pid) && pid > 1 && ownerAlive(pid)) return true
  } catch {
    /* check /proc fallback */
  }
  try {
    for (const name of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue
      const cmd = fs.readFileSync(`/proc/${name}/cmdline`, 'utf8')
      if (cmd.includes('devspec-remote-wait.mjs') && cmd.includes(connectionId)) {
        return true
      }
    }
  } catch {
    /* non-Linux or no /proc */
  }
  return false
}

export function parseListenArgs(argv = []) {
  const out = {
    connectionId: null,
    conversationId: null,
    ownerPid: null,
    cwd: null,
    once: false,
    useAgentApi: true,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--connection-id') out.connectionId = argv[++i] || null
    else if (a === '--conversation-id' || a === '--local-id') out.conversationId = argv[++i] || null
    else if (a === '--owner-pid') out.ownerPid = argv[++i] || null
    else if (a === '--cwd') out.cwd = argv[++i] || null
    else if (a === '--once') out.once = true
    else if (a === '--no-agentapi') out.useAgentApi = false
  }
  return out
}

/**
 * Format an inbox entry (`owner_messages`, `canonical_commands`, `canonical_system_notices`,
 * `automation_run`, `interaction_answer`, or `question_dismissal`) into a wake prompt
 * suitable for `agentapi send-message` / `agentapi new-conversation`.
 * Includes both the `[DevSpec Remote Wake]` summary header and the full canonical
 * JSON lines from `formatInboxEntryForStream` (`rearm: "already_armed"`).
 */
export function buildWakeDeliveryMessage(entry, opts = {}) {
  if (!entry || typeof entry !== 'object') return null

  const streamOpts = {
    ...opts,
    rearm: opts.rearm ?? 'already_armed',
  }

  if (entry.type === 'canonical_commands') {
    const ingress = entry.ingress
    const executeIds = new Set(
      Array.isArray(entry.execute_message_ids)
        ? entry.execute_message_ids
        : Array.isArray(ingress?.command_message_ids)
          ? ingress.command_message_ids
          : [],
    )
    const commands = Array.isArray(ingress?.commands)
      ? ingress.commands.filter((c) => executeIds.size === 0 || executeIds.has(c?.message_id))
      : []
    if (commands.length === 0) return null
    const lines = ['[DevSpec Remote Wake]']
    if (entry.session_id) lines.push(`Session: ${entry.session_id}`)
    if (entry.wake_context?.transcript) lines.push(`Room transcript: ${entry.wake_context.transcript}`)
    if (entry.wake_context?.room_state) lines.push(`Room state: ${entry.wake_context.room_state}`)
    if (entry.instruction_context_file) lines.push(`Instructions file: ${entry.instruction_context_file}`)
    for (const c of commands) {
      const sender = c?.requester?.display_name || 'Owner'
      const body = typeof c?.content?.body === 'string' ? c.content.body.trim() : ''
      if (body) lines.push(`${sender} (${c?.authority?.kind || 'owner'}): ${body}`)
    }
    const streamJson = formatInboxEntryForStream(entry, streamOpts)
    if (streamJson) lines.push(streamJson)
    return lines.join('\n\n')
  }

  if (entry.type === 'canonical_system_notices') {
    const ingress = entry.ingress
    const executeIds = new Set(
      Array.isArray(entry.execute_notice_ids)
        ? entry.execute_notice_ids
        : Array.isArray(ingress?.system_notices)
          ? ingress.system_notices.map((n) => n?.notice_id).filter(Boolean)
          : [],
    )
    const notices = Array.isArray(ingress?.system_notices)
      ? ingress.system_notices.filter((n) => executeIds.size === 0 || executeIds.has(n?.notice_id))
      : []
    if (notices.length === 0) return null
    const lines = ['[DevSpec Remote Wake]']
    if (entry.session_id) lines.push(`Session: ${entry.session_id}`)
    for (const notice of notices) {
      const formatted = formatSystemNoticeContent(notice)
      if (formatted) lines.push(formatted)
    }
    const streamJson = formatInboxEntryForStream(entry, streamOpts)
    if (streamJson) lines.push(streamJson)
    return lines.join('\n\n')
  }

  if (entry.type === 'automation_run' && entry.dispatch) {
    const d = entry.dispatch
    const lines = [
      '[DevSpec Remote Wake]',
      `Automation run dispatched: "${d.automation_name}" (run_id=${d.run_id}, connection_id=${d.delivery_connection_id})`,
    ]
    const streamJson = formatInboxEntryForStream(entry, streamOpts)
    if (streamJson) lines.push(streamJson)
    return lines.join('\n\n')
  }

  if (entry.type === 'interaction_answer' && entry.event) {
    const lines = [
      '[DevSpec Remote Wake]',
      `Directed question ${entry.event.question_id} answered: ${JSON.stringify(entry.event.answer)}`,
    ]
    const streamJson = formatInboxEntryForStream(entry, streamOpts)
    if (streamJson) lines.push(streamJson)
    return lines.join('\n\n')
  }

  if (entry.type === 'question_dismissal' && entry.event) {
    const lines = [
      '[DevSpec Remote Wake]',
      `Directed question ${entry.event.question_id} was dismissed.`,
    ]
    const streamJson = formatInboxEntryForStream(entry, streamOpts)
    if (streamJson) lines.push(streamJson)
    return lines.join('\n\n')
  }

  if (entry.type !== 'owner_messages') return null
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
    const content =
      typeof m?.content === 'string'
        ? m.content.trim()
        : typeof m?.content?.body === 'string'
          ? m.content.body.trim()
          : ''
    if (content) {
      lines.push(`${sender}: ${content}`)
    }
  }
  const streamJson = formatInboxEntryForStream(entry, streamOpts)
  if (streamJson) lines.push(streamJson)
  return lines.join('\n\n')
}

function resolveAgentApiCommand(mergedEnv, execFileImpl, explicitEnv, state) {
  const allowAgentApiExe =
    execFileImpl === execFile ||
    Boolean(explicitEnv && 'ANTIGRAVITY_AGENTAPI_EXE' in explicitEnv) ||
    Boolean(state?.agentapi_exe)
  const explicitExe =
    allowAgentApiExe &&
    typeof mergedEnv?.ANTIGRAVITY_AGENTAPI_EXE === 'string' &&
    mergedEnv.ANTIGRAVITY_AGENTAPI_EXE.trim()
      ? mergedEnv.ANTIGRAVITY_AGENTAPI_EXE.trim()
      : null
  if (explicitExe) {
    return { bin: explicitExe, prefixArgs: ['agentapi'] }
  }
  const wrapperPath = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'bin', 'agentapi')
  if (execFileImpl === execFile && fs.existsSync(wrapperPath)) {
    return { bin: wrapperPath, prefixArgs: [] }
  }
  return { bin: 'agentapi', prefixArgs: [] }
}

function parseAgentApiCallbackResult(err, stdout, stderr) {
  const outText = (stdout || '').toString().trim()
  const errText = (stderr || '').toString().trim()
  if (err) {
    return {
      ok: false,
      error: errText || outText || err.message || 'agentapi_failed',
    }
  }
  if (outText.startsWith('{')) {
    try {
      const parsed = JSON.parse(outText)
      if (typeof parsed?.error === 'string' && parsed.error.trim()) {
        return {
          ok: false,
          error: parsed.error.trim(),
          stdout: outText,
        }
      }
    } catch {
      /* non-JSON stdout */
    }
  }
  return { ok: true, stdout: outText }
}

/**
 * Deliver a wake message to an Antigravity conversation via `agentapi send-message`
 * (or `agentapi new-conversation` when no conversationId exists yet).
 */
export function deliverWakeViaAgentApi({
  conversationId = null,
  message,
  env: explicitEnv,
  state = null,
  execFileImpl = execFile,
  timeoutMs = 5_000,
} = {}) {
  const env = explicitEnv || process.env
  if (!message) {
    return Promise.resolve({ ok: false, error: 'missing_conversation_or_message' })
  }
  const defaultBinDir = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'bin')
  const basePath = env.PATH || process.env.PATH || ''
  const mergedEnv = {
    ...env,
    PATH: basePath.includes(defaultBinDir)
      ? basePath
      : `${defaultBinDir}${path.delimiter}${basePath}`,
    ...(state?.ls_address && !env.ANTIGRAVITY_LS_ADDRESS
      ? { ANTIGRAVITY_LS_ADDRESS: state.ls_address }
      : {}),
    ...(state?.csrf_token && !env.ANTIGRAVITY_CSRF_TOKEN
      ? { ANTIGRAVITY_CSRF_TOKEN: state.csrf_token }
      : {}),
    ...(state?.agentapi_exe && !env.ANTIGRAVITY_AGENTAPI_EXE
      ? { ANTIGRAVITY_AGENTAPI_EXE: state.agentapi_exe }
      : {}),
  }

  const { bin, prefixArgs } = resolveAgentApiCommand(mergedEnv, execFileImpl, explicitEnv, state)

  // Backward-compatible signature: in unit tests or explicit calls with conversationId,
  // invoke `agentapi send-message <conversationId> <message>` (or `<ANTIGRAVITY_AGENTAPI_EXE> agentapi send-message ...`).
  if (conversationId) {
    return new Promise((resolve) => {
      try {
        execFileImpl(
          bin,
          [...prefixArgs, 'send-message', String(conversationId), String(message)],
          { timeout: timeoutMs, env: mergedEnv },
          (err, stdout, stderr) => {
            resolve(parseAgentApiCallbackResult(err, stdout, stderr))
          },
        )
      } catch (err) {
        resolve({ ok: false, error: err?.message || 'agentapi_spawn_failed' })
      }
    })
  }

  if (!mergedEnv.ANTIGRAVITY_LS_ADDRESS || !mergedEnv.ANTIGRAVITY_CSRF_TOKEN) {
    return Promise.resolve({ ok: false, error: 'missing_conversation_or_message' })
  }

  return new Promise((resolve) => {
    try {
      execFileImpl(
        bin,
        [...prefixArgs, 'new-conversation', String(message)],
        { timeout: timeoutMs, env: mergedEnv },
        (err, stdout, stderr) => {
          resolve(parseAgentApiCallbackResult(err, stdout, stderr))
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
    const start = offsetBytes >= 0 && offsetBytes <= buf.length ? offsetBytes : 0
    const slice = buf.subarray(start)
    const lastNl = slice.lastIndexOf(0x0a)
    if (lastNl === -1) return { entries: [], nextOffset: start }
    const completeText = slice.subarray(0, lastNl + 1).toString('utf8')
    const entries = []
    for (const line of completeText.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        entries.push(JSON.parse(trimmed))
      } catch {
        /* ignore malformed line */
      }
    }
    return { entries, nextOffset: start + lastNl + 1 }
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

  const explicitOwnerPid = Number.parseInt(String(args.ownerPid ?? state?.owner_pid ?? ''), 10)
  const hasExplicitOwnerPid = Number.isInteger(explicitOwnerPid) && explicitOwnerPid > 1
  if (!args.once && hasExplicitOwnerPid && !ownerAlive(explicitOwnerPid)) {
    process.stderr.write(
      `devspec-remote-listen: owner-pid ${explicitOwnerPid} not alive at startup — exiting\n`,
    )
    process.exit(0)
  }
  const ownerPid = resolveOwnerPid(args.ownerPid || 'auto', state?.owner_pid)
  const ownerAnchor = ownerPid && ownerAlive(ownerPid) ? ownerPid : null

  const listenerFile = listenerInfoPath(connectionId)
  const writeListenerMarker = () => {
    try {
      fs.mkdirSync(path.dirname(listenerFile), { recursive: true })
      fs.writeFileSync(
        listenerFile,
        JSON.stringify(
          {
            pid: process.pid,
            owner_pid: ownerAnchor,
            connection_id: connectionId,
            conversation_id: conversationId,
            status: 'serving',
            updated_at: new Date().toISOString(),
          },
          null,
          2,
        ) + '\n',
        { mode: 0o600 },
      )
    } catch {
      /* ignore */
    }
  }
  const removeListenerMarker = () => {
    try {
      const cur = JSON.parse(fs.readFileSync(listenerFile, 'utf8'))
      if (cur?.pid === process.pid) fs.rmSync(listenerFile, { force: true })
    } catch {
      /* ignore */
    }
  }
  writeListenerMarker()
  process.on('exit', removeListenerMarker)
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      removeListenerMarker()
      process.exit(0)
    })
  }

  if (state?.token && ownerAnchor) {
    try {
      ensurePollerForConnection(connectionId, {
        cwd: state?.cwd || cwd,
        ownerPid: ownerAnchor,
        sessionId: state?.session_id || null,
        reuseRunning: true,
      })
    } catch {
      /* non-fatal */
    }
  }

  const inboxPath = inboxPathForConnection(connectionId)
  let offset =
    typeof state?.inbox_byte_offset === 'number'
      ? state.inbox_byte_offset
      : fs.existsSync(inboxPath)
        ? fs.statSync(inboxPath).size
        : 0

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (ownerAnchor && !ownerAlive(ownerAnchor)) {
      removeListenerMarker()
      process.exit(0)
    }
    const live = readStateFile(connectionId)
    if (live && (live.enabled === false || live.ended_from_ui === true || live.end_reason === 'ui')) {
      removeListenerMarker()
      process.exit(0)
    }
    if (live?.local_id && live.local_id !== conversationId) {
      conversationId = live.local_id
      writeListenerMarker()
    }
    if (typeof live?.inbox_byte_offset === 'number' && live.inbox_byte_offset > offset) {
      offset = live.inbox_byte_offset
    }

    // If an in-conversation devspec-remote-wait.mjs is armed, let it consume the inbox
    // so we never race or double-deliver wakes.
    if (!args.once && isWaitProcessArmed(connectionId)) {
      await sleep(500)
      continue
    }

    const { entries, nextOffset } = readNewInboxEntries(inboxPath, offset)
    if (entries.length > 0) {
      let allDeliveredOrNonCommand = true
      for (const entry of entries) {
        const message = buildWakeDeliveryMessage(entry, {
          connectionId,
          inboxFile: inboxPath,
        })
        if (!message) continue
        let deliveredVia = 'stdout'
        if (args.useAgentApi) {
          const res = await deliverWakeViaAgentApi({
            conversationId,
            message,
            env: process.env,
            state: live,
          })
          if (res.ok) {
            deliveredVia = 'agentapi'
            writeTurnMarker(connectionId, { remoteTurn: true })
            if (live?.token && live?.mcp_url) {
              mcpToolsCall({
                mcpUrl: live.mcp_url,
                token: live.token,
                ...(live.connection_capability
                  ? { connectionCapability: live.connection_capability }
                  : {}),
                name: 'report_pickup',
                arguments: { connection_id: connectionId },
                timeoutMs: 5_000,
              }).catch(() => {})
            }
            try {
              recordDeliveredBatchRequests(connectionId, entry, { dir: CONNECTIONS_DIR })
            } catch {
              /* non-fatal */
            }
          } else if (!args.once) {
            // Do not advance offset if agentapi delivery failed in daemon mode,
            // so devspec-remote-wait.mjs or a later tick can deliver it.
            allDeliveredOrNonCommand = false
            break
          }
        } else {
          writeTurnMarker(connectionId, { remoteTurn: true })
          try {
            recordDeliveredBatchRequests(connectionId, entry, { dir: CONNECTIONS_DIR })
          } catch {
            /* non-fatal */
          }
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
      if (allDeliveredOrNonCommand) {
        offset = nextOffset
        if (live) {
          writeStateFile(connectionId, {
            ...live,
            inbox_byte_offset: offset,
            updated_at: new Date().toISOString(),
          })
        }
      }
    }

    if (args.once) break
    await sleep(500)
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  main().catch((e) => {
    process.stderr.write(`devspec-remote-listen: ${e.message}\n`)
    process.exit(1)
  })
}
