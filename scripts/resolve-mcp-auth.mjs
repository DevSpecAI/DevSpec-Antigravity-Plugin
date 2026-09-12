#!/usr/bin/env node
/**
 * Resolve DevSpec MCP URL + Bearer token for Antigravity remote-control hooks/poller.
 *
 * WHY THIS IS ANTIGRAVITY-SPECIFIC (this repo owns every script in it — the plugins
 * are independent implementations and nothing is synced between them). The
 * DevSpec token lives in Antigravity's OWN MCP config —
 * `~/.gemini/antigravity-cli/mcp_config.json` (the CLI) or the desktop app's MCP
 * settings — as `mcpServers.devspec.serverUrl` + `headers.Authorization`, NOT in a
 * `CLAUDE_PLUGIN_OPTION_*` env var. The detached poller and turn-mirroring hooks run
 * in a side channel that doesn't share that config, so they must resolve THAT token —
 * otherwise register_connection ran on one token while the poller heartbeats another
 * and the server rejects with "connection belongs to a different token" (dispatch
 * delivery spams). So Antigravity's mcp_config.json is the source of truth and wins
 * over a generic project `.mcp.json`. (The Claude Code plugin's resolver reads
 * `CLAUDE_PLUGIN_OPTION_*` + `~/.claude.json`, which are meaningless for Antigravity.)
 *
 * Lookup order:
 * 1. DEVSPEC_MCP_TOKEN / DEVSPEC_TOKEN (+ DEVSPEC_MCP_URL) — explicit override.
 * 2. opts.hostToken — an explicitly supplied host bearer.
 * 3. Antigravity MCP config — `~/.gemini/antigravity-cli/mcp_config.json` then
 *    `<cwd>/.gemini/antigravity-cli/mcp_config.json`.
 * 4. Project `.mcp.json` (cwd and parents) — fallback for non-standard setups.
 *
 * Prints JSON: { ok, token?, mcp_url?, source?, error? }
 * Never prints the full token in human logs — only to stdout JSON for piping.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DEFAULT_PROD_URL = 'https://api.devspec.ai/api/mcp'

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function extractBearer(headers) {
  if (!headers || typeof headers !== 'object') return null
  const auth = headers.Authorization || headers.authorization
  if (typeof auth !== 'string') return null
  const m = auth.match(/^Bearer\s+(.+)$/i)
  return m ? m[1].trim() : auth.trim() || null
}

function fromServerEntry(entry) {
  if (!entry || typeof entry !== 'object') return null
  const url = entry.url || entry.serverUrl || entry.server_url || null
  const token = extractBearer(entry.headers) || entry.token || null
  if (!url && !token) return null
  return { mcp_url: url || DEFAULT_PROD_URL, token: token || null }
}

/** Pull the `devspec` server entry out of a parsed MCP-config JSON object. */
function devspecEntry(j) {
  const servers = j?.mcpServers || j?.mcp?.servers || {}
  return servers.devspec || servers.DevSpec || servers['devspec-mcp']
}

function walkMcpJson(startDir) {
  let dir = path.resolve(startDir || process.cwd())
  for (let i = 0; i < 12; i++) {
    for (const name of ['.mcp.json', 'mcp.json']) {
      const file = path.join(dir, name)
      if (!fs.existsSync(file)) continue
      const got = fromServerEntry(devspecEntry(readJson(file)))
      if (got?.token) return { ...got, source: file }
      if (got?.mcp_url) return { ...got, source: file }
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/**
 * Antigravity's own MCP config — user-home first so every folder sees the same
 * token, then an optional project `<cwd>/.gemini/antigravity-cli/mcp_config.json`.
 * First one carrying a token wins. Never `~/.claude.json`.
 */
function antigravityConfigAuth(cwd = process.cwd()) {
  const rel = ['.gemini', 'antigravity-cli', 'mcp_config.json']
  const candidates = [
    path.join(os.homedir(), ...rel),
    path.join(path.resolve(cwd || process.cwd()), ...rel),
  ]
  let urlOnly = null
  for (const file of candidates) {
    const got = fromServerEntry(devspecEntry(readJson(file)))
    if (got?.token) return { ...got, source: file }
    if (got?.mcp_url && !urlOnly) urlOnly = { ...got, source: file }
  }
  return urlOnly
}

/**
 * The token Antigravity registers the connection with — its own
 * `~/.gemini/antigravity-cli/mcp_config.json` devspec bearer, or an explicit
 * DEVSPEC_MCP_TOKEN override. Pass the result as
 * `resolveDevspecMcpAuth(cwd, { hostToken })` so the poller and the in-session MCP
 * stay on ONE token.
 *
 * Named `hostTokenFromEnv` because this plugin's poller, mirror, and state helpers
 * import the symbol. Antigravity owns and tests every one of those callers locally.
 */
export function hostTokenFromEnv(env = process.env) {
  const envTok = env.DEVSPEC_MCP_TOKEN || env.DEVSPEC_TOKEN
  if (typeof envTok === 'string' && envTok.trim()) return envTok.trim()
  return antigravityConfigAuth()?.token || null
}

export function resolveDevspecMcpAuth(cwd = process.cwd(), opts = {}) {
  const envToken = process.env.DEVSPEC_MCP_TOKEN || process.env.DEVSPEC_TOKEN || null
  const envUrl = process.env.DEVSPEC_MCP_URL || null
  if (envToken) {
    return { ok: true, token: envToken, mcp_url: envUrl || DEFAULT_PROD_URL, source: 'env' }
  }

  const ag = antigravityConfigAuth(cwd)
  const fromProject = walkMcpJson(cwd)

  const hostToken =
    typeof opts.hostToken === 'string' && opts.hostToken.trim() ? opts.hostToken.trim() : null
  if (hostToken) {
    return {
      ok: true,
      token: hostToken,
      mcp_url: envUrl || ag?.mcp_url || fromProject?.mcp_url || DEFAULT_PROD_URL,
      source: 'host',
    }
  }

  // Antigravity's own config — the token register_connection ran on. Wins over .mcp.json.
  if (ag?.token) {
    return {
      ok: true,
      token: ag.token,
      mcp_url: envUrl || ag.mcp_url || fromProject?.mcp_url || DEFAULT_PROD_URL,
      source: ag.source,
    }
  }

  if (fromProject?.token) {
    return {
      ok: true,
      token: fromProject.token,
      mcp_url: envUrl || fromProject.mcp_url || ag?.mcp_url || DEFAULT_PROD_URL,
      source: fromProject.source,
    }
  }

  const urlOnly = ag?.mcp_url ? ag : fromProject
  if (urlOnly?.mcp_url) {
    return {
      ok: false,
      mcp_url: envUrl || urlOnly.mcp_url,
      source: urlOnly.source,
      error:
        'Found a DevSpec MCP URL but no Bearer token. Add your dvs_ token to ~/.gemini/antigravity-cli/mcp_config.json (mcpServers.devspec.headers.Authorization), or set DEVSPEC_MCP_TOKEN.',
    }
  }

  return {
    ok: false,
    mcp_url: envUrl || DEFAULT_PROD_URL,
    error:
      'No DevSpec MCP token found. Add your dvs_ token to ~/.gemini/antigravity-cli/mcp_config.json (mcpServers.devspec), or set DEVSPEC_MCP_TOKEN.',
  }
}

// CLI
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('resolve-mcp-auth.mjs')) {
  // Reflect the same host-token preference the write path uses, for diagnostics.
  const result = resolveDevspecMcpAuth(process.cwd(), { hostToken: hostTokenFromEnv(process.env) })
  process.stdout.write(JSON.stringify(result) + '\n')
  process.exit(result.ok ? 0 : 1)
}
