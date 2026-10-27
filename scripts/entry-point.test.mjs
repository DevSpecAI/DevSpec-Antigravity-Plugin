#!/usr/bin/env node
/**
 * No script's command-line entry can be switched off by where the plugin lives
 * (item 9e385793). `import.meta.url` percent-encodes a space while `process.argv[1]`
 * does not, so the `file://${process.argv[1]}` comparison was false in any folder
 * with a space in its name ("Antigravity extension") and the script silently did
 * nothing. Every script now asks `isEntryPoint`, which compares real paths.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { isEntryPoint } from './entry-point.mjs'

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(SCRIPTS)

// The one script that cannot import entry-point.mjs: git-observer.mjs copies it, alone,
// into the observer folder. It makes the same real-path comparison inline.
const SELF_CONTAINED = new Set(['git-observer-shim.mjs'])

describe('script entry checks', () => {
  it('every script decides it is the entry point with isEntryPoint, never by comparing argv text', () => {
    const offenders = []
    for (const name of fs.readdirSync(SCRIPTS)) {
      if (!name.endsWith('.mjs') || name.endsWith('.test.mjs') || name === 'entry-point.mjs') continue
      const text = fs.readFileSync(path.join(SCRIPTS, name), 'utf8')
      if (!text.includes('process.argv[1]')) continue
      if (SELF_CONTAINED.has(name) && /realpathSync\(process\.argv\[1\]\) === fs\.realpathSync\(fileURLToPath\(import\.meta\.url\)\)/.test(text)) continue
      offenders.push(name)
    }
    assert.deepEqual(offenders, [])
  })

  it('a script runs its entry from a folder with spaces and through a symlink, and stays quiet when imported', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'agy entry '))
    try {
      const copy = path.join(base, 'Antigravity extension', 'plugin')
      fs.cpSync(ROOT, copy, { recursive: true, filter: (src) => !src.includes(`${path.sep}.git`) })
      const link = path.join(base, 'linked')
      fs.symlinkSync(copy, link)
      for (const dir of [copy, link]) {
        const run = spawnSync(process.execPath, [path.join(dir, 'scripts', 'devspec-plan.mjs'), '--schema'], { encoding: 'utf8' })
        assert.equal(run.status, 0, run.stderr)
        assert.match(run.stdout, /"action"/, `no schema printed from ${dir}`)
      }
      assert.equal(isEntryPoint(new URL(`file://${path.join(copy, 'scripts', 'devspec-plan.mjs')}`).href, path.join(link, 'scripts', 'devspec-plan.mjs')), true)
      assert.equal(isEntryPoint(import.meta.url, path.join(copy, 'scripts', 'devspec-plan.mjs')), false)
      assert.equal(isEntryPoint(import.meta.url, ''), false)
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
    }
  })
})
