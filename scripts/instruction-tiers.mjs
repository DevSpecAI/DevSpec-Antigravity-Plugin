/**
 * The instruction tiers a connection is handed at register/attach/poll time,
 * and where they wait on disk (`<connectionId>.tiers.json` and content-addressed
 * `<connectionId>.tiers-<sha256>.txt`).
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readPrivateJsonResult, STATE_OK, writePrivateJson, writePrivateText } from './private-state.mjs'

export function resolveHome() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir() || ''
}

function defaultConnectionsDir(home = resolveHome()) {
  return path.join(home, '.devspec', 'remote-control', 'connections')
}

export const CHANNEL_LIMITS = Object.freeze({ hookContext: 10_000, bashResult: 30_000 })
export const CHANNEL_RESERVE = 1_500

/** The tier fields the server may hand back, in the order they should be read. */
export const TIER_FIELDS = [
  ['owner_custom_instructions', 'Your response style'],
  ['owner_agent_rules', 'Your personal agent rules (machine/tooling)'],
  ['project_custom_instructions', 'Project principles (team-wide)'],
  ['project_agent_rules', 'Project agent rules (execution mechanics)'],
]

export function renderTiers(payload) {
  if (payload?.instructions_unchanged) {
    return '\nInstructions: unchanged since this conversation last connected — the tiers you already hold still apply.\n'
  }
  const parts = []
  for (const [field, label] of TIER_FIELDS) {
    const value = payload?.[field]
    if (typeof value === 'string' && value.trim()) {
      parts.push(`\n### ${label}\n\n${value}\n`)
    } else if (Object.hasOwn(payload ?? {}, field)) {
      parts.push(`\n### ${label}\n\nNo instruction configured (clears the previous value).\n`)
    }
  }
  if (!parts.length) return ''
  return `\n## Instructions in force for this run\n${parts.join('')}`
}

export function tiersPath(connectionId, dir = defaultConnectionsDir()) {
  return path.join(dir, `${connectionId}.tiers.json`)
}

export function tiersPathFor(connectionId, home = resolveHome()) {
  const safeId = String(connectionId || 'default').replace(/[^a-zA-Z0-9._-]/g, '_')
  return path.join(home, '.devspec', `instruction-tiers-${safeId}.json`)
}

export function hasStoredTiers(connectionId, { dir = defaultConnectionsDir() } = {}) {
  return readPrivateJsonResult(tiersPath(connectionId, dir)).status === STATE_OK
}

/**
 * Write rendered tiers to a private file named by their content, and return its path.
 */
export function saveTiersText(connectionId, text, { dir = defaultConnectionsDir() } = {}) {
  const file = path.join(dir, `${connectionId}.tiers-${createHash('sha256').update(text).digest('hex')}.txt`)
  writePrivateText(file, text)
  return file
}

export function renderTiersPointer(file, { alreadyLoadedInSessionStart = false } = {}) {
  if (alreadyLoadedInSessionStart) {
    return (
      '\n## Instructions in force for this run\n\n' +
      `The owner's and this project's rules for this run are saved in full at:\n\n${file}\n\n` +
      'These rules are already loaded in your SessionStart system context for this conversation — do NOT call view_file on this file now. ' +
      'Only read it if you resume after context compaction or if a later wake names a different instruction_context_file.\n'
    )
  }
  return (
    '\n## Instructions in force for this run\n\n' +
    `The owner's and this project's rules for this run are saved in full at:\n\n${file}\n\n` +
    'If these rules are not already loaded in your SessionStart system context (or if the file name changed or you are resuming after compaction), read that whole file before acting on any work request, and follow it for the rest of this conversation.\n'
  )
}

/** Attach replies may clear a rule; missing fields do not erase a prior registration. */
export function mergeInstructionTiers(previous, incoming) {
  if (incoming?.instructions_unchanged) return previous
  const merged = { ...previous }
  for (const [field] of TIER_FIELDS) {
    if (typeof incoming?.[field] === 'string' || incoming?.[field] === null) {
      merged[field] = incoming[field]
    }
  }
  for (const field of ['instruction_tiers_version', 'instruction_tiers_hash']) {
    if (incoming?.[field] != null) merged[field] = incoming[field]
  }
  if (TIER_FIELDS.some(([field]) => Object.hasOwn(incoming ?? {}, field))) {
    delete merged.instructions_unchanged
  }
  return merged
}

function tierSnapshot(connectionId, registration, dir, now) {
  const prior = readPrivateJsonResult(tiersPath(connectionId, dir))
  const texts = { ...(prior.status === STATE_OK ? prior.value?.texts : {}) }
  for (const [field] of TIER_FIELDS) {
    const value = registration[field]
    if (typeof value === 'string' || value === null) texts[field] = value
  }
  return {
    connection_id: connectionId,
    version: registration.instruction_tiers_version ?? null,
    hash: registration.instruction_tiers_hash ?? null,
    texts,
    stored_at: now.toISOString(),
  }
}

/** Save changed server rules as an immutable, complete file for a queued command. */
export function captureInstructionContext(connectionId, payload, { dir = defaultConnectionsDir() } = {}) {
  if (payload?.instructions_unchanged || !TIER_FIELDS.some(([key]) => Object.hasOwn(payload ?? {}, key))) {
    return null
  }
  const snapshot = tierSnapshot(connectionId, payload, dir, new Date())
  const text = renderTiers(
    Object.fromEntries(Object.entries(snapshot.texts).filter(([key]) => key !== 'owner_custom_instructions')),
  )
  const file = saveTiersText(connectionId, text, { dir })
  writePrivateJson(tiersPath(connectionId, dir), snapshot)
  return file
}

export function normalizeInstructionsPayload(instructions) {
  if (!instructions) return null
  if (typeof instructions === 'string') {
    const trimmed = instructions.trim()
    if (!trimmed) return null
    return { tier_0: trimmed, tier_1: '', tier_2: '' }
  }
  if (typeof instructions === 'object') {
    if (TIER_FIELDS.some(([field]) => typeof instructions[field] === 'string' && instructions[field].trim())) {
      const rendered = renderTiers(instructions).trim()
      return {
        tier_0: rendered,
        tier_1: '',
        tier_2: '',
        texts: Object.fromEntries(
          TIER_FIELDS.filter(([field]) => typeof instructions[field] === 'string' || instructions[field] === null).map(
            ([field]) => [field, instructions[field]],
          ),
        ),
      }
    }
    const tier_0 = typeof instructions.tier_0 === 'string' ? instructions.tier_0.trim() : ''
    const tier_1 = typeof instructions.tier_1 === 'string' ? instructions.tier_1.trim() : ''
    const tier_2 = typeof instructions.tier_2 === 'string' ? instructions.tier_2.trim() : ''
    if (!tier_0 && !tier_1 && !tier_2) return null
    return { tier_0, tier_1, tier_2 }
  }
  return null
}

export function storeTiers(
  connectionId,
  registrationOrInstructions,
  { home = resolveHome(), dir = undefined, now = new Date() } = {},
) {
  if (!connectionId || !registrationOrInstructions) return false
  const effectiveDir = dir || defaultConnectionsDir(home)
  let storedAny = false

  if (
    typeof registrationOrInstructions === 'object' &&
    !registrationOrInstructions.instructions_unchanged &&
    TIER_FIELDS.some(([field]) => Object.hasOwn(registrationOrInstructions, field))
  ) {
    writePrivateJson(tiersPath(connectionId, effectiveDir), tierSnapshot(connectionId, registrationOrInstructions, effectiveDir, now))
    storedAny = true
  }

  const normalized = normalizeInstructionsPayload(
    registrationOrInstructions?.instructions || registrationOrInstructions,
  )
  if (normalized && home) {
    const p = tiersPathFor(connectionId, home)
    try {
      mkdirSync(path.join(home, '.devspec'), { recursive: true, mode: 0o700 })
      writeFileSync(
        p,
        JSON.stringify(
          {
            connection_id: connectionId,
            stored_at: now.toISOString(),
            tiers: normalized,
          },
          null,
          2,
        ) + '\n',
        { mode: 0o600 },
      )
      storedAny = true
    } catch {
      /* ignore */
    }
  }
  return storedAny
}

export function readTiersFor(connectionId, { home = resolveHome(), dir = undefined } = {}) {
  if (!connectionId) return null
  const effectiveDir = dir || defaultConnectionsDir(home)
  const snap = readPrivateJsonResult(tiersPath(connectionId, effectiveDir))
  if (snap.status === STATE_OK && snap.value?.texts) {
    const rendered = renderTiers(snap.value.texts)
    const text = rendered.trim()
    if (text) {
      const file = saveTiersText(connectionId, rendered, { dir: effectiveDir })
      return {
        tier_0: renderTiersPointer(file).trim(),
        tier_1: '',
        tier_2: '',
        file,
        rendered: text,
        texts: snap.value.texts,
      }
    }
  }
  if (!home) return null
  const p = tiersPathFor(connectionId, home)
  if (!existsSync(p)) return null
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8'))
    if (!raw || typeof raw !== 'object' || !raw.tiers) return null
    return raw.tiers
  } catch {
    return null
  }
}

/**
 * Supports both:
 * - `takeTiersFor(connectionId, localId, { dir, force, writeReceipt })` -> `{ status: 'pointer'|'unchanged'|'absent', text?, pointer?, file? }`
 * - `takeTiersFor(connectionId, { home, consume })` -> legacy `{ tier_0, tier_1, tier_2 } | null`
 */
export function takeTiersFor(connectionId, localIdOrOpts = {}, maybeOpts = {}) {
  if (typeof localIdOrOpts === 'string' || localIdOrOpts === null) {
    const localId = localIdOrOpts
    const {
      dir = defaultConnectionsDir(),
      force = false,
      writeReceipt = writePrivateJson,
    } = maybeOpts || {}
    const file = tiersPath(connectionId, dir)
    const read = readPrivateJsonResult(file)
    if (read.status !== STATE_OK || !read.value) return { status: 'absent' }
    const stored = read.value
    const text = renderTiers(stored.texts || {})
    if (!text) return { status: 'absent' }
    const deliveredKey = `${stored.hash || 'nohash'}@${createHash('sha256').update(text).digest('hex')}`
    const reader = createHash('sha256').update(localId || 'unknown').digest('hex')
    const receiptFile = path.join(dir, `${connectionId}.tiers-delivery-${reader}.json`)
    const receipt = readPrivateJsonResult(receiptFile)
    const pointedBefore =
      receipt.status === STATE_OK &&
      receipt.value?.delivered_key === deliveredKey &&
      receipt.value.mode === 'pointer'
    const saved = saveTiersText(connectionId, text, { dir })
    const pointer = renderTiersPointer(saved)
    if (!force && pointedBefore) return { status: 'unchanged', pointer }
    writeReceipt(receiptFile, { delivered_key: deliveredKey, mode: 'pointer' })
    return { status: 'pointer', text: pointer, file: saved }
  }

  const { home = resolveHome(), dir = undefined, consume = true } = localIdOrOpts || {}
  const tiers = readTiersFor(connectionId, { home, dir })
  if (!tiers) return null
  if (consume && home) {
    try {
      rmSync(tiersPathFor(connectionId, home), { force: true })
    } catch {
      /* ignore */
    }
  }
  return tiers
}

export function formatTiersForStartup(tiers) {
  if (!tiers || typeof tiers !== 'object') return ''
  if (typeof tiers.file === 'string' && tiers.file.trim()) {
    return renderTiersPointer(tiers.file.trim()).trim()
  }
  if (typeof tiers.rendered === 'string' && tiers.rendered.trim()) {
    return tiers.rendered.trim()
  }
  return [tiers.tier_0, tiers.tier_1].filter(Boolean).join('\n\n').trim()
}
