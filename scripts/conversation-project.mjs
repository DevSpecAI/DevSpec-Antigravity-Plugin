/**
 * Local-conversation project metadata for Antigravity (`local/antigravity/projects/<sha256>.json`).
 * Not a folder preference or credential.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readPrivateJsonResult, STATE_ABSENT, STATE_OK, writePrivateJson } from './private-state.mjs'

export const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const object = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : null)

export function projectCandidate(value) {
  const p = object(value)
  if (!p || !PROJECT_ID.test(p.id ?? '') || typeof p.name !== 'string') return null
  const org = object(p.organization)
  return {
    id: p.id,
    name: p.name,
    organization:
      org && PROJECT_ID.test(org.id ?? '') && typeof org.name === 'string'
        ? { id: org.id, name: org.name }
        : null,
  }
}

export function readProjectSelection(value) {
  const s = object(value?.project_selection)
  if (
    value?.code !== 'project_choice_required' ||
    s?.version !== 1 ||
    s.status !== 'choice_required' ||
    !Array.isArray(s.candidates)
  ) {
    return null
  }
  const candidates = s.candidates.map(projectCandidate)
  if (candidates.some((p) => !p || !p.organization)) return null
  return {
    version: 1,
    status: 'choice_required',
    reason: String(s.reason ?? 'project_required'),
    candidates,
  }
}

export function matchingProjects(projects, selector) {
  const key = String(selector).trim().toLowerCase()
  const exactIds = projects.filter((p) => p.id.toLowerCase() === key)
  return exactIds.length ? exactIds : projects.filter((p) => p.name.toLowerCase() === key)
}

export function projectStatePath(localId, home = os.homedir()) {
  if (typeof localId !== 'string' || !localId.trim()) {
    throw new Error(
      'This command needs Antigravity’s own conversation ID. Do not use a folder or another agent’s ID.',
    )
  }
  const key = createHash('sha256').update(localId).digest('hex')
  return path.join(home, '.devspec', 'remote-control', 'local', 'antigravity', 'projects', `${key}.json`)
}

export function readConversationProject(localId, { endpoint = null, home = os.homedir() } = {}) {
  if (!localId) return null
  const read = readPrivateJsonResult(projectStatePath(localId, home))
  if (read.status === STATE_ABSENT) return null
  const state = read.value
  if (
    read.status !== STATE_OK ||
    state?.version !== 1 ||
    state.local_id !== localId ||
    typeof state.endpoint !== 'string' ||
    !['selected', 'blocked'].includes(state.status)
  ) {
    throw new Error(
      'This conversation’s saved project could not be read. Do not fall back to a folder default; start a fresh conversation or repair the local project state.',
    )
  }
  if (endpoint && state.endpoint !== endpoint) {
    throw new Error('This conversation belongs to another DevSpec endpoint. Start a fresh local conversation.')
  }
  if (state.status === 'selected' && !projectCandidate(state.project)) {
    throw new Error('This conversation’s saved project is invalid. Start a fresh local conversation.')
  }
  return state
}

export function saveConversationProject(
  localId,
  endpoint,
  project,
  source = 'conversation',
  { home = os.homedir() } = {},
) {
  const parsed = projectCandidate(project)
  if (!parsed) throw new Error('The server did not confirm a valid project.')
  if (!localId) {
    return { version: 1, status: 'selected', local_id: null, endpoint, project: parsed, source }
  }
  const old = readConversationProject(localId, { endpoint, home })
  if (old?.status === 'selected' && old.project.id !== parsed.id) {
    throw new Error(
      'This conversation already uses another project. Start a fresh Antigravity conversation; do not carry the previous model context across.',
    )
  }
  const state = { version: 1, status: 'selected', local_id: localId, endpoint, project: parsed, source }
  writePrivateJson(projectStatePath(localId, home), state)
  return state
}

export function blockConversationProject(localId, endpoint, message, { home = os.homedir() } = {}) {
  if (!localId) return
  const old = readConversationProject(localId, { endpoint, home })
  if (old?.status === 'selected') return
  writePrivateJson(projectStatePath(localId, home), {
    version: 1,
    status: 'blocked',
    local_id: localId,
    endpoint,
    message: String(message),
  })
}

export function inheritConversationProject(
  fromLocalId,
  toLocalId,
  endpoint,
  { home = os.homedir() } = {},
) {
  const source = readConversationProject(fromLocalId, { endpoint, home })
  const target = readConversationProject(toLocalId, { endpoint, home })
  if (
    target?.status === 'blocked' ||
    (target?.status === 'selected' &&
      (source?.status !== 'selected' || source.project.id !== target.project.id))
  ) {
    throw new Error(
      'The resumed conversation has a different project. Its previous remote connection must not be reused.',
    )
  }
  if (source?.status === 'selected') {
    return saveConversationProject(toLocalId, endpoint, source.project, 'conversation', { home })
  }
  if (source?.status === 'blocked') {
    blockConversationProject(toLocalId, endpoint, source.message, { home })
  }
  return null
}

export function conversationProjectFingerprint(localId, home = os.homedir()) {
  if (!localId) return 'none'
  try {
    const stat = fs.statSync(projectStatePath(localId, home))
    return `${stat.mtimeMs}:${stat.size}`
  } catch {
    return 'absent'
  }
}
