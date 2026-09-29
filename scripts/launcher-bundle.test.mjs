import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { checkBundle } from '../launcher/check-bundle.mjs'
test('Antigravity uses its real mechanical Connect entry rather than assuming an activation hook', () => {
  assert.ok(checkBundle().files.has('plugin-setup.mjs'))
  const entry = readFileSync(new URL('./connection-call.mjs', import.meta.url), 'utf8')
  assert.match(entry, /if \(main\) \{[\s\S]*void setupAntigravityLauncher\(\)/)
})
