#!/usr/bin/env node
/**
 * FIFO queueing of check jobs and system notices behind active turns, silent check-job
 * follow-up turns, and mid-turn `<conversationId>/task-<n>` completion reconciliation
 * (DevSpec item d36ac887); commands past held records on the fallback wait path, held
 * records that survive a restart or a hand-off, and one per turn after a stale turn
 * marker (item b68df72d).
 */

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import {
  buildWakeDeliveryMessage,
  createListenerQueueState,
  processListenerInboxTick,
  restoreListenerQueueState,
} from './devspec-remote-listen.mjs'
import {
  appendCanonicalInbox,
  dispatchesStartTurn,
  scanPersistedInboxRecords,
} from './devspec-remote-poll.mjs'
import { prepareDevspecToolInput } from './devspec-tool-input.mjs'
import {
  clearTurnMarker,
  handleMirrorTurn,
  inferTurnContextFromTranscript,
  isCurrentTurnCheckJobOnly,
  isForegroundTurnRunning,
  isTurnMarkerActive,
  launchedAntigravityBackgroundWork,
  readOwnedIds,
  readTurnMarker,
  recordOwnedLaunch,
  recordTurnWake,
  streamTurnTrailIfChanged,
  writeTurnMarker,
} from './mirror-turn.mjs'
import { runPostToolDispatch } from './post-tool-dispatch.mjs'
import { readStateFile, writeLocalBond, writeStateFile } from './remote-control-state.mjs'
import {
  FIXTURE_ID,
  fixtureControl,
  fixtureEnvelope,
} from './remote-ingress-test-fixtures.mjs'
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
const SECOND_CHECK_JOB_ID = '13131313-1313-4313-8313-131313131313'
const WAIT_SCRIPT = fileURLToPath(new URL('./devspec-remote-wait.mjs', import.meta.url))

function makeCheckJobRecord(id = CHECK_JOB_ID, connectionId = CONN_ID) {
  return {
    type: 'check_job',
    connection_id: connectionId,
    session_id: SESS_ID,
    dispatch: {
      id,
      kind: 'check_job',
      check_job_id: id,
      check_kind: 'conflict',
      record: { type: 'task', id: RECORD_ID, title: 'Queue checks behind active turns' },
      entries: 2,
      yours: true,
      offered_at: '2026-11-04T18:00:00.000Z',
      delivery_connection_id: connectionId,
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

function makeFixture(connectionId = CONN_ID) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-fifo-queue-'))
  const rcDir = path.join(home, '.devspec', 'remote-control')
  const connDir = path.join(rcDir, 'connections')
  fs.mkdirSync(connDir, { recursive: true })
  const transcriptPath = path.join(home, 'transcript.jsonl')
  const inboxPath = path.join(connDir, `${connectionId}.inbox.jsonl`)
  const live = {
    connection_id: connectionId,
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
  writeLocalBond(CONV_ID, { connection_id: connectionId }, rcDir)
  return {
    connectionId,
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
      const queueState = createListenerQueueState(0)
      const checkBytes = Buffer.byteLength(checkLine, 'utf8')
      const noticeBytes = Buffer.byteLength(noticeLine, 'utf8')
      const heldBoth = [
        { start: 0, end: checkBytes },
        { start: checkBytes, end: checkBytes + noticeBytes },
      ]

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
            fx.live.inbox_held_records = next.inbox_held_records
          },
          writeStdout: () => {},
          env: {},
        })

      // 1. Active turn running: check_job + system_notice are both held, nothing delivered,
      // active turn marker (`otherWake: true`) and `current: REQ_ID` stay intact. The
      // cursor moves past them and their byte ranges are persisted beside it.
      const firstTick = await tick()
      assert.equal(deliveredMessages.length, 0)
      assert.equal(firstTick.heldCount, 2)
      assert.equal(fx.live.inbox_byte_offset, checkBytes + noticeBytes)
      assert.deepEqual(fx.live.inbox_held_records, heldBoth)
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
      assert.equal(
        fx.live.inbox_byte_offset,
        checkBytes + noticeBytes + Buffer.byteLength(commandLine, 'utf8'),
        'the cursor moves past the delivered command, so a restart never replays it',
      )
      assert.deepEqual(fx.live.inbox_held_records, heldBoth, 'the held records are persisted beside it')
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
      assert.deepEqual(fx.live.inbox_held_records, [heldBoth[1]])
      assert.equal(isCurrentTurnCheckJobOnly(CONN_ID, { dir: fx.connDir }), true)
      assert.equal(readRequestState(CONN_ID, { dir: fx.connDir }).current, null)
      assert.equal(
        mcpCalls.filter((c) => c.name === 'report_pickup').length,
        1,
        'check_job delivery immediately reports pickup so the UI shows Working right away',
      )

      // 4. Check-job turn finishes -> next tick drains the queued system_notice with full identity intact!
      clearTurnMarker(CONN_ID, fx.connDir)
      mcpCalls.length = 0
      const fourthTick = await tick()
      assert.equal(deliveredMessages.length, 3)
      assert.match(deliveredMessages[2], new RegExp(`system_notice_ids: \\["${NOTICE_ID}"\\]`))
      assert.equal(fourthTick.heldCount, 0)
      assert.deepEqual(fx.live.inbox_held_records, [])
      assert.equal(fx.live.inbox_byte_offset, Buffer.byteLength(checkLine + noticeLine + commandLine, 'utf8'))
      assert.deepEqual(readTurnMarker(CONN_ID, fx.connDir).noticeIds, [NOTICE_ID])
      assert.equal(readRequestState(CONN_ID, { dir: fx.connDir }).current, null)
      assert.equal(
        mcpCalls.filter((c) => c.name === 'report_pickup').length,
        1,
        'system_notice delivery immediately reports pickup so the UI shows Working right away',
      )
    } finally {
      fx.cleanup()
    }
  })

  it('skips a held check-job wake that was already settled on the server and advances to the next held wake without waking the agent', async () => {
    const fx = makeFixture()
    try {
      recordTurnWake(CONN_ID, { type: 'canonical_commands', execute_message_ids: [CMD_MSG_ID] }, fx.connDir)
      const settledCheckLine = `${JSON.stringify(makeCheckJobRecord(CHECK_JOB_ID))}\n`
      const openCheckLine = `${JSON.stringify(makeCheckJobRecord(SECOND_CHECK_JOB_ID))}\n`
      fs.writeFileSync(fx.inboxPath, settledCheckLine + openCheckLine)

      const deliveredMessages = []
      const mcpCalls = []
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
            if (req.name === 'get_connection_dispatch') {
              if (req.arguments?.dispatch_id === CHECK_JOB_ID) {
                return { connection_id: CONN_ID, dispatches: [], count: 0 }
              }
              return {
                connection_id: CONN_ID,
                dispatches: [{ id: req.arguments?.dispatch_id, kind: 'check_job' }],
                count: 1,
              }
            }
            return { ok: true }
          },
          writeState: (_id, next) => {
            fx.live.inbox_byte_offset = next.inbox_byte_offset
            fx.live.inbox_held_records = next.inbox_held_records
          },
          writeStdout: () => {},
          env: {},
        })

      // First tick while turn is active holds both check jobs.
      const firstTick = await tick()
      assert.equal(firstTick.heldCount, 2)
      assert.equal(deliveredMessages.length, 0)

      // Active turn ends: next tick checks CHECK_JOB_ID via get_connection_dispatch, sees dispatches: [],
      // drops it without waking the agent, and immediately delivers SECOND_CHECK_JOB_ID!
      clearTurnMarker(CONN_ID, fx.connDir)
      const secondTick = await tick()
      assert.equal(secondTick.heldCount, 0)
      assert.equal(deliveredMessages.length, 1)
      assert.doesNotMatch(deliveredMessages[0], new RegExp(CHECK_JOB_ID))
      assert.match(deliveredMessages[0], new RegExp(SECOND_CHECK_JOB_ID))
      assert.deepEqual(
        mcpCalls.filter((c) => c.name === 'get_connection_dispatch').map((c) => c.arguments.dispatch_id),
        [CHECK_JOB_ID, SECOND_CHECK_JOB_ID],
      )
      assert.deepEqual(fx.live.inbox_held_records, [])
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
            tool_calls: [{ name: 'default_api:call_mcp_tool', args: { ServerName: 'devspec', ToolName: 'claim_check_job' } }],
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

// ---------------------------------------------------------------------------------
// Item b68df72d: commands past held records on the fallback wait path, held records
// that survive a restart or a hand-off, and one per turn after a stale turn marker.
// ---------------------------------------------------------------------------------

/** A turn marker no reader counts as a running turn: no sign of life past 60 minutes. */
function writeStaleTurnMarker(connectionId, dir) {
  const longAgo = Date.now() - 61 * 60 * 1000
  fs.writeFileSync(
    path.join(dir, `${connectionId}.turn`),
    JSON.stringify({ startedAt: longAgo, lastToolAt: longAgo, remoteTurn: true, otherWake: true }),
  )
}

/** One inbox line exactly as the poller writes it (appendCanonicalInbox). */
function canonicalLine(connectionId, envelope, channel) {
  let line = null
  const result = appendCanonicalInbox(connectionId, envelope, scanPersistedInboxRecords(''), {
    channel,
    writeRecord: (_id, record) => {
      line = `${JSON.stringify(record)}\n`
      return true
    },
  })
  assert.equal(result.appended, true, `fixture ${channel} record was not written`)
  return line
}

const W_CONN = FIXTURE_ID.connection

function waitCommandLine(body = 'Please pause and check staging first.') {
  return canonicalLine(
    W_CONN,
    fixtureEnvelope({ body, envelopeId: '22222222-2222-4222-8222-000000000001' }),
    'command',
  )
}

function waitControlLine() {
  return canonicalLine(
    W_CONN,
    fixtureEnvelope({
      wakeKind: 'control',
      control: fixtureControl('compact'),
      envelopeId: '22222222-2222-4222-8222-000000000002',
    }),
    'control',
  )
}

function waitNoticeLine() {
  return canonicalLine(
    W_CONN,
    {
      kind: 'devspec.remote_ingress',
      schema_version: 1,
      contract_version: '1.6.0',
      policy_version: '2026-09-24.1',
      envelope_id: '22222222-2222-4222-8222-000000000003',
      connection: { connection_id: W_CONN, agent_name: 'Antigravity', codename: 'Calm Fox', label: 'Antigravity / Calm Fox' },
      wake: { kind: 'system_notice', active: true, reason_id: 'exact_connection_system_notice' },
      delivery_state: 'live',
      command_message_ids: [],
      commands: [],
      system_notices: [
        {
          version: 1,
          kind: 'server_notice',
          notice_id: NOTICE_ID,
          topic: 'coherence_finding',
          notice_type: 'reversal',
          summary: 'Protected decision reversed by new record',
          prompt: 'Review the protected record.',
          contract_uri: 'devspec://product/remote-ingress-contract',
          records: [
            {
              label: 'Protected record',
              record_type: 'memory',
              record_id: '81000000-0000-4000-8000-000000000001',
              title: 'All deliveries use canonical ingress',
              text: 'All remote deliveries use the canonical ingress envelope.',
              url: null,
            },
          ],
          allowed_outcomes: ['keep_protected', 'propose_override', 'retract_new_record'],
          allowed_tools: ['retract_memory', 'supersede_memory', 'manage_protected_intent'],
        },
      ],
      room_context: { version: 1, messages: [], coverage: null },
      control: null,
      context: { human_context: [], agent_context: [], ai_context: [], system_context: [] },
      window: {
        policy_version: '2026-09-24.1',
        returned: 0,
        total_known: 0,
        source_window: { start: null, end: null },
        truncated: false,
        has_more: false,
        next_cursor: null,
        fetch_id: null,
        omission_reason: null,
      },
    },
    'system_notice',
  )
}

const waitCheckLine = (id = CHECK_JOB_ID) => `${JSON.stringify(makeCheckJobRecord(id, W_CONN))}\n`

function parseEventLines(text) {
  const events = []
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      /* not an event line */
    }
  }
  return events
}

const checkJobIds = (events) => events.filter((e) => e.type === 'check_job').map((e) => e.check_job_id)
const noticeIds = (events) => events.filter((e) => e.type === 'system_notice').map((e) => e.notice_id)
const ownerMessages = (events) => events.filter((e) => e.type === 'owner_message')

/** Arm the fallback wait the way the connect script prints it on re-arm: one-shot `--pending`. */
function runWaitOnce(fx, { timeoutMs = 15_000 } = {}) {
  const res = spawnSync(
    process.execPath,
    [WAIT_SCRIPT, '--connection-id', fx.connectionId, '--pending', '--poll-ms', '5'],
    { env: { ...process.env, HOME: fx.home, USERPROFILE: fx.home }, encoding: 'utf8', timeout: timeoutMs },
  )
  return { status: res.status, signal: res.signal, stderr: res.stderr, events: parseEventLines(res.stdout) }
}

function startWaitStream(fx) {
  const child = spawn(
    process.execPath,
    [WAIT_SCRIPT, '--connection-id', fx.connectionId, '--stream', '--pending', '--poll-ms', '5'],
    { env: { ...process.env, HOME: fx.home, USERPROFILE: fx.home }, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const events = []
  let pending = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    pending += chunk
    for (let nl = pending.indexOf('\n'); nl !== -1; nl = pending.indexOf('\n')) {
      events.push(...parseEventLines(pending.slice(0, nl)))
      pending = pending.slice(nl + 1)
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  const until = async (predicate, label, timeoutMs = 10_000) => {
    const startedAt = Date.now()
    while (!predicate()) {
      if (child.exitCode !== null) throw new Error(`wait stream exited (${child.exitCode}) before ${label}: ${stderr}`)
      if (Date.now() - startedAt > timeoutMs) throw new Error(`timed out waiting for ${label}: ${stderr}`)
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  const stop = () =>
    new Promise((resolve) => {
      if (child.exitCode !== null) return resolve()
      child.once('exit', resolve)
      child.kill('SIGTERM')
    })
  return { events, until, stop }
}

/** Listener deliveries the way main() makes them: state re-read from disk every tick. */
function listenerTicker(fx, { deliveredMessages, queueState }) {
  return (state = queueState) =>
    processListenerInboxTick(state, {
      connectionId: fx.connectionId,
      conversationId: CONV_ID,
      inboxPath: fx.inboxPath,
      live: readStateFile(fx.connectionId, fx.connDir),
      useAgentApi: true,
      connectionsDir: fx.connDir,
      deliver: async ({ message }) => {
        deliveredMessages.push(message)
        return { ok: true }
      },
      callMcp: async () => ({ ok: true }),
      writeStdout: () => {},
      env: {},
    })
}

describe('the fallback wait path (devspec-remote-wait.mjs) delivers past held work', () => {
  it('wakes at once for a command and a control behind held check jobs and notices, then releases the held ones one per turn in arrival order across re-arms', () => {
    const fx = makeFixture(W_CONN)
    try {
      // A command turn is running.
      writeTurnMarker(W_CONN, { remoteTurn: true, otherWake: true }, fx.connDir)
      const checkLine = waitCheckLine()
      const noticeLine = waitNoticeLine()
      const controlLine = waitControlLine()
      const commandLine = waitCommandLine()
      fs.writeFileSync(fx.inboxPath, checkLine + noticeLine + controlLine + commandLine)
      const c = Buffer.byteLength(checkLine)
      const n = Buffer.byteLength(noticeLine)
      const end = fs.statSync(fx.inboxPath).size

      // The arm wakes on the control and the command; the check job and notice wait.
      const first = runWaitOnce(fx)
      assert.equal(first.status, 0, first.stderr)
      assert.match(first.stderr, /wake \(2 msg\)/, 'the control and the command both woke it')
      assert.equal(ownerMessages(first.events).length, 1)
      assert.match(ownerMessages(first.events)[0].body, /Please pause and check staging first\./)
      assert.deepEqual(checkJobIds(first.events), [])
      assert.deepEqual(noticeIds(first.events), [])
      let state = readStateFile(W_CONN, fx.connDir)
      assert.equal(state.inbox_byte_offset, end, 'the cursor is past everything it delivered')
      assert.deepEqual(state.inbox_held_records, [
        { start: 0, end: c },
        { start: c, end: c + n },
      ])

      // Re-armed while that turn still runs: nothing is replayed and nothing released.
      const still = runWaitOnce(fx, { timeoutMs: 1_000 })
      assert.notEqual(still.status, 0, 'no wake while the turn runs')
      assert.deepEqual(still.events, [], 'the delivered command is not replayed')

      // The turn ends: the next arm brings the check job alone, and starts its turn.
      clearTurnMarker(W_CONN, fx.connDir)
      const second = runWaitOnce(fx)
      assert.equal(second.status, 0, second.stderr)
      assert.deepEqual(checkJobIds(second.events), [CHECK_JOB_ID])
      assert.deepEqual(noticeIds(second.events), [], 'the notice waits for the check job turn')
      assert.equal(ownerMessages(second.events).length, 0)
      state = readStateFile(W_CONN, fx.connDir)
      assert.deepEqual(state.inbox_held_records, [{ start: c, end: c + n }])
      assert.equal(readTurnMarker(W_CONN, fx.connDir).checkJobWake, true)

      // That turn ends: the notice comes next, and nothing is left owed.
      clearTurnMarker(W_CONN, fx.connDir)
      const third = runWaitOnce(fx)
      assert.equal(third.status, 0, third.stderr)
      assert.deepEqual(noticeIds(third.events), [NOTICE_ID])
      assert.deepEqual(checkJobIds(third.events), [])
      assert.deepEqual(readStateFile(W_CONN, fx.connDir).inbox_held_records, [])
    } finally {
      fx.cleanup()
    }
  })

  it('in --stream mode keeps delivering commands past a held check job and releases held work one turn at a time', async () => {
    const fx = makeFixture(W_CONN)
    const stream = startWaitStream(fx)
    try {
      writeTurnMarker(W_CONN, { remoteTurn: true, otherWake: true }, fx.connDir)
      fs.writeFileSync(fx.inboxPath, waitCheckLine())
      const stateHeld = () => readStateFile(W_CONN, fx.connDir)?.inbox_held_records ?? []
      await stream.until(() => stateHeld().length === 1, 'the check job to be held')

      fs.appendFileSync(fx.inboxPath, waitCommandLine())
      await stream.until(() => ownerMessages(stream.events).length === 1, 'the command')
      assert.deepEqual(checkJobIds(stream.events), [], 'the check job still waits for the turn')

      clearTurnMarker(W_CONN, fx.connDir)
      await stream.until(() => checkJobIds(stream.events).length === 1, 'the check job after the turn ends')

      // The check job's own turn is running now, so a notice arriving waits for it.
      fs.appendFileSync(fx.inboxPath, waitNoticeLine())
      await stream.until(() => stateHeld().length === 1, 'the notice to be held')
      assert.deepEqual(noticeIds(stream.events), [])

      clearTurnMarker(W_CONN, fx.connDir)
      await stream.until(() => noticeIds(stream.events).length === 1, 'the notice after the check job turn')
      const order = stream.events
        .filter((e) => ['owner_message', 'check_job', 'system_notice'].includes(e.type))
        .map((e) => e.type)
      assert.deepEqual(order, ['owner_message', 'check_job', 'system_notice'])
    } finally {
      await stream.stop()
      fx.cleanup()
    }
  })

  it('releases one held check job per turn after a stale turn marker, never a burst', () => {
    const fx = makeFixture(W_CONN)
    try {
      writeStaleTurnMarker(W_CONN, fx.connDir)
      const first = waitCheckLine(CHECK_JOB_ID)
      fs.writeFileSync(fx.inboxPath, first + waitCheckLine(SECOND_CHECK_JOB_ID))
      const c = Buffer.byteLength(first)

      const wake = runWaitOnce(fx)
      assert.equal(wake.status, 0, wake.stderr)
      assert.deepEqual(checkJobIds(wake.events), [CHECK_JOB_ID])
      assert.deepEqual(readStateFile(W_CONN, fx.connDir).inbox_held_records, [
        { start: c, end: fs.statSync(fx.inboxPath).size },
      ])

      clearTurnMarker(W_CONN, fx.connDir)
      const next = runWaitOnce(fx)
      assert.equal(next.status, 0, next.stderr)
      assert.deepEqual(checkJobIds(next.events), [SECOND_CHECK_JOB_ID])
    } finally {
      fx.cleanup()
    }
  })
})

describe('held records survive a listener restart and a hand-off to the wait script', () => {
  it('a restarted listener neither replays the command delivered past a held check job nor loses the check job', async () => {
    const fx = makeFixture()
    try {
      recordTurnWake(CONN_ID, { type: 'canonical_commands', execute_message_ids: [CMD_MSG_ID] }, fx.connDir)
      fs.writeFileSync(fx.inboxPath, `${JSON.stringify(makeCheckJobRecord())}\n`)
      const deliveredMessages = []
      const tick = listenerTicker(fx, { deliveredMessages, queueState: createListenerQueueState(0) })

      await tick()
      fs.appendFileSync(fx.inboxPath, `${JSON.stringify(makeCommandRecord())}\n`)
      await tick()
      assert.equal(deliveredMessages.length, 1)
      assert.match(deliveredMessages[0], /Please pause and check staging first\./)

      // Restart: a new listener builds its queue from the state file alone.
      const restarted = restoreListenerQueueState(readStateFile(CONN_ID, fx.connDir), {
        inboxPath: fx.inboxPath,
        connectionId: CONN_ID,
      })
      assert.equal(restarted.heldRecords.length, 1)
      assert.equal(restarted.scanOffset, fs.statSync(fx.inboxPath).size)

      await tick(restarted)
      assert.equal(deliveredMessages.length, 1, 'the delivered command is not replayed')

      clearTurnMarker(CONN_ID, fx.connDir)
      await tick(restarted)
      assert.equal(deliveredMessages.length, 2)
      assert.match(deliveredMessages[1], /take it with claim_check_job/)
      clearTurnMarker(CONN_ID, fx.connDir)
      await tick(restarted)
      assert.equal(deliveredMessages.length, 2, 'the check job is delivered exactly once')
      assert.deepEqual(readStateFile(CONN_ID, fx.connDir).inbox_held_records, [])
    } finally {
      fx.cleanup()
    }
  })

  it('the wait script armed with --pending after the listener delivers the held check job and does not replay the command', async () => {
    const fx = makeFixture(W_CONN)
    try {
      writeTurnMarker(W_CONN, { remoteTurn: true, otherWake: true }, fx.connDir)
      fs.writeFileSync(fx.inboxPath, waitCheckLine())
      const deliveredMessages = []
      const tick = listenerTicker(fx, { deliveredMessages, queueState: createListenerQueueState(0) })
      await tick()
      fs.appendFileSync(fx.inboxPath, waitCommandLine())
      await tick()
      assert.equal(deliveredMessages.length, 1, 'the listener delivered the command')

      clearTurnMarker(W_CONN, fx.connDir)
      const wake = runWaitOnce(fx)
      assert.equal(wake.status, 0, wake.stderr)
      assert.deepEqual(checkJobIds(wake.events), [CHECK_JOB_ID])
      assert.equal(ownerMessages(wake.events).length, 0, 'the command is not replayed')
      assert.deepEqual(readStateFile(W_CONN, fx.connDir).inbox_held_records, [])
    } finally {
      fx.cleanup()
    }
  })

  it('a listener resuming after the wait script released its held check job does not deliver it again', async () => {
    const fx = makeFixture(W_CONN)
    try {
      writeTurnMarker(W_CONN, { remoteTurn: true, otherWake: true }, fx.connDir)
      fs.writeFileSync(fx.inboxPath, waitCheckLine())
      const deliveredMessages = []
      const queueState = createListenerQueueState(0)
      const tick = listenerTicker(fx, { deliveredMessages, queueState })
      await tick()
      assert.equal(queueState.heldRecords.length, 1)

      // The listener stands aside while the wait script is armed; that script delivers it.
      clearTurnMarker(W_CONN, fx.connDir)
      const wake = runWaitOnce(fx)
      assert.deepEqual(checkJobIds(wake.events), [CHECK_JOB_ID])

      clearTurnMarker(W_CONN, fx.connDir)
      await tick()
      assert.equal(deliveredMessages.length, 0, 'already delivered by the wait script')
      assert.equal(queueState.heldRecords.length, 0)
    } finally {
      fx.cleanup()
    }
  })

  it('drops persisted held ranges that no longer point at one queued record before the cursor', () => {
    const fx = makeFixture()
    try {
      const checkLine = `${JSON.stringify(makeCheckJobRecord())}\n`
      const commandLine = `${JSON.stringify(makeCommandRecord())}\n`
      fs.writeFileSync(fx.inboxPath, checkLine + commandLine)
      const c = Buffer.byteLength(checkLine)
      const end = fs.statSync(fx.inboxPath).size
      const restored = restoreListenerQueueState(
        {
          inbox_byte_offset: end,
          inbox_held_records: [
            { start: 0, end: c },
            { start: c, end }, // a command, never queued work
            { start: 1, end: c }, // part of a line
            { start: 0, end: c }, // the same record twice
          ],
        },
        { inboxPath: fx.inboxPath, connectionId: CONN_ID },
      )
      assert.deepEqual(
        restored.heldRecords.map((rec) => [rec.startOffset, rec.endOffset, rec.entry.type]),
        [[0, c, 'check_job']],
      )
      const pastCursor = restoreListenerQueueState(
        { inbox_byte_offset: 0, inbox_held_records: [{ start: 0, end: c }] },
        { inboxPath: fx.inboxPath, connectionId: CONN_ID },
      )
      assert.deepEqual(pastCursor.heldRecords, [], 'a range past the cursor was never held')
    } finally {
      fx.cleanup()
    }
  })
})

describe('a stale turn marker on the main listener', () => {
  it('releases held check jobs one per turn rather than all at once', async () => {
    const fx = makeFixture()
    try {
      writeStaleTurnMarker(CONN_ID, fx.connDir)
      fs.writeFileSync(
        fx.inboxPath,
        `${JSON.stringify(makeCheckJobRecord(CHECK_JOB_ID))}\n${JSON.stringify(makeCheckJobRecord(SECOND_CHECK_JOB_ID))}\n`,
      )
      const deliveredMessages = []
      const tick = listenerTicker(fx, { deliveredMessages, queueState: createListenerQueueState(0) })

      const first = await tick()
      assert.equal(deliveredMessages.length, 1)
      assert.match(deliveredMessages[0], new RegExp(CHECK_JOB_ID))
      assert.equal(first.heldCount, 1)
      // The delivered check job started a fresh turn, not the dead one's continuation.
      const marker = readTurnMarker(CONN_ID, fx.connDir)
      assert.equal(marker.checkJobWake, true)
      assert.equal(marker.otherWake, undefined)

      await tick()
      assert.equal(deliveredMessages.length, 1, 'the second waits for the first one’s turn')

      clearTurnMarker(CONN_ID, fx.connDir)
      await tick()
      assert.equal(deliveredMessages.length, 2)
      assert.match(deliveredMessages[1], new RegExp(SECOND_CHECK_JOB_ID))
    } finally {
      fx.cleanup()
    }
  })
})

describe('the poller asserting a turn ahead of the armed wait script', () => {
  it('does so for an automation run but never for a check job, which may have to wait', () => {
    assert.equal(dispatchesStartTurn({ automation_run: 1, check_job: 0 }), true)
    assert.equal(dispatchesStartTurn({ automation_run: 1, check_job: 1 }), true)
    assert.equal(dispatchesStartTurn({ automation_run: 0, check_job: 1 }), false)
  })
})

describe('held background & one-shot timer waits across >10m pauses and mid-wait check jobs (item 70981c12)', () => {
  it('tracks one-shot schedule timers (not recurring crons), clears on timer wakeup or manage_task kill, and keeps held turns + owned work active past hours', async () => {
    const fx = makeFixture()
    try {
      const timerId = `${CONV_ID}/task-1113`
      const cronId = `${CONV_ID}/task-1114`

      // One-shot schedule timer is tracked as owned work + notifying request launch
      const oneShot = launchedAntigravityBackgroundWork(
        'default_api:schedule',
        { DurationSeconds: '420', Prompt: 'Check benchmark progress', TimerCondition: 'never' },
        { output: `Tool is running as a background task with task id: ${timerId}\nTask Description: Timer: 7m, Prompt: Check benchmark progress` },
      )
      assert.deepEqual(oneShot, {
        id: timerId,
        kind: 'timer',
        label: 'Check benchmark progress',
      })
      const oneShotReq = launchForRequest(
        'default_api:schedule',
        { DurationSeconds: '420', Prompt: 'Check benchmark progress', TimerCondition: 'never' },
        { output: `Tool is running as a background task with task id: ${timerId}` },
      )
      assert.equal(oneShotReq?.key, timerId)
      assert.equal(oneShotReq?.kind, 'timer')
      assert.equal(oneShotReq?.notifies, true)

      // Recurring cron schedule does NOT hold the turn open
      assert.equal(
        launchedAntigravityBackgroundWork(
          'default_api:schedule',
          { CronExpression: '*/5 * * * *', Prompt: 'Poll status' },
          { output: `Tool is running as a background task with task id: ${cronId}\nTask Description: Cron: */5 * * * *` },
        ),
        null,
      )
      const cronReq = launchForRequest(
        'default_api:schedule',
        { CronExpression: '*/5 * * * *', Prompt: 'Poll status' },
        { taskId: cronId },
      )
      assert.equal(cronReq?.schedule, true)

      // A held turn and its owned timer/task remain active 3 hours later with no clock cutoff
      const t0 = Date.now() - 3 * 60 * 60 * 1000
      writeTurnMarker(CONN_ID, { startedAt: t0, remoteTurn: true, otherWake: true, held: true }, fx.connDir)
      recordOwnedLaunch(CONN_ID, { id: timerId, kind: 'timer', label: 'Check benchmark progress' }, { dir: fx.connDir, now: t0 })
      appendRequestEvent(
        CONN_ID,
        { op: 'open', id: REQ_ID, kind: 'command', message_id: CMD_MSG_ID, provenance_ref: PROV_ID, requested_by: USER_ID },
        { dir: fx.connDir },
      )
      appendRequestEvent(CONN_ID, { op: 'current', ref: REQ_ID }, { dir: fx.connDir })
      appendRequestEvent(
        CONN_ID,
        { op: 'launch', key: timerId, kind: 'timer', notifies: true, request: REQ_ID, also: [] },
        { dir: fx.connDir },
      )

      const now = Date.now()
      assert.equal(isTurnMarkerActive(readTurnMarker(CONN_ID, fx.connDir), now), true)
      assert.equal(isForegroundTurnRunning(readTurnMarker(CONN_ID, fx.connDir), now), false)
      assert.deepEqual(readOwnedIds(CONN_ID, readTurnMarker(CONN_ID, fx.connDir), fx.connDir, { now }), [timerId])

      // Cancelling the timer via manage_task kill clears both owned work and pending request hold
      await runPostToolDispatch(
        JSON.stringify({
          conversationId: CONV_ID,
          tool_name: 'default_api:manage_task',
          tool_input: { Action: 'kill', TaskId: timerId },
          tool_response: { output: 'Killed task' },
        }),
        { home: fx.home, env: {}, call: async () => ({ ok: true }) },
      )
      assert.deepEqual(readOwnedIds(CONN_ID, readTurnMarker(CONN_ID, fx.connDir), fx.connDir, { now }), [])
      assert.equal(requestsWithWorkPending(readRequestState(CONN_ID, { dir: fx.connDir })).has(REQ_ID), false)
    } finally {
      fx.cleanup()
    }
  })

  it('delivers and completes a check job during a >10m held wait without resetting the parent turn, calling report_complete, or suppressing the subsequent background/timer wake', async () => {
    const fx = makeFixture()
    try {
      const benchTaskId = `${CONV_ID}/task-900`
      const timerId = `${CONV_ID}/task-1113`
      const t0 = Date.now() - 25 * 60 * 1000 // 25 minutes ago!

      // Parent remote command turn launched a long benchmark + wait timer and parked on Stop (held: true)
      writeTurnMarker(
        CONN_ID,
        { startedAt: t0, remoteTurn: true, otherWake: true, held: true },
        fx.connDir,
      )
      recordOwnedLaunch(CONN_ID, { id: benchTaskId, kind: 'command', label: 'Stage 2 benchmark' }, { dir: fx.connDir, now: t0 })
      recordOwnedLaunch(CONN_ID, { id: timerId, kind: 'timer', label: 'Wait 7m' }, { dir: fx.connDir, now: t0 + 1000 })
      appendRequestEvent(
        CONN_ID,
        { op: 'open', id: REQ_ID, kind: 'command', message_id: CMD_MSG_ID, provenance_ref: PROV_ID, requested_by: USER_ID },
        { dir: fx.connDir },
      )
      appendRequestEvent(CONN_ID, { op: 'current', ref: REQ_ID }, { dir: fx.connDir })
      appendRequestEvent(
        CONN_ID,
        { op: 'launch', key: benchTaskId, kind: 'shell', notifies: true, request: REQ_ID, also: [] },
        { dir: fx.connDir },
      )
      appendRequestEvent(
        CONN_ID,
        { op: 'launch', key: timerId, kind: 'timer', notifies: true, request: REQ_ID, also: [] },
        { dir: fx.connDir },
      )

      // Two check jobs arrive 25 minutes into the background wait
      fs.writeFileSync(
        fx.inboxPath,
        `${JSON.stringify(makeCheckJobRecord(CHECK_JOB_ID))}\n${JSON.stringify(makeCheckJobRecord(SECOND_CHECK_JOB_ID))}\n`,
      )
      const deliveredMessages = []
      const tick = listenerTicker(fx, { deliveredMessages, queueState: createListenerQueueState(0) })

      // First check job delivers immediately during the held wait; second check job stays queued!
      const firstTick = await tick()
      assert.equal(deliveredMessages.length, 1)
      assert.match(deliveredMessages[0], new RegExp(CHECK_JOB_ID))
      assert.equal(firstTick.heldCount, 1, 'second check job waits behind the running first check job')

      const duringCheckMarker = readTurnMarker(CONN_ID, fx.connDir)
      assert.equal(duringCheckMarker.startedAt, t0, 'parent startedAt must NOT be reset')
      assert.equal(duringCheckMarker.held, false, 'foreground check turn is now running')
      assert.equal(duringCheckMarker.checkJobWake, true)
      assert.equal(duringCheckMarker.otherWake, false)
      assert.equal(duringCheckMarker.heldParent?.otherWake, true)
      assert.deepEqual(
        readOwnedIds(CONN_ID, duringCheckMarker, fx.connDir),
        [benchTaskId, timerId],
        'owned background work from parent turn remains intact',
      )
      assert.equal(
        isCurrentTurnCheckJobOnly(CONN_ID, { dir: fx.connDir, connectionState: fx.live }),
        true,
        'foreground check sub-turn is recognized as check-job-only so it does not pollute room trail',
      )

      // Transcript gets the check_job SYSTEM_MESSAGE and check ruling steps
      const checkWakeMsg = deliveredMessages[0]
      fs.writeFileSync(
        fx.transcriptPath,
        [
          JSON.stringify({
            step_index: 1,
            type: 'USER_INPUT',
            created_at: new Date(t0).toISOString(),
            content: `[DevSpec Remote Wake]\n${JSON.stringify({ type: 'owner_message', message_id: CMD_MSG_ID })}`,
          }),
          JSON.stringify({
            step_index: 2,
            type: 'SYSTEM_MESSAGE',
            created_at: new Date(Date.now() - 2000).toISOString(),
            content: `<SYSTEM_MESSAGE>\n${checkWakeMsg}\n</SYSTEM_MESSAGE>`,
          }),
          JSON.stringify({
            step_index: 3,
            type: 'PLANNER_RESPONSE',
            created_at: new Date(Date.now() - 1000).toISOString(),
            content: '',
            tool_calls: [{ name: 'call_mcp_tool', args: { ServerName: 'devspec_devspec', ToolName: 'record_check_rulings', Arguments: {} } }],
          }),
        ].join('\n') + '\n',
      )

      const mcpCalls = []
      const hookOpts = {
        env: {},
        connectionsDir: fx.connDir,
        legacyPath: path.join(fx.home, 'legacy.json'),
        call: async (req) => {
          mcpCalls.push(req)
          if (req.name === 'report_request' && req.arguments.action === 'close') {
            return { status: 'closed' }
          }
          return { ok: true }
        },
      }
      const hookInput = JSON.stringify({ conversationId: CONV_ID, transcriptPath: fx.transcriptPath })

      // Check-job turn stops: parent owned tasks are STILL running!
      const stopAfterCheck = await handleMirrorTurn('stop', hookInput, hookOpts)
      assert.equal(stopAfterCheck.held, true)
      assert.deepEqual(stopAfterCheck.outstanding, [benchTaskId, timerId])
      assert.equal(
        mcpCalls.some((c) => c.name === 'report_complete'),
        false,
        'must NOT call report_complete while parent background work is still running',
      )
      assert.equal(
        mcpCalls.some((c) => c.name === 'heartbeat_connection' && c.arguments?.busy === false),
        false,
        'must NOT mark connection busy:false while parent background work is still running',
      )

      const restoredHeldMarker = readTurnMarker(CONN_ID, fx.connDir)
      assert.equal(restoredHeldMarker.startedAt, t0)
      assert.equal(restoredHeldMarker.held, true)
      assert.equal(restoredHeldMarker.heldParent, null)
      assert.equal(restoredHeldMarker.otherWake, true)
      assert.equal(restoredHeldMarker.checkJobWake, false, 'checkJobWake must be cleared on return to held state')
      assert.equal(isTurnMarkerActive(restoredHeldMarker), true)

      // Now the 7m timer fires while benchTaskId is still running!
      const timerWakeStep = {
        step_index: 4,
        type: 'SYSTEM_MESSAGE',
        created_at: new Date().toISOString(),
        content: `<SYSTEM_MESSAGE>\n[Message] timestamp=${new Date().toISOString()} sender=${timerId} priority=MESSAGE_PRIORITY_HIGH content=Check benchmark progress\n</SYSTEM_MESSAGE>`,
      }
      fs.appendFileSync(fx.transcriptPath, `${JSON.stringify(timerWakeStep)}\n`)

      // Even if .turn were missing, inferTurnContextFromTranscript skips the intermediate check_job step!
      const inferred = inferTurnContextFromTranscript(fx.transcriptPath)
      assert.equal(inferred.backgroundContinuation, true)
      assert.equal(inferred.remoteTurn, true)
      assert.equal(inferred.otherWake, true)
      assert.equal(Boolean(inferred.checkJobWake), false, 'timer continuation must NOT inherit checkJobWake')

      // PreInvocation runs for the timer wakeup
      await handleMirrorTurn('user_prompt', hookInput, hookOpts)
      const afterTimerWakeMarker = readTurnMarker(CONN_ID, fx.connDir)
      assert.equal(afterTimerWakeMarker.held, false)
      assert.equal(afterTimerWakeMarker.backgroundContinuation, true)
      assert.equal(afterTimerWakeMarker.otherWake, true)
      assert.equal(Boolean(afterTimerWakeMarker.checkJobWake), false)
      assert.equal(
        isCurrentTurnCheckJobOnly(CONN_ID, { dir: fx.connDir, connectionState: fx.live }),
        false,
        'timer continuation turn is NOT check-job-only and streams progress normally',
      )
      assert.equal(
        readRequestState(CONN_ID, { dir: fx.connDir }).current,
        REQ_ID,
        'timer wake restores REQ_ID as current request',
      )
      assert.deepEqual(
        readOwnedIds(CONN_ID, afterTimerWakeMarker, fx.connDir),
        [benchTaskId],
        'timer cleared, benchmark command still owned',
      )

      // Timer turn stops while benchmark is still running -> stays held and keeps REQ_ID open!
      const stopAfterTimer = await handleMirrorTurn('stop', hookInput, hookOpts)
      assert.equal(stopAfterTimer.held, true)
      assert.deepEqual(stopAfterTimer.outstanding, [benchTaskId])
      assert.equal(readRequestState(CONN_ID, { dir: fx.connDir }).open.has(REQ_ID), true)

      // Finally benchmark finishes -> wakes, answers, and Stop closes both the turn and REQ_ID!
      fs.appendFileSync(
        fx.transcriptPath,
        [
          JSON.stringify({
            step_index: 5,
            type: 'SYSTEM_MESSAGE',
            created_at: new Date(Date.now() + 1000).toISOString(),
            content: `<SYSTEM_MESSAGE>\n[Message] timestamp=${new Date().toISOString()} sender=${benchTaskId} priority=MESSAGE_PRIORITY_HIGH content=Task id "${benchTaskId}" finished with result: Command exited with code 0.\n</SYSTEM_MESSAGE>`,
          }),
          JSON.stringify({
            step_index: 6,
            type: 'PLANNER_RESPONSE',
            created_at: new Date(Date.now() + 2000).toISOString(),
            content: 'Benchmark completed cleanly.',
          }),
        ].join('\n') + '\n',
      )
      await handleMirrorTurn('user_prompt', hookInput, hookOpts)
      const finalStop = await handleMirrorTurn('stop', hookInput, hookOpts)
      assert.equal(finalStop.held, undefined)
      assert.equal(finalStop.busy, false)
      assert.equal(readTurnMarker(CONN_ID, fx.connDir), null)
      assert.equal(readRequestState(CONN_ID, { dir: fx.connDir }).open.size, 0)
      assert.equal(mcpCalls.some((c) => c.name === 'report_complete'), true)
    } finally {
      fx.cleanup()
    }
  })
})
