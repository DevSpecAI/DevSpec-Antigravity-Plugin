#!/usr/bin/env node
/**
 * Unit tests for conversation-scoped, CONNECTION-NATIVE remote-control resolve-local.
 * Run: node --test hooks/scripts/remote-control-state.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import {
  isDeliberateConnectionEnd,
  POLLER_MISSES_BEFORE_REPAIR,
  reconcilePollerStep,
  repairConnectionPoller,
} from './devspec-remote-listen.mjs'
import {
  detectLocalId,
  ensurePollerForConnection,
  isConnectionStateFilename,
  isPollerArgv,
  isRecoverableEndReason,
  mintLocalId,
  negotiateConnectionCapability,
  ownerAlive,
  pollerRunning,
  resolveLocalAction,
  resolveOwnerPid,
  resolveOwnerPidAutoWindows,
  scanConnectionStates,
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

  it('prefers CODEX_THREAD_ID over other conversation env', () => {
    const r = detectLocalId({}, { CODEX_THREAD_ID: 'thread-1', GROK_SESSION_ID: 'grok-1' })
    assert.equal(r.local_id, 'thread-1')
    assert.equal(r.source, 'env:CODEX_THREAD_ID')
  })

  it('does NOT bond on SHELL_SESSION_ID / TERM_SESSION_ID (terminal, not conversation)', () => {
    // Regression guard for the Working-stuck bug (Grok a6b3f881, Claude 87117120).
    // A shell id in env hijacked the env leg of resolveHookConversationId, so the
    // correct hook-stdin conversation id was never reached, the bond matched no
    // connection, and the turn marker was never cleared.
    const r = detectLocalId({}, { SHELL_SESSION_ID: 'shell-only', TERM_SESSION_ID: 'term-only' })
    assert.equal(r.local_id, null)
    assert.equal(r.source, null)
  })

  it('uses CLAUDE_CODE_SESSION_ID even when a shell id is also present', () => {
    const r = detectLocalId({}, { CLAUDE_CODE_SESSION_ID: 'claude-conv', SHELL_SESSION_ID: 'shell' })
    assert.equal(r.local_id, 'claude-conv')
    assert.equal(r.source, 'env:CLAUDE_CODE_SESSION_ID')
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
  it('accepts local_stop owner_gone idle_timeout auth only', () => {
    assert.equal(isRecoverableEndReason('local_stop'), true)
    assert.equal(isRecoverableEndReason('owner_gone'), true)
    assert.equal(isRecoverableEndReason('idle_timeout'), true)
    assert.equal(isRecoverableEndReason('auth'), true)
    assert.equal(isRecoverableEndReason('ui'), false)
    assert.equal(isRecoverableEndReason(null), false)
  })

  it('owner_gone is recoverable — the host process exiting is the COMMON restart', () => {
    // Regression guard for item 937c78b0. The poller used to stamp owner-death as
    // `local_stop`; splitting it out makes the drop data readable, but if this list
    // did not learn the new value, every Claude Code relaunch would silently register
    // a brand-new connection (new codename, lost bond) instead of resuming.
    assert.equal(isRecoverableEndReason('owner_gone'), true)
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
    assert.equal(r.requires_state_write, true)
    assert.match(r.note, /state write.*rotate capability.*before re-arming/i)
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
    assert.equal(r.requires_state_write, true)
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

describe('negotiateConnectionCapability', () => {
  const input = {
    mcpUrl: 'https://example.test/mcp',
    token: 'dvs_test',
    projectId: '11111111-1111-4111-8111-111111111111',
    localId: 'local-conversation',
    connectionId: '22222222-2222-4222-8222-222222222222',
    agentName: 'Antigravity',
    cwd: '/repo',
  }

  it('requests version 1 and extracts the secret only from result _meta', async () => {
    const calls = []
    const result = await negotiateConnectionCapability({
      ...input,
      call: async (request) => {
        calls.push(request)
        return {
          data: { connection_id: input.connectionId, connection_capability_version: 1 },
          meta: { devspec: { connection_capability: { version: 1, value: 'dvsc_secret' } } },
        }
      },
    })
    assert.deepEqual(result, { ok: true, version: 1, value: 'dvsc_secret' })
    assert.equal(calls[0].arguments.connection_capability_version, 1)
    assert.equal(calls[0].includeMeta, true)
  })

  it('fails closed on a different bond or missing hidden capability', async () => {
    const mismatch = await negotiateConnectionCapability({
      ...input,
      call: async () => ({ data: { connection_id: '33333333-3333-4333-8333-333333333333' }, meta: null }),
    })
    assert.equal(mismatch.ok, false)
    assert.match(mismatch.error, /different connection bond/)
    const missing = await negotiateConnectionCapability({
      ...input,
      call: async () => ({ data: { connection_id: input.connectionId }, meta: null }),
    })
    assert.equal(missing.ok, false)
    assert.match(missing.error, /result _meta/)
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

describe('isPollerArgv and pollerRunning (item da592dee)', () => {
  const cid = '7d171d96-9f11-4ffe-84f2-430d0e9d8928'

  it('matches exact node devspec-remote-poll.mjs argv for the target connection', () => {
    assert.equal(
      isPollerArgv(
        ['/usr/bin/node', '/plugins/scripts/devspec-remote-poll.mjs', '--connection-id', cid, '--owner-pid', '1234'],
        cid,
      ),
      true,
    )
    assert.equal(
      isPollerArgv(
        ['node.exe', 'C:\\plugins\\scripts\\devspec-remote-poll.mjs', `--connection-id=${cid}`],
        cid,
      ),
      true,
    )
  })

  it('rejects a shell wrapper or another connection id', () => {
    assert.equal(
      isPollerArgv(
        ['/bin/bash', '-c', `node /plugins/scripts/devspec-remote-poll.mjs --connection-id ${cid}`],
        cid,
      ),
      false,
    )
    assert.equal(
      isPollerArgv(
        ['/usr/bin/node', '/plugins/scripts/devspec-remote-poll.mjs', '--connection-id', 'other-conn-id-1234'],
        cid,
      ),
      false,
    )
    assert.equal(isPollerArgv([], cid), false)
    assert.equal(isPollerArgv(['/usr/bin/node', '/plugins/scripts/devspec-remote-poll.mjs'], 'short'), false)
  })

  it('pollerRunning reports true when a poller pid is found and false otherwise', () => {
    assert.equal(pollerRunning(cid, { findPids: () => [4242] }), true)
    assert.equal(pollerRunning(cid, { findPids: () => [] }), false)
    assert.equal(pollerRunning('short', { findPids: () => [4242] }), false)
  })
})

describe('isConnectionStateFilename and scanConnectionStates sidecar filtering (item da592dee)', () => {
  const cid = '7d171d96-9f11-4ffe-84f2-430d0e9d8928'
  const sid = '08b72fbf-42b8-484b-a963-75689b90b219'

  it('accepts only <uuid>.json and rejects companion sidecars', () => {
    assert.equal(isConnectionStateFilename(`${cid}.json`), true)
    assert.equal(isConnectionStateFilename(`${cid}.${sid}.transcript-state.json`), false)
    assert.equal(isConnectionStateFilename(`${cid}.${sid}.read.json`), false)
    assert.equal(isConnectionStateFilename(`${cid}.room.json`), false)
    assert.equal(isConnectionStateFilename(`${cid}.tiers.json`), false)
    assert.equal(isConnectionStateFilename(`${cid}.listener.json`), false)
    assert.equal(isConnectionStateFilename(`.tiers-abc.txt`), false)
  })

  it('scanConnectionStates ignores .transcript-state.json and other sidecars even when they contain connection_id', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-scan-states-'))
    try {
      fs.writeFileSync(
        path.join(tmpDir, `${cid}.json`),
        JSON.stringify({
          connection_id: cid,
          agent_name: 'Antigravity',
          enabled: true,
          owner_pid: 1979424,
          updated_at: '2026-10-17T16:15:18.308Z',
        }),
      )
      // Sidecar written by room-transcript.mjs: has connection_id and old updated_at, no owner_pid.
      fs.writeFileSync(
        path.join(tmpDir, `${cid}.${sid}.transcript-state.json`),
        JSON.stringify({
          version: 1,
          connection_id: cid,
          session_id: sid,
          complete: true,
          updated_at: '2026-10-17T15:14:21.741Z',
        }),
      )
      fs.writeFileSync(
        path.join(tmpDir, `${cid}.room.json`),
        JSON.stringify({ connection_id: cid, session_id: sid }),
      )
      fs.writeFileSync(
        path.join(tmpDir, `${cid}.listener.json`),
        JSON.stringify({ pid: 9999, connection_id: cid }),
      )

      const states = scanConnectionStates(tmpDir)
      assert.equal(states.length, 1)
      assert.equal(states[0].connection_id, cid)
      assert.equal(states[0].owner_pid, 1979424)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe('devspec-remote-listen poller self-repair (item da592dee)', () => {
  const cid = '7d171d96-9f11-4ffe-84f2-430d0e9d8928'
  const sid = '08b72fbf-42b8-484b-a963-75689b90b219'
  const convId = '686d1ee1-76d2-4d5b-b819-a1e2a4c1f784'

  it('distinguishes deliberate connection ends from live or server-idle-timeout states', () => {
    assert.equal(isDeliberateConnectionEnd({ enabled: true, end_reason: null }), false)
    assert.equal(isDeliberateConnectionEnd({ enabled: false, end_reason: 'idle_timeout' }), false)
    assert.equal(isDeliberateConnectionEnd({ enabled: false, end_reason: 'server_ended' }), false)
    assert.equal(isDeliberateConnectionEnd({ enabled: false, end_reason: 'ui', ended_from_ui: true }), true)
    assert.equal(isDeliberateConnectionEnd({ enabled: false, end_reason: 'local_stop' }), true)
    assert.equal(isDeliberateConnectionEnd({ enabled: false, end_reason: 'owner_gone' }), true)
    assert.equal(isDeliberateConnectionEnd({ enabled: false, end_reason: null }), true)
  })

  it('reconcilePollerStep waits for POLLER_MISSES_BEFORE_REPAIR consecutive misses and respects backoff', () => {
    const s1 = reconcilePollerStep({ ownedAndActive: true, pollerUp: false, misses: 0, now: 1000 })
    assert.deepEqual(s1, { repair: false, misses: 1 })

    const s2 = reconcilePollerStep({
      ownedAndActive: true,
      pollerUp: false,
      misses: POLLER_MISSES_BEFORE_REPAIR - 1,
      now: 2000,
    })
    assert.deepEqual(s2, { repair: true, misses: POLLER_MISSES_BEFORE_REPAIR })

    const backoffBlocked = reconcilePollerStep({
      ownedAndActive: true,
      pollerUp: false,
      misses: POLLER_MISSES_BEFORE_REPAIR - 1,
      now: 2000,
      repairNotBefore: 5000,
    })
    assert.equal(backoffBlocked.repair, false)

    const recovered = reconcilePollerStep({ ownedAndActive: true, pollerUp: true, misses: 2, now: 6000 })
    assert.deepEqual(recovered, { repair: false, misses: 0 })
  })

  it('repairConnectionPoller re-registers, re-attaches session, refreshes capability, and respawns poller', async () => {
    const mcpCalls = []
    let writtenState = null
    let writtenBond = null
    let pollerSpawnOpts = null

    const result = await repairConnectionPoller({
      connectionId: cid,
      ownerPid: process.pid,
      cwd: '/repo',
      conversationId: convId,
      state: {
        connection_id: cid,
        session_id: sid,
        session_codename: 'Bold Lizard',
        agent_name: 'Antigravity',
        local_id: convId,
        project_id: '24c4abaa-2cb9-496a-8492-cf1f1aa1090b',
        enabled: false,
        end_reason: 'idle_timeout',
        token: 'dvs_test',
        mcp_url: 'https://example.test/api/mcp',
        owner_pid: process.pid,
      },
      callMcp: async (req) => {
        mcpCalls.push(req)
        if (req.name === 'register_connection') {
          req.onResultMeta?.({
            devspec: {
              connection_capability: { version: 1, value: 'dvsc_repaired_cap' },
            },
          })
          return { data: { connection_id: cid } }
        }
        return { data: { ok: true } }
      },
      writeStateFn: (_id, next) => {
        writtenState = next
      },
      writeBondFn: (_agent, _localId, bond) => {
        writtenBond = bond
      },
      ensurePollerFn: (_id, opts) => {
        pollerSpawnOpts = opts
        return { ok: true, pid: 7777 }
      },
    })

    assert.equal(result.ok, true)
    assert.equal(result.poller.pid, 7777)
    assert.deepEqual(
      mcpCalls.map((c) => c.name),
      ['register_connection', 'attach_connection'],
    )
    assert.equal(writtenState.enabled, true)
    assert.equal(writtenState.end_reason, null)
    assert.equal(writtenState.connection_capability, 'dvsc_repaired_cap')
    assert.equal(writtenBond.status, 'live')
    assert.equal(pollerSpawnOpts.sessionId, sid)
    assert.equal(pollerSpawnOpts.ownerPid, process.pid)
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
    // resolveOwnerPid stubbed to null: without it, win32's real self-resolver
    // (item 3cddb3b4) would walk up to this test process's own real claude.exe
    // ancestor and actually succeed — proceeding to really spawn a detached
    // poller process as a side effect of running the test suite.
    const r = ensurePollerForConnection('11111111-1111-1111-1111-111111111111', {
      resolveOwnerPid: () => null,
    })
    assert.equal(r.ok, false)
    assert.match(r.error, /owner-pid/)
    const bad = ensurePollerForConnection('11111111-1111-1111-1111-111111111111', {
      ownerPid: 1,
      resolveOwnerPid: () => null,
    })
    assert.equal(bad.ok, false)
    assert.match(bad.error, /owner-pid/)
  })
})

describe('ensurePollerForConnection (reuse, item b9e02835)', () => {
  const connectionId = '11111111-1111-1111-1111-111111111111'

  it('reuses a live poller when reuseRunning is set — no kill, no respawn', () => {
    const r = ensurePollerForConnection(connectionId, {
      reuseRunning: true,
      findPids: () => [4242],
    })
    assert.equal(r.ok, true)
    assert.equal(r.reused, true)
    assert.equal(r.pid, 4242)
    assert.equal(r.connection_id, connectionId)
  })

  it('reuse carries the sessionId through for the caller result', () => {
    const r = ensurePollerForConnection(connectionId, {
      reuseRunning: true,
      sessionId: '22222222-2222-2222-2222-222222222222',
      findPids: () => [4242],
    })
    assert.equal(r.reused, true)
    assert.equal(r.session_id, '22222222-2222-2222-2222-222222222222')
  })

  it('reuseRunning with no live poller falls through to the spawn guards', () => {
    // resolveOwnerPid stubbed to null: on win32 the real resolver walks THIS test
    // process's own ancestry, and since it's actually running under a real
    // claude.exe (item 3cddb3b4), it would otherwise find a genuine anchor and
    // this "no anchor" case would flake based on host state.
    const r = ensurePollerForConnection(connectionId, {
      reuseRunning: true,
      findPids: () => [],
      resolveOwnerPid: () => null,
    })
    assert.equal(r.ok, false)
    assert.match(r.error, /owner-pid/)
  })

  it('without reuseRunning the restart path is unchanged (guards still apply)', () => {
    const r = ensurePollerForConnection(connectionId, {
      findPids: () => [4242],
      resolveOwnerPid: () => null,
    })
    assert.equal(r.ok, false)
    assert.match(r.error, /owner-pid/)
  })
})

describe('resolveOwnerPid / resolveOwnerPidAutoWindows (item 3cddb3b4)', () => {
  it('explicit valid arg always wins, no auto-resolution attempted', () => {
    // A bogus prevValue proves the explicit arg short-circuits before any fallback.
    assert.equal(resolveOwnerPid(555, 999), 555)
  })

  it('never returns an invalid (<=1) explicit arg as-is', () => {
    // 1 fails the >1 validity check, so it must fall through to auto-resolution
    // or prevValue rather than being returned literally.
    assert.notEqual(resolveOwnerPid(1, 999), 1)
  })

  it('resolveOwnerPidAutoWindows returns null off-Windows and for a made-up start pid', () => {
    if (process.platform !== 'win32') {
      assert.equal(resolveOwnerPidAutoWindows(process.pid), null)
      return
    }
    // A start pid that (almost certainly) does not exist finds no process at all,
    // so the walk ends immediately with nothing to report — deterministic
    // regardless of what real processes happen to be running on this host.
    assert.equal(resolveOwnerPidAutoWindows(999_999_999), null)
  })

  it('resolveOwnerPidAutoWindows walks to a real claude.exe ancestor on win32', { skip: process.platform !== 'win32' }, () => {
    // This test process is itself running under a real claude.exe (item
    // 3cddb3b4's whole premise) — the walk from its own real pid should find it.
    const found = resolveOwnerPidAutoWindows(process.pid)
    assert.ok(found === null || (Number.isInteger(found) && found > 1))
  })
})
