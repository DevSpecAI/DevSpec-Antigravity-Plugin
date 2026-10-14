#!/usr/bin/env node
/**
 * Antigravity PostInvocation hook for DevSpec.
 *
 * Runs after each LLM step in Antigravity:
 * 1. Keeps `transcript_path` and `local_id` synchronized on the bound connection state.
 * 2. Injects mid-turn room unread awareness (`injectSteps` + `additionalContext`)
 *    when unpresented room messages arrived during the step.
 */

import fs from 'node:fs'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { pendingNudgeNotice } from './commit-provenance.mjs'
import {
  loadState,
  parseTranscriptPath,
  resolveHookConversationId,
  syncStateTranscriptPath,
} from './mirror-turn.mjs'
import { invocationNotice } from './room-unread.mjs'

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

export async function runPostInvocation(raw = '', { env = process.env, home = os.homedir() } = {}) {
  let input = {}
  try {
    input = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw || {}
  } catch {
    input = {}
  }
  const conversationId = resolveHookConversationId(raw, env)
  const state = loadState(conversationId)
  if (state) {
    const transcriptPath = parseTranscriptPath(raw)
    syncStateTranscriptPath(state, transcriptPath, conversationId)
  }
  const notice = invocationNotice({ input, env, home })
  const nudge = pendingNudgeNotice({ input, env })
  if (notice && nudge) {
    const combined = `${notice.additionalContext}\n\n${nudge.additionalContext}`
    return {
      ...notice,
      injectSteps: [...(notice.injectSteps || []), ...(nudge.injectSteps || [])],
      additionalContext: combined,
      hookSpecificOutput: {
        ...notice.hookSpecificOutput,
        additionalContext: combined,
      },
    }
  }
  if (notice) return notice
  if (nudge) return nudge
  return null
}

export function toProtoPostInvocationResult(out) {
  if (!out || typeof out !== 'object' || !Array.isArray(out.injectSteps) || out.injectSteps.length === 0) {
    return {}
  }
  return {
    injectSteps: out.injectSteps,
    ...(typeof out.terminationBehavior === 'string' && out.terminationBehavior
      ? { terminationBehavior: out.terminationBehavior }
      : {}),
  }
}

async function main() {
  const raw = readStdin()
  const out = await runPostInvocation(raw)
  process.stdout.write(JSON.stringify(toProtoPostInvocationResult(out)) + '\n')
  process.exit(0)
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) main()
