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
import { pathToFileURL } from 'node:url'
import { devspecFolderMarker, gitRemoteOrigin } from './devspec-scope.mjs'
import { mcpToolsCall } from './mcp-call.mjs'
import { resolveHookConversationId } from './mirror-turn.mjs'
import { hostTokenFromEnv, resolveDevspecMcpAuth } from './resolve-mcp-auth.mjs'

export const CONTRACT_URI = 'devspec://product/implementation-contract'
export const CLAIM_MAX_AGE_MS = 24 * 60 * 60 * 1000
export const ONLINE_TIMEOUT_MS = 2_500
const FUTURE_SKEW_MS = 5 * 60 * 1000
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const UUID_RE = new RegExp(`^${UUID}$`, 'i')
const REFERENCE_RE = new RegExp(`\\[devspec:(${UUID})\\]`, 'i')

const CLAIM_VERB = 'claim_work_item'
const RELEASE_VERBS = new Set(['record_implementation', 'fail_work_item', 'release_work_item'])

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

export function devspecToolVerb(toolName) {
  const s = String(toolName || '')
  const match = /^(?:mcp__(?:plugin_devspec_)?devspec__|mcp_devspec_|devspec__)([a-z0-9_]+)$/.exec(s)
  return match ? match[1] : null
}

function bareToolName(toolName) {
  return String(toolName || '').replace(/^default_api:/, '')
}

export function stateDir(env = process.env) {
  if (env.DEVSPEC_ANTIGRAVITY_STATE_DIR) return env.DEVSPEC_ANTIGRAVITY_STATE_DIR
  if (env.DEVSPEC_CLAUDE_STATE_DIR) return env.DEVSPEC_CLAUDE_STATE_DIR
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
  const toolInput = input.tool_input ?? input.toolInput ?? {}
  if (typeof input.cwd === 'string' && input.cwd) return input.cwd
  if (typeof toolInput.Cwd === 'string' && toolInput.Cwd) return toolInput.Cwd
  if (typeof toolInput.cwd === 'string' && toolInput.cwd) return toolInput.cwd
  const targetFile =
    toolInput.TargetFile ??
    toolInput.targetFile ??
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

function readClaimsRecord(scope, { env = process.env, now = Date.now(), platform = process.platform } = {}) {
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

export function readClaimDetails(scope, options = {}) {
  const { claims, details } = readClaimsRecord(scope, options)
  if (claims.length !== 1) return null
  const id = claims[0]
  const entry = details[id] && typeof details[id] === 'object' ? details[id] : {}
  return {
    action_item_id: id,
    work_claim_ref: typeof entry.work_claim_ref === 'string' ? entry.work_claim_ref : null,
    provenance_ref: typeof entry.provenance_ref === 'string' ? entry.provenance_ref : null,
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
        ephemeralMessage: {
          content: message,
        },
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
  if (typeof command !== 'string' || command.length === 0 || command.length > 8192) return null

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
  if (typeof command !== 'string' || command.length === 0 || command.length > 8192) return null
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

function stamp(updatedCommand, toolInput, itemId) {
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

function recoveryText(claims) {
  if (claims.length > 1) {
    return [
      `DevSpec: this commit has no [devspec:<id>] reference and ${claims.length} claims are active, so nothing was added automatically.`,
      `Pick the one this commit belongs to and put it in the message: ${claims.map((id) => `[devspec:${id}]`).join(' or ')}`,
      'Then retry the commit. Nothing else is blocked.',
    ].join(' ')
  }
  return [
    'DevSpec: this commit has no [devspec:<id>] reference, so it would land unlinked.',
    'Recover without leaving this turn: reuse or create the smallest item that covers it',
    '(search_action_items, or create_action_item with a one-line description — a thin',
    'last-mile item is fine), then add [devspec:<full-uuid>] to the commit message and retry.',
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
    'Recover without leaving this turn: confirm the id (get_action_item, or search_action_items),',
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
  const rawName = input?.tool_name ?? input?.toolName
  const verb = devspecToolVerb(rawName)
  const tool = bareToolName(rawName)

  if (EDIT_TOOLS.has(tool)) {
    let scope
    try { scope = scopeFrom(input, env) } catch { return null }
    let marker = null
    try {
      marker = devspecFolderMarker(scope.cwd, {
        home: env.USERPROFILE || env.HOME || os.homedir(),
        mainWorktree: scope.mainWorktree,
      })
    } catch { return null }
    if (!marker) return null
    const claims = readClaims(scope, { env, now, platform })
    if (claims.length === 0) {
      maybeNudge(scope, { env, now, platform })
    }
    return null
  }

  if (verb !== CLAIM_VERB && !RELEASE_VERBS.has(verb)) return null
  let scope
  try { scope = scopeFrom(input, env) } catch { return null }

  const parsed = parseClaimResponse(input)
  if (!parsed?.id) return null
  const itemId = parsed.id
  const { claims: current, details } = readClaimsRecord(scope, { env, now, platform })
  try {
    if (verb === CLAIM_VERB) {
      const nextDetails = {
        ...details,
        [itemId]: {
          work_claim_ref: parsed.work_claim_ref ?? details[itemId]?.work_claim_ref ?? null,
          provenance_ref: parsed.provenance_ref ?? details[itemId]?.provenance_ref ?? null,
          at: now,
        },
      }
      writeClaims(scope, [...current, itemId], nextDetails, { env, now, platform })
      clearPendingNudge(scope.sessionId, { env })
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

function parseClaimResponse(input) {
  const response = input?.tool_response ?? input?.toolResponse
  const toolInput = input?.tool_input ?? input?.toolInput ?? {}
  const texts = []
  const collect = (value) => {
    if (typeof value === 'string') { texts.push(value); return }
    if (Array.isArray(value)) { value.forEach(collect); return }
    if (value && typeof value === 'object') {
      if (typeof value.text === 'string') texts.push(value.text)
      for (const nested of Object.values(value)) if (nested && typeof nested === 'object') collect(nested)
    }
  }
  collect(response)
  const requested = toolInput.action_item_id
  const requestedProvenanceRef = typeof toolInput.provenance_ref === 'string' ? toolInput.provenance_ref : null
  const requestedWorkClaimRef = typeof toolInput.work_claim_ref === 'string' ? toolInput.work_claim_ref : null
  for (const text of texts) {
    let parsed
    try { parsed = JSON.parse(text) } catch { continue }
    const values = Array.isArray(parsed) ? parsed : [parsed]
    for (const value of values) {
      if (!value || typeof value !== 'object') continue
      if (value.error || value.success === false || value.ok === false) continue
      const id = typeof value.id === 'string' ? value.id : null
      if (id && UUID_RE.test(id)) {
        return {
          id: id.toLowerCase(),
          work_claim_ref: typeof value.work_claim_ref === 'string' ? value.work_claim_ref : requestedWorkClaimRef,
          provenance_ref: typeof value.provenance_ref === 'string' ? value.provenance_ref : requestedProvenanceRef,
        }
      }
    }
  }
  if (UUID_RE.test(requested || '') && !texts.some((t) => /"error"|not found|failed/i.test(t))) {
    return {
      id: requested.toLowerCase(),
      work_claim_ref: requestedWorkClaimRef,
      provenance_ref: requestedProvenanceRef,
    }
  }
  return null
}

export async function handlePre(input, options = {}) {
  const { env = process.env, now = Date.now(), platform = process.platform } = options
  const tool = bareToolName(input?.tool_name ?? input?.toolName)
  if (!COMMAND_TOOLS.has(tool) && !EDIT_TOOLS.has(tool)) return null

  let scope
  try { scope = scopeFrom(input, env) } catch { return null }

  let marker = null
  try {
    marker = devspecFolderMarker(scope.cwd, {
      home: env.USERPROFILE || env.HOME || os.homedir(),
      mainWorktree: scope.mainWorktree,
    })
  } catch { return null }
  if (!marker) return null

  const claims = readClaims(scope, { env, now, platform })

  // Edits are never denied. At most one reminder per session+repository.
  if (EDIT_TOOLS.has(tool)) {
    if (claims.length > 0) return null
    return maybeNudge(scope, { env, now, platform })
  }

  const toolInput = input?.tool_input ?? input?.toolInput ?? {}
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
    return stamp(updated, toolInput, id)
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
    'DevSpec: no work item is claimed in this repository, so work done here has nothing to trace it to. ' +
    'Claim one before you commit — search_action_items for an existing item, or create_action_item for a ' +
    'thin last-mile one — and put [devspec:<full-uuid>] in the commit message. Editing is never blocked. ' +
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

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
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
