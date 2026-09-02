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
import { resolveDevspecMcpAuth, hostTokenFromEnv } from './resolve-mcp-auth.mjs'

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
    JSON.stringify({ mcpServers: { devspec: { url: 'https://devspec.ai/api/mcp' } } }),
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
function agConfig(dir, token, url = 'https://devspec.ai/api/mcp') {
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
    JSON.stringify({ mcpServers: { devspec: { url: 'https://devspec.ai/api/mcp', headers: { Authorization: `Bearer ${token}` } } } }),
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
    fs.writeFileSync(path.join(c, 'mcp_config.json'), JSON.stringify({ mcpServers: { devspec: { serverUrl: 'https://devspec.ai/api/mcp' } } }))
    const auth = resolveDevspecMcpAuth(d)
    assert.equal(auth.ok, false)
    assert.match(auth.error, /antigravity-cli[\\/]mcp_config\.json/)
  })
})
