import assert from 'node:assert/strict'
import { it } from 'node:test'
import { mcpToolsCall } from './mcp-call.mjs'

it('carries a connection capability header and can return hidden MCP result metadata', async () => {
  const original = globalThis.fetch
  let request
  globalThis.fetch = async (_url, options) => {
    request = options
    return new Response(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: JSON.stringify({ connection_id: 'connection' }) }],
        _meta: { devspec: { connection_capability: { version: 1, value: 'dvsc_secret' } } },
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    let callbackMeta = null
    const result = await mcpToolsCall({
      mcpUrl: 'https://example.test/mcp',
      token: 'dvs_test',
      name: 'register_connection',
      arguments: {},
      connectionCapability: 'dvsc_existing',
      includeMeta: true,
      onResultMeta: (meta) => {
        callbackMeta = meta
      },
    })
    assert.equal(request.headers['x-devspec-connection-capability'], 'dvsc_existing')
    assert.equal(result.data.connection_id, 'connection')
    assert.equal(result.meta.devspec.connection_capability.value, 'dvsc_secret')
    assert.equal(callbackMeta.devspec.connection_capability.value, 'dvsc_secret')
  } finally {
    globalThis.fetch = original
  }
})

/**
 * x-devspec-plugin on the wire (item 7a01644a). The plugin's scripts reach DevSpec
 * through two requests: mcpToolsCall (every tool call, register, poll, and the check
 * of a new browser sign-in) and the poller's push channel. A real socket
 * receiving each is the closest check short of the server recording the header
 * (DevSpec item 2295e089 builds that).
 */
it('names this plugin and its running version on every DevSpec request the scripts make', async () => {
  const http = await import('node:http')
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { openPushChannel } = await import('./devspec-remote-poll.mjs')
  const version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
  const seen = []
  const server = http.createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const tool = body ? JSON.parse(body).params?.name : `GET ${new URL(req.url, 'http://x').pathname}`
    seen.push({ tool, plugin: req.headers['x-devspec-plugin'] ?? null, capability: req.headers['x-devspec-connection-capability'] ?? null })
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end()
      return
    }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{"ok":true}' }] } }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const mcpUrl = `http://127.0.0.1:${server.address().port}/api/mcp`
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-header-wire-'))
  try {
    await mcpToolsCall({ mcpUrl, token: 'dvs_fixture', name: 'get_task', arguments: {} })
    await mcpToolsCall({ mcpUrl, token: 'dvs_fixture', name: 'register_connection', arguments: {} })
    await mcpToolsCall({ mcpUrl, token: 'dvs_fixture', name: 'poll_connection', arguments: { connection_id: 'c' }, connectionCapability: 'dvsc_fixture', timeoutMs: 5_000 })
    const channel = openPushChannel({ mcpUrl, token: 'dvs_fixture', connectionId: 'c', connectionCapability: 'dvsc_fixture', onEvent: () => {}, onFallback: () => {} })
    for (let i = 0; i < 100 && !seen.some((entry) => entry.tool.startsWith('GET ')); i++) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    channel.close()
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(home, { recursive: true, force: true })
  }
  const expected = `antigravity/${version}`
  assert.deepEqual(seen.slice(0, 3), [
    { tool: 'get_task', plugin: expected, capability: null },
    { tool: 'register_connection', plugin: expected, capability: null },
    { tool: 'poll_connection', plugin: expected, capability: 'dvsc_fixture' },
  ])
  assert.ok(seen.some((entry) => entry.tool === 'GET /api/mcp/connection-stream' && entry.plugin === expected && entry.capability === 'dvsc_fixture'), JSON.stringify(seen))
})

/**
 * DevSpec refuses a credential (item 7f862114): the person hears it in plain words
 * with how to sign in again, never a raw HTTP error, and a browser login refused
 * because Antigravity was disconnected ends, so the next use says so too.
 */
it('a refused sign-in is said plainly, and a disconnected browser login ends', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { saveLogin, loginState } = await import('./auth-store.mjs')
  const { startSignInServer } = await import('./sign-in-test-fixtures.mjs')
  const fake = await startSignInServer()
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-refused-'))
  const savedHome = process.env.HOME
  const savedToken = process.env.DEVSPEC_MCP_TOKEN
  process.env.HOME = home
  delete process.env.DEVSPEC_MCP_TOKEN
  try {
    const now = Date.now()
    await saveLogin(
      {
        endpoint: fake.mcpUrl,
        tokens: { accessToken: 'oat_disconnected', refreshToken: 'rt_x', issuedAt: now, expiresAt: now + 86_400_000 },
        issuer: fake.base,
        tokenEndpoint: `${fake.base}/oauth/token`,
        clientId: 'TucS1MNZZlWpOUc7',
        resource: fake.mcpUrl,
      },
      { home },
    )
    const said = 'This tool was disconnected from your DevSpec account. You can reconnect it from Agent setup in your DevSpec settings.'
    fake.refuse('oat_disconnected', 401, { error: said, code: 'signed_out', retryable: false })
    const refused = await mcpToolsCall({ mcpUrl: fake.mcpUrl, token: 'oat_disconnected', name: 'get_task', arguments: {} }).catch((e) => e)
    assert.equal(refused.message, `${said} Then run /devspec-login to sign in again.`)
    assert.equal(refused.status, 401)
    assert.equal(refused.serverCode, 'signed_out')
    assert.equal(loginState(fake.mcpUrl, { home }).kind, 'ended')

    process.env.DEVSPEC_MCP_TOKEN = 'dvs_ci_token_123456'
    fake.refuse('dvs_ci_token_123456', 401, { error: 'Invalid or revoked API token', code: 'invalid_api_token', retryable: false })
    const envRefused = await mcpToolsCall({ mcpUrl: fake.mcpUrl, token: 'dvs_ci_token_123456', name: 'get_task', arguments: {} }).catch((e) => e)
    assert.match(envRefused.message, /DevSpec did not accept the token in DEVSPEC_MCP_TOKEN/)
  } finally {
    process.env.HOME = savedHome
    if (savedToken === undefined) delete process.env.DEVSPEC_MCP_TOKEN
    else process.env.DEVSPEC_MCP_TOKEN = savedToken
    fs.rmSync(home, { recursive: true, force: true })
    await fake.close()
  }
})
