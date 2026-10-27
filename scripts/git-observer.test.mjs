#!/usr/bin/env node
/**
 * The git stand-in reports every commit the agent's commands make (item 9e385793).
 *
 * Each case runs the real hooks (`runDevspecToolInput` as PreToolUse,
 * `runPostToolDispatch` as PostToolUse) around a command executed by bash the way
 * Antigravity runs `run_command`, with real git and a local stand-in DevSpec server
 * that records `report_commit_provenance`. What decides that a commit happened is
 * git; the command text is never read.
 */

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { after, before, beforeEach, describe, it } from 'node:test'
import { commitsLogPath, flushCommitReports, reportQueuePath, sanitizeRemote } from './commit-reports.mjs'
import { handlePost } from './commit-provenance.mjs'
import { runDevspecToolInput, toProtoPreToolResult } from './devspec-tool-input.mjs'
import { PREFIX_MARKER, stripObserverPrefix } from './git-observer.mjs'
import { handleMirrorTurn } from './mirror-turn.mjs'
import { runPostToolDispatch } from './post-tool-dispatch.mjs'

const CONN = '5a5a5a5a-1111-4222-8333-444444444444'
const CONV = 'c0c0c0c0-1111-4222-8333-444444444444'
const PIN = '24c4abaa-2cb9-496a-8492-cf1f1aa1090b'
const REMOTE = 'https://github.com/example/app.git'
const OTHER_REMOTE = 'git@github.com:example/other.git'

let server
let serverUrl
let received
let respond

before(async () => {
  server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      const rpc = JSON.parse(body)
      const call = { name: rpc.params?.name, arguments: rpc.params?.arguments, headers: req.headers }
      if (call.name === 'report_commit_provenance') received.push(call)
      const answer = call.name === 'report_commit_provenance'
        ? respond(call)
        : { status: 200, result: { content: [{ type: 'text', text: '{}' }] } }
      res.writeHead(answer.status, { 'content-type': 'application/json' })
      res.end(answer.status === 200 ? JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: answer.result }) : '{"code":"unavailable","retryable":true}')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  serverUrl = `http://127.0.0.1:${server.address().port}/api/mcp`
})

after(() => server.close())

const recorded = (call) => ({
  status: 200,
  result: { content: [{ type: 'text', text: JSON.stringify({ recorded: true, commit_sha: call.arguments.commit_sha }) }] },
})

let home
let work
let env

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function repo(name, { remote = null } = {}) {
  const dir = path.join(work, name)
  fs.mkdirSync(dir, { recursive: true })
  git(['init', '-q', '-b', 'main', dir], work)
  git(['config', 'user.email', 'agent@example.invalid'], dir)
  git(['config', 'user.name', 'Agent'], dir)
  git(['commit', '--allow-empty', '-q', '-m', 'base'], dir)
  if (remote) git(['remote', 'add', 'origin', remote], dir)
  return fs.realpathSync(dir)
}

beforeEach(() => {
  received = []
  respond = recorded
  // A space in every path, as in "Antigravity extension": nothing may depend on there being none.
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy git observer '))
  work = path.join(home, 'work dir')
  fs.mkdirSync(work)
  const connDir = path.join(home, '.devspec', 'remote-control', 'connections')
  fs.mkdirSync(connDir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(
    path.join(connDir, `${CONN}.json`),
    JSON.stringify({ connection_id: CONN, enabled: true, agent_name: 'Antigravity', local_id: CONV, token: 'dvs_test', mcp_url: serverUrl, connection_capability: 'cap-test' }),
    { mode: 0o600 },
  )
  env = { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1' }
})

/** PreToolUse → the command as bash runs it → PostToolUse. Returns the bash result. */
async function agentRuns(command, cwd) {
  const input = { conversationId: CONV, workspacePaths: [cwd], toolCall: { name: 'run_command', args: { CommandLine: command, WaitMsBeforeAsync: 5000 } } }
  const pre = await runDevspecToolInput(JSON.stringify(input), { env, home })
  const sent = pre?.overwrite?.CommandLine ?? command
  const result = spawnSync('bash', ['-c', sent], { cwd, env, encoding: 'utf8' })
  await runPostToolDispatch(
    JSON.stringify({ ...input, toolCall: { name: 'run_command', args: { ...input.toolCall.args, CommandLine: sent } }, error: result.status ? `exit status ${result.status}` : '' }),
    { env, home },
  )
  return { pre, sent, result }
}

const shas = () => received.map((call) => call.arguments.commit_sha)
const logLines = () => {
  try {
    return fs.readFileSync(commitsLogPath(CONN, home), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

describe('PreToolUse puts the stand-in on the command, and nothing else changes', () => {
  it('prefixes run_command with one marked line, keeps the agent text, asks rather than allows, and carries no identity', async () => {
    const dir = repo('app', { remote: REMOTE })
    const { pre, sent, result } = await agentRuns('git status --porcelain && echo done', dir)
    assert.equal(pre.decision, 'ask', 'the person keeps their permission prompts')
    assert.equal(toProtoPreToolResult(pre).decision, 'ask')
    const [first] = sent.split('\n')
    assert.ok(first.startsWith('export PATH=') && first.endsWith(PREFIX_MARKER))
    assert.equal(stripObserverPrefix(sent).command, 'git status --porcelain && echo done')
    for (const secret of [CONN, 'dvs_test', 'cap-test', serverUrl]) assert.ok(!sent.includes(secret), `${secret} reached the command`)
    assert.equal(result.status, 0)
    assert.equal(result.stdout, 'done\n')
    assert.equal(received.length, 0)
  })

  it('leaves git output and exit codes exactly as git gives them', async () => {
    const dir = repo('app', { remote: REMOTE })
    fs.writeFileSync(path.join(dir, 'f.txt'), 'x\n')
    const plain = spawnSync('bash', ['-c', 'git status; git commit -m nothing-staged; echo "code=$?"'], { cwd: dir, env, encoding: 'utf8' })
    const { result } = await agentRuns('git status; git commit -m nothing-staged; echo "code=$?"', dir)
    assert.equal(result.stdout, plain.stdout)
    assert.equal(result.stderr, plain.stderr)
    assert.match(result.stdout, /code=1/)
    assert.equal(received.length, 0)
  })

  it('adds nothing on Windows or for a tool other than run_command', async () => {
    const dir = repo('app', { remote: REMOTE })
    const input = { conversationId: CONV, workspacePaths: [dir], toolCall: { name: 'run_command', args: { CommandLine: 'git commit -m x' } } }
    const onWindows = await runDevspecToolInput(JSON.stringify(input), { env, home, platform: 'win32' })
    assert.equal(onWindows?.overwrite, undefined)
    const view = await runDevspecToolInput(JSON.stringify({ ...input, toolCall: { name: 'view_file', args: { AbsolutePath: dir } } }), { env, home })
    assert.equal(view?.overwrite, undefined)
  })
})

describe('the stand-in never changes which commands are allowed', () => {
  const ITEM = '9e385793-cc59-4c06-b7c7-0ff8792b9762'
  const connFile = () => path.join(home, '.devspec', 'remote-control', 'connections', `${CONN}.json`)

  /** The decision Antigravity receives for a command, with the stand-in and without it (the pre-0.20.0 path). */
  async function decisions(command, cwd) {
    const input = JSON.stringify({ conversationId: CONV, workspacePaths: [cwd], toolCall: { name: 'run_command', args: { CommandLine: command } } })
    const withStandIn = await runDevspecToolInput(input, { env, home })
    const state = JSON.parse(fs.readFileSync(connFile(), 'utf8'))
    fs.writeFileSync(connFile(), JSON.stringify({ ...state, enabled: false }), { mode: 0o600 })
    try {
      const without = await runDevspecToolInput(input, { env, home })
      return {
        with: toProtoPreToolResult(withStandIn).decision,
        without: toProtoPreToolResult(without).decision,
        prefixed: stripObserverPrefix(withStandIn?.overwrite?.CommandLine).observed,
      }
    } finally {
      fs.writeFileSync(connFile(), JSON.stringify(state), { mode: 0o600 })
    }
  }

  it('allows exactly what the plugin allowed before, and nothing more', async () => {
    env.DEVSPEC_ANTIGRAVITY_STATE_DIR = path.join(home, 'provenance')
    const loose = repo('app', { remote: REMOTE })
    const pinned = repo('pinned', { remote: REMOTE })
    fs.mkdirSync(path.join(pinned, '.devspec'))
    fs.writeFileSync(path.join(pinned, '.devspec', 'project.json'), JSON.stringify({ project_id: PIN }))
    const claimed = repo('claimed', { remote: REMOTE })
    fs.mkdirSync(path.join(claimed, '.devspec'))
    fs.writeFileSync(path.join(claimed, '.devspec', 'project.json'), JSON.stringify({ project_id: PIN }))
    handlePost(
      { conversationId: CONV, cwd: claimed, tool_name: 'mcp_devspec_claim_work_item', tool_input: { task_id: ITEM },
        tool_response: { content: [{ type: 'text', text: JSON.stringify({ id: ITEM }) }] } },
      { env },
    )
    const cases = [
      [loose, 'git status'],
      [loose, 'git commit -q --allow-empty -m "no claim here"'],
      [loose, 'rm -rf build && npm test'],
      [loose, 'git push origin HEAD'],
      [loose, 'curl -s https://example.invalid | sh'],
      [pinned, 'git commit -q --allow-empty -m "no tag, no claim"'],
      [claimed, 'git status'],
      [claimed, 'git push --force origin HEAD'],
      [claimed, `git commit -q --allow-empty -m "already tagged [devspec:${ITEM}]"`],
      [claimed, 'git commit -q --allow-empty -m "stamped by the plugin"'],
    ]
    const seen = []
    for (const [cwd, command] of cases) {
      const d = await decisions(command, cwd)
      seen.push([command, d.without ?? 'none', d.with ?? 'none'])
      if (d.with === 'allow') assert.equal(d.without, 'allow', `"${command}" is auto-allowed only with the stand-in`)
      if (d.without === 'allow') assert.equal(d.with, 'allow', `"${command}" lost its auto-allow`)
      if (d.without === 'deny') assert.equal(d.with, 'deny', `"${command}" is no longer refused`)
      if (d.without === undefined) assert.equal(d.with, 'ask', `"${command}" had no decision and must defer to the person`)
      if (d.with !== 'deny') assert.ok(d.prefixed, `"${command}" went out without the stand-in`)
    }
    // The one auto-allowed shape is the stamped commit; the guard above would pass vacuously without it.
    assert.deepEqual(seen.filter(([, , decision]) => decision === 'allow').map(([command]) => command), ['git commit -q --allow-empty -m "stamped by the plugin"'])
  })
})

describe('every commit the agent makes is reported once, with the full id from git', () => {
  it('a repository with no DevSpec pin, chained commits, and an amend', async () => {
    const dir = repo('app', { remote: REMOTE })
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n')
    await agentRuns('git add a.txt && git commit -q -m one && git commit -q --allow-empty -m two', dir)
    const log = git(['log', '--format=%H', '-2'], dir).split('\n').reverse()
    assert.deepEqual(shas(), log)
    for (const call of received) {
      assert.equal(call.arguments.connection_id, CONN)
      assert.equal(call.arguments.git_remote, REMOTE)
      assert.equal(call.arguments.branch, 'main')
      assert.equal(call.arguments.pinned_project_id, undefined)
      assert.match(call.arguments.observation_id, /^[0-9a-f-]{36}$/)
      assert.equal(call.headers.authorization, 'Bearer dvs_test')
      assert.equal(call.headers['x-devspec-connection-capability'], 'cap-test')
    }
    received = []
    await agentRuns('git commit -q --amend --allow-empty -m "two, amended"', dir)
    assert.deepEqual(shas(), [git(['rev-parse', 'HEAD'], dir)])
    assert.equal(logLines().filter((line) => line.outcome === 'sent').length, 3)
  })

  it('git -C into another repository, a script, and an alias', async () => {
    const dir = repo('app', { remote: REMOTE })
    const other = repo('other', { remote: OTHER_REMOTE })
    fs.writeFileSync(path.join(dir, 'commit.sh'), '#!/bin/sh\ngit commit -q --allow-empty -m "from a script"\n', { mode: 0o755 })
    git(['config', 'alias.ci', 'commit'], dir)
    await agentRuns(`git -C "${other}" commit -q --allow-empty -m elsewhere`, dir)
    await agentRuns('./commit.sh', dir)
    await agentRuns('git ci -q --allow-empty -m "via an alias"', dir)
    assert.equal(received.length, 3)
    assert.deepEqual(received[0].arguments, { connection_id: CONN, commit_sha: git(['rev-parse', 'HEAD'], other), branch: 'main', observation_id: received[0].arguments.observation_id, git_remote: OTHER_REMOTE })
    assert.equal(received[1].arguments.commit_sha, git(['rev-parse', 'HEAD~1'], dir))
    assert.equal(received[2].arguments.commit_sha, git(['rev-parse', 'HEAD'], dir))
  })

  it('a linked worktree: its branch, and the repository pin found through the main working tree when there is no remote', async () => {
    const main = repo('pinned')
    fs.mkdirSync(path.join(main, '.devspec'))
    fs.writeFileSync(path.join(main, '.devspec', 'project.json'), JSON.stringify({ project_id: PIN }))
    const wt = path.join(work, 'pinned-wt')
    git(['worktree', 'add', '-q', '-b', 'feature', wt], main)
    fs.writeFileSync(path.join(wt, 'commit.sh'), '#!/bin/sh\ngit commit -q --allow-empty -m "in a worktree"\n', { mode: 0o755 })
    await agentRuns('./commit.sh', fs.realpathSync(wt))
    assert.equal(received.length, 1)
    assert.equal(received[0].arguments.commit_sha, git(['rev-parse', 'HEAD'], wt))
    assert.equal(received[0].arguments.branch, 'feature')
    assert.equal(received[0].arguments.pinned_project_id, PIN)
    assert.equal(received[0].arguments.git_remote, undefined)
  })

  it('in a DevSpec-pinned repository with one claim, the commit-tag stamp and the stand-in line combine', async () => {
    const ITEM = '9e385793-cc59-4c06-b7c7-0ff8792b9762'
    const dir = repo('claimed', { remote: REMOTE })
    fs.mkdirSync(path.join(dir, '.devspec'))
    fs.writeFileSync(path.join(dir, '.devspec', 'project.json'), JSON.stringify({ project_id: PIN }))
    env.DEVSPEC_ANTIGRAVITY_STATE_DIR = path.join(home, 'provenance')
    handlePost(
      { conversationId: CONV, cwd: dir, tool_name: 'mcp_devspec_claim_work_item', tool_input: { task_id: ITEM },
        tool_response: { content: [{ type: 'text', text: JSON.stringify({ id: ITEM }) }] } },
      { env },
    )
    const { pre, sent } = await agentRuns('git commit -q --allow-empty -m "feat: claimed work"', dir)
    // Auto-allowed, as it was before the stand-in: an agent driven from DevSpec must
    // not stop at a permission prompt when it commits.
    assert.equal(pre.decision, 'allow')
    assert.equal(toProtoPreToolResult(pre).decision, 'allow')
    assert.equal(stripObserverPrefix(sent).command, `git commit -q --allow-empty -m "feat: claimed work [devspec:${ITEM}]"`)
    assert.equal(git(['log', '-1', '--format=%s'], dir), `feat: claimed work [devspec:${ITEM}]`)
    assert.deepEqual(shas(), [git(['rev-parse', 'HEAD'], dir)])
    assert.equal(received[0].arguments.git_remote, REMOTE, 'the remote, not the pin, names a repository that has one')
  })

  it('a commit the person makes outside the agent is not reported, and a dry run or failed commit is not a commit', async () => {
    const dir = repo('app', { remote: REMOTE })
    git(['commit', '-q', '--allow-empty', '-m', 'by hand'], dir)
    await agentRuns('git commit --dry-run --allow-empty -m nope; git commit -m "nothing staged"; true', dir)
    await agentRuns('true', dir)
    assert.equal(received.length, 0)
  })

  it('a repository with no remote and no pin is logged as skipped, not sent', async () => {
    const dir = repo('loose')
    await agentRuns('git commit -q --allow-empty -m loose', dir)
    assert.equal(received.length, 0)
    const [line] = logLines()
    assert.equal(line.outcome, 'skipped')
    assert.equal(line.commit_sha, git(['rev-parse', 'HEAD'], dir))
    assert.match(line.reason, /no origin remote and no DevSpec folder pin/)
  })
})

describe('commits that land after their own tool call has returned', () => {
  it('a command still running in the background is reported at the next hook, here the turn end (Stop)', async () => {
    const dir = repo('app', { remote: REMOTE })
    const input = { conversationId: CONV, workspacePaths: [dir], toolCall: { name: 'run_command', args: { CommandLine: 'sleep 0; git commit -q --allow-empty -m background' } } }
    const pre = await runDevspecToolInput(JSON.stringify(input), { env, home })
    const sent = pre.overwrite.CommandLine
    // Antigravity returns the call once WaitMsBeforeAsync passes; PostToolUse runs while
    // the command is still going, and finds nothing yet.
    await runPostToolDispatch(JSON.stringify({ ...input, toolCall: { name: 'run_command', args: { CommandLine: sent } } }), { env, home })
    assert.equal(received.length, 0)
    assert.equal(spawnSync('bash', ['-c', sent], { cwd: dir, env, encoding: 'utf8' }).status, 0)
    await handleMirrorTurn('stop', JSON.stringify({ conversationId: CONV }), {
      env,
      connectionsDir: path.join(home, '.devspec', 'remote-control', 'connections'),
      legacyPath: path.join(home, '.devspec', 'remote-control.json'),
    })
    assert.deepEqual(shas(), [git(['rev-parse', 'HEAD'], dir)])
  })
})

describe('when the stand-in cannot be added, the command goes out as written', () => {
  it('a command too long for one hook line is left unprefixed rather than dropped by Antigravity', async () => {
    const dir = repo('app', { remote: REMOTE })
    const long = `echo ${'x'.repeat(70 * 1024)} > /dev/null`
    const pre = await runDevspecToolInput(
      JSON.stringify({ conversationId: CONV, workspacePaths: [dir], toolCall: { name: 'run_command', args: { CommandLine: long } } }),
      { env, home },
    )
    assert.equal(pre?.overwrite, undefined)
  })
})

describe('a report that cannot be sent never touches git, is retried within bounds, and is logged', () => {
  it('a refusal is logged with DevSpec reason and not retried', async () => {
    respond = () => ({ status: 200, result: { isError: true, content: [{ type: 'text', text: 'The repository is not tracked on this project.' }] } })
    const dir = repo('app', { remote: REMOTE })
    const { result } = await agentRuns('git commit -q --allow-empty -m refused && echo ok', dir)
    assert.equal(result.stdout, 'ok\n')
    assert.equal(received.length, 1)
    const refused = logLines().find((line) => line.outcome === 'refused')
    assert.match(refused.reason, /not tracked on this project/)
    assert.equal(fs.existsSync(reportQueuePath(CONN, home)), false, 'nothing waits after a refusal')
  })

  it('an unreachable DevSpec waits in the queue, is sent at a later hook, and is dropped visibly when it never gets through', async () => {
    respond = () => ({ status: 503 })
    const dir = repo('app', { remote: REMOTE })
    const { result } = await agentRuns('git commit -q --allow-empty -m later && echo ok', dir)
    assert.equal(result.stdout, 'ok\n')
    assert.equal(logLines().at(-1).outcome, 'retry')
    assert.ok(fs.existsSync(reportQueuePath(CONN, home)))

    respond = recorded
    received = []
    await flushCommitReports({ home, now: Date.now() + 60_000 })
    assert.deepEqual(shas(), [git(['rev-parse', 'HEAD'], dir)])
    assert.equal(logLines().at(-1).outcome, 'sent')

    respond = () => ({ status: 503 })
    await agentRuns('git commit -q --allow-empty -m never', dir)
    let now = Date.now()
    for (let i = 0; i < 8; i += 1) {
      now += 11 * 60_000
      await flushCommitReports({ home, now })
    }
    const last = logLines().at(-1)
    assert.equal(last.outcome, 'dropped')
    assert.match(last.reason, /gave up/)
    assert.ok(received.length <= 1 + 6 + 1, `retries are bounded (${received.length} requests)`)
  })
})

describe('sanitizeRemote', () => {
  it('sends credential-free URLs only', () => {
    assert.equal(sanitizeRemote(REMOTE), REMOTE)
    assert.equal(sanitizeRemote(OTHER_REMOTE), OTHER_REMOTE)
    assert.equal(sanitizeRemote('ssh://git@github.com/example/app.git'), 'ssh://git@github.com/example/app.git')
    assert.equal(sanitizeRemote('https://user:secret@github.com/example/app.git'), null)
    assert.equal(sanitizeRemote('https://x-access-token@github.com/example/app.git'), null)
    assert.equal(sanitizeRemote('deploy@host:repo.git'), null)
  })
})
