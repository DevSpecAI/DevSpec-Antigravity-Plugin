/**
 * Closing the Antigravity CLI (`agy`) process when a person ends the agent from
 * DevSpec (item b725aa2d, parity with Claude Code item 973124bd and Pi item 7813bcd9).
 *
 * The poller (`devspec-remote-poll.mjs`) writes `enabled: false, ended_from_ui: true,
 * end_reason: 'ui'` onto the connection state file when the server reports an
 * Agents-page / session End (`status: 'ended', end_reason: 'ui'`) or an SSE `ended`
 * frame with `end_reason: 'ui'`. The listener (`devspec-remote-listen.mjs` or
 * `devspec-remote-wait.mjs`) watches the connection state file for the `agy` process
 * it serves (`owner_pid`). When a connection that this listener served while live
 * transitions to `end_reason === 'ui'`, this module sends `SIGTERM` to the owning
 * `agy` process so Bubble Tea restores the terminal and shuts down cleanly while
 * keeping the conversation resumable (`agy --resume`).
 *
 * Every guard exists to prevent closing the wrong process or closing for the wrong reason:
 *   - Only `state.end_reason === 'ui'` closes `agy` (never `local_stop`, `idle_timeout`,
 *     `server_ended`, `owner_gone`, or a session detach).
 *   - Only when `sawLive === true` (the listener observed this connection live before
 *     it ended, so a stale state file from an earlier run never closes a resumed session).
 *   - Only when `ownedByAntigravityProcess(state, ownerPid)` proves that `state.owner_pid`
 *     and `ownerPid` resolve to the same live `agy` / `antigravity` process (and matching
 *     `/proc/<pid>/stat` start time when recorded, defeating PID recycling).
 *   - POSIX only (`platform !== 'win32'`), where `SIGTERM` is a graceful shutdown signal.
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return Boolean(e && e.code === 'EPERM')
  }
}

export function commandOf(pid, { procRoot = '/proc', platform = process.platform } = {}) {
  try {
    if (platform === 'linux') {
      return fs.readFileSync(`${procRoot}/${pid}/comm`, 'utf8').trim()
    }
    if (platform === 'win32') return null
    return execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 2000,
    }).trim()
  } catch {
    return null
  }
}

export function commandLineOf(pid, { procRoot = '/proc', platform = process.platform } = {}) {
  try {
    if (platform === 'linux') {
      return fs
        .readFileSync(`${procRoot}/${pid}/cmdline`, 'utf8')
        .replace(/\0/g, ' ')
        .trim()
    }
    if (platform === 'win32') return ''
    return execFileSync('ps', ['-o', 'args=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 2000,
    }).trim()
  } catch {
    return ''
  }
}

export function parentOf(pid, { procRoot = '/proc', platform = process.platform } = {}) {
  try {
    if (platform === 'linux') {
      const stat = fs.readFileSync(`${procRoot}/${pid}/stat`, 'utf8')
      const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      return Number.parseInt(after[1], 10) || null
    }
    if (platform === 'win32') return null
    return (
      Number.parseInt(
        execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], {
          encoding: 'utf8',
          timeout: 2000,
        }).trim(),
        10,
      ) || null
    )
  } catch {
    return null
  }
}

/**
 * Kernel start time (clock ticks since boot, field 22 of `/proc/<pid>/stat` on Linux).
 * Used to detect PID reuse when `owner_started` was recorded on the connection state.
 */
export function processStartTime(pid, { procRoot = '/proc', platform = process.platform } = {}) {
  if (platform !== 'linux' || !Number.isInteger(pid) || pid <= 1) return null
  try {
    const stat = fs.readFileSync(`${procRoot}/${pid}/stat`, 'utf8')
    const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return after[19] || null
  } catch {
    return null
  }
}

export function looksLikeAntigravity(name, cmdline = '') {
  if (typeof name === 'string' && /(^|\/)(agy|antigravity)(\.exe)?$/i.test(name.trim())) {
    return true
  }
  if (
    typeof cmdline === 'string' &&
    /(^|[\s/])(agy|antigravity)(\.exe)?(\s|$)/i.test(cmdline.trim())
  ) {
    return true
  }
  return false
}

/**
 * The Antigravity (`agy`) process a pid belongs to: the pid itself when it is `agy`,
 * else its nearest `agy` ancestor. Null when the ancestry holds no `agy` process or
 * the pid is not alive.
 */
export function antigravityProcessOf(
  pid,
  {
    maxHops = 12,
    isAlive = pidAlive,
    nameOf = commandOf,
    cmdlineOf = commandLineOf,
    parentOfPid = parentOf,
  } = {},
) {
  const start = Number(pid)
  if (!Number.isInteger(start) || start <= 1 || !isAlive(start)) return null
  let cursor = start
  for (let hop = 0; hop <= maxHops && cursor && cursor > 1; hop++) {
    const name = nameOf(cursor)
    const cmdline = cmdlineOf(cursor)
    if (name === null && !cmdline) return hop === 0 ? start : null
    if (looksLikeAntigravity(name, cmdline)) return cursor
    const parent = parentOfPid(cursor)
    if (!parent || parent === cursor) return null
    cursor = parent
  }
  return null
}

/**
 * Resolve the live Antigravity (`agy`) PID from an explicit `--owner-pid` anchor
 * (used by detached listeners/pollers) or by walking `startPid`'s ancestry.
 */
export function resolveAntigravityPid(
  explicitOwnerPid = null,
  { startPid = process.pid, agyOf = antigravityProcessOf } = {},
) {
  const claimed = Number.parseInt(String(explicitOwnerPid ?? ''), 10)
  if (Number.isInteger(claimed) && claimed > 1) {
    const resolved = agyOf(claimed)
    if (resolved !== null) return resolved
  }
  return agyOf(startPid)
}

/**
 * Does a DIFFERENT live Antigravity process own this connection now?
 */
export function ownedByAnotherAntigravityProcess(
  state,
  myPid,
  { isAlive = pidAlive, agyOf = antigravityProcessOf } = {},
) {
  const owner = Number(state?.owner_pid)
  if (!Number.isInteger(owner) || owner <= 1 || !isAlive(owner)) return false
  const ownerAgy = agyOf(owner)
  if (ownerAgy === null) return false
  const mine = agyOf(Number(myPid))
  if (mine === null) return false
  return ownerAgy !== mine
}

/**
 * Does this Antigravity process own this connection?
 */
export function ownedByAntigravityProcess(
  state,
  myPid,
  {
    isAlive = pidAlive,
    agyOf = antigravityProcessOf,
    startTimeOf = processStartTime,
  } = {},
) {
  const owner = Number(state?.owner_pid)
  if (!Number.isInteger(owner) || owner <= 1 || !isAlive(owner)) return false
  const ownerAgy = agyOf(owner)
  const mine = agyOf(Number(myPid))
  if (ownerAgy === null || mine === null || ownerAgy !== mine) return false
  const recordedStart = state?.owner_started ?? null
  if (recordedStart !== null && recordedStart !== undefined) {
    const currentStart = startTimeOf(ownerAgy)
    if (currentStart !== null && String(recordedStart) !== String(currentStart)) {
      return false
    }
  }
  return true
}

export function closeOnEndDecision({
  state,
  sawLive = false,
  ownerPid,
  platform = process.platform,
  owns = ownedByAntigravityProcess,
} = {}) {
  if (platform === 'win32') return { close: false, pid: null, reason: 'unsupported_platform' }
  if (!sawLive) return { close: false, pid: null, reason: 'ended_before_this_process_served_it' }
  if (!state || state.end_reason !== 'ui') return { close: false, pid: null, reason: 'not_a_person_end' }
  const target = Number(ownerPid)
  if (!Number.isInteger(target) || target <= 1) {
    return { close: false, pid: null, reason: 'no_antigravity_process' }
  }
  if (!owns(state, target)) return { close: false, pid: null, reason: 'not_the_owner' }
  return { close: true, pid: target, reason: 'person_ended_from_devspec' }
}

export function closeAntigravityOnEnd({
  state,
  sawLive = false,
  ownerPid = null,
  platform = process.platform,
  resolvePid = resolveAntigravityPid,
  owns = ownedByAntigravityProcess,
  kill = (pid, signal) => process.kill(pid, signal),
} = {}) {
  const resolvedPid = resolvePid(ownerPid)
  const decision = closeOnEndDecision({
    state,
    sawLive,
    ownerPid: resolvedPid,
    platform,
    owns,
  })
  if (!decision.close) {
    return { closed: false, pid: decision.pid, reason: decision.reason }
  }
  try {
    kill(decision.pid, 'SIGTERM')
    return { closed: true, pid: decision.pid, reason: decision.reason }
  } catch (e) {
    return { closed: false, pid: decision.pid, reason: e?.code || e?.message || 'kill_failed' }
  }
}
