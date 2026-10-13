#!/usr/bin/env node
/**
 * Antigravity PreInvocation hook for DevSpec.
 *
 * Runs before each LLM invocation in Antigravity:
 * 1. Triggers `handleMirrorTurn('user_prompt', raw)` to mirror new user prompts into
 *    the attached DevSpec room, write the `.turn` marker, and assert busy heartbeat.
 * 2. Syncs `conversationId` and `transcriptPath` onto the bound connection state.
 */

import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import { handleMirrorTurn } from './mirror-turn.mjs'

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

export async function runPreInvocation(raw = '', options = {}) {
  await handleMirrorTurn('user_prompt', raw, options)
  return null
}

async function main() {
  const raw = readStdin()
  const out = await runPreInvocation(raw)
  if (out) {
    process.stdout.write(JSON.stringify(out) + '\n')
  }
  process.exit(0)
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) main()
