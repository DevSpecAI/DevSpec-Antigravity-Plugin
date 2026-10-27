/**
 * Puts a stand-in for `git` on the agent's shell PATH, so every commit the agent
 * makes is noted from git itself (item 9e385793, after Pi's item 2c971806).
 *
 * How it reaches the agent's shell. Antigravity's hooks cannot change the
 * environment of the commands it runs (no hook returns environment), but PreToolUse
 * can rewrite a tool call's arguments before it runs (`overwrite`), and each
 * `run_command` runs in a fresh bash (measured with agy 1.4.8: an `export` or `cd` in
 * one command is gone in the next). So PreToolUse puts one line in front of every
 * `run_command` the agent issues:
 *
 *     export PATH='<observer folder>':"$PATH" DEVSPEC_AGY_GIT_GENERATION=… DEVSPEC_AGY_GIT_OBSERVATION=…  # devspec-git-observer v1
 *
 * The agent's own text follows unchanged and is never parsed. Every `git` that
 * command starts, directly, after `cd` or `&&`, with `-C`, in a linked worktree or
 * from a script it runs, finds the stand-in first. The stand-in
 * (`git-observer-shim.mjs`) runs the real git unchanged and journals each commit;
 * PostToolUse and Stop read the journal and report (`commit-reports.mjs`).
 *
 * The stand-in also tags and checks commits in the connected project's repositories
 * (item 31ef3d3c): PreToolUse leaves it a stamp file (`writeStampFile`) with the tasks
 * claimed in the conversation and the project's repositories, and the stand-in adds
 * the tag, or stops an untagged commit, from git's own arguments. See
 * git-observer-shim.mjs.
 *
 * What the line carries: the folder, the real git's path, and two random ids. No
 * connection id, token or other identity reaches the command; those stay in the
 * envelope file this hook writes, which the journal line is matched against.
 *
 * Not covered, and why:
 * - Native Windows. agy runs each command there with PowerShell (`pwsh -Command`, or
 *   `powershell -Command` without PowerShell 7), and a PowerShell line in front would
 *   reach git (measured with agy 1.4.8). But on Windows agy checks the person's
 *   permission rules against the rewritten command and matches a PowerShell command
 *   whole, so any added line stops their allow rules from matching (every command
 *   would ask) and can take the command past their deny rules. The hook cannot see the
 *   grants made during a conversation, so it cannot tell when that would happen. No
 *   prefix is added there; the older `commit-observation.mjs` path applies.
 *   e2e/agy.e2e.test.mjs holds both platforms to this with the real agy.
 * - A git found by absolute path (`/usr/bin/git commit`), or a command that resets PATH
 *   (`env -i`), bypasses the stand-in.
 * - Commits git makes for commands other than `commit` (merge, cherry-pick, revert,
 *   rebase, am) are not reported, as in Pi; a rewritten commit is followed by DevSpec
 *   through the `[devspec:<id>]` tag in its message.
 * - Commits made outside the agent's own commands (a person's terminal, an editor) are
 *   never seen, by design.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveOwnConnectionId } from './launch-guard.mjs'
import { resolveHookConversationId } from './mirror-turn.mjs'
import { ensurePrivateDir, readPrivateJson, writePrivateJson } from './private-state.mjs'
import { readStateFile } from './remote-control-state.mjs'
import { readClaims, recoveryText, scopeFrom } from './commit-provenance.mjs'
import { devspecFolderMarker } from './devspec-scope.mjs'
import { projectRepositoryKeys } from './repository-context.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const FULL_SHA = /^[0-9a-f]{40}$/
const SHIM_SOURCE = fileURLToPath(new URL('./git-observer-shim.mjs', import.meta.url))
const SHIM_MODULE = 'git-observer-shim.mjs'
const SHIM_MARKER = '# DevSpec for Antigravity: git stand-in'
export const PREFIX_MARKER = '# devspec-git-observer v1'

/**
 * How long after a command starts its commits are still credited to it. A command
 * left running in the background (WaitMsBeforeAsync) can commit after its tool call
 * returns; past this, a journal line no longer has an envelope and is not reported.
 */
export const ENVELOPE_TTL_MS = 2 * 60 * 60 * 1000
/** Envelopes kept per connection; the oldest go first. Each is one small file. */
const MAX_ENVELOPES = 200
/** The journal is rotated once fully read past this size, so it never grows unbounded. */
const JOURNAL_ROTATE_BYTES = 1024 * 1024
/** Observations remembered as already read, so a re-read never reports twice. */
const MAX_DRAINED_KEYS = 500

export function observerRoot(home = os.homedir()) {
  return path.join(home, '.devspec', 'remote-control', 'git-observer')
}

/**
 * The connection's observer folder. Its name is a salted hash of the connection id,
 * not the id itself: the folder's path is on the agent's PATH, and no connection
 * identity reaches the agent's commands. The salt is a private file made once.
 */
export function generationDir(connectionId, home = os.homedir()) {
  const root = observerRoot(home)
  const saltFile = path.join(root, '.salt')
  let salt = null
  try {
    salt = fs.readFileSync(saltFile, 'utf8').trim()
  } catch {
    try {
      ensurePrivateDir(root, privateRoot(home))
      fs.writeFileSync(saltFile, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' })
    } catch {
      /* another hook made it first */
    }
    salt = fs.readFileSync(saltFile, 'utf8').trim()
  }
  return path.join(root, createHash('sha256').update(`${salt}:${connectionId}`).digest('hex').slice(0, 32))
}

function privateRoot(home) {
  return { root: path.join(home, '.devspec') }
}

const shellQuote = (value) => `'${String(value).replaceAll("'", `'"'"'`)}'`

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK)
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

function isStandIn(file, home) {
  try {
    const real = fs.realpathSync(file)
    const root = fs.existsSync(observerRoot(home)) ? fs.realpathSync(observerRoot(home)) : observerRoot(home)
    if (real.startsWith(`${root}${path.sep}`)) return true
    const head = Buffer.alloc(256)
    const fd = fs.openSync(real, 'r')
    try {
      fs.readSync(fd, head, 0, head.length, 0)
    } finally {
      fs.closeSync(fd)
    }
    return head.toString('utf8').includes(SHIM_MARKER)
  } catch {
    return false
  }
}

/** The first `git` on PATH that is not one of these stand-ins, or null. */
export function findRealGit(env = process.env, home = os.homedir()) {
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, 'git')
    if (isExecutable(candidate) && !isStandIn(candidate, home)) {
      try {
        return fs.realpathSync(candidate)
      } catch {
        /* next */
      }
    }
  }
  return null
}

function writeIfChanged(file, text, mode) {
  try {
    if (fs.readFileSync(file, 'utf8') === text) return
  } catch {
    /* absent: write it */
  }
  const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`
  fs.writeFileSync(tmp, text, { mode })
  fs.chmodSync(tmp, mode)
  fs.renameSync(tmp, file)
}

function shimScript({ dir, node, realGit }) {
  const module = path.join(dir, SHIM_MODULE)
  return [
    '#!/bin/sh',
    `${SHIM_MARKER}. It runs the real git unchanged and notes each commit it makes;`,
    "# it is on PATH only for the agent's own shell commands and installs nothing anywhere.",
    `real=${shellQuote(realGit)}`,
    `node=${shellQuote(node)}`,
    `module=${shellQuote(module)}`,
    'if [ -x "$real" ]; then',
    '  if [ -x "$node" ] && [ -f "$module" ]; then exec "$node" "$module" "$real" "$@"; fi',
    '  exec "$real" "$@"',
    'fi',
    '# The real git moved: leave this folder out of PATH and let the shell find git.',
    `PATH=$(printf '%s' "$PATH" | tr ':' '\\n' | grep -vxF ${shellQuote(dir)} | paste -sd: -)`,
    'export PATH',
    'exec git "$@"',
    '',
  ].join('\n')
}

/**
 * Create or refresh the connection's observer folder: the `git` stand-in, its module
 * (copied, so a plugin update or move mid-session never breaks git), and the
 * generation record. Returns `{ dir, id, realGit }` or null when it cannot be set up.
 */
export function ensureGeneration(connectionId, { home = os.homedir(), env = process.env, node = process.execPath } = {}) {
  if (!UUID.test(connectionId ?? '')) return null
  try {
    const dir = generationDir(connectionId, home)
    ensurePrivateDir(dir, privateRoot(home))
    const recordFile = path.join(dir, 'generation.json')
    let record = readPrivateJson(recordFile)
    let realGit = typeof record?.real_git === 'string' && isExecutable(record.real_git) && !isStandIn(record.real_git, home)
      ? record.real_git
      : findRealGit(env, home)
    if (!realGit) return null
    if (!record || !UUID.test(record.id ?? '') || record.real_git !== realGit || record.node !== node || record.connection_id !== connectionId) {
      record = { v: 1, id: UUID.test(record?.id ?? '') ? record.id : randomUUID(), connection_id: connectionId, real_git: realGit, node, updated_at: new Date().toISOString() }
      writePrivateJson(recordFile, record, privateRoot(home))
    }
    writeIfChanged(path.join(dir, SHIM_MODULE), fs.readFileSync(SHIM_SOURCE, 'utf8'), 0o600)
    writeIfChanged(path.join(dir, 'git'), shimScript({ dir, node, realGit }), 0o700)
    return { dir, id: record.id, realGit }
  } catch {
    return null
  }
}

/**
 * The line put in front of the agent's command. The folder goes first on PATH once:
 * a shell that keeps its environment between commands does not collect a copy per
 * command (`${PATH#…}` drops one already at the front; bash, dash and zsh agree).
 */
export function observerPrefix({ dir, id }, observationId) {
  const quoted = shellQuote(dir)
  const rest = dir.includes("'") ? '"$PATH"' : `"\${PATH#${quoted}:}"`
  return (
    `export PATH=${quoted}:${rest} DEVSPEC_AGY_GIT_GENERATION=${id} ` +
    `DEVSPEC_AGY_GIT_OBSERVATION=${observationId}  ${PREFIX_MARKER}\n`
  )
}

/** The agent's own command without the observer line, and whether it had one. */
export function stripObserverPrefix(command) {
  if (typeof command !== 'string') return { command, observed: false }
  const newline = command.indexOf('\n')
  if (newline < 0) return { command, observed: false }
  const first = command.slice(0, newline)
  if (!first.startsWith('export PATH=') || !first.endsWith(PREFIX_MARKER)) return { command, observed: false }
  return { command: command.slice(newline + 1), observed: true }
}

/**
 * A PostToolUse payload with the observer line taken back off the command, so every
 * other handler reads the command the agent wrote. `{ payload, observed }`.
 */
export function withoutObserverPrefix(payload) {
  for (const key of ['tool_input', 'toolInput']) {
    const args = payload?.[key]
    if (args && typeof args.CommandLine === 'string') {
      const stripped = stripObserverPrefix(args.CommandLine)
      if (stripped.observed) return { payload: { ...payload, [key]: { ...args, CommandLine: stripped.command } }, observed: true }
    }
  }
  const args = payload?.toolCall?.args
  if (args && typeof args.CommandLine === 'string') {
    const stripped = stripObserverPrefix(args.CommandLine)
    if (stripped.observed) {
      return { payload: { ...payload, toolCall: { ...payload.toolCall, args: { ...args, CommandLine: stripped.command } } }, observed: true }
    }
  }
  return { payload, observed: false }
}

function toolName(input) {
  return String(input?.tool_name ?? input?.toolName ?? input?.toolCall?.name ?? '').replace(/^default_api:/, '')
}

function toolArgs(input) {
  const args = input?.tool_input ?? input?.toolInput ?? input?.toolCall?.args
  return args && typeof args === 'object' && !Array.isArray(args) ? args : null
}

/** The live connection this hook's conversation is bound to, or null. */
export function boundConnectionFor(input, { env = process.env, home = os.homedir() } = {}) {
  const conversationId = resolveHookConversationId(input, env)
  const connectionId = resolveOwnConnectionId(conversationId, { home })
  if (!connectionId) return null
  const state = readStateFile(connectionId, path.join(home, '.devspec', 'remote-control', 'connections'))
  if (!state || state.enabled === false || state.connection_id !== connectionId) return null
  return { connectionId, conversationId, state }
}

function pruneEnvelopes(dir, now) {
  try {
    const files = fs.readdirSync(dir).filter((name) => name.endsWith('.json'))
    if (files.length <= MAX_ENVELOPES / 2) return
    const aged = files
      .map((name) => {
        const file = path.join(dir, name)
        try {
          return { file, at: fs.statSync(file).mtimeMs }
        } catch {
          return null
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.at - a.at)
    aged.forEach((entry, index) => {
      if (index >= MAX_ENVELOPES || now - entry.at > ENVELOPE_TTL_MS) fs.rmSync(entry.file, { force: true })
    })
  } catch {
    /* pruning is housekeeping */
  }
}

/**
 * What the stand-in needs to tag or stop a commit in this command (item 31ef3d3c),
 * written beside the envelope as `stamps/<observation>.json`: the tasks claimed in
 * this conversation, the project's repositories as remote identities, the project id
 * (for a pin), the repository the conversation's folder marks for DevSpec (as before),
 * and the two recovery texts. No connection id, key or other credential goes in it.
 * When the claims cannot be read, nothing is written and the stand-in only observes.
 */
function writeStampFile(input, bound, dir, observationId, { env, home, now }) {
  try {
    const scope = scopeFrom(input, env)
    const claims = readClaims(scope, { env, now })
    let marked = []
    try {
      if (devspecFolderMarker(scope.cwd, { home: env.USERPROFILE || env.HOME || home, mainWorktree: scope.mainWorktree })) {
        marked = [scope.repoRoot]
      }
    } catch {
      marked = []
    }
    const stamps = path.join(dir, 'stamps')
    ensurePrivateDir(stamps, privateRoot(home))
    writePrivateJson(
      path.join(stamps, `${observationId}.json`),
      {
        v: 1,
        claims,
        project_id: typeof bound.state.project_id === 'string' ? bound.state.project_id : null,
        repositories: projectRepositoryKeys(bound.connectionId, { dir: path.join(home, '.devspec', 'remote-control', 'connections') }),
        marked_repos: marked,
        messages: { unclaimed: recoveryText([]), several: claims.length > 1 ? recoveryText(claims) : null },
        created_at: now,
      },
      privateRoot(home),
    )
    pruneEnvelopes(stamps, now)
  } catch {
    /* no stamp file: the stand-in observes and leaves the message alone */
  }
}

/**
 * PreToolUse for `run_command`: the command with the observer line in front, or null
 * when the stand-in does not apply (another tool, Windows, no bound connection, or the
 * folder could not be set up). Writes the envelope the journal is matched against.
 */
export function prepareGitObservation(input, { env = process.env, home = os.homedir(), platform = process.platform, now = Date.now(), args = null } = {}) {
  try {
    if (platform === 'win32' || toolName(input) !== 'run_command') return null
    const toolInput = args ?? toolArgs(input)
    const command = toolInput?.CommandLine
    if (typeof command !== 'string' || !command.trim() || stripObserverPrefix(command).observed) return null
    const bound = boundConnectionFor(input, { env, home })
    if (!bound) return null
    const generation = ensureGeneration(bound.connectionId, { home, env })
    if (!generation) return null
    const observationId = randomUUID()
    const envelopes = path.join(generation.dir, 'envelopes')
    ensurePrivateDir(envelopes, privateRoot(home))
    writePrivateJson(
      path.join(envelopes, `${observationId}.json`),
      {
        v: 1,
        observation: observationId,
        generation: generation.id,
        connection_id: bound.connectionId,
        conversation_id: bound.conversationId ?? null,
        created_at: now,
      },
      privateRoot(home),
    )
    pruneEnvelopes(envelopes, now)
    writeStampFile(input, bound, generation.dir, observationId, { env, home, now })
    return { command: `${observerPrefix(generation, observationId)}${command}`, observationId, connectionId: bound.connectionId }
  } catch {
    return null
  }
}

/** Take a short-lived lock file; returns a release function, or null when held. */
export function takeLock(file, { staleMs = 120_000, now = Date.now() } = {}) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600)
      fs.writeSync(fd, String(process.pid))
      fs.closeSync(fd)
      return () => {
        try { fs.rmSync(file, { force: true }) } catch { /* gone */ }
      }
    } catch {
      try {
        if (now - fs.statSync(file).mtimeMs > staleMs) fs.rmSync(file, { force: true })
        else return null
      } catch {
        return null
      }
    }
  }
  return null
}

function validLine(row) {
  return Boolean(
    row && row.v === 1 && UUID.test(row.generation ?? '') && UUID.test(row.observation ?? '') &&
      typeof row.sha === 'string' && FULL_SHA.test(row.sha) &&
      (row.branch === null || (typeof row.branch === 'string' && row.branch.length <= 255)) &&
      typeof row.worktree === 'string' && path.isAbsolute(row.worktree) &&
      (row.previous_head === null || (typeof row.previous_head === 'string' && FULL_SHA.test(row.previous_head))) &&
      typeof row.amend === 'boolean',
  )
}

/**
 * Read what the stand-in journalled since the last read, for this connection. Each
 * commit comes back once: only lines whose envelope this plugin wrote for this
 * connection and generation, not expired, and not read before. Returns a list of
 * `{ sha, branch, worktree, previousHead, amend, observationId, connectionId, observedAt }`.
 */
export function drainObservations(connectionId, { home = os.homedir(), now = Date.now() } = {}) {
  if (!UUID.test(connectionId ?? '')) return []
  let dir
  try {
    if (!fs.existsSync(path.join(observerRoot(home), '.salt'))) return []
    dir = generationDir(connectionId, home)
  } catch {
    return []
  }
  const journal = path.join(dir, 'observations.jsonl')
  try {
    if (!fs.existsSync(journal)) return []
  } catch {
    return []
  }
  const release = takeLock(path.join(dir, 'drain.lock'), { now })
  if (!release) return []
  try {
    const record = readPrivateJson(path.join(dir, 'generation.json'))
    const stateFile = path.join(dir, 'drained.json')
    const state = readPrivateJson(stateFile) ?? {}
    let offset = Number.isInteger(state.offset) && state.offset >= 0 ? state.offset : 0
    const seen = new Set(Array.isArray(state.keys) ? state.keys : [])
    const data = fs.readFileSync(journal)
    if (offset > data.length) offset = 0
    const tail = data.subarray(offset).toString('utf8')
    const end = tail.lastIndexOf('\n')
    if (end < 0) return []
    const observed = []
    for (const line of tail.slice(0, end).split('\n')) {
      let row
      try {
        row = JSON.parse(line)
      } catch {
        continue
      }
      if (!validLine(row) || row.generation !== record?.id) continue
      const key = `${row.observation}:${row.sha}`
      if (seen.has(key)) continue
      const envelope = readPrivateJson(path.join(dir, 'envelopes', `${row.observation}.json`))
      if (
        !envelope || envelope.connection_id !== connectionId || envelope.generation !== row.generation ||
        !Number.isFinite(envelope.created_at) || now - envelope.created_at > ENVELOPE_TTL_MS
      ) {
        continue
      }
      seen.add(key)
      observed.push({
        sha: row.sha,
        branch: row.branch,
        worktree: row.worktree,
        previousHead: row.previous_head,
        amend: row.amend,
        observationId: row.observation,
        connectionId,
        observedAt: typeof row.observed_at === 'string' ? row.observed_at : new Date(now).toISOString(),
      })
    }
    offset += Buffer.byteLength(tail.slice(0, end + 1))
    if (offset === data.length && data.length > JOURNAL_ROTATE_BYTES) {
      fs.renameSync(journal, `${journal}.1`)
      offset = 0
    }
    writePrivateJson(stateFile, { offset, keys: [...seen].slice(-MAX_DRAINED_KEYS) }, privateRoot(home))
    return observed
  } catch {
    return []
  } finally {
    release()
  }
}

/**
 * Remove observer folders nobody can use any more: for a connection whose state is
 * gone or ended, untouched for a day. A command that still has such a folder on its
 * PATH simply finds the real git next.
 */
export function pruneObserverFolders({ home = os.homedir(), now = Date.now() } = {}) {
  const root = observerRoot(home)
  let names = []
  try {
    names = fs.readdirSync(root)
  } catch {
    return 0
  }
  let removed = 0
  for (const name of names) {
    if (!/^[0-9a-f]{32}$/.test(name)) continue
    const dir = path.join(root, name)
    try {
      const connectionId = readPrivateJson(path.join(dir, 'generation.json'))?.connection_id
      const state = UUID.test(connectionId ?? '') ? readStateFile(connectionId, path.join(home, '.devspec', 'remote-control', 'connections')) : null
      const idle = now - fs.statSync(dir).mtimeMs > 24 * 60 * 60 * 1000
      if (idle && (!state || state.enabled === false)) {
        fs.rmSync(dir, { recursive: true, force: true })
        removed += 1
      }
    } catch {
      /* next */
    }
  }
  return removed
}
