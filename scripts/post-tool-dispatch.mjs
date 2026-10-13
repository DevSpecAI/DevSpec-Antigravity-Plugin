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
import { handlePost } from './commit-provenance.mjs'
import { resolveOwnConnectionId } from './launch-guard.mjs'
import {
  explicitReplyMarkerPath,
  loadState,
  parseTranscriptPath,
  recordBackgroundLaunch,
  resolveHookConversationId,
  syncStateTranscriptPath,
} from './mirror-turn.mjs'
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

  const toolName = String(payload.tool_name || payload.toolName || '')
  const conversationId = resolveHookConversationId(raw, env)
  const state = loadState(conversationId)
  if (state) {
    syncStateTranscriptPath(state, parseTranscriptPath(raw), conversationId)
  }
  const connectionId = state?.connection_id || resolveOwnConnectionId(conversationId, { home })

  // 0. Commit provenance claim/release tracking & unclaimed edit nudge staging
  try {
    handlePost(payload, { env })
  } catch {
    /* non-fatal */
  }

  // 1. Explicit reply marker when the agent calls post_session_message
  if (
    connectionId &&
    (toolName === 'mcp_devspec_post_session_message' ||
      toolName === 'mcp__devspec__post_session_message' ||
      toolName.endsWith(':post_session_message') ||
      toolName === 'post_session_message')
  ) {
    try {
      const p = explicitReplyMarkerPath(connectionId)
      fs.writeFileSync(p, JSON.stringify({ at: Date.now() }), { mode: 0o600 })
    } catch {
      /* ignore */
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
          payload.tool_input ?? payload.toolInput,
          payload.tool_response ?? payload.toolResponse,
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
      return JSON.parse(unreadRaw)
    } catch {
      return null
    }
  }

  return null
}

async function main() {
  const raw = readStdin()
  const out = await runPostToolDispatch(raw)
  if (out) {
    process.stdout.write(JSON.stringify(out) + '\n')
  }
  process.exit(0)
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) main()
