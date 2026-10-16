/**
 * The GitHub identity link at connect (item 7a01644a; server side c45f75d4). The
 * server builds the prompt and the plugin decides how to show it, so a status block
 * that dropped it would leave the person never asked, and nothing else would fail.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { renderStatusBlock } from './devspec-remote-connect.mjs'
import { githubIdentityFrom, readGithubIdentity, storeGithubIdentity } from './github-identity.mjs'

const summary = (github_identity) => ({
  agent_name: 'Antigravity',
  codename: 'Quiet Ferret',
  connection_id: '9cb41eaa-b79c-48c1-9424-783b37bab46a',
  status: 'registered',
  poller: { skipped: true },
  mcp_url: 'https://fixture.example/api/mcp',
  auth_ok: true,
  local_id: 'local',
  owner_pid: 1234,
  wake_armed: true,
  github_identity,
  registration: {},
})

test('a project with GitHub repositories shows the link to give the person, or who they are linked as', () => {
  const url = 'https://app.devspec.example/api/git/github/identity?returnTo=%2Fsettings'
  const notLinked = renderStatusBlock(
    summary(githubIdentityFrom({ github_identity: { status: 'link_required', url, message: 'Ask the person to link their GitHub account.' } })),
    { saveTiers: () => null },
  )
  assert.match(notLinked, /^GitHub: {5}NOT LINKED — Ask the person to link their GitHub account\.$/m)
  assert.ok(notLinked.includes(`Link: ${url}`))
  assert.match(notLinked, /never open it or link an account for them/)

  const linked = renderStatusBlock(summary(githubIdentityFrom({ github_identity: { status: 'linked', logins: ['DevSpecAliPrice'] } })), { saveTiers: () => null })
  assert.match(linked, /^GitHub: {5}linked as @DevSpecAliPrice$/m)

  assert.doesNotMatch(renderStatusBlock(summary(null), { saveTiers: () => null }), /GitHub:/)
})

test('only an https link from the server is shown, and a reused registration still shows it', () => {
  assert.equal(githubIdentityFrom({ github_identity: { status: 'link_required', url: 'javascript:alert(1)' } }), null)
  assert.equal(githubIdentityFrom({ github_identity: { status: 'linked', logins: [] } }), null)
  assert.equal(githubIdentityFrom({ github_identity: { status: 'something_new' } }), null)

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-github-identity-'))
  try {
    storeGithubIdentity('c1', { github_identity: { status: 'linked', logins: ['someone'] } }, { dir })
    assert.deepEqual(readGithubIdentity('c1', { dir }), { status: 'linked', logins: ['someone'] })
    // A later registration that says nothing forgets the old answer.
    storeGithubIdentity('c1', {}, { dir })
    assert.equal(readGithubIdentity('c1', { dir }), null)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
