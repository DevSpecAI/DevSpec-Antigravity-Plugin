#!/usr/bin/env node
/**
 * Automatic turn recall on PreInvocation (item 08f036e5; host contract 7c87f509).
 *
 * Guards what reading turn-recall.mjs would not show a future change breaking: only a
 * turn-opening step reaches the network, a command is recalled once however many
 * steps show it, a card is shown once per conversation until its version changes or
 * a CHECKPOINT summarises it away, every failure injects nothing and remembers
 * nothing, a scope the server could not place is not asked again, the state stays
 * private and bounded, the key never leaves memory, and the poller never asks
 * poll_connection for recall (which would deliver it twice).
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import {
  TURN_RECALL_LIMITS,
  boundedStateText,
  classifyStep,
  loadSeenState,
  readLatestStep,
  recallTarget,
  remoteWakeCommand,
  runTurnRecall,
  saveSeenState,
  seenStatePath,
  sweepExpiredStates,
  turnRecallSteps,
  turnRecallUrl,
} from './turn-recall.mjs'
import { runPreInvocation } from './pre-invocation.mjs'
import { POSIX_MODES } from './private-state.mjs'
import { projectStatePath } from './conversation-project.mjs'

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url))
const CONV = '5b0c1f7e-1111-4222-8333-944455556666'
const CONN = '11111111-2222-4333-8444-555555555555'
const SESS = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const PROJ = '24c4abaa-2cb9-496a-8492-cf1f1aa1090b'
const MSG = 'd1111111-1111-4111-8111-111111111111'
const KEY = 'dvs_fixturekey0123456789abcdefghijklmnopqrstuvwxyz'
const CAP = 'dvsc_fixturecapability0123456789abcdef'
const BLOCK = '## DevSpec recall\n[REQUIREMENT · binding] Every migration is applied to staging (requirement:r1:v1)'
const modeOf = (p) => fs.statSync(p).mode & 0o777

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-recall-'))
  const logs = path.join(home, 'brain', CONV, '.system_generated', 'logs')
  fs.mkdirSync(logs, { recursive: true })
  const compact = path.join(logs, 'transcript.jsonl')
  const full = path.join(logs, 'transcript_full.jsonl')
  fs.writeFileSync(compact, '')
  fs.writeFileSync(full, '')
  const connDir = path.join(home, '.devspec', 'remote-control', 'connections')
  fs.mkdirSync(connDir, { recursive: true })
  let next = 0
  const step = (type, content, { cutAt = null } = {}) => {
    const index = next++
    const row = { step_index: index, type, source: 'X', status: 'DONE', content, created_at: 'now' }
    fs.appendFileSync(full, JSON.stringify(row) + '\n')
    const short = cutAt !== null && content.length > cutAt
      ? { ...row, content: content.slice(0, cutAt), truncated_fields: ['content'] }
      : row
    fs.appendFileSync(compact, JSON.stringify(short) + '\n')
    return index
  }
  const input = () => JSON.stringify({ conversationId: CONV, transcriptPath: full })
  return { home, compact, full, connDir, step, input, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) }
}

const userInput = (text) => `<USER_REQUEST>\n${text}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: now.\n</ADDITIONAL_METADATA>`

function commandWake({ body, transcript = null, messageId = MSG }) {
  return [
    'The following is a <SYSTEM_MESSAGE> not actually sent by the user.',
    '',
    '<SYSTEM_MESSAGE>',
    '[Message] timestamp=2026-11-13T10:00:00Z sender=system priority=MESSAGE_PRIORITY_HIGH content=[DevSpec Remote Wake]',
    '',
    `Session: ${SESS}`,
    '',
    ...(transcript ? [`Room transcript: ${transcript}`, ''] : []),
    `Ali Price (owner): ${body}`,
    '',
    JSON.stringify({ type: 'owner_message', from: 'Ali Price', authority: 'owner', message_id: messageId, body_chars: body.length, session_id: SESS }),
    JSON.stringify({ type: 'wake', reason: 'canonical_conversational_command', command_message_ids: [messageId] }),
    '</SYSTEM_MESSAGE>',
  ].join('\n')
}

/** A server stand-in: records each call, answers from `respond(call)`. */
function server(respond) {
  const calls = []
  const fetchImpl = async (url, init) => {
    const call = { url, headers: init.headers, body: JSON.parse(init.body), signal: init.signal }
    calls.push(call)
    const out = await respond(call)
    if (out instanceof Error) throw out
    const { status = 200, json = {} } = out
    return { ok: status >= 200 && status < 300, status, json: async () => json }
  }
  return { calls, fetchImpl }
}

const answer = (block, keys) => ({ json: { version: 1, formatted_block: block, cards: keys.map((k) => ({ dedupe_key: k })), seen_keys: keys } })

const target = (scope = { project_id: PROJ }, extra = {}) => () => ({
  token: KEY,
  mcpUrl: 'https://api.devspecstaging.com/api/mcp',
  capability: null,
  scope,
  ...extra,
})

describe('which steps recall', () => {
  it('a typed request recalls its USER_REQUEST text; a slash command or a short reply does not', () => {
    const typed = classifyStep({ stepIndex: 0, type: 'USER_INPUT', content: userInput('How should the billing ledger handle refunds?') })
    assert.equal(typed.recall, true)
    assert.equal(typed.query, 'How should the billing ledger handle refunds?')
    assert.equal(classifyStep({ stepIndex: 0, type: 'USER_INPUT', content: userInput('/devspec:devspec-remote') }).reason, 'slash_command')
    assert.equal(classifyStep({ stepIndex: 0, type: 'USER_INPUT', content: userInput('yes please') }).reason, 'short_prompt')
  })

  it('a step inside a turn never recalls', () => {
    for (const type of ['PLANNER_RESPONSE', 'GENERIC', 'CHECKPOINT', 'EPHEMERAL_MESSAGE', 'ERROR_MESSAGE']) {
      assert.equal(classifyStep({ stepIndex: 3, type, content: 'x'.repeat(100) }).reason, 'mid_turn_step', type)
    }
  })

  it('a system message that is not a command wake recalls nothing: check jobs, notices, background tasks', () => {
    const checkJob = '<SYSTEM_MESSAGE>\ncontent=[DevSpec Remote Wake]\n\nA check is waiting on "something long enough to recall".\n\n{"type":"check_job","check_job_id":"c1"}\n{"type":"wake","reason":"check_job"}\n</SYSTEM_MESSAGE>'
    const notice = '<SYSTEM_MESSAGE>\ncontent=[DevSpec Remote Wake]\n\nSession: s\n\n[DevSpec System Notice: pr_check_failed / merge_queue_ejected]\nSummary: PR #1 was removed from the merge queue.\n\n{"type":"system_notice","notice_id":"n1"}\n</SYSTEM_MESSAGE>'
    const background = '<SYSTEM_MESSAGE>\nBackground command "npm test" (id) finished with a long enough body\n</SYSTEM_MESSAGE>'
    for (const content of [checkJob, notice, background]) {
      assert.equal(classifyStep({ stepIndex: 9, type: 'SYSTEM_MESSAGE', content }).recall, false)
    }
  })

  it('a command wake recalls the command text, whole, from the room transcript by message id', () => {
    const fx = fixture()
    try {
      const longBody = `Please look at how refunds settle. ${'More detail. '.repeat(200)}`
      const transcript = path.join(fx.connDir, `${CONN}.${SESS}.transcript.jsonl`)
      fs.writeFileSync(transcript, [
        JSON.stringify({ seq: 1, message_id: 'other', text: 'unrelated' }),
        JSON.stringify({ seq: 2, message_id: MSG, text: longBody }),
      ].join('\n') + '\n')
      const wake = commandWake({ body: 'Please look at how refunds settle. (cut)', transcript })
      const d = classifyStep({ stepIndex: 4, type: 'SYSTEM_MESSAGE', content: wake }, { home: fx.home })
      assert.equal(d.recall, true)
      assert.equal(d.reason, 'remote_command')
      assert.equal(d.query, longBody.trim())
      assert.deepEqual(d.ids, [MSG])
    } finally {
      fx.cleanup()
    }
  })

  it('without a readable room transcript the wake\'s own body is used, sender label removed', () => {
    const d = classifyStep({ stepIndex: 4, type: 'SYSTEM_MESSAGE', content: commandWake({ body: 'Can you check the refund ledger rules?' }) })
    assert.equal(d.query, 'Can you check the refund ledger rules?')
  })

  it('a room transcript path outside DevSpec\'s own folder is never read', () => {
    const fx = fixture()
    try {
      const elsewhere = path.join(fx.home, 'elsewhere.transcript.jsonl')
      fs.writeFileSync(elsewhere, JSON.stringify({ message_id: MSG, text: 'SECRET FROM ELSEWHERE that is long' }) + '\n')
      const d = classifyStep({ stepIndex: 4, type: 'SYSTEM_MESSAGE', content: commandWake({ body: 'Inline body that is long enough', transcript: elsewhere }) }, { home: fx.home })
      assert.equal(d.query, 'Inline body that is long enough')
    } finally {
      fx.cleanup()
    }
  })

  it('a wake opening a new conversation (USER_INPUT) and an automation run are commands too', () => {
    const asInput = classifyStep({ stepIndex: 0, type: 'USER_INPUT', content: userInput(commandWake({ body: 'Start on the refunds ledger work now' })) })
    assert.equal(asInput.recall, true)
    assert.equal(asInput.query, 'Start on the refunds ledger work now')
    const run = '<SYSTEM_MESSAGE>\ncontent=[DevSpec Remote Wake]\n\nAutomation run dispatched: "Reconcile unique work from dismissed tasks" (run_id=r1, connection_id=c1)\n\n' +
      JSON.stringify({ type: 'automation_run', dispatch: { run_id: 'r1', automation_name: 'Reconcile unique work from dismissed tasks' } }) + '\n</SYSTEM_MESSAGE>'
    const d = classifyStep({ stepIndex: 2, type: 'SYSTEM_MESSAGE', content: run })
    assert.equal(d.recall, true)
    assert.equal(d.query, 'Reconcile unique work from dismissed tasks')
    assert.deepEqual(d.ids, ['run:r1'])
  })

  it('a large wake handed over in a payload file is read from it', () => {
    const fx = fixture()
    try {
      const payload = path.join(fx.connDir, `${CONN}.wake-env1.txt`)
      fs.writeFileSync(payload, 'Ali Price (owner): The whole long command about refunds and ledgers.\n')
      const wake = `<SYSTEM_MESSAGE>\ncontent=[DevSpec Remote Wake]\n\nSession: ${SESS}\n\nCommand from Ali Price (owner) (1 message):\n\nWake payload file: ${payload} (70000 bytes)\nREQUIRED: read it\n\n${JSON.stringify({ type: 'owner_message', message_id: MSG })}\n</SYSTEM_MESSAGE>`
      assert.equal(remoteWakeCommand(wake, { home: fx.home }).query, 'The whole long command about refunds and ledgers.')
    } finally {
      fx.cleanup()
    }
  })
})

describe('reading the newest step', () => {
  it('finds it past a long transcript and hydrates a cut step from transcript_full.jsonl', () => {
    const fx = fixture()
    try {
      for (let i = 0; i < 300; i++) fx.step('GENERIC', `tool output ${i} ${'x'.repeat(400)}`)
      const cp = fx.step('CHECKPOINT', 'summary')
      const long = `Explain the refund ledger. ${'detail '.repeat(30_000)}`.trim()
      const idx = fx.step('USER_INPUT', userInput(long), { cutAt: 200 })
      const { step, checkpoint } = readLatestStep(fx.compact)
      assert.equal(step.stepIndex, idx)
      assert.equal(step.truncated, false)
      assert.equal(checkpoint, cp)
      assert.equal(classifyStep(step).query, long)
    } finally {
      fx.cleanup()
    }
  })
})

describe('one PreInvocation', () => {
  it('injects the server block once at the turn tail, dedupes across turns and re-surfaces a new version', async () => {
    const fx = fixture()
    try {
      const responses = [
        answer(BLOCK, ['requirement:r1:v1', 'memory:m1:v1']),
        answer('## DevSpec recall\nmemory m1 v2', ['memory:m1:v2']),
      ]
      const srv = server(() => responses.shift())
      const opts = { home: fx.home, env: {}, fetchImpl: srv.fetchImpl, target: target() }

      const t1 = fx.step('USER_INPUT', userInput('How should the billing ledger handle refunds?'))
      const first = await runTurnRecall(fx.input(), opts)
      assert.deepEqual(first.result, { injectSteps: [{ systemMessage: { systemMessage: BLOCK } }] })
      assert.equal(srv.calls.length, 1)
      assert.equal(srv.calls[0].url, 'https://api.devspecstaging.com/api/mcp/turn-recall')
      assert.equal(srv.calls[0].headers.Authorization, `Bearer ${KEY}`)
      assert.match(srv.calls[0].headers['x-devspec-plugin'], /^antigravity\//)
      assert.deepEqual(srv.calls[0].body, {
        query: 'How should the billing ledger handle refunds?', host: 'antigravity', conversation_id: CONV, project_id: PROJ, seen_versions: [],
      })

      // The model's own steps inside that turn: PreInvocation fires, nothing is asked.
      fx.step('PLANNER_RESPONSE', '')
      fx.step('GENERIC', 'tool output')
      assert.equal((await runTurnRecall(fx.input(), opts)).reason, 'mid_turn_step')
      fx.step('SYSTEM_MESSAGE', `<SYSTEM_MESSAGE>\n${BLOCK}\n</SYSTEM_MESSAGE>`) // the injected step itself
      assert.equal((await runTurnRecall(fx.input(), opts)).result, null)
      assert.equal(srv.calls.length, 1)

      fx.step('USER_INPUT', userInput('And what about partial refunds on the ledger?'))
      const second = await runTurnRecall(fx.input(), opts)
      assert.equal(srv.calls.length, 2)
      assert.deepEqual(srv.calls[1].body.seen_versions, ['requirement:r1:v1', 'memory:m1:v1'])
      assert.match(second.result.injectSteps[0].systemMessage.systemMessage, /m1 v2/)

      const { state } = loadSeenState(CONV, { home: fx.home })
      assert.deepEqual(state.entries.map((e) => e.key), ['requirement:r1:v1', 'memory:m1:v1', 'memory:m1:v2'])
      assert.equal(state.entries[0].step, t1)
      const file = seenStatePath(CONV, fx.home)
      if (POSIX_MODES) {
        assert.equal(modeOf(file), 0o600)
        assert.equal(modeOf(path.dirname(file)), 0o700)
      }
      assert.ok(!fs.readFileSync(file, 'utf8').includes(KEY), 'the key never reaches the state file')
    } finally {
      fx.cleanup()
    }
  })

  it('a command seen at two steps is recalled once', async () => {
    const fx = fixture()
    try {
      const srv = server(() => answer(BLOCK, ['requirement:r1:v1']))
      const opts = { home: fx.home, env: {}, fetchImpl: srv.fetchImpl, target: target() }
      fx.step('SYSTEM_MESSAGE', commandWake({ body: 'Please review the refund ledger plan' }))
      assert.ok((await runTurnRecall(fx.input(), opts)).result)
      fx.step('PLANNER_RESPONSE', '')
      fx.step('SYSTEM_MESSAGE', commandWake({ body: 'Please review the refund ledger plan' }))
      assert.equal((await runTurnRecall(fx.input(), opts)).reason, 'command_already_recalled')
      assert.equal(srv.calls.length, 1)
    } finally {
      fx.cleanup()
    }
  })

  it('a CHECKPOINT forgets the cards shown before it, so they can come back', async () => {
    const fx = fixture()
    try {
      const srv = server(() => answer(BLOCK, ['requirement:r1:v1']))
      const opts = { home: fx.home, env: {}, fetchImpl: srv.fetchImpl, target: target() }
      fx.step('USER_INPUT', userInput('How should the billing ledger handle refunds?'))
      await runTurnRecall(fx.input(), opts)
      fx.step('CHECKPOINT', 'earlier steps summarised')
      fx.step('USER_INPUT', userInput('Now the partial refunds, same ledger please'))
      await runTurnRecall(fx.input(), opts)
      assert.deepEqual(srv.calls[1].body.seen_versions, [])
    } finally {
      fx.cleanup()
    }
  })

  it('fails open: a thrown fetch, a 500, a 401 or a timeout inject nothing and remember nothing', async () => {
    const cases = [
      () => new Error('ECONNREFUSED'),
      () => ({ status: 500, json: { error: 'boom' } }),
      () => ({ status: 401, json: { code: 'invalid_api_token' } }),
      (call) => new Promise((resolve) => call.signal.addEventListener('abort', () => resolve(new Error('aborted')))),
    ]
    for (const respond of cases) {
      const fx = fixture()
      try {
        const srv = server(respond)
        const opts = { home: fx.home, env: {}, fetchImpl: srv.fetchImpl, target: target(), timeoutMs: 50 }
        fx.step('SYSTEM_MESSAGE', commandWake({ body: 'Please review the refund ledger plan' }))
        const started = Date.now()
        const out = await runTurnRecall(fx.input(), opts)
        assert.equal(out.result, null)
        assert.ok(Date.now() - started < 2_000)
        const { state } = loadSeenState(CONV, { home: fx.home })
        assert.deepEqual(state.entries, [])
        assert.deepEqual(state.handled_remote_ids, [], 'a failed recall may be tried again for the same command')
        assert.deepEqual(state.scope_misses, [], 'only a 400 for the scope is remembered')
        // Not cached: the next turn asks again.
        fx.step('USER_INPUT', userInput('How should the billing ledger handle refunds?'))
        await runTurnRecall(fx.input(), opts)
        assert.equal(srv.calls.length, 2)
      } finally {
        fx.cleanup()
      }
    }
  })

  it('the hard deadline ends the recall even when the request ignores its abort', async () => {
    const fx = fixture()
    try {
      const fetchImpl = () => new Promise(() => {})
      fx.step('USER_INPUT', userInput('How should the billing ledger handle refunds?'))
      const started = Date.now()
      const out = await turnRecallSteps(fx.input(), { home: fx.home, env: {}, fetchImpl, target: target(), hardExitMs: 100 })
      assert.equal(out, null)
      assert.ok(Date.now() - started < 1_000)
      assert.equal(TURN_RECALL_LIMITS.hardExitMs, 3_000)
      assert.equal(TURN_RECALL_LIMITS.clientHttpTimeoutMs, 2_800)
    } finally {
      fx.cleanup()
    }
  })

  it('a scope the server could not place is not asked again in this conversation; another scope is', async () => {
    const fx = fixture()
    try {
      const srv = server(() => ({ status: 400, json: { error: 'Project scope is required for turn recall', code: 'project_required' } }))
      const folder = { git_remote: 'git@github.com:someone/untracked.git', folder_scope_only: true }
      fx.step('USER_INPUT', userInput('How should the billing ledger handle refunds?'))
      await runTurnRecall(fx.input(), { home: fx.home, env: {}, fetchImpl: srv.fetchImpl, target: target(folder) })
      fx.step('USER_INPUT', userInput('And the partial refunds, how do they work?'))
      const again = await runTurnRecall(fx.input(), { home: fx.home, env: {}, fetchImpl: srv.fetchImpl, target: target(folder) })
      assert.equal(again.reason, 'scope_not_placed_before')
      assert.equal(srv.calls.length, 1)
      fx.step('USER_INPUT', userInput('Now in the other repository, same question'))
      await runTurnRecall(fx.input(), { home: fx.home, env: {}, fetchImpl: srv.fetchImpl, target: target({ project_id: PROJ }) })
      assert.equal(srv.calls.length, 2)
    } finally {
      fx.cleanup()
    }
  })

  it('nothing relevant: nothing injected, no keys kept, the command counted as recalled', async () => {
    const fx = fixture()
    try {
      const srv = server(() => answer('', []))
      fx.step('SYSTEM_MESSAGE', commandWake({ body: 'Please review the refund ledger plan' }))
      const out = await runTurnRecall(fx.input(), { home: fx.home, env: {}, fetchImpl: srv.fetchImpl, target: target() })
      assert.equal(out.result, null)
      const { state } = loadSeenState(CONV, { home: fx.home })
      assert.deepEqual(state.entries, [])
      assert.deepEqual(state.handled_remote_ids, [MSG])
    } finally {
      fx.cleanup()
    }
  })

  it('no credential or no project in sight: no call at all', async () => {
    const fx = fixture()
    try {
      const srv = server(() => answer(BLOCK, ['requirement:r1:v1']))
      fx.step('USER_INPUT', userInput('How should the billing ledger handle refunds?'))
      const out = await runTurnRecall(fx.input(), { home: fx.home, env: {}, fetchImpl: srv.fetchImpl, target: () => null })
      assert.equal(out.reason, 'no_credential_or_project')
      assert.equal(srv.calls.length, 0)
    } finally {
      fx.cleanup()
    }
  })
})

describe('where the call goes', () => {
  const quiet = { gitRemote: () => null, projectPin: () => null }

  it('a bound connection sends its capability and ids, never waiting on a sign-in renewal', () => {
    let loadOpts
    let credOpts
    const t = recallTarget({
      input: {}, conversationId: CONV, env: {}, home: '/h',
      loadBound: (_id, o) => { loadOpts = o; return { connection_id: CONN, session_id: SESS, project_id: PROJ, connection_capability: CAP, mcp_url: 'https://x/api/mcp', token: KEY } },
      credentialFor: (_s, o) => { credOpts = o; return { token: KEY, mcpUrl: 'https://x/api/mcp' } },
      resolveAuth: () => { throw new Error('not used') },
      ...quiet,
    })
    assert.equal(loadOpts.renewWaitMs, 0, 'never waits on a renewal')
    assert.equal(credOpts.waitMs, 0)
    assert.deepEqual(t, { token: KEY, mcpUrl: 'https://x/api/mcp', capability: CAP, scope: { connection_id: CONN, session_id: SESS } })
  })

  it('sessionless: the conversation\'s chosen project, else the folder\'s pin or remote, else nothing', () => {
    const fx = fixture()
    try {
      const auth = (_cwd, o) => (o.waitMs === 0 ? { ok: true, token: KEY, mcp_url: 'https://x/api/mcp' } : { ok: false })
      const base = { input: { workspacePaths: ['/work/repo'] }, conversationId: CONV, env: {}, home: fx.home, loadBound: () => null, resolveAuth: auth }
      assert.equal(recallTarget({ ...base, ...quiet }), null, 'no project evident: no call')
      const pinned = recallTarget({ ...base, gitRemote: () => 'git@github.com:a/b.git', projectPin: () => ({ project_id: PROJ }) })
      assert.deepEqual(pinned.scope, { pinned_project_id: PROJ, git_remote: 'git@github.com:a/b.git', folder_scope_only: true })
      assert.equal(recallTarget({ ...base, resolveAuth: () => ({ ok: false }), gitRemote: () => 'r', projectPin: () => null }), null, 'signed out')

      const projects = path.join(fx.home, '.devspec', 'remote-control', 'local', 'antigravity', 'projects')
      fs.mkdirSync(projects, { recursive: true })
      fs.writeFileSync(projectStatePath(CONV, fx.home), JSON.stringify({ version: 1, status: 'selected', local_id: CONV, endpoint: 'https://x/api/mcp', project: { id: PROJ, name: 'P' }, source: 'conversation' }))
      assert.deepEqual(recallTarget({ ...base, ...quiet }).scope, { project_id: PROJ })
      fs.writeFileSync(projectStatePath(CONV, fx.home), JSON.stringify({ version: 1, status: 'blocked', local_id: CONV, endpoint: 'https://x/api/mcp', message: 'choose' }))
      assert.equal(recallTarget({ ...base, gitRemote: () => 'r', projectPin: () => null }), null, 'a conversation still choosing its project gets no guess')
    } finally {
      fx.cleanup()
    }
  })

  it('the endpoint is the configured MCP address plus /turn-recall, query dropped', () => {
    assert.equal(turnRecallUrl('https://api.devspecstaging.com/api/mcp?model_tools=x'), 'https://api.devspecstaging.com/api/mcp/turn-recall')
    assert.equal(turnRecallUrl('not a url'), null)
  })
})

describe('state stays private and bounded', () => {
  it('never more than 512 entries or 32 KB, oldest dropped first', () => {
    const state = { version: 1, host: 'antigravity', conversation_id: CONV, updated_at: 0, last_processed_step_index: 1, last_checkpoint_step_index: null, handled_remote_ids: [], scope_misses: [], entries: [] }
    for (let i = 0; i < 900; i++) state.entries.push({ key: `memory:${String(i).padStart(8, '0')}-1111-4222-8333-944455556666:v1`, step: i, at: 1 })
    const text = boundedStateText(state)
    assert.ok(Buffer.byteLength(text) <= TURN_RECALL_LIMITS.seenStoreMaxBytes)
    assert.ok(state.entries.length <= TURN_RECALL_LIMITS.seenStoreMaxEntries)
    assert.equal(state.entries.at(-1).step, 899, 'the newest survive')
  })

  it('a conversation untouched for 30 days is swept; a recent one stays', () => {
    const fx = fixture()
    try {
      const old = { ...loadSeenState('old-conversation-1', { home: fx.home }).state }
      const recent = { ...loadSeenState('new-conversation-1', { home: fx.home }).state }
      saveSeenState(old, { home: fx.home })
      saveSeenState(recent, { home: fx.home })
      const stale = (Date.now() - TURN_RECALL_LIMITS.seenStoreTtlMs - 60_000) / 1000
      fs.utimesSync(seenStatePath('old-conversation-1', fx.home), stale, stale)
      assert.equal(sweepExpiredStates({ home: fx.home }), 1)
      assert.ok(fs.existsSync(seenStatePath('new-conversation-1', fx.home)))
    } finally {
      fx.cleanup()
    }
  })
})

describe('PreInvocation', () => {
  it('appends recalled cards after the room notice, and a recall that throws changes nothing', async () => {
    const fx = fixture()
    try {
      const recalled = { injectSteps: [{ systemMessage: { systemMessage: BLOCK } }] }
      const out = await runPreInvocation(fx.input(), { home: fx.home, env: {}, recall: async () => recalled })
      assert.deepEqual(out, recalled)
      const broken = await runPreInvocation(fx.input(), { home: fx.home, env: {}, recall: async () => { throw new Error('x') } })
      assert.equal(broken, null)
    } finally {
      fx.cleanup()
    }
  })

  it('signed out, the hook makes no request and prints only an empty result, never a key', async () => {
    const fx = fixture()
    try {
      fx.step('USER_INPUT', userInput('How should the billing ledger handle refunds?'))
      let called = 0
      const out = await runPreInvocation(fx.input(), { home: fx.home, env: {}, recallOptions: { fetchImpl: async () => { called++ } } })
      assert.equal(out, null)
      assert.equal(called, 0)
    } finally {
      fx.cleanup()
    }
  })
})

describe('single delivery', () => {
  it('no script asks poll_connection for recall: PreInvocation is the only path that delivers it', () => {
    for (const name of fs.readdirSync(SCRIPTS)) {
      if (!name.endsWith('.mjs') || name.endsWith('.test.mjs')) continue
      const text = fs.readFileSync(path.join(SCRIPTS, name), 'utf8')
      assert.ok(!/turn_recall_version|seen_recall_versions/.test(text), `${name} negotiates poll-delivered recall`)
    }
  })

  it('no hook but PreInvocation runs recall', () => {
    const hooks = JSON.parse(fs.readFileSync(path.join(SCRIPTS, '..', 'hooks.json'), 'utf8'))
    const commands = JSON.stringify(hooks)
    assert.ok(!commands.includes('turn-recall'), 'recall is reached only through pre-invocation.mjs')
    const pre = fs.readFileSync(path.join(SCRIPTS, 'pre-invocation.mjs'), 'utf8')
    assert.match(pre, /turnRecallSteps/)
  })
})
