#!/usr/bin/env node
/**
 * Tests for Antigravity commit provenance assistance (`scripts/commit-provenance.mjs`)
 * and direct-commit git observation (`scripts/commit-observation.mjs`), plus wiring
 * through `devspec-tool-input.mjs`, `post-tool-dispatch.mjs`, and `post-invocation.mjs`.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { afterEach, beforeEach, describe, it } from 'node:test'
import {
  boundConnection,
  commitRepoDir,
  handleBashPost,
  handleBashPre,
  inJurisdiction,
} from './commit-observation.mjs'
import {
  CONTRACT_URI,
  confirmReferenceOnline,
  handlePost,
  handlePre,
  handleSessionStart,
  heredocGitCommit,
  isSimpleGitPush,
  pendingNudgeNotice,
  readActiveAutomation,
  readClaimDetails,
  readClaimedWorkItems,
  readClaims,
  referenceIn,
  simpleGitCommit,
} from './commit-provenance.mjs'
import { runDevspecToolInput } from './devspec-tool-input.mjs'
import { runPostInvocation } from './post-invocation.mjs'
import { runPostToolDispatch } from './post-tool-dispatch.mjs'
import { renderStatusLine } from './statusline.mjs'

const ITEM = 'cdd7a494-ed6a-414b-9f8f-bd0741b9de55'
const OTHER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PROJECT = '22222222-2222-4222-8222-222222222222'
const CONVERSATION = 'ca2d5a24-57ea-4252-90d0-82d4dd2504d1'
const PROV_REF = '33333333-3333-4333-8333-333333333333'
const CLAIM_REF = '44444444-4444-4444-8444-444444444444'

let sandbox
let repo
let env

function git(args, cwd = repo) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function gitInit(dir) {
  fs.mkdirSync(dir, { recursive: true })
  const result = spawnSync('git', ['init', '-q', dir], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  git(['config', 'user.email', 'fixture@example.invalid'], dir)
  git(['config', 'user.name', 'Fixture'], dir)
}

function markDevspecProject(dir) {
  fs.mkdirSync(path.join(dir, '.devspec'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, '.devspec', 'project.json'),
    JSON.stringify({ project_id: PROJECT }),
  )
}

function scope(cwd = repo, sessionId = CONVERSATION) {
  return {
    sessionId,
    cwd: fs.realpathSync(cwd),
    repoRoot: fs.realpathSync(path.join(cwd, '.git')),
  }
}

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-provenance-test-'))
  repo = path.join(sandbox, 'repo')
  gitInit(repo)
  markDevspecProject(repo)
  git(['commit', '--allow-empty', '-q', '-m', 'base'], repo)
  const {
    DEVSPEC_MCP_TOKEN: _t,
    DEVSPEC_TOKEN: _t2,
    DEVSPEC_MCP_URL: _u,
    CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN: _p,
    ...ambient
  } = process.env
  env = {
    ...ambient,
    DEVSPEC_ANTIGRAVITY_STATE_DIR: path.join(sandbox, 'state'),
  }
})

afterEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true })
})

describe('commit-provenance.mjs — claim/release tracking per conversation', () => {
  it('tracks claim_work_item, release_work_item, fail_work_item, and record_implementation per conversation', () => {
    // 1. Claim ITEM with mcp_devspec_claim_work_item
    handlePost(
      {
        conversationId: CONVERSATION,
        cwd: repo,
        tool_name: 'mcp_devspec_claim_work_item',
        tool_input: {
          action_item_id: ITEM,
          provenance_ref: PROV_REF,
        },
        tool_response: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                id: ITEM,
                claim_success: true,
                work_claim_ref: CLAIM_REF,
                provenance_ref: PROV_REF,
              }),
            },
          ],
        },
      },
      { env },
    )
    assert.deepEqual(readClaims(scope(), { env }), [ITEM])
    assert.deepEqual(readClaimDetails(scope(), { env }), {
      action_item_id: ITEM,
      work_claim_ref: CLAIM_REF,
      provenance_ref: PROV_REF,
    })

    // 2. Different conversation does not see this claim
    assert.deepEqual(readClaims(scope(repo, 'other-conversation-9999'), { env }), [])

    // 3. release_work_item clears the claim
    handlePost(
      {
        conversationId: CONVERSATION,
        cwd: repo,
        tool_name: 'mcp_devspec_release_work_item',
        tool_input: { action_item_id: ITEM },
        tool_response: { content: [{ type: 'text', text: JSON.stringify({ id: ITEM, status: 'staged' }) }] },
      },
      { env },
    )
    assert.deepEqual(readClaims(scope(), { env }), [])

    // 4. Re-claim and release via fail_work_item
    handlePost(
      {
        conversationId: CONVERSATION,
        cwd: repo,
        tool_name: 'mcp_devspec_claim_work_item',
        tool_input: { action_item_id: ITEM },
        tool_response: { content: [{ type: 'text', text: JSON.stringify({ id: ITEM }) }] },
      },
      { env },
    )
    assert.deepEqual(readClaims(scope(), { env }), [ITEM])

    handlePost(
      {
        conversationId: CONVERSATION,
        cwd: repo,
        tool_name: 'mcp_devspec_fail_work_item',
        tool_input: { action_item_id: ITEM },
        tool_response: { content: [{ type: 'text', text: JSON.stringify({ id: ITEM, status: 'failed' }) }] },
      },
      { env },
    )
    assert.deepEqual(readClaims(scope(), { env }), [])

    // 5. Re-claim and release via record_implementation
    handlePost(
      {
        conversationId: CONVERSATION,
        cwd: repo,
        tool_name: 'mcp_devspec_claim_work_item',
        tool_input: { action_item_id: ITEM },
        tool_response: { content: [{ type: 'text', text: JSON.stringify({ id: ITEM }) }] },
      },
      { env },
    )
    assert.deepEqual(readClaims(scope(), { env }), [ITEM])

    handlePost(
      {
        conversationId: CONVERSATION,
        cwd: repo,
        tool_name: 'mcp_devspec_record_implementation',
        tool_input: { action_item_id: ITEM },
        tool_response: { content: [{ type: 'text', text: JSON.stringify({ id: ITEM, lifecycle: 'implemented' }) }] },
      },
      { env },
    )
    assert.deepEqual(readClaims(scope(), { env }), [])
  })

  it('auto-stamps [devspec:<id>] onto run_command CommandLine when one claim is active', async () => {
    handlePost(
      {
        conversationId: CONVERSATION,
        cwd: repo,
        tool_name: 'mcp_devspec_claim_work_item',
        tool_input: { action_item_id: ITEM },
        tool_response: { content: [{ type: 'text', text: JSON.stringify({ id: ITEM }) }] },
      },
      { env },
    )

    const result = await runDevspecToolInput(
      JSON.stringify({
        conversationId: CONVERSATION,
        cwd: repo,
        tool_name: 'run_command',
        tool_input: { CommandLine: 'git commit -m "feat: add provenance"', Cwd: repo },
      }),
      { env },
    )
    assert.equal(result.decision, 'allow')
    assert.equal(
      result.overwrite.CommandLine,
      `git commit -m "feat: add provenance [devspec:${ITEM}]"`,
    )
    assert.equal(
      result.hookSpecificOutput.updatedInput.CommandLine,
      `git commit -m "feat: add provenance [devspec:${ITEM}]"`,
    )
  })

  it('denies unreferenced git commit when zero or multiple claims are active, without blocking other commands', async () => {
    // Non-commit command is always allowed
    const lsOut = await runDevspecToolInput(
      JSON.stringify({
        conversationId: CONVERSATION,
        cwd: repo,
        tool_name: 'run_command',
        tool_input: { CommandLine: 'git status && npm test', Cwd: repo },
      }),
      { env },
    )
    assert.equal(lsOut, null)

    // Unreferenced commit with 0 claims is denied with recovery instructions
    const denied = await runDevspecToolInput(
      JSON.stringify({
        conversationId: CONVERSATION,
        cwd: repo,
        tool_name: 'run_command',
        tool_input: { CommandLine: 'git commit -m "untracked"', Cwd: repo },
      }),
      { env },
    )
    assert.equal(denied.decision, 'deny')
    assert.match(denied.reason, new RegExp(CONTRACT_URI.replace(/[/:]/g, '\\$&')))

    // Multiple active claims refuse to guess
    for (const id of [ITEM, OTHER]) {
      handlePost(
        {
          conversationId: CONVERSATION,
          cwd: repo,
          tool_name: 'mcp_devspec_claim_work_item',
          tool_input: { action_item_id: id },
          tool_response: { content: [{ type: 'text', text: JSON.stringify({ id }) }] },
        },
        { env },
      )
    }
    const ambiguous = await runDevspecToolInput(
      JSON.stringify({
        conversationId: CONVERSATION,
        cwd: repo,
        tool_name: 'run_command',
        tool_input: { CommandLine: 'git commit -m "which item?"', Cwd: repo },
      }),
      { env },
    )
    assert.equal(ambiguous.decision, 'deny')
    assert.match(ambiguous.reason, new RegExp(ITEM))
    assert.match(ambiguous.reason, new RegExp(OTHER))
  })

  it('supports heredoc commit parsing, simple git push detection, and online validation', async () => {
    assert.equal(isSimpleGitPush('git push origin staging'), true)
    assert.equal(
      heredocGitCommit(`git add -A && git commit -q -F - <<'MSG'\nsubject\n\nbody\nMSG`).message,
      'subject\n\nbody',
    )
    assert.equal(referenceIn(`feat: x [devspec:${ITEM}]`), ITEM)
    assert.equal(
      handleSessionStart().hookSpecificOutput.additionalContext,
      `DevSpec implementation contract: ${CONTRACT_URI}`,
    )

    // Test online confirmation against a local HTTP server
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  local: { status: 'well_formed', shape: 'full_uuid', reference: ITEM },
                  online: { status: 'not_found' },
                }),
              },
            ],
          },
        }),
      )
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const mcpUrl = `http://127.0.0.1:${server.address().port}/api/mcp`
      const outcome = await confirmReferenceOnline(`feat: bad ref [devspec:${ITEM}]`, {
        cwd: repo,
        env: { ...env, DEVSPEC_MCP_URL: mcpUrl, DEVSPEC_MCP_TOKEN: 'tok' },
      })
      assert.equal(outcome, 'not_found')
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
})

describe('unclaimed-edit provenance nudge lifecycle via PostInvocation', () => {
  it('stages a provenance nudge when editing tracked files without a claim and injects ephemeralMessage on PostInvocation once', async () => {
    const editPayload = {
      conversationId: CONVERSATION,
      cwd: repo,
      tool_name: 'replace_file_content',
      tool_input: {
        TargetFile: path.join(repo, 'index.js'),
      },
    }

    // PreToolUse allows the edit and stages the pending nudge
    const preOut = await handlePre(editPayload, { env })
    assert.ok(preOut)
    assert.equal(preOut.hookSpecificOutput?.permissionDecision, undefined)
    assert.match(preOut.systemMessage, /no work item is claimed/i)

    // PostInvocation injects the staged nudge as an ephemeralMessage
    const invOut = await runPostInvocation(JSON.stringify({ conversationId: CONVERSATION }), { env })
    assert.ok(invOut, 'PostInvocation should return the staged provenance nudge')
    assert.equal(Array.isArray(invOut.injectSteps), true)
    assert.equal(invOut.injectSteps.length, 1)
    assert.equal(typeof invOut.injectSteps[0].ephemeralMessage, 'string')
    assert.match(invOut.injectSteps[0].ephemeralMessage, /no work item is claimed/i)
    assert.match(invOut.additionalContext, /no work item is claimed/i)

    // Subsequent PostInvocation and edits in the same session+repo stay quiet
    assert.equal(await runPostInvocation(JSON.stringify({ conversationId: CONVERSATION }), { env }), null)
    assert.equal(await handlePre(editPayload, { env }), null)
    assert.equal(pendingNudgeNotice({ input: { conversationId: CONVERSATION }, env }), null)
  })

  it('clears any staged nudge if the agent claims a work item before PostInvocation', async () => {
    await handlePre(
      {
        conversationId: CONVERSATION,
        cwd: repo,
        tool_name: 'write_to_file',
        tool_input: { TargetFile: path.join(repo, 'new.js') },
      },
      { env },
    )
    // Agent claims an item in the same turn
    handlePost(
      {
        conversationId: CONVERSATION,
        cwd: repo,
        tool_name: 'mcp_devspec_claim_work_item',
        tool_input: { action_item_id: ITEM },
        tool_response: { content: [{ type: 'text', text: JSON.stringify({ id: ITEM }) }] },
      },
      { env },
    )
    // PostInvocation does not nag since a claim is now active
    assert.equal(await runPostInvocation(JSON.stringify({ conversationId: CONVERSATION }), { env }), null)
  })
})

describe('commit-observation.mjs — pre/post git commit observation', () => {
  const connState = {
    connection_id: '11111111-1111-4111-8111-111111111111',
    mcp_url: 'https://example.invalid/api/mcp',
    token: 'fixture-secret',
    connection_capability: 'fixture-capability',
    enabled: true,
    local_id: CONVERSATION,
  }

  it('snapshots git state before run_command git mutations and reports new commit SHAs via report_commit_provenance with active action_item_id and provenance_ref', async () => {
    // Active claim in this conversation+repo
    handlePost(
      {
        conversationId: CONVERSATION,
        cwd: repo,
        tool_name: 'mcp_devspec_claim_work_item',
        tool_input: { action_item_id: ITEM, provenance_ref: PROV_REF },
        tool_response: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                id: ITEM,
                work_claim_ref: CLAIM_REF,
                provenance_ref: PROV_REF,
              }),
            },
          ],
        },
      },
      { env },
    )

    const command = `git commit --allow-empty -q -m "feat: observed [devspec:${ITEM}]"`
    const event = {
      conversationId: CONVERSATION,
      tool_use_id: 'tool-obs-1',
      tool_name: 'run_command',
      tool_input: { CommandLine: command, Cwd: repo },
    }

    handleBashPre(event, { env, boundConnection: () => connState })
    const res = spawnSync('sh', ['-c', command], { cwd: repo, encoding: 'utf8' })
    assert.equal(res.status, 0, res.stderr)

    const calls = []
    await handleBashPost(
      {
        ...event,
        tool_response: { stdout: res.stdout, stderr: res.stderr, exit_code: res.status },
      },
      {
        env,
        boundConnection: () => connState,
        includeClaimArguments: true,
        call: async (val) => {
          calls.push(val)
        },
      },
    )

    assert.equal(calls.length, 1)
    assert.equal(calls[0].name, 'report_commit_provenance')
    assert.equal(calls[0].arguments.connection_id, connState.connection_id)
    assert.equal(calls[0].arguments.commit_sha, git(['rev-parse', 'HEAD'], repo))
    assert.equal(calls[0].arguments.pinned_project_id, PROJECT)
    assert.equal(calls[0].action_item_id, ITEM)
    assert.equal(calls[0].provenance_ref, PROV_REF)
    assert.equal(calls[0].arguments.action_item_id, ITEM)
    assert.equal(calls[0].arguments.provenance_ref, PROV_REF)
    assert.match(calls[0].arguments.observation_id, /^[0-9a-f-]{36}$/)
  })

  it('works end-to-end through runDevspecToolInput and runPostToolDispatch when auto-stamping a commit', async () => {
    const connDir = path.join(sandbox, '.devspec', 'remote-control', 'connections')
    fs.mkdirSync(connDir, { recursive: true, mode: 0o700 })
    const connFile = path.join(connDir, `${connState.connection_id}.json`)
    fs.writeFileSync(connFile, JSON.stringify(connState), { mode: 0o600 })

    // Claim via runPostToolDispatch
    await runPostToolDispatch(
      JSON.stringify({
        conversationId: CONVERSATION,
        cwd: repo,
        tool_name: 'mcp_devspec_claim_work_item',
        tool_input: { action_item_id: ITEM, provenance_ref: PROV_REF },
        tool_response: {
          content: [{ type: 'text', text: JSON.stringify({ id: ITEM, provenance_ref: PROV_REF }) }],
        },
      }),
      { env, home: sandbox },
    )

    // PreToolUse auto-stamps the commit AND snapshots pre-commit git state
    const preResult = await runDevspecToolInput(
      JSON.stringify({
        conversationId: CONVERSATION,
        cwd: repo,
        tool_use_id: 'tool-e2e-1',
        tool_name: 'run_command',
        tool_input: { CommandLine: 'git commit --allow-empty -q -m "feat: e2e"', Cwd: repo },
      }),
      {
        env,
        home: sandbox,
        boundConnection: () => connState,
      },
    )
    assert.equal(preResult.decision, 'allow')
    const stampedCmd = preResult.overwrite.CommandLine
    assert.equal(stampedCmd, `git commit --allow-empty -q -m "feat: e2e [devspec:${ITEM}]"`)

    // Execute the stamped commit
    const execRes = spawnSync('sh', ['-c', stampedCmd], { cwd: repo, encoding: 'utf8' })
    assert.equal(execRes.status, 0, execRes.stderr)

    const calls = []
    await handleBashPost(
      {
        conversationId: CONVERSATION,
        cwd: repo,
        tool_use_id: 'tool-e2e-1',
        tool_name: 'run_command',
        tool_input: { CommandLine: stampedCmd, Cwd: repo },
        tool_response: { exit_code: 0 },
      },
      {
        env,
        boundConnection: () => connState,
        call: async (val) => calls.push(val),
      },
    )
    assert.equal(calls.length, 1)
    assert.equal(calls[0].arguments.commit_sha, git(['rev-parse', 'HEAD'], repo))
    assert.equal(calls[0].action_item_id, ITEM)
    assert.equal(calls[0].provenance_ref, PROV_REF)
  })

  it('ignores failed commits, non-commit commands, and unmarked repos', async () => {
    assert.equal(commitRepoDir('cd "/tmp/a b" && git commit -m "x"', '/fallback'), '/tmp/a b')
    assert.equal(inJurisdiction(repo, env), true)
    const connDir = path.join(sandbox, 'conns')
    fs.mkdirSync(connDir, { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(connDir, 'c.json'), JSON.stringify(connState), { mode: 0o600 })
    assert.equal(boundConnection(CONVERSATION, connDir).connection_id, connState.connection_id)

    const failedEvent = {
      conversationId: CONVERSATION,
      tool_use_id: 'tool-fail',
      tool_name: 'run_command',
      tool_input: { CommandLine: 'git commit -q -m "nothing staged"', Cwd: repo },
    }
    handleBashPre(failedEvent, { env, boundConnection: () => connState })
    const calls = []
    await handleBashPost(
      { ...failedEvent, tool_response: { exit_code: 1 } },
      { env, boundConnection: () => connState, call: async (v) => calls.push(v) },
    )
    assert.equal(calls.length, 0)
  })

  it('tracks claims and stamps commits from Antigravity protojson payloads (toolCall.name, toolCall.args, workspacePaths)', async () => {
    handlePost(
      {
        conversationId: CONVERSATION,
        workspacePaths: [repo],
        toolCall: {
          name: 'mcp_devspec_claim_work_item',
          args: { action_item_id: ITEM, provenance_ref: PROV_REF },
        },
      },
      { env },
    )
    assert.deepEqual(readClaims(scope(), { env }), [ITEM])

    const preResult = await runDevspecToolInput(
      JSON.stringify({
        conversationId: CONVERSATION,
        workspacePaths: [repo],
        toolCall: {
          name: 'run_command',
          args: { CommandLine: 'git commit -m "feat: protojson payload"', Cwd: repo },
        },
      }),
      { env },
    )
    assert.equal(preResult.decision, 'allow')
    assert.equal(
      preResult.overwrite.CommandLine,
      `git commit -m "feat: protojson payload [devspec:${ITEM}]"`,
    )
  })

  it('resolves action item title, work_claim_ref, and automation name in Antigravity when PostToolUse omits tool_response', () => {
    const testEnv = { ...env, HOME: sandbox }
    const brainDir = path.join(sandbox, '.gemini', 'antigravity-cli', 'brain', CONVERSATION)
    const stepDir = path.join(brainDir, '.system_generated', 'steps', '42')
    fs.mkdirSync(stepDir, { recursive: true, mode: 0o700 })

    // 1. Antigravity fires PostToolUse BEFORE steps/42/output.txt is flushed to disk (no tool_response)
    handlePost(
      {
        conversationId: CONVERSATION,
        stepIdx: 42,
        artifactDirectoryPath: brainDir,
        workspacePaths: [repo],
        toolCall: {
          name: 'call_mcp_tool',
          args: {
            ServerName: 'devspec',
            ToolName: 'claim_work_item',
            Arguments: { action_item_id: ITEM, agent_branch: 'feat/test' },
          },
        },
      },
      { env: testEnv },
    )

    // Initially recorded with title: null because output.txt wasn't written yet
    assert.deepEqual(readClaimedWorkItems(scope(), { env: testEnv }), [
      { id: ITEM, title: null, work_claim_ref: null, provenance_ref: null },
    ])

    // 2. Antigravity flushes steps/42/output.txt right as the tool step completes
    fs.writeFileSync(
      path.join(stepDir, 'output.txt'),
      JSON.stringify({
        id: ITEM,
        title: 'Status line action item title resolution',
        work_claim_ref: CLAIM_REF,
      }),
      { mode: 0o600 },
    )

    // 3. statusline.mjs renders the full title AND backfills .claims.json (including work_claim_ref)
    const connDir = path.join(sandbox, '.devspec', 'remote-control', 'connections')
    fs.mkdirSync(connDir, { recursive: true, mode: 0o700 })
    fs.writeFileSync(
      path.join(connDir, `${connState.connection_id}.json`),
      JSON.stringify({
        ...connState,
        session_codename: 'Curious Badger',
        project_name: 'DevSpec',
        session_id: '7069bedd-878d-4c5a-b52c-b5cfc1bcd544',
        session_title: 'Remote Session',
        session_title_for: '7069bedd-878d-4c5a-b52c-b5cfc1bcd544',
      }),
      { mode: 0o600 },
    )
    const bondDir = path.join(sandbox, '.devspec', 'remote-control', 'local', 'antigravity')
    fs.mkdirSync(bondDir, { recursive: true, mode: 0o700 })
    fs.writeFileSync(
      path.join(bondDir, `${CONVERSATION}.json`),
      JSON.stringify({ connection_id: connState.connection_id }),
      { mode: 0o600 },
    )

    const line = renderStatusLine(
      JSON.stringify({ conversation_id: CONVERSATION, cwd: repo }),
      { home: sandbox, env: testEnv },
    )
    assert.match(
      line,
      /DevSpec: Curious Badger · DevSpec · “Remote Session” · working on “Status line action item title resolution” \(cdd7a494\)/,
    )
    assert.deepEqual(readClaimedWorkItems(scope(), { env: testEnv }), [
      {
        id: ITEM,
        title: 'Status line action item title resolution',
        work_claim_ref: CLAIM_REF,
        provenance_ref: null,
      },
    ])
    assert.equal(readClaimDetails(scope(), { env: testEnv })?.work_claim_ref, CLAIM_REF)

    // 4. record_implementation via node -e with escaped quotes releases the claim
    handlePost(
      {
        conversationId: CONVERSATION,
        workspacePaths: [repo],
        toolCall: {
          name: 'run_command',
          args: {
            CommandLine: `node -e "mcpToolsCall({ name: \\"record_implementation\\", arguments: { \\"action_item_id\\": \\"${ITEM}\\" } })"`,
            Cwd: repo,
          },
        },
      },
      { env: testEnv },
    )
    assert.deepEqual(readClaims(scope(), { env: testEnv }), [])

    // 5. Automation run dispatched via .inbox.jsonl + claimed via call_mcp_tool without tool_response
    const runId = '88888888-8888-4888-8888-888888888888'
    const autoId = '99999999-9999-4999-8999-999999999999'
    fs.writeFileSync(
      path.join(connDir, `${connState.connection_id}.inbox.jsonl`),
      `${JSON.stringify({
        type: 'automation_run',
        dispatch: {
          run_id: runId,
          automation_id: autoId,
          automation_name: 'Nightly Regression Sweep',
        },
      })}\n`,
      { mode: 0o600 },
    )

    handlePost(
      {
        conversationId: CONVERSATION,
        workspacePaths: [repo],
        toolCall: {
          name: 'call_mcp_tool',
          args: {
            ServerName: 'devspec',
            ToolName: 'claim_automation_run',
            Arguments: { run_id: runId },
          },
        },
      },
      { env: testEnv },
    )

    assert.deepEqual(readActiveAutomation(scope(), { env: testEnv }), {
      run_id: runId,
      automation_id: autoId,
      automation_name: 'Nightly Regression Sweep',
    })

    const autoLine = renderStatusLine(
      JSON.stringify({ conversation_id: CONVERSATION, cwd: repo }),
      { home: sandbox, env: testEnv },
    )
    assert.match(autoLine, /automation “Nightly Regression Sweep”/)

    // 6. record_automation_run without tool_response clears the active automation
    handlePost(
      {
        conversationId: CONVERSATION,
        workspacePaths: [repo],
        toolCall: {
          name: 'call_mcp_tool',
          args: {
            ServerName: 'devspec',
            ToolName: 'record_automation_run',
            Arguments: { run_id: runId, status: 'succeeded' },
          },
        },
      },
      { env: testEnv },
    )
    assert.equal(readActiveAutomation(scope(), { env: testEnv }), null)
  })
})
