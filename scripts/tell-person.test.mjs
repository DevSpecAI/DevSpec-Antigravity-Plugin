#!/usr/bin/env node
/**
 * The end-of-turn "tell your person" post lands on a turn no room command started
 * (DevSpec item e086163c).
 *
 * When a DevSpec write in a check-job or notice turn carries `tell_person` and the
 * agent tells nobody, the Stop hook posts the agent's last words as a backstop. These
 * tests run the real hooks (PostToolUse, Stop, PreInvocation) and the agent's
 * tell-person command against a stand-in for DevSpec's `post_session_message` that
 * decides as DevSpecV2 staging does, for the turns no command started: a for-the-record
 * notice, and a check job.
 */
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { tellPerson } from './devspec-tell-person.mjs'
import { handleMirrorTurn, readTurnMarker, recordTurnWake, turnMarkerPath } from './mirror-turn.mjs'
import { McpToolRefusalError } from './mcp-call.mjs'
import { runPostToolDispatch } from './post-tool-dispatch.mjs'
import { runPreInvocation } from './pre-invocation.mjs'
import { writeLocalBond, writeStateFile } from './remote-control-state.mjs'
import { handBackPath } from './tell-person.mjs'

const CONN_ID = '11111111-2222-4333-8444-555555555555'
const PROJ_ID = '24c4abaa-2cb9-496a-8492-cf1f1aa1090b'
const SESS_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const CONV_ID = 'ca2d5a24-57ea-4252-90d0-82d4dd2504d1'
const NOTICE_ID = 'f7d6a637-bb5a-4bcc-98ee-354e5f309a6b'
const TASK_ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
const CAPABILITY = 'dvsc_test_capability_secret'
const PREVIOUS_COMMAND = 'd1111111-1111-4111-8111-111111111111'
const PREVIOUS_TURN = '7e7e7e7e-7e7e-47e7-87e7-7e7e7e7e7e7e'
const WAITING_COMMAND = 'd2222222-2222-4222-8222-222222222222'
const WAITING_TURN = '7f7f7f7f-7f7f-47f7-87f7-7f7f7f7f7f7f'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SESSIONLESS_POST_ERROR =
  "This connection is not attached to a session (sessionless). Invoke your coding tool's DevSpec remote workflow with --session <id> to post into a room. For task work requested conversationally, use reserve_work_items then claim_work_item — do not invent a session or assignment protocol."

/**
 * DevSpec's `post_session_message`, as DevSpecV2 staging decides it for a post that
 * names no notice (apps/web/lib/mcp/tool-executors.ts postSessionMessage,
 * apps/web/lib/mcp/assistant-speech.ts, migration 953 append_agent_speech_v2 and its
 * Postgres test), reduced to one connection.
 *
 * An ordinary post (no `assistant_source_id`): the connection must be attached; it is
 * bound to the connection's current command when one is delivered
 * (`current_command_message_id`, set when a command is delivered, migration 1243),
 * else, for an answer, to the newest activity attempt on the connection whatever its
 * phase, quoting that attempt's command; with no attempt at all it is refused
 * ("Connection-native answer/error requires an exact open activity attempt."). An
 * attempt already closed takes the post as a late answer (migration 737).
 *
 * The speech lane (`assistant_source_id` with `ingest_version: 2`): needs the exact
 * connection capability, refuses every identity and expected_* field, complete_turn,
 * a phase other than answer and a turn_kind other than agent; refuses only an
 * unattached connection; lands the text in the room the connection is attached to now,
 * idempotent on the source id, with the newest open attempt and the current command
 * turn noted when they exist ("no open attempt and no current turn still lands"). Any
 * refusal there reaches the caller as one sentence (the executor's catch).
 */
function devspecRoom(connection) {
  const rows = []
  const calls = []
  const refuse = (text) => {
    let details = null
    try {
      details = JSON.parse(text)
    } catch {
      /* a plain refusal, as DevSpec sends most */
    }
    throw new McpToolRefusalError(text, details)
  }
  const newest = (list) => list.reduce((held, item) => (!held || item.openedAt > held.openedAt ? item : held), null)
  const speechRefusal = 'Assistant speech delivery rejected; original source was not relabelled.'
  const IDENTITY = ['attempt_id', 'command_turn_id', 'command_message_id', 'interaction_event_id', 'interaction_response_id',
    'interaction_claim_token', 'question_dismissal_event_id', 'question_dismissal_question_id', 'question_dismissal_claim_token',
    'expected_session_id', 'expected_attached_at', 'expected_attachment_id']

  function speech(args, capability) {
    if (args.connection_id !== connection.id || capability !== connection.capability) refuse(speechRefusal)
    if (args.ingest_version !== 2) refuse(speechRefusal)
    if (IDENTITY.some((key) => args[key] !== undefined)) refuse(speechRefusal)
    if (args.complete_turn === true || (args.phase !== undefined && args.phase !== 'answer') ||
      (args.turn_kind !== undefined && args.turn_kind !== 'agent')) refuse(speechRefusal)
    if (typeof args.message !== 'string' || !args.message.trim()) refuse(speechRefusal)
    if (typeof args.assistant_source_id !== 'string' || !UUID.test(args.assistant_source_id)) refuse(speechRefusal)
    if (args.model !== undefined && (typeof args.model?.providerID !== 'string' || typeof args.model?.modelID !== 'string' ||
      Object.keys(args.model).some((key) => key !== 'providerID' && key !== 'modelID'))) refuse(speechRefusal)
    if (!connection.sessionId) refuse(speechRefusal)
    const stored = rows.find((row) => row.sourceId === args.assistant_source_id)
    if (stored) {
      if (stored.content !== args.message) refuse(speechRefusal)
      return { connection_id: connection.id, session_id: stored.sessionId, message_id: stored.id, phase: 'answer',
        assistant_source_id: stored.sourceId, delivery: { status: 'stored', idempotently_stored: true } }
    }
    const open = newest(connection.attempts.filter((attempt) => attempt.phase === 'pending' || attempt.phase === 'working'))
    const row = {
      id: crypto.randomUUID(), lane: 'speech', sessionId: connection.sessionId, sourceId: args.assistant_source_id,
      content: args.message, attemptId: open?.id ?? null, turnId: connection.currentCommandTurnId,
      replyTo: connection.currentCommandMessageId, completesTurn: false,
    }
    rows.push(row)
    return { connection_id: connection.id, session_id: row.sessionId, message_id: row.id, phase: 'answer',
      assistant_source_id: row.sourceId, delivery: { status: 'stored' } }
  }

  function ordinary(args) {
    if (typeof args.message !== 'string' || !args.message.trim()) refuse('Missing required parameter: message')
    if (!connection.sessionId) refuse(SESSIONLESS_POST_ERROR)
    let attempt = null
    let turnId = null
    let replyTo = null
    if (connection.currentCommandMessageId) {
      turnId = connection.currentCommandTurnId
      replyTo = connection.currentCommandMessageId
      attempt = newest(connection.attempts.filter((candidate) => candidate.turnId === turnId))
    } else {
      attempt = newest(connection.attempts)
      replyTo = attempt?.sourceMessageId ?? null
      turnId = attempt?.turnId ?? null
    }
    if (!attempt) refuse('Connection-native answer/error requires an exact open activity attempt.')
    const row = {
      id: crypto.randomUUID(), lane: 'answer', sessionId: connection.sessionId, content: args.message,
      attemptId: attempt.id, turnId, replyTo, lateAnswer: attempt.phase === 'done', completesTurn: args.complete_turn === true,
    }
    rows.push(row)
    return { message_id: row.id, session_id: row.sessionId, connection_id: connection.id, delivery: { status: 'stored' } }
  }

  return {
    rows,
    calls,
    async call({ name, arguments: args, connectionCapability = null }) {
      calls.push({ name, arguments: args, connectionCapability })
      if (name !== 'post_session_message') return { ok: true }
      if (args.system_notice_ids !== undefined) throw new Error('test stand-in: the backstop never names a notice')
      return args.assistant_source_id !== undefined ? speech(args, connectionCapability) : ordinary(args)
    },
  }
}

/** The connection's state on DevSpec when the turn ends. */
const CONNECTION_STATES = {
  'no command has reached the connection yet': () => ({ attempts: [], currentCommandMessageId: null, currentCommandTurnId: null }),
  'its last command was answered and closed': () => ({
    attempts: [{ id: crypto.randomUUID(), phase: 'done', sourceMessageId: PREVIOUS_COMMAND, turnId: PREVIOUS_TURN, openedAt: 1 }],
    currentCommandMessageId: null,
    currentCommandTurnId: null,
  }),
}

function connection(over = {}) {
  return { id: CONN_ID, sessionId: SESS_ID, capability: CAPABILITY, ...CONNECTION_STATES['no command has reached the connection yet'](), ...over }
}

const WAKES = {
  'a notice for the record': {
    type: 'canonical_system_notices',
    connection_id: CONN_ID,
    session_id: SESS_ID,
    execute_notice_ids: [NOTICE_ID],
    ingress: {
      envelope_id: '7b48f5da-53fb-4480-97da-6a95bb8d4131',
      system_notices: [{
        version: 1, kind: 'server_notice', notice_id: NOTICE_ID, topic: 'duplicate_confirmed', notice_type: 'duplicate',
        summary: 'A duplicate of your task was confirmed.', prompt: 'Fold the duplicate into your task.',
        contract_uri: 'devspec://product/remote-ingress-contract', records: [], allowed_outcomes: ['acknowledge_outcome'],
        allowed_tools: ['update_task'], audience: 'for_the_record',
      }],
    },
  },
  'a check job': { type: 'check_job', connection_id: CONN_ID },
}

const TELL_PERSON_RESULT = {
  content: [
    { type: 'text', text: JSON.stringify({ outcome: 'committed', task: { id: TASK_ID } }) },
    {
      type: 'text',
      text: JSON.stringify({
        tell_person: {
          why: 'changed_someone_elses_record',
          record: { type: 'task', id: TASK_ID },
          owner: 'someone_else',
          instruction: 'This changed a record that is not the requester\'s own, so tell the person you are working for what you changed.',
        },
      }),
    },
  ],
}

const LAST_WORDS = 'I closed Brandon\'s duplicate task, which repeated mine.'

function fixture({ capability = CAPABILITY } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-tell-person-'))
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
      ...(capability ? { connection_capability: capability } : {}),
    },
    connDir,
  )
  writeLocalBond(CONV_ID, { connection_id: CONN_ID }, rcDir)
  fs.writeFileSync(transcriptPath, '')
  return { home, rcDir, connDir, transcriptPath, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) }
}

/** A turn woken by `wake`, in which a DevSpec write carried `tell_person`, and the agent's last words. */
async function tellPersonTurn(fx, wake) {
  recordTurnWake(CONN_ID, wake, fx.connDir)
  await runPostToolDispatch(
    JSON.stringify({
      conversationId: CONV_ID,
      tool_name: 'call_mcp_tool',
      tool_input: { ServerName: '"devspec"', ToolName: '"update_task"', Arguments: JSON.stringify({ task_id: TASK_ID, lifecycle: 'dismissed' }) },
      tool_response: TELL_PERSON_RESULT,
    }),
    { env: {}, home: fx.home, call: async () => ({ ok: true }) },
  )
  assert.equal(readTurnMarker(CONN_ID, fx.connDir).tellPerson, true, 'the write\'s tell_person is noted on the turn')
  fs.appendFileSync(
    fx.transcriptPath,
    `${JSON.stringify({ step_index: 4, type: 'PLANNER_RESPONSE', created_at: new Date(Date.now() + 2000).toISOString(), content: LAST_WORDS })}\n`,
  )
}

function stop(fx, room) {
  return handleMirrorTurn('stop', JSON.stringify({ conversationId: CONV_ID, transcriptPath: fx.transcriptPath }), {
    env: {},
    connectionsDir: fx.connDir,
    legacyPath: path.join(fx.home, 'legacy.json'),
    call: (request) => room.call(request),
  })
}

const postsIn = (room) => room.calls.filter((call) => call.name === 'post_session_message')

describe('the tell-person backstop lands on a turn no room command started (item e086163c)', () => {
  for (const [wakeName, wake] of Object.entries(WAKES)) {
    for (const [stateName] of Object.entries(CONNECTION_STATES)) {
      it(`${wakeName}, when ${stateName}: the person's message lands in the room, bound to no command`, async () => {
        const fx = fixture()
        try {
          const room = devspecRoom(connection(CONNECTION_STATES[stateName]()))
          await tellPersonTurn(fx, wake)
          await stop(fx, room)
          assert.equal(postsIn(room).length, 1, 'one post at the turn\'s end')
          assert.equal(room.rows.length, 1, 'DevSpec stored it')
          const [row] = room.rows
          assert.equal(row.content, LAST_WORDS)
          assert.equal(row.sessionId, SESS_ID)
          assert.equal(row.lane, 'speech', 'on DevSpec\'s speech lane, which takes a post with no turn open')
          assert.equal(row.replyTo, null, 'quoting no command')
          assert.equal(row.turnId, null, 'bound to no command turn')
          assert.equal(row.completesTurn, false, 'finishing nothing')
        } finally {
          fx.cleanup()
        }
      })
    }
  }

  it('a check job, when a room command is waiting: the post names no command of its own', async () => {
    // DevSpec points the connection at a command when it is delivered, before the
    // agent has it. Whatever DevSpec notes beside the text, the plugin's post must not
    // be the waiting command's answer.
    const fx = fixture()
    try {
      const room = devspecRoom(connection({
        attempts: [{ id: crypto.randomUUID(), phase: 'pending', sourceMessageId: WAITING_COMMAND, turnId: WAITING_TURN, openedAt: 2 }],
        currentCommandMessageId: WAITING_COMMAND,
        currentCommandTurnId: WAITING_TURN,
      }))
      await tellPersonTurn(fx, WAKES['a check job'])
      await stop(fx, room)
      assert.equal(room.rows.length, 1)
      const [post] = postsIn(room)
      for (const key of ['command_turn_id', 'command_message_id', 'command_turn_unbound', 'attempt_id', 'complete_turn', 'system_notice_ids']) {
        assert.equal(post.arguments[key], undefined, key)
      }
      assert.equal(room.rows[0].lane, 'speech', 'not an answer to the waiting command')
    } finally {
      fx.cleanup()
    }
  })
})

/** PreInvocation for the agent's next step: what it injects. */
async function nextStep(fx) {
  const out = await runPreInvocation(JSON.stringify({ conversationId: CONV_ID, transcriptPath: fx.transcriptPath }), {
    env: {},
    home: fx.home,
    connectionsDir: fx.connDir,
    legacyPath: path.join(fx.home, 'legacy.json'),
    call: async () => ({ ok: true }),
    recall: async () => null,
  })
  return (out?.injectSteps ?? []).map((step) => step.ephemeralMessage ?? '')
}

/** Run `work` with stderr captured. */
async function withStderr(work) {
  const lines = []
  const write = process.stderr.write
  process.stderr.write = (chunk) => {
    lines.push(String(chunk))
    return true
  }
  try {
    await work()
  } finally {
    process.stderr.write = write
  }
  return lines.join('')
}

describe('the backstop\'s post, its refusals and its one copy (item e086163c)', () => {
  it('sends the speech lane\'s shape with the connection\'s own capability, and nothing that binds it to a turn', async () => {
    const fx = fixture()
    try {
      const room = devspecRoom(connection())
      await tellPersonTurn(fx, WAKES['a check job'])
      await stop(fx, room)
      const [post] = postsIn(room)
      assert.equal(post.connectionCapability, CAPABILITY)
      assert.match(post.arguments.assistant_source_id, UUID)
      assert.equal(post.arguments.ingest_version, 2)
      assert.equal(post.arguments.connection_id, CONN_ID)
      for (const key of ['command_turn_id', 'command_message_id', 'command_turn_unbound', 'attempt_id', 'local_turn', 'complete_turn',
        'phase', 'turn_kind', 'work_trail', 'trail_events', 'system_notice_ids', 'session_id', 'expected_session_id']) {
        assert.equal(post.arguments[key], undefined, key)
      }
    } finally {
      fx.cleanup()
    }
  })

  it('a refused post is reported, and handed back to the agent at its next step, once, with DevSpec\'s refusal as sent', async () => {
    const fx = fixture()
    try {
      // DevSpec's answer carries structure; it must reach the agent whole, not as a sentence.
      const refusal = { delivery: { status: 'rejected', reason: 'not_attached', retryable: false }, error: 'This connection is attached to no room.' }
      const room = devspecRoom(connection())
      const call = async (request) => {
        room.calls.push(request)
        throw new McpToolRefusalError(JSON.stringify(refusal), refusal)
      }
      await tellPersonTurn(fx, WAKES['a notice for the record'])
      const stderr = await withStderr(() =>
        handleMirrorTurn('stop', JSON.stringify({ conversationId: CONV_ID, transcriptPath: fx.transcriptPath }), {
          env: {}, connectionsDir: fx.connDir, legacyPath: path.join(fx.home, 'legacy.json'), call,
        }),
      )
      assert.equal(postsIn(room).length, 1)
      assert.match(stderr, /tell_person post did not land; handed back to the agent/, 'reported')
      assert.ok(stderr.includes('"reason":"not_attached"'), 'with DevSpec\'s structured refusal')

      const [handedBack, ...more] = await nextStep(fx)
      assert.equal(more.length, 0)
      assert.ok(handedBack.includes(LAST_WORDS), 'the words that did not land')
      assert.ok(handedBack.includes('"reason": "not_attached"'), 'DevSpec\'s refusal, structured')
      assert.ok(handedBack.includes('"retryable": false'))
      assert.match(handedBack, /semantics\.notice_audience\.telling_anyway in devspec:\/\/product\/remote-ingress-contract/)
      assert.ok(handedBack.includes(`--connection-id "${CONN_ID}"`), 'and the command that posts it')
      assert.ok(!handedBack.includes(CAPABILITY), 'never the capability')
      assert.deepEqual(await nextStep(fx), [], 'handed back once')
    } finally {
      fx.cleanup()
    }
  })

  it('a connection with no capability sends nothing, says why, and hands the words back', async () => {
    const fx = fixture({ capability: null })
    try {
      const room = devspecRoom(connection())
      await tellPersonTurn(fx, WAKES['a check job'])
      await withStderr(() => stop(fx, room))
      assert.equal(postsIn(room).length, 0, 'an ordinary post would have no turn to join')
      const [handedBack] = await nextStep(fx)
      assert.ok(handedBack.includes(LAST_WORDS))
      assert.ok(handedBack.includes('connection_capability_unavailable'))
    } finally {
      fx.cleanup()
    }
  })

  it('a backstop that runs again for the same turn and words is stored once', async () => {
    const fx = fixture()
    try {
      const room = devspecRoom(connection())
      await tellPersonTurn(fx, WAKES['a check job'])
      const marker = readTurnMarker(CONN_ID, fx.connDir)
      await stop(fx, room)
      // The same turn's Stop again (a retried hook): the marker as it was.
      fs.writeFileSync(turnMarkerPath(CONN_ID, fx.connDir), JSON.stringify(marker))
      await stop(fx, room)
      assert.equal(postsIn(room).length, 2)
      assert.equal(postsIn(room)[0].arguments.assistant_source_id, postsIn(room)[1].arguments.assistant_source_id)
      assert.equal(room.rows.length, 1, 'one message in the room')
    } finally {
      fx.cleanup()
    }
  })

  it('posts nothing at Stop when the agent told its person with its own command', async () => {
    const fx = fixture()
    try {
      const room = devspecRoom(connection())
      await tellPersonTurn(fx, WAKES['a notice for the record'])
      const told = await tellPerson(
        { connectionId: CONN_ID, message: 'I closed Brandon\'s duplicate task.' },
        { dir: fx.connDir, call: (request) => room.call(request), readState: (file) => JSON.parse(fs.readFileSync(file, 'utf8')) },
      )
      assert.equal(told.sent, true)
      assert.equal(room.rows.length, 1)
      assert.ok(readTurnMarker(CONN_ID, fx.connDir).personToldAt, 'noted on the turn')
      await stop(fx, room)
      assert.equal(postsIn(room).length, 1, 'the Stop hook added nothing')
      assert.deepEqual(await nextStep(fx), [])
    } finally {
      fx.cleanup()
    }
  })

  it('posts nothing at Stop when the agent posted to its person itself', async () => {
    const fx = fixture()
    try {
      const room = devspecRoom(connection({ attempts: [{ id: crypto.randomUUID(), phase: 'done', sourceMessageId: PREVIOUS_COMMAND, turnId: PREVIOUS_TURN, openedAt: 1 }] }))
      await tellPersonTurn(fx, WAKES['a check job'])
      await runPostToolDispatch(
        JSON.stringify({
          conversationId: CONV_ID,
          tool_name: 'call_mcp_tool',
          tool_input: { ServerName: '"devspec"', ToolName: '"post_session_message"', Arguments: JSON.stringify({ message: 'I closed your duplicate task.' }) },
          tool_response: { content: [{ type: 'text', text: '{"delivery":{"status":"stored"}}' }] },
        }),
        { env: {}, home: fx.home, call: async () => ({ ok: true }) },
      )
      await stop(fx, room)
      assert.equal(postsIn(room).length, 0, 'told once, by the agent')
    } finally {
      fx.cleanup()
    }
  })
})

describe('the agent\'s tell-person command (devspec-tell-person.mjs)', () => {
  const readState = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))

  it('lands the words on a turn no room command started, with the connection\'s capability, and prints DevSpec\'s receipt', async () => {
    const fx = fixture()
    try {
      const room = devspecRoom(connection())
      recordTurnWake(CONN_ID, WAKES['a check job'], fx.connDir)
      const result = await tellPerson({ connectionId: CONN_ID, message: LAST_WORDS }, { dir: fx.connDir, call: (request) => room.call(request), readState })
      assert.equal(result.sent, true)
      assert.equal(result.receipt.delivery.status, 'stored')
      const [post] = postsIn(room)
      assert.equal(post.connectionCapability, CAPABILITY)
      assert.equal(post.arguments.ingest_version, 2)
      assert.equal(room.rows[0].turnId, null)
      // The same words again in the same turn are the same post.
      await tellPerson({ connectionId: CONN_ID, message: LAST_WORDS }, { dir: fx.connDir, call: (request) => room.call(request), readState })
      assert.equal(room.rows.length, 1)
    } finally {
      fx.cleanup()
    }
  })

  it('prints DevSpec\'s refusal as sent, with credentials redacted, and notes nothing on the turn', async () => {
    const fx = fixture()
    try {
      recordTurnWake(CONN_ID, WAKES['a check job'], fx.connDir)
      const details = { delivery: { status: 'rejected', reason: 'not_attached' }, echoed: `header ${CAPABILITY}`, connection_capability: CAPABILITY }
      const result = await tellPerson(
        { connectionId: CONN_ID, message: LAST_WORDS },
        { dir: fx.connDir, readState, call: async () => { throw new McpToolRefusalError(`refused for ${CAPABILITY}`, details) } },
      )
      assert.equal(result.sent, false)
      assert.equal(result.refusal.details.delivery.reason, 'not_attached', 'structured, not flattened')
      assert.ok(!JSON.stringify(result).includes(CAPABILITY), 'the capability never printed')
      assert.equal(readTurnMarker(CONN_ID, fx.connDir).personToldAt, undefined, 'so the Stop backstop still stands')
    } finally {
      fx.cleanup()
    }
  })

  it('refuses before sending when there is nothing to say or no connection', async () => {
    const fx = fixture()
    try {
      const calls = []
      const call = async (request) => calls.push(request)
      assert.equal((await tellPerson({ connectionId: CONN_ID, message: '  ' }, { dir: fx.connDir, call, readState })).refusal.details.code, 'empty_message')
      assert.equal((await tellPerson({ connectionId: 'nope', message: 'x' }, { dir: fx.connDir, call, readState })).refusal.details.code, 'invalid_connection_id')
      assert.equal(calls.length, 0)
    } finally {
      fx.cleanup()
    }
  })
})

describe('the instructions point at the served rule for telling the person (item e086163c)', () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
  const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8')

  it('the rules and the skill name telling_anyway and the command, and never leave it to the plugin', () => {
    for (const text of [read('rules', 'AGENTS.md'), read('skills', 'devspec-remote', 'SKILL.md')]) {
      assert.match(text, /semantics\.notice_audience\.telling_anyway/)
      assert.match(text, /devspec-tell-person\.mjs/)
      assert.match(text, /never (?:something to leave to the plugin|the plugin's)/)
      assert.doesNotMatch(text, /plugin posts your last words/)
    }
  })

  it('the command exists where the hand-back points', () => {
    assert.ok(fs.existsSync(path.join(root, 'scripts', 'devspec-tell-person.mjs')))
    assert.equal(path.basename(handBackPath(CONN_ID, '/x')), `${CONN_ID}.tell-person-refused.json`)
  })
})
