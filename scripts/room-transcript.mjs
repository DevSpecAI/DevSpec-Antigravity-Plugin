#!/usr/bin/env node
/**
 * The local room transcript (item 1a4f0246): a complete, checkable copy of the room
 * this connection is attached to, written beside the inbox for the model to read.
 *
 * The inbox is the plugin's protocol log. This is the room itself: one JSON line
 * per message, in the room's commit order, with who said it, who it was for, the
 * full text and any file references. It is built only from envelopes the poller
 * has already validated against remote-ingress 1.6.0
 * (devspec://product/remote-ingress-contract), and it follows that contract's
 * recovery rules rather than restating them:
 *
 * - apply a page's records, then `open_check`, then `deletions`;
 * - a row's state only moves forward (in progress, final, deleted) and a known
 *   tombstone always wins, so an older page can never bring a deleted message back;
 * - a partial history drain or an unfinished deletions listing is progress, never a
 *   mismatch; only a complete copy is compared with coverage, and each comparison
 *   is a bound that holds whichever side of the count a change landed on.
 *
 * Durability: the poller writes a page here BEFORE its inbox record, so the line a
 * wake points at is on disk by the time anything is woken (item 7fe8e3d1), and
 * advances its cursor only after both, so a crash anywhere re-polls and re-applies
 * the same page. Every application is idempotent
 * (keyed by message id, states monotonic), which is what makes that safe. Files are
 * replaced atomically (temp file + rename) with 0600 permissions. Nothing here ever
 * writes to stdout: stdout starts a paid model turn.
 *
 * Message text is data written by the room's participants. JSON string escaping is
 * the fence: a line cannot be broken out of by what somebody types.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { writePrivateJson, writePrivateText } from './private-state.mjs'
import { ROOM_PAGE_MAX } from './remote-ingress-v1.mjs'

export const TRANSCRIPT_STORE_VERSION = 1
/** A copy found to disagree with the room is re-read at most this often per day. */
export const MAX_REPAIRS_PER_DAY = 3
const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_DIR = path.join(os.homedir(), '.devspec', 'remote-control', 'connections')
const STATE_RANK = { in_progress: 0, final: 1, deleted: 2 }
const CONTEXT_BUCKETS = ['human_context', 'agent_context', 'ai_context', 'system_context']

/**
 * Where the room's CURRENT advisory state lives (item 62f132c9): one small document
 * per connection, overwritten in place, that always says what is true NOW — polls,
 * Still to Discuss, plans, session activity and how complete this copy is. A file
 * to read, not a message to receive: nothing in it is worth interrupting a turn
 * for (decision 2ccf65d1).
 */
export function roomStatePath(connectionId, dir = DEFAULT_DIR) {
  return path.join(dir, `${connectionId}.room.json`)
}

export function transcriptPaths(connectionId, sessionId, dir = DEFAULT_DIR) {
  const base = path.join(dir, `${connectionId}.${sessionId}`)
  return { transcript: `${base}.transcript.jsonl`, state: `${base}.transcript-state.json` }
}

/** A fresh, empty copy of one room for one connection. */
export function createTranscriptStore(connectionId, sessionId) {
  return {
    version: TRANSCRIPT_STORE_VERSION,
    connectionId,
    sessionId,
    selfLabel: null,
    rows: new Map(),
    tombstones: new Set(),
    open: new Set(),
    // What to echo as room_deletions_seen. Null asks for the room's tombstones
    // from the start: the first time, and whenever a relist is needed.
    deletionsSeen: null,
    backfill: { complete: false, generation: 0, draining: false, seen: new Set(), maxSeenSeq: 0 },
    lastCheck: null,
    repairs: [],
    pendingRedrain: null,
    // What the room produced and referenced, as references to fetch, plus the
    // server's history of what happened to them. Never a claim about an item's
    // state now (Ali, 2026-09-24; items 1a4f0246, 744c9724).
    activity: {
      seen: new Map(),
      events: [],
      eventIds: new Set(),
      eventsRevision: null,
      eventsReadable: null,
      eventsReadAt: null,
      readAt: null,
      available: null,
    },
    dirty: false,
    writeFailed: false,
    updatedAt: null,
  }
}

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

function addresseeLabel(addressee) {
  if (!addressee) return null
  if (addressee.kind === 'connection') return addressee.label
  if (addressee.kind === 'dev') return 'Dev'
  return null
}

function fileReferences(attachments) {
  return (attachments ?? []).map((item) => item.materialization === 'metadata'
    ? { filename: item.filename, mime_type: item.mime_type, size_bytes: item.size_bytes, resource_id: item.resource_id }
    : { filename: item.filename, mime_type: item.mime_type, size_bytes: item.size_bytes, unavailable: item.reason })
}

function contextLine(entry, described, selfLabel) {
  const state = described?.state ?? 'final'
  return {
    seq: entry.order.sequence,
    at: entry.order.created_at,
    message_id: entry.message_id,
    from: {
      label: entry.actor.display_name,
      kind: entry.actor.kind,
      ...(entry.actor.kind === 'agent' && selfLabel && entry.actor.agent_tool === selfLabel ? { you: true } : {}),
    },
    to: addresseeLabel(described?.addressee),
    text: state === 'deleted' ? null : entry.content,
    attachments: state === 'deleted' ? [] : fileReferences(described?.attachments),
    state,
  }
}

function commandLine(command, described, styleNotes) {
  return {
    seq: command.order.sequence,
    at: command.order.created_at,
    message_id: command.message_id,
    from: { label: command.requester.display_name ?? 'A teammate', kind: 'human' },
    to: command.addressee.label,
    text: command.content.body,
    attachments: fileReferences(described?.attachments ?? command.attachments),
    state: 'final',
    // A record of how the server delivered it, kept as history. Only the current
    // live delivery is ever handled; a line like this never becomes work again.
    delivered_as_command: {
      authority: command.authority.kind,
      // A delegated command's scope, with the server's instruction verbatim.
      ...(command.project_scope
        ? { project_scope: { project_id: command.project_scope.project_id, instruction: command.project_scope.instruction } }
        : {}),
      ...(styleNotes?.length ? { response_style: styleNotes } : {}),
    },
  }
}

/**
 * Merge one arriving line. The newer of the two states wins and a tombstone always
 * wins; the arriving text replaces what is held only when its state is at least as
 * new, so a stale page cannot overwrite a finished reply or resurrect a deletion.
 */
function merge(store, line) {
  const id = line.message_id
  const held = store.rows.get(id)
  if (store.backfill.draining) {
    store.backfill.seen.add(id)
    if (line.seq > store.backfill.maxSeenSeq) store.backfill.maxSeenSeq = line.seq
  }
  const known = store.tombstones.has(id) ? 'deleted' : held?.state
  const state = known && STATE_RANK[known] >= STATE_RANK[line.state] ? known : line.state
  let next
  if (state === 'deleted') {
    store.tombstones.add(id)
    store.open.delete(id)
    const base = held ?? line
    next = { ...base, state: 'deleted', text: null, attachments: [] }
  } else {
    const takeArrived = !held || STATE_RANK[line.state] >= STATE_RANK[held.state]
    next = takeArrived ? { ...line, state } : { ...held, state }
    if (held?.delivered_as_command && !next.delivered_as_command) next.delivered_as_command = held.delivered_as_command
    if (state === 'in_progress') store.open.add(id)
    else store.open.delete(id)
  }
  if (!held || JSON.stringify(held) !== JSON.stringify(next)) {
    store.rows.set(id, next)
    store.dirty = true
  }
}

function markDeleted(store, id) {
  store.tombstones.add(id)
  store.open.delete(id)
  const held = store.rows.get(id)
  if (held && held.state !== 'deleted') {
    store.rows.set(id, { ...held, state: 'deleted', text: null, attachments: [] })
    store.dirty = true
  }
}

// ---------------------------------------------------------------------------
// Applying a page
// ---------------------------------------------------------------------------

/**
 * Begin a full history drain: every row the room holds will be re-emitted, so a
 * row that is not seen again by the end of it is no longer in the room.
 */
export function beginDrain(store) {
  store.backfill.generation += 1
  store.backfill.draining = true
  store.backfill.seen = new Set()
  store.backfill.maxSeenSeq = 0
}

/**
 * A seed that found nothing to catch up (an empty room answers without a page):
 * the drain is over with nothing re-emitted, so there is nothing to keep or prune.
 */
export function completeEmptyDrain(store) {
  if (!store?.backfill.draining) return
  store.backfill.draining = false
  store.backfill.seen = new Set()
  store.backfill.maxSeenSeq = 0
  store.backfill.complete = true
}

function finishDrain(store) {
  if (store.backfill.draining) {
    // Within the range the drain re-emitted, a row it did not see again is gone
    // from the room (a hard delete has no product path today, but a copy must not
    // keep what the room lost). Rows beyond that range are left alone: they are
    // newer than the drain and arrive on live pages.
    const upTo = store.backfill.maxSeenSeq
    for (const [id, row] of [...store.rows]) {
      if (row.seq <= upTo && !store.backfill.seen.has(id)) {
        store.rows.delete(id)
        store.open.delete(id)
        store.tombstones.delete(id)
        store.dirty = true
      }
    }
  }
  store.backfill.draining = false
  store.backfill.seen = new Set()
  store.backfill.maxSeenSeq = 0
  store.backfill.complete = true
}

/**
 * Apply one validated 1.6.0 envelope. `drainPoll` says the request was part of the
 * history drain (a seed or a catch-up page). Returns what the copy concluded:
 * - `continue_deletions`: a deletions listing is unfinished (the next hold won't wait);
 * - `relist_deletions`: a deletion was missed; the next poll relists from the start;
 * - `unverified`: nothing to check against yet (no coverage, or still draining);
 * - `consistent`: the copy matches the room at the coverage point;
 * - `redrain`: rows are missing or extra; the copy asks to be re-read (bounded).
 */
export function applyIngressToStore(store, ingress, { sessionId, drainPoll = false, now = new Date() } = {}) {
  if (!store || sessionId !== store.sessionId) return { applied: false, reason: 'session_mismatch' }
  const room = ingress?.room_context
  if (!room) return { applied: false, reason: 'no_room_context' }
  store.selfLabel = ingress.connection.label

  const described = new Map(room.messages.map((message) => [message.message_id, message]))
  const styles = new Map((ingress.sender_response_styles ?? []).map((style) => [style.message_id, style.notes]))
  for (const command of ingress.commands) {
    merge(store, commandLine(command, described.get(command.message_id), styles.get(command.message_id)))
  }
  for (const bucket of CONTEXT_BUCKETS) {
    for (const entry of ingress.context[bucket]) {
      merge(store, contextLine(entry, described.get(entry.message_id), store.selfLabel))
    }
  }

  // open_check and deletions were read after coverage: newer for the rows they name.
  const newer = new Set()
  const removedAtOrBefore = []
  for (const check of room.open_check ?? []) {
    if (check.state === 'in_progress') continue
    newer.add(check.message_id)
    const held = store.rows.get(check.message_id)
    if (check.state === 'absent') {
      if (held) {
        removedAtOrBefore.push(held.seq)
        store.rows.delete(check.message_id)
        store.open.delete(check.message_id)
        store.dirty = true
      }
      continue
    }
    if (check.state === 'deleted') {
      markDeleted(store, check.message_id)
      continue
    }
    if (held) {
      merge(store, { ...contextLine(check.entry, null, store.selfLabel), to: held.to, attachments: held.attachments })
    }
  }

  let verdict = null
  const deletions = room.deletions
  if (deletions) {
    for (const id of deletions.message_ids) {
      newer.add(id)
      markDeleted(store, id)
    }
    store.deletionsSeen = deletions.seen
    if (deletions.truncated) {
      verdict = 'continue_deletions'
    } else if (store.tombstones.size < deletions.total) {
      // Complete, and still short of the room: one committed behind the point.
      store.deletionsSeen = null
      verdict = 'relist_deletions'
    }
  }

  if (drainPoll && !(ingress.window.has_more && ingress.window.next_cursor)) finishDrain(store)
  if (!verdict) verdict = checkCoverage(store, room.coverage, newer, removedAtOrBefore)

  store.lastCheck = {
    verdict,
    checked_at: now.toISOString(),
    through: room.coverage?.through ?? null,
    eligible_count: room.coverage?.eligible_count ?? null,
    deleted_count: room.coverage?.deleted_count ?? null,
  }
  if (verdict === 'redrain') requestRedrain(store, now)
  store.updatedAt = now.toISOString()
  return { applied: true, verdict }
}

/** The served comparison, for everything the later sections did not name. */
function checkCoverage(store, coverage, newer, removedAtOrBefore) {
  if (!coverage || !store.backfill.complete || store.backfill.draining) return 'unverified'
  const through = coverage.through.sequence
  let rowsHeld = 0
  let tombstonesHeld = 0
  for (const row of store.rows.values()) {
    if (row.seq > through) continue
    rowsHeld += 1
    if (row.state === 'deleted') tombstonesHeld += 1
  }
  const removed = removedAtOrBefore.filter((seq) => seq <= through).length
  // Rows: the count lies between what is held and what is held plus rows a later
  // section reported gone (which the count may or may not have included).
  if (coverage.eligible_count > rowsHeld + removed || coverage.eligible_count < rowsHeld) return 'redrain'
  // Tombstones only accumulate, so a complete copy holds at least as many.
  if (tombstonesHeld < coverage.deleted_count) {
    store.deletionsSeen = null
    return 'relist_deletions'
  }
  // A row held in progress that coverage no longer lists settled before the count;
  // it is still in `open`, so the next poll names it and open_check answers.
  void newer
  return 'consistent'
}

function requestRedrain(store, now) {
  const recent = store.repairs.filter((at) => now.getTime() - Date.parse(at) < DAY_MS)
  store.repairs = recent
  if (recent.length >= MAX_REPAIRS_PER_DAY) {
    store.pendingRedrain = null
    store.lastCheck = { ...(store.lastCheck ?? {}), repair_budget_spent: true }
    return
  }
  store.repairs.push(now.toISOString())
  store.pendingRedrain = 'mismatch'
}

/** Consumed by the poller when it starts the re-drain it was asked for. */
export function takePendingRedrain(store) {
  const pending = store?.pendingRedrain ?? null
  if (store) store.pendingRedrain = null
  return pending
}

// ---------------------------------------------------------------------------
// Poll arguments and summaries
// ---------------------------------------------------------------------------

/** What this copy asks the next 1.6.0 poll for (see the served contract). */
export function transcriptPollArguments(store) {
  if (!store) return {}
  const open = [...store.open].slice(0, ROOM_PAGE_MAX)
  return {
    room_context_version: 1,
    ...(open.length > 0 ? { room_open_message_ids: open } : {}),
    room_deletions_seen: store.deletionsSeen,
    // The room's record history (item 744c9724): echo the revision held, so an
    // unchanged list is not resent.
    session_events_version: 1,
    session_events_revision: store.activity.eventsRevision,
  }
}

function sortedLines(store) {
  return [...store.rows.values()].sort((a, b) => a.seq - b.seq)
}

/** The copy holds the room's history, not only the pages since it started. */
export function transcriptHasHistory(store) {
  return Boolean(store?.backfill.complete && !store.backfill.draining)
}

/**
 * How many messages came after this connection's own last post, counting only
 * those before `beforeSeq` (a command's own line is not "since" itself). Deleted
 * messages are not counted: there is nothing left to read. Navigation, not proof
 * that anything before the reply was read. Null while the copy is still filling
 * in history, because a count taken then is only the part that has arrived.
 */
export function messagesSinceLastReply(store, beforeSeq = Number.POSITIVE_INFINITY) {
  if (!transcriptHasHistory(store)) return null
  const lines = sortedLines(store).filter((line) => line.seq < beforeSeq)
  let count = 0
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]
    if (line.from?.you) break
    if (line.state !== 'deleted') count += 1
  }
  return count
}

/**
 * How the copy stands, for the room state file. `approx_tokens` is an estimate
 * (characters ÷ 4) and says so. `since_my_last_reply` is navigation — how many
 * messages came after this connection's own last post — not proof that anything
 * before it was read.
 */
export function transcriptSummary(store, { dir = DEFAULT_DIR } = {}) {
  if (!store) return null
  const lines = sortedLines(store)
  const chars = lines.reduce((sum, line) => sum + (line.text?.length ?? 0), 0)
  const hasMyReply = lines.some((line) => line.from?.you)
  const status = store.writeFailed
    ? 'write_failed'
    : store.backfill.draining || !store.backfill.complete
      ? 'backfilling'
      : store.lastCheck?.verdict === 'consistent'
        ? 'complete'
        : store.lastCheck?.verdict === 'redrain'
          ? (store.lastCheck?.repair_budget_spent ? 'mismatch' : 'repairing')
          : 'unverified'
  return {
    path: transcriptPaths(store.connectionId, store.sessionId, dir).transcript,
    messages: lines.length,
    deleted: lines.filter((line) => line.state === 'deleted').length,
    in_progress: store.open.size,
    approx_tokens: Math.ceil(chars / 4),
    approx_tokens_is_estimate: true,
    complete: status === 'complete',
    status,
    since_my_last_reply: messagesSinceLastReply(store),
    has_my_reply: hasMyReply,
    last_check: store.lastCheck,
    as_of: store.updatedAt,
  }
}

// ---------------------------------------------------------------------------
// Session activity: references, and the history of what happened to them
// ---------------------------------------------------------------------------

/**
 * Keep the server's list of what the room produced and referenced as references
 * only: kind, id, title, relation and creator. Its status is how the record stood
 * when the list was read, and a copy that kept it would be claiming to know how it
 * stands now (Ali, 2026-09-24). The current state of any record is read from the
 * database with the MCP tools. An unavailable list changes nothing.
 */
export function observeSessionActivity(store, activity, now = new Date()) {
  if (!store || !activity) return
  store.activity.readAt = now.toISOString()
  store.activity.available = activity.status === 'available'
  if (activity.status !== 'available') return
  store.activity.seen = new Map(activity.entries.map((entry) => [`${entry.kind}:${entry.id}`, {
    kind: entry.kind, id: entry.id, title: entry.title, relation: entry.relation, creator: entry.creator,
  }]))
}

const eventOrder = (a, b) => (a.at === b.at ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : Date.parse(a.at) - Date.parse(b.at))

/**
 * Keep the server's history of the room's records (item 744c9724): produced,
 * first mentioned, an item's lifecycle moving, a memory or artifact superseded,
 * retracted or archived, each with when it happened. Append-only by event id: an
 * event this copy holds is never rewritten or dropped. `unchanged` means the copy
 * already holds the revision; `unavailable` asserts nothing and keeps what we have.
 */
export function observeSessionEvents(store, section, now = new Date()) {
  if (!store || !section) return
  store.activity.eventsReadAt = now.toISOString()
  store.activity.eventsReadable = section.status !== 'unavailable'
  if (section.status === 'unavailable') return
  if (section.status === 'available') {
    let added = false
    for (const event of section.events) {
      if (store.activity.eventIds.has(event.id)) continue
      store.activity.eventIds.add(event.id)
      store.activity.events.push(event)
      added = true
    }
    if (added) store.activity.events.sort(eventOrder)
  }
  store.activity.eventsRevision = section.revision
}

/** The room file's view: references to fetch, and what happened to them. */
export function sessionActivityView(store) {
  if (!store || store.activity.available === null) return null
  return {
    note:
      'References to what this room produced or mentioned, and what happened to them ' +
      '(at = when it happened). Never how anything stands now: fetch a record with ' +
      'get_action_item, get_memory or get_resource for that.',
    list_readable: store.activity.available,
    last_read_at: store.activity.readAt,
    items: [...store.activity.seen.values()].map(({ kind, id, title, relation, creator }) => ({ kind, id, title, relation, creator })),
    events_readable: store.activity.eventsReadable,
    events: store.activity.events,
  }
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/**
 * Write the copy: the transcript first, then the store's own state. A crash between
 * the two leaves a newer transcript beside older state, which loading reconciles
 * (tombstones and open rows are re-derived from the lines). Returns false on a
 * failed write, which the store remembers so the room state can say so.
 */
export function persistTranscriptStore(store, { dir = DEFAULT_DIR, writeText = writePrivateText, writeJson = writePrivateJson } = {}) {
  const paths = transcriptPaths(store.connectionId, store.sessionId, dir)
  try {
    if (store.dirty) {
      const text = sortedLines(store).map((line) => JSON.stringify(line)).join('\n')
      writeText(paths.transcript, text ? `${text}\n` : '')
      store.dirty = false
    }
    writeJson(paths.state, {
      version: TRANSCRIPT_STORE_VERSION,
      connection_id: store.connectionId,
      session_id: store.sessionId,
      self_label: store.selfLabel,
      tombstones: [...store.tombstones],
      open: [...store.open],
      deletions_seen: store.deletionsSeen,
      // A restart always begins a fresh drain, so progress inside one is not kept.
      backfill: { complete: store.backfill.complete, generation: store.backfill.generation },
      last_check: store.lastCheck,
      repairs: store.repairs,
      activity: {
        seen: [...store.activity.seen.values()],
        history: store.activity.events,
        history_revision: store.activity.eventsRevision,
        history_readable: store.activity.eventsReadable,
        history_read_at: store.activity.eventsReadAt,
        read_at: store.activity.readAt,
        available: store.activity.available,
      },
      updated_at: store.updatedAt,
    })
    store.writeFailed = false
    return true
  } catch {
    store.writeFailed = true
    return false
  }
}

/** Parse newline-terminated lines only; a torn last line is not a record. */
function readLines(text) {
  const out = []
  const complete = text.slice(0, text.lastIndexOf('\n') + 1)
  for (const raw of complete.split('\n')) {
    if (!raw.trim()) continue
    try {
      const line = JSON.parse(raw)
      if (typeof line?.message_id === 'string' && Number.isSafeInteger(line.seq)) out.push(line)
    } catch {
      /* not a record */
    }
  }
  return out
}

/**
 * Load this room's copy, or start an empty one. Tombstones and open rows are
 * re-derived from the transcript as well as read from state, so a crash between the
 * two writes loses neither. A copy for another room or connection is never read.
 */
export function loadTranscriptStore(connectionId, sessionId, { dir = DEFAULT_DIR } = {}) {
  const store = createTranscriptStore(connectionId, sessionId)
  if (!connectionId || !sessionId) return store
  const paths = transcriptPaths(connectionId, sessionId, dir)
  let text = ''
  try { text = fs.readFileSync(paths.transcript, 'utf8') } catch { /* no copy yet */ }
  for (const line of readLines(text)) {
    store.rows.set(line.message_id, line)
    if (line.state === 'deleted') store.tombstones.add(line.message_id)
    if (line.state === 'in_progress') store.open.add(line.message_id)
  }
  let state = null
  try { state = JSON.parse(fs.readFileSync(paths.state, 'utf8')) } catch { /* none, or unreadable */ }
  if (state && state.version === TRANSCRIPT_STORE_VERSION &&
      state.connection_id === connectionId && state.session_id === sessionId) {
    store.selfLabel = typeof state.self_label === 'string' ? state.self_label : null
    for (const id of Array.isArray(state.tombstones) ? state.tombstones : []) {
      if (typeof id === 'string') markDeleted(store, id)
    }
    store.deletionsSeen = state.deletions_seen ?? null
    store.backfill.complete = state.backfill?.complete === true
    store.backfill.generation = Number.isSafeInteger(state.backfill?.generation) ? state.backfill.generation : 0
    store.lastCheck = state.last_check ?? null
    store.repairs = Array.isArray(state.repairs) ? state.repairs.filter((at) => typeof at === 'string') : []
    const activity = state.activity
    if (activity && Array.isArray(activity.seen)) {
      // References only. A copy written before 0.32.4 also kept each item's status
      // and a list of changes it had noticed ("seen_at"); neither is carried over,
      // because both were claims about state rather than history (item 744c9724).
      store.activity.seen = new Map(activity.seen.filter((item) => item?.kind && item?.id).map((item) => [
        `${item.kind}:${item.id}`,
        { kind: item.kind, id: item.id, title: item.title, relation: item.relation, creator: item.creator ?? null },
      ]))
      store.activity.readAt = activity.read_at ?? null
      store.activity.available = typeof activity.available === 'boolean' ? activity.available : null
    }
    if (activity && Array.isArray(activity.history)) {
      const events = activity.history.filter((event) => typeof event?.id === 'string' && typeof event?.at === 'string')
      store.activity.events = events.sort(eventOrder)
      store.activity.eventIds = new Set(events.map((event) => event.id))
      store.activity.eventsRevision = typeof activity.history_revision === 'string' ? activity.history_revision : null
      store.activity.eventsReadable = typeof activity.history_readable === 'boolean' ? activity.history_readable : null
      store.activity.eventsReadAt = activity.history_read_at ?? null
    }
    store.updatedAt = state.updated_at ?? null
  }
  // markDeleted above may have flagged rows already written as tombstones; nothing
  // new is known, so there is nothing to rewrite.
  store.dirty = false
  return store
}
