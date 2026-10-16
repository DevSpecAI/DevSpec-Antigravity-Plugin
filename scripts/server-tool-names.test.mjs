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

let serverTools = null
/** The server's tools, each with the names of its input parameters. */
function serverToolParams(root) {
  if (serverTools) return serverTools
  const tsx = path.join(root, 'node_modules/.bin/tsx')
  assert.ok(fs.existsSync(tsx), `${root} has no node_modules/.bin/tsx; run npm ci there`)
  const script = `import { getMcpAllTools } from ${JSON.stringify(path.join(root, DEFINITIONS))}
process.stdout.write(JSON.stringify(getMcpAllTools().map((tool) => [tool.name, Object.keys(tool.inputSchema?.properties ?? {})])))`
  const out = execFileSync(tsx, ['--tsconfig=apps/web/tsconfig.json', '-e', script], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  serverTools = new Map(JSON.parse(out))
  return serverTools
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
    const server = pairedServer(t)
    if (!server) return
    const found = referencedNames()
    for (const name of MUST_FIND) assert.ok(found.has(name), `the scan did not find ${name}: it is broken, not clean`)
    const unknown = [...found]
      .filter(([name]) => !server.has(name) && !NOT_DEVSPEC_TOOLS.has(name))
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
