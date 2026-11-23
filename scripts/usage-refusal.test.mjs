/**
 * Item cf356677: when the model provider refuses the agent for usage, DevSpec is told
 * until when (`usage_refused_until`), so its check jobs go to another agent, and is
 * told it lifted once a turn succeeds (`semantics.check_job.usage_refusal`).
 * Run: node --test scripts/usage-refusal.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { handleMirrorTurn, writeTurnMarker } from './mirror-turn.mjs'
import { USAGE_REFUSAL_COOL_OFF_MS, usageRefusalArgument, usageRefusedUntil } from './usage-refusal.mjs'

const NOW = Date.parse('2026-11-20T00:00:00Z')

describe('what counts as a usage refusal, and until when', () => {
  it("reads the time Antigravity's quota refusal gives", () => {
    // The refusal Antigravity CLI ended turns with on 4 Nov 2026 (item 4d744b7b).
    const text = 'RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 161h54m'
    assert.equal(usageRefusedUntil(text, NOW), new Date(NOW + (161 * 60 + 54) * 60_000).toISOString())
    assert.equal(
      usageRefusedUntil('Rate limited, try again in 5 minutes and 30 seconds', NOW),
      new Date(NOW + 330_000).toISOString(),
    )
    assert.equal(usageRefusedUntil('Quota exceeded; resets at 2026-11-21T10:00:00Z', NOW), '2026-11-21T10:00:00.000Z')
  })

  it('reports a short cool-off for a refusal that gives no time', () => {
    assert.equal(usageRefusedUntil('429 Too Many Requests', NOW), new Date(NOW + USAGE_REFUSAL_COOL_OFF_MS).toISOString())
  })

  it('is not set off by another failure, or by a usage percentage alone', () => {
    // A usage percentage is never a refusal: some accounts keep working past 100%.
    for (const text of [
      'generating and executing: request failed: Post "https://example.invalid/v1": Forbidden',
      'context deadline exceeded',
      'Usage: 100% of the weekly limit',
      null,
    ]) {
      assert.equal(usageRefusedUntil(text, NOW), null, String(text))
    }
  })
})

describe('the status updates that carry it', () => {
  const connId = '66666666-7777-4888-8999-aaaaaaaaaaaa'
  const convId = 'conv-usage-refusal-1'

  /** One Stop on a fresh or given folder; the heartbeat arguments it sent. */
  async function stop(dir, hookFields) {
    const transcriptPath = path.join(dir, 'transcript.jsonl')
    fs.writeFileSync(
      path.join(dir, `${connId}.json`),
      JSON.stringify({
        enabled: true,
        connection_id: connId,
        local_id: convId,
        agent_name: 'Antigravity',
        token: 'dvs_test_tok',
        mcp_url: 'https://api.devspec.ai/api/mcp',
        transcript_path: transcriptPath,
      }),
    )
    fs.writeFileSync(transcriptPath, '')
    writeTurnMarker(connId, { startedAt: Date.now() - 5_000, held: false, otherWake: true }, dir)
    const calls = []
    await handleMirrorTurn('stop', JSON.stringify({ conversationId: convId, transcriptPath, ...hookFields }), {
      env: {},
      connectionsDir: dir,
      legacyPath: path.join(dir, 'legacy.json'),
      call: async (req) => {
        calls.push(req)
        return { ok: true }
      },
    })
    return calls.find((c) => c.name === 'heartbeat_connection')?.arguments
  }

  it('reports the refusal at the turn it ended, keeps it on later updates, and clears it once a turn succeeds', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-usage-refusal-'))
    try {
      const refused = await stop(dir, {
        terminationReason: 'ERROR',
        error: 'RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 2h',
      })
      const until = Date.parse(refused.usage_refused_until)
      assert.ok(until > Date.now() + 119 * 60_000 && until <= Date.now() + 120 * 60_000, refused.usage_refused_until)
      // The poller's next status update carries it too, while it stands.
      assert.deepEqual(usageRefusalArgument(connId, { dir }), { usage_refused_until: refused.usage_refused_until })

      // Another kind of failure says nothing about usage: the refusal stands.
      const otherFailure = await stop(dir, { terminationReason: 'ERROR', error: 'request failed: Forbidden' })
      assert.equal(otherFailure.usage_refused_until, refused.usage_refused_until)

      const succeeded = await stop(dir, { terminationReason: 'NO_TOOL_CALL', error: '' })
      assert.equal(succeeded.usage_refused_until, null, 'a successful turn clears it')
      assert.deepEqual(usageRefusalArgument(connId, { dir }), {}, 'a delivered clear is not sent again')

      const next = await stop(dir, { terminationReason: 'NO_TOOL_CALL', error: '' })
      assert.equal(Object.hasOwn(next, 'usage_refused_until'), false, 'nothing to report: nothing sent')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('forgets a refusal whose time has passed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-usage-refusal-'))
    try {
      fs.writeFileSync(path.join(dir, `${connId}.usage-refusal.json`), JSON.stringify({ v: 1, until: '2026-11-19T00:00:00.000Z' }))
      assert.deepEqual(usageRefusalArgument(connId, { dir, now: NOW }), {})
      assert.equal(fs.existsSync(path.join(dir, `${connId}.usage-refusal.json`)), false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
