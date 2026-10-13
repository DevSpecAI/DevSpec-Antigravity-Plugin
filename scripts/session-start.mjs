#!/usr/bin/env node
/**
 * Antigravity SessionStart hook for DevSpec.
 *
 * 1. Reaps provably-dead pollers from exited Antigravity processes.
 * 2. Resolves `conversationId` and `transcriptPath` from Antigravity hook stdin.
 * 3. Ensures the bound connection's poller is running and syncs `transcript_path`.
 * 4. Injects compact connection orientation into `hookSpecificOutput.additionalContext`.
 */

import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import { AGENT_NAME } from './agent-identity.mjs'
import {
  ensurePollerForConnection,
  reapDeadPollers,
  rebondConnectionToConversation,
  resolveOwnerPid,
} from './remote-control-state.mjs'
import {
  loadState,
  parseTranscriptPath,
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

export async function runSessionStart(
  raw = '',
  { env = process.env, cwd = process.cwd() } = {},
) {
  try {
    reapDeadPollers({ agent: AGENT_NAME })
  } catch {
    /* non-fatal */
  }

  const conversationId = resolveHookConversationId(raw, env)
  const transcriptPath = parseTranscriptPath(raw)
  const state = loadState(conversationId)
  if (!state?.connection_id) {
    return null
  }

  // If the single live connection for this agent has a different or missing local_id,
  // rebond it to this conversation when it belongs to the same Antigravity owner process.
  const currentOwnerPid = resolveOwnerPid('auto', state.owner_pid)
  if (
    conversationId &&
    state.local_id !== conversationId &&
    (!state.owner_pid || !currentOwnerPid || Number(state.owner_pid) === Number(currentOwnerPid))
  ) {
    rebondConnectionToConversation({
      agent: AGENT_NAME,
      connectionId: state.connection_id,
      localId: conversationId,
      transcriptPath,
    })
  } else {
    syncStateTranscriptPath(state, transcriptPath, conversationId)
  }

  if (state.auth_ok !== false && state.token) {
    try {
      ensurePollerForConnection(state.connection_id, {
        cwd: state.cwd || cwd,
        ownerPid: state.owner_pid || currentOwnerPid,
        sessionId: state.session_id || null,
        reuseRunning: true,
      })
    } catch {
      /* non-fatal */
    }
  }

  const parts = [
    `DevSpec Remote Control active (${state.session_codename || state.connection_id.slice(0, 8)})`,
    `connection_id=${state.connection_id}`,
    state.session_id ? `session_id=${state.session_id}` : 'sessionless',
    conversationId ? `local_session_id=${conversationId}` : '',
  ].filter(Boolean)

  return {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: parts.join(' | '),
    },
  }
}

async function main() {
  const raw = readStdin()
  const out = await runSessionStart(raw)
  if (out) {
    process.stdout.write(JSON.stringify(out) + '\n')
  }
  process.exit(0)
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) main()
