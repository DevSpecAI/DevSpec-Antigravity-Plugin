/**
 * What the end of a turn tells DevSpec to close (item 6ccb8be1).
 *
 * `report_complete` with only a connection id closes whatever is newest on the
 * connection: the newest working attempt, else the newest pending one, which can be a
 * command the owner has just sent and the agent has not started. A turn that ended
 * while the next command was arriving closed that command, and the agent's first write
 * for it was refused ("delivery is closed"). So no turn end is reported without saying
 * which turn ended. The identity travels on the turn marker (`<connectionId>.turn`),
 * because the two processes that report a turn end (the Stop hook in mirror-turn.mjs
 * and the poller's backstop in devspec-remote-poll.mjs) share nothing else, and the
 * marker is still there after either of them restarts.
 *
 * `commandTurns` on the marker lists the command turns delivered into the turn, each
 * with the newest command message delivered from it:
 * `[{ turnId, messageId, sequence }]`. The ids are the command's own
 * `delivery.turn_id` and `message_id` from the canonical ingress.
 *
 * Why the newest delivered message, and never the turn id alone: one command turn can
 * hold several commands (a primary and the follow-ups sent while it is open), each
 * with its own activity on the server. `report_complete` with `command_turn_id` and
 * `command_message_id` closes that message's activity and every older one in the
 * turn, and leaves a newer follow-up open, which keeps the command turn alive for it.
 * With `command_turn_id` alone the server closes the newest open activity in the
 * turn, which can be a follow-up this turn was never given. A batch of several
 * commands is always one command turn in a stable order (remote-ingress-v1.mjs), so
 * its last command closes the whole batch and nothing after it.
 *
 * Imports only `local-turn.mjs` (Node built-ins), so notice-reply.mjs and
 * mirror-turn.mjs can import it.
 */

import { localTurnToComplete } from './local-turn.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const uuid = (value) => (typeof value === 'string' && UUID.test(value) ? value : null)

/** One command as the marker keeps it, or null when it does not name a turn and a message. */
function commandTurnEntry(turnId, messageId, sequence) {
  if (!uuid(turnId) || !uuid(messageId)) return null
  return {
    turnId,
    messageId,
    ...(Number.isInteger(sequence) ? { sequence } : {}),
  }
}

/** The marker entry for one canonical command object (`message_id`, `order`, `delivery`). */
export function commandTurnFromCommand(command) {
  return commandTurnEntry(command?.delivery?.turn_id, command?.message_id, command?.order?.sequence)
}

/**
 * Fold command deliveries into the marker's list: one entry per command turn, holding
 * the newest command delivered from it. Newest is the room's own order
 * (`order.sequence`) when both sides carry it, because two writers record the same
 * delivery (the listener as it delivers, the turn-start hook from the wake text) and
 * the older one can be written last. Without a sequence the later write wins.
 */
export function mergeCommandTurns(existing, incoming) {
  const byTurn = new Map()
  for (const raw of [
    ...(Array.isArray(existing) ? existing : []),
    ...(Array.isArray(incoming) ? incoming : []),
  ]) {
    const entry = commandTurnEntry(raw?.turnId, raw?.messageId, raw?.sequence)
    if (!entry) continue
    const held = byTurn.get(entry.turnId)
    const older =
      held && Number.isInteger(held.sequence) && Number.isInteger(entry.sequence)
        ? entry.sequence < held.sequence
        : false
    if (!older) byTurn.set(entry.turnId, entry)
  }
  return [...byTurn.values()]
}

/**
 * The command turns one delivered inbox entry brings into the turn: for a
 * `canonical_commands` record, the commands it hands the model
 * (`execute_message_ids`). Anything else (a check job, a notice, an automation run, a
 * legacy `owner_messages` record with no turn id) names no command turn.
 */
export function commandTurnsFromEntry(entry) {
  if (!entry || typeof entry !== 'object' || entry.type !== 'canonical_commands') return []
  const commands = Array.isArray(entry.ingress?.commands) ? entry.ingress.commands : []
  const delivered = Array.isArray(entry.execute_message_ids)
    ? new Set(entry.execute_message_ids)
    : null
  return mergeCommandTurns(
    [],
    commands
      .filter((command) => !delivered || delivered.has(command?.message_id))
      .map(commandTurnFromCommand),
  )
}

/**
 * The exact command a turn starts, as `report_pickup` identity fields (item cf356677):
 * the newest command delivered into it, by the room's order. A pickup that names
 * nothing starts whichever command is newest on the connection and supersedes every
 * other open attempt, which can be a command that arrived behind this one and that the
 * agent has not been given; naming the command starts exactly that one and spares the
 * others still waiting. Empty when no command started the turn (a check job, a notice,
 * an automation run, a prompt typed at the terminal): there is nothing to name then.
 */
export function commandPickupIdentity(commandTurns) {
  const turns = mergeCommandTurns([], commandTurns)
  if (turns.length === 0) return {}
  const newest = turns.reduce((held, entry) =>
    Number.isInteger(held.sequence) && Number.isInteger(entry.sequence) && entry.sequence < held.sequence ? held : entry,
  )
  return { command_turn_id: newest.turnId, command_message_id: newest.messageId }
}

/**
 * What ends when this turn ends, as `report_complete` identities. One call per entry,
 * each carrying exactly one identity, which is what the server accepts.
 *
 * - A turn typed at the terminal that the host admitted: its exact attempt.
 * - Each command turn delivered into the turn: that turn, up to the newest command
 *   this turn was given. A command already closed (its answer went out with
 *   `complete_turn: true`) makes this a no-op on the server.
 * - Neither: `command_turn_unbound`, which closes only activity that has no source
 *   command (a check job or notice wake, an automation run, a typed prompt that could
 *   not be admitted) and can never close a command. A marker written by a plugin
 *   version that did not record `commandTurns` lands here too: its command is left to
 *   its own answer or its lease, never guessed at.
 *
 * Never empty, so a caller cannot fall back to a completion that names nothing.
 */
export function turnCompletionIdentities({ marker = null, localTurn = null, sessionId = null } = {}) {
  const identities = []
  const attemptId = localTurnToComplete(localTurn || marker?.localTurn, sessionId)
  if (attemptId) identities.push({ attempt_id: attemptId })
  for (const command of mergeCommandTurns([], marker?.commandTurns)) {
    identities.push({ command_turn_id: command.turnId, command_message_id: command.messageId })
  }
  return identities.length > 0 ? identities : [{ command_turn_unbound: true }]
}
