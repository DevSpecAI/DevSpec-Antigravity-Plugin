/**
 * The stand-in for `git` on the agent's shell PATH (item 9e385793).
 *
 * `git-observer.mjs` copies this file into the connection's private observer folder
 * and puts that folder first on PATH for each shell command the agent runs, through a
 * one-line prefix on the command. Started as
 *
 *     node git-observer-shim.mjs <real git> <git arguments...>
 *
 * it runs the real git with the same arguments, the same working directory and the
 * same terminal, and exits with the same code or signal. Nothing about git changes:
 * no hook is installed, no configuration is written, nothing is added to any
 * repository. The only difference is that git is asked to describe what it did
 * (Trace2, to a private file), so this script can tell from git itself, never from
 * the agent's command text, whether a commit was made. When one was, it appends the
 * full commit id, branch, working tree, previous head and whether it was an amend to
 * `observations.jsonl` beside it, for the plugin's hooks to report.
 *
 * Self-contained (Node built-ins only), so it keeps working from its copy whatever
 * happens to the plugin folder. Every observation step fails open: if anything about
 * noting the commit goes wrong, git has still run exactly as asked.
 */

import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const FULL_SHA = /^[0-9a-f]{40}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// Trace2 output of one git command, hooks included, is a few kilobytes; a trace past
// this is not read (and that one commit goes unobserved) rather than held in memory.
const MAX_TRACE_BYTES = 4 * 1024 * 1024
const MAX_JOURNAL_LINE_BYTES = 8 * 1024

/**
 * Git's own commands that are not `commit`. Anything else that is not `commit` may be
 * an alias, which git expands to a child command; only those are traced. Leaving a
 * builtin off this list costs two quick `git rev-parse` calls, never a missed commit.
 */
const NOT_COMMIT = new Set([
  'add', 'am', 'annotate', 'apply', 'archive', 'bisect', 'blame', 'branch', 'bundle',
  'cat-file', 'check-attr', 'check-ignore', 'check-mailmap', 'check-ref-format',
  'checkout', 'checkout-index', 'cherry', 'cherry-pick', 'clean', 'clone', 'column',
  'commit-graph', 'commit-tree', 'config', 'count-objects', 'credential', 'describe',
  'diff', 'diff-files', 'diff-index', 'diff-tree', 'difftool', 'fetch', 'fetch-pack',
  'for-each-ref', 'format-patch', 'fsck', 'gc', 'grep', 'hash-object', 'help',
  'index-pack', 'init', 'log', 'ls-files', 'ls-remote', 'ls-tree', 'maintenance',
  'merge', 'merge-base', 'merge-file', 'mergetool', 'mktag', 'mktree', 'mv', 'notes',
  'pack-objects', 'prune', 'pull', 'push', 'range-diff', 'read-tree', 'rebase', 'reflog',
  'remote', 'repack', 'replace', 'rerere', 'reset', 'restore', 'rev-list', 'rev-parse',
  'revert', 'rm', 'shortlog', 'show', 'show-branch', 'show-ref', 'sparse-checkout',
  'stash', 'status', 'submodule', 'switch', 'symbolic-ref', 'tag', 'unpack-objects',
  'update-index', 'update-ref', 'var', 'verify-commit', 'verify-pack', 'verify-tag',
  'version', 'whatchanged', 'worktree', 'write-tree',
])

const VALUE_OPTIONS = new Set(['-C', '-c', '--config-env', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--exec-path'])
const VALUE_PREFIXES = ['--config-env=', '--git-dir=', '--work-tree=', '--namespace=', '--super-prefix=', '--exec-path=']
const FLAG_OPTIONS = new Set([
  '--no-pager', '-P', '--paginate', '-p', '--bare', '--no-replace-objects',
  '--literal-pathspecs', '--no-literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs',
  '--icase-pathspecs', '--no-optional-locks', '--no-lazy-fetch', '--no-advice',
])

/** Split git's own options from the subcommand: `{ globals, command }`, or null for `git --version` and the like. */
export function splitGlobalOptions(args) {
  const globals = []
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (VALUE_OPTIONS.has(arg)) {
      if (typeof args[i + 1] !== 'string') return null
      globals.push(arg, args[i + 1])
      i += 1
    } else if ((arg.startsWith('-C') || arg.startsWith('-c')) && arg.length > 2) {
      globals.push(arg)
    } else if (VALUE_PREFIXES.some((prefix) => arg.startsWith(prefix)) || FLAG_OPTIONS.has(arg)) {
      globals.push(arg)
    } else if (arg.startsWith('-')) {
      return null
    } else {
      return { globals, command: arg }
    }
  }
  return null
}

function quiet(realGit, args) {
  const result = spawnSync(realGit, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 10_000,
    windowsHide: true,
  })
  return result.status === 0 ? result.stdout.trim() : null
}

/** The repository the command is about to act on, and its head before it runs. */
function preflight(realGit, globals) {
  const top = quiet(realGit, [...globals, 'rev-parse', '--show-toplevel'])
  if (!top) return null
  let worktree
  try {
    worktree = fs.realpathSync(top)
  } catch {
    return null
  }
  const head = quiet(realGit, [...globals, 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])?.toLowerCase() ?? null
  return { worktree, previousHead: head && FULL_SHA.test(head) ? head : null }
}

/**
 * The commit this command made, read from git's Trace2 events: the top-level command
 * is `commit`, or an alias whose expansion runs `commit`. A commit run by a hook, or
 * by any other child process, is not this command's.
 */
export function commitFromTrace(rows) {
  const root = rows.find((row) => row.event === 'start' && typeof row.sid === 'string' && !row.sid.includes('/'))
  if (!root) return null
  const named = rows.find((row) => {
    if (row.event !== 'cmd_name' || row.name !== 'commit' || typeof row.sid !== 'string') return false
    if (row.sid === root.sid) return true
    return (
      row.sid.startsWith(`${root.sid}/`) &&
      !row.sid.slice(root.sid.length + 1).includes('/') &&
      typeof row.hierarchy === 'string' &&
      row.hierarchy.includes('_run_git_alias_') &&
      row.hierarchy.endsWith('/commit')
    )
  })
  if (!named) return null
  const start = rows.find((row) => row.event === 'start' && row.sid === named.sid)
  const argv = Array.isArray(start?.argv) ? start.argv : []
  if (argv.includes('--dry-run')) return null
  const repo = rows.find((row) => row.event === 'def_repo' && row.sid === named.sid && (row.repo === 1 || row.repo == null))
  if (typeof repo?.worktree !== 'string' || !repo.worktree) return null
  return { worktree: repo.worktree, amend: argv.includes('--amend') }
}

function parents(realGit, worktree, sha) {
  const line = quiet(realGit, ['-C', worktree, 'rev-list', '--parents', '-n', '1', sha])
  return line ? line.split(/\s+/).slice(1).map((p) => p.toLowerCase()) : null
}

/**
 * Confirm from the repository that the command made exactly this commit: it is the
 * new head, its parents fit what was there before (the old head for a commit or the
 * end of a merge, the old head's parents for an amend, none for a first commit), and
 * the head's newest reflog entry is that commit, written by `git commit`.
 */
export function confirmCommit(realGit, worktree, previousHead, amend) {
  const sha = quiet(realGit, ['-C', worktree, 'rev-parse', '--verify', 'HEAD^{commit}'])?.toLowerCase()
  if (!sha || !FULL_SHA.test(sha) || sha === previousHead) return null
  const now = parents(realGit, worktree, sha)
  if (!now) return null
  if (previousHead === null) {
    if (amend || now.length !== 0) return null
  } else if (amend) {
    const before = parents(realGit, worktree, previousHead)
    if (!before || before.length !== now.length || before.some((p, i) => p !== now[i])) return null
  } else if (now[0] !== previousHead) {
    return null
  }
  const reflog = quiet(realGit, ['-C', worktree, 'reflog', 'show', '-2', '--format=%H%x09%gs', 'HEAD'])
  if (!reflog) return null
  const entries = reflog.split('\n').filter(Boolean).map((line) => line.split('\t'))
  const [topSha = '', action = ''] = entries[0] ?? []
  const expected = previousHead === null ? /^commit \(initial\):/ : amend ? /^commit \(amend\):/ : /^commit( \(merge\))?:/
  if (topSha.toLowerCase() !== sha || !expected.test(action)) return null
  if (previousHead !== null && entries[1]?.[0]?.toLowerCase() !== previousHead) return null
  const branch = quiet(realGit, ['-C', worktree, 'symbolic-ref', '--quiet', '--short', 'HEAD'])
  return { sha, branch: branch ? branch.slice(0, 255) : null }
}

function readTrace(file) {
  try {
    if (fs.statSync(file).size > MAX_TRACE_BYTES) return []
    const rows = []
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line) continue
      try {
        const row = JSON.parse(line)
        if (row && typeof row === 'object') rows.push(row)
      } catch {
        /* a partial line from a process still writing: not this command's */
      }
    }
    return rows
  } catch {
    return []
  } finally {
    try { fs.rmSync(file, { force: true }) } catch { /* best effort */ }
  }
}

function delegate(realGit, args, env) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(realGit, args, { stdio: 'inherit', env, windowsHide: true })
    } catch (error) {
      resolve({ code: 126, signal: null, error })
      return
    }
    const forwarded = []
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']) {
      const handler = () => {
        try { child.kill(signal) } catch { /* the child may have gone */ }
      }
      process.on(signal, handler)
      forwarded.push([signal, handler])
    }
    const done = (result) => {
      for (const [signal, handler] of forwarded) process.off(signal, handler)
      resolve(result)
    }
    child.once('error', (error) => done({ code: 126, signal: null, error }))
    child.once('exit', (code, signal) => done({ code: code ?? 1, signal, error: null }))
  })
}

export async function runShim(argv = process.argv.slice(2), env = process.env, here = path.dirname(fileURLToPath(import.meta.url))) {
  const [realGit, ...args] = argv
  if (!realGit) return { code: 126, signal: null, error: new Error('devspec git observer: no git to run') }

  // Never run another copy of this stand-in as "the real git": that recursion has no end.
  try {
    if (path.dirname(fs.realpathSync(realGit)) === fs.realpathSync(here)) {
      return { code: 126, signal: null, error: new Error('devspec git observer: the real git is this stand-in') }
    }
  } catch {
    /* an unresolvable path is reported by spawn itself */
  }

  const observation = env.DEVSPEC_AGY_GIT_OBSERVATION
  const generation = env.DEVSPEC_AGY_GIT_GENERATION
  const split = splitGlobalOptions(args)
  const eligible = Boolean(
    UUID.test(observation ?? '') && UUID.test(generation ?? '') && split &&
      (split.command === 'commit' || !NOT_COMMIT.has(split.command)) &&
      !env.GIT_TRACE2_EVENT && !env.GIT_TRACE2,
  )

  let before = null
  let traceFile = null
  let childEnv = env
  if (eligible) {
    try {
      before = preflight(realGit, split.globals)
      if (before) {
        const traces = path.join(here, 'traces')
        fs.mkdirSync(traces, { recursive: true, mode: 0o700 })
        traceFile = path.join(traces, `${randomUUID()}.trace`)
        childEnv = { ...env, GIT_TRACE2_EVENT: traceFile }
      }
    } catch {
      before = null
      traceFile = null
      childEnv = env
    }
  }

  const result = await delegate(realGit, args, childEnv)

  if (traceFile) {
    try {
      const rows = readTrace(traceFile)
      const found = result.code === 0 && !result.signal ? commitFromTrace(rows) : null
      const worktree = found ? fs.realpathSync(found.worktree) : null
      const commit = worktree && worktree === before.worktree
        ? confirmCommit(realGit, worktree, before.previousHead, found.amend)
        : null
      if (commit) {
        const line = JSON.stringify({
          v: 1,
          generation,
          observation,
          sha: commit.sha,
          branch: commit.branch,
          worktree,
          previous_head: before.previousHead,
          amend: found.amend,
          observed_at: new Date().toISOString(),
        })
        if (Buffer.byteLength(line) < MAX_JOURNAL_LINE_BYTES) {
          fs.appendFileSync(path.join(here, 'observations.jsonl'), `${line}\n`, { mode: 0o600 })
        }
      }
    } catch {
      /* noting the commit never affects git */
    }
  }
  return result
}

let entry = false
try {
  entry = Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
} catch {
  entry = false
}
if (entry) {
  const result = await runShim()
  if (result.error) process.stderr.write(`${result.error.message}\n`)
  if (result.signal) {
    try { process.kill(process.pid, result.signal) } catch { process.exit(1) }
  } else {
    process.exit(result.code)
  }
}
