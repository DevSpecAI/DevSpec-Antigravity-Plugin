/**
 * Browser sign-in for the plugin's background features (OAuth 2.1 authorization code
 * + PKCE), for remote control, commit tracking and the hooks.
 *
 * DevSpec's tool endpoint names its authorization server (Clerk) in its
 * protected-resource metadata (RFC 9728). The plugin signs in through Antigravity's
 * own pre-registered public sign-in app at that server, the same app Antigravity's
 * built-in MCP sign-in uses, so the approval page names Antigravity and DevSpec's
 * Agent setup page lists Antigravity once (decisions 912b3b3e, 23570432).
 *
 * The approval always returns through the person's own browser (risk 65cc21b1):
 * - normally to a short-lived listener on 127.0.0.1 (RFC 8252 loopback);
 * - where the browser cannot reach this machine (SSH, a remote box), to DevSpec's
 *   own "copy this code" page, and the person pastes `code#state` back.
 * Nothing ever learns the result by polling a server, and the authorization code is
 * useless without the PKCE verifier, which never leaves the process that made it
 * (or, for a code pasted back in a later command, its owner-only pending file).
 *
 * Ported from the Pi plugin's extensions/core/oauth.ts. Each plugin owns its own
 * copy; nothing is shared or synced between them.
 */

import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'

/** Scopes every DevSpec sign-in asks for: DevSpec access, plus renewal. */
export const SIGN_IN_SCOPE = 'devspec offline_access'

/**
 * How long an unanswered sign-in keeps its local listener open. The listener is a
 * port on this machine waiting for a browser, so it closes by itself; ten minutes
 * matches how long Clerk keeps an authorization request alive.
 */
export const SIGN_IN_WAIT_MS = 10 * 60 * 1000

/** One network round trip to DevSpec or Clerk during sign-in or renewal. */
export const SIGN_IN_REQUEST_TIMEOUT_MS = 15_000

export class SignInError extends Error {}

/** The server refused to renew: the sign-in is over until the person signs in again. */
export class SignInEndedError extends SignInError {}

/** Origin + path with no trailing slash, query or fragment: one key per DevSpec server. */
export function normalizeResource(url) {
  const parsed = new URL(url)
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`
}

async function getJson(url, fetchImpl) {
  const response = await fetchImpl(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(SIGN_IN_REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) throw new SignInError(`${url} answered ${response.status}`)
  return response.json()
}

function stringField(value, key) {
  const field = value && typeof value === 'object' ? value[key] : undefined
  return typeof field === 'string' && field ? field : undefined
}

/**
 * Find where this DevSpec server sends people to sign in. Refuses a server that does
 * not offer browser sign-in, or metadata that names a different endpoint.
 */
export async function discoverSignIn(mcpUrl, fetchImpl = fetch) {
  const resource = normalizeResource(mcpUrl)
  const { origin, pathname } = new URL(resource)
  let metadata
  try {
    metadata = await getJson(`${origin}/.well-known/oauth-protected-resource${pathname}`, fetchImpl)
  } catch {
    throw new SignInError(`This DevSpec server (${origin}) does not offer browser sign-in yet.`)
  }
  const named = stringField(metadata, 'resource')
  if (named === undefined || normalizeResource(named) !== resource) {
    throw new SignInError(`This DevSpec server's sign-in details are for a different address than ${resource}.`)
  }
  const servers = metadata?.authorization_servers
  const issuer =
    Array.isArray(servers) && typeof servers[0] === 'string' ? servers[0].replace(/\/+$/, '') : undefined
  if (!issuer) throw new SignInError('This DevSpec server does not name where to sign in.')

  const server = await getJson(`${issuer}/.well-known/oauth-authorization-server`, fetchImpl)
  if (stringField(server, 'issuer')?.replace(/\/+$/, '') !== issuer) {
    throw new SignInError("DevSpec's sign-in server described itself as a different server.")
  }
  const authorizationEndpoint = stringField(server, 'authorization_endpoint')
  const tokenEndpoint = stringField(server, 'token_endpoint')
  if (!authorizationEndpoint || !tokenEndpoint) {
    throw new SignInError("DevSpec's sign-in server did not list its endpoints.")
  }
  return {
    resource: named,
    issuer,
    authorizationEndpoint,
    tokenEndpoint,
    revocationEndpoint: stringField(server, 'revocation_endpoint'),
  }
}

const base64url = (bytes) => bytes.toString('base64url')

export function createPkce() {
  const verifier = base64url(randomBytes(32))
  return { verifier, challenge: base64url(createHash('sha256').update(verifier).digest()) }
}

export function createState() {
  return base64url(randomBytes(24))
}

export function authorizationUrl({ discovery, clientId, redirectUri, state, challenge }) {
  const url = new URL(discovery.authorizationEndpoint)
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: SIGN_IN_SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: discovery.resource,
  }).toString()
  return url.toString()
}

async function postToken(tokenEndpoint, body, fetchImpl) {
  const response = await fetchImpl(tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(SIGN_IN_REQUEST_TIMEOUT_MS),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    const code = typeof payload?.error === 'string' ? payload.error : `status ${response.status}`
    // invalid_grant: the code or renewal key is spent, revoked or expired. The grant
    // is over; anything else may be passing and is worth trying again later.
    if (code === 'invalid_grant') throw new SignInEndedError('DevSpec ended this sign-in.')
    throw new SignInError(`DevSpec's sign-in server refused the request (${code}).`)
  }
  const accessToken = typeof payload?.access_token === 'string' ? payload.access_token : ''
  const refreshToken = typeof payload?.refresh_token === 'string' ? payload.refresh_token : ''
  const expiresIn = typeof payload?.expires_in === 'number' ? payload.expires_in : NaN
  if (!accessToken || !refreshToken || !Number.isFinite(expiresIn)) {
    throw new SignInError("DevSpec's sign-in server answered without a complete sign-in.")
  }
  const issuedAt = Date.now()
  return { accessToken, refreshToken, issuedAt, expiresAt: issuedAt + expiresIn * 1000 }
}

export function exchangeCode({ discovery, clientId, code, redirectUri, verifier }, fetchImpl = fetch) {
  return postToken(
    discovery.tokenEndpoint,
    {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
      resource: discovery.resource,
    },
    fetchImpl,
  )
}

/**
 * Renew a sign-in. Clerk rotates the renewal key on every use and treats a second use
 * of the same key as theft, ending the grant, so callers hold the store lock
 * (auth-store.mjs) around this.
 */
export function refreshTokens({ tokenEndpoint, clientId, refreshToken, resource }, fetchImpl = fetch) {
  return postToken(
    tokenEndpoint,
    { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, resource },
    fetchImpl,
  )
}

/** Best effort: cancel the grant at Clerk when the person signs out. */
export async function revokeRefreshToken({ revocationEndpoint, clientId, refreshToken }, fetchImpl = fetch) {
  if (!revocationEndpoint) return
  await fetchImpl(revocationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: refreshToken, token_type_hint: 'refresh_token', client_id: clientId }).toString(),
    signal: AbortSignal.timeout(SIGN_IN_REQUEST_TIMEOUT_MS),
  }).catch(() => {})
}

/** Open a URL in the default browser without a shell (no metacharacter re-parsing). */
export function openInBrowser(url, { platform = process.platform } = {}) {
  const [cmd, args] =
    platform === 'darwin'
      ? ['open', [url]]
      : platform === 'win32'
        ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : ['xdg-open', [url]]
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true }).on('error', () => {}).unref()
  } catch {
    /* the link is always printed too */
  }
}

/**
 * Whether a browser opened here can reach a listener on this machine. Over SSH the
 * browser runs on the person's own computer, where 127.0.0.1 is not us.
 */
export function browserCanReachThisMachine(env = process.env) {
  return !env.SSH_CONNECTION && !env.SSH_TTY && !env.SSH_CLIENT
}

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function logoUrlForResource(resource) {
  try {
    const u = new URL(resource)
    if (u.protocol === 'https:') {
      if (u.hostname.startsWith('api.')) u.hostname = `app.${u.hostname.slice(4)}`
      return `${u.origin}/logo-icon.png`
    }
  } catch {
    /* fall through */
  }
  return 'https://app.devspec.ai/logo-icon.png'
}

function page(title, body, logoUrl = 'https://app.devspec.ai/logo-icon.png') {
  const safeTitle = escapeHtml(title)
  const safeBody = escapeHtml(body)
  const safeLogo = escapeHtml(logoUrl)
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="referrer" content="no-referrer">',
    '<meta name="color-scheme" content="light dark">',
    `<title>${safeTitle} — DevSpec</title>`,
    '<style>',
    ':root{color-scheme:light dark;--bg:#f9f7f2;--card:#fdfcfa;--fg:#18202c;--muted:#5c6573;--border:#e3dfd6;--primary:#2e548a;--shadow:0 1px 3px rgba(24,32,44,.06)}',
    '@media (prefers-color-scheme:dark){:root{--bg:#0c1017;--card:#141b26;--fg:#eae7df;--muted:#939ba8;--border:#232c3b;--primary:#7aa5e8;--shadow:0 2px 8px rgba(0,0,0,.35)}}',
    '*{box-sizing:border-box}',
    "body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1.5rem;font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.5;background:var(--bg);color:var(--fg)}",
    'main{width:100%;max-width:28rem;background:var(--card);border:1px solid var(--border);border-radius:.75rem;padding:1.75rem;box-shadow:var(--shadow)}',
    '.brand{display:inline-flex;align-items:center;gap:.5rem;margin-bottom:1.25rem}',
    '.brand img{width:1.5rem;height:1.5rem;display:block}',
    '.brand span{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:.75rem;font-weight:600;letter-spacing:.16em;text-transform:uppercase;color:var(--primary)}',
    'h1{font-size:1.125rem;font-weight:600;margin:0 0 .5rem;color:var(--fg)}',
    'p{font-size:.875rem;margin:0;color:var(--muted)}',
    '</style>',
    '</head>',
    '<body>',
    '<main>',
    `<div class="brand"><img src="${safeLogo}" alt="DevSpec" width="24" height="24"><span>DevSpec</span></div>`,
    `<h1>${safeTitle}</h1>`,
    `<p>${safeBody}</p>`,
    '</main>',
    '</body>',
    '</html>',
  ].join('')
}

function reply(res, status, html) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(html)
}

const START_AGAIN = 'Start again with /devspec-login in Antigravity.'

/**
 * Sign in through a loopback listener: open `url`, and the browser brings the
 * approval back to this process. `state` and the issuer echo (RFC 9207) are checked
 * before the code is exchanged. Resolves `{ url, done, cancel }`; `done` settles with
 * the new sign-in, or rejects when canceled, refused or timed out.
 */
export async function startLoopbackSignIn({ discovery, clientId, waitMs = SIGN_IN_WAIT_MS }, fetchImpl = fetch) {
  const { verifier, challenge } = createPkce()
  const state = createState()
  let settle
  const done = new Promise((resolve, reject) => {
    settle = { resolve, reject }
  })
  // A replaced or canceled sign-in may have no listener left; never crash over it.
  done.catch(() => {})
  let finished = false
  let redirectUri = ''
  let timer

  const logoUrl = logoUrlForResource(discovery.resource)
  const server = createServer((req, res) => {
    const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (requestUrl.pathname !== '/callback' || finished) {
      reply(res, 404, page('Not found', 'This address is only used to finish signing in to DevSpec.', logoUrl))
      return
    }
    const params = requestUrl.searchParams
    if (params.get('state') !== state) {
      // Not our request (or a replay): never exchange a code we did not ask for.
      reply(res, 400, page('Sign-in not recognized', `This sign-in was not started here. ${START_AGAIN}`, logoUrl))
      return
    }
    const iss = params.get('iss')
    if (iss !== null && iss.replace(/\/+$/, '') !== discovery.issuer) {
      reply(res, 400, page('Sign-in not recognized', `This sign-in came back from a different server. ${START_AGAIN}`, logoUrl))
      finish(new SignInError('The sign-in came back from a different server.'))
      return
    }
    const error = params.get('error')
    if (error) {
      reply(res, 200, page('Sign-in canceled', 'Nothing was connected. You can close this tab.', logoUrl))
      finish(
        new SignInError(
          error === 'access_denied' ? 'Sign-in was canceled in the browser.' : `Sign-in failed (${error}).`,
        ),
      )
      return
    }
    const code = params.get('code')
    if (!code) {
      reply(res, 400, page('Sign-in incomplete', `The browser did not bring back a sign-in. ${START_AGAIN}`, logoUrl))
      return
    }
    finished = true
    exchangeCode({ discovery, clientId, code, redirectUri, verifier }, fetchImpl).then(
      (tokens) => {
        reply(res, 200, page('Signed in to DevSpec', 'You can close this tab and go back to Antigravity. Restart Antigravity to finish connecting.', logoUrl))
        finish(tokens)
      },
      (err) => {
        reply(res, 500, page('Sign-in failed', 'Antigravity could not finish signing in. Go back to Antigravity for details.', logoUrl))
        finish(err instanceof Error ? err : new SignInError(String(err)))
      },
    )
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const { port } = server.address()
  redirectUri = `http://127.0.0.1:${port}/callback`
  timer = setTimeout(
    () => finish(new SignInError(`Sign-in timed out waiting for the browser. ${START_AGAIN}`)),
    waitMs,
  )
  timer.unref?.()

  function finish(result) {
    finished = true
    clearTimeout(timer)
    server.close()
    server.closeAllConnections?.()
    if (result instanceof Error) settle.reject(result)
    else settle.resolve(result)
  }

  return {
    url: authorizationUrl({ discovery, clientId, redirectUri, state, challenge }),
    done,
    cancel: () => finish(new SignInError('Sign-in canceled.')),
  }
}

/**
 * Start a sign-in where the browser cannot reach this machine: the approval returns
 * to DevSpec's own page (`codePageUrl`), which shows `code#state` for the person to
 * paste back. Returns the link and the secret half (`verifier`, `state`) needed to
 * finish it with `completeCopyCodeSignIn`.
 */
export function beginCopyCodeSignIn({ discovery, clientId, codePageUrl }) {
  const { verifier, challenge } = createPkce()
  const state = createState()
  return {
    url: authorizationUrl({ discovery, clientId, redirectUri: codePageUrl, state, challenge }),
    verifier,
    state,
    redirectUri: codePageUrl,
  }
}

/** The pasted state must match the one this sign-in generated before its code is exchanged. */
export function completeCopyCodeSignIn({ discovery, clientId, pending, pasted }, fetchImpl = fetch) {
  const value = String(pasted ?? '').trim()
  const hash = value.lastIndexOf('#')
  const code = hash > 0 ? value.slice(0, hash) : ''
  if (!code || value.slice(hash + 1) !== pending.state) {
    return Promise.reject(
      new SignInError(
        'That code is not from this sign-in. Copy the whole code from the page, or start again with /devspec-login --code.',
      ),
    )
  }
  return exchangeCode(
    { discovery, clientId, code, redirectUri: pending.redirectUri, verifier: pending.verifier },
    fetchImpl,
  )
}
