/**
 * Command offer and question-to-command handoff (item a11d27fa,
 * devspec://product/command-offer-contract).
 *
 * When a connection is working on an answered directed question, a conversational
 * command that arrives behind it is held back by the server (`delivery_retry`) until
 * that question's turn finishes. The server now advertises that held command on
 * `poll_connection` via `command_offers` (availability only — no body, no authority,
 * no cursor movement) and lets this poller declare `command_handoff_ready` on the
 * next poll once the answer has been durably delivered into the model's wake stream,
 * retiring the question's attempt and delivering the canonical command in one move.
 */

import { isCanonicalIsoDatetime, isCanonicalUuid } from './remote-ingress-v1.mjs'
import { continuationDelivered } from './interaction-events.mjs'

export const COMMAND_OFFER_CONTRACT_URI = 'devspec://product/command-offer-contract'
export const COMMAND_OFFER_VERSION = 1
export const COMMAND_OFFER_KIND = 'devspec.command_offer'

const OFFER_KEYS = new Set([
  'kind',
  'version',
  'offer_id',
  'origin_connection_id',
  'source_session_id',
  'attachment_id',
  'source_message_id',
  'created_at',
  'blocking_attempt_id',
  'blocking_question_id',
  'blocking_event_id',
  'blocking_response_id',
])

const HANDOFF_KEYS = new Set(['question_id', 'source_message_id'])

function hasExactKeys(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Object.keys(value)
  return keys.length === allowed.size && keys.every((key) => allowed.has(key))
}

/**
 * Can this poll negotiate command offers?
 *
 * Catch-up / seed polls are history drains, never live handoffs, and an offer names
 * the live speech attachment (`attachment_id`), so we negotiate only once we know
 * our capability, our attached session, and that session's current attachment id.
 */
export function commandOfferNegotiable({
  connectionCapability = null,
  sessionId = null,
  attachmentId = null,
  catchUp = false,
} = {}) {
  return Boolean(
    !catchUp &&
    typeof connectionCapability === 'string' && connectionCapability.startsWith('dvsc_') &&
    isCanonicalUuid(sessionId) &&
    isCanonicalUuid(attachmentId),
  )
}

/**
 * Poll arguments for the offer/handoff exchange. A readiness requires the version on
 * the same call; when not negotiable, neither field is sent.
 */
export function commandOfferArguments({ negotiable = false, ready = null } = {}) {
  if (!negotiable) return {}
  return {
    command_offer_version: COMMAND_OFFER_VERSION,
    ...(ready ? { command_handoff_ready: ready } : {}),
  }
}

export function validateCommandOffer(
  offer,
  { connectionId = null, sessionId = null, attachmentId = null } = {},
) {
  if (!hasExactKeys(offer, OFFER_KEYS)) {
    return { ok: false, error: 'command offer must have the exact v1 key set' }
  }
  if (offer.kind !== COMMAND_OFFER_KIND || offer.version !== COMMAND_OFFER_VERSION) {
    return { ok: false, error: 'command offer kind/version mismatch' }
  }
  for (const field of [
    'offer_id',
    'origin_connection_id',
    'source_session_id',
    'attachment_id',
    'source_message_id',
    'blocking_attempt_id',
    'blocking_question_id',
    'blocking_event_id',
    'blocking_response_id',
  ]) {
    if (!isCanonicalUuid(offer[field])) {
      return { ok: false, error: `command offer ${field} must be a canonical UUID` }
    }
  }
  if (!isCanonicalIsoDatetime(offer.created_at)) {
    return { ok: false, error: 'command offer created_at must be an ISO datetime' }
  }
  if (!isCanonicalUuid(connectionId) || offer.origin_connection_id !== connectionId) {
    return { ok: false, error: 'command offer origin_connection_id does not match this connection' }
  }
  if (!isCanonicalUuid(sessionId) || offer.source_session_id !== sessionId) {
    return { ok: false, error: 'command offer source_session_id does not match the attached session' }
  }
  if (!isCanonicalUuid(attachmentId) || offer.attachment_id !== attachmentId) {
    return { ok: false, error: 'command offer attachment_id does not match the current attachment' }
  }
  return { ok: true, offer }
}

/**
 * Read the offer sidecar from a `poll_connection` response. Throws on malformed
 * shapes so the caller logs and ignores the offer without touching canonical ingress.
 */
export function parseCommandOfferResponse(
  res,
  { connectionId = null, sessionId = null, attachmentId = null } = {},
) {
  if (!res || typeof res !== 'object') return { supported: false, offer: null, stale: false }
  const hasVersion = Object.hasOwn(res, 'command_offer_version')
  const hasOffers = Object.hasOwn(res, 'command_offers')
  const hasStale = Object.hasOwn(res, 'command_handoff_stale')
  if (!hasVersion && !hasOffers && !hasStale) {
    return { supported: false, offer: null, stale: false }
  }
  if (res.command_offer_version !== COMMAND_OFFER_VERSION) {
    throw new Error(`unsupported command_offer_version: ${String(res.command_offer_version)}`)
  }
  if (!Array.isArray(res.command_offers) || res.command_offers.length > 1) {
    throw new Error('command_offers must be an array of at most 1 offer')
  }
  if (hasStale && typeof res.command_handoff_stale !== 'boolean') {
    throw new Error('command_handoff_stale must be a boolean when present')
  }
  const stale = res.command_handoff_stale === true
  if (res.command_offers.length === 0) {
    return { supported: true, offer: null, stale }
  }
  const validated = validateCommandOffer(res.command_offers[0], {
    connectionId,
    sessionId,
    attachmentId,
  })
  if (!validated.ok) throw new Error(validated.error)
  return { supported: true, offer: validated.offer, stale }
}

/**
 * Decide whether an offered command may take over the open question continuation.
 *
 * All four gates must hold before we send `command_handoff_ready`:
 *   1. There is an offer.
 *   2. We hold a live answer continuation (never a dismissal) whose attempt,
 *      question, event and response ids all match the offer's `blocking_*` fields.
 *   3. The answer's own `interaction_ack` has already been sent (`ackPending === false`),
 *      because the server only hands over an answer it has recorded as applied.
 *   4. The wait stream has already flushed the answer events to the model
 *      (`continuationDelivered(continuation, inboxByteOffset)`), so the model never
 *      receives the follow-up command without having received the answer first.
 */
export function commandHandoffDecision({
  offer = null,
  continuation = null,
  ackPending = false,
  inboxByteOffset = null,
} = {}) {
  if (!offer) return { action: 'none' }
  if (!continuation || typeof continuation !== 'object') {
    return { action: 'wait', reason: 'no_active_continuation' }
  }
  if (
    continuation.attempt_id !== offer.blocking_attempt_id ||
    continuation.question_id !== offer.blocking_question_id ||
    continuation.event_id !== offer.blocking_event_id ||
    typeof continuation.response_id !== 'string' ||
    continuation.response_id !== offer.blocking_response_id ||
    typeof continuation.claim_token !== 'string' ||
    !isCanonicalUuid(continuation.claim_token)
  ) {
    return { action: 'wait', reason: 'continuation_mismatch' }
  }
  if (ackPending) {
    return { action: 'wait', reason: 'interaction_ack_pending' }
  }
  if (!continuationDelivered(continuation, inboxByteOffset)) {
    return { action: 'wait', reason: 'answer_not_yet_delivered_to_wait' }
  }
  return {
    action: 'ready',
    ready: {
      offer_id: offer.offer_id,
      source_session_id: offer.source_session_id,
      attachment_id: offer.attachment_id,
      source_message_id: offer.source_message_id,
      attempt_id: offer.blocking_attempt_id,
      interaction_event_id: offer.blocking_event_id,
      interaction_response_id: offer.blocking_response_id,
      interaction_claim_token: continuation.claim_token,
    },
  }
}

export function commandHandoffKey(ready) {
  if (!ready || typeof ready !== 'object') return ''
  return `${ready.offer_id}:${ready.attempt_id}:${ready.source_message_id}`
}

/** Validate the `question_handoff` annotation stored on a `canonical_commands` inbox record. */
export function validQuestionHandoff(value, executeMessageIds = null) {
  if (!hasExactKeys(value, HANDOFF_KEYS)) return null
  if (!isCanonicalUuid(value.question_id) || !isCanonicalUuid(value.source_message_id)) return null
  if (executeMessageIds instanceof Set && !executeMessageIds.has(value.source_message_id)) return null
  return {
    question_id: value.question_id,
    source_message_id: value.source_message_id,
  }
}

/**
 * Advisory wake event emitted immediately before the `owner_message` that took over
 * the answered question's turn, so the model knows `devspec-question.mjs respond` is
 * closed and a normal `post_session_message` reply answers both.
 */
export function questionHandoffEvent(handoff, { sessionId = null } = {}) {
  return {
    type: 'question_turn_handed_off',
    question_id: handoff.question_id,
    to_message_id: handoff.source_message_id,
    session_id: sessionId,
    authoritative: false,
    executable: false,
    note:
      `Your question ${handoff.question_id}'s turn was handed to message ${handoff.source_message_id} ` +
      'below. Do not run `devspec-question.mjs respond` for that question — reply to this message ' +
      'with `post_session_message` instead.',
  }
}
