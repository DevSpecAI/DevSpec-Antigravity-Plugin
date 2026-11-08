/**
 * The DevSpec key stays off command lines, out of anything the plugin prints, and in
 * owner-only files (item b17cb7d7).
 *
 * The audit found the install docs and the missing-auth message telling people to run
 * `agy mcp add --header "Authorization: Bearer dvs_…"` (the key in that process's
 * argv and in shell history), commands that printed the raw key (agents then built
 * `curl -H "Authorization: Bearer …"` command lines from it), and key-holding files
 * whose 0600 was set only when they were first created.
 */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import {
  ensurePrivateDir,
  openPrivateAppend,
  POSIX_MODES,
  tightenPrivateTree,
  writePrivateJson,
} from './private-state.mjs'
import { printableAuth, tokenFingerprint } from './resolve-mcp-auth.mjs'
import { writeStateFile } from './remote-control-state.mjs'

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(SCRIPTS, '..')
const KEY = 'dvs_fixturekey0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRS'
const CSRF = 'csrf-fixture-value-0123456789'

const modeOf = (p) => fs.statSync(p).mode & 0o777
const posixOnly = { skip: POSIX_MODES ? false : 'POSIX modes do not apply on Windows' }

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `agy-key-${label}-`))
}

/** Run a plugin command as a separate process with its own HOME; returns stdout + stderr. */
function runPlugin(script, args, home, env = {}) {
  const result = spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], {
    cwd: home,
    env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, ...env },
    encoding: 'utf8',
    timeout: 20_000,
  })
  return `${result.stdout}\n${result.stderr}`
}

describe('no documented or shipped command carries the key', () => {
  it('no fenced command in any shipped document runs agy mcp add with a header', () => {
    const docs = execFileSync('git', ['ls-files', '-z', '*.md'], { cwd: ROOT, encoding: 'utf8' })
      .split('\0')
      .filter(Boolean)
    assert.ok(docs.includes('README.md'), 'the scan found no documents: it is broken, not clean')
    for (const file of docs) {
      if (path.basename(file) === 'CHANGELOG.md') continue // history names what was removed
      const text = fs.readFileSync(path.join(ROOT, file), 'utf8')
      for (const block of text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) {
        assert.doesNotMatch(block[1], /agy\s+mcp\s+add\b[^\n]*(?:--header|\s-H\s)/, `${file} tells people to put a header on agy's command line`)
      }
    }
  })

  it('resolve-mcp-auth.mjs reports the key by fingerprint only', () => {
    const home = tempDir('resolve')
    try {
      const out = runPlugin('resolve-mcp-auth.mjs', [], home, { DEVSPEC_MCP_TOKEN: KEY })
      assert.ok(!out.includes(KEY), 'the key was printed')
      assert.equal(JSON.parse(out.trim().split('\n')[0]).token_fingerprint, tokenFingerprint(KEY))
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('remote-control-state.mjs resolve-auth and read print no key and no CSRF token', () => {
    const home = tempDir('state-cli')
    try {
      const connDir = path.join(home, '.devspec', 'remote-control', 'connections')
      const state = { connection_id: 'conn-fixture-1', token: KEY, csrf_token: CSRF, connection_capability: 'dvsc_fixture' }
      writePrivateJson(path.join(connDir, 'conn-fixture-1.json'), state, { root: path.join(home, '.devspec') })
      writePrivateJson(path.join(home, '.devspec', 'remote-control.json'), state, { root: path.join(home, '.devspec') })

      const resolved = runPlugin('remote-control-state.mjs', ['resolve-auth'], home, { DEVSPEC_MCP_TOKEN: KEY })
      assert.ok(!resolved.includes(KEY), 'resolve-auth printed the key')
      assert.match(resolved, new RegExp(tokenFingerprint(KEY)))

      const read = runPlugin('remote-control-state.mjs', ['read', '--connection-id', 'conn-fixture-1'], home)
      assert.ok(!read.includes(KEY), 'read printed the key')
      assert.ok(!read.includes(CSRF), 'read printed the CSRF token')
      assert.ok(!read.includes('dvsc_fixture'), 'read printed the connection capability')
      const printed = JSON.parse(read)
      assert.equal(printed.token_fingerprint, tokenFingerprint(KEY))
      assert.equal(printed.csrf_token_present, true)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('a fingerprint is what DevSpec shows under Access tokens, and printableAuth drops the key', () => {
    assert.equal(tokenFingerprint(KEY), `${KEY.slice(0, 12)}…`)
    assert.equal(tokenFingerprint(''), null)
    const printed = printableAuth({ ok: true, token: KEY, mcp_url: 'https://x/api/mcp' })
    assert.equal('token' in printed, false)
    assert.equal(printed.token_fingerprint, tokenFingerprint(KEY))
  })
})

describe('files holding the key are owner-only after every write', posixOnly, () => {
  it('a state file that existed at 0644 in a 0775 folder ends up 0600 in 0700 folders, up to ~/.devspec', () => {
    const home = tempDir('state')
    try {
      const root = path.join(home, '.devspec')
      const connDir = path.join(root, 'remote-control', 'connections')
      fs.mkdirSync(connDir, { recursive: true })
      for (const d of [root, path.dirname(connDir), connDir]) fs.chmodSync(d, 0o775)
      const file = path.join(connDir, 'conn-1.json')
      fs.writeFileSync(file, '{}\n')
      fs.chmodSync(file, 0o644)

      writePrivateJson(file, { connection_id: 'conn-1', token: KEY }, { root })

      assert.equal(modeOf(file), 0o600)
      for (const d of [root, path.dirname(connDir), connDir]) assert.equal(modeOf(d), 0o700, d)
      assert.equal(modeOf(home), fs.statSync(home).mode & 0o777, 'the home folder is never touched')
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('writeStateFile replaces a looser connection state file with a 0600 one', () => {
    const dir = tempDir('conn')
    try {
      fs.chmodSync(dir, 0o775)
      const file = path.join(dir, 'conn-2.json')
      fs.writeFileSync(file, '{}\n')
      fs.chmodSync(file, 0o664)
      writeStateFile({ connection_id: 'conn-2', token: KEY }, dir)
      assert.equal(modeOf(file), 0o600)
      assert.equal(modeOf(dir), 0o700)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('logs opened for appending are owner-only, including one an earlier version left 0664', () => {
    const dir = tempDir('log')
    try {
      const log = path.join(dir, 'conn.poll.log')
      fs.writeFileSync(log, 'earlier\n')
      fs.chmodSync(log, 0o664)
      fs.closeSync(openPrivateAppend(log))
      assert.equal(modeOf(log), 0o600)
      const fresh = path.join(dir, 'sub', 'conn.listen.log')
      fs.closeSync(openPrivateAppend(fresh))
      assert.equal(modeOf(fresh), 0o600)
      assert.equal(modeOf(path.dirname(fresh)), 0o700)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('the SessionStart sweep tightens what earlier versions left and never follows a symlink out', () => {
    const home = tempDir('sweep')
    const outside = tempDir('outside')
    try {
      const root = path.join(home, '.devspec')
      const connDir = path.join(root, 'remote-control', 'connections')
      fs.mkdirSync(connDir, { recursive: true })
      for (const d of [root, path.dirname(connDir), connDir]) fs.chmodSync(d, 0o775)
      const log = path.join(connDir, 'old.poll.log')
      fs.writeFileSync(log, '')
      fs.chmodSync(log, 0o664)
      const kept = path.join(connDir, 'already.json')
      fs.writeFileSync(kept, '{}')
      fs.chmodSync(kept, 0o600)
      const target = path.join(outside, 'not-ours.txt')
      fs.writeFileSync(target, '')
      fs.chmodSync(target, 0o644)
      fs.symlinkSync(target, path.join(connDir, 'link.txt'))
      fs.symlinkSync(outside, path.join(connDir, 'linkdir'))

      const changed = tightenPrivateTree(root)

      assert.deepEqual(changed, { dirs: 3, files: 1 })
      assert.equal(modeOf(log), 0o600)
      assert.equal(modeOf(kept), 0o600)
      for (const d of [root, path.dirname(connDir), connDir]) assert.equal(modeOf(d), 0o700)
      assert.equal(modeOf(target), 0o644, 'a symlink target outside the tree is left alone')
      assert.equal(modeOf(outside), fs.statSync(outside).mode & 0o777)
      assert.deepEqual(tightenPrivateTree(root), { dirs: 0, files: 0 }, 'a second sweep has nothing to do')
      // Never the home folder itself: with HOME pointed at the fixture, a sweep of it is refused.
      const realHome = process.env.HOME
      fs.chmodSync(home, 0o775)
      process.env.HOME = home
      try {
        assert.deepEqual(tightenPrivateTree(home), { dirs: 0, files: 0 })
      } finally {
        process.env.HOME = realHome
      }
      assert.equal(modeOf(home), 0o775)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('ensurePrivateDir outside ~/.devspec tightens only the folder it is given', () => {
    const base = tempDir('outside-root')
    try {
      fs.chmodSync(base, 0o755)
      const dir = path.join(base, 'a', 'b')
      ensurePrivateDir(dir, { root: path.join(base, 'unrelated') })
      assert.equal(modeOf(dir), 0o700)
      assert.equal(modeOf(base), 0o755)
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
    }
  })
})
