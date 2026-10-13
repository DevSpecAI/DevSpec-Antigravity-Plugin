#!/usr/bin/env node
/**
 * Antigravity SessionStart hook for DevSpec.
 *
 * 1. Reaps provably-dead pollers from exited Antigravity processes.
 * 2. Resolves `conversationId` and `transcriptPath` from Antigravity hook stdin.
 * 3. Supports startup auto-connect (`connectAtStartupEnabled` / `autoConnectAtStartup`)
 *    when `DEVSPEC_CONNECT_AT_STARTUP=1` or `.devspec/project.json` sets `connect_at_startup: true`.
 * 4. Ensures the bound connection's poller is running and syncs `transcript_path`.
 * 5. Injects compact connection orientation + cached instruction tiers (`storeTiers` / `takeTiersFor`)
 *    into `hookSpecificOutput.additionalContext`.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { AGENT_NAME } from './agent-identity.mjs'
import { LOADED_PLUGIN_VERSION } from './connection-version.mjs'
import {
  formatTiersForStartup,
  storeTiers,
  takeTiersFor,
} from './instruction-tiers.mjs'
import { hostTokenFromEnv, resolveDevspecMcpAuth } from './resolve-mcp-auth.mjs'
import {
  ensurePollerForConnection,
  reapDeadPollers,
  rebondConnectionToConversation,
  resolveOwnerPid,
  writeLocalBond,
  writeStateFile,
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

/**
 * Determine whether startup auto-connect is enabled via environment or `.devspec/project.json`.
 */
export function connectAtStartupEnabled(env = process.env, { cwd = process.cwd() } = {}) {
  const rawEnv = String(
    env?.DEVSPEC_CONNECT_AT_STARTUP ?? env?.DEVSPEC_AUTO_CONNECT ?? '',
  )
    .trim()
    .toLowerCase()
  if (rawEnv === '1' || rawEnv === 'true' || rawEnv === 'yes') return true
  if (rawEnv === '0' || rawEnv === 'false' || rawEnv === 'no') return false

  try {
    const pinPath = path.join(cwd, '.devspec', 'project.json')
    if (fs.existsSync(pinPath)) {
      const pin = JSON.parse(fs.readFileSync(pinPath, 'utf8'))
      if (pin?.connect_at_startup === true || pin?.auto_connect === true) return true
    }
  } catch {
    /* ignore */
  }
  return false
}

/**
 * Default JSON-RPC caller for `register_connection` during startup auto-connect.
 */
async function defaultCallMcp({ mcpUrl, token, name, arguments: args }) {
  const res = await fetch(mcpUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const text = await res.text()
  const json = JSON.parse(text)
  const rawText = json?.result?.content?.[0]?.text
  return rawText ? JSON.parse(rawText) : json?.result || {}
}

/**
 * Register a sessionless Antigravity connection at startup, cache instruction tiers,
 * persist connection state, and start the poller.
 */
export async function autoConnectAtStartup({
  cwd = process.cwd(),
  conversationId = null,
  transcriptPath = null,
  env = process.env,
  callMcp = defaultCallMcp,
  writeStateFn = writeStateFile,
  writeBondFn = writeLocalBond,
  ensurePollerFn = ensurePollerForConnection,
  home = undefined,
} = {}) {
  const auth = resolveDevspecMcpAuth(cwd, { hostToken: hostTokenFromEnv(env) })
  if (!auth?.token) return null
  const mcpUrl = auth.mcp_url || 'https://api.devspec.ai/api/mcp'
  const ownerPid = resolveOwnerPid('auto', null)
  const agentVersion = LOADED_PLUGIN_VERSION
  const reg = await callMcp({
    mcpUrl,
    token: auth.token,
    name: 'register_connection',
    arguments: {
      agent_name: AGENT_NAME,
      agent_version: agentVersion,
      local_id: conversationId || undefined,
      cwd,
      machine_label: os.hostname(),
      capabilities: {
        can_execute: true,
        can_edit_files: true,
        can_run_commands: true,
        supports_mcp: true,
        supports_trail: true,
      },
    },
  })
  const connectionId = reg?.connection_id || reg?.connection?.id || null
  if (!connectionId) return null

  if (reg?.instructions) {
    storeTiers(connectionId, reg.instructions, home ? { home } : {})
  }

  const statePayload = {
    enabled: true,
    connection_id: connectionId,
    session_id: reg?.session_id || null,
    session_codename: reg?.codename || reg?.connection?.codename || null,
    agent_name: AGENT_NAME,
    agent_version: agentVersion,
    local_id: conversationId || null,
    transcript_path: transcriptPath || null,
    cwd,
    owner_pid: ownerPid || null,
    token: auth.token,
    mcp_url: mcpUrl,
    auth_ok: true,
    ...(typeof reg?.connection_capability === 'string' && reg.connection_capability
      ? {
          connection_capability: reg.connection_capability,
          connection_capability_version: reg.connection_capability_version || 1,
        }
      : {}),
    updated_at: new Date().toISOString(),
  }
  writeStateFn(connectionId, statePayload)
  if (conversationId) {
    writeBondFn(AGENT_NAME, conversationId, {
      connection_id: connectionId,
      session_id: statePayload.session_id,
      enabled: true,
    })
  }
  try {
    ensurePollerFn(connectionId, {
      cwd,
      ownerPid,
      sessionId: statePayload.session_id,
      reuseRunning: true,
    })
  } catch {
    /* non-fatal */
  }
  return statePayload
}

export async function runSessionStart(
  raw = '',
  {
    env = process.env,
    cwd = process.cwd(),
    callMcp = defaultCallMcp,
    loadStateFn = loadState,
    writeStateFn = writeStateFile,
    writeBondFn = writeLocalBond,
    ensurePollerFn = ensurePollerForConnection,
    reapPollersFn = reapDeadPollers,
    home = undefined,
  } = {},
) {
  try {
    reapPollersFn({ agent: AGENT_NAME })
  } catch {
    /* non-fatal */
  }

  const conversationId = resolveHookConversationId(raw, env)
  const transcriptPath = parseTranscriptPath(raw)
  let state = loadStateFn(conversationId)

  if (!state?.connection_id && connectAtStartupEnabled(env, { cwd })) {
    try {
      state = await autoConnectAtStartup({
        cwd,
        conversationId,
        transcriptPath,
        env,
        callMcp,
        writeStateFn,
        writeBondFn,
        ensurePollerFn,
        home,
      })
    } catch {
      /* non-fatal */
    }
  }

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
    if (loadStateFn === loadState) {
      rebondConnectionToConversation({
        agent: AGENT_NAME,
        connectionId: state.connection_id,
        localId: conversationId,
        transcriptPath,
      })
    }
  } else if (loadStateFn === loadState) {
    syncStateTranscriptPath(state, transcriptPath, conversationId)
  }

  if (state.auth_ok !== false && state.token) {
    try {
      ensurePollerFn(state.connection_id, {
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

  const cachedTiers = takeTiersFor(state.connection_id, {
    ...(home ? { home } : {}),
    consume: true,
  })
  const tierContext = formatTiersForStartup(cachedTiers)
  const additionalContext = tierContext
    ? `${parts.join(' | ')}\n\n${tierContext}`
    : parts.join(' | ')

  return {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext,
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
