import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  antigravityProcessOf,
  closeAntigravityOnEnd,
  closeOnEndDecision,
  looksLikeAntigravity,
  ownedByAnotherAntigravityProcess,
  ownedByAntigravityProcess,
  processStartTime,
  resolveAntigravityPid,
} from './close-on-end.mjs'
import { disableLocalState, parseSseFrame } from './devspec-remote-poll.mjs'
import { writeConnectionState } from './remote-control-state.mjs'

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url))

function makeTempDir(prefix = 'agy-close-on-end-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

describe('Item b725aa2d: closing Antigravity on End from DevSpec (close-on-end.mjs)', () => {
  it('identifies agy and antigravity process names and command lines', () => {
    assert.equal(looksLikeAntigravity('agy', ''), true)
    assert.equal(looksLikeAntigravity('antigravity', ''), true)
    assert.equal(looksLikeAntigravity('/home/n3o/.local/bin/agy', ''), true)
    assert.equal(looksLikeAntigravity('node', '/home/n3o/.local/bin/agy --resume'), true)
    assert.equal(looksLikeAntigravity('bash', '/bin/bash -l'), false)
    assert.equal(looksLikeAntigravity('claude', 'claude --resume'), false)
  })

  it('resolves the owning agy PID directly or through parent ancestry', () => {
    const procs = new Map([
      [1000, { name: 'systemd', cmdline: '/sbin/init', ppid: 1 }],
      [2000, { name: 'agy', cmdline: '/home/user/.local/bin/agy', ppid: 1000 }],
      [2050, { name: 'bash', cmdline: '/bin/bash -c node wait.mjs', ppid: 2000 }],
      [2060, { name: 'node', cmdline: 'node devspec-remote-wait.mjs', ppid: 2050 }],
      [3000, { name: 'bash', cmdline: '/bin/bash', ppid: 1000 }],
    ])
    const opts = {
      isAlive: (pid) => procs.has(pid),
      nameOf: (pid) => procs.get(pid)?.name ?? null,
      cmdlineOf: (pid) => procs.get(pid)?.cmdline ?? '',
      parentOfPid: (pid) => procs.get(pid)?.ppid ?? null,
    }

    assert.equal(antigravityProcessOf(2000, opts), 2000)
    assert.equal(antigravityProcessOf(2060, opts), 2000)
    assert.equal(antigravityProcessOf(3000, opts), null)
    assert.equal(antigravityProcessOf(9999, opts), null)

    assert.equal(
      resolveAntigravityPid('2000', {
        startPid: 3000,
        agyOf: (pid) => antigravityProcessOf(pid, opts),
      }),
      2000,
    )
    assert.equal(
      resolveAntigravityPid(null, {
        startPid: 2060,
        agyOf: (pid) => antigravityProcessOf(pid, opts),
      }),
      2000,
    )
  })

  it('verifies ownership by matching owner_pid and owner_started, rejecting other agy processes or recycled PIDs', () => {
    const agyPids = new Set([2000, 4000])
    const startTimes = new Map([
      [2000, '12345678'],
      [4000, '87654321'],
    ])
    const deps = {
      isAlive: (pid) => agyPids.has(pid),
      agyOf: (pid) => (agyPids.has(pid) ? pid : null),
      startTimeOf: (pid) => startTimes.get(pid) ?? null,
    }

    const state = {
      connection_id: 'conn-1',
      owner_pid: 2000,
      owner_started: '12345678',
    }

    assert.equal(ownedByAntigravityProcess(state, 2000, deps), true)
    assert.equal(ownedByAnotherAntigravityProcess(state, 2000, deps), false)

    // Another terminal's agy process (4000) must not match state owned by 2000
    assert.equal(ownedByAntigravityProcess(state, 4000, deps), false)
    assert.equal(ownedByAnotherAntigravityProcess(state, 4000, deps), true)

    // Recycled PID: PID 2000 is now a new agy process with a different start time
    startTimes.set(2000, '99999999')
    assert.equal(ownedByAntigravityProcess(state, 2000, deps), false)

    // Dead owner_pid
    agyPids.delete(2000)
    assert.equal(ownedByAntigravityProcess(state, 2000, deps), false)
  })

  it('signals the owning agy process with SIGTERM only when a live connection ends with end_reason === "ui"', () => {
    const killed = []
    const state = {
      connection_id: 'conn-ui-end',
      enabled: false,
      ended_from_ui: true,
      end_reason: 'ui',
      owner_pid: 2000,
      owner_started: '12345678',
    }

    const res = closeAntigravityOnEnd({
      state,
      sawLive: true,
      ownerPid: 2000,
      platform: 'linux',
      resolvePid: (pid) => pid,
      owns: (s, pid) => s.owner_pid === pid,
      kill: (pid, sig) => killed.push({ pid, sig }),
    })

    assert.deepEqual(res, {
      closed: true,
      pid: 2000,
      reason: 'person_ended_from_devspec',
    })
    assert.deepEqual(killed, [{ pid: 2000, sig: 'SIGTERM' }])
  })

  it('never closes agy for non-UI end reasons or when sawLive is false or when owned by another process', () => {
    const killed = []
    const run = (overrides) =>
      closeAntigravityOnEnd({
        state: {
          connection_id: 'conn-1',
          enabled: false,
          end_reason: 'ui',
          owner_pid: 2000,
        },
        sawLive: true,
        ownerPid: 2000,
        platform: 'linux',
        resolvePid: (pid) => pid,
        owns: (s, pid) => s.owner_pid === pid,
        kill: (pid, sig) => killed.push({ pid, sig }),
        ...overrides,
      })

    for (const reason of ['local_stop', 'idle_timeout', 'server_ended', 'owner_gone', null, undefined]) {
      const out = run({
        state: { connection_id: 'conn-1', enabled: false, end_reason: reason, owner_pid: 2000 },
      })
      assert.equal(out.closed, false)
      assert.equal(out.reason, 'not_a_person_end')
    }

    const stale = run({ sawLive: false })
    assert.equal(stale.closed, false)
    assert.equal(stale.reason, 'ended_before_this_process_served_it')

    const wrongOwner = run({ ownerPid: 4000 })
    assert.equal(wrongOwner.closed, false)
    assert.equal(wrongOwner.reason, 'not_the_owner')

    const win = closeOnEndDecision({
      state: { end_reason: 'ui', owner_pid: 2000 },
      sawLive: true,
      ownerPid: 2000,
      platform: 'win32',
      owns: () => true,
    })
    assert.equal(win.close, false)
    assert.equal(win.reason, 'unsupported_platform')

    assert.equal(killed.length, 0)
  })

  it('records owner_started in writeConnectionState and marks local conversation bonds stopped in disableLocalState', async () => {
    const tmp = makeTempDir()
    try {
      const connectionsDir = path.join(tmp, '.devspec', 'remote-control', 'connections')
      const localDir = path.join(tmp, '.devspec', 'remote-control', 'local')
      const legacyPath = path.join(tmp, '.devspec', 'remote-control.json')
      const connectionId = '11111111-2222-3333-4444-555555555555'
      const localId = 'conv-abc-123'

      await writeConnectionState({
        connectionId,
        agent: 'Antigravity',
        localId,
        ownerPid: process.pid,
        connectionCapability: 'dvsc_cap_token',
        noPoller: true,
        home: tmp,
        env: {},
      })

      const written = JSON.parse(
        fs.readFileSync(path.join(connectionsDir, `${connectionId}.json`), 'utf8'),
      )
      assert.equal(written.owner_pid, process.pid)
      if (process.platform === 'linux') {
        assert.equal(written.owner_started, processStartTime(process.pid))
        assert.ok(written.owner_started)
      }

      const bondFile = path.join(localDir, 'antigravity', `${localId}.json`)
      assert.ok(fs.existsSync(bondFile))
      assert.equal(JSON.parse(fs.readFileSync(bondFile, 'utf8')).status, 'live')

      const disabled = disableLocalState({
        connectionId,
        reason: 'ui',
        dir: connectionsDir,
        legacyPath,
        localDir,
      })

      assert.equal(disabled.enabled, false)
      assert.equal(disabled.ended_from_ui, true)
      assert.equal(disabled.end_reason, 'ui')
      assert.equal(disabled.connection_capability, undefined)

      const stoppedBond = JSON.parse(fs.readFileSync(bondFile, 'utf8'))
      assert.equal(stoppedBond.status, 'stopped')
      assert.equal(stoppedBond.enabled, false)
      assert.equal(stoppedBond.ended_from_ui, true)
      assert.equal(stoppedBond.end_reason, 'ui')
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('parses SSE event: ended frames with end_reason: "ui" for immediate poller teardown', () => {
    const parsed = parseSseFrame(`event: ended\ndata: ${JSON.stringify({ end_reason: 'ui' })}`)
    assert.deepEqual(parsed, { kind: 'ended', endReason: 'ui' })
  })

  it('closes a live mock agy process via SIGTERM when devspec-remote-listen.mjs observes end_reason === "ui"', async () => {
    if (process.platform === 'win32') return
    const tmp = makeTempDir()
    const connectionsDir = path.join(tmp, '.devspec', 'remote-control', 'connections')
    fs.mkdirSync(connectionsDir, { recursive: true })
    const connectionId = 'aaaa1111-bbbb-2222-cccc-333333333333'

    // Spawn a dummy process whose argv0/cmdline contains 'agy' so looksLikeAntigravity matches it
    const dummyAgy = spawn(
      process.execPath,
      ['-e', 'process.title = "agy"; setInterval(() => {}, 1000)', 'agy'],
      { stdio: 'ignore' },
    )
    const dummyPid = dummyAgy.pid
    const dummyStarted = processStartTime(dummyPid)

    const stateFile = path.join(connectionsDir, `${connectionId}.json`)
    fs.writeFileSync(
      stateFile,
      JSON.stringify(
        {
          connection_id: connectionId,
          enabled: true,
          owner_pid: dummyPid,
          owner_started: dummyStarted,
          local_id: 'conv-live-test',
        },
        null,
        2,
      ),
      { mode: 0o600 },
    )

    const listenProc = spawn(
      process.execPath,
      [
        path.join(SCRIPTS_DIR, 'devspec-remote-listen.mjs'),
        '--connection-id',
        connectionId,
        '--conversation-id',
        'conv-live-test',
        '--owner-pid',
        String(dummyPid),
      ],
      {
        env: { ...process.env, HOME: tmp },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )

    try {
      // Wait for listener to write its .listener.json marker (proving it observed the connection live)
      const markerPath = path.join(connectionsDir, `${connectionId}.listener.json`)
      const startWait = Date.now()
      while (!fs.existsSync(markerPath) && Date.now() - startWait < 4000) {
        await new Promise((r) => setTimeout(r, 50))
      }
      assert.ok(fs.existsSync(markerPath), 'listener marker should be created while connection is live')

      // Transition connection state to UI-ended
      fs.writeFileSync(
        stateFile,
        JSON.stringify(
          {
            connection_id: connectionId,
            enabled: false,
            ended_from_ui: true,
            end_reason: 'ui',
            owner_pid: dummyPid,
            owner_started: dummyStarted,
            local_id: 'conv-live-test',
          },
          null,
          2,
        ),
        { mode: 0o600 },
      )

      const dummyExit = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ timedOut: true }), 4000)
        dummyAgy.once('exit', (code, signal) => {
          clearTimeout(timer)
          resolve({ code, signal })
        })
      })
      assert.equal(dummyExit.signal, 'SIGTERM', 'dummy agy process must receive SIGTERM')

      const listenExit = await new Promise((resolve) => {
        if (listenProc.exitCode !== null) return resolve(listenProc.exitCode)
        const timer = setTimeout(() => resolve('timeout'), 4000)
        listenProc.once('exit', (code) => {
          clearTimeout(timer)
          resolve(code)
        })
      })
      assert.equal(listenExit, 0)
    } finally {
      try {
        dummyAgy.kill('SIGKILL')
      } catch {}
      try {
        listenProc.kill('SIGKILL')
      } catch {}
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})
