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

export const DEFAULT_PROD_URL = 'https://devspec.ai/api/mcp'

export function formatMissingAuthMessage(platform = process.platform) {
  const configPath =
    platform === 'win32'
      ? '%USERPROFILE%\\.gemini\\config\\mcp_config.json (or %USERPROFILE%\\.gemini\\antigravity-cli\\mcp_config.json)'
      : '~/.gemini/config/mcp_config.json (or ~/.gemini/antigravity-cli/mcp_config.json)'
  return `DevSpec is not configured properly: run \`agy mcp add --header "Authorization: Bearer dvs_..." devspec https://devspec.ai/api/mcp\` or place your "dvs_..." token in ${configPath} under mcpServers.devspec.headers.Authorization ("Bearer dvs_..."), then restart agy.`
}

export function isValidConfigToken(token) {
  if (typeof token !== 'string') return false
  const trimmed = token.trim()
  if (!trimmed) return false
  if (!trimmed.startsWith('dvs_')) return false
  if (/^dvs_your(?:_|$)/i.test(trimmed)) return false
  if (trimmed.includes('YOUR_') || trimmed.includes('<YOUR') || /^dvs_<.*>$/i.test(trimmed)) return false
  return true
}

function isNonPlaceholderToken(token) {
  if (typeof token !== 'string') return false
  const trimmed = token.trim()
  if (!trimmed) return false
  if (/^dvs_your(?:_|$)/i.test(trimmed)) return false
  if (trimmed.includes('YOUR_') || trimmed.includes('<YOUR') || /^<.*>$/.test(trimmed) || /^\$\{.*\}$/.test(trimmed)) {
    return false
  }
  return true
}

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
  const rawToken = extractBearer(entry.headers) || entry.token || null
  const token = isValidConfigToken(rawToken) ? rawToken.trim() : null
  if (!url && !token) return null
  return { mcp_url: url || DEFAULT_PROD_URL, token }
}

/** Pull the `devspec` server entry out of a parsed MCP-config JSON object. */
function devspecEntry(j) {
  const servers = j?.mcpServers || j?.mcp?.servers || {}
  return servers.devspec || servers.DevSpec || servers['devspec-mcp']
}

export function pinnedAuthPath(home = os.homedir()) {
  return path.join(home, '.devspec', 'auth.json')
}

export function readPinnedAuth({ home = os.homedir() } = {}) {
  const file = pinnedAuthPath(home)
  const parsed = readJson(file)
  if (!parsed || !isValidConfigToken(parsed.token)) return null
  return {
    token: parsed.token.trim(),
    mcp_url: (typeof parsed.mcp_url === 'string' && parsed.mcp_url.trim()) || DEFAULT_PROD_URL,
    verified_at: typeof parsed.verified_at === 'string' ? parsed.verified_at : null,
    source: file,
  }
}

export function writePinnedAuth(
  { token, mcp_url = DEFAULT_PROD_URL, verified_at = new Date().toISOString() } = {},
  { home = os.homedir() } = {},
) {
  if (!isValidConfigToken(token)) return null
  const file = pinnedAuthPath(home)
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const payload = {
      token: token.trim(),
      mcp_url: (typeof mcp_url === 'string' && mcp_url.trim()) || DEFAULT_PROD_URL,
      verified_at,
    }
    fs.writeFileSync(file, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 })
    return { ...payload, source: file }
  } catch {
    return null
  }
}

export function readPiAuth({ home = os.homedir() } = {}) {
  if (!home) return null
  const file = path.join(home, '.pi', 'agent', 'devspec', 'auth.json')
  const parsed = readJson(file)
  if (!parsed || !isValidConfigToken(parsed.token)) return null
  const url =
    (typeof parsed.mcp_url === 'string' && parsed.mcp_url.trim()) ||
    (typeof parsed.url === 'string' && parsed.url.trim()) ||
    DEFAULT_PROD_URL
  return {
    token: parsed.token.trim(),
    mcp_url: url,
    source: file,
  }
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

function antigravityConfigCandidates(cwd = process.cwd(), home = os.homedir()) {
  const resolvedCwd = path.resolve(cwd || process.cwd())
  const files = [
    path.join(home, '.gemini', 'config', 'mcp_config.json'),
    path.join(home, '.gemini', 'antigravity-cli', 'mcp_config.json'),
    path.join(resolvedCwd, '.gemini', 'config', 'mcp_config.json'),
    path.join(resolvedCwd, '.gemini', 'antigravity-cli', 'mcp_config.json'),
  ]
  const out = []
  for (const file of files) {
    const got = fromServerEntry(devspecEntry(readJson(file)))
    if (got) out.push({ ...got, source: file })
  }
  return out
}

/**
 * Antigravity's own MCP config — user-home first so every folder sees the same
 * token, then an optional project `<cwd>/.gemini/antigravity-cli/mcp_config.json`.
 * If a verified pinned token in `~/.devspec/auth.json` matches one of the candidates,
 * that verified candidate wins. Never `~/.claude.json`.
 */
function antigravityConfigAuth(cwd = process.cwd(), { home = os.homedir() } = {}) {
  const candidates = antigravityConfigCandidates(cwd, home)
  const pinned = readPinnedAuth({ home })
  if (pinned?.token) {
    const matching = candidates.find((c) => c.token === pinned.token)
    if (matching) return matching
  }
  let urlOnly = null
  for (const got of candidates) {
    if (got.token) return got
    if (got.mcp_url && !urlOnly) urlOnly = got
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
export function hostTokenFromEnv(env = process.env, { cwd = process.cwd(), home = os.homedir() } = {}) {
  const envTok = env.DEVSPEC_MCP_TOKEN || env.DEVSPEC_TOKEN
  if (isNonPlaceholderToken(envTok)) return envTok.trim()
  const pinned = readPinnedAuth({ home })
  const piAuth = readPiAuth({ home })
  const agCandidates = antigravityConfigCandidates(cwd, home)
  const fromProject = walkMcpJson(cwd)
  const allCandidates = [...agCandidates, ...(fromProject ? [fromProject] : []), ...(piAuth ? [piAuth] : [])].filter((c) => c.token)
  if (pinned?.token && allCandidates.some((c) => c.token === pinned.token)) {
    return pinned.token
  }
  return antigravityConfigAuth(cwd, { home })?.token || pinned?.token || piAuth?.token || null
}

export function resolveDevspecMcpAuth(cwd = process.cwd(), opts = {}) {
  const env = opts.env || process.env
  const home = opts.home || os.homedir()
  const rawEnvToken = env.DEVSPEC_MCP_TOKEN || env.DEVSPEC_TOKEN || null
  const envToken = isNonPlaceholderToken(rawEnvToken) ? rawEnvToken.trim() : null
  const envUrl = env.DEVSPEC_MCP_URL || null

  const ag = antigravityConfigAuth(cwd, { home })
  const fromProject = walkMcpJson(cwd)
  const pinned = readPinnedAuth({ home })
  const piAuth = readPiAuth({ home })

  if (envToken) {
    return {
      ok: true,
      token: envToken,
      mcp_url:
        envUrl ||
        ag?.mcp_url ||
        fromProject?.mcp_url ||
        pinned?.mcp_url ||
        piAuth?.mcp_url ||
        DEFAULT_PROD_URL,
      source: 'env',
    }
  }

  const hostToken = isNonPlaceholderToken(opts.hostToken) ? opts.hostToken.trim() : null
  if (hostToken) {
    return {
      ok: true,
      token: hostToken,
      mcp_url: envUrl || ag?.mcp_url || fromProject?.mcp_url || pinned?.mcp_url || piAuth?.mcp_url || DEFAULT_PROD_URL,
      source: 'host',
    }
  }

  // If a pinned verified token matches a project or Antigravity config candidate, prefer it.
  if (pinned?.token) {
    const agCandidates = antigravityConfigCandidates(cwd, home).filter((c) => c.token)
    const matchingAg = agCandidates.find((c) => c.token === pinned.token)
    if (matchingAg) {
      return {
        ok: true,
        token: matchingAg.token,
        mcp_url: envUrl || matchingAg.mcp_url || fromProject?.mcp_url || DEFAULT_PROD_URL,
        source: matchingAg.source,
      }
    }
    if (fromProject?.token === pinned.token) {
      return {
        ok: true,
        token: fromProject.token,
        mcp_url: envUrl || fromProject.mcp_url || ag?.mcp_url || DEFAULT_PROD_URL,
        source: fromProject.source,
      }
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

  if (pinned?.token) {
    return {
      ok: true,
      token: pinned.token,
      mcp_url: envUrl || pinned.mcp_url || ag?.mcp_url || fromProject?.mcp_url || DEFAULT_PROD_URL,
      source: pinned.source,
    }
  }

  if (piAuth?.token) {
    return {
      ok: true,
      token: piAuth.token,
      mcp_url: envUrl || piAuth.mcp_url || ag?.mcp_url || fromProject?.mcp_url || DEFAULT_PROD_URL,
      source: piAuth.source,
    }
  }

  const urlOnly = ag?.mcp_url ? ag : fromProject
  if (urlOnly?.mcp_url) {
    return {
      ok: false,
      mcp_url: envUrl || urlOnly.mcp_url,
      source: urlOnly.source,
      error: formatMissingAuthMessage(opts.platform),
    }
  }

  return {
    ok: false,
    mcp_url: envUrl || DEFAULT_PROD_URL,
    error: formatMissingAuthMessage(opts.platform),
  }
}

async function defaultVerifyToken({ mcpUrl, token }) {
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
      params: { name: 'verify_agent_connection', arguments: {} },
    }),
  })
  if (!res.ok) return false
  const text = await res.text()
  const json = JSON.parse(text)
  if (json?.error || json?.result?.isError) return false
  return true
}

/**
 * Collect candidate DevSpec tokens across Antigravity config files, pinned auth,
 * and project `.mcp.json`, verify them against `verify_agent_connection`, and pin
 * the first working token to `~/.devspec/auth.json`.
 */
export async function verifyAndPinDevspecAuth(
  cwd = process.cwd(),
  {
    env = process.env,
    home = os.homedir(),
    platform = process.platform,
    verifyToken = defaultVerifyToken,
  } = {},
) {
  const envUrl = env.DEVSPEC_MCP_URL || null
  const rawEnvToken = env.DEVSPEC_MCP_TOKEN || env.DEVSPEC_TOKEN || null
  if (isNonPlaceholderToken(rawEnvToken)) {
    const token = rawEnvToken.trim()
    const mcp_url = envUrl || DEFAULT_PROD_URL
    return { ok: true, token, mcp_url, source: 'env', verified: true }
  }

  const agCandidates = antigravityConfigCandidates(cwd, home).filter((c) => c.token)
  const pinned = readPinnedAuth({ home })
  const piAuth = readPiAuth({ home })
  const fromProject = walkMcpJson(cwd)
  const rawList = [
    ...agCandidates,
    ...(pinned?.token ? [pinned] : []),
    ...(piAuth?.token ? [piAuth] : []),
    ...(fromProject?.token ? [fromProject] : []),
  ]

  const seen = new Set()
  const candidates = []
  for (const item of rawList) {
    if (!item?.token || seen.has(item.token)) continue
    seen.add(item.token)
    candidates.push({
      token: item.token,
      mcp_url: envUrl || item.mcp_url || DEFAULT_PROD_URL,
      source: item.source,
    })
  }

  if (candidates.length === 0) {
    return {
      ok: false,
      mcp_url: envUrl || DEFAULT_PROD_URL,
      error: formatMissingAuthMessage(platform),
    }
  }

  for (const candidate of candidates) {
    let valid = false
    try {
      valid = Boolean(await verifyToken({ mcpUrl: candidate.mcp_url, token: candidate.token }))
    } catch {
      valid = false
    }
    if (valid) {
      writePinnedAuth({ token: candidate.token, mcp_url: candidate.mcp_url }, { home })
      return {
        ok: true,
        token: candidate.token,
        mcp_url: candidate.mcp_url,
        source: candidate.source,
        verified: true,
      }
    }
  }

  return {
    ok: false,
    mcp_url: candidates[0].mcp_url,
    error: formatMissingAuthMessage(platform),
  }
}

// CLI
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('resolve-mcp-auth.mjs')) {
  // Reflect the same host-token preference the write path uses, for diagnostics.
  const result = resolveDevspecMcpAuth(process.cwd(), { hostToken: hostTokenFromEnv(process.env) })
  process.stdout.write(JSON.stringify(result) + '\n')
  process.exit(result.ok ? 0 : 1)
}
