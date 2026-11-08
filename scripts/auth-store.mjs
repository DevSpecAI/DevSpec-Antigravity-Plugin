/**
 * The Antigravity plugin's own login file for its background features (remote
 * control, commit tracking and the hooks): `~/.devspec/antigravity/auth.json`, 0600
 * in a 0700 folder.
 *
 * One browser sign-in per DevSpec server, keyed by the server's normalized tool
 * endpoint, so a staging login and a production login sit side by side and switching
 * servers never needs a fresh login. A login is saved only under the server it was
 * discovered, approved and verified on. No other plugin reads or writes this file,
 * and this plugin reads no other tool's login (sign-in is once per tool, decision
 * 912b3b3e; logins are per tool, decision 23570432).
 *
 * Renewal: Clerk rotates the renewal key on every use and ends the whole grant if one
 * is used twice, so every renewal holds an exclusive lock on the file across this
 * plugin's processes and re-reads the file after taking the lock, because another
 * process may already have renewed. A token is renewed once it is past half its life,
 * so any token handed out still has at least half its life left.
 *
 * Ported from the Pi plugin's extensions/core/auth-store.ts; each plugin owns its
 * own copy.
 */

import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { normalizeResource, refreshTokens, SignInEndedError } from './oauth.mjs'
import { privateStateRoot, readPrivateJsonResult, STATE_OK, writePrivateJson } from './private-state.mjs'

const STORE_VERSION = 1

/**
 * A lock older than this is abandoned. A holder only renews (one network round trip,
 * bounded by SIGN_IN_REQUEST_TIMEOUT_MS) or writes the file, so a live holder always
 * finishes well inside it.
 */
export const LOCK_STALE_MS = 60_000
const LOCK_RETRY_MS = 50

/** The folder this plugin keeps its sign-in files in. */
export function authDir(home = os.homedir()) {
  return path.join(privateStateRoot(home), 'antigravity')
}

export function authFilePath(home = os.homedir()) {
  return path.join(authDir(home), 'auth.json')
}

export function lockPath(home = os.homedir()) {
  return `${authFilePath(home)}.lock`
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/**
 * Renew once an access token is past half its life, so any token handed out still
 * has at least half its life left: long-running work (a poller, a retry loop) never
 * holds one about to stop working.
 */
export function needsRenewal(login, now = Date.now()) {
  const issued = Date.parse(login?.issuedAt)
  const expires = Date.parse(login?.expiresAt)
  if (!Number.isFinite(issued) || !Number.isFinite(expires)) return true
  return now >= issued + (expires - issued) / 2
}

export function isExpired(login, now = Date.now()) {
  const expires = Date.parse(login?.expiresAt)
  return !Number.isFinite(expires) || now >= expires
}

/**
 * The stable identity of a browser login (64 hex characters): its sign-in server,
 * sign-in app and a random id saved with it, so it stays the same across the daily
 * token change. Never a secret.
 */
export function loginPrincipal(login) {
  return sha256(`devspec-antigravity-login\0${login.issuer}\0${login.clientId}\0${login.loginId}`)
}

function isLogin(v) {
  return (
    !!v &&
    typeof v === 'object' &&
    typeof v.accessToken === 'string' &&
    typeof v.refreshToken === 'string' &&
    typeof v.issuedAt === 'string' &&
    typeof v.expiresAt === 'string' &&
    typeof v.issuer === 'string' &&
    typeof v.tokenEndpoint === 'string' &&
    typeof v.clientId === 'string' &&
    typeof v.resource === 'string' &&
    typeof v.loginId === 'string'
  )
}

/** The whole store; a missing, corrupt or foreign file reads as no logins. */
export function readStore({ home = os.homedir() } = {}) {
  const result = readPrivateJsonResult(authFilePath(home))
  const logins = {}
  if (result.status === STATE_OK && result.value?.version === STORE_VERSION && result.value.logins) {
    for (const [key, value] of Object.entries(result.value.logins)) {
      if (isLogin(value)) logins[key] = value
    }
  }
  return { version: STORE_VERSION, logins }
}

/** Written aside at 0600 and renamed, so a reader never sees half a file. */
function writeStore(store, home) {
  writePrivateJson(authFilePath(home), store, { root: privateStateRoot(home) })
}

/**
 * What the store holds for one server: `{ kind: 'none' }`, `{ kind: 'active', login }`
 * or `{ kind: 'ended', login }` (DevSpec ended it; the person must sign in again).
 */
export function loginState(endpoint, { home = os.homedir() } = {}) {
  const login = readStore({ home }).logins[normalizeResource(endpoint)]
  if (!login) return { kind: 'none' }
  return login.endedAt ? { kind: 'ended', login } : { kind: 'active', login }
}

function lockHolderGone(file) {
  try {
    const info = fs.statSync(file)
    if (Date.now() - info.mtimeMs > LOCK_STALE_MS) return info.mtimeMs
    const holder = Number.parseInt(fs.readFileSync(file, 'utf8'), 10)
    if (!Number.isInteger(holder) || holder <= 0) return null
    try {
      process.kill(holder, 0)
      return null
    } catch (err) {
      return err?.code === 'ESRCH' ? info.mtimeMs : null
    }
  } catch {
    return null
  }
}

/** Whether another process holds the store lock right now. */
export function lockHeld({ home = os.homedir() } = {}) {
  const file = lockPath(home)
  try {
    fs.statSync(file)
  } catch {
    return false
  }
  return lockHolderGone(file) === null
}

/** Run `work` holding the store's exclusive lock across this plugin's processes. */
export async function withStoreLock(work, { home = os.homedir() } = {}) {
  const file = lockPath(home)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  for (;;) {
    try {
      const handle = await fsp.open(file, 'wx', 0o600)
      try {
        await handle.writeFile(String(process.pid))
      } finally {
        await handle.close()
      }
      break
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err
      const stale = lockHolderGone(file)
      if (stale !== null) {
        // Clear it only if it is still the lock judged stale, not one a waiter beside
        // us has just taken.
        const now = await fsp.stat(file).catch(() => null)
        if (now?.mtimeMs === stale) await fsp.rm(file, { force: true })
        continue
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS))
    }
  }
  try {
    return await work()
  } finally {
    await fsp.rm(file, { force: true })
  }
}

/** Save a new sign-in under the server it was approved for, replacing only that server's. */
export async function saveLogin(
  { endpoint, tokens, issuer, tokenEndpoint, revocationEndpoint, clientId, resource, signedInAs },
  { home = os.homedir() } = {},
) {
  if (normalizeResource(resource) !== normalizeResource(endpoint)) {
    throw new Error('A sign-in can only be saved for the server it was approved for.')
  }
  const login = {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    issuedAt: new Date(tokens.issuedAt).toISOString(),
    expiresAt: new Date(tokens.expiresAt).toISOString(),
    issuer,
    tokenEndpoint,
    ...(revocationEndpoint ? { revocationEndpoint } : {}),
    clientId,
    resource,
    loginId: randomUUID(),
    ...(signedInAs ? { signedInAs } : {}),
    savedAt: new Date().toISOString(),
  }
  await withStoreLock(
    async () => {
      const store = readStore({ home })
      store.logins[normalizeResource(endpoint)] = login
      writeStore(store, home)
    },
    { home },
  )
  return login
}

/** Remove the sign-in for one server only. Returns what was removed, if anything. */
export async function removeLogin(endpoint, { home = os.homedir() } = {}) {
  return withStoreLock(
    async () => {
      const store = readStore({ home })
      const key = normalizeResource(endpoint)
      const login = store.logins[key] ?? null
      if (login) {
        delete store.logins[key]
        writeStore(store, home)
      }
      return login
    },
    { home },
  )
}

/**
 * Renew one server's login if it is past half its life. Takes the lock and re-reads
 * the file first, because another process may already have renewed. A refusal to
 * renew (`invalid_grant`) ends the login; any other failure keeps it and hands back
 * the token it has. Returns the login as it now stands, or null when there is none.
 */
export async function renewLogin(endpoint, { home = os.homedir(), refresh = refreshTokens, now = () => Date.now() } = {}) {
  const key = normalizeResource(endpoint)
  return withStoreLock(
    async () => {
      const store = readStore({ home })
      const login = store.logins[key]
      if (!login || login.endedAt) return login ?? null
      if (!needsRenewal(login, now())) return login
      try {
        const tokens = await refresh({
          tokenEndpoint: login.tokenEndpoint,
          clientId: login.clientId,
          refreshToken: login.refreshToken,
          resource: login.resource,
        })
        login.accessToken = tokens.accessToken
        login.refreshToken = tokens.refreshToken
        login.issuedAt = new Date(tokens.issuedAt).toISOString()
        login.expiresAt = new Date(tokens.expiresAt).toISOString()
        delete login.renewalFailedAt
        writeStore(store, home)
      } catch (err) {
        if (err instanceof SignInEndedError) {
          login.endedAt = new Date().toISOString()
          login.endedReason = 'renewal_refused'
        } else {
          login.renewalFailedAt = new Date().toISOString()
        }
        writeStore(store, home)
      }
      return login
    },
    { home },
  )
}

/**
 * DevSpec refused this server's login because the person disconnected Antigravity on
 * the Agent setup page: end it, so every later use says so plainly instead of
 * failing quietly. Only the token that was refused can end it; a newer sign-in made
 * since is left alone.
 */
export async function markLoginEnded(endpoint, accessToken, reason, { home = os.homedir() } = {}) {
  const key = normalizeResource(endpoint)
  return withStoreLock(
    async () => {
      const store = readStore({ home })
      const login = store.logins[key]
      if (!login || login.endedAt || login.accessToken !== accessToken) return false
      login.endedAt = new Date().toISOString()
      login.endedReason = reason
      writeStore(store, home)
      return true
    },
    { home },
  )
}

/** Record who a saved login acts as, once DevSpec has said. */
export async function setSignedInAs(endpoint, loginId, signedInAs, { home = os.homedir() } = {}) {
  await withStoreLock(
    async () => {
      const store = readStore({ home })
      const login = store.logins[normalizeResource(endpoint)]
      if (!login || login.loginId !== loginId) return
      login.signedInAs = signedInAs
      writeStore(store, home)
    },
    { home },
  )
}
