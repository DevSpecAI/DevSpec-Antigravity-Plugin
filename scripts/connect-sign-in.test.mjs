/**
 * /devspec-remote with no background sign-in yet (item 7f862114): asking for remote
 * control opens the one browser approval it needs, waits a little for this
 * machine's own login file to show the result, and never asks DevSpec whether the
 * person approved.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ConnectError, signedInAuth } from './devspec-remote-connect.mjs'

const MCP = 'https://api.devspec.ai/api/mcp'
const notSignedIn = { ok: false, reason: 'not_signed_in', mcp_url: MCP, error: 'not signed in' }
const signedIn = { ok: true, token: 'oat_x', mcp_url: MCP, source: 'login' }

function scripted(results) {
  let i = 0
  const calls = []
  return {
    calls,
    resolveAuth: (cwd, opts) => {
      calls.push(opts)
      return results[Math.min(i++, results.length - 1)]
    },
  }
}

describe('connecting with no background sign-in', () => {
  it('opens the approval, tells the person with the link, and carries on once it lands', async () => {
    const auth = scripted([notSignedIn, notSignedIn, signedIn])
    const messages = []
    const started = []
    const result = await signedInAuth({
      cwd: '/w',
      env: {},
      home: '/h',
      resolveAuth: auth.resolveAuth,
      startSignIn: (request) => {
        started.push(request)
        return { status: 'started', url: 'https://clerk.example/oauth/authorize?x=1' }
      },
      onSignInMessage: (m) => messages.push(m),
      sleepFn: async () => {},
    })
    assert.equal(result, signedIn)
    assert.deepEqual(started, [{ mcpUrl: MCP, home: '/h', env: {} }])
    assert.equal(messages.length, 1)
    assert.match(messages[0], /approve Antigravity on DevSpec's page/)
    assert.match(messages[0], /https:\/\/clerk\.example\/oauth\/authorize\?x=1/)
  })

  it('says to run /devspec-remote again when the approval has not landed in time', async () => {
    const auth = scripted([notSignedIn])
    const error = await signedInAuth({
      cwd: '/w',
      env: {},
      home: '/h',
      resolveAuth: auth.resolveAuth,
      startSignIn: () => ({ status: 'waiting', url: 'https://clerk.example/a' }),
      signInWaitMs: 0,
      sleepFn: async () => {},
    }).catch((e) => e)
    assert.ok(error instanceof ConnectError)
    assert.equal(error.reason, 'sign_in')
    assert.match(error.message, /Waiting for you to approve Antigravity/)
    assert.match(error.message, /Then run \/devspec-remote again\./)
  })

  it('an ended sign-in starts a new approval too, because the person asked to connect', async () => {
    let started = 0
    await signedInAuth({
      cwd: '/w',
      env: {},
      home: '/h',
      resolveAuth: scripted([{ ...notSignedIn, reason: 'sign_in_ended' }, signedIn]).resolveAuth,
      startSignIn: () => {
        started += 1
        return { status: 'started', url: null }
      },
      sleepFn: async () => {},
    })
    assert.equal(started, 1)
  })

  it('over SSH it explains the code flow instead of waiting', async () => {
    const error = await signedInAuth({
      cwd: '/w',
      env: {},
      home: '/h',
      resolveAuth: scripted([notSignedIn]).resolveAuth,
      startSignIn: () => ({ status: 'needs_code' }),
    }).catch((e) => e)
    assert.equal(error.reason, 'sign_in')
    assert.match(error.message, /\/devspec-login --code/)
  })
})
