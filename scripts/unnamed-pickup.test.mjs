#!/usr/bin/env node
/**
 * A turn no room command started never reports a pickup that could start one
 * (DevSpec item 71ce988c).
 *
 * `report_pickup` with only a connection id picks up the newest pending attempt on the
 * connection, which can be a room command the agent has not been given, and closes the
 * connection's other open attempts. So a check job, automation run or notice reaching
 * the agent while a command waits behind it marked that command as started although
 * nobody was working on it. What a pickup and a busy report each mean is the served
 * contract's and the tools' own descriptions (devspec://product/remote-ingress-contract);
 * these tests run the plugin's two pickup senders (the listener's hand-over and the
 * poller's turn reports) against a stand-in for DevSpec's connection activity, for each
 * kind of wake, and assert that the waiting command stays waiting and that every pickup
 * the plugin sends names its command.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { createListenerQueueState, processListenerInboxTick } from './devspec-remote-listen.mjs'
import * as remotePoll from './devspec-remote-poll.mjs'
import { parseInboxBatches } from './devspec-remote-wait.mjs'
import {
  clearTurnMarker,
  readTurnMarker,
  recordTurnWake,
  turnMarkerPath,
  writeTurnMarker,
} from './mirror-turn.mjs'
import { writeStateFile } from './remote-control-state.mjs'
import {
  FIXTURE_ID,
  fixtureAutomationDispatch,
  fixtureCommand,
  fixtureEnvelope,
  fixtureOrder,
  fixtureUuid,
} from './remote-ingress-test-fixtures.mjs'

const { appendCanonicalInbox, appendWakeDispatches, isTurnMarkerActive, scanPersistedInboxRecords } = remotePoll

const CONNECTION = FIXTURE_ID.connection
const TURN_A = FIXTURE_ID.turn
const TURN_B = '77777777-7777-4777-8777-77777777777b'
const WAITING_MESSAGE = fixtureUuid(9)
const CHECK_JOB_ID = '12121212-1212-4212-8212-121212121212'
const NOTICE_ID = 'f7d6a637-bb5a-4bcc-98ee-354e5f309a6b'

/**
 * DevSpec's connection activity as DevSpecV2 decides it (apps/web/lib/connections/
 * activity.ts and reportPickupTool in apps/web/lib/mcp/tool-executors.ts), reduced to
 * the attempts these tests need.
 *
 * - `report_pickup` with only `connection_id` (pickupCurrentForConnection, which may
 *   start a waiting command): the newest pending attempt, a waiting room command
 *   included, is picked up and every other open attempt is closed as superseded;
 *   failing that an unexpired working attempt is kept; failing that a new working
 *   attempt with no source is opened.
 * - `report_pickup` with `command_turn_id` (+ `command_message_id`)
 *   (pickupCommandForConnection): exactly that command's open attempt, sparing the
 *   other waiting commands; `nothing_open` when it has none.
 * - `report_keepalive`: the newest working attempt, or the refusal "No working attempt
 *   to keep alive for this connection."
 * - `report_complete`: `command_turn_id` + `command_message_id` closes that command and
 *   older ones in its turn; `command_turn_unbound` closes only activity no command
 *   started; `attempt_id` that attempt.
 */
function devspecActivity() {
  let order = 0
  const attempts = []
  const calls = []
  const isOpen = (attempt) => attempt.phase === 'pending' || attempt.phase === 'working'
  const newest = (list) => list.reduce((held, attempt) => (!held || attempt.order > held.order ? attempt : held), null)
  const supersede = (except, { spareWaitingCommands }) => {
    for (const attempt of attempts) {
      if (attempt === except || !isOpen(attempt)) continue
      if (spareWaitingCommands && attempt.phase === 'pending' && attempt.sourceMessageId) continue
      attempt.phase = 'done'
      attempt.reason = 'superseded_by_new_working'
    }
  }
  const pickedUp = (attempt, outcome = 'picked_up') => ({ attempt_id: attempt.id, phase: 'working', outcome })

  function reportPickup(args) {
    if (args.command_turn_id) {
      const target = attempts.find(
        (attempt) =>
          isOpen(attempt) &&
          attempt.commandTurnId === args.command_turn_id &&
          (!args.command_message_id || attempt.sourceMessageId === args.command_message_id),
      )
      if (!target) return { attempt_id: null, outcome: 'nothing_open' }
      supersede(target, { spareWaitingCommands: true })
      if (target.phase === 'working') return pickedUp(target, 'already_working')
      target.phase = 'working'
      return pickedUp(target)
    }
    if (args.attempt_id || args.local_activity_version !== undefined || args.speech_scope) {
      throw new Error(`test stand-in: unexpected exact pickup ${JSON.stringify(args)}`)
    }
    const pending = newest(attempts.filter((attempt) => attempt.phase === 'pending'))
    if (pending) {
      supersede(pending, { spareWaitingCommands: false })
      pending.phase = 'working'
      return pickedUp(pending)
    }
    const working = newest(attempts.filter((attempt) => attempt.phase === 'working'))
    if (working) return pickedUp(working)
    supersede(null, { spareWaitingCommands: false })
    const opened = { id: `sourceless-${++order}`, order, phase: 'working', sourceMessageId: null, commandTurnId: null }
    attempts.push(opened)
    return pickedUp(opened)
  }

  function reportComplete(args) {
    if (args.command_turn_unbound === true) {
      for (const attempt of attempts) if (isOpen(attempt) && !attempt.sourceMessageId) attempt.phase = 'done'
    } else if (args.command_turn_id) {
      const named = attempts.find((attempt) => attempt.sourceMessageId === args.command_message_id)
      for (const attempt of attempts) {
        if (!isOpen(attempt) || attempt.commandTurnId !== args.command_turn_id) continue
        if (!named || attempt.order <= named.order) attempt.phase = 'done'
      }
    } else if (args.attempt_id) {
      for (const attempt of attempts) if (attempt.id === args.attempt_id && isOpen(attempt)) attempt.phase = 'done'
    } else {
      throw new Error('test stand-in: a completion that names nothing')
    }
    return { ok: true }
  }

  return {
    calls,
    /** A room command delivered to the connection and not yet started. */
    commandWaiting(turnId, messageId) {
      attempts.push({ id: `command-${messageId}`, order: ++order, phase: 'pending', sourceMessageId: messageId, commandTurnId: turnId })
    },
    /** The agent's own answer with complete_turn closed this command. */
    answered(messageId) {
      for (const attempt of attempts) if (attempt.sourceMessageId === messageId) attempt.phase = 'done'
    },
    phaseOf(messageId) {
      return attempts.find((attempt) => attempt.sourceMessageId === messageId)?.phase ?? null
    },
    /** The plugin's MCP call, as the poller's callTool and the listener's callMcp make it. */
    async call({ name, arguments: args }) {
      calls.push({ name, arguments: args })
      if (name === 'report_pickup') return reportPickup(args)
      if (name === 'report_keepalive') {
        if (!newest(attempts.filter((attempt) => attempt.phase === 'working'))) {
          throw new Error('No working attempt to keep alive for this connection.')
        }
        return { renewed: true }
      }
      if (name === 'report_complete') return reportComplete(args)
      return { ok: true }
    },
  }
}

const pickupsIn = (calls) =>
  calls
    .filter((call) => call.name === 'report_pickup')
    .map(({ arguments: { connection_id: _connection, ...identity } }) => identity)

const completionsIn = (calls) =>
  calls
    .filter((call) => call.name === 'report_complete')
    .map(({ arguments: { connection_id: _connection, reason: _reason, ...identity } }) => identity)

/** Every pickup the plugin sends names the command it starts. */
function assertEveryPickupNamesACommand(calls) {
  for (const identity of pickupsIn(calls)) {
    assert.ok(
      typeof identity.command_turn_id === 'string' && typeof identity.command_message_id === 'string',
      `a pickup that names no command can start one that is waiting: ${JSON.stringify(identity)}`,
    )
  }
}

/** One command of a command turn: message `n`, in room order `n`. */
function command(n, { turn = TURN_A } = {}) {
  const messageId = fixtureUuid(n)
  return {
    ...fixtureCommand(`command ${n}`),
    message_id: messageId,
    order: fixtureOrder(n, messageId),
    attachments: [],
    delivery: {
      provenance_ref: fixtureUuid(1000 + n),
      turn_id: turn,
      primary_provenance_ref: fixtureUuid(1000 + n),
      is_primary: true,
    },
  }
}

/** Inbox records as the poller's own writers persist them, read back through the reader. */
function persisted(write) {
  const lines = []
  const writeRecord = (_connectionId, record) => {
    lines.push(JSON.stringify(record))
    return true
  }
  write(writeRecord)
  return lines
}

function commandEntry(n) {
  const lines = persisted((writeRecord) =>
    appendCanonicalInbox(
      CONNECTION,
      fixtureEnvelope({ commands: [command(n)], envelopeId: fixtureUuid(5000 + n) }),
      scanPersistedInboxRecords(''),
      { sessionId: null, channel: 'command', writeRecord },
    ),
  )
  const [entry] = parseInboxBatches(lines, CONNECTION)
  assert.ok(entry, 'the fixture command passes the reader revalidation')
  return entry
}

function dispatchEntry(dispatch) {
  const lines = persisted((writeRecord) =>
    appendWakeDispatches(CONNECTION, [dispatch], 'dispatch-cursor', scanPersistedInboxRecords(''), null, writeRecord),
  )
  assert.equal(lines.length, 1, 'the poller persists the dispatch')
  return JSON.parse(lines[0])
}

function checkJobEntry() {
  return dispatchEntry({
    id: CHECK_JOB_ID,
    kind: 'check_job',
    check_job_id: CHECK_JOB_ID,
    check_kind: 'conflict',
    record: { type: 'task', id: '34343434-3434-4434-8434-343434343434', title: 'Queue checks behind active turns' },
    entries: 2,
    yours: true,
    offered_at: '2026-11-04T18:00:00.000Z',
    delivery_connection_id: CONNECTION,
  })
}

function automationRunEntry() {
  return dispatchEntry(fixtureAutomationDispatch())
}

function noticeEntry(audience) {
  return {
    type: 'canonical_system_notices',
    connection_id: CONNECTION,
    session_id: null,
    execute_notice_ids: [NOTICE_ID],
    ingress: {
      envelope_id: '7b48f5da-53fb-4480-97da-6a95bb8d4131',
      system_notices: [
        {
          version: 1,
          kind: 'server_notice',
          notice_id: NOTICE_ID,
          topic: 'intent_ruling_outcome',
          notice_type: 'go_ahead',
          summary: 'Your held work now has the OK to merge.',
          prompt: 'Merge the branch.',
          contract_uri: 'devspec://product/remote-ingress-contract',
          records: [],
          allowed_outcomes: ['merge_or_open_pr_to_tracking_branch'],
          allowed_tools: ['get_task', 'update_task'],
          audience,
        },
      ],
    },
  }
}

/** Every kind of wake that no room command started. */
const WAKES = [
  { name: 'a check job', entry: checkJobEntry },
  { name: 'an automation run', entry: automationRunEntry },
  { name: 'a notice that needs a person', entry: () => noticeEntry('needs_person') },
  { name: 'a notice for the record', entry: () => noticeEntry('for_the_record') },
]

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agy-unnamed-pickup-'))
}

let lastStartedAt = 0
/** Start a turn the way the listener does; each test turn gets its own `startedAt`. */
function startTurn(dir, entry) {
  recordTurnWake(CONNECTION, entry, dir)
  const marker = readTurnMarker(CONNECTION, dir)
  if (marker.startedAt <= lastStartedAt) {
    marker.startedAt = lastStartedAt + 1
    fs.writeFileSync(turnMarkerPath(CONNECTION, dir), JSON.stringify(marker))
  }
  lastStartedAt = marker.startedAt
  return marker
}

/** The poller's reporter over real marker files, calling the stand-in. */
function poller(dir, devspec) {
  const reporter = remotePoll.createTurnActivityReporter({
    connectionId: CONNECTION,
    callTool: (request) => devspec.call(request),
    readMarker: () => readTurnMarker(CONNECTION, dir),
    clearMarker: () => clearTurnMarker(CONNECTION, dir),
    log: () => {},
  })
  /** One pass of the poll loop's look at the marker. */
  return () => {
    const marker = readTurnMarker(CONNECTION, dir)
    return reporter.observe(isTurnMarkerActive(marker) ? marker : null, { sessionId: null })
  }
}

/** One listener tick over an inbox holding `entries`, calling the stand-in. */
async function listenerDelivers(dir, devspec, entries) {
  const inboxPath = path.join(dir, `${CONNECTION}.inbox.jsonl`)
  fs.writeFileSync(inboxPath, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(''))
  const live = {
    connection_id: CONNECTION,
    session_id: null,
    local_id: 'd4407e18-72e0-40c5-81e7-a52859d2811d',
    agent_name: 'Antigravity',
    enabled: true,
    token: 'dvs_test_tok',
    mcp_url: 'https://fixture.invalid/api/mcp',
    connection_capability: 'cap_v1',
    inbox_byte_offset: 0,
  }
  writeStateFile(live, dir)
  const delivered = []
  await processListenerInboxTick(createListenerQueueState(0), {
    connectionId: CONNECTION,
    conversationId: live.local_id,
    inboxPath,
    live,
    useAgentApi: true,
    connectionsDir: dir,
    deliver: async ({ message }) => {
      delivered.push(message)
      return { ok: true }
    },
    callMcp: (request) => devspec.call(request),
    writeState: () => {},
    writeStdout: () => {},
    env: {},
  })
  // The listener's pickup is fire-and-forget: let it land.
  await new Promise((resolve) => setImmediate(resolve))
  return delivered
}

describe('a wake no room command started never starts a waiting command (item 71ce988c)', () => {
  for (const wake of WAKES) {
    it(`the listener hands over ${wake.name} without starting the command waiting behind it`, async () => {
      const dir = tempDir()
      try {
        const devspec = devspecActivity()
        devspec.commandWaiting(TURN_B, WAITING_MESSAGE)
        const delivered = await listenerDelivers(dir, devspec, [wake.entry()])
        assert.equal(delivered.length, 1, `${wake.name} reaches the agent`)
        assert.ok(readTurnMarker(CONNECTION, dir), 'and starts a turn')
        assert.equal(devspec.phaseOf(WAITING_MESSAGE), 'pending', 'the waiting command is still waiting')
        assert.deepEqual(pickupsIn(devspec.calls), [], 'no pickup: nothing names a command to start')
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })

    it(`the poller reports ${wake.name}'s turn from start to end without starting the waiting command`, async () => {
      const dir = tempDir()
      try {
        const devspec = devspecActivity()
        devspec.commandWaiting(TURN_B, WAITING_MESSAGE)
        const look = poller(dir, devspec)
        startTurn(dir, wake.entry())
        await look()
        await look()
        await look()
        assert.equal(devspec.phaseOf(WAITING_MESSAGE), 'pending', 'the waiting command is still waiting')
        assert.ok(isTurnMarkerActive(readTurnMarker(CONNECTION, dir)), 'the turn is still running')
        assertEveryPickupNamesACommand(devspec.calls)

        clearTurnMarker(CONNECTION, dir)
        await look()
        assert.deepEqual(completionsIn(devspec.calls), [{ command_turn_unbound: true }], 'its end closes only activity no command started')
        assert.equal(devspec.phaseOf(WAITING_MESSAGE), 'pending', 'and leaves the waiting command waiting')
        assertEveryPickupNamesACommand(devspec.calls)
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })
  }

  it('a refused keepalive in a turn that also took a check job keeps the turn and starts nothing', async () => {
    const dir = tempDir()
    try {
      // The turn started with command 1 and later took a check job. The command's own
      // answer closed it while the agent kept working, and command 2 arrived and waits
      // behind the turn. The next keepalive is refused because nothing is working.
      const devspec = devspecActivity()
      devspec.commandWaiting(TURN_A, fixtureUuid(1))
      const look = poller(dir, devspec)
      startTurn(dir, commandEntry(1))
      // Started long enough ago that only the check job counts it as still running.
      writeTurnMarker(CONNECTION, { startedAt: Date.now() - 5 * 60_000 }, dir)
      await look()
      assert.deepEqual(pickupsIn(devspec.calls), [{ command_turn_id: TURN_A, command_message_id: fixtureUuid(1) }])
      assert.equal(devspec.phaseOf(fixtureUuid(1)), 'working', 'command 1 started by name')

      recordTurnWake(CONNECTION, checkJobEntry(), dir)
      const turn = readTurnMarker(CONNECTION, dir)
      assert.equal(turn.checkJobWake, true, 'the turn took a check job')
      assert.equal(turn.commandTurns.length, 1, 'and is still command 1\'s turn')
      devspec.answered(fixtureUuid(1))
      devspec.commandWaiting(TURN_B, WAITING_MESSAGE)
      await look()
      await look()
      await look()

      assert.equal(devspec.phaseOf(WAITING_MESSAGE), 'pending', 'command 2 is still waiting')
      assert.ok(isTurnMarkerActive(readTurnMarker(CONNECTION, dir)), 'the turn is still running')
      assertEveryPickupNamesACommand(devspec.calls)

      clearTurnMarker(CONNECTION, dir)
      await look()
      assert.equal(devspec.phaseOf(WAITING_MESSAGE), 'pending', 'its end leaves command 2 waiting')
      assertEveryPickupNamesACommand(devspec.calls)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a held question keeps its own exact keepalive on a turn no command started', async () => {
    const dir = tempDir()
    try {
      // The turn sends nothing of its own, but a directed-question continuation held
      // through it is still renewed by its exact keepalive (interactionActivityPlan).
      const devspec = devspecActivity()
      let exactKeepalives = 0
      const reporter = remotePoll.createTurnActivityReporter({
        connectionId: CONNECTION,
        callTool: (request) => devspec.call(request),
        readMarker: () => readTurnMarker(CONNECTION, dir),
        clearMarker: () => clearTurnMarker(CONNECTION, dir),
        getContinuation: () => ({ attempt_id: 'held-question-attempt' }),
        keepaliveContinuation: async () => {
          exactKeepalives++
        },
        log: () => {},
      })
      const look = () => reporter.observe(readTurnMarker(CONNECTION, dir), { sessionId: null })
      startTurn(dir, checkJobEntry())
      await look()
      await look()
      await look()
      assert.equal(exactKeepalives, 2, 'one exact keepalive per look while the turn runs')
      assert.deepEqual(devspec.calls, [], 'and nothing generic')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a room command is still started by name, by the listener and by the poller', async () => {
    const dir = tempDir()
    try {
      const devspec = devspecActivity()
      devspec.commandWaiting(TURN_A, fixtureUuid(3))
      devspec.commandWaiting(TURN_B, WAITING_MESSAGE)
      const look = poller(dir, devspec)
      const delivered = await listenerDelivers(dir, devspec, [commandEntry(3)])
      assert.equal(delivered.length, 1)
      await look()
      assert.equal(devspec.phaseOf(fixtureUuid(3)), 'working', 'the command handed over is working')
      assert.equal(devspec.phaseOf(WAITING_MESSAGE), 'pending', 'the one behind it still waits')
      assert.deepEqual(pickupsIn(devspec.calls), [
        { command_turn_id: TURN_A, command_message_id: fixtureUuid(3) },
        { command_turn_id: TURN_A, command_message_id: fixtureUuid(3) },
      ])
      clearTurnMarker(CONNECTION, dir)
      await look()
      assert.deepEqual(completionsIn(devspec.calls), [{ command_turn_id: TURN_A, command_message_id: fixtureUuid(3) }])
      assert.equal(devspec.phaseOf(fixtureUuid(3)), 'done')
      assert.equal(devspec.phaseOf(WAITING_MESSAGE), 'pending')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
