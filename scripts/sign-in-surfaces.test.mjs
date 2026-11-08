/**
 * Where a person hears about the background features' sign-in (item 7f862114): the
 * status bar and SessionStart say plainly when it is missing, waiting or ended, and
 * long-lived work always picks up a renewed token for the same login.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { loginPrincipal, markLoginEnded, renewLogin, saveLogin } from './auth-store.mjs'
import { pendingSignInPath } from './devspec-login.mjs'
import { writePrivateJson } from './private-state.mjs'
import { readStateFile } from './remote-control-state.mjs'
import { runSessionStart } from './session-start.mjs'
import { renderStatusLine } from './statusline.mjs'

const HOUR = 60 * 60 * 1000
const PROD = 'https://api.devspec.ai/api/mcp'
const CONN = '0b7c2d4e-1111-4222-8333-944455556666'

let home
let savedHome
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-surfaces-'))
  savedHome = process.env.HOME
  process.env.HOME = home
})
afterEach(() => {
  process.env.HOME = savedHome
  fs.rmSync(home, { recursive: true, force: true })
})

function save(tag, issuedAt = Date.now()) {
  return saveLogin(
    {
      endpoint: PROD,
      tokens: { accessToken: `oat_${tag}`, refreshToken: `rt_${tag}`, issuedAt, expiresAt: issuedAt + 24 * HOUR },
      issuer: 'https://clerk.devspec.ai',
      tokenEndpoint: 'https://clerk.devspec.ai/oauth/token',
      clientId: 'Gmbtf7QgaoSw7WJ0',
      resource: PROD,
    },
    { home },
  )
}

const statusLine = () => renderStatusLine(JSON.stringify({ conversation_id: 'conv-1', cwd: home }), { home, env: {} })

describe('the status bar', () => {
  it('says when the approval is waiting in the browser, and when the sign-in has ended', async () => {
    writePrivateJson(pendingSignInPath(PROD, home), { pid: process.pid, startedAt: new Date().toISOString(), url: 'https://x' }, { root: path.join(home, '.devspec') })
    assert.equal(statusLine(), 'DevSpec: approve Antigravity in your browser to finish signing in')
    fs.rmSync(pendingSignInPath(PROD, home))
    await save('a')
    assert.equal(statusLine(), '', 'nothing to say once signed in and not connected')
    await markLoginEnded(PROD, 'oat_a', 'signed_out', { home })
    assert.equal(statusLine(), 'DevSpec: sign-in ended (/devspec-login to sign in again)')
  })
})

describe('a connection made with the browser login', () => {
  it('is read with the login’s current token after a renewal', async () => {
    const login = await save('day1')
    const dir = path.join(home, '.devspec', 'remote-control', 'connections')
    writePrivateJson(path.join(dir, `${CONN}.json`), {
      connection_id: CONN,
      enabled: true,
      mcp_url: PROD,
      token: 'oat_day1',
      auth_source: 'login',
      auth_principal: loginPrincipal(login),
    })
    await renewLogin(PROD, {
      home,
      now: () => Date.now() + 13 * HOUR,
      refresh: async () => ({ accessToken: 'oat_day2', refreshToken: 'rt_day2', issuedAt: Date.now(), expiresAt: Date.now() + 24 * HOUR }),
    })
    assert.equal(readStateFile(CONN, dir).token, 'oat_day2')
  })

  it('whose sign-in ended has the person told at the next session start', async () => {
    const login = await save('gone')
    await markLoginEnded(PROD, 'oat_gone', 'signed_out', { home })
    const start = () =>
      runSessionStart(JSON.stringify({ conversation_id: 'conv-ended', cwd: home }), {
        home,
        cwd: home,
        env: {},
        loadStateFn: () => ({
          connection_id: CONN,
          enabled: true,
          local_id: 'conv-ended',
          mcp_url: PROD,
          token: 'oat_gone',
          auth_source: 'login',
          auth_principal: loginPrincipal(login),
        }),
        writeStateFn: () => {},
        writeBondFn: () => {},
        ensurePollerFn: () => ({ ok: true }),
        startSignInFn: () => assert.fail('an ended sign-in never reopens the browser by itself'),
      })
    const context = (await start()).hookSpecificOutput.additionalContext
    assert.match(context, /sign-in for remote control and commit tracking has ended/)
    assert.match(context, /Run \/devspec-login to sign in again/)
    assert.match(context, /Tell the person this once/)
    assert.match(context, /DevSpec Remote Control active/)
    const later = (await start()).hookSpecificOutput.additionalContext
    assert.match(later, /has ended/, 'still there for the agent')
    assert.match(later, /If the person asks/, 'but told to the person only once; the status bar keeps showing it')
  })
})

describe('the environment token at session start', () => {
  it('is named, with how to remove it, when it hides a browser sign-in', async () => {
    await save('browser')
    const out = await runSessionStart(JSON.stringify({ conversation_id: 'conv-env', cwd: home }), {
      home,
      cwd: home,
      env: { DEVSPEC_MCP_TOKEN: 'dvs_ci_token_123456' },
      loadStateFn: () => null,
    })
    assert.match(out.hookSpecificOutput.additionalContext, /DEVSPEC_MCP_TOKEN is set in this environment/)
    assert.equal(
      await runSessionStart(JSON.stringify({ conversation_id: 'conv-env2', cwd: home }), {
        home: fs.mkdtempSync(path.join(home, 'other-')),
        cwd: home,
        env: { DEVSPEC_MCP_TOKEN: 'dvs_ci_token_123456' },
        loadStateFn: () => null,
      }),
      null,
      'on a machine with no browser sign-in, the token is the intended setup and nothing is said',
    )
  })
})
