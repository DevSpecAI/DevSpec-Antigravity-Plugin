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
import { AGENT_NAME } from './agent-identity.mjs'
import {
  closeAntigravityOnEnd,
  ownedByAnotherAntigravityProcess,
  ownedByAntigravityProcess,
} from './close-on-end.mjs'
import { LOADED_PLUGIN_VERSION } from './connection-version.mjs'
import { formatInboxEntryForStream, formatSystemNoticeContent } from './devspec-remote-wait.mjs'
import { mcpToolsCall } from './mcp-call.mjs'
import { loadState, writeTurnMarker } from './mirror-turn.mjs'
import {
  ensurePollerForConnection,
  listenerInfoPath,
  ownerAlive,
  pollerRunning,
  readStateFile,
  resolveOwnerPid,
  writeLocalBond,
  writeStateFile,
} from './remote-control-state.mjs'
import { ensurePrivateDir, writePrivateText } from './private-state.mjs'
import { recordDeliveredBatchRequests } from './requests.mjs'
import { autoConnectAtStartup, connectAtStartupEnabled } from './session-start.mjs'

const CONNECTIONS_DIR = path.join(os.homedir(), '.devspec', 'remote-control', 'connections')

/**
 * Linux `execve` caps each individual argv string at `MAX_ARG_STRLEN` (131,072 bytes).
 * `deliverWakeViaAgentApi` passes the wake payload as a single CLI argument to
 * `agy agentapi send-message <conversationId> <message>`. Wakes at or below 64 KB
 * (half of `MAX_ARG_STRLEN`) travel inline for zero-latency reading; wakes above
 * 64 KB write their complete uncut readable body to an owner-only (`0600`) local
 * handoff file in the connection directory and carry the file path + canonical JSON
 * metadata inline so `execFile` can never fail with `spawn E2BIG` (item 5019ecc9).
 */
export const MAX_INLINE_WAKE_BYTES = 65_536

export const POLLER_CHECK_INTERVAL_MS = 2_500
export const POLLER_MISSES_BEFORE_REPAIR = 2
export const REPAIR_BACKOFF_MS = [0, 5_000, 15_000, 30_000, 60_000]
export const REPAIR_STABLE_MS = 60_000

/**
 * True when a connection state reflects a deliberate human or owner-process stop
 * (`end_reason === "ui"`, `"ended_from_ui"`, `"local_stop"`, `"owner_gone"`, or
 * `enabled === false` without a recoverable server timeout reason).
 * Recoverable server-side timeouts (`idle_timeout` / `server_ended`) while the
 * owning Antigravity process is still alive return `false` so the listener can
 * self-repair the poller and re-register/re-attach the connection (item da592dee).
 */
export function isDeliberateConnectionEnd(state) {
  if (!state) return false
  if (state.ended_from_ui === true) return true
  const reason = state.end_reason || null
  if (
    reason === 'ui' ||
    reason === 'ended_from_ui' ||
    reason === 'local_stop' ||
    reason === 'owner_gone'
  ) {
    return true
  }
  if (state.enabled === false && reason !== 'idle_timeout' && reason !== 'server_ended') {
    return true
  }
  return false
}

/**
 * Decide whether the serving listener should repair a missing poller on this check tick.
 * Requires `POLLER_MISSES_BEFORE_REPAIR` consecutive misses so a normal kill→respawn
 * during `/devspec-remote` never triggers a redundant repair.
 */
export function reconcilePollerStep({
  ownedAndActive,
  pollerUp,
  misses = 0,
  now = Date.now(),
  repairNotBefore = 0,
} = {}) {
  if (!ownedAndActive) return { repair: false, misses: 0 }
  const nextMisses = pollerUp ? 0 : misses + 1
  return {
    repair: !pollerUp && nextMisses >= POLLER_MISSES_BEFORE_REPAIR && now >= repairNotBefore,
    misses: nextMisses,
  }
}

/**
 * Self-repair a connection whose poller died while its owning Antigravity process
 * is still alive (item da592dee):
 * 1. Best-effort `register_connection` (and `attach_connection` if `state.session_id`
 *    is set) so a connection that timed out on the server while the poller was down
 *    is revived on the same `connection_id`, codename, and room with a fresh capability.
 * 2. Re-enable local state and bond, then spawn `devspec-remote-poll.mjs` via
 *    `ensurePollerForConnection`.
 */
export async function repairConnectionPoller({
  connectionId,
  state,
  ownerPid,
  cwd,
  conversationId = null,
  callMcp = mcpToolsCall,
  ensurePollerFn = ensurePollerForConnection,
  writeStateFn = writeStateFile,
  writeBondFn = writeLocalBond,
  isOwnerAlive = ownerAlive,
} = {}) {
  if (!connectionId || !state) return { ok: false, error: 'missing_state' }
  const effectiveOwnerPid = Number.parseInt(String(ownerPid ?? state.owner_pid ?? ''), 10)
  if (!Number.isInteger(effectiveOwnerPid) || effectiveOwnerPid <= 1 || !isOwnerAlive(effectiveOwnerPid)) {
    return { ok: false, error: 'owner_not_alive' }
  }
  const effectiveCwd = state.cwd || cwd || process.cwd()
  const effectiveLocalId =
    conversationId || state.local_id || state.pending_local_id || null
  let nextState = { ...state }

  if (state.token && state.mcp_url) {
    let negotiatedCapability =
      typeof state.connection_capability === 'string' &&
      state.connection_capability.startsWith('dvsc_')
        ? state.connection_capability
        : null
    let negotiatedVersion = state.connection_capability_version || 1
    try {
      const regRes = await callMcp({
        mcpUrl: state.mcp_url,
        token: state.token,
        name: 'register_connection',
        ...(negotiatedCapability ? { connectionCapability: negotiatedCapability } : {}),
        includeMeta: true,
        onResultMeta: (meta) => {
          const cap = meta?.devspec?.connection_capability
          if (cap?.version === 1 && typeof cap.value === 'string') {
            negotiatedCapability = cap.value
            negotiatedVersion = cap.version
          }
        },
        arguments: {
          ...(effectiveLocalId ? { local_id: effectiveLocalId } : {}),
          agent_name: state.agent_name || AGENT_NAME,
          agent_version: LOADED_PLUGIN_VERSION,
          cwd: effectiveCwd,
          machine_hostname: os.hostname(),
          ...(state.git_remote ? { git_remote: state.git_remote } : {}),
          ...(state.project_id ? { project_id: state.project_id } : {}),
          ...(state.session_codename ? { name: state.session_codename } : {}),
          connection_capability_version: 1,
          project_selection_version: 1,
          ...(state.instruction_tiers_version && state.instruction_tiers_hash
            ? {
                known_instruction_tiers_version: state.instruction_tiers_version,
                known_instruction_tiers_hash: state.instruction_tiers_hash,
              }
            : {}),
        },
        timeoutMs: 15_000,
      })
      const metaCap = regRes?.meta?.devspec?.connection_capability
      if (metaCap?.version === 1 && typeof metaCap.value === 'string') {
        negotiatedCapability = metaCap.value
        negotiatedVersion = metaCap.version
      }
      if (state.session_id) {
        await callMcp({
          mcpUrl: state.mcp_url,
          token: state.token,
          name: 'attach_connection',
          ...(negotiatedCapability ? { connectionCapability: negotiatedCapability } : {}),
          arguments: {
            connection_id: connectionId,
            session_id: state.session_id,
          },
          timeoutMs: 15_000,
        })
      }
    } catch {
      /* best-effort: if offline, still spawn the poller so its retry loop takes over */
    }
    nextState = {
      ...nextState,
      enabled: true,
      ended_from_ui: false,
      end_reason: null,
      owner_pid: effectiveOwnerPid,
      ...(negotiatedCapability
        ? {
            connection_capability: negotiatedCapability,
            connection_capability_version: negotiatedVersion,
          }
        : {}),
      updated_at: new Date().toISOString(),
    }
    writeStateFn(connectionId, nextState)
    if (effectiveLocalId && !String(effectiveLocalId).startsWith('agy-window:')) {
      try {
        writeBondFn(state.agent_name || AGENT_NAME, effectiveLocalId, {
          status: 'live',
          connection_id: connectionId,
          session_id: nextState.session_id || null,
          session_codename: nextState.session_codename || null,
          cwd: effectiveCwd,
          transcript_path: nextState.transcript_path || null,
          enabled: true,
          end_reason: null,
        })
      } catch {
        /* non-fatal */
      }
    }
  }

  const poller = ensurePollerFn(connectionId, {
    cwd: effectiveCwd,
    ownerPid: effectiveOwnerPid,
    sessionId: nextState.session_id || null,
    reuseRunning: true,
  })
  return {
    ok: Boolean(poller?.ok),
    connection_id: connectionId,
    poller,
    state: nextState,
  }
}

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

function sanitizeWakeToken(value, fallback = 'wake') {
  const cleaned = String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96)
  return cleaned || fallback
}

function finalizeWakeWithOptionalFileHandoff({
  headerLines,
  bodyLines,
  summaryLine,
  streamJson,
  connectionId,
  wakeId,
  maxInlineBytes = MAX_INLINE_WAKE_BYTES,
  handoffDir = CONNECTIONS_DIR,
  writeHandoffFile = writePrivateText,
}) {
  const fullLines = [...headerLines, ...bodyLines]
  if (streamJson) fullLines.push(streamJson)
  const fullWake = fullLines.join('\n\n')
  if (
    bodyLines.length === 0 ||
    !Number.isFinite(maxInlineBytes) ||
    Buffer.byteLength(fullWake, 'utf8') <= maxInlineBytes
  ) {
    return fullWake
  }

  const bodyText = bodyLines.join('\n\n') + '\n'
  const bodyBytes = Buffer.byteLength(bodyText, 'utf8')
  const safeConn = sanitizeWakeToken(connectionId, 'connection')
  const safeWake = sanitizeWakeToken(wakeId, String(Date.now()))
  const filePath = path.join(handoffDir, `${safeConn}.wake-${safeWake}.txt`)
  try {
    writeHandoffFile(filePath, bodyText)
  } catch {
    return fullWake
  }

  const handoffLines = [
    ...headerLines,
    ...(summaryLine ? [summaryLine] : []),
    `Wake payload file: ${filePath} (${bodyBytes} bytes)\n` +
      `REQUIRED: This wake exceeds the ${maxInlineBytes}-byte inline threshold for the 128 KB OS command-line argument limit. ` +
      `Read ${filePath} in full with view_file before acting or replying — the complete, uncut text is stored there.`,
  ]
  if (streamJson) handoffLines.push(streamJson)
  return handoffLines.join('\n\n')
}

/**
 * Format an inbox entry (`owner_messages`, `canonical_commands`, `canonical_system_notices`,
 * `automation_run`, `interaction_answer`, or `question_dismissal`) into a wake prompt
 * suitable for `agentapi send-message` / `agentapi new-conversation`.
 * Includes both the `[DevSpec Remote Wake]` summary header and the full canonical
 * JSON lines from `formatInboxEntryForStream` (`rearm: "already_armed"`).
 * When the assembled wake exceeds `MAX_INLINE_WAKE_BYTES` (64 KB), writes the complete
 * uncut readable body to an owner-only (`0600`) local handoff file in `handoffDir`
 * and replaces the inline body section with the handoff file path and a required-read
 * instruction so `agentapi` never fails with `spawn E2BIG`.
 */
export function buildWakeDeliveryMessage(entry, opts = {}) {
  if (!entry || typeof entry !== 'object') return null

  const streamOpts = {
    ...opts,
    rearm: opts.rearm ?? 'already_armed',
  }
  const effectiveConnId =
    opts.connectionId ||
    entry.connection_id ||
    entry.ingress?.connection?.connection_id ||
    entry.dispatch?.delivery_connection_id ||
    null

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
    const headerLines = ['[DevSpec Remote Wake]']
    if (entry.session_id) headerLines.push(`Session: ${entry.session_id}`)
    if (entry.wake_context?.transcript) headerLines.push(`Room transcript: ${entry.wake_context.transcript}`)
    if (entry.wake_context?.room_state) headerLines.push(`Room state: ${entry.wake_context.room_state}`)
    if (entry.instruction_context_file) headerLines.push(`Instructions file: ${entry.instruction_context_file}`)
    const bodyLines = []
    const senders = []
    for (const c of commands) {
      const sender = c?.requester?.display_name || 'Owner'
      const authKind = c?.authority?.kind || 'owner'
      senders.push(`${sender} (${authKind})`)
      const body = typeof c?.content?.body === 'string' ? c.content.body.trim() : ''
      if (body) bodyLines.push(`${sender} (${authKind}): ${body}`)
    }
    const streamJson = formatInboxEntryForStream(entry, { ...streamOpts, includeBody: false })
    return finalizeWakeWithOptionalFileHandoff({
      headerLines,
      bodyLines,
      summaryLine: `Command from ${senders.join(', ')} (${commands.length} message${commands.length === 1 ? '' : 's'}):`,
      streamJson,
      connectionId: effectiveConnId,
      wakeId: ingress?.envelope_id || commands[0]?.message_id,
      maxInlineBytes: opts.maxInlineBytes,
      handoffDir: opts.handoffDir,
      writeHandoffFile: opts.writeHandoffFile,
    })
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
    const headerLines = ['[DevSpec Remote Wake]']
    if (entry.session_id) headerLines.push(`Session: ${entry.session_id}`)
    const bodyLines = []
    for (const notice of notices) {
      const formatted = formatSystemNoticeContent(notice)
      if (formatted) bodyLines.push(formatted)
    }
    const streamJson = formatInboxEntryForStream(entry, { ...streamOpts, includeContent: false })
    const topics = notices
      .map((n) => (n?.topic && n?.notice_type ? `${n.topic}/${n.notice_type}` : n?.kind || 'notice'))
      .join(', ')
    return finalizeWakeWithOptionalFileHandoff({
      headerLines,
      bodyLines,
      summaryLine: `[DevSpec System Notices: ${notices.length} notice${notices.length === 1 ? '' : 's'} (${topics})]`,
      streamJson,
      connectionId: effectiveConnId,
      wakeId: ingress?.envelope_id || notices[0]?.notice_id,
      maxInlineBytes: opts.maxInlineBytes,
      handoffDir: opts.handoffDir,
      writeHandoffFile: opts.writeHandoffFile,
    })
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
      `Directed question ${entry.event.question_id} answered.`,
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

  const headerLines = ['[DevSpec Remote Wake]']
  if (entry.session_id) {
    headerLines.push(`Session: ${entry.session_id}`)
  }
  const bodyLines = []
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
      bodyLines.push(`${sender}: ${content}`)
    }
  }
  const streamJson = formatInboxEntryForStream(entry, { ...streamOpts, includeBody: false })
  return finalizeWakeWithOptionalFileHandoff({
    headerLines,
    bodyLines,
    summaryLine: `Owner message (${msgs.length} message${msgs.length === 1 ? '' : 's'}):`,
    streamJson,
    connectionId: effectiveConnId,
    wakeId: msgs[0]?.id || entry.next_after_message_id,
    maxInlineBytes: opts.maxInlineBytes,
    handoffDir: opts.handoffDir,
    writeHandoffFile: opts.writeHandoffFile,
  })
}

/**
 * Which executable delivers the wake.
 *
 * `ANTIGRAVITY_AGENTAPI_EXE` (and the state file's copy of it) names the binary the
 * agy process was started from. agy updates itself by renaming that running binary
 * to `agy.<n>.old` (or `agy.exe.<n>.old`), and a later agy launch deletes it, while
 * the long-lived agy process and its env still name the old path. Furthermore, on
 * Linux every `run_command` tool call in a pre-update agy session rewrites the shared
 * `~/.gemini/antigravity-cli/bin/agentapi` wrapper with `/proc/self/exe` (the deleted
 * `agy.<n>.old` path), and on Windows `agentapi.bat` cannot be executed via Node's
 * `execFile` (`ENOENT`). We therefore never invoke the `agentapi` shell/batch wrapper:
 * when `explicitExe` no longer exists on disk, we strip any self-update `.old` suffix
 * (`.\d+.old` or `.old`) to invoke the live `agy` binary at that path with
 * `prefixArgs: ['agentapi']`, or fall back to `agy` on `PATH` with `prefixArgs: ['agentapi']`.
 */
export function stripSelfUpdateOldSuffix(exePath) {
  if (typeof exePath !== 'string') return ''
  return exePath.replace(/\.(?:\d+\.)?old$/i, '')
}

export function resolveAgentApiCommand(mergedEnv, execFileImpl, explicitEnv, state, existsImpl = fs.existsSync) {
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
    const isAbsoluteLike = path.isAbsolute(explicitExe) || path.win32.isAbsolute(explicitExe)
    if (!isAbsoluteLike || existsImpl(explicitExe)) {
      return { bin: explicitExe, prefixArgs: ['agentapi'] }
    }
    const liveExe = stripSelfUpdateOldSuffix(explicitExe)
    if (liveExe && liveExe !== explicitExe && existsImpl(liveExe)) {
      return { bin: liveExe, prefixArgs: ['agentapi'] }
    }
    return { bin: 'agy', prefixArgs: ['agentapi'] }
  }
  if (execFileImpl === execFile) {
    return { bin: 'agy', prefixArgs: ['agentapi'] }
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
  existsImpl = fs.existsSync,
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

  const { bin, prefixArgs } = resolveAgentApiCommand(mergedEnv, execFileImpl, explicitEnv, state, existsImpl)

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
      ensurePrivateDir(path.dirname(listenerFile))
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

  // A wake that cannot be delivered stays in the inbox and is retried every tick; say
  // so once per distinct reason (and again when it recovers), so a stuck listener is
  // visible in its log instead of silently holding every room message (479607e6).
  let lastDeliveryError = null
  let pollerMisses = 0
  let pollerRepairs = 0
  let repairNotBefore = 0
  let pollerUpSince = null
  let lastPollerCheckAt = 0
  let sawLive = Boolean(
    state &&
      !isDeliberateConnectionEnd(state) &&
      (!ownerAnchor || ownedByAntigravityProcess(state, ownerAnchor)),
  )

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (ownerAnchor && !ownerAlive(ownerAnchor)) {
      removeListenerMarker()
      process.exit(0)
    }
    let live = readStateFile(connectionId)
    if (live && ownerAnchor && ownedByAnotherAntigravityProcess(live, ownerAnchor)) {
      process.stderr.write(
        `devspec-remote-listen: connection ${connectionId} moved to another Antigravity process (${live.owner_pid}) — standing down\n`,
      )
      removeListenerMarker()
      process.exit(0)
    }
    if (live && isDeliberateConnectionEnd(live)) {
      if (!args.once) {
        const outcome = closeAntigravityOnEnd({
          state: live,
          sawLive,
          ownerPid: ownerAnchor,
        })
        process.stderr.write(
          `devspec-remote-listen: ${
            outcome.closed
              ? 'ended from DevSpec — closing Antigravity'
              : 'ended — Antigravity stays open'
          } (connection=${connectionId} reason=${outcome.reason} pid=${outcome.pid ?? 'none'})\n`,
        )
      }
      removeListenerMarker()
      process.exit(0)
    }
    const ownedAndActive = Boolean(
      live &&
        !isDeliberateConnectionEnd(live) &&
        (!ownerAnchor || ownedByAntigravityProcess(live, ownerAnchor)),
    )
    if (ownedAndActive) {
      sawLive = true
    }
    if (!args.once && ownedAndActive && ownerAnchor && live?.token) {
      const now = Date.now()
      if (now - lastPollerCheckAt >= POLLER_CHECK_INTERVAL_MS) {
        lastPollerCheckAt = now
        const pollerUp = pollerRunning(connectionId)
        if (pollerUp) {
          pollerUpSince ??= now
          if (now - pollerUpSince >= REPAIR_STABLE_MS) pollerRepairs = 0
        } else {
          pollerUpSince = null
        }
        const step = reconcilePollerStep({
          ownedAndActive,
          pollerUp,
          misses: pollerMisses,
          now,
          repairNotBefore,
        })
        pollerMisses = step.misses
        if (step.repair) {
          const backoffIdx = Math.min(pollerRepairs + 1, REPAIR_BACKOFF_MS.length - 1)
          repairNotBefore = Date.now() + REPAIR_BACKOFF_MS[backoffIdx]
          pollerRepairs += 1
          pollerMisses = 0
          process.stderr.write(
            `devspec-remote-listen: poller missing while Antigravity is alive — repairing (connection=${connectionId} attempt=${pollerRepairs})\n`,
          )
          try {
            const repaired = await repairConnectionPoller({
              connectionId,
              state: live,
              ownerPid: ownerAnchor,
              cwd: live.cwd || cwd,
              conversationId,
            })
            if (repaired?.state) live = repaired.state
            process.stderr.write(
              `devspec-remote-listen: poller repair ${repaired?.ok ? `succeeded (pid=${repaired.poller?.pid})` : 'failed'} (connection=${connectionId})\n`,
            )
          } catch (err) {
            process.stderr.write(
              `devspec-remote-listen: poller repair error (${err?.message || String(err)})\n`,
            )
          }
        }
      }
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
            if (lastDeliveryError !== null) {
              process.stdout.write(
                JSON.stringify({ type: 'wake_delivery_recovered', connection_id: connectionId, at: new Date().toISOString() }) + '\n',
              )
              lastDeliveryError = null
            }
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
          } else {
            const error = String(res.error || 'agentapi_failed')
            if (error !== lastDeliveryError) {
              process.stdout.write(
                JSON.stringify({
                  type: 'wake_delivery_failed',
                  connection_id: connectionId,
                  conversation_id: conversationId,
                  error,
                  retrying: !args.once,
                  at: new Date().toISOString(),
                }) + '\n',
              )
              lastDeliveryError = error
            }
            if (!args.once) {
              // Do not advance offset if agentapi delivery failed in daemon mode,
              // so devspec-remote-wait.mjs or a later tick can deliver it.
              allDeliveredOrNonCommand = false
              break
            }
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
