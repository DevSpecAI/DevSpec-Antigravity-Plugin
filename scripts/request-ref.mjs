/**
 * Say which request a DevSpec MCP write serves, or refuse when the turn carries
 * multiple requesters and the agent has not named which one the write serves via
 * `devspec-serve-request.mjs`.
 *
 * A write that takes `request_ref` gets the request and nothing else. The request
 * answers for its work after its command has closed; the command tag
 * (`provenance_ref`) is read first by DevSpec and must still be live, so sending
 * it beside the request made a write fail on a closed command although the
 * request said who asked. Only the few tools that take the command and not the
 * request still get `provenance_ref`.
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
  'manage_incident',
  'manage_inventory_connections',
  'manage_knowledge_links',
  'manage_protected_intent',
  'record_completed_work',
  'record_criterion_verdicts',
  'record_dependency_review',
  'record_duplicate_nonmatch',
  'record_implementation',
  'record_inventory_entry',
  'record_memory',
  'record_requirement',
  'release_work_item',
  'reopen_task',
  'report_incident',
  'resolve_duplicate',
  'resolve_memory_flag',
  'resolve_resource_flag',
  'resolve_task_flag',
  'retract_inventory_entry',
  'retract_memory',
  'retract_requirement',
  'revise_inventory_entry',
  'spin_off_task',
  'supersede_task',
  'supersede_memory',
  'supersede_requirement',
  'supersede_resource',
  'unlink_tasks',
  'update_task',
  'update_automation',
  'update_memory',
  'update_requirement',
  'update_resource',
  'write_project_instruction_rule',
])

/**
 * DevSpec tools that accept `provenance_ref`. Kept equal to the server's list by
 * `server-tool-names.test.mjs`; it is not the list of tools that get one stamped
 * (see `stampsCommand`).
 */
export const PROVENANCE_REF_TOOLS = new Set([
  ...REQUEST_REF_TOOLS,
  'claim_work_item',
  'manage_directed_question',
  'preview_supersession',
  'report_request',
  'reserve_work_items',
])

/**
 * Whether PreToolUse adds the command tag to this tool: only where the server
 * takes the command and has no `request_ref` to name the request with.
 */
export function stampsCommand(toolName) {
  return PROVENANCE_REF_TOOLS.has(toolName) && !REQUEST_REF_TOOLS.has(toolName)
}

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
  if (next.provenance_ref === undefined && stampsCommand(toolName)) {
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
