#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import {
  managePollRequestOptions,
  parseArgs as parsePollArgs,
  readPollConnectionState,
  validateManagePollArguments,
} from './devspec-poll.mjs'
import {
  askTurnBoundaryPlan,
  clearStoredContinuation,
  directedQuestionToolArguments,
  parseArgs as parseQuestionArgs,
  questionRequestOptions,
  readQuestionConnectionState,
  respondArguments,
  validateDirectedQuestionArguments,
} from './devspec-question.mjs'
import {
  activeContinuation,
  classifyContinuationStart,
  DELIVERED,
  INTERACTION_EVENT_KIND,
  INTERACTION_EVENT_VERSION,
  interactionAnswerRecord,
  interactionNegotiationArguments,
  scanPersistedInteractionEventIds,
  validateInteractionEvent,
} from './interaction-events.mjs'
import { checkPinAfterTool, pinProblem } from './pin-check.mjs'
import { runPostToolDispatch } from './post-tool-dispatch.mjs'
import {
  DISMISSAL_KIND,
  persistedDismissalDisposition,
  questionEventAck,
  questionEventOffers,
} from './question-dismissal-events.mjs'
import { handleBashPost as checkRepoLink, looksRemoteCreating } from './repo-link-nudge.mjs'
import {
  formatStatusLine,
  normalizeStatuslineTelemetryInput,
  readConnectionTelemetry,
  recordStatuslineTelemetry,
  renderStatusLine,
  sendTelemetry,
} from './statusline.mjs'

const CONN_ID = '11111111-2222-4333-8444-555555555555'
const SESS_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const PROJ_ID = '24c4abaa-2cb9-496a-8492-cf1f1aa1090b'
const EVT_ID = '99999999-8888-4777-8666-555555555555'
const Q_ID = '77777777-6666-4555-8444-333333333333'
const RESP_ID = '66666666-5555-4444-8333-222222222222'
const CLAIM_ID = '33333333-2222-4111-8000-999999999999'
const ATT_ID = '55555555-4444-4333-8222-111111111111'

function makeTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-item5-test-'))
}

function writeConnectionState(home, connectionId, overrides = {}) {
  const dir = path.join(home, '.devspec', 'remote-control', 'connections')
  fs.mkdirSync(dir, { recursive: true })
  const state = {
    enabled: true,
    connection_id: connectionId,
    session_id: SESS_ID,
    session_codename: 'Cosmic Raven',
    session_title: 'Parity Session',
    session_title_for: SESS_ID,
    token: 'dsp_test_token',
    mcp_url: 'https://api.devspec.ai/api/mcp',
    connection_capability: 'cap_secret_1234567890',
    connection_capability_version: 1,
    ...overrides,
  }
  fs.writeFileSync(path.join(dir, `${connectionId}.json`), JSON.stringify(state, null, 2), { mode: 0o600 })
  return { state, dir }
}

describe('Item 5 Parity: devspec-poll.mjs and devspec-question.mjs bridges', () => {
  it('fails closed when connection capability is missing and validates manage_poll arguments', () => {
    const home = makeTempHome()
    const { dir } = writeConnectionState(home, CONN_ID, { connection_capability: null })

    assert.throws(
      () => readPollConnectionState(CONN_ID, dir),
      /connection poll capability is unavailable/,
    )

    writeConnectionState(home, CONN_ID)
    const state = readPollConnectionState(CONN_ID, dir)
    const opts = managePollRequestOptions(state)
    assert.equal(opts.connectionCapability, 'cap_secret_1234567890')
    assert.equal(opts.token, 'dsp_test_token')

    const parsed = parsePollArgs(['use', '--connection-id', CONN_ID, '--input', '{"action":"list"}'])
    assert.equal(parsed.command, 'use')
    assert.equal(parsed.connectionId, CONN_ID)

    assert.deepEqual(
      validateManagePollArguments({
        action: 'create',
        client_request_id: Q_ID,
        question: 'Ship now?',
        options: ['Yes', 'No'],
        recommendation_index: 0,
      }),
      { ok: true },
    )
    assert.equal(
      validateManagePollArguments({
        action: 'update',
        poll_id: 'poll-1',
        question: 'Missing revision',
      }).ok,
      false,
    )
  })

  it('enforces capability gating, argument validation, and continuation response on manage_directed_question', () => {
    const home = makeTempHome()
    const { dir } = writeConnectionState(home, CONN_ID, { connection_capability: null })

    assert.throws(
      () => readQuestionConnectionState(CONN_ID, dir),
      /no question capability/,
    )

    writeConnectionState(home, CONN_ID, {
      interaction_continuation: {
        kind: INTERACTION_EVENT_KIND,
        event_id: EVT_ID,
        response_id: RESP_ID,
        claim_token: CLAIM_ID,
        attempt_id: ATT_ID,
        question_id: Q_ID,
        connection_id: CONN_ID,
        session_id: SESS_ID,
      },
    })
    const state = readQuestionConnectionState(CONN_ID, dir)
    const opts = questionRequestOptions(state)
    assert.equal(opts.connectionCapability, 'cap_secret_1234567890')

    const parsed = parseQuestionArgs([
      'use',
      '--connection-id',
      CONN_ID,
      '--keep-turn',
      '--input',
      '{"action":"list"}',
    ])
    assert.equal(parsed.command, 'use')
    assert.equal(parsed.keepTurn, true)

    assert.deepEqual(
      validateDirectedQuestionArguments({
        action: 'create',
        client_request_id: Q_ID,
        response_kind: 'single_select',
        prompt: 'Which target?',
        options: ['staging', 'production'],
      }),
      { ok: true },
    )
    assert.deepEqual(
      directedQuestionToolArguments({ action: 'create', prompt: 'Hi' }, { keepTurn: true }),
      { action: 'create', prompt: 'Hi', keep_turn: true },
    )
    assert.deepEqual(
      askTurnBoundaryPlan({
        action: 'create',
        keepTurn: false,
        continuation: null,
        result: { question: { status: 'pending' } },
      }),
      { endTurn: true, reason: 'asked and stopped' },
    )

    const cont = activeContinuation(state.interaction_continuation, {
      connectionId: CONN_ID,
      sessionId: SESS_ID,
    })
    assert.ok(cont)
    const respArgs = respondArguments({
      connectionId: CONN_ID,
      continuation: cont,
      message: 'Deploying to staging.',
    })
    assert.equal(respArgs.connection_id, CONN_ID)
    assert.equal(respArgs.attempt_id, ATT_ID)
    assert.equal(respArgs.interaction_event_id, EVT_ID)
    assert.equal(respArgs.interaction_response_id, RESP_ID)
    assert.equal(respArgs.interaction_claim_token, CLAIM_ID)

    clearStoredContinuation(CONN_ID, dir)
    const cleared = readQuestionConnectionState(CONN_ID, dir)
    assert.equal(cleared.interaction_continuation, null)
  })
})

describe('Item 5 Parity: canonical interaction and dismissal contracts', () => {
  it('validates directed-question answers and dismissals and tracks inbox deduplication', () => {
    const neg = interactionNegotiationArguments({
      enabled: true,
      connection_id: CONN_ID,
      connection_capability: 'cap_secret_1234567890',
    })
    assert.deepEqual(neg, { interaction_event_version: 1, question_dismissal_event_version: 1 })
    assert.deepEqual(interactionNegotiationArguments({ enabled: true, connection_id: CONN_ID }), {})

    const rawAnswer = {
      kind: INTERACTION_EVENT_KIND,
      version: INTERACTION_EVENT_VERSION,
      event_id: EVT_ID,
      response_id: RESP_ID,
      question_id: Q_ID,
      origin_connection_id: CONN_ID,
      source_session_id: SESS_ID,
      response_kind: 'single_select',
      answer: 'Staging',
      answered_at: '2026-10-13T22:00:00.000Z',
      claim_token: CLAIM_ID,
      lease_expires_at: '2026-10-13T22:05:00.000Z',
    }

    const validated = validateInteractionEvent(rawAnswer, { connectionId: CONN_ID, sessionId: SESS_ID })
    assert.equal(validated.ok, true)

    const startDecision = classifyContinuationStart({ outcome: 'started', attempt_id: ATT_ID })
    assert.deepEqual(startDecision, { action: 'apply', outcome: 'started', attemptId: ATT_ID })

    const record = interactionAnswerRecord({
      connectionId: CONN_ID,
      sessionId: SESS_ID,
      event: validated.event,
      attemptId: ATT_ID,
      disposition: DELIVERED,
    })
    const inboxLine = JSON.stringify(record) + '\n'
    const ids = scanPersistedInteractionEventIds(inboxLine)
    assert.equal(ids.has(EVT_ID), true)

    const rawDismissal = {
      kind: DISMISSAL_KIND,
      version: 1,
      event_id: '88888888-7777-4666-8555-444444444444',
      question_id: Q_ID,
      origin_connection_id: CONN_ID,
      source_session_id: SESS_ID,
      response_kind: 'single_select',
      prompt: 'Which target?',
      dismissed_by_user_id: '44444444-3333-4222-8111-000000000000',
      dismissed_at: '2026-10-13T22:05:00.000Z',
      claim_token: CLAIM_ID,
      lease_expires_at: '2026-10-13T22:10:00.000Z',
    }
    const offers = questionEventOffers(
      {
        interaction_event_version: 1,
        question_dismissal_event_version: 1,
        question_dismissal_events: [rawDismissal],
      },
      true,
    )
    assert.equal(offers.length, 1)
    const validDismissal = validateInteractionEvent(offers[0], { connectionId: CONN_ID, sessionId: SESS_ID })
    assert.equal(validDismissal.ok, true)
    assert.equal(persistedDismissalDisposition(inboxLine, validDismissal.event), 'new')
    assert.deepEqual(questionEventAck(validDismissal.event), {
      event_id: '88888888-7777-4666-8555-444444444444',
      claim_token: CLAIM_ID,
      question_id: Q_ID,
    })
  })
})

describe('Item 5 Parity: pin-check.mjs and repo-link-nudge.mjs', () => {
  it('validates .devspec/project.json pins across Antigravity and Claude tool payloads', () => {
    assert.equal(pinProblem('{"project_id": "24c4abaa-2cb9-496a-8492-cf1f1aa1090b"}'), null)
    assert.equal(
      pinProblem('{"project_id": "24c4abaa-2cb9-496a-8492-cf1f1aa1090b", "project_name": "DevSpec"}'),
      null,
    )
    assert.match(pinProblem('{"projectId": "24c4abaa-2cb9-496a-8492-cf1f1aa1090b"}'), /project_id/)
    assert.match(
      pinProblem('{"project_id": "24c4abaa-2cb9-496a-8492-cf1f1aa1090b", "extra": 1}'),
      /only "project_id"/,
    )

    const tmpDir = makeTempHome()
    const pinFile = path.join(tmpDir, '.devspec', 'project.json')
    fs.mkdirSync(path.dirname(pinFile), { recursive: true })
    fs.writeFileSync(pinFile, JSON.stringify({ projectId: PROJ_ID }))

    const badOut = checkPinAfterTool({
      tool_name: 'write_to_file',
      cwd: tmpDir,
      tool_input: { TargetFile: pinFile },
    })
    assert.ok(badOut?.hookSpecificOutput?.additionalContext)
    assert.match(badOut.hookSpecificOutput.additionalContext, new RegExp(PROJ_ID))

    fs.writeFileSync(pinFile, JSON.stringify({ project_id: PROJ_ID }))
    const goodOut = checkPinAfterTool({
      tool_name: 'write_to_file',
      cwd: tmpDir,
      tool_input: { TargetFile: pinFile },
    })
    assert.equal(goodOut, null)
  })

  it('nudges once when a pinned folder adds an unlinked git remote', async () => {
    assert.equal(looksRemoteCreating('git remote add origin https://github.com/org/repo.git'), true)
    assert.equal(looksRemoteCreating('gh repo create org/repo --source .'), true)
    assert.equal(looksRemoteCreating('git status'), false)

    const tmpDir = makeTempHome()
    const remoteUrl = 'https://github.com/org/unlinked-repo.git'
    const env = {
      ...process.env,
      DEVSPEC_ANTIGRAVITY_STATE_DIR: path.join(tmpDir, 'prov'),
      DEVSPEC_PROVENANCE_DIR: path.join(tmpDir, 'prov'),
    }

    const payload = {
      session_id: 'conv-123',
      cwd: tmpDir,
      tool_name: 'run_command',
      tool_input: { CommandLine: `git remote add origin ${remoteUrl}` },
    }

    const deps = {
      env,
      findProjectPin: () => ({ project_id: PROJ_ID, path: path.join(tmpDir, '.devspec', 'project.json') }),
      gitRemoteOrigin: () => remoteUrl,
      resolveAuth: () => ({ ok: true, token: 'dsp_test', mcp_url: 'https://api.devspec.ai/api/mcp' }),
      call: async () => ({
        remote_match: { resolved_project_id: null, candidate_project_ids: [] },
        projects: [{ id: PROJ_ID, name: 'DevSpec Core' }],
      }),
    }

    const first = await checkRepoLink(payload, deps)
    assert.ok(first?.hookSpecificOutput?.additionalContext)
    assert.match(first.hookSpecificOutput.additionalContext, /DevSpec Core/)
    assert.match(first.hookSpecificOutput.additionalContext, /not linked to that project yet/)

    // Second invocation for same session + project + remote is deduplicated
    const second = await checkRepoLink(payload, deps)
    assert.equal(second, null)
  })

  it('surfaces pin check notices through post-tool-dispatch.mjs', async () => {
    const tmpDir = makeTempHome()
    const pinFile = path.join(tmpDir, '.devspec', 'project.json')
    fs.mkdirSync(path.dirname(pinFile), { recursive: true })
    fs.writeFileSync(pinFile, '{"wrong_key": "24c4abaa-2cb9-496a-8492-cf1f1aa1090b"}')

    const res = await runPostToolDispatch(
      JSON.stringify({
        conversation_id: 'conv-pin-dispatch',
        cwd: tmpDir,
        tool_name: 'write_to_file',
        tool_input: { TargetFile: pinFile },
      }),
      { home: tmpDir },
    )
    assert.ok(res?.hookSpecificOutput?.additionalContext)
    assert.match(res.hookSpecificOutput.additionalContext, /project_id/)
  })
})

describe('Item 5 Parity: statusline.mjs rendering and telemetry', () => {
  it('normalizes statusLine stdin, writes telemetry, renders status bar, and sends heartbeat_connection stats', async () => {
    const home = makeTempHome()
    writeConnectionState(home, CONN_ID)
    const bondDir = path.join(home, '.devspec', 'remote-control', 'local', 'antigravity')
    fs.mkdirSync(bondDir, { recursive: true })
    fs.writeFileSync(
      path.join(bondDir, 'conv-status-1.json'),
      JSON.stringify({ connection_id: CONN_ID, local_id: 'conv-status-1' }),
    )

    const stdinPayload = {
      conversation_id: 'conv-status-1',
      cwd: home,
      model: { id: 'gemini-2.5-pro', provider: 'google' },
      thinking_level: 'high',
      context_window: {
        used_percentage: 42.4,
        context_window_size: 1000000,
        current_usage: {
          input_tokens: 400000,
          output_tokens: 24000,
          cache_read_input_tokens: 10000,
          cache_creation_input_tokens: 0,
        },
      },
      cost: { total_cost_usd: 0.125 },
    }

    const line = renderStatusLine(JSON.stringify(stdinPayload), {
      home,
      nowIso: '2026-10-13T22:10:00.000Z',
    })
    assert.match(line, /DevSpec: Cosmic Raven/)
    assert.match(line, /“Parity Session”/)
    assert.match(line, /gemini-2\.5-pro \(42%\)/)

    const stored = readConnectionTelemetry(CONN_ID, {
      home,
      now: Date.parse('2026-10-13T22:11:00.000Z'),
    })
    assert.ok(stored)
    assert.deepEqual(stored.model, { provider: 'google', id: 'gemini-2.5-pro' })
    assert.equal(stored.thinkingLevel, 'high')
    assert.equal(stored.context.percent, 42.4)
    assert.equal(stored.context.window, 1000000)
    assert.equal(stored.turn.input, 400000)

    let heartbeatReq = null
    const sent = await sendTelemetry({
      connectionId: CONN_ID,
      home,
      call: async (req) => {
        heartbeatReq = req
        return { ok: true }
      },
    })
    assert.equal(sent.ok, true)
    assert.equal(heartbeatReq.name, 'heartbeat_connection')
    assert.equal(heartbeatReq.arguments.connection_id, CONN_ID)
    assert.deepEqual(heartbeatReq.arguments.agent_stats.model, {
      provider: 'google',
      id: 'gemini-2.5-pro',
    })

    // Also verify disconnected / ended_from_devspec formatting
    assert.equal(
      formatStatusLine({ state: 'ended_from_devspec', codename: 'Cosmic Raven' }),
      'DevSpec: Cosmic Raven · ended from DevSpec',
    )
    assert.equal(
      formatStatusLine({ state: 'disconnected', codename: 'Cosmic Raven' }),
      'DevSpec: Cosmic Raven · disconnected',
    )

    // Verify normalizeStatuslineTelemetryInput and recordStatuslineTelemetry directly
    const norm = normalizeStatuslineTelemetryInput({
      model: 'claude-sonnet-4-5',
      context_window: { tokens: 50000, window: 200000, percent: 25 },
    })
    assert.deepEqual(norm.model, { provider: 'anthropic', id: 'claude-sonnet-4-5' })
    assert.ok(recordStatuslineTelemetry(stdinPayload, { home, connectionId: CONN_ID }))
  })

  it('auto-configures statusLine in settings.json and surfaces missing-auth notice in statusline and SessionStart', async () => {
    const { connectAtStartupEnabled, ensureStatusLineConfigured, runSessionStart } = await import(
      './session-start.mjs'
    )
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-agy-setup-'))
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-agy-cwd-'))

    // 1. ensureStatusLineConfigured writes statusLine when missing and preserves existing keys
    const settingsPath = path.join(home, '.gemini', 'antigravity-cli', 'settings.json')
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    fs.writeFileSync(settingsPath, JSON.stringify({ theme: 'dark' }, null, 2))
    const cfg1 = ensureStatusLineConfigured({ home })
    assert.equal(cfg1.updated, true)
    const parsedSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    assert.equal(parsedSettings.theme, 'dark')
    assert.equal(parsedSettings.statusLine.type, 'command')
    assert.match(parsedSettings.statusLine.command, /statusline\.mjs/)

    // Second call preserves existing statusLine when script exists on disk
    const cfg2 = ensureStatusLineConfigured({ home })
    assert.equal(cfg2.updated, false)
    assert.equal(cfg2.reason, 'already_configured')

    // 2. connectAtStartupEnabled defaults to true when valid token is configured, unless disabled
    assert.equal(connectAtStartupEnabled({}, { cwd, home }), false)
    assert.equal(
      connectAtStartupEnabled({ DEVSPEC_MCP_TOKEN: 'dvs_valid_test_token_123456' }, { cwd, home }),
      true,
    )
    assert.equal(
      connectAtStartupEnabled(
        { DEVSPEC_MCP_TOKEN: 'dvs_valid_test_token_123456', DEVSPEC_CONNECT_AT_STARTUP: '0' },
        { cwd, home },
      ),
      false,
    )

    // 3. renderStatusLine shows not-configured notice when no dvs_ token exists
    const unconfiguredLine = renderStatusLine(
      JSON.stringify({ conversation_id: 'conv-missing-auth', cwd }),
      { home, env: {} },
    )
    assert.equal(
      unconfiguredLine,
      'DevSpec: not configured — add dvs_ token to ~/.gemini/antigravity-cli/mcp_config.json',
    )

    // 4. runSessionStart returns deterministic missing-auth remediation context when unconfigured
    const startOut = await runSessionStart(
      JSON.stringify({ conversation_id: 'conv-missing-auth', cwd }),
      {
        home,
        cwd,
        env: {},
        loadStateFn: () => null,
      },
    )
    assert.ok(startOut?.hookSpecificOutput?.additionalContext)
    assert.match(
      startOut.hookSpecificOutput.additionalContext,
      /DevSpec is not configured properly: place your "dvs_\.\.\." token in ~\/\.gemini\/antigravity-cli\/mcp_config\.json/,
    )
    assert.match(
      startOut.hookSpecificOutput.additionalContext,
      /report this message verbatim and do not guess or search for tokens/,
    )
  })
})
