/**
 * End-to-end: the real agy (the pinned release) with this plugin installed, driven by a
 * scripted model, on the platform it runs on. CI runs it on Linux and on native Windows.
 *
 *   AGY_E2E=1 node --test e2e/agy.e2e.test.mjs    downloads the pinned agy once, then runs
 *   AGY_BIN=/path/to/agy node --test e2e/agy.e2e.test.mjs
 *
 * What it holds on each platform:
 * - the plugin's hooks run (on Windows agy runs them through `cmd /c`);
 * - permission decisions are the same with the plugin as without it: what the person's
 *   rules allow still runs, what they deny is still denied, anything else still asks;
 * - a commit the agent makes in a project repository is tagged with its one claimed
 *   task and reported to DevSpec. On Linux and macOS the git stand-in does this for any
 *   commit; on native Windows agy runs commands in PowerShell, the stand-in is off (it
 *   would change permission decisions there), and the simpler check that reads the
 *   command tags a single-line `git commit -m` in a pinned folder.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import { fetchAgy } from './agy-release.mjs'
import { TASK_ID, bindConversation, makeHome, makeRepo, runAgy } from './agy-harness.mjs'
import { startDevspec } from './devspec-standin.mjs'

const AGY = process.env.AGY_BIN || (process.env.AGY_E2E === '1' ? await fetchAgy() : null)
const skip = AGY ? false : 'set AGY_E2E=1 (downloads the pinned agy) or AGY_BIN=<agy> to run'
const windows = process.platform === 'win32'
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-agy-e2e-'))
after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }))
const fresh = (name) => {
  const dir = path.join(scratch, name)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

// One rule of each kind, written as a person on that platform writes them: on Windows
// agy matches a PowerShell command whole, so prefix rules need `regex:`.
const RULES = windows
  ? { allow: ['command(regex:git .*)', 'command(regex:echo .*)'], deny: ['command(regex:git push.*)'] }
  : { allow: ['command(git)', 'command(echo)'], deny: ['command(git push)'] }
const PERMISSION_STEPS = ['git --version', 'echo e2e-allowed', 'git push origin nowhere', windows ? 'Write-Output not-asked-for' : 'printf not-asked-for']
const EXPECTED = ['ran', 'ran', 'denied', 'not-allowed']

describe(`agy ${windows ? 'on native Windows' : `on ${process.platform}`} with the DevSpec plugin`, { skip }, () => {
  it("runs the plugin's hooks", async () => {
    const root = fresh('hooks')
    const { home } = makeHome(root)
    const { repo } = makeRepo(root)
    const run = await runAgy({ agy: AGY, home, workspace: repo, commands: ['echo hooks-ran'], skipPermissions: true })
    assert.equal(run.steps[0].outcome, 'ran', run.steps[0].text || run.stderr)
    assert.match(run.steps[0].text, /hooks-ran/)
  })

  it('leaves every permission decision as it was without the plugin', async () => {
    const devspec = await startDevspec()
    try {
      const outcomes = {}
      for (const plugin of [false, true]) {
        const root = fresh(`permissions-${plugin ? 'plugin' : 'none'}`)
        const { home, pluginDir } = makeHome(root, { plugin, settings: { permissions: RULES } })
        const { repo } = makeRepo(root)
        if (plugin) bindConversation(repo, pluginDir, devspec.url)
        const run = await runAgy({ agy: AGY, home, workspace: repo, commands: PERMISSION_STEPS })
        outcomes[plugin ? 'plugin' : 'none'] = run.steps
      }
      assert.deepEqual(outcomes.none.map((s) => s.outcome), EXPECTED, JSON.stringify(outcomes.none))
      assert.deepEqual(outcomes.plugin.map((s) => s.outcome), EXPECTED, JSON.stringify(outcomes.plugin))
      // The comparison covers the stand-in where it runs: on Linux and macOS the plugin put
      // its line in front of the commands that ran; on Windows it changed none of them.
      const rewritten = outcomes.plugin.slice(0, 2).map((s) => s.rewritten)
      assert.deepEqual(rewritten, windows ? [false, false] : [true, true])
    } finally {
      devspec.close()
    }
  })

  it('tags a commit in a project repository with its one claimed task, and reports it', async () => {
    const devspec = await startDevspec()
    try {
      const root = fresh('commit')
      const { home, pluginDir } = makeHome(root)
      // The simpler check on Windows acts only in a folder pinned to the project.
      const { repo, git } = makeRepo(root, { pin: windows })
      bindConversation(repo, pluginDir, devspec.url)
      const commands = ['git commit -q --allow-empty -m "e2e single line"']
      if (!windows) commands.push("git commit -q --allow-empty -F - <<'MSG'\ne2e multi-line\n\nBody line.\nMSG")
      const run = await runAgy({ agy: AGY, home, workspace: repo, commands, skipPermissions: true })
      for (const step of run.steps) assert.equal(step.outcome, 'ran', step.text || run.stderr)
      const made = git('log', `-${commands.length}`, '--format=%H %s').split('\n').reverse()
      assert.equal(made.length, commands.length)
      for (const line of made) assert.match(line, new RegExp(`\\[devspec:${TASK_ID}\\]$`), line)
      const reported = devspec.calls.filter((c) => c.name === 'report_commit_provenance').map((c) => c.args.commit_sha)
      for (const line of made) assert.ok(reported.includes(line.split(' ')[0]), `not reported: ${line}`)
    } finally {
      devspec.close()
    }
  })
})
