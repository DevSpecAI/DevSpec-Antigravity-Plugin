#!/usr/bin/env node
/**
 * Sign the plugin's background features (remote control, commit tracking, the
 * hooks) in to DevSpec through the browser, as Antigravity.
 *
 *   node scripts/devspec-login.mjs             sign in here and wait for the browser
 *   node scripts/devspec-login.mjs --start     open the approval and return at once
 *                                              (what /devspec-login and the hooks do)
 *   node scripts/devspec-login.mjs --code      for a machine your browser cannot reach:
 *                                              prints a link; DevSpec's page then shows
 *                                              a code. In a terminal it asks for the
 *                                              code; otherwise run it again as
 *   node scripts/devspec-login.mjs --code "<code shown on the page>"
 *   node scripts/devspec-login.mjs --status    which server, and how it is signed in
 *   node scripts/devspec-login.mjs --logout    sign out of the current server only
 *
 * The server is always the one this install connects Antigravity to
 * (devspec-server.mjs), and a login is saved only under the server it was
 * discovered, approved and verified on.
 *
 * Every path brings the approval back through the person's own browser: a
 * short-lived listener on 127.0.0.1, or a code the person copies from DevSpec's page
 * (risk 65cc21b1). Nothing here polls DevSpec or Clerk for the result. The hooks
 * only ever wait for this machine's own login file to change.
 *
 * Internal: `--background` is the detached process the hooks and `--start` launch
 * (one at a time per server, however many hooks ask), and `--renew --server <url>`
 * renews a login past half its life on behalf of a hook that cannot wait for a
 * network round trip in-process.
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { authDir, loginState, removeLogin, renewLogin, saveLogin } from './auth-store.mjs'
import {
  agentsSettingsUrl,
  clientIdForIssuer,
  configuredServer,
  serverLabel,
  signInCodePageUrl,
} from './devspec-server.mjs'
import { isEntryPoint } from './entry-point.mjs'
import { mcpToolsCall } from './mcp-call.mjs'
import {
  beginCopyCodeSignIn,
  browserCanReachThisMachine,
  completeCopyCodeSignIn,
  discoverSignIn,
  normalizeResource,
  openInBrowser,
  revokeRefreshToken,
  SIGN_IN_WAIT_MS,
  SignInError,
  startLoopbackSignIn,
} from './oauth.mjs'
import { privateStateRoot, readPrivateJson, writePrivateJson } from './private-state.mjs'
import { envTokenNotice, envTokenSet } from './sign-in-messages.mjs'

const SCRIPT = fileURLToPath(import.meta.url)

/** How long a hook waits for the background process to have its link ready. */
const LINK_WAIT_MS = 3_000
/** A pending sign-in is abandoned once its listener has certainly closed. */
const PENDING_STALE_MS = SIGN_IN_WAIT_MS + 60_000

function serverKey(mcpUrl) {
  return createHash('sha256').update(normalizeResource(mcpUrl)).digest('hex').slice(0, 16)
}

export function pendingSignInPath(mcpUrl, home = os.homedir()) {
  return path.join(authDir(home), `sign-in-${serverKey(mcpUrl)}.pending.json`)
}

export function lastSignInPath(mcpUrl, home = os.homedir()) {
  return path.join(authDir(home), `sign-in-${serverKey(mcpUrl)}.last.json`)
}

function copyCodePath(mcpUrl, home = os.homedir()) {
  return path.join(authDir(home), `sign-in-${serverKey(mcpUrl)}.code.json`)
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err?.code === 'EPERM'
  }
}

/** The background sign-in waiting for the browser for this server, if one is. */
export function pendingSignIn(mcpUrl, { home = os.homedir(), now = Date.now() } = {}) {
  const pending = readPrivateJson(pendingSignInPath(mcpUrl, home))
  if (!pending || typeof pending !== 'object') return null
  const started = Date.parse(pending.startedAt)
  if (!pidAlive(pending.pid) || !Number.isFinite(started) || now - started > PENDING_STALE_MS) return null
  return pending
}

/** How the last background sign-in for this server ended, if one ran. */
export function lastSignIn(mcpUrl, { home = os.homedir() } = {}) {
  return readPrivateJson(lastSignInPath(mcpUrl, home))
}

/**
 * Remember how the last sign-in for this server went, or what the person was last
 * told about it, so a new window does not open the browser or repeat itself.
 */
export function recordSignInOutcome(mcpUrl, home, outcome, message = null, extra = {}) {
  try {
    writePrivateJson(
      lastSignInPath(mcpUrl, home),
      { outcome, at: new Date().toISOString(), ...(message ? { message } : {}), ...extra },
      { root: privateStateRoot(home) },
    )
  } catch {
    /* the store and the messages still say what happened */
  }
}

const recordOutcome = recordSignInOutcome

/**
 * Claim the one pending sign-in for this server. Exactly one process wins, however
 * many hooks start one at the same moment; a pending file left by a process that
 * died or outlived its listener is taken over.
 */
function claimPending(mcpUrl, home) {
  const file = pendingSignInPath(mcpUrl, home)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600)
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), server: normalizeResource(mcpUrl) }))
      fs.closeSync(fd)
      return true
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err
      if (pendingSignIn(mcpUrl, { home })) return false
      fs.rmSync(file, { force: true })
    }
  }
  return false
}

function releasePending(mcpUrl, home) {
  const file = pendingSignInPath(mcpUrl, home)
  const pending = readPrivateJson(file)
  if (pending?.pid === process.pid) fs.rmSync(file, { force: true })
}

function readablePrincipal(value) {
  if (typeof value !== 'string') return null
  const name = value.trim()
  if (!name || /^[{[]/.test(name) || /[\u0000-\u001f\u007f-\u009f]/.test(name)) return null
  return name
}

/** Who DevSpec says a credential acts as, from verify_agent_connection's structured fields only. */
export function principalFrom(result) {
  if (!result || typeof result !== 'object') return null
  for (const key of ['connected_as', 'name', 'user_name', 'display_name', 'email', 'principal']) {
    const name = readablePrincipal(result[key])
    if (name) return name
  }
  if (result.user && typeof result.user === 'object') {
    return readablePrincipal(result.user.name) ?? readablePrincipal(result.user.email)
  }
  return null
}

/**
 * Confirm DevSpec accepts a new sign-in at the very server it was approved for, then
 * save it under that server, so a saved login is always one that worked.
 */
async function finishSignIn({ mcpUrl, discovery, clientId, tokens, home, call = mcpToolsCall }) {
  let verified
  try {
    verified = await call({
      mcpUrl,
      token: tokens.accessToken,
      name: 'verify_agent_connection',
      arguments: {},
      timeoutMs: 20_000,
    })
  } catch (err) {
    throw new SignInError(`DevSpec did not accept the new sign-in: ${err instanceof Error ? err.message : String(err)}`)
  }
  const signedInAs = principalFrom(verified)
  const login = await saveLogin(
    {
      endpoint: mcpUrl,
      tokens,
      issuer: discovery.issuer,
      tokenEndpoint: discovery.tokenEndpoint,
      revocationEndpoint: discovery.revocationEndpoint,
      clientId,
      resource: discovery.resource,
      signedInAs: signedInAs ?? undefined,
    },
    { home },
  )
  try {
    fs.rmSync(lastSignInPath(mcpUrl, home), { force: true })
  } catch {
    /* only steers whether a hook opens the browser again */
  }
  return login
}

async function discover(mcpUrl, fetchImpl) {
  const discovery = await discoverSignIn(mcpUrl, fetchImpl)
  return { discovery, clientId: clientIdForIssuer(discovery.issuer) }
}

function signedInText(mcpUrl, login) {
  const who = login.signedInAs ? ` as ${login.signedInAs}` : ''
  return `Signed in to DevSpec ${serverLabel(mcpUrl)}${who}. Remote control and commit tracking are ready in Antigravity.`
}

/**
 * Sign in through the loopback listener and wait for the browser. `onLink` receives
 * the approval link as soon as it exists (the browser is opened too).
 */
export async function signInWithBrowser({
  mcpUrl = configuredServer(),
  home = os.homedir(),
  fetchImpl = fetch,
  open = openInBrowser,
  onLink = () => {},
  waitMs = SIGN_IN_WAIT_MS,
  call = mcpToolsCall,
} = {}) {
  const { discovery, clientId } = await discover(mcpUrl, fetchImpl)
  const pending = await startLoopbackSignIn({ discovery, clientId, waitMs }, fetchImpl)
  onLink(pending.url)
  open(pending.url)
  const tokens = await pending.done
  return finishSignIn({ mcpUrl, discovery, clientId, tokens, home, call })
}

/** Step one of copy-a-code: the link, with the secret half kept in an owner-only file. */
export async function beginCodeSignIn({ mcpUrl = configuredServer(), home = os.homedir(), fetchImpl = fetch } = {}) {
  const { discovery, clientId } = await discover(mcpUrl, fetchImpl)
  const flow = beginCopyCodeSignIn({ discovery, clientId, codePageUrl: signInCodePageUrl(mcpUrl) })
  writePrivateJson(
    copyCodePath(mcpUrl, home),
    {
      server: normalizeResource(mcpUrl),
      createdAt: new Date().toISOString(),
      discovery,
      clientId,
      verifier: flow.verifier,
      state: flow.state,
      redirectUri: flow.redirectUri,
    },
    { root: privateStateRoot(home) },
  )
  return flow.url
}

/** Step two of copy-a-code: exchange what the person pasted, if it is from this sign-in. */
export async function completeCodeSignIn(pasted, { mcpUrl = configuredServer(), home = os.homedir(), fetchImpl = fetch, call = mcpToolsCall } = {}) {
  const file = copyCodePath(mcpUrl, home)
  const saved = readPrivateJson(file)
  const created = Date.parse(saved?.createdAt)
  if (
    !saved ||
    saved.server !== normalizeResource(mcpUrl) ||
    !Number.isFinite(created) ||
    Date.now() - created > SIGN_IN_WAIT_MS
  ) {
    throw new SignInError('There is no sign-in waiting for a code. Start again with /devspec-login --code.')
  }
  const tokens = await completeCopyCodeSignIn(
    { discovery: saved.discovery, clientId: saved.clientId, pending: saved, pasted },
    fetchImpl,
  )
  fs.rmSync(file, { force: true })
  return finishSignIn({ mcpUrl, discovery: saved.discovery, clientId: saved.clientId, tokens, home, call })
}

/** Sign out of one server: forget its login here and cancel it at Clerk. */
export async function signOut({ mcpUrl = configuredServer(), home = os.homedir(), fetchImpl = fetch } = {}) {
  const removed = await removeLogin(mcpUrl, { home })
  // Signed out on purpose: a new window must not open the browser again by itself.
  recordOutcome(mcpUrl, home, 'signed_out')
  if (removed) {
    await revokeRefreshToken(
      { revocationEndpoint: removed.revocationEndpoint, clientId: removed.clientId, refreshToken: removed.refreshToken },
      fetchImpl,
    )
  }
  return removed
}

/**
 * Start the one background sign-in for this server and return without waiting for
 * the browser: what a hook, `/devspec-remote` and `/devspec-login` call. Never
 * blocks for more than a few seconds (only for the link to be ready).
 *
 * Returns `{ status }`, one of:
 * - `env`: DEVSPEC_MCP_TOKEN is set, so a browser sign-in would be ignored;
 * - `signed_in`: there is already an active login for this server;
 * - `needs_code`: the browser cannot reach this machine (SSH): use --code;
 * - `started` / `waiting`: a browser approval is open (`url` when known).
 */
export function startBackgroundSignIn({
  mcpUrl = configuredServer(),
  home = os.homedir(),
  env = process.env,
  spawnImpl = spawn,
  linkWaitMs = LINK_WAIT_MS,
} = {}) {
  if (envTokenSet(env)) return { status: 'env' }
  if (loginState(mcpUrl, { home }).kind === 'active') return { status: 'signed_in' }
  if (!browserCanReachThisMachine(env)) return { status: 'needs_code' }
  const existing = pendingSignIn(mcpUrl, { home })
  if (existing) return { status: 'waiting', url: existing.url ?? null }
  try {
    spawnImpl(process.execPath, [SCRIPT, '--background', '--server', normalizeResource(mcpUrl)], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...env, HOME: home, USERPROFILE: home },
    }).unref()
  } catch {
    return { status: 'failed' }
  }
  const startedAt = Date.now()
  const deadline = startedAt + linkWaitMs
  while (Date.now() < deadline) {
    const pending = pendingSignIn(mcpUrl, { home })
    if (pending?.url) return { status: 'started', url: pending.url }
    const last = lastSignIn(mcpUrl, { home })
    if (last?.outcome === 'failed' && Date.parse(last.at) >= startedAt - 1_000) {
      return { status: 'failed', message: last.message ?? null }
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
  }
  return { status: 'started', url: pendingSignIn(mcpUrl, { home })?.url ?? null }
}

/**
 * The one sign-in waiting for the browser for this server, in this process: the
 * detached process behind startBackgroundSignIn, or the command run in a terminal.
 * Returns null when another process already holds it (then nothing is opened).
 */
async function runPendingSignIn(mcpUrl, home, onLink = () => {}) {
  if (!claimPending(mcpUrl, home)) return null
  try {
    const login = await signInWithBrowser({
      mcpUrl,
      home,
      onLink: (url) => {
        writePrivateJson(
          pendingSignInPath(mcpUrl, home),
          { pid: process.pid, startedAt: new Date().toISOString(), server: normalizeResource(mcpUrl), url },
          { root: privateStateRoot(home) },
        )
        onLink(url)
      },
    })
    recordOutcome(mcpUrl, home, 'signed_in', login.signedInAs ? `Signed in as ${login.signedInAs}.` : null)
    return login
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const outcome = /canceled in the browser/.test(message) ? 'canceled' : /timed out/.test(message) ? 'timed_out' : 'failed'
    recordOutcome(mcpUrl, home, outcome, message)
    throw err
  } finally {
    releasePending(mcpUrl, home)
  }
}

/** The detached process behind startBackgroundSignIn: one per server at a time. */
async function runBackground(mcpUrl, home) {
  try {
    await runPendingSignIn(mcpUrl, home)
    return 0
  } catch {
    return 1
  }
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer)
    })
  })
}

function statusText(mcpUrl, env, home) {
  const label = serverLabel(mcpUrl)
  if (envTokenSet(env)) return `DevSpec ${label} (${mcpUrl}): using the token in DEVSPEC_MCP_TOKEN.\n${envTokenNotice()}`
  const state = loginState(mcpUrl, { home })
  if (state.kind === 'active') {
    return `DevSpec ${label} (${mcpUrl}): remote control and commit tracking are signed in through the browser${state.login.signedInAs ? ` as ${state.login.signedInAs}` : ''}.`
  }
  if (state.kind === 'ended') {
    return `DevSpec ${label} (${mcpUrl}): the sign-in for remote control and commit tracking has ended, for example because Antigravity was disconnected in Agent setup (${agentsSettingsUrl(mcpUrl)}). Run /devspec-login to sign in again.`
  }
  const pending = pendingSignIn(mcpUrl, { home })
  if (pending) return `DevSpec ${label} (${mcpUrl}): waiting for you to approve Antigravity in your browser${pending.url ? `. If you closed the tab, open this link:\n${pending.url}` : '.'}`
  return `DevSpec ${label} (${mcpUrl}): remote control and commit tracking are not signed in. Run /devspec-login to sign in.`
}

function startText(result, mcpUrl, pluginRoot) {
  const label = serverLabel(mcpUrl)
  switch (result.status) {
    case 'signed_in':
      return `Already signed in to DevSpec ${label} for remote control and commit tracking.`
    case 'needs_code':
      return `Your browser cannot reach this machine, so sign in with a code: run /devspec-login --code (or \`node "${path.join(pluginRoot, 'scripts', 'devspec-login.mjs')}" --code\`).`
    case 'failed':
      return `DevSpec sign-in could not start: ${result.message || 'see the message above'}`
    default:
      return result.url
        ? `Approve Antigravity on DevSpec's page in your browser to turn on remote control and commit tracking. If no browser tab opened, open this link:\n${result.url}`
        : 'Approve Antigravity on DevSpec\'s page in your browser to turn on remote control and commit tracking. Run /devspec-login --status for the link if no browser tab opened.'
  }
}

function argValue(argv, flag) {
  const i = argv.indexOf(flag)
  return i >= 0 && typeof argv[i + 1] === 'string' && !argv[i + 1].startsWith('--') ? argv[i + 1] : null
}

export async function main(argv = process.argv.slice(2), { env = process.env, home = os.homedir(), out = process.stdout, err = process.stderr } = {}) {
  const say = (text) => out.write(`${text}\n`)
  const warn = (text) => err.write(`${text}\n`)
  const pluginRoot = path.resolve(path.dirname(SCRIPT), '..')

  if (argv.includes('--renew')) {
    const server = argValue(argv, '--server')
    if (!server) return 2
    await renewLogin(server, { home }).catch(() => null)
    return 0
  }
  if (argv.includes('--background')) {
    // Only ever this install's server: a hook cannot be steered into signing in elsewhere.
    const server = argValue(argv, '--server') ?? configuredServer()
    if (normalizeResource(server) !== configuredServer()) return 2
    return runBackground(configuredServer(), home)
  }

  const mcpUrl = configuredServer()
  const label = serverLabel(mcpUrl)

  if (argv.includes('--status')) {
    say(statusText(mcpUrl, env, home))
    return 0
  }
  if (argv.includes('--logout')) {
    const removed = await signOut({ mcpUrl, home })
    say(removed ? `Signed out of DevSpec ${label} for remote control and commit tracking.` : `Remote control and commit tracking were not signed in to DevSpec ${label}.`)
    if (envTokenSet(env)) say(envTokenNotice())
    return 0
  }

  if (envTokenSet(env)) {
    warn(envTokenNotice())
    return 1
  }

  try {
    if (argv.includes('--start')) {
      say(startText(startBackgroundSignIn({ mcpUrl, home, env }), mcpUrl, pluginRoot))
      return 0
    }
    if (argv.includes('--code')) {
      const pasted = argValue(argv, '--code')
      if (pasted) {
        const login = await completeCodeSignIn(pasted, { mcpUrl, home })
        say(signedInText(mcpUrl, login))
        return 0
      }
      const url = await beginCodeSignIn({ mcpUrl, home })
      if (browserCanReachThisMachine(env)) openInBrowser(url)
      say(`Sign in to DevSpec ${label}: open this link in a browser, approve Antigravity, then copy the code the page shows.\n${url}`)
      if (!process.stdin.isTTY) {
        say(`Then run: node "${path.join(pluginRoot, 'scripts', 'devspec-login.mjs')}" --code "<the code>" (or paste the code to Antigravity after /devspec-login --code).`)
        return 0
      }
      const answer = (await ask('Paste the code from the DevSpec page: ')).trim()
      if (!answer) {
        say('DevSpec sign-in canceled.')
        return 1
      }
      const login = await completeCodeSignIn(answer, { mcpUrl, home })
      say(signedInText(mcpUrl, login))
      return 0
    }
    if (!browserCanReachThisMachine(env)) {
      say(startText({ status: 'needs_code' }, mcpUrl, pluginRoot))
      return 1
    }
    const login = await runPendingSignIn(mcpUrl, home, (url) =>
      say(`Approve Antigravity on DevSpec's page in your browser (DevSpec ${label}). If no browser tab opened, open this link:\n${url}\nOn a machine your browser cannot reach, run this again with --code.`),
    )
    if (!login) {
      // Another window already opened the approval: join it rather than open a second.
      say(startText({ status: 'waiting', url: pendingSignIn(mcpUrl, { home })?.url ?? null }, mcpUrl, pluginRoot))
      return 0
    }
    say(signedInText(mcpUrl, login))
    return 0
  } catch (error) {
    warn(`DevSpec sign-in did not finish: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

if (isEntryPoint(import.meta.url)) {
  main().then((code) => process.exit(code))
}
