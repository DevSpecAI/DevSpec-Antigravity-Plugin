#!/usr/bin/env node
/**
 * Local stdio-to-Streamable-HTTP MCP bridge for Antigravity (`mcp_config.json`).
 *
 * Antigravity's built-in `/mcp` OAuth token store caches single-use Clerk
 * refresh tokens in memory per `agy` process without locking or re-reading
 * disk before refreshing, so running multiple Antigravity windows causes a
 * second window to replay a spent refresh token after 24 hours (`invalid_grant`).
 *
 * Routing the bundled `devspec` MCP server through this stdio bridge lets both
 * DevSpec's tools and the plugin's background features share the single
 * browser sign-in in `~/.devspec/antigravity/auth.json`, renewed under the
 * cross-process lock in `auth-store.mjs`.
 */

import os from 'node:os'
import readline from 'node:readline'
import { loginState, markLoginEnded, needsRenewal, renewLogin } from './auth-store.mjs'
import { pluginHeaders } from './connection-version.mjs'
import { configuredServer } from './devspec-server.mjs'
import { isEntryPoint } from './entry-point.mjs'
import { readServerFailure } from './mcp-call.mjs'
import { normalizeResource } from './oauth.mjs'
import { envToken, notSignedInMessage, refusedCredentialMessage, signInEndedMessage } from './sign-in-messages.mjs'

const DEFAULT_RENEW_TIMEOUT_MS = 8_000
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000

function envServerUrl(env = process.env) {
  const raw = typeof env?.DEVSPEC_MCP_URL === 'string' ? env.DEVSPEC_MCP_URL.trim() : ''
  if (raw && !raw.startsWith('${') && /^https?:\/\//i.test(raw)) return normalizeResource(raw)
  return null
}

export function resolveBridgeServerUrl(argUrl, { pluginRoot } = {}) {
  const trimmed = typeof argUrl === 'string' ? argUrl.trim() : ''
  if (trimmed && /^https?:\/\//i.test(trimmed)) return normalizeResource(trimmed)
  return configuredServer({ pluginRoot })
}

/**
 * Resolve the current credential for a bridge request, renewing at half-life
 * under the cross-process lock (bounded by `renewTimeoutMs` so a slow Clerk
 * endpoint falls back to the still-valid current token rather than hanging a
 * tool call).
 */
export async function resolveBridgeAuth(
  serverUrl,
  { env = process.env, home = os.homedir(), renewTimeoutMs = DEFAULT_RENEW_TIMEOUT_MS, renew = renewLogin } = {},
) {
  const normalizedUrl = normalizeResource(serverUrl)
  const fromEnv = envToken(env)
  if (fromEnv) {
    return {
      ok: true,
      token: fromEnv,
      mcp_url: envServerUrl(env) ?? normalizedUrl,
      source: 'env',
    }
  }

  const state = loginState(normalizedUrl, { home })
  if (state.kind === 'active') {
    let login = state.login
    if (needsRenewal(login)) {
      let timer = null
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve('timeout'), renewTimeoutMs)
        timer.unref?.()
      })
      const outcome = await Promise.race([
        Promise.resolve().then(() => renew(normalizedUrl, { home })).catch(() => null),
        timeout,
      ]).finally(() => {
        if (timer) clearTimeout(timer)
      })
      if (outcome && outcome !== 'timeout' && typeof outcome.accessToken === 'string') {
        login = outcome
      } else if (outcome !== 'timeout') {
        const after = loginState(normalizedUrl, { home })
        if (after.kind === 'ended') {
          return {
            ok: false,
            mcp_url: normalizedUrl,
            reason: 'sign_in_ended',
            error: signInEndedMessage(normalizedUrl),
          }
        }
        if (after.kind === 'active') login = after.login
      }
    }
    return {
      ok: true,
      token: login.accessToken,
      mcp_url: normalizedUrl,
      source: 'login',
    }
  }

  if (state.kind === 'ended') {
    return {
      ok: false,
      mcp_url: normalizedUrl,
      reason: 'sign_in_ended',
      error: signInEndedMessage(normalizedUrl),
    }
  }

  return {
    ok: false,
    mcp_url: normalizedUrl,
    reason: 'not_signed_in',
    error: notSignedInMessage(normalizedUrl),
  }
}

function formatErrorReply(msg, message) {
  if (msg?.method === 'tools/call') {
    return {
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        content: [{ type: 'text', text: message }],
        isError: true,
      },
    }
  }
  return {
    jsonrpc: '2.0',
    id: msg.id,
    error: {
      code: -32000,
      message,
    },
  }
}

function parseJsonRpcResponse(raw, requestId) {
  const trimmed = String(raw ?? '').trim()
  if (trimmed) {
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object') {
        return { ...parsed, jsonrpc: '2.0', id: requestId }
      }
    } catch {
      /* may be SSE data: framing */
    }
  }
  let lastPayload = null
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    const data = line.slice(5).trim()
    if (!data || data === '[DONE]') continue
    try {
      const parsed = JSON.parse(data)
      if (parsed && typeof parsed === 'object') lastPayload = parsed
    } catch {
      /* ignore partial line */
    }
  }
  if (lastPayload) {
    return { ...lastPayload, jsonrpc: '2.0', id: requestId }
  }
  return null
}

/**
 * Handle one parsed JSON-RPC message and return the response object to write
 * to `stdout` (or `null` for notifications that take no response).
 */
export async function handleBridgeMessage(
  msg,
  {
    serverUrl,
    env = process.env,
    home = os.homedir(),
    pluginRoot,
    renewTimeoutMs = DEFAULT_RENEW_TIMEOUT_MS,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    fetchImpl = fetch,
    renew = renewLogin,
  } = {},
) {
  if (!msg || typeof msg !== 'object') return null
  if (msg.id === undefined || msg.id === null) return null
  if (msg.method === 'ping') {
    return { jsonrpc: '2.0', id: msg.id, result: {} }
  }

  const targetUrl = resolveBridgeServerUrl(serverUrl, { pluginRoot })
  const auth = await resolveBridgeAuth(targetUrl, { env, home, renewTimeoutMs, renew })
  if (!auth.ok) {
    return formatErrorReply(msg, auth.error)
  }

  let res
  let text = ''
  try {
    res = await fetchImpl(auth.mcp_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${auth.token}`,
        ...pluginHeaders(),
      },
      body: JSON.stringify(msg),
      signal: AbortSignal.timeout(requestTimeoutMs),
    })
    text = await res.text()
  } catch (err) {
    return formatErrorReply(msg, `Could not reach DevSpec MCP server (${auth.mcp_url}): ${err?.message || String(err)}`)
  }

  if (!res.ok) {
    const failure = readServerFailure(res.status, text)
    if (res.status === 401 && (failure.serverCode === 'signed_out' || failure.serverCode === 'invalid_api_token')) {
      if (auth.source === 'login' && failure.serverCode === 'signed_out') {
        await markLoginEnded(auth.mcp_url, auth.token, 'signed_out', { home }).catch(() => false)
      }
      const message = refusedCredentialMessage({
        serverCode: failure.serverCode,
        serverMessage: failure.serverMessage,
        source: auth.source,
      })
      return formatErrorReply(msg, message)
    }
    return formatErrorReply(msg, failure.serverMessage || `DevSpec MCP server returned HTTP ${res.status}`)
  }

  const rpcResponse = parseJsonRpcResponse(text, msg.id)
  if (!rpcResponse) {
    return formatErrorReply(msg, 'DevSpec MCP server returned an invalid JSON-RPC response.')
  }
  return rpcResponse
}

export function startBridge({
  input = process.stdin,
  output = process.stdout,
  serverUrl = process.argv[2],
  env = process.env,
  home = os.homedir(),
  pluginRoot,
} = {}) {
  const rl = readline.createInterface({ input, crlfDelay: Infinity })
  const pending = new Set()
  let closed = false

  rl.on('line', (line) => {
    const trimmed = line.trim()
    if (!trimmed) return
    let msg
    try {
      msg = JSON.parse(trimmed)
    } catch {
      return
    }
    const task = handleBridgeMessage(msg, { serverUrl, env, home, pluginRoot })
      .then((reply) => {
        if (reply && !closed) {
          output.write(`${JSON.stringify(reply)}\n`)
        }
      })
      .catch((err) => {
        if (msg?.id !== undefined && msg?.id !== null && !closed) {
          const fallback = formatErrorReply(msg, err?.message || String(err))
          output.write(`${JSON.stringify(fallback)}\n`)
        }
      })
      .finally(() => {
        pending.delete(task)
      })
    pending.add(task)
  })

  output.on?.('error', () => {
    closed = true
  })

  return new Promise((resolve) => {
    rl.on('close', async () => {
      await Promise.allSettled([...pending])
      resolve()
    })
  })
}

if (isEntryPoint(import.meta.url)) {
  await startBridge()
}
