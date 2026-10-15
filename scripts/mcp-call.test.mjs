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
