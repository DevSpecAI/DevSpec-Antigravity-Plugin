/**
 * Stamp `request_ref` and `provenance_ref` onto DevSpec MCP writes, or refuse
 * when the turn carries multiple requesters and the agent has not named which
 * one the write serves via `devspec-serve-request.mjs`.
 */

import os from 'node:os'
import path from 'node:path'
import {
  provenanceRefForWrite,
  readRequestState,
  requestRefForWrite,
  servableCarried,
  turnAmbiguity,
  undecidedTurnMessage,
} from './requests.mjs'

const CONNECTION_SUBJECT = /(?:^|_)connection(?:_|$)|^report_(?:pickup|keepalive|complete|request)$/

/**
 * The DevSpec tools that record who asked for a write and take `request_ref`.
 * Kept equal to the server tools that take `request_ref` by `server-tool-names.test.mjs`
 * (run with DEVSPEC_V2_ROOT naming a devspecv2 checkout).
 */
export const REQUEST_REF_TOOLS = new Set([
  'add_commit_reference',
  'add_implementation_note',
  'archive_resource',
  'classify_criterion',
  'create_task',
  'create_automation',
  'create_resource',
  'decide_proposal',
  'delete_automation',
  'fail_work_item',
  'import_instruction_rules',
  'link_tasks',
  'manage_goals',
  'manage_knowledge_links',
  'manage_protected_intent',
  'record_completed_work',
  'record_criterion_verdicts',
  'record_duplicate_nonmatch',
  'record_implementation',
  'record_memory',
  'release_work_item',
  'reopen_task',
  'resolve_duplicate',
  'resolve_memory_flag',
  'resolve_resource_flag',
  'resolve_task_flag',
  'retract_memory',
  'spin_off_task',
  'supersede_task',
  'supersede_memory',
  'supersede_resource',
  'unlink_tasks',
  'update_task',
  'update_automation',
  'update_memory',
  'update_resource',
  'write_project_instruction_rule',
])

/**
 * DevSpec tools that accept `provenance_ref`.
 */
export const PROVENANCE_REF_TOOLS = new Set([
  ...REQUEST_REF_TOOLS,
  'claim_work_item',
  'manage_directed_question',
  'preview_supersession',
  'report_request',
  'reserve_work_items',
])

export function stampRequest(
  toolName,
  args,
  connectionId,
  agentId = null,
  { home = os.homedir(), connectionState = null } = {}
) {
  if (!args || typeof args !== 'object') return { args }
  let own = args
  if (Object.hasOwn(args, 'request_ref')) {
    const { request_ref: _written, ...rest } = args
    own = rest
  }
  if (!connectionId || CONNECTION_SUBJECT.test(toolName)) return { args: own }
  const dir = path.join(home, '.devspec', 'remote-control', 'connections')
  const state = readRequestState(connectionId, { dir })
  const agent = typeof agentId === 'string' && agentId ? agentId : null

  const cites = typeof own.work_claim_ref === 'string' || typeof own.provenance_ref === 'string'
  const requiresAttribution = REQUEST_REF_TOOLS.has(toolName) || PROVENANCE_REF_TOOLS.has(toolName)
  const carried = requiresAttribution && !cites ? turnAmbiguity(state, agent) : null
  if (carried) {
    return { deny: undecidedTurnMessage(connectionId, servableCarried(state, carried), 'this change') }
  }

  let next = own
  const ref = requestRefForWrite(state, agent)
  if (ref && REQUEST_REF_TOOLS.has(toolName)) {
    next = {
      ...next,
      ...(next.connection_id === undefined ? { connection_id: connectionId } : {}),
      request_ref: ref,
    }
  }
  if (next.provenance_ref === undefined && PROVENANCE_REF_TOOLS.has(toolName)) {
    const provRef =
      provenanceRefForWrite(state, agent) ||
      (typeof connectionState?.provenance_ref === 'string' && connectionState.provenance_ref
        ? connectionState.provenance_ref
        : null)
    if (provRef) {
      next = { ...next, provenance_ref: provRef }
    }
  }
  return { args: next }
}
