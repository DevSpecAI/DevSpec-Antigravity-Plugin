#!/usr/bin/env node
/**
 * A turn's end names the turn that ended (DevSpec item 6ccb8be1).
 *
 * `report_complete` with only a connection id closes whatever is newest on the
 * connection, which can be a command sent a moment ago that the agent has not started.
 * These tests run the two reporters of a turn end (the Stop hook and the poller's
 * marker-driven backstop) through the orders that lost a command, and assert on what
 * each `report_complete` says it closes.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import * as remotePoll from './devspec-remote-poll.mjs'
import { buildWakeDeliveryMessage } from './devspec-remote-listen.mjs'
import { parseInboxBatches } from './devspec-remote-wait.mjs'
import {
  clearTurnMarker,
  handleMirrorTurn,
  readTurnMarker,
  recordTurnWake,
  turnMarkerPath,
} from './mirror-turn.mjs'
import { mergeTurnWake, turnWakeFromEntry, turnWakeFromText } from './notice-reply.mjs'
import * as turnCompletion from './turn-completion.mjs'
import {
  FIXTURE_ID,
  fixtureCommand,
  fixtureEnvelope,
  fixtureOrder,
  fixtureUuid,
} from './remote-ingress-test-fixtures.mjs'

const { appendCanonicalInbox, isTurnMarkerActive, scanPersistedInboxRecords } = remotePoll

const CONNECTION = FIXTURE_ID.connection
const TURN_A = FIXTURE_ID.turn
const TURN_B = '77777777-7777-4777-8777-77777777777b'
const CHECK_JOB = { type: 'check_job', connection_id: CONNECTION }

/** One command of a command turn: message `n`, in room order `n`. */
function command(n, { turn = TURN_A, primary = n } = {}) {
  const messageId = fixtureUuid(n)
  return {
    ...fixtureCommand(`command ${n}`),
    message_id: messageId,
    order: fixtureOrder(n, messageId),
    attachments: [],
    delivery: {
      provenance_ref: fixtureUuid(1000 + n),
      turn_id: turn,
      primary_provenance_ref: fixtureUuid(1000 + primary),
      is_primary: primary === n,
    },
  }
}

/**
 * The inbox entry the listener hands to the model for these commands: written by the
 * poller's own inbox writer and read back through the reader's revalidation.
 */
function deliveredEntry(commands, { index = scanPersistedInboxRecords('') } = {}) {
  const lines = []
  const result = appendCanonicalInbox(
    CONNECTION,
    fixtureEnvelope({ commands, envelopeId: fixtureUuid(5000 + commands[0].order.sequence) }),
    index,
    {
      sessionId: null,
      channel: 'command',
      writeRecord: (_connectionId, record) => {
        lines.push(JSON.stringify(record))
        return true
      },
    },
  )
  assert.equal(result.appended, true, 'the fixture command is persisted')
  const [entry] = parseInboxBatches(lines, CONNECTION)
  assert.ok(entry, 'the fixture command passes the reader revalidation')
  return entry
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agy-turn-completion-'))
}

/**
 * Start a turn the way the listener does (`recordTurnWake`). Two turns started within
 * one millisecond would share `startedAt`, which real turns never do, so each test
 * turn gets its own.
 */
let lastStartedAt = 0
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

/** A completion must carry exactly one identity; one that carries none closes whatever is newest. */
function identityOf(completion) {
  const args = completion.arguments
  const named = ['attempt_id', 'command_turn_id', 'command_turn_unbound'].filter(
    (key) => args[key] !== undefined,
  )
  assert.equal(
    named.length,
    1,
    `report_complete must name exactly one thing to close, got ${JSON.stringify(args)}`,
  )
  const { connection_id: _connection, reason: _reason, ...identity } = args
  return identity
}

const completionsIn = (calls) => calls.filter((call) => call.name === 'report_complete').map(identityOf)

describe('a delivered command is recorded on the turn marker (item 6ccb8be1)', () => {
  it('records the command turn and the newest command of a batch', () => {
    const dir = tempDir()
    try {
      recordTurnWake(CONNECTION, deliveredEntry([command(1), command(2, { primary: 1 })]), dir)
      // The last command: the server closes that one and every older one in the turn,
      // and leaves a follow-up this turn was never given.
      assert.deepEqual(readTurnMarker(CONNECTION, dir).commandTurns, [
        { turnId: TURN_A, messageId: fixtureUuid(2), sequence: 2 },
      ])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads the same command from the wake text the turn opens with', () => {
    // The turn-start hook only has the text. If the wake line stops carrying the
    // command's turn, a turn the hook marks first would end naming no command.
    const entry = deliveredEntry([command(1), command(2, { primary: 1 })])
    const text = buildWakeDeliveryMessage(entry, { connectionId: CONNECTION, inboxFile: '/tmp/inbox.jsonl' })
    assert.deepEqual(turnWakeFromText(text), turnWakeFromEntry(entry))
    assert.equal(turnWakeFromEntry(entry).commandTurns.length, 1)
  })

  it('keeps the newest command of a command turn whichever writer records last', () => {
    const index = scanPersistedInboxRecords('')
    const first = turnWakeFromEntry(deliveredEntry([command(1)], { index }))
    const followUp = turnWakeFromEntry(deliveredEntry([command(2, { primary: 1 })], { index }))
    const other = turnWakeFromEntry(deliveredEntry([command(3, { turn: TURN_B })], { index }))

    const newest = { turnId: TURN_A, messageId: fixtureUuid(2), sequence: 2 }
    const marker = mergeTurnWake(mergeTurnWake(null, first), followUp)
    assert.deepEqual(marker.commandTurns, [newest])
    // The listener records the follow-up, then the turn-start hook writes the first
    // delivery it read from its own wake text: the follow-up must stay.
    assert.deepEqual(mergeTurnWake(marker, first).commandTurns, [newest])
    // A different command turn delivered into the same turn is kept beside it.
    assert.deepEqual(mergeTurnWake(marker, other).commandTurns, [
      newest,
      { turnId: TURN_B, messageId: fixtureUuid(3), sequence: 3 },
    ])
    // A wake that brings no command leaves the marker's record alone.
    assert.equal(Object.hasOwn(mergeTurnWake(marker, { otherWake: true }), 'commandTurns'), false)
  })
})

describe('the Stop hook names the turn it ends (item 6ccb8be1)', () => {
  /** Run Stop for a turn whose marker `prepare` wrote; returns what it told DevSpec to close. */
  async function completionsAtStop(prepare) {
    const dir = tempDir()
    const conversationId = 'ca2d5a24-57ea-4252-90d0-82d4dd2504d1'
    try {
      fs.writeFileSync(
        path.join(dir, `${CONNECTION}.json`),
        JSON.stringify({
          enabled: true,
          connection_id: CONNECTION,
          local_id: conversationId,
          agent_name: 'Antigravity',
          token: 'dvs_test',
          mcp_url: 'https://fixture.invalid/api/mcp',
        }),
      )
      prepare(dir)
      const calls = []
      const result = await handleMirrorTurn('stop', JSON.stringify({ conversationId }), {
        env: {},
        connectionsDir: dir,
        legacyPath: path.join(dir, 'legacy.json'),
        call: async (request) => {
          calls.push(request)
          return { ok: true }
        },
      })
      assert.equal(result.busy, false, 'the turn ended')
      return completionsIn(calls)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  it('closes the command turn it was given, up to the newest command delivered', async () => {
    const completions = await completionsAtStop((dir) =>
      recordTurnWake(CONNECTION, deliveredEntry([command(1), command(2, { primary: 1 })]), dir),
    )
    assert.deepEqual(completions, [
      { command_turn_id: TURN_A, command_message_id: fixtureUuid(2) },
    ])
  })

  it('closes only source-less activity for a turn no command started', async () => {
    // The observed loss: a check job's turn ended as the next command arrived, and a
    // completion that named nothing closed that command.
    const completions = await completionsAtStop((dir) => recordTurnWake(CONNECTION, CHECK_JOB, dir))
    assert.deepEqual(completions, [{ command_turn_unbound: true }])
  })

  it('never guesses for a marker that records a command but not which one', async () => {
    // What a plugin version before this one wrote for a command turn.
    const completions = await completionsAtStop((dir) =>
      fs.writeFileSync(
        turnMarkerPath(CONNECTION, dir),
        JSON.stringify({ startedAt: Date.now(), remoteTurn: true, otherWake: true }),
      ),
    )
    assert.deepEqual(completions, [{ command_turn_unbound: true }])
  })
})

describe('the poller completes the turn it saw, not what is newest on the connection (item 6ccb8be1)', () => {
  /** The poller's reporter over real marker files, with every tool call recorded. */
  function poller(dir, { respond = () => ({}) } = {}) {
    const calls = []
    const reporter = remotePoll.createTurnActivityReporter({
      connectionId: CONNECTION,
      callTool: async (request) => {
        calls.push(request)
        return respond(request)
      },
      readMarker: () => readTurnMarker(CONNECTION, dir),
      clearMarker: () => clearTurnMarker(CONNECTION, dir),
      log: () => {},
    })
    return {
      calls,
      /** One pass of the poll loop's look at the marker. */
      look: () => {
        const marker = readTurnMarker(CONNECTION, dir)
        return reporter.observe(isTurnMarkerActive(marker) ? marker : null, { sessionId: null })
      },
      /** The tool calls made since the last time this was asked. */
      since: () => calls.splice(0).map((call) => call.name),
    }
  }

  it('a turn that ends as the next command arrives cannot close that command', async () => {
    const dir = tempDir()
    try {
      const { calls, look, since } = poller(dir)

      // A check job's turn is running. It started no command, so the poller picks
      // nothing up for it and keeps nothing alive of its own (item 71ce988c).
      startTurn(dir, CHECK_JOB)
      await look()
      await look()
      assert.deepEqual(since(), [])

      // The turn ends during a long poll, and that poll returns a new command. The
      // poller has written it to the inbox, but the listener has not delivered it yet,
      // so no marker says a turn is running when the loop looks again.
      clearTurnMarker(CONNECTION, dir)
      const newCommand = deliveredEntry([command(1)])
      await look()
      assert.deepEqual(completionsIn(calls), [{ command_turn_unbound: true }])
      since()

      // The listener delivers the command: a new turn, picked up as one.
      startTurn(dir, newCommand)
      await look()
      assert.deepEqual(since(), ['report_pickup'])

      // And that turn's own end names the command.
      clearTurnMarker(CONNECTION, dir)
      await look()
      assert.deepEqual(completionsIn(calls), [
        { command_turn_id: TURN_A, command_message_id: fixtureUuid(1) },
      ])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('completes the old turn and picks up the new one when the marker changed hands between two looks', async () => {
    const dir = tempDir()
    try {
      const { calls, look, since } = poller(dir)
      startTurn(dir, deliveredEntry([command(1)]))
      await look()
      since()

      // The first turn ended and the next command's turn began before the loop looked
      // again. A keepalive here would leave the first turn open and never start the second.
      clearTurnMarker(CONNECTION, dir)
      startTurn(dir, deliveredEntry([command(2, { turn: TURN_B })]))
      await look()
      assert.deepEqual(
        calls.map((call) => call.name),
        ['report_complete', 'report_pickup'],
      )
      assert.deepEqual(completionsIn(calls), [
        { command_turn_id: TURN_A, command_message_id: fixtureUuid(1) },
      ])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a poller started mid-turn still names the command, from the marker', async () => {
    const dir = tempDir()
    try {
      startTurn(dir, deliveredEntry([command(1)]))
      // A fresh process: nothing remembered, only the marker on disk.
      const { calls, look } = poller(dir)
      await look()
      clearTurnMarker(CONNECTION, dir)
      await look()
      assert.deepEqual(completionsIn(calls), [
        { command_turn_id: TURN_A, command_message_id: fixtureUuid(1) },
      ])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('also closes source-less activity at the end of a turn that outlived its command', async () => {
    const dir = tempDir()
    try {
      // The command's answer closed its turn on the server while the agent kept
      // working, so the next keepalive is refused. The poller picks nothing up again
      // (item 71ce988c) and sends no further keepalive. Whatever carried the rest of the
      // turn belongs to no command: naming only the command at the end would leave the
      // room showing Working until the lease ran out.
      const { calls, look, since } = poller(dir, {
        respond: (request) => {
          if (request.name === 'report_keepalive') {
            throw new Error('No working attempt to keep alive for this connection.')
          }
          return {}
        },
      })
      startTurn(dir, deliveredEntry([command(1)]))
      await look()
      await look()
      await look()
      assert.deepEqual(since(), ['report_pickup', 'report_keepalive'])
      assert.ok(readTurnMarker(CONNECTION, dir), 'the turn is still running')

      clearTurnMarker(CONNECTION, dir)
      await look()
      assert.deepEqual(completionsIn(calls), [
        { command_turn_id: TURN_A, command_message_id: fixtureUuid(1) },
        { command_turn_unbound: true },
      ])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does the same when the marker was cleared and written again for the same command', async () => {
    const dir = tempDir()
    try {
      // The other way a second pickup happens: the refused keepalive comes too late to
      // count as an active turn, so the marker is cleared, and the agent's next tool
      // call writes it again for the command it is still on.
      const entry = deliveredEntry([command(1)])
      const { calls, look, since } = poller(dir)
      startTurn(dir, entry)
      await look()
      clearTurnMarker(CONNECTION, dir)
      await look()
      since()

      startTurn(dir, entry)
      await look()
      await look()
      assert.deepEqual(since(), [], 'the command was already picked up, and its answer closed it')
      clearTurnMarker(CONNECTION, dir)
      await look()
      assert.deepEqual(completionsIn(calls), [
        { command_turn_id: TURN_A, command_message_id: fixtureUuid(1) },
        { command_turn_unbound: true },
      ])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('a turn start names the command it starts (item cf356677)', () => {
  /**
   * `report_pickup` with only a connection id starts whichever command is newest on the
   * connection and supersedes every other open attempt: a command that arrived behind
   * the one this turn was given would be started before the agent saw it.
   */
  const pickupsIn = (calls) =>
    calls
      .filter((call) => call.name === 'report_pickup')
      .map(({ arguments: { connection_id: _connection, ...identity } }) => identity)

  function poller(dir, respond = () => ({})) {
    const calls = []
    const reporter = remotePoll.createTurnActivityReporter({
      connectionId: CONNECTION,
      callTool: async (request) => {
        calls.push(request)
        return respond(request)
      },
      readMarker: () => readTurnMarker(CONNECTION, dir),
      clearMarker: () => clearTurnMarker(CONNECTION, dir),
      log: () => {},
    })
    const look = () => {
      const marker = readTurnMarker(CONNECTION, dir)
      return reporter.observe(isTurnMarkerActive(marker) ? marker : null, { sessionId: null })
    }
    return { calls, look }
  }

  it('the poller names the newest command of the turn, and sends no pickup for a turn no command started', async () => {
    const dir = tempDir()
    try {
      const { calls, look } = poller(dir)
      startTurn(dir, deliveredEntry([command(1), command(2, { primary: 1 })]))
      await look()
      clearTurnMarker(CONNECTION, dir)
      await look()
      startTurn(dir, CHECK_JOB)
      await look()
      assert.deepEqual(pickupsIn(calls), [
        { command_turn_id: TURN_A, command_message_id: fixtureUuid(2) },
      ])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('work that goes on after the command was answered is never picked up again', async () => {
    const dir = tempDir()
    try {
      const { calls, look } = poller(dir, (request) => {
        if (request.name === 'report_keepalive') throw new Error('No working attempt to keep alive for this connection.')
        return {}
      })
      const entry = deliveredEntry([command(1)])
      startTurn(dir, entry)
      await look()
      clearTurnMarker(CONNECTION, dir)
      await look()
      startTurn(dir, entry)
      await look()
      assert.deepEqual(pickupsIn(calls), [
        { command_turn_id: TURN_A, command_message_id: fixtureUuid(1) },
      ])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('the listener names the command it delivers, and has nothing to name for a check job', () => {
    const { commandPickupIdentity, commandTurnsFromEntry } = turnCompletion
    assert.deepEqual(commandPickupIdentity(commandTurnsFromEntry(deliveredEntry([command(3)]))), {
      command_turn_id: TURN_A,
      command_message_id: fixtureUuid(3),
    })
    assert.deepEqual(commandPickupIdentity(commandTurnsFromEntry(CHECK_JOB)), {})
  })
})
