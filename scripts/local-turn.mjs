/**
 * A turn the owner starts by typing at this Antigravity terminal (item 718825fc / 6ae82bcf).
 *
 * When the owner types a prompt into their own connected Antigravity session, the owner
 * asked for what the agent does in that turn, and DevSpec records them as the
 * requester of its writes. The server takes that from a turn the HOST admitted with
 * the connection's hidden capability (`report_pickup` with `local_activity_version: 1`,
 * `local_turn: true`) and/or a `typed_prompt` request opened via `report_request`.
 */

import { randomUUID } from 'node:crypto'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function uuid(value) {
  return typeof value === 'string' && UUID.test(value) ? value : null
}

function timestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null
}

/**
 * The attachment a poll response names, for the state file. The server issues a new
 * attachment id on every attach (rotate_speech_attachment_id), and admission must
 * name the current one, so the poller records what each poll reports.
 */
export function attachmentFromPoll(res) {
  const id = uuid(res?.speech_attachment_id)
  const at = id ? timestamp(res?.attached_at) : null
  return id && at
    ? { speech_attachment_id: id, attached_at: at }
    : { speech_attachment_id: null, attached_at: null }
}

/**
 * The exact scope to admit a terminal turn in, or null when this connection cannot
 * prove one: no room, no capability, or no attachment recorded yet. Null leaves the
 * turn unattributed at the activity layer, never guessed.
 */
export function localTurnScope(state, sessionId) {
  const connectionId = uuid(state?.connection_id)
  const room = uuid(sessionId)
  const attachment = uuid(state?.speech_attachment_id)
  const attachedAt = timestamp(state?.attached_at)
  if (!connectionId || !room || !attachment || !attachedAt) return null
  if (typeof state?.connection_capability !== 'string' || !state.connection_capability) return null
  return {
    connection_id: connectionId,
    expected_session_id: room,
    expected_attachment_id: attachment,
    expected_attached_at: attachedAt,
  }
}

/**
 * Admit the turn. `call(args)` performs `report_pickup` with the connection
 * capability and returns the parsed result. The server refuses a start that does
 * not name the connection's newest attempt and says which one that is; a start
 * made at prompt time is current by definition, so it adopts that reference once.
 */
export async function startLocalTurn({
  scope,
  previousAttemptId = null,
  call,
  attemptId = randomUUID(),
}) {
  if (!scope || typeof call !== 'function') return null
  let previous = uuid(previousAttemptId)
  for (let retry = 0; retry < 2; retry++) {
    let result
    try {
      result = await call({
        ...scope,
        local_activity_version: 1,
        local_turn: true,
        attempt_id: attemptId,
        previous_attempt_id: previous,
      })
    } catch {
      return null
    }
    if (
      !result ||
      typeof result !== 'object' ||
      result.connection_id !== scope.connection_id ||
      result.attempt_id !== attemptId ||
      result.expected_session_id !== scope.expected_session_id
    ) {
      return null
    }
    if (result.status === 'working') {
      return { attempt_id: attemptId, session_id: scope.expected_session_id }
    }
    if (result.status !== 'predecessor_changed' || !uuid(result.previous_attempt_id)) return null
    previous = result.previous_attempt_id
  }
  return null
}

/**
 * The terminal turn a real turn end should complete, if this connection admitted one
 * in the room it is still in. A turn from another room is not this Stop's to close.
 */
export function localTurnToComplete(stored, sessionId) {
  const attemptId = uuid(stored?.attempt_id)
  if (!attemptId || !sessionId || stored.session_id !== sessionId) return null
  return attemptId
}
