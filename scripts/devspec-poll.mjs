#!/usr/bin/env node
/**
 * Capability-safe MCP describe/use bridge for the connection-bound manage_poll tool.
 *
 * Same shape and same reason as devspec-plan.mjs: Antigravity cannot add a header the
 * connect script learned to a later native MCP call, so connect stores the hidden
 * capability in mode-0600 connection state and this bridge injects it mechanically.
 * Only manage_poll is reachable here; poll/heartbeat/delivery pump verbs stay private.
 *
 * Modelled on the PLAN bridge, deliberately not the question one (item f4dd7be1). A poll
 * is not a blocking agent driver: creating, updating or ending one must never open, hold
 * or complete an activity attempt, set awaiting_input, claim a reply channel, or keep the
 * room showing Working. There is no vote action here either — voting is something people
 * do in the UI, and `recommendation_index` is advice, not a ballot.
 *
 * Usage:
 *   node devspec-poll.mjs describe --connection-id <uuid>
 *   node devspec-poll.mjs use --connection-id <uuid> --input '{"action":"list"}'
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mcpToolsCall, mcpToolsList } from './mcp-call.mjs'
import { readPrivateJson } from './private-state.mjs'
import { isEntryPoint } from './entry-point.mjs'

const CONNECTIONS_DIR = path.join(os.homedir(), '.devspec', 'remote-control', 'connections')
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const TOOL = 'manage_poll'

const MANAGE_POLL_ACTIONS = new Set([
  'create',
  'list',
  'get',
  'update',
  'end',
  'retract',
  'supersede',
])
const READ_ACTIONS = new Set(['list', 'get'])
/** Every existing-poll mutation: needs the poll's identity AND its current revision. */
const EXISTING_POLL_ACTIONS = new Set(['update', 'end', 'retract', 'supersede'])
/** Retry idempotency is the caller's job on the two actions that mint a poll row. */
const CLIENT_REQUEST_ID_ACTIONS = new Set(['create', 'supersede'])

const MANAGE_POLL_PROPERTIES = new Set([
  'action',
  'poll_id',
  'expected_revision',
  'client_request_id',
  'question',
  'options',
  'recommendation_index',
  'multi_select',
  'allow_write_in',
  'series_id',
  'series_label',
  'reason',
  'status',
])
const LIST_STATUSES = new Set(['all', 'active', 'ended', 'retracted', 'superseded'])
const MIN_OPTIONS = 2
const MAX_OPTIONS = 30

export function parseArgs(argv) {
  const out = { command: null, connectionId: null, input: null }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (!out.command && (arg === 'describe' || arg === 'use')) out.command = arg
    else if (arg === '--schema') {
      if (!out.command) out.command = 'describe'
    } else if (arg === '--connection-id' || arg === '--connection_id') out.connectionId = argv[++index]
    else if (arg === '--input' || arg === '--json') out.input = argv[++index]
  }
  return out
}

export function validateManagePollArguments(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'manage_poll input must be a JSON object' }
  }
  if (!MANAGE_POLL_ACTIONS.has(input.action)) {
    return { ok: false, error: 'unknown manage_poll action' }
  }
  const unknown = Object.keys(input).find((key) => !MANAGE_POLL_PROPERTIES.has(key))
  if (unknown) {
    return { ok: false, error: `unknown manage_poll property: ${unknown}` }
  }

  if (EXISTING_POLL_ACTIONS.has(input.action)) {
    if (typeof input.poll_id !== 'string' || !input.poll_id.trim()) {
      return { ok: false, error: `${input.action} requires poll_id` }
    }
    if (!Number.isSafeInteger(input.expected_revision) || input.expected_revision < 1) {
      return { ok: false, error: 'existing-poll mutations require expected_revision' }
    }
  } else if (Object.hasOwn(input, 'expected_revision') && !READ_ACTIONS.has(input.action)) {
    return { ok: false, error: 'expected_revision applies only to an existing poll' }
  }

  if (CLIENT_REQUEST_ID_ACTIONS.has(input.action) && typeof input.client_request_id !== 'string') {
    return { ok: false, error: `${input.action} requires a caller-generated client_request_id` }
  }
  if (input.action === 'retract' && (typeof input.reason !== 'string' || !input.reason.trim())) {
    return { ok: false, error: 'retract requires a reason' }
  }

  if (Object.hasOwn(input, 'options')) {
    if (!Array.isArray(input.options)) return { ok: false, error: 'options must be an array' }
    if (input.options.some((option) => typeof option !== 'string' || !option.trim())) {
      return { ok: false, error: 'every option must be a non-empty string' }
    }
    if (input.options.length < MIN_OPTIONS || input.options.length > MAX_OPTIONS) {
      return {
        ok: false,
        error: `options must have between ${MIN_OPTIONS} and ${MAX_OPTIONS} entries`,
      }
    }
  }
  if (input.action === 'create' && !Array.isArray(input.options)) {
    return { ok: false, error: 'create requires options' }
  }
  if (input.action === 'create' && (typeof input.question !== 'string' || !input.question.trim())) {
    return { ok: false, error: 'create requires a question' }
  }

  if (Object.hasOwn(input, 'recommendation_index')) {
    const index = input.recommendation_index
    if (!Number.isSafeInteger(index) || index < 0) {
      return { ok: false, error: 'recommendation_index must be a 0-based option index' }
    }
    if (Array.isArray(input.options) && index >= input.options.length) {
      return { ok: false, error: 'recommendation_index is outside the options' }
    }
  }

  if (
    Object.hasOwn(input, 'series_id') &&
    (typeof input.series_label !== 'string' || !input.series_label.trim())
  ) {
    return { ok: false, error: 'series_id requires series_label' }
  }
  if (Object.hasOwn(input, 'status') && !LIST_STATUSES.has(input.status)) {
    return { ok: false, error: 'unknown status filter' }
  }
  for (const key of ['multi_select', 'allow_write_in']) {
    if (Object.hasOwn(input, key) && typeof input[key] !== 'boolean') {
      return { ok: false, error: `${key} must be a boolean` }
    }
  }
  return { ok: true }
}

export function readPollConnectionState(connectionId, dir = CONNECTIONS_DIR) {
  if (typeof connectionId !== 'string' || !UUID.test(connectionId)) {
    throw new Error('missing or invalid --connection-id')
  }
  const statePath = path.join(dir, `${connectionId}.json`)
  const state = readPrivateJson(statePath)
  if (!state) throw new Error('connection state is unavailable or unreadable')
  if (state.connection_id !== connectionId || state.enabled === false) {
    throw new Error('connection state is unavailable or disabled')
  }
  if (!state.session_id) throw new Error('manage_poll requires an attached DevSpec session')
  if (!state.token || !state.mcp_url) throw new Error('connection MCP authentication is unavailable')
  if (!state.connection_capability) {
    throw new Error('connection poll capability is unavailable; reconnect with the current plugin')
  }
  return state
}

export function managePollRequestOptions(state) {
  return {
    mcpUrl: state.mcp_url,
    token: state.token,
    connectionCapability: state.connection_capability,
    timeoutMs: 30_000,
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.command) throw new Error('expected describe or use')
  const state = readPollConnectionState(args.connectionId)
  const options = managePollRequestOptions(state)

  if (args.command === 'describe') {
    const tools = await mcpToolsList(options)
    const tool = tools.find((candidate) => candidate?.name === TOOL)
    if (!tool) throw new Error(`server did not advertise ${TOOL}`)
    process.stdout.write(JSON.stringify(tool, null, 2) + '\n')
    return
  }

  const raw = args.input ?? fs.readFileSync(0, 'utf8')
  let input
  try {
    input = JSON.parse(raw)
  } catch {
    throw new Error('use requires valid JSON via --input or stdin')
  }
  const validation = validateManagePollArguments(input)
  if (!validation.ok) throw new Error(validation.error)
  const result = await mcpToolsCall({ ...options, name: TOOL, arguments: input })
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
}

const isMain = isEntryPoint(import.meta.url)
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`devspec-poll: ${error?.message || String(error)}\n`)
    process.exit(1)
  })
}
