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
import { formatRoomStateJson, shouldAssertTurnOnPollerInboxWrite } from './devspec-remote-poll.mjs'
import { capTrailForPreToolHook } from './devspec-tool-input.mjs'
import { formatTiersForStartup, readTiersFor, storeTiers } from './instruction-tiers.mjs'
import {
  discoverAntigravityLsAddress,
  resolveLocalAction,
  writeLocalBond,
  writeStateFile,
} from './remote-control-state.mjs'
import {
  invocationNotice,
  prePostHold,
  READER_PAGE_CHARS,
  readerOutput,
  readPage,
  recordMirroredLocalPrompt,
  transcriptPaths,
  wakeNotice,
} from './room-unread.mjs'
import { autoConnectAtStartup } from './session-start.mjs'
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

  it('reuses a fresh (<60s) sessionless registration from SessionStart on bare /devspec-remote without a second register_connection HTTP round-trip', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-reuse-startup-'))
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-reuse-cwd-'))
    const connDir = path.join(home, '.devspec', 'remote-control', 'connections')
    const rcDir = path.join(home, '.devspec', 'remote-control')
    fs.mkdirSync(connDir, { recursive: true })
    const origHome = process.env.HOME
    try {
      process.env.HOME = home
      const regPayload = {
        connection_id: CONN_ID,
        codename: 'Curious Badger',
        created: true,
        project_id: PROJ_ID,
        project_name: 'DevSpec',
        instruction_tiers_version: 1,
        instruction_tiers_hash:
          'sha256:870c7a92399f88c05b92c403d25644e2745a04c38f6284e9d38247f3b6518b2b',
        owner_agent_rules: 'VERIFY AT THE RIGHT LAYER.',
        project_custom_instructions: 'All work goes through DevSpec items.',
      }
      storeTiers(CONN_ID, regPayload, { home, dir: connDir })
      const startupTiers = readTiersFor(CONN_ID, { home, dir: connDir })
      const startupContext = formatTiersForStartup(startupTiers)
      assert.match(startupContext, /## Instructions in force for this run/)
      assert.match(startupContext, /\.tiers-[a-f0-9]{64}\.txt/)
      assert.doesNotMatch(startupContext, /VERIFY AT THE RIGHT LAYER\./)

      writeStateFile(
        CONN_ID,
        {
          enabled: true,
          connection_id: CONN_ID,
          session_id: null,
          session_codename: 'Curious Badger',
          project_id: PROJ_ID,
          project_name: 'DevSpec',
          created_by_session_start: true,
          agent_name: 'Antigravity',
          local_id: CONV_ID,
          cwd,
          owner_pid: process.pid,
          connection_capability: 'dvsc_fresh_startup_cap_123',
          connection_capability_version: 1,
          instruction_tiers_version: 1,
          instruction_tiers_hash:
            'sha256:870c7a92399f88c05b92c403d25644e2745a04c38f6284e9d38247f3b6518b2b',
          updated_at: new Date().toISOString(),
        },
        connDir,
      )
      writeLocalBond(
        'Antigravity',
        CONV_ID,
        {
          status: 'live',
          connection_id: CONN_ID,
          session_id: null,
          session_codename: 'Curious Badger',
          cwd,
          enabled: true,
          updated_at: new Date().toISOString(),
        },
        rcDir,
      )

      let registerCalled = false
      const summary = await connect(
        {
          cwd,
          localId: CONV_ID,
          ownerPid: process.pid,
          noPoller: true,
          env: { HOME: home, DEVSPEC_MCP_TOKEN: 'dvs_test_token_123456' },
        },
        {
          projectHome: home,
          resolveAuth: () => ({
            ok: true,
            token: 'dvs_test_token_123456',
            mcp_url: 'https://api.devspecstaging.com/api/mcp',
            source: 'test',
          }),
          writeState: async (opts) => ({
            path: path.join(connDir, `${opts.connectionId}.json`),
            session_id: opts.sessionId,
            owner_pid: opts.ownerPid,
            mcp_url: 'https://api.devspecstaging.com/api/mcp',
            auth_ok: true,
            auth_source: 'test',
            poller: { skipped: true },
          }),
          callTool: async (req) => {
            if (req.name === 'register_connection') registerCalled = true
            return {}
          },
        },
      )

      assert.equal(registerCalled, false, 'should reuse fresh startup registration without HTTP call')
      assert.equal(summary.connection_id, CONN_ID)
      assert.equal(summary.codename, 'Curious Badger')
      assert.equal(summary.created, true)
      assert.equal(summary.cursor_flag, '--from-end')
    } finally {
      if (origHome === undefined) delete process.env.HOME
      else process.env.HOME = origHome
      fs.rmSync(home, { recursive: true, force: true })
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('upgrades a window-standby connection (agy-window:<pid>) in place with connectionCapability on /devspec-remote without minting a second connection', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-upgrade-window-'))
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-upgrade-cwd-'))
    const connDir = path.join(home, '.devspec', 'remote-control', 'connections')
    fs.mkdirSync(connDir, { recursive: true })
    const origHome = process.env.HOME
    try {
      process.env.HOME = home
      writeStateFile(
        CONN_ID,
        {
          enabled: true,
          connection_id: CONN_ID,
          session_id: null,
          session_codename: 'Swift Otter',
          project_id: PROJ_ID,
          project_name: 'DevSpec',
          created_by_session_start: true,
          agent_name: 'Antigravity',
          local_id: `agy-window:${process.pid}`,
          pending_local_id: `agy-window:${process.pid}`,
          cwd,
          owner_pid: process.pid,
          connection_capability: 'dvsc_window_standby_cap_999',
          connection_capability_version: 1,
          updated_at: new Date().toISOString(),
        },
        connDir,
      )

      const registerCalls = []
      const summary = await connect(
        {
          cwd,
          localId: CONV_ID,
          ownerPid: process.pid,
          noPoller: true,
          env: { HOME: home, DEVSPEC_MCP_TOKEN: 'dvs_test_token_123456' },
        },
        {
          projectHome: home,
          resolveAuth: () => ({
            ok: true,
            token: 'dvs_test_token_123456',
            mcp_url: 'https://api.devspecstaging.com/api/mcp',
            source: 'test',
          }),
          writeState: async (opts) => ({
            path: path.join(connDir, `${opts.connectionId}.json`),
            session_id: opts.sessionId,
            owner_pid: opts.ownerPid,
            mcp_url: 'https://api.devspecstaging.com/api/mcp',
            auth_ok: true,
            auth_source: 'test',
            poller: { skipped: true },
          }),
          callTool: async (req) => {
            if (req.name === 'register_connection') {
              registerCalls.push(req)
              return {
                connection_id: CONN_ID,
                codename: 'Swift Otter',
                created: false,
                project_id: PROJ_ID,
                project_name: 'DevSpec',
              }
            }
            return {}
          },
        },
      )

      assert.equal(registerCalls.length, 1, 'should call register_connection once to upgrade local_id')
      assert.equal(
        registerCalls[0].connectionCapability,
        'dvsc_window_standby_cap_999',
        'must present window standby capability header when upgrading local_id',
      )
      assert.equal(registerCalls[0].arguments.local_id, CONV_ID)
      assert.equal(summary.connection_id, CONN_ID)
      assert.equal(summary.codename, 'Swift Otter')
    } finally {
      if (origHome === undefined) delete process.env.HOME
      else process.env.HOME = origHome
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

      // 3. maybeSpawnWindowAutoConnect is disabled by default unless opted in, and when opted in spawns once per ownerPid
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-spawn-cwd-'))
      fs.mkdirSync(path.join(cwd, '.devspec'), { recursive: true })
      fs.writeFileSync(
        path.join(cwd, '.devspec', 'project.json'),
        JSON.stringify({ project_id: PROJ_ID }),
      )
      const defaultDisabled = maybeSpawnWindowAutoConnect({
        cwd,
        ownerPid: 99999,
        home,
        env: { DEVSPEC_MCP_TOKEN: 'dvs_valid_test_token_123456' },
      })
      assert.equal(defaultDisabled.spawned, false)
      assert.equal(defaultDisabled.reason, 'disabled_or_unconfigured')

      const spawns = []
      const firstSpawn = maybeSpawnWindowAutoConnect({
        cwd,
        ownerPid: 99999,
        home,
        env: { DEVSPEC_MCP_TOKEN: 'dvs_valid_test_token_123456', DEVSPEC_CONNECT_AT_STARTUP: '1' },
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
        env: { DEVSPEC_MCP_TOKEN: 'dvs_valid_test_token_123456', DEVSPEC_CONNECT_AT_STARTUP: '1' },
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
  it('formats canonical_commands with full formatInboxEntryForStream JSON lines (provenance_ref, sender_response_style, rearm: already_armed)', async () => {
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
            requester: { display_name: 'Ali Price', user_id: 'u-1', kind: 'human' },
            authority: { kind: 'owner', target_match: 'exact', executable: true },
            content: { body: 'Please continue.' },
            sender_response_style: ['Use numbered sections and clickable file links.'],
            delivery: {
              provenance_ref: {
                kind: 'session_command',
                session_id: SESS_ID,
                message_id: 'msg-1',
              },
            },
          },
        ],
      },
    })
    assert.match(canonicalWake, /Ali Price \(owner\): Please continue\./)
    assert.match(canonicalWake, /Room transcript: \/tmp\/t\.jsonl/)
    assert.match(canonicalWake, /"type":"owner_message"/)
    assert.match(canonicalWake, /"provenance_ref":\{"kind":"session_command","session_id":"7069bedd-878d-4c5a-b52c-b5cfc1bcd544","message_id":"msg-1"\}/)
    assert.match(canonicalWake, /"sender_response_style":\["Use numbered sections and clickable file links\."\]/)
    assert.match(canonicalWake, /"rearm":"already_armed"/)

    const autoWake = buildWakeDeliveryMessage({
      type: 'automation_run',
      dispatch: {
        automation_name: 'Nightly Check',
        run_id: 'run-1',
        delivery_connection_id: CONN_ID,
      },
    })
    assert.match(autoWake, /Nightly Check/)
    assert.match(autoWake, /"type":"automation_run"/)

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

  it('uses ANTIGRAVITY_AGENTAPI_EXE when available and treats JSON stdout with an error field as failed delivery', async () => {
    const exeCalls = []
    const okRes = await deliverWakeViaAgentApi({
      conversationId: CONV_ID,
      message: 'wake payload',
      env: {
        ANTIGRAVITY_AGENTAPI_EXE: '/opt/antigravity/bin/agy',
        ANTIGRAVITY_LS_ADDRESS: 'localhost:46803',
        ANTIGRAVITY_CSRF_TOKEN: 'csrf-123',
      },
      execFileImpl: (bin, args, _opts, cb) => {
        exeCalls.push({ bin, args })
        cb(null, '{"status":"ok"}', '')
      },
      existsImpl: (file) => file === '/opt/antigravity/bin/agy',
    })
    assert.equal(okRes.ok, true)
    assert.equal(exeCalls[0].bin, '/opt/antigravity/bin/agy')
    assert.deepEqual(exeCalls[0].args.slice(0, 3), ['agentapi', 'send-message', CONV_ID])

    const errRes = await deliverWakeViaAgentApi({
      conversationId: CONV_ID,
      message: 'wake payload',
      env: {
        ANTIGRAVITY_AGENTAPI_EXE: '/opt/antigravity/bin/agy',
        ANTIGRAVITY_LS_ADDRESS: 'localhost:46803',
        ANTIGRAVITY_CSRF_TOKEN: 'csrf-123',
      },
      execFileImpl: (_bin, _args, _opts, cb) => {
        cb(null, '{"error":"language server unreachable"}', '')
      },
      existsImpl: (file) => file === '/opt/antigravity/bin/agy',
    })
    assert.equal(errRes.ok, false)
    assert.match(errRes.error, /language server unreachable/)

    // agy renamed the running binary to agy.<n>.old on update and a later launch
    // deleted it, while the env still names it (8fdbf73e): strip the .old suffix
    // and invoke the live agy binary directly with `agentapi`, never the shared
    // ~/.gemini/antigravity-cli/bin/agentapi wrapper (which pre-update agy processes
    // overwrite with deleted /proc/self/exe paths on Linux and which is a .bat on Windows).
    const staleCalls = []
    const wrapper = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'bin', 'agentapi')
    const staleRes = await deliverWakeViaAgentApi({
      conversationId: CONV_ID,
      message: 'wake payload',
      env: {
        ANTIGRAVITY_AGENTAPI_EXE: '/home/someone/.local/bin/agy.1792139574779166696.old',
        ANTIGRAVITY_LS_ADDRESS: 'localhost:46803',
        ANTIGRAVITY_CSRF_TOKEN: 'csrf-123',
      },
      execFileImpl: (bin, args, _opts, cb) => {
        staleCalls.push({ bin, args })
        cb(null, 'sent', '')
      },
      existsImpl: (file) => file === '/home/someone/.local/bin/agy' || file === wrapper,
    })
    assert.equal(staleRes.ok, true)
    assert.equal(staleCalls[0].bin, '/home/someone/.local/bin/agy')
    assert.deepEqual(staleCalls[0].args.slice(0, 3), ['agentapi', 'send-message', CONV_ID])

    // Windows self-update suffix (`agy.exe.<n>.old` -> `agy.exe`)
    const winCalls = []
    const winRes = await deliverWakeViaAgentApi({
      conversationId: CONV_ID,
      message: 'wake payload',
      env: {
        ANTIGRAVITY_AGENTAPI_EXE: 'C:\\Users\\someone\\AppData\\Local\\Programs\\Antigravity\\agy.exe.1792139574779166696.old',
        ANTIGRAVITY_LS_ADDRESS: 'localhost:46803',
        ANTIGRAVITY_CSRF_TOKEN: 'csrf-123',
      },
      execFileImpl: (bin, args, _opts, cb) => {
        winCalls.push({ bin, args })
        cb(null, 'sent', '')
      },
      existsImpl: (file) => file === 'C:\\Users\\someone\\AppData\\Local\\Programs\\Antigravity\\agy.exe',
    })
    assert.equal(winRes.ok, true)
    assert.equal(winCalls[0].bin, 'C:\\Users\\someone\\AppData\\Local\\Programs\\Antigravity\\agy.exe')
    assert.deepEqual(winCalls[0].args.slice(0, 3), ['agentapi', 'send-message', CONV_ID])

    // Fallback to `agy agentapi` on PATH if neither explicitExe nor stripped path exists
    const fallbackCalls = []
    const fallbackRes = await deliverWakeViaAgentApi({
      conversationId: CONV_ID,
      message: 'wake payload',
      env: {
        ANTIGRAVITY_AGENTAPI_EXE: '/home/someone/.local/bin/agy.1792139574779166696.old',
        ANTIGRAVITY_LS_ADDRESS: 'localhost:46803',
        ANTIGRAVITY_CSRF_TOKEN: 'csrf-123',
      },
      execFileImpl: (bin, args, _opts, cb) => {
        fallbackCalls.push({ bin, args })
        cb(null, 'sent', '')
      },
      existsImpl: () => false,
    })
    assert.equal(fallbackRes.ok, true)
    assert.equal(fallbackCalls[0].bin, 'agy')
    assert.deepEqual(fallbackCalls[0].args.slice(0, 3), ['agentapi', 'send-message', CONV_ID])
  })

  it('renders wake: ALREADY ARMED when wake_armed is true and ARM THE BACKGROUND WAIT NOW when false', () => {
    const armedBlock = renderStatusBlock({
      status: 'connected',
      connection_id: CONN_ID,
      agent_name: 'Steady Jackal',
      project_id: PROJ_ID,
      project_name: 'DevSpec',
      session_id: SESS_ID,
      reconnected: false,
      poller_pid: 1234,
      listener_pid: 5678,
      wake_armed: true,
      wait_mode: '--from-end',
      wait_script: '/path/to/devspec-remote-wait.mjs',
    })
    assert.match(armedBlock, /wake: ALREADY ARMED \(listener pid 5678\)/)
    assert.doesNotMatch(armedBlock, /ARM THE BACKGROUND WAIT NOW/)

    const unarmedBlock = renderStatusBlock({
      status: 'connected',
      connection_id: CONN_ID,
      agent_name: 'Steady Jackal',
      project_id: PROJ_ID,
      project_name: 'DevSpec',
      session_id: SESS_ID,
      reconnected: false,
      poller_pid: 1234,
      listener_pid: null,
      wake_armed: false,
      wait_mode: '--from-end',
      wait_script: '/path/to/devspec-remote-wait.mjs',
    })
    assert.match(unarmedBlock, /ARM THE BACKGROUND WAIT NOW/)
  })
})

describe('room-unread.mjs — mirrored local prompt & single-command wake watermark suppression', () => {
  it('suppresses redundant room-unread notices for mirrored local prompts and already-delivered wake commands', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-room-watermark-'))
    try {
      const paths = transcriptPaths(CONN_ID, SESS_ID, dir)
      fs.writeFileSync(paths.state, JSON.stringify({ self_label: 'Steady Jackal' }))

      // 1. User types a local terminal prompt that mirror-turn.mjs mirrors to the session
      const localPromptText = 'What do you think about our setup?'
      recordMirroredLocalPrompt(CONN_ID, SESS_ID, {
        messageId: 'msg-local-1',
        text: localPromptText,
        dir,
      })

      // Poller later syncs that mirrored message into .transcript.jsonl
      const mirroredLine = {
        seq: 1,
        at: '2026-10-15T10:00:00Z',
        message_id: 'msg-local-1',
        from: { label: 'Ali Price', kind: 'human' },
        to: 'Steady Jackal',
        state: 'active',
        text: localPromptText,
      }
      fs.writeFileSync(paths.transcript, JSON.stringify(mirroredLine) + '\n')

      assert.equal(
        invocationNotice({ connectionId: CONN_ID, sessionId: SESS_ID, dir }),
        null,
        'mirrored local prompt must not trigger PostInvocation unread notice',
      )
      assert.equal(
        prePostHold({ connectionId: CONN_ID, sessionId: SESS_ID, dir }),
        null,
        'mirrored local prompt must not block post_session_message in prePostHold',
      )

      // 2. Single-command wake arrives where the delivered command is the only new message in the room
      const remoteCmdLine = {
        seq: 2,
        at: '2026-10-15T10:01:00Z',
        message_id: 'msg-remote-2',
        from: { label: 'Ali Price', kind: 'human' },
        to: 'Steady Jackal',
        state: 'active',
        text: 'Please check the action items.',
      }
      fs.writeFileSync(
        paths.transcript,
        [JSON.stringify(mirroredLine), JSON.stringify(remoteCmdLine)].join('\n') + '\n',
      )

      const singleWake = wakeNotice({
        connectionId: CONN_ID,
        sessionId: SESS_ID,
        deliveredCommandIds: ['msg-remote-2'],
        deliveredCommands: [
          {
            message_id: 'msg-remote-2',
            content: { body: 'Please check the action items.' },
          },
        ],
        dir,
      })
      assert.equal(
        singleWake,
        null,
        'wakeNotice should return null when the delivered command is the only unread message in the room',
      )
      assert.equal(
        invocationNotice({ connectionId: CONN_ID, sessionId: SESS_ID, dir }),
        null,
        'delivered wake command should also be marked read for subsequent PostInvocation checks',
      )

      // 3. Another room participant posts an advisory message alongside a command -> wakeNotice should report 1 unread
      const peerLine = {
        seq: 3,
        at: '2026-10-15T10:02:00Z',
        message_id: 'msg-peer-3',
        from: { label: 'Other Agent', kind: 'agent_session' },
        to: 'room',
        state: 'active',
        text: 'FYI I updated the schema.',
      }
      const nextCmdLine = {
        seq: 4,
        at: '2026-10-15T10:02:05Z',
        message_id: 'msg-remote-4',
        from: { label: 'Ali Price', kind: 'human' },
        to: 'Steady Jackal',
        state: 'active',
        text: 'Take a look at what Other Agent posted.',
      }
      fs.writeFileSync(
        paths.transcript,
        [mirroredLine, remoteCmdLine, peerLine, nextCmdLine].map((l) => JSON.stringify(l)).join('\n') + '\n',
      )

      const multiWake = wakeNotice({
        connectionId: CONN_ID,
        sessionId: SESS_ID,
        deliveredCommandIds: ['msg-remote-4'],
        deliveredCommands: [
          {
            message_id: 'msg-remote-4',
            content: { body: 'Take a look at what Other Agent posted.' },
          },
        ],
        dir,
      })
      assert.ok(multiWake, 'wakeNotice should return an unread summary when other room messages are unread')
      assert.equal(multiWake.unread, 1)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('room-unread.mjs & devspec-remote-poll.mjs — Antigravity token/truncation optimizations', () => {
  it('uses READER_PAGE_CHARS = 6000, deduplicates identical response_style arrays across older commands in a page, and appends room_messages_footer when remaining > 0', () => {
    assert.equal(READER_PAGE_CHARS, 6000)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-room-unread-'))
    try {
      const styleArray = [
        'Use numbered sections and explicit file links.',
        'Ground in DevSpec before editing code.',
        'Keep status updates concise.',
      ]
      const lines = [
        {
          seq: 1,
          at: '2026-10-15T08:00:00Z',
          message_id: 'msg-1',
          from: { label: 'Ali Price', kind: 'human' },
          to: 'Curious Badger',
          state: 'active',
          text: 'First command',
          delivered_as_command: {
            authority: 'owner',
            response_style: styleArray,
          },
        },
        {
          seq: 2,
          at: '2026-10-15T08:01:00Z',
          message_id: 'msg-2',
          from: { label: 'Ali Price', kind: 'human' },
          to: 'Curious Badger',
          state: 'active',
          text: 'Second command',
          delivered_as_command: {
            authority: 'owner',
            response_style: styleArray,
          },
        },
        {
          seq: 3,
          at: '2026-10-15T08:02:00Z',
          message_id: 'msg-3',
          from: { label: 'Ali Price', kind: 'human' },
          to: 'Curious Badger',
          state: 'active',
          text: 'Third command ' + 'x'.repeat(5600),
          delivered_as_command: {
            authority: 'owner',
            response_style: styleArray,
          },
        },
      ]
      const page = readPage({
        lines,
        read: {},
        selfLabel: 'Curious Badger',
        budget: 6000,
        writeOverflow: () => '/tmp/overflow.txt',
      })
      assert.equal(page.printed.length, 2)
      const firstObj = JSON.parse(page.printed[0])
      const secondObj = JSON.parse(page.printed[1])
      assert.equal(
        firstObj.delivered_as_command.response_style_same_as_message_id,
        'msg-2',
        'older command in same page should reference newest command with identical response_style',
      )
      assert.equal(firstObj.delivered_as_command.response_style, undefined)
      assert.deepEqual(secondObj.delivered_as_command.response_style, styleArray)

      const paths = transcriptPaths(CONN_ID, SESS_ID, dir)
      fs.writeFileSync(paths.transcript, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
      fs.writeFileSync(paths.state, JSON.stringify({ self_label: 'Curious Badger' }))
      const out = readerOutput({ connectionId: CONN_ID, sessionId: SESS_ID, dir })
      assert.equal(out.ok, true)
      const outLines = out.text.trim().split('\n')
      const footer = JSON.parse(outLines[outLines.length - 1])
      assert.ok(footer.room_messages_footer, 'should repeat room_messages_footer when remaining > 0')
      assert.equal(footer.room_messages_footer.remaining, 1)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('formats .room.json array rows one-per-line while remaining 100% JSON.parse identical', () => {
    const sampleDoc = {
      updated_at: '2026-10-15T10:00:00.000Z',
      advisory: true,
      executable: false,
      still_to_discuss: {
        version: 1,
        open_count: 1,
        rows: [{ id: 'd-1', kind: 'point', title: 'Architecture check', status: 'open' }],
      },
      session_activity: {
        list_readable: true,
        items: [
          { id: 'item-1', code: 'DEV-1', title: 'First item', status: 'in_progress' },
          { id: 'item-2', code: 'DEV-2', title: 'Second item', status: 'completed' },
        ],
        events: [
          { seq: 1, kind: 'claimed', item_id: 'item-1', at: '2026-10-15T09:50:00Z' },
          { seq: 2, kind: 'completed', item_id: 'item-2', at: '2026-10-15T09:55:00Z' },
        ],
      },
    }
    const formatted = formatRoomStateJson(sampleDoc)
    assert.deepEqual(JSON.parse(formatted), sampleDoc)
    const lineCount = formatted.trim().split('\n').length
    const naiveLineCount = JSON.stringify(sampleDoc, null, 2).trim().split('\n').length
    assert.ok(lineCount < naiveLineCount - 15, `expected compact lines (${lineCount} vs ${naiveLineCount})`)
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

describe('Wandering Otter zombie & Working status regression guards (item bbf7b679)', () => {
  it('readConnectionView matches UI-ended/disconnected owner_pid connections and maybeSpawnWindowAutoConnect refuses to re-spawn for an existing owner_pid', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-otter-home-'))
    const connDir = path.join(home, '.devspec', 'remote-control', 'connections')
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-otter-cwd-'))
    fs.mkdirSync(connDir, { recursive: true })
    fs.mkdirSync(path.join(cwd, '.devspec'), { recursive: true })
    fs.writeFileSync(
      path.join(cwd, '.devspec', 'project.json'),
      JSON.stringify({ project_id: PROJ_ID }),
    )
    try {
      writeStateFile(
        CONN_ID,
        {
          enabled: false,
          ended_from_ui: true,
          end_reason: 'ui',
          connection_id: CONN_ID,
          session_codename: 'Wandering Otter',
          project_id: PROJ_ID,
          project_name: 'DevSpec',
          agent_name: 'Antigravity',
          local_id: `agy-window:${process.pid}`,
          owner_pid: process.pid,
        },
        connDir,
      )

      const view = readConnectionView({
        home,
        connectionId: CONN_ID,
        conversationId: CONV_ID,
      })
      assert.ok(view)
      assert.equal(view.state, 'ended_from_devspec')
      assert.equal(view.codename, 'Wandering Otter')

      const spawnAttempt = maybeSpawnWindowAutoConnect({
        cwd,
        ownerPid: process.pid,
        home,
        env: { DEVSPEC_MCP_TOKEN: 'dvs_valid_test_token_123456', DEVSPEC_CONNECT_AT_STARTUP: '1' },
        spawnImpl: () => {
          throw new Error('must not spawn when owner_pid already has a connection file')
        },
      })
      assert.equal(spawnAttempt.spawned, false)
      assert.equal(spawnAttempt.reason, 'already_attempted')
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('autoConnectAtStartup aborts when explicit ownerPid is dead or connection was already ended', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-autoconn-dead-'))
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-autoconn-cwd-'))
    try {
      let calledMcp = false
      const res = await autoConnectAtStartup({
        cwd,
        ownerPid: 99999999,
        home,
        env: { HOME: home, DEVSPEC_MCP_TOKEN: 'dvs_valid_test_token_123456' },
        callMcp: async () => {
          calledMcp = true
          return { connection_id: CONN_ID }
        },
      })
      assert.equal(res, null)
      assert.equal(calledMcp, false)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('devspec-remote-poll.mjs and devspec-remote-listen.mjs exit immediately at startup when explicit --owner-pid is already dead', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-dead-daemon-'))
    const connDir = path.join(home, '.devspec', 'remote-control', 'connections')
    fs.mkdirSync(connDir, { recursive: true })
    try {
      writeStateFile(
        CONN_ID,
        {
          enabled: true,
          connection_id: CONN_ID,
          agent_name: 'Antigravity',
          owner_pid: 99999999,
          token: 'dvs_test_tok_123456',
          mcp_url: 'http://127.0.0.1:9/api/mcp',
        },
        connDir,
      )

      const pollRes = spawnSync(
        process.execPath,
        [path.join(HERE, 'devspec-remote-poll.mjs'), '--connection-id', CONN_ID, '--owner-pid', '99999999'],
        { env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 5000 },
      )
      assert.equal(pollRes.status, 0)
      assert.match(pollRes.stderr, /not alive at startup — stopping/)

      // Re-enable to test listener startup guard independently
      writeStateFile(
        CONN_ID,
        {
          enabled: true,
          connection_id: CONN_ID,
          agent_name: 'Antigravity',
          owner_pid: 99999999,
          token: 'dvs_test_tok_123456',
          mcp_url: 'http://127.0.0.1:9/api/mcp',
        },
        connDir,
      )
      const listenRes = spawnSync(
        process.execPath,
        [path.join(HERE, 'devspec-remote-listen.mjs'), '--connection-id', CONN_ID, '--owner-pid', '99999999'],
        { env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 5000 },
      )
      assert.equal(listenRes.status, 0)
      assert.match(listenRes.stderr, /not alive at startup — exiting/)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('shouldAssertTurnOnPollerInboxWrite is false for unbonded standby or listener-only connections and true only when wait.pid is armed on a bound conversation', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-turn-guard-'))
    try {
      // 1. Unbonded window standby (agy-window:<pid>) -> false
      assert.equal(
        shouldAssertTurnOnPollerInboxWrite(CONN_ID, { local_id: `agy-window:${process.pid}` }, dir),
        false,
      )
      // 2. Bound conversation, but only listener.json (no wait.pid) -> false (listener asserts .turn on agentapi delivery)
      fs.writeFileSync(
        path.join(dir, `${CONN_ID}.listener.json`),
        JSON.stringify({ pid: process.pid }),
      )
      assert.equal(
        shouldAssertTurnOnPollerInboxWrite(CONN_ID, { local_id: CONV_ID }, dir),
        false,
      )
      // 3. Bound conversation with live wait.pid -> true
      fs.writeFileSync(path.join(dir, `${CONN_ID}.wait.pid`), `${process.pid}\n`)
      assert.equal(
        shouldAssertTurnOnPollerInboxWrite(CONN_ID, { local_id: CONV_ID }, dir),
        true,
      )
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('discoverAntigravityLsAddress matches the HTTP port and skips the earlier HTTPS port in cli-*.log, and capTrailForPreToolHook keeps trail under 24KB', () => {
    const procRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-proc-'))
    const fdDir = path.join(procRoot, '4242', 'fd')
    fs.mkdirSync(fdDir, { recursive: true })
    const logFile = path.join(procRoot, 'cli-test.log')
    fs.writeFileSync(
      logFile,
      [
        '2026/10/15 20:42:19 Language server listening on random port at 36783 for HTTPS',
        '2026/10/15 20:42:19 Language server listening on random port at 45663 for HTTP',
      ].join('\n') + '\n',
    )
    fs.symlinkSync(logFile, path.join(fdDir, '1'))
    try {
      const addr = discoverAntigravityLsAddress(4242, {}, { procRoot })
      assert.equal(addr, 'localhost:45663')
    } finally {
      fs.rmSync(procRoot, { recursive: true, force: true })
    }

    const hugeEvents = Array.from({ length: 80 }, (_, idx) => ({
      seq: idx + 1,
      kind: 'thinking',
      text: 'Thinking step '.repeat(250),
      label: `Step ${idx + 1}`,
    }))
    const hugeMarkdown = Array.from({ length: 80 }, (_, idx) => `> 💭 Step ${idx + 1} ${'x'.repeat(120)}`).join('\n')
    const capped = capTrailForPreToolHook(hugeEvents, hugeMarkdown)
    const serializedBytes = Buffer.byteLength(
      JSON.stringify({ work_trail: capped.markdown, trail_events: capped.events }),
      'utf8',
    )
    assert.ok(serializedBytes <= 24_000, `expected <= 24000 bytes, got ${serializedBytes}`)
  })

  it('v0.16.0: renderStatusLine shows local (/devspec-remote to connect) · <Project> when opened in a DevSpec project before /devspec-remote is run', async () => {
    const { renderStatusLine } = await import('./statusline.mjs')
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-v016-home-'))
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-v016-cwd-'))
    fs.mkdirSync(path.join(cwd, '.devspec'), { recursive: true })
    fs.writeFileSync(
      path.join(cwd, '.devspec', 'project.json'),
      JSON.stringify({ project_id: PROJ_ID, project_name: 'DevSpec' }),
    )
    try {
      const line = renderStatusLine(
        JSON.stringify({
          cwd,
          model: { id: 'Gemini 4 Argon (High)', display_name: 'Gemini 4 Argon (High)' },
          context_window: { percent: 5 },
        }),
        {
          home,
          env: { HOME: home, DEVSPEC_MCP_TOKEN: 'dvs_valid_test_token_123456' },
        },
      )
      assert.equal(
        line,
        'DevSpec: local (/devspec-remote to connect) · DevSpec · Gemini 4 Argon (5%)',
      )
      const connDir = path.join(home, '.devspec', 'remote-control', 'connections')
      assert.equal(
        fs.existsSync(connDir),
        false,
        'renderStatusLine must not auto-spawn a background connection on window open',
      )
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })
})

