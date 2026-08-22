#!/usr/bin/env node
/**
 * On-demand Antigravity bridge for the schema-complete DevSpec manage_plan tool.
 * WHEN planning is warranted comes only from devspec://product/implementation-contract.
 * This file retains mechanics because Antigravity cannot attach a rotated dynamic
 * connection-capability header to a model-issued native MCP call.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mcpToolsCall } from './mcp-call.mjs'

const REMOTE_CONTROL_DIR = path.join(os.homedir(), '.devspec', 'remote-control')
const CONNECTIONS_DIR = path.join(REMOTE_CONTROL_DIR, 'connections')
const LOCAL_DIR = path.join(REMOTE_CONTROL_DIR, 'local')
const LEGACY_STATE_PATH = path.join(os.homedir(), '.devspec', 'remote-control.json')
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const ACTIONS = [
  'create', 'list', 'get', 'update', 'start_step', 'complete_step', 'skip_step',
  'fail_step', 'advance', 'complete', 'abandon', 'adopt',
]
const MUTATIONS = new Set([
  'update', 'start_step', 'complete_step', 'skip_step', 'fail_step', 'advance',
  'complete', 'abandon', 'adopt',
])
const ACTION_PROPERTIES = {
  list: ['action'],
  get: ['action', 'plan_id'],
  create: ['action', 'title', 'steps'],
  update: ['action', 'plan_id', 'expected_revision', 'steps'],
  start_step: ['action', 'plan_id', 'expected_revision', 'step_id'],
  complete_step: ['action', 'plan_id', 'expected_revision', 'step_id'],
  skip_step: ['action', 'plan_id', 'expected_revision', 'step_id'],
  fail_step: ['action', 'plan_id', 'expected_revision', 'step_id', 'reason', 'retryable'],
  advance: ['action', 'plan_id', 'expected_revision', 'steps', 'current_step_id', 'next_step_id'],
  complete: ['action', 'plan_id', 'expected_revision'],
  abandon: ['action', 'plan_id', 'expected_revision', 'reason'],
  adopt: ['action', 'plan_id', 'expected_revision'],
}
const ACTION_REQUIRED = {
  list: ['action'],
  get: ['action'],
  create: ['action', 'title', 'steps'],
  update: ['action', 'expected_revision', 'steps'],
  start_step: ['action', 'expected_revision', 'step_id'],
  complete_step: ['action', 'expected_revision', 'step_id'],
  skip_step: ['action', 'expected_revision', 'step_id'],
  fail_step: ['action', 'expected_revision', 'step_id', 'reason', 'retryable'],
  advance: ['action', 'expected_revision'],
  complete: ['action', 'expected_revision'],
  abandon: ['action', 'expected_revision', 'reason'],
  adopt: ['action', 'plan_id', 'expected_revision'],
}
const UUID_PATTERN = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
const STEP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    description: { type: 'string' },
  },
  required: ['title'],
}
const PROPERTY_SCHEMAS = {
  plan_id: { type: 'string', pattern: UUID_PATTERN },
  expected_revision: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
  title: { type: 'string', pattern: '\\S' },
  steps: { type: 'array', maxItems: 50, items: STEP_SCHEMA },
  step_id: { type: 'string' },
  current_step_id: { type: 'string' },
  next_step_id: { type: 'string' },
  reason: { type: 'string' },
  retryable: { type: 'boolean' },
}
function actionSchema(action) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: Object.fromEntries(ACTION_PROPERTIES[action].map((property) => [
      property,
      property === 'action'
        ? { const: action }
        : property === 'steps' && action === 'create'
          ? { ...PROPERTY_SCHEMAS.steps, minItems: 1 }
          : property === 'reason' && action === 'abandon'
            ? { ...PROPERTY_SCHEMAS.reason, pattern: '\\S' }
            : PROPERTY_SCHEMAS[property],
    ])),
    required: ACTION_REQUIRED[action],
  }
}

/** Exact discriminated runtime shapes; no identity/provenance/project fields exist. */
export const MANAGE_PLAN_SCHEMA = {
  oneOf: ACTIONS.map(actionSchema),
}

function validateSteps(steps, { requireOne = false } = {}) {
  if (!Array.isArray(steps) || steps.length > 50 || (requireOne && steps.length === 0)) {
    return requireOne
      ? 'steps must contain between 1 and 50 milestones'
      : 'steps must be an array of at most 50 milestones'
  }
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index]
    if (!step || typeof step !== 'object' || Array.isArray(step)) return `step ${index} must be an object`
    const extras = Object.keys(step).filter((key) => !['id', 'title', 'description'].includes(key))
    if (extras.length) return `unsupported step property: ${extras[0]}`
    if (typeof step.title !== 'string') return `step ${index} requires title`
    if (step.id !== undefined && typeof step.id !== 'string') return `step ${index} id must be a string`
    if (step.description !== undefined && typeof step.description !== 'string') {
      return `step ${index} description must be a string`
    }
  }
  return null
}

export function validateManagePlanArguments(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'manage_plan input must be an object'
  if (!ACTIONS.includes(input.action)) return 'unsupported manage_plan action'
  const allowed = new Set(ACTION_PROPERTIES[input.action])
  const extras = Object.keys(input).filter((key) => !allowed.has(key))
  if (extras.length) return `unsupported property for ${input.action}: ${extras[0]}`
  if (input.plan_id !== undefined && (typeof input.plan_id !== 'string' || !UUID.test(input.plan_id))) {
    return 'plan_id must be a full UUID'
  }
  if (MUTATIONS.has(input.action) && (!Number.isSafeInteger(input.expected_revision) || input.expected_revision < 1)) {
    return 'existing-plan mutations require a positive expected_revision'
  }
  if (input.action === 'adopt' && !input.plan_id) return 'adopt requires explicit plan_id'
  if (input.action === 'create') {
    if (typeof input.title !== 'string' || !input.title.trim()) return 'create requires title'
    const error = validateSteps(input.steps, { requireOne: true })
    if (error) return `create requires title and at least one step: ${error}`
  }
  if (input.action === 'update') {
    if (input.steps === undefined) return 'update requires steps'
    const error = validateSteps(input.steps)
    if (error) return error
  }
  if (input.action === 'advance' && input.steps !== undefined) {
    const error = validateSteps(input.steps)
    if (error) return error
  }
  if (['start_step', 'complete_step', 'skip_step', 'fail_step'].includes(input.action) &&
      typeof input.step_id !== 'string') return `${input.action} requires step_id`
  if (input.action === 'fail_step' && (typeof input.reason !== 'string' || typeof input.retryable !== 'boolean')) {
    return 'fail_step requires reason and retryable'
  }
  if (input.action === 'abandon' && (typeof input.reason !== 'string' || !input.reason.trim())) {
    return 'abandon requires reason'
  }
  for (const key of ['current_step_id', 'next_step_id']) {
    if (input[key] !== undefined && typeof input[key] !== 'string') return `${key} must be a string`
  }
  return null
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}
function agentSlug(name) {
  return String(name || 'agent').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'agent'
}
function bondPath(state) {
  const localId = String(state.local_id).trim().replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 128)
  if (!localId || localId !== state.local_id) return null
  return path.join(LOCAL_DIR, agentSlug(state.agent_name), `${localId}.json`)
}

export function readPlanState(
  connectionId = null,
  { readState = readJson, readBond = readJson } = {},
) {
  if (connectionId !== null && (typeof connectionId !== 'string' || !UUID.test(connectionId))) return null
  const state = connectionId
    ? readState(path.join(CONNECTIONS_DIR, `${connectionId}.json`))
    : readState(LEGACY_STATE_PATH)
  if (!state || state.enabled !== true || !state.connection_id ||
      (connectionId && state.connection_id !== connectionId) ||
      typeof state.local_id !== 'string' || !state.local_id || typeof state.agent_name !== 'string') return null
  const localBondPath = bondPath(state)
  if (!localBondPath) return null
  const bond = readBond(localBondPath)
  if (!bond || bond.status !== 'live' || bond.connection_id !== state.connection_id ||
      (bond.local_id && bond.local_id !== state.local_id)) return null
  return { ...state, bond_verified: true }
}

export async function callManagePlan(input, { state, call = mcpToolsCall } = {}) {
  const error = validateManagePlanArguments(input)
  if (error) throw new Error(error)
  if (state?.enabled !== true || state?.bond_verified !== true || !state?.connection_id) {
    throw new Error('manage_plan requires an enabled connection with a matching live conversation bond')
  }
  if (!state.session_id) throw new Error('manage_plan requires an attached DevSpec remote connection')
  if (!state.token || !state.mcp_url) throw new Error('manage_plan requires resolved DevSpec MCP auth')
  if (state.connection_capability_version !== 1 ||
      typeof state.connection_capability !== 'string' || !state.connection_capability.startsWith('dvsc_')) {
    throw new Error('manage_plan requires connection capability version 1; rerun devspec-remote state write')
  }
  return call({
    mcpUrl: state.mcp_url,
    token: state.token,
    name: 'manage_plan',
    arguments: input,
    connectionCapability: state.connection_capability,
    timeoutMs: 15_000,
  })
}

function parseCli(argv) {
  let connectionId = null
  let schema = false
  const rest = []
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--connection-id') connectionId = argv[++index]
    else if (argv[index] === '--schema') schema = true
    else rest.push(argv[index])
  }
  return { connectionId, schema, rest }
}

const isMain = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) {
  const cli = parseCli(process.argv.slice(2))
  if (cli.schema) {
    process.stdout.write(JSON.stringify(MANAGE_PLAN_SCHEMA, null, 2) + '\n')
    process.exit(0)
  }
  let raw = cli.rest.join(' ').trim()
  if (!raw && !process.stdin.isTTY) raw = fs.readFileSync(0, 'utf8').trim()
  if (!raw) {
    process.stderr.write('Usage: devspec-plan.mjs [--connection-id <uuid>] \'{"action":"..."}\'\nUse --schema to discover the complete input schema.\n')
    process.exit(2)
  }
  try {
    const input = JSON.parse(raw)
    const state = readPlanState(cli.connectionId)
    const result = await callManagePlan(input, { state })
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  } catch (error) {
    process.stderr.write(`devspec-plan: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  }
}
