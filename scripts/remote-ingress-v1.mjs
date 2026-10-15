/**
 * Canonical remote ingress v1 validator and normalizer (1.1.0 through 1.6.0).
 *
 * The versioned authority/wake/context/delivery policy lives at
 * `devspec://product/remote-ingress-contract`. This module validates that a
 * negotiated `poll_connection` response carries a well-formed `ingress`
 * envelope addressed to THIS connection before any wake record can be written.
 */

export const REMOTE_INGRESS_RESOURCE_URI = 'devspec://product/remote-ingress-contract'
export const REMOTE_INGRESS_KIND = 'devspec.remote_ingress'
export const REMOTE_INGRESS_SCHEMA_VERSION = 1
export const REMOTE_INGRESS_CONTRACT_VERSION = '1.1.0'
export const REMOTE_INGRESS_POLICY_VERSION = '2026-08-19.2'
export const REMOTE_INGRESS_SCOPE_CONTRACT_VERSION = '1.2.0'
export const REMOTE_INGRESS_SCOPE_POLICY_VERSION = '2026-08-19.3'
export const REMOTE_INGRESS_PLAN_CONTRACT_VERSION = '1.3.0'
export const REMOTE_INGRESS_PLAN_POLICY_VERSION = '2026-08-21.1'
export const REMOTE_INGRESS_SYSTEM_NOTICE_CONTRACT_VERSION = '1.4.0'
export const REMOTE_INGRESS_SYSTEM_NOTICE_POLICY_VERSION = '2026-08-22.1'
export const REMOTE_INGRESS_SENDER_STYLE_CONTRACT_VERSION = '1.5.0'
export const REMOTE_INGRESS_SENDER_STYLE_POLICY_VERSION = '2026-08-23.1'
// Remote-ingress 1.6.0 (item 1a4f0246): room-context fields on `context.*` rows plus
// `session_activity` and `session_events` on the envelope so the poller can maintain a
// complete local `.transcript.jsonl` and `.room.json` without `get_session_transcript`.
export const REMOTE_INGRESS_ROOM_CONTEXT_CONTRACT_VERSION = '1.6.0'
export const REMOTE_INGRESS_ROOM_CONTEXT_POLICY_VERSION = '2026-08-25.1'
export const ROOM_CONTEXT_VERSION = 1
// Item bba35976: poll inventory that is never dropped when the room has more polls than fit.
export const SESSION_POLL_PROJECTION_VERSION_2 = 2

// Backward-compatible aliases for existing Antigravity tests
export const REMOTE_INGRESS_PREVIOUS_CONTRACT_VERSION = REMOTE_INGRESS_SCOPE_CONTRACT_VERSION
export const REMOTE_INGRESS_PREVIOUS_POLICY_VERSION = REMOTE_INGRESS_SCOPE_POLICY_VERSION
export const REMOTE_INGRESS_OWNER_ONLY_CONTRACT_VERSION = REMOTE_INGRESS_CONTRACT_VERSION
export const REMOTE_INGRESS_OWNER_ONLY_POLICY_VERSION = REMOTE_INGRESS_POLICY_VERSION

export const ACTIVE_PLAN_AUTHORITY_NOTE =
  'Advisory read-awareness only. Presence does not authorize execution or mutation; manage_plan still requires a capability-authenticated caller identity, explicit plan_id for cross-plan work, and expected_revision.'
export const SESSION_POLL_AUTHORITY_NOTE =
  'Advisory read-awareness only. Presence does not authorize execution or mutation; manage_poll still requires a capability-authenticated caller identity and expected_revision for mutations.'
export const STILL_TO_DISCUSS_AUTHORITY_NOTE =
  'Advisory read-awareness only. Presence does not authorize execution or mutation; manage_discussion_point remains the only write surface.'
export const SESSION_ACTIVITY_AUTHORITY_NOTE =
  'Advisory read-awareness only. Items and events record what this session produced and referenced; presence does not authorize execution or mutation.'

export const DELEGATED_PROJECT_SCOPE_KIND = 'devspec_project'
export const DELEGATED_PROJECT_SCOPE_POLICY_ID = 'delegated_project_v1'

export function formatDelegatedProjectScopeInstruction(projectId) {
  return (
    `Delegated project scope: this command is authorized ONLY for DevSpec project ${projectId}. ` +
    `Pass project_id: "${projectId}" on project-scoped DevSpec calls, and do not read, modify, or execute work for any other project or unassociated repository.`
  )
}

const CANONICAL_CONTRACTS = new Map([
  [REMOTE_INGRESS_CONTRACT_VERSION, { policyVersion: REMOTE_INGRESS_POLICY_VERSION, scopeAware: false, planAware: false, systemNoticeAware: false, senderStyleAware: false, roomContextAware: false }],
  [REMOTE_INGRESS_SCOPE_CONTRACT_VERSION, { policyVersion: REMOTE_INGRESS_SCOPE_POLICY_VERSION, scopeAware: true, planAware: false, systemNoticeAware: false, senderStyleAware: false, roomContextAware: false }],
  [REMOTE_INGRESS_PLAN_CONTRACT_VERSION, { policyVersion: REMOTE_INGRESS_PLAN_POLICY_VERSION, scopeAware: true, planAware: true, systemNoticeAware: false, senderStyleAware: false, roomContextAware: false }],
  [REMOTE_INGRESS_SYSTEM_NOTICE_CONTRACT_VERSION, { policyVersion: REMOTE_INGRESS_SYSTEM_NOTICE_POLICY_VERSION, scopeAware: true, planAware: true, systemNoticeAware: true, senderStyleAware: false, roomContextAware: false }],
  [REMOTE_INGRESS_SENDER_STYLE_CONTRACT_VERSION, { policyVersion: REMOTE_INGRESS_SENDER_STYLE_POLICY_VERSION, scopeAware: true, planAware: true, systemNoticeAware: true, senderStyleAware: true, roomContextAware: false }],
  [REMOTE_INGRESS_ROOM_CONTEXT_CONTRACT_VERSION, { policyVersion: REMOTE_INGRESS_ROOM_CONTEXT_POLICY_VERSION, scopeAware: true, planAware: true, systemNoticeAware: true, senderStyleAware: true, roomContextAware: true }],
])

const NIL_UUID = '00000000-0000-0000-0000-000000000000'
const MAX_UUID = 'ffffffff-ffff-ffff-ffff-ffffffffffff'
const RFC_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ISO_DATETIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/
const COMMAND_AUTHORITIES = new Set(['owner', 'delegated'])
const DELEGATED_MODES = new Set(['project', 'allowlist'])
const WAKE_KINDS = new Set([
  'conversational_command',
  'control',
  'advisory_update',
  'history_reseed',
  'idle',
])
const DELIVERY_STATES = new Set(['live', 'replay', 'reseed'])
const CONTROL_VERBS = new Set(['abort', 'compact', 'set_model', 'set_thinking_level'])
const CONTEXT_BUCKETS = ['human_context', 'agent_context', 'ai_context', 'system_context']
const CONTEXT_ACTOR_BY_BUCKET = {
  human_context: 'human',
  agent_context: 'agent',
  ai_context: 'ai',
  system_context: 'system',
}
const ATTACHMENT_TYPES = new Set(['image', 'text', 'binary'])
const UNAVAILABLE_REASONS = new Set(['missing_resource', 'invalid_payload', 'access_denied'])
const OMISSION_REASONS = new Set(['policy_limit', 'byte_budget', 'delivery_retry'])
const ACTIVE_PLAN_STEP_STATUSES = new Set(['pending', 'in_progress', 'completed', 'skipped'])
const ACTIVE_PLAN_ORIGIN_KINDS = new Set(['connection', 'ai_assistant', 'human'])
const ACTIVE_PLAN_STEWARD_KINDS = new Set(['connection', 'ai_assistant', 'unassigned'])
const SYSTEM_NOTICE_ACTOR_KINDS = new Set(['owner', 'delegated', 'system'])
const SYSTEM_NOTICE_CODES = new Set(['rate_limit', 'concurrency_limit', 'budget_exceeded', 'turn_failed', 'provider_error', 'system_notice'])

const BASE_ENVELOPE_KEYS = new Set([
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
])
const PLAN_ENVELOPE_KEYS = new Set([...BASE_ENVELOPE_KEYS, 'active_session_plans'])
const SYSTEM_NOTICE_ENVELOPE_KEYS = new Set([...PLAN_ENVELOPE_KEYS, 'system_notices'])
const SENDER_STYLE_ENVELOPE_KEYS = new Set([...SYSTEM_NOTICE_ENVELOPE_KEYS, 'sender_response_styles'])
const ROOM_CONTEXT_ENVELOPE_KEYS = new Set([
  ...SENDER_STYLE_ENVELOPE_KEYS,
  'session_activity',
  'session_events',
])
const SENDER_STYLE_KEYS = new Set(['message_id', 'sender_user_id', 'notes'])
const SYSTEM_NOTICE_KEYS = new Set([
  'notice_id', 'created_at', 'code', 'summary', 'actor_kind', 'requester', 'advisory', 'executable',
])
const CONNECTION_KEYS = new Set(['connection_id', 'agent_name', 'codename', 'label'])
const WAKE_KEYS = new Set(['kind', 'active', 'reason_id'])
const ORDER_KEYS = new Set(['sequence', 'created_at', 'message_id'])
const CONTENT_KEYS = new Set(['mode', 'body', 'complete'])
const CONTENT_ROOM_KEYS = new Set(['mode', 'body', 'complete', 'updated_at'])
const REQUESTER_KEYS = new Set(['user_id', 'display_name'])
const AUTHORITY_KEYS = new Set([
  'kind',
  'mode',
  'requested_by_user_id',
  'connection_owner_user_id',
  'decision_source',
])
const DELIVERY_KEYS = new Set([
  'provenance_ref',
  'turn_id',
  'primary_provenance_ref',
  'is_primary',
])
const BASE_COMMAND_KEYS = new Set([
  'message_id',
  'order',
  'content',
  'attachments',
  'requester',
  'authority',
  'addressee',
  'delivery',
])
const SCOPED_COMMAND_KEYS = new Set([...BASE_COMMAND_KEYS, 'project_scope'])
const PROJECT_SCOPE_KEYS = new Set(['kind', 'policy_id', 'project_id', 'instruction'])
const CONTROL_KEYS = new Set(['id', 'verb', 'issued_at', 'issued_by_user_id', 'args'])
const CONTEXT_KEYS = new Set(CONTEXT_BUCKETS)
const CONTEXT_ACTOR_KEYS = new Set(['kind', 'user_id', 'display_name', 'agent_tool', 'model'])
const CONTEXT_ENTRY_KEYS = new Set([
  'message_id',
  'order',
  'actor',
  'source_type',
  'relationship',
  'content',
  'advisory',
])
const CONTEXT_ENTRY_ROOM_KEYS = new Set([...CONTEXT_ENTRY_KEYS, 'attachments', 'room'])
const CONTEXT_ROOM_KEYS = new Set([
  'updated_at',
  'author_connection_id',
  'author_codename',
  'addressed_to',
  'work_trail',
  'trail_events',
])
const CONTEXT_ADDRESSED_TO_KEYS = new Set(['connection_id', 'agent_name', 'codename'])
const WINDOW_KEYS = new Set([
  'policy_version',
  'returned',
  'total_known',
  'source_window',
  'truncated',
  'has_more',
  'next_cursor',
  'fetch_id',
  'omission_reason',
])
const SOURCE_WINDOW_KEYS = new Set(['start', 'end'])
const METADATA_ATTACHMENT_KEYS = new Set([
  'materialization',
  'filename',
  'mime_type',
  'type',
  'size_bytes',
  'resource_id',
])
const UNAVAILABLE_ATTACHMENT_KEYS = new Set([
  'materialization',
  'filename',
  'mime_type',
  'type',
  'size_bytes',
  'resource_id',
  'reason',
])
const ACTIVE_PLAN_PROJECTION_KEYS = new Set([
  'version',
  'advisory',
  'authority_note',
  'inventory',
  'plans',
])
const ACTIVE_PLAN_INVENTORY_KEYS = new Set(['returned', 'total_known', 'truncated'])
const ACTIVE_PLAN_KEYS = new Set([
  'id',
  'title',
  'revision',
  'status',
  'created_at',
  'origin',
  'steward',
  'owner',
  'orphaned',
  'progress',
  'steps',
])
const ACTIVE_PLAN_ACTOR_KEYS = new Set(['kind', 'connection_id', 'agent_name', 'codename'])
const ACTIVE_PLAN_PROGRESS_KEYS = new Set(['terminal', 'total', 'completed', 'skipped'])
const ACTIVE_PLAN_STEP_KEYS = new Set(['id', 'position', 'title', 'status'])

const SESSION_POLL_PROJECTION_KEYS = new Set([
  'version', 'advisory', 'authority_note', 'inventory', 'polls',
])
const SESSION_POLL_V2_INVENTORY_KEYS = new Set([
  'returned', 'total_known', 'open_total', 'closed_total', 'truncated', 'read_Hint', 'read_hint',
])
const SESSION_POLL_KEYS = new Set([
  'id', 'question', 'status', 'revision', 'created_at', 'closed_at',
  'creator', 'recommendation_index', 'options', 'total_votes',
])
const SESSION_POLL_CREATOR_KEYS = new Set([
  'kind', 'user_id', 'connection_id', 'display_name', 'agent_name', 'codename',
])
const SESSION_POLL_OPTION_KEYS = new Set(['index', 'label', 'vote_count', 'voters'])
const SESSION_POLL_VOTER_KEYS = new Set(['user_id', 'display_name'])

const STILL_TO_DISCUSS_PROJECTION_KEYS = new Set([
  'version', 'advisory', 'authority_note', 'inventory', 'points',
])
const STILL_TO_DISCUSS_POINT_KEYS = new Set([
  'id', 'title', 'body', 'status', 'position', 'created_at', 'resolved_at', 'source_message_id',
])

const SESSION_ACTIVITY_KEYS = new Set([
  'version', 'advisory', 'authority_note', 'list_readable', 'items', 'events',
])
const SESSION_ACTIVITY_ITEM_KEYS = new Set([
  'id', 'short_code', 'title', 'status', 'priority', 'Display', 'origin', 'assignee',
  'claimed_by', 'created_at', 'updated_at', 'completed_at',
])
const SESSION_ACTIVITY_EVENT_KEYS = new Set([
  'id', 'kind', 'item_id', 'short_code', 'title', 'status', 'actor', 'at', 'summary',
])
const SESSION_EVENTS_PROJECTION_KEYS = new Set([
  'version', 'advisory', 'inventory', 'events',
])
const SESSION_EVENT_KEYS = new Set([
  'id', 'message_type', 'created_at', 'actor_name', 'content', 'metadata', 'attachments',
])

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value, allowed) {
  if (!isPlainObject(value)) return false
  const keys = Object.keys(value)
  return keys.length === allowed.size && keys.every((key) => allowed.has(key))
}

function hasOnlyAllowedKeys(value, allowed) {
  if (!isPlainObject(value)) return false
  return Object.keys(value).every((key) => allowed.has(key))
}

export function isCanonicalUuid(value) {
  if (typeof value !== 'string') return false
  if (value === NIL_UUID || value === MAX_UUID) return true
  return RFC_UUID_PATTERN.test(value)
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

function isNonBlankString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

export function isSafeNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0
}

function isSafePositiveInteger(value) {
  return Number.isSafeInteger(value) && value >= 1
}

function daysInUtcMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

export function isCanonicalIsoDatetime(value) {
  if (typeof value !== 'string') return false
  const match = ISO_DATETIME_PATTERN.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6])
  const offsetHour = match[7] === undefined ? 0 : Number(match[7])
  const offsetMinute = match[8] === undefined ? 0 : Number(match[8])
  if (month < 1 || month > 12) return false
  if (day < 1 || day > daysInUtcMonth(year, month)) return false
  if (hour > 23 || minute > 59 || second > 59) return false
  if (offsetHour > 23 || offsetMinute > 59) return false
  return !Number.isNaN(Date.parse(value))
}

function compareOrder(left, right) {
  if (left.sequence !== right.sequence) return left.sequence - right.sequence
  if (left.created_at !== right.created_at) return left.created_at < right.created_at ? -1 : 1
  if (left.message_id !== right.message_id) return left.message_id < right.message_id ? -1 : 1
  return 0
}

function sameOrder(left, right) {
  return (
    left.sequence === right.sequence &&
    left.created_at === right.created_at &&
    left.message_id === right.message_id
  )
}

function isOrderKey(value) {
  return (
    hasExactKeys(value, ORDER_KEYS) &&
    isSafeNonNegativeInteger(value.sequence) &&
    isCanonicalIsoDatetime(value.created_at) &&
    isCanonicalUuid(value.message_id)
  )
}

function isConnectionIdentity(value) {
  return (
    hasExactKeys(value, CONNECTION_KEYS) &&
    isCanonicalUuid(value.connection_id) &&
    isNonEmptyString(value.agent_name) &&
    (value.codename === null || isNonEmptyString(value.codename)) &&
    isNonEmptyString(value.label)
  )
}

function isAttachment(value) {
  if (hasExactKeys(value, METADATA_ATTACHMENT_KEYS)) {
    return (
      value.materialization === 'metadata' &&
      isNonEmptyString(value.filename) &&
      isNonEmptyString(value.mime_type) &&
      ATTACHMENT_TYPES.has(value.type) &&
      isSafeNonNegativeInteger(value.size_bytes) &&
      isCanonicalUuid(value.resource_id)
    )
  }
  if (hasExactKeys(value, UNAVAILABLE_ATTACHMENT_KEYS)) {
    return (
      value.materialization === 'unavailable' &&
      isNonEmptyString(value.filename) &&
      isNonEmptyString(value.mime_type) &&
      ATTACHMENT_TYPES.has(value.type) &&
      (value.size_bytes === null || isSafeNonNegativeInteger(value.size_bytes)) &&
      (value.resource_id === null || isCanonicalUuid(value.resource_id)) &&
      UNAVAILABLE_REASONS.has(value.reason)
    )
  }
  return false
}

export function validateRemoteCommandProjectScope(projectScope, authorityKind) {
  if (authorityKind === 'owner') {
    return projectScope === null ? null : 'owner command project_scope must be null'
  }
  if (authorityKind !== 'delegated') {
    return 'unknown command authority kind'
  }
  if (!hasExactKeys(projectScope, PROJECT_SCOPE_KEYS)) {
    return 'delegated command project_scope must have the exact v1 key set'
  }
  if (
    projectScope.kind !== DELEGATED_PROJECT_SCOPE_KIND ||
    projectScope.policy_id !== DELEGATED_PROJECT_SCOPE_POLICY_ID ||
    !isCanonicalUuid(projectScope.project_id) ||
    !isNonBlankString(projectScope.instruction)
  ) {
    return 'delegated command project_scope fields are invalid'
  }
  return null
}

export function isRemoteCommandProjectScope(projectScope, authorityKind) {
  return validateRemoteCommandProjectScope(projectScope, authorityKind) === null
}

function isCommandAuthority(authority, requester, scopeAware) {
  if (!hasExactKeys(authority, AUTHORITY_KEYS)) return false
  if (
    !COMMAND_AUTHORITIES.has(authority.kind) ||
    !isCanonicalUuid(authority.requested_by_user_id) ||
    !isCanonicalUuid(authority.connection_owner_user_id) ||
    authority.decision_source !== 'server' ||
    authority.requested_by_user_id !== requester.user_id
  ) {
    return false
  }
  if (authority.kind === 'owner') {
    return (
      authority.mode === 'owner' &&
      authority.requested_by_user_id === authority.connection_owner_user_id
    )
  }
  return (
    scopeAware &&
    DELEGATED_MODES.has(authority.mode) &&
    authority.requested_by_user_id !== authority.connection_owner_user_id
  )
}

function isValidContent(content, roomContextAware) {
  if (!isPlainObject(content)) return false
  const allowed = roomContextAware ? CONTENT_ROOM_KEYS : CONTENT_KEYS
  if (!hasOnlyAllowedKeys(content, allowed)) return false
  if (content.mode !== 'full' || typeof content.body !== 'string' || content.complete !== true) {
    return false
  }
  if (Object.hasOwn(content, 'updated_at') && !isCanonicalIsoDatetime(content.updated_at)) {
    return false
  }
  return true
}

function isCommand(value, connectionId, { scopeAware = true, roomContextAware = false } = {}) {
  const expectedKeys = scopeAware ? SCOPED_COMMAND_KEYS : BASE_COMMAND_KEYS
  if (!hasExactKeys(value, expectedKeys)) return false
  if (!isCanonicalUuid(value.message_id) || !isOrderKey(value.order)) return false
  if (value.order.message_id !== value.message_id) return false
  if (!isValidContent(value.content, roomContextAware)) return false
  if (!Array.isArray(value.attachments) || !value.attachments.every(isAttachment)) return false
  if (
    !hasExactKeys(value.requester, REQUESTER_KEYS) ||
    !isCanonicalUuid(value.requester.user_id) ||
    !isNonEmptyString(value.requester.display_name)
  ) {
    return false
  }
  if (!isCommandAuthority(value.authority, value.requester, scopeAware)) return false
  if (scopeAware && !isRemoteCommandProjectScope(value.project_scope, value.authority.kind)) {
    return false
  }
  if (!isConnectionIdentity(value.addressee) || value.addressee.connection_id !== connectionId) {
    return false
  }
  if (
    !hasExactKeys(value.delivery, DELIVERY_KEYS) ||
    !isCanonicalUuid(value.delivery.provenance_ref) ||
    !isCanonicalUuid(value.delivery.turn_id) ||
    !isCanonicalUuid(value.delivery.primary_provenance_ref) ||
    typeof value.delivery.is_primary !== 'boolean'
  ) {
    return false
  }
  return true
}

function isControl(value) {
  if (!isPlainObject(value)) return false
  const keys = Object.keys(value)
  if (keys.some((key) => !CONTROL_KEYS.has(key))) return false
  return (
    isCanonicalUuid(value.id) &&
    CONTROL_VERBS.has(value.verb) &&
    isCanonicalIsoDatetime(value.issued_at) &&
    isCanonicalUuid(value.issued_by_user_id) &&
    (value.args === undefined || isPlainObject(value.args))
  )
}

function isRoomAttachment(att) {
  if (!isPlainObject(att)) return false
  return isNonEmptyString(att.filename)
}

function isContextRoomMetadata(room) {
  if (!isPlainObject(room) || !hasOnlyAllowedKeys(room, CONTEXT_ROOM_KEYS)) return false
  if (!isCanonicalIsoDatetime(room.updated_at)) return false
  if (room.author_connection_id !== null && room.author_connection_id !== undefined && !isCanonicalUuid(room.author_connection_id)) {
    return false
  }
  if (room.author_codename !== null && room.author_codename !== undefined && !isNonEmptyString(room.author_codename)) {
    return false
  }
  if (room.addressed_to !== null && room.addressed_to !== undefined) {
    if (!hasExactKeys(room.addressed_to, CONTEXT_ADDRESSED_TO_KEYS)) return false
    if (!isCanonicalUuid(room.addressed_to.connection_id) || !isNonEmptyString(room.addressed_to.agent_name)) return false
    if (room.addressed_to.codename !== null && !isNonEmptyString(room.addressed_to.codename)) return false
  }
  if (room.work_trail !== undefined && room.work_trail !== null && typeof room.work_trail !== 'string') {
    return false
  }
  if (room.trail_events !== undefined && room.trail_events !== null && !Array.isArray(room.trail_events)) {
    return false
  }
  return true
}

function isContextEntry(value, expectedKind, roomContextAware = false) {
  if (!isPlainObject(value)) return false
  const allowed = roomContextAware ? CONTEXT_ENTRY_ROOM_KEYS : CONTEXT_ENTRY_KEYS
  if (!hasOnlyAllowedKeys(value, allowed)) return false
  for (const req of CONTEXT_ENTRY_KEYS) {
    if (!Object.hasOwn(value, req)) return false
  }
  if (!isCanonicalUuid(value.message_id) || !isOrderKey(value.order)) return false
  if (value.order.message_id !== value.message_id) return false
  if (!hasExactKeys(value.actor, CONTEXT_ACTOR_KEYS) || value.actor.kind !== expectedKind) {
    return false
  }
  if (value.actor.user_id !== null && !isCanonicalUuid(value.actor.user_id)) return false
  if (!isNonEmptyString(value.actor.display_name)) return false
  if (value.actor.agent_tool !== null && !isNonEmptyString(value.actor.agent_tool)) return false
  if (value.actor.model !== null && !isNonEmptyString(value.actor.model)) return false
  if (!isNonEmptyString(value.source_type) || value.relationship !== 'within_window') return false
  if (typeof value.content !== 'string' || value.advisory !== true) return false
  if (Object.hasOwn(value, 'attachments')) {
    if (!Array.isArray(value.attachments) || !value.attachments.every(isRoomAttachment)) return false
  }
  if (Object.hasOwn(value, 'room')) {
    if (value.room !== null && !isContextRoomMetadata(value.room)) return false
  }
  return true
}

function isStrictlyOrdered(entries) {
  for (let i = 1; i < entries.length; i++) {
    if (compareOrder(entries[i - 1].order, entries[i].order) >= 0) return false
  }
  return true
}

function isActivePlanActor(value, allowedKinds) {
  if (!hasExactKeys(value, ACTIVE_PLAN_ACTOR_KEYS) || !allowedKinds.has(value.kind)) return false
  if (value.kind === 'connection') {
    return (
      isCanonicalUuid(value.connection_id) &&
      isNonBlankString(value.agent_name) &&
      (value.codename === null || isNonBlankString(value.codename))
    )
  }
  return value.connection_id === null && value.agent_name === null && value.codename === null
}

function isActivePlanStep(value) {
  return (
    hasExactKeys(value, ACTIVE_PLAN_STEP_KEYS) &&
    isCanonicalUuid(value.id) &&
    isSafeNonNegativeInteger(value.position) &&
    value.position < 64 &&
    isNonBlankString(value.title) &&
    ACTIVE_PLAN_STEP_STATUSES.has(value.status)
  )
}

function isActiveSessionPlanSummary(value) {
  if (!hasExactKeys(value, ACTIVE_PLAN_KEYS)) return false
  if (
    !isCanonicalUuid(value.id) ||
    !isNonBlankString(value.title) ||
    !isSafePositiveInteger(value.revision) ||
    value.status !== 'active' ||
    !isCanonicalIsoDatetime(value.created_at) ||
    !isActivePlanActor(value.origin, ACTIVE_PLAN_ORIGIN_KINDS) ||
    !isActivePlanActor(value.steward, ACTIVE_PLAN_STEWARD_KINDS) ||
    !hasExactKeys(value.owner, REQUESTER_KEYS) ||
    !isCanonicalUuid(value.owner.user_id) ||
    !isNonBlankString(value.owner.display_name) ||
    typeof value.orphaned !== 'boolean' ||
    !hasExactKeys(value.progress, ACTIVE_PLAN_PROGRESS_KEYS) ||
    !Array.isArray(value.steps) ||
    value.steps.length > 64 ||
    !value.steps.every(isActivePlanStep)
  ) {
    return false
  }
  if (value.orphaned && value.steward.kind !== 'connection') return false
  const stepIds = new Set()
  for (let i = 0; i < value.steps.length; i++) {
    const step = value.steps[i]
    if (stepIds.has(step.id)) return false
    stepIds.add(step.id)
    if (i > 0 && value.steps[i - 1].position >= step.position) return false
  }
  const completed = value.steps.filter((step) => step.status === 'completed').length
  const skipped = value.steps.filter((step) => step.status === 'skipped').length
  const terminal = completed + skipped
  return (
    value.progress.total === value.steps.length &&
    value.progress.completed === completed &&
    value.progress.skipped === skipped &&
    value.progress.terminal === terminal
  )
}

export function isActiveSessionPlansProjectionV1(value) {
  if (!hasExactKeys(value, ACTIVE_PLAN_PROJECTION_KEYS)) return false
  if (
    value.version !== 1 ||
    value.advisory !== true ||
    value.authority_note !== ACTIVE_PLAN_AUTHORITY_NOTE ||
    !hasExactKeys(value.inventory, ACTIVE_PLAN_INVENTORY_KEYS) ||
    !isSafeNonNegativeInteger(value.inventory.returned) ||
    !isSafeNonNegativeInteger(value.inventory.total_known) ||
    value.inventory.truncated !== false ||
    !Array.isArray(value.plans) ||
    value.plans.length > 64 ||
    !value.plans.every(isActiveSessionPlanSummary)
  ) {
    return false
  }
  const planIds = new Set(value.plans.map((plan) => plan.id))
  return (
    planIds.size === value.plans.length &&
    value.inventory.returned === value.plans.length &&
    value.inventory.total_known === value.plans.length
  )
}

export function validateActiveSessionPlansV1(value) {
  return isActiveSessionPlansProjectionV1(value)
    ? null
    : 'active_session_plans projection is malformed or inconsistent'
}

function isSessionPollItem(poll) {
  if (!hasExactKeys(poll, SESSION_POLL_KEYS)) return false
  if (
    !isCanonicalUuid(poll.id) ||
    !isNonBlankString(poll.question) ||
    (poll.status !== 'open' && poll.status !== 'closed') ||
    !isSafePositiveInteger(poll.revision) ||
    !isCanonicalIsoDatetime(poll.created_at) ||
    (poll.closed_at !== null && !isCanonicalIsoDatetime(poll.closed_at)) ||
    !hasExactKeys(poll.creator, SESSION_POLL_CREATOR_KEYS) ||
    (poll.recommendation_index !== null && !isSafeNonNegativeInteger(poll.recommendation_index)) ||
    !Array.isArray(poll.options) ||
    poll.options.length < 2 ||
    !isSafeNonNegativeInteger(poll.total_votes)
  ) {
    return false
  }
  for (let i = 0; i < poll.options.length; i++) {
    const opt = poll.options[i]
    if (
      !hasExactKeys(opt, SESSION_POLL_OPTION_KEYS) ||
      opt.index !== i ||
      !isNonBlankString(opt.label) ||
      !isSafeNonNegativeInteger(opt.vote_count) ||
      !Array.isArray(opt.voters) ||
      !opt.voters.every((v) => hasExactKeys(v, SESSION_POLL_VOTER_KEYS) && isCanonicalUuid(v.user_id) && isNonBlankString(v.display_name))
    ) {
      return false
    }
  }
  return true
}

export function isSessionPollsProjectionV1(value) {
  if (!hasExactKeys(value, SESSION_POLL_PROJECTION_KEYS)) return false
  if (
    value.version !== 1 ||
    value.advisory !== true ||
    value.authority_note !== SESSION_POLL_AUTHORITY_NOTE ||
    !hasExactKeys(value.inventory, ACTIVE_PLAN_INVENTORY_KEYS) ||
    !isSafeNonNegativeInteger(value.inventory.returned) ||
    !isSafeNonNegativeInteger(value.inventory.total_known) ||
    value.inventory.truncated !== false ||
    !Array.isArray(value.polls) ||
    !value.polls.every(isSessionPollItem)
  ) {
    return false
  }
  return value.inventory.returned === value.polls.length
}

export function isSessionPollsProjectionV2(value) {
  if (!hasExactKeys(value, SESSION_POLL_PROJECTION_KEYS)) return false
  if (
    value.version !== SESSION_POLL_PROJECTION_VERSION_2 ||
    value.advisory !== true ||
    value.authority_note !== SESSION_POLL_AUTHORITY_NOTE ||
    !isPlainObject(value.inventory) ||
    !hasOnlyAllowedKeys(value.inventory, SESSION_POLL_V2_INVENTORY_KEYS) ||
    !isSafeNonNegativeInteger(value.inventory.returned) ||
    !isSafeNonNegativeInteger(value.inventory.total_known) ||
    typeof value.inventory.truncated !== 'boolean' ||
    !Array.isArray(value.polls) ||
    !value.polls.every(isSessionPollItem)
  ) {
    return false
  }
  return value.inventory.returned === value.polls.length
}

export function isSessionPollsProjection(value) {
  return isSessionPollsProjectionV1(value) || isSessionPollsProjectionV2(value)
}

function isDiscussionPointItem(pt) {
  if (!hasExactKeys(pt, STILL_TO_DISCUSS_POINT_KEYS)) return false
  return (
    isCanonicalUuid(pt.id) &&
    isNonBlankString(pt.title) &&
    (pt.body === null || typeof pt.body === 'string') &&
    (pt.status === 'open' || pt.status === 'resolved') &&
    isSafeNonNegativeInteger(pt.position) &&
    isCanonicalIsoDatetime(pt.created_at) &&
    (pt.resolved_at === null || isCanonicalIsoDatetime(pt.resolved_at)) &&
    (pt.source_message_id === null || isCanonicalUuid(pt.source_message_id))
  )
}

export function isStillToDiscussProjectionV1(value) {
  if (!hasExactKeys(value, STILL_TO_DISCUSS_PROJECTION_KEYS)) return false
  if (
    value.version !== 1 ||
    value.advisory !== true ||
    value.authority_note !== STILL_TO_DISCUSS_AUTHORITY_NOTE ||
    !hasExactKeys(value.inventory, ACTIVE_PLAN_INVENTORY_KEYS) ||
    !isSafeNonNegativeInteger(value.inventory.returned) ||
    !isSafeNonNegativeInteger(value.inventory.total_known) ||
    value.inventory.truncated !== false ||
    !Array.isArray(value.points) ||
    !value.points.every(isDiscussionPointItem)
  ) {
    return false
  }
  return value.inventory.returned === value.points.length
}

export function isSessionActivityV1(value) {
  if (!isPlainObject(value) || !hasOnlyAllowedKeys(value, SESSION_ACTIVITY_KEYS)) return false
  if (
    value.version !== 1 ||
    value.advisory !== true ||
    typeof value.list_readable !== 'boolean' ||
    !Array.isArray(value.items) ||
    !Array.isArray(value.events)
  ) {
    return false
  }
  for (const item of value.items) {
    if (!isPlainObject(item) || !isCanonicalUuid(item.id) || !isNonBlankString(item.title)) return false
  }
  for (const ev of value.events) {
    if (!isPlainObject(ev) || !isNonEmptyString(ev.id) || !isCanonicalIsoDatetime(ev.at)) return false
  }
  return true
}

export function isSessionEventsV1(value) {
  if (!isPlainObject(value) || !hasOnlyAllowedKeys(value, SESSION_EVENTS_PROJECTION_KEYS)) return false
  if (
    value.version !== 1 ||
    value.advisory !== true ||
    !isPlainObject(value.inventory) ||
    typeof value.inventory.truncated !== 'boolean' ||
    !Array.isArray(value.events)
  ) {
    return false
  }
  for (const ev of value.events) {
    if (!isPlainObject(ev) || !isNonEmptyString(ev.id) || !isCanonicalIsoDatetime(ev.created_at)) return false
  }
  return true
}

function isSystemNotice(value) {
  if (!hasExactKeys(value, SYSTEM_NOTICE_KEYS)) return false
  if (
    !isCanonicalUuid(value.notice_id) ||
    !isCanonicalIsoDatetime(value.created_at) ||
    !SYSTEM_NOTICE_CODES.has(value.code) ||
    !isNonBlankString(value.summary) ||
    !SYSTEM_NOTICE_ACTOR_KINDS.has(value.actor_kind) ||
    value.advisory !== true ||
    value.executable !== false
  ) {
    return false
  }
  if (value.requester !== null) {
    if (
      !hasExactKeys(value.requester, REQUESTER_KEYS) ||
      !isCanonicalUuid(value.requester.user_id) ||
      !isNonBlankString(value.requester.display_name)
    ) {
      return false
    }
  }
  return true
}

function isSenderResponseStyle(value, commandMessageIds) {
  if (!hasExactKeys(value, SENDER_STYLE_KEYS)) return false
  if (
    !isCanonicalUuid(value.message_id) ||
    !commandMessageIds.has(value.message_id) ||
    !isCanonicalUuid(value.sender_user_id) ||
    !Array.isArray(value.notes) ||
    value.notes.length === 0 ||
    !value.notes.every(isNonBlankString)
  ) {
    return false
  }
  return true
}

function isWindowMetadata(windowValue, rows, expectedPolicyVersion) {
  if (!hasExactKeys(windowValue, WINDOW_KEYS)) return false
  if (
    windowValue.policy_version !== expectedPolicyVersion ||
    !isSafeNonNegativeInteger(windowValue.returned) ||
    !isSafeNonNegativeInteger(windowValue.total_known) ||
    windowValue.returned !== rows.length ||
    windowValue.total_known < windowValue.returned ||
    !hasExactKeys(windowValue.source_window, SOURCE_WINDOW_KEYS) ||
    typeof windowValue.truncated !== 'boolean' ||
    typeof windowValue.has_more !== 'boolean'
  ) {
    return false
  }

  const { start, end } = windowValue.source_window
  if (rows.length === 0) {
    if (start !== null || end !== null) return false
  } else {
    if (!isOrderKey(start) || !isOrderKey(end)) return false
    if (!sameOrder(start, rows[0].order) || !sameOrder(end, rows.at(-1).order)) return false
  }

  if (windowValue.has_more) {
    return (
      isNonEmptyString(windowValue.next_cursor) &&
      isNonEmptyString(windowValue.fetch_id) &&
      OMISSION_REASONS.has(windowValue.omission_reason)
    )
  }
  if (windowValue.next_cursor !== null || windowValue.fetch_id !== null) return false
  if (windowValue.truncated) return OMISSION_REASONS.has(windowValue.omission_reason)
  return windowValue.omission_reason === null
}

export function validateRemoteIngressV1(ingress, connectionId) {
  if (!isCanonicalUuid(connectionId)) {
    return { ok: false, error: 'connectionId is not a canonical UUID' }
  }
  if (!isPlainObject(ingress)) {
    return { ok: false, error: 'ingress is missing or not an object' }
  }
  const contract = CANONICAL_CONTRACTS.get(ingress.contract_version)
  if (
    ingress.kind !== REMOTE_INGRESS_KIND ||
    ingress.schema_version !== REMOTE_INGRESS_SCHEMA_VERSION ||
    !contract ||
    ingress.policy_version !== contract.policyVersion ||
    !isCanonicalUuid(ingress.envelope_id)
  ) {
    return { ok: false, error: 'ingress header/version mismatch' }
  }
  const expectedEnvelopeKeys = contract.roomContextAware
    ? ROOM_CONTEXT_ENVELOPE_KEYS
    : contract.senderStyleAware
      ? SENDER_STYLE_ENVELOPE_KEYS
      : contract.systemNoticeAware
        ? SYSTEM_NOTICE_ENVELOPE_KEYS
        : contract.planAware
          ? PLAN_ENVELOPE_KEYS
          : BASE_ENVELOPE_KEYS
  if (!contract.planAware && Object.hasOwn(ingress, 'active_session_plans')) {
    return { ok: false, error: 'active_session_plans requires canonical contract 1.3.0' }
  }
  if (contract.roomContextAware) {
    if (!hasOnlyAllowedKeys(ingress, expectedEnvelopeKeys)) {
      return { ok: false, error: 'ingress does not match the v1.6 key set' }
    }
    for (const req of SENDER_STYLE_ENVELOPE_KEYS) {
      if (!Object.hasOwn(ingress, req)) {
        return { ok: false, error: `ingress missing required field ${req}` }
      }
    }
  } else if (!hasExactKeys(ingress, expectedEnvelopeKeys)) {
    return { ok: false, error: 'ingress does not have the exact v1 key set' }
  }
  if (
    !isConnectionIdentity(ingress.connection) ||
    ingress.connection.connection_id !== connectionId
  ) {
    return { ok: false, error: 'ingress connection identity does not match this connection' }
  }
  if (
    !hasExactKeys(ingress.wake, WAKE_KEYS) ||
    !WAKE_KINDS.has(ingress.wake.kind) ||
    typeof ingress.wake.active !== 'boolean' ||
    !isNonEmptyString(ingress.wake.reason_id) ||
    !DELIVERY_STATES.has(ingress.delivery_state)
  ) {
    return { ok: false, error: 'ingress wake/delivery_state is invalid' }
  }
  if (
    !Array.isArray(ingress.command_message_ids) ||
    !ingress.command_message_ids.every(isCanonicalUuid) ||
    !Array.isArray(ingress.commands) ||
    !ingress.commands.every((entry) =>
      isCommand(entry, connectionId, {
        scopeAware: contract.scopeAware,
        roomContextAware: contract.roomContextAware,
      }),
    ) ||
    !isStrictlyOrdered(ingress.commands)
  ) {
    return { ok: false, error: 'ingress commands are invalid or out of order' }
  }
  if (
    ingress.command_message_ids.length !== ingress.commands.length ||
    ingress.commands.some((entry, idx) => entry.message_id !== ingress.command_message_ids[idx])
  ) {
    return { ok: false, error: 'command_message_ids does not match commands' }
  }

  const provenanceRefs = new Set()
  const turnIds = new Set()
  const primaryRefs = new Set()
  for (const command of ingress.commands) {
    if (
      command.delivery.is_primary !==
      (command.delivery.provenance_ref === command.delivery.primary_provenance_ref)
    ) {
      return { ok: false, error: 'invalid is_primary in turn binding' }
    }
    if (provenanceRefs.has(command.delivery.provenance_ref)) {
      return { ok: false, error: 'duplicate command provenance_ref in turn binding' }
    }
    provenanceRefs.add(command.delivery.provenance_ref)
    turnIds.add(command.delivery.turn_id)
    primaryRefs.add(command.delivery.primary_provenance_ref)
  }
  if (ingress.commands.length > 0 && (turnIds.size !== 1 || primaryRefs.size !== 1)) {
    return { ok: false, error: 'commands do not share one turn binding' }
  }

  if (ingress.control !== null && !isControl(ingress.control)) {
    return { ok: false, error: 'ingress control is invalid' }
  }

  if (!hasExactKeys(ingress.context, CONTEXT_KEYS)) {
    return { ok: false, error: 'ingress context buckets are invalid' }
  }
  for (const bucket of CONTEXT_BUCKETS) {
    const entries = ingress.context[bucket]
    const kind = CONTEXT_ACTOR_BY_BUCKET[bucket]
    if (
      !Array.isArray(entries) ||
      !entries.every((entry) => isContextEntry(entry, kind, contract.roomContextAware)) ||
      !isStrictlyOrdered(entries)
    ) {
      return { ok: false, error: `ingress ${bucket} is invalid or out of order` }
    }
  }

  if (
    contract.planAware &&
    ingress.active_session_plans !== null &&
    !isActiveSessionPlansProjectionV1(ingress.active_session_plans)
  ) {
    return { ok: false, error: 'ingress active_session_plans is invalid' }
  }

  if (contract.systemNoticeAware) {
    if (!Array.isArray(ingress.system_notices) || !ingress.system_notices.every(isSystemNotice)) {
      return { ok: false, error: 'ingress system_notices is invalid' }
    }
  }

  if (contract.senderStyleAware) {
    const cmdIdSet = new Set(ingress.command_message_ids)
    if (
      !Array.isArray(ingress.sender_response_styles) ||
      !ingress.sender_response_styles.every((s) => isSenderResponseStyle(s, cmdIdSet))
    ) {
      return { ok: false, error: 'ingress sender_response_styles is invalid' }
    }
  }

  if (contract.roomContextAware) {
    if (
      ingress.session_activity !== undefined &&
      ingress.session_activity !== null &&
      !isSessionActivityV1(ingress.session_activity)
    ) {
      return { ok: false, error: 'ingress session_activity is invalid' }
    }
    if (
      ingress.session_events !== undefined &&
      ingress.session_events !== null &&
      !isSessionEventsV1(ingress.session_events)
    ) {
      return { ok: false, error: 'ingress session_events is invalid' }
    }
  }

  const allRows = [
    ...ingress.commands,
    ...CONTEXT_BUCKETS.flatMap((bucket) => ingress.context[bucket]),
  ].sort((left, right) => compareOrder(left.order, right.order))
  if (!isStrictlyOrdered(allRows)) {
    return { ok: false, error: 'ingress window contains duplicate order keys' }
  }
  const commandIds = new Set(ingress.command_message_ids)
  for (const bucket of CONTEXT_BUCKETS) {
    for (const entry of ingress.context[bucket]) {
      if (commandIds.has(entry.message_id)) {
        return { ok: false, error: 'message appears in both commands and context' }
      }
    }
  }
  if (!isWindowMetadata(ingress.window, allRows, contract.policyVersion)) {
    return { ok: false, error: 'ingress window metadata does not match returned rows' }
  }

  if (ingress.wake.kind === 'conversational_command') {
    if (
      !ingress.wake.active ||
      ingress.delivery_state !== 'live' ||
      ingress.commands.length === 0 ||
      ingress.control !== null
    ) {
      return { ok: false, error: 'conversational_command wake invariant failed' }
    }
  } else if (ingress.wake.kind === 'control') {
    if (
      !ingress.wake.active ||
      ingress.delivery_state !== 'live' ||
      ingress.control === null ||
      ingress.commands.length !== 0
    ) {
      return { ok: false, error: 'control wake invariant failed' }
    }
  } else if (
    ingress.wake.active ||
    ingress.commands.length !== 0 ||
    ingress.control !== null ||
    (ingress.wake.kind === 'history_reseed' && ingress.delivery_state === 'live')
  ) {
    return { ok: false, error: 'non-wake envelope invariant failed' }
  }

  return { ok: true, envelope: ingress }
}

/**
 * Backward-compatible validator returning `null` when valid or an error string when
 * invalid (including when a command attachment is `unavailable`).
 */
export function validateRemoteIngressEnvelopeV1(ingress, connectionId) {
  const res = validateRemoteIngressV1(ingress, connectionId)
  if (!res.ok) return res.error
  const hasUnavailable = ingress.commands.some((command) =>
    command.attachments.some((attachment) => attachment.materialization === 'unavailable'),
  )
  if (hasUnavailable) return 'command attachment unavailable'
  return null
}

/**
 * Validate and classify a canonical ingress envelope for runtime delivery.
 * Accepts either the raw `ingress` envelope object OR a poll response `{ ingress }`.
 */
export function normalizeRemoteIngressV1(input, connectionId) {
  const ingress =
    isPlainObject(input) && input.kind !== REMOTE_INGRESS_KIND && isPlainObject(input.ingress)
      ? input.ingress
      : input
  const validated = validateRemoteIngressV1(ingress, connectionId)
  if (!validated.ok) return validated

  const envelope = validated.envelope
  const hasUnavailableCommandAttachment = envelope.commands.some((command) =>
    command.attachments.some((attachment) => attachment.materialization === 'unavailable'),
  )
  if (hasUnavailableCommandAttachment) {
    return {
      ok: true,
      wake: false,
      reason: 'unavailable_attachment',
      envelope,
      commands: [],
    }
  }

  const wake =
    envelope.wake.kind === 'conversational_command' &&
    envelope.wake.active === true &&
    envelope.delivery_state === 'live' &&
    envelope.commands.length > 0

  return {
    ok: true,
    wake,
    reason: wake ? 'conversational_command' : envelope.wake.kind,
    envelope,
    commands: wake ? envelope.commands : [],
  }
}

/**
 * Bounded newest-first carry for typed advisory context when a caller wants an
 * in-memory summary. Kept for test and backward-compatibility surfaces.
 */
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
  for (const bucket of CONTEXT_BUCKETS) {
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

export function renderAdvisoryContext(context) {
  if (!context || typeof context !== 'object') return []
  return CONTEXT_BUCKETS.flatMap((bucket) => (Array.isArray(context[bucket]) ? context[bucket] : []))
}
