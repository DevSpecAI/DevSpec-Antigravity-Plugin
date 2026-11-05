/**
 * Item 408ad47b: a turn that ends on an error is reported in the room in
 * Antigravity's own words, and only a remote command turn gets that reply.
 * Run: node --test scripts/turn-failure.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { parseTurnFailure, turnFailureMessage } from './turn-failure.mjs'
import { handleMirrorTurn, writeExplicitReplyMarker, writeTurnMarker } from './mirror-turn.mjs'

// The Stop input Antigravity CLI 1.4.11 sent for a turn whose model request was
// refused mid-session (captured 2026-10-31), trimmed to the fields that matter.
const FAILED_STOP = {
  error: 'generating and executing: request failed: Post "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse": Forbidden',
  executionNum: 0,
  fullyIdle: true,
  terminationReason: 'ERROR',
}

describe('parseTurnFailure', () => {
  it('reads the error a failed turn carries', () => {
    assert.deepEqual(parseTurnFailure(FAILED_STOP), { text: FAILED_STOP.error })
  })

  it('is null for a turn that ended normally', () => {
    assert.equal(parseTurnFailure({ error: '', terminationReason: 'NO_TOOL_CALL' }), null)
    assert.equal(parseTurnFailure({}), null)
    assert.equal(parseTurnFailure(null), null)
  })

  it('still reports an ERROR ending that came with no text', () => {
    assert.deepEqual(parseTurnFailure({ error: '  ', terminationReason: 'ERROR' }), { text: null })
    assert.deepEqual(parseTurnFailure({ terminationReason: 'TERMINATION_REASON_ERROR' }), { text: null })
  })

  it('treats error text as a failure whatever the termination reason says', () => {
    assert.deepEqual(parseTurnFailure({ error: 'quota exceeded', terminationReason: 'UNSPECIFIED' }), { text: 'quota exceeded' })
  })
})

describe('turnFailureMessage', () => {
  it('quotes every line of the error as written', () => {
    const message = turnFailureMessage({ text: 'Quota exceeded.\n\nTry again at 4pm.' }, 'Antigravity')
    assert.match(message, /^Antigravity couldn't finish this\. It said:\n\n> Quota exceeded\.\n>\n> Try again at 4pm\.\n\n/)
    assert.match(message, /send your message again\.$/)
  })

  it('points at the terminal when there is no text', () => {
    const message = turnFailureMessage({ text: null }, 'Antigravity')
    assert.match(message, /couldn't finish this/)
    assert.match(message, /terminal/)
  })
})

describe('Stop on a failed turn', () => {
  const connId = '55555555-6666-4777-8888-999999999999'
  const convId = 'conv-turn-failure-1'
  const sessId = 'sess-turn-failure-1'

  async function stop(marker, hookFields, { explicitReply = false } = {}) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-turn-failure-'))
    try {
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
      // The failed turn left only its input in the transcript: no model reply.
      fs.writeFileSync(
        transcriptPath,
        JSON.stringify({
          step_index: 1,
          type: 'SYSTEM_MESSAGE',
          created_at: new Date().toISOString(),
          content: '{"event":"wake","command_count":1}',
        }) + '\n',
      )
      writeTurnMarker(connId, { startedAt: Date.now() - 5_000, held: false, ...marker }, tmpDir)
      if (explicitReply) writeExplicitReplyMarker(connId, tmpDir)
      const calls = []
      const result = await handleMirrorTurn(
        'stop',
        JSON.stringify({ conversationId: convId, transcriptPath, ...hookFields }),
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
      return { result, calls, posts: calls.filter((c) => c.name === 'post_session_message') }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  it('answers a room command with the error as an ordinary reply and ends the turn', async () => {
    const { result, calls, posts } = await stop({ remoteTurn: true }, FAILED_STOP)
    assert.equal(result.ok, true)
    assert.equal(posts.length, 1)
    const post = posts[0].arguments
    assert.equal(post.connection_id, connId)
    assert.equal(post.complete_turn, true)
    assert.equal(post.phase, undefined, 'an error-phase post is dropped when no bubble is open')
    assert.ok(post.message.includes(`> ${FAILED_STOP.error}`), 'error text is passed through verbatim')
    const heartbeat = calls.find((c) => c.name === 'heartbeat_connection')
    assert.equal(heartbeat?.arguments.busy, false)
    assert.ok(calls.find((c) => c.name === 'report_complete'))
  })

  it('still reports the failure after the agent posted progress during the turn', async () => {
    const { posts } = await stop({ remoteTurn: true }, FAILED_STOP, { explicitReply: true })
    assert.equal(posts.length, 1)
    assert.match(posts[0].arguments.message, /couldn't finish this/)
  })

  it('posts nothing for a turn typed in the terminal, which shows the error itself', async () => {
    const { calls, posts } = await stop({ localPromptMirrored: true }, FAILED_STOP)
    assert.equal(posts.length, 0)
    assert.ok(calls.find((c) => c.name === 'report_complete'))
  })

  it('leaves a normally ended remote turn to the usual fallback', async () => {
    const { posts } = await stop({ remoteTurn: true }, { error: '', terminationReason: 'NO_TOOL_CALL' })
    assert.equal(posts.length, 0, 'no model reply and no failure: nothing to mirror')
  })
})
