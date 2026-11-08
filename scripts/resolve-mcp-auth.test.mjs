/**
 * Which credential the background features use (resolve-mcp-auth.mjs): the
 * environment token on a machine with no browser, else this plugin's own browser
 * login for this install's server, and never anything else.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { loginPrincipal, loginState, markLoginEnded, renewLogin, saveLogin } from './auth-store.mjs'
import { discoverSignIn, startLoopbackSignIn } from './oauth.mjs'
import {
  connectionCredential,
  credentialIdentity,
  resolveDevspecMcpAuth,
  stateWithCurrentToken,
  tokenFingerprint,
} from './resolve-mcp-auth.mjs'
import { eventually, pluginCopy, sandbox, startSignInServer } from './sign-in-test-fixtures.mjs'

const HOUR = 60 * 60 * 1000
const PROD = 'https://api.devspec.ai/api/mcp'
const STAGING = 'https://api.devspecstaging.com/api/mcp'

let home
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-resolve-'))
})
afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

function save(endpoint, tag, { issuedAt = Date.now(), lifeMs = 24 * HOUR } = {}) {
  return saveLogin(
    {
      endpoint,
      tokens: { accessToken: `oat_${tag}`, refreshToken: `rt_${tag}`, issuedAt, expiresAt: issuedAt + lifeMs },
      issuer: 'https://issuer.test',
      tokenEndpoint: 'https://issuer.test/oauth/token',
      clientId: 'agy-client',
      resource: endpoint,
    },
    { home },
  )
}

describe('the background features credential', () => {
  it('uses the browser login saved for this install’s server (production as shipped)', async () => {
    await save(PROD, 'prod')
    const auth = resolveDevspecMcpAuth('/anywhere', { env: {}, home })
    assert.equal(auth.ok, true)
    assert.equal(auth.token, 'oat_prod')
    assert.equal(auth.mcp_url, PROD)
    assert.equal(auth.source, 'login')
    assert.match(auth.principal, /^[a-f0-9]{64}$/)
  })

  it('never sends a login to another server: a staging login is not used for production, nor redirected by DEVSPEC_MCP_URL', async () => {
    await save(STAGING, 'staging')
    for (const env of [{}, { DEVSPEC_MCP_URL: STAGING }]) {
      const auth = resolveDevspecMcpAuth('/anywhere', { env, home })
      assert.equal(auth.ok, false)
      assert.equal(auth.mcp_url, PROD)
      assert.equal(auth.reason, 'not_signed_in')
      assert.equal(auth.token, undefined)
    }
  })

  it('reads no other tool’s login and no token from Antigravity’s settings', () => {
    const write = (file, value) => {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify(value))
    }
    write(path.join(home, '.pi', 'agent', 'devspec', 'auth.json'), { token: 'dvs_pi_token_abcdef', mcp_url: PROD })
    write(path.join(home, '.devspec', 'auth.json'), { token: 'dvs_old_pinned_abcdef', mcp_url: PROD })
    write(path.join(home, '.gemini', 'config', 'mcp_config.json'), {
      mcpServers: { devspec: { serverUrl: PROD, headers: { Authorization: 'Bearer dvs_settings_token_abc' } } },
    })
    const auth = resolveDevspecMcpAuth(home, { env: {}, home })
    assert.equal(auth.ok, false)
    assert.equal(auth.reason, 'not_signed_in')
    assert.match(auth.error, /\/devspec-login/)
  })

  it('DEVSPEC_MCP_TOKEN wins, goes to DEVSPEC_MCP_URL (or this install’s server), and keeps its old fingerprint', async () => {
    await save(PROD, 'prod')
    const env = { DEVSPEC_MCP_TOKEN: 'dvs_ci_token_123456' }
    const plain = resolveDevspecMcpAuth('/x', { env, home })
    assert.deepEqual(
      { ok: plain.ok, token: plain.token, mcp_url: plain.mcp_url, source: plain.source },
      { ok: true, token: 'dvs_ci_token_123456', mcp_url: PROD, source: 'env' },
    )
    assert.equal(plain.principal, createHash('sha256').update('dvs_ci_token_123456').digest('hex'))
    const paired = resolveDevspecMcpAuth('/x', { env: { ...env, DEVSPEC_MCP_URL: `${STAGING}/` }, home })
    assert.equal(paired.mcp_url, STAGING)
    assert.equal(resolveDevspecMcpAuth('/x', { env: { DEVSPEC_MCP_TOKEN: '${DEVSPEC_TOKEN}' }, home }).token, 'oat_prod', 'a placeholder is not a token')
  })

  it('an ended login is said plainly, with how to sign in again', async () => {
    await save(PROD, 'prod')
    await markLoginEnded(PROD, 'oat_prod', 'signed_out', { home })
    const auth = resolveDevspecMcpAuth('/x', { env: {}, home })
    assert.equal(auth.ok, false)
    assert.equal(auth.reason, 'sign_in_ended')
    assert.match(auth.error, /has ended/)
    assert.match(auth.error, /https:\/\/app\.devspec\.ai\/settings\/agents/)
    assert.match(auth.error, /Run \/devspec-login to sign in again/)
  })
})

describe('connection state made with a browser login', () => {
  it('always carries the login’s current token, keeps one identity, and leaves other states alone', async () => {
    const first = await save(STAGING, 'day1')
    const made = { connection_id: 'c1', mcp_url: STAGING, token: 'oat_day1', auth_source: 'login', auth_principal: loginPrincipal(first) }
    // A day later the same login has renewed: same login, new token.
    await renewLogin(STAGING, {
      home,
      now: () => Date.now() + 13 * HOUR,
      refresh: async () => ({ accessToken: 'oat_day2', refreshToken: 'rt_day2', issuedAt: Date.now(), expiresAt: Date.now() + 24 * HOUR }),
    })
    const read = stateWithCurrentToken(made, { home })
    assert.equal(read.token, 'oat_day2')
    assert.equal(read.mcp_url, STAGING)
    assert.equal(credentialIdentity(read), credentialIdentity(made), 'the connection is the same identity after renewal')
    const envState = { connection_id: 'c2', mcp_url: STAGING, token: 'dvs_env', auth_source: 'env' }
    assert.equal(stateWithCurrentToken(envState, { home }), envState)
    assert.equal(credentialIdentity(envState), 'dvs_env', 'an environment token is identified exactly as before')
  })

  it('never fills a missing token with a credential for a different server', async () => {
    await save(PROD, 'prod')
    assert.equal(connectionCredential({ connection_id: 'c', mcp_url: STAGING }, { env: {}, home }), null)
    assert.deepEqual(connectionCredential({ connection_id: 'c', mcp_url: PROD }, { env: {}, home }), { token: 'oat_prod', mcpUrl: PROD })
  })
})

describe('renewal from a hook', () => {
  it('renews past half-life in a detached process, once, however many hooks ask at the same moment', async () => {
    const fake = await startSignInServer()
    const box = sandbox('renew')
    try {
      const discovery = await discoverSignIn(fake.mcpUrl)
      const pending = await startLoopbackSignIn({ discovery, clientId: 'TucS1MNZZlWpOUc7' })
      await fetch(fake.approve(pending.url, 'code-renew'))
      const tokens = await pending.done
      const now = Date.now()
      await saveLogin(
        {
          endpoint: fake.mcpUrl,
          tokens: { ...tokens, issuedAt: now - 20 * HOUR, expiresAt: now + 4 * HOUR },
          issuer: discovery.issuer,
          tokenEndpoint: discovery.tokenEndpoint,
          clientId: 'TucS1MNZZlWpOUc7',
          resource: discovery.resource,
        },
        { home: box.home },
      )
      const plugin = pluginCopy(box.root, { mcpUrl: fake.mcpUrl, issuer: fake.base })
      const run = () =>
        new Promise((resolve) => {
          const child = spawn(process.execPath, [path.join(plugin, 'scripts', 'resolve-mcp-auth.mjs')], { env: box.env })
          let out = ''
          child.stdout.on('data', (chunk) => {
            out += chunk
          })
          child.on('exit', () => resolve(JSON.parse(out)))
        })
      const results = await Promise.all([run(), run(), run()])
      const renewed = await eventually(() => {
        const state = loginState(fake.mcpUrl, { home: box.home })
        return state.login.accessToken !== tokens.accessToken ? state.login : null
      })
      assert.equal(fake.requests.filter((r) => r.path === '/oauth/token' && r.body?.grant_type === 'refresh_token').length, 1)
      assert.equal(fake.deadGrants.size, 0, 'no renewal key was used twice')
      assert.ok(Date.parse(renewed.expiresAt) - Date.now() > 23 * HOUR)
      for (const result of results) {
        assert.equal(result.ok, true)
        assert.equal(result.mcp_url, fake.mcpUrl)
        assert.ok(!JSON.stringify(result).includes(tokens.accessToken), 'only a fingerprint is printed')
      }
      assert.ok(results.some((r) => r.token_fingerprint === tokenFingerprint(renewed.accessToken)))
    } finally {
      box.remove()
      await fake.close()
    }
  })
})
