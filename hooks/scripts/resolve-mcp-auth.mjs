#!/usr/bin/env node
/**
 * Resolve DevSpec MCP URL + Bearer token for remote-control hooks/poller.
 *
 * Lookup order:
 * 1. DEVSPEC_MCP_TOKEN / DEVSPEC_TOKEN (+ DEVSPEC_MCP_URL)
 * 2. Project .mcp.json (cwd and parents)
 * 3. ~/.claude.json project entries that match cwd (mcpServers.devspec)
 * 4. ~/.claude.json top-level mcpServers.devspec
 * 5. CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN — the plugin userConfig token
 *    (keychain-stored; Claude Code exports it to hook/tool subprocesses).
 *    Lowest priority so a developer's own .mcp.json (e.g. staging) still wins.
 *
 * Prints JSON: { ok, token?, mcp_url?, source?, error? }
 * Never prints the full token in human logs — only to stdout JSON for piping.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DEFAULT_PROD_URL = 'https://devspec.ai/api/mcp'

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

function walkMcpJson(startDir) {
  let dir = path.resolve(startDir || process.cwd())
  for (let i = 0; i < 12; i++) {
    for (const name of ['.mcp.json', 'mcp.json']) {
      const file = path.join(dir, name)
      if (!fs.existsSync(file)) continue
      const j = readJson(file)
      const servers = j?.mcpServers || j?.mcp?.servers || {}
      const entry = servers.devspec || servers.DevSpec || servers['devspec-mcp']
      const got = fromServerEntry(entry)
      if (got?.token) return { ...got, source: file }
      if (got?.mcp_url) return { ...got, source: file }
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

function fromClaudeJson(cwd) {
  const file = path.join(os.homedir(), '.claude.json')
  const j = readJson(file)
  if (!j) return null

  const abs = path.resolve(cwd || process.cwd())

  // Prefer project-scoped config matching cwd prefix (longest match wins)
  const projects = j.projects || {}
  const matches = Object.keys(projects)
    .filter((p) => abs === p || abs.startsWith(p + path.sep) || p.startsWith(abs + path.sep))
    .sort((a, b) => b.length - a.length)

  for (const proj of matches) {
    const servers = projects[proj]?.mcpServers || {}
    const entry = servers.devspec || servers.DevSpec
    const got = fromServerEntry(entry)
    if (got?.token) return { ...got, source: `${file}#projects[${proj}]` }
  }

  // Any project entry named for this path substring
  for (const [proj, cfg] of Object.entries(projects)) {
    if (!proj.includes('devspec') && !abs.includes(path.basename(proj))) continue
    const servers = cfg?.mcpServers || {}
    const entry = servers.devspec || servers.DevSpec
    const got = fromServerEntry(entry)
    if (got?.token) return { ...got, source: `${file}#projects[${proj}]` }
  }

  const top = fromServerEntry((j.mcpServers || {}).devspec)
  if (top?.token) return { ...top, source: `${file}#mcpServers` }

  return null
}

export function resolveDevspecMcpAuth(cwd = process.cwd()) {
  const envToken = process.env.DEVSPEC_MCP_TOKEN || process.env.DEVSPEC_TOKEN || null
  const envUrl = process.env.DEVSPEC_MCP_URL || null
  if (envToken) {
    return {
      ok: true,
      token: envToken,
      mcp_url: envUrl || DEFAULT_PROD_URL,
      source: 'env',
    }
  }

  const fromProject = walkMcpJson(cwd)
  if (fromProject?.token) {
    return {
      ok: true,
      token: fromProject.token,
      mcp_url: envUrl || fromProject.mcp_url || DEFAULT_PROD_URL,
      source: fromProject.source,
    }
  }

  const fromClaude = fromClaudeJson(cwd)
  if (fromClaude?.token) {
    return {
      ok: true,
      token: fromClaude.token,
      mcp_url: envUrl || fromClaude.mcp_url || DEFAULT_PROD_URL,
      source: fromClaude.source,
    }
  }

  // Plugin userConfig token (sensitive; stored in the OS keychain, exported to
  // subprocesses as CLAUDE_PLUGIN_OPTION_<KEY>). This is how a marketplace-
  // installed user's token reaches the remote-control hooks/poller — they never
  // put it in .mcp.json. Kept last so an explicit local .mcp.json wins.
  const pluginOptionToken =
    process.env.CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN ||
    process.env.CLAUDE_PLUGIN_OPTION_devspec_token ||
    null
  if (pluginOptionToken) {
    return {
      ok: true,
      token: pluginOptionToken,
      mcp_url: envUrl || fromProject?.mcp_url || DEFAULT_PROD_URL,
      source: 'plugin_user_config',
    }
  }

  // URL-only from project file (token missing)
  if (fromProject?.mcp_url) {
    return {
      ok: false,
      mcp_url: envUrl || fromProject.mcp_url,
      source: fromProject.source,
      error:
        'Found DevSpec MCP URL but no Bearer token. Set DEVSPEC_MCP_TOKEN or add headers.Authorization on the devspec server in .mcp.json.',
    }
  }

  return {
    ok: false,
    mcp_url: envUrl || DEFAULT_PROD_URL,
    error:
      'No DevSpec MCP token found. Provide your token via the plugin configuration, set DEVSPEC_MCP_TOKEN, or configure mcpServers.devspec.headers.Authorization in project .mcp.json.',
  }
}

// CLI
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('resolve-mcp-auth.mjs')) {
  const result = resolveDevspecMcpAuth(process.cwd())
  process.stdout.write(JSON.stringify(result) + '\n')
  process.exit(result.ok ? 0 : 1)
}
