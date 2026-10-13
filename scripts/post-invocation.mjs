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
  if (notice) return notice
  return null
}

async function main() {
  const raw = readStdin()
  const out = await runPostInvocation(raw)
  if (out) {
    process.stdout.write(JSON.stringify(out) + '\n')
  }
  process.exit(0)
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) main()
