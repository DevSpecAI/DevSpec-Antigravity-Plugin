/**
 * Browser sign-in (oauth.mjs) against a local stand-in for DevSpec and its sign-in
 * server, whose token endpoint checks the PKCE verifier for real.
 */
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import {
  beginCopyCodeSignIn,
  browserCanReachThisMachine,
  completeCopyCodeSignIn,
  discoverSignIn,
  refreshTokens,
  SignInEndedError,
  startLoopbackSignIn,
} from './oauth.mjs'
import { ANTIGRAVITY_CLIENT_IDS, clientIdForIssuer } from './devspec-server.mjs'
import { startSignInServer } from './sign-in-test-fixtures.mjs'

let fake
before(async () => {
  fake = await startSignInServer()
})
after(() => fake.close())

describe('browser sign-in', () => {
  it('discovery follows DevSpec to its sign-in server, and refuses a server without sign-in', async () => {
    const found = await discoverSignIn(fake.mcpUrl)
    assert.equal(found.resource, fake.mcpUrl)
    assert.equal(found.issuer, fake.base)
    assert.equal(found.tokenEndpoint, `${fake.base}/oauth/token`)
    await assert.rejects(discoverSignIn(`${fake.base}/other/mcp`), /does not offer browser sign-in yet/)
  })

  it("signs in as Antigravity's own app on each DevSpec sign-in server, and refuses an unknown one", () => {
    assert.equal(clientIdForIssuer('https://clerk.devspec.ai'), 'Gmbtf7QgaoSw7WJ0')
    assert.equal(clientIdForIssuer('https://apt-hare-75.clerk.accounts.dev'), 'TucS1MNZZlWpOUc7')
    assert.equal(Object.keys(ANTIGRAVITY_CLIENT_IDS).length, 2)
    assert.throws(() => clientIdForIssuer('https://attacker.test'), /does not know how to sign in/)
  })

  it('the approval comes back through the browser to this machine, and only with the matching state', async () => {
    const pending = await startLoopbackSignIn({ discovery: await discoverSignIn(fake.mcpUrl), clientId: 'agy-client' })
    const request = new URL(pending.url)
    assert.equal(request.searchParams.get('client_id'), 'agy-client')
    assert.equal(request.searchParams.get('scope'), 'devspec offline_access')
    assert.equal(request.searchParams.get('code_challenge_method'), 'S256')
    assert.equal(request.searchParams.get('resource'), fake.mcpUrl)
    assert.match(request.searchParams.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+\/callback$/)

    const back = fake.approve(pending.url, 'code-loopback')
    const forged = new URL(back)
    forged.searchParams.set('state', 'someone-elses')
    assert.equal((await fetch(forged)).status, 400, 'a callback this machine did not start is refused')

    const page = await fetch(back)
    assert.equal(page.status, 200)
    assert.match(await page.text(), /Signed in to DevSpec/)
    const tokens = await pending.done
    assert.match(tokens.accessToken, /^oat_/)
    assert.ok(tokens.expiresAt > tokens.issuedAt)
    await assert.rejects(fetch(back), 'the listener is gone once the sign-in finishes')
  })

  it('Deny in the browser ends the sign-in plainly', async () => {
    const pending = await startLoopbackSignIn({ discovery: await discoverSignIn(fake.mcpUrl), clientId: 'agy-client' })
    const request = new URL(pending.url)
    const back = new URL(request.searchParams.get('redirect_uri'))
    back.searchParams.set('error', 'access_denied')
    back.searchParams.set('state', request.searchParams.get('state'))
    const outcome = assert.rejects(pending.done, /canceled in the browser/)
    await fetch(back)
    await outcome
  })

  it('an approval returned by a different sign-in server is refused (RFC 9207)', async () => {
    const pending = await startLoopbackSignIn({ discovery: await discoverSignIn(fake.mcpUrl), clientId: 'agy-client' })
    const back = fake.approve(pending.url, 'code-mixup')
    back.searchParams.set('iss', 'https://attacker.test')
    const outcome = assert.rejects(pending.done, /different server/)
    assert.equal((await fetch(back)).status, 400)
    await outcome
  })

  it('an unanswered sign-in closes its listener by itself', async () => {
    const pending = await startLoopbackSignIn({ discovery: await discoverSignIn(fake.mcpUrl), clientId: 'agy-client', waitMs: 20 })
    await assert.rejects(pending.done, /timed out/)
  })

  it('on a machine the browser cannot reach, the person pastes the code the page shows', async () => {
    const discovery = await discoverSignIn(fake.mcpUrl)
    const codePageUrl = `${fake.base}/oauth-code`
    const flow = beginCopyCodeSignIn({ discovery, clientId: 'agy-client', codePageUrl })
    assert.equal(new URL(flow.url).searchParams.get('redirect_uri'), codePageUrl)
    const back = fake.approve(flow.url, 'code-pasted')
    const shown = `${back.searchParams.get('code')}#${back.searchParams.get('state')}`
    await assert.rejects(completeCopyCodeSignIn({ discovery, clientId: 'agy-client', pending: flow, pasted: 'code-pasted#not-this-sign-in' }), /not from this sign-in/)
    await assert.rejects(completeCopyCodeSignIn({ discovery, clientId: 'agy-client', pending: flow, pasted: 'code-pasted' }), /not from this sign-in/)
    const tokens = await completeCopyCodeSignIn({ discovery, clientId: 'agy-client', pending: flow, pasted: `  ${shown}\n` })
    assert.match(tokens.accessToken, /^oat_/)
  })

  it('renewal rotates the key, and a spent key ends the sign-in', async () => {
    const discovery = await discoverSignIn(fake.mcpUrl)
    const pending = await startLoopbackSignIn({ discovery, clientId: 'agy-client' })
    await fetch(fake.approve(pending.url, 'code-renew'))
    const first = await pending.done
    const input = { tokenEndpoint: discovery.tokenEndpoint, clientId: 'agy-client', resource: discovery.resource }
    const renewed = await refreshTokens({ ...input, refreshToken: first.refreshToken })
    assert.notEqual(renewed.refreshToken, first.refreshToken)
    await assert.rejects(refreshTokens({ ...input, refreshToken: first.refreshToken }), SignInEndedError)
  })

  it('an SSH session uses the copy-a-code page, because its browser cannot reach this machine', () => {
    assert.equal(browserCanReachThisMachine({}), true)
    assert.equal(browserCanReachThisMachine({ SSH_CONNECTION: '1.2.3.4 5 6.7.8.9 22' }), false)
    assert.equal(browserCanReachThisMachine({ SSH_TTY: '/dev/pts/1' }), false)
  })
})
