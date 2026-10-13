#!/usr/bin/env node
/**
 * Antigravity PostToolUse dispatcher (`scripts/post-tool-dispatch.mjs`).
 *
 * Routes PostToolUse events by `tool_name` in-process:
 * 1. `mcp_devspec_post_session_message` → marks explicit reply (`mark-explicit-reply.mjs`)
 * 2. `mcp_devspec_*` plan tools → syncs shared session plan files (`session-plan-sync.mjs`)
 * 3. `invoke_subagent`, `run_command`, `schedule` → records background work launches
 *    against the open turn (`recordBackgroundLaunch` in `mirror-turn.mjs`)
 */

import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import {
  explicitReplyMarkerPath,
  loadState,
  parseTranscriptPath,
  recordBackgroundLaunch,
  resolveHookConversationId,
  syncStateTranscriptPath,
} from './mirror-turn.mjs'

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

export async function runPostToolDispatch(raw = '', { env = process.env } = {}) {
  let payload = {}
  try {
    payload = JSON.parse(raw || '{}')
  } catch {
    return null
  }

  const toolName = String(payload.tool_name || '')
  const conversationId = resolveHookConversationId(raw, env)
  const state = loadState(conversationId)
  if (state) {
    syncStateTranscriptPath(state, parseTranscriptPath(raw), conversationId)
  }

  // 1. Explicit reply marker when the agent calls post_session_message
  if (
    state?.connection_id &&
    (toolName === 'mcp_devspec_post_session_message' ||
      toolName === 'mcp__devspec__post_session_message' ||
      toolName.endsWith(':post_session_message') ||
      toolName === 'post_session_message')
  ) {
    try {
      const p = explicitReplyMarkerPath(state.connection_id)
      fs.writeFileSync(p, JSON.stringify({ at: Date.now() }), { mode: 0o600 })
    } catch {
      /* ignore */
    }
  }

  // 2. Record background subagent / command launches so Stop holds the turn open
  if (
    toolName === 'invoke_subagent' ||
    toolName === 'default_api:invoke_subagent' ||
    toolName === 'run_command' ||
    toolName === 'default_api:run_command' ||
    toolName === 'Bash' ||
    toolName === 'Agent'
  ) {
    try {
      recordBackgroundLaunch(raw)
    } catch {
      /* non-fatal */
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
