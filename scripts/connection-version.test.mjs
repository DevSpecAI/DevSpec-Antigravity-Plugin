import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseConnectionCall, runConnectionCall, publicConnectionResult } from './connection-call.mjs'
import { LOADED_PLUGIN_VERSION, PLUGIN_HEADER, pluginHeaderValue, pluginHeaders } from './connection-version.mjs'
import { mcpToolsCall } from './mcp-call.mjs'

const here = dirname(fileURLToPath(import.meta.url)), root = resolve(here, '..')
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
const auth = () => ({ ok: true, token: 'fixture-secret', mcp_url: 'https://fixture.example.test/api/mcp' })

test('mechanical register/attach calls carry the artifact version and preserve caller scope', async () => {
  const calls = []
  for (const name of ['register_connection', 'attach_connection']) {
    const result = await runConnectionCall(name, { project_id: 'p', local_id: 'local', connection_id: 'c', session_id: 's', host_version: 'guess' }, { resolveAuth: auth, call: async input => { calls.push(input); return { connection_id: 'c', _meta: { connection_capability: 'dvsc_private_fixture' } } } })
    assert.equal(result.connection_id, 'c'); assert.equal(result._meta, undefined)
  }
  assert.equal(LOADED_PLUGIN_VERSION, version)
  for (const call of calls) {
    assert.equal(call.arguments.plugin_version, version)
    assert.equal(call.arguments.host_version, undefined)
    assert.equal(call.arguments.connection_id, 'c')
  }
  assert.equal(calls[0].arguments.agent_name, 'Antigravity')
})
test('internal capability re-registration also gains the same version at the transport boundary', async () => {
  const old = globalThis.fetch; let sent
  globalThis.fetch = async (_url, init) => {
    sent = JSON.parse(init.body).params
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{"connection_id":"c"}' }] } }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    await mcpToolsCall({ mcpUrl: 'https://fixture.example.test/api/mcp', token: 'fixture', name: 'register_connection', arguments: { connection_capability_version: 1 } })
    assert.equal(sent.arguments.plugin_version, version)
    assert.equal(sent.arguments.connection_capability_version, 1)
  } finally { globalThis.fetch = old }
})
test('the helper is narrow and never prints credentials or private result metadata', async () => {
  assert.throws(() => parseConnectionCall(['post_session_message']))
  assert.throws(() => parseConnectionCall(['register_connection', '--token', 'secret']))
  assert.throws(() => parseConnectionCall(['attach_connection', '--connection-id', 'c']))
  assert.deepEqual(parseConnectionCall(['attach_connection', '--connection-id', 'c', '--session', 's']), { name: 'attach_connection', args: { connection_id: 'c', session_id: 's' } })
  const cleaned = publicConnectionResult({ raw: 'fixture-secret dvsc_private_value', data: { _meta: { secret: 'hidden' } } }, 'fixture-secret')
  assert.ok(!JSON.stringify(cleaned).includes('fixture-secret')); assert.ok(!JSON.stringify(cleaned).includes('dvsc_private_value')); assert.ok(!JSON.stringify(cleaned).includes('hidden'))
  await assert.rejects(runConnectionCall('register_connection', { local_id: 'local' }, { resolveAuth: auth, call: async () => { throw new Error('fixture-secret dvsc_private_value') } }), error => !error.message.includes('fixture-secret') && !error.message.includes('dvsc_private_value'))
  await assert.rejects(runConnectionCall('register_connection', {}, { resolveAuth: () => { throw new Error('private credential') } }), error => !error.message.includes('private credential'))
})
test('Connect uses the actual scripts layout and the mechanical caller, not a fictitious native hook', () => {
  const skill = readFileSync(join(root, 'skills/devspec-remote/SKILL.md'), 'utf8')
  assert.ok(skill.includes('connection-call.mjs" register_connection'))
  assert.ok(skill.includes('connection-call.mjs" attach_connection'))
  assert.ok(!skill.includes('<plugin>/hooks/scripts/'))
  const hooks = JSON.parse(readFileSync(join(root, 'hooks.json'), 'utf8'))
  assert.ok(!JSON.stringify(hooks).includes('hooks/scripts/'))
})
test('an installed artifact reports its own loaded package rather than later file contents', async () => {
  const fixture = mkdtempSync(join(tmpdir(), 'antigravity-version-artifact-'))
  try {
    mkdirSync(join(fixture, 'scripts'))
    const manifest = join(fixture, 'package.json')
    writeFileSync(manifest, JSON.stringify({ name: 'devspec-antigravity-plugin', version: '1.2.3', type: 'module' }))
    const file = join(fixture, 'scripts/connection-version.mjs')
    writeFileSync(file, readFileSync(join(here, 'connection-version.mjs')))
    // Its one import: the plugin id for the x-devspec-plugin header.
    writeFileSync(join(fixture, 'scripts/agent-identity.mjs'), readFileSync(join(here, 'agent-identity.mjs')))
    const loaded = await import(pathToFileURL(file).href)
    assert.equal(loaded.LOADED_PLUGIN_VERSION, '1.2.3')
    writeFileSync(manifest, JSON.stringify({ name: 'devspec-antigravity-plugin', version: '9.9.9' }))
    assert.equal(loaded.versionedConnectionArguments('attach_connection', {}).plugin_version, '1.2.3')
    // The header names the release that loaded, not a later file on disk.
    assert.deepEqual(loaded.pluginHeaders(), { 'x-devspec-plugin': 'antigravity/1.2.3' })
  } finally { rmSync(fixture, { recursive: true, force: true }) }
})
test('Stop marks the connection offline and detaches through the mechanical caller, so the model calls no plumbing', async () => {
  assert.deepEqual(parseConnectionCall(['heartbeat_connection', '--connection-id', 'c', '--status', 'offline', '--end-reason', 'local_stop']),
    { name: 'heartbeat_connection', args: { connection_id: 'c', status: 'offline', end_reason: 'local_stop' } })
  assert.deepEqual(parseConnectionCall(['detach_connection', '--connection-id', 'c']), { name: 'detach_connection', args: { connection_id: 'c' } })
  assert.throws(() => parseConnectionCall(['heartbeat_connection', '--connection-id', 'c']), /--status/)
  assert.throws(() => parseConnectionCall(['poll_connection', '--connection-id', 'c']), /Choose one of/)
  const calls = []
  await runConnectionCall('heartbeat_connection', { connection_id: 'c', status: 'offline', end_reason: 'local_stop' }, { resolveAuth: auth, call: async input => { calls.push(input); return { ok: true } } })
  assert.deepEqual(calls[0].arguments, { connection_id: 'c', status: 'offline', end_reason: 'local_stop' })
  const stop = readFileSync(join(root, 'skills/devspec-remote-stop/SKILL.md'), 'utf8')
  assert.ok(stop.includes('connection-call.mjs" heartbeat_connection'))
  assert.ok(stop.includes('connection-call.mjs" detach_connection'))
  assert.ok(!stop.includes('<plugin>/hooks/scripts/'))
  const remote = readFileSync(join(root, 'skills/devspec-remote/SKILL.md'), 'utf8')
  assert.ok(!/heartbeat_connection\(|poll_connection\(\{/.test(remote))
})

test('the x-devspec-plugin header is antigravity/<the loaded package version>, or absent', () => {
  assert.equal(PLUGIN_HEADER, 'x-devspec-plugin')
  assert.equal(pluginHeaderValue(), `antigravity/${version}`)
  assert.deepEqual(pluginHeaders(), { 'x-devspec-plugin': `antigravity/${version}` })
  assert.equal(pluginHeaderValue('1.2.3-rc.1'), 'antigravity/1.2.3-rc.1')
  // <id>/<version> must stay one split: an unreadable or slash-bearing version sends nothing.
  for (const bad of [null, '', 'has space', 'a/b', '../1']) assert.deepEqual(pluginHeaders(bad), {}, String(bad))
})
