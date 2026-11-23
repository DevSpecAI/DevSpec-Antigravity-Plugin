/**
 * Signing the background features in, end to end: the real scripts, run as their
 * own processes from a copy of the plugin pointed at a local stand-in for DevSpec
 * and its sign-in server, with a browser opener that only records the link. The test
 * plays the person's browser.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { loginState } from './auth-store.mjs'
import { lastSignIn, pendingSignIn } from './devspec-login.mjs'
import { signInNotice } from './session-start.mjs'
import { eventually, pluginCopy, sandbox, startSignInServer } from './sign-in-test-fixtures.mjs'

const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

let fake
let box
let plugin

beforeEach(async () => {
  fake = await startSignInServer()
  box = sandbox('login')
  plugin = pluginCopy(box.root, { mcpUrl: fake.mcpUrl, issuer: fake.base })
})
afterEach(async () => {
  // Let any background sign-in close its listener before the folder goes.
  const pending = pendingSignIn(fake.mcpUrl, { home: box.home })
  if (pending?.pid) {
    try {
      process.kill(pending.pid)
    } catch {
      /* already gone */
    }
  }
  box.remove()
  await fake.close()
})

function login(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(plugin, 'scripts', 'devspec-login.mjs'), ...args], {
      env: { ...box.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('exit', (code) => resolve({ code, stdout, stderr }))
  })
}

const linkIn = (text) => text.match(/https?:\/\/\S+\/oauth\/authorize\S*/)?.[0] ?? null

describe('/devspec-login', () => {
  it('opens one approval as Antigravity, and the browser brings it back; nothing asks the server in between', async () => {
    const first = await login(['--start'])
    assert.equal(first.code, 0, first.stderr)
    assert.match(first.stdout, /Approve Antigravity on DevSpec's page in your browser/)
    const link = linkIn(first.stdout)
    assert.ok(link, first.stdout)
    const request = new URL(link)
    assert.equal(request.searchParams.get('client_id'), 'TucS1MNZZlWpOUc7', "Antigravity's own sign-in app")
    assert.match(request.searchParams.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    assert.equal(request.searchParams.get('resource'), fake.mcpUrl)
    await eventually(() => box.openedLinks().length === 1)
    assert.deepEqual(box.openedLinks(), [link])

    // A second window asking at the same time joins the one approval.
    const second = await login(['--start'])
    assert.equal(linkIn(second.stdout), link)
    assert.equal(box.openedLinks().length, 1, 'no second browser tab')

    const before = fake.requests.length
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(fake.requests.length, before, 'waiting for the approval sends nothing to DevSpec or its sign-in server')

    const page = await fetch(fake.approve(link, 'code-start'))
    assert.match(await page.text(), /Signed in to DevSpec/)
    const state = await eventually(() => {
      const s = loginState(fake.mcpUrl, { home: box.home })
      return s.kind === 'active' ? s : null
    })
    assert.equal(state.login.signedInAs, 'Ada Lovelace')
    assert.equal(state.login.clientId, 'TucS1MNZZlWpOUc7')
    assert.deepEqual(
      fake.requests.map((r) => `${r.method} ${r.path}`),
      [
        'GET /.well-known/oauth-protected-resource/api/mcp',
        'GET /.well-known/oauth-authorization-server',
        'POST /oauth/token',
        'POST /api/mcp',
      ],
    )
    const verify = fake.requests.at(-1)
    assert.equal(verify.tool, 'verify_agent_connection', 'the new sign-in is checked with DevSpec before it is saved')
    assert.equal(verify.token, state.login.accessToken)
    assert.equal(verify.headers['x-devspec-plugin'], `antigravity/${VERSION}`)

    const status = await login(['--status'])
    assert.match(status.stdout, /signed in through the browser as Ada Lovelace/)
    const again = await login(['--start'])
    assert.match(again.stdout, /Already signed in/)
  })

  it('run in a terminal, it prints the link, waits for the browser, and says who it signed in as', async () => {
    const child = spawn(process.execPath, [path.join(plugin, 'scripts', 'devspec-login.mjs')], { env: box.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let approved = false
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      const link = linkIn(stdout)
      if (link && !approved) {
        approved = true
        fetch(fake.approve(link, 'code-terminal'))
      }
    })
    const code = await new Promise((resolve) => child.on('exit', resolve))
    assert.equal(code, 0)
    assert.match(stdout, /Signed in to DevSpec .* as Ada Lovelace\. Remote control and commit tracking are ready in Antigravity\./)
    assert.equal(loginState(fake.mcpUrl, { home: box.home }).kind, 'active')
  })

  it('over SSH it asks for the code flow instead of opening a listener the browser cannot reach', async () => {
    const result = await login(['--start'], { SSH_CONNECTION: '10.0.0.2 50000 10.0.0.1 22' })
    assert.match(result.stdout, /your browser cannot reach this machine/i)
    assert.match(result.stdout, /\/devspec-login --code/)
    assert.equal(fake.requests.length, 0)
    assert.equal(pendingSignIn(fake.mcpUrl, { home: box.home }), null)
  })

  it('with a code: the link, then the code DevSpec’s page shows, checked against this sign-in', async () => {
    const begin = await login(['--code'], { SSH_TTY: '/dev/pts/9' })
    assert.equal(begin.code, 0, begin.stderr)
    const link = linkIn(begin.stdout)
    assert.equal(new URL(link).searchParams.get('redirect_uri'), `${fake.base}/oauth-code`)
    assert.deepEqual(box.openedLinks(), [], 'over SSH nothing is opened here')
    const back = fake.approve(link, 'code-pasted')
    const shown = `${back.searchParams.get('code')}#${back.searchParams.get('state')}`

    const wrong = await login(['--code', 'code-pasted#from-another-sign-in'])
    assert.equal(wrong.code, 1)
    assert.match(wrong.stderr, /not from this sign-in/)
    const right = await login(['--code', shown])
    assert.equal(right.code, 0, right.stderr)
    assert.match(right.stdout, /Signed in to DevSpec .* as Ada Lovelace/)
    assert.equal(loginState(fake.mcpUrl, { home: box.home }).kind, 'active')
  })

  it('refuses to sign in while DEVSPEC_MCP_TOKEN is set, and says how to remove it', async () => {
    const result = await login(['--start'], { DEVSPEC_MCP_TOKEN: 'dvs_ci_token_123456' })
    assert.equal(result.code, 1)
    assert.match(result.stderr, /DEVSPEC_MCP_TOKEN is set in this environment/)
    assert.match(result.stderr, /unset DEVSPEC_MCP_TOKEN/)
    assert.equal(fake.requests.length, 0)
    assert.equal(loginState(fake.mcpUrl, { home: box.home }).kind, 'none')
  })

  it('a server that does not offer browser sign-in says so plainly', async () => {
    fs.writeFileSync(
      path.join(plugin, 'mcp_config.json'),
      JSON.stringify({ mcpServers: { devspec: { serverUrl: `${fake.base}/other/mcp`, oauth: { clientId: 'x' } } } }),
    )
    const result = await login(['--start'])
    assert.match(result.stdout, /could not start: This DevSpec server \(http:\/\/127\.0\.0\.1:\d+\) does not offer browser sign-in yet/)
  })

  it('signing out cancels the sign-in at the sign-in server, and no new window reopens the browser by itself', async () => {
    const started = await login(['--start'])
    await fetch(fake.approve(linkIn(started.stdout), 'code-logout'))
    const signedIn = await eventually(() => {
      const s = loginState(fake.mcpUrl, { home: box.home })
      return s.kind === 'active' ? s.login : null
    })
    const out = await login(['--logout'])
    assert.match(out.stdout, /Signed out of DevSpec/)
    assert.equal(loginState(fake.mcpUrl, { home: box.home }).kind, 'none')
    assert.deepEqual(fake.revoked, [{ token: signedIn.refreshToken, token_type_hint: 'refresh_token', client_id: 'TucS1MNZZlWpOUc7' }])
    assert.equal(lastSignIn(fake.mcpUrl, { home: box.home }).outcome, 'signed_out')

    let opened = 0
    const notice = signInNotice(
      { ok: false, reason: 'not_signed_in', mcp_url: fake.mcpUrl, error: 'not signed in' },
      { env: {}, home: box.home, startSignInFn: () => { opened += 1; return { status: 'started' } } },
    )
    assert.equal(opened, 0)
    assert.match(notice, /Run \/devspec-login to sign in/)
    assert.match(notice, /If the person asks/)
  })
})
