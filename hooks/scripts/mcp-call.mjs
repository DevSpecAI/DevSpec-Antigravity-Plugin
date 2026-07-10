#!/usr/bin/env node
/**
 * Minimal JSON-RPC tools/call against DevSpec streamable HTTP MCP.
 */

export async function mcpToolsCall({ mcpUrl, token, name, arguments: toolArgs }) {
  const body = {
    jsonrpc: '2.0',
    id: Date.now(),
    method: 'tools/call',
    params: { name, arguments: toolArgs || {} },
  }

  const res = await fetch(mcpUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(body),
  })

  const text = await res.text()
  if (!res.ok) {
    throw new Error(`MCP HTTP ${res.status}: ${text.slice(0, 400)}`)
  }

  // Parse JSON or SSE-ish responses
  let payload = null
  try {
    payload = JSON.parse(text)
  } catch {
    // SSE: lines like data: {...}
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.startsWith('data:')) {
        try {
          payload = JSON.parse(trimmed.slice(5).trim())
          break
        } catch {
          /* continue */
        }
      }
    }
  }

  if (!payload) {
    throw new Error(`Unparseable MCP response: ${text.slice(0, 200)}`)
  }
  if (payload.error) {
    throw new Error(payload.error.message || JSON.stringify(payload.error))
  }

  // tools/call result content is usually { content: [{ type:'text', text:'...' }], isError? }
  const content = payload.result?.content
  if (Array.isArray(content)) {
    const textParts = content
      .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
    const joined = textParts.join('\n')
    if (payload.result?.isError) {
      throw new Error(joined || 'MCP tool error')
    }
    try {
      return JSON.parse(joined)
    } catch {
      return { raw: joined, result: payload.result }
    }
  }
  return payload.result ?? payload
}
