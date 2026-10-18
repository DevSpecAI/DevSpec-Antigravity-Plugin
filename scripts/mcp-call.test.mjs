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
 * through three requests: mcpToolsCall (every tool call, register and poll), the
 * token check before auth is pinned, and the poller's push channel. A real socket
 * receiving each is the closest check short of the server recording the header
 * (DevSpec item 2295e089 builds that).
 */
it('names this plugin and its running version on every DevSpec request the scripts make', async () => {
  const http = await import('node:http')
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { verifyAndPinDevspecAuth } = await import('./resolve-mcp-auth.mjs')
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
    // The token check reads its candidates from the Antigravity config under home.
    fs.mkdirSync(path.join(home, '.gemini', 'config'), { recursive: true })
    fs.writeFileSync(path.join(home, '.gemini', 'config', 'mcp_config.json'), JSON.stringify({ mcpServers: { devspec: { serverUrl: mcpUrl, headers: { Authorization: 'Bearer dvs_fixture_token' } } } }))
    await verifyAndPinDevspecAuth(home, { env: {}, home, platform: 'linux' })
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
  assert.deepEqual(seen.slice(0, 4), [
    { tool: 'get_task', plugin: expected, capability: null },
    { tool: 'register_connection', plugin: expected, capability: null },
    { tool: 'poll_connection', plugin: expected, capability: 'dvsc_fixture' },
    { tool: 'verify_agent_connection', plugin: expected, capability: null },
  ])
  assert.ok(seen.some((entry) => entry.tool === 'GET /api/mcp/connection-stream' && entry.plugin === expected && entry.capability === 'dvsc_fixture'), JSON.stringify(seen))
})
