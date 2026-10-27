#!/usr/bin/env node
/**
 * Antigravity statusLine renderer and runtime telemetry bridge (`scripts/statusline.mjs`).
 *
 * 1. Reads Antigravity `statusLine` JSON from stdin (`session_id` / `conversation_id`,
 *    `cwd` / `workspace`, `model`, `context_window`, `cost`).
 * 2. Records normalized `agent_stats` telemetry (`model`, `context`, `turn`, `session`)
 *    at `~/.devspec/remote-control/connections/<connectionId>.telemetry.json` so
 *    `heartbeat_connection` (and `devspec-remote-poll.mjs`) can report live model and
 *    context-window telemetry to DevSpec.
 * 3. Renders a single-line DevSpec status bar showing connection state/codename,
 *    pinned project, attached session title, active claimed work item, and context fill.
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AGENT_NAME } from './agent-identity.mjs'
import {
  backfillAutomationDetails,
  backfillClaimedItemDetails,
  canonicalRepo,
  readActiveAutomation,
  readClaimedWorkItems,
  readClaims,
  resolveLocalAutomationDetails,
  resolveLocalItemDetails,
} from './commit-provenance.mjs'
import { readConversationProject } from './conversation-project.mjs'
import { findProjectPin, gitRemoteOrigin } from './devspec-scope.mjs'
import { resolveOwnConnectionId } from './launch-guard.mjs'
import { mcpToolsCall } from './mcp-call.mjs'
import { resolveHookConversationId } from './mirror-turn.mjs'
import { ensurePrivateDir } from './private-state.mjs'
import { ownerAlive, resolveOwnerPid } from './remote-control-state.mjs'
import { DEFAULT_PROD_URL, resolveDevspecMcpAuth } from './resolve-mcp-auth.mjs'
import { connectAtStartupEnabled } from './session-start.mjs'
import { isEntryPoint } from './entry-point.mjs'

const REMOTE_DIR = '.devspec/remote-control'
const AGENT_DIR = AGENT_NAME.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SAFE_ID_RE = /^[a-zA-Z0-9._-]{1,128}$/
const EFFORT_LEVELS = ['low', 'medium', 'high', 'max']
const EFFORT_SUFFIX_RE = /^(.*?)\s*\((low|medium|high|xhigh|max)(?:\s+thinking)?\)\s*$/i
const PLACEHOLDER_MODEL_ID_RE = /^MODEL_PLACEHOLDER_/i
const DEFAULT_TELEMETRY_MAX_AGE_MS = 30 * 60 * 1000

export function splitModelEffortSuffix(text) {
  if (typeof text !== 'string') return { id: '', effort: null }
  const trimmed = text.trim()
  if (!trimmed) return { id: '', effort: null }
  const match = EFFORT_SUFFIX_RE.exec(trimmed)
  if (!match) return { id: trimmed, effort: null }
  const base = match[1].trim()
  const effort = match[2].toLowerCase()
  return { id: base || trimmed, effort }
}

export function bondPath(home, conversationId) {
  return path.join(home, REMOTE_DIR, 'local', AGENT_DIR, `${conversationId}.json`)
}

export function connectionStatePath(home, connectionId) {
  return path.join(home, REMOTE_DIR, 'connections', `${connectionId}.json`)
}

export function telemetryPath(home, connectionId) {
  return path.join(home, REMOTE_DIR, 'connections', `${connectionId}.telemetry.json`)
}

function parseJson(text) {
  if (typeof text !== 'string' || !text) return null
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

function count(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0
}

function dollars(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value * 1_000_000) / 1_000_000
    : 0
}

export function cleanLabel(text) {
  if (typeof text !== 'string') return ''
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim()
}

export function shortCode(id) {
  return typeof id === 'string' ? id.slice(0, 8).toLowerCase() : ''
}

export function isRealSessionTitle(title) {
  if (typeof title !== 'string') return false
  const trimmed = title.trim()
  return trimmed.length > 0 && trimmed !== 'New session'
}

export function inferModelProvider(modelId, explicitProvider) {
  if (typeof explicitProvider === 'string' && explicitProvider.trim()) {
    return explicitProvider.trim().toLowerCase()
  }
  const id = String(modelId || '').toLowerCase()
  if (id.startsWith('claude')) return 'anthropic'
  if (id.startsWith('gpt') || id.startsWith('o1') || id.startsWith('o3') || id.startsWith('o4')) return 'openai'
  return 'google'
}

export function contextFigures(cw) {
  if (!cw || typeof cw !== 'object') return null
  const rawWindow = cw.window ?? cw.context_window_size ?? cw.max_tokens
  const window = count(rawWindow) || null
  const usage = cw.current_usage && typeof cw.current_usage === 'object' ? cw.current_usage : null
  const usageTokens = usage
    ? count(usage.input_tokens) +
      count(usage.output_tokens) +
      count(usage.cache_read_input_tokens) +
      count(usage.cache_creation_input_tokens)
    : null
  const rawTokens =
    typeof cw.tokens === 'number' && Number.isFinite(cw.tokens) && cw.tokens >= 0
      ? Math.round(cw.tokens)
      : typeof cw.used_tokens === 'number' && Number.isFinite(cw.used_tokens) && cw.used_tokens >= 0
        ? Math.round(cw.used_tokens)
        : usageTokens !== null && usageTokens > 0
          ? usageTokens
          : null
  const rawPercent =
    typeof cw.percent === 'number' && Number.isFinite(cw.percent)
      ? cw.percent
      : typeof cw.used_percentage === 'number' && Number.isFinite(cw.used_percentage)
        ? cw.used_percentage
        : rawTokens !== null && window
          ? (rawTokens / window) * 100
          : null
  const percent =
    rawPercent !== null ? Math.max(0, Math.min(100, Math.round(rawPercent * 10) / 10)) : null
  const tokens =
    rawTokens !== null
      ? rawTokens
      : percent !== null && window
        ? Math.round((percent / 100) * window)
        : null
  if (window === null && tokens === null && percent === null) return null
  return { tokens, window, percent }
}

export function parseTelemetryRecord(text) {
  const value = parseJson(text)
  if (!value || value.v !== 1) return null
  const rawReport = value.report
  if (!rawReport || typeof rawReport !== 'object' || rawReport.v !== 1) return null
  let report = rawReport
  if (typeof rawReport.model?.id === 'string') {
    const { id: cleanId, effort: suffixEffort } = splitModelEffortSuffix(rawReport.model.id)
    if (cleanId && cleanId !== rawReport.model.id) {
      report = {
        ...rawReport,
        model: { ...rawReport.model, id: cleanId },
        thinkingLevel:
          rawReport.thinkingLevel ??
          (suffixEffort && EFFORT_LEVELS.includes(suffixEffort) ? suffixEffort : null),
      }
    }
  }
  return {
    conversationId: typeof value.conversation_id === 'string' ? value.conversation_id : null,
    report,
  }
}

function emptyUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 }
}

/**
 * Normalize an Antigravity `statusLine` stdin payload into a DevSpec `agent_stats` report.
 */
export function normalizeStatuslineTelemetryInput(
  input,
  { previous = null, conversationId = null, nowIso = new Date().toISOString() } = {},
) {
  if (!input || typeof input !== 'object') return null
  const before =
    previous && (!conversationId || !previous.conversationId || previous.conversationId === conversationId)
      ? previous.report
      : null

  const rawModel = input.model
  const candidateId =
    typeof rawModel === 'string'
      ? rawModel.trim()
      : typeof rawModel?.display_name === 'string' &&
          rawModel.display_name.trim() &&
          PLACEHOLDER_MODEL_ID_RE.test(String(rawModel?.id || rawModel?.model_id || '').trim())
        ? rawModel.display_name.trim()
        : typeof rawModel?.id === 'string' && rawModel.id.trim()
          ? rawModel.id.trim()
          : typeof rawModel?.model_id === 'string' && rawModel.model_id.trim()
            ? rawModel.model_id.trim()
            : typeof rawModel?.display_name === 'string'
              ? rawModel.display_name.trim()
              : ''
  const { id: modelIdStr, effort: suffixEffort } = splitModelEffortSuffix(candidateId)
  const providerStr = typeof rawModel === 'object' && rawModel ? rawModel.provider : input.provider
  const model = modelIdStr
    ? { provider: inferModelProvider(modelIdStr, providerStr), id: modelIdStr }
    : before?.model ?? null

  const rawEffort =
    input.thinking_level ??
    input.thinkingLevel ??
    input.effort ??
    rawModel?.effort ??
    suffixEffort ??
    null
  const thinkingLevel =
    typeof rawEffort === 'string' && EFFORT_LEVELS.includes(rawEffort.toLowerCase())
      ? rawEffort.toLowerCase()
      : before?.thinkingLevel ?? null
  const supportedThinkingLevels =
    thinkingLevel !== null ? [...EFFORT_LEVELS] : before?.supportedThinkingLevels ?? []

  const context = contextFigures(input.context_window ?? input.context) ?? before?.context ?? null
  if (!model && !context) return null

  const usage = input.context_window?.current_usage ?? input.usage ?? null
  const totalCost = dollars(input.cost?.total_cost_usd ?? input.cost_usd)
  const turn = usage
    ? {
        input: count(usage.input_tokens),
        output: count(usage.output_tokens),
        cacheRead: count(usage.cache_read_input_tokens),
        cacheWrite: count(usage.cache_creation_input_tokens),
        costUsd: totalCost,
        messages: 1,
      }
    : before?.turn ?? { ...emptyUsage(), messages: 0 }

  const session = before?.session
    ? {
        input: Math.max(count(before.session.input), turn.input),
        output: Math.max(count(before.session.output), turn.output),
        cacheRead: Math.max(count(before.session.cacheRead), turn.cacheRead),
        cacheWrite: Math.max(count(before.session.cacheWrite), turn.cacheWrite),
        costUsd: totalCost || dollars(before.session.costUsd),
        turns: Math.max(1, count(before.session.turns)),
      }
    : {
        input: turn.input,
        output: turn.output,
        cacheRead: turn.cacheRead,
        cacheWrite: turn.cacheWrite,
        costUsd: totalCost,
        turns: 1,
      }

  return {
    v: 1,
    model,
    thinkingLevel,
    supportedThinkingLevels,
    context,
    turn,
    session,
    at: nowIso,
  }
}

/**
 * Persist telemetry from an Antigravity `statusLine` update to `<connectionId>.telemetry.json`.
 */
export function recordStatuslineTelemetry(
  input,
  { home = os.homedir(), connectionId, conversationId = null, nowIso = new Date().toISOString() } = {},
) {
  if (!connectionId || !UUID_RE.test(connectionId)) return null
  const file = telemetryPath(home, connectionId)
  let previous = null
  try {
    if (fs.existsSync(file)) {
      previous = parseTelemetryRecord(fs.readFileSync(file, 'utf8'))
    }
  } catch {
    previous = null
  }
  const report = normalizeStatuslineTelemetryInput(input, { previous, conversationId, nowIso })
  if (!report) return null
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    fs.writeFileSync(file, JSON.stringify({ v: 1, conversation_id: conversationId, report }) + '\n', {
      mode: 0o600,
    })
  } catch {
    /* non-fatal */
  }
  return report
}

/**
 * Read fresh telemetry report for `connectionId` so `heartbeat_connection` can attach `agent_stats`.
 */
export function readConnectionTelemetry(
  connectionId,
  { home = os.homedir(), maxAgeMs = DEFAULT_TELEMETRY_MAX_AGE_MS, now = Date.now() } = {},
) {
  if (!connectionId || !UUID_RE.test(connectionId)) return null
  try {
    const text = fs.readFileSync(telemetryPath(home, connectionId), 'utf8')
    const parsed = parseTelemetryRecord(text)
    if (!parsed?.report) return null
    if (parsed.report.at) {
      const ts = Date.parse(parsed.report.at)
      if (Number.isFinite(ts) && maxAgeMs > 0 && now - ts > maxAgeMs) return null
    }
    return parsed.report
  } catch {
    return null
  }
}

/**
 * Send stored telemetry for `connectionId` to DevSpec via `heartbeat_connection`.
 */
export async function sendTelemetry({ connectionId, home = os.homedir(), call = mcpToolsCall } = {}) {
  if (!UUID_RE.test(connectionId ?? '')) return { ok: false, reason: 'bad_id' }
  const report = readConnectionTelemetry(connectionId, { home, maxAgeMs: 0 })
  if (!report) return { ok: false, reason: 'no_report' }
  const state = parseJson(
    (() => {
      try {
        return fs.readFileSync(connectionStatePath(home, connectionId), 'utf8')
      } catch {
        return ''
      }
    })(),
  )
  let token = state?.token
  let mcpUrl = state?.mcp_url
  if (!token) {
    const auth = resolveDevspecMcpAuth(state?.cwd || process.cwd())
    token = auth.token
    mcpUrl = mcpUrl || auth.mcp_url
  }
  if (!token) return { ok: false, reason: 'no_token' }
  await call({
    mcpUrl: mcpUrl || DEFAULT_PROD_URL,
    token,
    name: 'heartbeat_connection',
    arguments: {
      connection_id: connectionId,
      agent_name: AGENT_NAME,
      status: 'live',
      agent_stats: report,
    },
  })
  return { ok: true }
}

/**
 * Read the local connection & project view for status bar rendering.
 */
export function readConnectionView({
  home = os.homedir(),
  conversationId = null,
  connectionId: explicitConnectionId = null,
  cwd = null,
  env = process.env,
} = {}) {
  let connectionId =
    explicitConnectionId && UUID_RE.test(explicitConnectionId) ? explicitConnectionId : null
  let bond = null
  if (!connectionId && conversationId && SAFE_ID_RE.test(conversationId)) {
    try {
      bond = parseJson(fs.readFileSync(bondPath(home, conversationId), 'utf8'))
      if (typeof bond?.connection_id === 'string' && UUID_RE.test(bond.connection_id)) {
        connectionId = bond.connection_id
      }
    } catch {
      /* ignore */
    }
    if (!connectionId) {
      connectionId = resolveOwnConnectionId(conversationId, { home })
    }
  }

  let connection = null
  if (connectionId) {
    try {
      const parsed = parseJson(fs.readFileSync(connectionStatePath(home, connectionId), 'utf8'))
      if (parsed && parsed.connection_id === connectionId) {
        connection = parsed
      }
    } catch {
      /* ignore */
    }
  }

  // If no conversation bond exists yet (e.g. newly opened Antigravity window before first prompt,
  // or a window whose connection was ended from DevSpec UI), match a connection anchored to
  // this Antigravity window's owner_pid (preferring an active connection, or falling back to
  // an ended/disconnected connection for the same owner_pid so statusLine renders the ended
  // state instead of re-triggering maybeSpawnWindowAutoConnect).
  if (!connection) {
    const ownerPid = resolveOwnerPid('auto', null)
    if (ownerPid) {
      const connDir = path.join(home, REMOTE_DIR, 'connections')
      try {
        let fallbackEnded = null
        let fallbackEndedMtime = -1
        for (const f of fs.readdirSync(connDir)) {
          if (!/^[0-9a-f-]{36}\.json$/i.test(f)) continue
          const fullPath = path.join(connDir, f)
          const parsed = parseJson(fs.readFileSync(fullPath, 'utf8'))
          if (
            !parsed ||
            String(parsed.agent_name || '').toLowerCase() !== AGENT_NAME.toLowerCase() ||
            Number(parsed.owner_pid) !== Number(ownerPid)
          ) {
            continue
          }
          const localIdOk =
            !conversationId ||
            !parsed.local_id ||
            String(parsed.local_id).startsWith('agy-window:') ||
            parsed.local_id === conversationId
          if (!localIdOk) continue
          if (parsed.enabled !== false && !parsed.ended_from_ui) {
            connection = parsed
            connectionId = parsed.connection_id
            break
          }
          let mtime = 0
          try {
            mtime = fs.statSync(fullPath).mtimeMs
          } catch {
            mtime = 0
          }
          if (mtime >= fallbackEndedMtime) {
            fallbackEnded = parsed
            fallbackEndedMtime = mtime
          }
        }
        if (!connection && fallbackEnded) {
          connection = fallbackEnded
          connectionId = fallbackEnded.connection_id
        }
      } catch {
        /* ignore */
      }
    }
  }

  const effectiveCwd = cwd || connection?.cwd || null
  let pin = null
  if (effectiveCwd) {
    try {
      pin = findProjectPin(effectiveCwd, { home })
    } catch {
      pin = null
    }
  }
  let pinProjectName = ''
  if (pin?.path) {
    try {
      const rawPin = parseJson(fs.readFileSync(pin.path, 'utf8'))
      const candidate = cleanLabel(rawPin?.project_name || '')
      if (candidate && !UUID_RE.test(candidate)) pinProjectName = candidate
    } catch {
      /* ignore */
    }
  }
  let convProjectName = ''
  if (conversationId) {
    try {
      const cp = readConversationProject(conversationId, { home })
      if (cp?.status === 'selected' && cp.project?.name) {
        const candidate = cleanLabel(cp.project.name)
        if (candidate && !UUID_RE.test(candidate)) convProjectName = candidate
      }
    } catch {
      /* ignore */
    }
  }
  const rawConnProjName = cleanLabel(connection?.project_name || bond?.project_name || '')
  const connectionProjectName =
    rawConnProjName && !UUID_RE.test(rawConnProjName) ? rawConnProjName : ''
  let cwdProjectName = ''
  if (!connection && effectiveCwd) {
    try {
      const connDir = path.join(home, REMOTE_DIR, 'connections')
      if (fs.existsSync(connDir)) {
        let bestMtime = -1
        for (const f of fs.readdirSync(connDir)) {
          if (!/^[0-9a-f-]{36}\.json$/i.test(f)) continue
          const fullPath = path.join(connDir, f)
          const parsed = parseJson(fs.readFileSync(fullPath, 'utf8'))
          if (!parsed || parsed.cwd !== effectiveCwd) continue
          const candidate = cleanLabel(parsed.project_name || '')
          if (!candidate || UUID_RE.test(candidate)) continue
          let mtime = 0
          try {
            mtime = fs.statSync(fullPath).mtimeMs
          } catch {
            mtime = 0
          }
          if (mtime >= bestMtime) {
            cwdProjectName = candidate
            bestMtime = mtime
          }
        }
      }
    } catch {
      /* ignore */
    }
  }
  const resolvedProjectName =
    convProjectName || connectionProjectName || pinProjectName || cwdProjectName

  const work = []
  const workItems = []
  let automation = null
  if (conversationId && effectiveCwd) {
    try {
      const repoRoot = canonicalRepo(effectiveCwd)
      const scope = { sessionId: conversationId, repoRoot }
      const claimedItems = readClaimedWorkItems(scope, { env })
      if (Array.isArray(claimedItems) && claimedItems.length > 0) {
        for (const item of claimedItems) {
          if (typeof item?.id === 'string' && item.id) {
            let resolvedTitle =
              typeof item.title === 'string' && item.title ? cleanLabel(item.title) : null
            if (!resolvedTitle) {
              const local = resolveLocalItemDetails(item.id, {
                conversationId,
                connectionId,
                home,
                env,
              })
              if (local?.title) {
                resolvedTitle = cleanLabel(local.title)
                backfillClaimedItemDetails(scope, item.id, local, { env })
              }
            }
            work.push(item.id)
            workItems.push({
              id: item.id,
              title: resolvedTitle,
            })
          }
        }
      } else {
        const claimed = readClaims(scope, { env })
        if (Array.isArray(claimed)) {
          for (const id of claimed) {
            if (typeof id === 'string' && id) {
              const local = resolveLocalItemDetails(id, {
                conversationId,
                connectionId,
                home,
                env,
              })
              const resolvedTitle = local?.title ? cleanLabel(local.title) : null
              if (local?.title) {
                backfillClaimedItemDetails(scope, id, local, { env })
              }
              work.push(id)
              workItems.push({ id, title: resolvedTitle })
            }
          }
        }
      }
      automation = readActiveAutomation(scope, { env })
      if (automation && !automation.automation_name && automation.run_id) {
        const localAuto = resolveLocalAutomationDetails(automation.run_id, {
          conversationId,
          connectionId,
          home,
          env,
        })
        if (localAuto?.automation_name) {
          automation = {
            ...automation,
            automation_id: automation.automation_id || localAuto.automation_id || null,
            automation_name: localAuto.automation_name,
          }
          backfillAutomationDetails(scope, localAuto, { env })
        }
      }
    } catch {
      /* ignore */
    }
  }

  const hasGitRemote = Boolean(effectiveCwd && gitRemoteOrigin(effectiveCwd))
  if (
    !connection &&
    !pin &&
    !resolvedProjectName &&
    !hasGitRemote &&
    work.length === 0 &&
    !automation
  ) {
    return null
  }

  if (!connection) {
    return {
      connectionId: null,
      state: 'local',
      codename: '',
      projectName: resolvedProjectName || (pin?.project_id ? `pinned (${shortCode(pin.project_id)})` : ''),
      sessionId: null,
      sessionTitle: '',
      work,
      workItems,
      automation,
    }
  }

  const codename = cleanLabel(
    connection.session_codename || connection.codename || bond?.session_codename || '',
  )
  const endReason = typeof connection.end_reason === 'string' ? connection.end_reason : null
  const endedFromUi =
    connection.ended_from_ui === true || endReason === 'ui' || endReason === 'ended_from_ui'
  const state = endedFromUi
    ? 'ended_from_devspec'
    : connection.enabled === false
      ? 'disconnected'
      : 'connected'

  const sessionId =
    state === 'connected' && typeof connection.session_id === 'string' && connection.session_id
      ? connection.session_id
      : null
  const sessionTitle =
    sessionId &&
    connection.session_title_for === sessionId &&
    isRealSessionTitle(connection.session_title)
      ? cleanLabel(connection.session_title)
      : ''

  return {
    connectionId,
    state,
    codename,
    projectName: resolvedProjectName,
    sessionId,
    sessionTitle,
    work,
    workItems,
    automation,
  }
}

/**
 * Trigger a non-blocking background auto-connect once when an Antigravity window
 * opens in a linked repository before any prompt has been typed (only when explicitly
 * opted in via `DEVSPEC_CONNECT_AT_STARTUP=1` or `.devspec/project.json` `connect_at_startup: true`).
 */
export function maybeSpawnWindowAutoConnect({
  cwd,
  ownerPid = resolveOwnerPid('auto', null),
  conversationId = null,
  home = os.homedir(),
  env = process.env,
  spawnImpl = spawn,
} = {}) {
  if (!cwd || !ownerPid) return { spawned: false, reason: 'missing_cwd_or_owner' }
  if (!connectAtStartupEnabled(env, { cwd, home })) {
    return { spawned: false, reason: 'disabled_or_unconfigured' }
  }
  const hasScope = Boolean(gitRemoteOrigin(cwd) || findProjectPin(cwd, { home }))
  if (!hasScope) return { spawned: false, reason: 'no_folder_scope' }

  const lockDir = path.join(home, REMOTE_DIR)
  const connDir = path.join(lockDir, 'connections')
  try {
    if (fs.existsSync(connDir)) {
      for (const f of fs.readdirSync(connDir)) {
        if (!/^[0-9a-f-]{36}\.json$/i.test(f)) continue
        const parsed = parseJson(fs.readFileSync(path.join(connDir, f), 'utf8'))
        if (
          parsed &&
          String(parsed.agent_name || '').toLowerCase() === AGENT_NAME.toLowerCase() &&
          Number(parsed.owner_pid) === Number(ownerPid)
        ) {
          return { spawned: false, reason: 'already_attempted' }
        }
      }
    }
  } catch {
    /* ignore */
  }

  const lockFile = path.join(lockDir, `autoconnect-${ownerPid}.lock`)
  try {
    if (fs.existsSync(lockFile)) {
      const stat = fs.statSync(lockFile)
      if (ownerAlive(Number(ownerPid)) || Date.now() - stat.mtimeMs < 60_000) {
        return { spawned: false, reason: 'already_attempted' }
      }
    }
    ensurePrivateDir(lockDir)
    fs.writeFileSync(lockFile, `${Date.now()}\n`, { mode: 0o600 })
  } catch {
    return { spawned: false, reason: 'lock_failed' }
  }

  const sessionStartScript = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'session-start.mjs',
  )
  const args = [sessionStartScript, '--auto-connect', '--cwd', cwd, '--owner-pid', String(ownerPid)]
  if (conversationId) args.push('--conversation-id', String(conversationId))
  try {
    const child = spawnImpl(process.execPath, args, {
      cwd,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env,
    })
    child.unref?.()
    return { spawned: true, pid: child.pid || null, ownerPid }
  } catch {
    return { spawned: false, reason: 'spawn_failed' }
  }
}

/**
 * Format the single-line DevSpec status string.
 */
export function formatStatusLine(view, work = [], telemetry = null) {
  if (!view) return ''
  const items =
    Array.isArray(work) && work.length > 0
      ? work
      : Array.isArray(view.workItems) && view.workItems.length > 0
        ? view.workItems
        : view.work || []
  const hasActiveWork =
    items.length > 0 || Boolean(view.automation?.automation_name || view.automation?.run_id)
  if (view.state === 'ended_from_devspec' && !hasActiveWork) {
    const name = view.codename || 'connected'
    return `DevSpec: ${name} · ended from DevSpec`
  }
  if (view.state === 'disconnected' && !hasActiveWork) {
    const name = view.codename || 'connected'
    return `DevSpec: ${name} · disconnected`
  }

  const parts = []
  if (view.state === 'connected') {
    parts.push(view.codename || 'connected')
  } else if (view.state === 'ended_from_devspec') {
    parts.push(`${view.codename || 'connected'} · ended from DevSpec`)
  } else if (view.state === 'disconnected') {
    parts.push(`${view.codename || 'connected'} · disconnected`)
  } else if (view.state === 'local') {
    parts.push('local (/devspec-remote to connect)')
  }
  if (view.projectName) parts.push(view.projectName)
  if (view.sessionId) {
    parts.push(view.sessionTitle ? `“${view.sessionTitle}”` : 'untitled session')
  }
  if (view.automation?.automation_name) {
    parts.push(`automation “${cleanLabel(view.automation.automation_name)}”`)
  } else if (view.automation?.run_id) {
    parts.push(`automation ${shortCode(view.automation.run_id)}`)
  }
  if (items.length > 0) {
    const latest = items[items.length - 1]
    const latestId = typeof latest === 'string' ? latest : latest?.id || ''
    const matchedItem =
      typeof latest === 'object' && latest?.title
        ? latest
        : Array.isArray(view.workItems)
          ? view.workItems.find((w) => w?.id === latestId)
          : null
    const latestTitle = cleanLabel(matchedItem?.title || '')
    const suffix = items.length > 1 ? ` +${items.length - 1}` : ''
    if (latestTitle && latestId) {
      parts.push(`working on “${latestTitle}” (${shortCode(latestId)})${suffix}`)
    } else if (latestTitle) {
      parts.push(`working on “${latestTitle}”${suffix}`)
    } else if (latestId) {
      parts.push(`working on ${shortCode(latestId)}${suffix}`)
    }
  }
  if (telemetry?.model?.id) {
    const pct =
      typeof telemetry?.context?.percent === 'number'
        ? ` (${Math.round(telemetry.context.percent)}%)`
        : ''
    parts.push(`${telemetry.model.id}${pct}`)
  }
  if (parts.length === 0) return ''
  return `DevSpec: ${parts.join(' · ')}`
}

/**
 * Process raw Antigravity `statusLine` stdin JSON, record telemetry if bound to a
 * connection, and return the formatted status bar string.
 */
export function renderStatusLine(rawInput = '', { home = os.homedir(), env = process.env, nowIso } = {}) {
  const input = typeof rawInput === 'string' ? parseJson(rawInput) || {} : rawInput || {}
  const rawStr = typeof rawInput === 'string' ? rawInput : JSON.stringify(input)
  const conversationId =
    (typeof input.conversation_id === 'string' && input.conversation_id.trim()) ||
    (typeof input.session_id === 'string' && input.session_id.trim()) ||
    resolveHookConversationId(rawStr, env)
  const cwd =
    (typeof input.cwd === 'string' && input.cwd.trim()) ||
    (typeof input.workspace?.current_dir === 'string' && input.workspace.current_dir.trim()) ||
    (typeof input.workspace === 'string' && input.workspace.trim()) ||
    null

  const view = readConnectionView({ home, conversationId, cwd, env })
  if (!view || view.state === 'local') {
    const hasInputContext = Boolean(
      cwd ||
        (typeof input.conversation_id === 'string' && input.conversation_id.trim()) ||
        (typeof input.session_id === 'string' && input.session_id.trim()),
    )
    if (hasInputContext) {
      const auth = resolveDevspecMcpAuth(cwd || process.cwd(), { home, env })
      if (!auth.ok) {
        return 'DevSpec: not configured — add dvs_ token to ~/.gemini/config/mcp_config.json'
      }
    }
    if (!view) return ''
  }
  let telemetry = null
  if (view?.connectionId) {
    telemetry =
      recordStatuslineTelemetry(input, {
        home,
        connectionId: view.connectionId,
        conversationId,
        ...(nowIso ? { nowIso } : {}),
      }) || readConnectionTelemetry(view.connectionId, { home })
  } else {
    telemetry = normalizeStatuslineTelemetryInput(input, {
      conversationId,
      ...(nowIso ? { nowIso } : {}),
    })
  }
  return formatStatusLine(view, view?.work || [], telemetry)
}

async function main() {
  const [mode, connectionId] = process.argv.slice(2)
  if (mode === 'send') {
    const res = await sendTelemetry({ connectionId })
    process.exit(res.ok ? 0 : 1)
  }
  let raw = ''
  try {
    raw = fs.readFileSync(0, 'utf8')
  } catch {
    raw = ''
  }
  const line = renderStatusLine(raw)
  if (line) process.stdout.write(line + '\n')
}

const isMain = isEntryPoint(import.meta.url)

if (isMain) {
  main().catch(() => process.exit(0))
}
