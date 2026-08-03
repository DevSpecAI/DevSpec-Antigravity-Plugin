#!/usr/bin/env node
/**
 * Identity is a fixed property of THIS plugin, and this test is what pins it.
 *
 * The DevSpec plugins are independent implementations — no file crosses a repo
 * boundary, and there is no sync tool that could regenerate this. So the guarantee
 * that used to come from central generation lives here instead: same protection
 * against item `f99bc20b` (a plugin registering under another plugin's name), no
 * cross-repo copying.
 *
 * Run: node --test scripts/agent-identity.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { AGENT_NAME } from './agent-identity.mjs'

/** This repo's plugin. Changing this line is changing which plugin this is. */
const OWN_NAME = 'Antigravity'

/** Every other DevSpec plugin. None of these may appear as a literal in our scripts. */
const RIVAL_NAMES = ['Claude Code', 'Cursor', 'Grok Build', 'Codex', 'OpenCode']

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** Sibling implementation scripts — tests and the identity module itself excluded. */
function siblingScripts() {
  return fs
    .readdirSync(HERE)
    .filter((f) => f.endsWith('.mjs'))
    .filter((f) => !f.endsWith('.test.mjs') && f !== 'agent-identity.mjs')
    .sort()
}

describe('AGENT_NAME', () => {
  it('is this plugin, not another one', () => {
    assert.equal(AGENT_NAME, OWN_NAME)
  })

  it('is a non-empty, untrimmed-clean string', () => {
    assert.equal(typeof AGENT_NAME, 'string')
    assert.ok(AGENT_NAME.length > 0)
    assert.equal(AGENT_NAME, AGENT_NAME.trim())
  })
})

describe('no rival plugin name is hardcoded in this repo', () => {
  // The f99bc20b failure mode was a literal agent name sitting in a script — as a
  // fallback, an --agent default, or (harmlessly at first) a usage example that
  // later got copied into real code. Catch the literal, wherever it sits.
  for (const file of siblingScripts()) {
    it(`${file} references no other plugin by name`, () => {
      const src = fs.readFileSync(path.join(HERE, file), 'utf8')
      for (const rival of RIVAL_NAMES) {
        for (const quoted of [`'${rival}'`, `"${rival}"`]) {
          assert.ok(
            !src.includes(quoted),
            `${file} contains the literal ${quoted}. Identity comes from AGENT_NAME — ` +
              `never a hardcoded name, not even in a comment or usage example.`,
          )
        }
      }
    })
  }

  it('actually scanned something', () => {
    assert.ok(siblingScripts().length > 0, 'no sibling scripts found — check the glob')
  })
})
