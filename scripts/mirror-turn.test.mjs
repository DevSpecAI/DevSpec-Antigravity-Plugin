#!/usr/bin/env node
/**
 * Unit tests for conversation-scoped, CONNECTION-NATIVE remote-control turn mirroring.
 * Run: node --test hooks/scripts/mirror-turn.test.mjs
 *
 * These encode the cross-session-bleed regression: a machine-newer connection that
 * belongs to a DIFFERENT conversation must never be selected for mirroring.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import {
  resolveHookConversationId,
  selectBoundState,
  stripRemoteControlBanner,
  isOperationalChrome,
  prepareAgentMirrorText,
  explicitReplyMarkerPath,
  writeExplicitReplyMarker,
  consumeExplicitReplyMarker,
  parseTranscriptPath,
  normalizeTranscriptPath,
  syncStateTranscriptPath,
  extractUserRequestText,
  extractLatestTranscriptStep,
  launchedAntigravityBackgroundWork,
  handleMirrorTurn,
  recordOwnedLaunch,
  recordTurnWake,
  writeTurnMarker,
  readTurnMarker,
  extractAntigravityTrailFromTranscript,
  streamTurnTrailIfChanged,
} from './mirror-turn.mjs'
import { runPostToolDispatch } from './post-tool-dispatch.mjs'

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
    assert.equal(resolveHookConversationId('{}', { GROK_SESSION_ID: 'grok-conv' }), 'grok-conv')
    assert.equal(resolveHookConversationId('{}', { CODEX_THREAD_ID: 'codex-conv' }), 'codex-conv')
  })

  it('falls back to hook stdin session_id when no env id', () => {
    assert.equal(resolveHookConversationId('{"session_id":"stdin-conv"}', {}), 'stdin-conv')
  })

  it('reaches the stdin session_id even when the host shell exports a shell id', () => {
    // THE Working-stuck regression (Grok a6b3f881, Claude 87117120). SHELL_SESSION_ID
    // is set in real Claude Code environments. While detectLocalId still probed it,
    // it won the env leg and this fallback never ran, so Stop resolved a bond that
    // matched no connection — and with 2+ live connections of the same agent
    // selectBoundState fails closed, leaving the turn marker (and Working) forever.
    assert.equal(
      resolveHookConversationId('{"session_id":"stdin-conv"}', {
        SHELL_SESSION_ID: 'w0t0p0:AAAA-BBBB',
        TERM_SESSION_ID: 'term-1',
      }),
      'stdin-conv',
    )
  })

  it('returns null when nothing identifies the conversation (fail closed)', () => {
    assert.equal(resolveHookConversationId('{}', {}), null)
    assert.equal(resolveHookConversationId('not json', {}), null)
    assert.equal(resolveHookConversationId('', {}), null)
  })
})

describe('selectBoundState (connection-native)', () => {
  const conv = 'conv-A'
  const mk = (raw, mtime) => ({ raw, mtime })
  const own = {
    enabled: true,
    connection_id: 'conn-A',
    session_id: 'sess-A',
    local_id: 'conv-A',
    agent_name: 'Claude Code',
  }
  const foreignNewer = {
    enabled: true,
    connection_id: 'conn-B',
    session_id: 'sess-B',
    local_id: 'conv-B',
    agent_name: 'Grok Build',
  }

  it('returns null when no conversation id (fail closed)', () => {
    assert.equal(selectBoundState([mk(own, 1)], null), null)
  })

  it('binds to THIS conversation, never the machine-newest foreign connection', () => {
    const r = selectBoundState([mk(own, 1), mk(foreignNewer, 9999)], conv)
    assert.equal(r?.connection_id, 'conn-A')
  })

  it('returns null when only a foreign conversation has state (fail closed)', () => {
    assert.equal(selectBoundState([mk(foreignNewer, 9999)], conv), null)
  })

  it('ignores disabled state for this conversation', () => {
    assert.equal(selectBoundState([mk({ ...own, enabled: false }, 1)], conv), null)
  })

  it('ignores state missing a connection_id', () => {
    assert.equal(selectBoundState([mk({ ...own, connection_id: null }, 1)], conv), null)
  })

  it('binds a SESSIONLESS connection (session_id null) — the connection is the unit', () => {
    const sessionless = { ...own, session_id: null }
    const r = selectBoundState([mk(sessionless, 1)], conv)
    assert.equal(r?.connection_id, 'conn-A')
    assert.equal(r?.session_id, null)
  })

  it("prefers the newest among THIS conversation's own states", () => {
    const older = { ...own, connection_id: 'conn-A-old' }
    const newer = { ...own, connection_id: 'conn-A-new' }
    const r = selectBoundState([mk(older, 1), mk(newer, 2)], conv)
    assert.equal(r?.connection_id, 'conn-A-new')
  })

  it('tolerates null/garbage candidates', () => {
    const r = selectBoundState([null, undefined, mk(own, 5)], conv)
    assert.equal(r?.connection_id, 'conn-A')
  })

  // Fallback for tools that expose NO per-conversation id to hooks (Cursor,
  // Antigravity): the single enabled connection for THIS agent is unambiguous.
  it('falls back to the single enabled connection for THIS agent when no conversation id', () => {
    const cur = { enabled: true, connection_id: 'conn-C', session_id: null, local_id: null, agent_name: 'Cursor' }
    assert.equal(selectBoundState([mk(cur, 1)], null, 'Cursor')?.connection_id, 'conn-C')
  })

  it('fails closed with two concurrent connections of the same agent (cannot disambiguate)', () => {
    const a = { enabled: true, connection_id: 'conn-1', local_id: null, agent_name: 'Cursor' }
    const b = { enabled: true, connection_id: 'conn-2', local_id: null, agent_name: 'Cursor' }
    assert.equal(selectBoundState([mk(a, 1), mk(b, 2)], null, 'Cursor'), null)
  })

  it('the single-agent fallback ignores other agents; a precise bond still wins', () => {
    const cur = { enabled: true, connection_id: 'conn-CU', session_id: null, local_id: null, agent_name: 'Cursor' }
    assert.equal(selectBoundState([mk(own, 5), mk(cur, 1)], null, 'Cursor')?.connection_id, 'conn-CU')
    assert.equal(
      selectBoundState([mk(own, 5), mk(cur, 1)], 'conv-A', 'Claude Code')?.connection_id,
      'conn-A',
    )
  })
})

const BANNER = `━━━ DevSpec Remote Control ━━━
Agent:      Claude Code · Climbing Toucan
Connection: 7b3a74ae…
Session:    46ef72c0… | attached
Status:     registered + attached
Open:       Agents page
Stop with:  /devspec.remote-stop
─────────────────────────────`

describe('operational chrome filtering', () => {
  it('strips the remote-control status banner', () => {
    const out = stripRemoteControlBanner(`${BANNER}\n\n2`)
    assert.equal(out, '2')
  })

  it('treats banner-only Stop text as chrome', () => {
    assert.equal(isOperationalChrome(BANNER), true)
    assert.equal(prepareAgentMirrorText(BANNER), null)
  })

  it('treats banner + waiting spiel as chrome', () => {
    const t = `${BANNER}\nConnected and waiting for your next command from the session — I already replied to your "Hi" there.`
    assert.equal(isOperationalChrome(t), true)
    assert.equal(prepareAgentMirrorText(t), null)
  })

  it('skips connect / disconnect one-liners', () => {
    assert.equal(
      isOperationalChrome("You're connected to Brandon's Cursor agent on their local machine."),
      true,
    )
    assert.equal(isOperationalChrome('🔌 **Local agent disconnected**.'), true)
    assert.equal(prepareAgentMirrorText('🔌 **Local agent disconnected**.'), null)
  })

  it('keeps a real reply (fail open)', () => {
    const reply = '1 + 1 is 2.'
    assert.equal(isOperationalChrome(reply), false)
    assert.equal(prepareAgentMirrorText(reply), reply)
  })

  it('keeps a real reply after stripping a leading banner', () => {
    const mixed = `${BANNER}\n\nQueue same-tab Dev sends while streaming — done on staging.`
    assert.equal(isOperationalChrome(mixed), false)
    assert.equal(
      prepareAgentMirrorText(mixed),
      'Queue same-tab Dev sends while streaming — done on staging.',
    )
  })
})

describe('explicit-reply marker (double-post guard, item b9fb49a9)', () => {
  // Use a non-UUID test id so this can never collide with a real connection's
  // marker file under the shared ~/.devspec state dir.
  const testConnectionId = 'test-conn-explicit-reply-marker'

  function cleanup() {
    try {
      fs.rmSync(explicitReplyMarkerPath(testConnectionId), { force: true })
    } catch {
      /* ignore */
    }
  }

  it('reports absent when no marker was written', () => {
    cleanup()
    try {
      assert.equal(consumeExplicitReplyMarker(testConnectionId), false)
    } finally {
      cleanup()
    }
  })

  it('reports present once, then absent (single-consume — cannot leak into a later turn)', () => {
    cleanup()
    try {
      fs.mkdirSync(path.dirname(explicitReplyMarkerPath(testConnectionId)), { recursive: true })
      fs.writeFileSync(explicitReplyMarkerPath(testConnectionId), `${Date.now()}\n`)
      assert.equal(fs.existsSync(explicitReplyMarkerPath(testConnectionId)), true)
      assert.equal(consumeExplicitReplyMarker(testConnectionId), true)
      // Consumed — gone, and a second read never re-reports it.
      assert.equal(fs.existsSync(explicitReplyMarkerPath(testConnectionId)), false)
      assert.equal(consumeExplicitReplyMarker(testConnectionId), false)
    } finally {
      cleanup()
    }
  })

  it('returns false for a missing/empty connection id rather than throwing', () => {
    assert.equal(consumeExplicitReplyMarker(null), false)
    assert.equal(consumeExplicitReplyMarker(undefined), false)
    assert.equal(consumeExplicitReplyMarker(''), false)
  })

  it('marker path is scoped under the shared connections dir, keyed by connection id', () => {
    const p = explicitReplyMarkerPath(testConnectionId)
    assert.equal(path.basename(p), `${testConnectionId}.explicit-reply`)
    assert.equal(path.dirname(p), path.join(os.homedir(), '.devspec', 'remote-control', 'connections'))
  })
})

describe('Antigravity native hook payload & transcript handling', () => {
  it('resolves Antigravity conversationId and transcriptPath from stdin JSON', () => {
    const raw = JSON.stringify({
      conversationId: 'ca2d5a24-57ea-4252-90d0-82d4dd2504d1',
      transcriptPath: '/tmp/brain/ca2d5a24/.system_generated/logs/transcript.jsonl',
    })
    assert.equal(resolveHookConversationId(raw, {}), 'ca2d5a24-57ea-4252-90d0-82d4dd2504d1')
    assert.equal(
      parseTranscriptPath(raw),
      '/tmp/brain/ca2d5a24/.system_generated/logs/transcript.jsonl',
    )
  })

  it('extracts user prompt from <USER_REQUEST> wrapper in Antigravity transcript.jsonl', () => {
    const wrapped = '<USER_REQUEST>\nFix the hook schema\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nfoo\n</ADDITIONAL_METADATA>'
    assert.equal(extractUserRequestText(wrapped), 'Fix the hook schema')
  })

  it('mirrors USER_INPUT on PreInvocation once, skips mid-turn PLANNER_RESPONSE, and holds Stop on subagent launch', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-mirror-test-'))
    const connId = '11111111-2222-4333-8444-555555555555'
    const convId = 'ca2d5a24-57ea-4252-90d0-82d4dd2504d1'
    const transcriptFile = path.join(tmpDir, 'transcript.jsonl')
    try {
      fs.writeFileSync(
        path.join(tmpDir, `${connId}.json`),
        JSON.stringify({
          enabled: true,
          connection_id: connId,
          session_id: '22222222-3333-4444-8555-666666666666',
          local_id: convId,
          agent_name: 'Antigravity',
          token: 'dvs_test',
          mcp_url: 'https://fixture.invalid/api/mcp',
        }),
      )
      fs.writeFileSync(
        transcriptFile,
        JSON.stringify({
          step_index: 1,
          type: 'USER_INPUT',
          source: 'USER_EXPLICIT',
          content: '<USER_REQUEST>\nShip parity item 1\n</USER_REQUEST>',
        }) + '\n',
      )

      const calls = []
      const mockCall = async (req) => {
        calls.push(req)
        return { ok: true }
      }

      const hookInput = JSON.stringify({
        conversationId: convId,
        transcriptPath: transcriptFile,
      })

      // 1st PreInvocation: mirrors local_prompt + sets busy: true
      const first = await handleMirrorTurn('user_prompt', hookInput, {
        env: {},
        connectionsDir: tmpDir,
        legacyPath: path.join(tmpDir, 'legacy.json'),
        call: mockCall,
      })
      assert.equal(first.ok, true)
      assert.equal(calls.length, 2)
      assert.equal(calls[0].name, 'post_session_message')
      assert.equal(calls[0].arguments.message, 'Ship parity item 1')
      assert.equal(calls[1].name, 'heartbeat_connection')
      assert.equal(calls[1].arguments.busy, true)

      // Append PLANNER_RESPONSE (mid-turn tool step) -> next PreInvocation is deduplicated
      fs.appendFileSync(
        transcriptFile,
        JSON.stringify({
          step_index: 2,
          type: 'PLANNER_RESPONSE',
          source: 'MODEL',
          content: '',
        }) + '\n',
      )
      const second = await handleMirrorTurn('user_prompt', hookInput, {
        env: {},
        connectionsDir: tmpDir,
        legacyPath: path.join(tmpDir, 'legacy.json'),
        call: mockCall,
      })
      assert.equal(second.skipped, 'mid_turn_pre_invocation')
      assert.equal(calls.length, 2)

      // Launch a subagent in this turn -> Stop holds the turn open
      const launch = launchedAntigravityBackgroundWork(
        'invoke_subagent',
        { Subagents: [{ Role: 'Researcher' }] },
        { output: '{"conversationId":"subagent-uuid-1"}' },
      )
      assert.equal(launch?.id, 'subagent-uuid-1')
      recordOwnedLaunch(connId, launch, { dir: tmpDir })

      const heldStop = await handleMirrorTurn('stop', hookInput, {
        env: {},
        connectionsDir: tmpDir,
        legacyPath: path.join(tmpDir, 'legacy.json'),
        call: mockCall,
      })
      assert.equal(heldStop.held, true)
      assert.equal(readTurnMarker(connId, tmpDir)?.held, true)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('ignores devspec-remote-wait.mjs and devspec-remote-listen.mjs background launches so Stop is not held open', () => {
    const waiter = launchedAntigravityBackgroundWork(
      'default_api:run_command',
      {
        CommandLine: 'node "/home/user/.gemini/config/plugins/devspec/scripts/devspec-remote-wait.mjs" --connection-id "conn-1" --owner-pid "$PPID" --pending',
        WaitMsBeforeAsync: 500,
      },
      { output: 'Command sent to background with background task ID: task-wait-1' },
    )
    assert.equal(waiter, null)

    const listener = launchedAntigravityBackgroundWork(
      'run_command',
      {
        CommandLine: 'node scripts/devspec-remote-listen.mjs --connection-id conn-1',
      },
      { output: 'TaskId: task-listen-1' },
    )
    assert.equal(listener, null)

    const realBg = launchedAntigravityBackgroundWork(
      'default_api:run_command',
      {
        CommandLine: 'npm run build',
        toolSummary: 'Run build in background',
      },
      { output: 'Command sent to background with background task ID: task-build-1' },
    )
    assert.deepEqual(realBg, {
      id: 'task-build-1',
      kind: 'command',
      label: 'Run build in background',
    })
  })

  it('normalizes transcript_full.jsonl to compact transcript.jsonl when sibling exists and avoids rewriting state on PostInvocation', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-transcript-norm-'))
    try {
      const compactPath = path.join(tmpDir, 'transcript.jsonl')
      const fullPath = path.join(tmpDir, 'transcript_full.jsonl')
      fs.writeFileSync(compactPath, '{}\n')
      fs.writeFileSync(fullPath, '{}\n')

      assert.equal(normalizeTranscriptPath(fullPath), compactPath)
      assert.equal(
        parseTranscriptPath(JSON.stringify({ transcriptPath: fullPath })),
        compactPath,
      )

      const connId = '33333333-4444-4555-8666-777777777777'
      const convId = 'ca2d5a24-57ea-4252-90d0-82d4dd2504d1'
      const stateFile = path.join(tmpDir, `${connId}.json`)
      const state = {
        enabled: true,
        connection_id: connId,
        local_id: convId,
        transcript_path: compactPath,
      }
      fs.writeFileSync(stateFile, JSON.stringify(state, null, 2))

      // PreInvocation passes transcript_full.jsonl -> normalizes to compactPath, no rewrite needed
      assert.equal(
        syncStateTranscriptPath(state, fullPath, convId, { connectionsDir: tmpDir, env: {} }),
        false,
      )
      // PostInvocation passes null transcriptPath -> preserves existing compactPath, no rewrite needed
      assert.equal(
        syncStateTranscriptPath(state, null, convId, { connectionsDir: tmpDir, env: {} }),
        false,
      )
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('posts a fallback post_session_message with work_trail on Stop when a remote turn ends without an explicit reply, and skips when explicit reply was posted', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-fallback-reply-'))
    try {
      const connId = '44444444-5555-4666-8777-888888888888'
      const convId = 'conv-remote-fallback-1'
      const sessId = 'sess-remote-fallback-1'
      const transcriptPath = path.join(tmpDir, 'transcript.jsonl')

      fs.writeFileSync(
        path.join(tmpDir, `${connId}.json`),
        JSON.stringify({
          enabled: true,
          connection_id: connId,
          session_id: sessId,
          local_id: convId,
          agent_name: 'Antigravity',
          token: 'dvs_test_tok',
          mcp_url: 'https://api.devspec.ai/api/mcp',
          transcript_path: transcriptPath,
        }),
      )

      const startedAt = Date.parse('2026-10-14T22:00:00.000Z')
      fs.writeFileSync(
        transcriptPath,
        [
          JSON.stringify({
            step_index: 1,
            type: 'SYSTEM_MESSAGE',
            created_at: '2026-10-14T22:00:01.000Z',
            content: '{"event":"wake","command_count":1}',
          }),
          JSON.stringify({
            step_index: 2,
            type: 'PLANNER_RESPONSE',
            created_at: '2026-10-14T22:00:03.000Z',
            thinking: 'Checking the status of the repository.',
            tool_calls: [
              {
                name: 'view_file',
                args: {
                  AbsolutePath: '"/tmp/readme.md"',
                  toolAction: '"Viewing readme.md"',
                  toolSummary: '"View readme.md"',
                },
              },
            ],
          }),
          JSON.stringify({
            step_index: 3,
            type: 'PLANNER_RESPONSE',
            created_at: '2026-10-14T22:00:06.000Z',
            content: 'Everything in readme.md looks clean and up to date.',
          }),
        ].join('\n') + '\n',
      )

      writeTurnMarker(connId, { startedAt, remoteTurn: true, held: false }, tmpDir)

      const calls = []
      const stopRes = await handleMirrorTurn(
        'stop',
        JSON.stringify({ conversationId: convId, transcriptPath }),
        {
          env: {},
          connectionsDir: tmpDir,
          legacyPath: path.join(tmpDir, 'legacy.json'),
          call: async (req) => {
            calls.push(req)
            return { ok: true }
          },
        },
      )
      assert.equal(stopRes.ok, true)
      const postCall = calls.find((c) => c.name === 'post_session_message')
      assert.ok(postCall, 'posts fallback reply on Stop when no explicit post_session_message was called')
      assert.equal(postCall.arguments.connection_id, connId)
      assert.equal(postCall.arguments.session_id, sessId)
      assert.equal(
        postCall.arguments.message,
        'Everything in readme.md looks clean and up to date.',
      )
      assert.match(postCall.arguments.work_trail, /Viewing readme\.md/)
      assert.equal(postCall.arguments.trail_events.length, 2)

      // Now verify that when writeExplicitReplyMarker was called during the turn, Stop does NOT post a duplicate reply
      calls.length = 0
      writeTurnMarker(connId, { startedAt, remoteTurn: true, held: false }, tmpDir)
      writeExplicitReplyMarker(connId, tmpDir)
      await handleMirrorTurn(
        'stop',
        JSON.stringify({ conversationId: convId, transcriptPath }),
        {
          env: {},
          connectionsDir: tmpDir,
          legacyPath: path.join(tmpDir, 'legacy.json'),
          call: async (req) => {
            calls.push(req)
            return { ok: true }
          },
        },
      )
      assert.equal(calls.find((c) => c.name === 'post_session_message'), undefined)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('admits local terminal turns (startLocalTurn + openRequest typed_prompt), posts symmetric fallback reply on Stop with local_turn + command_turn_unbound, and closes the local turn and request', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-local-turn-symmetry-'))
    try {
      const { readRequestState, recordDeliveredBatchRequests } = await import('./requests.mjs')
      const connId = '55555555-6666-4777-8888-999999999999'
      const convId = 'conv-local-symmetry-1'
      const sessId = '66666666-7777-4888-8999-aaaaaaaaaaaa'
      const attachId = '77777777-8888-4999-8aaa-bbbbbbbbbbbb'
      const attachedAt = '2026-10-15T12:00:00.000Z'
      const transcriptPath = path.join(tmpDir, 'transcript.jsonl')

      fs.writeFileSync(
        path.join(tmpDir, `${connId}.json`),
        JSON.stringify({
          enabled: true,
          connection_id: connId,
          session_id: sessId,
          local_id: convId,
          agent_name: 'Antigravity',
          token: 'dvs_test_tok',
          mcp_url: 'https://api.devspec.ai/api/mcp',
          connection_capability: 'cap_secret_v1',
          speech_attachment_id: attachId,
          attached_at: attachedAt,
          transcript_path: transcriptPath,
        }),
      )

      fs.writeFileSync(
        transcriptPath,
        [
          JSON.stringify({
            step_index: 1,
            type: 'USER_INPUT',
            source: 'USER_EXPLICIT',
            created_at: '2026-10-15T12:00:01.000Z',
            content: '<USER_REQUEST>\nUpdate the memory from the terminal\n</USER_REQUEST>',
          }),
        ].join('\n') + '\n',
      )

      let admittedAttemptId = null
      let openedRequestId = null
      const calls = []
      const mockCall = async (req) => {
        calls.push(req)
        if (req.name === 'report_pickup') {
          admittedAttemptId = req.arguments.attempt_id
          return {
            connection_id: connId,
            attempt_id: req.arguments.attempt_id,
            expected_session_id: sessId,
            status: 'working',
          }
        }
        if (req.name === 'report_request') {
          if (req.arguments.action === 'open') {
            openedRequestId = req.arguments.request_id
            return {
              request_id: req.arguments.request_id,
              status: 'open',
              requested_by_user_id: 'a1111111-1111-4111-8111-111111111111',
            }
          }
          if (req.arguments.action === 'close') {
            return { status: 'closed' }
          }
        }
        return { ok: true }
      }

      // 1. PreInvocation on local terminal prompt: admits local turn, opens typed_prompt request, mirrors prompt
      const preRes = await handleMirrorTurn(
        'user_prompt',
        JSON.stringify({ conversationId: convId, transcriptPath }),
        {
          env: {},
          connectionsDir: tmpDir,
          legacyPath: path.join(tmpDir, 'legacy.json'),
          call: mockCall,
        },
      )
      assert.equal(preRes.ok, true)
      const pickupCall = calls.find((c) => c.name === 'report_pickup')
      assert.ok(pickupCall, 'calls report_pickup for local turn admission')
      assert.equal(pickupCall.arguments.local_turn, true)
      assert.equal(pickupCall.arguments.local_activity_version, 1)
      assert.equal(pickupCall.connectionCapability, 'cap_secret_v1')

      const reqCall = calls.find((c) => c.name === 'report_request')
      assert.ok(reqCall, 'calls report_request to open typed_prompt request')
      assert.equal(reqCall.arguments.kind, 'typed_prompt')

      const promptMirrorCall = calls.find(
        (c) => c.name === 'post_session_message' && c.arguments.turn_kind === 'local_prompt',
      )
      assert.ok(promptMirrorCall, 'mirrors local user prompt to session')
      assert.equal(promptMirrorCall.arguments.message, 'Update the memory from the terminal')

      const reqStateDuringTurn = readRequestState(connId, { dir: tmpDir })
      assert.equal(reqStateDuringTurn.current, openedRequestId)
      assert.equal(reqStateDuringTurn.open.get(openedRequestId)?.kind, 'typed_prompt')

      // 2. Append assistant reply in transcript without explicit post_session_message -> Stop mirrors fallback reply symmetrically
      fs.appendFileSync(
        transcriptPath,
        JSON.stringify({
          step_index: 2,
          type: 'PLANNER_RESPONSE',
          source: 'MODEL',
          created_at: new Date(Date.now() + 1000).toISOString(),
          content: 'I updated the memory as requested from the terminal.',
        }) + '\n',
      )

      calls.length = 0
      const stopRes = await handleMirrorTurn(
        'stop',
        JSON.stringify({ conversationId: convId, transcriptPath }),
        {
          env: {},
          connectionsDir: tmpDir,
          legacyPath: path.join(tmpDir, 'legacy.json'),
          call: mockCall,
        },
      )
      assert.equal(stopRes.ok, true)
      const fallbackReply = calls.find((c) => c.name === 'post_session_message')
      assert.ok(fallbackReply, 'posts symmetric fallback reply on Stop for mirrored local terminal turn')
      assert.equal(fallbackReply.arguments.connection_id, connId)
      assert.equal(fallbackReply.arguments.session_id, sessId)
      assert.equal(fallbackReply.arguments.command_turn_unbound, true)
      assert.equal(fallbackReply.arguments.local_turn, true)
      assert.equal(fallbackReply.arguments.complete_turn, true)
      assert.equal(
        fallbackReply.arguments.message,
        'I updated the memory as requested from the terminal.',
      )

      const completeCall = calls.find((c) => c.name === 'report_complete')
      assert.ok(completeCall, 'completes the local turn attempt via report_complete')
      assert.equal(completeCall.arguments.attempt_id, admittedAttemptId)

      const reqStateAfterStop = readRequestState(connId, { dir: tmpDir })
      assert.equal(reqStateAfterStop.open.size, 0, 'closes the typed_prompt request on Stop')

      // 3. Verify recordDeliveredBatchRequests sets op: 'current' when devspec-remote-wait delivers a command batch
      const cmdReqId = '99999999-aaaa-4bbb-8ccc-dddddddddddd'
      const cmdMsgId = 'aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff'
      const cmdProvRef = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'
      fs.appendFileSync(
        path.join(tmpDir, `${connId}.requests.jsonl`),
        JSON.stringify({
          op: 'open',
          id: cmdReqId,
          kind: 'command',
          message_id: cmdMsgId,
          provenance_ref: cmdProvRef,
          requested_by: 'a1111111-1111-4111-8111-111111111111',
        }) + '\n',
      )
      recordDeliveredBatchRequests(
        connId,
        [
          {
            type: 'owner_message',
            message: { id: cmdMsgId, provenance_ref: cmdProvRef },
          },
        ],
        { dir: tmpDir },
      )
      const reqStateAfterWake = readRequestState(connId, { dir: tmpDir })
      assert.equal(reqStateAfterWake.current, cmdReqId)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('extracts Pi-style thinking/tool/domain/subagent trail events without command obfuscation, streams mid-turn phase:trail, and finalizes cleanly on Stop', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-pi-trail-'))
    try {
      const connId = '88888888-9999-4aaa-8bbb-cccccccccccc'
      const convId = 'conv-pi-trail-1'
      const sessId = '99999999-aaaa-4bbb-8ccc-dddddddddddd'
      const transcriptPath = path.join(tmpDir, 'transcript.jsonl')

      const state = {
        enabled: true,
        connection_id: connId,
        session_id: sessId,
        local_id: convId,
        agent_name: 'Antigravity',
        token: 'dvs_test_tok',
        mcp_url: 'https://api.devspec.ai/api/mcp',
        transcript_path: transcriptPath,
      }
      fs.writeFileSync(path.join(tmpDir, `${connId}.json`), JSON.stringify(state))

      const startedAt = Date.parse('2026-10-15T20:00:00.000Z')
      fs.writeFileSync(
        transcriptPath,
        [
          JSON.stringify({
            step_index: 1,
            type: 'PLANNER_RESPONSE',
            created_at: '2026-10-15T20:00:02.000Z',
            thinking: 'First paragraph of reasoning.\n\nSecond paragraph checking git status and token dvs_secret123456789.',
            tool_calls: [
              {
                name: 'default_api:run_command',
                args: {
                  CommandLine: 'git status --short && echo dvs_secret123456789',
                  Cwd: '/repo',
                  toolAction: 'Checking git status',
                },
              },
              {
                name: 'default_api:call_mcp_tool',
                args: {
                  ServerName: 'devspec',
                  ToolName: 'claim_work_item',
                  Arguments: {
                    task_id: '4cbd20e0-1417-4c5f-9d99-28f5607bf296',
                    agent_branch: 'agent/4cbd20e0-trail',
                  },
                },
              },
              {
                name: 'default_api:invoke_subagent',
                args: {
                  Subagents: [
                    {
                      Role: 'Test Runner',
                      TypeName: 'self',
                      Model: 'inherit',
                      Prompt: 'Run the test suite and verify exit code.',
                    },
                  ],
                },
              },
            ],
          }),
        ].join('\n') + '\n',
      )

      const extracted = extractAntigravityTrailFromTranscript(
        fs.readFileSync(transcriptPath, 'utf8'),
        { sinceMs: startedAt },
      )
      // 1 thinking event (containing full redacted text) + 1 bash tool + 1 domain (claim_work_item) + 1 subagent = 4 trail events
      assert.equal(extracted.events.length, 4)
      assert.equal(extracted.events[0].kind, 'thinking')
      assert.match(extracted.events[0].text, /First paragraph of reasoning\./)
      assert.match(extracted.events[0].text, /token \[REDACTED\]\./)

      const bashEv = extracted.events[1]
      assert.equal(bashEv.kind, 'tool')
      assert.equal(bashEv.name, 'bash')
      assert.equal(bashEv.status, 'ok')
      // Command is NOT obfuscated, only the secret token is redacted
      assert.equal(bashEv.args, 'git status --short && echo [REDACTED]')
      assert.equal(bashEv.result, 'Checking git status')

      const domainEv = extracted.events[2]
      assert.equal(domainEv.kind, 'domain')
      assert.equal(domainEv.domain, 'task')
      assert.equal(domainEv.action, 'claimed')
      assert.equal(domainEv.name, 'claim_work_item')
      assert.equal(domainEv.status, 'ok')
      assert.equal(domainEv.id, '4cbd20e0-1417-4c5f-9d99-28f5607bf296')

      const subEv = extracted.events[3]
      assert.equal(subEv.kind, 'subagent')
      assert.equal(subEv.name, 'invoke_subagent')
      assert.equal(subEv.status, 'ok')
      assert.equal(subEv.children.length, 1)
      assert.equal(subEv.children[0].agent, 'Test Runner')
      assert.equal(subEv.children[0].status, 'running')

      assert.match(extracted.markdown, /git status --short && echo \[REDACTED\]/)

      // Stream mid-turn trail via streamTurnTrailIfChanged
      writeTurnMarker(connId, { startedAt, remoteTurn: true, held: false }, tmpDir)
      const calls = []
      const mockCall = async (req) => {
        calls.push(req)
        return { ok: true }
      }

      const firstStream = await streamTurnTrailIfChanged(state, {
        connectionsDir: tmpDir,
        call: mockCall,
      })
      assert.equal(firstStream.streamed, true)
      assert.equal(calls.length, 1)
      assert.equal(calls[0].name, 'post_session_message')
      assert.equal(calls[0].arguments.phase, 'trail')
      assert.equal(calls[0].arguments.message, extracted.markdown)
      assert.equal(calls[0].arguments.trail_events.length, 4)

      // Immediate second call with unchanged transcript is skipped
      const duplicateStream = await streamTurnTrailIfChanged(state, {
        connectionsDir: tmpDir,
        call: mockCall,
      })
      assert.equal(duplicateStream.streamed, false)
      assert.equal(duplicateStream.reason, 'unchanged')
      assert.equal(calls.length, 1)

      // Append final assistant answer and run Stop -> finalizes turn with complete_turn: true + work_trail + trail_events
      fs.appendFileSync(
        transcriptPath,
        JSON.stringify({
          step_index: 2,
          type: 'PLANNER_RESPONSE',
          created_at: '2026-10-15T20:00:05.000Z',
          content: 'All checks passed and work item is claimed.',
        }) + '\n',
      )

      calls.length = 0
      const stopRes = await handleMirrorTurn(
        'stop',
        JSON.stringify({ conversationId: convId, transcriptPath }),
        {
          env: {},
          connectionsDir: tmpDir,
          legacyPath: path.join(tmpDir, 'legacy.json'),
          call: mockCall,
        },
      )
      assert.equal(stopRes.ok, true)
      const finalPost = calls.find((c) => c.name === 'post_session_message')
      assert.ok(finalPost, 'finalizes streamed trail on Stop')
      assert.equal(finalPost.arguments.complete_turn, true)
      assert.equal(finalPost.arguments.message, 'All checks passed and work item is claimed.')
      assert.equal(finalPost.arguments.trail_events.length, 4)

      // Sessionless remote turn (e.g. automation run on unattached agent) streams trail without session_id
      const sessionlessState = {
        ...state,
        session_id: null,
      }
      writeTurnMarker(connId, { startedAt: startedAt + 10, remoteTurn: true, held: false }, tmpDir)
      calls.length = 0
      const sessionlessRemoteStream = await streamTurnTrailIfChanged(sessionlessState, {
        connectionsDir: tmpDir,
        call: mockCall,
      })
      assert.equal(sessionlessRemoteStream.streamed, true)
      assert.equal(calls.length, 1)
      assert.equal(calls[0].arguments.connection_id, connId)
      assert.equal(calls[0].arguments.session_id, undefined)
      assert.equal(calls[0].arguments.phase, 'trail')

      // Sessionless local turn does not stream trail
      writeTurnMarker(connId, { startedAt: startedAt + 20, remoteTurn: false, held: false }, tmpDir)
      const sessionlessLocalStream = await streamTurnTrailIfChanged(sessionlessState, {
        connectionsDir: tmpDir,
        call: mockCall,
      })
      assert.equal(sessionlessLocalStream.streamed, false)
      assert.equal(sessionlessLocalStream.reason, 'not_attached')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('runPostToolDispatch streams sessionless remote automation trails, retries after pre-claim refusal, and stays silent on unattached local turns', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-post-tool-sessionless-'))
    try {
      const connectionsDir = path.join(tmpHome, '.devspec', 'remote-control', 'connections')
      fs.mkdirSync(connectionsDir, { recursive: true })
      const connId = '99999999-aaaa-4bbb-8ccc-dddddddddddd'
      const convId = '77777777-8888-4999-8aaa-bbbbbbbbbbbb'
      const transcriptPath = path.join(tmpHome, 'transcript.jsonl')
      const startedAt = Date.parse('2026-10-31T21:00:00.000Z')

      fs.writeFileSync(
        transcriptPath,
        [
          JSON.stringify({
            step_index: 0,
            type: 'USER_INPUT',
            created_at: '2026-10-31T21:00:00.000Z',
            content: '[DevSpec Remote Wake] automation_run',
          }),
          JSON.stringify({
            step_index: 1,
            type: 'PLANNER_RESPONSE',
            created_at: '2026-10-31T21:00:01.000Z',
            thinking: 'Checking clean plugin checkouts before fast-forwarding.',
            tool_calls: [
              {
                name: 'default_api:run_command',
                arguments: { CommandLine: 'git status --porcelain' },
              },
            ],
          }),
        ].join('\n') + '\n',
      )

      fs.writeFileSync(
        path.join(connectionsDir, `${connId}.json`),
        JSON.stringify({
          enabled: true,
          connection_id: connId,
          session_id: null,
          local_id: convId,
          transcript_path: transcriptPath,
          token: 'dvs_test_tok_fake1234',
          mcp_url: 'https://api.devspec.ai/api/mcp',
        }),
      )

      // 1. Sessionless remote automation turn: first call before claim_automation_run is refused by server
      writeTurnMarker(connId, { startedAt, remoteTurn: true, held: false }, connectionsDir)
      const calls = []
      let failPreClaim = true
      const mockCall = async (req) => {
        if (req.name === 'post_session_message' && failPreClaim) {
          const err = new Error('session_id is required when the connection has no running automation run')
          err.code = 'MCP_TOOL_REFUSAL'
          throw err
        }
        calls.push(req)
        return { ok: true }
      }

      const hookPayload = JSON.stringify({
        conversationId: convId,
        transcriptPath,
        tool_name: 'default_api:run_command',
        tool_input: { CommandLine: 'git status --porcelain' },
      })

      await runPostToolDispatch(hookPayload, { env: {}, home: tmpHome, call: mockCall })
      assert.equal(calls.length, 0, 'pre-claim refusal fails non-fatally without recording post')
      assert.equal(
        fs.existsSync(path.join(connectionsDir, `${connId}.trail-state.json`)),
        false,
        'pre-claim refusal must not latch trail-state.json signature',
      )

      // 2. Once claim_automation_run transitions run to running, the exact same/next post-tool call streams cleanly
      failPreClaim = false
      await runPostToolDispatch(hookPayload, { env: {}, home: tmpHome, call: mockCall })
      const trailPosts = calls.filter((c) => c.name === 'post_session_message')
      assert.equal(trailPosts.length, 1)
      assert.equal(trailPosts[0].arguments.connection_id, connId)
      assert.equal(trailPosts[0].arguments.session_id, undefined)
      assert.equal(trailPosts[0].arguments.phase, 'trail')
      assert.match(trailPosts[0].arguments.work_trail, /git status --porcelain/)

      // 3. Unattached local turn (remoteTurn: false, session_id: null) never streams trail
      calls.length = 0
      writeTurnMarker(connId, { startedAt: startedAt + 50, remoteTurn: false, held: false }, connectionsDir)
      await runPostToolDispatch(hookPayload, { env: {}, home: tmpHome, call: mockCall })
      assert.equal(calls.filter((c) => c.name === 'post_session_message').length, 0)
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it('preserves notice, check-job, and background-task continuation turn context across tool calls without sending unbound room-command trails', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-nonchat-context-'))
    try {
      const connectionsDir = path.join(tmpHome, '.devspec', 'remote-control', 'connections')
      const legacyPath = path.join(tmpHome, '.devspec', 'remote-control.json')
      fs.mkdirSync(connectionsDir, { recursive: true })

      const connId = '4b2db8bc-e182-4514-9087-442ced71f324'
      const sessionId = '8a0e6bc5-dc53-49c8-a502-90fd02b7f764'
      const convId = 'conv-nonchat-context'
      const noticeId = 'c3c8c000-0000-4000-8000-000000000099'
      const transcriptPath = path.join(
        tmpHome,
        '.gemini',
        'antigravity-cli',
        'brain',
        convId,
        '.system_generated',
        'logs',
        'transcript.jsonl',
      )
      fs.mkdirSync(path.dirname(transcriptPath), { recursive: true })

      fs.writeFileSync(
        path.join(connectionsDir, `${connId}.json`),
        JSON.stringify({
          enabled: true,
          connection_id: connId,
          session_id: sessionId,
          local_id: convId,
          transcript_path: transcriptPath,
          token: 'dvs_test_tok_fake1234',
          mcp_url: 'https://api.devspec.ai/api/mcp',
        }),
      )

      const t0 = Date.now()
      fs.writeFileSync(
        transcriptPath,
        [
          JSON.stringify({
            step_index: 1,
            type: 'USER_INPUT',
            created_at: new Date(t0).toISOString(),
            content: `<USER_REQUEST>\n[DevSpec Remote Wake]\n[DevSpec System Notice: ci_failure]\nTell the person with post_session_message and system_notice_ids: ["${noticeId}"]\n</USER_REQUEST>`,
          }),
          JSON.stringify({
            step_index: 2,
            type: 'PLANNER_RESPONSE',
            created_at: new Date(t0 + 1000).toISOString(),
            thinking: 'Inspecting broken PR checks.',
            tool_calls: [
              {
                name: 'default_api:run_command',
                args: { CommandLine: 'gh pr checks 1235', toolSummary: 'Check PR 1235 status' },
              },
            ],
          }),
          JSON.stringify({
            step_index: 3,
            type: 'GENERIC',
            created_at: new Date(t0 + 1500).toISOString(),
            content: `Tool is running as a background task with task id: ${convId}/task-2`,
          }),
        ].join('\n') + '\n',
      )

      const calls = []
      const mockCall = async (req) => {
        calls.push(req)
        return { ok: true }
      }

      // 1. Even if .turn was missing when PostToolUse ran, inferTurnContextFromTranscript recovers noticeIds
      //    and suppresses unbound trail streaming.
      await runPostToolDispatch(
        JSON.stringify({
          conversationId: convId,
          transcriptPath,
          stepIdx: 2,
          toolCall: {
            name: 'run_command',
            args: { CommandLine: 'gh pr checks 1235', WaitMsBeforeAsync: 500, toolSummary: 'Check PR 1235 status' },
          },
        }),
        { env: {}, home: tmpHome, call: mockCall },
      )
      const markerAfterTool = readTurnMarker(connId, connectionsDir)
      assert.deepEqual(markerAfterTool?.noticeIds, [noticeId])
      assert.equal(
        calls.filter((c) => c.name === 'post_session_message' && c.arguments?.phase === 'trail').length,
        0,
        'notice turn tool call must never stream an unbound room-command trail',
      )

      // 2. Stop holds .turn open because background task `${convId}/task-2` is in flight!
      const stopHeld = await handleMirrorTurn(
        'stop',
        JSON.stringify({ conversationId: convId, transcriptPath }),
        { env: {}, connectionsDir, legacyPath, call: mockCall },
      )
      assert.equal(stopHeld.held, true)
      assert.deepEqual(stopHeld.outstanding, [`${convId}/task-2`])
      assert.equal(readTurnMarker(connId, connectionsDir)?.held, true)
      assert.equal(
        calls.filter((c) => c.name === 'report_complete').length,
        0,
        'Stop must not call report_complete while background task is still running',
      )

      // 3. Background task completes via <SYSTEM_MESSAGE> (even if its stdout mentions "type":"owner_message").
      fs.appendFileSync(
        transcriptPath,
        [
          JSON.stringify({
            step_index: 4,
            type: 'SYSTEM_MESSAGE',
            created_at: new Date(t0 + 5000).toISOString(),
            content: `<SYSTEM_MESSAGE>\n[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event, not a message from the user.\nBackground command "task-2" (Check PR 1235 status) finished with exit code 0.\nOutput path: ${path.join(path.dirname(path.dirname(transcriptPath)), 'tasks', 'task-2.log')}\nFinal output:\n{"type":"owner_message","message_id":"00000000-0000-4000-8000-000000000001"}\n</SYSTEM_MESSAGE>`,
          }),
          JSON.stringify({
            step_index: 5,
            type: 'PLANNER_RESPONSE',
            created_at: new Date(t0 + 6000).toISOString(),
            thinking: 'Applying fix after background task finished.',
            content: 'Fixed PR #1235 and verified CI passes.',
            tool_calls: [
              {
                name: 'default_api:run_command',
                args: { CommandLine: 'git status', toolSummary: 'Check git status' },
              },
            ],
          }),
        ].join('\n') + '\n',
      )

      await handleMirrorTurn(
        'user_prompt',
        JSON.stringify({ conversationId: convId, transcriptPath }),
        { env: {}, connectionsDir, legacyPath, call: mockCall },
      )
      const markerAfterWake = readTurnMarker(connId, connectionsDir)
      assert.equal(markerAfterWake?.held, false)
      assert.equal(markerAfterWake?.backgroundContinuation, true)
      assert.deepEqual(markerAfterWake?.noticeIds, [noticeId])
      assert.equal(
        markerAfterWake?.otherWake,
        undefined,
        'background task stdout containing owner_message JSON must not set otherWake on a notice turn',
      )

      // 4. Tool call during the background-task continuation turn still preserves noticeIds and sends no trail
      await runPostToolDispatch(
        JSON.stringify({
          conversationId: convId,
          transcriptPath,
          stepIdx: 5,
          toolCall: {
            name: 'run_command',
            args: { CommandLine: 'git status', WaitMsBeforeAsync: 5000, toolSummary: 'Check git status' },
          },
        }),
        { env: {}, home: tmpHome, call: mockCall },
      )
      assert.equal(
        calls.filter((c) => c.name === 'post_session_message' && c.arguments?.phase === 'trail').length,
        0,
        'background continuation of notice turn must not stream an unbound room-command trail',
      )

      // 5. Final Stop reconciles the finished background task, ends the notice turn quietly without scraping terminal text, and completes the turn!
      const stopFinal = await handleMirrorTurn(
        'stop',
        JSON.stringify({ conversationId: convId, transcriptPath }),
        { env: {}, connectionsDir, legacyPath, call: mockCall },
      )
      assert.equal(stopFinal.held, undefined)
      assert.equal(stopFinal.busy, false)
      assert.equal(readTurnMarker(connId, connectionsDir), null)
      const postCalls = calls.filter((c) => c.name === 'post_session_message')
      assert.equal(postCalls.length, 0, 'notice turn that finished without calling post_session_message must not scrape terminal text on Stop')
      assert.equal(calls.filter((c) => c.name === 'report_complete').length, 1)
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it('resolves human task titles for truncated create_task, claim_work_item, and record_implementation calls without falling back to branch names or UUIDs', () => {
    const taskId = '5773f417-11d6-4665-a79b-df4137982d5d'
    const taskTitle =
      'Unify pending memory version view with one-click accept and connected conflict rulings'
    const lines = [
      JSON.stringify({
        step_index: 10,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-10T14:13:46Z',
        truncated_fields: ['tool_calls'],
        tool_calls: [
          {
            name: 'default_api:call_mcp_tool',
            args: {
              ServerName: '"devspec_devspec"',
              ToolName: '"create_task"',
              Arguments: '"{\\"description\\":\\"Long spec... [truncated]',
            },
          },
        ],
      }),
      JSON.stringify({
        step_index: 11,
        type: 'GENERIC',
        created_at: '2026-11-10T14:13:47Z',
        content: JSON.stringify({
          outcome: 'committed',
          id: taskId,
          title: taskTitle,
        }),
      }),
      JSON.stringify({
        step_index: 12,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-10T14:20:13Z',
        tool_calls: [
          {
            name: 'default_api:call_mcp_tool',
            args: {
              ServerName: '"devspec_devspec"',
              ToolName: '"claim_work_item"',
              Arguments: JSON.stringify(
                JSON.stringify({
                  agent_branch: 'feat/unify-pending-memory-view-5773f417',
                  task_id: taskId,
                }),
              ),
            },
          },
        ],
      }),
      JSON.stringify({
        step_index: 13,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-10T14:43:06Z',
        truncated_fields: ['tool_calls'],
        tool_calls: [
          {
            name: 'default_api:call_mcp_tool',
            args: {
              ServerName: '"devspec_devspec"',
              ToolName: '"record_implementation"',
              Arguments: `"{\\"task_id\\":\\"${taskId}\\",\\"completion_note\\":\\"Long note... [truncated]`,
            },
          },
        ],
      }),
    ].join('\n')

    const { events, markdown } = extractAntigravityTrailFromTranscript(lines, {
      stopAtReply: false,
    })
    assert.equal(events.length, 3)
    assert.deepEqual(
      events.map((e) => ({ domain: e.domain, action: e.action, id: e.id, title: e.title })),
      [
        { domain: 'task', action: 'created', id: taskId, title: taskTitle },
        { domain: 'task', action: 'claimed', id: taskId, title: taskTitle },
        { domain: 'implementation', action: 'recorded', id: taskId, title: taskTitle },
      ],
    )
    assert.ok(!markdown.includes('feat/unify-pending-memory-view-5773f417'))
    assert.ok(markdown.includes(`\`create_task\` — \`${taskTitle}\``))
    assert.ok(markdown.includes(`\`claim_work_item\` — \`${taskTitle}\``))
    assert.ok(markdown.includes(`\`record_implementation\` — \`${taskTitle}\``))
  })

  it('does not mistake read_file outputs containing "parentTaskId" after an earlier run_command step for a background command launch', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-parent-task-id-'))
    try {
      const rcDir = path.join(tmpHome, '.devspec', 'remote-control')
      const connectionsDir = path.join(rcDir, 'connections')
      const legacyPath = path.join(rcDir, 'state.json')
      fs.mkdirSync(connectionsDir, { recursive: true })

      const connId = '11111111-2222-4333-8444-555555555555'
      const convId = 'b9b9b9b9-b9b9-4b9b-8b9b-b9b9b9b9b9b9'
      const msgId = 'd9d9d9d9-d9d9-4d9d-8d9d-d9d9d9d9d9d9'
      const transcriptPath = path.join(
        tmpHome,
        '.gemini',
        'antigravity-cli',
        'brain',
        convId,
        '.system_generated',
        'logs',
        'transcript.jsonl',
      )
      fs.mkdirSync(path.dirname(transcriptPath), { recursive: true })

      fs.writeFileSync(
        path.join(connectionsDir, `${connId}.json`),
        JSON.stringify({
          connection_id: connId,
          session_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
          project_id: '24c4abaa-2cb9-496a-8492-cf1f1aa1090b',
          local_id: convId,
          agent_name: 'Antigravity',
          enabled: true,
          token: 'dvs_tok',
          mcp_url: 'https://fixture.invalid/api/mcp',
          connection_capability: 'cap_1',
          transcript_path: transcriptPath,
        }),
      )
      fs.writeFileSync(
        path.join(rcDir, 'local-bonds.json'),
        JSON.stringify({ bonds: { [`Antigravity:${convId}`]: { connection_id: connId } } }),
      )

      const t0 = Date.now()
      recordTurnWake(
        connId,
        { type: 'canonical_commands', execute_message_ids: [msgId] },
        connectionsDir,
      )

      // 1. Earlier PLANNER_RESPONSE ran a normal synchronous run_command, followed by a
      //    PLANNER_RESPONSE that called read_file on a subagent log containing `"parentTaskId": "task-662"`.
      fs.writeFileSync(
        transcriptPath,
        [
          JSON.stringify({
            step_index: 1,
            type: 'USER_INPUT',
            created_at: new Date(t0).toISOString(),
            content: '<USER_REQUEST>Inspect the transcript</USER_REQUEST>',
          }),
          JSON.stringify({
            step_index: 2,
            type: 'PLANNER_RESPONSE',
            created_at: new Date(t0 + 1000).toISOString(),
            tool_calls: [
              {
                name: 'default_api:run_command',
                args: { CommandLine: 'git status --short', toolSummary: 'Git status check' },
              },
            ],
          }),
          JSON.stringify({
            step_index: 3,
            type: 'GENERIC',
            created_at: new Date(t0 + 1500).toISOString(),
            content:
              'Created At: 2026-11-11T10:00:00Z\nCompleted At: 2026-11-11T10:00:01Z\nCommand exited with code 0.',
          }),
          JSON.stringify({
            step_index: 4,
            type: 'PLANNER_RESPONSE',
            created_at: new Date(t0 + 2000).toISOString(),
            tool_calls: [
              {
                name: 'default_api:read_file',
                args: { Path: '/tmp/subagent-transcript.jsonl' },
              },
            ],
          }),
          JSON.stringify({
            step_index: 5,
            type: 'GENERIC',
            created_at: new Date(t0 + 2500).toISOString(),
            content:
              'Showing lines 1-5 of 5\n1: {"step_index":1,"parentTaskId":"task-662","TaskId":"should-not-match-on-read-file"}',
          }),
        ].join('\n') + '\n',
      )

      assert.equal(
        launchedAntigravityBackgroundWork(
          'run_command',
          { CommandLine: 'cat file' },
          { output: '{"parentTaskId":"task-662"}' },
        ),
        null,
      )

      const calls = []
      const stopRes = await handleMirrorTurn(
        'stop',
        JSON.stringify({ conversationId: convId, transcriptPath }),
        {
          env: {},
          connectionsDir,
          legacyPath,
          call: async (req) => {
            calls.push(req)
            return { ok: true }
          },
        },
      )

      assert.notEqual(stopRes.held, true, 'Stop must not hold the turn open on read_file output')
      assert.equal(readTurnMarker(connId, connectionsDir), null, '.turn marker must be cleared on Stop')
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it('does not mark the connection busy during the /devspec:devspec-remote setup turn, then marks busy on a real prompt', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-remote-connect-spare-'))
    try {
      const connectionsDir = path.join(tmpHome, '.devspec', 'remote-control', 'connections')
      const legacyPath = path.join(tmpHome, '.devspec', 'remote-control.json')
      fs.mkdirSync(connectionsDir, { recursive: true })
      const connId = '63752d51-2af6-46a5-8436-5181a5718571'
      const convId = 'a7702ea3-eccc-471a-abb0-ff4268edeb41'
      const transcriptPath = path.join(tmpHome, 'transcript.jsonl')

      // Step 0: user invokes /devspec:devspec-remote; Step 1: model runs devspec-remote-connect.mjs;
      // Step 2: run_command output after connection state is registered.
      const steps = [
        {
          step_index: 0,
          source: 'USER_EXPLICIT',
          type: 'USER_INPUT',
          status: 'DONE',
          created_at: new Date(Date.now() - 5000).toISOString(),
          content: '<USER_REQUEST>\n/devspec:devspec-remote\n</USER_REQUEST>\n<ADDITIONAL_METADATA>...</ADDITIONAL_METADATA>',
        },
        {
          step_index: 1,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: new Date(Date.now() - 4000).toISOString(),
          tool_calls: [{ name: 'run_command', args: { CommandLine: 'node devspec-remote-connect.mjs --owner-pid $PPID' } }],
        },
        {
          step_index: 2,
          source: 'SYSTEM',
          type: 'GENERIC',
          status: 'DONE',
          created_at: new Date(Date.now() - 1000).toISOString(),
          content: '━━━ DevSpec Remote Control ━━━\nStatus: registered\nwake: ALREADY ARMED',
        },
      ]
      fs.writeFileSync(transcriptPath, steps.map((s) => JSON.stringify(s)).join('\n') + '\n')

      // State file written during Step 2 (sessionless spare connection)
      fs.writeFileSync(
        path.join(connectionsDir, `${connId}.json`),
        JSON.stringify({
          enabled: true,
          connection_id: connId,
          session_id: null,
          agent_name: 'Antigravity',
          local_id: convId,
          transcript_path: transcriptPath,
          mcp_url: 'https://example.invalid/api/mcp',
          token: 'test-token',
          connection_capability: 'dvsc_test',
        }),
      )

      const calls = []
      const preStep3 = await handleMirrorTurn(
        'user_prompt',
        JSON.stringify({ conversationId: convId, transcriptPath }),
        {
          env: {},
          connectionsDir,
          legacyPath,
          call: async (req) => {
            calls.push(req)
            return { ok: true }
          },
        },
      )
      assert.equal(preStep3.skipped, 'remote_control_command')
      assert.equal(readTurnMarker(connId, connectionsDir), null)
      assert.equal(calls.length, 0)

      const stopStep3 = await handleMirrorTurn(
        'stop',
        JSON.stringify({ conversationId: convId, transcriptPath }),
        {
          env: {},
          connectionsDir,
          legacyPath,
          call: async (req) => {
            calls.push(req)
            return { ok: true }
          },
        },
      )
      assert.equal(stopStep3.skipped, 'remote_control_command')
      assert.equal(calls.length, 0)

      // Now the user types a real prompt in Step 4: it must mark the connection busy.
      steps.push({
        step_index: 4,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: new Date().toISOString(),
        content: '<USER_REQUEST>\nHello from terminal\n</USER_REQUEST>',
      })
      fs.writeFileSync(transcriptPath, steps.map((s) => JSON.stringify(s)).join('\n') + '\n')

      const preStep4 = await handleMirrorTurn(
        'user_prompt',
        JSON.stringify({ conversationId: convId, transcriptPath }),
        {
          env: {},
          connectionsDir,
          legacyPath,
          call: async (req) => {
            calls.push(req)
            return { ok: true }
          },
        },
      )
      assert.equal(preStep4.busy, true)
      assert.notEqual(readTurnMarker(connId, connectionsDir), null)
      assert.equal(calls.some((c) => c.name === 'heartbeat_connection' && c.arguments.busy === true), true)
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it('matches remote-control plumbing strictly by actual invocation, tracking git/test/commit mentions as owned background work (85ced7c4)', async () => {
    const {
      isDevSpecListener,
      isRemotePlumbingBackgroundCommand,
      isRemotePlumbingShellCommand,
      launchForRequest,
    } = await import('./requests.mjs')
    const {
      isRemotePlumbingToolCall,
      launchedAntigravityBackgroundWork,
    } = await import('./mirror-turn.mjs')

    // Actual invocations of plugin plumbing scripts remain excluded.
    const directPlumbing = [
      'node "/home/user/.gemini/config/plugins/devspec/scripts/devspec-remote-wait.mjs" --pending',
      'export PATH="/tmp/bin:$PATH" # devspec-git-observer v1\nnode "$HOME/.gemini/config/plugins/devspec/scripts/devspec-remote-listen.mjs" --connection-id abc',
      'nohup node /opt/devspec/scripts/devspec-remote-poll.mjs --connection-id abc',
      './scripts/devspec-remote-wait.mjs --from-end',
      'bash -c "node /opt/devspec/scripts/devspec-remote-poll.mjs"',
    ]
    for (const cmd of directPlumbing) {
      assert.equal(isRemotePlumbingBackgroundCommand(cmd), true, `expected plumbing: ${cmd}`)
      assert.equal(isDevSpecListener({ CommandLine: cmd }), true, `expected listener: ${cmd}`)
      assert.equal(isRemotePlumbingToolCall('run_command', { CommandLine: cmd }), true)
      assert.equal(
        launchedAntigravityBackgroundWork(
          'run_command',
          { CommandLine: cmd },
          { output: 'Tool is running as a background task with task id: conv-1/task-99' },
        ),
        null,
      )
      assert.equal(
        launchForRequest(
          'run_command',
          { CommandLine: cmd },
          { output: 'Tool is running as a background task with task id: conv-1/task-99' },
        ),
        null,
      )
    }

    // Ordinary shell commands merely mentioning those filenames are NOT plumbing and ARE tracked.
    const ordinaryMentions = [
      'git add hooks/scripts/devspec-remote-poll.mjs hooks/scripts/devspec-remote-wait.mjs && git commit -m "Fix devspec-remote-wait.mjs"',
      'node --test hooks/scripts/devspec-remote-poll.test.mjs scripts/devspec-remote-wait.mjs',
      'node --check scripts/devspec-remote-listen.mjs',
      'node -e "console.log(\'devspec-remote-wait.mjs\')"',
      'grep -n devspec-remote-wait.mjs scripts/mirror-turn.mjs',
      'git commit -m "Update heartbeat_connection and post_session_message"',
    ]
    for (const cmd of ordinaryMentions) {
      assert.equal(isRemotePlumbingBackgroundCommand(cmd), false, `should not be plumbing: ${cmd}`)
      assert.equal(isRemotePlumbingShellCommand(cmd), false, `should not be shell plumbing: ${cmd}`)
      assert.equal(isDevSpecListener({ CommandLine: cmd }), false, `should not be listener: ${cmd}`)
      assert.equal(isRemotePlumbingToolCall('run_command', { CommandLine: cmd }), false)
      const bg = launchedAntigravityBackgroundWork(
        'run_command',
        { CommandLine: cmd, toolSummary: 'Commit changes' },
        { output: 'Tool is running as a background task with task id: conv-1/task-521' },
      )
      assert.deepEqual(bg, { id: 'conv-1/task-521', kind: 'command', label: 'Commit changes' })
      const reqLaunch = launchForRequest(
        'run_command',
        { CommandLine: cmd },
        { output: 'Tool is running as a background task with task id: conv-1/task-521' },
      )
      assert.deepEqual(reqLaunch, { key: 'conv-1/task-521', alias: null, kind: 'shell', notifies: true })
    }

    // Direct plugin helper invocations like connect/mcp-call remain filtered in isRemotePlumbingToolCall.
    assert.equal(
      isRemotePlumbingShellCommand('PLUGIN_DIR="$HOME/.gemini/config/plugins/devspec"; node "$PLUGIN_DIR/scripts/devspec-remote-connect.mjs" --owner-pid "$PPID"'),
      true,
    )
    assert.equal(
      isRemotePlumbingShellCommand('node /opt/devspec/scripts/mcp-call.mjs heartbeat_connection "{}"'),
      true,
    )

    // Arbitrarily nested shell wrappers have no numeric depth cap (3c5147a7 / 91d7b47c).
    const deepPlumbing =
      'sh -c "bash -c \'zsh -c \\"sh -c \\\\\\"bash -c \\\\\\\\\\\\\\"node scripts/devspec-remote-wait.mjs --pending\\\\\\\\\\\\\\"\\\\\\"\\" \'"'
    assert.equal(isRemotePlumbingBackgroundCommand(deepPlumbing), true)
    const deepNonPlumbing =
      'sh -c "bash -c \'zsh -c \\"sh -c \\\\\\"git commit -m devspec-remote-wait.mjs\\\\\\"\\" \'"'
    assert.equal(isRemotePlumbingBackgroundCommand(deepNonPlumbing), false)
  })

  it('restores parked room task, active request, trail streaming, and Stop fallback when held background work completes mid-turn after a for_the_record notice (972c8895)', async () => {
    const {
      appendRequestEvent,
      readRequestState,
      requestRefForWrite,
      setCurrentRequest,
      UNSTATED,
    } = await import('./requests.mjs')
    const {
      currentTurnNoticeIds,
      isCurrentTurnRoutine,
      recordOwnedLaunch,
      recordTurnWake,
      streamTurnTrailIfChanged,
    } = await import('./mirror-turn.mjs')

    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-972c8895-'))
    try {
      const connectionsDir = path.join(tmpHome, 'connections')
      const legacyPath = path.join(tmpHome, 'legacy.json')
      fs.mkdirSync(connectionsDir, { recursive: true })
      const connId = '972c8895-0000-4000-8000-000000000001'
      const sessId = '972c8895-0000-4000-8000-000000000002'
      const reqId = '972c8895-0000-4000-8000-000000000003'
      const noticeId = '972c8895-0000-4000-8000-000000000004'
      const convId = 'conv-972c8895'
      const taskId = `${convId}/task-415`
      const transcriptPath = path.join(tmpHome, 'transcript.jsonl')
      const t0 = Date.now() - 10_000

      // 1. Room task opened a request, launched background task-415, and paused (held: true).
      appendRequestEvent(connId, { op: 'open', id: reqId, kind: 'command' }, { dir: connectionsDir })
      setCurrentRequest(connId, reqId, { dir: connectionsDir })
      appendRequestEvent(
        connId,
        { op: 'launch', key: taskId, kind: 'shell', notifies: true, request: reqId, also: [] },
        { dir: connectionsDir },
      )
      writeTurnMarker(
        connId,
        { startedAt: t0, remoteTurn: true, otherWake: true, held: true },
        connectionsDir,
      )
      recordOwnedLaunch(connId, { id: taskId, kind: 'command', label: 'Run tests' }, { dir: connectionsDir })

      // 2. A quiet for_the_record notice wakes the agent while held: true, parking heldParent and clearing current request.
      recordTurnWake(
        connId,
        {
          type: 'canonical_system_notices',
          execute_notice_ids: [noticeId],
          ingress: {
            system_notices: [{ notice_id: noticeId, audience: 'for_the_record', topic: 'deploy_failed' }],
          },
        },
        connectionsDir,
        t0 + 2000,
      )
      setCurrentRequest(connId, UNSTATED, { dir: connectionsDir })

      const parked = readTurnMarker(connId, connectionsDir)
      assert.equal(parked.held, false)
      assert.equal(parked.otherWake, false)
      assert.ok(parked.heldParent)
      assert.deepEqual(parked.recordNoticeIds, [noticeId])
      assert.deepEqual(currentTurnNoticeIds(connId, { dir: connectionsDir }), [noticeId])
      assert.equal(requestRefForWrite(readRequestState(connId, { dir: connectionsDir })), null)

      // 3. Mid-turn (no Stop in between), task-415 finishes and transcript gets its SYSTEM_MESSAGE + a real model step.
      const steps = [
        {
          step_index: 1,
          source: 'SYSTEM',
          type: 'SYSTEM_MESSAGE',
          created_at: new Date(t0 + 4000).toISOString(),
          content: `[Message] sender=${taskId} content=Task id "${taskId}" finished with result:\nAll tests passed`,
        },
      ]
      fs.writeFileSync(transcriptPath, steps.map((s) => JSON.stringify(s)).join('\n') + '\n')
      fs.writeFileSync(
        path.join(connectionsDir, `${connId}.json`),
        JSON.stringify({
          enabled: true,
          connection_id: connId,
          session_id: sessId,
          agent_name: 'Antigravity',
          local_id: convId,
          transcript_path: transcriptPath,
          mcp_url: 'https://example.invalid/api/mcp',
          token: 'test-token',
          connection_capability: 'dvsc_test',
        }),
      )

      // 4. Mid-turn PreInvocation fires when Antigravity delivers the parent task's
      //    completion notification: even though it returns mid_turn_pre_invocation,
      //    it MUST immediately restore heldParent and the active parent request.
      const preRes = await handleMirrorTurn(
        'user_prompt',
        JSON.stringify({ conversationId: convId, transcriptPath }),
        {
          env: {},
          connectionsDir,
          legacyPath,
          call: async () => ({ ok: true }),
        },
      )
      assert.equal(preRes.skipped, 'mid_turn_pre_invocation')

      const restored = readTurnMarker(connId, connectionsDir)
      assert.equal(restored.heldParent, null)
      assert.equal(restored.otherWake, true)
      assert.deepEqual(restored.recordNoticeIds, [])
      assert.equal(currentTurnNoticeIds(connId, { dir: connectionsDir }), null)
      assert.equal(isCurrentTurnRoutine(connId, { dir: connectionsDir }), false)
      assert.equal(requestRefForWrite(readRequestState(connId, { dir: connectionsDir })), reqId)

      // 5. The agent rolls straight into resumed parent work after restoration, and
      //    live trail streaming succeeds (not suppressed as 'notice_turn')!
      fs.appendFileSync(
        transcriptPath,
        JSON.stringify({
          step_index: 2,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          created_at: new Date(Date.now() + 1000).toISOString(),
          thinking: 'Tests passed; continuing the room task now.',
          tool_calls: [{ name: 'read_file', args: { Path: '/tmp/app.ts' } }],
        }) + '\n',
      )
      const trailCalls = []
      const trailRes = await streamTurnTrailIfChanged(
        {
          connection_id: connId,
          session_id: sessId,
          agent_name: 'Antigravity',
          transcript_path: transcriptPath,
          mcp_url: 'https://example.invalid/api/mcp',
          token: 'test-token',
        },
        {
          connectionsDir,
          call: async (req) => {
            trailCalls.push(req)
            return { ok: true }
          },
        },
      )
      assert.equal(trailRes.skipped, undefined)
      assert.equal(trailCalls.some((c) => c.name === 'post_session_message' && c.arguments.phase === 'trail'), true)

      // 6. When the resumed room task finishes without calling post_session_message,
      //    Stop posts the fallback reply instead of suppressing it as a notice turn.
      steps.push({
        step_index: 3,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        created_at: new Date(Date.now() + 1000).toISOString(),
        content: 'All tests passed and the room task is finished.',
      })
      fs.writeFileSync(transcriptPath, steps.map((s) => JSON.stringify(s)).join('\n') + '\n')
      const stopCalls = []
      await handleMirrorTurn(
        'stop',
        JSON.stringify({ conversationId: convId, transcriptPath }),
        {
          env: {},
          connectionsDir,
          legacyPath,
          call: async (req) => {
            stopCalls.push(req)
            return { ok: true }
          },
        },
      )
      assert.equal(
        stopCalls.some(
          (c) =>
            c.name === 'post_session_message' &&
            c.arguments.complete_turn === true &&
            String(c.arguments.message).includes('All tests passed and the room task is finished.'),
        ),
        true,
      )
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it('keeps standalone for_the_record notices and check-job turns silent with no heldParent (972c8895)', async () => {
    const {
      currentTurnNoticeIds,
      isCurrentTurnRoutine,
      recordTurnWake,
      restoreHeldParentIfResumed,
    } = await import('./mirror-turn.mjs')
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-standalone-'))
    try {
      const connA = '972c8895-0000-4000-8000-000000000010'
      const noticeId = '972c8895-0000-4000-8000-000000000011'
      recordTurnWake(
        connA,
        {
          type: 'canonical_system_notices',
          execute_notice_ids: [noticeId],
          ingress: {
            system_notices: [{ notice_id: noticeId, audience: 'for_the_record' }],
          },
        },
        tmpDir,
      )
      const markerA = readTurnMarker(connA, tmpDir)
      const resA = restoreHeldParentIfResumed(connA, markerA, { dir: tmpDir })
      assert.equal(resA.restored, false)
      assert.deepEqual(currentTurnNoticeIds(connA, { dir: tmpDir }), [noticeId])
      assert.equal(isCurrentTurnRoutine(connA, { dir: tmpDir }), true)

      const connB = '972c8895-0000-4000-8000-000000000012'
      recordTurnWake(connB, { type: 'check_job', check_job_id: '972c8895-0000-4000-8000-000000000013' }, tmpDir)
      const markerB = readTurnMarker(connB, tmpDir)
      const resB = restoreHeldParentIfResumed(connB, markerB, { dir: tmpDir })
      assert.equal(resB.restored, false)
      assert.equal(isCurrentTurnRoutine(connB, { dir: tmpDir }), true)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('keeps check-job pause and helper subagent isolated from the command trail and Stop reply (02f4ce2b, a2d9f38f, c1791ffa)', async () => {
    const { appendRequestEvent, setCurrentRequest, UNSTATED } = await import('./requests.mjs')
    const {
      isCurrentTurnCheckJobOnly,
      recordCheckJobRuled,
      recordOwnedEnd,
      recordOwnedLaunch,
      recordTurnWake,
      restoreHeldParentIfResumed,
      streamTurnTrailIfChanged,
    } = await import('./mirror-turn.mjs')

    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-check-isolation-'))
    try {
      const connectionsDir = path.join(tmpHome, 'connections')
      const legacyPath = path.join(tmpHome, 'legacy.json')
      fs.mkdirSync(connectionsDir, { recursive: true })
      const connId = '972c8895-0000-4000-8000-000000000021'
      const sessId = '972c8895-0000-4000-8000-000000000022'
      const reqId = '972c8895-0000-4000-8000-000000000023'
      const convId = 'conv-check-isolation'
      const parentTaskId = `${convId}/task-10`
      const checkHelperId = 'subagent-check-helper-1'
      const transcriptPath = path.join(tmpHome, 'transcript.jsonl')
      const t0 = Date.now() - 20_000

      appendRequestEvent(connId, { op: 'open', id: reqId, kind: 'command' }, { dir: connectionsDir })
      setCurrentRequest(connId, reqId, { dir: connectionsDir })
      appendRequestEvent(
        connId,
        { op: 'launch', key: parentTaskId, kind: 'shell', notifies: true, request: reqId, also: [] },
        { dir: connectionsDir },
      )
      writeTurnMarker(connId, { startedAt: t0, remoteTurn: true, otherWake: true, held: true }, connectionsDir)
      recordOwnedLaunch(connId, { id: parentTaskId, kind: 'command', label: 'Build app' }, { dir: connectionsDir, now: t0 + 500 })

      // Mid-wait check job arrives at t0 + 2000 and spawns a fresh helper subagent.
      recordTurnWake(
        connId,
        { type: 'check_job', check_job_id: '972c8895-0000-4000-8000-000000000024' },
        connectionsDir,
        t0 + 2000,
      )
      setCurrentRequest(connId, UNSTATED, { dir: connectionsDir })
      recordOwnedLaunch(connId, { id: checkHelperId, kind: 'subagent', label: 'Check Reviewer' }, { dir: connectionsDir, now: t0 + 2500 })

      // Parent task finishes while check helper is still running: MUST NOT restore yet!
      recordOwnedEnd(connId, parentTaskId, { dir: connectionsDir, now: t0 + 4000 })
      const whileHelperRunning = restoreHeldParentIfResumed(connId, readTurnMarker(connId, connectionsDir), {
        dir: connectionsDir,
        now: t0 + 4100,
      })
      assert.equal(whileHelperRunning.restored, false)
      assert.equal(isCurrentTurnCheckJobOnly(connId, { dir: connectionsDir }), true)

      // Helper finishes, but check job has NOT recorded rulings yet: still MUST NOT restore!
      recordOwnedEnd(connId, checkHelperId, { dir: connectionsDir, now: t0 + 4500 })
      const beforeRuling = restoreHeldParentIfResumed(connId, readTurnMarker(connId, connectionsDir), {
        dir: connectionsDir,
        now: t0 + 4600,
      })
      assert.equal(beforeRuling.restored, false)
      assert.equal(isCurrentTurnCheckJobOnly(connId, { dir: connectionsDir }), true)

      // Now check ruling finishes (`recordCheckJobRuled`), and parent task resumes.
      recordCheckJobRuled(connId, connectionsDir, {
        jobId: '972c8895-0000-4000-8000-000000000024',
        now: t0 + 4900,
      })
      const afterRuling = restoreHeldParentIfResumed(connId, readTurnMarker(connId, connectionsDir), {
        dir: connectionsDir,
        now: t0 + 5000,
      })
      assert.equal(afterRuling.restored, true)

      // Transcript has:
      // - pre-pause command step (t0 + 1000)
      // - check-pause helper launch (t0 + 2500)
      // - check-only tool step AFTER parent finished (t0 + 4200, while helper still running!)
      // - routine check-only response AFTER parent & helper finished, before pause ended (t0 + 4700!)
      // - post-resume command step (t0 + 6000)
      const steps = [
        {
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          created_at: new Date(t0 + 1000).toISOString(),
          tool_calls: [{ name: 'read_file', args: { Path: '/tmp/before-pause.ts' } }],
        },
        {
          step_index: 2,
          type: 'PLANNER_RESPONSE',
          created_at: new Date(t0 + 2500).toISOString(),
          tool_calls: [
            {
              name: 'invoke_subagent',
              args: { Subagents: [{ Role: 'Check Reviewer' }], toolSummary: 'Rule check job' },
            },
          ],
        },
        {
          step_index: 3,
          type: 'PLANNER_RESPONSE',
          created_at: new Date(t0 + 4200).toISOString(),
          tool_calls: [{ name: 'read_file', args: { Path: '/tmp/check-only-between-completion-and-pause-end.ts' } }],
        },
        {
          step_index: 4,
          type: 'PLANNER_RESPONSE',
          created_at: new Date(t0 + 4700).toISOString(),
          content: 'Check job ruled cleanly (internal note only).',
        },
        {
          step_index: 5,
          type: 'PLANNER_RESPONSE',
          created_at: new Date(t0 + 6000).toISOString(),
          tool_calls: [{ name: 'read_file', args: { Path: '/tmp/after-resume.ts' } }],
        },
      ]
      fs.writeFileSync(transcriptPath, steps.map((s) => JSON.stringify(s)).join('\n') + '\n')
      fs.writeFileSync(
        path.join(connectionsDir, `${connId}.json`),
        JSON.stringify({
          enabled: true,
          connection_id: connId,
          session_id: sessId,
          agent_name: 'Antigravity',
          local_id: convId,
          transcript_path: transcriptPath,
          mcp_url: 'https://example.invalid/api/mcp',
          token: 'test-token',
          connection_capability: 'dvsc_test',
        }),
      )

      const trailCalls = []
      await streamTurnTrailIfChanged(
        {
          connection_id: connId,
          session_id: sessId,
          agent_name: 'Antigravity',
          transcript_path: transcriptPath,
          mcp_url: 'https://example.invalid/api/mcp',
          token: 'test-token',
        },
        {
          connectionsDir,
          call: async (req) => {
            trailCalls.push(req)
            return { ok: true }
          },
        },
      )
      assert.equal(trailCalls.length, 1)
      const trailMsg = String(trailCalls[0].arguments.message)
      assert.ok(trailMsg.includes('before-pause.ts'))
      assert.ok(trailMsg.includes('after-resume.ts'))
      assert.equal(trailMsg.includes('Check Reviewer'), false)
      assert.equal(trailMsg.includes('invoke_subagent'), false)
      assert.equal(trailMsg.includes('check-only-between-completion-and-pause-end.ts'), false)

      // Stop without any post-resume assistant reply must NOT scrape the check-pause note from t0 + 3500!
      const stopCalls = []
      await handleMirrorTurn(
        'stop',
        JSON.stringify({ conversationId: convId, transcriptPath }),
        {
          env: {},
          connectionsDir,
          legacyPath,
          call: async (req) => {
            stopCalls.push(req)
            return { ok: true }
          },
        },
      )
      assert.equal(
        stopCalls.some(
          (c) =>
            c.name === 'post_session_message' &&
            String(c.arguments.message || '').includes('Check job ruled cleanly'),
        ),
        false,
      )
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it('keeps a quiet notice silent on Stop when parent background work finished without resumed parent work (02f4ce2b)', async () => {
    const { appendRequestEvent, setCurrentRequest, UNSTATED } = await import('./requests.mjs')
    const { recordOwnedEnd, recordOwnedLaunch, recordTurnWake } = await import('./mirror-turn.mjs')

    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-quiet-stop-'))
    try {
      const connectionsDir = path.join(tmpHome, 'connections')
      const legacyPath = path.join(tmpHome, 'legacy.json')
      fs.mkdirSync(connectionsDir, { recursive: true })
      const connId = '972c8895-0000-4000-8000-000000000031'
      const sessId = '972c8895-0000-4000-8000-000000000032'
      const reqId = '972c8895-0000-4000-8000-000000000033'
      const noticeId = '972c8895-0000-4000-8000-000000000034'
      const convId = 'conv-quiet-stop'
      const taskId = `${convId}/task-99`
      const transcriptPath = path.join(tmpHome, 'transcript.jsonl')
      const t0 = Date.now() - 10_000

      appendRequestEvent(connId, { op: 'open', id: reqId, kind: 'command' }, { dir: connectionsDir })
      setCurrentRequest(connId, reqId, { dir: connectionsDir })
      writeTurnMarker(connId, { startedAt: t0, remoteTurn: true, otherWake: true, held: true }, connectionsDir)
      recordOwnedLaunch(connId, { id: taskId, kind: 'command', label: 'Tests' }, { dir: connectionsDir, now: t0 + 500 })
      recordTurnWake(
        connId,
        {
          type: 'canonical_system_notices',
          execute_notice_ids: [noticeId],
          ingress: { system_notices: [{ notice_id: noticeId, audience: 'for_the_record' }] },
        },
        connectionsDir,
        t0 + 2000,
      )
      setCurrentRequest(connId, UNSTATED, { dir: connectionsDir })
      recordOwnedEnd(connId, taskId, { dir: connectionsDir, now: t0 + 3000 })

      fs.writeFileSync(
        transcriptPath,
        JSON.stringify({
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          created_at: new Date(t0 + 2500).toISOString(),
          content: 'Quiet notice handled locally — do not post in room.',
        }) + '\n',
      )
      fs.writeFileSync(
        path.join(connectionsDir, `${connId}.json`),
        JSON.stringify({
          enabled: true,
          connection_id: connId,
          session_id: sessId,
          agent_name: 'Antigravity',
          local_id: convId,
          transcript_path: transcriptPath,
          mcp_url: 'https://example.invalid/api/mcp',
          token: 'test-token',
          connection_capability: 'dvsc_test',
        }),
      )

      const stopCalls = []
      await handleMirrorTurn('stop', JSON.stringify({ conversationId: convId, transcriptPath }), {
        env: {},
        connectionsDir,
        legacyPath,
        call: async (req) => {
          stopCalls.push(req)
          return { ok: true }
        },
      })
      assert.equal(stopCalls.some((c) => c.name === 'post_session_message'), false)
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it('restores request attribution strictly from the ended launch when a parked turn holds launches for two requesters (ce71a72b)', async () => {
    const {
      appendRequestEvent,
      readRequestState,
      requestRefForWrite,
      setCurrentRequest,
      UNSTATED,
    } = await import('./requests.mjs')
    const {
      recordOwnedEnd,
      recordOwnedLaunch,
      recordTurnWake,
      restoreHeldParentIfResumed,
    } = await import('./mirror-turn.mjs')

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-multi-req-'))
    try {
      const connId = '972c8895-0000-4000-8000-000000000041'
      const reqAlice = '972c8895-0000-4000-8000-000000000042'
      const reqBob = '972c8895-0000-4000-8000-000000000043'
      const noticeId = '972c8895-0000-4000-8000-000000000044'
      const taskAlice = 'conv-multi/task-alice'
      const taskBob = 'conv-multi/task-bob'
      const t0 = Date.now() - 10_000

      appendRequestEvent(connId, { op: 'open', id: reqAlice, kind: 'command', requested_by: 'alice' }, { dir: tmpDir })
      appendRequestEvent(connId, { op: 'open', id: reqBob, kind: 'command', requested_by: 'bob' }, { dir: tmpDir })
      setCurrentRequest(connId, reqAlice, { dir: tmpDir })
      appendRequestEvent(connId, { op: 'launch', key: taskAlice, kind: 'shell', notifies: true, request: reqAlice, also: [] }, { dir: tmpDir })
      appendRequestEvent(connId, { op: 'launch', key: taskBob, kind: 'shell', notifies: true, request: reqBob, also: [] }, { dir: tmpDir })

      writeTurnMarker(connId, { startedAt: t0, remoteTurn: true, otherWake: true, held: true }, tmpDir)
      recordOwnedLaunch(connId, { id: taskAlice, kind: 'command', label: 'Alice task' }, { dir: tmpDir, now: t0 + 100 })
      recordOwnedLaunch(connId, { id: taskBob, kind: 'command', label: 'Bob task' }, { dir: tmpDir, now: t0 + 200 })

      recordTurnWake(
        connId,
        {
          type: 'canonical_system_notices',
          execute_notice_ids: [noticeId],
          ingress: { system_notices: [{ notice_id: noticeId, audience: 'for_the_record' }] },
        },
        tmpDir,
        t0 + 1000,
      )
      setCurrentRequest(connId, UNSTATED, { dir: tmpDir })

      // Only Bob's task ends (recorded in owned log, with no matching notification text):
      // MUST restore Bob's request, NEVER Alice's still-open launch!
      recordOwnedEnd(connId, taskBob, { dir: tmpDir, now: t0 + 2000 })
      const res = restoreHeldParentIfResumed(connId, readTurnMarker(connId, tmpDir), { dir: tmpDir, now: t0 + 2500 })
      assert.equal(res.restored, true)
      assert.equal(requestRefForWrite(readRequestState(connId, { dir: tmpDir })), reqBob)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('retains unknown attribution when a completed launch was unstated even if another parked launch has a known requester (ce71a72b)', async () => {
    const {
      appendRequestEvent,
      readRequestState,
      requestRefForWrite,
      setCurrentRequest,
      UNSTATED,
    } = await import('./requests.mjs')
    const {
      recordOwnedEnd,
      recordOwnedLaunch,
      recordTurnWake,
      restoreHeldParentIfResumed,
    } = await import('./mirror-turn.mjs')

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-unstated-launch-'))
    try {
      const connId = '972c8895-0000-4000-8000-000000000051'
      const reqAlice = '972c8895-0000-4000-8000-000000000052'
      const noticeId = '972c8895-0000-4000-8000-000000000053'
      const taskAlice = 'conv-unstated/task-alice'
      const taskUnstated = 'conv-unstated/task-unknown'
      const t0 = Date.now() - 10_000

      appendRequestEvent(connId, { op: 'open', id: reqAlice, kind: 'command', requested_by: 'alice' }, { dir: tmpDir })
      setCurrentRequest(connId, reqAlice, { dir: tmpDir })
      appendRequestEvent(connId, { op: 'launch', key: taskAlice, kind: 'shell', notifies: true, request: reqAlice, also: [] }, { dir: tmpDir })
      appendRequestEvent(connId, { op: 'launch', key: taskUnstated, kind: 'shell', notifies: true, request: UNSTATED, also: [] }, { dir: tmpDir })

      writeTurnMarker(connId, { startedAt: t0, remoteTurn: true, otherWake: true, held: true }, tmpDir)
      recordOwnedLaunch(connId, { id: taskAlice, kind: 'command', label: 'Alice task' }, { dir: tmpDir, now: t0 + 100 })
      recordOwnedLaunch(connId, { id: taskUnstated, kind: 'command', label: 'Unstated task' }, { dir: tmpDir, now: t0 + 200 })

      recordTurnWake(
        connId,
        {
          type: 'canonical_system_notices',
          execute_notice_ids: [noticeId],
          ingress: { system_notices: [{ notice_id: noticeId, audience: 'for_the_record' }] },
        },
        tmpDir,
        t0 + 1000,
      )
      setCurrentRequest(connId, UNSTATED, { dir: tmpDir })

      // Only the unstated launch finishes while Alice's launch is still running:
      // MUST retain unknown attribution (null), NEVER credit Alice!
      recordOwnedEnd(connId, taskUnstated, { dir: tmpDir, now: t0 + 2000 })
      const res = restoreHeldParentIfResumed(connId, readTurnMarker(connId, tmpDir), { dir: tmpDir, now: t0 + 2500 })
      assert.equal(res.restored, true)
      assert.equal(requestRefForWrite(readRequestState(connId, { dir: tmpDir })), null)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('does not mark a check-job pause ruled on an intermediate record_check_rulings batch with remaining entries (a2d9f38f)', async () => {
    const { appendRequestEvent, setCurrentRequest, UNSTATED } = await import('./requests.mjs')
    const { runPostToolDispatch } = await import('./post-tool-dispatch.mjs')
    const {
      isCurrentTurnCheckJobOnly,
      recordOwnedEnd,
      recordOwnedLaunch,
      recordTurnWake,
    } = await import('./mirror-turn.mjs')

    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-mid-batch-'))
    try {
      const connectionsDir = path.join(tmpHome, '.devspec', 'remote-control', 'connections')
      fs.mkdirSync(connectionsDir, { recursive: true })
      const connId = '972c8895-0000-4000-8000-000000000061'
      const sessId = '972c8895-0000-4000-8000-000000000062'
      const reqId = '972c8895-0000-4000-8000-000000000063'
      const jobId = '972c8895-0000-4000-8000-000000000064'
      const convId = 'conv-mid-batch'
      const parentTaskId = `${convId}/task-1`
      const transcriptPath = path.join(tmpHome, 'transcript.jsonl')
      const t0 = Date.now() - 20_000

      fs.writeFileSync(
        path.join(connectionsDir, `${connId}.json`),
        JSON.stringify({
          enabled: true,
          connection_id: connId,
          session_id: sessId,
          agent_name: 'Antigravity',
          local_id: convId,
          transcript_path: transcriptPath,
          mcp_url: 'https://example.invalid/api/mcp',
          token: 'test-token',
          connection_capability: 'dvsc_test',
        }),
      )
      appendRequestEvent(connId, { op: 'open', id: reqId, kind: 'command' }, { dir: connectionsDir })
      setCurrentRequest(connId, reqId, { dir: connectionsDir })
      appendRequestEvent(
        connId,
        { op: 'launch', key: parentTaskId, kind: 'shell', notifies: true, request: reqId, also: [] },
        { dir: connectionsDir },
      )
      writeTurnMarker(connId, { startedAt: t0, remoteTurn: true, otherWake: true, held: true }, connectionsDir)
      recordOwnedLaunch(connId, { id: parentTaskId, kind: 'command', label: 'Build' }, { dir: connectionsDir, now: t0 + 500 })
      recordTurnWake(connId, { type: 'check_job', check_job_id: jobId }, connectionsDir, t0 + 2000)
      setCurrentRequest(connId, UNSTATED, { dir: connectionsDir })
      recordOwnedEnd(connId, parentTaskId, { dir: connectionsDir, now: t0 + 3000 })

      fs.writeFileSync(
        transcriptPath,
        JSON.stringify({
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          created_at: new Date(t0 + 1000).toISOString(),
          tool_calls: [{ name: 'read_file', args: { Path: '/tmp/parent-before.ts' } }],
        }) + '\n',
      )

      const calls = []
      const fakeCall = async (req) => {
        calls.push(req)
        return { ok: true }
      }

      // 1. Intermediate batch (settled: false, remaining: 5) MUST NOT mark checkJobRuled!
      await runPostToolDispatch(
        JSON.stringify({
          conversationId: convId,
          transcriptPath,
          tool_name: 'call_mcp_tool',
          tool_input: {
            ServerName: 'devspec_devspec',
            ToolName: 'record_check_rulings',
            Arguments: { check_job_id: jobId, rulings: [] },
          },
          tool_response: {
            content: [{ type: 'text', text: JSON.stringify({ settled: false, remaining: 5 }) }],
          },
        }),
        { home: tmpHome, env: {}, call: fakeCall },
      )
      assert.equal(readTurnMarker(connId, connectionsDir)?.checkJobRuled, false)
      assert.equal(isCurrentTurnCheckJobOnly(connId, { dir: connectionsDir }), true)

      // 2. Subsequent check-only read_file before batch 2 MUST stay in check-job pause (no restore, no trail)!
      fs.appendFileSync(
        transcriptPath,
        JSON.stringify({
          step_index: 2,
          type: 'PLANNER_RESPONSE',
          created_at: new Date(Date.now() - 50).toISOString(),
          tool_calls: [{ name: 'read_file', args: { Path: '/tmp/batch2-check-file.ts' } }],
        }) + '\n',
      )
      await runPostToolDispatch(
        JSON.stringify({
          conversationId: convId,
          transcriptPath,
          tool_name: 'read_file',
          tool_input: { Path: '/tmp/batch2-check-file.ts' },
        }),
        { home: tmpHome, env: {}, call: fakeCall },
      )
      assert.equal(isCurrentTurnCheckJobOnly(connId, { dir: connectionsDir }), true)
      assert.equal(calls.some((c) => c.name === 'post_session_message'), false)

      // 3. Final batch (settled: true, remaining: 0) marks checkJobRuled = true,
      //    and the next resumed parent tool restores heldParent while excluding batch2-check-file.ts!
      await runPostToolDispatch(
        JSON.stringify({
          conversationId: convId,
          transcriptPath,
          tool_name: 'call_mcp_tool',
          tool_input: {
            ServerName: 'devspec_devspec',
            ToolName: 'record_check_rulings',
            Arguments: { check_job_id: jobId, rulings: [] },
          },
          tool_response: {
            content: [{ type: 'text', text: JSON.stringify({ settled: true, remaining: 0 }) }],
          },
        }),
        { home: tmpHome, env: {}, call: fakeCall },
      )
      assert.equal(readTurnMarker(connId, connectionsDir)?.checkJobRuled, true)

      const resumedStepMs = Date.now() + 50
      fs.appendFileSync(
        transcriptPath,
        JSON.stringify({
          step_index: 3,
          type: 'PLANNER_RESPONSE',
          created_at: new Date(resumedStepMs).toISOString(),
          tool_calls: [{ name: 'edit_file', args: { Path: '/tmp/resumed-parent.ts' } }],
        }) + '\n',
      )
      await runPostToolDispatch(
        JSON.stringify({
          conversationId: convId,
          transcriptPath,
          tool_name: 'edit_file',
          tool_input: { Path: '/tmp/resumed-parent.ts' },
        }),
        { home: tmpHome, env: {}, call: fakeCall },
      )
      assert.equal(readTurnMarker(connId, connectionsDir)?.heldParent, null)
      const trailPost = calls.find((c) => c.name === 'post_session_message')
      assert.ok(trailPost, 'expected resumed parent trail to stream')
      assert.ok(String(trailPost.arguments.message).includes('resumed-parent.ts'))
      assert.equal(String(trailPost.arguments.message).includes('batch2-check-file.ts'), false)
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it('does not let a notice tool or tell_person write restore the parent turn or leak into command trail/answer (02f4ce2b, a2d9f38f)', async () => {
    const { appendRequestEvent, setCurrentRequest, UNSTATED } = await import('./requests.mjs')
    const { runPostToolDispatch } = await import('./post-tool-dispatch.mjs')
    const {
      currentTurnReplyNoticeIds,
      recordOwnedEnd,
      recordOwnedLaunch,
      recordTurnWake,
    } = await import('./mirror-turn.mjs')

    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-notice-tool-isolation-'))
    try {
      const connectionsDir = path.join(tmpHome, '.devspec', 'remote-control', 'connections')
      const legacyPath = path.join(tmpHome, '.devspec', 'remote-control.json')
      fs.mkdirSync(connectionsDir, { recursive: true })
      const connId = '972c8895-0000-4000-8000-000000000071'
      const sessId = '972c8895-0000-4000-8000-000000000072'
      const reqId = '972c8895-0000-4000-8000-000000000073'
      const noticeId = '972c8895-0000-4000-8000-000000000074'
      const convId = 'conv-notice-tool-isolation'
      const parentTaskId = `${convId}/task-1`
      const transcriptPath = path.join(tmpHome, 'transcript.jsonl')
      const t0 = Date.now() - 20_000

      fs.writeFileSync(
        path.join(connectionsDir, `${connId}.json`),
        JSON.stringify({
          enabled: true,
          connection_id: connId,
          session_id: sessId,
          agent_name: 'Antigravity',
          local_id: convId,
          transcript_path: transcriptPath,
          mcp_url: 'https://example.invalid/api/mcp',
          token: 'test-token',
          connection_capability: 'dvsc_test',
        }),
      )
      appendRequestEvent(connId, { op: 'open', id: reqId, kind: 'command' }, { dir: connectionsDir })
      setCurrentRequest(connId, reqId, { dir: connectionsDir })
      appendRequestEvent(
        connId,
        { op: 'launch', key: parentTaskId, kind: 'shell', notifies: true, request: reqId, also: [] },
        { dir: connectionsDir },
      )
      writeTurnMarker(connId, { startedAt: t0, remoteTurn: true, otherWake: true, held: true }, connectionsDir)
      recordOwnedLaunch(connId, { id: parentTaskId, kind: 'command', label: 'Build' }, { dir: connectionsDir, now: t0 + 500 })

      // A needs_person notice arrives during the wait, and parent task completes while notice is handled.
      recordTurnWake(
        connId,
        {
          type: 'canonical_system_notices',
          execute_notice_ids: [noticeId],
          ingress: { system_notices: [{ notice_id: noticeId, audience: 'needs_person' }] },
        },
        connectionsDir,
        t0 + 2000,
      )
      setCurrentRequest(connId, UNSTATED, { dir: connectionsDir })
      recordOwnedEnd(connId, parentTaskId, { dir: connectionsDir, now: t0 + 3000 })

      fs.writeFileSync(
        transcriptPath,
        [
          {
            step_index: 1,
            type: 'PLANNER_RESPONSE',
            created_at: new Date(t0 + 3500).toISOString(),
            tool_calls: [{ name: 'update_memory', args: { memory_id: 'm1' } }],
          },
          {
            step_index: 2,
            type: 'PLANNER_RESPONSE',
            created_at: new Date(t0 + 4000).toISOString(),
            content: 'Unresolved conflict still waiting on owner decision.',
          },
        ]
          .map((s) => JSON.stringify(s))
          .join('\n') + '\n',
      )

      const toolCalls = []
      await runPostToolDispatch(
        JSON.stringify({
          conversationId: convId,
          transcriptPath,
          tool_name: 'call_mcp_tool',
          tool_input: {
            ServerName: 'devspec_devspec',
            ToolName: 'update_memory',
            Arguments: { memory_id: 'm1' },
          },
          tool_response: {
            content: [{ type: 'text', text: JSON.stringify({ tell_person: { why: 'changed shared record' } }) }],
          },
        }),
        {
          home: tmpHome,
          env: {},
          call: async (req) => {
            toolCalls.push(req)
            return { ok: true }
          },
        },
      )

      // MUST stay in notice pause: heldParent preserved, noticeIds preserved, tellPerson preserved, ZERO command trail!
      const afterTool = readTurnMarker(connId, connectionsDir)
      assert.ok(afterTool?.heldParent, 'expected heldParent to stay parked during notice handling')
      assert.equal(afterTool?.tellPerson, true)
      assert.deepEqual(currentTurnReplyNoticeIds(connId, { dir: connectionsDir }), [noticeId])
      assert.equal(toolCalls.some((c) => c.name === 'post_session_message'), false)

      // On Stop: must NEVER post the unresolved finding as the command's final answer (complete_turn: true)!
      const stopCalls = []
      await handleMirrorTurn('stop', JSON.stringify({ conversationId: convId, transcriptPath }), {
        env: {},
        connectionsDir,
        legacyPath,
        call: async (req) => {
          stopCalls.push(req)
          return { ok: true }
        },
      })
      assert.equal(
        stopCalls.some((c) => c.name === 'post_session_message' && c.arguments?.complete_turn === true),
        false,
      )
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it('retains unknown attribution when two parked launches finish in the same pause and one is untracked (ce71a72b)', async () => {
    const {
      appendRequestEvent,
      readRequestState,
      requestRefForWrite,
      setCurrentRequest,
      UNSTATED,
    } = await import('./requests.mjs')
    const {
      recordOwnedEnd,
      recordOwnedLaunch,
      recordTurnWake,
      restoreHeldParentIfResumed,
    } = await import('./mirror-turn.mjs')

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-untracked-mixed-'))
    try {
      const connId = '972c8895-0000-4000-8000-000000000081'
      const reqAlice = '972c8895-0000-4000-8000-000000000082'
      const noticeId = '972c8895-0000-4000-8000-000000000083'
      const taskAlice = 'conv-mixed/task-alice'
      const taskUntracked = 'conv-mixed/task-untracked'
      const t0 = Date.now() - 10_000

      appendRequestEvent(connId, { op: 'open', id: reqAlice, kind: 'command', requested_by: 'alice' }, { dir: tmpDir })
      setCurrentRequest(connId, reqAlice, { dir: tmpDir })
      appendRequestEvent(connId, { op: 'launch', key: taskAlice, kind: 'shell', notifies: true, request: reqAlice, also: [] }, { dir: tmpDir })
      // taskUntracked intentionally has NO launch record in requests.jsonl!

      writeTurnMarker(connId, { startedAt: t0, remoteTurn: true, otherWake: true, held: true }, tmpDir)
      recordOwnedLaunch(connId, { id: taskAlice, kind: 'command', label: 'Alice task' }, { dir: tmpDir, now: t0 + 100 })
      recordOwnedLaunch(connId, { id: taskUntracked, kind: 'command', label: 'Untracked task' }, { dir: tmpDir, now: t0 + 200 })

      recordTurnWake(
        connId,
        {
          type: 'canonical_system_notices',
          execute_notice_ids: [noticeId],
          ingress: { system_notices: [{ notice_id: noticeId, audience: 'for_the_record' }] },
        },
        tmpDir,
        t0 + 1000,
      )
      setCurrentRequest(connId, UNSTATED, { dir: tmpDir })

      // Both finish in the same pause; notification is for the untracked launch:
      // MUST retain unknown attribution (null), NEVER credit Alice!
      recordOwnedEnd(connId, taskAlice, { dir: tmpDir, now: t0 + 1800 })
      recordOwnedEnd(connId, taskUntracked, { dir: tmpDir, now: t0 + 2000 })
      const res = restoreHeldParentIfResumed(connId, readTurnMarker(connId, tmpDir), {
        dir: tmpDir,
        latestStep: {
          type: 'SYSTEM_MESSAGE',
          created_at: new Date(t0 + 2000).toISOString(),
          content: `[Message] Background command "${taskUntracked}" completed with exit code 0`,
        },
        now: t0 + 2500,
      })
      assert.equal(res.restored, true)
      assert.equal(requestRefForWrite(readRequestState(connId, { dir: tmpDir })), null)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('keeps a mixed check + for_the_record pause out of the room trail after the check settles (02f4ce2b)', async () => {
    const { appendRequestEvent, setCurrentRequest, UNSTATED } = await import('./requests.mjs')
    const { runPostToolDispatch } = await import('./post-tool-dispatch.mjs')
    const {
      isCurrentTurnRoutine,
      recordOwnedEnd,
      recordOwnedLaunch,
      recordTurnWake,
    } = await import('./mirror-turn.mjs')

    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-mixed-check-notice-'))
    try {
      const connectionsDir = path.join(tmpHome, '.devspec', 'remote-control', 'connections')
      fs.mkdirSync(connectionsDir, { recursive: true })
      const connId = '972c8895-0000-4000-8000-000000000091'
      const sessId = '972c8895-0000-4000-8000-000000000092'
      const reqId = '972c8895-0000-4000-8000-000000000093'
      const jobId = '972c8895-0000-4000-8000-000000000094'
      const noticeId = '972c8895-0000-4000-8000-000000000095'
      const convId = 'conv-mixed-check-notice'
      const parentTaskId = `${convId}/task-1`
      const transcriptPath = path.join(tmpHome, 'transcript.jsonl')
      const t0 = Date.now() - 20_000

      fs.writeFileSync(
        path.join(connectionsDir, `${connId}.json`),
        JSON.stringify({
          enabled: true,
          connection_id: connId,
          session_id: sessId,
          agent_name: 'Antigravity',
          local_id: convId,
          transcript_path: transcriptPath,
          mcp_url: 'https://example.invalid/api/mcp',
          token: 'test-token',
          connection_capability: 'dvsc_test',
        }),
      )
      appendRequestEvent(connId, { op: 'open', id: reqId, kind: 'command' }, { dir: connectionsDir })
      setCurrentRequest(connId, reqId, { dir: connectionsDir })
      appendRequestEvent(connId, { op: 'launch', key: parentTaskId, kind: 'shell', notifies: true, request: reqId, also: [] }, { dir: connectionsDir })
      writeTurnMarker(connId, { startedAt: t0, remoteTurn: true, otherWake: true, held: true }, connectionsDir)
      recordOwnedLaunch(connId, { id: parentTaskId, kind: 'command', label: 'Build' }, { dir: connectionsDir, now: t0 + 500 })

      // Both a check job AND a for_the_record notice arrive in the same pause!
      recordTurnWake(connId, { type: 'check_job', check_job_id: jobId }, connectionsDir, t0 + 2000)
      recordTurnWake(
        connId,
        {
          type: 'canonical_system_notices',
          execute_notice_ids: [noticeId],
          ingress: { system_notices: [{ notice_id: noticeId, audience: 'for_the_record' }] },
        },
        connectionsDir,
        t0 + 2100,
      )
      setCurrentRequest(connId, UNSTATED, { dir: connectionsDir })
      recordOwnedEnd(connId, parentTaskId, { dir: connectionsDir, now: t0 + 3000 })

      fs.writeFileSync(transcriptPath, '')
      const calls = []
      const fakeCall = async (req) => {
        calls.push(req)
        return { ok: true }
      }

      // Check settles, then a routine notice-handling tool runs: MUST NOT restore or stream!
      await runPostToolDispatch(
        JSON.stringify({
          conversationId: convId,
          transcriptPath,
          tool_name: 'call_mcp_tool',
          tool_input: {
            ServerName: 'devspec_devspec',
            ToolName: 'record_check_rulings',
            Arguments: { check_job_id: jobId, rulings: [] },
          },
          tool_response: {
            content: [{ type: 'text', text: JSON.stringify({ settled: true, remaining: 0 }) }],
          },
        }),
        { home: tmpHome, env: {}, call: fakeCall },
      )
      fs.appendFileSync(
        transcriptPath,
        JSON.stringify({
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          created_at: new Date(Date.now() + 20).toISOString(),
          tool_calls: [{ name: 'read_file', args: { Path: '/tmp/notice-only-file.ts' } }],
        }) + '\n',
      )
      await runPostToolDispatch(
        JSON.stringify({
          conversationId: convId,
          transcriptPath,
          tool_name: 'read_file',
          tool_input: { Path: '/tmp/notice-only-file.ts' },
        }),
        { home: tmpHome, env: {}, call: fakeCall },
      )
      assert.ok(readTurnMarker(connId, connectionsDir)?.heldParent)
      assert.equal(isCurrentTurnRoutine(connId, { dir: connectionsDir }), true)
      assert.equal(calls.some((c) => c.name === 'post_session_message'), false)
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it('does not make the parent request current in PreInvocation when parent work finishes while a check helper is still running (a2d9f38f)', async () => {
    const { appendRequestEvent, readRequestState, requestRefForWrite, setCurrentRequest, UNSTATED } = await import('./requests.mjs')
    const {
      isCurrentTurnCheckJobOnly,
      recordOwnedLaunch,
      recordTurnWake,
    } = await import('./mirror-turn.mjs')

    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-pre-check-helper-'))
    try {
      const connectionsDir = path.join(tmpHome, 'connections')
      const legacyPath = path.join(tmpHome, 'legacy.json')
      fs.mkdirSync(connectionsDir, { recursive: true })
      const connId = '972c8895-0000-4000-8000-000000000101'
      const sessId = '972c8895-0000-4000-8000-000000000102'
      const reqId = '972c8895-0000-4000-8000-000000000103'
      const jobId = '972c8895-0000-4000-8000-000000000104'
      const convId = 'conv-pre-check-helper'
      const parentTaskId = `${convId}/task-1`
      const helperId = 'subagent-check-helper-active'
      const transcriptPath = path.join(tmpHome, 'transcript.jsonl')
      const t0 = Date.now() - 10_000

      fs.writeFileSync(
        path.join(connectionsDir, `${connId}.json`),
        JSON.stringify({
          enabled: true,
          connection_id: connId,
          session_id: sessId,
          agent_name: 'Antigravity',
          local_id: convId,
          transcript_path: transcriptPath,
          mcp_url: 'https://example.invalid/api/mcp',
          token: 'test-token',
          connection_capability: 'dvsc_test',
        }),
      )
      appendRequestEvent(connId, { op: 'open', id: reqId, kind: 'command' }, { dir: connectionsDir })
      setCurrentRequest(connId, reqId, { dir: connectionsDir })
      appendRequestEvent(connId, { op: 'launch', key: parentTaskId, kind: 'shell', notifies: true, request: reqId, also: [] }, { dir: connectionsDir })
      writeTurnMarker(connId, { startedAt: t0, remoteTurn: true, otherWake: true, held: true }, connectionsDir)
      recordOwnedLaunch(connId, { id: parentTaskId, kind: 'command', label: 'Build' }, { dir: connectionsDir, now: t0 + 500 })

      // Check job arrives, spawns helper, and Stop holds the check pause open while helper runs.
      recordTurnWake(connId, { type: 'check_job', check_job_id: jobId }, connectionsDir, t0 + 2000)
      setCurrentRequest(connId, UNSTATED, { dir: connectionsDir })
      recordOwnedLaunch(connId, { id: helperId, kind: 'subagent', label: 'Check Helper' }, { dir: connectionsDir, now: t0 + 2200 })
      writeTurnMarker(connId, { held: true, preserveExplicitReply: true }, connectionsDir)

      // Parent background command finishes and triggers PreInvocation while check helper is STILL running!
      fs.writeFileSync(
        transcriptPath,
        JSON.stringify({
          step_index: 1,
          source: 'SYSTEM',
          type: 'SYSTEM_MESSAGE',
          created_at: new Date(t0 + 4000).toISOString(),
          content: `[Message] sender=${parentTaskId} content=Task id "${parentTaskId}" finished with result:\nBuild green`,
        }) + '\n',
      )

      await handleMirrorTurn('user_prompt', JSON.stringify({ conversationId: convId, transcriptPath }), {
        env: {},
        connectionsDir,
        legacyPath,
        call: async () => ({ ok: true }),
      })

      // MUST stay check-job-only with requestRefForWrite === null (NEVER make parent reqId current yet)!
      assert.ok(readTurnMarker(connId, connectionsDir)?.heldParent)
      assert.equal(requestRefForWrite(readRequestState(connId, { dir: connectionsDir })), null)
      assert.equal(isCurrentTurnCheckJobOnly(connId, { dir: connectionsDir }), true)
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it('preserves multi-requester joined ambiguity when two launches for different people finish in one pause and notification names only one (ce71a72b)', async () => {
    const {
      appendRequestEvent,
      readRequestState,
      setCurrentRequest,
      turnAmbiguity,
      UNSTATED,
    } = await import('./requests.mjs')
    const {
      recordOwnedEnd,
      recordOwnedLaunch,
      recordTurnWake,
      restoreHeldParentIfResumed,
    } = await import('./mirror-turn.mjs')

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-two-people-ended-'))
    try {
      const connId = '972c8895-0000-4000-8000-000000000111'
      const reqAlice = '972c8895-0000-4000-8000-000000000112'
      const reqBob = '972c8895-0000-4000-8000-000000000113'
      const noticeId = '972c8895-0000-4000-8000-000000000114'
      const taskAlice = 'conv-two/task-alice'
      const taskBob = 'conv-two/task-bob'
      const t0 = Date.now() - 10_000

      appendRequestEvent(connId, { op: 'open', id: reqAlice, kind: 'command', requested_by: 'alice' }, { dir: tmpDir })
      appendRequestEvent(connId, { op: 'open', id: reqBob, kind: 'command', requested_by: 'bob' }, { dir: tmpDir })
      setCurrentRequest(connId, reqAlice, { dir: tmpDir })
      appendRequestEvent(connId, { op: 'launch', key: taskAlice, kind: 'shell', notifies: true, request: reqAlice, also: [] }, { dir: tmpDir })
      appendRequestEvent(connId, { op: 'launch', key: taskBob, kind: 'shell', notifies: true, request: reqBob, also: [] }, { dir: tmpDir })

      writeTurnMarker(connId, { startedAt: t0, remoteTurn: true, otherWake: true, held: true }, tmpDir)
      recordOwnedLaunch(connId, { id: taskAlice, kind: 'command', label: 'Alice task' }, { dir: tmpDir, now: t0 + 100 })
      recordOwnedLaunch(connId, { id: taskBob, kind: 'command', label: 'Bob task' }, { dir: tmpDir, now: t0 + 200 })

      recordTurnWake(
        connId,
        {
          type: 'canonical_system_notices',
          execute_notice_ids: [noticeId],
          ingress: { system_notices: [{ notice_id: noticeId, audience: 'for_the_record' }] },
        },
        tmpDir,
        t0 + 1000,
      )
      setCurrentRequest(connId, UNSTATED, { dir: tmpDir })

      // Both Alice's and Bob's launches finish in the same pause; notification text names ONLY Bob's launch!
      recordOwnedEnd(connId, taskAlice, { dir: tmpDir, now: t0 + 1800 })
      recordOwnedEnd(connId, taskBob, { dir: tmpDir, now: t0 + 2000 })
      const res = restoreHeldParentIfResumed(connId, readTurnMarker(connId, tmpDir), {
        dir: tmpDir,
        latestStep: {
          type: 'SYSTEM_MESSAGE',
          created_at: new Date(t0 + 2000).toISOString(),
          content: `[Message] sender=${taskBob} content=Task id "${taskBob}" finished with result:\nDone`,
        },
        now: t0 + 2500,
      })
      assert.equal(res.restored, true)
      const state = readRequestState(connId, { dir: tmpDir })
      assert.equal(state.current, reqBob)
      assert.equal(state.joined.has(reqAlice), true)
      // Multi-requester turn MUST preserve turnAmbiguity so PreToolUse prompts to choose whose request a write serves!
      const ambiguity = turnAmbiguity(state)
      assert.ok(Array.isArray(ambiguity) && ambiguity.length === 2)
      assert.deepEqual(new Set(ambiguity.map((e) => e.id)), new Set([reqAlice, reqBob]))
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('does not treat a reply to notice 1 as covering a later needs_person notice 2 in the same pause (02f4ce2b)', async () => {
    const { appendRequestEvent, setCurrentRequest, UNSTATED } = await import('./requests.mjs')
    const {
      currentTurnReplyNoticeIds,
      recordNoticeReply,
      recordOwnedEnd,
      recordOwnedLaunch,
      recordTurnWake,
      restoreHeldParentIfResumed,
    } = await import('./mirror-turn.mjs')

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-second-notice-'))
    try {
      const connId = '972c8895-0000-4000-8000-000000000121'
      const reqId = '972c8895-0000-4000-8000-000000000122'
      const notice1 = '972c8895-0000-4000-8000-000000000123'
      const notice2 = '972c8895-0000-4000-8000-000000000124'
      const taskId = 'conv-second-notice/task-1'
      const t0 = Date.now() - 10_000

      appendRequestEvent(connId, { op: 'open', id: reqId, kind: 'command' }, { dir: tmpDir })
      setCurrentRequest(connId, reqId, { dir: tmpDir })
      appendRequestEvent(connId, { op: 'launch', key: taskId, kind: 'shell', notifies: true, request: reqId, also: [] }, { dir: tmpDir })
      writeTurnMarker(connId, { startedAt: t0, remoteTurn: true, otherWake: true, held: true }, tmpDir)
      recordOwnedLaunch(connId, { id: taskId, kind: 'command', label: 'Build' }, { dir: tmpDir, now: t0 + 100 })

      // Notice 1 arrives and is replied to.
      recordTurnWake(
        connId,
        {
          type: 'canonical_system_notices',
          execute_notice_ids: [notice1],
          ingress: { system_notices: [{ notice_id: notice1, audience: 'needs_person' }] },
        },
        tmpDir,
        t0 + 1000,
      )
      setCurrentRequest(connId, UNSTATED, { dir: tmpDir })
      recordNoticeReply(connId, tmpDir, t0 + 1500, { noticeIds: [notice1] })

      // Notice 2 arrives in the same pause; parent task ends — MUST NOT restore until notice 2 is answered!
      recordTurnWake(
        connId,
        {
          type: 'canonical_system_notices',
          execute_notice_ids: [notice2],
          ingress: { system_notices: [{ notice_id: notice2, audience: 'needs_person' }] },
        },
        tmpDir,
        t0 + 2000,
      )
      recordOwnedEnd(connId, taskId, { dir: tmpDir, now: t0 + 2500 })

      const beforeSecondReply = restoreHeldParentIfResumed(connId, readTurnMarker(connId, tmpDir), {
        dir: tmpDir,
        now: t0 + 3000,
      })
      assert.equal(beforeSecondReply.restored, false)
      assert.deepEqual(currentTurnReplyNoticeIds(connId, { dir: tmpDir }), [notice1, notice2])

      // Once notice 2 is also replied to, restoration succeeds!
      recordNoticeReply(connId, tmpDir, t0 + 3500, { noticeIds: [notice2] })
      const afterSecondReply = restoreHeldParentIfResumed(connId, readTurnMarker(connId, tmpDir), {
        dir: tmpDir,
        now: t0 + 4000,
      })
      assert.equal(afterSecondReply.restored, true)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('merges a second check job arriving while Stop holds a parked pause for a helper instead of replacing checkJobIds (a2d9f38f)', async () => {
    const { appendRequestEvent, setCurrentRequest, UNSTATED } = await import('./requests.mjs')
    const {
      recordCheckJobRuled,
      recordOwnedEnd,
      recordOwnedLaunch,
      recordTurnWake,
      restoreHeldParentIfResumed,
    } = await import('./mirror-turn.mjs')

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-held-second-check-'))
    try {
      const connId = '972c8895-0000-4000-8000-000000000131'
      const reqId = '972c8895-0000-4000-8000-000000000132'
      const job1 = '972c8895-0000-4000-8000-000000000133'
      const job2 = '972c8895-0000-4000-8000-000000000134'
      const parentTaskId = 'conv-second-check/task-1'
      const helperId = 'subagent-helper-1'
      const t0 = Date.now() - 10_000

      appendRequestEvent(connId, { op: 'open', id: reqId, kind: 'command' }, { dir: tmpDir })
      setCurrentRequest(connId, reqId, { dir: tmpDir })
      appendRequestEvent(connId, { op: 'launch', key: parentTaskId, kind: 'shell', notifies: true, request: reqId, also: [] }, { dir: tmpDir })
      writeTurnMarker(connId, { startedAt: t0, remoteTurn: true, otherWake: true, held: true }, tmpDir)
      recordOwnedLaunch(connId, { id: parentTaskId, kind: 'command', label: 'Build' }, { dir: tmpDir, now: t0 + 100 })

      // Check 1 arrives, spawns helper, and Stop sets held: true while preserving heldParent.
      recordTurnWake(connId, { type: 'check_job', check_job_id: job1 }, tmpDir, t0 + 1000)
      setCurrentRequest(connId, UNSTATED, { dir: tmpDir })
      recordOwnedLaunch(connId, { id: helperId, kind: 'subagent', label: 'Helper' }, { dir: tmpDir, now: t0 + 1200 })
      writeTurnMarker(connId, { held: true, preserveExplicitReply: true }, tmpDir)

      // Check 2 wakes the agent while held: true — MUST merge into [job1, job2]!
      recordTurnWake(connId, { type: 'check_job', check_job_id: job2 }, tmpDir, t0 + 2000)
      assert.deepEqual(readTurnMarker(connId, tmpDir)?.checkJobIds, [job1, job2])

      recordOwnedEnd(connId, parentTaskId, { dir: tmpDir, now: t0 + 2500 })
      recordOwnedEnd(connId, helperId, { dir: tmpDir, now: t0 + 2800 })

      // Settling ONLY job2 MUST NOT restore while job1 is still unresolved!
      recordCheckJobRuled(connId, tmpDir, { jobId: job2, now: t0 + 3000 })
      const afterOnlyJob2 = restoreHeldParentIfResumed(connId, readTurnMarker(connId, tmpDir), {
        dir: tmpDir,
        now: t0 + 3100,
      })
      assert.equal(afterOnlyJob2.restored, false)

      // Once job1 also settles, restoration succeeds!
      recordCheckJobRuled(connId, tmpDir, { jobId: job1, now: t0 + 3500 })
      const afterBoth = restoreHeldParentIfResumed(connId, readTurnMarker(connId, tmpDir), {
        dir: tmpDir,
        now: t0 + 3600,
      })
      assert.equal(afterBoth.restored, true)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('restores the known requester when a single completion notification names both full and short task IDs (ce71a72b)', async () => {
    const {
      appendRequestEvent,
      readRequestState,
      requestRefForWrite,
      setCurrentRequest,
      UNSTATED,
    } = await import('./requests.mjs')
    const {
      recordOwnedEnd,
      recordOwnedLaunch,
      recordTurnWake,
      restoreHeldParentIfResumed,
    } = await import('./mirror-turn.mjs')

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-short-alias-'))
    try {
      const connId = '972c8895-0000-4000-8000-000000000141'
      const reqId = '972c8895-0000-4000-8000-000000000142'
      const noticeId = '972c8895-0000-4000-8000-000000000143'
      const convUuid = '972c8895-0000-4000-8000-000000000144'
      const fullTaskId = `${convUuid}/task-415`
      const t0 = Date.now() - 10_000

      appendRequestEvent(connId, { op: 'open', id: reqId, kind: 'command' }, { dir: tmpDir })
      setCurrentRequest(connId, reqId, { dir: tmpDir })
      appendRequestEvent(connId, { op: 'launch', key: fullTaskId, kind: 'shell', notifies: true, request: reqId, also: [] }, { dir: tmpDir })
      writeTurnMarker(connId, { startedAt: t0, remoteTurn: true, otherWake: true, held: true }, tmpDir)
      recordOwnedLaunch(connId, { id: fullTaskId, kind: 'command', label: 'Build' }, { dir: tmpDir, now: t0 + 100 })

      recordTurnWake(
        connId,
        {
          type: 'canonical_system_notices',
          execute_notice_ids: [noticeId],
          ingress: { system_notices: [{ notice_id: noticeId, audience: 'for_the_record' }] },
        },
        tmpDir,
        t0 + 1000,
      )
      setCurrentRequest(connId, UNSTATED, { dir: tmpDir })
      recordOwnedEnd(connId, fullTaskId, { dir: tmpDir, now: t0 + 2000 })

      // Notification mentions the log path (which produces BOTH `${convUuid}/task-415` AND short alias `task-415`)!
      const res = restoreHeldParentIfResumed(connId, readTurnMarker(connId, tmpDir), {
        dir: tmpDir,
        latestStep: {
          type: 'SYSTEM_MESSAGE',
          created_at: new Date(t0 + 2000).toISOString(),
          content: `[Message] Background command "task-415" completed. Output saved to /tmp/brain/${convUuid}/.system_generated/tasks/task-415.log`,
        },
        now: t0 + 2500,
      })
      assert.equal(res.restored, true)
      assert.equal(requestRefForWrite(readRequestState(connId, { dir: tmpDir })), reqId)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

