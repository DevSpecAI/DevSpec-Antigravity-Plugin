#!/usr/bin/env node
/**
 * Unit tests for conversation-scoped, CONNECTION-NATIVE remote-control resolve-local.
 * Run: node --test hooks/scripts/remote-control-state.test.mjs
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  detectLocalId,
  ensurePollerForConnection,
  isRecoverableEndReason,
  mintLocalId,
  ownerAlive,
  reapDeadPollers,
  resolveLocalAction,
} from './remote-control-state.mjs'

describe('detectLocalId', () => {
  it('prefers explicit --local-id over env', () => {
    const r = detectLocalId(
      { 'local-id': 'from-arg' },
      { CODEX_THREAD_ID: 'from-env', SHELL_SESSION_ID: 'shell' },
    )
    assert.equal(r.local_id, 'from-arg')
    assert.equal(r.source, 'arg')
  })

  it('prefers CODEX_THREAD_ID over SHELL_SESSION_ID', () => {
    const r = detectLocalId({}, { CODEX_THREAD_ID: 'thread-1', SHELL_SESSION_ID: 'shell-1' })
    assert.equal(r.local_id, 'thread-1')
    assert.equal(r.source, 'env:CODEX_THREAD_ID')
  })

  it('does not invent an id from cwd or empty env', () => {
    const r = detectLocalId({}, {})
    assert.equal(r.local_id, null)
    assert.equal(r.source, null)
  })

  it('sanitizes unsafe characters', () => {
    const r = detectLocalId({ 'local-id': 'abc/../evil;rm' }, {})
    assert.equal(r.local_id, 'abc..evilrm')
  })
})

describe('isRecoverableEndReason', () => {
  it('accepts local_stop idle_timeout auth only', () => {
    assert.equal(isRecoverableEndReason('local_stop'), true)
    assert.equal(isRecoverableEndReason('idle_timeout'), true)
    assert.equal(isRecoverableEndReason('auth'), true)
    assert.equal(isRecoverableEndReason('ui'), false)
    assert.equal(isRecoverableEndReason(null), false)
  })
})

describe('mintLocalId', () => {
  it('returns a uuid-like string', () => {
    const id = mintLocalId()
    assert.match(id, /^[0-9a-f-]{36}$/i)
  })
})

describe('resolveLocalAction (connection-native)', () => {
  const agent = 'Grok Build'
  const localId = 'conv-aaa'
  const connectionId = '22222222-2222-2222-2222-222222222222'
  const sessionId = '11111111-1111-1111-1111-111111111111'
  const now = Date.parse('2026-07-12T12:00:00.000Z')

  it('register when no local id (fresh terminal, bare remote)', () => {
    const r = resolveLocalAction({ agent, localId: null, now })
    assert.equal(r.action, 'register')
    assert.equal(r.connection_id, null)
    assert.equal(r.session_id, null)
    assert.match(r.note, /No local conversation id/)
  })

  it('create_and_attach with forceNew even if bond is live', () => {
    const r = resolveLocalAction({
      agent,
      localId,
      forceNew: true,
      now,
      readBond: () => ({
        local_id: localId,
        connection_id: connectionId,
        session_id: sessionId,
        status: 'live',
        session_codename: 'Colorful Possum',
      }),
      readConnection: () => ({ enabled: true, connection_id: connectionId }),
    })
    assert.equal(r.action, 'create_and_attach')
  })

  it('register when bond missing for this conversation', () => {
    const r = resolveLocalAction({
      agent,
      localId,
      now,
      readBond: () => null,
      readConnection: () => null,
    })
    assert.equal(r.action, 'register')
    assert.equal(r.connection_id, null)
  })

  it('already_live when this conversation owns an enabled connection', () => {
    const r = resolveLocalAction({
      agent,
      localId,
      now,
      readBond: () => ({
        local_id: localId,
        connection_id: connectionId,
        session_id: sessionId,
        status: 'live',
        agent_name: agent,
        session_codename: 'Colorful Possum',
        updated_at: '2026-07-12T11:55:00.000Z',
      }),
      readConnection: () => ({
        connection_id: connectionId,
        session_id: sessionId,
        enabled: true,
        session_codename: 'Colorful Possum',
        updated_at: '2026-07-12T11:55:00.000Z',
      }),
    })
    assert.equal(r.action, 'already_live')
    assert.equal(r.connection_id, connectionId)
    assert.equal(r.session_id, sessionId)
    assert.equal(r.session_codename, 'Colorful Possum')
  })

  it('already_live for a SESSIONLESS connection (no session attached)', () => {
    const r = resolveLocalAction({
      agent,
      localId,
      now,
      readBond: () => ({
        local_id: localId,
        connection_id: connectionId,
        session_id: null,
        status: 'live',
        agent_name: agent,
        updated_at: '2026-07-12T11:55:00.000Z',
      }),
      readConnection: () => ({
        connection_id: connectionId,
        session_id: null,
        enabled: true,
        updated_at: '2026-07-12T11:55:00.000Z',
      }),
    })
    assert.equal(r.action, 'already_live')
    assert.equal(r.connection_id, connectionId)
    assert.equal(r.session_id, null)
  })

  it('reconnect after recent local_stop for THIS conversation only', () => {
    const r = resolveLocalAction({
      agent,
      localId,
      now,
      maxAgeMinutes: 30,
      readBond: () => ({
        local_id: localId,
        connection_id: connectionId,
        session_id: sessionId,
        status: 'stopped',
        end_reason: 'local_stop',
        agent_name: agent,
        session_codename: 'Silent Fox',
        updated_at: '2026-07-12T11:50:00.000Z',
      }),
      readConnection: () => ({
        connection_id: connectionId,
        session_id: sessionId,
        enabled: false,
        end_reason: 'local_stop',
        session_codename: 'Silent Fox',
        updated_at: '2026-07-12T11:50:00.000Z',
        cursor_after_message_id: 'msg-1',
      }),
    })
    assert.equal(r.action, 'reconnect')
    assert.equal(r.connection_id, connectionId)
    assert.equal(r.session_id, sessionId)
    assert.equal(r.cursor_after_message_id, 'msg-1')
  })

  it('register when prior stop is stale (> TTL)', () => {
    const r = resolveLocalAction({
      agent,
      localId,
      now,
      maxAgeMinutes: 30,
      readBond: () => ({
        local_id: localId,
        connection_id: connectionId,
        session_id: sessionId,
        status: 'stopped',
        end_reason: 'local_stop',
        updated_at: '2026-07-12T10:00:00.000Z', // 2h earlier
      }),
      readConnection: () => ({
        connection_id: connectionId,
        enabled: false,
        end_reason: 'local_stop',
        updated_at: '2026-07-12T10:00:00.000Z',
      }),
    })
    assert.equal(r.action, 'register')
    assert.equal(r.connection_id, null)
    assert.equal(r.prior_connection_id, connectionId)
  })

  it('register after UI end (no ambient reattach)', () => {
    const r = resolveLocalAction({
      agent,
      localId,
      now,
      readBond: () => ({
        local_id: localId,
        connection_id: connectionId,
        session_id: sessionId,
        status: 'stopped',
        end_reason: 'ui',
        updated_at: '2026-07-12T11:55:00.000Z',
      }),
      readConnection: () => ({
        connection_id: connectionId,
        enabled: false,
        end_reason: 'ui',
        ended_from_ui: true,
        updated_at: '2026-07-12T11:55:00.000Z',
      }),
    })
    assert.equal(r.action, 'register')
    assert.match(r.note, /ended from the UI/)
  })

  it('does not reconnect a foreign conversation bond (different localId → no bond)', () => {
    const r = resolveLocalAction({
      agent: 'Grok Build',
      localId: 'grok-fresh-id',
      now,
      readBond: () => null, // no bond for Grok's local id
      readConnection: () => ({
        connection_id: 'bad12d41-229b-4bcf-afee-fa1a093888c8',
        enabled: false,
        end_reason: 'local_stop',
        agent_name: 'Codex',
        updated_at: '2026-07-12T11:50:00.000Z',
      }),
    })
    assert.equal(r.action, 'register')
    assert.equal(r.connection_id, null)
  })

  it('two different local ids never share already_live', () => {
    const bonds = {
      'term-a': {
        local_id: 'term-a',
        connection_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        status: 'live',
        session_codename: 'Amber Otter',
      },
      'term-b': {
        local_id: 'term-b',
        connection_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        status: 'live',
        session_codename: 'Bold Raven',
      },
    }
    const ra = resolveLocalAction({
      agent,
      localId: 'term-a',
      now,
      readBond: (_a, id) => bonds[id],
      readConnection: (cid) => ({ connection_id: cid, enabled: true }),
    })
    const rb = resolveLocalAction({
      agent,
      localId: 'term-b',
      now,
      readBond: (_a, id) => bonds[id],
      readConnection: (cid) => ({ connection_id: cid, enabled: true }),
    })
    assert.equal(ra.action, 'already_live')
    assert.equal(rb.action, 'already_live')
    assert.notEqual(ra.connection_id, rb.connection_id)
  })
})

describe('ownerAlive', () => {
  it('this process is alive; pid 1 / bad input are not adopted', () => {
    assert.equal(ownerAlive(process.pid), true)
    assert.equal(ownerAlive(1), false)
    assert.equal(ownerAlive(0), false)
    assert.equal(ownerAlive(null), false)
    assert.equal(ownerAlive(-5), false)
    assert.equal(ownerAlive(2_147_483_646), false) // implausible pid → ESRCH
  })
})

describe('reapDeadPollers (connection-native)', () => {
  const agent = 'Claude Code'
  // A poller "runs" for every connection by default in these tests.
  const findPidsAll = (cid) => [`pid-${cid}`]
  const noneAlive = () => false
  const allAlive = () => true

  function run(states, opts = {}) {
    const killed = []
    const reaped = reapDeadPollers({
      agent,
      listStates: () => states,
      findPids: opts.findPids || findPidsAll,
      isOwnerAlive: opts.isOwnerAlive || allAlive,
      kill: (pid) => {
        killed.push(pid)
        return true
      },
      ...opts.args,
    })
    return { reaped, killed }
  }

  it('reaps a disabled connection', () => {
    const { reaped, killed } = run([
      { connection_id: 'c-disabled', agent_name: agent, enabled: false },
    ])
    assert.equal(reaped.length, 1)
    assert.equal(reaped[0].reason, 'disabled')
    assert.deepEqual(killed, ['pid-c-disabled'])
  })

  it('reaps an owner-gone connection (owner_pid recorded but dead)', () => {
    const { reaped } = run(
      [{ connection_id: 'c-orphan', agent_name: agent, enabled: true, owner_pid: 4242 }],
      { isOwnerAlive: noneAlive },
    )
    assert.equal(reaped.length, 1)
    assert.equal(reaped[0].reason, 'owner_gone')
  })

  it('reaps an ended-from-ui connection', () => {
    const { reaped } = run([
      { connection_id: 'c-ui', agent_name: agent, enabled: true, ended_from_ui: true, owner_pid: 10 },
    ])
    assert.equal(reaped.length, 1)
    assert.equal(reaped[0].reason, 'ended_from_ui')
  })

  it('NEVER reaps a live connection (enabled + owner alive)', () => {
    const { reaped, killed } = run(
      [{ connection_id: 'c-live', agent_name: agent, enabled: true, owner_pid: 999 }],
      { isOwnerAlive: allAlive },
    )
    assert.equal(reaped.length, 0)
    assert.deepEqual(killed, [])
  })

  it('does NOT reap a no-owner_pid connection with no/fresh timestamp (unknown → leave alone)', () => {
    // No updated_at → staleness unknown → not reaped.
    const noStamp = run([{ connection_id: 'c-legacy', agent_name: agent, enabled: true }])
    assert.equal(noStamp.reaped.length, 0)
    // Fresh updated_at → clearly active → not reaped.
    const fresh = run(
      [
        {
          connection_id: 'c-legacy-fresh',
          agent_name: agent,
          enabled: true,
          updated_at: '2026-07-20T11:59:00.000Z',
        },
      ],
      { args: { now: Date.parse('2026-07-20T12:00:00.000Z') } },
    )
    assert.equal(fresh.reaped.length, 0)
  })

  it('reaps a STALE no-owner_pid connection (legacy backstop — zombie gap 00bd4f6e)', () => {
    const { reaped, killed } = run(
      [
        {
          connection_id: 'c-legacy-stale',
          agent_name: agent,
          enabled: true,
          updated_at: '2026-07-20T10:00:00.000Z', // 2h before `now`, threshold 1h
        },
      ],
      { args: { now: Date.parse('2026-07-20T12:00:00.000Z') } },
    )
    assert.equal(reaped.length, 1)
    assert.equal(reaped[0].reason, 'stale_no_owner')
    assert.deepEqual(killed, ['pid-c-legacy-stale'])
  })

  it('skips the exceptConnectionId (the one we are about to (re)use)', () => {
    const { reaped } = run(
      [{ connection_id: 'c-keep', agent_name: agent, enabled: false }],
      { args: { exceptConnectionId: 'c-keep' } },
    )
    assert.equal(reaped.length, 0)
  })

  it('only reaps this agent — a different agent is left alone', () => {
    const { reaped } = run([
      { connection_id: 'c-other', agent_name: 'Grok Build', enabled: false },
      { connection_id: 'c-mine', agent_name: agent, enabled: false },
    ])
    assert.deepEqual(
      reaped.map((r) => r.connection_id),
      ['c-mine'],
    )
  })

  it('skips connections with no running poller', () => {
    const { reaped } = run([{ connection_id: 'c-nopoller', agent_name: agent, enabled: false }], {
      findPids: () => [],
    })
    assert.equal(reaped.length, 0)
  })
})

describe('ensurePollerForConnection (guards)', () => {
  it('rejects a missing/too-short connection id without spawning', () => {
    assert.equal(ensurePollerForConnection('').ok, false)
    assert.equal(ensurePollerForConnection('short').ok, false)
    assert.match(ensurePollerForConnection(null).error, /missing connection id/)
  })

  it('refuses to spawn without a valid --owner-pid (no anchor → would zombie)', () => {
    // Valid-length connection id, script present, but no owner pid → refuse before
    // stopping/spawning anything, so the reaper can always prove a poller dead.
    const r = ensurePollerForConnection('11111111-1111-1111-1111-111111111111')
    assert.equal(r.ok, false)
    assert.match(r.error, /owner-pid/)
    const bad = ensurePollerForConnection('11111111-1111-1111-1111-111111111111', { ownerPid: 1 })
    assert.equal(bad.ok, false)
    assert.match(bad.error, /owner-pid/)
  })
})
