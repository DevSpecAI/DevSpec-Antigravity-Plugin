/**
 * The connection's local copy of the room transcript (item 1a4f0246, decision
 * 366e1beb).
 *
 * The poller already hears every message in the room — commands and context
 * alike — on `poll_connection`. Before this file existed, the wait script carried
 * a newest-20, 12,000-character slice of that context into the wake and threw the
 * rest away, including any single message longer than the cap. The model then had
 * to spend an MCP call on `get_session_transcript` whenever a turn was long or the
 * room had been busy, and could still miss a post that landed while it was working.
 *
 * This module keeps the whole room in one append-ordered JSONL file per connection
 * and session (`<connectionId>.<sessionId>.transcript.jsonl`), sorted by the
 * server's `(sequence, created_at, message_id)` order, with a small companion state
 * file (`.transcript-state.json`) that records what the copy holds and how complete
 * it is. Attachments are decoded to `<connectionId>.attachments/` before a line is
 * written, so the transcript is plain text and file paths — never base64.
 *
 * It is awareness, never authority: a line in this file is how the room reads,
 * while what to execute still comes only from the canonical inbox record.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { STATE_OK, readPrivateJsonResult, writePrivateJson } from './private-state.mjs'
import { attachmentDirFor, defaultWriteFile, describeAttachment } from './attachment-store.mjs'

const CONNECTIONS_DIR = path.join(os.homedir(), '.devspec', 'remote-control', 'connections')

export const TRANSCRIPT_SCHEMA_VERSION = 1

/**
 * Once per UTC day is enough for an automatic re-read when the server's count and
 * ours disagree: if one re-drain did not reconcile it, spinning on every poll only
 * burns requests against a gap that is not going to close by asking again.
 */
export const RECONCILE_COOLDOWN_MS = 24 * 60 * 60 * 1000

const SAFE_PART = /^[a-zA-Z0-9_-]{1,64}$/

export function transcriptPaths(connectionId, sessionId, dir = CONNECTIONS_DIR) {
  if (!SAFE_PART.test(String(connectionId || '')) || !SAFE_PART.test(String(sessionId || ''))) {
    throw new Error('transcriptPaths requires safe connectionId and sessionId')
  }
  const stem = path.join(dir, `${connectionId}.${sessionId}`)
  return {
    transcript: `${stem}.transcript.jsonl`,
    state: `${stem}.transcript-state.json`,
  }
}

export function roomStatePath(connectionId, dir = CONNECTIONS_DIR) {
  return path.join(dir, `${connectionId}.room.json`)
}

function compareOrder(left, right) {
  if (left.sequence !== right.sequence) return left.sequence - right.sequence
  if (left.created_at !== right.created_at) return left.created_at < right.created_at ? -1 : 1
  if (left.message_id !== right.message_id) return left.message_id < right.message_id ? -1 : 1
  return 0
}

function sameOrder(left, right) {
  return Boolean(
    left &&
    right &&
    left.sequence === right.sequence &&
    left.created_at === right.created_at &&
    left.message_id === right.message_id,
  )
}

function validOrder(order) {
  return Boolean(
    order &&
    typeof order === 'object' &&
    Number.isSafeInteger(order.sequence) &&
    order.sequence >= 0 &&
    typeof order.created_at === 'string' &&
    order.created_at.length > 0 &&
    typeof order.message_id === 'string' &&
    order.message_id.length > 0,
  )
}

function validTranscriptLine(entry) {
  return Boolean(
    entry &&
    typeof entry === 'object' &&
    !Array.isArray(entry) &&
    typeof entry.message_id === 'string' &&
    validOrder(entry.order) &&
    entry.order.message_id === entry.message_id &&
    typeof entry.content === 'string',
  )
}

function freshBackfillState() {
  return {
    complete: false,
    draining: false,
    pages_loaded: 0,
    oldest_order: null,
    newest_order: null,
    total_known: null,
    last_reconcile_at: null,
  }
}

function freshActivityState() {
  return {
    items: [],
    list_readable: false,
    events: [],
    updated_at: null,
  }
}

function freshEventsState() {
  return {
    events: [],
    complete: false,
    updated_at: null,
  }
}

/**
 * Open the local copy for `(connectionId, sessionId)`. If either file is missing or
 * unreadable, the store starts empty and incomplete so the next seed poll drains the
 * room again from the server rather than trusting half a file.
 */
export function loadTranscriptStore(connectionId, sessionId, { dir = CONNECTIONS_DIR } = {}) {
  const paths = transcriptPaths(connectionId, sessionId, dir)
  const rows = new Map()
  let fileComplete = true

  try {
    const raw = fs.readFileSync(paths.transcript, 'utf8')
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      const parsed = JSON.parse(line)
      if (!validTranscriptLine(parsed)) {
        fileComplete = false
        rows.clear()
        break
      }
      rows.set(parsed.message_id, parsed)
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') fileComplete = false
  }

  const stateRes = readPrivateJsonResult(paths.state)
  const saved =
    fileComplete &&
    stateRes.status === STATE_OK &&
    stateRes.value?.schema_version === TRANSCRIPT_SCHEMA_VERSION &&
    stateRes.value?.connection_id === connectionId &&
    stateRes.value?.session_id === sessionId
      ? stateRes.value
      : null

  // If the state file said we had rows that the JSONL file does not hold (e.g. one
  // was deleted without the other), believe the rows we actually read and mark the
  // copy incomplete so the poller re-drains.
  const countMatches = saved && saved.message_count === rows.size
  const backfill = countMatches && saved.backfill && typeof saved.backfill === 'object'
    ? {
        complete: Boolean(saved.backfill.complete),
        draining: false,
        pages_loaded: Number.isSafeInteger(saved.backfill.pages_loaded) ? saved.backfill.pages_loaded : 0,
        oldest_order: validOrder(saved.backfill.oldest_order) ? saved.backfill.oldest_order : null,
        newest_order: validOrder(saved.backfill.newest_order) ? saved.backfill.newest_order : null,
        total_known: Number.isSafeInteger(saved.backfill.total_known) ? saved.backfill.total_known : null,
        last_reconcile_at: typeof saved.backfill.last_reconcile_at === 'string' ? saved.backfill.last_reconcile_at : null,
      }
    : freshBackfillState()

  const activity = saved?.activity && typeof saved.activity === 'object'
    ? {
        items: Array.isArray(saved.activity.items) ? saved.activity.items : [],
        list_readable: Boolean(saved.activity.list_readable),
        events: Array.isArray(saved.activity.events) ? saved.activity.events : [],
        updated_at: typeof saved.activity.updated_at === 'string' ? saved.activity.updated_at : null,
      }
    : freshActivityState()

  const sessionEvents = saved?.session_events && typeof saved.session_events === 'object'
    ? {
        events: Array.isArray(saved.session_events.events) ? saved.session_events.events : [],
        complete: Boolean(saved.session_events.complete),
        updated_at: typeof saved.session_events.updated_at === 'string' ? saved.session_events.updated_at : null,
      }
    : freshEventsState()

  const store = {
    connectionId,
    sessionId,
    dir,
    paths,
    rows,
    backfill,
    activity,
    sessionEvents,
    // Set when a drain is in progress: the ids seen across the drain so far, so
    // rows that vanished from the server during a full re-read can be dropped when
    // the final page lands.
    drainSeenIds: null,
    // Set when a live mismatch asks the poller to re-seed on the next tick.
    pendingRedrain: false,
  }
  recomputeBounds(store)
  return store
}

function recomputeBounds(store) {
  const ordered = [...store.rows.values()].sort((a, b) => compareOrder(a.order, b.order))
  store.backfill.oldest_order = ordered[0]?.order ?? null
  store.backfill.newest_order = ordered.at(-1)?.order ?? null
}

/**
 * Turn any attachment on a context or command row into a disk descriptor before it
 * reaches the transcript file. Metadata-only references (1.0 commands) have no
 * bytes to write and are kept as they are so the reader still sees a file was
 * attached.
 */
function cleanAttachments(rawAttachments, messageId, { attachmentDir, writeFile }) {
  if (!Array.isArray(rawAttachments) || rawAttachments.length === 0) return []
  const out = []
  for (let i = 0; i < rawAttachments.length; i++) {
    const att = rawAttachments[i]
    if (!att || typeof att !== 'object') continue
    if (att.materialization === 'metadata') {
      out.push({
        filename: att.filename,
        mime_type: att.mime_type,
        type: att.type,
        size_bytes: att.size_bytes,
        resource_id: att.resource_id,
        delivery: 'metadata',
      })
      continue
    }
    const desc = describeAttachment(att, { dir: attachmentDir, messageId, index: i, writeFile })
    if (desc) out.push(desc)
  }
  return out
}

function commandToTranscriptLine(command, styleByMessageId, attachmentOpts) {
  const style = styleByMessageId.get(command.message_id) ?? null
  const attachments = cleanAttachments(command.attachments, command.message_id, attachmentOpts)
  return {
    message_id: command.message_id,
    order: command.order,
    kind: 'command',
    author: {
      kind: 'human',
      user_id: command.requester.user_id,
      display_name: command.requester.display_name,
      agent_tool: null,
      model: null,
      connection_id: null,
      codename: null,
    },
    source_type: 'command',
    content: command.content.body,
    updated_at: command.content.updated_at ?? command.order.created_at,
    addressed_to: {
      connection_id: command.addressee.connection_id,
      agent_name: command.addressee.agent_name,
      codename: command.addressee.codename,
      label: command.addressee.label,
    },
    authority: command.authority.kind,
    ...(command.project_scope ? { project_scope: command.project_scope } : {}),
    ...(style ? { sender_response_style: style } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    advisory: false,
  }
}

function contextToTranscriptLine(entry, attachmentOpts) {
  const attachments = cleanAttachments(entry.attachments, entry.message_id, attachmentOpts)
  const room = entry.room ?? null
  return {
    message_id: entry.message_id,
    order: entry.order,
    kind: entry.actor.kind,
    author: {
      kind: entry.actor.kind,
      user_id: entry.actor.user_id,
      display_name: entry.actor.display_name,
      agent_tool: entry.actor.agent_tool,
      model: entry.actor.model,
      connection_id: room?.author_connection_id ?? null,
      codename: room?.author_codename ?? null,
    },
    source_type: entry.source_type,
    content: entry.content,
    updated_at: room?.updated_at ?? entry.order.created_at,
    addressed_to: room?.addressed_to ?? null,
    ...(room?.work_trail ? { work_trail: room.work_trail } : {}),
    ...(room?.trail_events ? { trail_events: room.trail_events } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    advisory: true,
  }
}

/**
 * Begin a full history drain (initial connect, session switch, or a reconciliation
 * re-read). Existing rows stay readable while the drain runs; `drainSeenIds` tracks
 * what the server re-emits so anything that was deleted server-side can be dropped
 * when the final page lands (`has_more: false`).
 */
export function beginDrain(store) {
  store.backfill.draining = true
  store.drainSeenIds = new Set()
}

/**
 * Fold one validated canonical ingress envelope into the store.
 *
 * Returns `{ applied: false, reason: 'session_mismatch' }` when the response is for a
 * different session than the store was opened for — the guard that stops an
 * in-flight poll from writing Room A's messages into Room B's file after a switch.
 */
export function applyIngressToStore(
  store,
  ingress,
  {
    sessionId,
    drainPoll = false,
    writeFile = defaultWriteFile,
    now = Date.now(),
  } = {},
) {
  if (!store || !ingress) return { applied: false, reason: 'empty' }
  if (!sessionId || sessionId !== store.sessionId) {
    return { applied: false, reason: 'session_mismatch' }
  }

  const attachmentOpts = {
    attachmentDir: attachmentDirFor(store.connectionId, store.dir),
    writeFile,
  }
  const styleByMessageId = new Map()
  for (const s of Array.isArray(ingress.sender_response_styles) ? ingress.sender_response_styles : []) {
    if (s && typeof s.message_id === 'string' && Array.isArray(s.notes)) {
      styleByMessageId.set(s.message_id, s.notes)
    }
  }

  let changed = false
  const put = (line) => {
    const prev = store.rows.get(line.message_id)
    if (!prev || JSON.stringify(prev) !== JSON.stringify(line)) changed = true
    store.rows.set(line.message_id, line)
    if (store.drainSeenIds) store.drainSeenIds.add(line.message_id)
  }

  for (const command of Array.isArray(ingress.commands) ? ingress.commands : []) {
    put(commandToTranscriptLine(command, styleByMessageId, attachmentOpts))
  }
  const ctx = ingress.context ?? {}
  for (const bucket of ['human_context', 'agent_context', 'ai_context', 'system_context']) {
    for (const entry of Array.isArray(ctx[bucket]) ? ctx[bucket] : []) {
      put(contextToTranscriptLine(entry, attachmentOpts))
    }
  }

  const win = ingress.window
  if (win && Number.isSafeInteger(win.total_known)) {
    store.backfill.total_known = win.total_known
  }

  if (drainPoll) {
    store.backfill.pages_loaded += 1
    if (win && win.has_more === false) {
      // Final page of a full drain: if we started from the top and walked all the
      // way to the end without hitting a policy cap, anything we held before the
      // drain that the server never sent is gone on the server too.
      if (store.drainSeenIds && win.truncated === false) {
        for (const id of [...store.rows.keys()]) {
          if (!store.drainSeenIds.has(id)) {
            store.rows.delete(id)
            changed = true
          }
        }
      }
      store.backfill.draining = false
      store.backfill.complete = win.truncated === false
      store.drainSeenIds = null
    } else if (win && win.has_more === true) {
      store.backfill.draining = true
      store.backfill.complete = false
    }
  } else if (win && win.truncated === true && win.omission_reason !== 'delivery_retry') {
    // A live delta overflowed a single page (`policy_limit` / `byte_budget`), so
    // there is a gap between what we held and what just arrived. Ask for a re-drain.
    store.backfill.complete = false
    requestRedrainIfAllowed(store, now)
  }

  recomputeBounds(store)

  // Reconciliation check: when we believe we have the whole room (`complete: true`
  // and not mid-drain) and the server's `window` covers the room's tail without
  // holding rows back (`delivery_retry`), our row count should match `total_known`.
  // Wait until any in-flight `updated_since` edits have settled too.
  if (
    store.backfill.complete &&
    !store.backfill.draining &&
    win &&
    win.truncated === false &&
    Number.isSafeInteger(win.total_known) &&
    store.rows.size !== win.total_known
  ) {
    store.backfill.complete = false
    requestRedrainIfAllowed(store, now)
  }

  return { applied: true, changed }
}

/**
 * A seed poll that returned `changed: false` means the room has zero messages.
 * Mark the copy complete so the room-state file does not stay stuck on `seeding`.
 */
export function completeEmptyDrain(store) {
  if (!store) return
  store.backfill.draining = false
  store.backfill.complete = store.rows.size === 0
  store.backfill.total_known = store.rows.size
  store.drainSeenIds = null
  recomputeBounds(store)
}

function requestRedrainIfAllowed(store, nowMs) {
  const last = store.backfill.last_reconcile_at ? Date.parse(store.backfill.last_reconcile_at) : NaN
  if (Number.isFinite(last) && nowMs - last < RECONCILE_COOLDOWN_MS) return false
  store.backfill.last_reconcile_at = new Date(nowMs).toISOString()
  store.pendingRedrain = true
  return true
}

/** Take and clear a pending re-drain request so the poller can set `needsSeed = true`. */
export function takePendingRedrain(store) {
  if (!store || !store.pendingRedrain) return false
  store.pendingRedrain = false
  return true
}

/**
 * Fold a `session_activity` projection from the envelope into the store.
 *
 * The server sends the current item snapshots (`items`, when `list_readable` is
 * true) and a bounded tail of recent lifecycle transitions (`events`). Here we
 * keep the union of every transition this connection has seen, keyed by its
 * deterministic `id`, so an item that was claimed and completed twenty minutes ago
 * is still in the local record even after it scrolls out of the server's tail. If
 * `list_readable` is false on one poll (a transient read failure), the last good
 * `items` list is kept rather than wiped, and `list_readable: false` records that
 * it may be stale.
 */
export function observeSessionActivity(store, activity, { now = new Date() } = {}) {
  if (!store || !activity || typeof activity !== 'object') return false
  let changed = false
  if (activity.list_readable === true && Array.isArray(activity.items)) {
    if (
      !store.activity.list_readable ||
      JSON.stringify(store.activity.items) !== JSON.stringify(activity.items)
    ) {
      store.activity.items = activity.items
      changed = true
    }
    store.activity.list_readable = true
  } else if (activity.list_readable === false && store.activity.list_readable !== false) {
    store.activity.list_readable = false
    changed = true
  }

  if (Array.isArray(activity.events) && activity.events.length > 0) {
    const byId = new Map(store.activity.events.map((e) => [e.id, e]))
    const before = byId.size
    for (const ev of activity.events) {
      if (ev && typeof ev.id === 'string') byId.set(ev.id, ev)
    }
    if (byId.size !== before) {
      store.activity.events = [...byId.values()].sort((a, b) =>
        a.at !== b.at ? (a.at < b.at ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
      )
      changed = true
    }
  }

  if (changed || store.activity.updated_at === null) {
    store.activity.updated_at = now.toISOString()
  }
  return changed
}

/**
 * Fold the room's non-message timeline (`session_events`: action-item and poll
 * cards, attachments, compact boundaries) into the store, keyed by `id`. They do
 * not go into `.transcript.jsonl` — that file is messages only — and instead sit
 * in `.transcript-state.json` and `.room.json` so the timeline is available without
 * mixing card rows into conversation lines.
 */
export function observeSessionEvents(store, sessionEvents, { now = new Date() } = {}) {
  if (!store || !sessionEvents || typeof sessionEvents !== 'object') return false
  const incoming = Array.isArray(sessionEvents.events) ? sessionEvents.events : []
  const byId = new Map(store.sessionEvents.events.map((e) => [e.id, e]))
  let changed = false
  for (const ev of incoming) {
    if (!ev || typeof ev.id !== 'string') continue
    const prev = byId.get(ev.id)
    if (!prev || JSON.stringify(prev) !== JSON.stringify(ev)) {
      byId.set(ev.id, ev)
      changed = true
    }
  }
  const complete = sessionEvents.inventory?.truncated === false
  if (store.sessionEvents.complete !== complete) {
    store.sessionEvents.complete = complete
    changed = true
  }
  if (changed || store.sessionEvents.updated_at === null) {
    store.sessionEvents.events = [...byId.values()].sort((a, b) =>
      a.created_at !== b.created_at
        ? a.created_at < b.created_at ? -1 : 1
        : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    )
    store.sessionEvents.updated_at = now.toISOString()
  }
  return changed
}

/**
 * Write `.transcript.jsonl` and `.transcript-state.json` atomically (`0600` via a
 * `.tmp` rename). Returns `false` if either write fails; when that happens
 * `backfill.complete` is flipped to `false` in memory so `room.json` never claims a
 * complete transcript that is not actually on disk.
 */
export function persistTranscriptStore(store, { now = new Date() } = {}) {
  if (!store) return false
  const ordered = [...store.rows.values()].sort((a, b) => compareOrder(a.order, b.order))
  const lines = ordered.map((row) => JSON.stringify(row)).join('\n') + (ordered.length ? '\n' : '')
  const tmp = `${store.paths.transcript}.${process.pid}.${Date.now()}.tmp`
  try {
    fs.mkdirSync(path.dirname(store.paths.transcript), { recursive: true, mode: 0o700 })
    fs.writeFileSync(tmp, lines, { mode: 0o600 })
    fs.renameSync(tmp, store.paths.transcript)
  } catch {
    try { fs.rmSync(tmp, { force: true }) } catch { /* ignore */ }
    store.backfill.complete = false
    return false
  }

  let newestUpdatedAt = null
  for (const row of ordered) {
    const candidate = typeof row.updated_at === 'string' ? row.updated_at : row.order.created_at
    if (!newestUpdatedAt || candidate > newestUpdatedAt) newestUpdatedAt = candidate
  }

  const stateDoc = {
    schema_version: TRANSCRIPT_SCHEMA_VERSION,
    connection_id: store.connectionId,
    session_id: store.sessionId,
    updated_at: now.toISOString(),
    message_count: ordered.length,
    newest_updated_at: newestUpdatedAt,
    backfill: {
      complete: store.backfill.complete,
      draining: store.backfill.draining,
      pages_loaded: store.backfill.pages_loaded,
      oldest_order: store.backfill.oldest_order,
      newest_order: store.backfill.newest_order,
      total_known: store.backfill.total_known,
      last_reconcile_at: store.backfill.last_reconcile_at,
    },
    activity: store.activity,
    session_events: store.sessionEvents,
  }
  try {
    writePrivateJson(store.paths.state, stateDoc)
  } catch {
    store.backfill.complete = false
    return false
  }
  return true
}

/**
 * What the poller echoes on `poll_connection` so the server can send edited
 * messages alongside new ones. Only sent once the store has at least one row to
 * anchor from; during a drain we omit `updated_since` so the server focuses on
 * walking history pages.
 */
export function transcriptPollArguments(store) {
  if (!store || store.backfill.draining || store.rows.size === 0) return {}
  let newest = null
  for (const row of store.rows.values()) {
    const candidate = typeof row.updated_at === 'string' ? row.updated_at : row.order.created_at
    if (!newest || candidate > newest) newest = candidate
  }
  return newest ? { updated_since: newest } : {}
}

/**
 * Does this store have a usable history to count against? True once at least one
 * seed page has landed, or when an empty room finished its drain.
 */
export function transcriptHasHistory(store) {
  if (!store) return false
  return store.backfill.complete || store.backfill.pages_loaded > 0
}

/**
 * Compact status block for `.room.json` so the model can tell at a glance where the
 * transcript file is and whether all of history is in it yet.
 */
export function transcriptSummary(store) {
  if (!store) return null
  const status = store.backfill.complete
    ? 'complete'
    : store.backfill.draining
      ? 'draining'
      : 'incomplete'
  return {
    path: store.paths.transcript,
    state_path: store.paths.state,
    status,
    message_count: store.rows.size,
    total_known: store.backfill.total_known,
    oldest_order: store.backfill.oldest_order,
    newest_order: store.backfill.newest_order,
  }
}

/**
 * Compact view of what the session produced and referenced, for `.room.json`.
 */
export function sessionActivityView(store) {
  if (!store || store.activity.updated_at === null) return null
  return {
    advisory: true,
    list_readable: store.activity.list_readable,
    items: store.activity.items,
    events: store.activity.events,
    session_events: store.sessionEvents.events,
    session_events_complete: store.sessionEvents.complete,
    updated_at: store.activity.updated_at,
  }
}
