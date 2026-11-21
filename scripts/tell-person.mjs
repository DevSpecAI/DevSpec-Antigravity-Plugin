/**
 * Telling the person on a turn no room command started (DevSpec item e086163c).
 *
 * A DevSpec write whose result carries `tell_person` is
 * `semantics.notice_audience.telling_anyway` in the served remote-ingress contract,
 * and acting on it is the agent's. On a turn only a check job or a notice woke, an
 * ordinary `post_session_message` has no turn of its own to join: DevSpec refuses it
 * when the connection has never had a command, and otherwise files it under one it is
 * not about (the last command, or one delivered and still waiting). So this plugin
 * posts such a message on DevSpec's assistant speech lane (`assistant_source_id` with
 * `ingest_version: 2`, in the post tool's own description), which needs the
 * connection's capability and no open turn. Two callers:
 *
 * - the agent's own command, `devspec-tell-person.mjs`;
 * - the Stop hook's backstop (mirror-turn.mjs), which posts the agent's last words
 *   when a write carried `tell_person` and the agent told nobody.
 *
 * A post DevSpec refuses is never dropped: the refusal is kept as DevSpec sent it
 * (its words and its structured details, credentials redacted), reported, and, for
 * the backstop, handed back to the agent once at its next step (pre-invocation.mjs).
 *
 * Imports only Node built-ins, so mirror-turn.mjs and pre-invocation.mjs can import it.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const TELLING_ANYWAY_CONTRACT =
  'semantics.notice_audience.telling_anyway in devspec://product/remote-ingress-contract'

/** The agent's command, by its real path on this machine. */
export const TELL_PERSON_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'devspec-tell-person.mjs')

/**
 * A stable uuid for one message: DevSpec stores a source id once and returns the stored
 * row for a resend of the same text, so the same words for the same turn never land twice.
 */
export function speechSourceId(...parts) {
  const hex = crypto.createHash('sha256').update(parts.map((part) => String(part ?? '')).join('\u0000')).digest('hex')
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** The speech lane's post: no command, turn, attempt or completion on it. */
export function tellPersonArguments({ connectionId, message, sourceId, agentName = null, model = null }) {
  return {
    connection_id: connectionId,
    message,
    assistant_source_id: sourceId,
    ingest_version: 2,
    ...(agentName ? { agent_name: agentName } : {}),
    ...(model ? { model } : {}),
  }
}

/** The model a post names, from the connection's telemetry, in the one shape the lane takes. */
export function telemetryModel(telemetry) {
  const id = telemetry?.model?.id
  if (typeof id !== 'string' || !id) return null
  return { providerID: telemetry.model.provider || 'google', modelID: id }
}

/** Credentials out of anything that is printed, stored or shown to the agent. */
export function redactCredentials(value, secrets = []) {
  const known = secrets.filter((secret) => typeof secret === 'string' && secret.length >= 8)
  const scrub = (text) => {
    let out = text
    for (const secret of known) out = out.split(secret).join('[REDACTED]')
    return out.replace(/dvsc_[A-Za-z0-9_-]+/g, '[REDACTED_CONNECTION_CAPABILITY]')
  }
  const visit = (item) => {
    if (typeof item === 'string') return scrub(item)
    if (Array.isArray(item)) return item.map(visit)
    if (!item || typeof item !== 'object') return item
    return Object.fromEntries(
      Object.entries(item)
        .filter(([key]) => !['connection_capability', 'connectionCapability', 'token', '_meta'].includes(key))
        .map(([key, nested]) => [key, visit(nested)]),
    )
  }
  return visit(value)
}

/** DevSpec's refusal as it arrived: its words, its structured details, and any transport code. */
export function refusalOf(error) {
  const details = error && typeof error === 'object' && Object.hasOwn(error, 'details') ? error.details ?? null : null
  return {
    message: error instanceof Error ? error.message : String(error),
    details,
    ...(error && typeof error === 'object' && typeof error.code === 'string' ? { code: error.code } : {}),
    ...(error && typeof error === 'object' && Number.isInteger(error.status) ? { status: error.status } : {}),
  }
}

/**
 * Post it. Never throws: `{ ok: true, receipt }` with DevSpec's receipt, or
 * `{ ok: false, refusal }`, where nothing was stored. `call` is mcpToolsCall's shape.
 */
export async function postToPerson({ call, mcpUrl, token, connectionCapability, args }) {
  const secrets = [token, connectionCapability]
  if (!connectionCapability) {
    return {
      ok: false,
      refusal: {
        message: 'Not sent: this connection holds no capability for DevSpec\'s speech lane. Reconnect with the current plugin.',
        details: { code: 'connection_capability_unavailable', sent: false },
      },
    }
  }
  try {
    const receipt = await call({ mcpUrl, token, connectionCapability, name: 'post_session_message', arguments: args })
    return { ok: true, receipt: redactCredentials(receipt, secrets) }
  } catch (error) {
    return { ok: false, refusal: redactCredentials(refusalOf(error), secrets) }
  }
}

export function handBackPath(connectionId, dir) {
  return path.join(dir, `${connectionId}.tell-person-refused.json`)
}

/** Keep a refused backstop post for the agent's next step. A later one joins it, never replaces it. */
export function stageHandBack(connectionId, { message, refusal, at = Date.now() }, dir) {
  if (!connectionId || !dir) return false
  const file = handBackPath(connectionId, dir)
  let held = []
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (Array.isArray(parsed?.refused)) held = parsed.refused
  } catch {
    /* nothing held yet */
  }
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    fs.writeFileSync(
      file,
      JSON.stringify({ schema: 1, connection_id: connectionId, refused: [...held, { at: new Date(at).toISOString(), message, refusal }] }),
      { mode: 0o600 },
    )
    return true
  } catch {
    return false
  }
}

/** Take what was handed back, once: the file is gone after this, whoever reads it first. */
export function takeHandBack(connectionId, dir) {
  if (!connectionId || !dir) return null
  const file = handBackPath(connectionId, dir)
  const taken = `${file}.taken-${crypto.randomUUID()}`
  try {
    fs.renameSync(file, taken)
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(taken, 'utf8'))
    if (parsed?.schema !== 1 || parsed.connection_id !== connectionId || !Array.isArray(parsed.refused)) return null
    const refused = parsed.refused.filter((item) => typeof item?.message === 'string' && item.refusal && typeof item.refusal === 'object')
    return refused.length > 0 ? { connectionId, refused } : null
  } catch {
    return null
  } finally {
    try {
      fs.rmSync(taken, { force: true })
    } catch {
      /* best effort */
    }
  }
}

/** What the agent is told at its next step: what did not land, DevSpec's refusal as sent, and where the rule is. */
export function handBackText({ connectionId, refused }) {
  const items = refused
    .map(
      (item, index) =>
        `${refused.length > 1 ? `${index + 1}. ` : ''}At ${item.at}, DevSpec refused it with:\n` +
        `${JSON.stringify(item.refusal, null, 2)}\n` +
        `The words that did not reach the room:\n${item.message}`,
    )
    .join('\n\n')
  return (
    '[DevSpec] A write in your last turn carried `tell_person`, you did not tell your person, and the post this ' +
    'plugin made at the end of that turn with your last words did not land.\n\n' +
    `${items}\n\n` +
    `What \`tell_person\` asks of you is ${TELLING_ANYWAY_CONTRACT}. To post to your person on a turn no room command ` +
    `started: node "${TELL_PERSON_SCRIPT}" --connection-id "${connectionId}" --message '<your words>'. ` +
    'It prints DevSpec\'s receipt, or DevSpec\'s refusal as sent.'
  )
}
