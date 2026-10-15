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
import { fileURLToPath, pathToFileURL } from 'node:url'
import { AGENT_NAME } from './agent-identity.mjs'
import { LOADED_PLUGIN_VERSION } from './connection-version.mjs'
import { findProjectPin, gitRemoteOrigin } from './devspec-scope.mjs'
import {
  formatTiersForStartup,
  storeTiers,
  takeTiersFor,
} from './instruction-tiers.mjs'
import { storeRepositoryContext } from './repository-context.mjs'
import { mcpToolsCall } from './mcp-call.mjs'
import {
  DEFAULT_PROD_URL,
  formatMissingAuthMessage,
  hostTokenFromEnv,
  resolveDevspecMcpAuth,
  verifyAndPinDevspecAuth,
} from './resolve-mcp-auth.mjs'
import {
  discoverAntigravityLsAddress,
  ensureListenerForConnection,
  ensurePollerForConnection,
  inferAntigravityTranscriptPath,
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

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

/**
 * Extract the active workspace path from Antigravity hook stdin JSON.
 * Antigravity executes hook commands with `process.cwd()` set to the plugin directory,
 * passing the user's active workspace in `workspacePaths: ["/path/to/workspace"]`.
 */
export function parseHookCwd(hookInput, fallbackCwd = process.cwd()) {
  try {
    const parsed =
      typeof hookInput === 'string'
        ? JSON.parse(hookInput || '{}')
        : hookInput && typeof hookInput === 'object'
          ? hookInput
          : {}
    const ws = Array.isArray(parsed.workspacePaths)
      ? parsed.workspacePaths[0]
      : Array.isArray(parsed.workspace_paths)
        ? parsed.workspace_paths[0]
        : null
    if (typeof ws === 'string' && ws.trim()) return ws.trim()
    if (typeof parsed.cwd === 'string' && parsed.cwd.trim()) return parsed.cwd.trim()
  } catch {
    /* ignore */
  }
  return fallbackCwd
}

/**
 * Remove any leftover untracked placeholder `mcp_config.json` inside the plugin
 * directory so Antigravity does not hang trying to connect `antigravity-devspec-autopilot-extension_devspec`.
 */
export function cleanupLegacyPluginMcpConfig({ pluginRoot = PLUGIN_ROOT } = {}) {
  if (!pluginRoot) return { removed: false, reason: 'no_plugin_root' }
  const legacyMcpPath = path.join(pluginRoot, 'mcp_config.json')
  try {
    if (!fs.existsSync(legacyMcpPath)) return { removed: false, reason: 'not_present' }
    const raw = fs.readFileSync(legacyMcpPath, 'utf8')
    if (raw.includes('dvs_YOUR_DEVSPEC_MCP_TOKEN')) {
      fs.rmSync(legacyMcpPath, { force: true })
      return { removed: true, path: legacyMcpPath }
    }
    return { removed: false, reason: 'custom_config_kept' }
  } catch {
    return { removed: false, reason: 'error' }
  }
}

/**
 * Non-destructively configure `statusLine` in `~/.gemini/antigravity-cli/settings.json`
 * when no custom statusLine is set yet (with `stack_with_default: true`).
 */
export function ensureStatusLineConfigured({
  home = os.homedir(),
  pluginRoot = PLUGIN_ROOT,
} = {}) {
  if (!home) return { updated: false, reason: 'no_home' }
  const settingsPath = path.join(home, '.gemini', 'antigravity-cli', 'settings.json')
  const scriptPath = path.join(pluginRoot, 'scripts', 'statusline.mjs')
  const desiredCommand = `node "${scriptPath}"`

  let settings = {}
  try {
    if (fs.existsSync(settingsPath)) {
      const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        settings = parsed
      }
    }
  } catch {
    return { updated: false, reason: 'invalid_settings_json' }
  }

  const existing = settings.statusLine
  if (existing) {
    const existingCmd =
      typeof existing === 'string'
        ? existing.trim()
        : typeof existing?.command === 'string'
          ? existing.command.trim()
          : ''
    if (existingCmd) {
      const m = existingCmd.match(/["']([^"']*statusline\.mjs)["']/)
      if (!m) {
        return { updated: false, reason: 'already_configured', settingsPath }
      }
      if (fs.existsSync(m[1]) && typeof existing === 'object' && existing.stack_with_default === true) {
        return { updated: false, reason: 'already_configured', settingsPath }
      }
    }
  }

  settings.statusLine = {
    type: 'command',
    command: desiredCommand,
    stack_with_default: true,
  }
  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n')
    return { updated: true, settingsPath, command: desiredCommand }
  } catch {
    return { updated: false, reason: 'write_failed', settingsPath }
  }
}

/**
 * Determine whether startup auto-connect is enabled via environment, `.devspec/project.json`,
 * or the presence of a valid DevSpec MCP token (unless explicitly disabled).
 */
export function connectAtStartupEnabled(
  env = process.env,
  { cwd = process.cwd(), home = undefined } = {},
) {
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
      if (pin?.connect_at_startup === false || pin?.auto_connect === false) return false
      if (pin?.connect_at_startup === true || pin?.auto_connect === true) return true
    }
  } catch {
    /* ignore */
  }

  const effectiveHome = home || env?.HOME || os.homedir()
  const auth = resolveDevspecMcpAuth(cwd, {
    env,
    home: effectiveHome,
    hostToken: hostTokenFromEnv(env, { cwd, home: effectiveHome }),
  })
  return Boolean(auth?.ok && auth?.token)
}

/**
 * Default JSON-RPC caller for `register_connection` during startup auto-connect.
 * Uses `mcpToolsCall` so both JSON and SSE responses as well as `_meta.devspec.connection_capability`
 * are parsed properly.
 */
async function defaultCallMcp({ mcpUrl, token, name, arguments: args, connectionCapability = null }) {
  let capturedMeta = null
  const res = await mcpToolsCall({
    mcpUrl,
    token,
    name,
    arguments: args,
    connectionCapability,
    includeMeta: true,
    onResultMeta: (meta) => {
      capturedMeta = meta
    },
    timeoutMs: 15_000,
  })
  const data =
    res?.data && typeof res.data === 'object'
      ? { ...res.data }
      : res && typeof res === 'object'
        ? { ...res }
        : {}
  const cap = (capturedMeta || res?.meta)?.devspec?.connection_capability
  if (cap && typeof cap.value === 'string' && cap.value.startsWith('dvsc_')) {
    data.connection_capability = cap.value
    data.connection_capability_version = cap.version || 1
  }
  return data
}

/**
 * Register a sessionless Antigravity connection at startup, cache instruction tiers,
 * persist connection state, and start the poller.
 */
export async function autoConnectAtStartup({
  cwd = process.cwd(),
  conversationId = null,
  ownerPid: explicitOwnerPid = null,
  transcriptPath = null,
  env = process.env,
  callMcp = defaultCallMcp,
  writeStateFn = writeStateFile,
  writeBondFn = writeLocalBond,
  ensurePollerFn = ensurePollerForConnection,
  ensureListenerFn = ensureListenerForConnection,
  verifyAuthFn = verifyAndPinDevspecAuth,
  home = undefined,
} = {}) {
  const effectiveHome = home || env?.HOME || os.homedir()
  let auth = null
  if (verifyAuthFn !== verifyAndPinDevspecAuth) {
    try {
      auth = await verifyAuthFn(cwd, { env, home: effectiveHome })
    } catch {
      auth = null
    }
  }
  if (!auth?.token) {
    auth = resolveDevspecMcpAuth(cwd, {
      env,
      home: effectiveHome,
      hostToken: hostTokenFromEnv(env, { cwd, home: effectiveHome }),
    })
  }
  if (!auth?.token && callMcp === defaultCallMcp) {
    try {
      auth = await verifyAuthFn(cwd, { env, home: effectiveHome })
    } catch {
      auth = null
    }
  }
  if (!auth?.token) return null
  let mcpUrl = auth.mcp_url || DEFAULT_PROD_URL
  const ownerPid = resolveOwnerPid(explicitOwnerPid || 'auto', null)
  const windowStandbyLocalId =
    !conversationId && Number.isInteger(Number(ownerPid)) && Number(ownerPid) > 1
      ? `agy-window:${ownerPid}`
      : null
  const effectiveLocalId = conversationId || windowStandbyLocalId || null
  const agentVersion = LOADED_PLUGIN_VERSION
  const gitRemote = gitRemoteOrigin(cwd)
  const pinnedProjectId = findProjectPin(cwd, { home: effectiveHome })?.project_id || null
  const registerArgs = {
    agent_name: AGENT_NAME,
    agent_version: agentVersion,
    local_id: effectiveLocalId || undefined,
    cwd,
    ...(gitRemote ? { git_remote: gitRemote } : {}),
    ...(pinnedProjectId ? { pinned_project_id: pinnedProjectId } : {}),
    ...(!conversationId ? { folder_scope_only: true } : {}),
    machine_label: os.hostname(),
    connection_capability_version: 1,
    project_selection_version: 1,
    capabilities: {
      can_execute: true,
      can_edit_files: true,
      can_run_commands: true,
      supports_mcp: true,
      supports_trail: true,
    },
  }
  let reg = null
  try {
    reg = await callMcp({
      mcpUrl,
      token: auth.token,
      name: 'register_connection',
      arguments: registerArgs,
    })
  } catch (err) {
    if (callMcp === defaultCallMcp && verifyAuthFn === verifyAndPinDevspecAuth) {
      const fallbackAuth = await verifyAuthFn(cwd, { env, home: effectiveHome }).catch(() => null)
      if (fallbackAuth?.token && fallbackAuth.token !== auth.token) {
        auth = fallbackAuth
        mcpUrl = auth.mcp_url || DEFAULT_PROD_URL
        reg = await callMcp({
          mcpUrl,
          token: auth.token,
          name: 'register_connection',
          arguments: registerArgs,
        })
      } else {
        throw err
      }
    } else {
      throw err
    }
  }
  const connectionId = reg?.connection_id || reg?.connection?.id || null
  if (!connectionId) return null

  const connDir = path.join(effectiveHome, '.devspec', 'remote-control', 'connections')
  storeTiers(connectionId, reg, { home: effectiveHome, dir: connDir })
  storeRepositoryContext(connectionId, reg, { dir: connDir })

  const resolvedProjectId =
    reg?.project_id || reg?.connection?.project_id || pinnedProjectId || null
  const resolvedProjectName =
    reg?.project_selection?.project?.name || reg?.project_name || null
  const resolvedTranscriptPath =
    transcriptPath || inferAntigravityTranscriptPath(conversationId, env) || null
  const discoveredLsAddress =
    env.ANTIGRAVITY_LS_ADDRESS || discoverAntigravityLsAddress(ownerPid, env) || null

  const statePayload = {
    enabled: true,
    connection_id: connectionId,
    session_id: reg?.session_id || null,
    session_codename: reg?.codename || reg?.connection?.codename || null,
    project_id: resolvedProjectId,
    ...(resolvedProjectName ? { project_name: resolvedProjectName } : {}),
    ...(reg?.project_selection ? { project_selection: reg.project_selection } : {}),
    ...(typeof reg?.created === 'boolean' ? { created_by_session_start: reg.created } : {}),
    agent_name: AGENT_NAME,
    agent_version: agentVersion,
    local_id: conversationId || null,
    ...(windowStandbyLocalId ? { pending_local_id: windowStandbyLocalId } : {}),
    transcript_path: resolvedTranscriptPath,
    cwd,
    ...(gitRemote ? { git_remote: gitRemote } : {}),
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
    ...(reg?.instruction_tiers_version && reg?.instruction_tiers_hash
      ? {
          instruction_tiers_version: reg.instruction_tiers_version,
          instruction_tiers_hash: reg.instruction_tiers_hash,
        }
      : {}),
    ...(discoveredLsAddress ? { ls_address: discoveredLsAddress } : {}),
    ...(env.ANTIGRAVITY_CSRF_TOKEN ? { csrf_token: env.ANTIGRAVITY_CSRF_TOKEN } : {}),
    ...(env.ANTIGRAVITY_AGENTAPI_EXE ? { agentapi_exe: env.ANTIGRAVITY_AGENTAPI_EXE } : {}),
    updated_at: new Date().toISOString(),
  }
  writeStateFn(connectionId, statePayload)
  if (conversationId) {
    writeBondFn(AGENT_NAME, conversationId, {
      status: 'live',
      connection_id: connectionId,
      session_id: statePayload.session_id,
      session_codename: statePayload.session_codename,
      cwd,
      transcript_path: resolvedTranscriptPath,
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
  if (ensureListenerFn !== ensureListenerForConnection || ensurePollerFn === ensurePollerForConnection) {
    try {
      ensureListenerFn(connectionId, {
        cwd,
        ownerPid,
        conversationId,
        reuseRunning: true,
        connDir,
        env,
      })
    } catch {
      /* non-fatal */
    }
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
    verifyAuthFn = verifyAndPinDevspecAuth,
    home = undefined,
  } = {},
) {
  const effectiveHome = home || env?.HOME || os.homedir()
  const effectiveCwd = parseHookCwd(raw, cwd)
  try {
    cleanupLegacyPluginMcpConfig()
  } catch {
    /* non-fatal */
  }
  try {
    ensureStatusLineConfigured({ home: effectiveHome })
  } catch {
    /* non-fatal */
  }

  try {
    reapPollersFn({ agent: AGENT_NAME })
  } catch {
    /* non-fatal */
  }

  const conversationId = resolveHookConversationId(raw, env)
  const transcriptPath = parseTranscriptPath(raw)
  let state = loadStateFn(conversationId)

  const auth = resolveDevspecMcpAuth(effectiveCwd, {
    env,
    home: effectiveHome,
    hostToken: hostTokenFromEnv(env, { cwd: effectiveCwd, home: effectiveHome }),
  })

  if (!state?.connection_id && connectAtStartupEnabled(env, { cwd: effectiveCwd, home: effectiveHome })) {
    try {
      state = await autoConnectAtStartup({
        cwd: effectiveCwd,
        conversationId,
        transcriptPath,
        env,
        callMcp,
        writeStateFn,
        writeBondFn,
        ensurePollerFn,
        verifyAuthFn,
        home: effectiveHome,
      })
    } catch {
      /* non-fatal */
    }
  }

  if (!state?.connection_id) {
    if (!auth?.ok || !auth?.token) {
      const missingAuthContext = `${auth?.error || formatMissingAuthMessage()}\nIf the user asks about DevSpec or remote control, report this message verbatim and do not guess or search for tokens across unrelated files.`
      return {
        injectSteps: [
          {
            systemMessage: {
              systemMessage: missingAuthContext,
            },
          },
        ],
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: missingAuthContext,
        },
      }
    }
    return null
  }

  // If the single live connection for this agent has a different or missing local_id,
  // rebond it to this conversation when it belongs to the same Antigravity owner process,
  // and upgrade any pre-conversation window standby bond (`agy-window:<pid>`) in place on the server.
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
        env,
      })
    }
    if (
      typeof state.connection_capability === 'string' &&
      state.connection_capability.startsWith('dvsc_') &&
      state.token &&
      state.mcp_url
    ) {
      try {
        const upgraded = await callMcp({
          mcpUrl: state.mcp_url,
          token: state.token,
          name: 'register_connection',
          connectionCapability: state.connection_capability,
          arguments: {
            agent_name: AGENT_NAME,
            agent_version: LOADED_PLUGIN_VERSION,
            local_id: conversationId,
            cwd: state.cwd || effectiveCwd,
            ...(state.project_id ? { project_id: state.project_id } : {}),
            ...(state.git_remote ? { git_remote: state.git_remote } : {}),
            machine_hostname: os.hostname(),
            connection_capability_version: 1,
            project_selection_version: 1,
            ...(state.instruction_tiers_version && state.instruction_tiers_hash
              ? {
                  known_instruction_tiers_version: state.instruction_tiers_version,
                  known_instruction_tiers_hash: state.instruction_tiers_hash,
                }
              : {}),
          },
        })
        if (upgraded?.connection_capability) {
          state.connection_capability = upgraded.connection_capability
          state.connection_capability_version = upgraded.connection_capability_version || 1
        }
      } catch {
        /* non-fatal — devspec-remote-connect.mjs can still upgrade if called later */
      }
    }
    state.local_id = conversationId
    delete state.pending_local_id
    if (env.ANTIGRAVITY_LS_ADDRESS) state.ls_address = env.ANTIGRAVITY_LS_ADDRESS
    if (env.ANTIGRAVITY_CSRF_TOKEN) state.csrf_token = env.ANTIGRAVITY_CSRF_TOKEN
    if (env.ANTIGRAVITY_AGENTAPI_EXE) state.agentapi_exe = env.ANTIGRAVITY_AGENTAPI_EXE
    state.updated_at = new Date().toISOString()
    writeStateFn(state.connection_id, state)
    writeBondFn(AGENT_NAME, conversationId, {
      status: 'live',
      connection_id: state.connection_id,
      session_id: state.session_id || null,
      session_codename: state.session_codename || null,
      cwd: state.cwd || effectiveCwd,
      transcript_path:
        transcriptPath || state.transcript_path || inferAntigravityTranscriptPath(conversationId, env) || null,
      enabled: true,
    })
  } else if (loadStateFn === loadState) {
    syncStateTranscriptPath(state, transcriptPath, conversationId, { env })
  }

  if (state.auth_ok !== false && state.token) {
    try {
      ensurePollerFn(state.connection_id, {
        cwd: state.cwd || effectiveCwd,
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
    state.project_id ? `project_id=${state.project_id}` : '',
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
    injectSteps: [
      {
        systemMessage: {
          systemMessage: additionalContext,
        },
      },
    ],
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext,
    },
  }
}

/**
 * Convert an internal SessionStart hook result to strict Antigravity protojson
 * (`SessionStartHookResult` accepts only `injectSteps`).
 */
export function toProtoSessionStartResult(out) {
  if (!out || typeof out !== 'object' || !Array.isArray(out.injectSteps) || out.injectSteps.length === 0) {
    return {}
  }
  return { injectSteps: out.injectSteps }
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--auto-connect')) {
    let cwdArg = process.cwd()
    let ownerPidArg = null
    let convArg = null
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === '--cwd' && argv[i + 1]) cwdArg = argv[++i]
      else if (argv[i] === '--owner-pid' && argv[i + 1]) ownerPidArg = argv[++i]
      else if (argv[i] === '--conversation-id' && argv[i + 1]) convArg = argv[++i]
    }
    try {
      cleanupLegacyPluginMcpConfig()
      ensureStatusLineConfigured()
      await autoConnectAtStartup({
        cwd: cwdArg,
        ownerPid: ownerPidArg,
        conversationId: convArg,
      })
    } catch {
      /* non-fatal */
    }
    process.exit(0)
  }
  const raw = readStdin()
  const out = await runSessionStart(raw)
  process.stdout.write(JSON.stringify(toProtoSessionStartResult(out)) + '\n')
  process.exit(0)
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) main()
