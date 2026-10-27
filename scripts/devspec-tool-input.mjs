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
 * 5. Makes a `post_session_message` that replies to DevSpec notices a notice reply
 *    (`system_notice_ids`, notice-reply.mjs): the model's ids as an array, or the
 *    turn's own notices when every wake of the turn was a notice; no trail and no
 *    local-turn flags on it, and it never counts as the reply to a command.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AGENT_NAME } from './agent-identity.mjs'
import { handleBashPre } from './commit-observation.mjs'
import { handlePre } from './commit-provenance.mjs'
import { prepareGitObservation } from './git-observer.mjs'
import { versionedConnectionArguments } from './connection-version.mjs'
import { launchGuard, resolveOwnConnectionId } from './launch-guard.mjs'
import {
  currentTurnNoticeIds,
  extractAntigravityTrailFromTranscript,
  parseTranscriptPath,
  readTurnMarker,
  recordNoticeReply,
  resolveHookConversationId,
  writeExplicitReplyMarker,
} from './mirror-turn.mjs'
import { normalizeNoticeIds, postCanTakeTurnNotices } from './notice-reply.mjs'
import { inferAntigravityTranscriptPath, readStateFile } from './remote-control-state.mjs'
import { PROVENANCE_REF_TOOLS, REQUEST_REF_TOOLS, stampRequest } from './request-ref.mjs'
import { readRequestState } from './requests.mjs'
import { prePostHoldObject } from './room-unread.mjs'
import { readConnectionTelemetry } from './statusline.mjs'
import { isEntryPoint } from './entry-point.mjs'

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
  // Set when this hook attaches the trail itself; a trail the model passed is never trimmed here.
  let trailAttached = false
  if (verb === 'post_session_message' && next.provenance_ref !== undefined) {
    delete next.provenance_ref
  }

  // A reply to DevSpec notices (notice-reply.mjs): the ids the model passed, as an
  // array whatever shape its host's tool schema gave them; or, in a turn every wake of
  // which was a notice, those notices' ids on a post that is aimed at nothing else.
  let noticeReply = false
  if (verb === 'post_session_message') {
    if (next.system_notice_ids !== undefined) {
      next.system_notice_ids = normalizeNoticeIds(next.system_notice_ids)
      noticeReply = true
    } else if (connectionId && postCanTakeTurnNotices(next)) {
      const turnNotices = currentTurnNoticeIds(connectionId, { dir: connDir, connectionState: connState })
      if (turnNotices) {
        next.system_notice_ids = turnNotices
        noticeReply = true
      }
    }
    // It goes into the room the connection is attached to, so it needs the
    // connection even when the model named a room.
    if (noticeReply && connectionId && next.connection_id === undefined) {
      next.connection_id = connectionId
    }
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
    (next.session_id === undefined ||
      REQUEST_REF_TOOLS.has(verb) ||
      PROVENANCE_REF_TOOLS.has(verb) ||
      verb === 'surface_session_tasks')
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

  // 8a. A reply to DevSpec notices is bound to no turn: it takes no trail and no
  //     local-turn flags (the server refuses both on it), and it is not the turn's
  //     reply, so a command being worked still gets its own answer. Only the host's
  //     telemetry rides along, as on every answer.
  if (verb === 'post_session_message' && noticeReply) {
    const targetConnId = next.connection_id || connectionId
    if (targetConnId) {
      recordNoticeReply(targetConnId, connDir)
      const telemetry = readConnectionTelemetry(targetConnId, { home })
      if (telemetry) {
        if (!next.agent_stats) next = { ...next, agent_stats: telemetry }
        if (telemetry.model?.id) {
          next = {
            ...next,
            model: { providerID: telemetry.model.provider || 'google', modelID: telemetry.model.id },
          }
        }
      }
    }
  }

  // 8. For explicit session replies (non-trail, non-needs_input, non-local_prompt):
  //    record the explicit reply marker, stamp local-turn unbound flags when answering
  //    a local terminal prompt, stamp live mechanical telemetry (`agent_stats` and
  //    `model`) so LLM-guessed model names never override the host-reported model,
  //    and automatically attach `work_trail` + `trail_events` from the current turn's
  //    Antigravity transcript if not already supplied.
  if (
    verb === 'post_session_message' &&
    !noticeReply &&
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
            next = { ...next, work_trail: markdown, trail_events: events }
            trailAttached = true
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

  const wrapArgs = (args) =>
    wrapped
      ? {
          ...rawToolInput,
          [argumentsKey || 'Arguments']: argumentsWasString ? JSON.stringify(args) : args,
        }
      : args
  if (trailAttached) next = fitTrailToHookLine(next, wrapArgs)
  const finalOverwrite = wrapArgs(next)

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
 * Antigravity reads each hook's stdout with Go's bufio.Scanner, whose default token
 * limit (bufio.MaxScanTokenSize) is 64 KiB: a longer line fails the hook ("token too
 * long") and the call goes out with nothing this hook stamped (item bbf7b679). The
 * trail attached to a session reply is the only part that grows without limit, so it
 * is the part that gives way, measured against the line actually written.
 */
export const HOOK_STDOUT_LIMIT_BYTES = 64 * 1024

function hookLineBytes(overwrite) {
  return Buffer.byteLength(`${JSON.stringify(toProtoPreToolResult({ decision: 'allow', overwrite }))}\n`, 'utf8')
}

/** The largest count in [0, total] that `fits`, given that fitting only gets easier as the count falls. */
function largestFitting(total, fits) {
  let low = 0
  let high = total
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (fits(mid)) low = mid
    else high = mid - 1
  }
  return low
}

/**
 * Fit an attached trail into the hook's one line, without cutting any single step.
 * Oldest events go first: the server merges trail events by seq and keeps the ones it
 * already holds for this turn (streamed while the turn ran), so leaving them out of
 * this reply loses nothing it has. Only if no event fits does the markdown give way,
 * from its oldest steps, with a note saying how many were left out; only if even one
 * line cannot fit is the trail left off this reply.
 */
export function fitTrailToHookLine(args, wrapArgs = (value) => value, limit = HOOK_STDOUT_LIMIT_BYTES) {
  const fits = (candidate) => hookLineBytes(wrapArgs(candidate)) < limit
  if (fits(args)) return args
  const events = Array.isArray(args.trail_events) ? args.trail_events : []
  const withEvents = (kept) => {
    const candidate = { ...args }
    if (kept > 0) candidate.trail_events = events.slice(events.length - kept)
    else delete candidate.trail_events
    return candidate
  }
  const keptEvents = largestFitting(events.length, (kept) => fits(withEvents(kept)))
  if (keptEvents > 0 || fits(withEvents(0))) return withEvents(keptEvents)

  const base = withEvents(0)
  const lines = String(args.work_trail || '').split('\n')
  const withLines = (kept) => {
    const candidate = { ...base }
    const left = lines.length - kept
    candidate.work_trail = [
      `> … ${left} earlier ${left === 1 ? 'step' : 'steps'} not shown here (Antigravity limits how much a hook can pass on; every step remains in the Antigravity conversation)`,
      ...lines.slice(left),
    ].join('\n')
    return candidate
  }
  const keptLines = largestFitting(lines.length - 1, (kept) => fits(withLines(kept)))
  if (keptLines > 0) return withLines(keptLines)
  const bare = { ...base }
  delete bare.work_trail
  return bare
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

  // The agent's commits are noted by the git stand-in on its shell PATH, whatever the
  // command looks like (git-observer.mjs). The older observation, which reads the
  // command text, runs only where the stand-in cannot: Windows, or a folder that
  // could not be set up.
  const rawArgs = parsed.tool_input ?? parsed.toolInput ?? parsed.toolCall?.args
  const effectiveArgs = prov?.hookSpecificOutput?.updatedInput ??
    (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : null)
  // The one command shape this hook allows itself: a commit whose message it stamped
  // with the task tag. Both branches below test exactly this, so the stand-in never
  // changes which commands are allowed (item 9e385793).
  const stampedCommit = Boolean(prov?.hookSpecificOutput?.updatedInput)
  const observed = effectiveArgs ? prepareGitObservation(parsed, { ...options, args: effectiveArgs }) : null
  if (observed) {
    const overwrite = { ...effectiveArgs, CommandLine: observed.command }
    // Antigravity applies `overwrite` only with a decision, and refuses the call when
    // there is none, so the stand-in line must carry one; it keeps the decision the
    // command had without it. A stamped commit stays `allow`: the line only routes
    // git through the stand-in, which runs the real git unchanged, so it adds no
    // capability, and an agent driven from DevSpec must not stall on a prompt at
    // commit time. Every other command had no decision, and `ask` is that: measured
    // with agy 1.4.8, the person's allow-rules and --dangerously-skip-permissions
    // still let a command run at once, and anything else still asks.
    const result = {
      ...(prov ?? {}),
      decision: stampedCommit ? 'allow' : 'ask',
      overwrite,
      hookSpecificOutput: { ...(prov?.hookSpecificOutput ?? {}), hookEventName: 'PreToolUse', updatedInput: overwrite },
    }
    // Antigravity drops a hook's whole answer past its line limit, and with it any
    // commit-message stamp above; then the command goes out as it was, unobserved.
    if (Buffer.byteLength(`${JSON.stringify(toProtoPreToolResult(result))}\n`, 'utf8') < HOOK_STDOUT_LIMIT_BYTES) {
      return result
    }
  }
  handleBashPre(effectiveInput, options)

  if (stampedCommit) {
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

const isMain = isEntryPoint(import.meta.url)
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
