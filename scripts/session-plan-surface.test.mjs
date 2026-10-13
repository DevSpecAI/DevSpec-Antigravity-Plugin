import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8')

describe('bounded Antigravity plan discovery and prompts', () => {
  it('keeps only the two connection skills and discovers plan mechanics on demand', () => {
    const skills = fs.readdirSync(path.join(ROOT, 'skills')).sort()
    assert.deepEqual(skills, ['devspec-remote', 'devspec-remote-stop'])
    const remote = read('skills/devspec-remote/SKILL.md')
    assert.match(remote, /devspec-plan\.mjs" --schema/)
    assert.match(remote, /do not keep a local plan skill or broad static MCP allowlist hot/i)
  })

  it('keeps routine investigation plan-free and delegates the high threshold to the served contract', () => {
    const remote = read('skills/devspec-remote/SKILL.md')
    assert.match(remote, /Routine search\/inspect\/answer investigation does not merit a plan/i)
    assert.match(remote, /Only when the served `work_entry_contract` selects a session plan/i)
    assert.match(remote, /devspec:\/\/product\/implementation-contract/)
  })

  it('forces already_live through capability rotation before the wait', () => {
    const remote = read('skills/devspec-remote/SKILL.md')
    const alreadyLive = remote.indexOf('| `already_live` |')
    const stateWrite = remote.indexOf('### 5. Write state file + rotate capability')
    const wait = remote.indexOf('### 7. Arm the wait')
    assert.ok(alreadyLive >= 0 && stateWrite > alreadyLive && wait > stateWrite)
    assert.match(remote.slice(alreadyLive, stateWrite), /still run state write/i)
    assert.match(remote.slice(stateWrite, wait), /mandatory for `already_live`/i)
    const obsoleteShortcut = ['Skip re-registering', 'just re-arm the wait'].join('; ')
    assert.equal(remote.toLowerCase().includes(obsoleteShortcut.toLowerCase()), false)
  })

  it('does not inject plan prompts before connection and provides revisioned resume/end/adoption after connection', () => {
    const hooks = JSON.parse(read('hooks.json'))
    assert.deepEqual(hooks['devspec-remote-control-mirror'].PreInvocation, [{
      type: 'command', command: 'node "./scripts/pre-invocation.mjs"', timeout: 10,
    }])
    const remote = read('skills/devspec-remote/SKILL.md')
    for (const phrase of ['On reconnect', 'expected_revision', 'explicit `plan_id`', 'Another owner\'s plan is read-only', 'Closing a plan does not end remote control']) {
      assert.ok(remote.includes(phrase), phrase)
    }
  })

  it('requests all three v1 negotiations and labels projected plans advisory', () => {
    const poller = read('scripts/devspec-remote-poll.mjs')
    for (const field of ['ingress_version', 'delegated_scope_version', 'active_plan_projection_version']) {
      assert.ok(poller.includes(field), field)
    }
    assert.match(poller, /active_session_plans/)
    assert.match(read('docs/remote-control/remote-control-overview.md'), /read-awareness only/i)
  })
})
