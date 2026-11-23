/**
 * The plugin's own login file (auth-store.mjs): owner-only, one login per server,
 * renewed once past half its life, with Clerk's single-use renewal keys spent exactly
 * once however many processes renew at the same moment.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, it } from 'node:test'
import {
  authFilePath,
  lockPath,
  loginPrincipal,
  loginState,
  markLoginEnded,
  needsRenewal,
  removeLogin,
  renewLogin,
  saveLogin,
} from './auth-store.mjs'
import { SignInEndedError } from './oauth.mjs'
import { POSIX_MODES } from './private-state.mjs'

const HOUR = 60 * 60 * 1000
const PROD = 'https://api.devspec.ai/api/mcp'
const STAGING = 'https://api.devspecstaging.com/api/mcp'
const SCRIPTS = path.dirname(fileURLToPath(import.meta.url))

let home
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-auth-store-'))
})
afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

function tokens(tag, issuedAt = Date.now(), lifeMs = 24 * HOUR) {
  return { accessToken: `oat_${tag}`, refreshToken: `rt_${tag}`, issuedAt, expiresAt: issuedAt + lifeMs }
}

function save(endpoint, tag, issuedAt, lifeMs) {
  return saveLogin(
    {
      endpoint,
      tokens: tokens(tag, issuedAt, lifeMs),
      issuer: 'https://issuer.test',
      tokenEndpoint: 'https://issuer.test/oauth/token',
      clientId: 'agy-client',
      resource: endpoint,
      signedInAs: 'Ada Lovelace',
    },
    { home },
  )
}

describe('the login file', () => {
  it('starts with no login for any server', () => {
    assert.deepEqual(loginState(PROD, { home }), { kind: 'none' })
  })

  it('is written owner-only, in an owner-only folder, under ~/.devspec/antigravity', { skip: POSIX_MODES ? false : 'POSIX modes' }, async () => {
    await save(PROD, 'prod')
    const file = authFilePath(home)
    assert.equal(file, path.join(home, '.devspec', 'antigravity', 'auth.json'))
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700)
  })

  it('keeps staging and production side by side, and signing out of one leaves the other', async () => {
    await save(PROD, 'prod')
    await save(`${STAGING}/`, 'staging')
    assert.equal(loginState(PROD, { home }).login.accessToken, 'oat_prod')
    assert.equal(loginState(STAGING, { home }).login.accessToken, 'oat_staging')
    const removed = await removeLogin(STAGING, { home })
    assert.equal(removed.refreshToken, 'rt_staging')
    assert.equal(loginState(STAGING, { home }).kind, 'none')
    assert.equal(loginState(PROD, { home }).kind, 'active')
  })

  it('never saves a login under a server other than the one it was approved for', async () => {
    await assert.rejects(
      saveLogin(
        { endpoint: PROD, tokens: tokens('x'), issuer: 'https://issuer.test', tokenEndpoint: 'https://issuer.test/t', clientId: 'c', resource: STAGING },
        { home },
      ),
    )
    assert.equal(loginState(PROD, { home }).kind, 'none')
  })

  it('reads a corrupt file as signed out', () => {
    fs.mkdirSync(path.dirname(authFilePath(home)), { recursive: true })
    fs.writeFileSync(authFilePath(home), '{ not json')
    assert.equal(loginState(PROD, { home }).kind, 'none')
  })
})

describe('renewal', () => {
  it('renews once a token is past half its life, never before', async () => {
    const start = new Date(0).toISOString()
    const end = new Date(24 * HOUR).toISOString()
    assert.equal(needsRenewal({ issuedAt: start, expiresAt: end }, 11 * HOUR), false)
    assert.equal(needsRenewal({ issuedAt: start, expiresAt: end }, 12 * HOUR), true)
    await save(PROD, 'fresh')
    let calls = 0
    const login = await renewLogin(PROD, { home, refresh: async () => { calls += 1; return tokens('unused') } })
    assert.equal(login.accessToken, 'oat_fresh')
    assert.equal(calls, 0)
  })

  it('keeps one identity across renewals, unlike the token itself', async () => {
    const before = await save(PROD, 'first', Date.now() - 13 * HOUR)
    const after = await renewLogin(PROD, { home, refresh: async () => tokens('second') })
    assert.equal(after.accessToken, 'oat_second')
    assert.equal(after.refreshToken, 'rt_second')
    assert.match(loginPrincipal(before), /^[a-f0-9]{64}$/)
    assert.equal(loginPrincipal(after), loginPrincipal(before))
  })

  it('five renewals at once spend the single-use renewal key exactly once', async () => {
    await save(PROD, 'old', Date.now() - 20 * HOUR)
    const spent = []
    const refresh = async (input) => {
      spent.push(input.refreshToken)
      await new Promise((resolve) => setTimeout(resolve, 50))
      return tokens(`renewed${spent.length}`)
    }
    const results = await Promise.all(Array.from({ length: 5 }, () => renewLogin(PROD, { home, refresh })))
    assert.deepEqual(spent, ['rt_old'])
    assert.deepEqual(new Set(results.map((login) => login.accessToken)), new Set(['oat_renewed1']))
    assert.equal(loginState(PROD, { home }).login.refreshToken, 'rt_renewed1')
  })

  it('separate processes renewing together spend the key once too', async () => {
    await save(PROD, 'shared', Date.now() - 20 * HOUR)
    const marker = path.join(home, 'spent.log')
    const child = `
      import fs from 'node:fs'
      import { renewLogin } from ${JSON.stringify(path.join(SCRIPTS, 'auth-store.mjs'))}
      await renewLogin(${JSON.stringify(PROD)}, {
        home: ${JSON.stringify(home)},
        refresh: async (input) => {
          fs.appendFileSync(${JSON.stringify(marker)}, input.refreshToken + '\\n')
          await new Promise((resolve) => setTimeout(resolve, 100))
          const now = Date.now()
          return { accessToken: 'oat_' + process.pid, refreshToken: 'rt_' + process.pid, issuedAt: now, expiresAt: now + 86400000 }
        },
      })
    `
    await Promise.all(
      Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
        const p = spawn(process.execPath, ['--input-type=module', '-e', child], { stdio: 'inherit' })
        p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`child exited ${code}`))))
      })),
    )
    assert.deepEqual(fs.readFileSync(marker, 'utf8').trim().split('\n'), ['rt_shared'])
  })

  it('a renewal DevSpec refuses ends the login, and it is not offered again', async () => {
    await save(PROD, 'old', Date.now() - 20 * HOUR)
    const ended = await renewLogin(PROD, { home, refresh: async () => { throw new SignInEndedError('ended') } })
    assert.ok(ended.endedAt)
    assert.equal(loginState(PROD, { home }).kind, 'ended')
    let calls = 0
    await renewLogin(PROD, { home, refresh: async () => { calls += 1; return tokens('never') } })
    assert.equal(calls, 0)
  })

  it('a renewal that fails for a passing reason keeps the login and its token', async () => {
    await save(PROD, 'old', Date.now() - 20 * HOUR)
    const login = await renewLogin(PROD, { home, refresh: async () => { throw new Error('offline') } })
    assert.equal(login.accessToken, 'oat_old')
    assert.ok(login.renewalFailedAt)
    assert.equal(loginState(PROD, { home }).kind, 'active')
  })

  it('a lock left by a process that died does not block renewal', async () => {
    await save(PROD, 'old', Date.now() - 20 * HOUR)
    fs.writeFileSync(lockPath(home), '999999999')
    const login = await renewLogin(PROD, { home, refresh: async () => tokens('after-crash') })
    assert.equal(login.accessToken, 'oat_after-crash')
  })
})

describe('a login DevSpec refused', () => {
  it('ends only when the refused token is the login current token', async () => {
    await save(PROD, 'current')
    assert.equal(await markLoginEnded(PROD, 'oat_some_older_token', 'signed_out', { home }), false)
    assert.equal(loginState(PROD, { home }).kind, 'active')
    assert.equal(await markLoginEnded(PROD, 'oat_current', 'signed_out', { home }), true)
    const state = loginState(PROD, { home })
    assert.equal(state.kind, 'ended')
    assert.equal(state.login.endedReason, 'signed_out')
  })
})
