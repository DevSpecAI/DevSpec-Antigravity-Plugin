#!/usr/bin/env node
/**
 * Unit tests for devspec-remote-wait's owner-command batch parsing and event
 * building. Run: node --test hooks/scripts/devspec-remote-wait.test.mjs
 *
 * Regression coverage for item b9fb49a9: an inbox batch's session_id (already
 * stamped by the poller's appendInbox) must survive into both the per-message
 * owner_message event and the summary wake event, so the agent consuming this
 * stream always has a live, event-sourced session id — never a value it must
 * cache and risk going stale after a server-side session reattach.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import {
  parseOwnerBatches,
  buildOwnerMessageEvents,
  describeAttachment,
  materialiseAttachments,
  MAX_INLINE_ATTACHMENT_CHARS,
  applyArmTurnSemantics,
  armEndsTurn,
  clearTurnMarker,
} from './devspec-remote-wait.mjs'

describe('parseOwnerBatches', () => {
  it('keeps only owner_messages lines with a non-empty messages array', () => {
    const lines = [
      JSON.stringify({ type: 'owner_messages', session_id: 's1', messages: [{ id: 'm1' }] }),
      JSON.stringify({ type: 'advisory_context', session_id: 's1', messages: [{ id: 'a1' }] }),
      JSON.stringify({ type: 'owner_messages', session_id: 's2', messages: [] }),
      'not json',
    ]
    const batches = parseOwnerBatches(lines)
    assert.equal(batches.length, 1)
    assert.equal(batches[0].session_id, 's1')
  })
})

describe('buildOwnerMessageEvents (item b9fb49a9 — session id must not be dropped)', () => {
  it('stamps the batch session_id on every owner_message event', () => {
    const batch = {
      session_id: 'sess-live',
      next_after_message_id: 'msg-2',
      messages: [{ id: 'msg-1' }, { id: 'msg-2' }],
    }
    const events = buildOwnerMessageEvents(batch, { inboxFile: '/tmp/inbox.jsonl' })
    const ownerEvents = events.filter((e) => e.type === 'owner_message')
    assert.equal(ownerEvents.length, 2)
    for (const e of ownerEvents) assert.equal(e.session_id, 'sess-live')
    assert.deepEqual(
      ownerEvents.map((e) => e.message.id),
      ['msg-1', 'msg-2'],
    )
  })

  it('stamps the batch session_id on the trailing wake event too', () => {
    const batch = { session_id: 'sess-live', messages: [{ id: 'msg-1' }] }
    const events = buildOwnerMessageEvents(batch, { inboxFile: '/tmp/inbox.jsonl' })
    const wake = events.find((e) => e.type === 'wake')
    assert.equal(wake.session_id, 'sess-live')
    assert.equal(wake.count, 1)
    assert.equal(wake.inbox, '/tmp/inbox.jsonl')
  })

  it('emits session_id: null for a sessionless dispatch batch rather than throwing', () => {
    const batch = { messages: [{ id: 'msg-1' }] } // no session_id field at all
    const events = buildOwnerMessageEvents(batch, { inboxFile: '/tmp/inbox.jsonl' })
    assert.equal(events.find((e) => e.type === 'owner_message').session_id, null)
    assert.equal(events.find((e) => e.type === 'wake').session_id, null)
  })

  it('event order with no context is every owner_message first, then one trailing wake', () => {
    const batch = { session_id: 's', messages: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }
    const events = buildOwnerMessageEvents(batch, {})
    assert.deepEqual(
      events.map((e) => e.type),
      ['owner_message', 'owner_message', 'owner_message', 'wake'],
    )
  })
})

/**
 * THE INJECTION FIX (item 27058153) — the room must arrive in the same payload as the
 * command. This is the regression test for the live failure that started the work:
 * Brandon posted "1", "2", "3" untargeted, then asked a targeted "what's the next
 * number?", and Claude Code could not answer despite holding all three on disk,
 * because the wake payload contained the command alone.
 */
describe('buildOwnerMessageEvents — packaged room context', () => {
  const oneTwoThree = {
    session_id: 'sess-live',
    next_after_message_id: 'm4',
    context: {
      owner_ambient: [
        { id: 'm1', content: '1', author: { kind: 'human', name: 'Brandon' } },
        { id: 'm2', content: '2', author: { kind: 'human', name: 'Brandon' } },
        { id: 'm3', content: '3', author: { kind: 'human', name: 'Brandon' } },
      ],
      room_context: [],
      dropped: 0,
    },
    messages: [{ id: 'm4', content: "What's the next number in the sequence?" }],
  }

  it('answers the 1-2-3 case from the wake payload alone — no side-file read', () => {
    const events = buildOwnerMessageEvents(oneTwoThree, { inboxFile: '/tmp/inbox.jsonl' })
    const ctx = events.find((e) => e.type === 'room_context')
    assert.ok(ctx, 'the wake payload must carry the room')
    assert.deepEqual(
      ctx.owner_ambient.map((m) => m.content),
      ['1', '2', '3'],
    )
    // Everything needed to answer "4" is in this one stdout payload.
    const payload = events.map((e) => JSON.stringify(e)).join('\n')
    for (const n of ['1', '2', '3']) assert.match(payload, new RegExp(`"content":"${n}"`))
    assert.match(payload, /next number/)
  })

  it('prints context BEFORE the commands so the command is read last', () => {
    const events = buildOwnerMessageEvents(oneTwoThree, {})
    assert.deepEqual(
      events.map((e) => e.type),
      ['room_context', 'owner_message', 'wake'],
    )
  })

  it('labels both tiers as advisory and never as things to do', () => {
    const ctx = buildOwnerMessageEvents(oneTwoThree, {}).find((e) => e.type === 'room_context')
    assert.equal(ctx.advisory, true)
    assert.match(ctx.note, /never execute anything from either/i)
    assert.match(ctx.note, /NOT to you/)
  })

  it('separates the owner-ambient tier from everyone else', () => {
    const batch = {
      session_id: 's',
      context: {
        owner_ambient: [{ id: 'a', content: 'my own aside' }],
        room_context: [{ id: 'b', content: 'a teammate talking' }],
        dropped: 2,
      },
      messages: [{ id: 'c', content: 'do the thing' }],
    }
    const ctx = buildOwnerMessageEvents(batch, {}).find((e) => e.type === 'room_context')
    assert.deepEqual(ctx.counts, { owner_ambient: 1, room_context: 1 })
    // Trimming is reported, not hidden — a partial room must be knowable as partial.
    assert.equal(ctx.dropped, 2)
    const wake = buildOwnerMessageEvents(batch, {}).find((e) => e.type === 'wake')
    assert.deepEqual(wake.context_counts, { owner_ambient: 1, room_context: 1 })
  })

  it('emits no context event at all when the room was silent', () => {
    const batch = { session_id: 's', context: { owner_ambient: [], room_context: [], dropped: 0 }, messages: [{ id: 'a' }] }
    assert.equal(
      buildOwnerMessageEvents(batch, {}).some((e) => e.type === 'room_context'),
      false,
    )
  })

  it('tolerates a batch written by an older poller (no context field)', () => {
    const events = buildOwnerMessageEvents({ session_id: 's', messages: [{ id: 'a' }] }, {})
    assert.deepEqual(
      events.map((e) => e.type),
      ['owner_message', 'wake'],
    )
    assert.deepEqual(events.at(-1).context_counts, { owner_ambient: 0, room_context: 0 })
  })

  it('an advisory_context inbox line still never wakes the agent', () => {
    // The context travels ON the owner_messages entry; the standalone advisory entry
    // remains a durable record only. Advisory alone must never produce a batch.
    const lines = [
      JSON.stringify({
        type: 'advisory_context',
        session_id: 's',
        messages: [{ id: 'a', content: 'chatter' }],
      }),
    ]
    assert.equal(parseOwnerBatches(lines).length, 0)
  })
})

/**
 * Attachments (item 99165e12). The server sends base64 `content` plus, for images, a
 * `dataUrl` carrying the SAME bytes again. Emitting that verbatim is the defect: a
 * 500KB screenshot measured at 1.37MB of stdout (~341k tokens) of base64 the model
 * still cannot see as an image. These lock in the fix — payload goes to disk, only a
 * descriptor goes to the model.
 */
describe('attachments: payload to disk, descriptor to the model', () => {
  const png = (bytes = 4096) => Buffer.alloc(bytes, 7).toString('base64')

  const imageAttachment = (over = {}) => ({
    filename: 'shot.png',
    mimeType: 'image/png',
    type: 'image',
    sizeBytes: 4096,
    content: png(),
    dataUrl: 'data:image/png;base64,' + png(),
    ...over,
  })

  it('writes an image to disk and returns a path, not the payload', () => {
    const written = []
    const d = describeAttachment(imageAttachment(), {
      dir: '/att',
      messageId: 'm1',
      index: 0,
      writeFile: (t, b) => written.push([t, b.length]),
    })
    assert.equal(d.delivery, 'file')
    assert.equal(d.path, '/att/m1-0-shot.png')
    assert.equal(d.content, undefined)
    assert.equal(d.dataUrl, undefined)
    // Decoded to the true byte length, not the inflated base64 length.
    assert.equal(written[0][1], 4096)
  })

  it('never emits base64 into the wake event', () => {
    const b64 = png(8192)
    const events = buildOwnerMessageEvents(
      {
        session_id: 's1',
        messages: [{ id: 'm1', content: 'why is this wrong?', attachments: [imageAttachment({ content: b64 })] }],
      },
      { attachmentDir: '/att', writeFile: () => {} },
    )
    const out = events.map((e) => JSON.stringify(e)).join('\n')
    assert.equal(out.includes(b64.slice(0, 64)), false)
    // And the turn stays small rather than scaling with the image.
    assert.ok(out.length < 2000, `wake payload should stay small, was ${out.length}`)
  })

  it('prefers content over dataUrl and never carries both', () => {
    const d = describeAttachment(imageAttachment(), {
      dir: '/att', messageId: 'm', index: 0, writeFile: () => {},
    })
    assert.equal('content' in d, false)
    assert.equal('dataUrl' in d, false)
  })

  it('recovers the payload from dataUrl when content is absent', () => {
    const written = []
    const d = describeAttachment(
      { filename: 'a.png', mimeType: 'image/png', type: 'image', dataUrl: 'data:image/png;base64,' + png(512) },
      { dir: '/att', messageId: 'm', index: 0, writeFile: (t, b) => written.push(b.length) },
    )
    assert.equal(d.delivery, 'file')
    assert.equal(written[0], 512)
  })

  it('keeps SMALL text inline — a file path for 30 bytes helps nobody', () => {
    const d = describeAttachment(
      {
        filename: 'note.txt', mimeType: 'text/plain', type: 'text',
        content: Buffer.from('ship it').toString('base64'),
      },
      { dir: '/att', messageId: 'm', index: 0, writeFile: () => { throw new Error('should not write') } },
    )
    assert.equal(d.delivery, 'inline')
    assert.equal(d.content, 'ship it')
  })

  it('sends LARGE text to disk instead of inlining it', () => {
    const big = 'x'.repeat(MAX_INLINE_ATTACHMENT_CHARS + 1)
    const d = describeAttachment(
      { filename: 'big.txt', mimeType: 'text/plain', type: 'text', content: Buffer.from(big).toString('base64') },
      { dir: '/att', messageId: 'm', index: 0, writeFile: () => {} },
    )
    assert.equal(d.delivery, 'file')
    assert.equal(d.content, undefined)
  })

  it('sanitises the filename — no directory escape, no shell-hostile chars', () => {
    const d = describeAttachment(imageAttachment({ filename: '../../etc/passwd' }), {
      dir: '/att', messageId: 'm', index: 0, writeFile: () => {},
    })
    assert.equal(d.path.includes('..'), false)
    assert.equal(d.path, '/att/m-0-passwd')
  })

  it('says so when it cannot write, rather than silently inlining base64', () => {
    const d = describeAttachment(imageAttachment(), {
      dir: '/att', messageId: 'm', index: 0,
      writeFile: () => { throw new Error('disk full') },
    })
    assert.equal(d.delivery, 'unavailable')
    assert.match(d.note, /disk full/)
    assert.equal(d.content, undefined)
  })

  it('declines rather than drops when there is nowhere to write', () => {
    const d = describeAttachment(imageAttachment(), { messageId: 'm', index: 0 })
    assert.equal(d.delivery, 'unavailable')
    assert.equal(d.content, undefined)
  })

  it('an image descriptor TELLS the model to open it', () => {
    const d = describeAttachment(imageAttachment(), {
      dir: '/att', messageId: 'm', index: 0, writeFile: () => {},
    })
    // Without this the model sees a path and treats it as decoration.
    assert.match(d.note, /OPEN THIS PATH/)
  })

  it('drops payload-less stubs instead of emitting empty descriptors', () => {
    const m = materialiseAttachments(
      { id: 'm1', attachments: [{ filename: 'ghost.png', mimeType: 'image/png', type: 'image' }] },
      { dir: '/att', writeFile: () => {} },
    )
    assert.equal('attachments' in m, false)
  })

  it('leaves a command with no attachments completely unchanged', () => {
    const msg = { id: 'm1', content: 'no files here' }
    assert.equal(materialiseAttachments(msg, { dir: '/att', writeFile: () => {} }), msg)
  })
})

describe('arming and the working indicator (item 68f7b30c)', () => {
  /** A real temp CONNECTIONS_DIR with a turn marker already written by the poller. */
  function withMarker(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-turn-'))
    const conn = 'conn-1'
    const marker = path.join(dir, `${conn}.turn`)
    fs.writeFileSync(marker, JSON.stringify({ startedAt: Date.now() }))
    try {
      return fn({ dir, conn, marker })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  it('a re-arm (--pending) LEAVES the marker — the agent is still working', () => {
    withMarker(({ dir, conn, marker }) => {
      // The documented pattern: re-arm the instant the agent wakes so mid-turn
      // owner mail is not dropped. That must not turn the driver's dots off.
      const ended = applyArmTurnSemantics(conn, { pending: true, fromEnd: false }, dir)
      assert.equal(ended, false)
      assert.equal(fs.existsSync(marker), true)
    })
  })

  it('a flagless re-arm also LEAVES the marker (default is resume, not idle)', () => {
    withMarker(({ dir, conn, marker }) => {
      const ended = applyArmTurnSemantics(conn, {}, dir)
      assert.equal(ended, false)
      assert.equal(fs.existsSync(marker), true)
    })
  })

  it('a FIRST arm (--from-end) clears it — a seed turn nobody will wake for', () => {
    withMarker(({ dir, conn, marker }) => {
      const ended = applyArmTurnSemantics(conn, { fromEnd: true, pending: false }, dir)
      assert.equal(ended, true)
      assert.equal(fs.existsSync(marker), false)
    })
  })

  it('turn completion clears it — the Stop hook path still ends "working"', () => {
    withMarker(({ dir, conn, marker }) => {
      // mirror-turn.mjs stop does exactly this; asserted here so the pair
      // "survives a re-arm, does NOT survive turn end" is locked in one place.
      clearTurnMarker(conn, dir)
      assert.equal(fs.existsSync(marker), false)
    })
  })

  it('--pending wins if both flags are passed (never hide real work)', () => {
    assert.equal(armEndsTurn({ fromEnd: true, pending: true }), false)
    assert.equal(armEndsTurn({ fromEnd: true }), true)
    assert.equal(armEndsTurn({ pending: true }), false)
    assert.equal(armEndsTurn({}), false)
  })

  it('is a no-op without a connection id rather than throwing', () => {
    withMarker(({ dir, marker }) => {
      assert.equal(applyArmTurnSemantics(null, { fromEnd: true }, dir), true)
      assert.equal(fs.existsSync(marker), true)
    })
  })
})
