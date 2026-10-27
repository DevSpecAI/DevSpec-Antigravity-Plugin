#!/usr/bin/env node
/**
 * DevSpec provenance assistance for Antigravity — ADR 71c23b46.
 *
 * Enforces on the ONE artifact that is decidable: a commit message either carries a
 * well-formed DevSpec item reference or it does not.
 *
 *  - Edits and execution are NEVER denied for want of a claim.
 *  - Editing tracked files without an active claim stages a one-time provenance nudge
 *    per conversation+repo that PostInvocation injects as an `ephemeralMessage`.
 *  - Tracks `claim_work_item`, `release_work_item`, `fail_work_item`, and
 *    `record_implementation` per conversation+repository.
 *  - Where exactly one claim is unambiguously active, the reference is APPENDED for
 *    the agent (`overwrite` and `hookSpecificOutput.updatedInput`) and reported.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { commitScope, connectedProject } from './commit-scope.mjs'
import { gitRemoteOrigin } from './devspec-scope.mjs'
import { mcpToolsCall } from './mcp-call.mjs'
import { resolveHookConversationId } from './mirror-turn.mjs'
import { hostTokenFromEnv, resolveDevspecMcpAuth } from './resolve-mcp-auth.mjs'
import { isEntryPoint } from './entry-point.mjs'

export const CONTRACT_URI = 'devspec://product/implementation-contract'
export const CLAIM_MAX_AGE_MS = 24 * 60 * 60 * 1000
export const ONLINE_TIMEOUT_MS = 2_500
const FUTURE_SKEW_MS = 5 * 60 * 1000
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const UUID_RE = new RegExp(`^${UUID}$`, 'i')
const REFERENCE_RE = new RegExp(`\\[devspec:(${UUID})\\]`, 'i')

const CLAIM_VERB = 'claim_work_item'
const GET_ITEM_VERB = 'get_task'
const RELEASE_VERBS = new Set(['record_implementation', 'fail_work_item', 'release_work_item'])
const CLAIM_AUTOMATION_VERB = 'claim_automation_run'
const RECORD_AUTOMATION_VERB = 'record_automation_run'

/** Tools recognized as file edits across Antigravity and Claude Code. */
const EDIT_TOOLS = new Set([
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'write_to_file',
  'replace_file_content',
  'multi_replace_file_content',
])

const COMMAND_TOOLS = new Set(['Bash', 'run_command'])

function bareToolName(toolName) {
  return String(toolName || '').replace(/^default_api:/, '')
}

export function devspecToolVerb(toolName, toolInput = null) {
  const s = String(toolName || '')
  const match = /^(?:mcp__(?:plugin_devspec_)?devspec__|mcp_devspec_|devspec__)([a-z0-9_]+)$/.exec(s)
  if (match) return match[1]
  if (bareToolName(s) === 'call_mcp_tool' && toolInput && typeof toolInput === 'object') {
    const server = String(
      toolInput.ServerName ?? toolInput.server_name ?? toolInput.serverName ?? '',
    ).toLowerCase()
    const inner = String(toolInput.ToolName ?? toolInput.tool_name ?? toolInput.toolName ?? '')
    if (server === 'devspec' && /^[a-z0-9_]+$/.test(inner)) return inner
  }
  return null
}

export function unwrapDevspecArgs(toolName, toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return {}
  if (bareToolName(toolName) === 'call_mcp_tool') {
    const inner = toolInput.Arguments ?? toolInput.arguments
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) return inner
  }
  return toolInput
}

export function detectCommandDevspecVerb(command) {
  if (typeof command !== 'string' || !/\bnode\b/.test(command) || /\b--test\b/.test(command)) {
    return null
  }
  const match =
    /\b(claim_work_item|get_task|record_implementation|fail_work_item|release_work_item|claim_automation_run|record_automation_run)\b/.exec(
      command,
    )
  return match ? match[1] : null
}

export function stateDir(env = process.env) {
  if (env.DEVSPEC_ANTIGRAVITY_STATE_DIR) return env.DEVSPEC_ANTIGRAVITY_STATE_DIR
  if (env.DEVSPEC_CLAUDE_STATE_DIR) return env.DEVSPEC_CLAUDE_STATE_DIR
  if (env.DEVSPEC_PROVENANCE_DIR) return env.DEVSPEC_PROVENANCE_DIR
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'user'
  return path.join(os.tmpdir(), `devspec-antigravity-provenance-${uid}`)
}

function enforcesPosixModes(platform) {
  return platform !== 'win32'
}

function restrictMode(target, mode, platform) {
  try {
    fs.chmodSync(target, mode)
  } catch (error) {
    if (enforcesPosixModes(platform)) throw error
  }
}

function ensurePrivateDirectory(dir, platform = process.platform) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const stat = fs.lstatSync(dir)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('provenance state path is not a directory')
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error('provenance state directory is not owned by this user')
  }
  restrictMode(dir, 0o700, platform)
}

function atomicWritePrivate(file, value, platform = process.platform) {
  ensurePrivateDirectory(path.dirname(file), platform)
  const temp = `${file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`
  let fd
  try {
    fd = fs.openSync(temp, 'wx', 0o600)
    fs.writeFileSync(fd, `${JSON.stringify(value)}\n`, 'utf8')
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = undefined
    fs.renameSync(temp, file)
    restrictMode(file, 0o600, platform)
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
    try { fs.unlinkSync(temp) } catch { /* renamed, or never created */ }
  }
}

function canonicalCwd(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0 || cwd.includes('\0')) throw new Error('missing hook cwd')
  return fs.realpathSync(cwd)
}

export function canonicalRepo(cwdPath) {
  try {
    const repository = execFileSync(
      'git',
      ['-C', cwdPath, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 },
    ).trim()
    return fs.realpathSync(repository)
  } catch {
    return cwdPath
  }
}

function mainWorktreeOf(repoRoot) {
  return path.basename(repoRoot) === '.git' ? path.dirname(repoRoot) : null
}

function validSessionId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,160}$/.test(value)
}

export function resolveProvenanceSessionId(input, env = process.env) {
  if (!input || typeof input !== 'object') return null
  const direct =
    input.session_id ??
    input.sessionId ??
    input.conversationId ??
    input.conversation_id ??
    resolveHookConversationId(input, env)
  return validSessionId(direct) ? direct : null
}

export function resolveProvenanceCwd(input) {
  if (!input || typeof input !== 'object') return null
  const toolInput = input.tool_input ?? input.toolInput ?? input.toolCall?.args ?? {}
  if (typeof input.cwd === 'string' && input.cwd) return input.cwd
  const ws = Array.isArray(input.workspacePaths)
    ? input.workspacePaths[0]
    : Array.isArray(input.workspace_paths)
      ? input.workspace_paths[0]
      : null
  if (typeof ws === 'string' && ws) return ws
  if (typeof toolInput.Cwd === 'string' && toolInput.Cwd) return toolInput.Cwd
  if (typeof toolInput.cwd === 'string' && toolInput.cwd) return toolInput.cwd
  const targetFile =
    toolInput.TargetFile ??
    toolInput.targetFile ??
    toolInput.AbsolutePath ??
    toolInput.file_path ??
    toolInput.notebook_path ??
    null
  if (typeof targetFile === 'string' && path.isAbsolute(targetFile)) {
    let dir = path.dirname(targetFile)
    while (dir && dir !== path.dirname(dir)) {
      if (fs.existsSync(dir)) return dir
      dir = path.dirname(dir)
    }
  }
  return null
}

export function scopeFrom(input, env = process.env) {
  const sessionId = resolveProvenanceSessionId(input, env)
  if (!sessionId) {
    throw new Error('missing or malformed hook session_id')
  }
  const rawCwd = resolveProvenanceCwd(input)
  const cwd = canonicalCwd(rawCwd)
  const repoRoot = canonicalRepo(cwd)
  return { sessionId, cwd, repoRoot, mainWorktree: mainWorktreeOf(repoRoot) }
}

function statePathFor(scope, kind, env = process.env) {
  const digest = crypto
    .createHash('sha256')
    .update(`${scope.sessionId}\0${scope.repoRoot}`)
    .digest('hex')
  return path.join(stateDir(env), `${digest}.${kind}.json`)
}

function pendingNudgePathFor(sessionId, env = process.env) {
  const digest = crypto
    .createHash('sha256')
    .update(`pending-nudge\0${sessionId}`)
    .digest('hex')
  return path.join(stateDir(env), `${digest}.pending-nudge.json`)
}

export function readClaimsRecord(scope, { env = process.env, now = Date.now(), platform = process.platform } = {}) {
  const file = statePathFor(scope, 'claims', env)
  try {
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink()) return { claims: [], details: {} }
    if (enforcesPosixModes(platform) && (stat.mode & 0o077) !== 0) return { claims: [], details: {} }
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (parsed?.schema !== 1 || !Array.isArray(parsed.claims)) return { claims: [], details: {} }
    if (typeof parsed.updated_at !== 'number') return { claims: [], details: {} }
    if (parsed.updated_at > now + FUTURE_SKEW_MS) return { claims: [], details: {} }
    if (now - parsed.updated_at > CLAIM_MAX_AGE_MS) return { claims: [], details: {} }
    if (parsed.session_id !== scope.sessionId || parsed.repo_root !== scope.repoRoot) {
      return { claims: [], details: {} }
    }
    const claims = parsed.claims
      .filter((id) => typeof id === 'string' && UUID_RE.test(id))
      .map((id) => id.toLowerCase())
    const details = parsed.details && typeof parsed.details === 'object' ? parsed.details : {}
    return { claims, details }
  } catch {
    return { claims: [], details: {} }
  }
}

export function readClaims(scope, options = {}) {
  return readClaimsRecord(scope, options).claims
}

export function readClaimedWorkItems(scope, options = {}) {
  const { claims, details } = readClaimsRecord(scope, options)
  return claims.map((id) => {
    const entry = details[id] && typeof details[id] === 'object' ? details[id] : {}
    return {
      id,
      title: typeof entry.title === 'string' && entry.title.trim() ? entry.title.trim() : null,
      work_claim_ref: typeof entry.work_claim_ref === 'string' ? entry.work_claim_ref : null,
      provenance_ref: typeof entry.provenance_ref === 'string' ? entry.provenance_ref : null,
    }
  })
}

export function readClaimDetails(scope, options = {}) {
  const { claims, details } = readClaimsRecord(scope, options)
  if (claims.length !== 1) return null
  const id = claims[0]
  const entry = details[id] && typeof details[id] === 'object' ? details[id] : {}
  let workClaimRef = typeof entry.work_claim_ref === 'string' ? entry.work_claim_ref : null
  const provenanceRef = typeof entry.provenance_ref === 'string' ? entry.provenance_ref : null
  if (!workClaimRef && scope?.sessionId) {
    const local = resolveLocalItemDetails(id, {
      conversationId: scope.sessionId,
      env: options.env ?? process.env,
    })
    if (local?.work_claim_ref) {
      workClaimRef = local.work_claim_ref
      backfillClaimedItemDetails(scope, id, local, options)
    } else if (local?.title && !entry.title) {
      backfillClaimedItemDetails(scope, id, local, options)
    }
  }
  return {
    task_id: id,
    work_claim_ref: workClaimRef,
    provenance_ref: provenanceRef,
  }
}

function writeClaims(scope, claims, details = {}, { env = process.env, now = Date.now(), platform = process.platform } = {}) {
  const file = statePathFor(scope, 'claims', env)
  const deduped = [...new Set(claims.map((id) => id.toLowerCase()))]
  if (deduped.length === 0) {
    try { fs.unlinkSync(file) } catch { /* nothing to remove */ }
    return
  }
  const filteredDetails = {}
  for (const id of deduped) {
    if (details[id] && typeof details[id] === 'object') {
      filteredDetails[id] = details[id]
    }
  }
  atomicWritePrivate(file, {
    schema: 1,
    session_id: scope.sessionId,
    repo_root: scope.repoRoot,
    claims: deduped,
    details: filteredDetails,
    updated_at: now,
  }, platform)
}

export function readActiveAutomation(scope, { env = process.env, now = Date.now(), platform = process.platform } = {}) {
  const file = statePathFor(scope, 'automation', env)
  try {
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink()) return null
    if (enforcesPosixModes(platform) && (stat.mode & 0o077) !== 0) return null
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (parsed?.schema !== 1) return null
    if (typeof parsed.updated_at !== 'number') return null
    if (parsed.updated_at > now + FUTURE_SKEW_MS) return null
    if (now - parsed.updated_at > CLAIM_MAX_AGE_MS) return null
    if (parsed.session_id !== scope.sessionId || parsed.repo_root !== scope.repoRoot) return null
    const runId = typeof parsed.run_id === 'string' && parsed.run_id.trim() ? parsed.run_id.trim() : null
    const automationId =
      typeof parsed.automation_id === 'string' && parsed.automation_id.trim()
        ? parsed.automation_id.trim()
        : null
    const automationName =
      typeof parsed.automation_name === 'string' && parsed.automation_name.trim()
        ? parsed.automation_name.trim()
        : null
    if (!runId && !automationName) return null
    return {
      run_id: runId,
      automation_id: automationId,
      automation_name: automationName,
    }
  } catch {
    return null
  }
}

export function writeActiveAutomation(
  scope,
  automation,
  { env = process.env, now = Date.now(), platform = process.platform } = {},
) {
  if (!automation || (!automation.run_id && !automation.automation_name)) return
  const file = statePathFor(scope, 'automation', env)
  atomicWritePrivate(
    file,
    {
      schema: 1,
      session_id: scope.sessionId,
      repo_root: scope.repoRoot,
      run_id: automation.run_id || null,
      automation_id: automation.automation_id || null,
      automation_name: automation.automation_name || null,
      updated_at: now,
    },
    platform,
  )
}

export function backfillClaimedItemDetails(
  scope,
  itemId,
  resolved,
  { env = process.env, now = Date.now(), platform = process.platform } = {},
) {
  if (!scope || !itemId || !UUID_RE.test(itemId) || !resolved || typeof resolved !== 'object') return false
  const targetId = itemId.toLowerCase()
  const { claims, details } = readClaimsRecord(scope, { env, now, platform })
  if (!claims.includes(targetId)) return false
  const current = details[targetId] && typeof details[targetId] === 'object' ? details[targetId] : {}
  const nextTitle =
    (typeof current.title === 'string' && current.title.trim()) ||
    (typeof resolved.title === 'string' && resolved.title.trim() ? resolved.title.trim() : null)
  const nextClaimRef =
    current.work_claim_ref ||
    (typeof resolved.work_claim_ref === 'string' && resolved.work_claim_ref.trim()
      ? resolved.work_claim_ref.trim()
      : null)
  const nextProvRef =
    current.provenance_ref ||
    (typeof resolved.provenance_ref === 'string' && resolved.provenance_ref.trim()
      ? resolved.provenance_ref.trim()
      : null)
  if (
    nextTitle === (current.title ?? null) &&
    nextClaimRef === (current.work_claim_ref ?? null) &&
    nextProvRef === (current.provenance_ref ?? null)
  ) {
    return false
  }
  const nextDetails = {
    ...details,
    [targetId]: {
      ...current,
      title: nextTitle,
      work_claim_ref: nextClaimRef,
      provenance_ref: nextProvRef,
      at: current.at ?? now,
    },
  }
  try {
    writeClaims(scope, claims, nextDetails, { env, now, platform })
    return true
  } catch {
    return false
  }
}

export function clearActiveAutomation(
  scope,
  runId = null,
  { env = process.env, now = Date.now(), platform = process.platform } = {},
) {
  const file = statePathFor(scope, 'automation', env)
  if (runId) {
    const active = readActiveAutomation(scope, { env, now, platform })
    if (active?.run_id && active.run_id.toLowerCase() !== String(runId).toLowerCase()) return
  }
  try {
    fs.unlinkSync(file)
  } catch {
    /* nothing to remove */
  }
}

export function backfillAutomationDetails(
  scope,
  resolved,
  { env = process.env, now = Date.now(), platform = process.platform } = {},
) {
  if (!scope || !resolved || typeof resolved !== 'object') return false
  const active = readActiveAutomation(scope, { env, now, platform })
  if (!active) return false
  if (
    active.run_id &&
    resolved.run_id &&
    active.run_id.toLowerCase() !== String(resolved.run_id).toLowerCase()
  ) {
    return false
  }
  const nextName =
    active.automation_name ||
    (typeof resolved.automation_name === 'string' && resolved.automation_name.trim()
      ? resolved.automation_name.trim()
      : null)
  const nextAutoId =
    active.automation_id ||
    (typeof resolved.automation_id === 'string' && resolved.automation_id.trim()
      ? resolved.automation_id.trim()
      : null)
  if (nextName === active.automation_name && nextAutoId === active.automation_id) {
    return false
  }
  try {
    writeActiveAutomation(
      scope,
      {
        run_id: active.run_id || resolved.run_id || null,
        automation_id: nextAutoId,
        automation_name: nextName,
      },
      { env, now, platform },
    )
    return true
  } catch {
    return false
  }
}

export function stagePendingNudge(sessionId, message, { env = process.env, now = Date.now(), platform = process.platform } = {}) {
  if (!validSessionId(sessionId) || typeof message !== 'string' || !message) return
  try {
    atomicWritePrivate(
      pendingNudgePathFor(sessionId, env),
      { schema: 1, session_id: sessionId, message, at: now },
      platform,
    )
  } catch {
    /* non-fatal */
  }
}

export function clearPendingNudge(sessionId, { env = process.env } = {}) {
  if (!validSessionId(sessionId)) return
  try {
    fs.unlinkSync(pendingNudgePathFor(sessionId, env))
  } catch {
    /* absent */
  }
}

export function consumePendingNudge(sessionId, { env = process.env } = {}) {
  if (!validSessionId(sessionId)) return null
  const file = pendingNudgePathFor(sessionId, env)
  const consumed = `${file}.consumed-${crypto.randomUUID()}`
  try {
    fs.renameSync(file, consumed)
    const parsed = JSON.parse(fs.readFileSync(consumed, 'utf8'))
    if (parsed?.schema === 1 && parsed.session_id === sessionId && typeof parsed.message === 'string' && parsed.message) {
      return parsed.message
    }
    return null
  } catch {
    return null
  } finally {
    try { fs.rmSync(consumed, { force: true }) } catch { /* best effort */ }
  }
}

export function pendingNudgeNotice({ input = {}, env = process.env } = {}) {
  const sessionId = resolveProvenanceSessionId(input, env)
  if (!sessionId) return null
  const message = consumePendingNudge(sessionId, { env })
  if (!message) return null
  return {
    injectSteps: [
      {
        ephemeralMessage: message,
      },
    ],
    additionalContext: message,
    hookSpecificOutput: {
      hookEventName: 'PostInvocation',
      additionalContext: message,
    },
  }
}

/* ------------------------------------------------------------------ *
 * Reading a commit message out of a shell command, without pretending *
 * ------------------------------------------------------------------ */

export function simpleGitCommit(command, { onInvocation } = {}) {
  if (typeof command !== 'string' || command.length === 0) return null

  const segments = [[]]
  let word = ''
  let started = false
  let quote = null
  let wordStart = -1

  const endWord = (at) => {
    if (!started) return
    segments[segments.length - 1].push({ value: word, start: wordStart, end: at })
    word = ''
    started = false
    wordStart = -1
  }

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]

    if (quote === "'") {
      if (char === "'") { quote = null; continue }
      word += char
      started = true
      continue
    }
    if (quote === '"') {
      if (char === '"') { quote = null; continue }
      if (char === '$' || char === '`' || char === '\\') return null
      word += char
      started = true
      continue
    }

    if (char === '"' || char === "'") {
      if (!started) wordStart = index
      quote = char
      started = true
      continue
    }
    if (char === '&') {
      if (command[index + 1] !== '&') return null
      if (segments.length > 1) return null
      endWord(index)
      segments.push([])
      index += 1
      continue
    }
    if ('|;<>(){}`$\\\n\r'.includes(char)) return null
    if (/\s/.test(char)) {
      endWord(index)
      continue
    }
    if (!started) wordStart = index
    word += char
    started = true
  }
  if (quote) return null
  endWord(command.length)

  if (segments.length === 2 && !readablePrefix(segments[0])) return null
  const words = segments[segments.length - 1]

  if (words.length === 0) return null
  if (words[0].value !== 'git') return null

  const directoryChanges = segments.length === 2 && segments[0][0]?.value === 'cd'
    ? [segments[0][1].value] : []
  let index = 1
  while (index < words.length && words[index].value.startsWith('-')) {
    const option = words[index].value
    if (option === '-C') {
      if (!words[index + 1] || words[index + 1].value.startsWith('-')) return null
      directoryChanges.push(words[index + 1].value)
      index += 2
      continue
    }
    if (option === '--no-pager' || option === '--no-optional-locks') {
      index += 1
      continue
    }
    return null
  }
  if (words[index]?.value !== 'commit') return null

  const rest = words.slice(index + 1)
  const REFUSED = new Set([
    '--amend', '--squash', '--fixup', '--no-edit', '--template', '-t',
    '-F', '--file', '-C', '--reuse-message', '-c', '--reedit-message',
    '--interactive', '-i', '-p', '--patch',
  ])
  for (const entry of rest) {
    if (REFUSED.has(entry.value)) return null
    if (/^(?:--file|--template|--reuse-message|--reedit-message|--squash|--fixup)=/.test(entry.value)) return null
  }

  const messages = []
  for (let i = 0; i < rest.length; i += 1) {
    const entry = rest[i]
    if (entry.value === '-m' || entry.value === '--message') {
      const next = rest[i + 1]
      if (!next) return null
      messages.push(next)
      i += 1
      continue
    }
    if (entry.value.startsWith('--message=')) {
      messages.push({ value: entry.value.slice('--message='.length), start: entry.start, end: entry.end, joined: true })
      continue
    }
    if (/^-m./.test(entry.value)) {
      messages.push({ value: entry.value.slice(2), start: entry.start, end: entry.end, joined: true })
      continue
    }
  }
  if (messages.length !== 1) return null

  const message = messages[0]
  const closing = command[message.end - 1]
  const quoted = closing === '"' || closing === "'"
  onInvocation?.({ directoryChanges, commitArgs: rest.map((entry) => entry.value) })
  return {
    message: message.value,
    insertOffset: message.end - 1,
    appendable: quoted,
  }
}

function readablePrefix(prefix) {
  const head = prefix[0]?.value
  if (prefix.length === 2 && head === 'cd' && !prefix[1].value.startsWith('-')) return true
  if (prefix.length >= 3 && head === 'git' && prefix[1].value === 'add') return true
  return false
}

const HEREDOC_DELIMITER = /^[A-Za-z_][A-Za-z0-9_]*$/

export function heredocGitCommit(command, options = {}) {
  if (typeof command !== 'string' || command.length === 0) return null
  if (command.includes('`')) return null

  const open = command.indexOf("<<'")
  if (open === -1) return null
  if (command.indexOf('<<', open + 3) !== -1) return null
  if (command.indexOf('<<', 0) !== open) return null

  const delimEnd = command.indexOf("'", open + 3)
  if (delimEnd === -1) return null
  const delimiter = command.slice(open + 3, delimEnd)
  if (!HEREDOC_DELIMITER.test(delimiter)) return null

  let cursor = delimEnd + 1
  if (command[cursor] === '\r') cursor += 1
  if (command[cursor] !== '\n') return null
  const bodyStart = cursor + 1

  const terminator = `\n${delimiter}`
  let close = command.indexOf(terminator, bodyStart - 1)
  while (close !== -1) {
    const after = command[close + terminator.length]
    if (after === undefined || after === '\n' || after === '\r') break
    close = command.indexOf(terminator, close + 1)
  }
  if (close === -1 || close < bodyStart - 1) return null

  const body = command.slice(bodyStart, close)
  const head = command.slice(0, open)
  const tail = command.slice(close + terminator.length)
  if (head.includes('\n') || head.includes('\r')) return null

  let normalised = null
  const viaStdin = /^(?<pre>.*?)\s(?:-F|--file)\s+-\s*$/.exec(head)
  const viaSubstitution = /^(?<pre>.*?)\s-m\s+"\$\(cat\s*$/.exec(head)

  if (viaStdin) {
    if (tail.trim() !== '') return null
    if (head.includes('$')) return null
    normalised = `${viaStdin.groups.pre} -m "x"`
  } else if (viaSubstitution) {
    if (tail.trim() !== ')"') return null
    if (command.indexOf('$(') !== command.lastIndexOf('$(')) return null
    if (viaSubstitution.groups.pre.includes('$')) return null
    normalised = `${viaSubstitution.groups.pre} -m "x"`
  } else {
    return null
  }

  const simple = simpleGitCommit(normalised, options)
  if (!simple || simple.message !== 'x') return null

  const firstBreak = body.indexOf('\n')
  const subjectEnd = firstBreak === -1 ? bodyStart + body.length : bodyStart + firstBreak

  return { message: body, insertOffset: subjectEnd, appendable: true }
}

export function isSimpleGitPush(command) {
  if (typeof command !== 'string' || /[|&;<>(){}`$\n\r]/.test(command)) return false
  const words = command.trim().split(/\s+/)
  return words[0] === 'git' && words[1] === 'push'
}

export function referenceIn(message) {
  const match = typeof message === 'string' ? message.match(REFERENCE_RE) : null
  return match ? match[1].toLowerCase() : null
}

export async function confirmReferenceOnline(commitMessage, options = {}) {
  const {
    cwd,
    mainWorktree = null,
    marker = null,
    env = process.env,
    timeoutMs = ONLINE_TIMEOUT_MS,
    call = mcpToolsCall,
  } = options

  const auth = resolveAuth(cwd, mainWorktree, env)
  if (!auth) return 'unavailable'

  const args = { commit_message: commitMessage }
  if (marker?.kind === 'pin' && typeof marker.project_id === 'string' && marker.project_id) {
    args.pinned_project_id = marker.project_id
  }
  const remote = gitRemoteOrigin(cwd)
  if (remote) args.git_remote = remote

  let result
  try {
    result = await call({
      mcpUrl: auth.mcp_url,
      token: auth.token,
      name: 'validate_commit_reference',
      arguments: args,
      timeoutMs,
    })
  } catch {
    return 'unavailable'
  }

  const status = result?.online?.status
  if (status === 'not_found') return 'not_found'
  if (status === 'valid') return 'valid'
  return 'indeterminate'
}

function deny(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }
}

/**
 * The stamped command, with the permission decision it carries: `allow` only for a
 * commit in a pinned repository, the one stamp the plugin has always allowed; `ask`
 * for one in scope by its origin (item cdd7f0f3), so matching by remote stamps more
 * commits without allowing any command the plugin did not allow before.
 */
function stamp(updatedCommand, toolInput, itemId, { decision }) {
  const nextInput = { ...toolInput }
  if (typeof toolInput?.CommandLine === 'string') {
    nextInput.CommandLine = updatedCommand
  }
  if (typeof toolInput?.command === 'string' || nextInput.CommandLine === undefined) {
    nextInput.command = updatedCommand
  }
  return {
    systemMessage: `DevSpec stamped [devspec:${itemId}] onto this commit message (one active claim).`,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      updatedInput: nextInput,
    },
  }
}

function nudge(message) {
  return {
    systemMessage: message,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: message,
    },
  }
}

/**
 * What a refused commit asks of the model: only what it cannot leave to the plugin
 * (item 9d945fcc). With exactly one task claimed, PreToolUse adds that task's tag to
 * a `git commit -m "…"` message itself, so the model never types a UUID it does not
 * need; it writes a tag only when several tasks are claimed, because the plugin must
 * never guess between them. When the stamp applies is the served contract's
 * commit_provenance_contract, pointed at rather than restated.
 */
export function recoveryText(claims) {
  if (claims.length > 1) {
    return [
      `DevSpec: this commit has no [devspec:<id>] reference and ${claims.length} claims are active, so nothing was added automatically.`,
      `Pick the one this commit belongs to and put it in the message: ${claims.map((id) => `[devspec:${id}]`).join(' or ')}`,
      'Then retry the commit. Nothing else is blocked.',
    ].join(' ')
  }
  if (claims.length === 1) {
    return [
      'DevSpec: this commit has no [devspec:<id>] reference, and its message cannot be stamped as written.',
      'Retry it with the message in quotes after -m (git commit -m "…") and the tag of the task you claimed is added for you.',
      `Authority: ${CONTRACT_URI} (commit_provenance_contract). Nothing else is blocked.`,
    ].join(' ')
  }
  // Since item ab6a3960 the write gate refuses a thin task: create_task needs a real
  // description and the reason behind it, so this must never suggest a one-liner.
  return [
    'DevSpec: no task is claimed for this commit, so it would land unlinked.',
    'Recover without leaving this turn: search_tasks for the task this work belongs to and claim it (claim_work_item);',
    'if none covers it, create_task for the smallest adequate task, with a real description of the change',
    'and the reason it is needed (the server refuses a thin one), and claim that. When to create one is the',
    "contract's work_entry_contract. Then retry the same commit: its [devspec:<id>] tag is added for you.",
    `Authority: ${CONTRACT_URI}. Nothing else is blocked, and no other command is affected.`,
  ].join(' ')
}

function resolveAuth(cwd, mainWorktree, env) {
  const hostToken = hostTokenFromEnv(env)
  for (const dir of [cwd, mainWorktree]) {
    if (!dir) continue
    try {
      const auth = resolveDevspecMcpAuth(dir, { env, hostToken })
      if (auth?.ok && auth.token && auth.mcp_url) return auth
    } catch {
      /* an unreadable config is simply not a source of credentials */
    }
  }
  return null
}

function unresolvedReferenceText(reference) {
  return [
    `DevSpec: [devspec:${reference}] is well formed but resolves to no item in this project,`,
    'so this commit would read as linked and link to nothing.',
    'That is usually a correct short code with a wrong uuid tail, or an item belonging to a different project.',
    'Recover without leaving this turn: confirm the id (get_task, or search_tasks),',
    'correct the reference in the commit message and retry.',
    `Authority: ${CONTRACT_URI}. Nothing else is blocked, and no other command is affected.`,
  ].join(' ')
}

export function handleSessionStart() {
  return {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: `DevSpec implementation contract: ${CONTRACT_URI}`,
    },
  }
}

export function handlePost(input, options = {}) {
  const { env = process.env, now = Date.now(), platform = process.platform } = options
  const rawName = input?.tool_name ?? input?.toolName ?? input?.toolCall?.name
  const rawToolInput = input?.tool_input ?? input?.toolInput ?? input?.toolCall?.args ?? {}
  const tool = bareToolName(rawName)
  const command =
    typeof rawToolInput?.CommandLine === 'string'
      ? rawToolInput.CommandLine
      : typeof rawToolInput?.command === 'string'
        ? rawToolInput.command
        : ''
  const verb =
    devspecToolVerb(rawName, rawToolInput) ??
    (COMMAND_TOOLS.has(tool) ? detectCommandDevspecVerb(command) : null)

  if (EDIT_TOOLS.has(tool)) {
    let scope
    try { scope = scopeFrom(input, env) } catch { return null }
    let marker = null
    try {
      marker = repositoryInScope(input, scope, env, options)
    } catch { return null }
    if (!marker) return null
    const claims = readClaims(scope, { env, now, platform })
    if (claims.length === 0 && !readActiveAutomation(scope, { env, now, platform })) {
      maybeNudge(scope, { env, now, platform })
    }
    return null
  }

  if (verb === CLAIM_AUTOMATION_VERB) {
    let scope
    try { scope = scopeFrom(input, env) } catch { return null }
    const parsedAuto = parseAutomationClaimResponse(input, rawName, rawToolInput, command, {
      env,
      sessionId: scope.sessionId,
    })
    if (!parsedAuto) return null
    try {
      writeActiveAutomation(scope, parsedAuto, { env, now, platform })
      clearPendingNudge(scope.sessionId, { env })
    } catch {
      /* non-fatal */
    }
    return null
  }

  if (verb === RECORD_AUTOMATION_VERB) {
    let scope
    try { scope = scopeFrom(input, env) } catch { return null }
    const recorded = parseAutomationRecordResponse(input, rawName, rawToolInput, command, { env })
    if (!recorded?.ok) return null
    try {
      clearActiveAutomation(scope, recorded.run_id, { env, now, platform })
    } catch {
      /* non-fatal */
    }
    return null
  }

  if (verb !== CLAIM_VERB && verb !== GET_ITEM_VERB && !RELEASE_VERBS.has(verb)) return null
  let scope
  try { scope = scopeFrom(input, env) } catch { return null }

  const { claims: current, details } = readClaimsRecord(scope, { env, now, platform })
  const parsed = parseClaimResponse(input, rawName, rawToolInput, command, {
    env,
    sessionId: scope.sessionId,
    verb,
  })
  const itemId =
    parsed?.id ??
    (RELEASE_VERBS.has(verb) &&
    current.length === 1 &&
    !(typeof input?.error === 'string' && input.error.trim().length > 0)
      ? current[0]
      : null)
  if (!itemId) return null
  try {
    if (verb === CLAIM_VERB) {
      const nextDetails = {
        ...details,
        [itemId]: {
          title: parsed?.title ?? details[itemId]?.title ?? null,
          work_claim_ref: parsed?.work_claim_ref ?? details[itemId]?.work_claim_ref ?? null,
          provenance_ref: parsed?.provenance_ref ?? details[itemId]?.provenance_ref ?? null,
          at: now,
        },
      }
      writeClaims(scope, [...current, itemId], nextDetails, { env, now, platform })
      clearPendingNudge(scope.sessionId, { env })
    } else if (verb === GET_ITEM_VERB) {
      if (current.includes(itemId) && parsed?.title) {
        const nextDetails = {
          ...details,
          [itemId]: {
            ...details[itemId],
            title: parsed.title,
          },
        }
        writeClaims(scope, current, nextDetails, { env, now, platform })
      }
    } else {
      const nextDetails = { ...details }
      delete nextDetails[itemId]
      writeClaims(scope, current.filter((id) => id !== itemId), nextDetails, { env, now, platform })
    }
  } catch {
    // State is an optimisation for stamping only.
  }
  return null
}

function collectResponseTexts(response) {
  const texts = []
  const collect = (value) => {
    if (typeof value === 'string') { texts.push(value); return }
    if (Array.isArray(value)) { value.forEach(collect); return }
    if (value && typeof value === 'object') {
      if (typeof value.text === 'string') texts.push(value.text)
      if (typeof value.stdout === 'string') texts.push(value.stdout)
      if (typeof value.output === 'string') texts.push(value.output)
      for (const nested of Object.values(value)) if (nested && typeof nested === 'object') collect(nested)
    }
  }
  collect(response)
  return texts
}

// The local lookups below (claim titles, automation names, a step's work_claim_ref)
// run inside every hook call, under Antigravity's per-hook timeout (hooks.json), and
// read host files that grow without limit: spilled step outputs, logs, the inbox.
// So each looks only at the recent part: the newest step outputs, the tail of a log.
// They are best-effort hints — a miss falls back to what the server says — and they
// never shorten anything shown to the model or posted to the room.
const MAX_LOCAL_OUTPUT_BYTES = 512 * 1024
const RECENT_STEP_OUTPUTS_SCANNED = 50

function readSmallTextFile(filePath, maxBytes = MAX_LOCAL_OUTPUT_BYTES) {
  if (typeof filePath !== 'string' || !filePath) return null
  try {
    const stat = fs.statSync(filePath)
    if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) return null
    return fs.readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
}

function readTailLines(filePath, maxBytes = 128 * 1024) {
  if (typeof filePath !== 'string' || !filePath) return []
  let fd
  try {
    const stat = fs.statSync(filePath)
    if (!stat.isFile() || stat.size <= 0) return []
    const readSize = Math.min(stat.size, maxBytes)
    const offset = stat.size - readSize
    fd = fs.openSync(filePath, 'r')
    const buf = Buffer.alloc(readSize)
    fs.readSync(fd, buf, 0, readSize, offset)
    const text = buf.toString('utf8')
    const lines = text.split(/\r?\n/).filter(Boolean)
    return offset > 0 ? lines.slice(1) : lines
  } catch {
    return []
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd) } catch { /* ignore */ }
    }
  }
}

function resolveBrainDir(input, { conversationId = null, home = null, env = process.env } = {}) {
  if (typeof input?.artifactDirectoryPath === 'string' && input.artifactDirectoryPath.trim()) {
    return input.artifactDirectoryPath.trim()
  }
  if (typeof input?.transcriptPath === 'string' && input.transcriptPath.includes('.system_generated')) {
    const base = input.transcriptPath.split('.system_generated')[0].replace(/[\\/]+$/, '')
    if (base) return base
  }
  const cid = conversationId || resolveProvenanceSessionId(input, env)
  const effectiveHome = home || env.USERPROFILE || env.HOME || os.homedir()
  if (cid && validSessionId(cid) && effectiveHome) {
    return path.join(effectiveHome, '.gemini', 'antigravity-cli', 'brain', cid)
  }
  return null
}

function collectAntigravityStepTexts(input, { env = process.env, sessionId = null } = {}) {
  const texts = []
  if (!input || typeof input !== 'object') return texts
  const home = env.USERPROFILE || env.HOME || os.homedir()
  const conversationId = sessionId || resolveProvenanceSessionId(input, env)
  const brainDir = resolveBrainDir(input, { conversationId, home, env })
  const rawStep = input.stepIdx ?? input.step_index
  const stepNum = rawStep !== undefined && rawStep !== null && rawStep !== '' ? Number(rawStep) : NaN

  if (brainDir && Number.isInteger(stepNum) && stepNum >= 0) {
    for (const candidateStep of [stepNum, stepNum + 1]) {
      const stepOut = path.join(brainDir, '.system_generated', 'steps', String(candidateStep), 'output.txt')
      const content = readSmallTextFile(stepOut)
      if (content) texts.push(content)
    }
  }

  const transcriptCandidates = []
  if (brainDir) {
    transcriptCandidates.push(
      path.join(brainDir, '.system_generated', 'logs', 'transcript_full.jsonl'),
      path.join(brainDir, '.system_generated', 'logs', 'transcript.jsonl'),
    )
  }
  if (typeof input.transcriptPath === 'string' && input.transcriptPath.trim()) {
    const tp = input.transcriptPath.trim()
    if (!transcriptCandidates.includes(tp)) transcriptCandidates.push(tp)
  }

  for (const tp of transcriptCandidates) {
    const lines = readTailLines(tp, 64 * 1024)
    if (lines.length === 0) continue
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 6); i--) {
      try {
        const entry = JSON.parse(lines[i])
        if (entry?.type !== 'GENERIC' || typeof entry.content !== 'string') continue
        if (
          Number.isInteger(stepNum) &&
          typeof entry.step_index === 'number' &&
          entry.step_index !== stepNum &&
          entry.step_index !== stepNum + 1
        ) {
          continue
        }
        texts.push(entry.content)
      } catch {
        /* ignore malformed line */
      }
    }
    if (texts.length > 0) break
  }

  return texts
}

function parseJsonCandidates(texts) {
  const objects = []
  const pushParsed = (parsed) => {
    const values = Array.isArray(parsed) ? parsed : [parsed]
    for (const v of values) if (v && typeof v === 'object') objects.push(v)
  }

  for (const rawText of texts) {
    const text = String(rawText ?? '')
    if (!text.trim()) continue
    try {
      pushParsed(JSON.parse(text))
      continue
    } catch {
      /* try spilled file URI, header-stripped multi-line JSON, or line-by-line JSON */
    }

    const fileUriMatch = /file:\/\/(\/[^\s"'<>]+\.txt)/i.exec(text)
    if (fileUriMatch) {
      const spilledPath = decodeURIComponent(fileUriMatch[1])
      const spilledContent = readSmallTextFile(spilledPath)
      if (spilledContent) {
        try {
          pushParsed(JSON.parse(spilledContent))
          continue
        } catch {
          /* continue to other fallbacks */
        }
      }
    }

    const blockMatch = /(?:^|\r?\n)\s*(\{[\s\S]*\}|\[[\s\S]*\])\s*$/.exec(text)
    if (blockMatch) {
      try {
        pushParsed(JSON.parse(blockMatch[1]))
        continue
      } catch {
        /* fall through to line-by-line scan */
      }
    }

    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed) continue
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          pushParsed(JSON.parse(trimmed))
          continue
        } catch {
          /* ignore non-JSON line */
        }
      }
      const braceIdx = trimmed.indexOf('{')
      if (braceIdx > 0 && trimmed.endsWith('}')) {
        try {
          pushParsed(JSON.parse(trimmed.slice(braceIdx)))
        } catch {
          /* ignore */
        }
      }
    }
  }
  return objects
}

function extractItemTitle(value) {
  if (!value || typeof value !== 'object') return null
  const candidates = [
    value.title,
    value.item?.title,
    value.task?.title,
    value.details?.title,
    value.details?.item?.title,
  ]
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim()
  }
  return null
}

function extractItemFieldsFromText(text, itemId) {
  if (typeof text !== 'string' || !text || !itemId) return null
  const esc = itemId.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')
  const r1 = new RegExp(
    `"(?:task_)?id"\\s*:\\s*"${esc}"[\\s\\S]{0,600}?"title"\\s*:\\s*"((?:[^"\\\\]|\\\\.)+)"`,
    'i',
  )
  const r2 = new RegExp(
    `"title"\\s*:\\s*"((?:[^"\\\\]|\\\\.)+)"[\\s\\S]{0,600}?"(?:task_)?id"\\s*:\\s*"${esc}"`,
    'i',
  )
  const m = r1.exec(text) || r2.exec(text)
  if (!m) return null
  let title = m[1]
  try {
    title = JSON.parse(`"${m[1]}"`)
  } catch {
    /* keep raw match */
  }
  if (typeof title !== 'string' || !title.trim()) return null
  const refMatch = /"work_claim_ref"\s*:\s*"([0-9a-f-]{36})"/i.exec(text)
  return {
    id: itemId.toLowerCase(),
    title: title.trim(),
    work_claim_ref: refMatch ? refMatch[1] : null,
  }
}

function matchItemFromCandidateObject(value, targetId) {
  if (!value || typeof value !== 'object') return null
  const candidates = [value]
  for (const listKey of ['items', 'tasks', 'results']) {
    if (Array.isArray(value[listKey])) {
      for (const el of value[listKey]) if (el && typeof el === 'object') candidates.push(el)
    }
  }
  if (Array.isArray(value.session_activity?.items)) {
    for (const el of value.session_activity.items) {
      if (el && typeof el === 'object') candidates.push(el)
    }
  }
  for (const obj of candidates) {
    const rawId =
      typeof obj.id === 'string'
        ? obj.id
        : typeof obj.task_id === 'string'
          ? obj.task_id
          : typeof obj.item?.id === 'string'
            ? obj.item.id
            : null
    if (!rawId || rawId.toLowerCase() !== targetId) continue
    const title = extractItemTitle(obj)
    if (title) {
      return {
        id: targetId,
        title,
        work_claim_ref: typeof obj.work_claim_ref === 'string' ? obj.work_claim_ref : null,
      }
    }
  }
  return null
}

function resolveConnectionIdsForSession(conversationId, explicitConnectionId, home) {
  const ids = []
  if (typeof explicitConnectionId === 'string' && UUID_RE.test(explicitConnectionId)) {
    ids.push(explicitConnectionId)
  }
  if (conversationId && validSessionId(conversationId) && home) {
    const bondFile = path.join(home, '.devspec', 'remote-control', 'local', 'antigravity', `${conversationId}.json`)
    const bondText = readSmallTextFile(bondFile, 64 * 1024)
    if (bondText) {
      try {
        const bond = JSON.parse(bondText)
        if (typeof bond?.connection_id === 'string' && UUID_RE.test(bond.connection_id) && !ids.includes(bond.connection_id)) {
          ids.push(bond.connection_id)
        }
      } catch {
        /* ignore */
      }
    }
  }
  return ids
}

export function resolveLocalItemDetails(
  itemId,
  { conversationId = null, connectionId = null, home = null, brainDir = null, env = process.env } = {},
) {
  if (typeof itemId !== 'string' || !UUID_RE.test(itemId)) return null
  const targetId = itemId.toLowerCase()
  const effectiveHome = home || env.USERPROFILE || env.HOME || os.homedir()
  const effectiveBrainDir =
    brainDir ||
    (conversationId && validSessionId(conversationId) && effectiveHome
      ? path.join(effectiveHome, '.gemini', 'antigravity-cli', 'brain', conversationId)
      : null)

  // 1. Check Antigravity spilled step outputs (<brain>/<cid>/.system_generated/steps/*/output.txt),
  // which contain both `title` and `work_claim_ref` from claim_work_item / get_task.
  if (effectiveBrainDir) {
    const stepsDir = path.join(effectiveBrainDir, '.system_generated', 'steps')
    try {
      if (fs.existsSync(stepsDir)) {
        const stepDirs = fs
          .readdirSync(stepsDir)
          .filter((d) => /^\d+$/.test(d))
          .sort((a, b) => Number(b) - Number(a))
          .slice(0, RECENT_STEP_OUTPUTS_SCANNED)
        for (const stepName of stepDirs) {
          const outFile = path.join(stepsDir, stepName, 'output.txt')
          const txt = readSmallTextFile(outFile)
          if (!txt || !txt.toLowerCase().includes(targetId)) continue
          for (const obj of parseJsonCandidates([txt])) {
            const matched = matchItemFromCandidateObject(obj, targetId)
            if (matched?.title) return matched
          }
          const regexMatched = extractItemFieldsFromText(txt, targetId)
          if (regexMatched?.title) return regexMatched
        }
      }
    } catch {
      /* ignore */
    }
  }

  // 2. Check cached .room.json files (fast, tiny, already materialized by poller).
  if (effectiveHome) {
    const connDir = path.join(effectiveHome, '.devspec', 'remote-control', 'connections')
    const connIds = resolveConnectionIdsForSession(conversationId, connectionId, effectiveHome)
    const roomFiles = connIds.map((cid) => path.join(connDir, `${cid}.room.json`))
    try {
      if (roomFiles.length === 0 && fs.existsSync(connDir)) {
        for (const f of fs.readdirSync(connDir)) {
          if (f.endsWith('.room.json')) roomFiles.push(path.join(connDir, f))
        }
      }
    } catch {
      /* ignore */
    }
    for (const rf of roomFiles) {
      const txt = readSmallTextFile(rf)
      if (!txt || !txt.toLowerCase().includes(targetId)) continue
      try {
        const room = JSON.parse(txt)
        const matched = matchItemFromCandidateObject(room, targetId)
        if (matched?.title) return matched
      } catch {
        /* ignore */
      }
    }
  }

  // 3. Check Antigravity conversation transcript logs (transcript_full.jsonl / transcript.jsonl).
  if (effectiveBrainDir) {
    for (const logName of ['transcript_full.jsonl', 'transcript.jsonl']) {
      const logPath = path.join(effectiveBrainDir, '.system_generated', 'logs', logName)
      const lines = readTailLines(logPath, 256 * 1024)
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]
        if (!line.toLowerCase().includes(targetId)) continue
        try {
          const entry = JSON.parse(line)
          const content = typeof entry?.content === 'string' ? entry.content : ''
          if (!content) continue
          for (const obj of parseJsonCandidates([content])) {
            const matched = matchItemFromCandidateObject(obj, targetId)
            if (matched?.title) return matched
          }
          const regexMatched = extractItemFieldsFromText(content, targetId)
          if (regexMatched?.title) return regexMatched
        } catch {
          /* ignore */
        }
      }
    }
  }

  return null
}

export function resolveLocalAutomationDetails(
  runId,
  { conversationId = null, connectionId = null, home = null, brainDir = null, env = process.env } = {},
) {
  const targetRunId = typeof runId === 'string' && runId.trim() ? runId.trim().toLowerCase() : null
  const effectiveHome = home || env.USERPROFILE || env.HOME || os.homedir()

  // 1. Check .inbox.jsonl where devspec-remote-poll.mjs records automation_run dispatches with automation_name.
  if (effectiveHome) {
    const connDir = path.join(effectiveHome, '.devspec', 'remote-control', 'connections')
    const connIds = resolveConnectionIdsForSession(conversationId, connectionId, effectiveHome)
    const inboxFiles = connIds.map((cid) => path.join(connDir, `${cid}.inbox.jsonl`))
    try {
      if (fs.existsSync(connDir)) {
        for (const f of fs.readdirSync(connDir)) {
          if (f.endsWith('.inbox.jsonl')) {
            const full = path.join(connDir, f)
            if (!inboxFiles.includes(full)) inboxFiles.push(full)
          }
        }
      }
    } catch {
      /* ignore */
    }
    for (const inboxFile of inboxFiles) {
      const lines = readTailLines(inboxFile, 128 * 1024)
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]
        if (targetRunId && !line.toLowerCase().includes(targetRunId)) continue
        try {
          const entry = JSON.parse(line)
          const dispatch =
            entry?.dispatch && typeof entry.dispatch === 'object' ? entry.dispatch : entry
          const candRunId =
            (typeof dispatch?.run_id === 'string' && dispatch.run_id.trim()) ||
            (typeof dispatch?.id === 'string' && dispatch.id.trim()) ||
            (typeof entry?.run_id === 'string' && entry.run_id.trim()) ||
            null
          if (targetRunId && (!candRunId || candRunId.toLowerCase() !== targetRunId)) continue
          const candName =
            (typeof dispatch?.automation_name === 'string' && dispatch.automation_name.trim()) ||
            (typeof dispatch?.automation?.name === 'string' && dispatch.automation.name.trim()) ||
            (typeof entry?.automation_name === 'string' && entry.automation_name.trim()) ||
            null
          const candAutoId =
            (typeof dispatch?.automation_id === 'string' && dispatch.automation_id.trim()) ||
            (typeof dispatch?.automation?.id === 'string' && dispatch.automation.id.trim()) ||
            (typeof entry?.automation_id === 'string' && entry.automation_id.trim()) ||
            null
          if (candName || candAutoId) {
            return {
              run_id: candRunId || (typeof runId === 'string' ? runId.trim() : null),
              automation_id: candAutoId,
              automation_name: candName,
            }
          }
        } catch {
          /* ignore */
        }
      }
    }
  }

  // 2. Check Antigravity spilled step outputs and transcript logs.
  const effectiveBrainDir =
    brainDir ||
    (conversationId && validSessionId(conversationId) && effectiveHome
      ? path.join(effectiveHome, '.gemini', 'antigravity-cli', 'brain', conversationId)
      : null)

  const extractAutoFromObject = (value) => {
    if (!value || typeof value !== 'object') return null
    const autoObj = value.automation && typeof value.automation === 'object' ? value.automation : null
    const runObj = value.run && typeof value.run === 'object' ? value.run : null
    const candRunId =
      (typeof runObj?.id === 'string' && runObj.id.trim()) ||
      (typeof runObj?.run_id === 'string' && runObj.run_id.trim()) ||
      (typeof value.run_id === 'string' && value.run_id.trim()) ||
      null
    if (targetRunId && candRunId && candRunId.toLowerCase() !== targetRunId) return null
    const candName =
      (typeof autoObj?.name === 'string' && autoObj.name.trim()) ||
      (typeof value.automation_name === 'string' && value.automation_name.trim()) ||
      (typeof runObj?.automation_name === 'string' && runObj.automation_name.trim()) ||
      null
    const candAutoId =
      (typeof autoObj?.id === 'string' && autoObj.id.trim()) ||
      (typeof value.automation_id === 'string' && value.automation_id.trim()) ||
      (typeof runObj?.automation_id === 'string' && runObj.automation_id.trim()) ||
      null
    if (!candName) return null
    return {
      run_id: candRunId || (typeof runId === 'string' ? runId.trim() : null),
      automation_id: candAutoId,
      automation_name: candName,
    }
  }

  if (effectiveBrainDir) {
    const stepsDir = path.join(effectiveBrainDir, '.system_generated', 'steps')
    try {
      if (fs.existsSync(stepsDir)) {
        const stepDirs = fs
          .readdirSync(stepsDir)
          .filter((d) => /^\d+$/.test(d))
          .sort((a, b) => Number(b) - Number(a))
          .slice(0, RECENT_STEP_OUTPUTS_SCANNED)
        for (const stepName of stepDirs) {
          const outFile = path.join(stepsDir, stepName, 'output.txt')
          const txt = readSmallTextFile(outFile)
          if (!txt) continue
          if (targetRunId && !txt.toLowerCase().includes(targetRunId)) continue
          for (const obj of parseJsonCandidates([txt])) {
            const matched = extractAutoFromObject(obj)
            if (matched?.automation_name) return matched
          }
        }
      }
    } catch {
      /* ignore */
    }

    for (const logName of ['transcript_full.jsonl', 'transcript.jsonl']) {
      const logPath = path.join(effectiveBrainDir, '.system_generated', 'logs', logName)
      const lines = readTailLines(logPath, 256 * 1024)
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]
        if (targetRunId && !line.toLowerCase().includes(targetRunId)) continue
        try {
          const entry = JSON.parse(line)
          const content = typeof entry?.content === 'string' ? entry.content : ''
          if (!content) continue
          for (const obj of parseJsonCandidates([content])) {
            const matched = extractAutoFromObject(obj)
            if (matched?.automation_name) return matched
          }
        } catch {
          /* ignore */
        }
      }
    }
  }

  return null
}

function parseClaimResponse(
  input,
  rawName = input?.tool_name ?? input?.toolName ?? input?.toolCall?.name,
  rawToolInput = input?.tool_input ?? input?.toolInput ?? input?.toolCall?.args ?? {},
  command = '',
  { env = process.env, sessionId = null, verb = null } = {},
) {
  if (typeof input?.error === 'string' && input.error.trim().length > 0) return null
  const response = input?.tool_response ?? input?.toolResponse ?? input?.result
  const toolInput = unwrapDevspecArgs(rawName, rawToolInput)
  const texts = collectResponseTexts(response)
  if (texts.length === 0) {
    texts.push(...collectAntigravityStepTexts(input, { env, sessionId }))
  }
  let requested = toolInput.task_id
  if (!requested && command) {
    const m = new RegExp(`task_id[\\\\'"\\s:]+(${UUID})`, 'i').exec(command)
    if (m) requested = m[1]
  }
  const requestedProvenanceRef = typeof toolInput.provenance_ref === 'string' ? toolInput.provenance_ref : null
  const requestedWorkClaimRef = typeof toolInput.work_claim_ref === 'string' ? toolInput.work_claim_ref : null
  const conversationId = sessionId || resolveProvenanceSessionId(input, env)
  const brainDir = resolveBrainDir(input, { conversationId, env })

  for (const value of parseJsonCandidates(texts)) {
    if (value.error || value.success === false || value.ok === false || value.claim_success === false) {
      continue
    }
    const rawId =
      typeof value.id === 'string'
        ? value.id
        : typeof value.task_id === 'string'
          ? value.task_id
          : typeof value.item?.id === 'string'
            ? value.item.id
            : null
    if (rawId && UUID_RE.test(rawId)) {
      const id = rawId.toLowerCase()
      let title = extractItemTitle(value)
      let workClaimRef = typeof value.work_claim_ref === 'string' ? value.work_claim_ref : requestedWorkClaimRef
      if (!title && (verb === CLAIM_VERB || verb === GET_ITEM_VERB || !verb)) {
        const local = resolveLocalItemDetails(id, { conversationId, brainDir, env })
        if (local?.title) title = local.title
        if (!workClaimRef && local?.work_claim_ref) workClaimRef = local.work_claim_ref
      }
      return {
        id,
        title,
        work_claim_ref: workClaimRef,
        provenance_ref: typeof value.provenance_ref === 'string' ? value.provenance_ref : requestedProvenanceRef,
      }
    }
  }
  if (UUID_RE.test(requested || '') && !texts.some((t) => /"error"|not found|failed/i.test(t))) {
    const id = requested.toLowerCase()
    const local =
      verb === CLAIM_VERB || verb === GET_ITEM_VERB || !verb
        ? resolveLocalItemDetails(id, { conversationId, brainDir, env })
        : null
    return {
      id,
      title: local?.title ?? null,
      work_claim_ref: local?.work_claim_ref ?? requestedWorkClaimRef,
      provenance_ref: requestedProvenanceRef,
    }
  }
  return null
}

function parseAutomationClaimResponse(
  input,
  rawName,
  rawToolInput,
  command = '',
  { env = process.env, sessionId = null } = {},
) {
  if (typeof input?.error === 'string' && input.error.trim().length > 0) return null
  const response = input?.tool_response ?? input?.toolResponse ?? input?.result
  const toolInput = unwrapDevspecArgs(rawName, rawToolInput)
  const texts = collectResponseTexts(response)
  if (texts.length === 0) {
    texts.push(...collectAntigravityStepTexts(input, { env, sessionId }))
  }
  let requestedRunId = typeof toolInput.run_id === 'string' && toolInput.run_id.trim() ? toolInput.run_id.trim() : null
  if (!requestedRunId && command) {
    const m = new RegExp(`run_id[\\\\'"\\s:]+(${UUID}|[A-Za-z0-9_-]+)`, 'i').exec(command)
    if (m) requestedRunId = m[1]
  }
  const conversationId = sessionId || resolveProvenanceSessionId(input, env)
  const brainDir = resolveBrainDir(input, { conversationId, env })

  for (const value of parseJsonCandidates(texts)) {
    if (value.error || value.success === false || value.ok === false || value.claimed === false) {
      continue
    }
    const autoObj = value.automation && typeof value.automation === 'object' ? value.automation : null
    const runObj = value.run && typeof value.run === 'object' ? value.run : null
    let name =
      (typeof autoObj?.name === 'string' && autoObj.name.trim()) ||
      (typeof value.automation_name === 'string' && value.automation_name.trim()) ||
      (typeof runObj?.automation_name === 'string' && runObj.automation_name.trim()) ||
      null
    const runId =
      (typeof runObj?.id === 'string' && runObj.id.trim()) ||
      (typeof runObj?.run_id === 'string' && runObj.run_id.trim()) ||
      (typeof value.run_id === 'string' && value.run_id.trim()) ||
      requestedRunId ||
      null
    let automationId =
      (typeof autoObj?.id === 'string' && autoObj.id.trim()) ||
      (typeof value.automation_id === 'string' && value.automation_id.trim()) ||
      (typeof runObj?.automation_id === 'string' && runObj.automation_id.trim()) ||
      null
    if (value.claimed === true || name || (runId && autoObj)) {
      if (!name && runId) {
        const local = resolveLocalAutomationDetails(runId, { conversationId, brainDir, env })
        if (local?.automation_name) name = local.automation_name
        if (!automationId && local?.automation_id) automationId = local.automation_id
      }
      return {
        run_id: runId,
        automation_id: automationId,
        automation_name: name,
      }
    }
  }

  if (requestedRunId && !texts.some((t) => /"error"|not found|failed/i.test(t))) {
    const local = resolveLocalAutomationDetails(requestedRunId, { conversationId, brainDir, env })
    return {
      run_id: requestedRunId,
      automation_id: local?.automation_id ?? null,
      automation_name: local?.automation_name ?? null,
    }
  }
  return null
}

function parseAutomationRecordResponse(
  input,
  rawName,
  rawToolInput,
  command = '',
  { env = process.env } = {},
) {
  if (typeof input?.error === 'string' && input.error.trim().length > 0) return null
  const response = input?.tool_response ?? input?.toolResponse ?? input?.result
  const toolInput = unwrapDevspecArgs(rawName, rawToolInput)
  const texts = collectResponseTexts(response)
  if (texts.length === 0) {
    texts.push(...collectAntigravityStepTexts(input, { env }))
  }
  let requestedRunId = typeof toolInput.run_id === 'string' ? toolInput.run_id : null
  if (!requestedRunId && command) {
    const m = new RegExp(`run_id[\\\\'"\\s:]+(${UUID}|[A-Za-z0-9_-]+)`, 'i').exec(command)
    if (m) requestedRunId = m[1]
  }
  for (const value of parseJsonCandidates(texts)) {
    if (value.error || value.success === false || value.ok === false) return null
    const runObj = value.run && typeof value.run === 'object' ? value.run : null
    const runId =
      (typeof value.run_id === 'string' && value.run_id.trim()) ||
      (typeof runObj?.id === 'string' && runObj.id.trim()) ||
      (typeof runObj?.run_id === 'string' && runObj.run_id.trim()) ||
      requestedRunId ||
      null
    return { ok: true, run_id: runId }
  }
  if (!texts.some((t) => /"error"|not found|failed/i.test(t))) {
    return { ok: true, run_id: requestedRunId }
  }
  return null
}

/**
 * The repository this hook's command or edit works in, when it is the connected
 * project's: an origin the project tracks, or a pin (commit-scope.mjs, item cdd7f0f3).
 * Without a connection only a pin can say so. Null leaves the command alone.
 *
 * `options.matchRemote: false` is for a command the git stand-in also runs under: the
 * stand-in tags and checks commits in repositories matched by origin, inside git, and
 * this reader then acts only where it always has, a pinned repository, so the command
 * keeps the permission decision it had (devspec-tool-input.mjs).
 */
function repositoryInScope(input, scope, env, options = {}) {
  const home = options.home ?? (env.USERPROFILE || env.HOME || os.homedir())
  const project = connectedProject(input, { env, home })
  return commitScope(scope.cwd, { home, mainWorktree: scope.mainWorktree, project, matchRemote: options.matchRemote !== false })
}

export async function handlePre(input, options = {}) {
  const { env = process.env, now = Date.now(), platform = process.platform } = options
  const tool = bareToolName(input?.tool_name ?? input?.toolName ?? input?.toolCall?.name)
  if (!COMMAND_TOOLS.has(tool) && !EDIT_TOOLS.has(tool)) return null

  let scope
  try { scope = scopeFrom(input, env) } catch { return null }

  let marker = null
  try {
    marker = repositoryInScope(input, scope, env, options)
  } catch { return null }
  if (!marker) return null

  const claims = readClaims(scope, { env, now, platform })

  // Edits are never denied. At most one reminder per session+repository.
  if (EDIT_TOOLS.has(tool)) {
    if (claims.length > 0) return null
    return maybeNudge(scope, { env, now, platform })
  }

  const toolInput = input?.tool_input ?? input?.toolInput ?? input?.toolCall?.args ?? {}
  const command =
    typeof toolInput.command === 'string'
      ? toolInput.command
      : typeof toolInput.CommandLine === 'string'
        ? toolInput.CommandLine
        : ''
  if (!command) return null

  const commit = simpleGitCommit(command) ?? heredocGitCommit(command)
  if (!commit) {
    return null
  }

  const reference = referenceIn(commit.message)
  if (reference) {
    const outcome = await confirmReferenceOnline(commit.message, {
      cwd: scope.cwd,
      mainWorktree: scope.mainWorktree,
      localId: scope.sessionId,
      marker,
      env,
      timeoutMs: options.timeoutMs,
      call: options.call,
    })
    if (outcome === 'not_found') return deny(unresolvedReferenceText(reference))
    return null
  }

  if (claims.length === 1 && commit.appendable) {
    const id = claims[0]
    const updated = `${command.slice(0, commit.insertOffset)} [devspec:${id}]${command.slice(commit.insertOffset)}`
    return stamp(updated, toolInput, id, { decision: marker.kind === 'pin' ? 'allow' : 'ask' })
  }

  return deny(recoveryText(claims))
}

function maybeNudge(scope, { env, now, platform }) {
  const file = statePathFor(scope, 'nudged', env)
  try {
    if (fs.existsSync(file)) return null
    atomicWritePrivate(file, { schema: 1, at: now }, platform)
  } catch {
    return null
  }
  const message =
    'DevSpec: no task is claimed in this repository, so work done here has nothing to trace it to. ' +
    'Before you commit, search_tasks for the task this work belongs to and claim it (claim_work_item); if none covers it, ' +
    "create the smallest adequate one with a real description and reason (the contract's work_entry_contract " +
    'says when) and claim that. Then commit as usual: the [devspec:<id>] tag is added for you. Editing is never blocked. ' +
    `Shown once per session. Authority: ${CONTRACT_URI}`
  stagePendingNudge(scope.sessionId, message, { env, now, platform })
  return nudge(message)
}

function readStdin() {
  return fs.readFileSync(0, 'utf8')
}

function emit(value) {
  if (value !== null && value !== undefined) process.stdout.write(`${JSON.stringify(value)}\n`)
}

async function main() {
  const mode = process.argv[2]
  if (mode === 'session-start') return emit(handleSessionStart())
  let input
  try { input = JSON.parse(readStdin()) } catch {
    return
  }
  if (mode === 'pre') return emit(await handlePre(input))
  if (mode === 'post') return emit(handlePost(input))
  throw new Error('usage: commit-provenance.mjs session-start|pre|post')
}

const isMain = isEntryPoint(import.meta.url)
if (isMain) {
  main().catch((error) => {
    if (process.argv[2] === 'pre' || process.argv[2] === 'post') {
      process.stderr.write(`DevSpec provenance hook failed (allowing): ${error.message}\n`)
      process.exitCode = 0
    } else {
      process.stderr.write(`DevSpec provenance hook failed: ${error.message}\n`)
      process.exitCode = 1
    }
  })
}
