#!/usr/bin/env node
/**
 * Request-chain state machine for the Antigravity DevSpec plugin.
 *
 * Tracks open requests (`command` from room dispatches and `typed_prompt` from
 * terminal input), background launches (`run_command`, `invoke_subagent`,
 * `schedule`), and multi-requester turn ambiguity per connection in an
 * append-only JSONL log (`~/.devspec/remote-control/connections/<id>.requests.jsonl`).
 *
 * Imports only Node built-ins.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { ensurePrivateDir } from './private-state.mjs'
import { isEntryPoint } from './entry-point.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const KEY = /^[A-Za-z0-9_.:-]{1,128}$/
const ENDED_STATUSES = new Set(['completed', 'failed', 'killed', 'stopped', 'cancelled', 'canceled', 'error'])
const CRON_PROMPT_CLIP = 1000
const ROTATE_BYTES = 64 * 1024

export const NO_REQUEST = 'none'
export const UNSTATED = 'unstated'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const SERVE_REQUEST_SCRIPT = path.join(HERE, 'devspec-serve-request.mjs')

export function requestLogPath(connectionId, dir = path.join(os.homedir(), '.devspec', 'remote-control', 'connections')) {
  return path.join(dir, `${connectionId}.requests.jsonl`)
}

export function appendRequestEvent(
  connectionId,
  event,
  { dir = path.join(os.homedir(), '.devspec', 'remote-control', 'connections'), now = Date.now() } = {}
) {
  if (!connectionId || !event?.op) return false
  try {
    ensurePrivateDir(dir)
    fs.appendFileSync(
      requestLogPath(connectionId, dir),
      `${JSON.stringify({ ...event, at: new Date(now).toISOString() })}\n`,
      { mode: 0o600 }
    )
    return true
  } catch {
    return false
  }
}

function carriedRef(ref) {
  return ref === NO_REQUEST || ref === UNSTATED || UUID.test(ref ?? '')
}

function uuids(value) {
  return Array.isArray(value) ? value.filter((id) => UUID.test(id ?? '')) : []
}

export function reduceRequestLog(text) {
  const open = new Map()
  const started = new Set()
  const launches = new Map()
  const aliases = new Map()
  const schedules = []
  let current = null
  let joined = new Set()
  let chosen = false
  const launchOf = (key) => launches.get(key) ?? launches.get(aliases.get(key))

  for (const line of String(text || '').split('\n')) {
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    switch (event?.op) {
      case 'open':
        if (UUID.test(event.id ?? '')) {
          open.set(event.id, {
            kind: event.kind,
            ...(event.message_id ? { message_id: event.message_id } : {}),
            ...(event.provenance_ref ? { provenance_ref: event.provenance_ref } : {}),
            ...(event.requested_by ? { requested_by: event.requested_by } : {}),
          })
        }
        break
      case 'close':
        open.delete(event.id)
        started.delete(event.id)
        joined.delete(event.id)
        if (current === event.id) current = null
        break
      case 'current':
        current = event.ref === NO_REQUEST || UUID.test(event.ref ?? '') ? event.ref : null
        joined = new Set()
        chosen = false
        if (UUID.test(current ?? '')) started.add(current)
        break
      case 'joined':
        if (carriedRef(event.id) && event.id !== current) {
          joined.add(event.id)
          chosen = false
          if (UUID.test(event.id)) started.add(event.id)
        }
        break
      case 'serve':
        if (carriedRef(event.ref)) {
          current = event.ref === UNSTATED ? null : event.ref
          chosen = true
          if (UUID.test(current ?? '')) started.add(current)
        }
        break
      case 'launch':
        if (KEY.test(event.key ?? '') && carriedRef(event.request)) {
          launches.set(event.key, {
            key: event.key,
            request: event.request,
            also: uuids(event.also),
            kind: String(event.kind || 'unknown'),
            notifies: event.notifies !== false,
            notified: false,
            absent: 0,
          })
          if (KEY.test(event.alias ?? '')) aliases.set(event.alias, event.key)
        }
        break
      case 'notified': {
        const launch = launchOf(event.key)
        if (launch) launch.notified = true
        break
      }
      case 'absent': {
        const launch = launchOf(event.key)
        if (launch) launch.absent += 1
        break
      }
      case 'schedule':
        if (typeof event.prompt === 'string' && event.prompt.trim() && carriedRef(event.request)) {
          schedules.push({
            prompt: event.prompt.trim(),
            request: event.request,
            also: uuids(event.also),
            id: KEY.test(event.id ?? '') ? event.id : null,
          })
        }
        break
      default:
        break
    }
  }
  for (const [alias, key] of aliases) {
    if (!launches.has(alias) && launches.has(key)) launches.set(alias, launches.get(key))
  }
  return { open, started, launches, schedules, current, joined, chosen }
}

export function readRequestState(
  connectionId,
  { dir = path.join(os.homedir(), '.devspec', 'remote-control', 'connections') } = {}
) {
  let text = ''
  try {
    text = fs.readFileSync(requestLogPath(connectionId, dir), 'utf8')
  } catch {
    /* no log yet */
  }
  return reduceRequestLog(text)
}

export async function openRequest({
  connectionId,
  kind,
  provenanceRef = null,
  messageId = null,
  call,
  dir = path.join(os.homedir(), '.devspec', 'remote-control', 'connections'),
  id = randomUUID(),
}) {
  if (!connectionId || (kind !== 'command' && kind !== 'typed_prompt')) return null
  if (kind === 'command') {
    if (!UUID.test(provenanceRef ?? '')) return null
    for (const [existing, info] of readRequestState(connectionId, { dir }).open) {
      if (info.provenance_ref === provenanceRef) return existing
    }
  }
  let result
  try {
    result = await call({
      connection_id: connectionId,
      action: 'open',
      request_id: id,
      kind,
      ...(kind === 'command' ? { provenance_ref: provenanceRef } : {}),
    })
  } catch {
    return null
  }
  const requestId = UUID.test(result?.request_id ?? '') ? result.request_id : null
  if (!requestId || result.status !== 'open') return null
  appendRequestEvent(
    connectionId,
    {
      op: 'open',
      id: requestId,
      kind,
      ...(kind === 'command' ? { provenance_ref: provenanceRef } : {}),
      ...(UUID.test(messageId ?? '') ? { message_id: messageId } : {}),
      ...(UUID.test(result.requested_by_user_id ?? '') ? { requested_by: result.requested_by_user_id } : {}),
    },
    { dir }
  )
  return requestId
}

export async function closeRequest({
  connectionId,
  requestId,
  reason = 'host_finished',
  call,
  dir = path.join(os.homedir(), '.devspec', 'remote-control', 'connections'),
}) {
  if (!connectionId || !UUID.test(requestId ?? '')) return false
  let closed = false
  try {
    const result = await call({ connection_id: connectionId, action: 'close', request_id: requestId, reason })
    closed = result?.status === 'closed'
  } catch (error) {
    closed = /unknown request/i.test(String(error?.message ?? error))
  }
  return closed ? appendRequestEvent(connectionId, { op: 'close', id: requestId }, { dir }) : false
}

export function setCurrentRequest(
  connectionId,
  ref,
  { dir = path.join(os.homedir(), '.devspec', 'remote-control', 'connections') } = {}
) {
  if (ref === UNSTATED) return appendRequestEvent(connectionId, { op: 'current', ref: null }, { dir })
  if (ref !== NO_REQUEST && !UUID.test(ref ?? '')) return false
  return appendRequestEvent(connectionId, { op: 'current', ref }, { dir })
}

function tag(text, name) {
  const match = String(text || '').match(new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`))
  return match ? match[1] : null
}

function ownerMessageIds(text) {
  const ids = []
  for (const line of String(text || '').split('\n')) {
    const start = line.indexOf('{')
    if (start < 0 || !line.includes('owner_message')) continue
    try {
      const event = JSON.parse(line.slice(start))
      if (event?.type === 'owner_message' && UUID.test(event.message_id ?? '')) ids.push(event.message_id)
    } catch {
      const match = line.match(/"message_id":"([0-9a-f-]{36})"/i)
      if (match && UUID.test(match[1])) ids.push(match[1])
    }
  }
  return ids
}

export function commandRequestsInWake(text, state) {
  const refs = []
  if (!state?.open) return refs
  for (const messageId of ownerMessageIds(text)) {
    for (const [id, info] of state.open) {
      if (info.message_id === messageId && !refs.includes(id)) refs.push(id)
    }
  }
  return refs
}

function carriedBy(entry, state) {
  return {
    ref: state.open.has(entry.request) || entry.request === NO_REQUEST ? entry.request : UNSTATED,
    also: (entry.also ?? []).filter((id) => state.open.has(id) && id !== entry.request),
  }
}

export function requestForWake({ origin, text, state }) {
  const kind = typeof origin === 'string' ? origin : origin?.kind
  if (kind === 'task-notification') {
    for (const key of [tag(text, 'task-id'), tag(text, 'tool-use-id')]) {
      const launch = key ? state.launches.get(key) : null
      if (launch) return carriedBy(launch, state)
    }
    const commands = commandRequestsInWake(text, state)
    if (commands.length > 0) return { ref: commands.at(-1), also: commands.slice(0, -1) }
    if (ownerMessageIds(text).length > 0) return { ref: UNSTATED, also: [] }
    if (/"type"\s*:\s*"automation_run"/.test(String(text || ''))) return { ref: NO_REQUEST, also: [] }
    return { ref: UNSTATED, also: [] }
  }
  if (kind === 'scheduled-trigger') {
    const prompt = String(text || '').trim()
    const matched = [...state.schedules].reverse().filter((schedule) => schedule.prompt === prompt)
    if (matched.length === 0) return { ref: UNSTATED, also: [] }
    const first = carriedBy(matched[0], state)
    const also = new Set(first.also)
    for (const schedule of matched.slice(1)) {
      const other = carriedBy(schedule, state)
      for (const id of [other.ref, ...other.also]) {
        if (id !== first.ref && (UUID.test(id) || id === NO_REQUEST)) also.add(id)
      }
    }
    return { ref: first.ref, also: [...also] }
  }
  return { ref: UNSTATED, also: [] }
}

export function notifiedKeys(text) {
  return [tag(text, 'task-id'), tag(text, 'tool-use-id')].filter((key) => key && KEY.test(key))
}

export function promptArrival({ fromAPerson, origin, text, midTurn = false, state, newId = randomUUID }) {
  const events = []
  if (fromAPerson) {
    const id = newId()
    events.push(midTurn ? { op: 'joined', id } : { op: 'current', ref: id })
    return { events, typedId: id }
  }
  const { ref, also } = requestForWake({ origin, text, state })
  if (midTurn) {
    for (const id of [ref, ...also]) events.push({ op: 'joined', id })
  } else {
    events.push({ op: 'current', ref: ref === UNSTATED ? null : ref })
    for (const id of also) events.push({ op: 'joined', id })
  }
  const kind = typeof origin === 'string' ? origin : origin?.kind
  if (kind === 'task-notification') {
    for (const key of notifiedKeys(text)) events.push({ op: 'notified', key })
  }
  return { events, typedId: null }
}

/**
 * Record the active request(s) in `<connectionId>.requests.jsonl` when a remote inbox
 * batch (`canonical_commands`, `automation_run`, or legacy `owner_messages`) is delivered
 * by `devspec-remote-wait.mjs` or `devspec-remote-listen.mjs`.
 *
 * In Antigravity, background `devspec-remote-wait.mjs` wakes resume the model without
 * invoking `PreInvocation`, so recording `op: 'current'` at wake delivery guarantees
 * `requestRefForWrite` and `provenanceRefForWrite` resolve the active request during the turn.
 */
export function recordDeliveredBatchRequests(
  connectionId,
  batch,
  { dir = path.join(os.homedir(), '.devspec', 'remote-control', 'connections') } = {},
) {
  if (!connectionId || !batch || typeof batch !== 'object') return []
  const events = []
  if (Array.isArray(batch)) {
    const state = readRequestState(connectionId, { dir })
    const refs = []
    for (const item of batch) {
      const msgId = item?.message_id ?? item?.message?.id ?? null
      const provRef = item?.provenance_ref ?? item?.message?.provenance_ref ?? null
      for (const [id, info] of state.open) {
        if (
          ((msgId && info.message_id === msgId) || (provRef && info.provenance_ref === provRef)) &&
          !refs.includes(id)
        ) {
          refs.push(id)
        }
      }
    }
    if (refs.length > 0) {
      events.push({ op: 'current', ref: refs.at(-1) })
      for (const id of refs.slice(0, -1)) events.push({ op: 'joined', id })
    }
  } else if (batch.type === 'canonical_commands') {
    const state = readRequestState(connectionId, { dir })
    const executeIds = Array.isArray(batch.execute_message_ids)
      ? batch.execute_message_ids
      : Array.isArray(batch.ingress?.command_message_ids)
        ? batch.ingress.command_message_ids
        : []
    const refs = []
    for (const messageId of executeIds) {
      for (const [id, info] of state.open) {
        if (info.message_id === messageId && !refs.includes(id)) refs.push(id)
      }
    }
    if (refs.length > 0) {
      events.push({ op: 'current', ref: refs.at(-1) })
      for (const id of refs.slice(0, -1)) events.push({ op: 'joined', id })
    } else if (executeIds.length > 0) {
      events.push({ op: 'current', ref: null })
    }
  } else if (batch.type === 'automation_run') {
    events.push({ op: 'current', ref: NO_REQUEST })
  } else if (batch.type === 'owner_messages') {
    events.push({ op: 'current', ref: null })
  }
  for (const event of events) {
    appendRequestEvent(connectionId, event, { dir })
  }
  return events
}

export function requestRefForWrite(state, agentId = null) {
  if (!state) return null
  if (agentId) {
    const launch = state.launches.get(agentId)
    if (launch) return state.open.has(launch.request) || launch.request === NO_REQUEST ? launch.request : null
  }
  if (state.current === NO_REQUEST) return NO_REQUEST
  return state.current && state.open.has(state.current) ? state.current : null
}

export function provenanceRefForWrite(state, agentId = null) {
  if (!state) return null
  const ref = requestRefForWrite(state, agentId)
  if (!ref || ref === NO_REQUEST) return null
  const info = state.open.get(ref)
  return typeof info?.provenance_ref === 'string' && UUID.test(info.provenance_ref) ? info.provenance_ref : null
}

function attributionOf(info) {
  return `${info.requested_by ?? 'unknown'}:${info.kind === 'typed_prompt' ? 'terminal' : 'room'}`
}

export function turnAmbiguity(state, agentId = null) {
  if (!state || state.chosen || state.joined.size === 0) return null
  if (agentId && state.launches.has(agentId)) return null
  const entries = []
  const add = (ref, current) => {
    if (entries.some((entry) => entry.id === (ref ?? UNSTATED))) return
    if (ref === NO_REQUEST) entries.push({ id: NO_REQUEST, kind: 'none', current, attribution: 'nobody' })
    else if (ref === UNSTATED || ref === null) entries.push({ id: UNSTATED, kind: 'unstated', current, attribution: 'unknown' })
    else if (state.open.has(ref)) {
      const info = state.open.get(ref)
      entries.push({
        id: ref,
        kind: info.kind,
        ...(info.message_id ? { message_id: info.message_id } : {}),
        current,
        attribution: attributionOf(info),
      })
    }
  }
  add(state.current, true)
  for (const id of state.joined) add(id, false)
  if (new Set(entries.map((entry) => entry.attribution)).size < 2) return null
  return entries.map(({ attribution: _attribution, ...entry }) => entry)
}

export function requestForLaunch(state, agentId = null) {
  const ref = requestRefForWrite(state, agentId) ?? UNSTATED
  const also = (turnAmbiguity(state, agentId) ?? [])
    .map((entry) => entry.id)
    .filter((id) => UUID.test(id) && id !== ref)
  return { request: ref, also }
}

function cronIsSchedule(cron, schedule) {
  if (schedule.id && cron?.id === schedule.id) return true
  const listed = typeof cron?.prompt === 'string' ? cron.prompt.trim() : ''
  if (!listed) return false
  if (listed === schedule.prompt) return true
  const kept = listed.replace(/(…|\.\.\.)$/, '')
  return listed.length >= CRON_PROMPT_CLIP - 3 && schedule.prompt.startsWith(kept)
}

export function requestsWithWorkPending(state, { backgroundTasks = null, sessionCrons = null } = {}) {
  const pending = new Set()
  const listed = new Map()
  for (const task of Array.isArray(backgroundTasks) ? backgroundTasks : []) {
    if (task && typeof task.id === 'string') listed.set(task.id, String(task.status || '').toLowerCase())
  }
  const hold = (entry) => {
    for (const id of [entry.request, ...(entry.also ?? [])]) if (state.open.has(id)) pending.add(id)
  }
  for (const launch of new Set(state.launches.values())) {
    const status = listed.get(launch.key)
    if (status !== undefined && !ENDED_STATUSES.has(status)) hold(launch)
    else if (
      launch.notifies &&
      !launch.notified &&
      !(status === undefined && Array.isArray(backgroundTasks) && launch.absent >= 1)
    ) {
      hold(launch)
    }
  }
  const crons = Array.isArray(sessionCrons) ? sessionCrons : []
  for (const schedule of state.schedules) {
    if (crons.some((cron) => cronIsSchedule(cron, schedule))) hold(schedule)
  }
  return pending
}

export function absentLaunches(state, backgroundTasks) {
  if (!Array.isArray(backgroundTasks)) return []
  const listed = new Set(backgroundTasks.map((task) => task?.id).filter((id) => typeof id === 'string'))
  return [...new Set(state.launches.values())]
    .filter((launch) => launch.notifies && !launch.notified && state.open.has(launch.request) && !listed.has(launch.key))
    .map((launch) => launch.key)
}

export function rotateRequestLog(
  connectionId,
  { dir = path.join(os.homedir(), '.devspec', 'remote-control', 'connections'), minBytes = ROTATE_BYTES } = {}
) {
  const file = requestLogPath(connectionId, dir)
  try {
    if (fs.statSync(file).size < minBytes) return false
    const state = reduceRequestLog(fs.readFileSync(file, 'utf8'))
    if (state.open.size > 0) return false
    fs.renameSync(file, `${file}.1`)
    for (const launch of new Set(state.launches.values())) {
      if (launch.request === NO_REQUEST && launch.notifies && !launch.notified) {
        appendRequestEvent(
          connectionId,
          { op: 'launch', key: launch.key, kind: launch.kind, notifies: true, request: NO_REQUEST, also: [] },
          { dir }
        )
      }
    }
    for (const schedule of state.schedules) {
      if (schedule.request === NO_REQUEST) {
        appendRequestEvent(
          connectionId,
          { op: 'schedule', prompt: schedule.prompt, id: schedule.id, request: NO_REQUEST, also: [] },
          { dir }
        )
      }
    }
    return true
  } catch {
    return false
  }
}

export function isDevSpecListener(toolInput) {
  const cmd = String(toolInput?.command || toolInput?.CommandLine || '')
  return cmd.includes('devspec-remote-wait.mjs') || cmd.includes('devspec-remote-listen.mjs')
}

/**
 * Whether a tool call is about to start background work that outlives the call:
 * Antigravity native tools (`invoke_subagent`, `run_command`, `schedule`) as well
 * as Claude Code / generic equivalents (`Bash`, `Agent`, `Monitor`, `Workflow`,
 * `ScheduleWakeup`, `CronCreate`).
 */
export function startsBackgroundWork(toolName, toolInput) {
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {}
  const name = String(toolName || '').replace(/^default_api:/, '')
  switch (name) {
    case 'invoke_subagent':
    case 'schedule':
    case 'Workflow':
    case 'ScheduleWakeup':
    case 'CronCreate':
      return true
    case 'run_command':
      if (isDevSpecListener(input)) return false
      return (
        input.IsDaemon === true ||
        input.run_in_background === true ||
        input.background === true ||
        (typeof input.WaitMsBeforeAsync === 'number' && input.WaitMsBeforeAsync <= 500)
      )
    case 'Bash':
    case 'Agent':
      return input.run_in_background === true
    case 'Monitor':
      return !isDevSpecListener(input)
    default:
      return false
  }
}

export function launchForRequest(toolName, toolInput, toolResponse, toolUseId = null) {
  const res = toolResponse && typeof toolResponse === 'object' ? toolResponse : null
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {}
  const id = (value) => (typeof value === 'string' && KEY.test(value) ? value : null)
  const alias = id(toolUseId)
  const name = String(toolName || '').replace(/^default_api:/, '')
  if (!res) return null
  switch (name) {
    case 'invoke_subagent': {
      const sub = Array.isArray(res.subagents) ? res.subagents[0] : res
      const key = id(sub?.conversationId ?? sub?.conversation_id ?? res.agentId ?? res.taskId ?? toolUseId)
      return key ? { key, alias, kind: 'subagent', notifies: true } : null
    }
    case 'run_command': {
      if (isDevSpecListener(input)) return null
      const key = id(res.taskId ?? res.task_id ?? res.backgroundTaskId)
      return key ? { key, alias, kind: 'shell', notifies: true } : null
    }
    case 'schedule': {
      const prompt = String(input.Prompt ?? input.prompt ?? '').trim()
      return prompt ? { schedule: true, prompt, id: id(res.taskId ?? res.id) } : null
    }
    case 'Bash': {
      const key = id(res.backgroundTaskId)
      return key ? { key, alias, kind: 'shell', notifies: res.backgroundEndsWithFinalResponse !== true } : null
    }
    case 'Agent': {
      if (res.status === 'async_launched' && id(res.agentId)) return { key: res.agentId, alias, kind: 'subagent', notifies: true }
      if (res.status === 'remote_launched' && id(res.taskId)) return { key: res.taskId, alias, kind: 'subagent', notifies: true }
      return null
    }
    default:
      return null
  }
}

export function serveCommand(connectionId, scriptPath = SERVE_REQUEST_SCRIPT) {
  return `node ${JSON.stringify(scriptPath)} serve --connection-id ${connectionId}`
}

export function servableCarried(state, carried) {
  if (!carried?.some((entry) => entry.kind === 'none')) return carried
  const owners = new Set(
    [...state.open.values()].filter((info) => info.kind === 'typed_prompt').map((info) => info.requested_by)
  )
  const teammateOpen = [...state.open.values()].some(
    (info) => info.kind === 'command' && !owners.has(info.requested_by)
  )
  if (!teammateOpen) return carried
  const choices = carried.filter((entry) => entry.kind !== 'none')
  if (!choices.some((entry) => entry.kind === 'unstated')) {
    choices.push({ id: UNSTATED, kind: 'unstated', current: false })
  }
  return choices
}

export function describeCarried(entry) {
  if (entry.kind === 'none') return "- nobody's request (your own initiative): --none"
  if (entry.kind === 'unstated') {
    return "- something DevSpec could not identify (the write is recorded as unattributed; how it is judged is the contract's requester_rule): --unstated"
  }
  if (entry.kind === 'typed_prompt') return '- the prompt your owner typed at this terminal: --terminal'
  return `- the room command with message_id ${entry.message_id ?? '(unknown)'}: --message-id ${entry.message_id ?? '<id>'}`
}

export function undecidedTurnMessage(connectionId, carried, what = 'this change', scriptPath = SERVE_REQUEST_SCRIPT) {
  return [
    `This turn carries more than one request, and they would be recorded differently (different people, or the same person here and in a room). DevSpec records who asked for ${what}.`,
    'Say which request it serves, then make the call again. Run:',
    `  ${serveCommand(connectionId, scriptPath)} <one of>`,
    ...carried.map(describeCarried),
    'What you do next follows that request until another reaches you. Name each request before its work when you switch.',
  ].join('\n')
}

export function serveMain(
  argv,
  { dir = path.join(os.homedir(), '.devspec', 'remote-control', 'connections') } = {}
) {
  const args = argv[0] === 'serve' ? argv.slice(1) : argv
  const value = (flag) => {
    const at = args.indexOf(flag)
    return at >= 0 && typeof args[at + 1] === 'string' ? args[at + 1] : null
  }
  const connectionId = value('--connection-id')
  if (!UUID.test(connectionId ?? '')) {
    return { ok: false, error: 'serve needs --connection-id <your connection id>' }
  }
  const requestId = value('--request-id')
  const messageId = value('--message-id')
  const flags = {
    terminal: args.includes('--terminal'),
    none: args.includes('--none'),
    unstated: args.includes('--unstated'),
  }
  if ([Boolean(requestId), Boolean(messageId), flags.terminal, flags.none, flags.unstated].filter(Boolean).length !== 1) {
    return {
      ok: false,
      error: 'serve needs exactly one of --message-id <id>, --request-id <id>, --terminal, --none or --unstated',
    }
  }
  const state = readRequestState(connectionId, { dir })
  const carried = servableCarried(state, turnAmbiguity(state))
  if (!carried) {
    return { ok: false, error: 'Nothing to choose: this turn carries one request, and your writes already name it.' }
  }
  const entry = [...carried].reverse().find((candidate) =>
    requestId
      ? candidate.id === requestId
      : messageId
        ? candidate.message_id === messageId
        : flags.terminal
          ? candidate.kind === 'typed_prompt'
          : flags.none
            ? candidate.kind === 'none'
            : candidate.kind === 'unstated'
  )
  if (!entry) {
    return {
      ok: false,
      error: `That is not one of the requests this turn carries. Choose one of:\n${carried.map(describeCarried).join('\n')}`,
    }
  }
  if (!appendRequestEvent(connectionId, { op: 'serve', ref: entry.id }, { dir })) {
    return { ok: false, error: 'could not record it' }
  }
  return {
    ok: true,
    request_ref: entry.id,
    serving: describeCarried(entry).replace(/^- /, '').replace(/: --.*$/, ''),
  }
}

const isMain = isEntryPoint(import.meta.url)
if (isMain && (process.argv[2] === 'serve' || process.argv.includes('--connection-id'))) {
  const result = serveMain(process.argv.slice(2))
  process.stdout.write(`${JSON.stringify(result)}\n`)
  process.exit(result.ok ? 0 : 1)
}
