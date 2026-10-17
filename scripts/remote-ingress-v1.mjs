#!/usr/bin/env node
/**
 * Dependency-free validator/normalizer for the negotiated remote-ingress v1 wire.
 *
 * The product contract is authoritative: devspec://product/remote-ingress-contract.
 * This module mirrors its v1 wire shape only because hook scripts deliberately have
 * no package dependencies. Unknown versions and every malformed/cross-field-invalid
 * envelope fail closed at the network boundary.
 */

export const REMOTE_INGRESS_SCHEMA_VERSION = 1
export const REMOTE_INGRESS_CONTRACT_VERSION = '1.3.0'
export const REMOTE_INGRESS_POLICY_VERSION = '2026-08-21.1'
/**
 * 1.4 adds system_notices; 1.5 adds the sender's response style per delivered
 * command (item af5e3d6c). The ladder is nested, so asking for style means
 * asking for notices too — the server refuses sender_style_version without
 * system_notice_version.
 */
export const REMOTE_INGRESS_SENDER_STYLE_CONTRACT_VERSION = '1.5.0'
export const REMOTE_INGRESS_SENDER_STYLE_POLICY_VERSION = '2026-09-18.1'
/**
 * 1.6 adds room context (item 1dcb75df): every emitted record's addressee,
 * attachment references and state, a coverage point a local room copy checks
 * itself against, and the answers to the copy's own questions (open_check,
 * deletions). It also may carry session_activity (item d37b3343). 1.6 carries
 * everything 1.5 does; the ladder stays nested.
 */
export const REMOTE_INGRESS_ROOM_CONTEXT_CONTRACT_VERSION = '1.6.0'
export const REMOTE_INGRESS_ROOM_CONTEXT_POLICY_VERSION = '2026-09-24.1'
export const ROOM_CONTEXT_VERSION = 1
export const ROOM_PAGE_MAX = 500
export const SESSION_ACTIVITY_MAX_ENTRIES = 1000
/**
 * The room's record history (item 744c9724, server item f6a8f4f2): a section the
 * poller negotiates with session_events_version on top of 1.6.0. What happened to
 * the records the room produced or referenced, with the time it happened.
 */
export const SESSION_EVENTS_VERSION = 1
export const SESSION_EVENTS_MAX = 2000
export const REMOTE_INGRESS_SYSTEM_NOTICE_CONTRACT_VERSION = '1.4.0'
export const REMOTE_INGRESS_SYSTEM_NOTICE_POLICY_VERSION = '2026-08-22.1'
/**
 * The shape version each notice carries in its own `version` field. It is not the
 * channel version the poller negotiates (`SYSTEM_NOTICE_CHANNEL_VERSION` in
 * devspec-remote-poll.mjs): channel version 2 adds the `server_notice` kind and
 * changes no shape, so every notice is still `version: 1` (1fd34942).
 */
export const SYSTEM_NOTICE_VERSION = 1
export const SENDER_STYLE_VERSION = 1
export const REMOTE_INGRESS_SCOPE_CONTRACT_VERSION = '1.2.0'
export const REMOTE_INGRESS_SCOPE_POLICY_VERSION = '2026-08-19.3'
export const ACTIVE_PLAN_PROJECTION_VERSION = 1
export const ACTIVE_PLAN_MAX_PLANS = 64
export const ACTIVE_PLAN_MAX_STEPS = 64
export const ACTIVE_PLAN_MAX_TITLE_CHARS = 300
export const ACTIVE_PLAN_MAX_FAILURE_REASON_CHARS = 4096
export const ACTIVE_PLAN_MAX_IDENTITY_CHARS = 300
export const ACTIVE_PLAN_MAX_TOTAL_TEXT_CHARS = 131_072
export const ACTIVE_PLAN_AUTHORITY_NOTE =
  'Advisory read-awareness only. Presence does not authorize execution or mutation; manage_plan still requires a capability-authenticated caller identity, explicit plan_id for cross-plan work, and expected_revision.'
/**
 * Room awareness that is NOT part of the ingress envelope (item b1e26146).
 *
 * `session_polls` and `still_to_discuss` ride the poll response beside `ingress`,
 * not inside it, so they have their own shapes and their own authority notes. Both
 * are advisory: a poll is something the room is deciding and a discussion point is
 * something it has parked, and neither is an instruction to this agent.
 *
 * The notes are pinned verbatim because they are the server's own words about what
 * the data does not authorize. Drifting from them would quietly relax a boundary.
 */
export const SESSION_POLL_PROJECTION_VERSION = 1
/**
 * Version 2 (item bba35976) is never missing while the session has polls: it carries
 * the newest polls that fit the text budget, the totals, and a continuation naming
 * where the rest are. Version 1 refused outright past 16 active polls, so a busy room
 * arrived as no polls at all.
 */
export const SESSION_POLL_PROJECTION_VERSION_2 = 2
export const SESSION_POLL_CONTINUATION = 'Call manage_poll list to read every poll in this session.'
export const SESSION_POLL_MAX_ACTIVE = 16
export const SESSION_POLL_MAX_ENDED = 5
export const SESSION_POLL_MAX_OPTIONS = 30
export const SESSION_POLL_MAX_QUESTION_CHARS = 400
export const SESSION_POLL_MAX_LABEL_CHARS = 80
export const SESSION_POLL_MAX_VOTER_CHARS = 80
export const SESSION_POLL_MAX_TOTAL_TEXT_CHARS = 16_384
export const SESSION_POLL_AUTHORITY_NOTE =
  'Advisory read-awareness only. Presence does not authorize execution or mutation; manage_poll still requires a capability-authenticated caller identity and expected_revision. Votes are not commands and do not keep Working on.'

export const STILL_TO_DISCUSS_PROJECTION_VERSION = 1
export const STILL_TO_DISCUSS_MAX_ROWS = 24
export const STILL_TO_DISCUSS_MAX_TITLE_CHARS = 300
export const STILL_TO_DISCUSS_MAX_PREVIEW_CHARS = 2048
export const STILL_TO_DISCUSS_AUTHORITY_NOTE =
  'Raised in this room, or brought into it. Advisory read-awareness. Do not add, strike, or reopen unless the human asked.'

export const REMOTE_INGRESS_RESOURCE_URI = 'devspec://product/remote-ingress-contract'

const CONTRACT_POLICY_PAIRS = new Map([
  ['1.1.0', '2026-08-19.2'],
  ['1.1.1', '2026-08-19.2'],
  [REMOTE_INGRESS_SCOPE_CONTRACT_VERSION, REMOTE_INGRESS_SCOPE_POLICY_VERSION],
  [REMOTE_INGRESS_CONTRACT_VERSION, REMOTE_INGRESS_POLICY_VERSION],
  [REMOTE_INGRESS_SYSTEM_NOTICE_CONTRACT_VERSION, REMOTE_INGRESS_SYSTEM_NOTICE_POLICY_VERSION],
  [REMOTE_INGRESS_SENDER_STYLE_CONTRACT_VERSION, REMOTE_INGRESS_SENDER_STYLE_POLICY_VERSION],
  [REMOTE_INGRESS_ROOM_CONTEXT_CONTRACT_VERSION, REMOTE_INGRESS_ROOM_CONTEXT_POLICY_VERSION],
])
// Every version from 1.2 up carries project_scope on delegated commands. 1.4 and
// 1.5 inherit that; leaving them out rejected every command on the new lanes.
const SCOPE_AWARE_CONTRACT_VERSIONS = new Set([
  REMOTE_INGRESS_SCOPE_CONTRACT_VERSION,
  REMOTE_INGRESS_CONTRACT_VERSION,
  REMOTE_INGRESS_SYSTEM_NOTICE_CONTRACT_VERSION,
  REMOTE_INGRESS_SENDER_STYLE_CONTRACT_VERSION,
  REMOTE_INGRESS_ROOM_CONTEXT_CONTRACT_VERSION,
])
const SUPPORTED_POLICY_VERSIONS = new Set(CONTRACT_POLICY_PAIRS.values())

const UUID = /^(?:00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$/
const OFFSET_DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/
const WAKE_KINDS = new Set([
  'conversational_command',
  'control',
  'system_notice',
  'advisory_update',
  'history_reseed',
  'idle',
])
const AUTHORITY_KINDS = new Set(['owner', 'delegated'])
const AUTHORITY_MODES = new Set(['owner', 'project', 'allowlist'])
const ACTOR_KINDS = new Set(['human', 'agent', 'ai', 'system'])
const RELATIONSHIPS = new Set(['before_window', 'within_window', 'after_command'])
const OMISSION_REASONS = new Set([
  'policy_limit',
  'model_budget',
  'transport_budget',
  'filter',
  'history_before_window',
  'delivery_retry',
])
const CONTROL_VERBS = new Set(['abort', 'set_model', 'set_thinking', 'compact', 'clear', 'reload', 'list_models'])
const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
const CONTEXT_BUCKETS = [
  ['human_context', 'human'],
  ['agent_context', 'agent'],
  ['ai_context', 'ai'],
  ['system_context', 'system'],
]

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value, keys) {
  if (!record(value)) return false
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function optionalExactKeys(value, required, optional = []) {
  if (!record(value)) return false
  const allowed = new Set([...required, ...optional])
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.has(key))
}

function nonempty(value) {
  return typeof value === 'string' && value.length > 0
}

function uuid(value) {
  return typeof value === 'string' && UUID.test(value)
}

function datetime(value) {
  if (typeof value !== 'string') return false
  const match = OFFSET_DATETIME.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6])
  const offsetHour = match[8] === undefined ? 0 : Number(match[8])
  const offsetMinute = match[9] === undefined ? 0 : Number(match[9])
  if (
    month < 1 || month > 12 ||
    hour > 23 || minute > 59 || second > 59 ||
    offsetHour > 23 || offsetMinute > 59
  ) return false
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return day >= 1 && day <= days[month - 1]
}

function nullable(value, predicate) {
  return value === null || predicate(value)
}

function nonnegativeInt(value) {
  return Number.isSafeInteger(value) && value >= 0
}

function positiveInt(value) {
  return Number.isSafeInteger(value) && value > 0
}

function orderPoint(value) {
  return (
    exactKeys(value, ['sequence', 'created_at', 'message_id']) &&
    positiveInt(value.sequence) &&
    datetime(value.created_at) &&
    uuid(value.message_id)
  )
}

function compareOrder(a, b) {
  return a.sequence - b.sequence
}

/** The canonical attachment shape, for sidecars that carry a command's manifest. */
export function isRemoteIngressAttachment(value) {
  return attachment(value)
}

function strictlyOrdered(rows) {
  return rows.every((row, index) => index === 0 || compareOrder(rows[index - 1].order, row.order) < 0)
}

function attachment(value) {
  if (!record(value) || value.materialization === 'metadata') {
    return (
      exactKeys(value, [
        'materialization',
        'filename',
        'mime_type',
        'type',
        'size_bytes',
        'resource_id',
      ]) &&
      value.materialization === 'metadata' &&
      nonempty(value.filename) &&
      nonempty(value.mime_type) &&
      nonempty(value.type) &&
      nullable(value.size_bytes, nonnegativeInt) &&
      uuid(value.resource_id)
    )
  }
  if (value.materialization === 'unavailable') {
    return (
      exactKeys(value, [
        'materialization',
        'filename',
        'mime_type',
        'type',
        'size_bytes',
        'resource_id',
        'reason',
      ]) &&
      nonempty(value.filename) &&
      nonempty(value.mime_type) &&
      nonempty(value.type) &&
      nullable(value.size_bytes, nonnegativeInt) &&
      value.resource_id === null &&
      ['missing_resource', 'legacy_inline_payload', 'access_denied'].includes(value.reason)
    )
  }
  return false
}

function addressee(value) {
  return (
    exactKeys(value, ['connection_id', 'agent_name', 'codename', 'label']) &&
    uuid(value.connection_id) &&
    nullable(value.agent_name, nonempty) &&
    nullable(value.codename, nonempty) &&
    nonempty(value.label)
  )
}

function authority(value) {
  if (
    !exactKeys(value, [
      'kind',
      'mode',
      'requested_by_user_id',
      'connection_owner_user_id',
      'decision_source',
    ]) ||
    !AUTHORITY_KINDS.has(value.kind) ||
    !AUTHORITY_MODES.has(value.mode) ||
    !uuid(value.requested_by_user_id) ||
    !uuid(value.connection_owner_user_id) ||
    value.decision_source !== 'server'
  ) return false
  const requesterIsOwner = value.requested_by_user_id === value.connection_owner_user_id
  return (value.kind === 'owner') === requesterIsOwner && !(value.mode === 'owner' && value.kind !== 'owner')
}

export function isRemoteCommandProjectScope(value, authorityKind) {
  if (authorityKind === 'owner') return value === null
  return (
    authorityKind === 'delegated' &&
    exactKeys(value, ['kind', 'policy_id', 'project_id', 'instruction']) &&
    value.kind === 'devspec_project' &&
    value.policy_id === 'delegated_project_v1' &&
    uuid(value.project_id) &&
    typeof value.instruction === 'string' &&
    value.instruction.trim().length > 0
  )
}

function command(value, scopeAware) {
  const keys = [
    'message_id',
    'order',
    'content',
    'attachments',
    'requester',
    'authority',
    'addressee',
    'delivery',
    ...(scopeAware ? ['project_scope'] : []),
  ]
  return (
    exactKeys(value, keys) &&
    uuid(value.message_id) &&
    orderPoint(value.order) &&
    value.message_id === value.order.message_id &&
    exactKeys(value.content, ['mode', 'body', 'complete']) &&
    value.content.mode === 'full' &&
    typeof value.content.body === 'string' &&
    value.content.complete === true &&
    Array.isArray(value.attachments) &&
    value.attachments.every(attachment) &&
    exactKeys(value.requester, ['user_id', 'display_name']) &&
    uuid(value.requester.user_id) &&
    nullable(value.requester.display_name, nonempty) &&
    authority(value.authority) &&
    value.requester.user_id === value.authority.requested_by_user_id &&
    (scopeAware
      ? isRemoteCommandProjectScope(value.project_scope, value.authority.kind)
      : value.authority.kind === 'owner') &&
    addressee(value.addressee) &&
    exactKeys(value.delivery, [
      'provenance_ref',
      'turn_id',
      'primary_provenance_ref',
      'is_primary',
    ]) &&
    uuid(value.delivery.provenance_ref) &&
    uuid(value.delivery.turn_id) &&
    uuid(value.delivery.primary_provenance_ref) &&
    typeof value.delivery.is_primary === 'boolean'
  )
}

function actor(value) {
  return (
    exactKeys(value, ['kind', 'user_id', 'display_name', 'agent_tool', 'model']) &&
    ACTOR_KINDS.has(value.kind) &&
    nullable(value.user_id, uuid) &&
    nonempty(value.display_name) &&
    nullable(value.agent_tool, nonempty) &&
    nullable(value.model, nonempty)
  )
}

function contextEntry(value) {
  return (
    exactKeys(value, [
      'message_id',
      'order',
      'actor',
      'source_type',
      'relationship',
      'content',
      'advisory',
    ]) &&
    uuid(value.message_id) &&
    orderPoint(value.order) &&
    value.message_id === value.order.message_id &&
    actor(value.actor) &&
    nonempty(value.source_type) &&
    RELATIONSHIPS.has(value.relationship) &&
    typeof value.content === 'string' &&
    value.advisory === true
  )
}

export function isRemoteIngressTypedContext(value) {
  if (!exactKeys(value, CONTEXT_BUCKETS.map(([name]) => name))) return false
  return CONTEXT_BUCKETS.every(([name, kind]) =>
    Array.isArray(value[name]) &&
    value[name].every((entry) => contextEntry(entry) && entry.actor.kind === kind) &&
    strictlyOrdered(value[name]),
  )
}

export function isRemoteIngressBoundedMetadata(value) {
  if (
    !exactKeys(value, [
      'policy_version',
      'returned',
      'total_known',
      'source_window',
      'truncated',
      'has_more',
      'next_cursor',
      'fetch_id',
      'omission_reason',
    ]) ||
    !SUPPORTED_POLICY_VERSIONS.has(value.policy_version) ||
    !nonnegativeInt(value.returned) ||
    !nullable(value.total_known, nonnegativeInt) ||
    !exactKeys(value.source_window, ['start', 'end']) ||
    !nullable(value.source_window.start, orderPoint) ||
    !nullable(value.source_window.end, orderPoint) ||
    typeof value.truncated !== 'boolean' ||
    typeof value.has_more !== 'boolean' ||
    !nullable(value.next_cursor, nonempty) ||
    !nullable(value.fetch_id, nonempty) ||
    !nullable(value.omission_reason, (reason) => OMISSION_REASONS.has(reason))
  ) return false
  const { start, end } = value.source_window
  if ((start === null) !== (end === null) || (start && end && compareOrder(start, end) > 0)) return false
  if (value.has_more && !value.next_cursor) return false
  if (value.truncated && (!value.omission_reason || !value.fetch_id)) return false
  return value.total_known === null || value.returned <= value.total_known
}

function control(value) {
  if (!optionalExactKeys(value, ['id', 'verb', 'issued_at', 'issued_by_user_id'], ['args'])) return false
  if (!uuid(value.id) || !CONTROL_VERBS.has(value.verb) || !datetime(value.issued_at) || !uuid(value.issued_by_user_id)) {
    return false
  }
  if (Object.hasOwn(value, 'args')) {
    if (!optionalExactKeys(value.args, [], ['model', 'thinking'])) return false
    if (Object.hasOwn(value.args, 'model') && !nonempty(value.args.model)) return false
    if (Object.hasOwn(value.args, 'thinking') && !THINKING_LEVELS.has(value.args.thinking)) return false
  }
  if (value.verb === 'set_model' && !value.args?.model) return false
  return value.verb !== 'set_thinking' || !!value.args?.thinking
}

function sameAddressee(a, b) {
  return (
    a.connection_id === b.connection_id &&
    a.agent_name === b.agent_name &&
    a.codename === b.codename &&
    a.label === b.label
  )
}

function rowsFitWindow(rows, window) {
  if (rows.length === 0) return true
  const { start, end } = window.source_window
  return !!start && !!end && rows.every(
    (row) => compareOrder(row.order, start) >= 0 && compareOrder(row.order, end) <= 0,
  )
}

function activePlanIdentity(value) {
  if (!exactKeys(value, ['kind', 'connection_id', 'agent_name', 'codename'])) return false
  if (typeof value.agent_name !== 'string' || value.agent_name.length < 1 ||
      value.agent_name.length > ACTIVE_PLAN_MAX_IDENTITY_CHARS ||
      !nullable(value.codename, (item) => nonempty(item) && item.length <= ACTIVE_PLAN_MAX_IDENTITY_CHARS)) {
    return false
  }
  return value.kind === 'dev'
    ? value.connection_id === null
    : value.kind === 'connection' && uuid(value.connection_id)
}

function activePlanStep(value) {
  if (!optionalExactKeys(
    value,
    ['id', 'position', 'title', 'status'],
    ['failure_reason', 'retryable'],
  )) return false
  if (!uuid(value.id) || !Number.isSafeInteger(value.position) ||
      value.position < 0 || value.position >= ACTIVE_PLAN_MAX_STEPS ||
      !nonempty(value.title) || value.title.length > ACTIVE_PLAN_MAX_TITLE_CHARS ||
      !['pending', 'in_progress', 'completed', 'failed', 'skipped'].includes(value.status)) return false
  const hasFailure = Object.hasOwn(value, 'failure_reason') || Object.hasOwn(value, 'retryable')
  if ((value.status === 'failed') !== hasFailure) return false
  if (value.status === 'failed') {
    if (typeof value.retryable !== 'boolean') return false
    if (Object.hasOwn(value, 'failure_reason') &&
        (!nonempty(value.failure_reason) || value.failure_reason.length > ACTIVE_PLAN_MAX_FAILURE_REASON_CHARS)) {
      return false
    }
  }
  return true
}

function activePlan(value) {
  if (!exactKeys(value, [
    'id', 'title', 'revision', 'status', 'created_at', 'origin', 'steward', 'owner',
    'orphaned', 'progress', 'steps',
  ])) return false
  if (!uuid(value.id) || !nonempty(value.title) || value.title.length > ACTIVE_PLAN_MAX_TITLE_CHARS ||
      !positiveInt(value.revision) || value.status !== 'active' || !datetime(value.created_at) ||
      !activePlanIdentity(value.origin) || !activePlanIdentity(value.steward) ||
      !exactKeys(value.owner, ['user_id', 'display_name']) || !uuid(value.owner.user_id) ||
      !nonempty(value.owner.display_name) || value.owner.display_name.length > ACTIVE_PLAN_MAX_IDENTITY_CHARS ||
      typeof value.orphaned !== 'boolean' ||
      !exactKeys(value.progress, ['terminal', 'total', 'completed', 'skipped']) ||
      !Object.values(value.progress).every(nonnegativeInt) ||
      !Array.isArray(value.steps) || value.steps.length > ACTIVE_PLAN_MAX_STEPS ||
      !value.steps.every(activePlanStep)) return false
  if (new Set(value.steps.map((step) => step.id)).size !== value.steps.length ||
      new Set(value.steps.map((step) => step.position)).size !== value.steps.length ||
      value.steps.some((step, index) => index > 0 && step.position <= value.steps[index - 1].position)) {
    return false
  }
  const completed = value.steps.filter((step) => step.status === 'completed').length
  const skipped = value.steps.filter((step) => step.status === 'skipped').length
  return value.progress.total === value.steps.length &&
    value.progress.completed === completed &&
    value.progress.skipped === skipped &&
    value.progress.terminal === completed + skipped
}

export function isActiveSessionPlansProjectionV1(value) {
  if (!exactKeys(value, ['version', 'advisory', 'authority_note', 'inventory', 'plans']) ||
      value.version !== ACTIVE_PLAN_PROJECTION_VERSION || value.advisory !== true ||
      value.authority_note !== ACTIVE_PLAN_AUTHORITY_NOTE ||
      !exactKeys(value.inventory, ['returned', 'total_known', 'truncated']) ||
      !positiveInt(value.inventory.returned) || value.inventory.returned > ACTIVE_PLAN_MAX_PLANS ||
      !positiveInt(value.inventory.total_known) || value.inventory.total_known > ACTIVE_PLAN_MAX_PLANS ||
      value.inventory.truncated !== false || !Array.isArray(value.plans) ||
      value.plans.length < 1 || value.plans.length > ACTIVE_PLAN_MAX_PLANS ||
      !value.plans.every(activePlan) ||
      new Set(value.plans.map((plan) => plan.id)).size !== value.plans.length ||
      value.inventory.returned !== value.plans.length ||
      value.inventory.total_known !== value.plans.length) return false
  const chars = value.plans.reduce((sum, plan) => sum + plan.title.length +
    plan.origin.agent_name.length + (plan.origin.codename?.length ?? 0) +
    plan.steward.agent_name.length + (plan.steward.codename?.length ?? 0) +
    plan.owner.display_name.length + plan.steps.reduce((stepSum, step) =>
      stepSum + step.title.length + (step.failure_reason?.length ?? 0), 0), 0)
  return chars <= ACTIVE_PLAN_MAX_TOTAL_TEXT_CHARS
}

/**
 * The sender's response style for one delivered command (item af5e3d6c).
 *
 * Read verbatim and never recomputed: the server froze this onto the message
 * row when it was sent, so an older command keeps rendering the same way on a
 * later poll.
 */
/**
 * One poll option. `percent` is server-computed and `voters` are display names,
 * both already bounded by the server's own schema; this re-checks rather than
 * trusts, because the inbox is a file on disk that outlives the poll.
 */
function pollOption(value) {
  return (
    exactKeys(value, ['label', 'human_vote_count', 'percent', 'voters']) &&
    nonempty(value.label) && value.label.length <= SESSION_POLL_MAX_LABEL_CHARS &&
    nonnegativeInt(value.human_vote_count) &&
    nonnegativeInt(value.percent) &&
    Array.isArray(value.voters) && value.voters.length <= 32 &&
    value.voters.every((voter) => nonempty(voter) && voter.length <= SESSION_POLL_MAX_VOTER_CHARS)
  )
}

function poll(value) {
  return (
    exactKeys(value, [
      'id', 'question', 'status', 'revision', 'multi_select', 'allow_write_in',
      'recommendation', 'human_voter_count', 'winning_labels', 'options',
    ]) &&
    uuid(value.id) &&
    nonempty(value.question) && value.question.length <= SESSION_POLL_MAX_QUESTION_CHARS &&
    (value.status === 'active' || value.status === 'ended') &&
    positiveInt(value.revision) &&
    typeof value.multi_select === 'boolean' &&
    typeof value.allow_write_in === 'boolean' &&
    nullable(value.recommendation, (label) =>
      nonempty(label) && label.length <= SESSION_POLL_MAX_LABEL_CHARS) &&
    nonnegativeInt(value.human_voter_count) &&
    Array.isArray(value.winning_labels) &&
    value.winning_labels.length <= SESSION_POLL_MAX_OPTIONS &&
    value.winning_labels.every((label) =>
      nonempty(label) && label.length <= SESSION_POLL_MAX_LABEL_CHARS) &&
    Array.isArray(value.options) &&
    value.options.length >= 2 && value.options.length <= SESSION_POLL_MAX_OPTIONS &&
    value.options.every(pollOption)
  )
}

/** The advisory poll inventory delivered beside a canonical command (b1e26146). */
export function isSessionPollsProjectionV1(value) {
  if (!exactKeys(value, ['version', 'advisory', 'authority_note', 'inventory', 'polls']) ||
      value.version !== SESSION_POLL_PROJECTION_VERSION || value.advisory !== true ||
      value.authority_note !== SESSION_POLL_AUTHORITY_NOTE ||
      !exactKeys(value.inventory, ['active_returned', 'ended_returned', 'truncated_ended']) ||
      !nonnegativeInt(value.inventory.active_returned) ||
      value.inventory.active_returned > SESSION_POLL_MAX_ACTIVE ||
      !nonnegativeInt(value.inventory.ended_returned) ||
      value.inventory.ended_returned > SESSION_POLL_MAX_ENDED ||
      typeof value.inventory.truncated_ended !== 'boolean' ||
      !Array.isArray(value.polls) || value.polls.length < 1 ||
      value.polls.length > SESSION_POLL_MAX_ACTIVE + SESSION_POLL_MAX_ENDED ||
      !value.polls.every(poll) ||
      new Set(value.polls.map((entry) => entry.id)).size !== value.polls.length) return false
  // The counts must describe the array they arrived with, or a reader can be told
  // there is one open poll while being handed none.
  const active = value.polls.filter((entry) => entry.status === 'active').length
  const ended = value.polls.filter((entry) => entry.status === 'ended').length
  if (active !== value.inventory.active_returned || ended !== value.inventory.ended_returned) return false
  return pollTextChars(value.polls) <= SESSION_POLL_MAX_TOTAL_TEXT_CHARS
}

function pollTextChars(polls) {
  return polls.reduce((sum, entry) => sum + entry.question.length +
    (entry.recommendation?.length ?? 0) +
    entry.winning_labels.reduce((n, label) => n + label.length, 0) +
    entry.options.reduce((n, option) => n + option.label.length +
      option.voters.reduce((v, voter) => v + voter.length, 0), 0), 0)
}

/**
 * The v2 poll inventory (item bba35976). Its counts must tell the truth about what
 * was left out: `truncated_*` exactly when fewer were returned than exist, and the
 * continuation exactly when anything was truncated, so a reader is never shown a
 * partial list that looks complete.
 */
export function isSessionPollsProjectionV2(value) {
  if (!exactKeys(value, ['version', 'advisory', 'authority_note', 'inventory', 'polls']) ||
      value.version !== SESSION_POLL_PROJECTION_VERSION_2 || value.advisory !== true ||
      value.authority_note !== SESSION_POLL_AUTHORITY_NOTE) return false
  const inv = value.inventory
  if (!exactKeys(inv, ['active_total', 'active_returned', 'truncated_active', 'ended_total', 'ended_returned', 'truncated_ended', 'continuation']) ||
      ![inv.active_total, inv.active_returned, inv.ended_total, inv.ended_returned].every(nonnegativeInt) ||
      inv.ended_returned > SESSION_POLL_MAX_ENDED ||
      inv.active_returned > inv.active_total || inv.ended_returned > inv.ended_total ||
      inv.truncated_active !== (inv.active_returned < inv.active_total) ||
      inv.truncated_ended !== (inv.ended_returned < inv.ended_total) ||
      inv.continuation !== ((inv.truncated_active || inv.truncated_ended) ? SESSION_POLL_CONTINUATION : null) ||
      inv.active_total + inv.ended_total === 0 ||
      !Array.isArray(value.polls) || !value.polls.every(poll) ||
      new Set(value.polls.map((entry) => entry.id)).size !== value.polls.length) return false
  const active = value.polls.filter((entry) => entry.status === 'active').length
  const ended = value.polls.filter((entry) => entry.status === 'ended').length
  if (active !== inv.active_returned || ended !== inv.ended_returned) return false
  return pollTextChars(value.polls) <= SESSION_POLL_MAX_TOTAL_TEXT_CHARS
}

/** Either poll inventory a server may send; v2 is what this plugin asks for. */
export function isSessionPollsProjection(value) {
  return isSessionPollsProjectionV1(value) || isSessionPollsProjectionV2(value)
}

function discussionPoint(value) {
  return (
    exactKeys(value, ['id', 'title', 'state', 'preview']) &&
    uuid(value.id) &&
    nonempty(value.title) && value.title.length <= STILL_TO_DISCUSS_MAX_TITLE_CHARS &&
    (value.state === 'open' || value.state === 'discussed') &&
    typeof value.preview === 'string' && value.preview.length <= STILL_TO_DISCUSS_MAX_PREVIEW_CHARS
  )
}

/** The advisory Still to Discuss snapshot delivered beside a command (b1e26146). */
export function isStillToDiscussProjectionV1(value) {
  return (
    exactKeys(value, ['version', 'advisory', 'authority_note', 'truncated', 'rows']) &&
    value.version === STILL_TO_DISCUSS_PROJECTION_VERSION && value.advisory === true &&
    value.authority_note === STILL_TO_DISCUSS_AUTHORITY_NOTE &&
    typeof value.truncated === 'boolean' &&
    Array.isArray(value.rows) && value.rows.length >= 1 &&
    value.rows.length <= STILL_TO_DISCUSS_MAX_ROWS &&
    value.rows.every(discussionPoint) &&
    new Set(value.rows.map((row) => row.id)).size !== 0 &&
    new Set(value.rows.map((row) => row.id)).size === value.rows.length
  )
}

const FULL_LOWERCASE_SHA = /^[0-9a-f]{40}$/
const UNLINKED_COMMIT_NOTICE_OUTCOMES = [
  'correct_item',
  'link_item',
  'resolve_duplicate',
  'dismiss_item',
  'confirm_item_correct',
  'defer_follow_up',
]
const UNLINKED_COMMIT_NOTICE_TOOLS = [
  'get_action_item',
  'update_action_item',
  'link_action_items',
  'supersede_action_item',
]

function exactStringTuple(value, expected) {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((item, index) => item === expected[index])
  )
}

function serverNoticeRecord(value) {
  return (
    exactKeys(value, ['label', 'record_type', 'record_id', 'title', 'text', 'url']) &&
    nonempty(value.label) && value.label.length <= 200 &&
    nonempty(value.record_type) && value.record_type.length <= 120 &&
    nonempty(value.record_id) && value.record_id.length <= 200 &&
    nullable(value.title, (title) => nonempty(title) && title.length <= 500) &&
    nonempty(value.text) && value.text.length <= 8000 &&
    // The server's own bound (ServerNoticeRecordV1Schema: url max 1000). A tighter
    // bound here refused a whole valid notice envelope for one long link.
    nullable(value.url, (url) => nonempty(url) && url.length <= 1000)
  )
}

export function isSystemNoticeV1(value) {
  if (!record(value) || value.version !== SYSTEM_NOTICE_VERSION || value.contract_uri !== REMOTE_INGRESS_RESOURCE_URI) {
    return false
  }
  if (value.kind === 'unlinked_commit_item_review') {
    return (
      exactKeys(value, [
        'version', 'kind', 'notice_id', 'commit_sha', 'action_item_id',
        'action_item_title', 'branch', 'contract_uri', 'allowed_outcomes', 'allowed_tools',
      ]) &&
      uuid(value.notice_id) &&
      typeof value.commit_sha === 'string' && FULL_LOWERCASE_SHA.test(value.commit_sha) &&
      uuid(value.action_item_id) &&
      nonempty(value.action_item_title) && value.action_item_title.length <= 500 &&
      nonempty(value.branch) && value.branch.length <= 500 &&
      exactStringTuple(value.allowed_outcomes, UNLINKED_COMMIT_NOTICE_OUTCOMES) &&
      exactStringTuple(value.allowed_tools, UNLINKED_COMMIT_NOTICE_TOOLS)
    )
  }
  if (value.kind === 'server_notice') {
    return (
      exactKeys(value, [
        'version', 'kind', 'notice_id', 'topic', 'notice_type',
        'summary', 'prompt', 'contract_uri', 'records', 'allowed_outcomes', 'allowed_tools',
      ]) &&
      uuid(value.notice_id) &&
      nonempty(value.topic) && value.topic.length <= 120 &&
      nonempty(value.notice_type) && value.notice_type.length <= 120 &&
      nonempty(value.summary) && value.summary.length <= 500 &&
      nonempty(value.prompt) && value.prompt.length <= 8000 &&
      Array.isArray(value.records) && value.records.length >= 1 && value.records.length <= 10 &&
      value.records.every(serverNoticeRecord) &&
      Array.isArray(value.allowed_outcomes) && value.allowed_outcomes.length <= 16 &&
      value.allowed_outcomes.every((entry) => nonempty(entry) && entry.length <= 120) &&
      Array.isArray(value.allowed_tools) && value.allowed_tools.length <= 16 &&
      value.allowed_tools.every((entry) => nonempty(entry) && entry.length <= 120)
    )
  }
  return false
}

export function isSenderResponseStyleV1(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  if (!exactKeys(value, ['message_id', 'notes'])) return false
  if (!uuid(value.message_id)) return false
  if (!Array.isArray(value.notes) || value.notes.length === 0 || value.notes.length > 8) return false
  return value.notes.every((note) => nonempty(note))
}

const ROOM_MESSAGE_STATES = new Set(['final', 'in_progress', 'deleted'])
const OPEN_CHECK_STATES = new Set(['final', 'in_progress', 'deleted', 'absent'])
const SHA256 = /^sha256:[a-f0-9]{64}$/

function roomAddressee(value) {
  if (!record(value)) return false
  if (value.kind === 'connection') {
    return exactKeys(value, ['kind', 'connection_id', 'label']) && uuid(value.connection_id) && nonempty(value.label)
  }
  return (value.kind === 'dev' || value.kind === 'room') && exactKeys(value, ['kind'])
}

function roomMessage(value) {
  return (
    exactKeys(value, ['message_id', 'addressee', 'attachments', 'state']) &&
    uuid(value.message_id) &&
    roomAddressee(value.addressee) &&
    Array.isArray(value.attachments) &&
    value.attachments.every(attachment) &&
    ROOM_MESSAGE_STATES.has(value.state)
  )
}

function uniqueUuids(list, max) {
  return Array.isArray(list) && list.length <= max && list.every(uuid) && new Set(list).size === list.length
}

function roomCoverage(value) {
  return (
    exactKeys(value, ['through', 'eligible_count', 'deleted_count', 'open_message_ids']) &&
    orderPoint(value.through) &&
    nonnegativeInt(value.eligible_count) &&
    nonnegativeInt(value.deleted_count) &&
    uniqueUuids(value.open_message_ids, ROOM_PAGE_MAX) &&
    value.deleted_count + value.open_message_ids.length <= value.eligible_count
  )
}

function roomOpenCheck(value) {
  if (!Array.isArray(value) || value.length > ROOM_PAGE_MAX) return false
  const ids = new Set()
  for (const check of value) {
    if (!optionalExactKeys(check, ['message_id', 'state'], ['entry'])) return false
    if (!uuid(check.message_id) || !OPEN_CHECK_STATES.has(check.state)) return false
    const hasEntry = Object.hasOwn(check, 'entry')
    if ((check.state === 'final') !== hasEntry) return false
    if (hasEntry && (!contextEntry(check.entry) || check.entry.message_id !== check.message_id)) return false
    const key = check.message_id.toLowerCase()
    if (ids.has(key)) return false
    ids.add(key)
  }
  return true
}

function deletionPoint(value) {
  return exactKeys(value, ['deleted_at', 'message_id']) && datetime(value.deleted_at) && uuid(value.message_id)
}

export function isRoomDeletionsSeen(value) {
  return (
    exactKeys(value, ['through', 'total']) &&
    nullable(value.through, deletionPoint) &&
    nullable(value.total, nonnegativeInt)
  )
}

function roomDeletions(value) {
  return (
    exactKeys(value, ['message_ids', 'truncated', 'total', 'seen']) &&
    uniqueUuids(value.message_ids, ROOM_PAGE_MAX) &&
    typeof value.truncated === 'boolean' &&
    nonnegativeInt(value.total) &&
    value.message_ids.length <= value.total &&
    isRoomDeletionsSeen(value.seen) &&
    (value.message_ids.length === 0 || value.seen.through !== null) &&
    (!value.truncated || value.message_ids.length > 0) &&
    value.seen.total === (value.truncated ? null : value.total)
  )
}

export function isRoomContextV1(value) {
  if (!optionalExactKeys(value, ['version', 'messages', 'coverage'], ['open_check', 'deletions'])) return false
  if (value.version !== ROOM_CONTEXT_VERSION) return false
  if (!Array.isArray(value.messages) || value.messages.length > ROOM_PAGE_MAX || !value.messages.every(roomMessage)) {
    return false
  }
  if (!nullable(value.coverage, roomCoverage)) return false
  if (Object.hasOwn(value, 'open_check') && !nullable(value.open_check, roomOpenCheck)) return false
  if (Object.hasOwn(value, 'deletions') && !nullable(value.deletions, roomDeletions)) return false
  return true
}

function activityEntry(value) {
  return (
    exactKeys(value, ['kind', 'id', 'title', 'status', 'relation', 'creator']) &&
    ['action_item', 'memory', 'artifact'].includes(value.kind) &&
    uuid(value.id) &&
    nonempty(value.title) &&
    nullable(value.status, nonempty) &&
    ['produced', 'referenced'].includes(value.relation) &&
    nullable(value.creator, (creator) =>
      exactKeys(creator, ['kind', 'label']) &&
      ['agent', 'person', 'platform'].includes(creator.kind) &&
      nonempty(creator.label))
  )
}

export function isSessionActivityV1(value) {
  if (!exactKeys(value, ['version', 'advisory', 'status', 'as_of', 'revision', 'entries', 'truncated'])) return false
  if (value.version !== 1 || value.advisory !== true || !datetime(value.as_of)) return false
  if (!['available', 'unavailable'].includes(value.status) || typeof value.truncated !== 'boolean') return false
  if (!nullable(value.revision, (revision) => typeof revision === 'string' && SHA256.test(revision))) return false
  if (!Array.isArray(value.entries) || value.entries.length > SESSION_ACTIVITY_MAX_ENTRIES ||
      !value.entries.every(activityEntry)) return false
  const keys = value.entries.map((entry) => `${entry.kind}:${entry.id}`)
  if (new Set(keys).size !== keys.length) return false
  if (value.status === 'unavailable') {
    return value.entries.length === 0 && value.revision === null && value.truncated === false
  }
  return value.revision !== null
}

function eventActor(value) {
  return nullable(value, (actor) =>
    exactKeys(actor, ['kind', 'label']) &&
    ['agent', 'person', 'platform'].includes(actor.kind) &&
    nonempty(actor.label))
}

const EVENT_BASE_KEYS = ['id', 'at', 'kind', 'record_id', 'event']

function sessionEvent(value) {
  if (!value || typeof value !== 'object') return false
  const base =
    typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 200 &&
    datetime(value.at) &&
    ['action_item', 'memory', 'artifact'].includes(value.kind) &&
    uuid(value.record_id)
  if (!base) return false
  switch (value.event) {
    case 'produced':
    case 'retracted':
    case 'archived':
      return exactKeys(value, [...EVENT_BASE_KEYS, 'actor']) && eventActor(value.actor)
    case 'referenced':
      return exactKeys(value, [...EVENT_BASE_KEYS, 'message_id']) && uuid(value.message_id)
    case 'lifecycle_changed':
      return exactKeys(value, [...EVENT_BASE_KEYS, 'from', 'to']) &&
        value.kind === 'action_item' && nonempty(value.from) && nonempty(value.to)
    case 'superseded':
      return exactKeys(value, [...EVENT_BASE_KEYS, 'by', 'actor']) &&
        nullable(value.by, uuid) && eventActor(value.actor)
    default:
      return false
  }
}

/** The negotiated session_events section, mirrored from the served contract. */
export function isSessionEventsV1(value) {
  if (!exactKeys(value, ['version', 'advisory', 'status', 'as_of', 'revision', 'events', 'truncated'])) return false
  if (value.version !== SESSION_EVENTS_VERSION || value.advisory !== true || !datetime(value.as_of)) return false
  if (!['available', 'unchanged', 'unavailable'].includes(value.status) || typeof value.truncated !== 'boolean') return false
  if (!nullable(value.revision, (revision) => typeof revision === 'string' && SHA256.test(revision))) return false
  if (!Array.isArray(value.events) || value.events.length > SESSION_EVENTS_MAX || !value.events.every(sessionEvent)) return false
  const ids = value.events.map((event) => event.id)
  if (new Set(ids).size !== ids.length) return false
  if (value.status === 'unavailable') {
    return value.events.length === 0 && value.revision === null && value.truncated === false
  }
  if (value.status === 'unchanged' && value.events.length > 0) return false
  return value.revision !== null
}

/**
 * 1.6 cross-field rules, mirrored from the served contract so a malformed page
 * cannot poison a local room copy: room_context describes exactly the records
 * the envelope emits, a command is always a final present message, and a
 * coverage claim agrees with the states the page describes.
 */
function roomContextCrossCheck(value, allRows) {
  const room = value.room_context
  const emitted = new Set(allRows.map((row) => row.message_id))
  const described = room.messages.map((message) => message.message_id)
  if (new Set(described).size !== described.length || described.length !== emitted.size ||
      described.some((id) => !emitted.has(id))) {
    return 'room context must describe every emitted record exactly once'
  }
  const stateById = new Map(room.messages.map((message) => [message.message_id, message.state]))
  if (value.commands.some((entry) => stateById.get(entry.message_id) !== 'final')) {
    return 'a delivered command must be a final, present message'
  }
  if (room.coverage) {
    const { through } = room.coverage
    const end = value.window.source_window.end
    if (end) {
      if (through.sequence !== end.sequence || through.message_id !== end.message_id ||
          Date.parse(through.created_at) !== Date.parse(end.created_at)) {
        return 'coverage point must be the end of this envelope source window'
      }
    } else if (allRows.length > 0) {
      return 'coverage point must be the end of this envelope source window'
    }
    if (room.coverage.eligible_count < allRows.length) return 'eligible_count below emitted records'
    const open = new Set(room.coverage.open_message_ids)
    const describedDeleted = room.messages.filter((message) => message.state === 'deleted').length
    if (room.messages.some((message) => (message.state === 'in_progress') !== open.has(message.message_id)) ||
        describedDeleted > room.coverage.deleted_count) {
      return 'coverage contradicts the states this page describes'
    }
  }
  if (Array.isArray(room.open_check) && room.open_check.some((check) => emitted.has(check.message_id))) {
    return 'open_check answers rows outside this page only'
  }
  return null
}

function envelopeV1(value) {
  const roomContextLane = value?.contract_version === REMOTE_INGRESS_ROOM_CONTEXT_CONTRACT_VERSION
  const senderStyleLane = roomContextLane || value?.contract_version === REMOTE_INGRESS_SENDER_STYLE_CONTRACT_VERSION
  const noticeLane = senderStyleLane ||
    value?.contract_version === REMOTE_INGRESS_SYSTEM_NOTICE_CONTRACT_VERSION
  const enhanced = noticeLane || value?.contract_version === REMOTE_INGRESS_CONTRACT_VERSION
  const requiredKeys = [
    'kind',
    'schema_version',
    'contract_version',
    'policy_version',
    'envelope_id',
    'connection',
    'wake',
    'delivery_state',
    'command_message_ids',
    'commands',
    'control',
    'context',
    'window',
  ]
  // 1.4 always carries system_notices (possibly empty); 1.5 adds an optional
  // sender_response_styles. Both are additive sections, which is the only shape
  // this validator tolerates — a CHANGED key would fail here, by design.
  const laneRequiredKeys = noticeLane
    ? [...requiredKeys, 'system_notices', ...(roomContextLane ? ['room_context'] : [])]
    : requiredKeys
  const laneOptionalKeys = senderStyleLane
    ? ['active_session_plans', 'sender_response_styles', ...(roomContextLane ? ['session_activity', 'session_events'] : [])]
    : ['active_session_plans']
  if (!(enhanced
    ? optionalExactKeys(value, laneRequiredKeys, laneOptionalKeys)
    : exactKeys(value, requiredKeys))) return 'ingress must contain exactly the canonical v1 fields'
  if (value.kind !== 'devspec.remote_ingress') return 'unknown ingress kind'
  if (value.schema_version !== REMOTE_INGRESS_SCHEMA_VERSION) return 'unsupported ingress schema_version'
  const pairedPolicy = CONTRACT_POLICY_PAIRS.get(value.contract_version)
  if (!pairedPolicy) return 'unsupported ingress contract_version'
  if (value.policy_version !== pairedPolicy) return 'ingress contract_version/policy_version mismatch'
  if (!uuid(value.envelope_id) || !addressee(value.connection)) return 'invalid envelope identity or connection'
  if (
    !exactKeys(value.wake, ['kind', 'active', 'reason_id']) ||
    !WAKE_KINDS.has(value.wake.kind) ||
    typeof value.wake.active !== 'boolean' ||
    !nonempty(value.wake.reason_id)
  ) return 'invalid wake metadata'
  const activeKind = value.wake.kind === 'conversational_command' ||
    value.wake.kind === 'control' || value.wake.kind === 'system_notice'
  if (value.wake.active !== activeKind) return 'wake active flag contradicts kind'
  if (!['live', 'replay', 'reseed'].includes(value.delivery_state)) return 'invalid delivery_state'
  if (value.delivery_state !== 'live' && (value.wake.kind !== 'history_reseed' || value.wake.active)) {
    return 'replay/reseed must be inactive history'
  }
  if (value.wake.kind === 'history_reseed' && value.delivery_state === 'live') {
    return 'history wake requires replay/reseed state'
  }
  if (!Array.isArray(value.command_message_ids) || !value.command_message_ids.every(uuid)) {
    return 'invalid command_message_ids'
  }
  const scopeAware = SCOPE_AWARE_CONTRACT_VERSIONS.has(value.contract_version)
  if (!Array.isArray(value.commands) || !value.commands.every((entry) => command(entry, scopeAware))) {
    return 'invalid canonical command'
  }
  if ((value.wake.kind === 'control') !== (value.control !== null)) return 'control payload/wake mismatch'
  if (value.control !== null && !control(value.control)) return 'invalid control payload'
  if (
    !isRemoteIngressTypedContext(value.context) ||
    !isRemoteIngressBoundedMetadata(value.window) ||
    value.window.policy_version !== value.policy_version
  ) return 'invalid typed context or window'
  if (noticeLane) {
    // Always present on 1.4+, usually empty. Nonempty only on a notice wake, and
    // never alongside commands — the server's own invariant, checked here so a
    // malformed package cannot be mistaken for work.
    if (!Array.isArray(value.system_notices) || value.system_notices.length > 25) {
      return 'invalid system_notices'
    }
    const hasNotices = value.system_notices.length > 0
    if (hasNotices !== (value.wake.kind === 'system_notice')) {
      return 'system_notices must be nonempty iff wake kind is system_notice'
    }
    if (hasNotices && (value.commands.length > 0 || value.control !== null)) {
      return 'system notices cannot accompany commands or control'
    }
    if (hasNotices && (!value.system_notices.every(isSystemNoticeV1) ||
        new Set(value.system_notices.map((notice) => notice.notice_id)).size !== value.system_notices.length)) {
      return 'invalid system_notices'
    }
  }
  if (senderStyleLane && Object.hasOwn(value, 'sender_response_styles')) {
    const styles = value.sender_response_styles
    if (!Array.isArray(styles) || !styles.every(isSenderResponseStyleV1)) {
      return 'invalid sender_response_styles'
    }
    // Style describes a command this delta delivered, exactly once. A style for
    // a command we were never handed would be a preference with nothing to apply
    // it to.
    const delivered = new Set(value.command_message_ids)
    const ids = styles.map((style) => style.message_id)
    if (ids.some((id) => !delivered.has(id)) || new Set(ids).size !== ids.length) {
      return 'sender response style must name a delivered command exactly once'
    }
  }
  if (enhanced && Object.hasOwn(value, 'active_session_plans') &&
      !isActiveSessionPlansProjectionV1(value.active_session_plans)) {
    return 'invalid active_session_plans projection'
  }
  if (roomContextLane && !isRoomContextV1(value.room_context)) return 'invalid room_context'
  if (roomContextLane && Object.hasOwn(value, 'session_activity') && !isSessionActivityV1(value.session_activity)) {
    return 'invalid session_activity'
  }
  if (roomContextLane && Object.hasOwn(value, 'session_events') && !isSessionEventsV1(value.session_events)) {
    return 'invalid session_events'
  }

  const listedIds = new Set(value.command_message_ids)
  const commandIds = new Set(value.commands.map((entry) => entry.message_id))
  if (
    listedIds.size !== value.command_message_ids.length ||
    commandIds.size !== value.commands.length ||
    commandIds.size !== listedIds.size ||
    value.command_message_ids.some((id) => !commandIds.has(id))
  ) return 'command ids do not exactly match commands'
  if (value.wake.kind === 'conversational_command' && value.commands.length === 0) {
    return 'command wake requires a complete command'
  }
  if (value.commands.some((entry) => !sameAddressee(entry.addressee, value.connection))) {
    return 'command addressee does not exactly match envelope connection'
  }
  if (!strictlyOrdered(value.commands)) return 'commands are not in stable total order'

  const contextRows = CONTEXT_BUCKETS.flatMap(([name]) => value.context[name])
  const allRows = [...value.commands, ...contextRows]
  if (new Set(allRows.map((row) => row.message_id)).size !== allRows.length) {
    return 'command/context records overlap'
  }
  if (value.window.returned !== allRows.length || !rowsFitWindow(allRows, value.window)) {
    return 'canonical window count/range mismatch'
  }
  if (roomContextLane) {
    const roomError = roomContextCrossCheck(value, allRows)
    if (roomError) return roomError
  }
  if (value.commands.length > 0) {
    const turnIds = new Set(value.commands.map((entry) => entry.delivery.turn_id))
    const primaryRefs = new Set(value.commands.map((entry) => entry.delivery.primary_provenance_ref))
    const provenanceRefs = value.commands.map((entry) => entry.delivery.provenance_ref)
    const sharedPrimaryRef = value.commands[0].delivery.primary_provenance_ref
    const primaryFlagsMatch = value.commands.every((entry) =>
      entry.delivery.is_primary === (entry.delivery.provenance_ref === sharedPrimaryRef)
    )
    if (
      turnIds.size !== 1 ||
      primaryRefs.size !== 1 ||
      new Set(provenanceRefs).size !== provenanceRefs.length ||
      !primaryFlagsMatch
    ) return 'command delta does not preserve one immutable turn primary'
  }
  return null
}

/**
 * Validate an ingress value and determine whether it may wake this connection.
 * The returned envelope is the original object: command bytes and all canonical
 * identity/order/delivery/window metadata are never rewritten or summarized.
 */
export function normalizeRemoteIngressV1(input, connectionId) {
  const target =
    record(input) && input.kind !== 'devspec.remote_ingress' && record(input.ingress)
      ? input.ingress
      : input
  const error = envelopeV1(target)
  if (error) return { ok: false, error }
  if (!uuid(connectionId) || target.connection.connection_id !== connectionId) {
    return { ok: false, error: 'ingress is not for this exact connection' }
  }

  const conversational =
    target.wake.kind === 'conversational_command' &&
    target.wake.active === true &&
    target.delivery_state === 'live'
  if (!conversational) {
    return { ok: true, envelope: target, wake: false, reason: target.wake.kind, commands: [] }
  }

  // Attachments are an atomic part of a command turn. A canonical unavailable
  // descriptor therefore rejects the turn before any inbox wake is written.
  if (target.commands.some((entry) =>
    entry.attachments.some((item) => item.materialization === 'unavailable')
  )) {
    return { ok: true, envelope: target, wake: false, reason: 'unavailable_attachment', commands: [] }
  }

  return { ok: true, envelope: target, wake: true, reason: 'conversational_command', commands: target.commands }
}

/** Actor-labelled, explicitly advisory context for a model-facing event. */
export function renderAdvisoryContext(context) {
  if (!isRemoteIngressTypedContext(context)) return []
  return CONTEXT_BUCKETS.flatMap(([bucket]) =>
    context[bucket].map((entry) => ({
      bucket,
      advisory: true,
      actor_label: `${entry.actor.kind.toUpperCase()}: ${entry.actor.display_name}`,
      message_id: entry.message_id,
      order: entry.order,
      source_type: entry.source_type,
      relationship: entry.relationship,
      content: entry.content,
    })),
  ).sort((a, b) => compareOrder(a.order, b.order))
}

export function isCanonicalUuid(value) {
  return uuid(value)
}

export function isCanonicalIsoDatetime(value) {
  return datetime(value)
}

export function formatDelegatedProjectScopeInstruction(projectId) {
  return `Execute this delegated command only within DevSpec project ${projectId}. Refuse any DevSpec project_id or repository target outside this project.`
}

export function validateActiveSessionPlansV1(value) {
  return isActiveSessionPlansProjectionV1(value) ? null : 'invalid active_session_plans projection'
}

export function validateRemoteIngressEnvelopeV1(ingress, connectionId) {
  const err = envelopeV1(ingress)
  if (err) return err
  if (!uuid(connectionId) || ingress.connection.connection_id !== connectionId) {
    return 'ingress is not for this exact connection'
  }
  const hasUnavailable = ingress.commands.some((cmd) =>
    cmd.attachments.some((att) => att.materialization === 'unavailable'),
  )
  if (hasUnavailable) return 'command attachment unavailable'
  return null
}

export function emptyCanonicalContextCarry() {
  return {
    context: {
      human_context: [],
      agent_context: [],
      ai_context: [],
      system_context: [],
    },
    windows: [],
    locally_omitted: 0,
    windows_omitted: 0,
    local_omission_reason: null,
  }
}

export function mergeCanonicalContextCarry(
  carry = emptyCanonicalContextCarry(),
  envelope,
  { maxCount = 20, maxChars = 12_000, maxWindows = 5 } = {},
) {
  const base = carry || emptyCanonicalContextCarry()
  const byId = new Map()
  for (const [bucket] of CONTEXT_BUCKETS) {
    for (const row of base.context?.[bucket] ?? []) {
      if (row?.message_id) byId.set(row.message_id, { bucket, row })
    }
    for (const row of envelope?.context?.[bucket] ?? []) {
      if (row?.message_id) byId.set(row.message_id, { bucket, row })
    }
  }
  const all = [...byId.values()].sort((a, b) => compareOrder(a.row.order, b.row.order))
  const kept = []
  let chars = 0
  let omitted = base.locally_omitted || 0
  for (let i = all.length - 1; i >= 0; i--) {
    const item = all[i]
    const len = typeof item.row.content === 'string' ? item.row.content.length : 0
    if (kept.length >= maxCount || (chars + len > maxChars && kept.length > 0)) {
      omitted++
      continue
    }
    if (len > maxChars && kept.length === 0) {
      omitted++
      continue
    }
    kept.unshift(item)
    chars += len
  }
  const nextContext = {
    human_context: [],
    agent_context: [],
    ai_context: [],
    system_context: [],
  }
  for (const { bucket, row } of kept) {
    nextContext[bucket].push(row)
  }

  const prevWindows = Array.isArray(base.windows) ? [...base.windows] : []
  let windowsOmitted = base.windows_omitted || 0
  if (envelope?.window) {
    const key = JSON.stringify(envelope.window.source_window)
    const exists = prevWindows.some((w) => JSON.stringify(w.source_window) === key)
    if (!exists) {
      prevWindows.push(envelope.window)
      while (prevWindows.length > maxWindows) {
        prevWindows.shift()
        windowsOmitted++
      }
    }
  }

  return {
    context: nextContext,
    windows: prevWindows,
    locally_omitted: omitted,
    windows_omitted: windowsOmitted,
    local_omission_reason: omitted > 0 || windowsOmitted > 0 ? 'model_budget' : null,
  }
}

