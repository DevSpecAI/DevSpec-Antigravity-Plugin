#!/usr/bin/env node
/**
 * After an agent gives a pinned folder its repository, say where to link it (item fa9b809b).
 *
 * A greenfield project starts as a folder with a `.devspec/project.json` pin and no
 * repository. Sooner or later the agent helpfully runs `git remote add origin …` or
 * `gh repo create --source .`, and the folder now has a real repository that DevSpec
 * knows nothing about: nothing indexes it, its commits link to nothing, and the pin is
 * the only thing tying the folder to its project. Linking a repository to a project is
 * done in the DevSpec app (there is no tool for it), so the useful thing is to tell the
 * model, once, so it can tell the person where.
 *
 * PostToolUse on run_command / Bash. It stays silent unless ALL of these hold, cheapest first:
 *   1. the command looks like it created or re-pointed `origin`;
 *   2. the folder carries a pin (positive jurisdiction, as everywhere else);
 *   3. the folder now has an `origin`;
 *   4. the server, asked with this folder's own credentials, says that remote does NOT
 *      resolve to the pinned project, and the pinned project is one this key can see.
 * Any failure along the way (offline, no key, server error) is silence: telling someone
 * their repository is unlinked when we do not know that is worse than saying nothing.
 * Said once per conversation, project and remote.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { commitRepoDir } from './commit-observation.mjs'
import { stateDir } from './commit-provenance.mjs'
import { findProjectPin, gitRemoteOrigin } from './devspec-scope.mjs'
import { mcpToolsCall } from './mcp-call.mjs'
import { resolveDevspecMcpAuth } from './resolve-mcp-auth.mjs'

const LOOKUP_TIMEOUT_MS = 8_000

/**
 * Commands that can give this folder an `origin`. Loose on purpose, like
 * `looksCommitProducing`: a false positive costs a stat and a `git remote get-url`,
 * and every later check still has to pass before anything is said.
 */
export function looksRemoteCreating(command) {
  if (typeof command !== 'string' || !command) return false
  return /\bgit\b[^\n]*\bremote\s+(?:add|set-url)\b/.test(command) || /\bgh\s+repo\s+create\b/.test(command)
}

/** What the model is told, to pass on. Written for the person, not about our machinery. */
export function nudgeText({ projectName, remote }) {
  const name = projectName ? `"${projectName}"` : 'its DevSpec project'
  return [
    `DevSpec: this folder belongs to the DevSpec project ${name}, but the repository it now points at (${remote}) is not linked to that project yet.`,
    `Tell the person: in DevSpec, open the project's Settings → Integrations → Repositories and add this repository.`,
    `Until then DevSpec cannot read the code or connect its commits to the project's work, and the folder is recognised only by its .devspec/project.json file.`,
  ].join(' ')
}

function markerPath(sessionId, projectId, remote, env) {
  const digest = crypto
    .createHash('sha256')
    .update(`${sessionId}\0${projectId}\0${remote}`)
    .digest('hex')
  return path.join(stateDir(env), `${digest}.repo-link-nudge`)
}

function alreadySaid(file) {
  try {
    return fs.existsSync(file)
  } catch {
    return false
  }
}

function remember(file) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    fs.writeFileSync(file, '', { mode: 0o600 })
  } catch {
    /* at worst it is said again next time */
  }
}

/**
 * Decide whether to speak, and return the hook output (or null for silence).
 * Every external effect is injectable for tests.
 */
export async function handleBashPost(input, deps = {}) {
  const env = deps.env ?? process.env
  const toolInput = input?.tool_input ?? input?.toolInput ?? {}
  const command = typeof toolInput.command === 'string' ? toolInput.command : toolInput.CommandLine
  if (!looksRemoteCreating(command)) return null
  const cwd =
    typeof input?.cwd === 'string' && input.cwd
      ? input.cwd
      : typeof toolInput?.Cwd === 'string' && toolInput.Cwd
        ? toolInput.Cwd
        : null
  if (!cwd) return null
  const repoDir = path.resolve(cwd, commitRepoDir(command, cwd) || cwd)

  const pin = (deps.findProjectPin ?? findProjectPin)(repoDir)
  if (!pin?.project_id) return null
  const remote = (deps.gitRemoteOrigin ?? gitRemoteOrigin)(repoDir)
  if (!remote) return null

  const sessionId =
    typeof input?.session_id === 'string' && input.session_id
      ? input.session_id
      : typeof input?.conversation_id === 'string' && input.conversation_id
        ? input.conversation_id
        : 'no-session'
  const marker = markerPath(sessionId, pin.project_id, remote, env)
  if (alreadySaid(marker)) return null

  const auth = (deps.resolveAuth ?? resolveDevspecMcpAuth)(repoDir, { env })
  if (!auth?.ok || !auth.token) return null
  if (typeof deps.readProject === 'function') {
    try {
      const selected = deps.readProject(sessionId, { endpoint: auth.mcp_url })
      if (selected?.status === 'blocked' || (selected?.status === 'selected' && selected.project.id !== pin.project_id)) {
        return null
      }
    } catch {
      return null
    }
  }

  let listed
  try {
    listed = await (deps.call ?? mcpToolsCall)({
      mcpUrl: auth.mcp_url,
      token: auth.token,
      name: 'list_projects',
      arguments: { git_remote: remote },
      timeoutMs: LOOKUP_TIMEOUT_MS,
    })
  } catch {
    return null
  }

  const match = listed?.remote_match
  if (!match || typeof match !== 'object') return null
  const candidates = Array.isArray(match.candidate_project_ids) ? match.candidate_project_ids : []
  if (match.resolved_project_id === pin.project_id || candidates.includes(pin.project_id)) return null

  // The pin must name a project this key can actually see; otherwise we would be
  // telling them to link a repository to a project they cannot open.
  const projects = Array.isArray(listed?.projects) ? listed.projects : []
  const project = projects.find((p) => p?.id === pin.project_id)
  if (!project) return null

  remember(marker)
  return {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: nudgeText({ projectName: project.name, remote }),
    },
  }
}

export const checkRepoLinkAfterTool = handleBashPost

async function main() {
  let input = {}
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}')
  } catch {
    return
  }
  const out = await handleBashPost(input)
  if (out) process.stdout.write(JSON.stringify(out) + '\n')
}

const isMain =
  Boolean(process.argv[1]) && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (isMain) {
  main().catch(() => {})
}
