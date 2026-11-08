#!/usr/bin/env node
/**
 * The DevSpec server and credential the plugin's background features use: the
 * poller, listener, connect script, turn mirroring, commit tracking and the hooks.
 *
 * Antigravity's own DevSpec tools sign in through Antigravity itself (the plugin's
 * bundled mcp_config.json names Antigravity's sign-in app), and Antigravity keeps
 * that credential where these scripts cannot read it. So the background features
 * have their own browser sign-in, as Antigravity, in this plugin's own login file
 * (auth-store.mjs). They resolve:
 *
 *   1. DEVSPEC_MCP_TOKEN, for machines with no browser (CI, cloud workers). It goes
 *      to DEVSPEC_MCP_URL, or this install's server when that is unset, and it wins
 *      outright; interactive surfaces say so (sign-in-messages.mjs).
 *   2. Otherwise this plugin's browser login for this install's server
 *      (devspec-server.mjs), renewed once past half its life.
 *
 * The server and its credential always stay paired: a login is only ever sent to the
 * server it was saved for, and a server address from the environment never redirects
 * a saved login. Nothing here reads another tool's login file, Antigravity's
 * settings, or a token pasted into a config file.
 *
 * Renewal from synchronous code: a hook cannot hold a network round trip open, and a
 * renewal killed half-way (by a hook timeout) would lose Clerk's freshly rotated
 * renewal key and end the grant. So renewal always runs in a detached
 * `devspec-login.mjs --renew` process that finishes on its own; a caller waits a few
 * seconds for the file to change and otherwise carries on with the token it has,
 * which still has up to half its life left.
 *
 * This plugin owns every script in it: nothing here is shared with, or synced from,
 * another DevSpec plugin.
 *
 * Run as a command it prints JSON: { ok, token_fingerprint?, mcp_url?, source?, error? }.
 * It never prints the key itself (item b17cb7d7). Scripts that need the key import
 * `resolveDevspecMcpAuth` and keep it in memory.
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { lockHeld, loginPrincipal, loginState, needsRenewal } from './auth-store.mjs'
import { configuredServer, PRODUCTION_MCP_URL } from './devspec-server.mjs'
import { isEntryPoint } from './entry-point.mjs'
import { normalizeResource } from './oauth.mjs'
import { envToken, notSignedInMessage, signInEndedMessage, URL_ENV_VAR } from './sign-in-messages.mjs'

export const DEFAULT_PROD_URL = PRODUCTION_MCP_URL

const LOGIN_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'devspec-login.mjs')

/** How long a caller waits for a background renewal before using the token it has. */
export const RENEW_WAIT_MS = 5_000

/**
 * How a key is shown wherever this plugin reports one: the first twelve characters,
 * as DevSpec shows a pasted token under Access tokens, and nothing an attacker could
 * use. Never the key itself.
 */
export function tokenFingerprint(token) {
  if (typeof token !== 'string' || !token.trim()) return null
  return `${token.trim().slice(0, 12)}…`
}

/** An auth result with the key replaced by its fingerprint, for printing. */
export function printableAuth(result) {
  if (!result || typeof result !== 'object') return result
  const { token, ...rest } = result
  return token ? { ...rest, token_fingerprint: tokenFingerprint(token) } : rest
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * After a renewal that failed for a passing reason (offline, a slow network), wait
 * this long before trying again, and never wait on one twice in a row in the same
 * process: a hook that reads many connection states must not stall on each.
 */
export const RENEW_RETRY_MS = 60_000
const lastWaited = new Map()

/**
 * Renew in a detached process (unless one is already renewing) and wait up to
 * `waitMs` for the file to show the outcome. Returns the login as it then stands.
 */
function renewInBackground(mcpUrl, login, { home, waitMs, spawnImpl }) {
  const started = Date.now()
  const failedBefore = Date.parse(login.renewalFailedAt ?? '')
  if (started - failedBefore < RENEW_RETRY_MS) return login
  const waitedBefore = lastWaited.get(mcpUrl) ?? -Infinity
  if (started - waitedBefore < RENEW_RETRY_MS) waitMs = 0
  else lastWaited.set(mcpUrl, started)
  if (!lockHeld({ home })) {
    try {
      spawnImpl(process.execPath, [LOGIN_SCRIPT, '--renew', '--server', mcpUrl], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, HOME: home, USERPROFILE: home },
      }).unref()
    } catch {
      return login
    }
  }
  for (;;) {
    const now = loginState(mcpUrl, { home })
    if (now.kind !== 'active') return now.kind === 'ended' ? now.login : null
    const failedAt = Date.parse(now.login.renewalFailedAt ?? '')
    if (now.login.accessToken !== login.accessToken || !needsRenewal(now.login) || failedAt >= started - 1_000) {
      return now.login
    }
    if (Date.now() - started >= waitMs) return now.login
    sleepSync(50)
  }
}

/**
 * The browser login for one server, renewed first when it is past half its life.
 * `{ ok: true, token, mcp_url, source: 'login', principal, signed_in_as }`, or
 * `{ ok: false, mcp_url, reason, error }` with the plain message for the person.
 */
export function resolveLoginFor(
  mcpUrl,
  { home = os.homedir(), renew = true, waitMs = RENEW_WAIT_MS, spawnImpl = spawn } = {},
) {
  const key = normalizeResource(mcpUrl)
  const state = loginState(key, { home })
  if (state.kind === 'none') {
    return { ok: false, mcp_url: key, reason: 'not_signed_in', error: notSignedInMessage(key) }
  }
  let login = state.login
  if (state.kind === 'active' && renew && needsRenewal(login)) {
    login = renewInBackground(key, login, { home, waitMs, spawnImpl })
  }
  if (!login) return { ok: false, mcp_url: key, reason: 'not_signed_in', error: notSignedInMessage(key) }
  if (login.endedAt) {
    return { ok: false, mcp_url: key, reason: 'sign_in_ended', error: signInEndedMessage(key) }
  }
  return {
    ok: true,
    token: login.accessToken,
    mcp_url: key,
    source: 'login',
    principal: loginPrincipal(login),
    ...(login.signedInAs ? { signed_in_as: login.signedInAs } : {}),
  }
}

/**
 * The credential for the background features. `cwd` is accepted for the many callers
 * that pass one; the server no longer depends on the folder.
 */
export function resolveDevspecMcpAuth(_cwd = process.cwd(), opts = {}) {
  const env = opts.env || process.env
  const home = opts.home || os.homedir()
  const fromEnv = envToken(env)
  if (fromEnv) {
    const named = typeof env[URL_ENV_VAR] === 'string' && env[URL_ENV_VAR].trim() ? env[URL_ENV_VAR].trim() : null
    let mcpUrl
    try {
      mcpUrl = normalizeResource(named || configuredServer({ pluginRoot: opts.pluginRoot }))
    } catch {
      return { ok: false, mcp_url: null, reason: 'bad_url', error: `${URL_ENV_VAR} is not a valid address.` }
    }
    // The same fingerprint an environment token always had.
    return { ok: true, token: fromEnv, mcp_url: mcpUrl, source: 'env', principal: sha256(fromEnv) }
  }
  return resolveLoginFor(configuredServer({ pluginRoot: opts.pluginRoot }), {
    home,
    renew: opts.renew !== false,
    ...(opts.waitMs !== undefined ? { waitMs: opts.waitMs } : {}),
    ...(opts.spawnImpl ? { spawnImpl: opts.spawnImpl } : {}),
  })
}

/**
 * Connection state written from a browser login keeps the token it was written with,
 * which changes about daily. Every reader of connection state goes through this, so
 * a poller, hook or bridge always sends the login's current token, to the server the
 * state names, and never switches to a different identity (an environment token set
 * later does not take over a connection made with the browser login).
 */
export function stateWithCurrentToken(state, opts = {}) {
  if (!state || typeof state !== 'object' || state.auth_source !== 'login' || typeof state.mcp_url !== 'string') {
    return state
  }
  let auth
  try {
    auth = resolveLoginFor(state.mcp_url, { home: opts.home || os.homedir(), ...(opts.renew === false ? { renew: false } : {}) })
  } catch {
    return state
  }
  // No usable login: keep the stale token, so DevSpec's refusal says what to do.
  if (!auth.ok || auth.token === state.token) return state
  return { ...state, token: auth.token, auth_principal: auth.principal }
}

/**
 * The server and token to use for a connection: the state's own pair, or, when the
 * state lacks one, the background features' credential, but only if it is for the
 * same server the state names. A credential never goes to a server it was not saved
 * for. Returns `{ token, mcpUrl }` or null.
 */
export function connectionCredential(state, opts = {}) {
  const fresh = stateWithCurrentToken(state, opts)
  if (fresh?.token && fresh?.mcp_url) return { token: fresh.token, mcpUrl: fresh.mcp_url }
  const auth = resolveDevspecMcpAuth(fresh?.cwd || process.cwd(), opts)
  if (!auth.ok) return null
  if (fresh?.mcp_url) {
    let named
    try {
      named = normalizeResource(fresh.mcp_url)
    } catch {
      return null
    }
    if (named !== auth.mcp_url) return null
  }
  return { token: auth.token, mcpUrl: auth.mcp_url }
}

/**
 * What identifies the credential a connection state was written with, for "is this
 * the same connection as before" checks: a browser login's stable principal, or an
 * environment or older token's own value, exactly as those checks always used it.
 */
export function credentialIdentity(state) {
  if (!state || typeof state !== 'object') return null
  if (state.auth_source === 'login' && typeof state.auth_principal === 'string' && state.auth_principal) {
    return state.auth_principal
  }
  return typeof state.token === 'string' && state.token ? state.token : null
}

// CLI: diagnostics only. The key is reported by its fingerprint.
if (isEntryPoint(import.meta.url)) {
  const result = resolveDevspecMcpAuth(process.cwd())
  process.stdout.write(JSON.stringify(printableAuth(result)) + '\n')
  process.exit(result.ok ? 0 : 1)
}
