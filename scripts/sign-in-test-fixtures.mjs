/**
 * Test fixtures for browser sign-in (not used by the plugin at run time).
 *
 * One local server plays DevSpec (protected-resource metadata and the MCP endpoint)
 * and Clerk (authorization-server metadata, token and revocation endpoints). The
 * token endpoint pays out only when the PKCE verifier matches the challenge from the
 * authorize step, rotates the renewal key on every use and ends the whole grant when
 * a spent key is used again, as Clerk does.
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(SCRIPTS, '..')

export async function startSignInServer({ connectedAs = 'Ada Lovelace', lifeSeconds = 86400 } = {}) {
  const requests = []
  const issued = new Map()
  const live = new Map() // refresh token -> grant id
  const spent = new Map() // spent refresh token -> grant id
  const deadGrants = new Set()
  const revoked = []
  const refusals = new Map() // access token -> { status, body }
  let counter = 0
  let base = ''

  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      const url = new URL(req.url ?? '/', base)
      const json = (status, body) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      const entry = { method: req.method, path: url.pathname, headers: req.headers }
      requests.push(entry)
      if (url.pathname === '/.well-known/oauth-protected-resource/api/mcp') {
        return json(200, { resource: `${base}/api/mcp`, authorization_servers: [base], scopes_supported: ['devspec', 'offline_access'] })
      }
      if (url.pathname === '/.well-known/oauth-authorization-server') {
        return json(200, {
          issuer: base,
          authorization_endpoint: `${base}/oauth/authorize`,
          token_endpoint: `${base}/oauth/token`,
          revocation_endpoint: `${base}/oauth/revoke`,
        })
      }
      if (url.pathname === '/oauth/token' && req.method === 'POST') {
        const body = Object.fromEntries(new URLSearchParams(raw))
        entry.body = body
        const mint = (grant) => {
          counter += 1
          const refresh = `rt_${counter}`
          live.set(refresh, grant)
          return json(200, { access_token: `oat_${counter}_${grant}`, refresh_token: refresh, expires_in: lifeSeconds, token_type: 'bearer' })
        }
        if (body.grant_type === 'refresh_token') {
          const grant = live.get(body.refresh_token)
          if (!grant) {
            // A spent key used again is treated as theft: the whole grant ends.
            const stolen = spent.get(body.refresh_token)
            if (stolen) deadGrants.add(stolen)
            return json(400, { error: 'invalid_grant' })
          }
          if (deadGrants.has(grant)) return json(400, { error: 'invalid_grant' })
          live.delete(body.refresh_token)
          spent.set(body.refresh_token, grant)
          return mint(grant)
        }
        const grant = issued.get(body.code ?? '')
        const verified =
          grant &&
          grant.redirectUri === body.redirect_uri &&
          grant.clientId === body.client_id &&
          createHash('sha256').update(body.code_verifier ?? '').digest('base64url') === grant.challenge
        if (!verified) return json(400, { error: 'invalid_grant' })
        issued.delete(body.code)
        return mint(`g${body.code}`)
      }
      if (url.pathname === '/oauth/revoke' && req.method === 'POST') {
        revoked.push(Object.fromEntries(new URLSearchParams(raw)))
        res.writeHead(200)
        return res.end()
      }
      if (url.pathname === '/api/mcp' && req.method === 'POST') {
        const token = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
        entry.token = token
        let rpc = {}
        try {
          rpc = JSON.parse(raw)
        } catch {
          /* answered below */
        }
        entry.tool = rpc.params?.name ?? null
        const refusal = refusals.get(token)
        if (refusal) return json(refusal.status, refusal.body)
        if (!token.startsWith('oat_') && !token.startsWith('dvs_')) {
          return json(401, { error: 'Invalid or revoked API token', code: 'invalid_api_token', retryable: false })
        }
        const text = rpc.params?.name === 'verify_agent_connection' ? JSON.stringify({ ok: true, connected_as: connectedAs }) : '{}'
        return json(200, { jsonrpc: '2.0', id: rpc.id ?? 1, result: { content: [{ type: 'text', text }] } })
      }
      res.writeHead(404)
      res.end()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`

  return {
    base,
    mcpUrl: `${base}/api/mcp`,
    requests,
    revoked,
    deadGrants,
    /** What the sign-in server does when the person clicks Allow: a code bound to the challenge. */
    approve(authorizeUrl, code = `code-${requests.length}`) {
      const request = new URL(authorizeUrl)
      issued.set(code, {
        challenge: request.searchParams.get('code_challenge'),
        redirectUri: request.searchParams.get('redirect_uri'),
        clientId: request.searchParams.get('client_id'),
      })
      const back = new URL(request.searchParams.get('redirect_uri'))
      back.searchParams.set('code', code)
      back.searchParams.set('state', request.searchParams.get('state'))
      back.searchParams.set('iss', base)
      return back
    },
    /** DevSpec refuses this access token from now on (e.g. signed_out after a disconnect). */
    refuse(token, status, body) {
      refusals.set(token, { status, body })
    },
    close() {
      server.closeAllConnections?.()
      return new Promise((resolve) => server.close(resolve))
    },
  }
}

/**
 * A copy of this plugin in a temporary folder, its mcp_config.json naming `mcpUrl`,
 * with the fake sign-in server registered as one Antigravity knows (under the
 * Development app's client id), so the real scripts run end to end against it.
 */
export function pluginCopy(root, { mcpUrl, issuer }) {
  const pluginRoot = path.join(root, 'plugin')
  fs.cpSync(SCRIPTS, path.join(pluginRoot, 'scripts'), { recursive: true, filter: (src) => !src.endsWith('.test.mjs') })
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(pluginRoot, 'package.json'))
  const serverFile = path.join(pluginRoot, 'scripts', 'devspec-server.mjs')
  const source = fs.readFileSync(serverFile, 'utf8')
  const patched = source.replace("const DEVELOPMENT_ISSUER = 'https://apt-hare-75.clerk.accounts.dev'", `const DEVELOPMENT_ISSUER = ${JSON.stringify(issuer)}`)
  if (patched === source) throw new Error('pluginCopy: the Development issuer line moved; update the fixture')
  fs.writeFileSync(serverFile, patched)
  fs.writeFileSync(
    path.join(pluginRoot, 'mcp_config.json'),
    `${JSON.stringify({ mcpServers: { devspec: { command: 'node', args: ['${PLUGIN_ROOT}/scripts/mcp-bridge.mjs', mcpUrl] } } }, null, 2)}\n`,
  )
  return pluginRoot
}

/** A temporary folder with an empty home, and a PATH whose xdg-open only records the link. */
export function sandbox(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `agy-sign-in-${label}-`))
  const home = path.join(root, 'home')
  const bin = path.join(root, 'bin')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(bin, { recursive: true })
  const opened = path.join(root, 'opened.log')
  for (const name of ['xdg-open', 'open']) {
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nprintf '%s\\n' "$1" >> "${opened}"\n`, { mode: 0o755 })
  }
  return {
    root,
    home,
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, USERPROFILE: home },
    openedLinks: () => (fs.existsSync(opened) ? fs.readFileSync(opened, 'utf8').split('\n').filter(Boolean) : []),
    remove: () => fs.rmSync(root, { recursive: true, force: true }),
  }
}

/** Wait for `check()` to return something truthy, without blocking the event loop. */
export async function eventually(check, { timeoutMs = 15_000, everyMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, everyMs))
  }
}
