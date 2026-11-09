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
 * Whether to say anything in the room at all is DevSpec's label on each notice, never
 * this plugin's guess (item a868f41f; `semantics.notice_audience` in the served
 * contract). At system notice version 3 every notice carries `audience`:
 * `needs_person` or `for_the_record`. The turn marker keeps the two apart
 * (`noticeIds` / `recordNoticeIds`): Stop replies only to notices that need a person,
 * and a turn woken only by check jobs and for-the-record notices is routine
 * (`isRoutineTurn`) and ends with nothing in the room. A notice with no label (one
 * persisted before this version) is read as needing a person, as DevSpec reads one:
 * an unknown never makes a notice quiet.
 *
 * Imports only `requests.mjs` (Node built-ins), so mirror-turn.mjs can import it.
 */

import { NO_REQUEST } from './requests.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const NOTICE_REPLY_CONTRACT = 'semantics.notice_reply in devspec://product/remote-ingress-contract'
export const NOTICE_AUDIENCE_CONTRACT = 'semantics.notice_audience in devspec://product/remote-ingress-contract'

/** DevSpec's two labels (system notice version 3). */
export const NOTICE_AUDIENCES = Object.freeze(['needs_person', 'for_the_record'])

/** A notice's label; one without a label needs a person, as DevSpec reads it. */
export function noticeAudience(notice) {
  return notice?.audience === 'for_the_record' ? 'for_the_record' : 'needs_person'
}

/**
 * The model-facing line under a notice DevSpec labelled for the record, in place of the
 * reply call: the label, where its meaning lives, and what this plugin does with it.
 */
export function noticeForTheRecordLine() {
  return (
    `DevSpec labels this notice for the record (${NOTICE_AUDIENCE_CONTRACT}); its prompt above opens with what that asks of you, ` +
    'and a write result that carries `tell_person` is `semantics.notice_audience.telling_anyway` there. This plugin posts no reply to it.'
  )
}

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

const validIds = (list) =>
  Array.isArray(list) ? list.filter((id) => typeof id === 'string' && UUID.test(id)) : []
const uniqueIds = (list) => [...new Set(list.map((id) => id.toLowerCase()))]

/**
 * Whether something other than DevSpec notices and check jobs is the turn's subject: a
 * command, an automation run, an answered question, a prompt typed at the terminal, or
 * a request still open on the connection (`requestState` from requests.mjs). A stale
 * marker or request left by an earlier turn only ever makes this true.
 */
function turnHasOtherSubject({ marker, requestState = null, connectionState = null }) {
  if (marker?.otherWake || marker?.localPromptMirrored || marker?.localTurn || connectionState?.local_turn) {
    return true
  }
  if (requestState) {
    if (requestState.current === NO_REQUEST) return true
    if (requestState.current && requestState.open?.has?.(requestState.current)) return true
    if (requestState.joined?.size > 0) return true
  }
  return false
}

/**
 * The notices this turn is about, when that is certain; otherwise null. Both labels:
 * a notice-only turn of either kind has no command turn to carry a trail.
 *
 * Certain means: the turn marker records at least one notice delivered into this turn
 * and no other wake, no prompt was typed at the terminal for it, and the connection
 * serves no command, typed prompt or automation run (`turnHasOtherSubject`).
 */
export function turnNoticeIds({ marker, requestState = null, connectionState = null } = {}) {
  const ids = [...validIds(marker?.noticeIds), ...validIds(marker?.recordNoticeIds)]
  if (ids.length === 0) return null
  if (turnHasOtherSubject({ marker, requestState, connectionState })) return null
  return uniqueIds(ids)
}

/** Of those, the ones that need a person: what Stop's reply names. Null when none do. */
export function turnReplyNoticeIds({ marker, requestState = null, connectionState = null } = {}) {
  const ids = validIds(marker?.noticeIds)
  if (ids.length === 0) return null
  if (turnHasOtherSubject({ marker, requestState, connectionState })) return null
  return uniqueIds(ids)
}

/**
 * The ids PreToolUse stamps on a plain post the model makes in a notice-only turn: the
 * notices that need a person when there are any. In a turn whose notices are all for
 * the record, those, so a stray post is refused by DevSpec (`for_the_record`) before
 * anything reaches the room; unless a write in the turn carried `tell_person`, when
 * the post is the ordinary message DevSpec asks for and gets no ids.
 */
export function turnStampNoticeIds({ marker, requestState = null, connectionState = null } = {}) {
  const reply = turnReplyNoticeIds({ marker, requestState, connectionState })
  if (reply) return reply
  if (marker?.tellPerson) return null
  return turnNoticeIds({ marker, requestState, connectionState })
}

/**
 * Whether the current turn was woken solely by one or more DevSpec check jobs, with no
 * command, terminal prompt, automation run, or system notice open on the turn.
 *
 * A check-job-only turn rules checks silently (`claim_check_job` / `record_check_rulings`)
 * and must neither stream a work trail into the room nor auto-post a fallback session
 * reply on Stop.
 */
export function isCheckJobOnlyTurn({ marker, requestState = null, connectionState = null } = {}) {
  if (!marker?.checkJobWake) return false
  if (validIds(marker.noticeIds).length > 0 || validIds(marker.recordNoticeIds).length > 0) return false
  return !turnHasOtherSubject({ marker, requestState, connectionState })
}

/**
 * Whether the current turn is routine: woken only by check jobs and notices DevSpec
 * labelled for the record, with nothing that needs a person and nothing else open.
 * Its text never reaches the room on its own: no answer, no trail, no error message
 * (`check_job.room` and `semantics.notice_audience` in the served contract). Stop
 * still posts its last words when a write in it carried `tell_person` and the model
 * did not tell the person itself (mirror-turn.mjs).
 */
export function isRoutineTurn({ marker, requestState = null, connectionState = null } = {}) {
  const routine = Boolean(marker?.checkJobWake) || validIds(marker?.recordNoticeIds).length > 0
  if (!routine || validIds(marker?.noticeIds).length > 0) return false
  return !turnHasOtherSubject({ marker, requestState, connectionState })
}

/** Split notice ids by DevSpec's label: `noticeIds` need a person, `recordNoticeIds` are for the record. */
function splitByAudience(ids, audienceOf) {
  const noticeIds = []
  const recordNoticeIds = []
  for (const id of validIds(ids)) {
    ;(audienceOf(id) === 'for_the_record' ? recordNoticeIds : noticeIds).push(id)
  }
  return {
    ...(noticeIds.length > 0 ? { noticeIds } : {}),
    ...(recordNoticeIds.length > 0 ? { recordNoticeIds } : {}),
  }
}

/**
 * What one delivered inbox entry adds to the turn marker: its notice ids by label,
 * `checkJobWake` for a check job, or `otherWake` for anything else. A control entry
 * (abort, model switch) is no input to the turn and adds nothing.
 */
export function turnWakeFromEntry(entry) {
  if (!entry || typeof entry !== 'object') return null
  if (entry.type === 'canonical_control') return null
  if (entry.type === 'check_job') return { checkJobWake: true }
  if (entry.type === 'canonical_system_notices') {
    const notices = Array.isArray(entry.ingress?.system_notices) ? entry.ingress.system_notices : []
    const ids = Array.isArray(entry.execute_notice_ids)
      ? entry.execute_notice_ids
      : notices.map((notice) => notice?.notice_id)
    const audiences = new Map(notices.map((notice) => [notice?.notice_id, noticeAudience(notice)]))
    const split = splitByAudience(ids, (id) => audiences.get(id))
    return split.noticeIds || split.recordNoticeIds ? split : null
  }
  return { otherWake: true }
}

/**
 * The same, read from the wake text a turn opened with (the JSON lines the listener
 * and the wait script deliver). Used by PreInvocation, which sees the step itself.
 */
export function turnWakeFromText(text) {
  const noticeIds = []
  const audiences = new Map()
  let checkJobWake = false
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
      audiences.set(event.notice_id, noticeAudience(event))
    } else if (event.type === 'check_job') {
      checkJobWake = true
    } else if (event.type === 'wake') {
      if (event.reason === 'exact_connection_system_notice') {
        if (Array.isArray(event.system_notice_ids)) noticeIds.push(...event.system_notice_ids)
      } else if (event.reason === 'check_job') {
        checkJobWake = true
      } else {
        otherWake = true
      }
    } else if (event.type === 'owner_message' || event.type === 'automation_run') {
      otherWake = true
    }
  }
  if (otherWake) return { otherWake: true }
  if (noticeIds.length === 0) {
    for (const match of String(text || '').matchAll(/system_notice_ids\s*:\s*(\[[^\]]*\])/g)) {
      const parsed = normalizeNoticeIds(match[1])
      if (Array.isArray(parsed)) noticeIds.push(...parsed)
    }
  }
  if (!checkJobWake && /\btake it with claim_check_job\b/.test(String(text || ''))) {
    checkJobWake = true
  }
  const split = splitByAudience(noticeIds, (id) => audiences.get(id))
  if (split.noticeIds || split.recordNoticeIds || checkJobWake) {
    return {
      ...split,
      ...(checkJobWake ? { checkJobWake: true } : {}),
    }
  }
  return null
}

/** Fold a wake into the marker's record: notice ids by label and `checkJobWake` accumulate, `otherWake` sticks. */
export function mergeTurnWake(marker, wake) {
  if (!wake) return {}
  if (wake.otherWake) return { otherWake: true }
  const held = Array.isArray(marker?.noticeIds) ? marker.noticeIds : []
  const heldRecord = Array.isArray(marker?.recordNoticeIds) ? marker.recordNoticeIds : []
  const recordNoticeIds = [...new Set([...heldRecord, ...(wake.recordNoticeIds ?? [])])]
  const checkJobWake = Boolean(marker?.checkJobWake || wake.checkJobWake)
  return {
    noticeIds: [...new Set([...held, ...(wake.noticeIds ?? [])])],
    ...(recordNoticeIds.length > 0 ? { recordNoticeIds } : {}),
    ...(checkJobWake ? { checkJobWake: true } : {}),
  }
}

/**
 * Whether a DevSpec tool result carries DevSpec's `tell_person` mark (item a868f41f): a
 * write that changed a record its requester does not own, which the agent must tell its
 * person about even in a routine turn. DevSpec appends it as its own text block,
 * `{"tell_person":{...}}`; only that shape counts, so record text that merely mentions
 * the word never does.
 */
export function resultCarriesTellPerson(result) {
  const marked = (value) =>
    Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
    Boolean(value.tell_person) && typeof value.tell_person === 'object' && !Array.isArray(value.tell_person) &&
    typeof value.tell_person.why === 'string'
  const fromText = (text) => {
    if (typeof text !== 'string' || !text.includes('"tell_person"')) return false
    for (const candidate of [text, ...text.split('\n')]) {
      const trimmed = candidate.trim()
      if (!trimmed.startsWith('{')) continue
      try {
        const parsed = JSON.parse(trimmed)
        if (marked(parsed)) return true
        if (Array.isArray(parsed?.content) && parsed.content.some((block) => fromText(block?.text))) return true
      } catch {
        /* not one JSON object: try the next line */
      }
    }
    return false
  }
  const visit = (value, depth) => {
    if (depth > 4 || value === null || value === undefined) return false
    if (typeof value === 'string') return fromText(value)
    if (Array.isArray(value)) return value.some((item) => visit(item, depth + 1))
    if (typeof value !== 'object') return false
    if (marked(value)) return true
    return Object.values(value).some((nested) => visit(nested, depth + 1))
  }
  return visit(result, 0)
}
