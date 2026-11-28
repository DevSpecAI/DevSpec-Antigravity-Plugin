#!/usr/bin/env node
/**
 * DevSpec remote-control mirror hook (Stop / PreInvocation / PostToolUse) — CONNECTION-NATIVE.
 * Resolves ONLY the connection bound to THIS local conversation — never a
 * machine-global "latest" pointer. Posts mechanically — no LLM tokens.
 *
 * user_prompt       → optional local_prompt bubble when attached (literal owner text)
 *                     + busy/heartbeat + turn marker
 * background_launch → records background subagent/task launches against the open turn
 * stop              → busy/heartbeat + turn marker clear (or hold when background work
 *                     launched by this turn is still in flight); a remote turn that
 *                     ended on an error tells the room so (turn-failure.mjs)
 *
 * Answers are agent-canonical: skills call post_session_message({ connection_id }).
 * ADR b98a39a9 — no dual writers.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mcpToolsCall } from './mcp-call.mjs'
import { connectionCredential, stateWithCurrentToken } from './resolve-mcp-auth.mjs'
import { devspecToolFromName, isDevspecServerName } from './devspec-server.mjs'
import { ensurePrivateDir, writePrivateJson } from './private-state.mjs'
import { AGENT_NAME } from './agent-identity.mjs'
import {
  detectLocalId,
  inferAntigravityTranscriptPath,
  localBondPath,
  resolveOwnerPid,
  writeLocalBond,
} from './remote-control-state.mjs'
import {
  localTurnScope,
  startLocalTurn,
} from './local-turn.mjs'
import {
  absentLaunches,
  appendRequestEvent,
  closeRequest,
  extractBackgroundCommandTaskId,
  isRemotePlumbingBackgroundCommand,
  isRemotePlumbingShellCommand,
  notifiedKeys,
  openRequest,
  promptArrival,
  readRequestState,
  requestForLaunch,
  requestRefForWrite,
  requestsWithWorkPending,
  rotateRequestLog,
  SERVE_REQUEST_SCRIPT,
  setCurrentRequest,
  UNSTATED,
} from './requests.mjs'
import {
  isCheckJobOnlyTurn,
  isRoutineTurn,
  mergeTurnWake,
  postCanTakeTurnNotices,
  turnNoticeIds,
  turnReplyNoticeIds,
  turnStampNoticeIds,
  turnWakeFromEntry,
  turnWakeFromText,
} from './notice-reply.mjs'
import { recordMirroredLocalPrompt } from './room-unread.mjs'
import { readConnectionTelemetry } from './statusline.mjs'
import { parseTurnFailure, turnFailureMessage } from './turn-failure.mjs'
import { noteUsageRefusalSent, recordTurnOutcome, usageRefusalArgument, usageRefusedUntil } from './usage-refusal.mjs'
import { turnCompletionIdentities } from './turn-completion.mjs'
import {
  postToPerson,
  speechSourceId,
  stageHandBack,
  telemetryModel,
  tellPersonArguments,
} from './tell-person.mjs'
import { isEntryPoint } from './entry-point.mjs'

const MODES = new Set(['user_prompt', 'stop', 'background_launch', 'subagent_stop'])
const mode = MODES.has(process.argv[2]) ? process.argv[2] : 'stop'
const LEGACY_STATE_PATH = path.join(os.homedir(), '.devspec', 'remote-control.json')
const CONNECTIONS_DIR = path.join(os.homedir(), '.devspec', 'remote-control', 'connections')

/**
 * The most the server accepts in one post_session_message `message` (the maxLength in
 * its input schema). A mirrored reply or prompt longer than that is posted up to it
 * with a note saying how much more there is and where it is — never cut silently.
 */
export const POST_MESSAGE_MAX_CHARS = 100_000

export function fitPostMessage(text) {
  const value = String(text ?? '')
  if (value.length <= POST_MESSAGE_MAX_CHARS) return value
  const noteFor = (left) => `\n\n… ${left} more characters are not shown here; the full text is in the Antigravity conversation.`
  let kept = POST_MESSAGE_MAX_CHARS - noteFor(value.length).length
  kept -= noteFor(value.length - kept).length - noteFor(value.length).length
  return `${value.slice(0, kept)}${noteFor(value.length - kept)}`
}

/**
 * The server stores each trail event's text, args and result clamped to 4,000
 * characters with a visible ellipsis (packages/core/src/messages/trail-events.ts in
 * DevSpecV2). The trail is re-sent whole each time it changes during a turn, so
 * anything past that point is bytes the server discards: clamp at the same point, the
 * same visible way.
 */
export const TRAIL_FIELD_MAX_CHARS = 4_000

function clampTrailField(text) {
  const value = String(text ?? '')
  return value.length > TRAIL_FIELD_MAX_CHARS ? `${value.slice(0, TRAIL_FIELD_MAX_CHARS - 1)}…` : value
}

/**
 * Each tool call is one line of the trail's markdown list, with a short excerpt of
 * its arguments so the line can be scanned; the call's full arguments travel in its
 * trail event. A longer excerpt ends with a visible ellipsis.
 */
const TRAIL_LINE_ARGS_CHARS = 140

// Turn marker — the connected agent is the SOLE authority for the "working" state.
// PreInvocation / UserPromptSubmit (turn start) writes it; Stop (turn end) clears it.
// The long-lived poller reads it (by connection_id) to re-assert busy on heartbeats
// while a turn runs, so long turns stay "working" and the server's busy freshness
// doesn't decay.
export function turnMarkerPath(connectionId, dir = CONNECTIONS_DIR) {
  return path.join(dir, `${connectionId}.turn`)
}

export const NO_SIGN_OF_LIFE_MS = 60 * 60 * 1000
const DEFAULT_MAX_TURN_MS = NO_SIGN_OF_LIFE_MS

export function readTurnMarker(connectionId, dir = CONNECTIONS_DIR) {
  if (!connectionId) return null
  try {
    const raw = JSON.parse(fs.readFileSync(turnMarkerPath(connectionId, dir), 'utf8'))
    return typeof raw?.startedAt === 'number' ? raw : null
  } catch {
    return null
  }
}

export function isTurnMarkerActive(marker, now = Date.now(), maxTurnMs = DEFAULT_MAX_TURN_MS) {
  if (!marker || typeof marker.startedAt !== 'number') return false
  if (marker.held === true) return true
  const lastActiveAt = Math.max(
    marker.startedAt,
    typeof marker.lastToolAt === 'number' ? marker.lastToolAt : 0,
  )
  return now - lastActiveAt < maxTurnMs
}

export function isForegroundTurnRunning(marker, now = Date.now(), maxTurnMs = DEFAULT_MAX_TURN_MS) {
  if (!marker || marker.held === true) return false
  return isTurnMarkerActive(marker, now, maxTurnMs)
}

export function trailStatePath(connectionId, dir = CONNECTIONS_DIR) {
  return path.join(dir, `${connectionId}.trail-state.json`)
}

export function writeTurnMarker(connectionId, extra = {}, dir = CONNECTIONS_DIR) {
  if (!connectionId) return null
  const existing = readTurnMarker(connectionId, dir)
  const startedAt = typeof existing?.startedAt === 'number' ? existing.startedAt : Date.now()
  const { preserveExplicitReply, ...restExtra } = extra || {}
  const payload = {
    ...(existing || {}),
    startedAt,
    ...restExtra,
  }
  try {
    ensurePrivateDir(dir)
    if (!existing && !preserveExplicitReply) {
      fs.rmSync(path.join(dir, `${connectionId}.explicit-reply`), { force: true })
      fs.rmSync(trailStatePath(connectionId, dir), { force: true })
    }
    fs.writeFileSync(turnMarkerPath(connectionId, dir), JSON.stringify(payload), {
      mode: 0o600,
    })
  } catch {
    /* non-fatal — the immediate busy heartbeat below still fires */
  }
  return payload
}

function snapshotHeldParent(marker, { connectionId = null, dir = CONNECTIONS_DIR } = {}) {
  if (!marker) return null
  if (marker.heldParent && typeof marker.heldParent === 'object') return marker.heldParent
  const ownedIds = connectionId ? readOwnedIds(connectionId, marker, dir) : []
  return {
    remoteTurn: Boolean(marker.remoteTurn),
    localPromptMirrored: Boolean(marker.localPromptMirrored),
    localTurn: marker.localTurn || null,
    otherWake: Boolean(marker.otherWake),
    backgroundContinuation: Boolean(marker.backgroundContinuation),
    ...(ownedIds.length > 0 ? { ownedIds } : {}),
  }
}

function normalizeExcludedRanges(ranges) {
  if (!Array.isArray(ranges)) return []
  return ranges.filter(
    (r) =>
      r &&
      typeof r.startMs === 'number' &&
      Number.isFinite(r.startMs) &&
      typeof r.endMs === 'number' &&
      Number.isFinite(r.endMs) &&
      r.endMs >= r.startMs,
  )
}

function appendExcludedRange(existing, startMs, endMs) {
  const ranges = normalizeExcludedRanges(existing)
  if (typeof startMs === 'number' && Number.isFinite(startMs) && typeof endMs === 'number' && Number.isFinite(endMs)) {
    ranges.push({ startMs: Math.min(startMs, endMs), endMs })
  }
  return ranges
}

function isTimestampInExcludedRanges(stepMs, excludedRanges) {
  if (!Number.isFinite(stepMs) || !Array.isArray(excludedRanges) || excludedRanges.length === 0) {
    return false
  }
  return excludedRanges.some(
    (r) =>
      typeof r?.startMs === 'number' &&
      typeof r?.endMs === 'number' &&
      stepMs >= r.startMs &&
      stepMs <= r.endMs,
  )
}

/**
 * Record that pause-phase activity happened at `now` while `heldParent` is parked so
 * the pause exclusion window covers the full pause interval (never ending early at
 * the parent background task's completion timestamp; decisions 02f4ce2b, a2d9f38f, c1791ffa).
 */
export function recordPauseActivity(connectionId, dir = CONNECTIONS_DIR, now = Date.now()) {
  const existing = connectionId ? readTurnMarker(connectionId, dir) : null
  if (!existing?.heldParent || existing.otherWake) return false
  const prev =
    typeof existing.lastPauseActivityAt === 'number' && Number.isFinite(existing.lastPauseActivityAt)
      ? existing.lastPauseActivityAt
      : 0
  writeTurnMarker(
    connectionId,
    { lastPauseActivityAt: Math.max(prev, now), preserveExplicitReply: true },
    dir,
  )
  return true
}

/**
 * Mark that a check-job ruling settled (all entries ruled or handed back) during the
 * current mid-wait pause so subsequent parent-task work can safely restore `heldParent`
 * without mixing in-flight check ruling steps into the command trail (decisions
 * a2d9f38f & c1791ffa). When multiple check jobs are batched in one pause, `checkJobRuled`
 * only becomes true once every tracked job has settled.
 */
export function recordCheckJobRuled(
  connectionId,
  dir = CONNECTIONS_DIR,
  { jobId = null, now = Date.now() } = {},
) {
  const existing = connectionId ? readTurnMarker(connectionId, dir) : null
  if (!existing) return false
  const prevPauseAt =
    typeof existing.lastPauseActivityAt === 'number' && Number.isFinite(existing.lastPauseActivityAt)
      ? existing.lastPauseActivityAt
      : 0
  const nextPauseAt = Math.max(prevPauseAt, now)
  const trackedJobs = Array.isArray(existing.checkJobIds)
    ? existing.checkJobIds.map((id) => String(id).toLowerCase()).filter(Boolean)
    : []
  const settledJobs = Array.isArray(existing.settledCheckJobIds)
    ? [...new Set(existing.settledCheckJobIds.map((id) => String(id).toLowerCase()).filter(Boolean))]
    : []
  const normalizedJobId = typeof jobId === 'string' && jobId.trim() ? jobId.trim().toLowerCase() : null
  if (normalizedJobId && !settledJobs.includes(normalizedJobId)) {
    settledJobs.push(normalizedJobId)
  }
  const allSettled =
    trackedJobs.length === 0 ||
    !normalizedJobId ||
    trackedJobs.every((id) => settledJobs.includes(id))
  writeTurnMarker(
    connectionId,
    {
      settledCheckJobIds: settledJobs,
      checkJobRuled: allSettled,
      ...(allSettled ? { checkJobRuledAt: now } : {}),
      lastPauseActivityAt: nextPauseAt,
      preserveExplicitReply: true,
    },
    dir,
  )
  return allSettled
}

/**
 * Find the `created_at` timestamp (ms) of the latest `PLANNER_RESPONSE` step in
 * `transcriptPath` that invoked `toolName` after `afterMs`, so `PostToolUse` can bound
 * the pause exclusion window strictly before the resumed parent tool step itself.
 */
export function findLatestToolCallStepMs(transcriptPath, toolName, { afterMs = null } = {}) {
  if (!transcriptPath || !toolName) return null
  const bareTarget = String(toolName).replace(/^default_api:/, '')
  let raw = ''
  try {
    const stat = fs.statSync(transcriptPath)
    if (!stat.isFile() || stat.size === 0) return null
    const readSize = Math.min(stat.size, 262_144)
    const fd = fs.openSync(transcriptPath, 'r')
    try {
      const buf = Buffer.alloc(readSize)
      fs.readSync(fd, buf, 0, readSize, stat.size - readSize)
      raw = buf.toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null
  }
  const lines = raw.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim()
    if (!trimmed) continue
    let step
    try {
      step = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (step?.type !== 'PLANNER_RESPONSE' || !Array.isArray(step.tool_calls)) continue
    const matches = step.tool_calls.some(
      (tc) => String(tc?.name || '').replace(/^default_api:/, '') === bareTarget,
    )
    if (!matches) continue
    const stepMs = step.created_at ? Date.parse(step.created_at) : NaN
    if (!Number.isFinite(stepMs)) return null
    if (typeof afterMs === 'number' && Number.isFinite(afterMs) && stepMs < afterMs) return null
    return stepMs
  }
  return null
}

/**
 * Restore a parked parent room task (`marker.heldParent`) and its active request
 * when a parent-owned background task completes mid-turn AND the mid-wait pause
 * is no longer in flight:
 * - Never restores while any pause-owned launch (e.g. a check-job helper subagent
 *   not in `parent.ownedIds`) is still running.
 * - Never clears an active `checkJobWake` pause until every tracked check job is
 *   settled (`checkJobRuled`).
 * - Ends the `[pauseStartedAt, resumedAt]` exclusion window at the full pause end
 *   (covering helper completions, check rulings, and pause tool activity — never
 *   cutting it short at an earlier parent-launch completion timestamp) so neither
 *   trail extraction nor Stop fallback can leak check/notice steps or routine
 *   check-only responses into the person's command (decisions 02f4ce2b, a2d9f38f, c1791ffa).
 * - Restores request attribution strictly from the launch(es) that actually ended,
 *   retaining unknown attribution whenever an ended launch is unstated or cannot be
 *   tied to the parent request while another launch is parked (decision ce71a72b).
 */
export function restoreHeldParentIfResumed(
  connectionId,
  marker,
  {
    dir = CONNECTIONS_DIR,
    reconciled = null,
    latestStep = null,
    now = Date.now(),
    excludeUpToMs = null,
    requireParentNotificationStep = false,
    allowQuietNoticeResume = false,
  } = {},
) {
  if (!connectionId || !marker?.heldParent || marker.otherWake) {
    return { restored: false, marker }
  }
  const parent = marker.heldParent
  const parentOwnedIds = Array.isArray(parent.ownedIds)
    ? parent.ownedIds.filter((id) => typeof id === 'string' && id)
    : []

  // Never restore while any launch created during the mid-wait pause (such as a
  // check-job helper subagent) is still running.
  const allOutstanding = readOwnedIds(connectionId, marker, dir)
  if (allOutstanding.some((id) => !parentOwnedIds.includes(id))) {
    return { restored: false, marker }
  }

  // Never clear an in-flight check-job pause until its ruling settled.
  if (marker.checkJobWake && !marker.checkJobRuled) {
    return { restored: false, marker }
  }

  // Never clear an active for-the-record notice pause automatically just because a
  // parent background task finished asynchronously (decisions 02f4ce2b & a2d9f38f):
  // the agent may still be investigating/handling the quiet notice (alone or after
  // a check job in the same pause settled). Only restore a quiet-notice pause
  // mid-turn when the agent explicitly hands back control after finishing the
  // notice (`allowQuietNoticeResume: true`, via `devspec-serve-request.mjs resume`).
  const hasForTheRecordNotice =
    Array.isArray(marker.recordNoticeIds) && marker.recordNoticeIds.length > 0
  if (hasForTheRecordNotice && !allowQuietNoticeResume) {
    return { restored: false, marker }
  }

  // Never clear an active needs_person notice or undelivered tell_person pause
  // mid-turn before EVERY needs_person notice in the pause has had an ACCEPTED
  // notice reply from the server (or the agent explicitly hands back after
  // settling a self-fixable notice quietly via `devspec-serve-request.mjs resume`),
  // so a refused post never clears a notice that still needs attention (02f4ce2b).
  const repliedNoticeSet = new Set(
    (Array.isArray(marker.repliedNoticeIds) ? marker.repliedNoticeIds : [])
      .map((id) => String(id).toLowerCase())
      .filter(Boolean),
  )
  const pendingNeedsPersonIds = (Array.isArray(marker.noticeIds) ? marker.noticeIds : [])
    .map((id) => String(id).toLowerCase())
    .filter((id) => id && !repliedNoticeSet.has(id))
  const hasPendingNeedsPersonNotice =
    Array.isArray(marker.noticeIds) &&
    marker.noticeIds.length > 0 &&
    (pendingNeedsPersonIds.length > 0 || !marker.acceptedNoticeReplyAt)
  if (hasPendingNeedsPersonNotice && !allowQuietNoticeResume) {
    return { restored: false, marker }
  }
  const hasPendingTellPerson =
    Boolean(marker.tellPerson) && !marker.personToldAt && !marker.acceptedNoticeReplyAt
  if (hasPendingTellPerson) {
    return { restored: false, marker }
  }

  // Identify ONLY the parent-owned launch(es) that actually completed and their
  // completion timestamp, PLUS the latest completion timestamp of any pause-owned
  // launch (such as a check-ruling helper subagent) so the exclusion window covers
  // the entire pause interval.
  const endedParentIds = []
  let completedAtMs = null
  let endedPauseLaunchAtMs = null
  let notificationText = ''
  let latestStepIsParentCompletion = false

  const noteEnded = (id, atMs = null, text = '') => {
    if (typeof id === 'string' && id && !endedParentIds.includes(id)) {
      endedParentIds.push(id)
    }
    if (typeof atMs === 'number' && Number.isFinite(atMs)) {
      completedAtMs = completedAtMs === null ? atMs : Math.max(completedAtMs, atMs)
    }
    if (text && !notificationText) {
      notificationText = text
    }
  }

  const notePauseEnded = (atMs) => {
    if (typeof atMs === 'number' && Number.isFinite(atMs)) {
      endedPauseLaunchAtMs =
        endedPauseLaunchAtMs === null ? atMs : Math.max(endedPauseLaunchAtMs, atMs)
    }
  }

  if (Array.isArray(reconciled?.endedOwnedDetails)) {
    for (const detail of reconciled.endedOwnedDetails) {
      if (parentOwnedIds.length === 0 || parentOwnedIds.includes(detail.id)) {
        noteEnded(detail.id, detail.atMs ?? null, detail.content || '')
      } else {
        notePauseEnded(detail.atMs ?? null)
      }
    }
  } else if (Array.isArray(reconciled?.endedOwnedIds)) {
    for (const id of reconciled.endedOwnedIds) {
      if (parentOwnedIds.length === 0 || parentOwnedIds.includes(id)) {
        noteEnded(id, null, '')
      }
    }
  }

  const ownedLines = readOwnedLines(connectionId, marker, dir)
  for (const entry of ownedLines) {
    if (typeof entry.ended !== 'string') continue
    const endedMs = Date.parse(entry.ended)
    const validEndedMs = Number.isFinite(endedMs) ? endedMs : null
    if (parentOwnedIds.length > 0 && parentOwnedIds.includes(entry.id)) {
      noteEnded(entry.id, validEndedMs, '')
    } else if (parentOwnedIds.length > 0 && !parentOwnedIds.includes(entry.id)) {
      notePauseEnded(validEndedMs)
    }
  }

  if (
    latestStep?.type === 'SYSTEM_MESSAGE' &&
    typeof latestStep.content === 'string' &&
    !latestStep.content.includes('[DevSpec Remote Wake]') &&
    isBackgroundTaskNotification(latestStep.content)
  ) {
    const stepMs = latestStep.created_at ? Date.parse(latestStep.created_at) : NaN
    const matchedIds = parentOwnedIds.filter((id) => stepMatchesOwnedId(latestStep.content, id))
    if (matchedIds.length > 0) {
      latestStepIsParentCompletion = true
      for (const id of matchedIds) {
        noteEnded(id, Number.isFinite(stepMs) ? stepMs : null, latestStep.content)
      }
    } else if (parentOwnedIds.length === 0) {
      latestStepIsParentCompletion = true
      noteEnded('__parent_bg__', Number.isFinite(stepMs) ? stepMs : null, latestStep.content)
    }
  }

  if (requireParentNotificationStep && !latestStepIsParentCompletion) {
    return { restored: false, marker }
  }

  if (endedParentIds.length === 0) {
    return { restored: false, marker }
  }

  if (!notificationText && Array.isArray(reconciled?.matchedSystemMessages) && reconciled.matchedSystemMessages.length > 0) {
    const matchingMsg = reconciled.matchedSystemMessages.find((msg) =>
      endedParentIds.some((id) => id !== '__parent_bg__' && stepMatchesOwnedId(msg, id)),
    )
    if (matchingMsg) notificationText = matchingMsg
  }

  const pauseStartMs = typeof marker.pauseStartedAt === 'number' && Number.isFinite(marker.pauseStartedAt)
    ? marker.pauseStartedAt
    : null
  const pauseFloorCandidates = [
    completedAtMs,
    endedPauseLaunchAtMs,
    typeof marker.checkJobRuledAt === 'number' && Number.isFinite(marker.checkJobRuledAt)
      ? marker.checkJobRuledAt
      : null,
    typeof marker.lastPauseActivityAt === 'number' && Number.isFinite(marker.lastPauseActivityAt)
      ? marker.lastPauseActivityAt
      : null,
  ].filter((v) => typeof v === 'number' && Number.isFinite(v))
  const pauseFloorMs = pauseFloorCandidates.length > 0 ? Math.max(...pauseFloorCandidates) : null
  const resumedAtMs =
    typeof excludeUpToMs === 'number' && Number.isFinite(excludeUpToMs)
      ? pauseFloorMs !== null
        ? Math.max(pauseFloorMs, excludeUpToMs)
        : excludeUpToMs
      : pauseFloorMs !== null
        ? Math.max(now, pauseFloorMs)
        : now
  const nextExcludedRanges =
    pauseStartMs !== null
      ? appendExcludedRange(marker.excludedRanges, pauseStartMs, resumedAtMs)
      : normalizeExcludedRanges(marker.excludedRanges)

  const restoredMarker = writeTurnMarker(
    connectionId,
    {
      held: false,
      heldParent: null,
      remoteTurn: Boolean(parent.remoteTurn),
      localPromptMirrored: Boolean(parent.localPromptMirrored),
      localTurn: parent.localTurn || null,
      otherWake: Boolean(parent.otherWake),
      backgroundContinuation: true,
      noticeIds: [],
      recordNoticeIds: [],
      checkJobWake: false,
      checkJobIds: [],
      settledCheckJobIds: [],
      checkJobRuled: false,
      checkJobRuledAt: null,
      lastPauseActivityAt: null,
      pauseStartedAt: null,
      resumedFromPauseAt: resumedAtMs,
      excludedRanges: nextExcludedRanges,
      tellPerson: false,
      noticeReplyAt: null,
      acceptedNoticeReplyAt: null,
      repliedNoticeIds: [],
      personToldAt: null,
      preserveExplicitReply: true,
    },
    dir,
  )

  try {
    const reqState = readRequestState(connectionId, { dir })
    const endedRealIds = endedParentIds.filter((id) => id !== '__parent_bg__')
    const notifiedEndedKeys = notificationText ? notifiedKeys(notificationText) : []
    const endedTrackedLaunches = []
    const seenEndedLaunches = new Set()
    let anyEndedUntracked = false

    // Check each distinct ended launch ID from the owned log / reconciliation.
    for (const id of endedRealIds) {
      const launch = reqState.launches.get(id)
      if (launch) {
        if (!seenEndedLaunches.has(launch)) {
          seenEndedLaunches.add(launch)
          endedTrackedLaunches.push(launch)
        }
      } else {
        anyEndedUntracked = true
      }
    }

    // `notifiedKeys(notificationText)` extracts candidate aliases for the SAME
    // completion message (e.g. both `<convId>/task-415` and its short alias
    // `task-415`). Match ANY alias to its launch just as `requestForWake` does,
    // without treating a short alias as a second untracked launch (ce71a72b).
    if (notifiedEndedKeys.length > 0) {
      let matchedNotificationLaunch = false
      for (const key of notifiedEndedKeys) {
        const launch = reqState.launches.get(key)
        if (launch) {
          matchedNotificationLaunch = true
          if (!seenEndedLaunches.has(launch)) {
            seenEndedLaunches.add(launch)
            endedTrackedLaunches.push(launch)
          }
        }
      }
      if (!matchedNotificationLaunch) {
        anyEndedUntracked = true
      }
    }

    if (endedTrackedLaunches.length > 0) {
      // Authoritative attribution from ALL completed launches in this pause:
      // if ANY completed launch is unstated, untracked (missing from launches),
      // or has no open requester, retain unknown attribution rather than
      // dropping it and crediting another launch's requester (decision ce71a72b).
      const endedRefs = []
      let anyEndedUnstated = false
      for (const launch of endedTrackedLaunches) {
        const launchRefs = []
        for (const candidate of [launch.request, ...(launch.also ?? [])]) {
          if (reqState.open.has(candidate) || candidate === 'none') {
            if (!launchRefs.includes(candidate)) launchRefs.push(candidate)
          }
        }
        if (launch.request === UNSTATED || launchRefs.length === 0) {
          anyEndedUnstated = true
        } else {
          for (const ref of launchRefs) {
            if (!endedRefs.includes(ref)) endedRefs.push(ref)
          }
        }
      }

      if (anyEndedUnstated || anyEndedUntracked || endedRefs.length === 0) {
        setCurrentRequest(connectionId, UNSTATED, { dir })
      } else {
        // Record any notified keys from notificationText, then ALWAYS restore the
        // full set of ended requesters (including `joined` when two launches for
        // different people finished in the same pause, even if `notificationText`
        // only names one of them — decision ce71a72b).
        if (notificationText) {
          for (const key of notifiedKeys(notificationText)) {
            appendRequestEvent(connectionId, { op: 'notified', key }, { dir })
          }
        }
        setCurrentRequest(connectionId, endedRefs.at(-1), { dir })
        for (const extra of endedRefs.slice(0, -1)) {
          appendRequestEvent(connectionId, { op: 'joined', id: extra }, { dir })
        }
      }
    } else {
      let restoredFromNotification = false
      if (notificationText) {
        const arrival = promptArrival({
          fromAPerson: false,
          origin: 'task-notification',
          text: notificationText,
          midTurn: false,
          state: reqState,
        })
        const hasCurrent = arrival.events.some((ev) => ev.op === 'current' && ev.ref !== null)
        if (hasCurrent) {
          for (const event of arrival.events) {
            appendRequestEvent(connectionId, event, { dir })
          }
          restoredFromNotification = true
        }
      }
      if (!restoredFromNotification) {
        // Never infer requester attribution from whichever request was current
        // when the pause began: an untracked launch without a request record
        // must leave attribution unknown (decision ce71a72b).
        setCurrentRequest(connectionId, UNSTATED, { dir })
      }
    }
  } catch {
    /* non-fatal */
  }

  return { restored: true, marker: restoredMarker }
}

/**
 * When a parent background launch has already completed during a quiet notice pause
 * (for-the-record notice or self-fixable needs_person notice with no reply needed)
 * and all check jobs / pause helpers / tell_person obligations are clear, return an
 * ephemeral PreInvocation hint telling the agent the exact command to hand back
 * to its parked room task once it finishes handling the notice (decisions 02f4ce2b,
 * a2d9f38f; item 972c8895).
 */
export function pendingParentResumeHint(
  connectionId,
  marker,
  {
    dir = CONNECTIONS_DIR,
    reconciled = null,
    latestStep = null,
    scriptPath = SERVE_REQUEST_SCRIPT,
  } = {},
) {
  if (!connectionId || !marker?.heldParent || marker.otherWake) return null
  const parent = marker.heldParent
  const parentOwnedIds = Array.isArray(parent.ownedIds)
    ? parent.ownedIds.filter((id) => typeof id === 'string' && id)
    : []
  const allOutstanding = readOwnedIds(connectionId, marker, dir)
  if (allOutstanding.some((id) => !parentOwnedIds.includes(id))) return null
  if (marker.checkJobWake && !marker.checkJobRuled) return null
  const hasPendingTellPerson =
    Boolean(marker.tellPerson) && !marker.personToldAt && !marker.acceptedNoticeReplyAt
  if (hasPendingTellPerson) return null

  const hasForTheRecordNotice =
    Array.isArray(marker.recordNoticeIds) && marker.recordNoticeIds.length > 0
  const repliedNoticeSet = new Set(
    (Array.isArray(marker.repliedNoticeIds) ? marker.repliedNoticeIds : [])
      .map((id) => String(id).toLowerCase())
      .filter(Boolean),
  )
  const pendingNeedsPersonIds = (Array.isArray(marker.noticeIds) ? marker.noticeIds : [])
    .map((id) => String(id).toLowerCase())
    .filter((id) => id && !repliedNoticeSet.has(id))
  const hasPendingNeedsPersonNotice =
    Array.isArray(marker.noticeIds) &&
    marker.noticeIds.length > 0 &&
    (pendingNeedsPersonIds.length > 0 || !marker.acceptedNoticeReplyAt)
  if (!hasForTheRecordNotice && !hasPendingNeedsPersonNotice) return null

  let hasEndedParent = false
  if (Array.isArray(reconciled?.endedOwnedDetails)) {
    hasEndedParent = reconciled.endedOwnedDetails.some(
      (d) => parentOwnedIds.length === 0 || parentOwnedIds.includes(d.id),
    )
  } else if (Array.isArray(reconciled?.endedOwnedIds)) {
    hasEndedParent = reconciled.endedOwnedIds.some(
      (id) => parentOwnedIds.length === 0 || parentOwnedIds.includes(id),
    )
  }
  if (!hasEndedParent) {
    const ownedLines = readOwnedLines(connectionId, marker, dir)
    hasEndedParent = ownedLines.some(
      (entry) =>
        typeof entry.ended === 'string' &&
        parentOwnedIds.length > 0 &&
        parentOwnedIds.includes(entry.id),
    )
  }
  if (
    !hasEndedParent &&
    latestStep?.type === 'SYSTEM_MESSAGE' &&
    typeof latestStep.content === 'string' &&
    !latestStep.content.includes('[DevSpec Remote Wake]') &&
    isBackgroundTaskNotification(latestStep.content)
  ) {
    hasEndedParent =
      parentOwnedIds.length === 0 ||
      parentOwnedIds.some((id) => stepMatchesOwnedId(latestStep.content, id))
  }
  if (!hasEndedParent) return null

  return {
    ephemeralMessage: [
      'Your parked room task has background work that finished while this DevSpec notice pause is open.',
      'Finish handling the notice first — all notice work stays out of the room while the pause is active.',
      'When you are done with the notice and ready to resume the parked room task mid-turn, run:',
      `  node ${JSON.stringify(scriptPath)} resume --connection-id ${connectionId}`,
      '(Or end your turn if nothing more is needed.)',
    ].join('\n'),
  }
}

/** PreInvocation helper: returns `{ ephemeralMessage }` when a quiet notice pause has a completed parent task waiting to resume. */
export function pendingParentResumeForHook(
  raw,
  { env = process.env, home = os.homedir(), connectionsDir = null, scriptPath = SERVE_REQUEST_SCRIPT } = {},
) {
  try {
    const dir = connectionsDir ?? path.join(home, '.devspec', 'remote-control', 'connections')
    const conversationId = resolveHookConversationId(raw, env)
    const state = loadState(conversationId, {
      connectionsDir: dir,
      legacyPath: path.join(home, '.devspec', 'remote-control.json'),
    })
    const connectionId = state?.connection_id
    if (!connectionId) return null
    const marker = readTurnMarker(connectionId, dir)
    if (!marker?.heldParent || marker.otherWake) return null
    const effectiveTranscriptPath = parseTranscriptPath(raw) || state?.transcript_path || null
    const reconciled = reconcileCompletedOwnedWork(connectionId, marker, effectiveTranscriptPath, dir)
    const latestStep = extractLatestTranscriptStep(effectiveTranscriptPath)
    return pendingParentResumeHint(connectionId, marker, { dir, reconciled, latestStep, scriptPath })
  } catch {
    return null
  }
}

/**
 * Mark the turn remote and record what one delivered inbox entry brought into it
 * (notice-reply.mjs): its notice ids, or that something other than a notice woke it.
 * The listener and the wait script call this for each entry they deliver.
 */
export function recordTurnWake(connectionId, entry, dir = CONNECTIONS_DIR, now = Date.now()) {
  if (!connectionId) return null
  const wake = turnWakeFromEntry(entry)
  let existing = readTurnMarker(connectionId, dir)
  // A stale marker (isTurnMarkerActive) is a turn that ended without its Stop, and
  // every reader already treats it as no turn. The wake delivered now starts a new
  // one, so it must not inherit that turn's startedAt or what woke it: the marker would
  // stay stale and every queued check job and notice behind this one would be released
  // at once instead of one per turn (item b68df72d). Only the marker goes; writing the
  // fresh one below clears the old turn's reply and trail state as any new turn does.
  if (existing && !isTurnMarkerActive(existing, now)) {
    try {
      fs.rmSync(turnMarkerPath(connectionId, dir), { force: true })
    } catch {
      /* non-fatal, as every marker write here is */
    }
    existing = null
  }
  // A notice or check job is not a command: one that arrives during a turn typed at
  // the terminal leaves it a local turn, so that turn's answer keeps its local-turn flags.
  const nonCommandWake = Boolean(wake?.noticeIds || wake?.recordNoticeIds || wake?.checkJobWake)
  // Check `existing?.heldParent` BEFORE `existing?.held === true`: if Stop held
  // an already-parked pause open while waiting on a helper subagent and a second
  // check job or notice wakes the agent, merge into the existing pause instead of
  // replacing its checkJobIds / noticeIds / settledCheckJobIds (decision a2d9f38f).
  if (existing?.heldParent && !existing?.otherWake && nonCommandWake) {
    const merged = mergeTurnWake(existing, wake)
    const settled = Array.isArray(existing.settledCheckJobIds)
      ? existing.settledCheckJobIds.map((id) => String(id).toLowerCase())
      : []
    const mergedJobs = Array.isArray(merged.checkJobIds)
      ? merged.checkJobIds.map((id) => String(id).toLowerCase())
      : []
    const resetRuled =
      Boolean(wake?.checkJobWake) &&
      (mergedJobs.length === 0 || mergedJobs.some((id) => !settled.includes(id)))
    const replied = Array.isArray(existing.repliedNoticeIds)
      ? existing.repliedNoticeIds.map((id) => String(id).toLowerCase())
      : []
    const mergedNotices = Array.isArray(merged.noticeIds)
      ? merged.noticeIds.map((id) => String(id).toLowerCase())
      : []
    const hasUnrepliedNotice = mergedNotices.some((id) => !replied.includes(id))
    return writeTurnMarker(
      connectionId,
      {
        held: false,
        heldParent: existing.heldParent,
        remoteTurn: true,
        ...merged,
        ...(resetRuled ? { checkJobRuled: false, checkJobRuledAt: null } : {}),
        ...(hasUnrepliedNotice ? { noticeReplyAt: null, acceptedNoticeReplyAt: null } : {}),
        lastPauseActivityAt: Math.max(
          typeof existing.lastPauseActivityAt === 'number' ? existing.lastPauseActivityAt : 0,
          now,
        ),
        preserveExplicitReply: true,
      },
      dir,
    )
  }
  if (existing?.held === true) {
    if (nonCommandWake) {
      return writeTurnMarker(
        connectionId,
        {
          held: false,
          heldParent: snapshotHeldParent(existing, { connectionId, dir }),
          remoteTurn: true,
          localPromptMirrored: false,
          localTurn: null,
          otherWake: false,
          backgroundContinuation: false,
          noticeIds: wake?.noticeIds ?? [],
          recordNoticeIds: wake?.recordNoticeIds ?? [],
          checkJobWake: Boolean(wake?.checkJobWake),
          checkJobIds: wake?.checkJobIds ?? [],
          settledCheckJobIds: [],
          checkJobRuled: false,
          checkJobRuledAt: null,
          lastPauseActivityAt: now,
          pauseStartedAt: now,
          excludedRanges: normalizeExcludedRanges(existing.excludedRanges),
          tellPerson: false,
          noticeReplyAt: null,
          acceptedNoticeReplyAt: null,
          repliedNoticeIds: [],
          personToldAt: null,
          preserveExplicitReply: true,
        },
        dir,
      )
    }
    return writeTurnMarker(
      connectionId,
      {
        held: false,
        heldParent: null,
        remoteTurn: true,
        ...mergeTurnWake(existing, wake),
        preserveExplicitReply: true,
      },
      dir,
    )
  }
  const remote = existing && nonCommandWake ? {} : { remoteTurn: true }
  return writeTurnMarker(connectionId, { ...remote, ...mergeTurnWake(existing, wake) }, dir)
}

/**
 * The notices the current turn is about when the plugin can tell for certain, else
 * null (`turnNoticeIds` in notice-reply.mjs). Read fresh each time it is asked.
 */
export function currentTurnNoticeIds(
  connectionId,
  { dir = CONNECTIONS_DIR, connectionState = null, marker = undefined } = {},
) {
  if (!connectionId) return null
  return turnNoticeIds({
    marker: marker === undefined ? readTurnMarker(connectionId, dir) : marker,
    requestState: readRequestState(connectionId, { dir }),
    connectionState,
  })
}

/** Of those, the notices that need a person (`turnReplyNoticeIds`). */
export function currentTurnReplyNoticeIds(
  connectionId,
  { dir = CONNECTIONS_DIR, connectionState = null, marker = undefined } = {},
) {
  if (!connectionId) return null
  return turnReplyNoticeIds({
    marker: marker === undefined ? readTurnMarker(connectionId, dir) : marker,
    requestState: readRequestState(connectionId, { dir }),
    connectionState,
  })
}

/** The ids PreToolUse puts on a plain post in a notice-only turn (`turnStampNoticeIds`). */
export function currentTurnStampNoticeIds(
  connectionId,
  { dir = CONNECTIONS_DIR, connectionState = null, marker = undefined } = {},
) {
  if (!connectionId) return null
  return turnStampNoticeIds({
    marker: marker === undefined ? readTurnMarker(connectionId, dir) : marker,
    requestState: readRequestState(connectionId, { dir }),
    connectionState,
  })
}

/**
 * True when the current turn is routine (`isRoutineTurn`): woken only by check jobs and
 * notices DevSpec labelled for the record.
 */
export function isCurrentTurnRoutine(
  connectionId,
  { dir = CONNECTIONS_DIR, connectionState = null, marker = undefined } = {},
) {
  if (!connectionId) return false
  return isRoutineTurn({
    marker: marker === undefined ? readTurnMarker(connectionId, dir) : marker,
    requestState: readRequestState(connectionId, { dir }),
    connectionState,
  })
}

/** Note on the turn marker that a write in it carried DevSpec's `tell_person` mark. */
export function recordTellPerson(connectionId, dir = CONNECTIONS_DIR) {
  if (!connectionId || !readTurnMarker(connectionId, dir)) return false
  writeTurnMarker(connectionId, { tellPerson: true, preserveExplicitReply: true }, dir)
  return true
}

/**
 * True when the current turn was woken solely by DevSpec check job(s), with no command,
 * terminal prompt, automation run, or system notice open on the turn.
 */
export function isCurrentTurnCheckJobOnly(
  connectionId,
  { dir = CONNECTIONS_DIR, connectionState = null, marker = undefined } = {},
) {
  if (!connectionId) return false
  return isCheckJobOnlyTurn({
    marker: marker === undefined ? readTurnMarker(connectionId, dir) : marker,
    requestState: readRequestState(connectionId, { dir }),
    connectionState,
  })
}

/**
 * Note on the turn marker that the agent initiated a reply to its notices (for
 * the Stop fallback). Mid-wait pause restoration waits for `recordNoticeReplyAccepted`
 * in PostToolUse so a server-refused post never clears a pending notice (decision 02f4ce2b).
 */
export function recordNoticeReply(connectionId, dir = CONNECTIONS_DIR, now = Date.now()) {
  if (!connectionId || !readTurnMarker(connectionId, dir)) return false
  writeTurnMarker(connectionId, { noticeReplyAt: now, preserveExplicitReply: true }, dir)
  return true
}

/**
 * Record in PostToolUse that DevSpec ACCEPTED a notice reply (`post_session_message`
 * with `system_notice_ids`), tracking the exact notice ids answered so a refused post
 * or a later needs-a-person notice in the same pause is never cleared prematurely
 * (decision 02f4ce2b).
 */
export function recordNoticeReplyAccepted(
  connectionId,
  dir = CONNECTIONS_DIR,
  now = Date.now(),
  { noticeIds = null } = {},
) {
  const existing = connectionId ? readTurnMarker(connectionId, dir) : null
  if (!existing) return false
  const prevReplied = Array.isArray(existing.repliedNoticeIds)
    ? existing.repliedNoticeIds.map((id) => String(id).toLowerCase()).filter(Boolean)
    : []
  const newlyReplied =
    Array.isArray(noticeIds) && noticeIds.length > 0
      ? noticeIds.map((id) => String(id).toLowerCase()).filter(Boolean)
      : (Array.isArray(existing.noticeIds) ? existing.noticeIds : [])
          .map((id) => String(id).toLowerCase())
          .filter(Boolean)
  const repliedNoticeIds = [...new Set([...prevReplied, ...newlyReplied])]
  writeTurnMarker(
    connectionId,
    {
      noticeReplyAt: now,
      acceptedNoticeReplyAt: now,
      repliedNoticeIds,
      preserveExplicitReply: true,
    },
    dir,
  )
  return true
}

/**
 * Note on the turn marker that the agent told its person itself with
 * `devspec-tell-person.mjs` (tell-person.mjs), so Stop's backstop posts nothing more.
 */
export function recordPersonTold(connectionId, dir = CONNECTIONS_DIR, now = Date.now()) {
  if (!connectionId || !readTurnMarker(connectionId, dir)) return false
  writeTurnMarker(connectionId, { personToldAt: now, preserveExplicitReply: true }, dir)
  return true
}

/**
 * Stop's backstop for `tell_person` (`semantics.notice_audience.telling_anyway`): the
 * agent's last words, posted on DevSpec's speech lane because a turn no room command
 * started has no turn for an ordinary post to join (tell-person.mjs, item e086163c).
 * The source id is the turn's and the words', so a Stop that runs again for the same
 * turn stores them once. A refusal is reported here and handed back to the agent at
 * its next step (pre-invocation.mjs), never dropped.
 */
async function postTellPersonBackstop({ call, mcpUrl, token, state, connectionId, agentName, message, marker, connectionsDir }) {
  const args = tellPersonArguments({
    connectionId,
    message,
    sourceId: speechSourceId('tell-person-backstop', connectionId, marker?.startedAt, message),
    agentName,
    model: telemetryModel(connectionId ? readConnectionTelemetry(connectionId) : null),
  })
  const sent = await postToPerson({ call, mcpUrl, token, connectionCapability: state?.connection_capability, args })
  if (!sent.ok) {
    stageHandBack(connectionId, { message, refusal: sent.refusal }, connectionsDir)
    process.stderr.write(
      `[devspec-remote] the tell_person post did not land; handed back to the agent: ${JSON.stringify(sent.refusal)}\n`,
    )
  }
  return sent
}

export function ownedWorkPath(connectionId, dir = CONNECTIONS_DIR) {
  return path.join(dir, `${connectionId}.turn-owned.jsonl`)
}

export function clearTurnMarker(connectionId, dir = CONNECTIONS_DIR) {
  if (!connectionId) return
  try {
    fs.rmSync(turnMarkerPath(connectionId, dir), { force: true })
    fs.rmSync(ownedWorkPath(connectionId, dir), { force: true })
    fs.rmSync(trailStatePath(connectionId, dir), { force: true })
  } catch {
    /* ignore */
  }
}

export function recordOwnedLaunch(
  connectionId,
  launch,
  { dir = CONNECTIONS_DIR, now = Date.now() } = {},
) {
  if (!connectionId || !launch?.id) return false
  const marker = readTurnMarker(connectionId, dir)
  if (!marker) return false
  try {
    ensurePrivateDir(dir)
    const line = {
      id: String(launch.id),
      kind: launch.kind || 'task',
      turn: marker.startedAt,
      at: new Date(now).toISOString(),
    }
    if (launch.label) line.label = String(launch.label)
    if (launch.model) line.model = String(launch.model)
    if (launch.parent) line.parent = String(launch.parent)
    fs.appendFileSync(ownedWorkPath(connectionId, dir), `${JSON.stringify(line)}\n`, {
      mode: 0o600,
    })
    return true
  } catch {
    return false
  }
}

export function recordOwnedEnd(
  connectionId,
  id,
  { status = 'completed', dir = CONNECTIONS_DIR, now = Date.now() } = {},
) {
  const marker = readTurnMarker(connectionId, dir)
  if (!marker || typeof id !== 'string' || !id) return false
  const lines = readOwnedLines(connectionId, marker, dir)
  if (!lines.some((entry) => entry.id === id && typeof entry.ended !== 'string')) return false
  if (lines.some((entry) => entry.id === id && typeof entry.ended === 'string')) return false
  try {
    fs.appendFileSync(
      ownedWorkPath(connectionId, dir),
      `${JSON.stringify({ id, turn: marker.startedAt, ended: new Date(now).toISOString(), status })}\n`,
      { mode: 0o600 },
    )
    return true
  } catch {
    return false
  }
}

export function readOwnedLines(connectionId, marker, dir = CONNECTIONS_DIR) {
  if (!connectionId || typeof marker?.startedAt !== 'number') return []
  let text = ''
  try {
    text = fs.readFileSync(ownedWorkPath(connectionId, dir), 'utf8')
  } catch {
    return []
  }
  const lines = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line)
      if (entry?.turn === marker.startedAt && typeof entry.id === 'string') lines.push(entry)
    } catch {
      /* ignore malformed line */
    }
  }
  return lines
}

export function readOwnedIds(
  connectionId,
  marker,
  dir = CONNECTIONS_DIR,
  { now = Date.now(), maxAgeMs = null } = {},
) {
  const lines = readOwnedLines(connectionId, marker, dir)
  const ended = new Set(
    lines.filter((e) => typeof e.ended === 'string').map((e) => e.id),
  )
  const ids = []
  for (const entry of lines) {
    if (typeof entry.ended === 'string' || ended.has(entry.id) || ids.includes(entry.id)) continue
    if (typeof entry.at === 'string' && Number.isFinite(maxAgeMs) && maxAgeMs > 0) {
      const launchedMs = Date.parse(entry.at)
      if (Number.isFinite(launchedMs) && now - launchedMs > maxAgeMs) continue
    }
    ids.push(entry.id)
  }
  return ids
}

function stepMatchesOwnedId(stepContent, id) {
  if (typeof stepContent !== 'string' || typeof id !== 'string' || !id) return false
  if (stepContent.includes(id)) return true
  const slashIdx = id.lastIndexOf('/')
  if (slashIdx > 0) {
    const shortId = id.slice(slashIdx + 1)
    if (
      shortId &&
      (stepContent.includes(`"${shortId}"`) ||
        stepContent.includes(`/${shortId}.log`) ||
        stepContent.includes(`/${shortId}`))
    ) {
      return true
    }
  }
  return false
}

/**
 * Reconcile background task and subagent launches (`GENERIC` steps) and completions
 * (`<SYSTEM_MESSAGE>` steps) from `transcript.jsonl`, whether the completion arrived
 * while the turn was still running (`existingMarker.held === false`) or while Stop
 * was holding the turn open.
 */
export function reconcileCompletedOwnedWork(
  connectionId,
  marker,
  transcriptPath,
  dir = CONNECTIONS_DIR,
) {
  if (!connectionId || !transcriptPath) return
  let ownedLines = marker ? readOwnedLines(connectionId, marker, dir) : []
  let ownedIds = marker ? readOwnedIds(connectionId, marker, dir) : []
  let reqState = readRequestState(connectionId, { dir })
  let unnotifiedKeys = [...new Set(reqState.launches.values())]
    .filter((launch) => launch.notifies && !launch.notified)
    .map((launch) => launch.key)
  if (!marker && ownedIds.length === 0 && unnotifiedKeys.length === 0 && reqState.open.size === 0) {
    return
  }

  let raw = ''
  try {
    const stat = fs.statSync(transcriptPath)
    if (!stat.isFile() || stat.size === 0) return
    const readSize = Math.min(stat.size, 262_144)
    const fd = fs.openSync(transcriptPath, 'r')
    try {
      const buf = Buffer.alloc(readSize)
      fs.readSync(fd, buf, 0, readSize, stat.size - readSize)
      raw = buf.toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return
  }

  const knownOwned = new Set(ownedLines.map((e) => e.id))
  const endedOwned = new Set(
    ownedLines.filter((e) => typeof e.ended === 'string').map((e) => e.id),
  )
  const newlyEndedOwned = []
  const endedOwnedDetails = []
  const newlyNotified = new Set()
  const matchedSystemMessages = []
  let seenPlannerResponse = false
  let pendingPlannerTools = []

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let step
    try {
      step = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (typeof marker?.startedAt === 'number' && step?.created_at) {
      const stepMs = Date.parse(step.created_at)
      if (Number.isFinite(stepMs) && stepMs < marker.startedAt - 1000) continue
    }
    if (step?.type === 'PLANNER_RESPONSE') {
      seenPlannerResponse = true
      pendingPlannerTools = Array.isArray(step.tool_calls)
        ? step.tool_calls.map((tc) => ({
            name: String(tc?.name || '').replace(/^default_api:/, ''),
            args: tc?.args && typeof tc.args === 'object' ? tc.args : {},
          }))
        : []
      continue
    }
    if (step?.type === 'GENERIC' && typeof step.content === 'string') {
      const currentTool = pendingPlannerTools.shift() || null
      const canBeRunCommand =
        (!seenPlannerResponse &&
          !step.content.includes('Task Description: Timer:') &&
          !step.content.includes('Task Description: Cron:')) ||
        currentTool?.name === 'run_command'
      const canBeSchedule =
        (!seenPlannerResponse && step.content.includes('Task Description: Timer:')) ||
        currentTool?.name === 'schedule'
      const canBeSubagent = !seenPlannerResponse || currentTool?.name === 'invoke_subagent'
      const runCommandInput = currentTool?.name === 'run_command' ? currentTool.args : null
      const scheduleInput = currentTool?.name === 'schedule' ? currentTool.args : null
      const subagentInput = currentTool?.name === 'invoke_subagent' ? currentTool.args : null

      if (currentTool?.name === 'manage_task') {
        const action = String(currentTool.args?.Action ?? currentTool.args?.action ?? '').toLowerCase()
        const rawKilledId = String(currentTool.args?.TaskId ?? currentTool.args?.taskId ?? '').trim()
        if (action === 'kill' && rawKilledId && !/^Error:/m.test(step.content)) {
          for (const id of ownedIds) {
            if (!endedOwned.has(id) && (id === rawKilledId || id.endsWith(`/${rawKilledId}`))) {
              recordOwnedEnd(connectionId, id, { status: 'killed', dir })
              endedOwned.add(id)
            }
          }
          for (const key of unnotifiedKeys) {
            if (
              !newlyNotified.has(key) &&
              (key === rawKilledId || key.endsWith(`/${rawKilledId}`))
            ) {
              appendRequestEvent(connectionId, { op: 'notified', key }, { dir })
              newlyNotified.add(key)
            }
          }
        }
        continue
      }

      const bgId = canBeRunCommand ? extractBackgroundCommandTaskId(step.content) : null
      if (bgId) {
        const cmdLine = String(
          runCommandInput?.CommandLine || runCommandInput?.command || '',
        )
        const isDaemon =
          runCommandInput?.IsDaemon === true || runCommandInput?.IsDaemon === 'true'
        const isPlumbing = isDaemon || isRemotePlumbingBackgroundCommand(cmdLine)
        if (!isPlumbing) {
          const id = bgId
          const label =
            unquoteTranscriptString(runCommandInput?.toolSummary) ||
            unquoteTranscriptString(runCommandInput?.CommandLine) ||
            'background command'
          if (marker && !knownOwned.has(id)) {
            if (recordOwnedLaunch(connectionId, { id, kind: 'command', label }, { dir })) {
              knownOwned.add(id)
              if (!ownedIds.includes(id)) ownedIds.push(id)
            }
          }
          if (!reqState.launches.has(id)) {
            const { request, also } = requestForLaunch(reqState)
            appendRequestEvent(
              connectionId,
              { op: 'launch', key: id, kind: 'shell', notifies: true, request, also },
              { dir },
            )
            reqState = readRequestState(connectionId, { dir })
            if (!unnotifiedKeys.includes(id)) unnotifiedKeys.push(id)
          }
        }
      }
      const timerId =
        canBeSchedule && (!scheduleInput || isOneShotScheduleTimer(scheduleInput))
          ? extractBackgroundCommandTaskId(step.content)
          : null
      if (timerId) {
        const label =
          unquoteTranscriptString(scheduleInput?.Prompt ?? scheduleInput?.prompt) || 'timer'
        if (marker && !knownOwned.has(timerId)) {
          if (recordOwnedLaunch(connectionId, { id: timerId, kind: 'timer', label }, { dir })) {
            knownOwned.add(timerId)
            if (!ownedIds.includes(timerId)) ownedIds.push(timerId)
          }
        }
        if (!reqState.launches.has(timerId)) {
          const { request, also } = requestForLaunch(reqState)
          appendRequestEvent(
            connectionId,
            { op: 'launch', key: timerId, kind: 'timer', notifies: true, request, also },
            { dir },
          )
          reqState = readRequestState(connectionId, { dir })
          if (!unnotifiedKeys.includes(timerId)) unnotifiedKeys.push(timerId)
        }
      }
      const subMatch = canBeSubagent
        ? step.content.match(
            /Created the following subagent:[\s\S]*?"conversationId"\s*:\s*"([^"]+)"/,
          )
        : null
      if (subMatch) {
        const id = subMatch[1]
        const label =
          unquoteTranscriptString(subagentInput?.Role) ||
          unquoteTranscriptString(subagentInput?.TypeName) ||
          'subagent'
        if (marker && !knownOwned.has(id)) {
          if (recordOwnedLaunch(connectionId, { id, kind: 'subagent', label }, { dir })) {
            knownOwned.add(id)
            if (!ownedIds.includes(id)) ownedIds.push(id)
          }
        }
        if (!reqState.launches.has(id)) {
          const { request, also } = requestForLaunch(reqState)
          appendRequestEvent(
            connectionId,
            { op: 'launch', key: id, kind: 'subagent', notifies: true, request, also },
            { dir },
          )
          reqState = readRequestState(connectionId, { dir })
          if (!unnotifiedKeys.includes(id)) unnotifiedKeys.push(id)
        }
      }
      continue
    }
    if (step?.type !== 'SYSTEM_MESSAGE' || typeof step.content !== 'string') continue
    const stepMs = step?.created_at ? Date.parse(step.created_at) : NaN
    const stepAtMs = Number.isFinite(stepMs) ? stepMs : null
    let stepMatched = false
    for (const id of ownedIds) {
      if (!endedOwned.has(id) && stepMatchesOwnedId(step.content, id)) {
        recordOwnedEnd(connectionId, id, { dir, ...(stepAtMs !== null ? { now: stepAtMs } : {}) })
        endedOwned.add(id)
        newlyEndedOwned.push(id)
        endedOwnedDetails.push({ id, atMs: stepAtMs, content: step.content })
        stepMatched = true
      }
    }
    const keysInStep = notifiedKeys(step.content)
    for (const key of unnotifiedKeys) {
      if (
        !newlyNotified.has(key) &&
        (keysInStep.includes(key) || stepMatchesOwnedId(step.content, key))
      ) {
        appendRequestEvent(connectionId, { op: 'notified', key }, { dir })
        newlyNotified.add(key)
        stepMatched = true
      }
    }
    if (stepMatched) matchedSystemMessages.push(step.content)
  }
  return {
    endedOwnedIds: newlyEndedOwned,
    endedOwnedDetails,
    newlyNotifiedKeys: [...newlyNotified],
    matchedSystemMessages,
  }
}

export function isOneShotScheduleTimer(input) {
  if (!input || typeof input !== 'object') return false
  if (input.CronExpression || input.cron_expression) return false
  if (input.IsDaemon === true || input.IsDaemon === 'true') return false
  const dur = input.DurationSeconds ?? input.duration_seconds
  if (dur === undefined || dur === null || dur === '') return false
  const n = Number(dur)
  return Number.isFinite(n) && n > 0
}

/**
 * Inspect a PostToolUse payload from Antigravity (or Claude Code) to see if it
 * launched asynchronous background work that will wake the agent in a subsequent
 * invocation (e.g. `invoke_subagent`, background `run_command`, `schedule` timer).
 */
export function launchedAntigravityBackgroundWork(toolName, toolInput, toolResponse) {
  const name = String(toolName || '')
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {}
  const resp =
    typeof toolResponse === 'string'
      ? (() => {
          try {
            return JSON.parse(toolResponse)
          } catch {
            return { raw: toolResponse }
          }
        })()
      : toolResponse && typeof toolResponse === 'object'
        ? toolResponse
        : {}

  // Antigravity: invoke_subagent spawns one or more background subagents.
  if (name === 'invoke_subagent' || name === 'default_api:invoke_subagent') {
    const subagents = Array.isArray(input.Subagents) ? input.Subagents : []
    const outText =
      typeof resp.output === 'string'
        ? resp.output
        : typeof resp.raw === 'string'
          ? resp.raw
          : JSON.stringify(resp)
    const convMatch = outText.match(/"conversationId"\s*:\s*"([^"]+)"/)
    const id = convMatch ? convMatch[1] : subagents[0]?.Role || 'subagent'
    const label = subagents.map((s) => s?.Role).filter(Boolean).join(', ') || 'subagent'
    return { id, kind: 'subagent', label }
  }

  // Antigravity: run_command sent to background (non-daemon).
  if (name === 'run_command' || name === 'default_api:run_command') {
    if (input.IsDaemon === true) return null
    const cmdLine = String(input.CommandLine || input.command || '')
    if (isRemotePlumbingBackgroundCommand(cmdLine)) {
      return null
    }
    const outText =
      typeof resp.output === 'string'
        ? resp.output
        : typeof resp.raw === 'string'
          ? resp.raw
          : ''
    const bgId = extractBackgroundCommandTaskId(outText)
    if (bgId) {
      return {
        id: bgId,
        kind: 'command',
        label: input.toolSummary || input.CommandLine || 'background command',
      }
    }
    return null
  }

  // Antigravity: one-shot schedule wait timer (`DurationSeconds` without `CronExpression` / `IsDaemon`).
  if (name === 'schedule' || name === 'default_api:schedule') {
    if (!isOneShotScheduleTimer(input)) return null
    const outText =
      typeof resp.output === 'string'
        ? resp.output
        : typeof resp.raw === 'string'
          ? resp.raw
          : ''
    const bgId =
      extractBackgroundCommandTaskId(outText) || resp.taskId || resp.task_id || resp.id || null
    if (bgId) {
      return {
        id: String(bgId),
        kind: 'timer',
        label: input.Prompt || input.prompt || 'timer',
      }
    }
    return null
  }

  // Claude Code / generic Agent or Bash background task support
  if (name === 'Bash' && (input.run_in_background === true || resp.backgroundTaskId)) {
    const cmdLine = String(input.command || input.CommandLine || '')
    if (isRemotePlumbingBackgroundCommand(cmdLine)) {
      return null
    }
    const id = resp.backgroundTaskId || resp.task_id || resp.id
    if (id) return { id: String(id), kind: 'command', label: input.description || 'bash' }
  }
  if (name === 'Agent' && (input.run_in_background === true || resp.isAsync === true)) {
    const id = resp.agentId || resp.agent_id || resp.id
    if (id) return { id: String(id), kind: 'subagent', label: input.description || 'agent' }
  }

  return null
}

export function resolveAntigravityToolResponse(
  input,
  { transcriptPath = null, conversationId = null } = {},
) {
  if (!input || typeof input !== 'object') return undefined
  const direct = input.tool_response ?? input.toolResponse ?? input.result
  if (direct !== undefined && direct !== null) return direct

  const stepIdx = typeof input.stepIdx === 'number' ? input.stepIdx : null
  const convId =
    conversationId ||
    (typeof input.conversationId === 'string' && input.conversationId.trim()) ||
    (typeof input.conversation_id === 'string' && input.conversation_id.trim()) ||
    null
  const tPath =
    normalizeTranscriptPath(transcriptPath) ||
    normalizeTranscriptPath(input.transcriptPath) ||
    normalizeTranscriptPath(input.transcript_path) ||
    null
  const brainDir =
    (typeof input.artifactDirectoryPath === 'string' && input.artifactDirectoryPath.trim()) ||
    (tPath && tPath.includes(`${path.sep}.system_generated${path.sep}`)
      ? tPath.split(`${path.sep}.system_generated${path.sep}`)[0]
      : null)

  if (brainDir && stepIdx !== null) {
    try {
      const stepOutPath = path.join(
        brainDir,
        '.system_generated',
        'steps',
        String(stepIdx),
        'output.txt',
      )
      if (fs.existsSync(stepOutPath)) {
        const text = fs.readFileSync(stepOutPath, 'utf8')
        if (text.trim()) return { output: text }
      }
    } catch {
      /* ignore */
    }
    try {
      const taskLogPath = path.join(
        brainDir,
        '.system_generated',
        'tasks',
        `task-${stepIdx}.log`,
      )
      if (fs.existsSync(taskLogPath)) {
        const taskId = convId ? `${convId}/task-${stepIdx}` : `task-${stepIdx}`
        return { output: `Tool is running as a background task with task id: ${taskId}` }
      }
    } catch {
      /* ignore */
    }
  }

  if (tPath && fs.existsSync(tPath)) {
    try {
      const stat = fs.statSync(tPath)
      if (stat.isFile() && stat.size > 0) {
        const readSize = Math.min(stat.size, 65536)
        const fd = fs.openSync(tPath, 'r')
        try {
          const buf = Buffer.alloc(readSize)
          fs.readSync(fd, buf, 0, readSize, stat.size - readSize)
          const lines = buf
            .toString('utf8')
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter(Boolean)
          for (let i = lines.length - 1; i >= 0; i--) {
            let step
            try {
              step = JSON.parse(lines[i])
            } catch {
              continue
            }
            if (stepIdx !== null && typeof step?.step_index === 'number' && step.step_index < stepIdx) {
              break
            }
            if (
              step?.type === 'GENERIC' &&
              typeof step.content === 'string' &&
              (Boolean(extractBackgroundCommandTaskId(step.content)) ||
                step.content.includes('Created the following subagent:'))
            ) {
              return { output: step.content }
            }
            if (step?.type === 'PLANNER_RESPONSE' && stepIdx === null) {
              break
            }
          }
        } finally {
          fs.closeSync(fd)
        }
      }
    } catch {
      /* ignore */
    }
  }

  return undefined
}

export function recordBackgroundLaunch(
  raw,
  {
    load = loadState,
    record = recordOwnedLaunch,
    dir = CONNECTIONS_DIR,
    transcriptPath = null,
    env = process.env,
  } = {},
) {
  let input
  try {
    input = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw || {}
  } catch {
    return false
  }
  const conversationId = resolveHookConversationId(raw, env)
  const state = load(conversationId)
  const effectiveTranscriptPath =
    transcriptPath || parseTranscriptPath(raw) || state?.transcript_path || null
  const toolResponse = resolveAntigravityToolResponse(input, {
    transcriptPath: effectiveTranscriptPath,
    conversationId: conversationId || state?.local_id || null,
  })
  const found = launchedAntigravityBackgroundWork(
    input?.tool_name ?? input?.toolName ?? input?.toolCall?.name,
    input?.tool_input ?? input?.toolInput ?? input?.toolCall?.args,
    toolResponse,
  )
  if (!found || !state?.connection_id) return false
  const recorded = record(state.connection_id, found, { dir })
  return recorded ? { state, launch: found } : false
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

/**
 * Normalize an Antigravity transcript path so `transcript_full.jsonl` (sent by
 * PreInvocation / Stop hooks) and `transcript.jsonl` (inferred by SessionStart /
 * PostInvocation) resolve to the same canonical compact `transcript.jsonl` path
 * whenever the compact sibling exists on disk.
 */
export function normalizeTranscriptPath(rawPath) {
  if (typeof rawPath !== 'string' || !rawPath.trim()) return null
  const trimmed = rawPath.trim()
  if (path.basename(trimmed) === 'transcript_full.jsonl') {
    const compactSibling = path.join(path.dirname(trimmed), 'transcript.jsonl')
    try {
      if (fs.existsSync(compactSibling)) return compactSibling
    } catch {
      /* ignore */
    }
  }
  return trimmed
}

/**
 * Extract the transcript path from hook stdin JSON.
 * Antigravity sends `transcriptPath` (camelCase) and `transcript_path` (snake_case).
 */
export function parseTranscriptPath(hookInput) {
  try {
    const parsed = JSON.parse(hookInput || '{}')
    if (typeof parsed.transcriptPath === 'string' && parsed.transcriptPath.trim()) {
      return normalizeTranscriptPath(parsed.transcriptPath)
    }
    if (typeof parsed.transcript_path === 'string' && parsed.transcript_path.trim()) {
      return normalizeTranscriptPath(parsed.transcript_path)
    }
  } catch {
    /* ignore */
  }
  return null
}

/**
 * Persist a newly discovered `transcript_path` (and `local_id` if missing) onto the
 * connection state file and local bond so the background poller can tail
 * `transcript.jsonl` for live progress trail streaming.
 */
export function syncStateTranscriptPath(
  state,
  transcriptPath,
  conversationId = null,
  { connectionsDir = CONNECTIONS_DIR, env = process.env } = {},
) {
  if (!state?.connection_id) return false
  const resolvedPath =
    normalizeTranscriptPath(transcriptPath) ||
    normalizeTranscriptPath(state.transcript_path) ||
    inferAntigravityTranscriptPath(conversationId || state.local_id)
  const lsAddress = env?.ANTIGRAVITY_LS_ADDRESS || state.ls_address || null
  const csrfToken = env?.ANTIGRAVITY_CSRF_TOKEN || state.csrf_token || null
  const agentapiExe = env?.ANTIGRAVITY_AGENTAPI_EXE || state.agentapi_exe || null
  const wasWindowStandby =
    !state.local_id || String(state.local_id).startsWith('agy-window:')
  const shouldUpgradeLocalId = Boolean(conversationId && wasWindowStandby)

  if (
    !resolvedPath &&
    !shouldUpgradeLocalId &&
    (!lsAddress || state.ls_address === lsAddress) &&
    (!csrfToken || state.csrf_token === csrfToken)
  ) {
    return false
  }
  if (
    state.transcript_path === resolvedPath &&
    !shouldUpgradeLocalId &&
    (!conversationId || state.local_id === conversationId) &&
    (!lsAddress || state.ls_address === lsAddress) &&
    (!csrfToken || state.csrf_token === csrfToken)
  ) {
    return false
  }
  const file = path.join(connectionsDir, `${state.connection_id}.json`)
  try {
    if (fs.existsSync(file)) {
      const current = JSON.parse(fs.readFileSync(file, 'utf8'))
      const currentIsStandby =
        !current.local_id || String(current.local_id).startsWith('agy-window:')
      const nextLocalId =
        currentIsStandby && conversationId ? conversationId : current.local_id || conversationId || null
      const updated = {
        ...current,
        ...(resolvedPath ? { transcript_path: resolvedPath } : {}),
        local_id: nextLocalId,
        ...(currentIsStandby && conversationId ? { pending_local_id: null } : {}),
        ...(lsAddress ? { ls_address: lsAddress } : {}),
        ...(csrfToken ? { csrf_token: csrfToken } : {}),
        ...(agentapiExe ? { agentapi_exe: agentapiExe } : {}),
        updated_at: new Date().toISOString(),
      }
      // Connection state holds the key: 0600 aside-and-rename (item b17cb7d7).
      writePrivateJson(file, updated)
      if (resolvedPath) state.transcript_path = resolvedPath
      if (nextLocalId) state.local_id = nextLocalId
      if (currentIsStandby && conversationId) state.pending_local_id = null
      if (lsAddress) state.ls_address = lsAddress
      if (csrfToken) state.csrf_token = csrfToken
      if (agentapiExe) state.agentapi_exe = agentapiExe
    }
    const localId =
      conversationId && wasWindowStandby ? conversationId : state.local_id || conversationId
    if (localId && !String(localId).startsWith('agy-window:')) {
      const rcDir = path.dirname(connectionsDir)
      const bondFile = localBondPath(state.agent_name || AGENT_NAME, localId, rcDir)
      if (fs.existsSync(bondFile)) {
        const bond = JSON.parse(fs.readFileSync(bondFile, 'utf8'))
        if (resolvedPath && bond.transcript_path !== resolvedPath) {
          bond.transcript_path = resolvedPath
          writePrivateJson(bondFile, bond)
        }
      } else if (shouldUpgradeLocalId) {
        writeLocalBond(
          state.agent_name || AGENT_NAME,
          localId,
          {
            status: 'live',
            connection_id: state.connection_id,
            session_id: state.session_id || null,
            session_codename: state.session_codename || null,
            session_title: state.session_title || null,
            cwd: state.cwd || process.cwd(),
            transcript_path: resolvedPath || null,
            enabled: true,
            updated_at: new Date().toISOString(),
          },
          rcDir,
        )
      }
    }
    return true
  } catch {
    return false
  }
}

/**
 * The DevSpec connection to mirror for belongs to THIS local conversation. Resolve
 * its conversation id the SAME way remote-control-state.mjs `write` stamped it — via
 * the shared detectLocalId (probes whichever conversation-id env var THIS tool
 * exposes), then the hook stdin `conversationId` (Antigravity native) or `session_id`.
 */
export function resolveHookConversationId(hookInput, env = process.env) {
  const fromEnv = detectLocalId({}, env).local_id
  if (fromEnv) return fromEnv
  try {
    const parsed =
      typeof hookInput === 'string'
        ? JSON.parse(hookInput || '{}')
        : hookInput && typeof hookInput === 'object'
          ? hookInput
          : {}
    if (typeof parsed.conversationId === 'string' && parsed.conversationId.trim()) {
      return parsed.conversationId.trim()
    }
    if (typeof parsed.conversation_id === 'string' && parsed.conversation_id.trim()) {
      return parsed.conversation_id.trim()
    }
    if (typeof parsed.session_id === 'string' && parsed.session_id.trim()) {
      return parsed.session_id.trim()
    }
  } catch {
    /* fall through — fail closed below */
  }
  return null
}

/**
 * Choose the connection state bound to THIS conversation.
 *
 * Primary — a precise conversation bond: tools that expose a stable conversation id
 * select the state whose local_id matches. A machine-newer connection for a
 * DIFFERENT conversation is never picked.
 *
 * Secondary — a window-standby bond (`local_id: null` or `agy-window:<pid>`) owned by
 * this Antigravity window's `owner_pid`.
 *
 * Fallback — for tools that expose NO per-conversation id to their hooks, or when a
 * connection was registered before `local_id` was known: the single enabled
 * connection for THIS agent. Safe ONLY because "exactly one" means nothing to
 * disambiguate; two+ concurrent connections of the same agent fail closed.
 */
export function selectBoundState(
  candidates,
  conversationId,
  agentName = null,
  { ownerPid = null } = {},
) {
  const enabled = candidates
    .filter(Boolean)
    .filter(({ raw }) => raw?.enabled === true && raw?.connection_id)

  if (conversationId) {
    const bound = enabled
      .filter(({ raw }) => raw.local_id === conversationId)
      .sort((a, b) => b.mtime - a.mtime)[0]?.raw
    if (bound) return bound
  }

  if (ownerPid && Number.isInteger(Number(ownerPid)) && Number(ownerPid) > 1) {
    const pidMatches = enabled
      .filter(({ raw }) => {
        if (
          agentName &&
          String(raw.agent_name || '').toLowerCase() !== String(agentName).toLowerCase()
        ) {
          return false
        }
        if (Number(raw.owner_pid) !== Number(ownerPid)) return false
        return (
          !conversationId ||
          !raw.local_id ||
          String(raw.local_id).startsWith('agy-window:') ||
          raw.local_id === conversationId
        )
      })
      .sort((a, b) => b.mtime - a.mtime)
    if (pidMatches.length > 0) return pidMatches[0].raw
  }

  if (agentName) {
    const mine = enabled.filter(
      ({ raw }) => String(raw.agent_name || '').toLowerCase() === String(agentName).toLowerCase(),
    )
    if (mine.length === 1) {
      // Only fall back to the single connection if it is either unbound (local_id: null / agy-window:*),
      // or we have no conversationId to check against. If the single connection is
      // explicitly bound to a DIFFERENT conversationId, fail closed!
      const candidate = mine[0].raw
      if (
        !conversationId ||
        !candidate.local_id ||
        String(candidate.local_id).startsWith('agy-window:') ||
        candidate.local_id === conversationId
      ) {
        return candidate
      }
    }
  }

  return null
}

/**
 * Marker set by mark-explicit-reply.mjs (PostToolUse on the devspec
 * post_session_message tool) when the agent itself already posted a reply this
 * turn. Cleared unconditionally once read so it can never leak into a later turn.
 */
export function explicitReplyMarkerPath(connectionId, dir = CONNECTIONS_DIR) {
  return path.join(dir, `${connectionId}.explicit-reply`)
}

export function writeExplicitReplyMarker(connectionId, dir = CONNECTIONS_DIR) {
  if (!connectionId) return false
  try {
    ensurePrivateDir(dir)
    fs.writeFileSync(
      explicitReplyMarkerPath(connectionId, dir),
      JSON.stringify({ at: Date.now() }),
      { mode: 0o600 },
    )
    return true
  } catch {
    return false
  }
}

export function consumeExplicitReplyMarker(connectionId, dir = CONNECTIONS_DIR) {
  if (!connectionId) return false
  const p = explicitReplyMarkerPath(connectionId, dir)
  try {
    const existed = fs.existsSync(p)
    if (existed) fs.rmSync(p, { force: true })
    return existed
  } catch {
    return false
  }
}

export function loadState(
  conversationId,
  {
    connectionsDir = CONNECTIONS_DIR,
    legacyPath = LEGACY_STATE_PATH,
    ownerPid = resolveOwnerPid({}),
    // How long to wait for a background renewal of the login (default RENEW_WAIT_MS).
    // 0 starts the detached renewal and carries on with the token in hand: for a hook
    // on a short deadline, such as the turn-recall hook (scripts/turn-recall.mjs).
    renewWaitMs = undefined,
  } = {},
) {
  // Gather every candidate (legacy singleton + per-connection files) but NEVER
  // trust "most recent" — selectBoundState keeps only THIS conversation's state.
  const candidates = []
  try {
    if (fs.existsSync(legacyPath)) {
      const raw = JSON.parse(fs.readFileSync(legacyPath, 'utf8'))
      candidates.push({ raw, mtime: fs.statSync(legacyPath).mtimeMs })
    }
  } catch {
    /* continue with per-connection state */
  }
  try {
    if (fs.existsSync(connectionsDir)) {
      for (const file of fs.readdirSync(connectionsDir).filter((f) => f.endsWith('.json') && !f.startsWith('.') && !f.slice(0, -5).includes('.') && f !== 'legacy.json')) {
        try {
          const p = path.join(connectionsDir, file)
          const raw = JSON.parse(fs.readFileSync(p, 'utf8'))
          candidates.push({ raw, mtime: fs.statSync(p).mtimeMs })
        } catch {
          /* ignore an incomplete or concurrently-replaced state file */
        }
      }
    }
  } catch {
    /* selection below fails closed when no readable matching state exists */
  }
  return stateWithCurrentToken(selectBoundState(candidates, conversationId, AGENT_NAME, { ownerPid }), renewWaitMs === undefined ? {} : { waitMs: renewWaitMs })
}

/**
 * Extract the inner text of `<USER_REQUEST>...</USER_REQUEST>` from an Antigravity
 * `USER_INPUT` step in `transcript.jsonl`.
 */
export function extractUserRequestText(content) {
  const raw = String(content ?? '')
  const match = raw.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/)
  if (match) return match[1].trim()
  return raw.trim()
}

/**
 * Read the last non-empty JSONL step from an Antigravity `transcript.jsonl` file.
 * Reads at most the last 64 KB of the file for O(1) performance on long transcripts.
 */
export function extractLatestTranscriptStep(transcriptPath) {
  if (!transcriptPath) return null
  try {
    const stat = fs.statSync(transcriptPath)
    if (!stat.isFile() || stat.size === 0) return null
    const readSize = Math.min(stat.size, 65536)
    const fd = fs.openSync(transcriptPath, 'r')
    try {
      const buf = Buffer.alloc(readSize)
      fs.readSync(fd, buf, 0, readSize, stat.size - readSize)
      const lines = buf
        .toString('utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          return JSON.parse(lines[i])
        } catch {
          /* skip partial first line in tail chunk */
        }
      }
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null
  }
  return null
}

function extractLastText(hookInput, which) {
  let data
  try {
    data = JSON.parse(hookInput || '{}')
  } catch {
    return null
  }

  if (which === 'user_prompt') {
    const direct =
      data.prompt ||
      data.user_prompt ||
      data.message ||
      data.text ||
      data.content ||
      (typeof data.input === 'string' ? data.input : null) ||
      null
    if (direct) return direct

    const tPath = parseTranscriptPath(hookInput)
    const latestStep = extractLatestTranscriptStep(tPath)
    if (latestStep?.type === 'USER_INPUT' && typeof latestStep.content === 'string') {
      return extractUserRequestText(latestStep.content)
    }
    return null
  }

  if (typeof data.last_assistant_message === 'string') return data.last_assistant_message
  if (typeof data.assistant_message === 'string') return data.assistant_message
  if (typeof data.response === 'string') return data.response
  if (typeof data.output === 'string') return data.output
  const msgs = data.transcript || data.messages
  if (Array.isArray(msgs)) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (m && (m.role === 'assistant' || m.type === 'assistant')) {
        const c = m.content
        if (typeof c === 'string' && c.trim()) return c
        if (Array.isArray(c)) {
          const text = c
            .filter((b) => b && (b.type === 'text' || typeof b.text === 'string'))
            .map((b) => b.text || '')
            .join('\n')
            .trim()
          if (text) return text
        }
      }
    }
  }
  return null
}

/**
 * Antigravity and Claude Code re-invoke the model after a background task or subagent
 * by injecting a synthetic system message (`<SYSTEM_MESSAGE>`, `<task-notification>`,
 * `[SYSTEM NOTIFICATION …]`, or `<system-reminder>`). Those are harness plumbing,
 * never owner-typed input, and must not be mirrored as local_prompt bubbles.
 */
export function isHarnessInjection(text) {
  const t = String(text)
  return (
    t.includes('<SYSTEM_MESSAGE>') ||
    t.includes('<EPHEMERAL_MESSAGE>') ||
    t.includes('<task-notification') ||
    t.includes('[SYSTEM NOTIFICATION - NOT USER INPUT]') ||
    t.includes('This is an automated background-task event') ||
    t.includes('<system-reminder>') ||
    t.includes('[DevSpec Remote Wake]')
  )
}

/**
 * True when a user prompt is the `/devspec-remote` or `/devspec-remote-stop` setup
 * command itself (`/(?:devspec:)?devspec-remote(?:-stop)?`). That setup turn registers
 * or detaches the connection and must not mark the connection busy with non-check work.
 */
export function isRemoteControlCommandPrompt(text) {
  if (typeof text !== 'string') return false
  const extracted = extractUserRequestText(text)
  const trimmed = String(extracted ?? text).trim()
  return /^\/(?:devspec:)?devspec-remote(?:-stop)?(?:\s|$)/i.test(trimmed)
}

/**
 * True when a prompt or `<SYSTEM_MESSAGE>` step is a background command, subagent,
 * or timer notification rather than user input or a DevSpec Remote Wake.
 */
export function isBackgroundTaskNotification(text) {
  const t = String(text ?? '')
  if (!t) return false
  if (
    t.includes('<task-notification') ||
    t.includes('[SYSTEM NOTIFICATION - NOT USER INPUT]') ||
    t.includes('This is an automated background-task event') ||
    /\bsender=(?!system\b)[A-Za-z0-9_.:/-]+/.test(t) ||
    /Background command\s+"[^"]+"\s+\([^)]*\)\s+finished/i.test(t) ||
    /\bcontent=Task id\s+"[^"]+"\s+finished/i.test(t)
  ) {
    return true
  }
  if (
    t.includes('[DevSpec Remote Wake]') ||
    t.includes('"event":"wake"') ||
    t.includes('"type":"system_notice"') ||
    t.includes('"type":"check_job"') ||
    t.includes('"event":"directives"') ||
    t.includes('"event":"automation_run"') ||
    t.includes('"event":"interaction_answer"') ||
    t.includes('"event":"question_dismissal"')
  ) {
    return false
  }
  return t.includes('<SYSTEM_MESSAGE>')
}

/**
 * Inspect the tail of `transcript.jsonl` to recover the active turn's context
 * (`remoteTurn`, `localPromptMirrored`, `noticeIds`, `recordNoticeIds`, `checkJobWake`,
 * `otherWake`, `backgroundContinuation`) when `.turn` was missing or when a background
 * task / subagent `<SYSTEM_MESSAGE>` continues an earlier turn.
 */
export function inferTurnContextFromTranscript(transcriptPath) {
  const tPath = normalizeTranscriptPath(transcriptPath)
  if (!tPath) return null
  let raw = ''
  try {
    const stat = fs.statSync(tPath)
    if (!stat.isFile() || stat.size === 0) return null
    const readSize = Math.min(stat.size, 262_144)
    const fd = fs.openSync(tPath, 'r')
    try {
      const buf = Buffer.alloc(readSize)
      fs.readSync(fd, buf, 0, readSize, stat.size - readSize)
      raw = buf.toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null
  }

  const steps = []
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      steps.push(JSON.parse(trimmed))
    } catch {
      /* skip partial first line in tail chunk */
    }
  }

  let sawBgNotification = false
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i]
    if (!step || typeof step.content !== 'string') continue
    if (step.type === 'SYSTEM_MESSAGE') {
      if (isBackgroundTaskNotification(step.content)) {
        sawBgNotification = true
        continue
      }
      const wake = turnWakeFromText(step.content)
      if (
        sawBgNotification &&
        wake &&
        !wake.otherWake &&
        (wake.checkJobWake || wake.noticeIds?.length || wake.recordNoticeIds?.length)
      ) {
        continue
      }
      return {
        remoteTurn: true,
        localPromptMirrored: false,
        ...(sawBgNotification ? { backgroundContinuation: true } : {}),
        ...(wake || {}),
      }
    }
    if (step.type === 'USER_INPUT') {
      if (step.content.includes('[DevSpec Remote Wake]')) {
        const wake = turnWakeFromText(step.content)
        if (
          sawBgNotification &&
          wake &&
          !wake.otherWake &&
          (wake.checkJobWake || wake.noticeIds?.length || wake.recordNoticeIds?.length)
        ) {
          continue
        }
        return {
          remoteTurn: true,
          localPromptMirrored: false,
          ...(sawBgNotification ? { backgroundContinuation: true } : {}),
          ...(wake || {}),
        }
      }
      if (!sawBgNotification && isRemoteControlCommandPrompt(step.content)) {
        return {
          remoteTurn: false,
          localPromptMirrored: false,
          remoteControlCommand: true,
        }
      }
      return {
        remoteTurn: false,
        localPromptMirrored: true,
        otherWake: true,
        ...(sawBgNotification ? { backgroundContinuation: true } : {}),
      }
    }
  }

  if (sawBgNotification) {
    return {
      remoteTurn: false,
      localPromptMirrored: false,
      backgroundContinuation: true,
    }
  }
  return null
}

function unquoteTranscriptString(val) {
  if (typeof val !== 'string') return val
  const trimmed = val.trim()
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed)
    } catch {
      return trimmed.slice(1, -1)
    }
  }
  return trimmed
}

export function summarizeThinkingText(text, maxLen = 140) {
  if (typeof text !== 'string') return ''
  const firstParagraph = text
    .trim()
    .split(/\r?\n\r?\n/)[0]
    .replace(/\s+/g, ' ')
    .trim()
  if (!firstParagraph) return ''
  return firstParagraph.length > maxLen
    ? `${firstParagraph.slice(0, maxLen - 1).trimEnd()}…`
    : firstParagraph
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SNAKE_TOOL_NAME_RE = /^[a-z0-9]+(?:_[a-z0-9]+)+$/i
const GIT_BRANCH_TITLE_RE = /^[a-z0-9._-]+\/[a-z0-9._/-]*…?$/i

function isHumanDomainTitle(value) {
  if (typeof value !== 'string') return false
  const trimmed = value.replace(/\s+/g, ' ').trim()
  if (!trimmed) return false
  if (UUID_RE.test(trimmed)) return false
  if (SNAKE_TOOL_NAME_RE.test(trimmed)) return false
  if (GIT_BRANCH_TITLE_RE.test(trimmed)) return false
  return true
}

function salvageTruncatedJsonStringFields(raw) {
  if (typeof raw !== 'string' || !raw) return {}
  const normalized = raw.includes('\\"')
    ? raw.replace(/^\s*"/, '').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
    : raw
  const out = {}
  const fieldRe =
    /"(title|task_id|id|resource_id|summary|completion_summary|query|agent_branch|phase|turn_kind)"\s*:\s*"((?:\\.|[^"\\])*)"/g
  let match
  while ((match = fieldRe.exec(normalized)) !== null) {
    const key = match[1]
    if (key in out) continue
    try {
      out[key] = JSON.parse(`"${match[2]}"`)
    } catch {
      out[key] = match[2]
    }
  }
  return out
}

function unwrapMcpCallArgs(toolName, args = {}) {
  const name = String(toolName || '').replace(/^default_api:/, '')
  if (name === 'call_mcp_tool' && args && typeof args === 'object') {
    const serverName = String(unquoteTranscriptString(args.ServerName ?? args.server_name ?? '')).toLowerCase()
    if (isDevspecServerName(serverName)) {
      const innerTool = String(unquoteTranscriptString(args.ToolName ?? args.tool_name ?? ''))
      let innerArgs = args.Arguments ?? args.arguments ?? {}
      if (typeof innerArgs === 'string') {
        const unquoted = unquoteTranscriptString(innerArgs)
        try {
          innerArgs = typeof unquoted === 'string' ? JSON.parse(unquoted) : unquoted
        } catch {
          innerArgs = typeof unquoted === 'string' ? salvageTruncatedJsonStringFields(unquoted) : {}
        }
      }
      return {
        effectiveName: innerTool ? `mcp_devspec_${innerTool}` : name,
        effectiveArgs: innerArgs && typeof innerArgs === 'object' ? innerArgs : {},
      }
    }
  }
  return {
    effectiveName: String(toolName || ''),
    effectiveArgs: args && typeof args === 'object' ? args : {},
  }
}

export function isSessionReplyToolCall(toolName, args = {}) {
  const { effectiveName: name, effectiveArgs } = unwrapMcpCallArgs(toolName, args)
  if (
    name === 'post_session_message' ||
    name === 'mcp_devspec_post_session_message' ||
    name === 'mcp__devspec__post_session_message' ||
    name.endsWith(':post_session_message') ||
    name.endsWith('__post_session_message')
  ) {
    // A reply to a DevSpec notice (system_notice_ids) answers no command, so it is not
    // the turn's reply: the command still needs its own answer (notice-reply.mjs).
    return (
      effectiveArgs?.phase !== 'trail' &&
      effectiveArgs?.phase !== 'needs_input' &&
      effectiveArgs?.turn_kind !== 'local_prompt' &&
      effectiveArgs?.system_notice_ids === undefined
    )
  }
  if (name === 'run_command' || name === 'default_api:run_command' || name === 'Bash') {
    const cmdLine = String(effectiveArgs?.CommandLine || effectiveArgs?.command || '')
    if (isRemotePlumbingShellCommand(cmdLine)) {
      if (cmdLine.includes('post_session_message') && !/phase\s*:\s*['"]trail['"]/.test(cmdLine)) {
        return true
      }
      if (cmdLine.includes('devspec-question.mjs') && /\brespond\b/.test(cmdLine)) {
        return true
      }
    }
    if (
      /\bnode(?:\.exe)?\b[^\n;]*\s(?:-e|--eval)\b/.test(cmdLine) &&
      /\bmcpToolsCall\s*\(/.test(cmdLine) &&
      cmdLine.includes('post_session_message') &&
      !/phase\s*:\s*['"]trail['"]/.test(cmdLine)
    ) {
      return true
    }
  }
  return false
}

/**
 * Whether a DevSpec `post_session_message` call is a reply to DevSpec notices: it names
 * them itself, or PreToolUse gave it `turnNotices` (the turn's notices, from
 * `currentTurnNoticeIds`) because nothing else in the turn could be its subject.
 */
export function isNoticeReplyToolCall(toolName, args = {}, { turnNotices = null } = {}) {
  const { effectiveName: name, effectiveArgs } = unwrapMcpCallArgs(toolName, args)
  if (!/(?:^|:|__|_)post_session_message$/.test(name)) return false
  if (effectiveArgs?.system_notice_ids !== undefined) return true
  return Boolean(turnNotices) && postCanTakeTurnNotices(effectiveArgs)
}

export function isRemotePlumbingToolCall(toolName, args = {}) {
  if (isSessionReplyToolCall(toolName, args)) return true
  const { effectiveName: name, effectiveArgs } = unwrapMcpCallArgs(toolName, args)
  if (
    /(?:^|:|__|_)(?:post_session_message|heartbeat_connection|poll_connection|report_pickup|report_keepalive|report_complete|report_blocked|register_connection|attach_connection)$/.test(
      name,
    )
  ) {
    return true
  }
  if (name === 'run_command' || name === 'default_api:run_command' || name === 'Bash') {
    const cmdLine = String(effectiveArgs?.CommandLine || effectiveArgs?.command || '')
    if (isRemotePlumbingShellCommand(cmdLine)) {
      return true
    }
  }
  return false
}

export function redactSecretsFromText(text) {
  if (typeof text !== 'string') return ''
  return text
    .replace(/\b(dvsc?_[A-Za-z0-9_-]{8,})\b/g, '[REDACTED]')
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, '[REDACTED]')
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{12,})\b/g, '[REDACTED]')
    .replace(/(Bearer\s+)[A-Za-z0-9._-]{8,}/gi, '$1[REDACTED]')
    .replace(/(DEVSPEC_MCP_TOKEN\s*=\s*)[^\s"']+/g, '$1[REDACTED]')
    .replace(/(ANTIGRAVITY_CSRF_TOKEN\s*=\s*)[^\s"']+/g, '$1[REDACTED]')
}

function classifyDevspecDomainTool(toolName, args = {}, { titleById = null } = {}) {
  const { effectiveName, effectiveArgs } = unwrapMcpCallArgs(toolName, args)
  const verb = devspecToolFromName(effectiveName)
  if (!verb) return null
  const id = unquoteTranscriptString(
    effectiveArgs?.task_id || effectiveArgs?.id || effectiveArgs?.resource_id || '',
  )
  const candidates = [
    effectiveArgs?.title,
    id && titleById ? titleById.get(String(id)) : '',
    effectiveArgs?.summary,
    effectiveArgs?.query,
  ]
  let title = ''
  for (const candidate of candidates) {
    const clean = unquoteTranscriptString(candidate || '')
    if (isHumanDomainTitle(clean)) {
      title = clean.replace(/\s+/g, ' ').trim()
      break
    }
  }

  const domainMap = {
    create_task: { domain: 'task', action: 'created' },
    update_task: { domain: 'task', action: 'updated' },
    claim_work_item: { domain: 'task', action: 'claimed' },
    reserve_work_items: { domain: 'task', action: 'reserved' },
    verify_task: { domain: 'task', action: 'verified' },
    get_task: { domain: 'task', action: 'inspected' },
    get_tasks: { domain: 'task', action: 'listed' },
    search_tasks: { domain: 'task', action: 'searched' },
    record_implementation: { domain: 'implementation', action: 'recorded' },
    record_criterion_verdicts: { domain: 'criterion', action: 'recorded verdicts' },
    record_memory: { domain: 'memory', action: 'recorded' },
    supersede_memory: { domain: 'memory', action: 'superseded' },
    update_memory: { domain: 'memory', action: 'updated' },
    retract_memory: { domain: 'memory', action: 'retracted' },
    get_memory: { domain: 'memory', action: 'read' },
    search_memories: { domain: 'memory', action: 'searched' },
    create_resource: { domain: 'resource', action: 'created' },
    update_resource: { domain: 'resource', action: 'updated' },
    supersede_resource: { domain: 'resource', action: 'superseded' },
    get_resource: { domain: 'resource', action: 'read' },
    search_resources: { domain: 'resource', action: 'searched' },
  }
  const mapped = domainMap[verb]
  if (!mapped) return { verb, domain: null, effectiveArgs }
  return {
    verb,
    domain: mapped.domain,
    action: mapped.action,
    ...(title ? { title: String(title) } : {}),
    ...(id ? { id: String(id) } : {}),
    effectiveArgs,
  }
}

function normalizeCanonicalToolEvent(toolName, args = {}) {
  const bare = String(toolName || '').replace(/^default_api:/, '')
  if (bare === 'view_file') {
    const filePath = unquoteTranscriptString(args?.AbsolutePath || '')
    const start = args?.StartLine
    const end = args?.EndLine
    const range = start || end ? `:${start || 1}-${end || ''}` : ''
    return {
      canonicalName: 'read',
      argsText: filePath ? `${filePath}${range}` : '',
    }
  }
  if (bare === 'replace_file_content' || bare === 'multi_replace_file_content') {
    return {
      canonicalName: 'edit',
      argsText: unquoteTranscriptString(args?.TargetFile || '') || '',
    }
  }
  if (bare === 'write_to_file') {
    return {
      canonicalName: 'write',
      argsText: unquoteTranscriptString(args?.TargetFile || '') || '',
    }
  }
  if (bare === 'run_command' || bare === 'Bash') {
    const cmdLine = unquoteTranscriptString(args?.CommandLine || args?.command || '') || ''
    return {
      canonicalName: 'bash',
      argsText: redactSecretsFromText(cmdLine),
    }
  }
  if (bare === 'grep_search' || bare === 'find_by_name' || bare === 'search_web') {
    const q =
      unquoteTranscriptString(args?.Query || args?.Pattern || args?.query || args?.SearchPath || '') || ''
    return {
      canonicalName: 'search',
      argsText: q,
    }
  }
  const { effectiveName, effectiveArgs } = unwrapMcpCallArgs(toolName, args)
  const cleanName = String(effectiveName || bare).replace(/^default_api:/, '')
  let argsPreview = ''
  try {
    const keys = Object.keys(effectiveArgs || {}).filter(
      (k) => k !== 'toolAction' && k !== 'toolSummary',
    )
    if (keys.length > 0) {
      const shown = {}
      for (const k of keys) shown[k] = effectiveArgs[k]
      argsPreview = clampTrailField(redactSecretsFromText(JSON.stringify(shown)))
    }
  } catch {
    argsPreview = ''
  }
  return {
    canonicalName: cleanName || 'tool',
    argsText: argsPreview,
  }
}

function extractRecordIdAndTitleFromToolOutput(rawContent) {
  if (typeof rawContent !== 'string' || !rawContent) return null
  let text = rawContent
  const spillMatch = rawContent.match(/saved to:\s*file:\/\/(\/[^\s"'<>]+\/output\.txt)/i)
  if (spillMatch?.[1] && fs.existsSync(spillMatch[1])) {
    try {
      const fd = fs.openSync(spillMatch[1], 'r')
      try {
        const buf = Buffer.alloc(4096)
        const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0)
        text = buf.slice(0, bytesRead).toString('utf8')
      } finally {
        fs.closeSync(fd)
      }
    } catch {
      /* ignore spill read errors */
    }
  }
  const head = text.slice(0, 4096)
  const idMatch = head.match(
    /"id"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/i,
  )
  const titleMatch = head.match(/"title"\s*:\s*"((?:\\.|[^"\\])*)"/)
  if (!idMatch?.[1] || !titleMatch?.[1]) return null
  let title = titleMatch[1]
  try {
    title = JSON.parse(`"${titleMatch[1]}"`)
  } catch {
    /* keep raw */
  }
  if (!isHumanDomainTitle(title)) return null
  return {
    id: idMatch[1],
    title: title.replace(/\s+/g, ' ').trim(),
  }
}

function loadFullTranscriptTruncatedSteps(transcriptPath, fullTranscriptText, neededStepIndices) {
  const byIndex = new Map()
  if (!neededStepIndices || neededStepIndices.size === 0) return byIndex
  let rawFull = typeof fullTranscriptText === 'string' ? fullTranscriptText : null
  if (!rawFull && typeof transcriptPath === 'string' && /transcript\.jsonl$/.test(transcriptPath)) {
    const fullPath = transcriptPath.replace(/transcript\.jsonl$/, 'transcript_full.jsonl')
    if (fs.existsSync(fullPath)) {
      try {
        rawFull = fs.readFileSync(fullPath, 'utf8')
      } catch {
        rawFull = null
      }
    }
  }
  if (!rawFull) return byIndex
  for (const rawLine of rawFull.split(/\r?\n/)) {
    const trimmed = rawLine.trim()
    if (!trimmed) continue
    try {
      const step = JSON.parse(trimmed)
      if (step && neededStepIndices.has(step.step_index)) {
        byIndex.set(step.step_index, step)
      }
    } catch {
      /* ignore */
    }
  }
  return byIndex
}

/**
 * Extract structured trail events and cumulative Markdown from an Antigravity
 * `transcript.jsonl` raw string for the active turn (Pi-style `work_trail` and
 * `@devspec/core/messages/trail-events` schema without command obfuscation).
 */
export function extractAntigravityTrailFromTranscript(
  rawText,
  {
    sinceIso = null,
    sinceMs = null,
    excludedRanges = [],
    stopAtReply = true,
    transcriptPath = null,
    fullTranscriptText = null,
  } = {},
) {
  const cutoffMs =
    typeof sinceMs === 'number' && Number.isFinite(sinceMs)
      ? sinceMs
      : sinceIso
        ? Date.parse(sinceIso)
        : null

  const events = []
  const bullets = []
  const domainBulletMeta = new Map()
  const titleById = new Map()
  let pendingCreatedDomainEvent = null
  let seq = 0
  let replyPosted = false

  const parsedSteps = []
  const truncatedStepIndices = new Set()
  for (const rawLine of String(rawText || '').split(/\r?\n/)) {
    const trimmed = rawLine.trim()
    if (!trimmed) continue
    let step
    try {
      step = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (!step) continue
    if (
      step.type === 'PLANNER_RESPONSE' &&
      Array.isArray(step.truncated_fields) &&
      step.truncated_fields.includes('tool_calls') &&
      step.step_index !== undefined
    ) {
      truncatedStepIndices.add(step.step_index)
    }
    parsedSteps.push(step)
  }

  const fullStepsByIndex = loadFullTranscriptTruncatedSteps(
    transcriptPath,
    fullTranscriptText,
    truncatedStepIndices,
  )

  for (let rawStep of parsedSteps) {
    const step =
      rawStep.type === 'PLANNER_RESPONSE' && fullStepsByIndex.has(rawStep.step_index)
        ? fullStepsByIndex.get(rawStep.step_index)
        : rawStep

    const stepMsForFilter = step.created_at ? Date.parse(step.created_at) : NaN
    if (isTimestampInExcludedRanges(stepMsForFilter, excludedRanges)) {
      continue
    }

    if (step.type === 'GENERIC') {
      const extracted = extractRecordIdAndTitleFromToolOutput(step.content)
      if (extracted) {
        titleById.set(extracted.id, extracted.title)
        if (pendingCreatedDomainEvent) {
          if (!pendingCreatedDomainEvent.id) pendingCreatedDomainEvent.id = extracted.id
          if (!pendingCreatedDomainEvent.title) pendingCreatedDomainEvent.title = extracted.title
          pendingCreatedDomainEvent = null
        }
      }
      continue
    }

    if (step.type !== 'PLANNER_RESPONSE') continue
    pendingCreatedDomainEvent = null

    const rawToolCalls = Array.isArray(step.tool_calls) ? step.tool_calls : []
    const parsedToolCalls = rawToolCalls.map((tc) => {
      const toolName = tc?.name || tc?.tool_name || tc?.function?.name || 'tool'
      let args = tc?.arguments ?? tc?.args ?? tc?.input ?? tc?.function?.arguments ?? {}
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args)
        } catch {
          args = {}
        }
      }
      return { toolName, args }
    })

    for (const { toolName, args } of parsedToolCalls) {
      const info = classifyDevspecDomainTool(toolName, args, { titleById })
      if (info?.id && info?.title && isHumanDomainTitle(info.title)) {
        titleById.set(String(info.id), info.title)
      }
    }

    if (cutoffMs !== null && Number.isFinite(cutoffMs) && step.created_at) {
      const stepMs = Date.parse(step.created_at)
      if (Number.isFinite(stepMs) && stepMs < cutoffMs) continue
    }

    const occurredAt =
      typeof step.created_at === 'string' && Number.isFinite(Date.parse(step.created_at))
        ? new Date(Date.parse(step.created_at)).toISOString()
        : undefined

    if (stopAtReply && parsedToolCalls.some((tc) => isSessionReplyToolCall(tc.toolName, tc.args))) {
      replyPosted = true
      break
    }

    const visibleToolCalls = parsedToolCalls.filter(
      (tc) => !isRemotePlumbingToolCall(tc.toolName, tc.args),
    )

    if (parsedToolCalls.length > 0 && visibleToolCalls.length === 0) {
      continue
    }
    if (parsedToolCalls.length === 0 && typeof step.content === 'string' && step.content.trim()) {
      continue
    }

    if (typeof step.thinking === 'string' && step.thinking.trim()) {
      const summary = summarizeThinkingText(step.thinking, 220)
      const fullThinking = clampTrailField(redactSecretsFromText(step.thinking.trim()))
      if (summary && fullThinking) {
        seq++
        events.push({
          seq,
          kind: 'thinking',
          text: fullThinking,
          label: summary,
          ...(occurredAt ? { occurredAt } : {}),
          step_index: step.step_index ?? null,
        })
        bullets.push(`> 💭 ${summary}`)
      }
    }

    for (const { toolName, args } of visibleToolCalls) {
      let subagentsList = args?.Subagents
      if (typeof subagentsList === 'string') {
        try {
          subagentsList = JSON.parse(unquoteTranscriptString(subagentsList))
        } catch {
          subagentsList = null
        }
      }
      if (
        (toolName === 'invoke_subagent' || toolName === 'default_api:invoke_subagent') &&
        Array.isArray(subagentsList)
      ) {
        const rawAction = unquoteTranscriptString(args?.toolAction)
        const rawSummary = unquoteTranscriptString(args?.toolSummary)
        const summary =
          (typeof rawAction === 'string' && rawAction.trim()) ||
          (typeof rawSummary === 'string' && rawSummary.trim()) ||
          'Delegated subagent work'
        const children = subagentsList.map((sub, idx) => {
          const role = unquoteTranscriptString(sub?.Role || sub?.TypeName) || 'subagent'
          const model = unquoteTranscriptString(sub?.Model) || undefined
          return {
            key: `${role}:${idx}`,
            agent: role,
            status: 'running',
            ...(model && model !== 'inherit' ? { model } : {}),
            summary,
          }
        })
        const firstRole = children[0]?.agent || 'subagent'
        seq++
        events.push({
          seq,
          kind: 'subagent',
          name: 'invoke_subagent',
          status: 'ok',
          summary,
          children,
          role: firstRole,
          action: summary,
          ...(occurredAt ? { occurredAt } : {}),
          step_index: step.step_index ?? null,
        })
        const rolesLabel = children.map((c) => c.agent).join(', ')
        bullets.push(`✓ \`invoke_subagent\` — \`${rolesLabel}\` → ${summary}`)
        continue
      }

      const rawAction = unquoteTranscriptString(args?.toolAction)
      const rawSummary = unquoteTranscriptString(args?.toolSummary)
      const action =
        (typeof rawAction === 'string' && rawAction.trim()) ||
        (typeof rawSummary === 'string' && rawSummary.trim()) ||
        toolName
      const summary = (typeof rawSummary === 'string' && rawSummary.trim()) || action

      const domainInfo = classifyDevspecDomainTool(toolName, args, { titleById })
      if (domainInfo?.domain) {
        seq++
        const domainEvent = {
          seq,
          kind: 'domain',
          domain: domainInfo.domain,
          action: domainInfo.action,
          name: domainInfo.verb,
          status: 'ok',
          ...(domainInfo.title ? { title: domainInfo.title } : {}),
          ...(domainInfo.id ? { id: domainInfo.id } : {}),
          ...(summary ? { result: summary } : {}),
          ...(occurredAt ? { occurredAt } : {}),
          step_index: step.step_index ?? null,
        }
        events.push(domainEvent)
        const bulletIdx = bullets.length
        const argBit = domainEvent.title ? ` — \`${domainEvent.title}\`` : ''
        bullets.push(`✓ \`${domainInfo.verb}\`${argBit} → ${action}`)
        domainBulletMeta.set(domainEvent, { bulletIdx, verb: domainInfo.verb, action })
        if (
          domainInfo.verb === 'create_task' ||
          domainInfo.verb === 'record_memory' ||
          domainInfo.verb === 'create_resource'
        ) {
          pendingCreatedDomainEvent = domainEvent
        }
        continue
      }

      const { canonicalName, argsText } = normalizeCanonicalToolEvent(toolName, args)
      seq++
      events.push({
        seq,
        kind: 'tool',
        name: canonicalName,
        tool_name: toolName,
        status: 'ok',
        ...(argsText ? { args: argsText } : {}),
        ...(action ? { result: action } : {}),
        action,
        summary,
        ...(occurredAt ? { occurredAt } : {}),
        step_index: step.step_index ?? null,
      })
      const oneLine = argsText ? argsText.replace(/\s+/g, ' ') : ''
      const excerpt = oneLine.length > TRAIL_LINE_ARGS_CHARS ? `${oneLine.slice(0, TRAIL_LINE_ARGS_CHARS - 1)}…` : oneLine
      const shortArgs = excerpt ? ` — \`${excerpt}\`` : ''
      bullets.push(`✓ \`${canonicalName}\`${shortArgs} → ${action}`)
    }
  }

  const taskIds = new Set()
  let createdTaskEvents = []
  for (const ev of events) {
    if (ev.kind !== 'domain') continue
    if (
      (ev.domain === 'task' || ev.domain === 'implementation' || ev.domain === 'criterion') &&
      ev.id &&
      UUID_RE.test(ev.id)
    ) {
      taskIds.add(ev.id)
    }
    if (ev.name === 'create_task') {
      createdTaskEvents.push(ev)
    }
    if (ev.id && ev.title && isHumanDomainTitle(ev.title)) {
      titleById.set(ev.id, ev.title)
    }
  }
  const singleTaskId = taskIds.size === 1 ? [...taskIds][0] : null
  if (singleTaskId && createdTaskEvents.length === 1) {
    const createdEv = createdTaskEvents[0]
    if (!createdEv.id) createdEv.id = singleTaskId
    if (createdEv.title && isHumanDomainTitle(createdEv.title) && !titleById.has(singleTaskId)) {
      titleById.set(singleTaskId, createdEv.title)
    }
  }
  for (const ev of events) {
    if (ev.kind !== 'domain') continue
    if (
      !ev.id &&
      singleTaskId &&
      (ev.name === 'create_task' ||
        ev.name === 'claim_work_item' ||
        ev.name === 'record_implementation' ||
        ev.name === 'record_criterion_verdicts')
    ) {
      ev.id = singleTaskId
    }
    if (!ev.title && ev.id && titleById.has(ev.id)) {
      ev.title = titleById.get(ev.id)
    }
    const meta = domainBulletMeta.get(ev)
    if (meta && ev.title) {
      bullets[meta.bulletIdx] = `✓ \`${meta.verb}\` — \`${ev.title}\` → ${meta.action}`
    }
  }

  const markdown = bullets.join('\n')
  const signature = JSON.stringify(
    events.map((e) => [e.seq, e.kind, e.name || e.text || e.role, e.args || e.title || e.action]),
  )
  return { events, markdown, signature, replyPosted }
}

/**
 * Stream a throttled mid-turn `phase: 'trail'` update from `PostToolUse` while
 * `.turn` is active and before `.explicit-reply` is set.
 *
 * Matches Pi's live work-trail UX without background-poller race conditions or
 * orphaned `"No response"` bubbles.
 */
export async function streamTurnTrailIfChanged(
  state,
  {
    connectionsDir = CONNECTIONS_DIR,
    call = mcpToolsCall,
    now = Date.now(),
    minIntervalMs = 1500,
    home = os.homedir(),
  } = {},
) {
  if (!state?.connection_id) {
    return { streamed: false, reason: 'not_attached' }
  }
  const connectionId = state.connection_id
  if (fs.existsSync(explicitReplyMarkerPath(connectionId, connectionsDir))) {
    return { streamed: false, reason: 'explicit_reply_already_sent' }
  }
  const marker = readTurnMarker(connectionId, connectionsDir)
  if (!marker || marker.held) {
    return { streamed: false, reason: 'no_active_turn' }
  }
  if (!state.session_id && !marker.remoteTurn) {
    return { streamed: false, reason: 'not_attached' }
  }
  // A turn woken only by DevSpec notices or check jobs has no command turn to carry a
  // trail: the server would file it under the previous command (notice-reply.mjs).
  if (currentTurnNoticeIds(connectionId, { dir: connectionsDir, connectionState: state, marker })) {
    return { streamed: false, reason: 'notice_turn' }
  }
  if (isCurrentTurnCheckJobOnly(connectionId, { dir: connectionsDir, connectionState: state, marker })) {
    return { streamed: false, reason: 'check_job_turn' }
  }
  const isLocalMirroredTurn = Boolean(
    !marker.remoteTurn &&
      (marker.localPromptMirrored || marker.localTurn || state.local_turn),
  )
  if (marker.backgroundContinuation && !isLocalMirroredTurn) {
    const reqState = readRequestState(connectionId, { dir: connectionsDir })
    const hasOpenCommand = [...reqState.open.values()].some((r) => r.kind === 'command')
    if (!hasOpenCommand) {
      return { streamed: false, reason: 'background_continuation_turn' }
    }
  }
  const tPath =
    normalizeTranscriptPath(state.transcript_path) ||
    inferAntigravityTranscriptPath(state.local_id)
  if (!tPath || !fs.existsSync(tPath)) {
    return { streamed: false, reason: 'no_transcript' }
  }

  let rawTranscript = ''
  try {
    rawTranscript = fs.readFileSync(tPath, 'utf8')
  } catch {
    return { streamed: false, reason: 'transcript_read_error' }
  }

  const trail = extractAntigravityTrailFromTranscript(rawTranscript, {
    sinceMs: marker.startedAt,
    excludedRanges: marker.excludedRanges ?? [],
    stopAtReply: true,
    transcriptPath: tPath,
  })
  if (trail.replyPosted) {
    return { streamed: false, reason: 'reply_posted_in_transcript' }
  }
  if (!trail.markdown || trail.events.length === 0) {
    return { streamed: false, reason: 'empty_trail' }
  }

  const stateFile = trailStatePath(connectionId, connectionsDir)
  let prev = null
  try {
    prev = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  } catch {
    prev = null
  }
  if (prev && prev.startedAt === marker.startedAt) {
    if (prev.signature === trail.signature) {
      return { streamed: false, reason: 'unchanged' }
    }
    if (typeof prev.lastSentAt === 'number' && now - prev.lastSentAt < minIntervalMs) {
      return { streamed: false, reason: 'throttled' }
    }
  }

  const credential = connectionCredential(state)
  if (!credential) return { streamed: false, reason: 'no_auth_token' }
  const { token, mcpUrl } = credential

  const telemetry = readConnectionTelemetry(connectionId, { home })
  const postArgs = {
    connection_id: connectionId,
    ...(state.session_id ? { session_id: state.session_id } : {}),
    agent_name: AGENT_NAME,
    phase: 'trail',
    message: trail.markdown,
    work_trail: trail.markdown,
    trail_events: trail.events,
    ...(isLocalMirroredTurn ? { command_turn_unbound: true, local_turn: true } : {}),
    ...(telemetry?.model?.id
      ? {
          model: {
            providerID: telemetry.model.provider || 'google',
            modelID: telemetry.model.id,
          },
        }
      : {}),
  }

  const res = await call({
    mcpUrl,
    token,
    name: 'post_session_message',
    arguments: postArgs,
  })
  if (res?.isError === true || res?.result?.isError === true) {
    return { streamed: false, reason: 'server_refused' }
  }

  try {
    ensurePrivateDir(connectionsDir)
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        startedAt: marker.startedAt,
        signature: trail.signature,
        lastSentAt: now,
        eventCount: trail.events.length,
      }),
      { mode: 0o600 },
    )
  } catch {
    /* non-fatal */
  }

  return { streamed: true, eventCount: trail.events.length, signature: trail.signature }
}

/**
 * Extract the latest assistant `PLANNER_RESPONSE` text from `transcript.jsonl`
 * for the current turn (after the latest `USER_INPUT` / `SYSTEM_MESSAGE` boundary
 * or since `sinceMs`).
 */
export function extractLatestAssistantReplyFromTranscript(
  transcriptPath,
  { sinceMs = null, excludedRanges = [], afterLastSystemMessage = false } = {},
) {
  if (!transcriptPath) return null
  let raw = ''
  try {
    const stat = fs.statSync(transcriptPath)
    if (!stat.isFile() || stat.size === 0) return null
    const readSize = Math.min(stat.size, 262_144)
    const fd = fs.openSync(transcriptPath, 'r')
    try {
      const buf = Buffer.alloc(readSize)
      fs.readSync(fd, buf, 0, readSize, stat.size - readSize)
      raw = buf.toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null
  }

  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  const steps = []
  for (const line of lines) {
    try {
      steps.push(JSON.parse(line))
    } catch {
      /* skip partial first line in tail chunk */
    }
  }

  // Find the last USER_INPUT (or SYSTEM_MESSAGE for isolated sub-turns) boundary
  let lastUserBoundary = -1
  for (let i = steps.length - 1; i >= 0; i--) {
    if (
      steps[i]?.type === 'USER_INPUT' ||
      (afterLastSystemMessage && steps[i]?.type === 'SYSTEM_MESSAGE')
    ) {
      lastUserBoundary = i
      break
    }
  }

  for (let i = steps.length - 1; i > lastUserBoundary; i--) {
    const step = steps[i]
    if (!step || step.type !== 'PLANNER_RESPONSE') continue
    if (step.created_at) {
      const stepMs = Date.parse(step.created_at)
      if (Number.isFinite(stepMs)) {
        if (typeof sinceMs === 'number' && Number.isFinite(sinceMs) && stepMs < sinceMs) continue
        if (isTimestampInExcludedRanges(stepMs, excludedRanges)) continue
      }
    }
    if (typeof step.content === 'string' && step.content.trim()) {
      const cleaned = prepareAgentMirrorText(step.content)
      if (cleaned) return cleaned
    }
  }
  return null
}

const REMOTE_STATUS_BANNER = '━━━ DevSpec Remote Control ━━━'

/**
 * Strip the terminal status block agents often paste into Stop output.
 * Removes from the banner header through the trailing rule line.
 */
export function stripRemoteControlBanner(text) {
  const t = String(text ?? '')
  const start = t.indexOf(REMOTE_STATUS_BANNER)
  if (start < 0) return t
  const afterHeader = t.slice(start + REMOTE_STATUS_BANNER.length)
  // Prefer the unicode rule line used in skills; fall back to ASCII dashes.
  const ruleMatch = afterHeader.match(/\n[─-]{3,}\s*\n?/)
  let end = start + REMOTE_STATUS_BANNER.length
  if (ruleMatch && typeof ruleMatch.index === 'number') {
    end += ruleMatch.index + ruleMatch[0].length
  } else {
    // No rule line — drop from banner to end of that paragraph block.
    const nextBlank = afterHeader.search(/\n\s*\n/)
    end = nextBlank >= 0 ? start + REMOTE_STATUS_BANNER.length + nextBlank : t.length
  }
  return `${t.slice(0, start)}${t.slice(end)}`.replace(/^\s+|\s+$/g, '')
}

/**
 * True when Stop (or agent) text is operational chrome that must not become a
 * session chat bubble. Fail open for ambiguous / real replies.
 */
export function isOperationalChrome(text) {
  let t = String(text ?? '').trim()
  if (!t) return true

  if (/^🔌?\s*\*{0,2}Local agent disconnected\*{0,2}\.?\s*$/i.test(t)) return true
  if (/^You're connected to .+ agent on their local machine\.?\s*$/i.test(t)) return true
  if (/^Connected and waiting for your next command\b/i.test(t) && t.length < 280) return true

  if (t.includes(REMOTE_STATUS_BANNER)) {
    t = stripRemoteControlBanner(t).trim()
    if (!t) return true
    if (/^Connected and waiting for your next command\b/i.test(t) && t.length < 280) return true
    if (/^🔌?\s*\*{0,2}Local agent disconnected\*{0,2}\.?\s*$/i.test(t)) return true
    if (/^You're connected to .+ agent on their local machine\.?\s*$/i.test(t)) return true
    // Banner plus a tiny leftover (e.g. "Open: Agents page") — still chrome.
    if (t.length < 80 && /^(Agent|Connection|Session|Status|Open|Stop with):/m.test(t)) return true
  }

  return false
}

/**
 * Prepare agent Stop text for mirroring: strip known chrome; return null to skip.
 */
export function prepareAgentMirrorText(text) {
  let t = String(text ?? '').trim()
  if (!t) return null
  if (t.includes(REMOTE_STATUS_BANNER)) t = stripRemoteControlBanner(t).trim()
  if (!t || isOperationalChrome(t)) return null
  return fitPostMessage(t)
}

export function patchOwnState(connectionId, patch, connectionsDir = CONNECTIONS_DIR) {
  if (!connectionId || !patch || typeof patch !== 'object') return false
  const file = path.join(connectionsDir, `${connectionId}.json`)
  try {
    if (!fs.existsSync(file)) return false
    const current = JSON.parse(fs.readFileSync(file, 'utf8'))
    const updated = {
      ...current,
      ...patch,
      updated_at: new Date().toISOString(),
    }
    // Connection state holds the key: 0600 aside-and-rename (item b17cb7d7).
    writePrivateJson(file, updated)
    return true
  } catch {
    return false
  }
}

/**
 * Execute the mirror-turn lifecycle logic in-process or from CLI.
 */
export async function handleMirrorTurn(
  modeArg = mode,
  raw = '',
  {
    env = process.env,
    connectionsDir = CONNECTIONS_DIR,
    legacyPath = LEGACY_STATE_PATH,
    call = mcpToolsCall,
  } = {},
) {
  if (modeArg === 'background_launch') {
    return recordBackgroundLaunch(raw, {
      load: (id) => loadState(id, { connectionsDir, legacyPath }),
      dir: connectionsDir,
      env,
    })
  }

  let parsedHookInput = {}
  try {
    parsedHookInput = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw || {}
  } catch {
    parsedHookInput = {}
  }
  if (
    parsedHookInput?.parentConversationId ||
    parsedHookInput?.parent_conversation_id ||
    parsedHookInput?.agent_id
  ) {
    return { ok: true, skipped: 'subagent_invocation' }
  }

  const conversationId = resolveHookConversationId(raw, env)
  const state = loadState(conversationId, { connectionsDir, legacyPath })
  if (!state) return { ok: true, skipped: 'no_bound_state' }

  const hookTranscriptPath = parseTranscriptPath(raw)
  syncStateTranscriptPath(state, hookTranscriptPath, conversationId, { connectionsDir, env })

  const credential = connectionCredential(state)
  if (!credential) return { ok: true, skipped: 'no_auth_token' }
  const { token, mcpUrl } = credential

  const agentName = AGENT_NAME
  const connectionId = state.connection_id
  const sessionId = state.session_id || null
  const effectiveTranscriptPath = hookTranscriptPath || state.transcript_path

  // In Antigravity, PreInvocation fires before EVERY LLM step in a multi-step turn.
  // If a `.turn` marker is already live AND the latest transcript step is not a new
  // USER_INPUT (or was already mirrored for this step_index), avoid duplicate
  // local_prompt posts and redundant heartbeats on every tool iteration.
  const rawExistingMarker = readTurnMarker(connectionId, connectionsDir)
  const reconciled = reconcileCompletedOwnedWork(
    connectionId,
    rawExistingMarker,
    effectiveTranscriptPath,
    connectionsDir,
  )
  const latestStep = extractLatestTranscriptStep(effectiveTranscriptPath)
  const existingMarker =
    modeArg === 'user_prompt'
      ? restoreHeldParentIfResumed(connectionId, rawExistingMarker, {
          dir: connectionsDir,
          reconciled,
          latestStep,
          requireParentNotificationStep: true,
        }).marker
      : rawExistingMarker
  const latestStepMs = latestStep?.created_at ? Date.parse(latestStep.created_at) : NaN
  const latestStepIsBeforeMarker =
    Boolean(
      existingMarker && !existingMarker.held && typeof existingMarker.startedAt === 'number',
    ) &&
    Number.isFinite(latestStepMs) &&
    latestStepMs < existingMarker.startedAt - 2000
  const isNewUserInputStep =
    !latestStepIsBeforeMarker &&
    latestStep?.type === 'USER_INPUT' &&
    (typeof latestStep.step_index !== 'number' ||
      existingMarker?.lastStepIndex !== latestStep.step_index)

  if (modeArg === 'user_prompt' && existingMarker && !existingMarker.held && !isNewUserInputStep) {
    // Check if hookInput had an explicit prompt field (e.g. direct UserPromptSubmit test)
    let parsedInput = {}
    try {
      parsedInput = JSON.parse(raw || '{}')
    } catch {
      parsedInput = {}
    }
    const hasExplicitPromptField = Boolean(
      parsedInput.prompt || parsedInput.user_prompt || parsedInput.message || parsedInput.text,
    )
    if (!hasExplicitPromptField) {
      return { ok: true, skipped: 'mid_turn_pre_invocation' }
    }
  }

  const text = latestStepIsBeforeMarker
    ? parsedHookInput?.prompt ||
      parsedHookInput?.user_prompt ||
      parsedHookInput?.message ||
      parsedHookInput?.text ||
      null
    : extractLastText(raw, modeArg)
  const rawStepContent =
    !latestStepIsBeforeMarker && typeof latestStep?.content === 'string' ? latestStep.content : ''
  const inferredTranscriptContext =
    !isNewUserInputStep
      ? inferTurnContextFromTranscript(effectiveTranscriptPath)
      : null
  const isRemoteControlCommand =
    (isNewUserInputStep && isRemoteControlCommandPrompt(rawStepContent || text)) ||
    (!isNewUserInputStep && Boolean(inferredTranscriptContext?.remoteControlCommand)) ||
    (modeArg === 'user_prompt' && isRemoteControlCommandPrompt(text))
  if (isRemoteControlCommand && !existingMarker) {
    return { ok: true, skipped: 'remote_control_command' }
  }
  const isBgContinuation =
    modeArg === 'user_prompt' &&
    !isNewUserInputStep &&
    (isBackgroundTaskNotification(rawStepContent || text) ||
      Boolean(inferredTranscriptContext?.backgroundContinuation) ||
      (Boolean(existingMarker?.held) &&
        latestStep?.type === 'SYSTEM_MESSAGE' &&
        !rawStepContent.includes('[DevSpec Remote Wake]')))
  // When `existingMarker.heldParent` is still parked (meaning `restoreHeldParentIfResumed`
  // intentionally declined to restore — e.g. a check-job helper subagent finished while
  // the check pause is still active), keep the pause context intact instead of promoting
  // `heldParent` into the active turn (decisions a2d9f38f & c1791ffa).
  const pauseStillParked = Boolean(existingMarker?.heldParent && !existingMarker?.otherWake)
  const bgParentContext = isBgContinuation
    ? pauseStillParked
      ? existingMarker
      : existingMarker?.heldParent || existingMarker || inferredTranscriptContext || {}
    : null
  const isExplicitUserInputStep =
    !isBgContinuation &&
    latestStep?.type === 'USER_INPUT' &&
    !rawStepContent.includes('[DevSpec Remote Wake]') &&
    parsedHookInput?.remote_turn !== true
  const isRemoteWakeInput = isBgContinuation
    ? Boolean(bgParentContext?.remoteTurn)
    : !isExplicitUserInputStep &&
      (Boolean(existingMarker?.remoteTurn) ||
        parsedHookInput?.remote_turn === true ||
        (typeof text === 'string' && text.includes('[DevSpec Remote Wake]')) ||
        rawStepContent.includes('[DevSpec Remote Wake]') ||
        (latestStep?.type === 'SYSTEM_MESSAGE' &&
          (rawStepContent.includes('"event":"wake"') ||
            rawStepContent.includes('"type":"system_notice"') ||
            rawStepContent.includes('"type":"check_job"') ||
            rawStepContent.includes('"event":"directives"') ||
            rawStepContent.includes('"event":"automation_run"') ||
            rawStepContent.includes('"event":"interaction_answer"') ||
            rawStepContent.includes('"event":"question_dismissal"'))))

  const skipMirror =
    modeArg === 'user_prompt' &&
    (isBgContinuation ||
      (!!text && isHarnessInjection(text)) ||
      latestStep?.type === 'SYSTEM_MESSAGE')

  const fromAPerson =
    modeArg === 'user_prompt' &&
    !isBgContinuation &&
    !isRemoteWakeInput &&
    !skipMirror &&
    Boolean(text && String(text).trim())

  let typedRequest = null
  if (fromAPerson && connectionId) {
    try {
      const arrival = promptArrival({
        fromAPerson: true,
        text,
        midTurn: false,
        state: readRequestState(connectionId, { dir: connectionsDir }),
      })
      for (const event of arrival.events) {
        appendRequestEvent(connectionId, event, { dir: connectionsDir })
      }
      if (arrival.typedId) typedRequest = { id: arrival.typedId, midTurn: false }
    } catch {
      /* non-fatal */
    }
  } else if (isBgContinuation && connectionId) {
    try {
      const arrival = promptArrival({
        fromAPerson: false,
        origin: 'task-notification',
        text: rawStepContent || text || '',
        midTurn: false,
        state: readRequestState(connectionId, { dir: connectionsDir }),
      })
      for (const event of arrival.events) {
        // When the mid-wait check/notice pause is still parked (e.g. parent work
        // finished while an unsettled check is waiting on its helper), NEVER make
        // the parent's request current yet — only record `notified` so the entire
        // check/notice pause stays separate from the person's command (decision a2d9f38f).
        if (pauseStillParked && event.op !== 'notified') continue
        appendRequestEvent(connectionId, event, { dir: connectionsDir })
      }
    } catch {
      /* non-fatal */
    }
  }

  const callRequest = (args) =>
    call({
      mcpUrl,
      token,
      connectionCapability: state.connection_capability,
      name: 'report_request',
      arguments: args,
    })

  try {
    let admittedLocalTurn = null
    if (fromAPerson && connectionId && sessionId && state.connection_capability) {
      const scope = localTurnScope(state, sessionId)
      if (scope) {
        admittedLocalTurn = await startLocalTurn({
          scope,
          previousAttemptId: state.local_turn?.attempt_id ?? null,
          call: (args) =>
            call({
              mcpUrl,
              token,
              connectionCapability: state.connection_capability,
              name: 'report_pickup',
              arguments: args,
            }),
        })
        if (admittedLocalTurn) {
          patchOwnState(connectionId, { local_turn: admittedLocalTurn }, connectionsDir)
          state.local_turn = admittedLocalTurn
        }
      }
    }

    if (typedRequest && connectionId && state.connection_capability) {
      await openRequest({
        connectionId,
        kind: 'typed_prompt',
        call: callRequest,
        dir: connectionsDir,
        id: typedRequest.id,
      }).catch(() => null)
    }

    let localPromptMirrored = false
    if (
      modeArg === 'user_prompt' &&
      sessionId &&
      text &&
      String(text).trim() &&
      !skipMirror &&
      !isRemoteWakeInput
    ) {
      const cleaned = fitPostMessage(String(text).trim())
      if (cleaned) {
        const postArgs = {
          message: cleaned,
          agent_name: agentName,
          turn_kind: 'local_prompt',
        }
        if (connectionId) postArgs.connection_id = connectionId
        else postArgs.session_id = sessionId
        const mirrorRes = await call({
          mcpUrl,
          token,
          name: 'post_session_message',
          arguments: postArgs,
        })
        localPromptMirrored = true
        if (connectionId && sessionId) {
          recordMirroredLocalPrompt(connectionId, sessionId, {
            messageId:
              mirrorRes?.message_id ||
              mirrorRes?.id ||
              mirrorRes?.message?.id ||
              mirrorRes?.data?.message_id ||
              null,
            text: cleaned,
            dir: connectionsDir,
          })
        }
      }
    }

    const turnActive = modeArg === 'user_prompt'
    if (turnActive) {
      // What woke the turn (notice-reply.mjs): the wake's own notice ids, checkJobWake,
      // or that a person or a command did. The listener records the same as it delivers;
      // both write, so neither ordering of the two loses it. A background task or
      // subagent continuation inherits its parent turn's wake context instead of parsing
      // background stdout as a new wake.
      const bgParentHasCommandOrPrompt = Boolean(
        bgParentContext?.otherWake ||
          bgParentContext?.localPromptMirrored ||
          bgParentContext?.localTurn ||
          existingMarker?.heldParent,
      )
      const wake = isBgContinuation
        ? {
            ...(!bgParentHasCommandOrPrompt &&
            Array.isArray(bgParentContext?.noticeIds) &&
            bgParentContext.noticeIds.length > 0
              ? { noticeIds: bgParentContext.noticeIds }
              : {}),
            ...(!bgParentHasCommandOrPrompt &&
            Array.isArray(bgParentContext?.recordNoticeIds) &&
            bgParentContext.recordNoticeIds.length > 0
              ? { recordNoticeIds: bgParentContext.recordNoticeIds }
              : {}),
            ...(!bgParentHasCommandOrPrompt && bgParentContext?.checkJobWake
              ? { checkJobWake: true }
              : {}),
            ...(bgParentContext?.otherWake ? { otherWake: true } : {}),
          }
        : isRemoteWakeInput
          ? turnWakeFromText(rawStepContent || text)
          : fromAPerson
            ? { otherWake: true }
            : null
      const isMidWaitNonCommandWake = Boolean(
        !isBgContinuation &&
          isRemoteWakeInput &&
          (existingMarker?.held === true ||
            (existingMarker?.heldParent && !existingMarker?.otherWake)) &&
          wake &&
          !wake.otherWake &&
          (wake.checkJobWake || wake.noticeIds?.length || wake.recordNoticeIds?.length),
      )
      if (
        connectionId &&
        isRemoteWakeInput &&
        (wake?.checkJobWake || wake?.noticeIds?.length || wake?.recordNoticeIds?.length) &&
        (isMidWaitNonCommandWake ||
          (!existingMarker?.otherWake &&
            !bgParentContext?.otherWake &&
            !existingMarker?.localPromptMirrored &&
            !bgParentContext?.localPromptMirrored &&
            !existingMarker?.localTurn &&
            !bgParentContext?.localTurn &&
            !state?.local_turn))
      ) {
        try {
          setCurrentRequest(connectionId, UNSTATED, { dir: connectionsDir })
        } catch {
          /* non-fatal */
        }
      }
      const preservedLocalMirrored = isMidWaitNonCommandWake
        ? false
        : Boolean(
            localPromptMirrored ||
              (isBgContinuation &&
                (bgParentContext?.localPromptMirrored || existingMarker?.localPromptMirrored)),
          )
      const preservedLocalTurn = isMidWaitNonCommandWake
        ? null
        : admittedLocalTurn ||
          (isBgContinuation ? bgParentContext?.localTurn || existingMarker?.localTurn || null : null)
      const currentMarkerForMerge = readTurnMarker(connectionId, connectionsDir)
      const pauseStartFromStep =
        Number.isFinite(latestStepMs) && latestStepMs <= Date.now()
          ? latestStepMs
          : Date.now()
      const mergedMidWait = isMidWaitNonCommandWake
        ? mergeTurnWake(
            currentMarkerForMerge?.heldParent
              ? currentMarkerForMerge
              : currentMarkerForMerge?.held === true
                ? null
                : currentMarkerForMerge,
            wake,
          )
        : null
      const midWaitSettled = Array.isArray(existingMarker?.settledCheckJobIds)
        ? existingMarker.settledCheckJobIds.map((id) => String(id).toLowerCase())
        : []
      const midWaitMergedJobs = Array.isArray(mergedMidWait?.checkJobIds)
        ? mergedMidWait.checkJobIds.map((id) => String(id).toLowerCase())
        : []
      const midWaitKeepRuled =
        Boolean(existingMarker?.heldParent && existingMarker?.checkJobRuled) &&
        !(
          Boolean(wake?.checkJobWake) &&
          (midWaitMergedJobs.length === 0 ||
            midWaitMergedJobs.some((id) => !midWaitSettled.includes(id)))
        )
      const midWaitReplied = Array.isArray(existingMarker?.repliedNoticeIds)
        ? existingMarker.repliedNoticeIds.map((id) => String(id).toLowerCase())
        : []
      const midWaitMergedNotices = Array.isArray(mergedMidWait?.noticeIds)
        ? mergedMidWait.noticeIds.map((id) => String(id).toLowerCase())
        : []
      const midWaitHasUnrepliedNotice = midWaitMergedNotices.some(
        (id) => !midWaitReplied.includes(id),
      )
      const markerExtra = isMidWaitNonCommandWake
        ? {
            held: false,
            heldParent: snapshotHeldParent(existingMarker, { connectionId, dir: connectionsDir }),
            remoteTurn: true,
            localPromptMirrored: false,
            localTurn: null,
            otherWake: false,
            backgroundContinuation: false,
            settledCheckJobIds: midWaitSettled,
            repliedNoticeIds: midWaitReplied,
            checkJobRuled: midWaitKeepRuled,
            checkJobRuledAt: midWaitKeepRuled ? existingMarker?.checkJobRuledAt ?? null : null,
            ...(midWaitHasUnrepliedNotice
              ? { noticeReplyAt: null, acceptedNoticeReplyAt: null }
              : {}),
            lastPauseActivityAt: Date.now(),
            pauseStartedAt:
              typeof existingMarker?.pauseStartedAt === 'number'
                ? existingMarker.pauseStartedAt
                : pauseStartFromStep,
            excludedRanges: normalizeExcludedRanges(existingMarker?.excludedRanges),
            ...mergedMidWait,
            preserveExplicitReply: true,
          }
        : isBgContinuation && pauseStillParked
          ? {
              held: false,
              heldParent: existingMarker.heldParent,
              remoteTurn: true,
              localPromptMirrored: false,
              localTurn: null,
              otherWake: false,
              backgroundContinuation: false,
              lastPauseActivityAt: Math.max(
                typeof existingMarker.lastPauseActivityAt === 'number'
                  ? existingMarker.lastPauseActivityAt
                  : 0,
                Date.now(),
              ),
              preserveExplicitReply: true,
            }
          : {
              held: false,
              heldParent: null,
              remoteTurn: Boolean(isRemoteWakeInput),
              localPromptMirrored: preservedLocalMirrored,
              ...(isBgContinuation
                ? {
                    backgroundContinuation: true,
                    ...(bgParentHasCommandOrPrompt
                      ? { noticeIds: [], recordNoticeIds: [], checkJobWake: false }
                      : {}),
                  }
                : {}),
              ...(preservedLocalTurn ? { localTurn: preservedLocalTurn } : { localTurn: null }),
              ...mergeTurnWake(
                isBgContinuation && bgParentHasCommandOrPrompt
                  ? { otherWake: Boolean(bgParentContext?.otherWake) }
                  : currentMarkerForMerge,
                wake,
              ),
              ...(isBgContinuation ? { preserveExplicitReply: true } : {}),
            }
      if (typeof latestStep?.step_index === 'number') {
        markerExtra.lastStepIndex = latestStep.step_index
      }
      writeTurnMarker(connectionId, markerExtra, connectionsDir)
    } else {
      // On Stop: check if this turn launched background work (e.g. subagent, async command,
      // or one-shot timer) that has not yet reported back. If so, hold the turn open instead
      // of closing it.
      let marker = readTurnMarker(connectionId, connectionsDir)
      const stopReconciled = reconcileCompletedOwnedWork(
        connectionId,
        marker,
        effectiveTranscriptPath,
        connectionsDir,
      )
      const outstandingIds = marker ? readOwnedIds(connectionId, marker, connectionsDir) : []
      if (outstandingIds.length > 0) {
        if (marker?.heldParent) {
          const parent = marker.heldParent
          const parentOwnedIds = Array.isArray(parent.ownedIds)
            ? parent.ownedIds.filter((id) => typeof id === 'string' && id)
            : []
          const pauseOutstandingIds = outstandingIds.filter((id) => !parentOwnedIds.includes(id))
          if (pauseOutstandingIds.length > 0) {
            // A launch started during the mid-wait pause (such as a fresh check-ruling
            // helper subagent) is still running: keep the pause context intact until it
            // finishes rather than dropping checkJobWake/notice context prematurely
            // (decisions a2d9f38f & c1791ffa).
            writeTurnMarker(
              connectionId,
              {
                held: true,
                preserveExplicitReply: true,
              },
              connectionsDir,
            )
            return { ok: true, held: true, outstanding: outstandingIds }
          }
          const midWaitNotices = currentTurnReplyNoticeIds(connectionId, {
            dir: connectionsDir,
            connectionState: state,
            marker,
          })
          const midWaitRoutine = isCurrentTurnRoutine(connectionId, {
            dir: connectionsDir,
            connectionState: state,
            marker,
          })
          if (
            (midWaitNotices || midWaitRoutine) &&
            marker.tellPerson &&
            !marker.noticeReplyAt &&
            !marker.personToldAt &&
            sessionId
          ) {
            const tellText =
              (text ? prepareAgentMirrorText(text) : null) ||
              extractLatestAssistantReplyFromTranscript(effectiveTranscriptPath, {
                sinceMs: marker.startedAt ?? null,
                afterLastSystemMessage: true,
              })
            if (tellText) {
              await postTellPersonBackstop({
                call, mcpUrl, token, state, connectionId, agentName, message: tellText, marker, connectionsDir,
              })
            }
          }
          const pauseEndMs = Date.now()
          const nextExcludedRanges =
            typeof marker.pauseStartedAt === 'number'
              ? appendExcludedRange(marker.excludedRanges, marker.pauseStartedAt, pauseEndMs)
              : normalizeExcludedRanges(marker.excludedRanges)
          writeTurnMarker(
            connectionId,
            {
              held: true,
              heldParent: null,
              remoteTurn: Boolean(parent.remoteTurn),
              localPromptMirrored: Boolean(parent.localPromptMirrored),
              localTurn: parent.localTurn || null,
              otherWake: Boolean(parent.otherWake),
              backgroundContinuation: Boolean(parent.backgroundContinuation),
              noticeIds: [],
              recordNoticeIds: [],
              checkJobWake: false,
              checkJobRuled: false,
              pauseStartedAt: null,
              resumedFromPauseAt: pauseEndMs,
              excludedRanges: nextExcludedRanges,
              tellPerson: false,
              noticeReplyAt: null,
              personToldAt: null,
              preserveExplicitReply: true,
            },
            connectionsDir,
          )
          return { ok: true, held: true, outstanding: outstandingIds }
        }
        const parentIsCommandOrPrompt = Boolean(
          marker?.otherWake || marker?.localPromptMirrored || marker?.localTurn,
        )
        writeTurnMarker(
          connectionId,
          {
            held: true,
            ...(parentIsCommandOrPrompt
              ? { noticeIds: [], recordNoticeIds: [], checkJobWake: false }
              : {}),
            preserveExplicitReply: true,
          },
          connectionsDir,
        )
        return { ok: true, held: true, outstanding: outstandingIds }
      }

      // Never blindly pop `heldParent` at Stop when no resumed post-completion
      // parent work restored it during the turn: if a quiet notice or check pause
      // reached Stop without resumed parent work, keep the notice/check silent
      // instead of scraping notice-only text as the command reply (decision 02f4ce2b).

      let hadStreamedTrail = false
      try {
        const tsRaw = JSON.parse(
          fs.readFileSync(trailStatePath(connectionId, connectionsDir), 'utf8'),
        )
        hadStreamedTrail = Boolean(
          tsRaw && typeof marker?.startedAt === 'number' && tsRaw.startedAt === marker.startedAt,
        )
      } catch {
        hadStreamedTrail = false
      }

      const hadExplicitReply = consumeExplicitReplyMarker(connectionId, connectionsDir)
      // Read before the marker goes: a turn woken only by DevSpec notices or check jobs
      // ends silently on Stop when the model did not call post_session_message itself —
      // never scraping local terminal notes into the room as a notice reply or command
      // answer (`check_job.room` and `semantics.notice_audience` in the served contract;
      // item 699517ad, decision 0fdb1237).
      const effectiveStopMarker =
        marker ||
        (inferredTranscriptContext &&
        !inferredTranscriptContext.otherWake &&
        !inferredTranscriptContext.localPromptMirrored &&
        (inferredTranscriptContext.checkJobWake ||
          inferredTranscriptContext.noticeIds?.length ||
          inferredTranscriptContext.recordNoticeIds?.length)
          ? { startedAt: Date.now(), ...inferredTranscriptContext }
          : null)
      const turnNotices = currentTurnReplyNoticeIds(connectionId, {
        dir: connectionsDir,
        connectionState: state,
        marker: effectiveStopMarker,
      })
      const routineTurn = isCurrentTurnRoutine(connectionId, {
        dir: connectionsDir,
        connectionState: state,
        marker: effectiveStopMarker,
      })
      clearTurnMarker(connectionId, connectionsDir)

      // Session fallback reply: if this turn ran on an attached session (either a remote wake
      // OR a local terminal prompt mirrored to the session) and the agent ended the turn
      // without calling post_session_message, extract the assistant's final response +
      // work_trail from the transcript and post it so the session room never misses the reply
      // or leaves an open streaming trail bubble as "No response".
      const isRemoteTurn = Boolean(marker?.remoteTurn || parsedHookInput?.remote_turn === true)
      const isLocalMirroredTurn = Boolean(
        !isRemoteTurn &&
          (marker?.localPromptMirrored || marker?.localTurn || state?.local_turn),
      )
      const isUnboundBgContinuation = Boolean(
        marker?.backgroundContinuation &&
          !isLocalMirroredTurn &&
          !hadStreamedTrail &&
          ![...readRequestState(connectionId, { dir: connectionsDir }).open.values()].some(
            (r) => r.kind === 'command',
          ),
      )
      const turnFailure = parseTurnFailure(parsedHookInput)
      if (turnNotices || routineTurn) {
        // Silent, except when a write in the turn carried `tell_person`
        // (`semantics.notice_audience.telling_anyway`) and the agent told nobody: then
        // its last words go to the room on DevSpec's speech lane, bound to no command
        // turn, so no trail and no complete_turn (postTellPersonBackstop).
        const tellText =
          marker?.tellPerson && !hadExplicitReply && !marker?.noticeReplyAt && !marker?.personToldAt && sessionId
            ? (text ? prepareAgentMirrorText(text) : null) ||
              extractLatestAssistantReplyFromTranscript(effectiveTranscriptPath, {
                sinceMs: marker?.startedAt ?? null,
              })
            : null
        if (tellText) {
          await postTellPersonBackstop({
            call, mcpUrl, token, state, connectionId, agentName, message: tellText, marker, connectionsDir,
          })
        }
      } else if (turnFailure && isRemoteTurn && sessionId && !isUnboundBgContinuation) {
        // The turn died on an error before the model could answer (item 408ad47b):
        // tell the room in Antigravity's own words instead of mirroring nothing. Posted
        // even after an explicit progress post, because the command still failed. An
        // ordinary answer, not phase error: the server drops an error post when no
        // working bubble is open, which is the silent case this exists for. A turn
        // typed in the terminal falls through: the error is already in front of them.
        const telemetry = connectionId ? readConnectionTelemetry(connectionId) : null
        try {
          await call({
            mcpUrl,
            token,
            name: 'post_session_message',
            arguments: {
              connection_id: connectionId,
              session_id: sessionId,
              agent_name: agentName,
              message: fitPostMessage(turnFailureMessage(turnFailure, agentName)),
              complete_turn: true,
              ...(telemetry ? { agent_stats: telemetry } : {}),
              ...(telemetry?.model?.id
                ? {
                    model: {
                      providerID: telemetry.model.provider || 'google',
                      modelID: telemetry.model.id,
                    },
                  }
                : {}),
            },
          })
        } catch {
          /* non-fatal: report_complete below still ends the turn */
        }
      } else if (
        !hadExplicitReply &&
        sessionId &&
        !isUnboundBgContinuation &&
        (isRemoteTurn || isLocalMirroredTurn || hadStreamedTrail)
      ) {
        let trail = { markdown: '', events: [] }
        if (effectiveTranscriptPath && fs.existsSync(effectiveTranscriptPath)) {
          try {
            trail = extractAntigravityTrailFromTranscript(
              fs.readFileSync(effectiveTranscriptPath, 'utf8'),
              {
                sinceMs: marker?.startedAt ?? null,
                excludedRanges: marker?.excludedRanges ?? [],
                stopAtReply: false,
                transcriptPath: effectiveTranscriptPath,
              },
            )
          } catch {
            /* ignore */
          }
        }
        const replySinceMs =
          typeof marker?.resumedFromPauseAt === 'number' && Number.isFinite(marker.resumedFromPauseAt)
            ? Math.max(marker?.startedAt ?? 0, marker.resumedFromPauseAt)
            : (marker?.startedAt ?? null)
        const rawStopText =
          (text ? prepareAgentMirrorText(text) : null) ||
          extractLatestAssistantReplyFromTranscript(effectiveTranscriptPath, {
            sinceMs: replySinceMs,
            excludedRanges: marker?.excludedRanges ?? [],
          }) ||
          (hadStreamedTrail && trail.events.length > 0
            ? `Completed ${trail.events.length} step${trail.events.length === 1 ? '' : 's'}.`
            : null)
        if (rawStopText) {
          const telemetry = connectionId ? readConnectionTelemetry(connectionId) : null
          const fallbackArgs = {
            connection_id: connectionId,
            session_id: sessionId,
            agent_name: agentName,
            message: rawStopText,
            complete_turn: true,
            ...(isLocalMirroredTurn
              ? {
                  command_turn_unbound: true,
                  local_turn: true,
                }
              : {}),
            ...(trail.markdown ? { work_trail: trail.markdown } : {}),
            ...(trail.events.length > 0 ? { trail_events: trail.events } : {}),
            ...(telemetry ? { agent_stats: telemetry } : {}),
            ...(telemetry?.model?.id
              ? {
                  model: {
                    providerID: telemetry.model.provider || 'google',
                    modelID: telemetry.model.id,
                  },
                }
              : {}),
          }
          try {
            await call({
              mcpUrl,
              token,
              name: 'post_session_message',
              arguments: fallbackArgs,
            })
          } catch {
            /* non-fatal fallback */
          }
        }
      }

      // Report what the git stand-in saw this turn, and retry what is waiting
      // (commit-reports.mjs). Only for the real state folder, whose home it lives in.
      const stateHome = path.dirname(path.dirname(path.dirname(path.resolve(connectionsDir))))
      if (connectionId && path.join(stateHome, '.devspec', 'remote-control', 'connections') === path.resolve(connectionsDir)) {
        try {
          const { reportObservedCommits } = await import('./commit-reports.mjs')
          await reportObservedCommits({ connectionId, home: stateHome, call, budgetMs: 6_000 })
        } catch {
          /* reporting never fails the hook */
        }
      }

      if (connectionId) {
        // A turn ended by the model provider's usage refusal keeps check jobs away from
        // this agent until it lifts; the next turn that succeeds clears it
        // (usage-refusal.mjs, `semantics.check_job.usage_refusal`).
        const endedOn = parseTurnFailure(parsedHookInput)
        recordTurnOutcome(
          connectionId,
          { refusedUntil: endedOn ? usageRefusedUntil(endedOn.text) : null, succeeded: !endedOn },
          { dir: connectionsDir },
        )
        const heartbeatArgs = {
          connection_id: connectionId,
          agent_name: agentName,
          status: 'live',
          busy: false,
          ...usageRefusalArgument(connectionId, { dir: connectionsDir }),
        }
        await call({
          mcpUrl,
          token,
          name: 'heartbeat_connection',
          arguments: heartbeatArgs,
        })
        noteUsageRefusalSent(connectionId, heartbeatArgs, { dir: connectionsDir })
        // Name the turn that ended (turn-completion.mjs, item 6ccb8be1), from the
        // marker read before it was cleared above. By now the next command may already
        // be delivered, and a completion that names nothing closes whatever is newest on
        // the connection: that command, before the agent starts on it.
        for (const identity of turnCompletionIdentities({
          marker,
          localTurn: state.local_turn,
          sessionId,
        })) {
          try {
            await call({
              mcpUrl,
              token,
              name: 'report_complete',
              arguments: { connection_id: connectionId, ...identity, reason: 'turn_end' },
            })
          } catch {
            /* non-fatal — the poller's marker-driven backstop still runs */
          }
        }
        if (state.local_turn) {
          patchOwnState(connectionId, { local_turn: null }, connectionsDir)
          state.local_turn = null
        }
        if (state.connection_capability) {
          try {
            const hostBackgroundTasks = Array.isArray(parsedHookInput?.background_tasks)
              ? parsedHookInput.background_tasks
              : null
            const requests = readRequestState(connectionId, { dir: connectionsDir })
            if (requests.open.size > 0) {
              const pending = requestsWithWorkPending(requests, {
                backgroundTasks: hostBackgroundTasks,
              })
              const finished = [...requests.open.keys()].filter(
                (id) => requests.started.has(id) && !pending.has(id),
              )
              await Promise.all(
                finished.map((requestId) =>
                  closeRequest({
                    connectionId,
                    requestId,
                    call: callRequest,
                    dir: connectionsDir,
                  }),
                ),
              )
            }
            for (const key of absentLaunches(requests, hostBackgroundTasks)) {
              appendRequestEvent(connectionId, { op: 'absent', key }, { dir: connectionsDir })
            }
            rotateRequestLog(connectionId, { dir: connectionsDir })
          } catch {
            /* non-fatal */
          }
        }
      }
      return { ok: true, busy: false }
    }

    if (connectionId) {
      await call({
        mcpUrl,
        token,
        name: 'heartbeat_connection',
        arguments: {
          connection_id: connectionId,
          agent_name: agentName,
          status: 'live',
          busy: true,
        },
      })
    }
    return { ok: true, busy: true }
  } catch (e) {
    process.stderr.write(`[devspec-remote] ${e instanceof Error ? e.message : String(e)}\n`)
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export function toProtoStopResult() {
  return {}
}

async function main() {
  const raw = readStdin()
  await handleMirrorTurn(mode, raw)
  process.stdout.write(JSON.stringify(toProtoStopResult()) + '\n')
  process.exit(0)
}

const isMain = isEntryPoint(import.meta.url)
if (isMain) main()
