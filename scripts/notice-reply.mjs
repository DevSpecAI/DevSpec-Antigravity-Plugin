/**
 * Replies to DevSpec notices (server item 8885423d; this plugin item fdc96b30).
 *
 * DevSpec sends notices about the agent's own work (findings, outcomes, reviews) to
 * its exact connection, outside every command and turn. Telling the person about one
 * in the room is `post_session_message` with `system_notice_ids`: the server stores it
 * as the agent's own message, labelled as a reply to those notices, and binds it to no
 * command turn. A plain post from a connection with no command open is instead filed
 * as a late answer to the agent's previous command, which is the bug this fixes.
 * The served contract is `semantics.notice_reply` in devspec://product/remote-ingress-contract.
 *
 * How the ids reach the post:
 * - Every notice the wake hands the model ends with the exact call and its id
 *   (`noticeReplyInstruction`), so the model copies ids from the text in front of it.
 * - The turn marker (`<connectionId>.turn`) records which wakes were delivered into
 *   the turn: `noticeIds` for notices, `otherWake` for anything else (a command, an
 *   automation run, an answered question). When every wake in the turn was a notice
 *   and nothing else is open on the connection, every post the model makes in it is
 *   about those notices, so PreToolUse stamps their ids itself (`turnNoticeIds`).
 *   Anywhere else (a notice that arrives while a command is being worked) the plugin
 *   cannot tell which post is about the notice, so it stamps nothing and the model
 *   passes the ids it was given.
 *
 * Imports only `requests.mjs` (Node built-ins), so mirror-turn.mjs can import it.
 */

import { NO_REQUEST } from './requests.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const NOTICE_REPLY_CONTRACT = 'semantics.notice_reply in devspec://product/remote-ingress-contract'

/**
 * The model-facing line under each notice (and under a batch): the exact call, with the
 * exact ids, and what the reply does and does not do.
 */
export function noticeReplyInstruction(ids) {
  const list = (Array.isArray(ids) ? ids : [ids]).filter((id) => typeof id === 'string' && id)
  const subject = list.length === 1 ? 'this notice' : `these ${list.length} notices`
  return (
    `Telling the person about ${subject} in the room is a notice reply: ` +
    `post_session_message({ message, system_notice_ids: ${JSON.stringify(list)} }). ` +
    'It is your own message, labelled as a reply to the notice and never as an answer to a command: ' +
    'complete_turn has no effect on it, and a command you are working on still ends with its own answer. ' +
    'A refusal gives DevSpec\'s reason; when you are attached to no room, tell the person here in the terminal instead. ' +
    `See ${NOTICE_REPLY_CONTRACT}.`
  )
}

/**
 * Shape only, never meaning: a host whose cached tool schema predates
 * `system_notice_ids` can hand the array over as a string ('["<id>"]', '<id>',
 * '<id>, <id>'). Anything that is not one of those is passed on untouched, so the
 * server's own refusal reaches the model.
 */
export function normalizeNoticeIds(value) {
  if (Array.isArray(value) || typeof value !== 'string') return value
  const text = value.trim()
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text)
      if (Array.isArray(parsed)) return parsed
    } catch {
      /* not JSON: read it as a list below */
    }
  }
  const parts = text
    .replace(/^\[|\]$/g, '')
    .split(/[\s,]+/)
    .map((part) => part.replace(/^["']+|["']+$/g, ''))
    .filter(Boolean)
  return parts.length > 0 && parts.every((part) => UUID.test(part)) ? parts : value
}

/** The arguments of a post the model aimed at something other than this turn's notices. */
const ADDRESSED_ELSEWHERE = [
  'command_turn_id',
  'command_message_id',
  'attempt_id',
  'reply_to_message_id',
  'needs_input',
  'work_trail',
  'trail_events',
  'assistant_source_id',
  'ingest_version',
  'expected_session_id',
  'expected_attached_at',
  'expected_attachment_id',
  'interaction_event_version',
  'interaction_event_id',
  'interaction_response_id',
  'interaction_claim_token',
  'question_dismissal_event_version',
  'question_dismissal_event_id',
  'question_dismissal_question_id',
  'question_dismissal_claim_token',
]

const present = (value) => value !== undefined && value !== null && value !== ''

/**
 * Whether a `post_session_message` the model wrote without `system_notice_ids` can take
 * the turn's notices: an ordinary answer, aimed at no command, message, question or
 * terminal turn of its own.
 */
export function postCanTakeTurnNotices(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false
  if (args.system_notice_ids !== undefined) return false
  if (args.command_turn_unbound === true || args.local_turn === true) return false
  if (args.phase !== undefined && args.phase !== 'answer') return false
  if (args.turn_kind !== undefined && args.turn_kind !== 'agent') return false
  return ADDRESSED_ELSEWHERE.every((key) => !present(args[key]))
}

/**
 * The notices this turn is about, when that is certain; otherwise null.
 *
 * Certain means: the turn marker records at least one notice delivered into this turn
 * and no other wake, no prompt was typed at the terminal for it, and the connection
 * serves no command, typed prompt or automation run (`requestState` from requests.mjs).
 * A stale marker or request left by an earlier turn only ever makes this null, never
 * the other way round.
 */
export function turnNoticeIds({ marker, requestState = null, connectionState = null } = {}) {
  const ids = Array.isArray(marker?.noticeIds)
    ? marker.noticeIds.filter((id) => typeof id === 'string' && UUID.test(id))
    : []
  if (ids.length === 0) return null
  if (marker.otherWake || marker.localPromptMirrored || marker.localTurn || connectionState?.local_turn) {
    return null
  }
  if (requestState) {
    if (requestState.current === NO_REQUEST) return null
    if (requestState.current && requestState.open?.has?.(requestState.current)) return null
    if (requestState.joined?.size > 0) return null
  }
  return [...new Set(ids.map((id) => id.toLowerCase()))]
}

/**
 * What one delivered inbox entry adds to the turn marker: its notice ids, or
 * `otherWake` for anything that is not a notice. A control entry (abort, model switch)
 * is no input to the turn and adds nothing.
 */
export function turnWakeFromEntry(entry) {
  if (!entry || typeof entry !== 'object') return null
  if (entry.type === 'canonical_control') return null
  if (entry.type === 'canonical_system_notices') {
    const ids = Array.isArray(entry.execute_notice_ids)
      ? entry.execute_notice_ids
      : Array.isArray(entry.ingress?.system_notices)
        ? entry.ingress.system_notices.map((notice) => notice?.notice_id)
        : []
    const noticeIds = ids.filter((id) => typeof id === 'string' && UUID.test(id))
    return noticeIds.length > 0 ? { noticeIds } : null
  }
  return { otherWake: true }
}

/**
 * The same, read from the wake text a turn opened with (the JSON lines the listener
 * and the wait script deliver). Used by PreInvocation, which sees the step itself.
 */
export function turnWakeFromText(text) {
  const noticeIds = []
  let otherWake = false
  for (const line of String(text || '').split('\n')) {
    const start = line.indexOf('{')
    if (start < 0 || !line.includes('"type"')) continue
    let event
    try {
      event = JSON.parse(line.slice(start))
    } catch {
      continue
    }
    if (!event || typeof event !== 'object') continue
    if (event.type === 'system_notice' && typeof event.notice_id === 'string') {
      noticeIds.push(event.notice_id)
    } else if (event.type === 'wake') {
      if (event.reason === 'exact_connection_system_notice') {
        if (Array.isArray(event.system_notice_ids)) noticeIds.push(...event.system_notice_ids)
      } else {
        otherWake = true
      }
    } else if (event.type === 'owner_message' || event.type === 'automation_run') {
      otherWake = true
    }
  }
  const ids = noticeIds.filter((id) => typeof id === 'string' && UUID.test(id))
  if (otherWake) return { otherWake: true }
  return ids.length > 0 ? { noticeIds: ids } : null
}

/** Fold a wake into the marker's record: notice ids accumulate, `otherWake` sticks. */
export function mergeTurnWake(marker, wake) {
  if (!wake) return {}
  if (wake.otherWake) return { otherWake: true }
  const held = Array.isArray(marker?.noticeIds) ? marker.noticeIds : []
  return { noticeIds: [...new Set([...held, ...(wake.noticeIds ?? [])])] }
}
