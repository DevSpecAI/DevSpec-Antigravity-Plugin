/**
 * Which repositories the plugin tags commits in and checks: the connected project's
 * (the contract's commit_provenance_contract.project_association, item cdd7f0f3).
 *
 * A repository is the project's when its `origin` is one of the project's tracked
 * repositories, or when it carries a pin (`.devspec/project.json`) naming the project:
 * in the working tree from the command's folder up, or in the main working tree of a
 * linked worktree (convention 182fc97f). Nothing else counts. A project MCP
 * configuration that declares DevSpec says DevSpec is used in a folder, not that the
 * repository belongs to this project, so it no longer brings a repository into scope:
 * counting it could tag or stop commits in a repository the project does not track.
 *
 * Both of the plugin's commit paths use this definition: the git stand-in
 * (`git-observer-shim.mjs`, which applies it inside git) and the command-text fallback
 * (`commit-provenance.mjs`: native Windows, a conversation not bound to a connection,
 * or a stand-in that could not start).
 */

import os from 'node:os'
import path from 'node:path'
import { gitRemoteOrigin, projectPin } from './devspec-scope.mjs'
import { normalizeRemoteKey } from './git-observer-shim.mjs'
import { resolveOwnConnectionId } from './launch-guard.mjs'
import { resolveHookConversationId } from './mirror-turn.mjs'
import { readStateFile } from './remote-control-state.mjs'
import { projectRepositoryKeys } from './repository-context.mjs'

function connectionsDir(home) {
  return path.join(home, '.devspec', 'remote-control', 'connections')
}

/** The live connection this hook's conversation is bound to, or null. */
export function boundConnectionFor(input, { env = process.env, home = os.homedir() } = {}) {
  const conversationId = resolveHookConversationId(input, env)
  const connectionId = resolveOwnConnectionId(conversationId, { home })
  if (!connectionId) return null
  const state = readStateFile(connectionId, connectionsDir(home))
  if (!state || state.enabled === false || state.connection_id !== connectionId) return null
  return { connectionId, conversationId, state }
}

/**
 * The connected project for this hook, as commit scope needs it: its id and its
 * repositories as `host/owner/repo` keys (from the list DevSpec sends at connect).
 * Null when the conversation is bound to no connection.
 */
export function connectedProject(input, { env = process.env, home = os.homedir() } = {}) {
  const bound = boundConnectionFor(input, { env, home })
  if (!bound) return null
  return {
    ...bound,
    projectId: typeof bound.state.project_id === 'string' && bound.state.project_id ? bound.state.project_id : null,
    repositories: projectRepositoryKeys(bound.connectionId, { dir: connectionsDir(home) }),
  }
}

/**
 * Whether the repository at `cwd` is in the connected project's scope:
 * `{ kind: 'pin', project_id, path }`, `{ kind: 'remote', remote }`, or null.
 *
 * With a connected project, a pin counts only when it names that project. With none
 * (the conversation is not connected), there is no project to compare, and any pin
 * counts, as it always has. `matchRemote: false` leaves the origin out, for a caller
 * whose remote matches are handled elsewhere (the stand-in, inside git).
 */
export function commitScope(cwd, { home = os.homedir(), mainWorktree = undefined, project = null, matchRemote = true } = {}) {
  const pin = projectPin(cwd, { home, mainWorktree })
  if (pin && (!project?.projectId || pin.project_id === project.projectId)) return pin
  if (!matchRemote) return null
  const repositories = Array.isArray(project?.repositories) ? project.repositories : []
  if (repositories.length === 0) return null
  const remote = normalizeRemoteKey(gitRemoteOrigin(cwd) ?? '')
  return remote && repositories.includes(remote) ? { kind: 'remote', remote } : null
}
