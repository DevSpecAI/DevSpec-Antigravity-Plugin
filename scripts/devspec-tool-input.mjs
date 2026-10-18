#!/usr/bin/env node
/**
 * Antigravity PreToolUse hook for DevSpec MCP tools (`mcp_devspec_*`, `mcp__devspec__*`)
 * and background launches (`run_command`, `invoke_subagent`, `schedule`).
 *
 * 1. Denies background launches (`run_command`, `invoke_subagent`, `schedule`) when
 *    a turn carries multiple requesters and the agent has not run `devspec-serve-request.mjs`.
 * 2. Holds `post_session_message` once on `PreToolUse` when unread room messages
 *    arrived mid-turn (`prePostHoldObject`).
 * 3. Denies ambiguous multi-requester DevSpec writes unless disambiguated via
 *    `devspec-serve-request.mjs` or an explicit `work_claim_ref` / `provenance_ref`.
 * 4. Mechanically stamps `connection_id`, `project_id`, `local_session_id`,
 *    `provenance_ref`, `request_ref`, `agent_name`, and `plugin_version` into
 *    `overwrite` (and `hookSpecificOutput.updatedInput`) when unambiguous.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AGENT_NAME } from './agent-identity.mjs'
import { handleBashPre } from './commit-observation.mjs'
import { handlePre } from './commit-provenance.mjs'
import { versionedConnectionArguments } from './connection-version.mjs'
import { launchGuard, resolveOwnConnectionId } from './launch-guard.mjs'
import {
  extractAntigravityTrailFromTranscript,
  parseTranscriptPath,
  readTurnMarker,
  resolveHookConversationId,
  writeExplicitReplyMarker,
} from './mirror-turn.mjs'
import { inferAntigravityTranscriptPath, readStateFile } from './remote-control-state.mjs'
import { stampRequest } from './request-ref.mjs'
import { readRequestState } from './requests.mjs'
import { prePostHoldObject } from './room-unread.mjs'
import { readConnectionTelemetry } from './statusline.mjs'

const CONNECTION_SUBJECT = /(?:^|_)connection(?:_|$)|^report_(?:pickup|keepalive|complete|request)$/

const PROJECTLESS_TOOLS = new Set([
  'list_projects',
  'verify_agent_connection',
  'devspec_help_search',
  'get_personal_instructions',
  'update_personal_instructions',
])

const LOCAL_SESSION_ID_TOOLS = new Set([
  'update_task',
  'claim_work_item',
  'record_implementation',
  'record_automation_run',
])

const AGENT_NAME_TOOLS = new Set([
  'create_task',
  'surface_session_tasks',
  'create_session',
  'post_session_message',
  'register_connection',
  'heartbeat_connection',
  'poll_connection',
])

export function parseDevspecToolName(toolName) {
  const s = String(toolName || '')
  const match = /^(?:mcp__(?:plugin_devspec_)?devspec__|mcp_devspec_|devspec__)([a-z0-9_]+)$/.exec(s)
  return match ? match[1] : null
}

function unquoteString(val) {
  if (typeof val !== 'string') return val
  const trimmed = val.trim()
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed)
    } catch {
      return trimmed.slice(1, -1)
    }
  }
  return trimmed
}

export function unwrapDevspecToolCall(toolName, rawToolInput) {
  const directVerb = parseDevspecToolName(toolName)
  if (directVerb) {
    return {
      verb: directVerb,
      args:
        rawToolInput && typeof rawToolInput === 'object' && !Array.isArray(rawToolInput)
          ? rawToolInput
          : null,
      wrapped: false,
      argumentsWasString: false,
      argumentsKey: null,
    }
  }
  const bare = String(toolName || '').replace(/^default_api:/, '')
  if (
    bare !== 'call_mcp_tool' ||
    !rawToolInput ||
    typeof rawToolInput !== 'object' ||
    Array.isArray(rawToolInput)
  ) {
    return { verb: null, args: null, wrapped: false, argumentsWasString: false, argumentsKey: null }
  }
  const serverName = String(
    unquoteString(rawToolInput.ServerName ?? rawToolInput.server_name ?? ''),
  ).toLowerCase()
  if (serverName !== 'devspec') {
    return { verb: null, args: null, wrapped: false, argumentsWasString: false, argumentsKey: null }
  }
  const verb = unquoteString(rawToolInput.ToolName ?? rawToolInput.tool_name ?? '')
  if (typeof verb !== 'string' || !/^[a-z0-9_]+$/.test(verb)) {
    return { verb: null, args: null, wrapped: false, argumentsWasString: false, argumentsKey: null }
  }
  const argumentsKey = Object.hasOwn(rawToolInput, 'arguments') ? 'arguments' : 'Arguments'
  const rawArgs = rawToolInput[argumentsKey]
  if (typeof rawArgs === 'string') {
    const unquoted = unquoteString(rawArgs)
    try {
      const parsed = typeof unquoted === 'string' ? JSON.parse(unquoted) : unquoted
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { verb, args: parsed, wrapped: true, argumentsWasString: true, argumentsKey }
      }
    } catch {
      return { verb: null, args: null, wrapped: false, argumentsWasString: false, argumentsKey: null }
    }
  }
  if (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
    return { verb, args: rawArgs, wrapped: true, argumentsWasString: false, argumentsKey }
  }
  return { verb, args: {}, wrapped: true, argumentsWasString: false, argumentsKey }
}

function readProjectPin(cwd) {
  if (!cwd) return null
  try {
    const file = path.join(cwd, '.devspec', 'project.json')
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    const id = data?.project_id ?? data?.id
    return typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id) ? id : null
  } catch {
    return null
  }
}

export function prepareDevspecToolInput(input, { env = process.env, home = os.homedir() } = {}) {
  if (!input || typeof input !== 'object') return {}

  // 1. Background launch guard during multi-requester turns
  const guard = launchGuard(input, { home, env })
  if (guard?.decision === 'deny' || guard?.hookSpecificOutput?.permissionDecision === 'deny') {
    return guard
  }

  const rawToolName = input.tool_name ?? input.toolName ?? input.toolCall?.name ?? ''
  const rawToolInput = input.tool_input ?? input.toolInput ?? input.toolCall?.args
  const {
    verb,
    args: toolInput,
    wrapped,
    argumentsWasString,
    argumentsKey,
  } = unwrapDevspecToolCall(rawToolName, rawToolInput)
  if (!verb || !toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput)) {
    return {}
  }

  // 2. Pre-post room unread hold (once per unpresented batch before post_session_message)
  if (verb === 'post_session_message') {
    const hold = prePostHoldObject({ input, env, home })
    if (hold) return hold
  }

  const conversationId = resolveHookConversationId(input, env)
  const connectionId = resolveOwnConnectionId(conversationId, { home })
  const connDir = path.join(home, '.devspec', 'remote-control', 'connections')
  const connState = connectionId ? readStateFile(connectionId, connDir) : null

  let next = { ...toolInput }
  if (verb === 'post_session_message' && next.provenance_ref !== undefined) {
    delete next.provenance_ref
  }
  const effectiveCwd =
    (Array.isArray(input.workspacePaths) && input.workspacePaths[0]) ||
    input.cwd ||
    process.cwd()

  // 3. Project scope stamping (from bound connection state or .devspec/project.json pin)
  if (!PROJECTLESS_TOOLS.has(verb)) {
    const boundProjectId =
      (typeof connState?.project_id === 'string' && connState.project_id ? connState.project_id : null) ||
      readProjectPin(effectiveCwd)
    if (boundProjectId) {
      if (next.project_id && next.project_id !== boundProjectId && connState?.project_id === boundProjectId) {
        const reason =
          'This conversation uses another DevSpec project. Start a fresh Antigravity conversation to switch projects.'
        return {
          decision: 'deny',
          reason,
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: reason,
          },
        }
      }
      if (!next.project_id) {
        next.project_id = boundProjectId
      }
    }
  }

  // 4. Connection ID stamping
  if (
    connectionId &&
    !CONNECTION_SUBJECT.test(verb) &&
    next.connection_id === undefined &&
    next.session_id === undefined
  ) {
    next.connection_id = connectionId
  }

  // 5. Local session ID & provider stamping
  if (conversationId && LOCAL_SESSION_ID_TOOLS.has(verb) && !next.local_session_id) {
    next.local_session_id = conversationId
  }
  if (verb === 'claim_work_item' && !next.provider) {
    next.provider = 'antigravity'
  }
  if (verb === 'register_connection' && conversationId && !next.local_id) {
    next.local_id = conversationId
  }

  // 6. Fixed agent_name stamping
  if (AGENT_NAME_TOOLS.has(verb) && next.agent_name !== AGENT_NAME) {
    next.agent_name = AGENT_NAME
  }

  // 7. Request ref & provenance_ref stamping (or multi-requester denial)
  const request = stampRequest(verb, next, connectionId, input.agent_id, {
    home,
    connectionState: connState,
  })
  if (request.deny) {
    return {
      decision: 'deny',
      reason: request.deny,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: request.deny,
      },
    }
  }
  next = versionedConnectionArguments(verb, request.args)

  // 8. For explicit session replies (non-trail, non-needs_input, non-local_prompt):
  //    record the explicit reply marker, stamp local-turn unbound flags when answering
  //    a local terminal prompt, stamp live mechanical telemetry (`agent_stats` and
  //    `model`) so LLM-guessed model names never override the host-reported model,
  //    and automatically attach `work_trail` + `trail_events` from the current turn's
  //    Antigravity transcript if not already supplied.
  if (
    verb === 'post_session_message' &&
    next.phase !== 'trail' &&
    next.phase !== 'needs_input' &&
    next.turn_kind !== 'local_prompt'
  ) {
    const targetConnId = next.connection_id || connectionId
    const turnMarker = targetConnId ? readTurnMarker(targetConnId, connDir) : null
    if (
      targetConnId &&
      !next.command_turn_id &&
      next.command_turn_unbound === undefined &&
      !next.interaction_event_id &&
      !next.question_dismissal_event_id
    ) {
      const reqState = readRequestState(targetConnId, { dir: connDir })
      const currentReq = reqState?.current ? reqState.open.get(reqState.current) : null
      const isLocalTurn = Boolean(
        connState?.local_turn ||
          (turnMarker &&
            !turnMarker.remoteTurn &&
            (turnMarker.localPromptMirrored || turnMarker.localTurn)) ||
          currentReq?.kind === 'typed_prompt',
      )
      if (isLocalTurn) {
        next = {
          ...next,
          command_turn_unbound: true,
          local_turn: true,
        }
      }
    }
    if (targetConnId) {
      writeExplicitReplyMarker(targetConnId, connDir)
      const telemetry = readConnectionTelemetry(targetConnId, { home })
      if (telemetry) {
        if (!next.agent_stats) {
          next = { ...next, agent_stats: telemetry }
        }
        if (telemetry.model?.id) {
          next = {
            ...next,
            model: {
              providerID: telemetry.model.provider || 'google',
              modelID: telemetry.model.id,
            },
          }
        }
      }
    }
    if (!next.work_trail && !next.trail_events) {
      const tPath =
        parseTranscriptPath(JSON.stringify(input)) ||
        connState?.transcript_path ||
        inferAntigravityTranscriptPath(conversationId || connState?.local_id)
      if (tPath && fs.existsSync(tPath)) {
        try {
          const { events, markdown } = extractAntigravityTrailFromTranscript(
            fs.readFileSync(tPath, 'utf8'),
            { sinceMs: turnMarker?.startedAt ?? null, stopAtReply: true },
          )
          if (markdown && events.length > 0) {
            const capped = capTrailForPreToolHook(events, markdown)
            next = {
              ...next,
              ...(capped.markdown ? { work_trail: capped.markdown } : {}),
              ...(capped.events.length > 0 ? { trail_events: capped.events } : {}),
            }
          }
        } catch {
          /* non-fatal */
        }
      }
    }
  }

  // Check if anything changed
  const changed =
    verb === 'register_connection' ||
    verb === 'attach_connection' ||
    JSON.stringify(next) !== JSON.stringify(toolInput)
  if (!changed) return {}

  let finalOverwrite = wrapped
    ? {
        ...rawToolInput,
        [argumentsKey || 'Arguments']: argumentsWasString ? JSON.stringify(next) : next,
      }
    : next

  // Antigravity reads PreToolUse stdout with Go's bufio.Scanner (64 KB MaxScanTokenSize).
  // If auto-attached trail fields push the serialized hook output past 48 KB, trim them
  // so the hook never fails with `bufio.Scanner: token too long`.
  if (
    verb === 'post_session_message' &&
    !toolInput.work_trail &&
    !toolInput.trail_events &&
    (next.work_trail || next.trail_events) &&
    Buffer.byteLength(JSON.stringify(finalOverwrite), 'utf8') > 48_000
  ) {
    const trimmedNext = { ...next }
    delete trimmedNext.trail_events
    if (
      trimmedNext.work_trail &&
      Buffer.byteLength(JSON.stringify(trimmedNext), 'utf8') > 44_000
    ) {
      delete trimmedNext.work_trail
    }
    next = trimmedNext
    finalOverwrite = wrapped
      ? {
          ...rawToolInput,
          [argumentsKey || 'Arguments']: argumentsWasString ? JSON.stringify(next) : next,
        }
      : next
  }

  return {
    decision: 'allow',
    overwrite: finalOverwrite,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      updatedInput: finalOverwrite,
    },
  }
}

/**
 * Cap `trail_events` and `work_trail` attached during `PreToolUse` so serialized
 * hook stdout stays well under Antigravity's 64 KB `bufio.Scanner` token limit.
 */
export function capTrailForPreToolHook(
  events = [],
  markdown = '',
  { maxTrailBytes = 24_000, maxEvents = 40 } = {},
) {
  const compactEvents = (Array.isArray(events) ? events : []).map((ev) => {
    if (!ev || typeof ev !== 'object') return ev
    if (ev.kind === 'thinking' && typeof ev.text === 'string' && ev.text.length > 500) {
      return { ...ev, text: `${ev.text.slice(0, 499)}…` }
    }
    if (typeof ev.args === 'string' && ev.args.length > 200) {
      return { ...ev, args: `${ev.args.slice(0, 199)}…` }
    }
    return ev
  })
  let keptEvents =
    compactEvents.length > maxEvents ? compactEvents.slice(-maxEvents) : compactEvents
  let keptMarkdown = String(markdown || '')
  if (keptMarkdown.length > 8_000) {
    const lines = keptMarkdown.split('\n')
    const tail = []
    let chars = 0
    for (let i = lines.length - 1; i >= 0; i--) {
      if (chars + lines[i].length + 1 > 7_500 && tail.length > 0) break
      tail.unshift(lines[i])
      chars += lines[i].length + 1
    }
    keptMarkdown = `> … (${lines.length - tail.length} earlier steps)\n${tail.join('\n')}`
  }
  while (
    keptEvents.length > 1 &&
    Buffer.byteLength(JSON.stringify({ work_trail: keptMarkdown, trail_events: keptEvents }), 'utf8') >
      maxTrailBytes
  ) {
    keptEvents = keptEvents.slice(Math.ceil(keptEvents.length / 3))
  }
  return { events: keptEvents, markdown: keptMarkdown }
}

export async function runDevspecToolInput(raw = '', options = {}) {
  let parsed = {}
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw || {}
  } catch {
    return null
  }
  const out = prepareDevspecToolInput(parsed, options)
  if (out && Object.keys(out).length > 0) return out

  const prov = await handlePre(parsed, options)
  if (prov?.hookSpecificOutput?.permissionDecision === 'deny') {
    return {
      decision: 'deny',
      reason: prov.hookSpecificOutput.permissionDecisionReason,
      ...prov,
    }
  }

  const effectiveInput = prov?.hookSpecificOutput?.updatedInput
    ? { ...parsed, tool_input: prov.hookSpecificOutput.updatedInput }
    : parsed
  handleBashPre(effectiveInput, options)

  if (prov?.hookSpecificOutput?.updatedInput) {
    return {
      decision: 'allow',
      overwrite: prov.hookSpecificOutput.updatedInput,
      ...prov,
    }
  }
  return prov || null
}

export function toProtoPreToolResult(out) {
  if (!out || typeof out !== 'object') return {}
  const decision =
    typeof out.decision === 'string' && out.decision
      ? out.decision
      : typeof out.hookSpecificOutput?.permissionDecision === 'string' && out.hookSpecificOutput.permissionDecision
        ? out.hookSpecificOutput.permissionDecision
        : null
  const overwrite =
    out.overwrite && typeof out.overwrite === 'object' && !Array.isArray(out.overwrite)
      ? out.overwrite
      : out.hookSpecificOutput?.updatedInput && typeof out.hookSpecificOutput.updatedInput === 'object'
        ? out.hookSpecificOutput.updatedInput
        : null
  if (!decision && !overwrite) return {}
  const proto = {
    decision: decision || 'allow',
  }
  const reason =
    typeof out.reason === 'string' && out.reason
      ? out.reason
      : typeof out.hookSpecificOutput?.permissionDecisionReason === 'string' &&
          out.hookSpecificOutput.permissionDecisionReason
        ? out.hookSpecificOutput.permissionDecisionReason
        : null
  if (reason) proto.reason = reason
  if (Array.isArray(out.permissionOverrides) && out.permissionOverrides.length > 0) {
    proto.permissionOverrides = out.permissionOverrides
  }
  if (overwrite) proto.overwrite = overwrite
  return proto
}

let isMain = false
try {
  isMain = Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
} catch {
  /* imported */
}
if (isMain) {
  ;(async () => {
    try {
      const raw = fs.readFileSync(0, 'utf8')
      const out = await runDevspecToolInput(raw)
      const proto = toProtoPreToolResult(out)
      if (proto && proto.decision) {
        process.stdout.write(JSON.stringify(proto) + '\n')
      }
    } catch {
      /* fail open on hook error: empty stdout allows normal execution */
    }
  })()
}
