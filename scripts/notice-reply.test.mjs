#!/usr/bin/env node
/**
 * A reply to a DevSpec notice reaches the room as a notice reply, never as a late
 * answer to an earlier command (item fdc96b30; server item 8885423d).
 *
 * These run the real hooks over a real connection directory:
 * - the wake hands the model the exact ids and call;
 * - the listener, the wait script and PreInvocation record what woke the turn;
 * - PreToolUse stamps the turn's notices only when every wake of the turn was a
 *   notice, turns a string-shaped `system_notice_ids` into an array, and never
 *   gives a notice reply a trail or local-turn flags;
 * - a notice reply never counts as the reply to a command, so Stop still answers it;
 * - Stop ends a notice-only turn with a notice reply, and streams no trail during it.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { buildWakeDeliveryMessage } from './devspec-remote-listen.mjs'
import { buildCanonicalSystemNoticeEvents } from './devspec-remote-wait.mjs'
import { prepareDevspecToolInput } from './devspec-tool-input.mjs'
import {
  currentTurnNoticeIds,
  explicitReplyMarkerPath,
  handleMirrorTurn,
  readTurnMarker,
  recordTurnWake,
  streamTurnTrailIfChanged,
} from './mirror-turn.mjs'
import { normalizeNoticeIds } from './notice-reply.mjs'
import { runPostToolDispatch } from './post-tool-dispatch.mjs'
import { writeLocalBond, writeStateFile } from './remote-control-state.mjs'
import { appendRequestEvent } from './requests.mjs'

const CONN_ID = '11111111-2222-4333-8444-555555555555'
const PROJ_ID = '24c4abaa-2cb9-496a-8492-cf1f1aa1090b'
const SESS_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const CONV_ID = 'ca2d5a24-57ea-4252-90d0-82d4dd2504d1'
const NOTICE_A = 'f7d6a637-bb5a-4bcc-98ee-354e5f309a6b'
const NOTICE_B = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
const REQ = 'f1111111-1111-4111-8111-111111111111'
const PROV = 'c1111111-1111-4111-8111-111111111111'
const MSG = 'd1111111-1111-4111-8111-111111111111'
const USER = 'a1111111-1111-4111-8111-111111111111'

function serverNotice(noticeId, summary) {
  return {
    version: 1,
    kind: 'server_notice',
    notice_id: noticeId,
    topic: 'intent_ruling_outcome',
    notice_type: 'go_ahead',
    summary,
    prompt: 'Merge the work into the tracking branch, then tell the person it landed.',
    contract_uri: 'devspec://product/remote-ingress-contract',
    records: [],
    allowed_outcomes: ['merge_or_open_pr_to_tracking_branch', 'acknowledge_outcome'],
    allowed_tools: ['get_task', 'update_task'],
  }
}

function noticeEntry(...ids) {
  return {
    type: 'canonical_system_notices',
    connection_id: CONN_ID,
    session_id: SESS_ID,
    execute_notice_ids: ids,
    ingress: { envelope_id: '7b48f5da-53fb-4480-97da-6a95bb8d4131', system_notices: ids.map((id, i) => serverNotice(id, `Notice ${i + 1}`)) },
  }
}

const COMMAND_ENTRY = { type: 'canonical_commands', connection_id: CONN_ID, session_id: SESS_ID, execute_message_ids: [MSG] }

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-notice-reply-'))
  const rcDir = path.join(home, '.devspec', 'remote-control')
  const connDir = path.join(rcDir, 'connections')
  fs.mkdirSync(connDir, { recursive: true })
  const transcriptPath = path.join(home, 'transcript.jsonl')
  writeStateFile(
    {
      connection_id: CONN_ID,
      session_id: SESS_ID,
      project_id: PROJ_ID,
      local_id: CONV_ID,
      agent_name: 'Antigravity',
      enabled: true,
      token: 'dvs_test_tok',
      mcp_url: 'https://api.devspec.ai/api/mcp',
      transcript_path: transcriptPath,
    },
    connDir,
  )
  writeLocalBond(CONV_ID, { connection_id: CONN_ID }, rcDir)
  // One step of work since the turn began, so an ordinary answer would carry a trail.
  fs.writeFileSync(
    transcriptPath,
    `${JSON.stringify({
      step_index: 2,
      type: 'PLANNER_RESPONSE',
      created_at: new Date(Date.now() + 1000).toISOString(),
      tool_calls: [{ name: 'view_file', args: { AbsolutePath: '"/tmp/a.md"', toolAction: '"Reading a.md"' } }],
    })}\n`,
  )
  return {
    home,
    connDir,
    transcriptPath,
    cleanup: () => fs.rmSync(home, { recursive: true, force: true }),
  }
}

/** A command being worked: delivered, opened as a request and current. */
function openCommand(fx) {
  appendRequestEvent(CONN_ID, { op: 'open', id: REQ, kind: 'command', message_id: MSG, provenance_ref: PROV, requested_by: USER }, { dir: fx.connDir })
  appendRequestEvent(CONN_ID, { op: 'current', ref: REQ }, { dir: fx.connDir })
  recordTurnWake(CONN_ID, COMMAND_ENTRY, fx.connDir)
}

/** PreToolUse on a post the way Antigravity's model makes it: call_mcp_tool, Arguments as a JSON string. */
function prePost(fx, args) {
  const res = prepareDevspecToolInput(
    {
      conversationId: CONV_ID,
      transcriptPath: fx.transcriptPath,
      tool_name: 'call_mcp_tool',
      tool_input: { ServerName: '"devspec"', ToolName: '"post_session_message"', Arguments: JSON.stringify(args) },
    },
    { home: fx.home, env: {} },
  )
  return res.overwrite ? JSON.parse(res.overwrite.Arguments) : args
}

const TURN_ONLY = ['work_trail', 'trail_events', 'local_turn', 'command_turn_unbound', 'command_turn_id', 'reply_to_message_id']

describe('the wake hands the model the exact ids and the call', () => {
  it('names each notice id in the call under it, and all of them for a batch', () => {
    const single = buildWakeDeliveryMessage(noticeEntry(NOTICE_A), { connectionId: CONN_ID })
    assert.ok(single.includes(`post_session_message({ message, system_notice_ids: ["${NOTICE_A}"] })`))
    assert.match(single, /complete_turn has no effect on it/)
    assert.match(single, /attached to no room, tell the person here in the terminal/)
    assert.match(single, /semantics\.notice_reply in devspec:\/\/product\/remote-ingress-contract/)

    const batch = buildWakeDeliveryMessage(noticeEntry(NOTICE_A, NOTICE_B), { connectionId: CONN_ID })
    assert.ok(batch.includes(`system_notice_ids: ["${NOTICE_A}","${NOTICE_B}"]`))

    const [event] = buildCanonicalSystemNoticeEvents(noticeEntry(NOTICE_A), { inboxFile: 'inbox' })
    assert.ok(event.content.includes(`system_notice_ids: ["${NOTICE_A}"]`), 'the wait script delivers the same line')
  })
})

describe('a turn woken only by notices', () => {
  it('stamps the turn notices on a plain post, with no trail, no local-turn flags and no reply marker', () => {
    const fx = fixture()
    try {
      recordTurnWake(CONN_ID, noticeEntry(NOTICE_A), fx.connDir)
      const sent = prePost(fx, { message: 'The work landed on staging.', complete_turn: true })
      assert.deepEqual(sent.system_notice_ids, [NOTICE_A])
      assert.equal(sent.connection_id, CONN_ID)
      for (const key of TURN_ONLY) assert.equal(sent[key], undefined, `${key} must not ride on a notice reply`)
      assert.equal(fs.existsSync(explicitReplyMarkerPath(CONN_ID, fx.connDir)), false)
      assert.equal(typeof readTurnMarker(CONN_ID, fx.connDir).noticeReplyAt, 'number')
    } finally {
      fx.cleanup()
    }
  })

  it('leaves a post aimed at a room message alone', () => {
    const fx = fixture()
    try {
      recordTurnWake(CONN_ID, noticeEntry(NOTICE_A), fx.connDir)
      const sent = prePost(fx, { message: 'Answering you.', reply_to_message_id: MSG })
      assert.equal(sent.system_notice_ids, undefined)
    } finally {
      fx.cleanup()
    }
  })

  it('records the notices from the wake step itself at PreInvocation', async () => {
    const fx = fixture()
    try {
      const wake = buildWakeDeliveryMessage(noticeEntry(NOTICE_A), { connectionId: CONN_ID })
      fs.appendFileSync(
        fx.transcriptPath,
        `${JSON.stringify({ step_index: 3, type: 'SYSTEM_MESSAGE', created_at: new Date().toISOString(), content: `<SYSTEM_MESSAGE>\n${wake}\n</SYSTEM_MESSAGE>` })}\n`,
      )
      await handleMirrorTurn('user_prompt', JSON.stringify({ conversationId: CONV_ID, transcriptPath: fx.transcriptPath }), {
        env: {},
        connectionsDir: fx.connDir,
        legacyPath: path.join(fx.home, 'legacy.json'),
        call: async () => ({ ok: true }),
      })
      assert.deepEqual(currentTurnNoticeIds(CONN_ID, { dir: fx.connDir }), [NOTICE_A])
    } finally {
      fx.cleanup()
    }
  })

  it('streams no trail, which the server would file under the previous command', async () => {
    const fx = fixture()
    try {
      recordTurnWake(CONN_ID, noticeEntry(NOTICE_A), fx.connDir)
      const calls = []
      const state = JSON.parse(fs.readFileSync(path.join(fx.connDir, `${CONN_ID}.json`), 'utf8'))
      const res = await streamTurnTrailIfChanged(state, { connectionsDir: fx.connDir, home: fx.home, call: async (c) => calls.push(c) })
      assert.equal(res.reason, 'notice_turn')
      assert.equal(calls.length, 0)
    } finally {
      fx.cleanup()
    }
  })

  it('ends with a notice reply at Stop when the model posted nothing, and with nothing when it replied', async () => {
    const fx = fixture()
    try {
      const stop = async () => {
        const calls = []
        await handleMirrorTurn('stop', JSON.stringify({ conversationId: CONV_ID, transcriptPath: fx.transcriptPath }), {
          env: {},
          connectionsDir: fx.connDir,
          legacyPath: path.join(fx.home, 'legacy.json'),
          call: async (c) => {
            calls.push(c)
            return { ok: true }
          },
        })
        return calls.filter((c) => c.name === 'post_session_message')
      }
      fs.appendFileSync(
        fx.transcriptPath,
        `${JSON.stringify({ step_index: 4, type: 'PLANNER_RESPONSE', created_at: new Date(Date.now() + 2000).toISOString(), content: 'Merged; the work is on staging.' })}\n`,
      )
      recordTurnWake(CONN_ID, noticeEntry(NOTICE_A, NOTICE_B), fx.connDir)
      const [post] = await stop()
      assert.ok(post, 'Stop posts the final words')
      assert.deepEqual(post.arguments.system_notice_ids, [NOTICE_A, NOTICE_B])
      assert.equal(post.arguments.message, 'Merged; the work is on staging.')
      for (const key of [...TURN_ONLY, 'complete_turn', 'session_id']) assert.equal(post.arguments[key], undefined, key)

      recordTurnWake(CONN_ID, noticeEntry(NOTICE_A), fx.connDir)
      prePost(fx, { message: 'Merged.' })
      assert.deepEqual(await stop(), [], 'no second post after the model replied to the notice')
    } finally {
      fx.cleanup()
    }
  })
})

describe('a notice that arrives while a command is being worked', () => {
  it('stamps nothing on the command answer, and the model passes the ids for a separate reply', () => {
    const fx = fixture()
    try {
      openCommand(fx)
      recordTurnWake(CONN_ID, noticeEntry(NOTICE_A), fx.connDir)
      assert.equal(currentTurnNoticeIds(CONN_ID, { dir: fx.connDir }), null)

      const answer = prePost(fx, { message: 'Done with your request.', complete_turn: true })
      assert.equal(answer.system_notice_ids, undefined, 'the command answer is never stamped')
      assert.ok(answer.work_trail, 'the command answer keeps its trail')

      // A host whose cached schema predates system_notice_ids sent the array as a string.
      const reply = prePost(fx, { message: 'Heads up: a finding on your work.', system_notice_ids: `["${NOTICE_A}"]` })
      assert.deepEqual(reply.system_notice_ids, [NOTICE_A])
      for (const key of TURN_ONLY) assert.equal(reply[key], undefined, key)
    } finally {
      fx.cleanup()
    }
  })

  it('still answers the command at Stop after the model only replied to the notice', async () => {
    const fx = fixture()
    try {
      openCommand(fx)
      recordTurnWake(CONN_ID, noticeEntry(NOTICE_A), fx.connDir)
      const reply = { ServerName: '"devspec"', ToolName: '"post_session_message"', Arguments: JSON.stringify({ message: 'A finding.', system_notice_ids: [NOTICE_A] }) }
      prePost(fx, JSON.parse(reply.Arguments))
      await runPostToolDispatch(
        JSON.stringify({ conversationId: CONV_ID, tool_name: 'call_mcp_tool', tool_input: reply, tool_response: {} }),
        { env: {}, home: fx.home, call: async () => ({ ok: true }) },
      )
      assert.equal(fs.existsSync(explicitReplyMarkerPath(CONN_ID, fx.connDir)), false, 'a notice reply is not the turn reply')

      fs.appendFileSync(
        fx.transcriptPath,
        `${JSON.stringify({ step_index: 5, type: 'PLANNER_RESPONSE', created_at: new Date(Date.now() + 3000).toISOString(), content: 'Your request is done.' })}\n`,
      )
      const calls = []
      await handleMirrorTurn('stop', JSON.stringify({ conversationId: CONV_ID, transcriptPath: fx.transcriptPath }), {
        env: {},
        connectionsDir: fx.connDir,
        legacyPath: path.join(fx.home, 'legacy.json'),
        call: async (c) => {
          calls.push(c)
          return { ok: true }
        },
      })
      const post = calls.find((c) => c.name === 'post_session_message')
      assert.ok(post, 'the command still gets its answer')
      assert.equal(post.arguments.complete_turn, true)
      assert.equal(post.arguments.system_notice_ids, undefined)
    } finally {
      fx.cleanup()
    }
  })

  it('a prompt typed at the terminal is never a notice-only turn, and a notice reply in it carries no local-turn flags', async () => {
    const fx = fixture()
    try {
      fs.appendFileSync(
        fx.transcriptPath,
        `${JSON.stringify({ step_index: 3, type: 'USER_INPUT', created_at: new Date().toISOString(), content: 'Tidy the README please' })}\n`,
      )
      await handleMirrorTurn('user_prompt', JSON.stringify({ conversationId: CONV_ID, transcriptPath: fx.transcriptPath }), {
        env: {},
        connectionsDir: fx.connDir,
        legacyPath: path.join(fx.home, 'legacy.json'),
        call: async () => ({ ok: true }),
      })
      recordTurnWake(CONN_ID, noticeEntry(NOTICE_A), fx.connDir)
      assert.equal(currentTurnNoticeIds(CONN_ID, { dir: fx.connDir }), null)
      assert.equal(prePost(fx, { message: 'README tidied.' }).local_turn, true, 'the typed turn answer keeps its flags')
      const reply = prePost(fx, { message: 'About that notice.', system_notice_ids: [NOTICE_A] })
      for (const key of TURN_ONLY) assert.equal(reply[key], undefined, key)
    } finally {
      fx.cleanup()
    }
  })
})

describe('normalizeNoticeIds changes shape only', () => {
  it('reads the string forms a stale host schema produces and leaves anything else for the server to refuse', () => {
    assert.deepEqual(normalizeNoticeIds(`["${NOTICE_A}","${NOTICE_B}"]`), [NOTICE_A, NOTICE_B])
    assert.deepEqual(normalizeNoticeIds(NOTICE_A), [NOTICE_A])
    assert.deepEqual(normalizeNoticeIds(`${NOTICE_A}, ${NOTICE_B}`), [NOTICE_A, NOTICE_B])
    assert.equal(normalizeNoticeIds('the last one'), 'the last one')
    assert.deepEqual(normalizeNoticeIds([NOTICE_A]), [NOTICE_A])
    assert.equal(normalizeNoticeIds(7), 7)
  })
})
