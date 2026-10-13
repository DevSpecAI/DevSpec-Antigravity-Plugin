#!/usr/bin/env node
/**
 * Unit tests for the Antigravity DevSpec MCP auth resolver.
 * Run: node --test hooks/scripts/resolve-mcp-auth.test.mjs
 *
 * The load-bearing property: the token lives in Antigravity's own MCP config
 * (~/.gemini/antigravity-cli/mcp_config.json — mcpServers.devspec.serverUrl +
 * headers.Authorization), so that MUST win over a generic project .mcp.json —
 * otherwise the poller heartbeats a different token and the server rejects
 * "connection belongs to a different token".
 */
import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  DEFAULT_PROD_URL,
  formatMissingAuthMessage,
  hostTokenFromEnv,
  readPinnedAuth,
  resolveDevspecMcpAuth,
  verifyAndPinDevspecAuth,
} from './resolve-mcp-auth.mjs'

let root
let fakeHome
const savedEnv = {}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agres-'))
  fakeHome = path.join(root, 'home')
  fs.mkdirSync(fakeHome, { recursive: true })
  for (const k of ['HOME', 'USERPROFILE', 'DEVSPEC_MCP_TOKEN', 'DEVSPEC_TOKEN', 'DEVSPEC_MCP_URL']) savedEnv[k] = process.env[k]
  process.env.HOME = fakeHome
  process.env.USERPROFILE = fakeHome
  delete process.env.DEVSPEC_MCP_TOKEN
  delete process.env.DEVSPEC_TOKEN
  delete process.env.DEVSPEC_MCP_URL
  // Stop walkMcpJson before it climbs into the real user home (which may have ~/.mcp.json).
  fs.writeFileSync(
    path.join(root, '.mcp.json'),
    JSON.stringify({ mcpServers: { devspec: { url: DEFAULT_PROD_URL } } }),
  )
})

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  fs.rmSync(root, { recursive: true, force: true })
})

function proj(name) {
  const d = path.join(root, name)
  fs.mkdirSync(d, { recursive: true })
  return d
}
function agConfig(dir, token, url = DEFAULT_PROD_URL) {
  const c = path.join(dir, '.gemini', 'antigravity-cli')
  fs.mkdirSync(c, { recursive: true })
  fs.writeFileSync(
    path.join(c, 'mcp_config.json'),
    JSON.stringify({ mcpServers: { devspec: { type: 'http', serverUrl: url, headers: { Authorization: `Bearer ${token}` } } } }),
  )
}
function mcpJson(dir, token) {
  fs.writeFileSync(
    path.join(dir, '.mcp.json'),
    JSON.stringify({ mcpServers: { devspec: { url: DEFAULT_PROD_URL, headers: { Authorization: `Bearer ${token}` } } } }),
  )
}

describe('resolveDevspecMcpAuth (Antigravity)', { concurrency: false }, () => {
  it('prefers mcp_config.json over a generic project .mcp.json (the fix)', () => {
    const d = proj('both')
    mcpJson(d, 'dvs_from_mcpjson')
    agConfig(d, 'dvs_from_ag')
    const auth = resolveDevspecMcpAuth(d)
    assert.equal(auth.ok, true)
    assert.equal(auth.token, 'dvs_from_ag')
    assert.match(auth.source, /mcp_config\.json$/)
  })

  it('reads ~/.gemini/antigravity-cli/mcp_config.json (home) when the project has none', () => {
    const d = proj('homeonly')
    agConfig(fakeHome, 'dvs_home_ag')
    const auth = resolveDevspecMcpAuth(d)
    assert.equal(auth.token, 'dvs_home_ag')
    assert.equal(hostTokenFromEnv(process.env), 'dvs_home_ag')
  })

  it('prefers user-home Antigravity MCP over a per-project mcp_config.json', () => {
    const d = proj('homewins')
    agConfig(d, 'dvs_project_ag')
    agConfig(fakeHome, 'dvs_home_ag')
    const auth = resolveDevspecMcpAuth(d)
    assert.equal(auth.ok, true)
    assert.equal(auth.token, 'dvs_home_ag')
  })

  it('parses the serverUrl key (Antigravity shape), not just url', () => {
    const d = proj('serverurl')
    agConfig(d, 'dvs_ag', 'https://devspec.internal/api/mcp')
    const auth = resolveDevspecMcpAuth(d)
    assert.equal(auth.token, 'dvs_ag')
    assert.equal(auth.mcp_url, 'https://devspec.internal/api/mcp')
  })

  it('falls back to .mcp.json when no Antigravity config token is reachable', () => {
    const d = proj('mcponly')
    mcpJson(d, 'dvs_only_mcp')
    const auth = resolveDevspecMcpAuth(d)
    assert.equal(auth.token, 'dvs_only_mcp')
    assert.match(auth.source, /\.mcp\.json$/)
  })

  it('DEVSPEC_MCP_TOKEN overrides the config files', () => {
    const d = proj('envwin')
    agConfig(d, 'dvs_ag')
    process.env.DEVSPEC_MCP_TOKEN = 'dvs_env_override'
    const auth = resolveDevspecMcpAuth(d)
    assert.equal(auth.token, 'dvs_env_override')
    assert.equal(auth.source, 'env')
  })

  it('an explicit opts.hostToken wins over the Antigravity config (below env)', () => {
    const d = proj('hosttok')
    agConfig(d, 'dvs_ag')
    const auth = resolveDevspecMcpAuth(d, { hostToken: 'dvs_explicit_host' })
    assert.equal(auth.token, 'dvs_explicit_host')
    assert.equal(auth.source, 'host')
  })

  it('reports an Antigravity-shaped error when a URL is present but no token', () => {
    const d = proj('urlonly')
    const c = path.join(d, '.gemini', 'antigravity-cli')
    fs.mkdirSync(c, { recursive: true })
    fs.writeFileSync(path.join(c, 'mcp_config.json'), JSON.stringify({ mcpServers: { devspec: { serverUrl: DEFAULT_PROD_URL } } }))
    const auth = resolveDevspecMcpAuth(d)
    assert.equal(auth.ok, false)
    assert.match(auth.error, /antigravity-cli[\\/]mcp_config\.json/)
  })

  it('defaults to the production API host when only an env token is known', () => {
    const d = proj('envdefault')
    process.env.DEVSPEC_MCP_TOKEN = 'dvs_env_only'
    const auth = resolveDevspecMcpAuth(d)
    assert.equal(auth.ok, true)
    assert.equal(auth.mcp_url, 'https://devspec.ai/api/mcp')
  })

  it('defaults to the production API host when the config entry has a token but no URL', () => {
    const d = proj('tokenonly')
    const c = path.join(d, '.gemini', 'antigravity-cli')
    fs.mkdirSync(c, { recursive: true })
    fs.writeFileSync(
      path.join(c, 'mcp_config.json'),
      JSON.stringify({ mcpServers: { devspec: { headers: { Authorization: 'Bearer dvs_no_url' } } } }),
    )
    const auth = resolveDevspecMcpAuth(d)
    assert.equal(auth.token, 'dvs_no_url')
    assert.equal(auth.mcp_url, 'https://devspec.ai/api/mcp')
  })

  it('honours a staging serverUrl override rather than falling back to production', () => {
    const d = proj('stagingurl')
    agConfig(d, 'dvs_staging', 'https://api.devspecstaging.com/api/mcp')
    const auth = resolveDevspecMcpAuth(d)
    assert.equal(auth.token, 'dvs_staging')
    assert.equal(auth.mcp_url, 'https://api.devspecstaging.com/api/mcp')
  })

  it('ignores placeholder tokens like dvs_YOUR_DEVSPEC_MCP_TOKEN or non-dvs_ tokens in config files', () => {
    const d = proj('placeholder')
    agConfig(fakeHome, 'dvs_YOUR_DEVSPEC_MCP_TOKEN')
    mcpJson(d, 'not_a_dvs_token')
    const auth = resolveDevspecMcpAuth(d)
    assert.equal(auth.ok, false)
    assert.equal(auth.error, formatMissingAuthMessage())
  })

  it('formats a deterministic OS-aware missing auth message for POSIX and Windows', () => {
    assert.equal(
      formatMissingAuthMessage('linux'),
      'DevSpec is not configured properly: place your "dvs_..." token in ~/.gemini/antigravity-cli/mcp_config.json under mcpServers.devspec.headers.Authorization ("Bearer dvs_..."), then restart agy.',
    )
    assert.equal(
      formatMissingAuthMessage('win32'),
      'DevSpec is not configured properly: place your "dvs_..." token in %USERPROFILE%\\.gemini\\antigravity-cli\\mcp_config.json under mcpServers.devspec.headers.Authorization ("Bearer dvs_..."), then restart agy.',
    )
  })

  it('verifies candidate tokens and pins the working token to ~/.devspec/auth.json when multiple tokens exist', async () => {
    const d = proj('multitoken')
    agConfig(fakeHome, 'dvs_stale_home_token')
    agConfig(d, 'dvs_working_project_token')

    const res = await verifyAndPinDevspecAuth(d, {
      home: fakeHome,
      verifyToken: async ({ token }) => token === 'dvs_working_project_token',
    })
    assert.equal(res.ok, true)
    assert.equal(res.token, 'dvs_working_project_token')

    const pinned = readPinnedAuth({ home: fakeHome })
    assert.equal(pinned?.token, 'dvs_working_project_token')

    // Subsequent resolveDevspecMcpAuth and hostTokenFromEnv prefer the verified pinned candidate
    const resolved = resolveDevspecMcpAuth(d, { home: fakeHome })
    assert.equal(resolved.ok, true)
    assert.equal(resolved.token, 'dvs_working_project_token')
    assert.equal(hostTokenFromEnv(process.env, { cwd: d, home: fakeHome }), 'dvs_working_project_token')
  })
})
