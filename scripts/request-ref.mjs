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
 * Verified against `apps/web/lib/mcp/tool-definitions.ts` via `server-tool-names.test.mjs`.
 */
export const REQUEST_REF_TOOLS = new Set([
  'add_commit_reference',
  'add_implementation_note',
  'archive_resource',
  'classify_criterion',
  'create_action_item',
  'create_automation',
  'create_resource',
  'delete_automation',
  'fail_work_item',
  'import_instruction_rules',
  'link_action_items',
  'manage_knowledge_links',
  'manage_protected_intent',
  'record_completed_work',
  'record_criterion_verdicts',
  'record_implementation',
  'record_memory',
  'release_work_item',
  'reopen_action_item',
  'resolve_memory_flag',
  'resolve_resource_flag',
  'retract_memory',
  'spin_off_action_item',
  'supersede_action_item',
  'supersede_memory',
  'supersede_resource',
  'unlink_action_items',
  'update_action_item',
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
    next = { ...next, request_ref: ref }
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
