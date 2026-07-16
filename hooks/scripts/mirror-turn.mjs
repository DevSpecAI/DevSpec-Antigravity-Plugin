#!/usr/bin/env node
/**
 * DevSpec remote-control mirror hook (Stop / UserPromptSubmit).
 * Resolves ONLY the session bound to THIS local conversation — never a
 * machine-global "latest session" pointer. Posts mechanically — no LLM tokens.
 *
 * user_prompt mode → turn_kind=local_prompt (literal owner text in Agents UI)
 * stop mode        → turn_kind=agent (assistant reply)
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
const SESSIONS_DIR = path.join(os.homedir(), '.devspec', 'remote-control', 'sessions')

// Turn marker — the connected agent is the SOLE authority for the "working"
// state. UserPromptSubmit (turn start) writes it; Stop (turn end) clears it. The
// long-lived poller reads it to re-assert busy on heartbeats while a turn runs
// (so long turns stay "working" and the server's busy freshness doesn't decay).
function turnMarkerPath(sessionId) {
  return path.join(SESSIONS_DIR, `${sessionId}.turn`)
}
function writeTurnMarker(sessionId) {
  if (!sessionId) return
  try {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true })
    fs.writeFileSync(turnMarkerPath(sessionId), JSON.stringify({ startedAt: Date.now() }), {
      mode: 0o600,
    })
  } catch {
    /* non-fatal — the immediate busy heartbeat below still fires */
  }
}
function clearTurnMarker(sessionId) {
  if (!sessionId) return
  try {
    fs.rmSync(turnMarkerPath(sessionId), { force: true })
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
 * The DevSpec session to mirror into belongs to THIS local conversation. Resolve
 * its id the SAME way remote-control-state.mjs `write` stamped it — via the shared
 * detectLocalId, which probes whichever conversation-id env var THIS tool exposes
 * (CLAUDE_CODE_SESSION_ID, GROK_SESSION_ID, CODEX_THREAD_ID, TERM/SHELL_SESSION_ID,
 * …), then the hook stdin session_id. Tool-agnostic and SYMMETRIC with connect, so
 * it works for every plugin — not just Claude Code. (A Claude-only resolver here
 * silently fail-closes every other plugin's mirror.) Never a machine-global
 * pointer — that is exactly what caused concurrent sessions to cross-post.
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
 * Choose the state file bound to THIS conversation.
 *
 * Primary — a precise conversation bond: tools that expose a stable conversation
 * id (Claude/Grok/Codex, via detectLocalId) select the state whose local_id
 * matches. A machine-newer session for a DIFFERENT conversation is never picked.
 *
 * Fallback — for tools that expose NO per-conversation id to their hooks (e.g.
 * Cursor, Antigravity): select the single enabled remote session for THIS agent.
 * Safe ONLY because "exactly one" means there is nothing to disambiguate, so no
 * cross-session bleed is possible; two+ concurrent sessions of the same agent
 * fall closed (no mirror) rather than guess. Never a newest-mtime / machine-global
 * pick across different conversations.
 */
export function selectBoundState(candidates, conversationId, agentName = null) {
  const enabled = candidates
    .filter(Boolean)
    .filter(({ raw }) => raw?.enabled === true && raw?.session_id)

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

function loadState(conversationId) {
  // Gather every candidate (legacy singleton + per-session files) but NEVER
  // trust "most recent" — selectBoundState keeps only THIS conversation's state.
  const candidates = []
  try {
    if (fs.existsSync(LEGACY_STATE_PATH)) {
      const raw = JSON.parse(fs.readFileSync(LEGACY_STATE_PATH, 'utf8'))
      candidates.push({ raw, mtime: fs.statSync(LEGACY_STATE_PATH).mtimeMs })
    }
  } catch {
    /* continue with per-session state */
  }
  try {
    if (fs.existsSync(SESSIONS_DIR)) {
      for (const file of fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'))) {
        try {
          const p = path.join(SESSIONS_DIR, file)
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
    // Claude Code / Grok / Cursor / Codex payload field names vary.
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
 * Claude Code re-invokes the model after a background task completes by
 * injecting a synthetic user prompt — a <task-notification> block, a
 * [SYSTEM NOTIFICATION …] banner, or a <system-reminder>. Those are harness
 * plumbing, never owner-typed input, and must not be mirrored into the
 * transcript as local_prompt bubbles. This guard is Claude-Code-specific:
 * other tools never surface this text on UserPromptSubmit, so shipping it
 * only here keeps the working plugins untouched.
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
  const sessionId = state.session_id

  const text = extractLastText(raw, mode)

  // In user_prompt mode, mirror only genuine owner-typed prompts. Skip harness
  // plumbing (task-notification / system-reminder injections) so it never shows
  // as a fake "local prompt" bubble. The heartbeat below still runs regardless,
  // so presence is unaffected.
  const skipMirror = mode === 'user_prompt' && !!text && isHarnessInjection(text)

  try {
    if (text && String(text).trim() && !skipMirror) {
      const cleaned = String(text).trim().slice(0, 12000)
      const isLocalPrompt = mode === 'user_prompt'
      await mcpToolsCall({
        mcpUrl,
        token,
        name: 'post_session_message',
        arguments: {
          session_id: sessionId,
          // Raw body for local prompts — server turn_kind + strip handles UX.
          // Agent replies post the final assistant text as-is.
          message: cleaned,
          agent_name: agentName,
          turn_kind: isLocalPrompt ? 'local_prompt' : 'agent',
        },
      })
    }
    // Turn lifecycle → "working" authority. user_prompt starts a turn
    // (busy:true + marker so the poller re-asserts); stop ends it (busy:false +
    // clear marker). The server never sets busy itself, so this is the ONLY
    // thing that lights up "working".
    const turnActive = mode === 'user_prompt'
    if (turnActive) writeTurnMarker(sessionId)
    else clearTurnMarker(sessionId)
    await mcpToolsCall({
      mcpUrl,
      token,
      name: 'report_remote_agent_heartbeat',
      arguments: {
        session_id: sessionId,
        agent_name: agentName,
        status: 'live',
        busy: turnActive,
      },
    })
  } catch (e) {
    process.stderr.write(`[devspec-remote] ${e instanceof Error ? e.message : String(e)}\n`)
  }
  process.exit(0)
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) main()
