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
  writeTurnMarker,
  readTurnMarker,
  extractAntigravityTrailFromTranscript,
  streamTurnTrailIfChanged,
} from './mirror-turn.mjs'

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
        CommandLine: 'node "/home/user/.gemini/config/plugins/antigravity-devspec-autopilot-extension/scripts/devspec-remote-wait.mjs" --connection-id "conn-1" --owner-pid "$PPID" --pending',
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
                    action_item_id: '4cbd20e0-1417-4c5f-9d99-28f5607bf296',
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
      assert.equal(domainEv.domain, 'action_item')
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
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

