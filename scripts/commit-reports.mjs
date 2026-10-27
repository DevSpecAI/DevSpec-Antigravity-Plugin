/**
 * Reports the agent's commits to DevSpec (`report_commit_provenance`), with the
 * repository's remote, and keeps a log of what happened to each (item 9e385793).
 *
 * The commits come from the git stand-in's journal (`git-observer.mjs`), or on
 * Windows from the older `commit-observation.mjs`. Each report names the repository
 * by its credential-free `origin` URL; DevSpec decides which project that repository
 * belongs to and refuses one it does not track. A DevSpec folder pin is sent only
 * when the repository has no origin, as in Pi. Commit ids that change later (amend,
 * rebase, squash) are followed by DevSpec through the `[devspec:<id>]` tag in the
 * message; this reports only what git did.
 *
 * Nothing here can touch git: reporting runs in the hooks after the command is done.
 * A report that cannot be sent waits in `<connection>.commit-reports.json` and is
 * tried again at the next hook, with backoff, until it is sent, refused, or past its
 * attempts or age. Every outcome, sent or not, is a line in `<connection>.commits.log`
 * beside the connection's other logs, so nothing is dropped silently.
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { drainObservations, takeLock } from './git-observer.mjs'
import { findProjectPin, gitRemoteOrigin } from './devspec-scope.mjs'
import { isRetryableHttpFailure, mcpToolsCall } from './mcp-call.mjs'
import { ensurePrivateDir, readPrivateJson, writePrivateJson } from './private-state.mjs'
import { readStateFile } from './remote-control-state.mjs'
import { resolveDevspecMcpAuth } from './resolve-mcp-auth.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const FULL_SHA = /^[0-9a-f]{40}$/

/**
 * What a report may cost, retried. Each attempt is one small request made from a
 * hook that is running anyway, never a timer or a background process.
 */
export const MAX_ATTEMPTS = 6
export const REPORT_TTL_MS = 24 * 60 * 60 * 1000
const BACKOFF_MS = [0, 15_000, 60_000, 4 * 60_000, 10 * 60_000, 10 * 60_000]
/** Waiting reports kept per connection; past this the oldest is dropped, and logged. */
export const MAX_QUEUED = 200
/** One request's wait. A hook has 15 s (PostToolUse) or 30 s (Stop) in all. */
const CALL_TIMEOUT_MS = 5_000
const LOG_ROTATE_BYTES = 1024 * 1024

function connectionsDir(home) {
  return path.join(home, '.devspec', 'remote-control', 'connections')
}

function privateRoot(home) {
  return { root: path.join(home, '.devspec') }
}

export function commitsLogPath(connectionId, home = os.homedir()) {
  return path.join(connectionsDir(home), `${connectionId}.commits.log`)
}

export function reportQueuePath(connectionId, home = os.homedir()) {
  return path.join(connectionsDir(home), `${connectionId}.commit-reports.json`)
}

/** Append one line about a commit to the connection's commit log. Never throws. */
export function logCommit(connectionId, entry, { home = os.homedir(), now = Date.now() } = {}) {
  try {
    const file = commitsLogPath(connectionId, home)
    ensurePrivateDir(path.dirname(file), privateRoot(home))
    try {
      if (fs.statSync(file).size > LOG_ROTATE_BYTES) fs.renameSync(file, `${file}.1`)
    } catch {
      /* no log yet */
    }
    fs.appendFileSync(file, `${JSON.stringify({ at: new Date(now).toISOString(), ...entry })}\n`, { mode: 0o600 })
  } catch {
    /* the log is for people; it never stops a report */
  }
}

/**
 * The origin URL as DevSpec may receive it, or null. A URL that carries a password or
 * a token, a query or a fragment, or an scp-style user other than `git`, is never sent.
 */
export function sanitizeRemote(raw) {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  if (!value || value.length > 512 || /[\s?#\u0000-\u001f\u007f]/.test(value)) return null
  const scp = /^([^/@:]+)@([^/:]+):(.+)$/.exec(value)
  if (scp) return scp[1] === 'git' ? value : null
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      const url = new URL(value)
      if (url.password || url.search || url.hash) return null
      if (url.username && !(url.protocol.endsWith('ssh:') && url.username === 'git')) return null
    } catch {
      return null
    }
  }
  return value
}

/**
 * How a report names the repository: `{ remote }`, else `{ pin }` when it has no
 * origin, else `{ skip: <why> }`. The pin lookup follows the repository, not the
 * folder: a linked worktree finds its main working tree through `--git-common-dir`.
 */
export function repositoryFor(worktree, { home = os.homedir() } = {}) {
  const raw = gitRemoteOrigin(worktree)
  if (raw) {
    const remote = sanitizeRemote(raw)
    return remote
      ? { remote }
      : { skip: 'its origin URL carries credentials or is not a form DevSpec reads, so it was not sent' }
  }
  const pin = findProjectPin(worktree, { home })?.project_id
  return UUID.test(pin ?? '') ? { pin } : { skip: 'the repository has no origin remote and no DevSpec folder pin' }
}

function commitExists(worktree, sha) {
  try {
    execFileSync('git', ['-C', worktree, 'cat-file', '-e', `${sha}^{commit}`], { stdio: 'ignore', timeout: 5_000 })
    return true
  } catch {
    return false
  }
}

function readQueue(file) {
  const value = readPrivateJson(file)
  return Array.isArray(value?.reports) ? value.reports : []
}

export function reportInboxPath(connectionId, home = os.homedir()) {
  return path.join(connectionsDir(home), `${connectionId}.commit-reports.inbox.jsonl`)
}

/**
 * Queue reports for sending. Each is `{ connectionId, sha, branch, observationId,
 * worktree, remote | pin }`. They are appended to the connection's inbox, one line
 * each, which needs no lock, so a hook that is sending never makes another hook lose
 * a commit; the next flush moves them into the queue, once per commit.
 */
export function enqueueCommitReports(reports, { home = os.homedir(), now = Date.now() } = {}) {
  for (const report of reports) {
    if (!UUID.test(report?.connectionId ?? '') || !FULL_SHA.test(report?.sha ?? '')) continue
    if (!report.remote && !UUID.test(report.pin ?? '')) continue
    const item = {
      key: `${report.connectionId}:${report.sha}`,
      connection_id: report.connectionId,
      commit_sha: report.sha,
      branch: report.branch ?? null,
      observation_id: UUID.test(report.observationId ?? '') ? report.observationId : null,
      ...(report.remote ? { git_remote: report.remote } : { pinned_project_id: report.pin }),
      worktree: report.worktree ?? null,
      created_at: now,
      attempts: 0,
      next_attempt_at: now,
    }
    try {
      const file = reportInboxPath(report.connectionId, home)
      ensurePrivateDir(path.dirname(file), privateRoot(home))
      fs.appendFileSync(file, `${JSON.stringify(item)}\n`, { mode: 0o600 })
      logCommit(report.connectionId, { outcome: 'observed', commit_sha: report.sha, branch: item.branch, repository: report.remote ?? `pin:${report.pin}` }, { home, now })
    } catch (error) {
      logCommit(report.connectionId, { outcome: 'dropped', commit_sha: report.sha, branch: item.branch, reason: `could not be queued: ${error?.message || error}` }, { home, now })
    }
  }
}

/**
 * Move the inbox into the queue (the caller holds the queue lock). The merged queue
 * is saved before the inbox lines are let go, so a crash in between loses nothing.
 */
function takeInbox(connectionId, queue, { home, now }) {
  const inbox = reportInboxPath(connectionId, home)
  const taking = `${inbox}.taking-${process.pid}`
  try {
    fs.renameSync(inbox, taking)
  } catch {
    return queue
  }
  let text = ''
  try {
    text = fs.readFileSync(taking, 'utf8')
    for (const line of text.split('\n')) {
      if (!line) continue
      let item
      try {
        item = JSON.parse(line)
      } catch {
        continue
      }
      if (typeof item?.key !== 'string' || queue.some((queued) => queued.key === item.key)) continue
      queue.push(item)
    }
    while (queue.length > MAX_QUEUED) {
      const dropped = queue.shift()
      logCommit(connectionId, { outcome: 'dropped', commit_sha: dropped.commit_sha, reason: `more than ${MAX_QUEUED} reports were waiting` }, { home, now })
    }
    writePrivateJson(reportQueuePath(connectionId, home), { v: 1, reports: queue }, privateRoot(home))
  } catch {
    // Not merged: hand the lines back to the inbox for the next flush.
    try { fs.appendFileSync(inbox, text, { mode: 0o600 }) } catch { /* reported by the next read */ }
  }
  try { fs.rmSync(taking, { force: true }) } catch { /* gone */ }
  return queue
}

function classify(result) {
  if (result?.recorded === true) return { outcome: 'sent' }
  if (result?.recorded === false) {
    return { outcome: 'refused', reason: String(result.message || (result.conflict ? 'another connection already reported this commit' : 'not recorded')) }
  }
  return { outcome: 'retry', reason: 'DevSpec answered without saying whether it was recorded' }
}

function classifyError(error) {
  if (error?.name === 'McpToolRefusalError') return { outcome: 'refused', reason: String(error.message || 'refused') }
  if (error?.code === 'timeout' || isRetryableHttpFailure(error) || error?.status === 401 || error?.status === 403) {
    return { outcome: 'retry', reason: String(error.message || error) }
  }
  return { outcome: 'refused', reason: String(error?.message || error) }
}

async function sendOne(item, { home, call }) {
  const state = readStateFile(item.connection_id, connectionsDir(home))
  let token = state?.token
  let mcpUrl = state?.mcp_url
  if (!token || !mcpUrl) {
    try {
      const auth = resolveDevspecMcpAuth(item.worktree || process.cwd())
      token = token || auth.token
      mcpUrl = mcpUrl || auth.mcp_url
    } catch {
      /* reported below */
    }
  }
  if (!token || !mcpUrl) return { outcome: 'retry', reason: 'no DevSpec key was available' }
  try {
    const result = await call({
      mcpUrl,
      token,
      connectionCapability: state?.connection_capability ?? null,
      name: 'report_commit_provenance',
      arguments: {
        connection_id: item.connection_id,
        commit_sha: item.commit_sha,
        ...(item.branch ? { branch: item.branch } : {}),
        ...(item.observation_id ? { observation_id: item.observation_id } : {}),
        ...(item.git_remote ? { git_remote: item.git_remote } : { pinned_project_id: item.pinned_project_id }),
      },
      timeoutMs: CALL_TIMEOUT_MS,
    })
    return classify(result)
  } catch (error) {
    return classifyError(error)
  }
}

/**
 * Send what is due, oldest first, until `budgetMs` is spent; the rest waits for the
 * next hook. Every queue in the connections folder is served, so a report for a
 * connection that has since moved on is still sent or visibly dropped.
 */
export async function flushCommitReports({ home = os.homedir(), call = mcpToolsCall, now = Date.now(), budgetMs = 6_000 } = {}) {
  const started = Date.now()
  const outcomes = []
  let files = []
  try {
    const ids = new Set()
    for (const name of fs.readdirSync(connectionsDir(home))) {
      const match = /^([0-9a-f-]{36})\.commit-reports\.(?:json|inbox\.jsonl)$/i.exec(name)
      if (match) ids.add(match[1])
    }
    files = [...ids]
  } catch {
    return outcomes
  }
  for (const connectionId of files) {
    const file = reportQueuePath(connectionId, home)
    const release = takeLock(`${file}.lock`, { now })
    if (!release) continue
    try {
      const queue = takeInbox(connectionId, readQueue(file), { home, now })
      const kept = []
      for (const item of queue) {
        const base = { commit_sha: item.commit_sha, branch: item.branch ?? null, repository: item.git_remote ?? `pin:${item.pinned_project_id}` }
        if (now - item.created_at > REPORT_TTL_MS || item.attempts >= MAX_ATTEMPTS) {
          logCommit(connectionId, { outcome: 'dropped', ...base, attempts: item.attempts, reason: item.last_error ? `gave up: ${item.last_error}` : 'gave up' }, { home, now })
          outcomes.push({ connectionId, sha: item.commit_sha, outcome: 'dropped' })
          continue
        }
        if (item.next_attempt_at > now || Date.now() - started > budgetMs) {
          kept.push(item)
          continue
        }
        const attempt = item.attempts + 1
        const result = await sendOne(item, { home, call })
        outcomes.push({ connectionId, sha: item.commit_sha, ...result })
        if (result.outcome === 'retry') {
          logCommit(connectionId, { outcome: 'retry', ...base, attempts: attempt, reason: result.reason }, { home, now })
          kept.push({ ...item, attempts: attempt, last_error: result.reason, next_attempt_at: now + (BACKOFF_MS[attempt] ?? BACKOFF_MS.at(-1)) })
        } else {
          logCommit(connectionId, { outcome: result.outcome, ...base, attempts: attempt, ...(result.reason ? { reason: result.reason } : {}) }, { home, now })
        }
      }
      if (kept.length > 0) writePrivateJson(file, { v: 1, reports: kept }, privateRoot(home))
      else fs.rmSync(file, { force: true })
    } catch {
      /* the queue is left as it was for the next hook */
    } finally {
      release()
    }
  }
  return outcomes
}

/**
 * PostToolUse and Stop: read what the stand-in journalled for this connection, queue
 * a report for each commit, and send what is due.
 */
export async function reportObservedCommits({ connectionId, home = os.homedir(), call = mcpToolsCall, now = Date.now(), budgetMs = 6_000 } = {}) {
  const reports = []
  for (const commit of drainObservations(connectionId, { home, now })) {
    if (!commitExists(commit.worktree, commit.sha)) {
      logCommit(connectionId, { outcome: 'skipped', commit_sha: commit.sha, branch: commit.branch, reason: 'the commit is no longer in its repository' }, { home, now })
      continue
    }
    const repository = repositoryFor(commit.worktree, { home })
    if (repository.skip) {
      logCommit(connectionId, { outcome: 'skipped', commit_sha: commit.sha, branch: commit.branch, worktree: commit.worktree, reason: repository.skip }, { home, now })
      continue
    }
    reports.push({ ...commit, ...repository })
  }
  if (reports.length > 0) enqueueCommitReports(reports, { home, now })
  return flushCommitReports({ home, call, now, budgetMs })
}
