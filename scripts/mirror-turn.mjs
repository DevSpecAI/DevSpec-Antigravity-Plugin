#!/usr/bin/env node
/**
 * DevSpec remote-control mirror hook (Stop / PreInvocation / PostToolUse) — CONNECTION-NATIVE.
 * Resolves ONLY the connection bound to THIS local conversation — never a
 * machine-global "latest" pointer. Posts mechanically — no LLM tokens.
 *
 * user_prompt       → optional local_prompt bubble when attached (literal owner text)
 *                     + busy/heartbeat + turn marker
 * background_launch → records background subagent/task launches against the open turn
 * stop              → busy/heartbeat + turn marker clear (or hold when background work
 *                     launched by this turn is still in flight)
 *
 * Answers are agent-canonical: skills call post_session_message({ connection_id }).
 * ADR b98a39a9 — no dual writers.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { mcpToolsCall } from './mcp-call.mjs'
import { resolveDevspecMcpAuth } from './resolve-mcp-auth.mjs'
import { AGENT_NAME } from './agent-identity.mjs'
import {
  detectLocalId,
  inferAntigravityTranscriptPath,
  localBondPath,
} from './remote-control-state.mjs'

const MODES = new Set(['user_prompt', 'stop', 'background_launch', 'subagent_stop'])
const mode = MODES.has(process.argv[2]) ? process.argv[2] : 'stop'
const LEGACY_STATE_PATH = path.join(os.homedir(), '.devspec', 'remote-control.json')
const CONNECTIONS_DIR = path.join(os.homedir(), '.devspec', 'remote-control', 'connections')

// Turn marker — the connected agent is the SOLE authority for the "working" state.
// PreInvocation / UserPromptSubmit (turn start) writes it; Stop (turn end) clears it.
// The long-lived poller reads it (by connection_id) to re-assert busy on heartbeats
// while a turn runs, so long turns stay "working" and the server's busy freshness
// doesn't decay.
export function turnMarkerPath(connectionId, dir = CONNECTIONS_DIR) {
  return path.join(dir, `${connectionId}.turn`)
}

export function readTurnMarker(connectionId, dir = CONNECTIONS_DIR) {
  if (!connectionId) return null
  try {
    const raw = JSON.parse(fs.readFileSync(turnMarkerPath(connectionId, dir), 'utf8'))
    return typeof raw?.startedAt === 'number' ? raw : null
  } catch {
    return null
  }
}

export function writeTurnMarker(connectionId, extra = {}, dir = CONNECTIONS_DIR) {
  if (!connectionId) return null
  const existing = readTurnMarker(connectionId, dir)
  const startedAt = typeof existing?.startedAt === 'number' ? existing.startedAt : Date.now()
  const payload = {
    ...(existing || {}),
    startedAt,
    ...extra,
  }
  try {
    fs.mkdirSync(dir, { recursive: true })
    if (!existing) {
      fs.rmSync(path.join(dir, `${connectionId}.explicit-reply`), { force: true })
    }
    fs.writeFileSync(turnMarkerPath(connectionId, dir), JSON.stringify(payload), {
      mode: 0o600,
    })
  } catch {
    /* non-fatal — the immediate busy heartbeat below still fires */
  }
  return payload
}

export function ownedWorkPath(connectionId, dir = CONNECTIONS_DIR) {
  return path.join(dir, `${connectionId}.turn-owned.jsonl`)
}

export function clearTurnMarker(connectionId, dir = CONNECTIONS_DIR) {
  if (!connectionId) return
  try {
    fs.rmSync(turnMarkerPath(connectionId, dir), { force: true })
    fs.rmSync(ownedWorkPath(connectionId, dir), { force: true })
  } catch {
    /* ignore */
  }
}

export function recordOwnedLaunch(
  connectionId,
  launch,
  { dir = CONNECTIONS_DIR, now = Date.now() } = {},
) {
  if (!connectionId || !launch?.id) return false
  const marker = readTurnMarker(connectionId, dir)
  if (!marker) return false
  try {
    fs.mkdirSync(dir, { recursive: true })
    const line = {
      id: String(launch.id),
      kind: launch.kind || 'task',
      turn: marker.startedAt,
      at: new Date(now).toISOString(),
    }
    if (launch.label) line.label = String(launch.label)
    if (launch.model) line.model = String(launch.model)
    if (launch.parent) line.parent = String(launch.parent)
    fs.appendFileSync(ownedWorkPath(connectionId, dir), `${JSON.stringify(line)}\n`, {
      mode: 0o600,
    })
    return true
  } catch {
    return false
  }
}

export function recordOwnedEnd(
  connectionId,
  id,
  { status = 'completed', dir = CONNECTIONS_DIR, now = Date.now() } = {},
) {
  const marker = readTurnMarker(connectionId, dir)
  if (!marker || typeof id !== 'string' || !id) return false
  const lines = readOwnedLines(connectionId, marker, dir)
  if (!lines.some((entry) => entry.id === id && typeof entry.ended !== 'string')) return false
  if (lines.some((entry) => entry.id === id && typeof entry.ended === 'string')) return false
  try {
    fs.appendFileSync(
      ownedWorkPath(connectionId, dir),
      `${JSON.stringify({ id, turn: marker.startedAt, ended: new Date(now).toISOString(), status })}\n`,
      { mode: 0o600 },
    )
    return true
  } catch {
    return false
  }
}

export function readOwnedLines(connectionId, marker, dir = CONNECTIONS_DIR) {
  if (!connectionId || typeof marker?.startedAt !== 'number') return []
  let text = ''
  try {
    text = fs.readFileSync(ownedWorkPath(connectionId, dir), 'utf8')
  } catch {
    return []
  }
  const lines = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line)
      if (entry?.turn === marker.startedAt && typeof entry.id === 'string') lines.push(entry)
    } catch {
      /* ignore malformed line */
    }
  }
  return lines
}

export function readOwnedIds(connectionId, marker, dir = CONNECTIONS_DIR) {
  const lines = readOwnedLines(connectionId, marker, dir)
  const ended = new Set(
    lines.filter((e) => typeof e.ended === 'string').map((e) => e.id),
  )
  const ids = []
  for (const entry of lines) {
    if (typeof entry.ended !== 'string' && !ended.has(entry.id) && !ids.includes(entry.id)) {
      ids.push(entry.id)
    }
  }
  return ids
}

/**
 * Inspect a PostToolUse payload from Antigravity (or Claude Code) to see if it
 * launched asynchronous background work that will wake the agent in a subsequent
 * invocation (e.g. `invoke_subagent`, background `run_command`, `schedule` timer).
 */
export function launchedAntigravityBackgroundWork(toolName, toolInput, toolResponse) {
  const name = String(toolName || '')
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {}
  const resp =
    typeof toolResponse === 'string'
      ? (() => {
          try {
            return JSON.parse(toolResponse)
          } catch {
            return { raw: toolResponse }
          }
        })()
      : toolResponse && typeof toolResponse === 'object'
        ? toolResponse
        : {}

  // Antigravity: invoke_subagent spawns one or more background subagents.
  if (name === 'invoke_subagent' || name === 'default_api:invoke_subagent') {
    const subagents = Array.isArray(input.Subagents) ? input.Subagents : []
    const outText =
      typeof resp.output === 'string'
        ? resp.output
        : typeof resp.raw === 'string'
          ? resp.raw
          : JSON.stringify(resp)
    const convMatch = outText.match(/"conversationId"\s*:\s*"([^"]+)"/)
    const id = convMatch ? convMatch[1] : subagents[0]?.Role || 'subagent'
    const label = subagents.map((s) => s?.Role).filter(Boolean).join(', ') || 'subagent'
    return { id, kind: 'subagent', label }
  }

  // Antigravity: run_command sent to background (non-daemon).
  if (name === 'run_command' || name === 'default_api:run_command') {
    if (input.IsDaemon === true) return null
    const cmdLine = String(input.CommandLine || input.command || '')
    if (
      cmdLine.includes('devspec-remote-wait.mjs') ||
      cmdLine.includes('devspec-remote-listen.mjs') ||
      cmdLine.includes('devspec-remote-poll.mjs')
    ) {
      return null
    }
    const outText =
      typeof resp.output === 'string'
        ? resp.output
        : typeof resp.raw === 'string'
          ? resp.raw
          : ''
    const bgMatch =
      outText.match(/background task ID[:\s]+([A-Za-z0-9_-]+)/i) ||
      outText.match(/TaskId[:\s"]+([A-Za-z0-9_-]+)/i)
    if (bgMatch) {
      return {
        id: bgMatch[1],
        kind: 'command',
        label: input.toolSummary || input.CommandLine || 'background command',
      }
    }
    return null
  }

  // Claude Code / generic Agent or Bash background task support
  if (name === 'Bash' && (input.run_in_background === true || resp.backgroundTaskId)) {
    const cmdLine = String(input.command || input.CommandLine || '')
    if (
      cmdLine.includes('devspec-remote-wait.mjs') ||
      cmdLine.includes('devspec-remote-listen.mjs') ||
      cmdLine.includes('devspec-remote-poll.mjs')
    ) {
      return null
    }
    const id = resp.backgroundTaskId || resp.task_id || resp.id
    if (id) return { id: String(id), kind: 'command', label: input.description || 'bash' }
  }
  if (name === 'Agent' && (input.run_in_background === true || resp.isAsync === true)) {
    const id = resp.agentId || resp.agent_id || resp.id
    if (id) return { id: String(id), kind: 'subagent', label: input.description || 'agent' }
  }

  return null
}

export function recordBackgroundLaunch(
  raw,
  { load = loadState, record = recordOwnedLaunch, dir = CONNECTIONS_DIR } = {},
) {
  let input
  try {
    input = JSON.parse(raw || '{}')
  } catch {
    return false
  }
  const found = launchedAntigravityBackgroundWork(
    input?.tool_name ?? input?.toolName ?? input?.toolCall?.name,
    input?.tool_input ?? input?.toolInput ?? input?.toolCall?.args,
    input?.tool_response ?? input?.toolResponse ?? input?.result,
  )
  if (!found) return false
  const state = load(resolveHookConversationId(raw))
  if (!state?.connection_id) return false
  const recorded = record(state.connection_id, found, { dir })
  return recorded ? { state, launch: found } : false
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

/**
 * Normalize an Antigravity transcript path so `transcript_full.jsonl` (sent by
 * PreInvocation / Stop hooks) and `transcript.jsonl` (inferred by SessionStart /
 * PostInvocation) resolve to the same canonical compact `transcript.jsonl` path
 * whenever the compact sibling exists on disk.
 */
export function normalizeTranscriptPath(rawPath) {
  if (typeof rawPath !== 'string' || !rawPath.trim()) return null
  const trimmed = rawPath.trim()
  if (path.basename(trimmed) === 'transcript_full.jsonl') {
    const compactSibling = path.join(path.dirname(trimmed), 'transcript.jsonl')
    try {
      if (fs.existsSync(compactSibling)) return compactSibling
    } catch {
      /* ignore */
    }
  }
  return trimmed
}

/**
 * Extract the transcript path from hook stdin JSON.
 * Antigravity sends `transcriptPath` (camelCase) and `transcript_path` (snake_case).
 */
export function parseTranscriptPath(hookInput) {
  try {
    const parsed = JSON.parse(hookInput || '{}')
    if (typeof parsed.transcriptPath === 'string' && parsed.transcriptPath.trim()) {
      return normalizeTranscriptPath(parsed.transcriptPath)
    }
    if (typeof parsed.transcript_path === 'string' && parsed.transcript_path.trim()) {
      return normalizeTranscriptPath(parsed.transcript_path)
    }
  } catch {
    /* ignore */
  }
  return null
}

/**
 * Persist a newly discovered `transcript_path` (and `local_id` if missing) onto the
 * connection state file and local bond so the background poller can tail
 * `transcript.jsonl` for live progress trail streaming.
 */
export function syncStateTranscriptPath(
  state,
  transcriptPath,
  conversationId = null,
  { connectionsDir = CONNECTIONS_DIR } = {},
) {
  if (!state?.connection_id) return false
  const resolvedPath =
    normalizeTranscriptPath(transcriptPath) ||
    normalizeTranscriptPath(state.transcript_path) ||
    inferAntigravityTranscriptPath(conversationId || state.local_id)
  if (!resolvedPath) return false
  if (state.transcript_path === resolvedPath && (!conversationId || state.local_id === conversationId)) {
    return false
  }
  const file = path.join(connectionsDir, `${state.connection_id}.json`)
  try {
    if (fs.existsSync(file)) {
      const current = JSON.parse(fs.readFileSync(file, 'utf8'))
      const updated = {
        ...current,
        transcript_path: resolvedPath,
        local_id: current.local_id || conversationId || null,
        updated_at: new Date().toISOString(),
      }
      fs.writeFileSync(file, JSON.stringify(updated, null, 2), { mode: 0o600 })
      state.transcript_path = resolvedPath
      if (!state.local_id && conversationId) state.local_id = conversationId
    }
    const localId = state.local_id || conversationId
    if (localId) {
      const bondFile = localBondPath(state.agent_name || AGENT_NAME, localId)
      if (fs.existsSync(bondFile)) {
        const bond = JSON.parse(fs.readFileSync(bondFile, 'utf8'))
        if (bond.transcript_path !== resolvedPath) {
          bond.transcript_path = resolvedPath
          fs.writeFileSync(bondFile, JSON.stringify(bond, null, 2), { mode: 0o600 })
        }
      }
    }
    return true
  } catch {
    return false
  }
}

/**
 * The DevSpec connection to mirror for belongs to THIS local conversation. Resolve
 * its conversation id the SAME way remote-control-state.mjs `write` stamped it — via
 * the shared detectLocalId (probes whichever conversation-id env var THIS tool
 * exposes), then the hook stdin `conversationId` (Antigravity native) or `session_id`.
 */
export function resolveHookConversationId(hookInput, env = process.env) {
  const fromEnv = detectLocalId({}, env).local_id
  if (fromEnv) return fromEnv
  try {
    const parsed =
      typeof hookInput === 'string'
        ? JSON.parse(hookInput || '{}')
        : hookInput && typeof hookInput === 'object'
          ? hookInput
          : {}
    if (typeof parsed.conversationId === 'string' && parsed.conversationId.trim()) {
      return parsed.conversationId.trim()
    }
    if (typeof parsed.conversation_id === 'string' && parsed.conversation_id.trim()) {
      return parsed.conversation_id.trim()
    }
    if (typeof parsed.session_id === 'string' && parsed.session_id.trim()) {
      return parsed.session_id.trim()
    }
  } catch {
    /* fall through — fail closed below */
  }
  return null
}

/**
 * Choose the connection state bound to THIS conversation.
 *
 * Primary — a precise conversation bond: tools that expose a stable conversation id
 * select the state whose local_id matches. A machine-newer connection for a
 * DIFFERENT conversation is never picked.
 *
 * Fallback — for tools that expose NO per-conversation id to their hooks, or when a
 * connection was registered before `local_id` was known: the single enabled
 * connection for THIS agent. Safe ONLY because "exactly one" means nothing to
 * disambiguate; two+ concurrent connections of the same agent fail closed.
 */
export function selectBoundState(candidates, conversationId, agentName = null) {
  const enabled = candidates
    .filter(Boolean)
    .filter(({ raw }) => raw?.enabled === true && raw?.connection_id)

  if (conversationId) {
    const bound = enabled
      .filter(({ raw }) => raw.local_id === conversationId)
      .sort((a, b) => b.mtime - a.mtime)[0]?.raw
    if (bound) return bound
  }

  if (agentName) {
    const mine = enabled.filter(
      ({ raw }) => String(raw.agent_name || '').toLowerCase() === String(agentName).toLowerCase(),
    )
    if (mine.length === 1) {
      // Only fall back to the single connection if it is either unbound (local_id: null)
      // or we have no conversationId to check against. If the single connection is
      // explicitly bound to a DIFFERENT conversationId, fail closed!
      const candidate = mine[0].raw
      if (!conversationId || !candidate.local_id || candidate.local_id === conversationId) {
        return candidate
      }
    }
  }

  return null
}

/**
 * Marker set by mark-explicit-reply.mjs (PostToolUse on the devspec
 * post_session_message tool) when the agent itself already posted a reply this
 * turn. Cleared unconditionally once read so it can never leak into a later turn.
 */
export function explicitReplyMarkerPath(connectionId) {
  return path.join(CONNECTIONS_DIR, `${connectionId}.explicit-reply`)
}
export function consumeExplicitReplyMarker(connectionId) {
  if (!connectionId) return false
  const p = explicitReplyMarkerPath(connectionId)
  try {
    const existed = fs.existsSync(p)
    if (existed) fs.rmSync(p, { force: true })
    return existed
  } catch {
    return false
  }
}

export function loadState(conversationId, { connectionsDir = CONNECTIONS_DIR, legacyPath = LEGACY_STATE_PATH } = {}) {
  // Gather every candidate (legacy singleton + per-connection files) but NEVER
  // trust "most recent" — selectBoundState keeps only THIS conversation's state.
  const candidates = []
  try {
    if (fs.existsSync(legacyPath)) {
      const raw = JSON.parse(fs.readFileSync(legacyPath, 'utf8'))
      candidates.push({ raw, mtime: fs.statSync(legacyPath).mtimeMs })
    }
  } catch {
    /* continue with per-connection state */
  }
  try {
    if (fs.existsSync(connectionsDir)) {
      for (const file of fs.readdirSync(connectionsDir).filter((f) => f.endsWith('.json') && !f.endsWith('.turn-trail.json') && !f.endsWith('.room.json'))) {
        try {
          const p = path.join(connectionsDir, file)
          const raw = JSON.parse(fs.readFileSync(p, 'utf8'))
          candidates.push({ raw, mtime: fs.statSync(p).mtimeMs })
        } catch {
          /* ignore an incomplete or concurrently-replaced state file */
        }
      }
    }
  } catch {
    /* selection below fails closed when no readable matching state exists */
  }
  return selectBoundState(candidates, conversationId, AGENT_NAME)
}

/**
 * Extract the inner text of `<USER_REQUEST>...</USER_REQUEST>` from an Antigravity
 * `USER_INPUT` step in `transcript.jsonl`.
 */
export function extractUserRequestText(content) {
  const raw = String(content ?? '')
  const match = raw.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/)
  if (match) return match[1].trim()
  return raw.trim()
}

/**
 * Read the last non-empty JSONL step from an Antigravity `transcript.jsonl` file.
 * Reads at most the last 64 KB of the file for O(1) performance on long transcripts.
 */
export function extractLatestTranscriptStep(transcriptPath) {
  if (!transcriptPath) return null
  try {
    const stat = fs.statSync(transcriptPath)
    if (!stat.isFile() || stat.size === 0) return null
    const readSize = Math.min(stat.size, 65536)
    const fd = fs.openSync(transcriptPath, 'r')
    try {
      const buf = Buffer.alloc(readSize)
      fs.readSync(fd, buf, 0, readSize, stat.size - readSize)
      const lines = buf
        .toString('utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          return JSON.parse(lines[i])
        } catch {
          /* skip partial first line in tail chunk */
        }
      }
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null
  }
  return null
}

function extractLastText(hookInput, which) {
  let data
  try {
    data = JSON.parse(hookInput || '{}')
  } catch {
    return null
  }

  if (which === 'user_prompt') {
    const direct =
      data.prompt ||
      data.user_prompt ||
      data.message ||
      data.text ||
      data.content ||
      (typeof data.input === 'string' ? data.input : null) ||
      null
    if (direct) return direct

    const tPath = parseTranscriptPath(hookInput)
    const latestStep = extractLatestTranscriptStep(tPath)
    if (latestStep?.type === 'USER_INPUT' && typeof latestStep.content === 'string') {
      return extractUserRequestText(latestStep.content)
    }
    return null
  }

  if (typeof data.last_assistant_message === 'string') return data.last_assistant_message
  if (typeof data.assistant_message === 'string') return data.assistant_message
  if (typeof data.response === 'string') return data.response
  if (typeof data.output === 'string') return data.output
  const msgs = data.transcript || data.messages
  if (Array.isArray(msgs)) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (m && (m.role === 'assistant' || m.type === 'assistant')) {
        const c = m.content
        if (typeof c === 'string' && c.trim()) return c
        if (Array.isArray(c)) {
          const text = c
            .filter((b) => b && (b.type === 'text' || typeof b.text === 'string'))
            .map((b) => b.text || '')
            .join('\n')
            .trim()
          if (text) return text
        }
      }
    }
  }
  return null
}

/**
 * Antigravity and Claude Code re-invoke the model after a background task or subagent
 * by injecting a synthetic system message (`<SYSTEM_MESSAGE>`, `<task-notification>`,
 * `[SYSTEM NOTIFICATION …]`, or `<system-reminder>`). Those are harness plumbing,
 * never owner-typed input, and must not be mirrored as local_prompt bubbles.
 */
export function isHarnessInjection(text) {
  const t = String(text)
  return (
    t.includes('<SYSTEM_MESSAGE>') ||
    t.includes('<EPHEMERAL_MESSAGE>') ||
    t.includes('<task-notification') ||
    t.includes('[SYSTEM NOTIFICATION - NOT USER INPUT]') ||
    t.includes('This is an automated background-task event') ||
    t.includes('<system-reminder>')
  )
}

const REMOTE_STATUS_BANNER = '━━━ DevSpec Remote Control ━━━'

/**
 * Strip the terminal status block agents often paste into Stop output.
 * Removes from the banner header through the trailing rule line.
 */
export function stripRemoteControlBanner(text) {
  const t = String(text ?? '')
  const start = t.indexOf(REMOTE_STATUS_BANNER)
  if (start < 0) return t
  const afterHeader = t.slice(start + REMOTE_STATUS_BANNER.length)
  // Prefer the unicode rule line used in skills; fall back to ASCII dashes.
  const ruleMatch = afterHeader.match(/\n[─-]{3,}\s*\n?/)
  let end = start + REMOTE_STATUS_BANNER.length
  if (ruleMatch && typeof ruleMatch.index === 'number') {
    end += ruleMatch.index + ruleMatch[0].length
  } else {
    // No rule line — drop from banner to end of that paragraph block.
    const nextBlank = afterHeader.search(/\n\s*\n/)
    end = nextBlank >= 0 ? start + REMOTE_STATUS_BANNER.length + nextBlank : t.length
  }
  return `${t.slice(0, start)}${t.slice(end)}`.replace(/^\s+|\s+$/g, '')
}

/**
 * True when Stop (or agent) text is operational chrome that must not become a
 * session chat bubble. Fail open for ambiguous / real replies.
 */
export function isOperationalChrome(text) {
  let t = String(text ?? '').trim()
  if (!t) return true

  if (/^🔌?\s*\*{0,2}Local agent disconnected\*{0,2}\.?\s*$/i.test(t)) return true
  if (/^You're connected to .+ agent on their local machine\.?\s*$/i.test(t)) return true
  if (/^Connected and waiting for your next command\b/i.test(t) && t.length < 280) return true

  if (t.includes(REMOTE_STATUS_BANNER)) {
    t = stripRemoteControlBanner(t).trim()
    if (!t) return true
    if (/^Connected and waiting for your next command\b/i.test(t) && t.length < 280) return true
    if (/^🔌?\s*\*{0,2}Local agent disconnected\*{0,2}\.?\s*$/i.test(t)) return true
    if (/^You're connected to .+ agent on their local machine\.?\s*$/i.test(t)) return true
    // Banner plus a tiny leftover (e.g. "Open: Agents page") — still chrome.
    if (t.length < 80 && /^(Agent|Connection|Session|Status|Open|Stop with):/m.test(t)) return true
  }

  return false
}

/**
 * Prepare agent Stop text for mirroring: strip known chrome; return null to skip.
 */
export function prepareAgentMirrorText(text) {
  let t = String(text ?? '').trim()
  if (!t) return null
  if (t.includes(REMOTE_STATUS_BANNER)) t = stripRemoteControlBanner(t).trim()
  if (!t || isOperationalChrome(t)) return null
  return t.slice(0, 12000)
}

/**
 * Execute the mirror-turn lifecycle logic in-process or from CLI.
 */
export async function handleMirrorTurn(
  modeArg = mode,
  raw = '',
  {
    env = process.env,
    connectionsDir = CONNECTIONS_DIR,
    legacyPath = LEGACY_STATE_PATH,
    call = mcpToolsCall,
  } = {},
) {
  if (modeArg === 'background_launch') {
    return recordBackgroundLaunch(raw, {
      load: (id) => loadState(id, { connectionsDir, legacyPath }),
      dir: connectionsDir,
    })
  }

  const conversationId = resolveHookConversationId(raw, env)
  const state = loadState(conversationId, { connectionsDir, legacyPath })
  if (!state) return { ok: true, skipped: 'no_bound_state' }

  const hookTranscriptPath = parseTranscriptPath(raw)
  syncStateTranscriptPath(state, hookTranscriptPath, conversationId, { connectionsDir })

  let token = state.token
  let mcpUrl = state.mcp_url
  if (!token) {
    const auth = resolveDevspecMcpAuth(state.cwd || process.cwd())
    token = auth.token
    mcpUrl = mcpUrl || auth.mcp_url
  }
  if (!token) return { ok: true, skipped: 'no_auth_token' }

  mcpUrl = mcpUrl || 'https://api.devspec.ai/api/mcp'
  const agentName = AGENT_NAME
  const connectionId = state.connection_id
  const sessionId = state.session_id || null

  // In Antigravity, PreInvocation fires before EVERY LLM step in a multi-step turn.
  // If a `.turn` marker is already live AND the latest transcript step is not a new
  // USER_INPUT (or was already mirrored for this step_index), avoid duplicate
  // local_prompt posts and redundant heartbeats on every tool iteration.
  const existingMarker = readTurnMarker(connectionId, connectionsDir)
  const latestStep = extractLatestTranscriptStep(hookTranscriptPath || state.transcript_path)
  const isNewUserInputStep =
    latestStep?.type === 'USER_INPUT' &&
    (typeof latestStep.step_index !== 'number' ||
      existingMarker?.lastStepIndex !== latestStep.step_index)

  if (modeArg === 'user_prompt' && existingMarker && !existingMarker.held && !isNewUserInputStep) {
    // Check if hookInput had an explicit prompt field (e.g. direct UserPromptSubmit test)
    let parsedInput = {}
    try {
      parsedInput = JSON.parse(raw || '{}')
    } catch {
      parsedInput = {}
    }
    const hasExplicitPromptField = Boolean(
      parsedInput.prompt || parsedInput.user_prompt || parsedInput.message || parsedInput.text,
    )
    if (!hasExplicitPromptField) {
      return { ok: true, skipped: 'mid_turn_pre_invocation' }
    }
  }

  // If waking up from a held Stop via a SYSTEM_MESSAGE (e.g. subagent or background task
  // completion), mark those owned background launches as completed so the subsequent Stop
  // can finish the turn cleanly.
  if (modeArg === 'user_prompt' && existingMarker?.held && latestStep?.type === 'SYSTEM_MESSAGE') {
    const ownedIds = readOwnedIds(connectionId, existingMarker, connectionsDir)
    for (const id of ownedIds) {
      if (typeof latestStep.content === 'string' && latestStep.content.includes(id)) {
        recordOwnedEnd(connectionId, id, { dir: connectionsDir })
      }
    }
  }

  const text = extractLastText(raw, modeArg)
  const skipMirror =
    modeArg === 'user_prompt' &&
    ((!!text && isHarnessInjection(text)) || latestStep?.type === 'SYSTEM_MESSAGE')

  if (modeArg === 'stop') consumeExplicitReplyMarker(connectionId)

  try {
    if (
      modeArg === 'user_prompt' &&
      sessionId &&
      text &&
      String(text).trim() &&
      !skipMirror
    ) {
      const cleaned = String(text).trim().slice(0, 12000)
      if (cleaned) {
        const postArgs = {
          message: cleaned,
          agent_name: agentName,
          turn_kind: 'local_prompt',
        }
        if (connectionId) postArgs.connection_id = connectionId
        else postArgs.session_id = sessionId
        await call({
          mcpUrl,
          token,
          name: 'post_session_message',
          arguments: postArgs,
        })
      }
    }

    const turnActive = modeArg === 'user_prompt'
    if (turnActive) {
      const markerExtra = { held: false }
      if (typeof latestStep?.step_index === 'number') {
        markerExtra.lastStepIndex = latestStep.step_index
      }
      writeTurnMarker(connectionId, markerExtra, connectionsDir)
    } else {
      // On Stop: check if this turn launched background work (e.g. subagent or async command)
      // that has not yet reported back. If so, hold the turn open instead of closing it.
      const marker = readTurnMarker(connectionId, connectionsDir)
      const outstandingIds = marker ? readOwnedIds(connectionId, marker, connectionsDir) : []
      if (outstandingIds.length > 0 && !marker?.held) {
        writeTurnMarker(connectionId, { held: true }, connectionsDir)
        return { ok: true, held: true, outstanding: outstandingIds }
      }
      clearTurnMarker(connectionId, connectionsDir)
    }

    if (connectionId) {
      await call({
        mcpUrl,
        token,
        name: 'heartbeat_connection',
        arguments: {
          connection_id: connectionId,
          agent_name: agentName,
          status: 'live',
          busy: turnActive,
        },
      })
      if (!turnActive) {
        try {
          await call({
            mcpUrl,
            token,
            name: 'report_complete',
            arguments: { connection_id: connectionId, reason: 'turn_end' },
          })
        } catch {
          /* non-fatal — the poller's marker-driven backstop still runs */
        }
      }
    }
    return { ok: true, busy: turnActive }
  } catch (e) {
    process.stderr.write(`[devspec-remote] ${e instanceof Error ? e.message : String(e)}\n`)
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

async function main() {
  const raw = readStdin()
  await handleMirrorTurn(mode, raw)
  process.exit(0)
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) main()
