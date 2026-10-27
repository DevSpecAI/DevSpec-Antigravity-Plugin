#!/usr/bin/env node
/**
 * Claude Code's half of the negotiated command handoff (item a11d27fa; server
 * 9abe0be20 / migration 985, Pi reference 4284a43c).
 *
 * While an answered question's exact continuation owns this connection, the server
 * holds every ordinary command back (migration 904), so a message the person sends
 * while Claude is still working on their answer used to wait until that work ended.
 * With `command_offer_version: 1` the poll says so instead: a non-executable offer
 * naming the held message and the exact question attempt holding it. It has no body
 * and no authority, and it never reaches the model.
 *
 * Pi has to abort its foreground and wait for it to settle before it can take a new
 * message. Claude Code does not: a monitor event reaches a running conversation
 * between steps. So this host is ready as soon as the answer itself is settled — its
 * application ACKed (the server refuses a handoff for an unacknowledged answer) and its
 * events flushed to the model. The next poll then carries `command_handoff_ready` with
 * the exact question identity; under the connection lock the server retires the
 * question attempt and opens the held message through the ordinary canonical
 * delivery, and that same response delivers it. Nothing is interrupted: the model
 * keeps what it was doing and reads the new message at its next step.
 *
 * Pure functions only, so the poller, the wait stream and the tests share one
 * definition of each rule.
 */

import { continuationDelivered, continuationIdentity } from './interaction-events.mjs'
import { isRemoteIngressAttachment } from './remote-ingress-v1.mjs'

export const COMMAND_OFFER_VERSION = 1
export const QUESTION_HANDOFF_EVENT = 'question_turn_handed_over'

const UUID = /^(?:00000000-0000-0000-0000-000000000000|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i
const OFFER_KEYS = ['version', 'connection_id', 'source_session_id', 'attachment_id',
  'source_message_id', 'blocking_attempt_id', 'attachments']

function isUuid(value) {
  return typeof value === 'string' && UUID.test(value)
}

/**
 * Can this poll negotiate offers?
 *
 * The server refuses `command_offer_version` without the exact connection capability,
 * so negotiating without one would fail the whole poll. It computes offers only on a
 * live poll of an attached connection with a speech attachment, never on a catch-up
 * page, so there is nothing to ask for otherwise.
 */
export function commandOfferNegotiable({ connectionCapability, sessionId, attachmentId, catchUp } = {}) {
  return Boolean(
    typeof connectionCapability === 'string' && connectionCapability &&
    isUuid(sessionId) && isUuid(attachmentId) && !catchUp,
  )
}

/** Poll arguments. `ready` rides only a negotiated poll. */
export function commandOfferArguments({ negotiable, ready = null } = {}) {
  if (!negotiable) return {}
  return { command_offer_version: COMMAND_OFFER_VERSION, ...(ready ? { command_handoff_ready: ready } : {}) }
}

/**
 * Read the offer sidecar, strictly.
 *
 * `supported:false` is a server that does not offer (the legacy lane, unchanged).
 * Throws on anything malformed or aimed elsewhere, and the caller treats a throw as
 * "no offer": a bad sidecar can only cost the early handoff, never deliver anything.
 */
export function parseCommandOfferResponse(res, { connectionId, sessionId, attachmentId } = {}) {
  if (!res || typeof res !== 'object' || Array.isArray(res)) throw new Error('invalid command offer response')
  if (res.command_offer_version === undefined) return { supported: false, stale: false, offer: null }
  if (res.command_offer_version !== COMMAND_OFFER_VERSION || typeof res.command_handoff_stale !== 'boolean') {
    throw new Error('unsupported command offer response')
  }
  if (res.command_offer === null) return { supported: true, stale: res.command_handoff_stale, offer: null }
  const offer = res.command_offer
  if (!offer || typeof offer !== 'object' || Array.isArray(offer)) throw new Error('invalid command offer')
  const keys = Object.keys(offer)
  if (keys.length !== OFFER_KEYS.length || OFFER_KEYS.some((key) => !Object.hasOwn(offer, key)) || offer.version !== 1) {
    throw new Error('invalid command offer fields')
  }
  for (const key of OFFER_KEYS.slice(1, -1)) {
    if (!isUuid(offer[key])) throw new Error(`command offer ${key} is not a UUID`)
  }
  if (offer.connection_id !== connectionId || offer.source_session_id !== sessionId || offer.attachment_id !== attachmentId) {
    throw new Error('command offer is not for this connection, room and attachment')
  }
  if (!Array.isArray(offer.attachments) || !offer.attachments.every(isRemoteIngressAttachment)) {
    throw new Error('invalid command offer attachments')
  }
  return { supported: true, stale: res.command_handoff_stale, offer }
}

/**
 * What an offer asks of this host.
 *
 * `ignore` — the offer is not about a question this host holds, so there is nothing
 *            of ours to hand over and the legacy wait applies.
 * `wait`   — ours, but the answer is not settled yet: its ACK has not ridden a poll
 *            that returned, or its events have not reached the model. Handing over
 *            before the model has the answer would close the reply channel its wake
 *            is about to name. A later poll offers again.
 * `ready`  — send `ready` on the next poll.
 */
export function commandHandoffDecision({ offer, continuation, ackPending = false, inboxByteOffset = null } = {}) {
  if (!offer) return { action: 'ignore', reason: 'no offer' }
  if (!continuation || continuation.attempt_id !== offer.blocking_attempt_id) {
    return { action: 'ignore', reason: 'not blocked by a question this host holds' }
  }
  if (continuation.session_id !== offer.source_session_id) {
    return { action: 'ignore', reason: 'the question belongs to another room' }
  }
  if (ackPending) return { action: 'wait', reason: 'the answer has not been acknowledged yet' }
  if (!continuationDelivered(continuation, inboxByteOffset)) {
    return { action: 'wait', reason: 'the answer has not reached the model yet' }
  }
  return {
    action: 'ready',
    ready: {
      source_message_id: offer.source_message_id,
      attempt_id: continuation.attempt_id,
      attachment_id: offer.attachment_id,
      ...continuationIdentity(continuation),
    },
  }
}

/** One key per (message, question attempt): a repeat is retried with backoff, not at once. */
export function commandHandoffKey(ready) {
  return ready ? `${ready.source_message_id}:${ready.attempt_id}` : null
}

/**
 * The marker the poller puts on the inbox record of a handed-over message, revalidated
 * when read back: it came from a file. Null unless it names a message in this batch.
 */
export function validQuestionHandoff(value, commandIds) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  if (!isUuid(value.question_id) || !isUuid(value.source_message_id)) return null
  if (!commandIds.has(value.source_message_id)) return null
  return { question_id: value.question_id, source_message_id: value.source_message_id }
}

/**
 * The model-facing notice, emitted just before the message it describes. Without it the
 * answer's own wake is the last word on how to reply, and that names a channel the
 * handoff has closed. Kept well under the host's 500-character line cap.
 */
export function questionHandoffEvent(handoff, { sessionId = null } = {}) {
  return {
    type: QUESTION_HANDOFF_EVENT,
    question_id: handoff.question_id,
    message_id: handoff.source_message_id,
    note:
      'The next message came while you worked on the answer and now owns the turn. The ' +
      'question\'s reply channel is closed: do not use devspec-question respond. Reply with ' +
      'post_session_message and connection_id, covering the answer\'s work if still owed.',
    session_id: sessionId,
    authoritative: false,
    executable: false,
  }
}
