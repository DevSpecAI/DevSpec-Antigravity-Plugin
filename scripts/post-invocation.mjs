#!/usr/bin/env node
/**
 * Antigravity PostInvocation hook for DevSpec.
 *
 * Runs after each LLM step in Antigravity. Keeps `transcript_path` and `local_id`
 * synchronized on the bound connection state and provides the hook surface for
 * post-invocation room unread awareness.
 */

import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
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

export async function runPostInvocation(raw = '', { env = process.env } = {}) {
  const conversationId = resolveHookConversationId(raw, env)
  const state = loadState(conversationId)
  if (!state) return null
  const transcriptPath = parseTranscriptPath(raw)
  syncStateTranscriptPath(state, transcriptPath, conversationId)
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
