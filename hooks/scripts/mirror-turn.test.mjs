#!/usr/bin/env node
/**
 * Unit tests for conversation-scoped remote-control turn mirroring.
 * Run: node --test hooks/scripts/mirror-turn.test.mjs
 *
 * These encode the cross-session-bleed regression: a machine-newer session that
 * belongs to a DIFFERENT conversation must never be selected for mirroring.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { resolveHookConversationId, selectBoundState } from './mirror-turn.mjs'

describe('resolveHookConversationId', () => {
  it('prefers CLAUDE_CODE_SESSION_ID env (the value write stamps)', () => {
    assert.equal(
      resolveHookConversationId('{"session_id":"stdin-conv"}', {
        CLAUDE_CODE_SESSION_ID: 'env-conv',
      }),
      'env-conv',
    )
  })

  it('falls back to CLAUDE_SESSION_ID', () => {
    assert.equal(resolveHookConversationId('{}', { CLAUDE_SESSION_ID: 'alt-conv' }), 'alt-conv')
  })

  it('resolves a non-Claude tool env id via the shared detectLocalId', () => {
    // Regression guard: the resolver must be tool-agnostic (symmetric with
    // connect-time detectLocalId). A Claude-only resolver silently fail-closes
    // every other plugin's mirror.
    assert.equal(resolveHookConversationId('{}', { GROK_SESSION_ID: 'grok-conv' }), 'grok-conv')
    assert.equal(resolveHookConversationId('{}', { CODEX_THREAD_ID: 'codex-conv' }), 'codex-conv')
  })

  it('falls back to hook stdin session_id when no env id', () => {
    assert.equal(resolveHookConversationId('{"session_id":"stdin-conv"}', {}), 'stdin-conv')
  })

  it('returns null when nothing identifies the conversation (fail closed)', () => {
    assert.equal(resolveHookConversationId('{}', {}), null)
    assert.equal(resolveHookConversationId('not json', {}), null)
    assert.equal(resolveHookConversationId('', {}), null)
  })
})

describe('selectBoundState', () => {
  const conv = 'conv-A'
  const mk = (raw, mtime) => ({ raw, mtime })
  const own = { enabled: true, session_id: 'sess-A', local_id: 'conv-A', agent_name: 'Claude Code' }
  const foreignNewer = {
    enabled: true,
    session_id: 'sess-B',
    local_id: 'conv-B',
    agent_name: 'Grok Build',
  }

  it('returns null when no conversation id (fail closed)', () => {
    assert.equal(selectBoundState([mk(own, 1)], null), null)
  })

  it('binds to THIS conversation, never the machine-newest foreign session', () => {
    // The pre-fix bug picked the newest state regardless of conversation.
    // foreignNewer has a far larger mtime; it must NOT win.
    const r = selectBoundState([mk(own, 1), mk(foreignNewer, 9999)], conv)
    assert.equal(r?.session_id, 'sess-A')
  })

  it('returns null when only a foreign conversation has state (fail closed)', () => {
    assert.equal(selectBoundState([mk(foreignNewer, 9999)], conv), null)
  })

  it('ignores disabled state for this conversation', () => {
    assert.equal(selectBoundState([mk({ ...own, enabled: false }, 1)], conv), null)
  })

  it('ignores state missing a session_id', () => {
    assert.equal(selectBoundState([mk({ ...own, session_id: null }, 1)], conv), null)
  })

  it("prefers the newest among THIS conversation's own states", () => {
    const older = { ...own, session_id: 'sess-A-old' }
    const newer = { ...own, session_id: 'sess-A-new' }
    const r = selectBoundState([mk(older, 1), mk(newer, 2)], conv)
    assert.equal(r?.session_id, 'sess-A-new')
  })

  it('tolerates null/garbage candidates', () => {
    const r = selectBoundState([null, undefined, mk(own, 5)], conv)
    assert.equal(r?.session_id, 'sess-A')
  })
})
