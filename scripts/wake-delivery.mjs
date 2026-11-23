#!/usr/bin/env node
/**
 * The wake a connection's conversation is being handed right now (item 4f140d6c).
 *
 * Antigravity runs PreInvocation for a turn opened by `agentapi send-message` about a
 * tenth of a second BEFORE it writes that message into the conversation's
 * transcript. Measured on agy 1.5.9 with a process and file watcher on a real
 * session: the hook started with the previous turn's last step as the newest one,
 * and the wake's own step landed 114 ms later. A hook that learns what was asked
 * only from the transcript therefore sees a step from inside the last turn, takes
 * the call for a mid-turn one, and the room command gets no recall at all. A typed
 * prompt does not have this problem: its USER_INPUT step is written first.
 *
 * So the listener writes the message here immediately before it hands it to
 * Antigravity, and the turn-recall hook reads it when the transcript shows no turn
 * opening it has not handled yet. One file per connection, replaced by each
 * delivery and removed when a delivery fails; `delivery_id` lets the hook act on a
 * delivery once, whatever came of it.
 *
 * The file holds the wake as delivered, which can quote a room command, so it is
 * written owner-only like every other file beside it (item b17cb7d7).
 */

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { writePrivateText } from './private-state.mjs'

const RECORD_VERSION = 1

export function wakeDeliveryPath(connectionId, dir) {
  return path.join(dir, `${connectionId}.wake-delivery.json`)
}

/**
 * Note the wake about to be delivered into `conversationId`. Returns the record, or
 * `null` when there is nothing to note or it could not be written: the wake is still
 * delivered, and its recall then waits for the transcript to show it.
 */
export function recordWakeDelivery(connectionId, { conversationId, message }, dir, now = Date.now()) {
  if (!connectionId || !conversationId || typeof message !== 'string' || !message) return null
  const record = {
    version: RECORD_VERSION,
    delivery_id: randomUUID(),
    at: now,
    conversation_id: String(conversationId),
    message,
  }
  try {
    writePrivateText(wakeDeliveryPath(connectionId, dir), `${JSON.stringify(record)}\n`)
  } catch {
    return null
  }
  return record
}

/** The delivery did not happen: nothing is being handed over. */
export function clearWakeDelivery(connectionId, dir) {
  if (!connectionId) return
  try {
    fs.rmSync(wakeDeliveryPath(connectionId, dir), { force: true })
  } catch {
    /* a record left behind costs one lookup for a command that never arrived */
  }
}

/** The wake last noted for this connection, when it is whole and for `conversationId`. */
export function readWakeDelivery(connectionId, conversationId, dir) {
  if (!connectionId || !conversationId) return null
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(wakeDeliveryPath(connectionId, dir), 'utf8'))
  } catch {
    return null
  }
  if (!parsed || parsed.version !== RECORD_VERSION) return null
  if (parsed.conversation_id !== conversationId) return null
  if (typeof parsed.delivery_id !== 'string' || !parsed.delivery_id) return null
  if (typeof parsed.message !== 'string' || !parsed.message) return null
  return { deliveryId: parsed.delivery_id, message: parsed.message }
}
