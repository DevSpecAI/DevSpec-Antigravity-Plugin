#!/usr/bin/env node
/**
 * FIFO queueing of check jobs and system notices behind active turns, silent check-job
 * follow-up turns, and mid-turn `<conversationId>/task-<n>` completion reconciliation
 * (DevSpec item d36ac887).
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import {
  buildWakeDeliveryMessage,
  createListenerQueueState,
  processListenerInboxTick,
} from './devspec-remote-listen.mjs'
import { prepareDevspecToolInput } from './devspec-tool-input.mjs'
import {
  clearTurnMarker,
  handleMirrorTurn,
  isCurrentTurnCheckJobOnly,
  launchedAntigravityBackgroundWork,
  readOwnedIds,
  readTurnMarker,
  recordOwnedLaunch,
  recordTurnWake,
  streamTurnTrailIfChanged,
  writeTurnMarker,
} from './mirror-turn.mjs'
import { writeLocalBond, writeStateFile } from './remote-control-state.mjs'
import {
  appendRequestEvent,
  launchForRequest,
  notifiedKeys,
  readRequestState,
  requestsWithWorkPending,
} from './requests.mjs'

const CONN_ID = '11111111-2222-4333-8444-555555555555'
const PROJ_ID = '24c4abaa-2cb9-496a-8492-cf1f1aa1090b'
const SESS_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const CONV_ID = 'd4407e18-72e0-40c5-81e7-a52859d2811d'
const CHECK_JOB_ID = '12121212-1212-4212-8212-121212121212'
const RECORD_ID = '34343434-3434-4434-8434-343434343434'
const NOTICE_ID = 'f7d6a637-bb5a-4bcc-98ee-354e5f309a6b'
const CMD_MSG_ID = 'd1111111-1111-4111-8111-111111111111'
const URGENT_MSG_ID = 'd2222222-2222-4222-8222-222222222222'
const REQ_ID = 'f1111111-1111-4111-8111-111111111111'
const URGENT_REQ_ID = 'f2222222-2222-4222-8222-222222222222'
const PROV_ID = 'c1111111-1111-4111-8111-111111111111'
const USER_ID = 'a1111111-1111-4111-8111-111111111111'

function makeCheckJobRecord(id = CHECK_JOB_ID) {
  return {
    type: 'check_job',
    connection_id: CONN_ID,
    session_id: SESS_ID,
    dispatch: {
      id,
      kind: 'check_job',
      check_job_id: id,
      check_kind: 'conflict',
      record: { type: 'task', id: RECORD_ID, title: 'Queue checks behind active turns' },
      entries: 2,
      high_risk: 1,
      yours: true,
      offered_at: '2026-11-04T18:00:00.000Z',
      delivery_connection_id: CONN_ID,
    },
  }
}

function makeNoticeRecord(noticeId = NOTICE_ID) {
  return {
    type: 'canonical_system_notices',
    connection_id: CONN_ID,
    session_id: SESS_ID,
    execute_notice_ids: [noticeId],
    ingress: {
      envelope_id: '7b48f5da-53fb-4480-97da-6a95bb8d4131',
      system_notices: [
        {
          version: 1,
          kind: 'server_notice',
          notice_id: noticeId,
          topic: 'intent_ruling_outcome',
          notice_type: 'go_ahead',
          summary: 'Your held work now has the OK to merge.',
          prompt: 'Merge the branch and let the person know.',
          contract_uri: 'devspec://product/remote-ingress-contract',
          records: [],
          allowed_outcomes: ['merge_or_open_pr_to_tracking_branch'],
          allowed_tools: ['get_task', 'update_task'],
        },
      ],
    },
  }
}

function makeCommandRecord(messageId = URGENT_MSG_ID) {
  return {
    type: 'canonical_commands',
    connection_id: CONN_ID,
    session_id: SESS_ID,
    execute_message_ids: [messageId],
    ingress: {
      envelope_id: '88888888-8888-4888-8888-888888888888',
      command_message_ids: [messageId],
      commands: [
        {
          message_id: messageId,
          requester: { display_name: 'Ali Price' },
          authority: { kind: 'owner' },
          content: { body: 'Please pause and check staging first.' },
        },
      ],
    },
  }
}

function makeFixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-fifo-queue-'))
  const rcDir = path.join(home, '.devspec', 'remote-control')
  const connDir = path.join(rcDir, 'connections')
  fs.mkdirSync(connDir, { recursive: true })
  const transcriptPath = path.join(home, 'transcript.jsonl')
  const inboxPath = path.join(connDir, `${CONN_ID}.inbox.jsonl`)
  const live = {
    connection_id: CONN_ID,
    session_id: SESS_ID,
    project_id: PROJ_ID,
    local_id: CONV_ID,
    agent_name: 'Antigravity',
    enabled: true,
    token: 'dvs_test_tok',
    mcp_url: 'https://fixture.invalid/api/mcp',
    connection_capability: 'cap_v1',
    transcript_path: transcriptPath,
    inbox_byte_offset: 0,
  }
  writeStateFile(live, connDir)
  writeLocalBond(CONV_ID, { connection_id: CONN_ID }, rcDir)
  return {
    home,
    connDir,
    transcriptPath,
    inboxPath,
    live,
    cleanup: () => fs.rmSync(home, { recursive: true, force: true }),
  }
}

describe('active-turn FIFO queueing in devspec-remote-listen.mjs', () => {
  it('holds check jobs and system notices behind an active turn without clobbering active turn tracking, lets urgent commands pass through, and drains held wakes one turn at a time in arrival order', async () => {
    const fx = makeFixture()
    try {
      // Open an active command turn with request REQ_ID.
      appendRequestEvent(
        CONN_ID,
        { op: 'open', id: REQ_ID, kind: 'command', message_id: CMD_MSG_ID, provenance_ref: PROV_ID, requested_by: USER_ID },
        { dir: fx.connDir },
      )
      appendRequestEvent(
        CONN_ID,
        { op: 'open', id: URGENT_REQ_ID, kind: 'command', message_id: URGENT_MSG_ID, provenance_ref: PROV_ID, requested_by: USER_ID },
        { dir: fx.connDir },
      )
      appendRequestEvent(CONN_ID, { op: 'current', ref: REQ_ID }, { dir: fx.connDir })
      recordTurnWake(CONN_ID, { type: 'canonical_commands', execute_message_ids: [CMD_MSG_ID] }, fx.connDir)

      // Append a check_job first, then a system_notice while the command turn is active.
      const checkLine = `${JSON.stringify(makeCheckJobRecord())}\n`
      const noticeLine = `${JSON.stringify(makeNoticeRecord())}\n`
      fs.writeFileSync(fx.inboxPath, checkLine + noticeLine)

      const deliveredMessages = []
      const mcpCalls = []
      const persistedOffsets = []
      const queueState = createListenerQueueState(0)

      const tick = () =>
        processListenerInboxTick(queueState, {
          connectionId: CONN_ID,
          conversationId: CONV_ID,
          inboxPath: fx.inboxPath,
          live: fx.live,
          useAgentApi: true,
          once: false,
          connectionsDir: fx.connDir,
          deliver: async ({ message }) => {
            deliveredMessages.push(message)
            return { ok: true }
          },
          callMcp: async (req) => {
            mcpCalls.push(req)
            return { ok: true }
          },
          writeState: (_id, next) => {
            fx.live.inbox_byte_offset = next.inbox_byte_offset
            persistedOffsets.push(next.inbox_byte_offset)
          },
          writeStdout: () => {},
          env: {},
        })

      // 1. Active turn running: check_job + system_notice are both held, nothing delivered,
      // active turn marker (`otherWake: true`) and `current: REQ_ID` stay intact, and disk offset stays at 0.
      const firstTick = await tick()
      assert.equal(deliveredMessages.length, 0)
      assert.equal(firstTick.heldCount, 2)
      assert.equal(firstTick.committedOffset, 0)
      assert.equal(readTurnMarker(CONN_ID, fx.connDir).otherWake, true)
      assert.equal(readRequestState(CONN_ID, { dir: fx.connDir }).current, REQ_ID)
      assert.equal(mcpCalls.length, 0)

      // 2. Urgent canonical_commands arriving while check_job + notice are held passes right through!
      const commandLine = `${JSON.stringify(makeCommandRecord())}\n`
      fs.appendFileSync(fx.inboxPath, commandLine)
      const secondTick = await tick()
      assert.equal(deliveredMessages.length, 1)
      assert.match(deliveredMessages[0], /Please pause and check staging first\./)
      assert.equal(secondTick.heldCount, 2, 'check_job and notice remain held behind the active turn')
      assert.equal(secondTick.committedOffset, 0, 'disk offset stays before earliest held record for crash safety')
      assert.equal(mcpCalls.filter((c) => c.name === 'report_pickup').length, 1, 'commands report pickup')

      // 3. Active command turn finishes (Stop clears turn marker and closes finished requests).
      clearTurnMarker(CONN_ID, fx.connDir)
      appendRequestEvent(CONN_ID, { op: 'close', id: REQ_ID }, { dir: fx.connDir })
      appendRequestEvent(CONN_ID, { op: 'close', id: URGENT_REQ_ID }, { dir: fx.connDir })
      mcpCalls.length = 0

      // Next tick drains ONLY the first held item (check_job) so it gets its own clean turn!
      const thirdTick = await tick()
      assert.equal(deliveredMessages.length, 2)
      assert.match(deliveredMessages[1], /take it with claim_check_job/)
      assert.equal(thirdTick.heldCount, 1, 'system_notice waits for the check-job turn to finish')
      assert.equal(thirdTick.committedOffset, Buffer.byteLength(checkLine, 'utf8'))
      assert.equal(isCurrentTurnCheckJobOnly(CONN_ID, { dir: fx.connDir }), true)
      assert.equal(readRequestState(CONN_ID, { dir: fx.connDir }).current, null)
      assert.equal(mcpCalls.length, 0, 'check_job delivery never calls report_pickup')

      // 4. Check-job turn finishes -> next tick drains the queued system_notice with full identity intact!
      clearTurnMarker(CONN_ID, fx.connDir)
      const fourthTick = await tick()
      assert.equal(deliveredMessages.length, 3)
      assert.match(deliveredMessages[2], new RegExp(`system_notice_ids: \\["${NOTICE_ID}"\\]`))
      assert.equal(fourthTick.heldCount, 0)
      assert.equal(
        fourthTick.committedOffset,
        Buffer.byteLength(checkLine + noticeLine + commandLine, 'utf8'),
      )
      assert.deepEqual(readTurnMarker(CONN_ID, fx.connDir).noticeIds, [NOTICE_ID])
      assert.equal(readRequestState(CONN_ID, { dir: fx.connDir }).current, null)
      assert.equal(mcpCalls.length, 0, 'system_notice delivery never calls report_pickup')
    } finally {
      fx.cleanup()
    }
  })
})

describe('dedicated check-job follow-up turns in mirror-turn.mjs and devspec-tool-input.mjs', () => {
  it('runs check-job turns silently (no work trail, no Stop room fallback reply) and clears stale command provenance', async () => {
    const fx = makeFixture()
    try {
      // Leave an open earlier command in `.requests.jsonl` (simulating a still-open background request).
      appendRequestEvent(
        CONN_ID,
        { op: 'open', id: REQ_ID, kind: 'command', message_id: CMD_MSG_ID, provenance_ref: PROV_ID, requested_by: USER_ID },
        { dir: fx.connDir },
      )
      appendRequestEvent(CONN_ID, { op: 'current', ref: REQ_ID }, { dir: fx.connDir })

      // Deliver check_job wake into transcript as a fresh follow-up turn.
      const wakeMessage = buildWakeDeliveryMessage(makeCheckJobRecord(), { connectionId: CONN_ID })
      const startedAtIso = new Date().toISOString()
      fs.writeFileSync(
        fx.transcriptPath,
        [
          JSON.stringify({
            step_index: 10,
            type: 'USER_INPUT',
            created_at: startedAtIso,
            content: `<USER_REQUEST>\n${wakeMessage}\n</USER_REQUEST>`,
          }),
        ].join('\n') + '\n',
      )

      const calls = []
      const hookInput = JSON.stringify({ conversationId: CONV_ID, transcriptPath: fx.transcriptPath })
      const opts = {
        env: {},
        connectionsDir: fx.connDir,
        legacyPath: path.join(fx.home, 'legacy.json'),
        call: async (req) => {
          calls.push(req)
          return { ok: true }
        },
      }

      // 1. PreInvocation starts the check-job turn and resets current request to null.
      await handleMirrorTurn('user_prompt', hookInput, opts)
      assert.equal(isCurrentTurnCheckJobOnly(CONN_ID, { dir: fx.connDir }), true)
      assert.equal(readRequestState(CONN_ID, { dir: fx.connDir }).current, null)

      // 2. Judged DevSpec tool calls during the check-job turn do NOT inherit stale command attribution.
      const stamped = prepareDevspecToolInput(
        {
          conversationId: CONV_ID,
          transcriptPath: fx.transcriptPath,
          tool_name: 'call_mcp_tool',
          tool_input: {
            ServerName: '"devspec"',
            ToolName: '"record_duplicate_nonmatch"',
            Arguments: JSON.stringify({
              left: { type: 'task', id: RECORD_ID, version: 1 },
              right: { type: 'task', id: '56565656-5656-4656-8656-565656565656', version: 1 },
              ruling_id: CHECK_JOB_ID,
              note: 'Distinct scope.',
            }),
          },
        },
        { home: fx.home, env: {} },
      )
      const stampedArgs = stamped.overwrite ? JSON.parse(stamped.overwrite.Arguments) : {}
      assert.equal(stampedArgs.connection_id, CONN_ID)
      assert.equal(stampedArgs.request_ref, undefined, 'must not stamp prior command request_ref')
      assert.equal(stampedArgs.provenance_ref, undefined, 'must not stamp prior command provenance_ref')

      // 3. Tool activity + assistant reasoning in transcript streams NO room trail and posts NO Stop fallback reply.
      fs.appendFileSync(
        fx.transcriptPath,
        [
          JSON.stringify({
            step_index: 11,
            type: 'PLANNER_RESPONSE',
            created_at: new Date(Date.now() + 1000).toISOString(),
            thinking: 'Claiming and ruling the check job.',
            tool_calls: [{ name: 'call_mcp_tool', arguments: { ServerName: 'devspec', ToolName: 'claim_check_job' } }],
          }),
          JSON.stringify({
            step_index: 12,
            type: 'PLANNER_RESPONSE',
            created_at: new Date(Date.now() + 2000).toISOString(),
            content: 'Ruled both entries on the check job; carrying on.',
          }),
        ].join('\n') + '\n',
      )

      const trailRes = await streamTurnTrailIfChanged(fx.live, {
        connectionsDir: fx.connDir,
        home: fx.home,
        call: async (req) => {
          calls.push(req)
          return { ok: true }
        },
      })
      assert.equal(trailRes.streamed, false)
      assert.equal(trailRes.reason, 'check_job_turn')

      calls.length = 0
      const stopRes = await handleMirrorTurn('stop', hookInput, opts)
      assert.equal(stopRes.busy, false)
      assert.equal(
        calls.filter((c) => c.name === 'post_session_message').length,
        0,
        'check-job-only turn never posts a fallback room command reply',
      )
      assert.ok(
        calls.some((c) => c.name === 'heartbeat_connection' && c.arguments.busy === false),
        'marks connection not busy on Stop',
      )
    } finally {
      fx.cleanup()
    }
  })
})

describe('Antigravity <conversationId>/task-<n> background launch & mid-turn reconciliation', () => {
  it('captures slash-delimited Antigravity TaskIds and reconciles mid-turn SYSTEM_MESSAGE completions so Stop clears .turn and closes finished requests', async () => {
    const fx = makeFixture()
    try {
      const taskId = `${CONV_ID}/task-77`
      assert.deepEqual(
        notifiedKeys(`[Message] timestamp=2026-11-04T18:05:00Z sender=${taskId} priority=HIGH`),
        [taskId],
      )

      const bgOwned = launchedAntigravityBackgroundWork(
        'default_api:run_command',
        { CommandLine: 'npm test', WaitMsBeforeAsync: 500 },
        { output: `Tool is running as a background task with task id: ${taskId}` },
      )
      assert.equal(bgOwned?.id, taskId)

      const reqLaunch = launchForRequest(
        'default_api:run_command',
        { CommandLine: 'npm test', WaitMsBeforeAsync: 500 },
        { taskId },
      )
      assert.equal(reqLaunch?.key, taskId)

      // Open command turn and record background task launch against both .turn-owned.jsonl and .requests.jsonl.
      const startedAt = Date.now()
      writeTurnMarker(CONN_ID, { startedAt, remoteTurn: true, otherWake: true, held: false }, fx.connDir)
      recordOwnedLaunch(CONN_ID, { id: taskId, kind: 'command', label: 'npm test' }, { dir: fx.connDir, now: startedAt })
      appendRequestEvent(
        CONN_ID,
        { op: 'open', id: REQ_ID, kind: 'command', message_id: CMD_MSG_ID, provenance_ref: PROV_ID, requested_by: USER_ID },
        { dir: fx.connDir },
      )
      appendRequestEvent(CONN_ID, { op: 'current', ref: REQ_ID }, { dir: fx.connDir })
      appendRequestEvent(
        CONN_ID,
        { op: 'launch', key: taskId, kind: 'shell', notifies: true, request: REQ_ID, also: [] },
        { dir: fx.connDir },
      )

      assert.deepEqual(readOwnedIds(CONN_ID, readTurnMarker(CONN_ID, fx.connDir), fx.connDir), [taskId])
      assert.equal(requestsWithWorkPending(readRequestState(CONN_ID, { dir: fx.connDir })).has(REQ_ID), true)

      // Task finishes MID-TURN (while held === false) via Antigravity <SYSTEM_MESSAGE> before final Stop.
      fs.writeFileSync(
        fx.transcriptPath,
        [
          JSON.stringify({
            step_index: 1,
            type: 'SYSTEM_MESSAGE',
            created_at: new Date(startedAt + 500).toISOString(),
            content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-04T18:05:00Z sender=${taskId} priority=MESSAGE_PRIORITY_HIGH content=Task finished\n</SYSTEM_MESSAGE>`,
          }),
          JSON.stringify({
            step_index: 2,
            type: 'PLANNER_RESPONSE',
            created_at: new Date(startedAt + 1000).toISOString(),
            content: 'Tests passed and changes are ready.',
          }),
        ].join('\n') + '\n',
      )

      const calls = []
      const hookInput = JSON.stringify({ conversationId: CONV_ID, transcriptPath: fx.transcriptPath })
      const opts = {
        env: {},
        connectionsDir: fx.connDir,
        legacyPath: path.join(fx.home, 'legacy.json'),
        call: async (req) => {
          calls.push(req)
          if (req.name === 'report_request' && req.arguments.action === 'close') {
            return { status: 'closed' }
          }
          return { ok: true }
        },
      }

      // Mid-turn PreInvocation reconciles the completion even while held === false.
      const midPre = await handleMirrorTurn('user_prompt', hookInput, opts)
      assert.equal(midPre.skipped, 'mid_turn_pre_invocation')
      assert.deepEqual(readOwnedIds(CONN_ID, readTurnMarker(CONN_ID, fx.connDir), fx.connDir), [])
      assert.equal(requestsWithWorkPending(readRequestState(CONN_ID, { dir: fx.connDir })).has(REQ_ID), false)

      // Stop finishes the turn cleanly (does NOT hold .turn open) and closes REQ_ID!
      const stopRes = await handleMirrorTurn('stop', hookInput, opts)
      assert.equal(stopRes.held, undefined)
      assert.equal(stopRes.busy, false)
      assert.equal(readTurnMarker(CONN_ID, fx.connDir), null)
      assert.equal(readRequestState(CONN_ID, { dir: fx.connDir }).open.size, 0)
    } finally {
      fx.cleanup()
    }
  })
})
