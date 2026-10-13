#!/usr/bin/env node
/**
 * Atomic reader/writer for remote-control JSON state that can contain bearer or
 * per-connection capability secrets. Existing files are repaired to owner-only mode
 * before any byte is read; mode is reasserted after every write because opening an
 * existing file with `{ mode: 0o600 }` does not change its prior permissions.
 */

import fs from 'node:fs'
import path from 'node:path'

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
  try {
    fs.chmodSync(filePath, 0o600)
  } catch {
    /* mode repair is best-effort; a readable file is still worth reading */
  }
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

export function writePrivateJson(filePath, value) {
  writePrivateText(filePath, JSON.stringify(value, null, 2) + '\n')
}

/**
 * Atomically replace a private (0600) file with `text`: written beside the
 * destination, then renamed over it.
 */
export function writePrivateText(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now().toString(36)}`
  try {
    fs.writeFileSync(tmp, text, { mode: 0o600 })
    fs.chmodSync(tmp, 0o600)
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
