#!/usr/bin/env node
/**
 * Post to your person in the room, on a turn no room command started (item e086163c).
 *
 * A DevSpec write whose result carries `tell_person` is
 * `semantics.notice_audience.telling_anyway` in devspec://product/remote-ingress-contract.
 * On a turn only a check job or a notice woke, an ordinary `post_session_message` has
 * no turn of its own to join, so this posts on DevSpec's speech lane instead
 * (tell-person.mjs), which needs the connection's capability. Antigravity cannot add
 * that header to the model's own MCP call, so, like devspec-plan.mjs and
 * devspec-question.mjs, this bridge reads it from the mode-0600 connection state and
 * sends exactly one call: `post_session_message` with `assistant_source_id` and
 * `ingest_version: 2`, never a command, turn or completion.
 *
 *   node devspec-tell-person.mjs --connection-id <uuid> --message '<words>'
 *   echo '<words>' | node devspec-tell-person.mjs --connection-id <uuid>
 *
 * Prints DevSpec's receipt, or `{ "sent": false, "refusal": … }` with DevSpec's refusal
 * as sent (credentials redacted) and exits 1. A post that lands is noted on the turn,
 * so the Stop hook adds nothing.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AGENT_NAME } from './agent-identity.mjs'
import { mcpToolsCall } from './mcp-call.mjs'
import { readTurnMarker, recordPersonTold } from './mirror-turn.mjs'
import { readPrivateJson } from './private-state.mjs'
import { stateWithCurrentToken } from './resolve-mcp-auth.mjs'
import { readConnectionTelemetry } from './statusline.mjs'
import { postToPerson, speechSourceId, telemetryModel, tellPersonArguments } from './tell-person.mjs'
import { isEntryPoint } from './entry-point.mjs'

const CONNECTIONS_DIR = path.join(os.homedir(), '.devspec', 'remote-control', 'connections')
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// No size check here: DevSpec owns the limit on a post's `message` and enforces it in
// one place. A post over it comes back as DevSpec's own refusal, which this command
// prints as sent, so the plugin never keeps a second copy that could drift.

export function parseArgs(argv) {
  const out = { connectionId: null, message: null }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--connection-id' || arg === '--connection_id') out.connectionId = argv[++index] ?? null
    else if (arg === '--message') out.message = argv[++index] ?? null
  }
  return out
}

/** A refusal made here, before anything is sent: the same shape as DevSpec's. */
function localRefusal(code, message) {
  return { sent: false, refusal: { message, details: { code, sent: false } } }
}

/**
 * Post `message` for the connection. Returns `{ sent: true, receipt }` or
 * `{ sent: false, refusal }`; never throws.
 */
export async function tellPerson(
  { connectionId, message },
  { dir = CONNECTIONS_DIR, call = mcpToolsCall, readState = (file) => stateWithCurrentToken(readPrivateJson(file)) } = {},
) {
  if (typeof connectionId !== 'string' || !UUID.test(connectionId)) {
    return localRefusal('invalid_connection_id', 'Pass your connection id with --connection-id.')
  }
  const words = typeof message === 'string' ? message.trim() : ''
  if (!words) return localRefusal('empty_message', 'Pass what to tell your person with --message, or on stdin.')
  let state = null
  try {
    state = readState(path.join(dir, `${connectionId}.json`))
  } catch {
    state = null
  }
  if (!state || state.connection_id !== connectionId || state.enabled === false) {
    return localRefusal('connection_unavailable', 'This connection\'s state is unavailable or disabled on this machine.')
  }
  if (!state.token || !state.mcp_url) {
    return localRefusal('authentication_unavailable', 'DevSpec authentication for this connection is unavailable.')
  }
  const marker = readTurnMarker(connectionId, dir)
  const sent = await postToPerson({
    call,
    mcpUrl: state.mcp_url,
    token: state.token,
    connectionCapability: state.connection_capability ?? null,
    args: tellPersonArguments({
      connectionId,
      message: words,
      // The same words in the same turn are one post, however often they are sent.
      sourceId: speechSourceId('tell-person', connectionId, marker?.startedAt, words),
      agentName: AGENT_NAME,
      model: telemetryModel(readConnectionTelemetry(connectionId)),
    }),
  })
  if (!sent.ok) return { sent: false, refusal: sent.refusal }
  recordPersonTold(connectionId, dir)
  return { sent: true, receipt: sent.receipt }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  let message = args.message
  if (message === null && !process.stdin.isTTY) {
    try {
      message = fs.readFileSync(0, 'utf8')
    } catch {
      message = null
    }
  }
  const result = await tellPerson({ connectionId: args.connectionId, message })
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  if (!result.sent) process.exitCode = 1
}

const isMain = isEntryPoint(import.meta.url)
if (isMain) {
  main().catch((error) => {
    process.stdout.write(
      JSON.stringify({ sent: false, refusal: { message: error?.message || String(error), details: null } }, null, 2) + '\n',
    )
    process.exitCode = 1
  })
}
