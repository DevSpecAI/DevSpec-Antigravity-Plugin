import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  applyConnectionCapabilityRotation,
  stripConnectionCapability,
} from './connection-capability-state.mjs'

const state = {
  enabled: true,
  connection_id: 'connection',
  connection_capability: 'dvsc_old',
  connection_capability_version: 1,
}

describe('connection capability state lifecycle', () => {
  it('strips both secret fields without mutating other state', () => {
    assert.deepEqual(stripConnectionCapability(state), {
      enabled: true,
      connection_id: 'connection',
    })
    assert.equal(state.connection_capability, 'dvsc_old')
  })

  it('installs a successful rotation as one pair', () => {
    assert.deepEqual(applyConnectionCapabilityRotation(state, {
      ok: true,
      value: 'dvsc_new',
      version: 1,
    }), {
      enabled: true,
      connection_id: 'connection',
      connection_capability: 'dvsc_new',
      connection_capability_version: 1,
    })
  })

  it('clears stale capability on missing or failed rotation', () => {
    for (const rotation of [null, { ok: false, error: 'missing' }, { ok: false, error: 'failed' }]) {
      const next = applyConnectionCapabilityRotation(state, rotation)
      assert.equal(Object.hasOwn(next, 'connection_capability'), false)
      assert.equal(Object.hasOwn(next, 'connection_capability_version'), false)
    }
  })
})
