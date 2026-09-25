#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CONTRACT = 'devspec://product/implementation-contract'
const CURRENT_SURFACES = [
  'README.md',
  'docs/remote-control/remote-control-antigravity.md',
  'docs/remote-control/remote-control-overview.md',
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
      'README.md',
      'docs/remote-control/remote-control-antigravity.md',
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
    const current = CURRENT_SURFACES.map((file) => `${file}\n${read(file)}`).join('\n')
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
      read('docs/remote-control/remote-control-antigravity.md'),
      read('docs/remote-control/remote-control-overview.md'),
      read('scripts/devspec-remote-wait.mjs'),
      read('scripts/resolve-mcp-auth.mjs'),
    ].join('\n')
    assert.doesNotMatch(independenceSurface, /shares verbatim|SYNCED callers|cross-repo sync pipeline/)
    assert.match(independenceSurface, /owns every plugin file|owns this script independently/i)
  })

  it('leaves UserPromptSubmit on mirror-turn transport rather than inventing contract injection', () => {
    const hooks = JSON.parse(read('hooks.json'))
    assert.deepEqual(hooks['devspec-remote-control-mirror'].UserPromptSubmit, [
      {
        type: 'command',
        command: 'node "./scripts/mirror-turn.mjs" user_prompt',
        timeout: 30,
      },
    ])
  })

  it('keeps package metadata and the current changelog release aligned', () => {
    const pkg = JSON.parse(read('package.json'))
    const firstRelease = read('CHANGELOG.md').match(/^## (\d+\.\d+\.\d+)$/m)?.[1]
    assert.equal(pkg.version, '0.11.2')
    assert.equal(firstRelease, pkg.version)
    const currentEntry = read('CHANGELOG.md').split(/^## 0\.8\.0$/m)[0]
    assert.ok(currentEntry.includes(CONTRACT))
  })
})
