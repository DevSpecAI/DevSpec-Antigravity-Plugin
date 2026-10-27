#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CONTRACT = 'devspec://product/implementation-contract'
const CURRENT_SURFACES = [
  'rules/AGENTS.md',
  'skills/devspec-remote/SKILL.md',
  'skills/devspec-remote-stop/SKILL.md',
  'scripts/devspec-remote-poll.mjs',
  'scripts/devspec-plan.mjs',
]

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8')
}

describe('MCP-served implementation contract', () => {
  for (const relativePath of CURRENT_SURFACES) {
    it(`${relativePath} points to the canonical runtime contract`, () => {
      assert.ok(read(relativePath).includes(CONTRACT))
    })
  }

  it('keeps mutation-boundary behavior inside honest Antigravity host-limitation notes', () => {
    for (const relativePath of [
      'skills/devspec-remote/SKILL.md',
    ]) {
      const source = read(relativePath)
      const paragraphs = source.split(/\n\s*\n/)
      const boundaryParagraphs = paragraphs.filter((paragraph) =>
        paragraph.includes('mutation boundary'),
      )
      assert.equal(boundaryParagraphs.length, 1, relativePath)
      assert.match(
        source,
        /(?:Antigravity host limitation|## Host limitation)[\s\S]{0,800}mutation boundary/i,
      )
      assert.match(boundaryParagraphs[0], /no verified blocking pre-tool hook/i)
      assert.match(boundaryParagraphs[0], /explicit/i)
      assert.match(boundaryParagraphs[0], /runtime authority|authoritative/i)
    }
  })

  it('contains no stale item-lifecycle restatements in current instruction surfaces', () => {
    // CHANGELOG.md is intentionally historical; its current release entry is checked below.
    const current = [...CURRENT_SURFACES, 'README.md'].map((file) => `${file}\n${read(file)}`).join('\n')
    const stalePhrases = [
      'Nothing is ever sent work',
      'The batch closes itself',
      'There is no batch mode',
      'Only the agent holding an item may claim, release or fail it',
      'ask only what is not yours to decide',
      'do not assume someone is waiting to answer',
      'get_assignment / acknowledge_assignment / resolve_assignment',
    ]
    for (const phrase of stalePhrases) {
      assert.equal(current.includes(phrase), false, `stale lifecycle prose: ${phrase}`)
    }
    assert.doesNotMatch(current, /record_implementation[^\n]{0,100}when done/i)
  })

  it('retains reserve-before-claim ordering for multi-item remote work', () => {
    const skill = read('skills/devspec-remote/SKILL.md')
    const start = skill.indexOf('### 8a.')
    const end = skill.indexOf('### 9.', start)
    assert.ok(start >= 0 && end > start)
    const workEntry = skill.slice(start, end)
    const reserve = workEntry.indexOf('reserve_work_items')
    const claim = workEntry.indexOf('claim_work_item')
    assert.ok(reserve >= 0, 'reserve_work_items instruction is present')
    assert.ok(claim > reserve, 'claim_work_item follows reserve_work_items')
    assert.match(workEntry, /successfully reserved item \*\*in order\*\*/)
  })

  it('keeps Antigravity files independent rather than describing shared or synced tooling', () => {
    const independenceSurface = [
      read('scripts/devspec-remote-wait.mjs'),
      read('scripts/resolve-mcp-auth.mjs'),
    ].join('\n')
    assert.doesNotMatch(independenceSurface, /shares verbatim|SYNCED callers|cross-repo sync pipeline/)
    assert.match(independenceSurface, /owns every plugin file|owns every script in it|owns this script independently/i)
  })

  it('leaves PreInvocation on pre-invocation transport rather than inventing contract injection', () => {
    const hooks = JSON.parse(read('hooks.json'))
    assert.deepEqual(hooks['devspec-remote-control-mirror'].PreInvocation, [
      {
        type: 'command',
        command: 'node ./scripts/pre-invocation.mjs',
        timeout: 10,
      },
    ])
  })

  it('keeps package metadata and the current changelog release aligned', () => {
    const pkg = JSON.parse(read('package.json'))
    const firstRelease = read('CHANGELOG.md').match(/^## (\d+\.\d+\.\d+)$/m)?.[1]
    assert.match(pkg.version, /^\d+\.\d+\.\d+$/)
    assert.equal(firstRelease, pkg.version)
    const currentEntry = read('CHANGELOG.md').split(/^## 0\.8\.0$/m)[0]
    assert.ok(currentEntry.includes(CONTRACT))
  })
})

// The plugin names parts of the served contract instead of restating them ("the
// contract's commit_provenance_contract", `core.waiting-work-stays-on-its-branch`).
// Each name must exist in the contract the server serves. Only names are compared,
// never wording, version or hash, so a clause the server adds to a section (as its
// commit guidance is being extended, item 9d945fcc) cannot break this check; a section
// renamed or removed does. Runs against the devspecv2 checkout DEVSPEC_V2_ROOT names,
// and skips without one, as the server tool-name check does.
const CONTRACT_SOURCE = 'packages/core/src/mcp/implementation-contract.ts'
const NAMING_SURFACES = [
  'rules/AGENTS.md',
  'skills/devspec-remote/SKILL.md',
  'skills/devspec-remote-stop/SKILL.md',
  'scripts/commit-provenance.mjs',
  'scripts/devspec-remote-wait.mjs',
  'README.md',
]

function servedContractNames(root) {
  const tsx = path.join(root, 'node_modules/.bin/tsx')
  assert.ok(fs.existsSync(tsx), `${root} has no node_modules/.bin/tsx; run npm ci there`)
  const script = `import { IMPLEMENTATION_CONTRACT } from ${JSON.stringify(path.join(root, CONTRACT_SOURCE))}
process.stdout.write(JSON.stringify(IMPLEMENTATION_CONTRACT))`
  const contract = JSON.parse(execFileSync(tsx, ['--tsconfig=apps/web/tsconfig.json', '-e', script], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  }))
  const names = new Set()
  const walk = (value) => {
    if (Array.isArray(value)) value.forEach(walk)
    else if (value && typeof value === 'object') {
      for (const [key, inner] of Object.entries(value)) {
        names.add(key)
        if (key === 'id' && typeof inner === 'string') names.add(inner)
        walk(inner)
      }
    }
  }
  walk(contract)
  return names
}

describe('contract parts the plugin names', () => {
  it('all exist in the served implementation contract', (t) => {
    const named = process.env.DEVSPEC_V2_ROOT?.trim()
    const root = named ? path.resolve(named) : path.resolve(ROOT, '..', 'devspecv2')
    if (!fs.existsSync(path.join(root, CONTRACT_SOURCE))) {
      if (named) assert.fail(`DEVSPEC_V2_ROOT names ${root}, which has no ${CONTRACT_SOURCE}`)
      t.skip('no devspecv2 checkout beside this repo')
      return
    }
    const served = servedContractNames(root)
    const used = new Map()
    for (const file of NAMING_SURFACES) {
      for (const match of read(file).matchAll(/\b([a-z]+(?:_[a-z]+)*_(?:contract|rule)|core\.[a-z0-9-]+)\b/g)) {
        if (!used.has(match[1])) used.set(match[1], new Set())
        used.get(match[1]).add(file)
      }
    }
    // A scan that finds neither of these is broken, not clean.
    for (const name of ['commit_provenance_contract', 'work_entry_contract']) assert.ok(used.has(name), `the scan did not find ${name}`)
    const missing = [...used].filter(([name]) => !served.has(name)).map(([name, files]) => `${name} (${[...files].join(', ')})`)
    assert.deepEqual(missing, [], `named here, but the served contract has no such part:\n  ${missing.join('\n  ')}`)
  })
})
