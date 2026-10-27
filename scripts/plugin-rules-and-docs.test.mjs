import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// Antigravity caps each rule file at 24,000 bytes and truncates anything past that
// on line boundaries — its own customization guide, under "Size Limits and Context
// Budget". A rules file over it would lose its last sections without any error.
const ANTIGRAVITY_RULE_FILE_MAX_BYTES = 24_000
const FULL_TRACKING =
  'Full commit tracking — every commit reported to DevSpec and tagged with its task automatically — needs macOS, Linux, or Windows through WSL.'

describe('Item 5 parity: rules/AGENTS.md, package version 0.15.0, and documentation accuracy', () => {
  it("bundles rules/AGENTS.md within Antigravity's per-file rule limit, with core DevSpec contracts and scripts", () => {
    const rulesPath = path.join(ROOT, 'rules', 'AGENTS.md')
    assert.ok(fs.existsSync(rulesPath), 'rules/AGENTS.md must exist so agy loads plugin rules automatically')
    const content = fs.readFileSync(rulesPath, 'utf8')
    assert.ok(
      Buffer.byteLength(content, 'utf8') <= ANTIGRAVITY_RULE_FILE_MAX_BYTES,
      `rules/AGENTS.md is ${Buffer.byteLength(content, 'utf8')} bytes; Antigravity truncates a rule file past ${ANTIGRAVITY_RULE_FILE_MAX_BYTES}`,
    )
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
    // A reply about a DevSpec notice is a notice reply, never a command answer (fdc96b30).
    assert.match(content, /system_notice_ids/)
    assert.match(content, /semantics\.notice_reply/)
    // Which setups get full commit tracking: the same sentence in every DevSpec plugin
    // and the help page, and native Windows stated plainly until it is tested (6da10a3a).
    for (const text of [content, fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8')]) {
      assert.ok(text.includes(FULL_TRACKING), 'the shared full-commit-tracking sentence')
      assert.match(text, /native Windows[^.]*single-line commits only/)
    }
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
    assert.match(readme, /https:\/\/api\.devspec\.ai\/api\/mcp/)
    assert.match(readme, /rules\/AGENTS\.md/)
    assert.match(readme, /Installing the plugin is required alongside the MCP server/)
    assert.match(readme, /local \(\/devspec-remote to connect\)/)
    assert.match(readme, /agy --dangerously-skip-permissions/)
    assert.match(readme, /\/devspec-project/)
    assert.doesNotMatch(readme, /--install-plugin|--update-plugins/)
  })
})
