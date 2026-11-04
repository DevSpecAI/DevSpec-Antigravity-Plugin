/**
 * Check jobs on the wake channel (DevSpec item 55d71b0c; `semantics.check_job` in
 * devspec://product/remote-ingress-contract).
 *
 * DevSpec sends every check on a change, the agent's own changes included, as a check
 * job in `poll_connection` `dispatches[]`, beside automation runs, but only to a
 * connection that sends `check_job_version: 1`. A job is inbox metadata only (which
 * record, which kind of check, how many entries, how many high risk, whether this
 * agent made the change), never record text, never a command, never task work and
 * never a requester: the agent takes it with `claim_check_job`, which returns what to
 * rule, and records its rulings with `record_check_rulings`.
 *
 * Used by `devspec-remote-poll.mjs` (validates before persisting) and
 * `devspec-remote-wait.mjs` (revalidates before waking), so both read one shape.
 */

/** The check-job wake-channel version this plugin negotiates (poll and connection stream). */
export const CHECK_JOB_VERSION = 1

/** The inbox record type a persisted check job is written under. */
export const CHECK_JOB_RECORD_TYPE = 'check_job'

/** Exactly the keys of a check job's envelope (`CHECK_JOB_WAKE_KEYS` on the server). */
export const CHECK_JOB_WAKE_KEYS = Object.freeze([
  'id', 'kind', 'check_job_id', 'check_kind', 'record', 'entries', 'high_risk', 'yours',
  'offered_at', 'delivery_connection_id',
])

const CHECK_KINDS = new Set(['conflict', 'conflict_decisions', 'duplicate', 'staleness'])
const RECORD_TYPES = new Set(['task', 'memory', 'artifact', 'proposal'])
const RECORD_KEYS = ['type', 'id', 'title']
const UUID =
  /^(?:00000000-0000-0000-0000-000000000000|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value, keys) {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

function count(value) {
  return Number.isInteger(value) && value >= 0
}

/** Accept a check job only in its exact shape, addressed to this connection. */
export function validateCheckJobDispatch(dispatch, connectionId) {
  if (!plainObject(dispatch)) return { ok: false, error: 'dispatch is not an object' }
  if (!exactKeys(dispatch, CHECK_JOB_WAKE_KEYS)) {
    return { ok: false, error: 'dispatch does not exactly match check_job' }
  }
  const record = dispatch.record
  const valid =
    dispatch.kind === 'check_job' &&
    typeof dispatch.id === 'string' && UUID.test(dispatch.id) &&
    dispatch.check_job_id === dispatch.id &&
    CHECK_KINDS.has(dispatch.check_kind) &&
    plainObject(record) && exactKeys(record, RECORD_KEYS) &&
    RECORD_TYPES.has(record.type) &&
    typeof record.id === 'string' && UUID.test(record.id) &&
    typeof record.title === 'string' &&
    count(dispatch.entries) &&
    count(dispatch.high_risk) &&
    typeof dispatch.yours === 'boolean' &&
    typeof dispatch.offered_at === 'string' && !Number.isNaN(Date.parse(dispatch.offered_at)) &&
    typeof connectionId === 'string' && dispatch.delivery_connection_id === connectionId
  return valid ? { ok: true, dispatch } : { ok: false, error: 'invalid or misaddressed check_job dispatch' }
}

/** Revalidate a persisted check-job inbox record before it wakes the agent. */
export function validateCheckJobInboxRecord(record, connectionId) {
  return Boolean(
    record?.type === CHECK_JOB_RECORD_TYPE &&
    record.connection_id === connectionId &&
    validateCheckJobDispatch(record.dispatch, connectionId).ok,
  )
}

/** The one line an arriving job wakes the agent with (the contract's wake text). */
export function checkJobWakeText(dispatch) {
  const title = typeof dispatch?.record?.title === 'string' ? dispatch.record.title.trim() : ''
  const subject = title
    ? `"${title}"`
    : `the ${dispatch?.record?.type || 'record'} ${dispatch?.record?.id || ''}`.trim()
  return `A check is waiting on ${subject}: take it with claim_check_job, rule every entry with record_check_rulings, then carry on.`
}
