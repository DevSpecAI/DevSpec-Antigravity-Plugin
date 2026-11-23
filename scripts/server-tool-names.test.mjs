#!/usr/bin/env node
// Every DevSpec tool this plugin tells an agent to call must exist on the server.
//
// The skills, commands, hooks and docs name DevSpec tools, and nothing else checks
// those names against the server: retire or rename a tool there and this plugin
// keeps telling the agent to call it, which fails only at run time, in someone's
// session. This reads the live tool list from a devspecv2 checkout beside this
// repo and fails on any name the server does not have.
//
// With no checkout beside it the test skips, because CI has no pair. Name one
// with DEVSPEC_V2_ROOT; once named, it must be there.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { PROVENANCE_REF_TOOLS, REQUEST_REF_TOOLS } from './request-ref.mjs'

const SELF = fileURLToPath(import.meta.url)
const ROOT = path.resolve(path.dirname(SELF), '..')
const DEFINITIONS = 'apps/web/lib/mcp/tool-definitions.ts'

// Names the scan matches that are not DevSpec tools, each with the reason.
const NOT_DEVSPEC_TOOLS = new Map([])

// The connect path names both of these. A scan that misses them is broken, not clean.
const MUST_FIND = ['register_connection', 'poll_connection']

const NAME = '([a-z][a-z0-9]*(?:_[a-z0-9]+)+)'
const PATTERNS = [
  // A qualified name: mcp__plugin_devspec_devspec__<tool>, mcp__devspec__<tool>, devspec__<tool>.
  new RegExp(`(?<![a-z0-9_])(?:mcp__[a-z0-9_]*?)?devspec(?:_devspec)?__${NAME}`, 'g'),
  // A JSON-RPC tools/call: name: '<tool>', arguments.
  new RegExp(`name['"]?\\s*:\\s*['"]${NAME}['"]\\s*,\\s*['"]?arguments`, 'g'),
  // Prose that calls one: `<tool>(`.
  new RegExp(`\`${NAME}\\(`, 'g'),
  // Prose that names one to use: call `<tool>`, use `<tool>`, via `<tool>`.
  new RegExp(`\\b(?:[Cc]all|[Cc]alling|[Cc]alls|[Uu]se|[Uu]sing|[Vv]ia|[Rr]un|MCP)\\s+\`${NAME}\``, 'g'),
]
const SCANNED = /\.(md|mjs|cjs|js|mts|ts|json|toml|ya?ml)$/

function serverCheckout() {
  const named = process.env.DEVSPEC_V2_ROOT?.trim()
  if (named) return { root: path.resolve(named), named: true }
  // The directories that hold this repo, nearest first. Only ever up, never a walk down.
  for (let dir = path.dirname(ROOT); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'devspecv2')
    if (fs.existsSync(path.join(candidate, DEFINITIONS))) return { root: candidate, named: false }
    if (path.dirname(dir) === dir) return { root: null, named: false }
  }
}

let serverSchemas = null
/** The server's tools, each with its input schema. */
function serverToolSchemas(root) {
  if (serverSchemas) return serverSchemas
  const tsx = path.join(root, 'node_modules/.bin/tsx')
  assert.ok(fs.existsSync(tsx), `${root} has no node_modules/.bin/tsx; run npm ci there`)
  const script = `import { getMcpAllTools } from ${JSON.stringify(path.join(root, DEFINITIONS))}
process.stdout.write(JSON.stringify(getMcpAllTools().map((tool) => [tool.name, tool.inputSchema ?? {}])))`
  const out = execFileSync(tsx, ['--tsconfig=apps/web/tsconfig.json', '-e', script], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  serverSchemas = new Map(JSON.parse(out))
  return serverSchemas
}
/** The server's tools, each with the names of its input parameters. */
function serverToolParams(root) {
  const schemas = serverToolSchemas(root)
  return new Map([...schemas].map(([name, schema]) => [name, Object.keys(schema.properties ?? {})]))
}
function serverToolNames(root) {
  return new Set(serverToolParams(root).keys())
}

function referencedNames() {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0')
  const found = new Map()
  for (const file of files) {
    // The changelog names retired tools on purpose: it is history.
    if (!SCANNED.test(file) || path.basename(file) === 'CHANGELOG.md') continue
    if (file.split('/').includes('node_modules')) continue
    const full = path.join(ROOT, file)
    if (full === SELF || !fs.existsSync(full)) continue
    const text = fs.readFileSync(full, 'utf8')
    for (const pattern of PATTERNS) {
      for (const match of text.matchAll(pattern)) {
        const at = found.get(match[1]) ?? new Set()
        at.add(file)
        found.set(match[1], at)
      }
    }
  }
  return found
}

function pairedServer(t, read = serverToolNames) {
  const checkout = serverCheckout()
  if (checkout.root && fs.existsSync(path.join(checkout.root, DEFINITIONS))) return read(checkout.root)
  if (checkout.named) assert.fail(`DEVSPEC_V2_ROOT names ${checkout.root}, which has no ${DEFINITIONS}`)
  t.skip('no devspecv2 checkout beside this repo')
  return null
}

describe('DevSpec tools this plugin names', () => {
  it('are all tools the server has', (t) => {
    const tools = pairedServer(t, serverToolParams)
    if (!tools) return
    // Prose also names a tool's parameters the same way ("connect them via
    // `parent_task_id`"). A name the server has as a parameter is not a missing
    // tool; a name it has as neither still fails, so retired tools stay caught.
    const parameters = new Set([...tools.values()].flat())
    const found = referencedNames()
    for (const name of MUST_FIND) assert.ok(found.has(name), `the scan did not find ${name}: it is broken, not clean`)
    const unknown = [...found]
      .filter(([name]) => !tools.has(name) && !parameters.has(name) && !NOT_DEVSPEC_TOOLS.has(name))
      .map(([name, files]) => `${name} (${[...files].sort().join(', ')})`)
    assert.deepEqual(unknown, [], `named here, but the server has no such tool:\n  ${unknown.join('\n  ')}`)
  })

  it('set aside only names that are still used and are still not DevSpec tools', (t) => {
    const server = pairedServer(t)
    if (!server) return
    const found = referencedNames()
    for (const name of NOT_DEVSPEC_TOOLS.keys()) {
      assert.ok(found.has(name), `${name} is set aside but nothing here names it any more; remove it`)
      assert.ok(!server.has(name), `${name} is set aside but it is a DevSpec tool now; remove it so it is checked`)
    }
  })
})

// PreToolUse stamps request_ref and provenance_ref only on the tools these sets name
// (request-ref.mjs). A server tool that gains either parameter and is missing here
// gets no stamp, so its writes cannot say whose request they serve; one named here
// that lost it would be refused for an unknown argument. Nothing else compares them.
describe('the tools PreToolUse stamps with the request a write serves', () => {
  const taking = (tools, param) => [...tools].filter(([, params]) => params.includes(param)).map(([name]) => name).sort()

  it('are exactly the server tools that take request_ref', (t) => {
    const tools = pairedServer(t, serverToolParams)
    if (!tools) return
    assert.deepEqual([...REQUEST_REF_TOOLS].sort(), taking(tools, 'request_ref'))
  })

  it('are exactly the server tools that take provenance_ref', (t) => {
    const tools = pairedServer(t, serverToolParams)
    if (!tools) return
    assert.deepEqual([...PROVENANCE_REF_TOOLS].sort(), taking(tools, 'provenance_ref'))
  })
})

// The DevSpec tool references in rules/ tell the agent to call DevSpec tools from the
// shapes they give, without reading their schema files (Antigravity loads MCP schemas
// lazily, so each read is a step). That makes those shapes the agent's schema, so they
// must match the server's: no parameter the tool lacks, every required one present and
// not marked optional, only values the server allows, and every parameter the agent
// may need, so a parameter the server adds is never invisible to the agent. Nested
// object shapes, and arrays of them, are checked the same way (items 1df99dd4, cf356677).
const RULES_DIR = 'rules'
const SHAPE_ENTRY = /`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`: `(\{[^`]*\})`/g
// A scan that finds none of these is broken, not clean.
const MUST_SHAPE = ['create_task', 'record_criterion_verdicts', 'manage_protected_intent', 'update_memory', 'record_inventory_entry', 'record_dependency_review']
// Parameters the references describe once, in each file's opening notes, rather than
// on every shape: what PreToolUse stamps, the project hints, and the claim reference.
const DESCRIBED_ONCE = new Set([
  'connection_id', 'project_id', 'local_session_id', 'agent_name', 'request_ref', 'provenance_ref',
  'git_remote', 'pinned_project_id', 'work_claim_ref',
])
// Parameters the plugin or DevSpec fills in on a tool, which its shape tells the agent
// never to pass.
const FILLED_IN_FOR_THE_AGENT = new Map([
  // The turn a reply answers, its trail, telemetry and local-turn flags (PreToolUse,
  // mirror-turn.mjs); the room is the connection's.
  ['post_session_message', new Set(['session_id', 'command_turn_id', 'command_message_id', 'command_turn_unbound', 'local_turn', 'turn_kind', 'phase', 'needs_input', 'work_trail', 'trail_events', 'agent_stats', 'model'])],
  // PreToolUse stamps provider: antigravity.
  ['claim_work_item', new Set(['provider'])],
])

/** A schema's object form: itself, or the object alternative of a nullable union. */
function objectSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema
  if (schema.properties) return schema
  for (const alternative of schema.anyOf ?? schema.oneOf ?? []) {
    if (alternative?.properties) return alternative
  }
  return schema
}

/** The values a schema allows, through a nullable union, or null when it is not an enum. */
function enumValues(schema) {
  if (!schema || typeof schema !== 'object') return null
  if (Array.isArray(schema.enum)) return schema.enum
  if (schema.const !== undefined) return [schema.const]
  const alternatives = schema.anyOf ?? schema.oneOf
  if (!alternatives) return null
  const values = alternatives.flatMap((alternative) => enumValues(alternative) ?? [])
  return values.length > 0 ? values : null
}

/** The item schema of an array schema, through a nullable union. */
function itemsOf(schema) {
  if (schema?.items) return schema.items
  for (const alternative of schema?.anyOf ?? schema?.oneOf ?? []) {
    if (alternative?.items) return alternative.items
  }
  return null
}

const hostOnly = (schema) => JSON.stringify(schema ?? {}).includes('x-devspec-host-only')

function splitTopLevel(body) {
  const parts = []
  let depth = 0
  let quoted = false
  let current = ''
  for (const ch of body) {
    if (ch === '"') quoted = !quoted
    if (!quoted && '{[('.includes(ch)) depth++
    if (!quoted && '}])'.includes(ch)) depth--
    if (ch === ',' && depth === 0 && !quoted) {
      parts.push(current.trim())
      current = ''
    } else current += ch
  }
  if (current.trim()) parts.push(current.trim())
  return parts
}

function quotedValues(type) {
  return [...type.matchAll(/"([^"]+)"/g)].map((match) => match[1])
}

function shapeProblems(shape, rawSchema, where, { complete = false, omitted = new Set() } = {}) {
  const problems = []
  const schema = objectSchema(rawSchema)
  const properties = schema?.properties ?? {}
  const body = shape.trim().replace(/^\{/, '').replace(/\}$/, '').trim()
  const given = new Map()
  for (const part of body ? splitTopLevel(body) : []) {
    const match = /^([a-z][a-z0-9_]*)(\?)?(?:\s*:\s*([\s\S]+))?$/.exec(part)
    if (!match) {
      problems.push(`${where}: cannot read "${part}"`)
      continue
    }
    const [, name, optional, type = ''] = match
    given.set(name, { optional: Boolean(optional) })
    const property = properties[name]
    if (!property) {
      problems.push(`${where}.${name}: the server has no such parameter`)
      continue
    }
    if (type.startsWith('{')) problems.push(...shapeProblems(type, property, `${where}.${name}`, { complete }))
    else if (type.startsWith('[{')) problems.push(...shapeProblems(type.slice(1, -1), itemsOf(property), `${where}.${name}[]`, { complete }))
    else if (type.startsWith('"') || type.startsWith('["')) {
      const allowed = type.startsWith('[') ? enumValues(itemsOf(property)) : enumValues(property)
      for (const value of quotedValues(type)) {
        if (!allowed?.includes(value)) problems.push(`${where}.${name}: the server does not allow "${value}"`)
      }
    }
  }
  for (const name of schema?.required ?? []) {
    if (!given.has(name)) problems.push(`${where}.${name}: required by the server but missing`)
    else if (given.get(name).optional) problems.push(`${where}.${name}: required by the server but marked optional`)
  }
  if (complete) {
    for (const [name, property] of Object.entries(properties)) {
      if (given.has(name) || hostOnly(property) || DESCRIBED_ONCE.has(name) || omitted.has(name)) continue
      problems.push(`${where}.${name}: the server takes it, and the shape does not show it`)
    }
  }
  return problems
}

function shapeEntries() {
  const entries = []
  for (const name of fs.readdirSync(path.join(ROOT, RULES_DIR)).filter((file) => file.endsWith('.md'))) {
    const file = `${RULES_DIR}/${name}`
    for (const [, tool, shape] of fs.readFileSync(path.join(ROOT, file), 'utf8').matchAll(SHAPE_ENTRY)) {
      entries.push({ file, tool, shape })
    }
  }
  return entries
}

describe('the call shapes the DevSpec tool references in rules/ give', () => {
  it('match the server input schemas', (t) => {
    const schemas = pairedServer(t, serverToolSchemas)
    if (!schemas) return
    const entries = shapeEntries()
    const named = new Set(entries.map(({ tool }) => tool))
    for (const tool of MUST_SHAPE) assert.ok(named.has(tool), `found no shape for ${tool}: the scan is broken, not clean`)
    const problems = []
    for (const { file, tool, shape } of entries) {
      if (!schemas.has(tool)) problems.push(`${file}: ${tool}: the server has no such tool`)
      else problems.push(...shapeProblems(shape, schemas.get(tool), `${file}: ${tool}`))
    }
    assert.deepEqual(problems, [], `the rules give call shapes the server would refuse:\n  ${problems.join('\n  ')}`)
  })

  it('show every parameter the agent may pass, at every level', (t) => {
    const schemas = pairedServer(t, serverToolSchemas)
    if (!schemas) return
    const problems = []
    for (const { file, tool, shape } of shapeEntries()) {
      if (!schemas.has(tool)) continue
      problems.push(...shapeProblems(shape, schemas.get(tool), `${file}: ${tool}`, {
        complete: true,
        omitted: FILLED_IN_FOR_THE_AGENT.get(tool),
      }))
    }
    assert.deepEqual(problems, [], `the server takes parameters the rules never show the agent:\n  ${problems.join('\n  ')}`)
  })

  it('give each tool one shape', () => {
    const seen = new Map()
    const twice = []
    for (const { file, tool } of shapeEntries()) {
      if (seen.has(tool)) twice.push(`${tool} (${seen.get(tool)}, ${file})`)
      else seen.set(tool, file)
    }
    assert.deepEqual(twice, [], `one tool, two shapes that can drift apart:\n  ${twice.join('\n  ')}`)
  })
})
