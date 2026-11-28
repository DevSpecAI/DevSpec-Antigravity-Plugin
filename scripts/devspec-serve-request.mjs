#!/usr/bin/env node
/**
 * CLI helper to select which request the current turn serves when multiple
 * people's requests (or terminal + room requests) are carried in one turn,
 * or to resume a parked parent room task after finishing a quiet DevSpec
 * notice pause whose background work completed mid-turn.
 *
 * Usage:
 *   node "./scripts/devspec-serve-request.mjs" [serve] --connection-id <uuid> \
 *     (--message-id <uuid> | --request-id <uuid> | --terminal | --none | --unstated)
 *   node "./scripts/devspec-serve-request.mjs" resume --connection-id <uuid>
 */

import os from 'node:os'
import path from 'node:path'
import {
  hasPendingTellPersonObligation,
  readOwnedIds,
  readTurnMarker,
  reconcileCompletedOwnedWork,
  restoreHeldParentIfResumed,
} from './mirror-turn.mjs'
import { readStateFile } from './remote-control-state.mjs'
import {
  appendRequestEvent,
  describeCarried,
  readRequestState,
  requestRefForWrite,
  serveCommand,
  serveMain,
  servableCarried,
  turnAmbiguity,
  undecidedTurnMessage,
} from './requests.mjs'
import { isEntryPoint } from './entry-point.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function resumeParentMain(
  argv,
  {
    dir = path.join(os.homedir(), '.devspec', 'remote-control', 'connections'),
    now = Date.now(),
  } = {},
) {
  const args = argv[0] === 'resume' ? argv.slice(1) : argv
  const at = args.indexOf('--connection-id')
  const connectionId = at >= 0 && typeof args[at + 1] === 'string' ? args[at + 1] : null
  if (!UUID.test(connectionId ?? '')) {
    return { ok: false, error: 'resume needs --connection-id <your connection id>' }
  }
  const marker = readTurnMarker(connectionId, dir)
  if (!marker?.heldParent || marker.otherWake) {
    return { ok: false, error: 'No parked parent room task is waiting to resume.' }
  }
  const connState = readStateFile(connectionId, dir)
  const transcriptPath = connState?.transcript_path || null
  const reconciled = reconcileCompletedOwnedWork(connectionId, marker, transcriptPath, dir)
  const parentOwnedIds = Array.isArray(marker.heldParent.ownedIds)
    ? marker.heldParent.ownedIds.filter((id) => typeof id === 'string' && id)
    : []
  const allOutstanding = readOwnedIds(connectionId, marker, dir)
  if (allOutstanding.some((id) => !parentOwnedIds.includes(id))) {
    return {
      ok: false,
      error: 'A background helper launched during this pause is still running; wait for it to finish before resuming the parent task.',
    }
  }
  if (marker.checkJobWake && !marker.checkJobRuled) {
    return {
      ok: false,
      error: 'A waiting DevSpec check job in this pause has not been ruled yet; settle it before resuming the parent task.',
    }
  }
  if (hasPendingTellPersonObligation(marker)) {
    return {
      ok: false,
      error: 'This pause carries a pending tell_person obligation; tell the person before resuming the parent task.',
    }
  }
  const res = restoreHeldParentIfResumed(connectionId, marker, {
    dir,
    reconciled,
    now,
    allowQuietNoticeResume: true,
  })
  if (!res.restored) {
    return {
      ok: false,
      error: 'No parked parent background work has completed yet; wait for it to finish before resuming.',
    }
  }
  const state = readRequestState(connectionId, { dir })
  return {
    ok: true,
    resumed: true,
    request_ref: requestRefForWrite(state),
  }
}

export {
  appendRequestEvent,
  describeCarried,
  readRequestState,
  serveCommand,
  serveMain,
  servableCarried,
  turnAmbiguity,
  undecidedTurnMessage,
}

const isMain = isEntryPoint(import.meta.url)
if (isMain) {
  const argv = process.argv.slice(2)
  const result = argv[0] === 'resume' ? resumeParentMain(argv) : serveMain(argv)
  process.stdout.write(`${JSON.stringify(result)}\n`)
  process.exit(result.ok ? 0 : 1)
}
