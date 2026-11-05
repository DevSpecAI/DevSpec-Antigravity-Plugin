#!/usr/bin/env node
/**
 * The git stand-in tags and checks commits in the project's repositories (item 31ef3d3c).
 *
 * Each case runs the real PreToolUse hook, then the command in bash the way
 * Antigravity runs `run_command`, with real git. The repository is in scope because
 * its origin is one of the connected project's repositories (no DevSpec marker), and
 * the stand-in reads the message from git's own arguments, so every shell shape that
 * produces one is covered: `-m`, `-m "$(cat <<'EOF' …)"`, a heredoc into `-F -`, and
 * `-F <file>`.
 */

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, it } from 'node:test'
import { handlePost } from './commit-provenance.mjs'
import { runDevspecToolInput, toProtoPreToolResult } from './devspec-tool-input.mjs'
import { generationDir } from './git-observer.mjs'
import { storeRepositoryContext } from './repository-context.mjs'

const CONN = '5a5a5a5a-1111-4222-8333-444444444444'
const CONV = 'c0c0c0c0-1111-4222-8333-444444444444'
const PROJECT = '24c4abaa-2cb9-496a-8492-cf1f1aa1090b'
const TASK = '31ef3d3c-7b88-48f8-961c-84c64f8bc344'
const OTHER_TASK = '9e385793-cc59-4c06-b7c7-0ff8792b9762'
const PROJECT_REMOTE = 'git@github.com:Example/App.git'

let home
let work
let env

function git(args, cwd, input) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] })
}

function repo(name, remote) {
  const dir = path.join(work, name)
  fs.mkdirSync(dir, { recursive: true })
  git(['init', '-q', '-b', 'main', dir], work)
  git(['config', 'user.email', 'agent@example.invalid'], dir)
  git(['config', 'user.name', 'Agent'], dir)
  git(['commit', '--allow-empty', '-q', '-m', 'base'], dir)
  if (remote) git(['remote', 'add', 'origin', remote], dir)
  return fs.realpathSync(dir)
}

function claim(cwd, ...ids) {
  for (const id of ids) {
    handlePost(
      { conversationId: CONV, cwd, tool_name: 'mcp_devspec_claim_work_item', tool_input: { task_id: id },
        tool_response: { content: [{ type: 'text', text: JSON.stringify({ id }) }] } },
      { env },
    )
  }
}

async function agentRuns(command, cwd) {
  const input = { conversationId: CONV, workspacePaths: [cwd], toolCall: { name: 'run_command', args: { CommandLine: command } } }
  const pre = await runDevspecToolInput(JSON.stringify(input), { env, home })
  const sent = pre?.overwrite?.CommandLine ?? command
  const result = spawnSync('bash', ['-c', sent], { cwd, env, encoding: 'utf8' })
  return { pre, result }
}

const lastMessage = (dir) => git(['log', '-1', '--format=%B'], dir).replace(/\n+$/, '')
const head = (dir) => git(['rev-parse', 'HEAD'], dir).trim()

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy stamping '))
  work = path.join(home, 'work dir')
  fs.mkdirSync(work)
  const connDir = path.join(home, '.devspec', 'remote-control', 'connections')
  fs.mkdirSync(connDir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(
    path.join(connDir, `${CONN}.json`),
    JSON.stringify({ connection_id: CONN, enabled: true, agent_name: 'Antigravity', local_id: CONV, project_id: PROJECT, token: 'dvs_test', mcp_url: 'http://127.0.0.1:9/api/mcp' }),
    { mode: 0o600 },
  )
  // What DevSpec sends at connect: the project's repositories.
  storeRepositoryContext(CONN, {
    project_id: PROJECT,
    repository_context: {
      version: 1, project_id: PROJECT, status: 'available',
      repositories: [{ id: 'r1', full_name: 'Example/App', provider: 'github', git_url: 'https://github.com/Example/App.git', target_branch: 'staging', default_branch: 'main' }],
    },
  }, { dir: connDir })
  env = { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1', DEVSPEC_ANTIGRAVITY_STATE_DIR: path.join(home, 'provenance') }
})

describe('one task claimed in a project repository with no DevSpec marker', () => {
  it('tags every message shape at the end of its subject line, without the model writing it', async () => {
    const dir = repo('app', PROJECT_REMOTE)
    claim(dir, TASK)
    const tag = `[devspec:${TASK}]`

    const plain = await agentRuns('git commit -q --allow-empty -m "fix: one line"', dir)
    assert.equal(plain.result.status, 0, plain.result.stderr)
    assert.equal(lastMessage(dir), `fix: one line ${tag}`)
    assert.match(plain.result.stderr, new RegExp(`added \\[devspec:${TASK}\\]`))

    const heredoc = await agentRuns(`git commit -q --allow-empty -F - <<'MSG'\nfeat: from a heredoc\n\nFirst body line.\nSecond body line.\nMSG`, dir)
    assert.equal(heredoc.result.status, 0, heredoc.result.stderr)
    assert.equal(lastMessage(dir), `feat: from a heredoc ${tag}\n\nFirst body line.\nSecond body line.`)

    const substituted = await agentRuns(`git commit -q --allow-empty -m "$(cat <<'MSG'\nfeat: substituted\n\nBody kept as written.\nMSG\n)"`, dir)
    assert.equal(substituted.result.status, 0, substituted.result.stderr)
    assert.equal(lastMessage(dir), `feat: substituted ${tag}\n\nBody kept as written.`)

    const file = path.join(work, 'message.txt')
    fs.writeFileSync(file, 'feat: from a file\n\nWith a body.\n')
    const before = fs.readFileSync(file)
    const fromFile = await agentRuns(`git commit -q --allow-empty -F "${file}"`, dir)
    assert.equal(fromFile.result.status, 0, fromFile.result.stderr)
    assert.equal(lastMessage(dir), `feat: from a file ${tag}\n\nWith a body.`)
    assert.deepEqual(fs.readFileSync(file), before, "the person's own message file is never edited")
    const copies = path.join(generationDir(CONN, home), 'messages')
    assert.deepEqual(fs.existsSync(copies) ? fs.readdirSync(copies) : [], [], 'the private copy is removed')

    // Same conversation (Antigravity keeps one workspace per conversation); the
    // command itself leaves the repository and commits into it with -C.
    const fromElsewhere = await agentRuns(`cd "${work}" && git -C "${dir}" commit -q --allow-empty -m "chore: via -C"`, dir)
    assert.equal(fromElsewhere.result.status, 0, fromElsewhere.result.stderr)
    assert.equal(lastMessage(dir), `chore: via -C ${tag}`)
  })

  it('leaves alone a message that already has a reference, and every form that reuses a message', async () => {
    const dir = repo('app', PROJECT_REMOTE)
    claim(dir, TASK)
    const ref = `[devspec:${OTHER_TASK}]`

    await agentRuns(`git commit -q --allow-empty -m "fix: chosen ${ref}"`, dir)
    assert.equal(lastMessage(dir), `fix: chosen ${ref}`, 'an existing reference is never replaced')

    // -F - with a reference: the exact bytes reach git (verbatim keeps every space).
    const exact = `subject with trailing spaces   ${ref}\n\n\tindented body\n`
    await agentRuns(`git commit -q --allow-empty --cleanup=verbatim -F - <<'MSG'\n${exact}MSG`, dir)
    assert.equal(git(['log', '-1', '--format=%B'], dir), `${exact}\n`)

    const reused = head(dir)
    const reusedMessage = lastMessage(dir)
    await agentRuns('git commit -q --allow-empty --amend --no-edit', dir)
    assert.equal(lastMessage(dir), reusedMessage)
    await agentRuns('git commit -q --allow-empty --amend -m "amended subject"', dir)
    assert.equal(lastMessage(dir), 'amended subject', 'an amend is not tagged')
    await agentRuns(`git commit -q --allow-empty -C ${reused}`, dir)
    assert.equal(lastMessage(dir), reusedMessage)
    await agentRuns(`git commit -q --allow-empty --reuse-message=${reused}`, dir)
    assert.equal(lastMessage(dir), reusedMessage)
    await agentRuns('git commit -q --allow-empty --fixup=HEAD', dir)
    assert.match(lastMessage(dir), /^fixup! /)
    assert.doesNotMatch(lastMessage(dir), new RegExp(TASK))
  })
})

describe('the commit check, before git runs', () => {
  it('no task claimed: stopped with recovery text that leaves nothing to type, and the repository is unchanged', async () => {
    const dir = repo('app', PROJECT_REMOTE)
    const before = head(dir)
    for (const command of [
      'git commit -q --allow-empty -m "feat: unclaimed"',
      `git commit -q --allow-empty -F - <<'MSG'\nfeat: unclaimed, multi-line\n\nBody.\nMSG`,
    ]) {
      const { result } = await agentRuns(command, dir)
      assert.equal(result.status, 1)
      assert.match(result.stderr, /claim_work_item/)
      assert.match(result.stderr, /retry the same commit/i)
      assert.doesNotMatch(result.stderr, /<full-uuid>|<uuid>/)
      assert.equal(head(dir), before)
    }
  })

  it('several tasks claimed: stopped, and asked to write the right tag', async () => {
    const dir = repo('app', PROJECT_REMOTE)
    claim(dir, TASK, OTHER_TASK)
    const before = head(dir)
    const { result } = await agentRuns(`git commit -q --allow-empty -F - <<'MSG'\nfeat: which one?\n\nBody.\nMSG`, dir)
    assert.equal(result.status, 1)
    assert.match(result.stderr, new RegExp(`\\[devspec:${TASK}\\]`))
    assert.match(result.stderr, new RegExp(`\\[devspec:${OTHER_TASK}\\]`))
    assert.equal(head(dir), before)
  })

  it('inside another git stand-in\'s work: not stopped, not tagged, not recorded, because that one owns the commit (65658d3b)', async () => {
    const dir = repo('app', PROJECT_REMOTE)
    // What another DevSpec plugin's stand-in, or a git hook under one, hands this one.
    const unclaimed = await agentRuns('DEVSPEC_GIT_STAND_IN_DEPTH=1 git commit -q --allow-empty -m "feat: nested, unclaimed"', dir)
    assert.equal(unclaimed.result.status, 0, unclaimed.result.stderr)
    assert.equal(lastMessage(dir), 'feat: nested, unclaimed')
    claim(dir, TASK)
    const claimed = await agentRuns('DEVSPEC_GIT_STAND_IN_DEPTH=1 git commit -q --allow-empty -m "feat: nested, claimed"', dir)
    assert.equal(claimed.result.status, 0, claimed.result.stderr)
    assert.equal(lastMessage(dir), 'feat: nested, claimed')
    const observations = path.join(generationDir(CONN, home), 'observations.jsonl')
    assert.equal(fs.existsSync(observations) ? fs.readFileSync(observations, 'utf8') : '', '')
  })
})

describe('a repository outside the project', () => {
  it('is left completely alone: not stopped without a claim, not tagged with one', async () => {
    const dir = repo('fixture', 'https://github.com/someone-else/fixture.git')
    const unclaimed = await agentRuns('git commit -q --allow-empty -m "test: fixture"', dir)
    assert.equal(unclaimed.result.status, 0, unclaimed.result.stderr)
    assert.equal(unclaimed.result.stderr, '')
    assert.equal(lastMessage(dir), 'test: fixture')
    claim(dir, TASK)
    await agentRuns(`git commit -q --allow-empty -F - <<'MSG'\ntest: still a fixture\n\nBody.\nMSG`, dir)
    assert.equal(lastMessage(dir), 'test: still a fixture\n\nBody.')
    const loose = repo('loose', null)
    const noRemote = await agentRuns('git commit -q --allow-empty -m "scratch"', loose)
    assert.equal(noRemote.result.status, 0)
    assert.equal(lastMessage(loose), 'scratch')
  })

  it('every permission decision stays as it was: an in-scope commit without a DevSpec marker still asks', async () => {
    const dir = repo('app', PROJECT_REMOTE)
    claim(dir, TASK)
    for (const command of ['git commit -q --allow-empty -m "feat: x"', 'git status']) {
      const { pre } = await agentRuns(command, dir)
      assert.equal(toProtoPreToolResult(pre).decision, 'ask', command)
    }
  })
})
