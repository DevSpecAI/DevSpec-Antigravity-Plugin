#!/usr/bin/env node
/**
 * Unit tests for Item 2:
 * - Mechanical PreToolUse input stamping (`overwrite` for `connection_id`,
 *   `project_id`, `local_session_id`, `provenance_ref`, `request_ref`,
 *   `agent_name`, `plugin_version`)
 * - Multi-requester ambiguity denial (`decision: 'deny'`) on DevSpec writes
 *   and background launches (`run_command`, `invoke_subagent`, `schedule`)
 *   with instructions to run `devspec-serve-request.mjs`
 * - `devspec-serve-request.mjs` binding (`serveMain`)
 * - `room-unread.mjs` pre-post hold on `PreToolUse` and `injectSteps` awareness
 *   on `PreInvocation` / `PostInvocation`
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { prepareDevspecToolInput } from './devspec-tool-input.mjs'
import { serveMain } from './devspec-serve-request.mjs'
import { runPostInvocation } from './post-invocation.mjs'
import { runPreInvocation } from './pre-invocation.mjs'
import { writeLocalBond, writeStateFile } from './remote-control-state.mjs'
import { appendRequestEvent } from './requests.mjs'
import { readerOutput, transcriptPaths } from './room-unread.mjs'

const CONN_ID = '11111111-2222-4333-8444-555555555555'
const PROJ_ID = '24c4abaa-2cb9-496a-8492-cf1f1aa1090b'
const SESS_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const CONV_ID = 'ca2d5a24-57ea-4252-90d0-82d4dd2504d1'
const REQ_1 = 'f1111111-1111-4111-8111-111111111111'
const REQ_2 = 'f2222222-2222-4222-8222-222222222222'
const PROV_1 = 'c1111111-1111-4111-8111-111111111111'
const PROV_2 = 'c2222222-2222-4222-8222-222222222222'
const MSG_1 = 'd1111111-1111-4111-8111-111111111111'
const MSG_2 = 'd2222222-2222-4222-8222-222222222222'
const USER_1 = 'a1111111-1111-4111-8111-111111111111'
const USER_2 = 'b2222222-2222-4222-8222-222222222222'

function makeFixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-agy-item2-'))
  const rcDir = path.join(home, '.devspec', 'remote-control')
  const connDir = path.join(rcDir, 'connections')
  fs.mkdirSync(connDir, { recursive: true })
  writeStateFile(
    {
      connection_id: CONN_ID,
      session_id: SESS_ID,
      project_id: PROJ_ID,
      local_id: CONV_ID,
      agent_name: 'Antigravity',
      enabled: true,
    },
    connDir
  )
  writeLocalBond(CONV_ID, { connection_id: CONN_ID }, rcDir)
  return {
    home,
    rcDir,
    connDir,
    cleanup() {
      fs.rmSync(home, { recursive: true, force: true })
    },
  }
}

describe('PreToolUse mechanical input stamping (overwrite)', () => {
  it('stamps connection_id, project_id, local_session_id, request_ref, and provenance_ref when unambiguous', () => {
    const fx = makeFixture()
    try {
      appendRequestEvent(
        CONN_ID,
        {
          op: 'open',
          id: REQ_1,
          kind: 'command',
          message_id: MSG_1,
          provenance_ref: PROV_1,
          requested_by: USER_1,
        },
        { dir: fx.connDir }
      )
      appendRequestEvent(CONN_ID, { op: 'current', ref: REQ_1 }, { dir: fx.connDir })

      const res = prepareDevspecToolInput(
        {
          conversationId: CONV_ID,
          tool_name: 'mcp_devspec_update_action_item',
          tool_input: {
            action_item_id: '98788aaf-9ce0-4299-a91c-ef4507bd2df0',
            status: 'in_progress',
          },
        },
        { home: fx.home, env: {} }
      )

      assert.equal(res.decision, 'allow')
      assert.ok(res.overwrite, 'returns overwrite object')
      assert.equal(res.overwrite.connection_id, CONN_ID)
      assert.equal(res.overwrite.project_id, PROJ_ID)
      assert.equal(res.overwrite.local_session_id, CONV_ID)
      assert.equal(res.overwrite.request_ref, REQ_1)
      assert.equal(res.overwrite.provenance_ref, PROV_1)
    } finally {
      fx.cleanup()
    }
  })

  it('stamps agent_name="Antigravity" and plugin_version on register_connection and create_action_item', () => {
    const fx = makeFixture()
    try {
      const reg = prepareDevspecToolInput(
        {
          conversationId: CONV_ID,
          tool_name: 'mcp_devspec_register_connection',
          tool_input: {
            agent_name: 'WrongAgent',
            host_version: 'fake-host',
          },
        },
        { home: fx.home, env: {} }
      )
      assert.equal(reg.decision, 'allow')
      assert.equal(reg.overwrite.agent_name, 'Antigravity')
      assert.equal(reg.overwrite.local_id, CONV_ID)
      assert.equal(reg.overwrite.host_version, undefined)
      assert.ok(typeof reg.overwrite.plugin_version === 'string' && reg.overwrite.plugin_version.length > 0)
    } finally {
      fx.cleanup()
    }
  })

  it('unwraps call_mcp_tool for devspec, writes explicit-reply marker, and attaches work_trail + trail_events on post_session_message', () => {
    const fx = makeFixture()
    try {
      const transcriptPath = path.join(fx.home, 'transcript.jsonl')
      fs.writeFileSync(
        transcriptPath,
        [
          JSON.stringify({
            step_index: 1,
            type: 'PLANNER_RESPONSE',
            created_at: '2026-10-14T22:00:02.000Z',
            thinking: 'Analyzing the room state before replying.',
            tool_calls: [
              {
                name: 'view_file',
                args: {
                  AbsolutePath: '"/tmp/room.json"',
                  toolAction: '"Reading room state"',
                  toolSummary: '"Read room state"',
                },
              },
            ],
          }),
        ].join('\n') + '\n',
      )

      const res = prepareDevspecToolInput(
        {
          conversationId: CONV_ID,
          transcriptPath,
          tool_name: 'call_mcp_tool',
          tool_input: {
            ServerName: 'devspec',
            ToolName: 'post_session_message',
            Arguments: {
              message: 'Completed the check.',
            },
          },
        },
        { home: fx.home, env: {} },
      )

      assert.equal(res.decision, 'allow')
      assert.ok(res.overwrite?.Arguments)
      assert.equal(res.overwrite.Arguments.connection_id, CONN_ID)
      assert.equal(res.overwrite.Arguments.agent_name, 'Antigravity')
      assert.match(res.overwrite.Arguments.work_trail, /Reading room state/)
      assert.equal(res.overwrite.Arguments.trail_events.length, 2)
      assert.equal(
        fs.existsSync(path.join(fx.connDir, `${CONN_ID}.explicit-reply`)),
        true,
      )
    } finally {
      fx.cleanup()
    }
  })
})

describe('Multi-requester ambiguity guard & devspec-serve-request.mjs', () => {
  it('denies DevSpec writes and background launches (run_command, invoke_subagent, schedule) when ambiguous, then allows after serveMain', () => {
    const fx = makeFixture()
    try {
      appendRequestEvent(
        CONN_ID,
        {
          op: 'open',
          id: REQ_1,
          kind: 'command',
          message_id: MSG_1,
          provenance_ref: PROV_1,
          requested_by: USER_1,
        },
        { dir: fx.connDir }
      )
      appendRequestEvent(
        CONN_ID,
        {
          op: 'open',
          id: REQ_2,
          kind: 'command',
          message_id: MSG_2,
          provenance_ref: PROV_2,
          requested_by: USER_2,
        },
        { dir: fx.connDir }
      )
      appendRequestEvent(CONN_ID, { op: 'current', ref: REQ_1 }, { dir: fx.connDir })
      appendRequestEvent(CONN_ID, { op: 'joined', id: REQ_2 }, { dir: fx.connDir })

      // 1. Ambiguous DevSpec write is denied
      const deniedWrite = prepareDevspecToolInput(
        {
          conversationId: CONV_ID,
          tool_name: 'mcp_devspec_update_action_item',
          tool_input: { action_item_id: '98788aaf-9ce0-4299-a91c-ef4507bd2df0' },
        },
        { home: fx.home, env: {} }
      )
      assert.equal(deniedWrite.decision, 'deny')
      assert.match(deniedWrite.reason, /devspec-serve-request\.mjs/)
      assert.match(deniedWrite.reason, new RegExp(MSG_1))
      assert.match(deniedWrite.reason, new RegExp(MSG_2))

      // 2. Background launches (run_command, invoke_subagent, schedule) are denied
      for (const bgCall of [
        { tool_name: 'run_command', tool_input: { CommandLine: 'npm test', IsDaemon: true } },
        { tool_name: 'invoke_subagent', tool_input: { Subagents: [{ TypeName: 'research', Role: 'R', Prompt: 'P' }] } },
        { tool_name: 'schedule', tool_input: { DurationSeconds: 60, Prompt: 'check' } },
      ]) {
        const deniedBg = prepareDevspecToolInput(
          { conversationId: CONV_ID, ...bgCall },
          { home: fx.home, env: {} }
        )
        assert.equal(deniedBg.decision, 'deny', `expected deny for ${bgCall.tool_name}`)
        assert.match(deniedBg.reason, /devspec-serve-request\.mjs/)
      }

      // 3. Binding REQ_2 via serveMain resolves ambiguity
      const served = serveMain(['serve', '--connection-id', CONN_ID, '--message-id', MSG_2], {
        dir: fx.connDir,
      })
      assert.equal(served.ok, true)
      assert.equal(served.request_ref, REQ_2)

      // 4. Subsequent PreToolUse stamps REQ_2 and PROV_2
      const allowedWrite = prepareDevspecToolInput(
        {
          conversationId: CONV_ID,
          tool_name: 'mcp_devspec_update_action_item',
          tool_input: { action_item_id: '98788aaf-9ce0-4299-a91c-ef4507bd2df0' },
        },
        { home: fx.home, env: {} }
      )
      assert.equal(allowedWrite.decision, 'allow')
      assert.equal(allowedWrite.overwrite.request_ref, REQ_2)
      assert.equal(allowedWrite.overwrite.provenance_ref, PROV_2)
    } finally {
      fx.cleanup()
    }
  })
})

describe('room-unread.mjs pre-post hold and injectSteps awareness', () => {
  it('holds post_session_message once on PreToolUse when unread room messages arrived mid-turn and injects awareness via PostInvocation/PreInvocation injectSteps', async () => {
    const fx = makeFixture()
    try {
      const paths = transcriptPaths(CONN_ID, SESS_ID, fx.connDir)
      fs.writeFileSync(
        paths.state,
        JSON.stringify({ self_label: 'Antigravity' }) + '\n',
        { mode: 0o600 }
      )
      const msg1 = {
        seq: 1,
        at: '2026-10-13T21:00:00Z',
        message_id: MSG_1,
        state: 'final',
        from: { kind: 'human', label: 'Ali', you: false },
        to: 'Antigravity',
        text: 'Wait before posting — check the updated schema first.',
        attachments: [],
      }
      fs.writeFileSync(paths.transcript, JSON.stringify(msg1) + '\n', { mode: 0o600 })

      // 1. PreToolUse on post_session_message holds the first attempt
      const hold = prepareDevspecToolInput(
        {
          conversationId: CONV_ID,
          tool_name: 'mcp_devspec_post_session_message',
          tool_input: { content: 'Here is my update' },
        },
        { home: fx.home, env: {} }
      )
      assert.equal(hold.decision, 'deny')
      assert.match(hold.reason, /Not posted yet: messages arrived in the room/)
      assert.match(hold.reason, /"unread":1/)

      // 2. Immediate retry of post_session_message for the same batch is allowed (held only once per batch)
      const retry = prepareDevspecToolInput(
        {
          conversationId: CONV_ID,
          tool_name: 'mcp_devspec_post_session_message',
          tool_input: { content: 'Revised update' },
        },
        { home: fx.home, env: {} }
      )
      assert.equal(retry.decision, 'allow')
      assert.equal(retry.overwrite.connection_id, CONN_ID)

      // 3. New message arrives mid-turn -> PostInvocation injects injectSteps ephemeralMessage
      const msg2 = {
        seq: 2,
        at: '2026-10-13T21:01:00Z',
        message_id: MSG_2,
        state: 'final',
        from: { kind: 'agent', label: 'Claude Code', you: false },
        to: 'Antigravity',
        text: 'I finished the API side.',
        attachments: [],
      }
      fs.writeFileSync(
        paths.transcript,
        [JSON.stringify(msg1), JSON.stringify(msg2)].join('\n') + '\n',
        { mode: 0o600 }
      )

      const postInv = await runPostInvocation(JSON.stringify({ conversationId: CONV_ID }), {
        home: fx.home,
        env: {},
      })
      assert.ok(postInv, 'PostInvocation returns unread awareness')
      assert.ok(Array.isArray(postInv.injectSteps), 'includes injectSteps array')
      assert.equal(typeof postInv.injectSteps[0].ephemeralMessage, 'string')
      assert.match(postInv.injectSteps[0].ephemeralMessage, /"unread":2/)

      // 4. Reader marks messages read
      const readRes = readerOutput({ connectionId: CONN_ID, sessionId: SESS_ID, dir: fx.connDir })
      assert.equal(readRes.ok, true)
      assert.match(readRes.text, /Wait before posting/)
      assert.match(readRes.text, /I finished the API side/)

      // 5. Subsequent PreInvocation has no unread notice
      const preInv = await runPreInvocation(JSON.stringify({ conversationId: CONV_ID }), {
        home: fx.home,
        env: {},
      })
      assert.equal(preInv, null)
    } finally {
      fx.cleanup()
    }
  })
})
