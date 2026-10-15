#!/usr/bin/env node
/**
 * Mechanical DevSpec connect for Antigravity (`scripts/devspec-remote-connect.mjs`) —
 * the whole deterministic half of `/devspec-remote` in ONE call.
 *
 * Resolves project scope, conversation bond, `register_connection` (with capability v1
 * and project_selection v1), optional `create_session` / `attach_connection`, state +
 * bond + poller + listener, instruction tiers, and repository context in one invocation.
 *
 * Usage:
 *   node devspec-remote-connect.mjs [--project <name-or-id>] [--session <uuid> | --new]
 *       [--private] [--name "<codename>"] [--title "…"] [--agent "Antigravity"]
 *       [--cwd <path>] [--owner-pid <pid>] [--local-id <id>] [--force-new]
 *       [--no-poller] [--json]
 */

import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AGENT_NAME } from './agent-identity.mjs'
import { LOADED_PLUGIN_VERSION } from './connection-version.mjs'
import {
  blockConversationProject,
  matchingProjects,
  PROJECT_ID,
  projectCandidate,
  readConversationProject,
  readProjectSelection,
  saveConversationProject,
} from './conversation-project.mjs'
import { findProjectPin, gitRemoteOrigin } from './devspec-scope.mjs'
import {
  hasStoredTiers,
  mergeInstructionTiers,
  renderTiers,
  renderTiersPointer,
  saveTiersText,
  storeTiers,
} from './instruction-tiers.mjs'
import { mcpToolsCall } from './mcp-call.mjs'

function isRetryableHttpFailure(err) {
  if (!err) return false
  const msg = String(err.message || err)
  return /HTTP (?:502|503|504|429)\b|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up/i.test(msg)
}
import {
  detectLocalId,
  knownInstructionTiersFor,
  readLocalBond,
  readStateFile,
  resolveLocalAction,
  resolveOwnerPid,
  writeConnectionState,
} from './remote-control-state.mjs'
import {
  renderRepositoryContext,
  storeRepositoryContext,
  takeRepositoryContext,
} from './repository-context.mjs'
import { formatMissingAuthMessage, hostTokenFromEnv, resolveDevspecMcpAuth } from './resolve-mcp-auth.mjs'
import { transcriptPaths } from './room-unread.mjs'

const CONNECT_ATTEMPTS = 3
const CONNECT_BACKOFF_MS = [300, 1_200]
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export async function withHttpRetry(invoke, options = {}) {
  const {
    attempts = CONNECT_ATTEMPTS,
    backoff = CONNECT_BACKOFF_MS,
    onRetry = null,
    sleepFn = sleep,
  } = options
  for (let attempt = 0; ; attempt++) {
    try {
      return await invoke()
    } catch (e) {
      if (attempt >= attempts - 1 || !isRetryableHttpFailure(e)) throw e
      if (onRetry) onRetry(e, attempt)
      await sleepFn(backoff[attempt] ?? backoff[backoff.length - 1] ?? 1_200)
    }
  }
}

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url))
const WAIT_SCRIPT = path.join(THIS_DIR, 'devspec-remote-wait.mjs')

function roomStatePath(connectionId, home = os.homedir()) {
  return path.join(home, '.devspec', 'remote-control', 'connections', `${connectionId}.room.json`)
}

export class ConnectError extends Error {
  constructor(message, { code = 1, reason = 'failed', projectSelection = null } = {}) {
    super(message)
    this.name = 'ConnectError'
    this.code = code
    this.reason = reason
    this.projectSelection = projectSelection
  }
}

export function parseArgs(argv = []) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--session' || a === '--session_id') out.session = argv[++i]
    else if (a === '--agent' || a === '--agent_name') out.agent = argv[++i]
    else if (a === '--project') {
      if (out.project !== undefined || !argv[i + 1]?.trim() || argv[i + 1].startsWith('--')) {
        throw new ConnectError('Pass one project name or ID after --project.', {
          code: 2,
          reason: 'bad_args',
        })
      }
      out.project = argv[++i]
    } else if (a.startsWith('--project=')) {
      throw new ConnectError('Use --project <name-or-id>, with a space before its value.', {
        code: 2,
        reason: 'bad_args',
      })
    } else if (a === '--cwd') out.cwd = argv[++i]
    else if (a === '--name' || a === '--codename') out.name = argv[++i]
    else if (a === '--title') out.title = argv[++i]
    else if (a === '--local-id' || a === '--local_id' || a === '--conversation-id') {
      out.localId = argv[++i]
    } else if (a === '--owner-pid') out.ownerPid = argv[++i]
    else if (a === '--new') out.new = true
    else if (a === '--private') out.private = true
    else if (a === '--force-new') out.forceNew = true
    else if (a === '--no-poller' || a === '--skip-poller') out.noPoller = true
    else if (a === '--json') out.json = true
    else if (a && !a.startsWith('--')) out._.push(a)
  }
  if (out.project !== undefined && out._.length) {
    throw new ConnectError('Quote a project name containing spaces, or use its full ID.', {
      code: 2,
      reason: 'bad_args',
    })
  }
  return out
}

export { findProjectPin, gitRemoteOrigin }

const short = (id) => (typeof id === 'string' && id.length >= 8 ? `${id.slice(0, 8)}…` : '—')

export function armCursorFlag({ created } = {}) {
  return created === true ? '--from-end' : '--pending'
}

export function startupScopeProven(registration) {
  return registration?.folder_scope_only === true
}

export async function connect(options = {}, deps = {}) {
  const {
    session = null,
    new: createNew = false,
    private: makePrivate = false,
    name = null,
    title = null,
    agent = null,
    cwd: cwdArg = null,
    ownerPid = null,
    localId: localIdArg = null,
    forceNew = false,
    noPoller = false,
    startup = false,
    project: projectSelector = null,
    env = process.env,
  } = options
  const {
    callTool = mcpToolsCall,
    writeState = writeConnectionState,
    resolveAuth = resolveDevspecMcpAuth,
    projectHome = os.homedir(),
    onRetryMessage = (message) => process.stderr.write(message),
  } = deps

  const [major] = process.versions.node.split('.')
  if (Number(major) < 18) {
    throw new ConnectError(
      `DevSpec remote control needs Node.js 18 or newer; this is ${process.version}.`,
      { reason: 'node_version' },
    )
  }
  if (startup && (createNew || session)) {
    throw new ConnectError('A startup connect never creates or attaches a session.', {
      code: 2,
      reason: 'bad_args',
    })
  }

  const cwd = cwdArg ? path.resolve(cwdArg) : process.cwd()
  const agentName = agent || AGENT_NAME
  const detected = detectLocalId({ 'local-id': localIdArg }, env)
  const effectiveOwnerPid = resolveOwnerPid(ownerPid, null)
  const tierDir = path.join(projectHome, '.devspec', 'remote-control', 'connections')
  const rcDir = path.join(projectHome, '.devspec', 'remote-control')
  const bond = resolveLocalAction({
    agent: agentName,
    localId: detected.local_id,
    ownerPid: effectiveOwnerPid,
    forceNew: !!forceNew || !!createNew,
    maxAgeMinutes: 30,
    readBond: (ag, id) => readLocalBond(ag, id, rcDir),
    readConnection: (id) => readStateFile(id, tierDir),
  })
  const localId = detected.local_id || bond?.local_id || null
  const localIdSource = detected.source || (bond?.local_id ? 'owner_pid_bond' : null)
  const gitRemote = gitRemoteOrigin(cwd)
  const pin = findProjectPin(cwd, { home: projectHome })
  const previousProject = readConversationProject(localId, { home: projectHome })

  if (startup && !gitRemote && !pin && previousProject?.status !== 'selected') {
    throw new ConnectError('This folder has no git remote and no .devspec/project.json pin.', {
      reason: 'folder_not_linked',
    })
  }

  const auth = resolveAuth(cwd, {
    hostToken: hostTokenFromEnv(env, { cwd, home: projectHome }),
    env,
    home: projectHome,
  })
  if (!auth.ok || !auth.token) {
    throw new ConnectError(auth.error || formatMissingAuthMessage(), { reason: 'auth' })
  }

  if (previousProject && previousProject.endpoint !== auth.mcp_url) {
    throw new ConnectError(
      'This conversation belongs to another DevSpec endpoint. Start a fresh Antigravity conversation.',
      { reason: 'auth' },
    )
  }

  const call = (toolName, toolArgs, callOptions = {}) =>
    withHttpRetry(
      () =>
        callTool({
          mcpUrl: auth.mcp_url,
          token: auth.token,
          name: toolName,
          arguments: toolArgs,
          timeoutMs: 30_000,
          ...callOptions,
        }),
      {
        onRetry: (e) =>
          onRetryMessage(`devspec-remote-connect: ${toolName} failed (${e.message}) — retrying\n`),
      },
    )

  let selectedProjectId = previousProject?.status === 'selected' ? previousProject.project.id : null
  let selectedCandidate = null
  if (projectSelector !== null) {
    try {
      const selector = String(projectSelector).trim()
      if (!selector) {
        throw new ConnectError('--project needs a project name or ID.', {
          code: 2,
          reason: 'bad_args',
        })
      }
      if (PROJECT_ID.test(selector)) {
        selectedProjectId = selector.toLowerCase()
      } else {
        const listing = await call('list_projects', {})
        if (!Array.isArray(listing.projects)) {
          throw new ConnectError('DevSpec did not return project choices. Retry.', {
            reason: 'register_refused',
          })
        }
        const candidates = listing.projects.map(projectCandidate)
        if (candidates.some((c) => !c)) {
          throw new ConnectError('DevSpec returned invalid project choices. Retry.', {
            reason: 'register_refused',
          })
        }
        const matches = matchingProjects(candidates, selector)
        if (matches.length !== 1) {
          throw new ConnectError(
            matches.length
              ? 'More than one accessible project has that name. Choose an organisation and project ID.'
              : 'No accessible project has that exact name. Use a full project ID or list the projects.',
            {
              reason: 'register_refused',
              projectSelection: {
                version: 1,
                status: 'choice_required',
                reason: matches.length ? 'ambiguous_name' : 'unknown_name',
                candidates: matches.length ? matches : candidates,
              },
            },
          )
        }
        selectedCandidate = matches[0]
        selectedProjectId = selectedCandidate.id
      }
      if (previousProject?.status === 'selected' && previousProject.project.id !== selectedProjectId) {
        throw new ConnectError(
          'This conversation already uses another project. Start a fresh Antigravity conversation, then run /devspec-remote --project.',
          { reason: 'register_refused' },
        )
      }
    } catch (error) {
      blockConversationProject(
        localId,
        auth.mcp_url,
        'Choose a project explicitly with /devspec-remote --project before using project-scoped DevSpec tools.',
        { home: projectHome },
      )
      throw error
    }
  }

  const known =
    startup || !hasStoredTiers(bond.connection_id, { dir: tierDir })
      ? null
      : knownInstructionTiersFor(bond.connection_id, tierDir)

  let registration = null
  let connectionCapability = null
  if (
    !startup &&
    !createNew &&
    !session &&
    projectSelector === null &&
    !name &&
    !forceNew &&
    bond?.action === 'already_live' &&
    bond?.connection_id
  ) {
    const existing = readStateFile(bond.connection_id, tierDir)
    const ageMs = existing?.updated_at ? Date.now() - Date.parse(existing.updated_at) : Infinity
    if (
      existing &&
      existing.enabled !== false &&
      !existing.session_id &&
      existing.project_id &&
      typeof existing.connection_capability === 'string' &&
      existing.connection_capability.startsWith('dvsc_') &&
      existing.cwd === cwd &&
      Number.isFinite(ageMs) &&
      ageMs >= 0 &&
      ageMs < 60_000
    ) {
      connectionCapability = existing.connection_capability
      registration = {
        connection_id: existing.connection_id,
        codename: existing.session_codename || existing.codename || null,
        created: Boolean(existing.created_by_session_start),
        reused_startup_registration: true,
        project_id: existing.project_id,
        project_name: existing.project_name || existing.project_id,
        project_selection: existing.project_selection || {
          version: 1,
          status: 'selected',
          source: previousProject?.source || 'conversation',
          project: {
            id: existing.project_id,
            name: existing.project_name || previousProject?.project?.name || existing.project_id,
            ...(previousProject?.project?.organization
              ? { organization: previousProject.project.organization }
              : {}),
          },
        },
        instruction_tiers_version: existing.instruction_tiers_version || known?.version || null,
        instruction_tiers_hash: existing.instruction_tiers_hash || known?.hash || null,
        instructions_unchanged: Boolean(known?.hash || existing.instruction_tiers_hash),
      }
    }
  }

  if (!registration) {
    try {
      registration = await call(
        'register_connection',
        {
          ...(localId ? { local_id: localId } : {}),
          agent_name: agentName,
          agent_version: LOADED_PLUGIN_VERSION,
          cwd,
          machine_hostname: os.hostname(),
          ...(gitRemote ? { git_remote: gitRemote } : {}),
          ...(pin ? { pinned_project_id: pin.project_id } : {}),
          ...(name ? { name } : {}),
          ...(selectedProjectId ? { project_id: selectedProjectId } : {}),
          ...(startup ? { folder_scope_only: true } : {}),
          connection_capability_version: 1,
          project_selection_version: 1,
          ...(known
            ? {
                known_instruction_tiers_version: known.version,
                known_instruction_tiers_hash: known.hash,
              }
            : {}),
        },
        {
          onResultMeta: (meta) => {
            const negotiated = meta?.devspec?.connection_capability
            if (negotiated?.version === 1 && typeof negotiated.value === 'string') {
              connectionCapability = negotiated.value
            }
          },
        },
      )
    } catch (e) {
      const hint =
        !gitRemote && !pin
          ? '\nThis folder has no git remote and no .devspec/project.json pin, so nothing identified the project.'
          : ''
      const projectSelection = readProjectSelection(e.details)
      if (projectSelection || projectSelector !== null) {
        blockConversationProject(
          localId,
          auth.mcp_url,
          'Choose a project explicitly with /devspec-remote --project before using project-scoped DevSpec tools.',
          { home: projectHome },
        )
      }
      throw new ConnectError(`register_connection failed: ${e.message}${hint}`, {
        reason: isRetryableHttpFailure(e) ? 'unreachable' : 'register_refused',
        projectSelection,
      })
    }
  }

  const connectionId = registration.connection_id || registration.connection?.id
  if (!connectionId) {
    throw new ConnectError(`register_connection returned no connection_id: ${JSON.stringify(registration)}`)
  }
  const codename = registration.codename || registration.connection?.codename || null

  if (startup && !startupScopeProven(registration)) {
    try {
      await call('heartbeat_connection', {
        connection_id: connectionId,
        status: 'offline',
        end_reason: 'local_stop',
      })
    } catch {
      /* best effort */
    }
    throw new ConnectError(
      'The DevSpec server did not confirm this registration was scoped by folder.',
      { reason: 'server_scope_unproven' },
    )
  }

  const confirmedProject =
    projectCandidate(registration.project_selection?.project) ??
    projectCandidate({
      id: registration.project_id,
      name: selectedCandidate?.name ?? registration.project_name ?? registration.project_id,
      organization: selectedCandidate?.organization,
    })
  if (!confirmedProject || (selectedProjectId && confirmedProject.id !== selectedProjectId)) {
    throw new ConnectError('DevSpec did not confirm the selected project. No local connection was adopted.', {
      reason: 'register_refused',
    })
  }
  const projectState = saveConversationProject(
    localId,
    auth.mcp_url,
    confirmedProject,
    registration.project_selection?.source ?? 'conversation',
    { home: projectHome },
  )

  let sessionId = null
  let sessionAccess = null
  let status = registration.created ? 'registered' : 'already live'
  if (createNew) {
    const created = await call('create_session', {
      session_type: 'agent_remote_control',
      agent_name: agentName,
      project_id: confirmedProject.id,
      ...(gitRemote ? { git_remote: gitRemote } : {}),
      ...(pin ? { pinned_project_id: pin.project_id } : {}),
      ...(codename ? { session_codename: codename } : {}),
      machine_hostname: os.hostname(),
      cwd,
      ...(title ? { title } : {}),
      ...(makePrivate ? { access: 'private' } : {}),
    })
    sessionId = created.session_id || created.id || null
    sessionAccess = makePrivate ? 'private' : 'shared'
    if (!sessionId) {
      throw new ConnectError(`create_session returned no session id: ${JSON.stringify(created)}`)
    }
    registration = mergeInstructionTiers(
      registration,
      await call('attach_connection', { connection_id: connectionId, session_id: sessionId }),
    )
    status = 'attached'
  } else if (session) {
    sessionId = session
    registration = mergeInstructionTiers(
      registration,
      await call('attach_connection', { connection_id: connectionId, session_id: sessionId }),
    )
    status = 'attached'
  } else if (bond.action === 'reconnect' && bond.session_id) {
    sessionId = bond.session_id
    registration = mergeInstructionTiers(
      registration,
      await call('attach_connection', { connection_id: connectionId, session_id: sessionId }),
    )
    status = 'reconnected'
  }
  storeTiers(connectionId, registration, { home: projectHome, dir: tierDir })

  const written = await writeState({
    connectionId,
    sessionId,
    agent: agentName,
    projectId: confirmedProject.id,
    projectName: confirmedProject.name,
    cwd,
    localId,
    ownerPid: effectiveOwnerPid,
    codename,
    title: title || registration.session_title || registration.title || null,
    instructionTiers:
      registration.instruction_tiers_hash && registration.instruction_tiers_version
        ? {
            hash: registration.instruction_tiers_hash,
            version: registration.instruction_tiers_version,
          }
        : null,
    connectionCapability,
    noPoller: !!noPoller,
    env,
    home: projectHome,
  })

  storeRepositoryContext(connectionId, registration, { dir: tierDir })

  const effectiveSessionId = written.session_id || null
  const transcript = effectiveSessionId
    ? transcriptPaths(connectionId, effectiveSessionId, tierDir).transcript
    : null
  const resolvedOwnerPid = written.owner_pid
  const cursorFlag = armCursorFlag({ created: registration.created })
  const armCommand =
    `node ${JSON.stringify(WAIT_SCRIPT)} --connection-id ${connectionId}` +
    `${resolvedOwnerPid ? ` --owner-pid ${resolvedOwnerPid}` : ''} ${cursorFlag}`
  const wakeArmed = Boolean(
    !noPoller &&
      written.listener?.ok &&
      (written.agentapi_ready ||
        (env?.ANTIGRAVITY_LS_ADDRESS && env?.ANTIGRAVITY_CSRF_TOKEN)),
  )

  return {
    ok: true,
    status,
    agent_name: agentName,
    codename,
    connection_id: connectionId,
    created: registration.created === true,
    session_id: effectiveSessionId,
    session_access: sessionAccess,
    local_id: localId,
    local_id_source: localIdSource,
    project_id: confirmedProject.id,
    project_selection: projectState,
    project_scope: {
      git_remote: gitRemote,
      pinned_project_id: pin?.project_id || null,
      pin_path: pin?.path || null,
      resolved_by_server: true,
      folder_scope_only: startup ? true : undefined,
    },
    mcp_url: written.mcp_url,
    auth_ok: written.auth_ok,
    auth_source: written.auth_source,
    warning: written.warning || null,
    warning_poller: written.warning_poller || null,
    warning_local: written.warning_local || null,
    poller: written.poller || null,
    listener: written.listener || null,
    wake_armed: wakeArmed,
    bond_action: bond.action,
    state_path: written.path,
    owner_pid: resolvedOwnerPid,
    cursor_flag: cursorFlag,
    arm_command: armCommand,
    connection_capability_present: Boolean(
      connectionCapability || written.plan_capability?.ok,
    ),
    plan_access:
      connectionCapability || written.plan_capability?.ok
        ? 'manage_plan capability ready'
        : 'unavailable — reconnect/update required',
    transcript,
    room_state: roomStatePath(connectionId, projectHome),
    registration,
  }
}

export function renderStatusBlock(
  summary,
  { noPoller = false, saveTiers = saveTiersText, home = os.homedir() } = {},
) {
  const lines = []
  lines.push('━━━ DevSpec Remote Control ━━━')
  lines.push(`Agent:      ${summary.agent_name} · ${summary.codename || short(summary.connection_id)}`)
  lines.push(`Connection: ${short(summary.connection_id)}`)
  if (summary.project_selection) {
    lines.push(
      `Project:    ${summary.project_selection.project?.name || summary.project_id} (${summary.project_selection.source})`,
    )
  }
  lines.push(
    `Session:    ${summary.session_id ? `${short(summary.session_id)}${summary.session_access ? ` (${summary.session_access})` : ''}` : 'none — available'}`,
  )
  lines.push(`Status:     ${summary.status}`)
  lines.push('Open:       Agents page')
  lines.push('Stop with:  /devspec-remote-stop')
  lines.push('─────────────────────────────')

  const poller = summary.poller
  const pollerText = poller?.skipped
    ? 'skipped (--no-poller)'
    : poller?.ok
      ? `running (pid ${poller.pid})`
      : `NOT RUNNING — ${summary.warning_poller || 'unknown'}`
  lines.push(`poller: ${pollerText} · host: ${summary.mcp_url}`)
  lines.push(
    `plans: ${summary.connection_capability_present ? 'manage_plan ready' : 'UNAVAILABLE — server did not negotiate capability v1'}`,
  )
  if (!summary.auth_ok) lines.push(`auth: FAILED — ${summary.warning}`)
  if (!summary.local_id) lines.push(`warning: ${summary.warning_local}`)
  if (!summary.owner_pid && !noPoller) {
    lines.push('warning: no owner pid resolved — pass --owner-pid "$PPID".')
  }

  lines.push('')
  if (summary.wake_armed) {
    const pid = summary.listener?.pid || summary.listener_pid || null
    const listenerPid = pid ? ` (listener pid ${pid})` : ''
    lines.push(
      `wake: ALREADY ARMED${listenerPid} — background listener delivers wakes automatically via agentapi; do NOT run devspec-remote-wait.mjs.`,
    )
  } else {
    lines.push('ARM THE BACKGROUND WAIT NOW (run_command with WaitMsBeforeAsync: 500):')
    lines.push(summary.arm_command)
  }

  if (summary.transcript) {
    lines.push('')
    lines.push(`Room transcript: ${summary.transcript}`)
    lines.push(
      `  The whole room, filled in by the poller. How complete it is: ${summary.room_state} (the room file). Read it when a command needs the room.`,
    )
  }

  const tierDir = path.join(home, '.devspec', 'remote-control', 'connections')
  const repositories = renderRepositoryContext(summary.registration)
  const tiers = renderTiers(summary.registration)
  if (tiers) {
    lines.push(
      summary.registration?.instructions_unchanged
        ? tiers
        : renderTiersPointer(saveTiers(summary.connection_id, tiers, { dir: tierDir })),
    )
  }
  if (repositories) lines.push(repositories)
  return lines.join('\n') + '\n'
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.private && !args.new) {
    process.stderr.write(
      'note: --private only applies with --new (it sets the new session private). Ignored here.\n',
    )
  }
  let summary
  try {
    summary = await connect({
      session: args.session || null,
      project: args.project ?? null,
      new: !!args.new,
      private: !!args.private,
      name: args.name || null,
      title: args.title || null,
      agent: args.agent || null,
      cwd: args.cwd || null,
      ownerPid: args.ownerPid,
      localId: args.localId,
      forceNew: !!args.forceNew,
      noPoller: !!args.noPoller,
    })
  } catch (e) {
    if (e instanceof ConnectError) {
      if (e.projectSelection) {
        process.stdout.write(
          JSON.stringify({
            ok: false,
            code: 'project_choice_required',
            project_selection: e.projectSelection,
          }) + '\n',
        )
      }
      process.stderr.write(`${e.message}\n`)
      process.exit(e.code)
    }
    throw e
  }

  if (args.json) {
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n')
    takeRepositoryContext(summary.connection_id, summary.local_id)
    process.exit(0)
  }
  process.stdout.write(renderStatusBlock(summary, { noPoller: !!args.noPoller }))
  takeRepositoryContext(summary.connection_id, summary.local_id)
  process.exit(0)
}

const isMain =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (isMain) {
  main().catch((e) => {
    process.stderr.write(`devspec-remote-connect failed: ${e?.stack || e?.message || String(e)}\n`)
    process.exit(1)
  })
}
