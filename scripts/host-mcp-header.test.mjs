/**
 * The user's Antigravity MCP config holds their DevSpec token. Keeping the
 * x-devspec-plugin header current there must never cost them the token, another
 * header, another server, the file's 0600 mode, or a file we could not parse
 * (item 7a01644a).
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { pluginHeaderValue } from './connection-version.mjs'
import { ensureHostPluginHeader, hostMcpConfigFiles } from './host-mcp-header.mjs'

function fixtureHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-host-header-'))
  const [primary, legacy] = hostMcpConfigFiles(home)
  fs.mkdirSync(path.dirname(primary), { recursive: true })
  fs.mkdirSync(path.dirname(legacy), { recursive: true })
  return { home, primary, legacy }
}

test('writes the running version onto the DevSpec entry and keeps everything else', () => {
  const { home, primary, legacy } = fixtureHome()
  try {
    const original = {
      mcpServers: {
        supabase: { type: 'http', serverUrl: 'https://mcp.supabase.example/mcp' },
        devspec: {
          type: 'http',
          serverUrl: 'https://api.devspec.example/api/mcp',
          headers: { Authorization: 'Bearer dvs_fixture_token', 'X-DevSpec-Plugin': 'antigravity/0.0.1', 'x-other': 'kept' },
        },
        axiom: { command: 'npx', args: ['-y', 'mcp-remote'] },
      },
    }
    fs.writeFileSync(primary, JSON.stringify(original, null, 2) + '\n', { mode: 0o600 })
    fs.writeFileSync(legacy, '{ not json', { mode: 0o600 })

    const first = ensureHostPluginHeader({ home })
    assert.deepEqual(first.updated, [primary])
    const written = JSON.parse(fs.readFileSync(primary, 'utf8'))
    assert.deepEqual(written.mcpServers.devspec.headers, {
      Authorization: 'Bearer dvs_fixture_token',
      'x-other': 'kept',
      'x-devspec-plugin': pluginHeaderValue(),
    })
    assert.deepEqual(written.mcpServers.supabase, original.mcpServers.supabase)
    assert.deepEqual(written.mcpServers.axiom, original.mcpServers.axiom)
    assert.equal(fs.statSync(primary).mode & 0o777, 0o600)
    assert.ok(fs.readFileSync(primary, 'utf8').endsWith('}\n'))
    assert.equal(fs.readFileSync(legacy, 'utf8'), '{ not json')

    // Already current: nothing is rewritten.
    const before = fs.statSync(primary).mtimeMs
    const second = ensureHostPluginHeader({ home })
    assert.deepEqual(second.updated, [])
    assert.deepEqual(second.unchanged, [primary])
    assert.equal(fs.statSync(primary).mtimeMs, before)

    // An update moves it to the new version.
    const third = ensureHostPluginHeader({ home, value: 'antigravity/9.9.9' })
    assert.deepEqual(third.updated, [primary])
    assert.equal(JSON.parse(fs.readFileSync(primary, 'utf8')).mcpServers.devspec.headers['x-devspec-plugin'], 'antigravity/9.9.9')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('leaves a config with no remote DevSpec entry, or no config at all, untouched', () => {
  const { home, primary } = fixtureHome()
  try {
    assert.deepEqual(ensureHostPluginHeader({ home }).updated, [])
    const stdioOnly = JSON.stringify({ mcpServers: { devspec: { command: 'node', args: ['bridge.mjs'] } } })
    fs.writeFileSync(primary, stdioOnly, { mode: 0o600 })
    assert.deepEqual(ensureHostPluginHeader({ home }).updated, [])
    assert.equal(fs.readFileSync(primary, 'utf8'), stdioOnly)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})
