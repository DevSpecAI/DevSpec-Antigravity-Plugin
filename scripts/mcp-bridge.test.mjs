/**
 * The bundled stdio MCP bridge (scripts/mcp-bridge.mjs): shares the plugin's own
 * browser sign-in with Antigravity's DevSpec tool connection and coordinates
 * half-life token renewal across multiple open Antigravity windows under the
 * cross-process lock.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { loginState, saveLogin } from './auth-store.mjs'
import { LOADED_PLUGIN_VERSION } from './connection-version.mjs'
import { discoverSignIn, startLoopbackSignIn } from './oauth.mjs'
import { handleBridgeMessage, resolveBridgeAuth } from './mcp-bridge.mjs'
import { pluginCopy, sandbox, startSignInServer } from './sign-in-test-fixtures.mjs'

const HOUR = 60 * 60 * 1000
const PROD = 'https://api.devspec.ai/api/mcp'
const STAGING = 'https://api.devspecstaging.com/api/mcp'
const BRIDGE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mcp-bridge.mjs')

let home
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-bridge-'))
})
afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

function save(endpoint, tag, { issuedAt = Date.now(), lifeMs = 24 * HOUR } = {}) {
  return saveLogin(
    {
      endpoint,
      tokens: { accessToken: `oat_${tag}`, refreshToken: `rt_${tag}`, issuedAt, expiresAt: issuedAt + lifeMs },
      issuer: 'https://issuer.test',
      tokenEndpoint: 'https://issuer.test/oauth/token',
      clientId: 'agy-client',
      resource: endpoint,
    },
    { home },
  )
}

function runBridgeLine(scriptPath, serverUrl, line, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, serverUrl], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk) => {
      out += chunk
    })
    child.stderr.on('data', (chunk) => {
      err += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout: out.trim(), stderr: err.trim() }))
    child.stdin.end(`${typeof line === 'string' ? line : JSON.stringify(line)}\n`)
  })
}

describe('the bundled stdio MCP bridge', () => {
  it('forwards JSON-RPC calls with the saved browser login and plugin header, and ignores notifications', async () => {
    const fake = await startSignInServer({ connectedAs: 'Grace Hopper' })
    try {
      await save(fake.mcpUrl, 'live')
      const notif = await handleBridgeMessage(
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { serverUrl: fake.mcpUrl, env: {}, home },
      )
      assert.equal(notif, null)

      const ping = await handleBridgeMessage(
        { jsonrpc: '2.0', id: 1, method: 'ping' },
        { serverUrl: fake.mcpUrl, env: {}, home },
      )
      assert.deepEqual(ping, { jsonrpc: '2.0', id: 1, result: {} })

      const call = await handleBridgeMessage(
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'verify_agent_connection', arguments: {} },
        },
        { serverUrl: fake.mcpUrl, env: {}, home },
      )
      assert.equal(call.id, 2)
      assert.match(call.result.content[0].text, /Grace Hopper/)
      const mcpReq = fake.requests.find((r) => r.path === '/api/mcp')
      assert.equal(mcpReq.headers.authorization, 'Bearer oat_live')
      assert.equal(mcpReq.headers['x-devspec-plugin'], `antigravity/${LOADED_PLUGIN_VERSION}`)
    } finally {
      await fake.close()
    }
  })

  it('renews past half-life across multiple concurrent bridge processes without replaying a Clerk refresh token', async () => {
    const fake = await startSignInServer()
    const box = sandbox('bridge-multi-window')
    try {
      const discovery = await discoverSignIn(fake.mcpUrl)
      const pending = await startLoopbackSignIn({ discovery, clientId: 'TucS1MNZZlWpOUc7' })
      await fetch(fake.approve(pending.url, 'code-bridge'))
      const tokens = await pending.done
      const now = Date.now()
      await saveLogin(
        {
          endpoint: fake.mcpUrl,
          tokens: { ...tokens, issuedAt: now - 20 * HOUR, expiresAt: now + 4 * HOUR },
          issuer: discovery.issuer,
          tokenEndpoint: discovery.tokenEndpoint,
          clientId: 'TucS1MNZZlWpOUc7',
          resource: discovery.resource,
        },
        { home: box.home },
      )
      const plugin = pluginCopy(box.root, { mcpUrl: fake.mcpUrl, issuer: fake.base })
      const bridgeScript = path.join(plugin, 'scripts', 'mcp-bridge.mjs')
      const rpc = {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'verify_agent_connection', arguments: {} },
      }
      const runs = await Promise.all([
        runBridgeLine(bridgeScript, fake.mcpUrl, rpc, box.env),
        runBridgeLine(bridgeScript, fake.mcpUrl, rpc, box.env),
        runBridgeLine(bridgeScript, fake.mcpUrl, rpc, box.env),
        runBridgeLine(bridgeScript, fake.mcpUrl, rpc, box.env),
      ])
      const refreshes = fake.requests.filter((r) => r.path === '/oauth/token' && r.body?.grant_type === 'refresh_token')
      assert.equal(refreshes.length, 1, 'exactly one refresh_token call was made across all 4 windows')
      assert.equal(fake.deadGrants.size, 0, 'no refresh token was replayed')
      const state = loginState(fake.mcpUrl, { home: box.home })
      assert.equal(state.kind, 'active')
      assert.notEqual(state.login.accessToken, tokens.accessToken)
      for (const run of runs) {
        assert.equal(run.code, 0, run.stderr)
        const parsed = JSON.parse(run.stdout)
        assert.equal(parsed.id, 7)
        assert.ok(!parsed.result.isError, run.stdout)
      }
    } finally {
      box.remove()
      await fake.close()
    }
  })

  it('returns plain-English sign-in guidance when signed out or when DevSpec refuses a disconnected login', async () => {
    const fake = await startSignInServer()
    try {
      const signedOutCall = await handleBridgeMessage(
        { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'get_tasks', arguments: {} } },
        { serverUrl: PROD, env: {}, home },
      )
      assert.equal(signedOutCall.result.isError, true)
      assert.match(signedOutCall.result.content[0].text, /\/devspec-login/)

      const signedOutInit = await handleBridgeMessage(
        { jsonrpc: '2.0', id: 11, method: 'initialize', params: {} },
        { serverUrl: PROD, env: {}, home },
      )
      assert.match(signedOutInit.error.message, /\/devspec-login/)

      await save(fake.mcpUrl, 'disconnected')
      fake.refuse('oat_disconnected', 401, {
        code: 'signed_out',
        error: 'This tool was disconnected from your DevSpec account. You can reconnect it from Agent setup in your DevSpec settings.',
      })
      const refused = await handleBridgeMessage(
        { jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'get_tasks', arguments: {} } },
        { serverUrl: fake.mcpUrl, env: {}, home },
      )
      assert.equal(refused.result.isError, true)
      assert.match(refused.result.content[0].text, /disconnected from your DevSpec account/)
      assert.match(refused.result.content[0].text, /Then run \/devspec-login to sign in again/)
      assert.equal(loginState(fake.mcpUrl, { home }).kind, 'ended')
    } finally {
      await fake.close()
    }
  })

  it('honours DEVSPEC_MCP_TOKEN and DEVSPEC_MCP_URL on headless machines', async () => {
    await save(PROD, 'prod')
    const auth = await resolveBridgeAuth(PROD, {
      env: { DEVSPEC_MCP_TOKEN: 'dvs_headless_token', DEVSPEC_MCP_URL: `${STAGING}/` },
      home,
    })
    assert.deepEqual(auth, {
      ok: true,
      token: 'dvs_headless_token',
      mcp_url: STAGING,
      source: 'env',
    })
  })
})
