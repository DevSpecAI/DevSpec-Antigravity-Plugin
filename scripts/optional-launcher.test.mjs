import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import { runConnectionCall } from './connection-call.mjs'
test('Antigravity Connect stays authenticated without installing a launcher', async () => {
  assert.equal(fs.existsSync(new URL('../launcher', import.meta.url)), false)
  assert.equal(fs.existsSync(new URL('./setup-launcher.mjs', import.meta.url)), false)
  assert.doesNotMatch(fs.readFileSync(new URL('./connection-call.mjs', import.meta.url), 'utf8'), /setupAntigravityLauncher|setup-launcher/)
  let observed
  const result = await runConnectionCall('register_connection', { local_id: 'test-conversation', cwd: '/fixture' }, {
    resolveAuth: () => ({ ok: true, token: 'test-token', mcp_url: 'https://fixture.invalid/api/mcp' }),
    call: async input => { observed = input; return { connection_id: 'fixture-connection' } },
  })
  assert.equal(observed.name, 'register_connection')
  assert.equal(observed.token, 'test-token')
  assert.equal(observed.arguments.agent_name, 'Antigravity')
  assert.equal(result.connection_id, 'fixture-connection')
})
