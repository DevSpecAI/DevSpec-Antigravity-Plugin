#!/usr/bin/env node
/**
 * Automatic turn recall for Antigravity (DevSpec item 08f036e5, decision 3ea02bd2).
 *
 * Once per substantive turn, PreInvocation asks DevSpec which of the project's
 * records bear on what was just asked (requirements, standing documents, memories,
 * plans and rejections, past shipped work, and any lane the server adds later) and
 * appends the server's own formatted cards to the end of the conversation as one
 * system step. Nothing here knows what a lane or a record kind is: the block is
 * passed on verbatim and the `kind:id:vN` keys are only remembered, so a new server
 * lane needs no plugin release.
 *
 * How it behaves is the host delivery contract measured in item 7c87f509
 * (apps/web/scripts/eval/recall-plugin-bench/host-delivery-contract.ts in DevSpecV2):
 *
 * - **One hook, at the turn's tail.** Only a turn-opening step recalls: the person's
 *   own `USER_INPUT`, or a `[DevSpec Remote Wake]` that delivers a command or an
 *   automation run. PreInvocation also fires before every model call inside a turn;
 *   those see a tool or planner step as the newest one and return at once, with no
 *   network call. The cards go in as a new `systemMessage` step, never into the
 *   system prompt or an earlier step, so the conversation's cached prefix stays warm.
 * - **Once per command.** The plugin never asks `poll_connection` to attach recall
 *   to a delivered command, so this hook is the only path that delivers it. A
 *   command seen at two steps is recalled once, by its message id.
 * - **Each card once per conversation.** `~/.devspec/recall/antigravity/<id>.json`
 *   (0600 in a 0700 folder) keeps the keys already shown; an edited record has a new
 *   version, so its key is new and it comes back. A CHECKPOINT step (Antigravity
 *   summarising earlier steps away) forgets what was shown before it, so a card that
 *   left the context can return.
 * - **Never in the way.** Signed out, no project in sight, a slow or failing server:
 *   the hook injects nothing and the turn goes ahead. The HTTP call is abandoned at
 *   2.8 s and the whole recall at 3 s. The hook never renews the sign-in itself, or
 *   waits for a renewal: a renewal cut off by the hook's deadline could lose the
 *   rotated refresh key. A login past half its life gets the plugin's usual detached
 *   `devspec-login.mjs --renew`, which finishes on its own under the store's lock,
 *   and this turn uses the token in hand (an expired one is refused, and fails open).
 * - **Only where a project is evident.** The connection's project, the conversation's
 *   chosen project, a folder pin or the repository's remote. With none of those the
 *   hook makes no call, and a scope the server could not place is not asked about
 *   again in the same conversation.
 *
 * The DevSpec key stays in memory: it is never put on a command line, in the
 * environment, in the output or in the state file (item b17cb7d7).
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pluginHeaders } from './connection-version.mjs'
import { readConversationProject } from './conversation-project.mjs'
import { findProjectPin, gitRemoteOrigin } from './devspec-scope.mjs'
import { loadState, normalizeTranscriptPath, resolveHookConversationId, extractUserRequestText } from './mirror-turn.mjs'
import { writePrivateText } from './private-state.mjs'
import { inferAntigravityTranscriptPath } from './remote-control-state.mjs'
import { connectionCredential, resolveDevspecMcpAuth } from './resolve-mcp-auth.mjs'

/** The host delivery contract's numbers (7c87f509 `RECALL_TIMEOUT_BUDGETS`). */
export const TURN_RECALL_LIMITS = Object.freeze({
  /** Shorter than this is an acknowledgement, not a topic (the server skips it too). */
  minQueryChars: 18,
  /** The HTTP call is abandoned here; the server answers by 2.4 s. */
  clientHttpTimeoutMs: 2_800,
  /** The whole recall, gating and state included, never holds the turn longer. */
  hardExitMs: 3_000,
  /** Seen keys kept per conversation: all of them go with every request (server cap 512). */
  seenStoreMaxEntries: 512,
  /** One conversation's state file never grows past this. */
  seenStoreMaxBytes: 32_768,
  /** A conversation untouched this long has its state removed. */
  seenStoreTtlMs: 30 * 24 * 60 * 60 * 1_000,
  /** Recent command ids and scope misses remembered per conversation. */
  recentIdsKept: 32,
  /** The newest step is found in the last this-many bytes of the compact transcript. */
  transcriptTailBytes: 65_536,
})

const REMOTE_WAKE = '[DevSpec Remote Wake]'
const STATE_VERSION = 1
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ---------------------------------------------------------------------------
// Seen state: ~/.devspec/recall/antigravity/<conversation>.json
// ---------------------------------------------------------------------------

export function recallDir(home = os.homedir()) {
  return path.join(home, '.devspec', 'recall', 'antigravity')
}

function sha256(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex')
}

/** A file name for one conversation id; anything that is not a plain id is hashed. */
export function conversationFileStem(conversationId) {
  const clean = String(conversationId ?? '').trim()
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{3,119}$/.test(clean) && !clean.includes('..')) return clean
  return `conv-${sha256(clean).slice(0, 32)}`
}

export function seenStatePath(conversationId, home = os.homedir()) {
  return path.join(recallDir(home), `${conversationFileStem(conversationId)}.json`)
}

function emptyState(conversationId) {
  return {
    version: STATE_VERSION,
    host: 'antigravity',
    conversation_id: conversationId,
    updated_at: 0,
    last_processed_step_index: null,
    last_checkpoint_step_index: null,
    handled_remote_ids: [],
    scope_misses: [],
    entries: [],
  }
}

const isInt = (v) => Number.isInteger(v) && v >= 0
const stringList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x) : [])

/** The conversation's recall state; anything unreadable starts clean (it only ever costs a repeated card). */
export function loadSeenState(conversationId, { home = os.homedir() } = {}) {
  const fresh = emptyState(conversationId)
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(seenStatePath(conversationId, home), 'utf8'))
  } catch {
    return { state: fresh, existed: false }
  }
  if (!parsed || parsed.version !== STATE_VERSION || parsed.conversation_id !== conversationId) {
    return { state: fresh, existed: true }
  }
  return {
    existed: true,
    state: {
      ...fresh,
      updated_at: Number.isFinite(parsed.updated_at) ? parsed.updated_at : 0,
      last_processed_step_index: isInt(parsed.last_processed_step_index) ? parsed.last_processed_step_index : null,
      last_checkpoint_step_index: isInt(parsed.last_checkpoint_step_index) ? parsed.last_checkpoint_step_index : null,
      handled_remote_ids: stringList(parsed.handled_remote_ids),
      scope_misses: stringList(parsed.scope_misses),
      entries: (Array.isArray(parsed.entries) ? parsed.entries : []).filter(
        (e) => e && typeof e.key === 'string' && e.key && (e.step === null || e.step === undefined || isInt(e.step)),
      ),
    },
  }
}

/** Serialise within the entry and byte bounds, oldest entries going first. */
export function boundedStateText(state) {
  const limits = TURN_RECALL_LIMITS
  state.handled_remote_ids = state.handled_remote_ids.slice(-limits.recentIdsKept)
  state.scope_misses = state.scope_misses.slice(-limits.recentIdsKept)
  if (state.entries.length > limits.seenStoreMaxEntries) state.entries = state.entries.slice(-limits.seenStoreMaxEntries)
  let text = JSON.stringify(state)
  while (Buffer.byteLength(text, 'utf8') > limits.seenStoreMaxBytes && state.entries.length > 0) {
    state.entries = state.entries.slice(Math.max(1, Math.floor(state.entries.length / 5)))
    text = JSON.stringify(state)
  }
  return `${text}\n`
}

export function saveSeenState(state, { home = os.homedir(), now = Date.now() } = {}) {
  state.updated_at = now
  writePrivateText(seenStatePath(state.conversation_id, home), boundedStateText(state), {
    root: path.join(home, '.devspec'),
  })
}

/** Remove conversations untouched for the TTL. Run when a conversation's file is first written. */
export function sweepExpiredStates({ home = os.homedir(), now = Date.now() } = {}) {
  let removed = 0
  let names = []
  try {
    names = fs.readdirSync(recallDir(home))
  } catch {
    return 0
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const file = path.join(recallDir(home), name)
    try {
      const st = fs.lstatSync(file)
      if (st.isFile() && now - st.mtimeMs > TURN_RECALL_LIMITS.seenStoreTtlMs) {
        fs.rmSync(file, { force: true })
        removed++
      }
    } catch {
      /* a concurrent writer or remover won */
    }
  }
  return removed
}

/** Remember the keys of cards that were injected at `step`, most recent last. */
export function recordSeenKeys(state, keys, step, now = Date.now()) {
  const byKey = new Map(state.entries.map((e) => [e.key, e]))
  for (const key of keys) {
    if (typeof key !== 'string' || !key) continue
    byKey.delete(key)
    byKey.set(key, { key, step: isInt(step) ? step : null, at: now })
  }
  state.entries = Array.from(byKey.values())
}

/** A CHECKPOINT summarises earlier steps away: forget the cards shown at or before it. */
export function applyCheckpoint(state, checkpointStepIndex) {
  if (!isInt(checkpointStepIndex)) return false
  if (isInt(state.last_checkpoint_step_index) && checkpointStepIndex <= state.last_checkpoint_step_index) return false
  state.last_checkpoint_step_index = checkpointStepIndex
  state.entries = state.entries.filter((e) => isInt(e.step) && e.step > checkpointStepIndex)
  return true
}

// ---------------------------------------------------------------------------
// Reading the conversation's newest step
// ---------------------------------------------------------------------------

function readTail(filePath, bytes) {
  const fd = fs.openSync(filePath, 'r')
  try {
    const size = fs.fstatSync(fd).size
    if (size === 0) return { text: '', start: 0 }
    const len = Math.min(size, bytes)
    const buf = Buffer.alloc(len)
    const n = fs.readSync(fd, buf, 0, len, size - len)
    return { text: buf.subarray(0, n).toString('utf8'), start: size - len }
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Walk a JSONL file's lines from the end, in chunks, handing each parsed line to
 * `visit` until it returns true. Reads no more than it must, and never more than
 * the file holds.
 */
export function scanJsonlFromEnd(filePath, visit, { chunkBytes = 65_536 } = {}) {
  let fd
  try {
    fd = fs.openSync(filePath, 'r')
  } catch {
    return false
  }
  try {
    let pos = fs.fstatSync(fd).size
    let carry = Buffer.alloc(0)
    while (pos > 0) {
      const len = Math.min(pos, chunkBytes)
      pos -= len
      const buf = Buffer.alloc(len)
      fs.readSync(fd, buf, 0, len, pos)
      let data = Buffer.concat([buf, carry])
      let end = data.length
      for (let i = data.length - 1; i >= 0; i--) {
        if (data[i] !== 0x0a) continue
        const line = data.subarray(i + 1, end).toString('utf8').trim()
        end = i
        if (!line.startsWith('{')) continue
        let obj
        try {
          obj = JSON.parse(line)
        } catch {
          continue
        }
        if (visit(obj)) return true
      }
      carry = data.subarray(0, end)
    }
    const first = carry.toString('utf8').trim()
    if (first.startsWith('{')) {
      try {
        if (visit(JSON.parse(first))) return true
      } catch {
        /* torn */
      }
    }
    return false
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * The newest step in the compact `transcript.jsonl` and the newest CHECKPOINT, from
 * its last 64 KB. A step whose `content` the compact file cut short is read whole
 * from `transcript_full.jsonl`.
 */
export function readLatestStep(transcriptPath) {
  if (!transcriptPath) return { step: null, checkpoint: null }
  let tail
  try {
    tail = readTail(transcriptPath, TURN_RECALL_LIMITS.transcriptTailBytes)
  } catch {
    return { step: null, checkpoint: null }
  }
  const lines = tail.text.split('\n')
  if (tail.start > 0) lines.shift() // the first line may begin mid-record
  let step = null
  let checkpoint = null
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    let obj
    try {
      obj = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (!isInt(obj?.step_index)) continue
    if (obj.type === 'CHECKPOINT') checkpoint = Math.max(checkpoint ?? -1, obj.step_index)
    if (!step || obj.step_index >= step.step_index) step = obj
  }
  if (!step) return { step: null, checkpoint }
  const out = {
    stepIndex: step.step_index,
    type: String(step.type ?? ''),
    content: typeof step.content === 'string' ? step.content : '',
    truncated: Array.isArray(step.truncated_fields) && step.truncated_fields.includes('content'),
  }
  if (out.truncated) {
    const full = path.join(path.dirname(transcriptPath), 'transcript_full.jsonl')
    scanJsonlFromEnd(full, (obj) => {
      if (!isInt(obj?.step_index) || obj.step_index < out.stepIndex) return true
      if (obj.step_index === out.stepIndex && typeof obj.content === 'string') {
        out.content = obj.content
        out.truncated = false
        return true
      }
      return false
    })
  }
  return { step: out, checkpoint }
}

// ---------------------------------------------------------------------------
// What the person (or the room) asked
// ---------------------------------------------------------------------------

function insideDir(file, dir) {
  const rel = path.relative(path.resolve(dir), path.resolve(file))
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel)
}

function connectionsDirOf(home) {
  return path.join(home, '.devspec', 'remote-control', 'connections')
}

/** Bodies of these room messages, from the local room transcript (newest lines first). */
export function roomMessageBodies(transcriptPath, messageIds, { home = os.homedir() } = {}) {
  if (!transcriptPath || messageIds.length === 0) return []
  if (!transcriptPath.endsWith('.transcript.jsonl') || !insideDir(transcriptPath, connectionsDirOf(home))) return []
  const wanted = new Set(messageIds)
  const found = new Map()
  scanJsonlFromEnd(transcriptPath, (row) => {
    const id = typeof row?.message_id === 'string' ? row.message_id : null
    if (id && wanted.has(id) && !found.has(id) && typeof row.text === 'string' && row.text.trim()) {
      found.set(id, row.text.trim())
    }
    return found.size === wanted.size
  })
  return messageIds.map((id) => found.get(id)).filter(Boolean)
}

const WAKE_HEADER = /^(Session:|Room transcript:|Room state:|Instructions file:|Command from |Wake payload file:|REQUIRED:|Owner message \(|Automation run dispatched)/

/**
 * Is this wake a command or an automation run, and what does it ask? Returns
 * `{ isCommand, query, ids }`. The text comes, in order of preference, from the room
 * transcript by message id, a large wake's payload file, then the wake's own lines.
 * A check job, a notice, an answered question or anything unrecognised is not a
 * command and recalls nothing.
 */
export function remoteWakeCommand(content, { home = os.homedir() } = {}) {
  const none = { isCommand: false, query: '', ids: [] }
  const at = String(content ?? '').indexOf(REMOTE_WAKE)
  if (at < 0) return none
  let inner = String(content).slice(at + REMOTE_WAKE.length)
  const close = inner.indexOf('</SYSTEM_MESSAGE>')
  if (close >= 0) inner = inner.slice(0, close)

  const messageIds = []
  const runNames = []
  const runIds = []
  let command = false
  for (const raw of inner.split('\n')) {
    const line = raw.trim()
    if (!line.startsWith('{"type"')) continue
    let obj
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }
    if (obj.type === 'owner_message') {
      command = true
      if (typeof obj.message_id === 'string' && UUID.test(obj.message_id) && !messageIds.includes(obj.message_id)) {
        messageIds.push(obj.message_id)
      }
    } else if (obj.type === 'automation_run') {
      command = true
      const d = obj.dispatch ?? {}
      if (typeof d.automation_name === 'string' && d.automation_name.trim()) runNames.push(d.automation_name.trim())
      if (typeof d.run_id === 'string' && d.run_id) runIds.push(`run:${d.run_id}`)
    } else if (obj.type === 'wake' && Array.isArray(obj.command_message_ids)) {
      for (const id of obj.command_message_ids) {
        if (typeof id === 'string' && UUID.test(id) && !messageIds.includes(id)) messageIds.push(id)
      }
    }
  }
  if (!command) return none
  const ids = [...messageIds, ...runIds]

  if (messageIds.length === 0) {
    return { isCommand: true, query: runNames.join('\n\n'), ids }
  }

  const transcript = inner.match(/^Room transcript:\s*(\S[^\n\r]*)$/m)?.[1]?.trim()
  const fromRoom = roomMessageBodies(transcript, messageIds, { home })
  if (fromRoom.length > 0) return { isCommand: true, query: fromRoom.join('\n\n'), ids }

  const payload = inner.match(/^Wake payload file:\s*(\/\S+)/m)?.[1]
  const paragraphs = []
  if (payload && /\.wake-[^/]+\.txt$/.test(payload) && insideDir(payload, connectionsDirOf(home))) {
    try {
      paragraphs.push(...fs.readFileSync(payload, 'utf8').split(/\n\s*\n/))
    } catch {
      /* fall back to the wake's own lines */
    }
  }
  if (paragraphs.length === 0) paragraphs.push(...inner.split(/\n\s*\n/))
  const body = []
  for (const para of paragraphs) {
    const p = para.trim()
    if (!p || p.startsWith('{') || WAKE_HEADER.test(p)) continue
    body.push(p.replace(/^[^\n:]{1,120} \((?:owner|delegated)\):\s*/, ''))
  }
  return { isCommand: true, query: body.join('\n\n').trim(), ids }
}

/**
 * Should this step recall, and with what text? Never touches the network.
 * Returns `{ recall, reason, query, ids }`.
 */
export function classifyStep(step, { home = os.homedir() } = {}) {
  const skip = (reason, extra = {}) => ({ recall: false, reason, query: '', ids: [], ...extra })
  if (!step) return skip('no_transcript_step')
  let query
  let ids = []
  let remote = false
  if (step.type === 'USER_INPUT') {
    const request = extractUserRequestText(step.content)
    if (request.includes(REMOTE_WAKE)) {
      const wake = remoteWakeCommand(request, { home })
      if (!wake.isCommand) return skip('not_a_command_wake')
      ;({ query, ids } = wake)
      remote = true
    } else {
      query = request
    }
  } else if (step.type === 'SYSTEM_MESSAGE') {
    const wake = remoteWakeCommand(step.content, { home })
    if (!wake.isCommand) return skip('not_a_command_wake')
    ;({ query, ids } = wake)
    remote = true
  } else {
    return skip('mid_turn_step')
  }
  query = String(query ?? '').trim()
  if (!query) return skip('empty_prompt', { remote, ids })
  if (query.startsWith('/')) return skip('slash_command', { remote, ids })
  if (query.length < TURN_RECALL_LIMITS.minQueryChars) return skip('short_prompt', { remote, ids })
  return { recall: true, reason: remote ? 'remote_command' : 'local_prompt', query, ids, remote }
}

// ---------------------------------------------------------------------------
// Where to ask, and for which project
// ---------------------------------------------------------------------------

/** The configured MCP address with `/turn-recall` on its path and no query string. */
export function turnRecallUrl(mcpUrl) {
  try {
    const u = new URL(mcpUrl)
    u.search = ''
    u.hash = ''
    u.pathname = `${u.pathname.replace(/\/+$/, '')}/turn-recall`
    return u.toString()
  } catch {
    return null
  }
}

function workspaceOf(input, env) {
  const ws = Array.isArray(input?.workspacePaths)
    ? input.workspacePaths[0]
    : Array.isArray(input?.workspace_paths)
      ? input.workspace_paths[0]
      : null
  const candidates = [ws, input?.cwd, env.ANTIGRAVITY_WORKSPACE_DIR]
  for (const c of candidates) if (typeof c === 'string' && c.trim() && path.isAbsolute(c.trim())) return c.trim()
  return null
}

/**
 * The credential and the project evidence for this conversation, read locally and
 * never waiting on a renewal. `null` means no call: signed out, or no project in sight.
 */
export function recallTarget({ input, conversationId, env, home, loadBound = loadState, resolveAuth = resolveDevspecMcpAuth, credentialFor = connectionCredential, gitRemote = gitRemoteOrigin, projectPin = findProjectPin }) {
  let bound = null
  try {
    bound = loadBound(conversationId, {
      connectionsDir: connectionsDirOf(home),
      legacyPath: path.join(home, '.devspec', 'remote-control.json'),
      renewWaitMs: 0,
    })
  } catch {
    bound = null
  }
  if (bound?.connection_id) {
    const cred = credentialFor(bound, { home, env, waitMs: 0 })
    if (!cred?.token || !cred?.mcpUrl) return null
    const scope = {
      connection_id: bound.connection_id,
      ...(typeof bound.session_id === 'string' && bound.session_id ? { session_id: bound.session_id } : {}),
    }
    if (!bound.project_id) {
      const folder = folderScope(bound.cwd || workspaceOf(input, env), { home, gitRemote, projectPin })
      if (folder) Object.assign(scope, folder)
    }
    const capability = typeof bound.connection_capability === 'string' && bound.connection_capability ? bound.connection_capability : null
    return { token: cred.token, mcpUrl: cred.mcpUrl, capability, scope }
  }

  let auth
  try {
    auth = resolveAuth(workspaceOf(input, env) || process.cwd(), { env, home, waitMs: 0 })
  } catch {
    return null
  }
  if (!auth?.ok || !auth.token || !auth.mcp_url) return null
  let choice = null
  try {
    choice = readConversationProject(conversationId, { endpoint: auth.mcp_url, home })
  } catch {
    return null // a saved choice that cannot be read is never replaced by a guess
  }
  if (choice?.status === 'blocked') return null
  if (choice?.status === 'selected') {
    return { token: auth.token, mcpUrl: auth.mcp_url, capability: null, scope: { project_id: choice.project.id } }
  }
  const folder = folderScope(workspaceOf(input, env), { home, gitRemote, projectPin })
  if (!folder) return null
  return { token: auth.token, mcpUrl: auth.mcp_url, capability: null, scope: folder }
}

function folderScope(cwd, { home, gitRemote, projectPin }) {
  if (!cwd) return null
  let pin = null
  try {
    pin = projectPin(cwd, { home })
  } catch {
    pin = null
  }
  const remote = gitRemote(cwd)
  if (!pin?.project_id && !remote) return null
  return {
    ...(pin?.project_id ? { pinned_project_id: pin.project_id } : {}),
    ...(remote ? { git_remote: remote } : {}),
    // Never the account's only project by default: just what the folder says.
    folder_scope_only: true,
  }
}

export function scopeFingerprint(mcpUrl, scope) {
  const keys = Object.keys(scope).sort()
  return sha256(JSON.stringify([mcpUrl, keys.map((k) => [k, scope[k]])])).slice(0, 32)
}

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

/**
 * POST the turn to DevSpec. Resolves `{ ok: true, payload }`, `{ ok: false,
 * scopeMiss: true }` for a scope the server could not place, or `{ ok: false }` for
 * anything else; it never throws and never waits past `timeoutMs`.
 */
export async function postTurnRecall({ url, token, capability = null, body, timeoutMs = TURN_RECALL_LIMITS.clientHttpTimeoutMs, fetchImpl = globalThis.fetch }) {
  let res
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...pluginHeaders(),
        ...(capability ? { 'x-devspec-connection-capability': capability } : {}),
      },
      body: JSON.stringify(body),
    })
  } catch {
    return { ok: false, reason: 'unreachable' }
  }
  let parsed = null
  try {
    parsed = await res.json()
  } catch {
    parsed = null
  }
  if (!res.ok) {
    // 400 for anything but a malformed request is the server saying it could not
    // place this scope (no project, a choice to make, a connection in another project).
    const scopeMiss = res.status === 400 && parsed?.code !== 'invalid_request'
    return { ok: false, reason: `http_${res.status}`, scopeMiss }
  }
  if (!parsed || typeof parsed !== 'object') return { ok: false, reason: 'unreadable' }
  const block = typeof parsed.formatted_block === 'string' ? parsed.formatted_block.trim() : ''
  const seen = stringList(parsed.seen_keys)
  const keys = seen.length > 0
    ? seen
    : (Array.isArray(parsed.cards) ? parsed.cards : []).map((c) => c?.dedupe_key ?? c?.seenKey).filter((k) => typeof k === 'string' && k)
  return { ok: true, block, keys }
}

// ---------------------------------------------------------------------------
// One PreInvocation
// ---------------------------------------------------------------------------

function parseInput(raw) {
  if (raw && typeof raw === 'object') return raw
  try {
    return JSON.parse(raw || '{}')
  } catch {
    return {}
  }
}

function compactTranscriptPath(input, conversationId, env) {
  const named = normalizeTranscriptPath(input?.transcriptPath) || normalizeTranscriptPath(input?.transcript_path)
  // normalizeTranscriptPath already prefers the compact sibling of transcript_full.jsonl;
  // with no compact file the full one is read directly (its steps are never cut short).
  if (named) return named
  return inferAntigravityTranscriptPath(conversationId, env)
}

/**
 * Decide, ask, remember. Resolves `{ injectSteps: [systemMessage] }` when there are
 * cards for this turn, otherwise `null`, with `reason` saying why (for tests and
 * debugging only; nothing prints it).
 */
export async function runTurnRecall(raw, {
  env = process.env,
  home = os.homedir(),
  now = () => Date.now(),
  fetchImpl = globalThis.fetch,
  target = recallTarget,
  timeoutMs = TURN_RECALL_LIMITS.clientHttpTimeoutMs,
} = {}) {
  const input = parseInput(raw)
  const conversationId = resolveHookConversationId(input, env)
  if (!conversationId) return { result: null, reason: 'no_conversation_id' }
  const transcriptPath = compactTranscriptPath(input, conversationId, env)
  const { step, checkpoint } = readLatestStep(transcriptPath)
  if (!step) return { result: null, reason: 'no_transcript_step' }

  const { state, existed } = loadSeenState(conversationId, { home })
  let dirty = applyCheckpoint(state, checkpoint)
  const persist = () => {
    if (!dirty) return
    try {
      if (!existed) sweepExpiredStates({ home, now: now() })
      saveSeenState(state, { home, now: now() })
    } catch {
      /* state is only dedupe: a failed write costs a repeated card, never the turn */
    }
    dirty = false
  }

  if (isInt(state.last_processed_step_index) && step.stepIndex <= state.last_processed_step_index) {
    persist()
    return { result: null, reason: 'already_processed' }
  }
  const decision = classifyStep(step, { home })
  if (decision.reason === 'mid_turn_step' || decision.reason === 'no_transcript_step') {
    persist()
    return { result: null, reason: decision.reason }
  }
  state.last_processed_step_index = step.stepIndex
  dirty = true
  if (!decision.recall) {
    persist()
    return { result: null, reason: decision.reason }
  }
  if (decision.ids.length > 0 && decision.ids.every((id) => state.handled_remote_ids.includes(id))) {
    persist()
    return { result: null, reason: 'command_already_recalled' }
  }

  let where = null
  try {
    where = target({ input, conversationId, env, home })
  } catch {
    where = null
  }
  if (!where) {
    persist()
    return { result: null, reason: 'no_credential_or_project' }
  }
  const url = turnRecallUrl(where.mcpUrl)
  if (!url) {
    persist()
    return { result: null, reason: 'bad_server_address' }
  }
  const fingerprint = scopeFingerprint(url, where.scope)
  if (state.scope_misses.includes(fingerprint)) {
    persist()
    return { result: null, reason: 'scope_not_placed_before' }
  }
  persist()

  const answer = await postTurnRecall({
    url,
    token: where.token,
    capability: where.capability,
    timeoutMs,
    fetchImpl,
    body: {
      query: decision.query,
      host: 'antigravity',
      conversation_id: conversationId,
      ...where.scope,
      seen_versions: state.entries.map((e) => e.key),
    },
  })
  if (!answer.ok) {
    if (answer.scopeMiss) {
      state.scope_misses.push(fingerprint)
      dirty = true
      persist()
    }
    return { result: null, reason: answer.reason }
  }
  for (const id of decision.ids) if (!state.handled_remote_ids.includes(id)) state.handled_remote_ids.push(id)
  dirty = true
  if (!answer.block) {
    persist()
    return { result: null, reason: 'nothing_relevant' }
  }
  recordSeenKeys(state, answer.keys, step.stepIndex, now())
  persist()
  return {
    result: { injectSteps: [{ systemMessage: { systemMessage: answer.block } }] },
    reason: decision.reason,
    keys: answer.keys,
  }
}

/**
 * `runTurnRecall` that can never hold the turn past `hardExitMs` or throw: on the
 * deadline or any error it resolves `null` and the turn goes ahead without cards.
 */
export async function turnRecallSteps(raw, options = {}) {
  const hardExitMs = options.hardExitMs ?? TURN_RECALL_LIMITS.hardExitMs
  let timer
  const deadline = new Promise((resolve) => {
    // Not unref'd: it must be able to end the race even when nothing else holds the loop.
    timer = setTimeout(() => resolve(null), hardExitMs)
  })
  try {
    const out = await Promise.race([
      runTurnRecall(raw, options).then((r) => r?.result ?? null, () => null),
      deadline,
    ])
    return out
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
