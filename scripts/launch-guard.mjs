#!/usr/bin/env node
/**
 * PreToolUse guard for background work (`run_command`, `invoke_subagent`, `schedule`,
 * `Bash`, `Agent`, `Monitor`, `Workflow`, `ScheduleWakeup`, `CronCreate`).
 *
 * When a turn carries multiple people's requests (or terminal + room requests)
 * and the agent has not run `devspec-serve-request.mjs` to name which request
 * its work serves, launching background work is refused with `decision: 'deny'`.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  readRequestState,
  servableCarried,
  startsBackgroundWork,
  turnAmbiguity,
  undecidedTurnMessage,
} from './requests.mjs'
import { resolveHookConversationId } from './mirror-turn.mjs'
import { readLocalBond, readStateFile } from './remote-control-state.mjs'

export function resolveOwnConnectionId(conversationId, { home = os.homedir() } = {}) {
  const dir = path.join(home, '.devspec', 'remote-control')
  if (conversationId) {
    const bond = readLocalBond(conversationId, dir)
    if (bond?.connection_id) {
      const st = readStateFile(bond.connection_id, path.join(dir, 'connections'))
      if (st && st.enabled !== false) return bond.connection_id
    }
  }
  const connDir = path.join(dir, 'connections')
  let files = []
  try {
    files = fs.readdirSync(connDir).filter((f) => /^[0-9a-f-]{36}\.json$/i.test(f))
  } catch {
    return null
  }
  const matches = []
  for (const f of files) {
    const st = readStateFile(f.slice(0, -5), connDir)
    if (!st || st.enabled === false) continue
    if (String(st.agent_name || '').toLowerCase() !== 'antigravity') continue
    if (conversationId && st.local_id === conversationId) {
      return st.connection_id
    }
    matches.push(st.connection_id)
  }
  return !conversationId && matches.length === 1 ? matches[0] : null
}

export function launchGuard(input, { home = os.homedir(), env = process.env } = {}) {
  const toolName = input?.tool_name ?? input?.toolName ?? input?.toolCall?.name ?? ''
  const toolInput = input?.tool_input ?? input?.toolInput ?? input?.toolCall?.args ?? {}
  if (!startsBackgroundWork(toolName, toolInput)) return {}
  const conversationId = resolveHookConversationId(input, env)
  const connectionId = resolveOwnConnectionId(conversationId, { home })
  if (!connectionId) return {}
  const dir = path.join(home, '.devspec', 'remote-control', 'connections')
  const agentId = typeof input?.agent_id === 'string' && input.agent_id ? input.agent_id : null
  const state = readRequestState(connectionId, { dir })
  const carried = turnAmbiguity(state, agentId)
  if (!carried) return {}
  const reason = undecidedTurnMessage(
    connectionId,
    servableCarried(state, carried),
    'whatever this background work does when it wakes you'
  )
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

let isMain = false
try {
  isMain = Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
} catch {
  /* imported */
}
if (isMain) {
  try {
    const out = launchGuard(JSON.parse(fs.readFileSync(0, 'utf8') || '{}'))
    process.stdout.write(JSON.stringify(out) + '\n')
  } catch {
    process.stdout.write('{}\n')
  }
}
