#!/usr/bin/env node
/**
 * Where a folder stands in relation to DevSpec.
 *
 * Two questions live here, and both are answered from the filesystem alone — no
 * network, no server round trip — because the callers are a PreToolUse hook that
 * runs before every mutation and a connect script that must work offline:
 *
 *  - WHICH project does this folder belong to?           → `findProjectPin`
 *  - Which pin covers this repository, from stat calls? → `projectPin`
 *
 * Whether a repository is in the connected project's scope for commits is
 * `commit-scope.mjs`: its origin, or a pin.
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** `git remote get-url origin`, or null when there is no repo / no origin. */
export function gitRemoteOrigin(cwd) {
  try {
    const out = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    })
    return out.trim() || null
  } catch {
    return null
  }
}

/** The git working-tree root for `cwd`, or null when this is not a repo. */
export function gitRoot(cwd) {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    })
    return out.trim() ? path.resolve(out.trim()) : null
  } catch {
    return null
  }
}

/**
 * The same answer as `gitRoot` from stat calls alone: the nearest ancestor holding
 * a `.git` entry. A linked worktree's `.git` is a FILE rather than a directory, so
 * presence — not type — is the test.
 */
export function workTreeRootFrom(cwd, { home = os.homedir() } = {}) {
  const homeResolved = path.resolve(home)
  let dir = path.resolve(cwd)
  for (;;) {
    if (atOrAboveHome(dir, homeResolved)) return null
    if (fs.existsSync(path.join(dir, '.git'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** True when `dir` IS the home directory or an ancestor of it (`~`, `/home`, `/`). */
function atOrAboveHome(dir, homeResolved) {
  const relative = path.relative(dir, homeResolved)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/**
 * Walk from `cwd` upward, calling `visit` on each directory, and stop at (and
 * including) `root`. Never looks at or above the home directory.
 */
function walkUp(cwd, { home, root }, visit) {
  const homeResolved = path.resolve(home)
  let dir = path.resolve(cwd)
  for (;;) {
    if (atOrAboveHome(dir, homeResolved)) return null
    const found = visit(dir)
    if (found) return found
    if (root && dir === path.resolve(root)) return null
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** `<dir>/.devspec/project.json` → `{ project_id }`, or null when absent/unusable. */
function readPin(dir) {
  const candidate = path.join(dir, '.devspec', 'project.json')
  try {
    if (!fs.existsSync(candidate)) return null
    const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'))
    const id = typeof parsed?.project_id === 'string' ? parsed.project_id.trim() : ''
    if (id) return { kind: 'pin', project_id: id, path: candidate }
  } catch {
    /* an unreadable or malformed pin is simply not a pin */
  }
  return null
}

/**
 * The repository's MAIN working tree for `cwd`, or null when there is no repository.
 */
export function mainWorkTreeFrom(cwd) {
  try {
    const common = execFileSync(
      'git',
      ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 },
    ).trim()
    if (!common) return null
    const resolved = path.resolve(common)
    return path.basename(resolved) === '.git' ? path.dirname(resolved) : null
  } catch {
    return null
  }
}

function statKey(candidate) {
  try {
    const stat = fs.statSync(candidate)
    return stat.isDirectory() ? 'd' : `f:${stat.mtimeMs}:${stat.size}`
  } catch {
    return '-'
  }
}

function gitIdentityPaths(gitEntry) {
  try {
    if (fs.statSync(gitEntry).isDirectory()) return [path.join(gitEntry, 'config')]
    const pointer = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(gitEntry, 'utf8'))
    if (!pointer) return []
    const gitdir = path.resolve(path.dirname(gitEntry), pointer[1].trim())
    let common = gitdir
    try {
      common = path.resolve(gitdir, fs.readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim())
    } catch {
      /* no commondir: the gitdir is the repository itself */
    }
    const paths = [path.join(common, 'config')]
    if (path.basename(common) === '.git') {
      paths.push(path.join(path.dirname(common), '.devspec', 'project.json'))
    }
    return paths
  } catch {
    return []
  }
}

export function folderLinkFingerprint(cwd, { home = os.homedir() } = {}) {
  const homeResolved = path.resolve(home)
  const parts = []
  let dir = path.resolve(cwd)
  for (;;) {
    if (atOrAboveHome(dir, homeResolved)) break
    parts.push(statKey(path.join(dir, '.devspec', 'project.json')))
    const gitEntry = path.join(dir, '.git')
    const gitKey = statKey(gitEntry)
    parts.push(gitKey)
    if (gitKey !== '-') {
      for (const identity of gitIdentityPaths(gitEntry)) parts.push(statKey(identity))
      break
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return parts.join('|')
}

export function findProjectPin(cwd, { home = os.homedir(), root = undefined, mainWorktree = undefined } = {}) {
  const stopAt = root === undefined ? gitRoot(cwd) : root
  const found = walkUp(cwd, { home, root: stopAt }, readPin)
  if (found) return { project_id: found.project_id, path: found.path }

  const main = mainWorktree === undefined ? mainWorkTreeFrom(cwd) : mainWorktree
  if (!main) return null
  const resolvedMain = path.resolve(main)
  if (atOrAboveHome(resolvedMain, path.resolve(home))) return null
  const fromMain = readPin(resolvedMain)
  return fromMain ? { project_id: fromMain.project_id, path: fromMain.path } : null
}

/**
 * The pin covering the repository at `cwd`: one in the working tree from `cwd` up to
 * its top, else one at the main working tree of a linked worktree (a pin is untracked,
 * so a linked worktree has none of its own; convention 182fc97f). Stat calls only.
 * `{ kind: 'pin', project_id, path }` or null.
 */
export function projectPin(cwd, {
  home = os.homedir(),
  root = undefined,
  mainWorktree = undefined,
} = {}) {
  const stopAt = root === undefined ? workTreeRootFrom(cwd, { home }) : root
  const inChain = walkUp(cwd, { home, root: stopAt }, readPin)
  if (inChain) return inChain

  if (!mainWorktree) return null
  const main = path.resolve(mainWorktree)
  if (atOrAboveHome(main, path.resolve(home))) return null
  return readPin(main)
}
