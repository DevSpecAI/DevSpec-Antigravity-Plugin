#!/usr/bin/env node
/**
 * Best-effort direct-commit observations, never a Git gate (P4 / 3d1f5f9d).
 * Snapshots git state before `run_command` / `Bash` direct commit invocations and
 * reports newly created commit SHAs via `report_commit_provenance` along with
 * active `action_item_id` and `provenance_ref` context when available.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { mcpToolsCall } from './mcp-call.mjs'
import {
  canonicalRepo,
  heredocGitCommit,
  readClaimDetails,
  referenceIn,
  resolveProvenanceCwd,
  resolveProvenanceSessionId,
  simpleGitCommit,
  stateDir,
} from './commit-provenance.mjs'
import { devspecFolderMarker, findProjectPin, gitRemoteOrigin, mainWorkTreeFrom } from './devspec-scope.mjs'
import { readPrivateJson, writePrivateJson } from './private-state.mjs'
import { readRequestState } from './requests.mjs'

const CONNECTIONS_DIR = path.join(os.homedir(), '.devspec', 'remote-control', 'connections')
const REPORT_TIMEOUT_MS = 2_500
const OBSERVATION_TTL_MS = 10 * 60_000
const MAX_PENDING = 100
const FULL_SHA = /^[0-9a-f]{40}$/i
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const digest = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')

function git(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: 3_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}

/** Kept for the separate, advisory repository-link nudge; NOT observation proof. */
export function commitRepoDir(command, cwd) {
  if (typeof command !== 'string') return cwd
  const viaC = /\bgit\s+(?:--\S+\s+)*-C\s+("([^"]+)"|'([^']+)'|(\S+))/.exec(command)
  if (viaC) return viaC[2] ?? viaC[3] ?? viaC[4] ?? cwd
  const viaCd = /^\s*cd\s+("([^"]+)"|'([^']+)'|(\S+))\s*&&/.exec(command)
  return viaCd ? viaCd[2] ?? viaCd[3] ?? viaCd[4] ?? cwd : cwd
}

function extractCommand(input) {
  const toolInput = input?.tool_input ?? input?.toolInput ?? {}
  if (typeof toolInput.command === 'string') return toolInput.command
  if (typeof toolInput.CommandLine === 'string') return toolInput.CommandLine
  return null
}

function directInvocation(command, cwd) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null
  let invocation
  const options = { onInvocation: (value) => { invocation = value } }
  const parsed = simpleGitCommit(command, options) ?? heredocGitCommit(command, options)
  if (!parsed || !invocation) return null
  const args = invocation.commitArgs
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-m' || args[i] === '--message') { i++; continue }
    if (/^(?:-m.|--message=)/.test(args[i])) continue
    if (!['-q', '--quiet', '-a', '--all', '--allow-empty', '--allow-empty-message'].includes(args[i])) return null
  }
  let dir = cwd
  for (const change of invocation.directoryChanges) {
    if (!change || /[\x00\r\n*?\[\]~!]/.test(change)) return null
    dir = path.resolve(dir, change)
  }
  const repoDir = git(['rev-parse', '--show-toplevel'], dir)
  if (!repoDir) return null
  return {
    repoDir: fs.realpathSync(repoDir),
    subjectHash: digest(parsed.message.split('\n')[0].trim()),
    message: parsed.message,
  }
}

export function looksCommitProducing(command) {
  return Boolean(simpleGitCommit(command) ?? heredocGitCommit(command))
}

function safeRemote(raw) {
  if (!raw) return null
  if (/^git@[A-Za-z0-9.-]+:[A-Za-z0-9_./-]+$/.test(raw)) return raw
  try {
    const url = new URL(raw)
    if (!['https:', 'http:', 'ssh:'].includes(url.protocol) || url.password || url.search || url.hash) return null
    if (url.username && !(url.protocol === 'ssh:' && url.username === 'git')) return null
    return url.toString()
  } catch { return null }
}

function repositoryBinding(repoDir, env = process.env) {
  if (!inJurisdiction(repoDir, env)) return null
  const rawRemote = gitRemoteOrigin(repoDir)
  const remote = safeRemote(rawRemote)
  if (rawRemote && !remote) return null
  const pin = findProjectPin(repoDir)?.project_id
  if (pin && !UUID.test(pin)) return null
  if (!remote && !pin) return null
  return { remote, pin: pin ?? null }
}

function connectionBinding(state) {
  if (!state?.connection_id || !state?.mcp_url || !state?.token) return null
  return digest([
    state.connection_id,
    state.mcp_url,
    state.token,
    state.project_id ?? null,
    state.connection_capability ?? null,
  ])
}

export function boundConnection(sessionId, dir = CONNECTIONS_DIR) {
  if (!sessionId) return null
  try {
    const candidates = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.json') && !name.includes('.terminal-wait.') && !name.includes('.turn-'))
      .map((name) => readPrivateJson(path.join(dir, name)))
      .filter((raw) => raw?.enabled === true && raw?.connection_id && raw?.local_id === sessionId)
    return candidates.length === 1 ? candidates[0] : null
  } catch {
    return null
  }
}

export function inJurisdiction(dir, env = process.env) {
  try {
    return Boolean(
      dir &&
        devspecFolderMarker(dir, {
          home: env.USERPROFILE || env.HOME || os.homedir(),
          mainWorktree: mainWorkTreeFrom(dir),
        }),
    )
  } catch {
    return false
  }
}

function markerPath(sessionId, input, repoDir, env = process.env) {
  const identity = input.tool_use_id || input.toolUseId || digest(extractCommand(input))
  return path.join(stateDir(env), `${digest([sessionId, identity, repoDir])}.observation-v1.json`)
}

function pruneMarkers(now, env = process.env) {
  const dir = stateDir(env)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.observation-v1.json'))
    .map((name) => {
      const file = path.join(dir, name)
      return { file, at: fs.statSync(file).mtimeMs }
    })
    .sort((a, b) => b.at - a.at)
  for (let i = 0; i < files.length; i++) {
    if (i >= MAX_PENDING - 1 || now - files[i].at > OBSERVATION_TTL_MS) {
      fs.rmSync(files[i].file, { force: true })
    }
  }
}

function readHead(repoDir) {
  const sha = git(['rev-parse', '--verify', 'HEAD^{commit}'], repoDir)
  return sha && FULL_SHA.test(sha) ? sha : null
}

function reflog(repoDir, count) {
  return git(['reflog', 'show', `-${count}`, '--date=raw', '--format=%H%x09%gD%x09%gs', 'HEAD'], repoDir)
}

function resolveActiveClaimContext(sessionId, repoDir, state, commitMessage, env = process.env) {
  const scope = { sessionId, cwd: repoDir, repoRoot: canonicalRepo(repoDir) }
  const claim = readClaimDetails(scope, { env })
  const msgRef = referenceIn(commitMessage)
  const actionItemId = claim?.action_item_id ?? msgRef ?? null
  let provenanceRef = claim?.provenance_ref ?? null
  if (!provenanceRef && state?.connection_id) {
    try {
      const reqState = readRequestState(state.connection_id)
      if (reqState?.serving && typeof reqState.serving === 'string') {
        provenanceRef = reqState.serving
      } else if (reqState?.turn?.size === 1) {
        provenanceRef = [...reqState.turn][0]
      }
    } catch {
      /* ignore */
    }
  }
  if (!provenanceRef && typeof state?.last_command_delivery_id === 'string' && state.last_command_delivery_id) {
    provenanceRef = state.last_command_delivery_id
  }
  return { action_item_id: actionItemId, provenance_ref: provenanceRef }
}

export function handleBashPre(input, options = {}) {
  try {
    const env = options.env ?? process.env
    const sessionId = resolveProvenanceSessionId(input, env)
    if (!sessionId) return null
    const cwd = resolveProvenanceCwd(input)
    const invocation = directInvocation(extractCommand(input), cwd)
    if (!invocation) return null
    const { repoDir, subjectHash } = invocation
    const file = markerPath(sessionId, input, repoDir, env)
    fs.rmSync(file, { force: true })
    const binding = connectionBinding((options.boundConnection ?? boundConnection)(sessionId))
    const repository = repositoryBinding(repoDir, env)
    if (!binding || !repository) return null
    const now = options.now ?? Date.now()
    const sha = readHead(repoDir)
    const priorReflog = reflog(repoDir, 1)
    if (sha && !priorReflog) return null
    const branch = git(['symbolic-ref', '-q', 'HEAD'], repoDir)
    if (!branch) return null
    pruneMarkers(now, env)
    writePrivateJson(file, {
      version: 1,
      sha,
      priorReflog,
      branch,
      binding,
      repository,
      subjectHash,
      at: now,
      observationId: crypto.randomUUID(),
    })
  } catch {
    /* observation is never permission */
  }
  return null
}

function consumeMarker(file) {
  const consumed = `${file}.consumed-${crypto.randomUUID()}`
  try {
    fs.renameSync(file, consumed)
    return readPrivateJson(consumed)
  } catch {
    return null
  } finally {
    try { fs.rmSync(consumed, { force: true }) } catch { /* best effort */ }
  }
}

function createdSha(repoDir, before, now) {
  const head = readHead(repoDir)
  if (!head || head === before.sha) return null
  if (git(['symbolic-ref', '-q', 'HEAD'], repoDir) !== before.branch) return null
  const entries = (reflog(repoDir, 2) ?? '').split('\n').filter(Boolean)
  const [sha, selector, action] = (entries[0] ?? '').split('\t')
  const epoch = /@\{(\d+) [+-]\d+\}$/.exec(selector ?? '')?.[1]
  const at = Number(epoch) * 1000
  if (sha !== head || !Number.isFinite(at) || at < before.at - 1000 || at > now + 1000) return null
  const parents = git(['rev-list', '--parents', '-n', '1', head], repoDir)?.split(/\s+/).slice(1)
  if (!parents) return null
  if (before.sha) {
    if (parents.length !== 1 || parents[0] !== before.sha || !action?.startsWith('commit: ')) return null
    if (entries[1] !== before.priorReflog) return null
  } else if (parents.length || entries.length !== 1 || !action?.startsWith('commit (initial): ')) return null
  if (digest(git(['show', '-s', '--format=%s', head], repoDir)) !== before.subjectHash) return null
  return head
}

export async function handleBashPost(input, options = {}) {
  try {
    const env = options.env ?? process.env
    const sessionId = resolveProvenanceSessionId(input, env)
    if (!sessionId) return null
    const cwd = resolveProvenanceCwd(input)
    const invocation = directInvocation(extractCommand(input), cwd)
    if (!invocation) return null
    const { repoDir, message } = invocation
    const before = consumeMarker(markerPath(sessionId, input, repoDir, env))
    const now = options.now ?? Date.now()
    if (!before || before.version !== 1 || !Number.isFinite(before.at) || now < before.at || now - before.at > OBSERVATION_TTL_MS) {
      return null
    }
    const response = input.tool_response ?? input.toolResponse
    if (
      input.is_error === true ||
      response?.is_error === true ||
      response?.interrupted === true ||
      (typeof response?.exit_code === 'number' && response.exit_code !== 0) ||
      (typeof response?.exitCode === 'number' && response.exitCode !== 0)
    ) {
      return null
    }
    const state = (options.boundConnection ?? boundConnection)(sessionId)
    if (connectionBinding(state) !== before.binding) return null
    const repository = repositoryBinding(repoDir, env)
    if (!repository || digest(repository) !== digest(before.repository)) return null
    const sha = createdSha(repoDir, before, now)
    if (!sha) return null
    const activeClaim = resolveActiveClaimContext(sessionId, repoDir, state, message, env)
    await (options.call ?? mcpToolsCall)({
      mcpUrl: state.mcp_url,
      token: state.token,
      connectionCapability: state.connection_capability ?? null,
      name: 'report_commit_provenance',
      arguments: {
        connection_id: state.connection_id,
        commit_sha: sha,
        observation_id: before.observationId,
        branch: before.branch.replace(/^refs\/heads\//, ''),
        ...(repository.remote ? { git_remote: repository.remote } : { pinned_project_id: repository.pin }),
        ...(options.includeClaimArguments && activeClaim.action_item_id
          ? { action_item_id: activeClaim.action_item_id }
          : {}),
        ...(options.includeClaimArguments && activeClaim.provenance_ref
          ? { provenance_ref: activeClaim.provenance_ref }
          : {}),
      },
      ...(activeClaim.action_item_id ? { action_item_id: activeClaim.action_item_id } : {}),
      ...(activeClaim.provenance_ref ? { provenance_ref: activeClaim.provenance_ref } : {}),
      timeoutMs: options.timeoutMs ?? REPORT_TIMEOUT_MS,
    })
  } catch {
    /* no retry under a later bond; server ingestion remains the backstop */
  }
  return null
}

async function main() {
  try {
    const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}')
    if (process.argv[2] === 'pre') handleBashPre(input)
    else if (process.argv[2] === 'post') await handleBashPost(input)
  } catch {
    /* malformed envelopes and every observation failure fail open */
  }
}
if (import.meta.url === `file://${process.argv[1]}`) main().catch(() => {})
