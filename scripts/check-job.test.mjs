#!/usr/bin/env node
/**
 * Check jobs on the wake channel (DevSpec item 55d71b0c): negotiation, the dispatch
 * validator union (automation run OR check job, anything else refused as before),
 * inbox persistence and dedupe, revalidation before waking, and the wake text.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import {
  CHECK_JOB_VERSION,
  CHECK_JOB_WAKE_KEYS,
  checkJobWakeText,
  validateCheckJobDispatch,
} from './check-job.mjs'
import {
  appendWakeDispatches,
  isTurnMarkerActive,
  pushChannelUrl,
  remoteIngressNegotiationArguments,
  scanPersistedInboxRecords,
  validateWakeDispatch,
} from './devspec-remote-poll.mjs'
import { buildWakeDeliveryMessage } from './devspec-remote-listen.mjs'
import { handleMirrorTurn, readTurnMarker } from './mirror-turn.mjs'
import { formatInboxEntryForStream, parseInboxBatches } from './devspec-remote-wait.mjs'
import { FIXTURE_ID, fixtureAutomationDispatch } from './remote-ingress-test-fixtures.mjs'

const CONNECTION = FIXTURE_ID.connection
const JOB = '12121212-1212-4212-8212-121212121212'
const RECORD = '34343434-3434-4434-8434-343434343434'
const WAKE_TEXT =
  'A check is waiting on "Sign in with a passkey": take it with claim_check_job, rule every entry with record_check_rulings, then carry on.'

function checkJob(over = {}) {
  return {
    id: JOB,
    kind: 'check_job',
    check_job_id: JOB,
    check_kind: 'conflict',
    record: { type: 'task', id: RECORD, title: 'Sign in with a passkey' },
    entries: 3,
    high_risk: 1,
    yours: true,
    offered_at: '2026-11-04T03:00:00.000Z',
    delivery_connection_id: CONNECTION,
    ...over,
  }
}

function memoryIndex() {
  return scanPersistedInboxRecords('')
}

function collect() {
  const written = []
  return {
    written,
    write: (_connectionId, record) => {
      written.push(record)
      return true
    },
  }
}

describe('check job negotiation', () => {
  it('asks for check jobs, version 1, on every poll', () => {
    assert.equal(CHECK_JOB_VERSION, 1)
    assert.equal(remoteIngressNegotiationArguments().check_job_version, 1)
  })

  it('asks for check jobs on the connection stream handshake, beside system_notice_version', () => {
    const url = new URL(pushChannelUrl('https://devspec.test/api/mcp', CONNECTION))
    assert.equal(url.searchParams.get('check_job_version'), '1')
    assert.equal(url.searchParams.get('system_notice_version'), '2')
  })
})

describe('busy is reported truthfully across a turn (required with check_job_version 1)', () => {
  it('is busy from the turn start until its Stop, then not busy', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-check-job-busy-'))
    const conversationId = 'ca2d5a24-57ea-4252-90d0-82d4dd2504d1'
    const transcriptPath = path.join(dir, 'transcript.jsonl')
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
      fs.writeFileSync(
        transcriptPath,
        JSON.stringify({
          step_index: 1,
          type: 'USER_INPUT',
          source: 'USER_EXPLICIT',
          content: '<USER_REQUEST>\nRule the waiting check\n</USER_REQUEST>',
        }) + '\n',
      )
      const calls = []
      const options = {
        env: {},
        connectionsDir: dir,
        legacyPath: path.join(dir, 'legacy.json'),
        call: async (request) => {
          calls.push(request)
          return { ok: true }
        },
      }
      const hookInput = JSON.stringify({ conversationId, transcriptPath })
      const busyBeats = () =>
        calls.filter((call) => call.name === 'heartbeat_connection').map((call) => call.arguments.busy)

      await handleMirrorTurn('user_prompt', hookInput, options)
      assert.deepEqual(busyBeats(), [true])
      // The poller re-asserts busy on every poll while this marker is active.
      assert.equal(isTurnMarkerActive(readTurnMarker(CONNECTION, dir)), true)

      const stop = await handleMirrorTurn('stop', hookInput, options)
      assert.equal(stop.busy, false)
      assert.deepEqual(busyBeats(), [true, false])
      assert.ok(
        calls.some((call) => call.name === 'report_complete' && call.arguments.reason === 'turn_end'),
        'the turn end is reported',
      )
      // ...and sends busy: false once the marker is gone.
      assert.equal(isTurnMarkerActive(readTurnMarker(CONNECTION, dir)), false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('dispatch validator union', () => {
  it('still accepts an automation run in its exact existing shape', () => {
    const run = fixtureAutomationDispatch()
    assert.deepEqual(validateWakeDispatch(run, CONNECTION), { ok: true, dispatch: run })
  })

  it('accepts a check job in its exact shape, for every check kind and record type', () => {
    assert.deepEqual([...CHECK_JOB_WAKE_KEYS].sort(), Object.keys(checkJob()).sort())
    for (const check_kind of ['conflict', 'conflict_decisions', 'duplicate', 'staleness']) {
      for (const type of ['task', 'memory', 'artifact', 'proposal']) {
        const job = checkJob({ check_kind, record: { type, id: RECORD, title: 'T' } })
        assert.equal(validateWakeDispatch(job, CONNECTION).ok, true, `${check_kind}/${type}`)
      }
    }
    // A record whose title is empty is still a record (the server sends '' for none).
    assert.equal(validateWakeDispatch(checkJob({ record: { type: 'memory', id: RECORD, title: '' } }), CONNECTION).ok, true)
    assert.equal(validateWakeDispatch(checkJob({ yours: false, entries: 0, high_risk: 0 }), CONNECTION).ok, true)
  })

  it('rejects a check job with an extra key or a missing key', () => {
    const extra = validateWakeDispatch({ ...checkJob(), text: 'record text' }, CONNECTION)
    assert.deepEqual(extra, { ok: false, error: 'dispatch does not exactly match check_job' })
    const { yours: _yours, ...missing } = checkJob()
    assert.equal(validateWakeDispatch(missing, CONNECTION).ok, false)
    const recordExtra = checkJob({ record: { type: 'task', id: RECORD, title: 'T', body: 'x' } })
    assert.equal(validateWakeDispatch(recordExtra, CONNECTION).ok, false)
    const recordMissing = checkJob({ record: { type: 'task', id: RECORD } })
    assert.equal(validateWakeDispatch(recordMissing, CONNECTION).ok, false)
  })

  it('rejects a check job with a wrong value or addressed to another connection', () => {
    const other = '99999999-9999-4999-8999-999999999999'
    for (const over of [
      { check_job_id: other },
      { id: 'not-a-uuid', check_job_id: 'not-a-uuid' },
      { check_kind: 'reversal' },
      { record: { type: 'action_item', id: RECORD, title: 'T' } },
      { record: { type: 'task', id: 'short', title: 'T' } },
      { record: { type: 'task', id: RECORD, title: null } },
      { entries: -1 },
      { entries: 1.5 },
      { high_risk: '1' },
      { yours: 'true' },
      { offered_at: 'yesterday' },
      { delivery_connection_id: other },
    ]) {
      const result = validateWakeDispatch(checkJob(over), CONNECTION)
      assert.deepEqual(result, { ok: false, error: 'invalid or misaddressed check_job dispatch' }, JSON.stringify(over))
    }
    assert.equal(validateCheckJobDispatch(checkJob(), null).ok, false)
  })

  it('rejects any other shape exactly as before check jobs existed', () => {
    for (const unknown of [
      { id: JOB, kind: 'task_work', task_id: RECORD },
      { ...fixtureAutomationDispatch(), extra: true },
      { ...checkJob(), kind: undefined },
    ]) {
      assert.deepEqual(validateWakeDispatch(unknown, CONNECTION), {
        ok: false,
        error: 'dispatch does not exactly match automation_run',
      })
    }
    assert.deepEqual(validateWakeDispatch(null, CONNECTION), { ok: false, error: 'dispatch is not an object' })
    assert.deepEqual(validateWakeDispatch([checkJob()], CONNECTION), { ok: false, error: 'dispatch is not an object' })
  })
})

describe('persisting dispatches to the inbox', () => {
  it('keeps automation runs and check jobs, each under its own record type, once by id', () => {
    const { written, write } = collect()
    const index = memoryIndex()
    const run = fixtureAutomationDispatch()
    const first = appendWakeDispatches(CONNECTION, [run, checkJob()], 'cursor-1', index, null, write)
    assert.deepEqual(first, { ok: true, appended: 2, appendedByType: { automation_run: 1, check_job: 1 } })
    assert.deepEqual(written.map((record) => record.type), ['automation_run', 'check_job'])
    assert.equal(written[1].connection_id, CONNECTION)
    assert.equal(written[1].dispatch_cursor, 'cursor-1')
    assert.deepEqual(written[1].dispatch, checkJob())

    // The whole open set comes again on the next poll: nothing is written twice.
    const again = appendWakeDispatches(CONNECTION, [run, checkJob()], 'cursor-2', index, null, write)
    assert.deepEqual(again, { ok: true, appended: 0, appendedByType: { automation_run: 0, check_job: 0 } })
    assert.equal(written.length, 2)
  })

  it('rebuilds the dedupe index from persisted check jobs after a restart', () => {
    const line = JSON.stringify({ type: 'check_job', connection_id: CONNECTION, dispatch: checkJob() })
    const index = scanPersistedInboxRecords(`${line}\n`)
    assert.equal(index.dispatchIds.has(JOB), true)
    const { written, write } = collect()
    const result = appendWakeDispatches(CONNECTION, [checkJob()], 'cursor', index, null, write)
    assert.equal(result.appended, 0)
    assert.equal(written.length, 0)
  })

  it('rejects the whole batch, writing nothing, when one item is bad', () => {
    for (const bad of [
      { ...checkJob(), text: 'record text' },
      { id: JOB, kind: 'task_work' },
      { ...fixtureAutomationDispatch(), delivery_connection_id: JOB },
    ]) {
      const { written, write } = collect()
      const index = memoryIndex()
      const result = appendWakeDispatches(
        CONNECTION,
        [fixtureAutomationDispatch(), checkJob(), bad],
        'cursor',
        index,
        null,
        write,
      )
      assert.equal(result.ok, false)
      assert.equal(result.appended, 0)
      assert.equal(written.length, 0)
      assert.equal(index.dispatchIds.size, 0)
    }
  })
})

describe('waking the agent for a check job', () => {
  const record = { type: 'check_job', connection_id: CONNECTION, session_id: null, dispatch: checkJob() }

  it('says a check is waiting on the record in one line', () => {
    assert.equal(checkJobWakeText(checkJob()), WAKE_TEXT)
    assert.equal(
      checkJobWakeText(checkJob({ record: { type: 'memory', id: RECORD, title: '' } })),
      `A check is waiting on the memory ${RECORD}: take it with claim_check_job, rule every entry with record_check_rulings, then carry on.`,
    )
    assert.equal(WAKE_TEXT.includes('\n'), false)
  })

  it('revalidates a persisted check job before it reaches the wake stream', () => {
    const line = JSON.stringify(record)
    assert.deepEqual(parseInboxBatches([line], CONNECTION), [record])
    const tampered = JSON.stringify({ ...record, dispatch: { ...checkJob(), text: 'x' } })
    assert.deepEqual(parseInboxBatches([tampered], CONNECTION), [])
    const elsewhere = JSON.stringify({ ...record, connection_id: JOB })
    assert.deepEqual(parseInboxBatches([elsewhere], CONNECTION), [])
    assert.deepEqual(parseInboxBatches([line], JOB), [])
  })

  it('streams the wake text and the dispatch, with its check_job_id, to devspec-remote-wait', () => {
    const lines = formatInboxEntryForStream(record, { inboxFile: '/tmp/inbox.jsonl' })
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.deepEqual(lines[0], {
      type: 'check_job',
      session_id: null,
      authoritative: true,
      executable: true,
      channel: 'explicit_check_job_dispatch',
      check_job_id: JOB,
      dispatch: checkJob(),
      content: WAKE_TEXT,
    })
    assert.deepEqual(lines[1], {
      type: 'wake',
      reason: 'check_job',
      check_job_id: JOB,
      inbox: '/tmp/inbox.jsonl',
      authoritative: false,
      executable: false,
    })
  })

  it('delivers the wake text through the background listener, and only for a valid job', () => {
    const message = buildWakeDeliveryMessage(record, { connectionId: CONNECTION })
    const parts = message.split('\n\n')
    assert.equal(parts[0], '[DevSpec Remote Wake]')
    assert.equal(parts[1], WAKE_TEXT)
    assert.match(parts[2], /"type":"check_job"/)
    assert.match(parts[2], new RegExp(`"check_job_id":"${JOB}"`))
    assert.equal(
      buildWakeDeliveryMessage({ ...record, dispatch: { ...checkJob(), extra: 1 } }, { connectionId: CONNECTION }),
      null,
    )
    assert.equal(buildWakeDeliveryMessage(record, { connectionId: JOB }), null)
  })

  it('leaves the turn request chain alone: a check job brings no requester', async () => {
    const { recordDeliveredBatchRequests } = await import('./requests.mjs')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-check-job-'))
    try {
      assert.deepEqual(recordDeliveredBatchRequests(CONNECTION, record, { dir }), [])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
