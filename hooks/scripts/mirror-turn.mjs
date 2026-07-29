#!/usr/bin/env node
/**
 * DevSpec remote-control mirror hook (Stop / UserPromptSubmit) — CONNECTION-NATIVE.
 * Resolves ONLY the connection bound to THIS local conversation — never a
 * machine-global "latest" pointer. Posts mechanically — no LLM tokens.
 *
 * user_prompt → optional local_prompt bubble when attached (literal owner text)
 * stop        → busy/heartbeat + turn marker only (NO assistant text)
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
import { detectLocalId } from './remote-control-state.mjs'

const mode = process.argv[2] === 'user_prompt' ? 'user_prompt' : 'stop'
const LEGACY_STATE_PATH = path.join(os.homedir(), '.devspec', 'remote-control.json')
const CONNECTIONS_DIR = path.join(os.homedir(), '.devspec', 'remote-control', 'connections')

// Turn marker — the connected agent is the SOLE authority for the "working" state.
// UserPromptSubmit (turn start) writes it; Stop (turn end) clears it. The long-lived
// poller reads it (by connection_id) to re-assert busy on heartbeats while a turn
// runs, so long turns stay "working" and the server's busy freshness doesn't decay.
function turnMarkerPath(connectionId) {
  return path.join(CONNECTIONS_DIR, `${connectionId}.turn`)
}
function writeTurnMarker(connectionId) {
  if (!connectionId) return
  try {
    fs.mkdirSync(CONNECTIONS_DIR, { recursive: true })
    fs.writeFileSync(turnMarkerPath(connectionId), JSON.stringify({ startedAt: Date.now() }), {
      mode: 0o600,
    })
  } catch {
    /* non-fatal — the immediate busy heartbeat below still fires */
  }
}
function clearTurnMarker(connectionId) {
  if (!connectionId) return
  try {
    fs.rmSync(turnMarkerPath(connectionId), { force: true })
  } catch {
    /* ignore */
  }
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

/**
 * The DevSpec connection to mirror for belongs to THIS local conversation. Resolve
 * its conversation id the SAME way remote-control-state.mjs `write` stamped it — via
 * the shared detectLocalId (probes whichever conversation-id env var THIS tool
 * exposes), then the hook stdin session_id. Tool-agnostic and SYMMETRIC with connect.
 */
export function resolveHookConversationId(hookInput, env = process.env) {
  const fromEnv = detectLocalId({}, env).local_id
  if (fromEnv) return fromEnv
  try {
    const parsed = JSON.parse(hookInput || '{}')
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
 * (Claude/Grok/Codex, via detectLocalId) select the state whose local_id matches.
 * A machine-newer connection for a DIFFERENT conversation is never picked.
 *
 * Fallback — for tools that expose NO per-conversation id to their hooks (Cursor,
 * Antigravity): the single enabled connection for THIS agent. Safe ONLY because
 * "exactly one" means nothing to disambiguate; two+ concurrent connections of the
 * same agent fall closed (no mirror) rather than guess.
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
    if (mine.length === 1) return mine[0].raw
  }

  return null
}

/**
 * Marker set by mark-explicit-reply.mjs (PostToolUse on the devspec
 * post_session_message tool) when the agent itself already posted a reply this
 * turn. Checked here so Stop never ALSO mirrors the turn's end-of-turn
 * narration as a second, redundant session message (item b9fb49a9 — the
 * "double post, real reply missing" symptom was this narration landing
 * alongside an explicit reply, not instead of one). Cleared unconditionally
 * once read so it can never leak into a later turn.
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

export function loadState(conversationId) {
  // Gather every candidate (legacy singleton + per-connection files) but NEVER
  // trust "most recent" — selectBoundState keeps only THIS conversation's state.
  const candidates = []
  try {
    if (fs.existsSync(LEGACY_STATE_PATH)) {
      const raw = JSON.parse(fs.readFileSync(LEGACY_STATE_PATH, 'utf8'))
      candidates.push({ raw, mtime: fs.statSync(LEGACY_STATE_PATH).mtimeMs })
    }
  } catch {
    /* continue with per-connection state */
  }
  try {
    if (fs.existsSync(CONNECTIONS_DIR)) {
      for (const file of fs.readdirSync(CONNECTIONS_DIR).filter((f) => f.endsWith('.json'))) {
        try {
          const p = path.join(CONNECTIONS_DIR, file)
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

function extractLastText(hookInput, which) {
  let data
  try {
    data = JSON.parse(hookInput || '{}')
  } catch {
    return null
  }

  if (which === 'user_prompt') {
    return (
      data.prompt ||
      data.user_prompt ||
      data.message ||
      data.text ||
      data.content ||
      (typeof data.input === 'string' ? data.input : null) ||
      null
    )
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
 * Claude Code re-invokes the model after a background task by injecting a synthetic
 * user prompt (a <task-notification> block, a [SYSTEM NOTIFICATION …] banner, or a
 * <system-reminder>). Those are harness plumbing, never owner-typed input, and must
 * not be mirrored as local_prompt bubbles.
 */
function isHarnessInjection(text) {
  const t = String(text)
  return (
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

async function main() {
  const raw = readStdin()
  const conversationId = resolveHookConversationId(raw)
  const state = loadState(conversationId)
  if (!state) process.exit(0)

  let token = state.token
  let mcpUrl = state.mcp_url
  if (!token) {
    const auth = resolveDevspecMcpAuth(state.cwd || process.cwd())
    token = auth.token
    mcpUrl = mcpUrl || auth.mcp_url
  }
  if (!token) process.exit(0) // silent — skill still posts instructionally

  mcpUrl = mcpUrl || 'https://devspec.ai/api/mcp'
  // Identity is a fixed property of THIS plugin — never trust state/args for it.
  const agentName = AGENT_NAME
  const connectionId = state.connection_id
  const sessionId = state.session_id || null // null = sessionless (no room to mirror into)
  const localId = state.local_id || null

  const text = extractLastText(raw, mode)
  const skipMirror = mode === 'user_prompt' && !!text && isHarnessInjection(text)

  // Consume any explicit-reply marker so it cannot bleed into a later turn.
  // Agent answers are skill-posted (ADR b98a39a9); Stop no longer mirrors full
  // assistant text as a primary path — dual writers caused wrong-voice dupes
  // and silent misses when bonding failed.
  if (mode === 'stop') consumeExplicitReplyMarker(connectionId)

  try {
    // LOCAL PROMPT only: mirror owner text typed in the terminal into the room
    // when attached (two-sided transcript). Agent Stop text is NOT posted here —
    // the skill must post_session_message the direct answer (prefer connection_id).
    if (
      mode === 'user_prompt' &&
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
        // Prefer connection_id so reattach is server-resolved (delivery contract).
        if (connectionId) postArgs.connection_id = connectionId
        else postArgs.session_id = sessionId
        await mcpToolsCall({
          mcpUrl,
          token,
          name: 'post_session_message',
          arguments: postArgs,
        })
      }
    }

    // Turn lifecycle → "working" authority. user_prompt starts a turn (busy:true +
    // marker so the poller re-asserts); stop ends it (busy:false + clear marker).
    // Marker is keyed by connection_id (the poller reads it by connection_id).
    const turnActive = mode === 'user_prompt'
    if (turnActive) writeTurnMarker(connectionId)
    else clearTurnMarker(connectionId)

    // Busy heartbeat — one connection-native path (attached or sessionless). The
    // server broadcasts agent_status for the attached session, so no session-keyed
    // heartbeat is needed.
    if (connectionId) {
      await mcpToolsCall({
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
      // End the activity attempt immediately on Stop. The poller also emits
      // report_complete when the marker disappears, but that waits for the next
      // long-poll tick — so Working / dots linger for seconds after the answer has
      // already landed. Calling it here drops them as soon as the turn ends, and
      // means a healthy Stop no longer depends on the poller to finish the turn.
      if (!turnActive) {
        try {
          await mcpToolsCall({
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
  } catch (e) {
    process.stderr.write(`[devspec-remote] ${e instanceof Error ? e.message : String(e)}\n`)
  }
  process.exit(0)
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) main()
