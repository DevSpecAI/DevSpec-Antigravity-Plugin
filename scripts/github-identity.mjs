/**
 * The GitHub identity link at connect (item 7a01644a; server side c45f75d4).
 *
 * For a project that tracks GitHub repositories, `register_connection` says whether
 * the person has linked their GitHub account to DevSpec: `linked` with their logins,
 * or `link_required` with one link they open in their browser. The link is identity
 * only (DevSpec's own GitHub App confirms who they are and keeps no token); it is for
 * attribution, never authority (ADR "Protecting intent" §14). The server builds the
 * prompt; each plugin decides how to show it. This one shows it in the connect status
 * block, which the agent relays to the person, and keeps it beside the connection so a
 * reused registration still shows it.
 */

import os from 'node:os'
import path from 'node:path'
import { readPrivateJson, writePrivateJson } from './private-state.mjs'

const defaultDir = path.join(os.homedir(), '.devspec', 'remote-control', 'connections')
const statePath = (connectionId, dir) => path.join(dir, `${connectionId}.github-identity.json`)

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** The server's `github_identity`, or null when it sent none or a shape we do not know. */
export function githubIdentityFrom(registration) {
  const value = registration?.github_identity
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  if (value.status === 'linked') {
    const logins = Array.isArray(value.logins) ? value.logins.map(text).filter(Boolean) : []
    return logins.length > 0 ? { status: 'linked', logins } : null
  }
  if (value.status === 'link_required') {
    const url = text(value.url)
    let parsed = null
    try {
      parsed = url ? new URL(url) : null
    } catch {
      parsed = null
    }
    if (!parsed || parsed.protocol !== 'https:') return null
    return { status: 'link_required', url: parsed.toString(), message: text(value.message) }
  }
  return null
}

/** Keep what this registration said, or forget a stale answer when it said nothing. */
export function storeGithubIdentity(connectionId, registration, { dir = defaultDir } = {}) {
  if (!connectionId) return null
  const identity = githubIdentityFrom(registration)
  writePrivateJson(statePath(connectionId, dir), { github_identity: identity })
  return identity
}

export function readGithubIdentity(connectionId, { dir = defaultDir } = {}) {
  if (!connectionId) return null
  return githubIdentityFrom(readPrivateJson(statePath(connectionId, dir)))
}

const FALLBACK_ASK =
  'Ask the person to link their GitHub account so their commits and pull requests show as theirs. GitHub confirms who they are, and DevSpec keeps no access to their account.'

/** The status-block lines, or [] when there is nothing to say. */
export function renderGithubIdentity(identity) {
  if (identity?.status === 'linked') {
    return [`GitHub:     linked as ${identity.logins.map((login) => `@${login}`).join(', ')}`]
  }
  if (identity?.status === 'link_required') {
    return [
      `GitHub:     NOT LINKED — ${identity.message || FALLBACK_ASK}`,
      `            Link: ${identity.url}`,
      '            Tell the person in plain words and give them the link to open in their browser; never open it or link an account for them.',
    ]
  }
  return []
}
