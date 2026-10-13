#!/usr/bin/env node
/**
 * Minimal JSON-RPC tools/call against DevSpec streamable HTTP MCP.
 *
 * Optional `timeoutMs` and `isAlive` exist for the LONG-POLL tick (`poll_connection`
 * holds a request open for ~25s):
 *   - timeoutMs: fetch has no default timeout, so a silently-dropped TCP connection
 *     would otherwise wedge a held request — and therefore the poller's heartbeat —
 *     forever. Always set a ceiling above the server's own hold.
 *   - isAlive: polled while the request is in flight. Returning false aborts it, so a
 *     poller whose owning agent process died tears down immediately instead of after
 *     the hold expires (the anti-zombie contract).
 * Both throw an Error carrying `code` ('timeout' | 'owner_gone') so callers can tell a
 * deliberate abort from a network failure. Omitting them keeps the original behaviour.
 */

import { versionedConnectionArguments } from './connection-version.mjs'

export async function mcpToolsCall({
  mcpUrl,
  token,
  name,
  arguments: toolArgs,
  timeoutMs = 0,
  isAlive = null,
  aliveCheckMs = 2_000,
  connectionCapability = null,
  includeMeta = false,
}) {
  const body = {
    jsonrpc: '2.0',
    id: Date.now(),
    method: 'tools/call',
    params: { name, arguments: versionedConnectionArguments(name, toolArgs || {}) },
  }

  const controller = new AbortController()
  let abortCode = null
  let timeoutTimer = null
  let aliveTimer = null
  if (timeoutMs > 0) {
    timeoutTimer = setTimeout(() => {
      abortCode = 'timeout'
      controller.abort()
    }, timeoutMs)
    if (typeof timeoutTimer.unref === 'function') timeoutTimer.unref()
  }
  if (typeof isAlive === 'function') {
    aliveTimer = setInterval(() => {
      let alive = true
      try {
        alive = isAlive() !== false
      } catch {
        alive = true // a broken liveness probe must never kill a healthy request
      }
      if (!alive) {
        abortCode = 'owner_gone'
        controller.abort()
      }
    }, aliveCheckMs)
    if (typeof aliveTimer.unref === 'function') aliveTimer.unref()
  }

  let res
  try {
    res = await fetch(mcpUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(connectionCapability
          ? { 'x-devspec-connection-capability': connectionCapability }
          : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (e) {
    if (abortCode) {
      const err = new Error(`MCP call ${name} aborted: ${abortCode}`)
      err.code = abortCode
      throw err
    }
    throw e
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer)
    if (aliveTimer) clearInterval(aliveTimer)
  }

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
      let details = payload.result?.structuredContent ?? null
      if (!details) {
        try {
          details = JSON.parse(joined)
        } catch {
          /* older plain refusal */
        }
      }
      const err = new Error(joined || 'MCP tool error')
      err.details = details
      throw err
    }
    let data
    try {
      data = JSON.parse(joined)
    } catch {
      data = { raw: joined, result: payload.result }
    }
    return includeMeta ? { data, meta: payload.result?._meta ?? null } : data
  }
  const data = payload.result ?? payload
  return includeMeta ? { data, meta: payload.result?._meta ?? null } : data
}

export async function mcpToolsList({
  mcpUrl,
  token,
  connectionCapability = null,
  timeoutMs = 0,
} = {}) {
  const controller = new AbortController()
  let timeoutTimer = null
  if (timeoutMs > 0) {
    timeoutTimer = setTimeout(() => controller.abort(), timeoutMs)
    if (typeof timeoutTimer.unref === 'function') timeoutTimer.unref()
  }
  let res
  try {
    res = await fetch(mcpUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(connectionCapability
          ? { 'x-devspec-connection-capability': connectionCapability }
          : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/list',
        params: {},
      }),
      signal: controller.signal,
    })
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer)
  }
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`MCP HTTP ${res.status}: ${text.slice(0, 400)}`)
  }
  let payload = null
  try {
    payload = JSON.parse(text)
  } catch {
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
  return Array.isArray(payload.result?.tools) ? payload.result.tools : []
}

