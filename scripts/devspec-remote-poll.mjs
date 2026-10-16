#!/usr/bin/env node
/**
 * Long-lived, model-free `poll_connection` client for one DevSpec connection (`devspec-remote-poll.mjs`).
 *
 * Architecture:
 *   held poll (or SSE push wake) → local room transcript (`.transcript.jsonl` + `.room.json`)
 *   + durable per-connection JSONL inbox (`.inbox.jsonl`) → `devspec-remote-wait.mjs` / `devspec-remote-listen.mjs`.
 *
 * Negotiates remote-ingress 1.6.0 (`ingress_version: 1`, `delegated_scope_version: 1`,
 * `active_plan_projection_version: 1`, `system_notice_version: 1`, `sender_style_version: 1`,
 * `room_context_version: 1`, `session_polls_projection_version: 2`), `known_instruction_tiers_hash`,
 * `interaction_event_version: 1`, `question_dismissal_event_version: 1`, and `command_offer_version: 1`.
 * Authority: devspec://product/implementation-contract
 *
 * Usage:
 *   node devspec-remote-poll.mjs --connection-id <uuid> [--session <uuid>] [--owner-pid <pid>]
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AGENT_NAME } from './agent-identity.mjs'
import {
  attachmentDirFor,
  defaultWriteFile,
  materialiseBatchAttachments,
} from './attachment-store.mjs'
import {
  commandHandoffDecision,
  commandHandoffKey,
  commandOfferArguments,
  commandOfferNegotiable,
  parseCommandOfferResponse,
} from './command-offer.mjs'
import { closeAntigravityOnEnd } from './close-on-end.mjs'
import { stripConnectionCapability as stripConnectionCapabilityFields } from './connection-capability-state.mjs'
import { pluginHeaders } from './connection-version.mjs'
import { captureInstructionContext } from './instruction-tiers.mjs'
import { markBondsStoppedForConnection } from './remote-control-state.mjs'
import {
  activeContinuation,
  classifyContinuationStart,
  continuationIdentity,
  DELIVERED,
  INTERACTION_EVENT_CONTRACT_URI,
  INTERACTION_EVENT_VERSION,
  interactionActivityPlan,
  interactionAnswerRecord,
  interactionNegotiationArguments,
  QUEUED,
  queuedAnswerNotice,
  scanPersistedInteractionEventIds,
  scanQueuedInteractionEventIds,
  validateInteractionEvent,
} from './interaction-events.mjs'
import { mcpToolsCall } from './mcp-call.mjs'
import {
  explicitReplyMarkerPath,
  extractAntigravityTrailFromTranscript,
  isRemotePlumbingToolCall,
  isSessionReplyToolCall,
  summarizeThinkingText,
  writeTurnMarker as writeTurnMarkerWithExtra,
} from './mirror-turn.mjs'
import {
  STATE_ABSENT,
  STATE_OK,
  STATE_UNREADABLE,
  ensurePrivateDir,
  readPrivateJson,
  readPrivateJsonResult,
  writePrivateJson,
  writePrivateText,
} from './private-state.mjs'
import {
  DISMISSAL_KIND,
  persistedDismissalDisposition,
  questionEventAck,
  questionEventAckArguments,
  questionEventOffers,
  questionEventStartVersion,
} from './question-dismissal-events.mjs'
import {
  emptyCanonicalContextCarry,
  isActiveSessionPlansProjectionV1,
  isRemoteCommandProjectScope,
  isSessionActivityV1,
  isSessionEventsV1,
  isSessionPollsProjection,
  isStillToDiscussProjectionV1,
  mergeCanonicalContextCarry,
  normalizeRemoteIngressV1,
  REMOTE_INGRESS_RESOURCE_URI,
  ROOM_CONTEXT_VERSION,
  SESSION_POLL_PROJECTION_VERSION_2,
} from './remote-ingress-v1.mjs'
import { openRequest } from './requests.mjs'
import {
  hostTokenFromEnv,
  resolveDevspecMcpAuth,
} from './resolve-mcp-auth.mjs'
import {
  applyIngressToStore,
  beginDrain,
  completeEmptyDrain,
  loadTranscriptStore,
  observeSessionActivity,
  observeSessionEvents,
  persistTranscriptStore,
  roomStatePath,
  sessionActivityView,
  takePendingRedrain,
  transcriptHasHistory,
  transcriptPaths,
  transcriptPollArguments,
  transcriptSummary,
} from './room-transcript.mjs'
import { readSessionTitle, sessionTitleReadDue } from './session-title.mjs'
import { readConnectionTelemetry } from './statusline.mjs'

export const REMOTE_INGRESS_VERSION = 1
export const DELEGATED_SCOPE_VERSION = 1
export const ACTIVE_PLAN_PROJECTION_VERSION = 1
export const SYSTEM_NOTICE_VERSION = 1
export const SENDER_STYLE_VERSION = 1

export { roomStatePath }

export function knownInstructionTierArguments(state) {
  const version = state?.instruction_tiers_version
  const hash = state?.instruction_tiers_hash
  if (version !== 1 || typeof hash !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(hash)) return {}
  return { known_instruction_tiers_version: version, known_instruction_tiers_hash: hash }
}

export function remoteIngressNegotiationArguments() {
  return {
    ingress_version: REMOTE_INGRESS_VERSION,
    delegated_scope_version: DELEGATED_SCOPE_VERSION,
    active_plan_projection_version: ACTIVE_PLAN_PROJECTION_VERSION,
    system_notice_version: SYSTEM_NOTICE_VERSION,
    sender_style_version: SENDER_STYLE_VERSION,
    room_context_version: ROOM_CONTEXT_VERSION,
    session_polls_projection_version: SESSION_POLL_PROJECTION_VERSION_2,
  }
}

function nowStamp() {
  return new Date().toISOString()
}

const LEGACY_STATE_PATH = path.join(os.homedir(), '.devspec', 'remote-control.json')
const CONNECTIONS_DIR = path.join(os.homedir(), '.devspec', 'remote-control', 'connections')

function inboxPathForConnection(connectionId, dir = CONNECTIONS_DIR) {
  return path.join(dir, `${connectionId}.inbox.jsonl`)
}

function inboxSizeFor(connectionId, dir = CONNECTIONS_DIR) {
  try {
    return fs.statSync(inboxPathForConnection(connectionId, dir)).size
  } catch {
    return 0
  }
}

function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return !!e && e.code === 'EPERM'
  }
}

/**
 * Is a wake listener (`devspec-remote-wait.mjs` or `devspec-remote-listen.mjs`)
 * armed for this connection right now?
 */
export function readListenerArmed(connectionId, state, dir = CONNECTIONS_DIR) {
  if (!connectionId) return null
  try {
    const pid = Number.parseInt(
      fs.readFileSync(path.join(dir, `${connectionId}.wait.pid`), 'utf8').trim(),
      10,
    )
    if (pidIsAlive(pid)) return true
  } catch {
    /* check companion listener.json next */
  }
  try {
    const listener = JSON.parse(
      fs.readFileSync(path.join(dir, `${connectionId}.listener.json`), 'utf8'),
    )
    if (Number.isInteger(listener?.pid) && pidIsAlive(listener.pid)) return true
  } catch {
    /* fall through */
  }
  return state && state.wait_armed_at ? false : null
}

/**
 * Should `devspec-remote-poll.mjs` immediately write `.turn` when persisting an
 * inbound command/event to `.inbox.jsonl`?
 *
 * Only when an in-conversation `devspec-remote-wait.mjs` process (`.wait.pid`) is
 * actively armed AND the connection is bonded to a real conversation (`local_id`
 * is present and not an `agy-window:<pid>` standby). When `devspec-remote-listen.mjs`
 * is handling wakes via `agentapi` (or no listener is armed yet), `.turn` must only
 * be written once the wake is actually delivered to the agent.
 */
export function shouldAssertTurnOnPollerInboxWrite(connectionId, state, dir = CONNECTIONS_DIR) {
  if (!connectionId) return false
  const localId = state?.local_id
  if (!localId || String(localId).startsWith('agy-window:')) return false
  try {
    const pid = Number.parseInt(
      fs.readFileSync(path.join(dir, `${connectionId}.wait.pid`), 'utf8').trim(),
      10,
    )
    if (pidIsAlive(pid)) return true
  } catch {
    /* no in-conversation wait process armed */
  }
  return false
}

/**
 * Count commands/controls/dispatches/delivered-answers in `.inbox.jsonl` past `inboxOffset`.
 */
export function countUnconsumedCommands(connectionId, inboxOffset, dir = CONNECTIONS_DIR) {
  if (!connectionId) return 0
  const file = path.join(dir, `${connectionId}.inbox.jsonl`)
  let size = 0
  try {
    size = fs.statSync(file).size
  } catch {
    return 0
  }
  const from = Number.isInteger(inboxOffset) && inboxOffset >= 0 ? inboxOffset : size
  if (size <= from) return 0
  let text = ''
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const buf = Buffer.alloc(size - from)
      fs.readSync(fd, buf, 0, size - from, from)
      text = buf.toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return 0
  }
  const lastNl = text.lastIndexOf('\n')
  if (lastNl === -1) return 0
  let count = 0
  for (const line of text.slice(0, lastNl + 1).split('\n')) {
    if (!line.trim()) continue
    try {
      const obj = JSON.parse(line)
      if (obj?.type === 'canonical_commands') {
        const ids = Array.isArray(obj.execute_message_ids)
          ? obj.execute_message_ids
          : Array.isArray(obj.ingress?.command_message_ids)
            ? obj.ingress.command_message_ids
            : []
        count += ids.length
      } else if (obj?.type === 'canonical_control' || obj?.type === 'automation_run') {
        count++
      } else if (obj?.type === 'interaction_answer' && obj.disposition === DELIVERED) {
        count++
      }
    } catch {
      /* skip garbage */
    }
  }
  return count
}

const ATTENDED_CADENCE = { waitMs: 25_000, tier: 'attended', checkTier: 'responsive' }
const IDLE_CADENCE = { waitMs: 30_000, tier: 'idle', checkTier: 'responsive' }
const POLL_HTTP_GRACE_MS = 15_000
const MAX_TURN_MS = 10 * 60 * 1000

const MAX_ADVISORY_CARRY_COUNT = 20
const MAX_ADVISORY_CARRY_CHARS = 12_000

export function trimAdvisoryCarry(
  messages,
  { maxCount = MAX_ADVISORY_CARRY_COUNT, maxChars = MAX_ADVISORY_CARRY_CHARS } = {},
) {
  if (!Array.isArray(messages) || messages.length === 0) return { kept: [], dropped: 0 }
  const kept = []
  let chars = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    const len = typeof m?.content === 'string' ? m.content.length : 0
    if (kept.length >= maxCount) break
    if (chars + len > maxChars && kept.length > 0) break
    kept.unshift(m)
    chars += len
  }
  return { kept, dropped: messages.length - kept.length }
}

function turnMarkerPath(connectionId, dir = CONNECTIONS_DIR) {
  return path.join(dir, `${connectionId}.turn`)
}

function readTurnMarker(connectionId, dir = CONNECTIONS_DIR) {
  try {
    const p = turnMarkerPath(connectionId, dir)
    const m = readPrivateJson(p)
    return typeof m?.startedAt === 'number' ? m : null
  } catch {
    return null
  }
}

function writeTurnMarker(connectionId, extra = { remoteTurn: true }) {
  if (!connectionId) return
  writeTurnMarkerWithExtra(connectionId, extra, CONNECTIONS_DIR)
}

function clearTurnMarker(connectionId, dir = CONNECTIONS_DIR) {
  if (!connectionId) return
  try {
    fs.rmSync(turnMarkerPath(connectionId, dir), { force: true })
  } catch {
    /* ignore */
  }
}

export function isNoWorkingAttemptRefusal(err) {
  const message = err instanceof Error ? err.message : String(err ?? '')
  return /No working attempt to keep alive/i.test(message)
}

export function isTurnMarkerActive(marker, now = Date.now(), maxTurnMs = MAX_TURN_MS) {
  if (!marker || typeof marker.startedAt !== 'number') return false
  const lastActiveAt = Math.max(
    marker.startedAt,
    typeof marker.lastToolAt === 'number' ? marker.lastToolAt : 0,
  )
  return now - lastActiveAt < maxTurnMs
}

export function hasPostReplyToolActivity(marker, now = Date.now(), windowMs = 30_000) {
  if (!marker || typeof marker.lastToolAt !== 'number') return false
  if (now - marker.lastToolAt > windowMs) return false
  if (typeof marker.lastReplyAt === 'number' && marker.lastToolAt <= marker.lastReplyAt) {
    return false
  }
  return true
}

function ownerAlive(pid) {
  return pidIsAlive(pid)
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

function connectionStatePath(connectionId, dir = CONNECTIONS_DIR) {
  return path.join(dir, `${connectionId}.json`)
}

function readStateResult(connectionId, { dir = CONNECTIONS_DIR, legacyPath = LEGACY_STATE_PATH } = {}) {
  if (connectionId) {
    const own = readPrivateJsonResult(connectionStatePath(connectionId, dir))
    if (own.status !== STATE_ABSENT) return own
  }
  const legacy = readPrivateJsonResult(legacyPath)
  if (legacy.status !== STATE_OK) return { status: STATE_ABSENT, value: null }
  if (
    connectionId &&
    legacy.value?.connection_id &&
    legacy.value.connection_id !== connectionId
  ) {
    return { status: STATE_ABSENT, value: null }
  }
  return legacy
}

function readState(connectionId) {
  const result = readStateResult(connectionId)
  return result.status === STATE_OK ? result.value : null
}

export function patchConnectionState(connectionId, patch, paths = {}) {
  const current = readStateResult(connectionId, paths)
  if (current.status === STATE_UNREADABLE) {
    process.stderr.write(
      `devspec-remote-poll: state unreadable for ${connectionId} — patch skipped to preserve the bond\n`,
    )
    return false
  }
  const next = {
    ...(current.value ?? {}),
    ...patch,
    connection_id: connectionId,
    updated_at: new Date().toISOString(),
  }
  writeState(next, connectionId, paths)
  return true
}

function writeState(state, connectionId, { dir = CONNECTIONS_DIR, legacyPath = LEGACY_STATE_PATH } = {}) {
  const cid = connectionId || state.connection_id
  const targets = []
  if (cid) targets.push(connectionStatePath(cid, dir))
  const legacy = readPrivateJsonResult(legacyPath)
  if (
    legacy.status === STATE_ABSENT ||
    (legacy.status === STATE_OK &&
      (!legacy.value?.connection_id || legacy.value.connection_id === cid))
  ) {
    targets.push(legacyPath)
  }
  for (const p of targets) writePrivateJson(p, state)
}

export function materialiseMessageAttachments(connectionId, messages, writeFile = defaultWriteFile) {
  if (!Array.isArray(messages) || messages.length === 0) return []
  return materialiseBatchAttachments(messages, { dir: attachmentDirFor(connectionId), writeFile })
}

export function materialiseContextAttachments(connectionId, context, writeFile = defaultWriteFile) {
  if (!context || typeof context !== 'object') return context
  const ownerAmbient = Array.isArray(context.owner_ambient) ? context.owner_ambient : null
  const roomContext = Array.isArray(context.room_context) ? context.room_context : null
  if (!ownerAmbient?.length && !roomContext?.length) return context
  return {
    ...context,
    ...(ownerAmbient
      ? { owner_ambient: materialiseMessageAttachments(connectionId, ownerAmbient, writeFile) }
      : {}),
    ...(roomContext
      ? { room_context: materialiseMessageAttachments(connectionId, roomContext, writeFile) }
      : {}),
  }
}

const UUID_PATTERN =
  /^(?:00000000-0000-0000-0000-000000000000|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i

export function validateAutomationRunDispatch(dispatch, connectionId) {
  if (!dispatch || typeof dispatch !== 'object' || Array.isArray(dispatch)) {
    return { ok: false, error: 'dispatch is not an object' }
  }
  const required = [
    'id', 'kind', 'run_id', 'automation_id', 'automation_name', 'trigger_kind', 'owner',
    'permission', 'queued_at', 'delivery_connection_id', 'requester',
  ]
  if (Object.keys(dispatch).length !== required.length || required.some((key) => !Object.hasOwn(dispatch, key))) {
    return { ok: false, error: 'dispatch does not exactly match automation_run' }
  }
  const owner = dispatch.owner
  const pressed = dispatch.trigger_kind === 'pressed'
  const requesterOk = pressed
    ? Boolean(
        dispatch.requester && typeof dispatch.requester === 'object' && !Array.isArray(dispatch.requester) &&
        Object.keys(dispatch.requester).length === 1 &&
        typeof dispatch.requester.user_id === 'string' && UUID_PATTERN.test(dispatch.requester.user_id),
      )
    : dispatch.requester === null
  const valid =
    dispatch.kind === 'automation_run' &&
    typeof dispatch.id === 'string' && UUID_PATTERN.test(dispatch.id) &&
    dispatch.run_id === dispatch.id &&
    typeof dispatch.automation_id === 'string' && UUID_PATTERN.test(dispatch.automation_id) &&
    typeof dispatch.automation_name === 'string' && dispatch.automation_name.length > 0 &&
    ['scheduled', 'event', 'pressed'].includes(dispatch.trigger_kind) &&
    owner && typeof owner === 'object' && !Array.isArray(owner) &&
    Object.keys(owner).length === 2 &&
    typeof owner.user_id === 'string' && UUID_PATTERN.test(owner.user_id) &&
    typeof owner.display_name === 'string' && owner.display_name.length > 0 &&
    ['look_only', 'can_commit', 'can_push'].includes(dispatch.permission) &&
    dispatch.delivery_connection_id === connectionId &&
    typeof dispatch.queued_at === 'string' && !Number.isNaN(Date.parse(dispatch.queued_at)) &&
    requesterOk
  return valid
    ? { ok: true, dispatch }
    : { ok: false, error: 'invalid or misaddressed automation_run dispatch' }
}

/** Rebuild crash-safe delivery identity from newline-terminated durable records only. */
export function scanPersistedInboxRecords(text, activeSessionId = undefined) {
  void activeSessionId
  const index = {
    envelopeIds: new Set(),
    commandMessageIds: new Set(),
    controlIds: new Set(),
    systemNoticeIds: new Set(),
    dispatchIds: new Set(),
    interactionEventIds: scanPersistedInteractionEventIds(text),
    queuedInteractionEventIds: scanQueuedInteractionEventIds(text),
  }
  const persisted = String(text || '')
  const finalNewline = persisted.lastIndexOf('\n')
  const completeRecords = finalNewline === -1 ? '' : persisted.slice(0, finalNewline)
  for (const line of completeRecords.split('\n')) {
    if (!line.trim()) continue
    try {
      const record = JSON.parse(line)
      if (typeof record?.ingress?.envelope_id === 'string') {
        index.envelopeIds.add(record.ingress.envelope_id)
      }
      if (record?.type === 'canonical_commands') {
        const ids = Array.isArray(record.execute_message_ids)
          ? record.execute_message_ids
          : Array.isArray(record.ingress?.commands)
            ? record.ingress.commands.map((command) => command?.message_id)
            : []
        for (const id of ids) if (typeof id === 'string') index.commandMessageIds.add(id)
      }
      if (record?.type === 'canonical_control' && typeof record.ingress?.control?.id === 'string') {
        index.controlIds.add(record.ingress.control.id)
      }
      if (record?.type === 'canonical_system_notices') {
        const ids = Array.isArray(record.execute_notice_ids)
          ? record.execute_notice_ids
          : Array.isArray(record.ingress?.system_notices)
            ? record.ingress.system_notices.map((notice) => notice?.notice_id)
            : []
        for (const id of ids) if (typeof id === 'string') index.systemNoticeIds.add(id)
      }
      if (record?.type === 'automation_run' && typeof record.dispatch?.id === 'string') {
        index.dispatchIds.add(record.dispatch.id)
      }
    } catch {
      /* incomplete/garbage lines carry no durable identity */
    }
  }
  return index
}

function readInboxDeliveryIndex(connectionId, activeSessionId = undefined) {
  try {
    return scanPersistedInboxRecords(
      fs.readFileSync(inboxPathForConnection(connectionId), 'utf8'),
      activeSessionId,
    )
  } catch {
    return scanPersistedInboxRecords('', activeSessionId)
  }
}

function truncateInterruptedJsonlTail(fd) {
  const size = fs.fstatSync(fd).size
  if (size === 0) return

  const lastByte = Buffer.allocUnsafe(1)
  fs.readSync(fd, lastByte, 0, 1, size - 1)
  if (lastByte[0] === 0x0a) return

  const chunk = Buffer.allocUnsafe(Math.min(size, 64 * 1024))
  let end = size
  while (end > 0) {
    const start = Math.max(0, end - chunk.length)
    const length = end - start
    fs.readSync(fd, chunk, 0, length, start)
    const newline = chunk.lastIndexOf(0x0a, length - 1)
    if (newline !== -1) {
      fs.ftruncateSync(fd, start + newline + 1)
      return
    }
    end = start
  }
  fs.ftruncateSync(fd, 0)
}

export function appendDurableRecord(connectionId, record, dir = CONNECTIONS_DIR) {
  let fd
  try {
    ensurePrivateDir(dir)
    const inbox = path.join(dir, `${connectionId}.inbox.jsonl`)
    fd = fs.openSync(inbox, 'a+', 0o600)
    truncateInterruptedJsonlTail(fd)
    fs.writeFileSync(fd, JSON.stringify(record) + '\n', 'utf8')
    fs.closeSync(fd)
    fd = undefined
    return true
  } catch (e) {
    process.stderr.write(`devspec-remote-poll: inbox write failed: ${e.message}\n`)
    return false
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        /* preserve original write failure */
      }
    }
  }
}

export function appendCanonicalInbox(
  connectionId,
  ingress,
  index,
  {
    sessionId = null,
    wakeContext = null,
    instructionContextFile = null,
    channel = 'context',
    questionHandoff = null,
    writeRecord = appendDurableRecord,
  } = {},
) {
  if (!connectionId || !ingress || !index) return { ok: false, appended: false }
  if (index.envelopeIds.has(ingress.envelope_id)) {
    return { ok: true, appended: false, duplicateEnvelope: true }
  }

  const executeMessageIds =
    channel === 'command'
      ? ingress.commands
          .map((command) => command.message_id)
          .filter((id) => !index.commandMessageIds.has(id))
      : []
  const systemNoticesSeen = index.systemNoticeIds instanceof Set ? index.systemNoticeIds : new Set()
  const executeNoticeIds =
    channel === 'system_notice' && Array.isArray(ingress.system_notices)
      ? ingress.system_notices
          .map((notice) => notice.notice_id)
          .filter((id) => !systemNoticesSeen.has(id))
      : []
  if (channel === 'command' && executeMessageIds.length === 0) {
    index.envelopeIds.add(ingress.envelope_id)
    return { ok: true, appended: false }
  }
  if (channel === 'control' && index.controlIds.has(ingress.control.id)) {
    index.envelopeIds.add(ingress.envelope_id)
    return { ok: true, appended: false }
  }
  if (channel === 'system_notice' && executeNoticeIds.length === 0) {
    index.envelopeIds.add(ingress.envelope_id)
    return { ok: true, appended: false }
  }

  const type =
    channel === 'command'
      ? 'canonical_commands'
      : channel === 'control'
        ? 'canonical_control'
        : channel === 'system_notice'
          ? 'canonical_system_notices'
          : 'canonical_context'
  const record = {
    type,
    connection_id: connectionId,
    session_id: sessionId,
    received_at: new Date().toISOString(),
    authoritative_source: REMOTE_INGRESS_RESOURCE_URI,
    ingress,
    ...(channel === 'command' ? { execute_message_ids: executeMessageIds } : {}),
    ...(channel === 'system_notice' ? { execute_notice_ids: executeNoticeIds } : {}),
    ...(channel === 'command' && wakeContext ? { wake_context: wakeContext } : {}),
    ...(channel === 'command' && instructionContextFile
      ? { instruction_context_file: instructionContextFile }
      : {}),
    ...(channel === 'command' &&
    questionHandoff &&
    executeMessageIds.includes(questionHandoff.source_message_id)
      ? { question_handoff: questionHandoff }
      : {}),
  }
  if (!writeRecord(connectionId, record)) return { ok: false, appended: false }
  index.envelopeIds.add(ingress.envelope_id)
  for (const id of executeMessageIds) index.commandMessageIds.add(id)
  if (channel === 'control') index.controlIds.add(ingress.control.id)
  if (channel === 'system_notice' && index.systemNoticeIds instanceof Set) {
    for (const id of executeNoticeIds) index.systemNoticeIds.add(id)
  }
  return {
    ok: true,
    appended: true,
    executeMessageIds,
    ...(channel === 'system_notice' ? { executeNoticeIds } : {}),
    handedOff: Object.hasOwn(record, 'question_handoff'),
  }
}

export function appendAutomationDispatches(
  connectionId,
  dispatches,
  dispatchCursor,
  index,
  sessionId,
  writeRecord = appendDurableRecord,
) {
  const validated = []
  for (const offered of Array.isArray(dispatches) ? dispatches : []) {
    const parsed = validateAutomationRunDispatch(offered, connectionId)
    if (!parsed.ok) return { ok: false, appended: 0, error: parsed.error }
    validated.push(parsed.dispatch)
  }
  let appended = 0
  for (const dispatch of validated) {
    if (index.dispatchIds.has(dispatch.id)) continue
    const record = {
      type: 'automation_run',
      connection_id: connectionId,
      session_id: sessionId,
      received_at: new Date().toISOString(),
      dispatch_cursor: dispatchCursor,
      dispatch,
    }
    if (!writeRecord(connectionId, record)) {
      return { ok: false, appended, error: 'automation inbox persistence failed' }
    }
    index.dispatchIds.add(dispatch.id)
    appended++
  }
  return { ok: true, appended }
}

export function disabledStatePatch(reason) {
  return {
    enabled: false,
    ended_from_ui: reason === 'ui' || reason === 'ended_from_ui',
    end_reason: reason,
  }
}

export function disabledLocalConnectionState(
  currentState,
  { connectionId, reason, now = new Date().toISOString() },
) {
  const s = stripConnectionCapabilityFields({ ...(currentState || {}) })
  s.enabled = false
  s.ended_from_ui = reason === 'ui' || reason === 'ended_from_ui'
  s.end_reason = reason
  s.connection_id = connectionId
  s.updated_at = now
  return s
}

export function disableLocalState({
  connectionId,
  reason,
  dir = CONNECTIONS_DIR,
  legacyPath = LEGACY_STATE_PATH,
  localDir = path.join(path.dirname(dir), 'local'),
} = {}) {
  try {
    const current = readStateResult(connectionId, { dir, legacyPath }).value
    const s = disabledLocalConnectionState(current, { connectionId, reason })
    writeState(s, connectionId, { dir, legacyPath })
    markBondsStoppedForConnection(connectionId, reason, {
      localDir,
      endedFromUi: s.ended_from_ui === true,
      now: s.updated_at,
    })
    return s
  } catch (e) {
    process.stderr.write(`devspec-remote-poll: failed to disable state: ${e.message}\n`)
    return null
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

export function cadenceFor({ attached = false, turnActive = false } = {}) {
  return attached || turnActive ? ATTENDED_CADENCE : IDLE_CADENCE
}

export function pollCursorArguments({ liveCursorV2, legacyCursor, catchUpCursor, needsSeed } = {}) {
  return {
    ...(liveCursorV2 ? { cursor_v2: liveCursorV2 } : legacyCursor ? { cursor: legacyCursor } : {}),
    ...(catchUpCursor ? { catch_up_cursor: catchUpCursor } : {}),
    ...(needsSeed || catchUpCursor ? { catch_up: true } : {}),
  }
}

export function advancePollCursors(
  current,
  response,
  ingress,
  { drainingContinuation = false } = {},
) {
  const liveCursorV2 =
    !drainingContinuation && typeof response?.cursor_v2 === 'string' && response.cursor_v2
      ? response.cursor_v2
      : current.liveCursorV2
  const legacyCursor =
    typeof response?.cursor === 'string' && response.cursor ? response.cursor : current.legacyCursor
  const catchUpCursor =
    ingress?.window?.omission_reason === 'delivery_retry'
      ? current.catchUpCursor ?? null
      : ingress?.window?.has_more === true && ingress.window.next_cursor
        ? ingress.window.next_cursor
        : null
  return { liveCursorV2, legacyCursor, catchUpCursor }
}

export function isCatchUpCursorRefusal(err) {
  const message = err instanceof Error ? err.message : String(err ?? '')
  return /catch_up_cursor has the wrong direction|catch_up_cursor requires catch_up/i.test(message)
}

export function roomChangesSince(res, activity, seen = {}) {
  const plans = res?.ingress?.active_session_plans
  const current = {
    session_polls: isSessionPollsProjection(res?.session_polls)
      ? JSON.stringify(res.session_polls)
      : null,
    still_to_discuss: isStillToDiscussProjectionV1(res?.still_to_discuss)
      ? JSON.stringify(res.still_to_discuss)
      : null,
    active_session_plans: isActiveSessionPlansProjectionV1(plans) ? JSON.stringify(plans) : null,
    session_activity: activity
      ? JSON.stringify({ items: activity.items, events: activity.events.length })
      : null,
  }
  return {
    changed: Object.keys(current).filter((section) => current[section] !== (seen[section] ?? null)),
    seen: current,
  }
}

export function commandWakeContext(
  store,
  ingress,
  { connectionId, roomChanged = [], dir = CONNECTIONS_DIR } = {},
) {
  void ingress
  const hasCopy = Boolean(store && (store.rows.size > 0 || transcriptHasHistory(store)))
  return {
    transcript: hasCopy ? transcriptPaths(store.connectionId, store.sessionId, dir).transcript : null,
    room_state: roomStatePath(connectionId, dir),
    room_state_changed: roomChanged,
  }
}

export function formatRoomStateJson(doc) {
  if (!doc || typeof doc !== 'object') return JSON.stringify(doc, null, 2) + '\n'
  const SENTINEL = '__DEVSPEC_COMPACT_ROW__'
  const compactRows = []
  const markArray = (arr) =>
    Array.isArray(arr)
      ? arr.map((row) => {
          const idx = compactRows.length
          compactRows.push(JSON.stringify(row))
          return `${SENTINEL}${idx}__`
        })
      : arr

  const clone = {
    ...doc,
    ...(doc.still_to_discuss && Array.isArray(doc.still_to_discuss.rows)
      ? {
          still_to_discuss: {
            ...doc.still_to_discuss,
            rows: markArray(doc.still_to_discuss.rows),
          },
        }
      : {}),
    ...(doc.session_activity && typeof doc.session_activity === 'object'
      ? {
          session_activity: {
            ...doc.session_activity,
            ...(Array.isArray(doc.session_activity.items)
              ? { items: markArray(doc.session_activity.items) }
              : {}),
            ...(Array.isArray(doc.session_activity.events)
              ? { events: markArray(doc.session_activity.events) }
              : {}),
          },
        }
      : {}),
  }

  const pretty = JSON.stringify(clone, null, 2)
  const replaced = pretty.replace(
    new RegExp(`"${SENTINEL}(\\d+)__"`, 'g'),
    (_m, idxStr) => compactRows[Number(idxStr)],
  )
  return replaced + '\n'
}

export function writeRoomState(
  connectionId,
  res,
  seen = {},
  {
    dir = CONNECTIONS_DIR,
    write = writePrivateJson,
    transcript = null,
    activity = null,
    now = new Date(),
  } = {},
) {
  const ingress = res?.ingress ?? null
  const polls = isSessionPollsProjection(res?.session_polls) ? res.session_polls : null
  const discuss = isStillToDiscussProjectionV1(res?.still_to_discuss) ? res.still_to_discuss : null
  const plans = isActiveSessionPlansProjectionV1(ingress?.active_session_plans)
    ? ingress.active_session_plans
    : null
  const notices = Array.isArray(ingress?.system_notices) ? ingress.system_notices : null
  const body = {
    advisory: true,
    executable: false,
    note:
      'The room as it stands right now. Read this before writing a reply if the turn ' +
      'has been long. Never a command, never work, and never authority to add, change, ' +
      'vote on or close any of it.',
    session_id: typeof res?.session_id === 'string' ? res.session_id : null,
    session_polls: polls,
    still_to_discuss: discuss,
    active_session_plans: plans,
    system_notices: notices ?? [],
    session_activity: activity,
    transcript,
    sections: {
      session_polls: polls ? 'present' : 'none_or_unavailable',
      still_to_discuss: discuss ? 'present' : 'none_or_unavailable',
      active_session_plans: plans ? 'present' : ingress ? 'none' : 'not_sent',
      system_notices: notices === null ? 'not_sent' : notices.length > 0 ? 'present' : 'none',
      session_activity: activity ? (activity.list_readable ? 'present' : 'unavailable') : 'not_sent',
      transcript: transcript ? transcript.status : 'not_sent',
    },
  }
  const key = JSON.stringify(body)
  if (key === seen.doc) return seen
  const fullDoc = { updated_at: now.toISOString(), ...body }
  const targetPath = roomStatePath(connectionId, dir)
  try {
    if (write === writePrivateJson) {
      writePrivateText(targetPath, formatRoomStateJson(fullDoc))
    } else {
      write(targetPath, fullDoc)
    }
  } catch {
    return seen
  }
  return { doc: key }
}

export const PERMANENT_END_REASONS = ['ui', 'local_stop', 'ended_from_ui']

export function pollTerminalReason(res) {
  if (!res || typeof res !== 'object') return null
  if (res.status !== 'not_found' && res.status !== 'ended') return null
  const reason = typeof res.end_reason === 'string' && res.end_reason ? res.end_reason : null
  return {
    reason,
    recoverable: !reason || !PERMANENT_END_REASONS.includes(reason),
    status: res.status,
  }
}

export const RECOVERABLE_TERMINAL_MAX = 10

export function emptyTurnBackoffMs(consecutive, maxMs) {
  if (!Number.isFinite(consecutive) || consecutive <= 0) return 0
  return Math.min(maxMs, 1_000 * 2 ** Math.min(consecutive - 1, 5))
}

export function errorBackoffMs(consecutive, { rateLimited = false } = {}) {
  const n = Math.max(1, Number.isFinite(consecutive) ? consecutive : 1)
  const base = rateLimited ? 5_000 : 2_000
  return Math.min(30_000, base * 2 ** Math.min(n - 1, 4))
}

export function unansweredCommands(commands, roomContext) {
  const cmds = Array.isArray(commands) ? commands : []
  const room = Array.isArray(roomContext) ? roomContext : []
  let lastReplyAt = null
  for (const m of room) {
    const isReply = m?.message_type === 'external_agent' || m?.author?.kind === 'external_agent'
    if (!isReply || typeof m?.created_at !== 'string') continue
    if (!lastReplyAt || m.created_at > lastReplyAt) lastReplyAt = m.created_at
  }
  if (!lastReplyAt) return cmds
  return cmds.filter((c) => typeof c?.created_at === 'string' && c.created_at > lastReplyAt)
}

export function shouldTreatWindowAsHistory(res, pending = false) {
  if (pending === true) return true
  return !!res && res.reseed === true
}

export function splitRoomWindow({ commands, ownerAmbient, roomContext, seed = false } = {}) {
  const cmds = Array.isArray(commands) ? commands : []
  const ambient = Array.isArray(ownerAmbient) ? ownerAmbient : []
  const room = Array.isArray(roomContext) ? roomContext : []
  return {
    wake: seed ? unansweredCommands(cmds, room) : cmds,
    advisory: [...ambient, ...room],
  }
}

export function verbForTurnTransition(prev, next) {
  if (!prev && next) return 'pickup'
  if (prev && next) return 'keepalive'
  if (prev && !next) return 'complete'
  return null
}

const ACTIVITY_VERB_TOOL = {
  pickup: 'report_pickup',
  keepalive: 'report_keepalive',
  complete: 'report_complete',
}

export function resolveServerAttachment(currentSessionId, hb) {
  if (!hb || typeof hb !== 'object' || hb.status === 'not_found') {
    return { sessionId: currentSessionId, changed: false }
  }
  const hbSession = typeof hb.session_id === 'string' && hb.session_id ? hb.session_id : null
  return { sessionId: hbSession, changed: hbSession !== currentSessionId }
}

export function installStopSignalHandlers(proc = process) {
  proc.once('SIGTERM', () => proc.exit(0))
  proc.once('SIGINT', () => proc.exit(0))
}

export function installExitAudit(proc = process, write = null) {
  const emit =
    write ||
    ((line) => {
      try {
        proc.stderr.write(line)
      } catch {
        /* ignore */
      }
    })
  proc.on('exit', (code) => {
    emit(`devspec-remote-poll: exiting code=${code} pid=${proc.pid} at=${new Date().toISOString()}\n`)
  })
}

export const ACCEPTED_COMMAND_AUTHORITIES = new Set(['owner', 'delegated'])

export function hasValidCommandProjectScope(msg) {
  if (!msg || typeof msg !== 'object') return false
  if (!ACCEPTED_COMMAND_AUTHORITIES.has(msg.authority?.kind)) return false
  return (
    Object.hasOwn(msg, 'project_scope') &&
    isRemoteCommandProjectScope(msg.project_scope, msg.authority.kind)
  )
}

export function isDeliverableCommand(msg, connectionId) {
  if (!msg || typeof msg !== 'object' || !connectionId) return false
  if (msg.addressed_to?.connection_id !== connectionId) return false
  return hasValidCommandProjectScope(msg)
}

/**
 * Legacy helper retained for unit test compatibility (`devspec-remote-poll.test.mjs`).
 */
export function buildPollConnectionArguments({
  connectionId,
  agentName,
  waitMs,
  cursor = null,
  cursorV2 = null,
  dispatchCursor = null,
  busy = null,
  checkTier = null,
  catchUp = false,
  agentStats = null,
} = {}) {
  return {
    connection_id: connectionId,
    agent_name: agentName,
    wait_ms: waitMs,
    ingress_version: REMOTE_INGRESS_VERSION,
    delegated_scope_version: DELEGATED_SCOPE_VERSION,
    active_plan_projection_version: ACTIVE_PLAN_PROJECTION_VERSION,
    ...(cursorV2 ? { cursor_v2: cursorV2 } : {}),
    ...(cursor ? { cursor } : {}),
    ...(dispatchCursor ? { dispatch_cursor: dispatchCursor } : {}),
    ...(busy !== null && busy !== undefined ? { busy } : {}),
    ...(checkTier ? { check_tier: checkTier } : {}),
    ...(catchUp ? { catch_up: true } : {}),
    ...(agentStats ? { agent_stats: agentStats } : {}),
  }
}

/**
 * Legacy helper retained for unit test compatibility (`devspec-remote-poll.test.mjs`).
 */
export function normalizePollDelivery(res, connectionId) {
  if (!res || typeof res !== 'object') return { ok: false, error: 'empty poll response' }
  if (res.changed !== true) return { ok: true, changed: false, commands: [], context: [], activeSessionPlans: null }
  const normalized = normalizeRemoteIngressV1(res, connectionId)
  if (!normalized.ok) return normalized
  const env = normalized.envelope
  const carry = mergeCanonicalContextCarry(emptyCanonicalContextCarry(), env)
  const context = Object.values(carry.context).flat()
  return {
    ok: true,
    changed: true,
    envelope: env,
    commands: normalized.commands,
    context,
    activeSessionPlans: env.active_session_plans ?? null,
  }
}

export function automationRunCommandText(d, connectionId = null) {
  const connId = connectionId || d?.delivery_connection_id || '<your_connection_id>'
  const permission =
    d.permission === 'can_push'
      ? 'You MAY edit, commit and push.'
      : d.permission === 'can_commit'
        ? 'You MAY edit and commit locally, but MUST NOT push.'
        : 'This automation is LOOK ONLY — investigate and report, do not edit, commit or push anything.'

  return [
    `▶️ Automation run dispatched to this connection: "${d.automation_name}" (run ${d.run_id}).`,
    d.trigger_kind === 'pressed'
      ? 'Someone pressed Run.'
      : d.trigger_kind === 'scheduled'
        ? 'This run started on a schedule.'
        : 'This run started because of an event.',
    `Owner: ${d.owner?.display_name || 'the owner'}`,
    '',
    'What to do:',
    `1. claim_automation_run({ run_id: "${d.run_id}", connection_id: "${connId}", provider: "antigravity" }) — always pass connection_id and provider (and model if the automation names one). If claimed:false the run was already taken by another of your agents, which is normal; stop there.`,
    '2. Follow the instruction returned by that claim, in this repo.',
    `3. record_automation_run({ run_id: "${d.run_id}", connection_id: "${connId}", ... }) — report status, a verdict for EACH acceptance criterion WITH evidence, and whatever the run produced as artifacts.`,
    '',
    `Permission: ${permission}`,
  ].join('\n')
}

// ---------------------------------------------------------------------------
// SSE Push Channel (parity with Pi push-channel.ts, falls back to poll_connection)
// ---------------------------------------------------------------------------

export const PUSH_RECONNECT_BACKOFF_MS = [1_000, 4_000, 10_000]
export const PUSH_HEALTHY_MS = 30_000

export function nextPushReconnectDelayMs({ attempt, openedAtMs, nowMs = Date.now() }) {
  const effectiveAttempt =
    openedAtMs !== null && openedAtMs !== undefined && nowMs - openedAtMs >= PUSH_HEALTHY_MS
      ? 0
      : attempt
  if (effectiveAttempt >= PUSH_RECONNECT_BACKOFF_MS.length) {
    return { delayMs: null, nextAttempt: effectiveAttempt + 1 }
  }
  return {
    delayMs: PUSH_RECONNECT_BACKOFF_MS[effectiveAttempt],
    nextAttempt: effectiveAttempt + 1,
  }
}

export function pushChannelUrl(mcpUrl, connectionId, options = {}) {
  const base = String(mcpUrl || '').replace(/\/$/, '')
  const params = new URLSearchParams({
    connection_id: String(connectionId || ''),
    system_notice_version: String(options.systemNoticeVersion ?? 1),
    interaction_event_version: String(options.interactionEventVersion ?? 1),
    question_dismissal_event_version: String(options.questionDismissalEventVersion ?? 1),
  })
  return `${base}/connection-stream?${params.toString()}`
}

export function parseSseFrame(block) {
  let eventName = 'message'
  const dataLines = []
  let sawComment = false

  for (const rawLine of String(block || '').split(/\r?\n/)) {
    if (!rawLine) continue
    if (rawLine.startsWith(':')) {
      sawComment = true
      continue
    }
    const colon = rawLine.indexOf(':')
    const field = colon === -1 ? rawLine : rawLine.slice(0, colon)
    let value = colon === -1 ? '' : rawLine.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') eventName = value
    else if (field === 'data') dataLines.push(value)
  }

  if (dataLines.length === 0 && sawComment) {
    return { kind: 'comment' }
  }
  const data = dataLines.join('\n')
  if (eventName === 'hello') return { kind: 'hello' }
  if (eventName === 'wake') return { kind: 'wake' }
  if (eventName === 'ended') {
    try {
      const parsed = data ? JSON.parse(data) : {}
      return {
        kind: 'ended',
        endReason: typeof parsed.end_reason === 'string' ? parsed.end_reason : null,
      }
    } catch {
      return { kind: 'ended', endReason: null }
    }
  }
  if (eventName === 'system_notice') {
    try {
      const parsed = data ? JSON.parse(data) : null
      return parsed && typeof parsed === 'object' ? { kind: 'system_notice', notice: parsed } : null
    } catch {
      return null
    }
  }
  if (eventName === 'interaction_event') {
    try {
      const parsed = data ? JSON.parse(data) : null
      return parsed && typeof parsed === 'object' ? { kind: 'interaction_event', event: parsed } : null
    } catch {
      return null
    }
  }
  if (eventName === 'question_dismissal_event') {
    try {
      const parsed = data ? JSON.parse(data) : null
      return parsed && typeof parsed === 'object'
        ? { kind: 'question_dismissal_event', event: parsed }
        : null
    } catch {
      return null
    }
  }
  return null
}

export function openPushChannel({
  mcpUrl,
  token,
  connectionId,
  connectionCapability = null,
  onEvent,
  onFallback,
  fetchImpl = fetch,
}) {
  let closed = false
  let controller = null
  let reconnectTimer = null
  let attempt = 0

  const stop = () => {
    closed = true
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    if (controller) {
      controller.abort()
      controller = null
    }
  }

  const scheduleReconnect = (openedAtMs, reason) => {
    if (closed) return
    const { delayMs, nextAttempt } = nextPushReconnectDelayMs({ attempt, openedAtMs })
    attempt = nextAttempt
    if (delayMs === null) {
      onFallback?.(`push_reconnect_exhausted:${reason}`)
      return
    }
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      void connect()
    }, delayMs)
  }

  const connect = async () => {
    if (closed) return
    controller = new AbortController()
    let openedAtMs = null
    try {
      const res = await fetchImpl(pushChannelUrl(mcpUrl, connectionId), {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'text/event-stream',
          ...pluginHeaders(),
          ...(connectionCapability ? { 'x-devspec-connection-capability': connectionCapability } : {}),
        },
        signal: controller.signal,
      })
      const contentType = res.headers?.get?.('content-type') || ''
      if (!res.ok || !contentType.includes('text/event-stream') || !res.body) {
        onFallback?.(`push_http_${res.status}`)
        return
      }
      openedAtMs = Date.now()
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (!closed) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let sep = buffer.indexOf('\n\n')
        while (sep !== -1) {
          const rawFrame = buffer.slice(0, sep)
          buffer = buffer.slice(sep + 2)
          const parsed = parseSseFrame(rawFrame)
          if (parsed && parsed.kind !== 'comment') {
            onEvent?.(parsed)
            if (parsed.kind === 'ended') {
              stop()
              return
            }
          }
          sep = buffer.indexOf('\n\n')
        }
      }
      if (!closed) {
        scheduleReconnect(openedAtMs, 'eof')
      }
    } catch (err) {
      if (closed) return
      const msg = err instanceof Error ? err.message : String(err)
      scheduleReconnect(openedAtMs, msg)
    }
  }

  void connect()
  return { close: stop }
}

// ---------------------------------------------------------------------------
// Antigravity transcript.jsonl Trail Extraction (`work_trail` & `trail_events`)
// ---------------------------------------------------------------------------

export {
  extractAntigravityTrailFromTranscript,
  isRemotePlumbingToolCall,
  isSessionReplyToolCall,
  summarizeThinkingText,
}

/**
 * Helper retained for unit tests (`devspec-remote-poll.test.mjs`).
 * NOTE: Not called inside the 2s poller loop so that turns that end without an
 * explicit `post_session_message` never leave an empty `phase: 'trail'` streaming
 * row on the server that gets sealed as `"No response"`. Instead, `work_trail` and
 * `trail_events` are attached directly to the final `post_session_message` call.
 */
export async function streamTurnTrailIfChanged({
  transcriptPath,
  sinceMs = null,
  sessionId,
  connectionId,
  mcpUrl,
  token,
  prevSignature = '',
  callMcp = mcpToolsCall,
} = {}) {
  if (!transcriptPath || !sessionId || !connectionId || !fs.existsSync(transcriptPath)) {
    return { posted: false, signature: prevSignature, events: [], markdown: '' }
  }
  if (fs.existsSync(explicitReplyMarkerPath(connectionId))) {
    return {
      posted: false,
      skipped: 'reply_already_posted',
      signature: prevSignature,
      events: [],
      markdown: '',
    }
  }
  let raw = ''
  try {
    raw = fs.readFileSync(transcriptPath, 'utf8')
  } catch {
    return { posted: false, signature: prevSignature, events: [], markdown: '' }
  }
  const { events, markdown, signature, replyPosted } = extractAntigravityTrailFromTranscript(raw, {
    sinceMs,
  })
  if (replyPosted) {
    return {
      posted: false,
      skipped: 'reply_already_posted',
      signature: prevSignature,
      events,
      markdown,
    }
  }
  if (events.length === 0 || !markdown || signature === prevSignature) {
    return { posted: false, signature: prevSignature, events, markdown }
  }
  await callMcp({
    mcpUrl,
    token,
    name: 'post_session_message',
    arguments: {
      session_id: sessionId,
      connection_id: connectionId,
      phase: 'trail',
      message: markdown,
      trail_events: events,
    },
    timeoutMs: 10_000,
  })
  return { posted: true, signature, events, markdown }
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
  mcpUrl = mcpUrl || 'https://api.devspec.ai/api/mcp'
  const agentName = AGENT_NAME
  let connectionCapability = state?.connection_capability || null

  let sessionId =
    (typeof args.session === 'string' && args.session.length >= 8 ? args.session : null) ||
    state?.session_id ||
    null

  const ownerPidRaw = Number.parseInt(String(args.ownerPid ?? state?.owner_pid ?? ''), 10)
  const ownerPid = Number.isInteger(ownerPidRaw) && ownerPidRaw > 1 ? ownerPidRaw : null
  const ownerAnchor = ownerPid && ownerAlive(ownerPid) ? ownerPid : null
  if (ownerPid && !ownerAnchor) {
    process.stderr.write(
      `devspec-remote-poll: owner-pid ${ownerPid} not alive at startup — stopping\n`,
    )
    disableLocalState({ connectionId, reason: 'owner_gone' })
    process.exit(0)
  } else if (ownerAnchor) {
    process.stderr.write(`devspec-remote-poll: owner-pid anchor ${ownerAnchor} adopted\n`)
    try {
      patchConnectionState(connectionId, { owner_pid: ownerAnchor })
    } catch {
      /* non-fatal */
    }
  }

  async function sendHeartbeat({
    status,
    checkTier = null,
    busy = null,
    endReason = null,
    agentStats = undefined,
  }) {
    const telemetry = agentStats !== undefined ? agentStats : readConnectionTelemetry(connectionId)
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
        ...(telemetry ? { agent_stats: telemetry } : {}),
      },
      timeoutMs: 5_000,
    })
  }

  let interactionContinuation = null
  let pendingInteractionAck = null
  let pendingControlAck = null
  let speechAttachmentId = null
  let pendingCommandHandoff = null
  let sentCommandHandoff = null
  let lastSentHandoffKey = null
  let lastOfferHold = null

  function patchState(patch) {
    try {
      patchConnectionState(connectionId, patch)
    } catch {
      /* ignore */
    }
  }

  function forgetCommandHandoff() {
    pendingCommandHandoff = null
    sentCommandHandoff = null
  }

  function clearInteractionContinuation(reason) {
    if (!interactionContinuation) return
    process.stderr.write(`devspec-remote-poll: interaction continuation cleared (${reason})\n`)
    interactionContinuation = null
    patchState({ interaction_continuation: null })
  }

  async function keepaliveInteractionContinuation() {
    const held = interactionContinuation
    if (!held) return
    try {
      await mcpToolsCall({
        mcpUrl,
        token,
        connectionCapability,
        name: 'report_keepalive',
        arguments: {
          connection_id: connectionId,
          attempt_id: held.attempt_id,
          ...continuationIdentity(held),
        },
        timeoutMs: 10_000,
      })
    } catch (e) {
      process.stderr.write(
        `devspec-remote-poll: exact interaction keepalive failed: ${e.message}\n`,
      )
      if (/identity|not working|denied|authority/i.test(e.message || '')) {
        clearInteractionContinuation('keepalive_rejected')
      }
    }
  }

  let prevTurnActive = false

  async function emitActivityVerb(verb) {
    if (!verb) return
    const plan = interactionActivityPlan({ verb, continuation: interactionContinuation })
    if (plan.kind === 'suppress') return
    if (plan.kind === 'exact_keepalive') {
      await keepaliveInteractionContinuation()
      return
    }
    const name = ACTIVITY_VERB_TOOL[verb]
    if (!name) return
    try {
      await mcpToolsCall({
        mcpUrl,
        token,
        name,
        arguments: {
          connection_id: connectionId,
          ...(verb === 'complete' ? { reason: 'turn_marker_cleared' } : {}),
        },
        timeoutMs: 10_000,
      })
    } catch (e) {
      process.stderr.write(`devspec-remote-poll: activity verb ${verb} (${name}) failed: ${e.message}\n`)
      if (isNoWorkingAttemptRefusal(e)) {
        const currentMarker = readTurnMarker(connectionId)
        if (verb === 'keepalive' && hasPostReplyToolActivity(currentMarker)) {
          try {
            await mcpToolsCall({
              mcpUrl,
              token,
              name: 'report_pickup',
              arguments: { connection_id: connectionId },
              timeoutMs: 10_000,
            })
            process.stderr.write(
              'devspec-remote-poll: post-reply tool activity detected — re-opened working attempt via report_pickup\n',
            )
            return
          } catch (pickupErr) {
            process.stderr.write(
              `devspec-remote-poll: continuation report_pickup failed: ${pickupErr.message}\n`,
            )
          }
        }
        clearTurnMarker(connectionId)
        prevTurnActive = false
        process.stderr.write(
          'devspec-remote-poll: server reports no working attempt — clearing the stale turn marker\n',
        )
      }
    }
  }

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
  installStopSignalHandlers()
  installExitAudit()

  let legacyCursor = args.cursor || state?.cursor_after_message_id || null
  let liveCursorV2 = state?.cursor_v2 || state?.ingress_cursor_v2 || null
  let catchUpCursor = state?.catch_up_cursor || null
  let dispatchCursor = state?.dispatch_cursor || null
  const persistedInbox = readInboxDeliveryIndex(connectionId, sessionId)
  let lastTier = null
  let lastBusySent = null
  let roomAnnounced = {}
  let roomFileSeen = {}
  let transcriptStore = sessionId ? loadTranscriptStore(connectionId, sessionId) : null
  let redrainRequested = false
  let titleReadAt = 0
  let titleReadInFlight = false

  function refreshSessionTitle(liveState) {
    if (
      titleReadInFlight ||
      !sessionTitleReadDue({ sessionId, state: liveState, lastAttemptAt: titleReadAt })
    ) {
      return
    }
    const forSession = sessionId
    titleReadInFlight = true
    titleReadAt = Date.now()
    readSessionTitle({ call: mcpToolsCall, mcpUrl, token, sessionId: forSession })
      .then((title) => {
        if (title !== null && sessionId === forSession) {
          patchState({ session_title: title, session_title_for: forSession })
        }
      })
      .finally(() => {
        titleReadInFlight = false
      })
  }

  function considerCommandOffer(res) {
    let parsed
    try {
      parsed = parseCommandOfferResponse(res, {
        connectionId,
        sessionId,
        attachmentId: speechAttachmentId,
      })
    } catch (error) {
      process.stderr.write(`devspec-remote-poll: ignored command offer (${error.message})\n`)
      return false
    }
    if (!parsed.supported) return false
    if (parsed.stale && sentCommandHandoff) {
      process.stderr.write('devspec-remote-poll: command handoff was stale; waiting for a fresh offer\n')
      sentCommandHandoff = null
    }
    const decision = commandHandoffDecision({
      offer: parsed.offer,
      continuation: interactionContinuation,
      ackPending: pendingInteractionAck !== null,
      inboxByteOffset: readState(connectionId)?.inbox_byte_offset ?? null,
    })
    const hold =
      decision.action === 'wait' ? `${parsed.offer.source_message_id}:${decision.reason}` : null
    if (hold && hold !== lastOfferHold) {
      process.stderr.write(`devspec-remote-poll: command offer held (${decision.reason})\n`)
    }
    lastOfferHold = hold
    if (decision.action !== 'ready') return false
    pendingCommandHandoff = decision.ready
    return commandHandoffKey(decision.ready) !== lastSentHandoffKey
  }

  async function releaseUnappliedContinuation(event, attemptId) {
    try {
      await mcpToolsCall({
        mcpUrl,
        token,
        connectionCapability,
        name: 'report_complete',
        arguments: {
          connection_id: connectionId,
          attempt_id: attemptId,
          interaction_pre_persistence_failure: true,
          ...continuationIdentity(event),
        },
        timeoutMs: 10_000,
      })
    } catch (e) {
      process.stderr.write(
        `devspec-remote-poll: could not release unapplied interaction claim: ${e.message}\n`,
      )
    }
  }

  async function applyInteractionEvent(event) {
    const dismissalDisposition =
      event.kind === DISMISSAL_KIND
        ? persistedDismissalDisposition(
            fs.existsSync(inboxPathForConnection(connectionId))
              ? fs.readFileSync(inboxPathForConnection(connectionId), 'utf8')
              : '',
            event,
          )
        : null
    if (dismissalDisposition === 'conflict') return { delivered: false }
    if (
      dismissalDisposition === 'applied' ||
      (dismissalDisposition === null && persistedInbox.interactionEventIds.has(event.event_id))
    ) {
      pendingInteractionAck = questionEventAck(event)
      process.stderr.write(
        `devspec-remote-poll: interaction event ${event.event_id} already applied — acknowledging redelivery\n`,
      )
      return { delivered: false }
    }

    let start
    try {
      start = await mcpToolsCall({
        mcpUrl,
        token,
        connectionCapability,
        name: 'report_pickup',
        arguments: {
          connection_id: connectionId,
          ...questionEventStartVersion(event),
          ...continuationIdentity(event),
        },
        timeoutMs: 15_000,
      })
    } catch (e) {
      process.stderr.write(
        `devspec-remote-poll: interaction continuation start failed: ${e.message}\n`,
      )
      return { delivered: false }
    }

    const decision = classifyContinuationStart(start)
    if (
      event.kind === DISMISSAL_KIND &&
      decision.action === 'apply' &&
      (start.source_session_id !== event.source_session_id ||
        start.phase !== 'working' ||
        typeof start.idempotent !== 'boolean')
    ) {
      await releaseUnappliedContinuation(event, decision.attemptId)
      return { delivered: false }
    }
    if (event.kind === DISMISSAL_KIND && decision.action === 'settle') return { delivered: false }
    if (decision.action === 'wait') {
      process.stderr.write(
        `devspec-remote-poll: ${nowStamp()} interaction continuation not startable ` +
          `(${decision.outcome ?? 'unknown'}` +
          `${decision.error ? `: ${decision.error}` : ''}) — waiting for redelivery\n`,
      )
      const notice = queuedAnswerNotice({
        outcome: decision.outcome,
        event,
        appliedEventIds: persistedInbox.interactionEventIds,
        queuedEventIds: persistedInbox.queuedInteractionEventIds,
      })
      if (notice.notify) {
        const queuedRecord = interactionAnswerRecord({
          connectionId,
          sessionId: event.source_session_id,
          event,
          attemptId: null,
          disposition: QUEUED,
        })
        if (appendDurableRecord(connectionId, queuedRecord)) {
          persistedInbox.queuedInteractionEventIds.add(event.event_id)
          process.stderr.write(
            `devspec-remote-poll: ${nowStamp()} announced queued answer for question ` +
              `${event.question_id} (channel busy: ${decision.outcome})\n`,
          )
        }
      }
      return { delivered: false }
    }

    const record = interactionAnswerRecord({
      connectionId,
      sessionId: event.source_session_id,
      event,
      attemptId: decision.attemptId,
      disposition: decision.action === 'apply' ? DELIVERED : decision.disposition,
    })
    if (event.kind === DISMISSAL_KIND && decision.action === 'apply') {
      try {
        const current = readState(connectionId)
        if (
          current?.session_id !== event.source_session_id ||
          current?.connection_capability !== connectionCapability
        ) {
          throw new Error('dismissal source authority changed')
        }
        const inbox = inboxPathForConnection(connectionId)
        const text = fs.existsSync(inbox) ? fs.readFileSync(inbox, 'utf8') : ''
        const prefix = text.slice(0, text.lastIndexOf('\n') + 1)
        const held = {
          kind: DISMISSAL_KIND,
          event_id: event.event_id,
          question_id: event.question_id,
          claim_token: event.claim_token,
          attempt_id: decision.attemptId,
          connection_id: connectionId,
          session_id: event.source_session_id,
          started_at: new Date().toISOString(),
          inbox_offset_after: Buffer.byteLength(prefix + JSON.stringify(record) + '\n'),
        }
        if (!patchConnectionState(connectionId, { interaction_continuation: held })) {
          throw new Error('dismissal state not persisted')
        }
      } catch (error) {
        process.stderr.write(
          `devspec-remote-poll: dismissal persistence failed: ${error.message}\n`,
        )
        await releaseUnappliedContinuation(event, decision.attemptId)
        return { delivered: false }
      }
    }
    if (!appendDurableRecord(connectionId, record)) {
      if (event.kind === DISMISSAL_KIND) patchState({ interaction_continuation: null })
      if (decision.action === 'apply' && decision.attemptId) {
        await releaseUnappliedContinuation(event, decision.attemptId)
      }
      return { delivered: false }
    }
    persistedInbox.interactionEventIds.add(event.event_id)

    if (decision.action !== 'apply') {
      process.stderr.write(
        `devspec-remote-poll: interaction event ${event.event_id} settled (${decision.outcome})\n`,
      )
      return { delivered: false }
    }

    interactionContinuation = {
      event_id: event.event_id,
      ...(event.kind === DISMISSAL_KIND
        ? { kind: DISMISSAL_KIND }
        : { response_id: event.response_id }),
      claim_token: event.claim_token,
      question_id: event.question_id,
      attempt_id: decision.attemptId,
      connection_id: connectionId,
      session_id: event.source_session_id,
      started_at: new Date().toISOString(),
      inbox_offset_after: inboxSizeFor(connectionId),
    }
    patchState({ interaction_continuation: interactionContinuation })
    pendingInteractionAck = questionEventAck(event)
    if (shouldAssertTurnOnPollerInboxWrite(connectionId, readState(connectionId))) {
      writeTurnMarker(connectionId, { remoteTurn: true })
    }
    process.stdout.write(
      JSON.stringify({
        type: 'wake',
        reason:
          event.kind === DISMISSAL_KIND
            ? 'directed_question_dismissal'
            : 'directed_question_answer',
        question_id: event.question_id,
        inbox: inboxPathForConnection(connectionId),
        authoritative: false,
        executable: false,
      }) + '\n',
    )
    return { delivered: true }
  }

  async function consumeInteractionEvents(res) {
    let offered
    try {
      offered = questionEventOffers(res, Boolean(connectionCapability))
    } catch (error) {
      process.stderr.write(`devspec-remote-poll: ${error.message}\n`)
      return { lane: true, delivered: false }
    }
    if (offered.length === 0) return { lane: false, delivered: false }
    if (res.interaction_event_version !== INTERACTION_EVENT_VERSION) {
      process.stderr.write(
        `devspec-remote-poll: refused interaction events on an unsupported version; ` +
          `see ${INTERACTION_EVENT_CONTRACT_URI}\n`,
      )
      return { lane: true, delivered: false }
    }
    let delivered = false
    for (const candidate of offered) {
      const validated = validateInteractionEvent(candidate, { connectionId, sessionId })
      if (!validated.ok) {
        process.stderr.write(
          `devspec-remote-poll: rejected interaction event (${validated.error})\n`,
        )
        continue
      }
      const result = await applyInteractionEvent(validated.event)
      if (result.delivered) delivered = true
    }
    return { lane: true, delivered }
  }

  async function pollOnce({ waitMs, busy, checkTier, catchUp = false }) {
    const listenerState = readState(connectionId)
    const listenerArmed = readListenerArmed(connectionId, listenerState)
    const unreadCommands = countUnconsumedCommands(
      connectionId,
      listenerState?.inbox_byte_offset,
    )
    const telemetry = readConnectionTelemetry(connectionId)
    const interactionArgs = interactionNegotiationArguments({
      enabled: true,
      connection_id: connectionId,
      connection_capability: connectionCapability,
    })
    const negotiatesInteraction = Object.keys(interactionArgs).length > 0
    const ack = negotiatesInteraction ? pendingInteractionAck : null
    const controlAck = pendingControlAck
    const offersNegotiable = commandOfferNegotiable({
      connectionCapability,
      sessionId,
      attachmentId: speechAttachmentId,
      catchUp,
    })
    const handoff = offersNegotiable && !ack ? pendingCommandHandoff : null
    if (handoff) {
      sentCommandHandoff = {
        ready: handoff,
        question_id: interactionContinuation?.question_id ?? null,
      }
      lastSentHandoffKey = commandHandoffKey(handoff)
      process.stderr.write(
        `devspec-remote-poll: ${nowStamp()} handing the question's turn to message ${handoff.source_message_id}\n`,
      )
    }
    const response = await mcpToolsCall({
      mcpUrl,
      token,
      ...(negotiatesInteraction || offersNegotiable ? { connectionCapability } : {}),
      name: 'poll_connection',
      arguments: {
        connection_id: connectionId,
        agent_name: agentName,
        ...remoteIngressNegotiationArguments(),
        ...(transcriptStore ? transcriptPollArguments(transcriptStore) : {}),
        ...knownInstructionTierArguments(listenerState),
        ...interactionArgs,
        ...(ack ? questionEventAckArguments(ack) : {}),
        ...commandOfferArguments({ negotiable: offersNegotiable, ready: handoff }),
        control_verbs: [],
        ...(controlAck ? { control_ack: controlAck } : {}),
        wait_ms: waitMs,
        ...pollCursorArguments({ liveCursorV2, legacyCursor, catchUpCursor, needsSeed: catchUp }),
        ...(dispatchCursor ? { dispatch_cursor: dispatchCursor } : {}),
        ...(busy !== null && busy !== undefined ? { busy } : {}),
        ...(checkTier ? { check_tier: checkTier } : {}),
        ...(catchUp ? { catch_up: true } : {}),
        ...(listenerArmed !== null ? { listener_armed: listenerArmed } : {}),
        unread_commands: unreadCommands,
        ...(telemetry ? { agent_stats: telemetry } : {}),
      },
      timeoutMs: waitMs + POLL_HTTP_GRACE_MS,
      isAlive: () => !ownerAnchor || ownerAlive(ownerAnchor),
    })
    if (ack && pendingInteractionAck === ack) pendingInteractionAck = null
    if (controlAck && pendingControlAck === controlAck) pendingControlAck = null
    if (handoff && pendingCommandHandoff === handoff) pendingCommandHandoff = null
    return response
  }

  function persistCanonicalCursorState(
    res,
    ingress,
    drainingContinuation,
    instructionContextDelivered = false,
  ) {
    const next = advancePollCursors(
      { liveCursorV2, legacyCursor, catchUpCursor },
      res,
      ingress,
      { drainingContinuation },
    )
    liveCursorV2 = next.liveCursorV2
    legacyCursor = next.legacyCursor
    catchUpCursor = next.catchUpCursor
    patchState({
      cursor_v2: liveCursorV2,
      ingress_cursor_v2: liveCursorV2,
      cursor_after_message_id: legacyCursor,
      catch_up_cursor: catchUpCursor,
      canonical_window: ingress.window,
      canonical_envelope_id: ingress.envelope_id,
      ...(instructionContextDelivered &&
      res.instruction_tiers_version === 1 &&
      typeof res.instruction_tiers_hash === 'string'
        ? {
            instruction_tiers_version: res.instruction_tiers_version,
            instruction_tiers_hash: res.instruction_tiers_hash,
          }
        : {}),
    })
  }

  function handOverControl(control) {
    pendingControlAck = control.id
    process.stderr.write(
      `devspec-remote-poll: ${nowStamp()} owner control ${control.verb} is not carried out here; handing it back\n`,
    )
  }

  async function openCommandRequests(commands) {
    const call = (reqArgs) =>
      mcpToolsCall({
        mcpUrl,
        token,
        connectionCapability,
        name: 'report_request',
        arguments: reqArgs,
        timeoutMs: 5_000,
      })
    for (const command of Array.isArray(commands) ? commands : []) {
      try {
        await openRequest({
          connectionId,
          kind: 'command',
          provenanceRef: command?.delivery?.provenance_ref,
          messageId: command?.message_id,
          call,
          dir: CONNECTIONS_DIR,
        })
      } catch {
        /* non-fatal */
      }
    }
  }

  let needsSeed = true

  async function consumeCanonicalIngress(res) {
    const normalized = normalizeRemoteIngressV1(res?.ingress, connectionId)
    if (!normalized.ok) {
      process.stderr.write(
        `devspec-remote-poll: rejected canonical ingress (${normalized.error}); ` +
          `see ${REMOTE_INGRESS_RESOURCE_URI}\n`,
      )
      return { ok: false, delivered: false }
    }

    const ingress = normalized.envelope
    const drainingContinuation = Boolean(catchUpCursor || (needsSeed && liveCursorV2))
    const drainPoll = Boolean(needsSeed || catchUpCursor)

    if (transcriptStore && typeof res?.session_id === 'string') {
      const applied = applyIngressToStore(transcriptStore, ingress, {
        sessionId: res.session_id,
        drainPoll,
      })
      if (applied.applied) {
        observeSessionActivity(
          transcriptStore,
          isSessionActivityV1(ingress.session_activity) ? ingress.session_activity : null,
        )
        observeSessionEvents(
          transcriptStore,
          isSessionEventsV1(ingress.session_events) ? ingress.session_events : null,
        )
        if (!persistTranscriptStore(transcriptStore)) {
          process.stderr.write(
            'devspec-remote-poll: transcript write failed; the copy is marked incomplete\n',
          )
        }
        if (takePendingRedrain(transcriptStore)) {
          process.stderr.write(
            'devspec-remote-poll: transcript disagrees with the room; re-reading its history\n',
          )
          redrainRequested = true
        }
      }
    }

    const activity = sessionActivityView(transcriptStore)
    roomFileSeen = writeRoomState(connectionId, res, roomFileSeen, {
      transcript: transcriptSummary(transcriptStore),
      activity,
    })

    let channel = 'context'
    if (normalized.wake) {
      channel = 'command'
    } else if (
      ingress.wake.kind === 'control' &&
      ingress.wake.active &&
      ingress.delivery_state === 'live'
    ) {
      channel = 'control'
    } else if (
      ingress.wake.kind === 'system_notice' &&
      ingress.wake.active &&
      ingress.delivery_state === 'live'
    ) {
      channel = 'system_notice'
    }
    const roomChanges =
      channel === 'command' ? roomChangesSince(res, activity, roomAnnounced) : null

    const instructionContextFile =
      channel === 'command' ? captureInstructionContext(connectionId, res) : null
    if (channel === 'command' && connectionCapability) {
      await openCommandRequests(ingress.commands)
    }
    const persisted = appendCanonicalInbox(connectionId, ingress, persistedInbox, {
      sessionId,
      instructionContextFile,
      wakeContext: roomChanges
        ? commandWakeContext(transcriptStore, ingress, {
            connectionId,
            roomChanged: roomChanges.changed,
          })
        : null,
      channel,
      questionHandoff: sentCommandHandoff?.question_id
        ? {
            question_id: sentCommandHandoff.question_id,
            source_message_id: sentCommandHandoff.ready.source_message_id,
          }
        : null,
    })
    if (!persisted.ok) return { ok: false, delivered: false }

    if (persisted.appended && roomChanges) roomAnnounced = roomChanges.seen
    persistCanonicalCursorState(
      res,
      ingress,
      drainingContinuation,
      Boolean(persisted.appended && instructionContextFile),
    )

    if (normalized.reason === 'unavailable_attachment') {
      process.stderr.write(
        'devspec-remote-poll: canonical command rejected before wake: unavailable attachment\n',
      )
    }
    if (!persisted.appended) return { ok: true, delivered: false }

    if (channel === 'command') {
      process.stdout.write(
        JSON.stringify({
          type: 'canonical_ingress_persisted',
          authoritative: false,
          executable: false,
          preview: null,
          envelope_id: ingress.envelope_id,
          command_message_ids: persisted.executeMessageIds,
          note: 'Poller stdout is notification only; execute only the canonical inbox record.',
        }) + '\n',
      )
      process.stdout.write(
        JSON.stringify({
          type: 'wake',
          reason: 'canonical_conversational_command',
          count: persisted.executeMessageIds.length,
          inbox: inboxPathForConnection(connectionId),
          continuous: true,
          authoritative: false,
          executable: false,
        }) + '\n',
      )
      if (shouldAssertTurnOnPollerInboxWrite(connectionId, readState(connectionId))) {
        writeTurnMarker(connectionId, { remoteTurn: true })
      }
      patchState({ last_owner_wake_at: new Date().toISOString() })
      if (persisted.handedOff) {
        clearInteractionContinuation('command_handoff')
        forgetCommandHandoff()
      }
    } else if (channel === 'control') {
      handOverControl(ingress.control)
    } else if (channel === 'system_notice') {
      process.stdout.write(
        JSON.stringify({
          type: 'canonical_system_notices_persisted',
          authoritative: false,
          executable: false,
          envelope_id: ingress.envelope_id,
          notice_ids: persisted.executeNoticeIds,
          note: 'Poller stdout is notification only; read the canonical inbox record.',
        }) + '\n',
      )
      process.stdout.write(
        JSON.stringify({
          type: 'wake',
          reason: 'exact_connection_system_notice',
          count: persisted.executeNoticeIds.length,
          inbox: inboxPathForConnection(connectionId),
          continuous: true,
          authoritative: false,
          executable: false,
        }) + '\n',
      )
    }
    return { ok: true, delivered: true }
  }

  function consumeAutomationDispatches(res) {
    if (!Array.isArray(res?.dispatches)) {
      process.stderr.write('devspec-remote-poll: rejected malformed dispatches channel\n')
      return { ok: false, delivered: false }
    }
    const nextDispatchCursor =
      typeof res.dispatch_cursor === 'string' ? res.dispatch_cursor : dispatchCursor
    const persisted = appendAutomationDispatches(
      connectionId,
      res.dispatches,
      nextDispatchCursor,
      persistedInbox,
      sessionId,
    )
    if (!persisted.ok) {
      process.stderr.write(`devspec-remote-poll: rejected automation dispatch (${persisted.error})\n`)
      return { ok: false, delivered: false }
    }
    dispatchCursor = nextDispatchCursor
    patchState({
      dispatch_cursor: dispatchCursor,
      delivered_dispatch_ids: [...persistedInbox.dispatchIds].slice(-200),
    })
    if (persisted.appended > 0) {
      process.stdout.write(
        JSON.stringify({
          type: 'wake',
          reason: 'automation_run',
          count: persisted.appended,
          inbox: inboxPathForConnection(connectionId),
          authoritative: false,
          executable: false,
        }) + '\n',
      )
      if (shouldAssertTurnOnPollerInboxWrite(connectionId, readState(connectionId))) {
        writeTurnMarker(connectionId, { remoteTurn: true })
      }
    }
    return { ok: true, delivered: persisted.appended > 0 }
  }

  process.stderr.write(
    `devspec-remote-poll: long-poll mode connection=${connectionId} session=${sessionId || '(none)'} inbox=${inboxPathForConnection(connectionId)}\n`,
  )

  function handlePermanentEnd(reason = 'ended_from_ui') {
    if (shuttingDown) return
    shuttingDown = true
    const listenerArmed = readListenerArmed(connectionId, readState(connectionId)) === true
    const disabled = disableLocalState({ connectionId, reason })
    if (!listenerArmed && disabled) {
      closeAntigravityOnEnd({ state: disabled, sawLive: true, ownerPid: ownerAnchor })
    }
    process.stdout.write(
      JSON.stringify({
        type: 'session_ended',
        reason,
        recoverable: false,
        connection_id: connectionId,
        message: 'Remote control was ended. Local poller stopping; do not restart.',
      }) + '\n',
    )
    process.stderr.write(`devspec-remote-poll: ended (${reason}) — disabling and exiting\n`)
    process.exit(1)
  }

  let sseWakePending = false
  if (process.env.DEVSPEC_DISABLE_SSE !== '1') {
    openPushChannel({
      mcpUrl,
      token,
      connectionId,
      connectionCapability,
      onEvent: (evt) => {
        if (evt.kind === 'wake') {
          sseWakePending = true
        } else if (evt.kind === 'ended') {
          sseWakePending = true
          if (evt.endReason && PERMANENT_END_REASONS.includes(evt.endReason)) {
            handlePermanentEnd(evt.endReason)
          }
        }
      },
      onFallback: (reason) => {
        process.stderr.write(
          `devspec-remote-poll: SSE push unavailable (${reason}) — using poll_connection\n`,
        )
      },
    })
  }

  let consecutiveEmpty = 0
  let consecutiveErrors = 0
  let consecutiveRecoverableEnds = 0

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const liveState = readState(connectionId)
    if (liveState && liveState.enabled === false) {
      process.stderr.write('devspec-remote-poll: disabled — exiting\n')
      process.exit(1)
    }
    refreshSessionTitle(liveState)
    if (
      typeof liveState?.connection_capability === 'string' &&
      liveState.connection_capability
    ) {
      connectionCapability = liveState.connection_capability
    }
    interactionContinuation = activeContinuation(liveState?.interaction_continuation, {
      connectionId,
      sessionId,
    })
    if (
      !interactionContinuation &&
      liveState?.interaction_continuation &&
      sessionId &&
      liveState.interaction_continuation.session_id !== sessionId
    ) {
      patchState({ interaction_continuation: null })
      pendingInteractionAck = null
    }
    const handoffAttempt = (pendingCommandHandoff ?? sentCommandHandoff?.ready)?.attempt_id
    if (handoffAttempt && interactionContinuation?.attempt_id !== handoffAttempt) {
      forgetCommandHandoff()
    }

    if (ownerAnchor && !ownerAlive(ownerAnchor)) {
      process.stderr.write(`devspec-remote-poll: owner process ${ownerAnchor} gone — stopping\n`)
      process.stdout.write(
        JSON.stringify({
          type: 'session_ended',
          reason: 'owner_gone',
          connection_id: connectionId,
        }) + '\n',
      )
      await offlineAndExit('owner_gone', 1)
      return
    }

    const marker = readTurnMarker(connectionId)
    const turnActive = isTurnMarkerActive(marker)
    let busyArg = null
    if (turnActive) busyArg = true
    else if (lastBusySent === true) busyArg = false

    const turnTransitionVerb = verbForTurnTransition(prevTurnActive, turnActive)
    prevTurnActive = turnActive
    await emitActivityVerb(turnTransitionVerb)

    const tier = cadenceFor({ attached: !!sessionId, turnActive })
    if (tier.tier !== lastTier) {
      lastTier = tier.tier
      process.stderr.write(`devspec-remote-poll: cadence → ${tier.tier} (hold ${tier.waitMs}ms)\n`)
      patchState({ check_tier: tier.tier })
    }

    if (needsSeed && transcriptStore && !transcriptStore.backfill.draining) {
      beginDrain(transcriptStore)
    }

    let res = null
    try {
      const effectiveWaitMs = sseWakePending ? 0 : tier.waitMs
      sseWakePending = false
      res = await pollOnce({
        waitMs: effectiveWaitMs,
        busy: busyArg,
        checkTier: tier.checkTier,
        catchUp: needsSeed,
      })
      consecutiveErrors = 0
      if (busyArg !== null) lastBusySent = busyArg
    } catch (e) {
      if (e?.code === 'owner_gone') {
        process.stderr.write(`devspec-remote-poll: owner process gone during poll — stopping\n`)
        process.stdout.write(
          JSON.stringify({
            type: 'session_ended',
            reason: 'owner_gone',
            connection_id: connectionId,
          }) + '\n',
        )
        await offlineAndExit('owner_gone', 1)
        return
      }
      if (catchUpCursor && isCatchUpCursorRefusal(e)) {
        process.stderr.write(
          'devspec-remote-poll: server refused the catch-up cursor; re-reading the room\n',
        )
        catchUpCursor = null
        needsSeed = true
        patchState({ catch_up_cursor: null })
        continue
      }
      consecutiveErrors++
      const rateLimited = /rate limit/i.test(e?.message || '')
      const backoff = errorBackoffMs(consecutiveErrors, { rateLimited })
      process.stderr.write(
        `devspec-remote-poll: poll failed (${consecutiveErrors}): ${e.message} — retrying in ${backoff}ms\n`,
      )
      await sleep(backoff)
      continue
    }

    const terminal = pollTerminalReason(res)
    if (terminal && terminal.recoverable) {
      consecutiveRecoverableEnds++
      const label = terminal.reason ? `${terminal.status} (${terminal.reason})` : terminal.status
      if (consecutiveRecoverableEnds < RECOVERABLE_TERMINAL_MAX) {
        const backoff = errorBackoffMs(consecutiveRecoverableEnds)
        process.stderr.write(
          `devspec-remote-poll: ${label} — recoverable, not a UI end; ` +
            `retrying in ${backoff}ms (${consecutiveRecoverableEnds}/${RECOVERABLE_TERMINAL_MAX})\n`,
        )
        await sleep(backoff)
        continue
      }
      process.stderr.write(
        `devspec-remote-poll: ${label} — still gone after ${RECOVERABLE_TERMINAL_MAX} tries; ` +
          `standing down (recoverable — re-register to resume)\n`,
      )
      disableLocalState({ connectionId, reason: terminal.reason || 'server_ended' })
      process.stdout.write(
        JSON.stringify({
          type: 'session_ended',
          reason: terminal.reason || 'server_ended',
          recoverable: true,
          connection_id: connectionId,
          message:
            'Connection is no longer on the server. This was NOT a UI end — ' +
            're-register the same bond to resume.',
        }) + '\n',
      )
      process.exit(1)
    }
    if (terminal) {
      handlePermanentEnd(terminal.reason || 'ended_from_ui')
      return
    }
    consecutiveRecoverableEnds = 0

    const adopt = resolveServerAttachment(sessionId, res)
    if (adopt.changed) {
      process.stderr.write(
        `devspec-remote-poll: server attachment ${sessionId || '(none)'} → ${adopt.sessionId || '(none)'}\n`,
      )
      sessionId = adopt.sessionId
      legacyCursor = null
      liveCursorV2 = null
      catchUpCursor = null
      needsSeed = true
      titleReadAt = 0
      transcriptStore = sessionId ? loadTranscriptStore(connectionId, sessionId) : null
      redrainRequested = false
      roomAnnounced = {}
      speechAttachmentId = null
      forgetCommandHandoff()
      patchState({
        session_id: sessionId,
        cursor_after_message_id: null,
        cursor_v2: null,
        ingress_cursor_v2: null,
        catch_up_cursor: null,
        speech_attachment_id: null,
        attached_at: null,
        session_title: null,
        session_title_for: null,
      })
      continue
    }

    const attachmentNow =
      typeof res.speech_attachment_id === 'string' && res.speech_attachment_id
        ? res.speech_attachment_id
        : null
    if (attachmentNow !== speechAttachmentId) {
      speechAttachmentId = attachmentNow
      forgetCommandHandoff()
    }
    const attachedAtNow =
      typeof res.attached_at === 'string' && res.attached_at ? res.attached_at : null
    const recorded = readState(connectionId)
    if (
      recorded &&
      ((recorded.speech_attachment_id ?? null) !== attachmentNow ||
        (recorded.attached_at ?? null) !== attachedAtNow)
    ) {
      patchState({
        speech_attachment_id: attachmentNow,
        attached_at: attachedAtNow,
      })
    }

    if (res.changed === true) {
      const interaction = await consumeInteractionEvents(res)
      if (interaction.lane) {
        if (interaction.delivered) {
          consecutiveEmpty = 0
          continue
        }
        consecutiveEmpty++
        await sleep(emptyTurnBackoffMs(consecutiveEmpty, tier.waitMs))
        continue
      }
      const automations = consumeAutomationDispatches(res)
      const canonical = await consumeCanonicalIngress(res)
      if (canonical.ok) {
        needsSeed = redrainRequested
        redrainRequested = false
      }
      const handOverNow = considerCommandOffer(res)
      if (automations.delivered || canonical.delivered) {
        consecutiveEmpty = 0
        continue
      }
      if (handOverNow) continue
      consecutiveEmpty++
      const floor = emptyTurnBackoffMs(consecutiveEmpty, tier.waitMs)
      if (consecutiveEmpty === 1 || consecutiveEmpty % 10 === 0) {
        process.stderr.write(
          `devspec-remote-poll: empty change (${consecutiveEmpty}) — backing off ${floor}ms\n`,
        )
      }
      await sleep(floor)
      continue
    }

    if (!catchUpCursor && typeof res.cursor_v2 === 'string' && res.cursor_v2) {
      liveCursorV2 = res.cursor_v2
    }
    if (typeof res.cursor === 'string' && res.cursor) legacyCursor = res.cursor
    patchState({
      cursor_v2: liveCursorV2,
      ingress_cursor_v2: liveCursorV2,
      cursor_after_message_id: legacyCursor,
    })
    if (needsSeed && transcriptStore?.backfill.draining) {
      completeEmptyDrain(transcriptStore)
      persistTranscriptStore(transcriptStore)
    }
    needsSeed = false
    consecutiveEmpty = 0
  }
}

const isMain =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (isMain) {
  main().catch((e) => {
    process.stderr.write(`devspec-remote-poll: ${e.message}\n`)
    process.exit(1)
  })
}
