#!/usr/bin/env node
/**
 * Deterministic DevSpec project management for Antigravity (`scripts/devspec-project.mjs`).
 *
 * Actions:
 *   - `status`: show `conversation_project` (selected project for THIS conversation) and `folder_default` (`.devspec/project.json` pin)
 *   - `list`: list accessible DevSpec projects via `list_projects`
 *   - `prepare --project <name-or-id>`: validate access and prepare a fresh conversation UUID before auto-connect
 *   - `remember [--confirm --expected <sha256>]`: preview or atomically write `.devspec/project.json` for this folder
 *   - `forget [--confirm --expected <sha256>]`: preview or remove `.devspec/project.json` for this folder
 */
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AGENT_NAME } from './agent-identity.mjs'
import {
  matchingProjects,
  projectCandidate,
  readConversationProject,
  saveConversationProject,
} from './conversation-project.mjs'
import { findProjectPin, gitRoot } from './devspec-scope.mjs'
import { mcpToolsCall } from './mcp-call.mjs'
import {
  detectLocalId,
  resolveOwnerPid,
  scanConnectionStates,
} from './remote-control-state.mjs'
import { hostTokenFromEnv, resolveDevspecMcpAuth } from './resolve-mcp-auth.mjs'
import { isEntryPoint } from './entry-point.mjs'

function fingerprint(file) {
  try {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  } catch (error) {
    if (error.code === 'ENOENT') return 'absent'
    throw error
  }
}

export function manageProjectDefault(
  action,
  { cwd, state = null, confirm = false, expected = null, home = os.homedir() },
) {
  const effective = findProjectPin(cwd, { home })
  if (action === 'status') {
    return { ok: true, conversation_project: state, folder_default: effective }
  }
  if (action !== 'remember' && action !== 'forget') {
    throw new Error('Use status, list, prepare, remember or forget.')
  }
  if (action === 'remember' && state?.status !== 'selected') {
    throw new Error('Choose a conversation project with /devspec-remote --project before remembering it.')
  }
  if (action === 'forget' && !effective) {
    return { ok: true, changed: false, message: 'No usable folder default to forget.' }
  }
  const root = gitRoot(cwd) || path.resolve(cwd)
  const file = action === 'forget' ? effective.path : path.join(root, '.devspec', 'project.json')
  if (action === 'remember' && effective && effective.path !== file) {
    const nested = path.relative(root, path.dirname(path.dirname(effective.path)))
    if (nested && nested !== '..' && !nested.startsWith(`..${path.sep}`)) {
      throw new Error(
        `A nearer default at ${effective.path} would override ${file}. Manage that file explicitly; this conversation remains unchanged.`,
      )
    }
  }
  const current = fingerprint(file)
  const preview = {
    action,
    path: file,
    project: action === 'remember' ? state.project : null,
    effective_default: effective,
    expected: current,
    message:
      'This is folder configuration and may be shared or committed. Existing conversations keep their selected project; a unique remote match still wins over a pin.',
  }
  if (!confirm) return { ok: false, confirmation_required: true, ...preview }
  if (!expected || expected !== current) {
    return {
      ok: false,
      confirmation_required: true,
      ...preview,
      message:
        'The file changed or no confirmed preview was supplied. Review the current default before changing it.',
    }
  }
  if (action === 'forget') {
    fs.unlinkSync(file)
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp-${randomUUID()}`
    try {
      fs.writeFileSync(tmp, JSON.stringify({ project_id: state.project.id }, null, 2) + '\n', {
        mode: 0o644,
        flag: 'wx',
      })
      fs.renameSync(tmp, file)
    } finally {
      try {
        fs.unlinkSync(tmp)
      } catch {
        /* ignore */
      }
    }
  }
  return {
    ok: true,
    changed: true,
    action,
    path: file,
    conversation_project: state,
    folder_default: findProjectPin(cwd, { home }),
    message: 'Folder default changed. Existing conversations are unchanged.',
  }
}

export async function prepareFreshConversation(
  selector,
  {
    cwd = process.cwd(),
    env = process.env,
    home = os.homedir(),
    call = mcpToolsCall,
    resolveAuth = resolveDevspecMcpAuth,
  } = {},
) {
  if (typeof selector !== 'string' || !selector.trim()) {
    throw new Error('prepare requires --project <name-or-id>.')
  }
  const auth = resolveAuth(cwd, { hostToken: hostTokenFromEnv(env, { cwd, home }), env, home })
  if (!auth.ok || !auth.token) {
    throw new Error('Connect your DevSpec account before preparing a project choice.')
  }
  const listing = await call({
    mcpUrl: auth.mcp_url,
    token: auth.token,
    name: 'list_projects',
    arguments: {},
    timeoutMs: 30_000,
  })
  if (!Array.isArray(listing?.projects)) {
    throw new Error('DevSpec did not return project choices.')
  }
  const candidates = listing.projects.map(projectCandidate)
  if (candidates.some((candidate) => !candidate)) {
    throw new Error('DevSpec returned invalid project choices.')
  }
  const matches = matchingProjects(candidates, selector)
  if (matches.length !== 1) {
    return {
      ok: false,
      code: 'project_choice_required',
      project_selection: {
        version: 1,
        status: 'choice_required',
        reason: matches.length ? 'ambiguous_name' : 'unknown_name',
        candidates: matches.length ? matches : candidates,
      },
    }
  }
  const localId = randomUUID()
  const state = saveConversationProject(localId, auth.mcp_url, matches[0], 'explicit', { home })
  return {
    ok: true,
    local_id: localId,
    project: state.project,
    launch_command: `DEVSPEC_REMOTE_LOCAL_ID=${localId} agy chat`,
    message:
      'Run this native command in a fresh terminal (or start a new Antigravity conversation and run /devspec-remote --project ' +
      state.project.id +
      '). The project is prepared before auto-connect; no previous conversation context is copied.',
  }
}

/**
 * Resolve the active conversation state for `devspec-project.mjs` in Antigravity,
 * falling back to the window's active connection (`owner_pid`) when invoked from
 * a `run_command` subshell where `ANTIGRAVITY_CONVERSATION_ID` is not in env.
 */
export function resolveActiveConversationProject(
  { localId = null, ownerPid = null, endpoint = null, home = os.homedir(), env = process.env } = {},
) {
  let effectiveLocalId = detectLocalId({ 'local-id': localId }, env).local_id
  const resolvedOwnerPid = resolveOwnerPid(ownerPid, null)
  const connDir = path.join(home, '.devspec', 'remote-control', 'connections')
  let matchingConn = null

  if (Number.isInteger(Number(resolvedOwnerPid)) && Number(resolvedOwnerPid) > 1) {
    const candidates = scanConnectionStates(connDir).filter(
      (s) =>
        s &&
        s.enabled !== false &&
        !s.ended_from_ui &&
        String(s.agent_name || '').toLowerCase() === AGENT_NAME.toLowerCase() &&
        Number(s.owner_pid) === Number(resolvedOwnerPid),
    )
    matchingConn =
      candidates.find((s) => s.local_id && !String(s.local_id).startsWith('agy-window:')) ||
      candidates[0] ||
      null
    if (
      !effectiveLocalId &&
      matchingConn?.local_id &&
      !String(matchingConn.local_id).startsWith('agy-window:')
    ) {
      effectiveLocalId = matchingConn.local_id
    }
  }

  let state = effectiveLocalId ? readConversationProject(effectiveLocalId, { endpoint, home }) : null
  if (!state && matchingConn?.project_id) {
    state = {
      version: 1,
      status: 'selected',
      local_id: effectiveLocalId || matchingConn.local_id || null,
      endpoint: matchingConn.mcp_url || endpoint || 'https://devspec.ai/api/mcp',
      project: {
        id: matchingConn.project_id,
        name: matchingConn.project_name || matchingConn.project_id,
      },
      source: 'connection',
    }
  }
  return { localId: effectiveLocalId, state }
}

async function main() {
  const args = process.argv.slice(2)
  const action = args[0] && !args[0].startsWith('--') ? args.shift() : 'status'
  const options = {
    cwd: process.cwd(),
    confirm: false,
    expected: null,
    localId: null,
    ownerPid: null,
    project: null,
  }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--confirm') options.confirm = true
    else if (args[i] === '--cwd') options.cwd = path.resolve(args[++i])
    else if (args[i] === '--local-id') options.localId = args[++i]
    else if (args[i] === '--owner-pid') options.ownerPid = args[++i]
    else if (args[i] === '--project') options.project = args[++i]
    else if (args[i] === '--expected') options.expected = args[++i]
    else throw new Error(`Unknown project-management option: ${args[i]}`)
  }
  if (action === 'prepare') {
    process.stdout.write(
      JSON.stringify(await prepareFreshConversation(options.project, { cwd: options.cwd })) + '\n',
    )
    return
  }
  const auth = resolveDevspecMcpAuth(options.cwd, {
    hostToken: hostTokenFromEnv(process.env, { cwd: options.cwd }),
  })
  if (action === 'list') {
    if (!auth.ok || !auth.token) {
      throw new Error('Connect your DevSpec account before listing projects.')
    }
    const result = await mcpToolsCall({
      mcpUrl: auth.mcp_url,
      token: auth.token,
      name: 'list_projects',
      arguments: {},
      timeoutMs: 30_000,
    })
    process.stdout.write(JSON.stringify(result) + '\n')
    return
  }
  const { state } = resolveActiveConversationProject({
    localId: options.localId,
    ownerPid: options.ownerPid,
    endpoint: auth.mcp_url,
  })
  process.stdout.write(JSON.stringify(manageProjectDefault(action, { ...options, state })) + '\n')
}

if (isEntryPoint(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
}
