#!/usr/bin/env node
/**
 * Antigravity PostToolUse dispatcher (`scripts/post-tool-dispatch.mjs`).
 *
 * Routes PostToolUse events by `tool_name` in-process:
 * 1. `mcp_devspec_post_session_message` → marks explicit reply (`explicitReplyMarkerPath`)
 * 2. `invoke_subagent`, `run_command`, `schedule` → records background work launches
 *    against both the open turn (`recordBackgroundLaunch` in `mirror-turn.mjs`) and
 *    the request chain (`<connectionId>.requests.jsonl` via `requests.mjs`).
 * 3. Emits mid-turn room unread awareness (`postToolNotice` in `room-unread.mjs`)
 *    when unpresented room messages arrived during tool execution.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { handleBashPost } from './commit-observation.mjs'
import { handlePost, stagePendingNudge } from './commit-provenance.mjs'
import { resolveOwnConnectionId } from './launch-guard.mjs'
import {
  currentTurnNoticeIds,
  explicitReplyMarkerPath,
  isNoticeReplyToolCall,
  isRemotePlumbingToolCall,
  isSessionReplyToolCall,
  loadState,
  parseTranscriptPath,
  readTurnMarker,
  recordBackgroundLaunch,
  resolveHookConversationId,
  streamTurnTrailIfChanged,
  syncStateTranscriptPath,
  writeTurnMarker,
} from './mirror-turn.mjs'
import { checkPinAfterTool } from './pin-check.mjs'
import { checkRepoLinkAfterTool } from './repo-link-nudge.mjs'
import {
  appendRequestEvent,
  launchForRequest,
  readRequestState,
  requestForLaunch,
} from './requests.mjs'
import { postToolNotice } from './room-unread.mjs'

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

export async function runPostToolDispatch(raw = '', { env = process.env, home = os.homedir(), call } = {}) {
  let payload = {}
  try {
    payload = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw || {}
  } catch {
    return null
  }

  const toolName = String(
    payload.tool_name || payload.toolName || payload.toolCall?.name || '',
  )
  const toolInput =
    payload.tool_input ?? payload.toolInput ?? payload.toolCall?.args ?? {}
  const toolResponse =
    payload.tool_response ?? payload.toolResponse ?? payload.result
  const conversationId = resolveHookConversationId(raw, env)
  const connectionsDir = path.join(home, '.devspec', 'remote-control', 'connections')
  const state = loadState(conversationId, {
    connectionsDir,
    legacyPath: path.join(home, '.devspec', 'remote-control.json'),
  })
  if (state) {
    syncStateTranscriptPath(state, parseTranscriptPath(raw), conversationId, {
      connectionsDir,
      env,
    })
  }
  const connectionId = state?.connection_id || resolveOwnConnectionId(conversationId, { home })
  const notices = []

  // 0. Commit provenance claim/release tracking & unclaimed edit nudge staging
  try {
    handlePost(payload, { env })
  } catch {
    /* non-fatal */
  }

  // 0b. Folder pin check (.devspec/project.json)
  try {
    const pinOut = checkPinAfterTool(payload)
    if (pinOut?.hookSpecificOutput?.additionalContext) {
      notices.push(pinOut.hookSpecificOutput.additionalContext)
    }
  } catch {
    /* non-fatal */
  }

  // 1. Explicit reply marker when the agent calls post_session_message (non-trail),
  //    or refresh/re-assert .turn on non-plumbing work tools and stream live mid-turn
  //    progress trail (`phase: 'trail'`) when attached to a session.
  const now = Date.now()
  // A reply to DevSpec notices is not the turn's reply (notice-reply.mjs): marking it
  // as one would stop a command being worked from getting its own answer at Stop.
  const noticeReply =
    connectionId &&
    isNoticeReplyToolCall(toolName, toolInput, {
      turnNotices: currentTurnNoticeIds(connectionId, { dir: connectionsDir, connectionState: state }),
    })
  if (connectionId && !noticeReply && isSessionReplyToolCall(toolName, toolInput)) {
    try {
      const p = explicitReplyMarkerPath(connectionId, connectionsDir)
      fs.writeFileSync(p, JSON.stringify({ at: now }), { mode: 0o600 })
      const existingMarker = readTurnMarker(connectionId, connectionsDir)
      if (existingMarker) {
        writeTurnMarker(
          connectionId,
          { lastReplyAt: now, preserveExplicitReply: true },
          connectionsDir,
        )
      }
    } catch {
      /* ignore */
    }
  } else if (connectionId && !isRemotePlumbingToolCall(toolName, toolInput)) {
    try {
      const existingMarker = readTurnMarker(connectionId, connectionsDir)
      writeTurnMarker(
        connectionId,
        {
          ...(existingMarker ? {} : { remoteTurn: Boolean(state?.session_id) }),
          lastToolAt: now,
          preserveExplicitReply: true,
        },
        connectionsDir,
      )
    } catch {
      /* ignore */
    }
    if (state?.session_id) {
      try {
        await streamTurnTrailIfChanged(state, {
          connectionsDir,
          home,
          now,
          ...(call ? { call } : {}),
        })
      } catch {
        /* non-fatal */
      }
    }
  }

  // 2. Record background subagent / command / schedule launches & git commit observations
  const bareToolName = toolName.replace(/^default_api:/, '')
  if (bareToolName === 'run_command' || bareToolName === 'Bash') {
    try {
      await handleBashPost(payload, { env, ...(call ? { call } : {}) })
    } catch {
      /* non-fatal */
    }
    try {
      const repoNudge = await checkRepoLinkAfterTool(payload, { env, ...(call ? { call } : {}) })
      if (repoNudge?.hookSpecificOutput?.additionalContext) {
        notices.push(repoNudge.hookSpecificOutput.additionalContext)
      }
    } catch {
      /* non-fatal */
    }
  }

  if (
    bareToolName === 'invoke_subagent' ||
    bareToolName === 'run_command' ||
    bareToolName === 'schedule' ||
    bareToolName === 'Bash' ||
    bareToolName === 'Agent'
  ) {
    try {
      recordBackgroundLaunch(typeof raw === 'string' ? raw : JSON.stringify(payload))
    } catch {
      /* non-fatal */
    }
    if (connectionId) {
      try {
        const dir = path.join(home, '.devspec', 'remote-control', 'connections')
        const reqState = readRequestState(connectionId, { dir })
        const launch = launchForRequest(
          bareToolName,
          toolInput,
          toolResponse,
          payload.tool_use_id ?? payload.toolUseId
        )
        if (launch) {
          const { request, also } = requestForLaunch(reqState, payload.agent_id)
          if (launch.schedule) {
            appendRequestEvent(
              connectionId,
              { op: 'schedule', prompt: launch.prompt, id: launch.id, request, also },
              { dir }
            )
          } else {
            appendRequestEvent(
              connectionId,
              {
                op: 'launch',
                key: launch.key,
                ...(launch.alias ? { alias: launch.alias } : {}),
                kind: launch.kind,
                notifies: launch.notifies,
                request,
                also,
              },
              { dir }
            )
          }
        }
      } catch {
        /* non-fatal */
      }
    }
  }

  // 3. Room unread post-tool notice
  const unreadRaw = postToolNotice({ input: payload, env, home })
  if (unreadRaw) {
    try {
      const parsed = JSON.parse(unreadRaw)
      if (parsed?.hookSpecificOutput?.additionalContext) {
        notices.push(parsed.hookSpecificOutput.additionalContext)
      }
    } catch {
      /* ignore */
    }
  }

  if (notices.length > 0) {
    const joined = notices.join('\n\n')
    if (conversationId) {
      stagePendingNudge(conversationId, joined, { env })
    }
    return {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: joined,
      },
    }
  }

  return null
}

/**
 * Antigravity PostToolHookResult expects `{}` (or `{ overwriteResult }`).
 * Post-tool notices are staged via `stagePendingNudge` and injected on `PostInvocation`.
 */
export function toProtoPostToolResult() {
  return {}
}

async function main() {
  const raw = readStdin()
  await runPostToolDispatch(raw)
  process.stdout.write(JSON.stringify(toProtoPostToolResult()) + '\n')
  process.exit(0)
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) main()
