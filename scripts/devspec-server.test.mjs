/**
 * The plugin's own DevSpec connection (mcp_config.json) and the one setting that
 * picks the server for both Antigravity's tools and the background features.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import {
  bundledMcpConfig,
  configuredServer,
  devspecToolFromName,
  isDevspecServerName,
  pointInstallAt,
  PRODUCTION_MCP_URL,
  STAGING_MCP_URL,
} from './devspec-server.mjs'
import { devspecToolVerb } from './commit-provenance.mjs'
import { unwrapDevspecToolCall } from './devspec-tool-input.mjs'
import { isSessionReplyToolCall } from './mirror-turn.mjs'
import { resolveDevspecMcpAuth } from './resolve-mcp-auth.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version

function tempPlugin() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-server-'))
  fs.copyFileSync(path.join(ROOT, 'mcp_config.json'), path.join(root, 'mcp_config.json'))
  return root
}

describe("the plugin's own DevSpec connection", () => {
  it('ships production through the local stdio MCP bridge, with no secret', () => {
    const shipped = fs.readFileSync(path.join(ROOT, 'mcp_config.json'), 'utf8')
    const expected = bundledMcpConfig({ mcpUrl: PRODUCTION_MCP_URL })
    assert.deepEqual(JSON.parse(shipped), expected)
    assert.doesNotMatch(shipped, /Authorization|Bearer|dvs_|secret/i)
    assert.equal(configuredServer({ pluginRoot: ROOT }), PRODUCTION_MCP_URL)
  })

  it('points an install at staging and back to the exact shipped file', async () => {
    const root = tempPlugin()
    try {
      const shipped = fs.readFileSync(path.join(root, 'mcp_config.json'), 'utf8')
      const staging = await pointInstallAt('staging', { pluginRoot: root })
      assert.equal(staging.changed, true)
      assert.equal(staging.clientId, 'TucS1MNZZlWpOUc7')
      const entry = JSON.parse(fs.readFileSync(path.join(root, 'mcp_config.json'), 'utf8')).mcpServers.devspec
      assert.equal(entry.command, 'node')
      assert.deepEqual(entry.args, ['${PLUGIN_ROOT}/scripts/mcp-bridge.mjs', STAGING_MCP_URL])
      assert.equal(configuredServer({ pluginRoot: root }), STAGING_MCP_URL)
      // The background features follow the same setting.
      assert.equal(resolveDevspecMcpAuth('/x', { env: {}, home: root, pluginRoot: root }).mcp_url, STAGING_MCP_URL)
      await pointInstallAt('production', { pluginRoot: root })
      assert.equal(fs.readFileSync(path.join(root, 'mcp_config.json'), 'utf8'), shipped)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses a target that is not a DevSpec server address', async () => {
    const root = tempPlugin()
    try {
      await assert.rejects(pointInstallAt('nonsense', { pluginRoot: root }), /not a DevSpec server/)
      await assert.rejects(pointInstallAt('http://devspec.example/api/mcp', { pluginRoot: root }), /must start with https/)
      assert.equal(configuredServer({ pluginRoot: root }), PRODUCTION_MCP_URL)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('shows the server from the command line', () => {
    const out = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'devspec-server.mjs')], { encoding: 'utf8' })
    assert.equal(out.status, 0)
    assert.match(out.stdout, /connects Antigravity to DevSpec production \(https:\/\/api\.devspec\.ai\/api\/mcp\)/)
  })
})

describe('DevSpec tool calls, under the name Antigravity gives the bundled server', () => {
  it('recognizes devspec_devspec (the plugin’s own server) and a hand-made devspec', () => {
    assert.equal(isDevspecServerName('devspec_devspec'), true)
    assert.equal(isDevspecServerName('antigravity-devspec-autopilot-extension_devspec'), true)
    assert.equal(isDevspecServerName('devspec'), true)
    assert.equal(isDevspecServerName('supabase'), false)
    assert.equal(isDevspecServerName('devspec_other'), false)
    assert.equal(devspecToolFromName('mcp_devspec_devspec_claim_work_item'), 'claim_work_item')
    assert.equal(devspecToolFromName('mcp_devspec_claim_work_item'), 'claim_work_item')
    assert.equal(devspecToolFromName('mcp__devspec__claim_work_item'), 'claim_work_item')
    assert.equal(devspecToolFromName('mcp_supabase_execute_sql'), null)
  })

  it('the hooks treat a call_mcp_tool to devspec_devspec as the DevSpec call it is', () => {
    const input = { ServerName: 'devspec_devspec', ToolName: 'claim_work_item', Arguments: { task_id: 'abc' } }
    assert.equal(devspecToolVerb('call_mcp_tool', input), 'claim_work_item')
    assert.equal(unwrapDevspecToolCall('call_mcp_tool', input).verb, 'claim_work_item')
    assert.equal(isSessionReplyToolCall('call_mcp_tool', { ServerName: 'devspec_devspec', ToolName: 'post_session_message', Arguments: { message: 'hi' } }), true)
    assert.equal(devspecToolVerb('call_mcp_tool', { ...input, ServerName: 'supabase' }), null)
  })
})
