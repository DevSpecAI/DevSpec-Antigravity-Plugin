#!/usr/bin/env node
/**
 * Unit tests for MCP token resolution order — focus on the host-token symmetry
 * fix (item 74b29c76): the poller must resolve the SAME bearer the host used for
 * register_connection, or every dispatch is rejected as "connection belongs to a
 * different token".
 * Run: node --test hooks/scripts/resolve-mcp-auth.test.mjs
 */
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { hostTokenFromEnv, resolveDevspecMcpAuth } from './resolve-mcp-auth.mjs'

describe('resolveDevspecMcpAuth token precedence (host symmetry, item 74b29c76)', () => {
  let tmp
  const saved = {}

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-mcp-auth-'))
    fs.writeFileSync(
      path.join(tmp, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          devspec: {
            url: 'https://staging.devspec.ai/api/mcp',
            headers: { Authorization: 'Bearer from-mcp-json' },
          },
        },
      }),
    )
    // Neutralise ambient env overrides so precedence is deterministic on any machine.
    for (const k of ['DEVSPEC_MCP_TOKEN', 'DEVSPEC_TOKEN', 'DEVSPEC_MCP_URL']) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
  })

  after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    try {
      fs.rmSync(tmp, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('host token wins over the project .mcp.json walk', () => {
    const r = resolveDevspecMcpAuth(tmp, { hostToken: 'from-host' })
    assert.equal(r.ok, true)
    assert.equal(r.token, 'from-host')
    assert.equal(r.source, 'host')
  })

  it('falls back to .mcp.json when no host token (backward compatible)', () => {
    const r = resolveDevspecMcpAuth(tmp, {})
    assert.equal(r.ok, true)
    assert.equal(r.token, 'from-mcp-json')
    assert.match(String(r.source), /\.mcp\.json$/)
  })

  it('a blank/whitespace host token is ignored (backward compatible)', () => {
    const r = resolveDevspecMcpAuth(tmp, { hostToken: '   ' })
    assert.equal(r.token, 'from-mcp-json')
  })

  it('explicit DEVSPEC_MCP_TOKEN still overrides even a host token', () => {
    process.env.DEVSPEC_MCP_TOKEN = 'from-env'
    try {
      const r = resolveDevspecMcpAuth(tmp, { hostToken: 'from-host' })
      assert.equal(r.token, 'from-env')
      assert.equal(r.source, 'env')
    } finally {
      delete process.env.DEVSPEC_MCP_TOKEN
    }
  })
})

describe('hostTokenFromEnv', () => {
  it('reads the plugin userConfig token Claude Code exports', () => {
    assert.equal(hostTokenFromEnv({ CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN: 'plug' }), 'plug')
    assert.equal(hostTokenFromEnv({ CLAUDE_PLUGIN_OPTION_devspec_token: 'plug2' }), 'plug2')
  })

  it('returns null where the plugin env is unset (dev-from-source / non-Claude plugins)', () => {
    assert.equal(hostTokenFromEnv({}), null)
  })

  it('trims and ignores blank', () => {
    assert.equal(hostTokenFromEnv({ CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN: '  x ' }), 'x')
    assert.equal(hostTokenFromEnv({ CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN: '   ' }), null)
  })
})
