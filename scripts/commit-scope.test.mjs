#!/usr/bin/env node
/**
 * Which repositories the plugin tags commits in and checks (item cdd7f0f3): an origin
 * the connected project tracks, or a pin naming the project. Nothing else, and in
 * particular not a folder whose MCP configuration merely declares DevSpec.
 *
 * Each case runs the real PreToolUse hook and then the command in bash with real git,
 * on both of the plugin's paths: the git stand-in (Linux, macOS, WSL) and the
 * command-text fallback (native Windows here, `platform: 'win32'`, where agy runs
 * commands in PowerShell and the stand-in stays off).
 */

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, it } from 'node:test'
import { handlePost, handlePre } from './commit-provenance.mjs'
import { runDevspecToolInput, toProtoPreToolResult } from './devspec-tool-input.mjs'
import { storeRepositoryContext } from './repository-context.mjs'

const CONN = '6b6b6b6b-1111-4222-8333-444444444444'
const CONV = 'd0d0d0d0-1111-4222-8333-444444444444'
const PROJECT = '24c4abaa-2cb9-496a-8492-cf1f1aa1090b'
const OTHER_PROJECT = '0f0f0f0f-1111-4222-8333-444444444444'
const TASK = 'cdd7f0f3-55c9-45c1-879e-c537574cdb43'
const PROJECT_REMOTE = 'https://github.com/Example/App.git'
const OTHER_REMOTE = 'git@github.com:Example/Elsewhere.git'
const PATHS = {
  standIn: {},
  fallback: { platform: 'win32' },
}

let home
let work
let env

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function repo(name, { remote = null, pin = null, declaresDevSpec = false } = {}) {
  const dir = path.join(work, name)
  fs.mkdirSync(dir, { recursive: true })
  git(['init', '-q', '-b', 'main', dir], work)
  git(['config', 'user.email', 'agent@example.invalid'], dir)
  git(['config', 'user.name', 'Agent'], dir)
  git(['commit', '--allow-empty', '-q', '-m', 'base'], dir)
  if (remote) git(['remote', 'add', 'origin', remote], dir)
  if (pin) {
    fs.mkdirSync(path.join(dir, '.devspec'))
    fs.writeFileSync(path.join(dir, '.devspec', 'project.json'), JSON.stringify({ project_id: pin }))
  }
  if (declaresDevSpec) {
    fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { devspec: { type: 'http', url: 'https://api.devspec.ai/api/mcp' } } }))
  }
  fs.writeFileSync(path.join(dir, '.git', 'info', 'exclude'), '.devspec/\n.mcp.json\n')
  return fs.realpathSync(dir)
}

function claim(cwd, id) {
  handlePost(
    { conversationId: CONV, cwd, tool_name: 'mcp_devspec_claim_work_item', tool_input: { task_id: id },
      tool_response: { content: [{ type: 'text', text: JSON.stringify({ id }) }] } },
    { env },
  )
}

/** The hook's answer and what the command did, as Antigravity would run it. */
async function agentRuns(command, cwd, extra) {
  const input = { conversationId: CONV, workspacePaths: [cwd], toolCall: { name: 'run_command', args: { CommandLine: command } } }
  const pre = await runDevspecToolInput(JSON.stringify(input), { env, home, ...extra })
  const decision = toProtoPreToolResult(pre ?? {}).decision ?? 'none'
  if (decision === 'deny') return { pre, decision, result: null }
  const sent = pre?.overwrite?.CommandLine ?? command
  return { pre, decision, result: spawnSync('bash', ['-c', sent], { cwd, env, encoding: 'utf8' }) }
}

const subject = (dir) => git(['log', '-1', '--format=%s'], dir).trim()
const head = (dir) => git(['rev-parse', 'HEAD'], dir).trim()

function connect() {
  const connDir = path.join(home, '.devspec', 'remote-control', 'connections')
  fs.mkdirSync(connDir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(
    path.join(connDir, `${CONN}.json`),
    JSON.stringify({ connection_id: CONN, enabled: true, agent_name: 'Antigravity', local_id: CONV, project_id: PROJECT, token: 'dvs_test', mcp_url: 'http://127.0.0.1:9/api/mcp' }),
    { mode: 0o600 },
  )
  storeRepositoryContext(CONN, {
    project_id: PROJECT,
    repository_context: {
      version: 1, project_id: PROJECT, status: 'available',
      repositories: [{ id: 'r1', full_name: 'Example/App', provider: 'github', git_url: PROJECT_REMOTE, target_branch: 'staging', default_branch: 'main' }],
    },
  }, { dir: connDir })
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy commit scope '))
  work = path.join(home, 'work dir')
  fs.mkdirSync(work)
  env = { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1', DEVSPEC_ANTIGRAVITY_STATE_DIR: path.join(home, 'provenance') }
})

describe('a repository the project tracks, with no pin', () => {
  for (const [name, extra] of Object.entries(PATHS)) {
    it(`${name}: one task claimed, the commit is tagged; none claimed, it is stopped`, async () => {
      connect()
      const tagged = repo('app', { remote: PROJECT_REMOTE })
      claim(tagged, TASK)
      const one = await agentRuns('git commit -q --allow-empty -m "feat: tracked"', tagged, extra)
      assert.equal(one.result.status, 0, one.result.stderr)
      assert.equal(subject(tagged), `feat: tracked [devspec:${TASK}]`)
      // Matching by origin stamps more commits, but allows no command it did not allow before.
      assert.equal(one.decision, 'ask')

      const unclaimed = repo('unclaimed', { remote: PROJECT_REMOTE })
      const before = head(unclaimed)
      const none = await agentRuns('git commit -q --allow-empty -m "feat: unclaimed"', unclaimed, extra)
      const text = none.result ? none.result.stderr : none.pre.reason
      assert.match(text, /claim_work_item/)
      assert.equal(head(unclaimed), before)
    })
  }
})

describe('a folder whose MCP configuration only declares DevSpec', () => {
  for (const [name, extra] of Object.entries(PATHS)) {
    it(`${name}: is left alone: no tag, no stopped commit, no edit reminder`, async () => {
      connect()
      for (const remote of [OTHER_REMOTE, null]) {
        const dir = repo(`declared-${remote ? 'remote' : 'local'}`, { remote, declaresDevSpec: true })
        const unclaimed = await agentRuns('git commit -q --allow-empty -m "chore: not the project\'s"', dir, extra)
        assert.notEqual(unclaimed.decision, 'deny')
        assert.equal(unclaimed.result.status, 0, unclaimed.result.stderr)
        assert.equal(subject(dir), "chore: not the project's")

        claim(dir, TASK)
        const claimed = await agentRuns('git commit -q --allow-empty -m "chore: still not"', dir, extra)
        assert.equal(claimed.result.status, 0, claimed.result.stderr)
        assert.equal(subject(dir), 'chore: still not')

        const edit = { conversationId: CONV, tool_name: 'write_to_file', tool_input: { TargetFile: path.join(dir, 'notes.md') } }
        assert.equal(await handlePre(edit, { env, home, ...extra }), null)
      }
    })
  }
})

describe('a pinned repository', () => {
  for (const [name, extra] of Object.entries(PATHS)) {
    it(`${name}: stays in scope with a pin naming the project, and its stamp stays allowed`, async () => {
      connect()
      const dir = repo('pinned', { pin: PROJECT })
      claim(dir, TASK)
      const run = await agentRuns('git commit -q --allow-empty -m "feat: pinned"', dir, extra)
      assert.equal(run.result.status, 0, run.result.stderr)
      assert.equal(subject(dir), `feat: pinned [devspec:${TASK}]`)
      assert.equal(run.decision, 'allow')
    })
  }

  it("fallback: a pin naming another project is not this project's while connected", async () => {
    connect()
    const dir = repo('theirs', { pin: OTHER_PROJECT })
    claim(dir, TASK)
    const run = await agentRuns('git commit -q --allow-empty -m "feat: theirs"', dir, PATHS.fallback)
    assert.equal(run.result.status, 0, run.result.stderr)
    assert.equal(subject(dir), 'feat: theirs')
  })

  it('fallback, not connected: any pin counts, as before', async () => {
    const dir = repo('offline', { pin: OTHER_PROJECT })
    claim(dir, TASK)
    const run = await agentRuns('git commit -q --allow-empty -m "feat: offline"', dir, PATHS.fallback)
    assert.equal(run.result.status, 0, run.result.stderr)
    assert.equal(subject(dir), `feat: offline [devspec:${TASK}]`)
  })
})
