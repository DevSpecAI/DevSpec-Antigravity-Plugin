#!/usr/bin/env node
/**
 * The one owner of how this plugin keeps private files: remote-control state that
 * holds the person's DevSpec key, per-connection capabilities and Antigravity's
 * local CSRF token, plus the logs and inboxes beside them.
 *
 * The rule (item b17cb7d7): every such file is owner-only (0600) after every write,
 * including one that already existed at a looser mode, and its directory is 0700.
 *
 * - A file is written aside at 0600 and renamed over the destination, so it never
 *   exists at a looser mode and a looser existing file is replaced, not kept.
 *   (`writeFileSync(file, …, { mode })` alone sets the mode only when it creates the
 *   file.)
 * - A directory is created 0700 and then chmodded 0700, because `mkdir`'s mode applies
 *   only to directories it creates. Under `~/.devspec` the chain up to and including
 *   `~/.devspec` is tightened too, so the state root cannot be listed by other
 *   accounts.
 * - A log or inbox opened for appending is opened 0600 and then fchmodded, for the
 *   same reason.
 * - Files written by earlier versions are repaired by `tightenPrivateTree`, which
 *   SessionStart runs over `~/.devspec`, and existing state is chmodded before every
 *   read.
 *
 * Windows: POSIX modes do not apply there, so none of the chmods do anything useful
 * and the tree sweep is skipped. The files live under `%USERPROFILE%` and inherit the
 * profile folder's default ACL: that user, SYSTEM and Administrators. Other standard
 * accounts on the machine cannot open them.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** POSIX permission bits mean something on this platform. */
export const POSIX_MODES = process.platform !== 'win32'

export const PRIVATE_FILE_MODE = 0o600
export const PRIVATE_DIR_MODE = 0o700

/** The state root every DevSpec plugin on this machine shares. */
export function privateStateRoot(home = os.homedir()) {
  return path.join(home, '.devspec')
}

/** A file that is not there. Safe to treat as empty state. */
export const STATE_ABSENT = 'absent'
/** Parsed cleanly. `value` is the state. */
export const STATE_OK = 'ok'
/**
 * The file EXISTS but could not be read or parsed — a torn read against a writer,
 * a truncated file, corruption. Never safe to treat as empty: whatever is in there
 * belongs to someone, and writing over it is how the bond gets lost.
 */
export const STATE_UNREADABLE = 'unreadable'

function within(child, parent) {
  const rel = path.relative(parent, child)
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * Create `dir` (and any missing parents) owner-only, and tighten it if it already
 * existed. When `dir` is inside `root` (default `~/.devspec`), every directory from
 * `dir` up to and including `root` is tightened as well. Throws only when the
 * directory cannot be created; a chmod that fails is left to the file's own 0600.
 */
export function ensurePrivateDir(dir, { root = privateStateRoot() } = {}) {
  const target = path.resolve(dir)
  fs.mkdirSync(target, { recursive: true, mode: PRIVATE_DIR_MODE })
  if (!POSIX_MODES) return target
  const chain = [target]
  const resolvedRoot = root ? path.resolve(root) : null
  if (resolvedRoot && within(target, resolvedRoot)) {
    for (let d = target; d !== resolvedRoot; ) {
      const parent = path.dirname(d)
      if (parent === d) break
      chain.push(parent)
      d = parent
    }
  }
  // Never the home folder itself or a filesystem root: those are not ours to close.
  const home = path.resolve(os.homedir())
  for (const d of chain) {
    if (d === home || path.dirname(d) === d) continue
    tightenMode(d, PRIVATE_DIR_MODE)
  }
  return target
}

/**
 * Set an existing file or directory to `mode` when it grants anything to group or
 * others; one that is already owner-only is left exactly as it is. Never follows a
 * symlink. Returns whether it changed.
 */
export function tightenMode(target, mode) {
  if (!POSIX_MODES) return false
  try {
    const st = fs.lstatSync(target)
    if (st.isSymbolicLink()) return false
    if ((st.mode & 0o077) === 0) return false
    fs.chmodSync(target, mode)
    return true
  } catch {
    return false
  }
}

/** Tighten one existing file to 0600 (and its directory to 0700). */
export function tightenPrivateFile(filePath, { root = privateStateRoot() } = {}) {
  if (!POSIX_MODES || !filePath) return false
  try {
    if (!fs.existsSync(filePath)) return false
  } catch {
    return false
  }
  try {
    ensurePrivateDir(path.dirname(filePath), { root })
  } catch {
    /* the file's own mode is what protects it */
  }
  return tightenMode(filePath, PRIVATE_FILE_MODE)
}

/**
 * Open `filePath` for appending, owner-only whether or not it existed, and return
 * the descriptor. Used for the listener and poller logs a detached child writes.
 */
export function openPrivateAppend(filePath, flags = 'a', { root = privateStateRoot() } = {}) {
  ensurePrivateDir(path.dirname(filePath), { root })
  const fd = fs.openSync(filePath, flags, PRIVATE_FILE_MODE)
  if (POSIX_MODES) {
    try {
      fs.fchmodSync(fd, PRIVATE_FILE_MODE)
    } catch {
      /* best-effort: the directory is already 0700 */
    }
  }
  return fd
}

/** The deepest the sweep goes below `~/.devspec`; the tree is three levels deep. */
const SWEEP_MAX_DEPTH = 6

/**
 * Repair what earlier versions left: every directory under `root` to 0700 and every
 * regular file to 0600 when it grants group or others anything. Symlinks are never
 * followed and the walk is bounded, so it cannot leave `root`. Skipped on Windows.
 * Returns `{ dirs, files }` — how many of each it tightened.
 */
export function tightenPrivateTree(root = privateStateRoot()) {
  const changed = { dirs: 0, files: 0 }
  if (!POSIX_MODES || !root) return changed
  const resolvedRoot = path.resolve(root)
  // A sweep of the home folder or a filesystem root would walk far outside our state.
  if (resolvedRoot === path.resolve(os.homedir()) || path.dirname(resolvedRoot) === resolvedRoot) return changed
  const walk = (dir, depth) => {
    if (tightenMode(dir, PRIVATE_DIR_MODE)) changed.dirs++
    if (depth >= SWEEP_MAX_DEPTH) return
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) walk(full, depth + 1)
      else if (entry.isFile() && tightenMode(full, PRIVATE_FILE_MODE)) changed.files++
    }
  }
  try {
    if (!fs.lstatSync(resolvedRoot).isDirectory()) return changed
  } catch {
    return changed
  }
  walk(resolvedRoot, 0)
  return changed
}

/**
 * Read remote-control state, saying WHICH kind of nothing it found.
 * Returns `{ status, value }`; `value` is null unless status is `ok`.
 */
export function readPrivateJsonResult(filePath) {
  if (!filePath) return { status: STATE_ABSENT, value: null }
  try {
    if (!fs.existsSync(filePath)) return { status: STATE_ABSENT, value: null }
  } catch {
    return { status: STATE_UNREADABLE, value: null }
  }
  // Mode repair is best-effort; a readable file is still worth reading.
  tightenMode(filePath, PRIVATE_FILE_MODE)
  try {
    return { status: STATE_OK, value: JSON.parse(fs.readFileSync(filePath, 'utf8')) }
  } catch {
    return { status: STATE_UNREADABLE, value: null }
  }
}

/**
 * Lenient read — the state, or null for both "absent" and "unreadable".
 */
export function readPrivateJson(filePath) {
  const result = readPrivateJsonResult(filePath)
  return result.status === STATE_OK ? result.value : null
}

const RENAME_ATTEMPTS = 5
const RENAME_BACKOFF_MS = 20

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

export function writePrivateJson(filePath, value, options = {}) {
  writePrivateText(filePath, JSON.stringify(value, null, 2) + '\n', options)
}

/**
 * Atomically replace a private (0600) file with `text`: written beside the
 * destination, then renamed over it, in a 0700 directory.
 */
export function writePrivateText(filePath, text, { root = privateStateRoot() } = {}) {
  ensurePrivateDir(path.dirname(filePath), { root })
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now().toString(36)}`
  try {
    fs.writeFileSync(tmp, text, { mode: PRIVATE_FILE_MODE })
    fs.chmodSync(tmp, PRIVATE_FILE_MODE)
    let lastError = null
    for (let attempt = 0; attempt < RENAME_ATTEMPTS; attempt++) {
      try {
        fs.renameSync(tmp, filePath)
        return
      } catch (e) {
        lastError = e
        if (attempt < RENAME_ATTEMPTS - 1) sleepSync(RENAME_BACKOFF_MS)
      }
    }
    throw lastError
  } finally {
    try {
      if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true })
    } catch {
      /* the rename already consumed it, or the directory went away */
    }
  }
}

/**
 * Merge `patch` into an existing state file and write it back atomically.
 * Returns `true` when the file was written, `false` when it was left alone because
 * it exists and could not be read.
 */
export function patchPrivateJson(filePath, patch) {
  const current = readPrivateJsonResult(filePath)
  if (current.status === STATE_UNREADABLE) return false
  writePrivateJson(filePath, { ...(current.value ?? {}), ...patch })
  return true
}
