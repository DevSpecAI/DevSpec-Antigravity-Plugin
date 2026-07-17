#!/usr/bin/env node
/**
 * Unit tests for conversation-scoped remote-control resolve-local.
 * Run: node --test hooks/scripts/remote-control-state.test.mjs
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  detectLocalId,
  ensurePollerForSession,
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

describe('resolveLocalAction', () => {
  const agent = 'Grok Build'
  const localId = 'conv-aaa'
  const sessionId = '11111111-1111-1111-1111-111111111111'
  const now = Date.parse('2026-07-12T12:00:00.000Z')

  it('create_session when no local id (fresh terminal, bare remote)', () => {
    const r = resolveLocalAction({ agent, localId: null, now })
    assert.equal(r.action, 'create_session')
    assert.equal(r.session_id, null)
    assert.match(r.note, /No local conversation id/)
  })

  it('create_session with forceNew even if bond is live', () => {
    const r = resolveLocalAction({
      agent,
      localId,
      forceNew: true,
      now,
      readBond: () => ({
        local_id: localId,
        session_id: sessionId,
        status: 'live',
        session_codename: 'Colorful Possum',
      }),
      readSession: () => ({ enabled: true, session_id: sessionId }),
    })
    assert.equal(r.action, 'create_session')
  })

  it('create_session when bond missing for this conversation', () => {
    const r = resolveLocalAction({
      agent,
      localId,
      now,
      readBond: () => null,
      readSession: () => null,
    })
    assert.equal(r.action, 'create_session')
  })

  it('already_live when this conversation owns an enabled session', () => {
    const r = resolveLocalAction({
      agent,
      localId,
      now,
      readBond: () => ({
        local_id: localId,
        session_id: sessionId,
        status: 'live',
        agent_name: agent,
        session_codename: 'Colorful Possum',
        updated_at: '2026-07-12T11:55:00.000Z',
      }),
      readSession: () => ({
        session_id: sessionId,
        enabled: true,
        session_codename: 'Colorful Possum',
        updated_at: '2026-07-12T11:55:00.000Z',
      }),
    })
    assert.equal(r.action, 'already_live')
    assert.equal(r.session_id, sessionId)
    assert.equal(r.session_codename, 'Colorful Possum')
  })

  it('reconnect after recent local_stop for THIS conversation only', () => {
    const r = resolveLocalAction({
      agent,
      localId,
      now,
      maxAgeMinutes: 30,
      readBond: () => ({
        local_id: localId,
        session_id: sessionId,
        status: 'stopped',
        end_reason: 'local_stop',
        agent_name: agent,
        session_codename: 'Silent Fox',
        updated_at: '2026-07-12T11:50:00.000Z',
      }),
      readSession: () => ({
        session_id: sessionId,
        enabled: false,
        end_reason: 'local_stop',
        session_codename: 'Silent Fox',
        updated_at: '2026-07-12T11:50:00.000Z',
        cursor_after_message_id: 'msg-1',
      }),
    })
    assert.equal(r.action, 'reconnect')
    assert.equal(r.session_id, sessionId)
    assert.equal(r.cursor_after_message_id, 'msg-1')
  })

  it('create_session when prior stop is stale (> TTL)', () => {
    const r = resolveLocalAction({
      agent,
      localId,
      now,
      maxAgeMinutes: 30,
      readBond: () => ({
        local_id: localId,
        session_id: sessionId,
        status: 'stopped',
        end_reason: 'local_stop',
        updated_at: '2026-07-12T10:00:00.000Z', // 2h earlier
      }),
      readSession: () => ({
        enabled: false,
        end_reason: 'local_stop',
        updated_at: '2026-07-12T10:00:00.000Z',
      }),
    })
    assert.equal(r.action, 'create_session')
    assert.equal(r.session_id, null)
    assert.equal(r.prior_session_id, sessionId)
  })

  it('create_session after UI end (no ambient reattach)', () => {
    const r = resolveLocalAction({
      agent,
      localId,
      now,
      readBond: () => ({
        local_id: localId,
        session_id: sessionId,
        status: 'stopped',
        end_reason: 'ui',
        updated_at: '2026-07-12T11:55:00.000Z',
      }),
      readSession: () => ({
        enabled: false,
        end_reason: 'ui',
        ended_from_ui: true,
        updated_at: '2026-07-12T11:55:00.000Z',
      }),
    })
    assert.equal(r.action, 'create_session')
    assert.match(r.note, /ended from the UI/)
  })

  it('does not reconnect a foreign conversation bond (different localId → no bond)', () => {
    // Simulate: Codex left a stopped session for another local id; Grok has no bond
    const r = resolveLocalAction({
      agent: 'Grok Build',
      localId: 'grok-fresh-id',
      now,
      readBond: () => null, // no bond for Grok's local id
      readSession: () => ({
        // Even if cwd-matching session files exist, we never read them without a bond
        session_id: 'bad12d41-229b-4bcf-afee-fa1a093888c8',
        enabled: false,
        end_reason: 'local_stop',
        agent_name: 'Codex',
        cwd: '/home/n3o/Software_Projects/DevSpec/devspecv2',
        updated_at: '2026-07-12T11:50:00.000Z',
      }),
    })
    assert.equal(r.action, 'create_session')
    assert.equal(r.session_id, null)
  })

  it('two different local ids never share already_live', () => {
    const bonds = {
      'term-a': {
        local_id: 'term-a',
        session_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        status: 'live',
        session_codename: 'Amber Otter',
      },
      'term-b': {
        local_id: 'term-b',
        session_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        status: 'live',
        session_codename: 'Bold Raven',
      },
    }
    const ra = resolveLocalAction({
      agent,
      localId: 'term-a',
      now,
      readBond: (_a, id) => bonds[id],
      readSession: (sid) => ({ session_id: sid, enabled: true }),
    })
    const rb = resolveLocalAction({
      agent,
      localId: 'term-b',
      now,
      readBond: (_a, id) => bonds[id],
      readSession: (sid) => ({ session_id: sid, enabled: true }),
    })
    assert.equal(ra.action, 'already_live')
    assert.equal(rb.action, 'already_live')
    assert.notEqual(ra.session_id, rb.session_id)
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

describe('reapDeadPollers', () => {
  const agent = 'Claude Code'
  // A poller "runs" for every session by default in these tests.
  const findPidsAll = (sid) => [`pid-${sid}`]
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

  it('reaps a disabled session', () => {
    const { reaped, killed } = run([
      { session_id: 's-disabled', agent_name: agent, enabled: false },
    ])
    assert.equal(reaped.length, 1)
    assert.equal(reaped[0].reason, 'disabled')
    assert.deepEqual(killed, ['pid-s-disabled'])
  })

  it('reaps an owner-gone session (owner_pid recorded but dead)', () => {
    const { reaped } = run(
      [{ session_id: 's-orphan', agent_name: agent, enabled: true, owner_pid: 4242 }],
      { isOwnerAlive: noneAlive },
    )
    assert.equal(reaped.length, 1)
    assert.equal(reaped[0].reason, 'owner_gone')
  })

  it('reaps an ended-from-ui session', () => {
    const { reaped } = run([
      { session_id: 's-ui', agent_name: agent, enabled: true, ended_from_ui: true, owner_pid: 10 },
    ])
    assert.equal(reaped.length, 1)
    assert.equal(reaped[0].reason, 'ended_from_ui')
  })

  it('NEVER reaps a live session (enabled + owner alive)', () => {
    const { reaped, killed } = run(
      [{ session_id: 's-live', agent_name: agent, enabled: true, owner_pid: 999 }],
      { isOwnerAlive: allAlive },
    )
    assert.equal(reaped.length, 0)
    assert.deepEqual(killed, [])
  })

  it('does NOT reap an enabled session with no owner_pid (cannot prove dead)', () => {
    const { reaped } = run([{ session_id: 's-legacy', agent_name: agent, enabled: true }])
    assert.equal(reaped.length, 0)
  })

  it('skips the exceptSessionId (the one we are about to (re)use)', () => {
    const { reaped } = run(
      [{ session_id: 's-keep', agent_name: agent, enabled: false }],
      { args: { exceptSessionId: 's-keep' } },
    )
    assert.equal(reaped.length, 0)
  })

  it('only reaps this agent — a different agent is left alone', () => {
    const { reaped } = run([
      { session_id: 's-other', agent_name: 'Grok Build', enabled: false },
      { session_id: 's-mine', agent_name: agent, enabled: false },
    ])
    assert.deepEqual(
      reaped.map((r) => r.session_id),
      ['s-mine'],
    )
  })

  it('skips sessions with no running poller', () => {
    const { reaped } = run([{ session_id: 's-nopoller', agent_name: agent, enabled: false }], {
      findPids: () => [],
    })
    assert.equal(reaped.length, 0)
  })
})

describe('ensurePollerForSession (guards)', () => {
  it('rejects a missing/too-short session id without spawning', () => {
    assert.equal(ensurePollerForSession('').ok, false)
    assert.equal(ensurePollerForSession('short').ok, false)
    assert.match(ensurePollerForSession(null).error, /missing session id/)
  })
})
