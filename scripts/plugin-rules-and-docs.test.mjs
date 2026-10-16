import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

describe('Item 5 parity: rules/AGENTS.md, package version 0.15.0, and documentation accuracy', () => {
  it('bundles rules/AGENTS.md under the 24KB Antigravity rule cap with core DevSpec contracts and scripts', () => {
    const rulesPath = path.join(ROOT, 'rules', 'AGENTS.md')
    assert.ok(fs.existsSync(rulesPath), 'rules/AGENTS.md must exist so agy loads plugin rules automatically')
    const content = fs.readFileSync(rulesPath, 'utf8')
    assert.ok(Buffer.byteLength(content, 'utf8') < 24_000, 'rules/AGENTS.md must stay under the 24KB per-file cap')
    assert.match(content, /devspec:\/\/product\/implementation-contract/)
    assert.match(content, /devspec:\/\/product\/remote-ingress-contract/)
    assert.match(content, /devspec-remote-connect\.mjs/)
    assert.match(content, /devspec-remote-wait\.mjs/)
    assert.match(content, /room-unread\.mjs/)
    assert.match(content, /\.transcript\.jsonl/)
    assert.match(content, /\.room\.json/)
    assert.match(content, /supersede_memory/)
    assert.match(content, /create_resource/)
    assert.match(content, /update_resource/)
    assert.match(content, /manage_discussion_point/)
    assert.match(content, /complete_turn:\s*true/)
    assert.match(content, /never pass `provenance_ref`/)
    assert.match(content, /wake: ALREADY ARMED/)
    assert.match(content, /rearm:\s*"already_armed"/)
  })

  it('opens CHANGELOG.md with the version package.json ships', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
    const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8')
    assert.equal(changelog.match(/^## (\S+)/m)?.[1], pkg.version)
  })

  it('documents ~/.gemini/config/mcp_config.json and why the plugin is required in README.md and has no non-existent agy flags', () => {
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8')
    assert.match(readme, /~\/\.gemini\/config\/mcp_config\.json/)
    assert.match(readme, /rules\/AGENTS\.md/)
    assert.match(readme, /Installing the plugin is required alongside the MCP server/)
    assert.match(readme, /local \(\/devspec-remote to connect\)/)
    assert.match(readme, /devspec-remote-connect\.mjs/)
    assert.match(readme, /room-unread\.mjs/)
    assert.doesNotMatch(readme, /--install-plugin|--update-plugins/)

    const antigravityDoc = fs.readFileSync(
      path.join(ROOT, 'docs', 'remote-control', 'remote-control-antigravity.md'),
      'utf8',
    )
    assert.match(antigravityDoc, /devspec-remote-connect\.mjs/)
    assert.match(antigravityDoc, /room-transcript\.mjs/)
    assert.match(antigravityDoc, /hook-output\.mjs/)
    assert.match(antigravityDoc, /session-title\.mjs/)
    assert.match(antigravityDoc, /rules\/AGENTS\.md/)
  })
})
