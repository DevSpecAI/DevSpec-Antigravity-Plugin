import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RULES = path.join(ROOT, 'rules')
// Antigravity truncates any single rule file past 24,000 bytes (after expanding
// `@[label](path)` includes), on line boundaries and without an error: its rules guide,
// https://antigravity.google/docs/rules, "Size limits and token budgets". This is the
// host's ceiling, not a budget of ours (decision 8faf5044): a file that reaches it is
// split into more rule files, never cut.
const ANTIGRAVITY_RULE_FILE_MAX_BYTES = 24_000
// A plugin's `rules/AGENTS.md` (or `GEMINI.md`) is always on and takes no frontmatter;
// every other rule file must open with frontmatter naming one of these triggers, or
// Antigravity silently discards it (same guide, "YAML frontmatter and activation modes").
const ALWAYS_ON_RULE_FILES = new Set(['AGENTS.md', 'GEMINI.md'])
const TRIGGERS = new Set(['always_on', 'model_decision', 'glob', 'manual'])
const FULL_TRACKING =
  'Full commit tracking — every commit reported to DevSpec and tagged with its task automatically — needs macOS, Linux, or Windows through WSL.'

const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8')
const ruleFiles = () => fs.readdirSync(RULES).filter((name) => name.endsWith('.md'))
const allRules = () => ruleFiles().map((name) => read('rules', name)).join('\n')
const skills = () => fs.readdirSync(path.join(ROOT, 'skills')).map((skill) => read('skills', skill, 'SKILL.md'))

/** The frontmatter of a rule file as key → value, or null when it has none. */
function frontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text)
  if (!match) return null
  const fields = {}
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([a-z_]+):\s*(.*)$/.exec(line)
    if (field) fields[field[1]] = field[2].trim().replace(/^"(.*)"$/, '$1')
  }
  return fields
}

describe('the rule files Antigravity loads from this plugin', () => {
  it("each fits Antigravity's per-file limit, so none is cut off", () => {
    for (const name of ruleFiles()) {
      const bytes = Buffer.byteLength(read('rules', name), 'utf8')
      assert.ok(
        bytes <= ANTIGRAVITY_RULE_FILE_MAX_BYTES,
        `rules/${name} is ${bytes} bytes; Antigravity truncates a rule file past ${ANTIGRAVITY_RULE_FILE_MAX_BYTES}: split it into another rule file`,
      )
    }
  })

  it('each is one Antigravity will load: AGENTS.md always on, every other file with a valid trigger', () => {
    assert.ok(ruleFiles().includes('AGENTS.md'), 'rules/AGENTS.md must exist so agy loads plugin rules automatically')
    // Antigravity reads only the files directly in rules/; one in a subfolder is ignored.
    assert.deepEqual(fs.readdirSync(RULES, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((d) => d.name), [])
    for (const name of ruleFiles()) {
      const fields = frontmatter(read('rules', name))
      if (ALWAYS_ON_RULE_FILES.has(name)) {
        assert.equal(fields, null, `rules/${name} is always on and takes no frontmatter`)
        continue
      }
      assert.ok(fields, `rules/${name} needs YAML frontmatter, or Antigravity discards it`)
      assert.ok(TRIGGERS.has(fields.trigger), `rules/${name}: trigger "${fields.trigger}" is not one Antigravity knows`)
      if (fields.trigger === 'model_decision') assert.ok(fields.description, `rules/${name}: a model_decision rule needs a description`)
      if (fields.trigger === 'glob') assert.ok(fields.globs || fields.glob, `rules/${name}: a glob rule needs globs`)
    }
  })

  it('every DevSpec rule file the rules and skills send the agent to exists', () => {
    const named = new Set()
    for (const text of [allRules(), ...skills(), read('README.md')]) {
      for (const match of text.matchAll(/\b(devspec-[a-z0-9-]+\.md)\b/g)) named.add(match[1])
    }
    assert.ok(named.has('devspec-records.md'), 'the scan found no rule file names: it is broken, not clean')
    const missing = [...named].filter((name) => !ruleFiles().includes(name))
    assert.deepEqual(missing, [], `named, but not in rules/: ${missing.join(', ')}`)
  })

  it('carry the core DevSpec contracts and scripts', () => {
    const rules = allRules()
    assert.match(rules, /devspec:\/\/product\/implementation-contract/)
    assert.match(rules, /devspec:\/\/product\/remote-ingress-contract/)
    assert.match(rules, /devspec-remote-connect\.mjs/)
    assert.match(rules, /devspec-remote-wait\.mjs/)
    assert.match(rules, /room-unread\.mjs/)
    assert.match(rules, /\.transcript\.jsonl/)
    assert.match(rules, /\.room\.json/)
    assert.match(rules, /complete_turn:\s*true/)
    // A reply about a DevSpec notice is a notice reply, never a command answer (fdc96b30).
    assert.match(rules, /system_notice_ids/)
    assert.match(rules, /semantics\.notice_reply/)
    // Whether anything is said in the room is DevSpec's label, and a check-job ruling
    // never is: both point at the served contract rather than restate it (a868f41f).
    for (const text of [rules, read('skills', 'devspec-remote', 'SKILL.md')]) {
      assert.match(text, /semantics\.notice_audience/)
      assert.match(text, /semantics\.notice_reply/)
      assert.match(text, /unresolved choice, hold, rejection, or block/)
      assert.match(text, /check_job\.room/)
      assert.match(text, /tell_person/)
      // Whose duplicate it is, and who is told, are core.resolve-duplicates-on-the-spot's:
      // a restatement here contradicted the server the moment that rule changed.
      assert.doesNotMatch(text, /or one they may change|close yours as its duplicate/)
    }
    assert.match(read('skills', 'devspec-remote', 'SKILL.md'), /served contract's `core\.resolve-duplicates-on-the-spot`/)
    // Which setups get full commit tracking: the same sentence in every DevSpec plugin
    // and the help page, and native Windows stated plainly until it is tested (6da10a3a).
    for (const text of [read('rules', 'AGENTS.md'), read('README.md')]) {
      assert.ok(text.includes(FULL_TRACKING), 'the shared full-commit-tracking sentence')
      assert.match(text, /native Windows[^.]*single-line commits only/)
    }
    assert.match(rules, /never pass `provenance_ref`/i)
    assert.match(rules, /wake: ALREADY ARMED/)
    assert.match(rules, /rearm:\s*"already_armed"/)
    assert.match(rules, /core\.push-safely/)
    assert.match(rules, /merge_when_cleared/)
  })

  it("name the clear-to-merge wake as DevSpec sends it, and nothing it never sends", () => {
    // DevSpec sends it as topic pr_merge_when_cleared, notice type
    // merge_when_cleared_fallback (core git/checks/pr-merge-when-cleared.ts). An earlier
    // name, pr_ready_to_merge, existed nowhere on the server.
    assert.match(read('rules', 'AGENTS.md'), /pr_merge_when_cleared/)
    for (const text of [allRules(), ...skills(), read('README.md')]) {
      assert.doesNotMatch(text, /pr_ready_to_merge/)
    }
  })
})

describe('package version and documentation accuracy', () => {
  it('opens CHANGELOG.md with the version package.json and plugin.json ship', () => {
    const pkg = JSON.parse(read('package.json'))
    const plugin = JSON.parse(read('plugin.json'))
    assert.equal(plugin.version, pkg.version)
    assert.equal(read('CHANGELOG.md').match(/^## (\S+)/m)?.[1], pkg.version)
  })

  it('sets up with the plugin and browser approval only: no settings file to edit, no token, and no non-existent agy flags', () => {
    const readme = read('README.md')
    assert.match(readme, /https:\/\/api\.devspec\.ai\/api\/mcp/)
    assert.match(readme, /local \(\/devspec-remote to connect\)/)
    assert.match(readme, /agy plugin install https:\/\/github\.com\/DevSpecAI\/DevSpec-Antigravity-Plugin/)
    assert.match(readme, /agy --dangerously-skip-permissions/)
    assert.match(readme, /\/devspec-project/)
    assert.match(readme, /\/devspec-login/)
    // Sign-in is browser approval and nothing else, on every customer surface.
    for (const text of [readme, ...skills(), read('rules', 'AGENTS.md')]) {
      assert.doesNotMatch(text, /Bearer [a-z]|dvs_|YOUR_DEVSPEC|DEVSPEC_MCP_TOKEN|access token|paste (?:your|the) (?:DevSpec )?token/i)
      assert.doesNotMatch(text, /(?:open|edit|merge)[^.\n]*~\/\.gemini\/config\/mcp_config\.json/i)
    }
    assert.doesNotMatch(readme, /--install-plugin|--update-plugins/)
  })
})
