#!/usr/bin/env node
/**
 * Tests for Antigravity Parity 2 (6307458c):
 * - One-shot mechanical connect (`devspec-remote-connect.mjs`)
 * - Window-open auto-connect (`maybeSpawnWindowAutoConnect` + `owner_pid` rebonding)
 * - Persistent `devspec-remote-listen.mjs` wake formatting (`canonical_commands`, `automation_run`, `interaction_answer`, `question_dismissal`)
 * - `PreToolUse` pass-through empty stdout contract (never emitting `{}` with empty decision)
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  connect,
  ConnectError,
  parseArgs as parseConnectArgs,
  renderStatusBlock,
} from './devspec-remote-connect.mjs'
import { buildWakeDeliveryMessage, deliverWakeViaAgentApi } from './devspec-remote-listen.mjs'
import { resolveLocalAction, writeStateFile } from './remote-control-state.mjs'
import { maybeSpawnWindowAutoConnect, readConnectionView } from './statusline.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CONN_ID = '55bf32b1-5e67-4151-b478-cf3fa7a03acc'
const SESS_ID = '7069bedd-878d-4c5a-b52c-b5cfc1bcd544'
const PROJ_ID = '24c4abaa-2cb9-496a-8492-cf1f1aa1090b'
const CONV_ID = '64bbe87f-6468-4827-af09-b2bfc7fbf773'

describe('devspec-remote-connect.mjs — one-shot mechanical connect', () => {
  it('parses CLI flags and connects in one call, storing 4-tier instructions and repository context', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-connect-test-'))
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-connect-cwd-'))
    try {
      const parsed = parseConnectArgs([
        '--project',
        'DevSpec',
        '--session',
        SESS_ID,
        '--name',
        'Nimble Hawk',
        '--owner-pid',
        String(process.pid),
      ])
      assert.equal(parsed.project, 'DevSpec')
      assert.equal(parsed.session, SESS_ID)
      assert.equal(parsed.name, 'Nimble Hawk')

      assert.throws(() => parseConnectArgs(['--project']), ConnectError)
      assert.throws(() => parseConnectArgs(['--project=DevSpec']), ConnectError)

      const calls = []
      const summary = await connect(
        {
          session: SESS_ID,
          name: 'Nimble Hawk',
          cwd,
          localId: CONV_ID,
          ownerPid: process.pid,
          noPoller: true,
          env: { DEVSPEC_MCP_TOKEN: 'dvs_test_token_123456' },
        },
        {
          projectHome: home,
          resolveAuth: () => ({
            ok: true,
            token: 'dvs_test_token_123456',
            mcp_url: 'https://api.devspecstaging.com/api/mcp',
            source: 'test',
          }),
          callTool: async (req) => {
            calls.push(req)
            if (req.name === 'register_connection') {
              req.onResultMeta?.({
                devspec: {
                  connection_capability: {
                    version: 1,
                    value: 'dvsc_secret_capability_token_123',
                  },
                },
              })
              return {
                connection_id: CONN_ID,
                codename: 'Nimble Hawk',
                created: true,
                project_id: PROJ_ID,
                project_selection: {
                  version: 1,
                  status: 'selected',
                  source: 'git_remote',
                  project: {
                    id: PROJ_ID,
                    name: 'DevSpec',
                    organization: { id: PROJ_ID, name: 'DevSpecAI' },
                  },
                },
                instruction_tiers_version: 1,
                instruction_tiers_hash:
                  'sha256:4fa65a9cf4e5b6599099456d2e7f361ec42c15a5d41e90e2d0205a32920c348e',
                owner_agent_rules: 'VERIFY AT THE RIGHT LAYER.',
                project_custom_instructions: 'All work goes through DevSpec items.',
                project_agent_rules: 'Do each task in its own git worktree.',
                repository_context: {
                  version: 1,
                  project_id: PROJ_ID,
                  status: 'available',
                  repositories: [
                    {
                      id: '3dc44ec7-d91a-4392-8388-71063f9fb5ce',
                      full_name: 'DevSpecAI/DevSpec-Antigravity-Plugin',
                      provider: 'github',
                      git_url: 'https://github.com/DevSpecAI/DevSpec-Antigravity-Plugin.git',
                      target_branch: 'staging',
                      default_branch: 'main',
                    },
                  ],
                },
              }
            }
            if (req.name === 'attach_connection') {
              return {
                connection_id: CONN_ID,
                session_id: SESS_ID,
                instructions_unchanged: true,
              }
            }
            return {}
          },
        },
      )

      assert.equal(summary.ok, true)
      assert.equal(summary.connection_id, CONN_ID)
      assert.equal(summary.codename, 'Nimble Hawk')
      assert.equal(summary.session_id, SESS_ID)
      assert.equal(summary.project_id, PROJ_ID)
      assert.equal(summary.connection_capability_present, true)
      assert.equal(summary.cursor_flag, '--from-end')

      const block = renderStatusBlock(summary, { noPoller: true, home })
      assert.match(block, /Agent:\s+Antigravity · Nimble Hawk/)
      assert.match(block, /Project:\s+DevSpec \(git_remote\)/)
      assert.match(block, /ARM THE BACKGROUND WAIT NOW/)
      assert.match(block, /Instructions in force for this run/)
      assert.match(block, /\.tiers-[a-f0-9]{64}\.txt/)
      assert.match(block, /<devspec-repository-data>/)
      assert.match(block, /DevSpecAI\/DevSpec-Antigravity-Plugin/)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })
})

describe('Window-open auto-connect & owner_pid startup connection rebonding', () => {
  it('displays an owner_pid-anchored startup connection before conversationId exists and rebonds it on first prompt', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-win-autoconnect-'))
    const connDir = path.join(home, '.devspec', 'remote-control', 'connections')
    const rcDir = path.join(home, '.devspec', 'remote-control')
    fs.mkdirSync(connDir, { recursive: true })
    try {
      // Simulate a connection created at window open (local_id: null, owner_pid: process.pid)
      writeStateFile(
        CONN_ID,
        {
          enabled: true,
          connection_id: CONN_ID,
          session_id: null,
          session_codename: 'Playful Dolphin',
          project_id: PROJ_ID,
          project_name: 'DevSpec',
          agent_name: 'Antigravity',
          local_id: null,
          owner_pid: process.pid,
        },
        connDir,
      )

      // 1. readConnectionView with conversationId=null finds the connection by owner_pid (when resolved)
      const viewByExplicit = readConnectionView({
        home,
        connectionId: CONN_ID,
        conversationId: null,
      })
      assert.ok(viewByExplicit)
      assert.equal(viewByExplicit.codename, 'Playful Dolphin')
      assert.equal(viewByExplicit.projectName, 'DevSpec')

      // 2. resolveLocalAction with ownerPid adopts and rebonds the local_id: null startup connection
      const states = [JSON.parse(fs.readFileSync(path.join(connDir, `${CONN_ID}.json`), 'utf8'))]
      const action = resolveLocalAction({
        agent: 'Antigravity',
        localId: CONV_ID,
        ownerPid: process.pid,
        listStates: () => states,
        readConnection: () => states[0],
        readBond: (_agent, lid) => {
          const p = path.join(rcDir, 'local', 'antigravity', `${lid}.json`)
          return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null
        },
      })
      assert.equal(action.local_id, CONV_ID)

      // 3. maybeSpawnWindowAutoConnect spawns once per ownerPid and respects the lockfile
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-spawn-cwd-'))
      fs.mkdirSync(path.join(cwd, '.devspec'), { recursive: true })
      fs.writeFileSync(
        path.join(cwd, '.devspec', 'project.json'),
        JSON.stringify({ project_id: PROJ_ID }),
      )
      const spawns = []
      const firstSpawn = maybeSpawnWindowAutoConnect({
        cwd,
        ownerPid: 99999,
        home,
        env: { DEVSPEC_MCP_TOKEN: 'dvs_valid_test_token_123456' },
        spawnImpl: (cmd, args) => {
          spawns.push({ cmd, args })
          return { pid: 12345, unref() {} }
        },
      })
      assert.equal(firstSpawn.spawned, true)
      assert.equal(spawns.length, 1)

      const secondSpawn = maybeSpawnWindowAutoConnect({
        cwd,
        ownerPid: 99999,
        home,
        env: { DEVSPEC_MCP_TOKEN: 'dvs_valid_test_token_123456' },
        spawnImpl: () => {
          throw new Error('should not spawn twice while lock is fresh')
        },
      })
      assert.equal(secondSpawn.spawned, false)
      assert.equal(secondSpawn.reason, 'already_attempted')
      fs.rmSync(cwd, { recursive: true, force: true })
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('devspec-remote-listen.mjs — canonical & legacy wake formatting', () => {
  it('formats canonical_commands, automation_run, interaction_answer, question_dismissal, and owner_messages', async () => {
    const canonicalWake = buildWakeDeliveryMessage({
      type: 'canonical_commands',
      session_id: SESS_ID,
      execute_message_ids: ['msg-1'],
      instruction_context_file: '/tmp/tiers.txt',
      wake_context: { transcript: '/tmp/t.jsonl', room_state: '/tmp/room.json' },
      ingress: {
        commands: [
          {
            message_id: 'msg-1',
            requester: { display_name: 'Ali Price' },
            authority: { kind: 'owner' },
            content: { body: 'Please continue.' },
          },
        ],
      },
    })
    assert.match(canonicalWake, /Ali Price \(owner\): Please continue\./)
    assert.match(canonicalWake, /Room transcript: \/tmp\/t\.jsonl/)

    const autoWake = buildWakeDeliveryMessage({
      type: 'automation_run',
      dispatch: {
        automation_name: 'Nightly Check',
        run_id: 'run-1',
        delivery_connection_id: CONN_ID,
      },
    })
    assert.match(autoWake, /Nightly Check/)

    const newConvCalls = []
    const res = await deliverWakeViaAgentApi({
      conversationId: null,
      message: canonicalWake,
      env: {
        ANTIGRAVITY_LS_ADDRESS: 'localhost:46803',
        ANTIGRAVITY_CSRF_TOKEN: 'csrf-123',
      },
      execFileImpl: (bin, args, _opts, cb) => {
        newConvCalls.push({ bin, args })
        cb(null, 'started', '')
      },
    })
    assert.equal(res.ok, true)
    assert.equal(newConvCalls[0].args[0], 'new-conversation')
  })
})

describe('PreToolUse pass-through empty stdout contract (compaction regression guard)', () => {
  it('outputs empty stdout on pass-through tool calls so Antigravity never treats an empty {} as a denial', () => {
    const script = path.join(HERE, 'devspec-tool-input.mjs')
    const res = spawnSync(
      process.execPath,
      [script],
      {
        input: JSON.stringify({
          conversationId: CONV_ID,
          workspacePaths: [HERE],
          toolCall: {
            name: 'view_file',
            args: { AbsolutePath: path.join(HERE, 'agent-identity.mjs') },
          },
        }),
        encoding: 'utf8',
      },
    )
    assert.equal(res.status, 0)
    assert.equal(res.stdout, '', 'pass-through PreToolUse must emit empty stdout, never {}')
  })
})
