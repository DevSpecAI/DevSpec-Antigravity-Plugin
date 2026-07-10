#!/usr/bin/env node
/**
 * DevSpec remote-control mirror hook (Stop / UserPromptSubmit).
 * Uses token from ~/.devspec/remote-control.json (or per-session state) /
 * resolve-mcp-auth. Posts mechanically — no LLM tokens.
 *
 * user_prompt mode → turn_kind=local_prompt (literal owner text in Agents UI)
 * stop mode        → turn_kind=agent (assistant reply)
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mcpToolsCall } from './mcp-call.mjs'
import { resolveDevspecMcpAuth } from './resolve-mcp-auth.mjs'

const mode = process.argv[2] === 'user_prompt' ? 'user_prompt' : 'stop'
const LEGACY_STATE_PATH = path.join(os.homedir(), '.devspec', 'remote-control.json')
const SESSIONS_DIR = path.join(os.homedir(), '.devspec', 'remote-control', 'sessions')

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

function loadState() {
  // Prefer enabled legacy pointer; fall back to newest enabled per-session file.
  try {
    if (fs.existsSync(LEGACY_STATE_PATH)) {
      const raw = JSON.parse(fs.readFileSync(LEGACY_STATE_PATH, 'utf8'))
      if (raw && raw.enabled === true && raw.session_id) return raw
    }
  } catch {
    /* continue */
  }
  try {
    if (!fs.existsSync(SESSIONS_DIR)) return null
    const files = fs
      .readdirSync(SESSIONS_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          const p = path.join(SESSIONS_DIR, f)
          const raw = JSON.parse(fs.readFileSync(p, 'utf8'))
          return { raw, mtime: fs.statSync(p).mtimeMs }
        } catch {
          return null
        }
      })
      .filter(Boolean)
      .filter((x) => x.raw && x.raw.enabled === true && x.raw.session_id)
      .sort((a, b) => b.mtime - a.mtime)
    return files[0]?.raw ?? null
  } catch {
    return null
  }
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

async function main() {
  const state = loadState()
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
  const agentName = state.agent_name || 'Claude Code'
  const sessionId = state.session_id

  const raw = readStdin()
  const text = extractLastText(raw, mode)

  try {
    if (text && String(text).trim()) {
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
    await mcpToolsCall({
      mcpUrl,
      token,
      name: 'report_remote_agent_heartbeat',
      arguments: { session_id: sessionId, agent_name: agentName, status: 'live' },
    })
  } catch (e) {
    process.stderr.write(`[devspec-remote] ${e instanceof Error ? e.message : String(e)}\n`)
  }
  process.exit(0)
}

main()
