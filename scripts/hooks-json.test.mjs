// Every hook command must run where agy runs it: `sh -c` on macOS and Linux, and
// `cmd /c` on Windows, both from the plugin folder. On Windows a quoted path reaches
// node with its quotes still on (measured with agy 1.4.8), so node finds no script,
// the hook fails, and agy fails the tool call it was for: with quoted paths every
// tool call failed. A bare relative path works in both shells.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function hookCommands(value, out = []) {
  if (Array.isArray(value)) value.forEach((v) => hookCommands(v, out))
  else if (value && typeof value === 'object') {
    if (value.type === 'command' && typeof value.command === 'string') out.push(value.command)
    else Object.values(value).forEach((v) => hookCommands(v, out))
  }
  return out
}

test('every hook command is node with a bare relative script path that exists', () => {
  const commands = hookCommands(JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks.json'), 'utf8')))
  assert.ok(commands.length >= 6, 'every hook event the plugin uses')
  for (const command of commands) {
    assert.doesNotMatch(command, /["'`^%]/, `${command}: no quoting or shell syntax`)
    const match = /^node \.\/scripts\/([a-z0-9-]+\.mjs)( [a-z]+)?$/.exec(command)
    assert.ok(match, `${command}: node ./scripts/<script>.mjs [word]`)
    assert.ok(fs.existsSync(path.join(ROOT, 'scripts', match[1])), `${match[1]} exists`)
  }
})

test("the sidecar's command and arguments are separate, so no shell quoting applies", () => {
  const sidecar = JSON.parse(fs.readFileSync(path.join(ROOT, 'sidecars', 'devspec-remote', 'sidecar.json'), 'utf8'))
  assert.equal(sidecar.command, 'node')
  assert.ok(Array.isArray(sidecar.args))
  assert.ok(fs.existsSync(path.resolve(ROOT, 'sidecars', 'devspec-remote', sidecar.args[0])))
})
