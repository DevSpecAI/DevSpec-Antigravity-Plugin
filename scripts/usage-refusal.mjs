/**
 * Tell DevSpec when the agent's model provider refuses it for usage (item cf356677).
 *
 * When Antigravity's model provider refuses the agent for usage (a quota reached, a
 * rate limit, a 429), the turn ends on an error and the agent can run no turn until
 * the refusal lifts. A check job offered to it meanwhile would sit there unruled, so
 * the host reports the refusal as `usage_refused_until` on its status updates, as
 * `semantics.check_job.usage_refusal` in the remote-ingress contract says: the time
 * the refusal said it lifts, or a short bounded cool-off when it gave none, with each
 * status update while it stands, and null once a turn succeeds. DevSpec then offers
 * the agent no check job and hands any it holds to the next agent.
 *
 * What Antigravity gives the Stop hook is its rendered error text and nothing more
 * (turn-failure.mjs), so the refusal is read from that text. Only a refusal counts,
 * never a usage percentage: some accounts keep working past 100% of a reported limit.
 * Seen on Antigravity CLI (item 4d744b7b, 4 Nov 2026):
 * `RESOURCE_EXHAUSTED (code 429): Individual quota reached … Resets in 161h54m`.
 *
 * The Stop hook records the outcome in `<connectionId>.usage-refusal.json` and sends
 * it on its own end-of-turn heartbeat; the poller sends it on every status update
 * after that until it lapses, and the null that clears it until one is delivered.
 *
 * Imports only private-state.mjs and Node built-ins, so every hook can load it.
 */

import fs from 'node:fs'
import path from 'node:path'
import { privateStateRoot, readPrivateJson, writePrivateJson } from './private-state.mjs'

/**
 * How long a refusal that gave no time of its own is reported for. Short, because a
 * guess that is too long keeps a working agent from checks; the next turn that fails
 * the same way reports it again, and the next that succeeds clears it.
 */
export const USAGE_REFUSAL_COOL_OFF_MS = 15 * 60 * 1000

/** A refusal that says it lifts at once still ended this turn: report at least this. */
const USAGE_REFUSAL_MIN_MS = 60 * 1000

const REFUSAL =
  /RESOURCE_EXHAUSTED|\b(?:code|status|HTTP)\s*:?\s*429\b|\b429\s+Too Many Requests\b|\btoo many requests\b|\brate[- ]?limit(?:ed)?\b|\bquota\b[^.\n]{0,40}\b(?:reached|exceeded|exhausted)\b|\bexceeded your (?:current )?quota\b|\busage limit\b/i

const UNIT_MS = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000 }

/** `161h54m`, `5 hours 3 minutes`, `30s` → milliseconds, or null when nothing reads as a duration. */
function durationMs(text) {
  let total = 0
  let found = false
  for (const [, amount, unit] of text.matchAll(/(\d+(?:\.\d+)?)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?![a-z])/gi)) {
    total += Number(amount) * UNIT_MS[unit[0].toLowerCase()]
    found = true
  }
  return found ? total : null
}

/** When the refusal says it lifts, as epoch milliseconds, or null when it says nothing. */
function liftsAtMs(text, nowMs) {
  const relative =
    /\b(?:resets?|retry|try again|available again)\s+(?:in|after)\s+((?:\d+(?:\.\d+)?\s*[a-z]+[\s,]*(?:and\s+)?)+)/i.exec(text) ||
    /\bretry[_ ]?delay"?\s*[:=]\s*"?((?:\d+(?:\.\d+)?)\s*s)\b/i.exec(text)
  if (relative) {
    const ms = durationMs(relative[1])
    if (ms !== null) return nowMs + Math.max(ms, USAGE_REFUSAL_MIN_MS)
  }
  const absolute = /\b(?:resets?|retry|available again)\s+(?:at|on)\s+(\d{4}-\d{2}-\d{2}[T ][0-9:.]+(?:Z|[+-]\d{2}:?\d{2})?)/i.exec(text)
  if (absolute) {
    const at = Date.parse(absolute[1])
    if (Number.isFinite(at) && at > nowMs) return at
  }
  return null
}

/**
 * The time to report for a turn that ended on `failureText`, as an ISO string, or null
 * when the text is not a usage refusal.
 */
export function usageRefusedUntil(failureText, nowMs = Date.now()) {
  if (typeof failureText !== 'string' || !REFUSAL.test(failureText)) return null
  return new Date(liftsAtMs(failureText, nowMs) ?? nowMs + USAGE_REFUSAL_COOL_OFF_MS).toISOString()
}

export function usageRefusalPath(connectionId, dir) {
  return path.join(dir, `${connectionId}.usage-refusal.json`)
}

function read(connectionId, dir) {
  const value = readPrivateJson(usageRefusalPath(connectionId, dir))
  if (!value || value.v !== 1) return null
  if (value.until === null) return { until: null }
  return typeof value.until === 'string' && Number.isFinite(Date.parse(value.until)) ? { until: value.until } : null
}

function remove(connectionId, dir) {
  try {
    fs.rmSync(usageRefusalPath(connectionId, dir), { force: true })
  } catch {
    /* a leftover file lapses by its time */
  }
}

/**
 * Record how a turn ended: `refusedUntil` an ISO time after a usage refusal; null after
 * a turn that succeeded, which clears a refusal recorded earlier. A turn that failed
 * for another reason changes nothing.
 */
export function recordTurnOutcome(connectionId, { refusedUntil, succeeded }, { dir, root = privateStateRoot() } = {}) {
  if (!connectionId || !dir) return
  try {
    if (refusedUntil) writePrivateJson(usageRefusalPath(connectionId, dir), { v: 1, until: refusedUntil }, { root })
    else if (succeeded && read(connectionId, dir)?.until) writePrivateJson(usageRefusalPath(connectionId, dir), { v: 1, until: null }, { root })
  } catch {
    /* the report is best effort; a refusal still lapses by itself on DevSpec */
  }
}

/**
 * What a status update carries: `{ usage_refused_until: <time> }` while a refusal
 * stands, `{ usage_refused_until: null }` while a clear has not been delivered, and
 * nothing otherwise. A refusal whose time has passed is forgotten here, as DevSpec
 * forgets it on its own.
 */
export function usageRefusalArgument(connectionId, { dir, now = Date.now() } = {}) {
  if (!connectionId || !dir) return {}
  const stored = read(connectionId, dir)
  if (!stored) return {}
  if (stored.until === null) return { usage_refused_until: null }
  if (Date.parse(stored.until) <= now) {
    remove(connectionId, dir)
    return {}
  }
  return { usage_refused_until: stored.until }
}

/** After a status update DevSpec accepted: a delivered clear is done with. */
export function noteUsageRefusalSent(connectionId, args, { dir } = {}) {
  if (!connectionId || !dir || !args || args.usage_refused_until !== null) return
  if (read(connectionId, dir)?.until === null) remove(connectionId, dir)
}
