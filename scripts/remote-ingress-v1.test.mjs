#!/usr/bin/env node
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  normalizeRemoteIngressV1,
  renderAdvisoryContext,
  REMOTE_INGRESS_CONTRACT_VERSION,
  REMOTE_INGRESS_POLICY_VERSION,
  REMOTE_INGRESS_SCOPE_CONTRACT_VERSION,
  REMOTE_INGRESS_SCOPE_POLICY_VERSION,
  ACTIVE_PLAN_AUTHORITY_NOTE,
  REMOTE_INGRESS_SENDER_STYLE_CONTRACT_VERSION,
  REMOTE_INGRESS_SENDER_STYLE_POLICY_VERSION,
  REMOTE_INGRESS_SYSTEM_NOTICE_CONTRACT_VERSION,
  REMOTE_INGRESS_SYSTEM_NOTICE_POLICY_VERSION,
} from './remote-ingress-v1.mjs'

const CONNECTION = '10000000-0000-4000-8000-000000000001'
const OWNER = '20000000-0000-4000-8000-000000000002'
const MESSAGE = '30000000-0000-4000-8000-000000000003'
const PROVENANCE = '40000000-0000-4000-8000-000000000004'
const TURN = '50000000-0000-4000-8000-000000000005'
const ENVELOPE = '60000000-0000-4000-8000-000000000006'
const RESOURCE = '70000000-0000-4000-8000-000000000007'
const PROJECT = '80000000-0000-4000-8000-000000000008'
const DELEGATED_INSTRUCTION = 'Work only within the server-selected project for this command.'

function order(messageId = MESSAGE, sequence = 1) {
  return { sequence, created_at: '2026-08-19T12:00:00.000Z', message_id: messageId }
}

function emptyContext() {
  return { human_context: [], agent_context: [], ai_context: [], system_context: [] }
}

function command(over = {}) {
  return {
    message_id: MESSAGE,
    order: order(),
    content: { mode: 'full', body: 'do the exact thing', complete: true },
    attachments: [],
    requester: { user_id: OWNER, display_name: 'Owner' },
    authority: {
      kind: 'owner',
      mode: 'owner',
      requested_by_user_id: OWNER,
      connection_owner_user_id: OWNER,
      decision_source: 'server',
    },
    project_scope: null,
    addressee: {
      connection_id: CONNECTION,
      agent_name: 'Claude Code',
      codename: 'Careful Moth',
      label: 'Claude Code / Careful Moth',
    },
    delivery: {
      provenance_ref: PROVENANCE,
      turn_id: TURN,
      primary_provenance_ref: PROVENANCE,
      is_primary: true,
    },
    ...over,
  }
}

function metadata(rows, over = {}) {
  const first = rows[0]?.order ?? null
  const last = rows.at(-1)?.order ?? null
  return {
    policy_version: REMOTE_INGRESS_POLICY_VERSION,
    returned: rows.length,
    total_known: rows.length,
    source_window: { start: first, end: last },
    truncated: false,
    has_more: false,
    next_cursor: null,
    fetch_id: null,
    omission_reason: null,
    ...over,
  }
}

function activePlans(over = {}) {
  const { steps: stepOverride, plans: planOverride, ...projectionOverride } = over
  const steps = stepOverride ?? [{
    id: '91000000-0000-4000-8000-000000000001',
    position: 0,
    title: 'Implement the protocol',
    status: 'in_progress',
  }]
  const plans = planOverride ?? [{
    id: '90000000-0000-4000-8000-000000000001',
    title: 'Shared protocol work',
    revision: 4,
    status: 'active',
    created_at: '2026-08-21T10:00:00.000Z',
    origin: { kind: 'connection', connection_id: CONNECTION, agent_name: 'Claude Code', codename: 'Careful Moth' },
    steward: { kind: 'connection', connection_id: CONNECTION, agent_name: 'Claude Code', codename: 'Careful Moth' },
    owner: { user_id: OWNER, display_name: 'Owner' },
    orphaned: false,
    progress: { terminal: 0, total: steps.length, completed: 0, skipped: 0 },
    steps,
  }]
  return {
    version: 1,
    advisory: true,
    authority_note: ACTIVE_PLAN_AUTHORITY_NOTE,
    inventory: { returned: plans.length, total_known: plans.length, truncated: false },
    plans,
    ...projectionOverride,
  }
}

function envelope(over = {}) {
  const commands = over.commands ?? [command()]
  const context = over.context ?? emptyContext()
  const rows = [...commands, ...Object.values(context).flat()].sort(
    (a, b) => a.order.sequence - b.order.sequence,
  )
  return {
    kind: 'devspec.remote_ingress',
    schema_version: 1,
    contract_version: REMOTE_INGRESS_CONTRACT_VERSION,
    policy_version: REMOTE_INGRESS_POLICY_VERSION,
    envelope_id: ENVELOPE,
    connection: {
      connection_id: CONNECTION,
      agent_name: 'Claude Code',
      codename: 'Careful Moth',
      label: 'Claude Code / Careful Moth',
    },
    wake: { kind: 'conversational_command', active: true, reason_id: 'new-command' },
    delivery_state: 'live',
    command_message_ids: commands.map((entry) => entry.message_id),
    commands,
    control: null,
    context,
    window: metadata(rows),
    ...over,
  }
}

describe('normalizeRemoteIngressV1', () => {
  it('preserves an exact very large full command body and all metadata by identity', () => {
    const body = `start\n${'x'.repeat(300_000)}\nend`
    const ingress = envelope({ commands: [command({ content: { mode: 'full', body, complete: true } })] })
    const result = normalizeRemoteIngressV1(ingress, CONNECTION)
    assert.equal(result.ok, true)
    assert.equal(result.wake, true)
    assert.equal(result.envelope, ingress)
    assert.equal(result.commands[0].content.body, body)
    assert.equal(result.commands[0].delivery.turn_id, TURN)
    assert.equal(result.commands[0].requester.user_id, OWNER)
  })

  it('accepts delegated authority only with the exact server-owned project scope', () => {
    const requester = '21000000-0000-4000-8000-000000000002'
    const projectScope = {
      kind: 'devspec_project',
      policy_id: 'delegated_project_v1',
      project_id: PROJECT,
      instruction: DELEGATED_INSTRUCTION,
    }
    const delegated = command({
      requester: { user_id: requester, display_name: 'Delegate' },
      authority: {
        kind: 'delegated',
        mode: 'allowlist',
        requested_by_user_id: requester,
        connection_owner_user_id: OWNER,
        decision_source: 'server',
      },
      project_scope: projectScope,
    })
    const result = normalizeRemoteIngressV1(envelope({ commands: [delegated] }), CONNECTION)
    assert.equal(result.wake, true)
    assert.equal(result.commands[0].authority.kind, 'delegated')
    assert.equal(result.commands[0].requester.user_id, requester)
    assert.equal(result.commands[0].project_scope, projectScope)
    assert.equal(result.commands[0].project_scope.instruction, DELEGATED_INSTRUCTION)
  })

  it('fails closed on missing, malformed, unknown, mismatched, or authority-incompatible scope', () => {
    const requester = '21000000-0000-4000-8000-000000000002'
    const delegatedAuthority = {
      kind: 'delegated', mode: 'project', requested_by_user_id: requester,
      connection_owner_user_id: OWNER, decision_source: 'server',
    }
    const validScope = {
      kind: 'devspec_project', policy_id: 'delegated_project_v1', project_id: PROJECT,
      instruction: DELEGATED_INSTRUCTION,
    }
    const delegated = (projectScope) => command({
      requester: { user_id: requester, display_name: 'Delegate' },
      authority: delegatedAuthority,
      ...(projectScope === undefined ? { project_scope: undefined } : { project_scope: projectScope }),
    })
    const missingScope = delegated(validScope)
    delete missingScope.project_scope
    const invalid = [
      missingScope,
      delegated(undefined),
      delegated(null),
      delegated({ ...validScope, kind: 'workspace' }),
      delegated({ ...validScope, policy_id: 'unknown_policy' }),
      delegated({ ...validScope, project_id: 'not-a-uuid' }),
      delegated({ ...validScope, instruction: '' }),
      delegated({ ...validScope, extra: true }),
      command({ project_scope: validScope }),
    ]
    for (const entry of invalid) {
      assert.equal(normalizeRemoteIngressV1(envelope({ commands: [entry] }), CONNECTION).ok, false)
    }
  })

  it('accepts metadata attachments as stable resource references without rewriting them', () => {
    const stable = {
      materialization: 'metadata',
      filename: 'design.png',
      mime_type: 'image/png',
      type: 'image',
      size_bytes: 1234,
      resource_id: RESOURCE,
    }
    const ingress = envelope({ commands: [command({ attachments: [stable] })] })
    const result = normalizeRemoteIngressV1(ingress, CONNECTION)
    assert.equal(result.wake, true)
    assert.equal(result.commands[0].attachments[0], stable)
    assert.equal(result.commands[0].attachments[0].resource_id, RESOURCE)
  })

  it('rejects an unavailable attachment for the whole one-command turn before wake', () => {
    const unavailable = {
      materialization: 'unavailable',
      filename: 'lost.png',
      mime_type: 'image/png',
      type: 'image',
      size_bytes: null,
      resource_id: null,
      reason: 'missing_resource',
    }
    const result = normalizeRemoteIngressV1(
      envelope({ commands: [command({ attachments: [unavailable] })] }),
      CONNECTION,
    )
    assert.deepEqual([result.ok, result.wake, result.reason], [true, false, 'unavailable_attachment'])
  })

  it('matches the authoritative canonical UUID boundary', () => {
    const cases = [
      ['lowercase nil sentinel', '00000000-0000-0000-0000-000000000000', true],
      ['lowercase max sentinel', 'ffffffff-ffff-ffff-ffff-ffffffffffff', true],
      ['lowercase RFC v4 UUID', '123e4567-e89b-42d3-a456-426614174000', true],
      ['uppercase RFC v4 UUID', '123E4567-E89B-42D3-A456-426614174000', true],
      ['nil near miss', '00000000-0000-0000-0000-000000000001', false],
      ['max near miss', 'ffffffff-ffff-ffff-ffff-fffffffffffe', false],
      ['uppercase max sentinel', 'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF', false],
      ['mixed-case max sentinel', 'ffffffff-ffff-ffff-ffff-ffffffffffFf', false],
      ['invalid RFC version', '123e4567-e89b-92d3-a456-426614174000', false],
      ['invalid RFC variant', '123e4567-e89b-42d3-7456-426614174000', false],
      ['missing canonical hyphen', '123e4567e89b-42d3-a456-426614174000', false],
    ]

    for (const [name, value, expected] of cases) {
      assert.equal(
        normalizeRemoteIngressV1(envelope({ envelope_id: value }), CONNECTION).ok,
        expected,
        name,
      )
    }
  })

  it('matches authoritative datetime/safe-integer boundaries', () => {
    const invalidDate = command({
      order: { sequence: 1, created_at: '2026-02-29T12:00:00.000Z', message_id: MESSAGE },
    })
    assert.equal(normalizeRemoteIngressV1(envelope({ commands: [invalidDate] }), CONNECTION).ok, false)
    const unsafeOrder = command({
      order: { sequence: Number.MAX_SAFE_INTEGER + 1, created_at: '2026-08-19T12:00:00.000Z', message_id: MESSAGE },
    })
    assert.equal(normalizeRemoteIngressV1(envelope({ commands: [unsafeOrder] }), CONNECTION).ok, false)
  })

  it('fails closed on missing, malformed, extra-field, unknown-version, and wrong-target ingress', () => {
    assert.equal(normalizeRemoteIngressV1(undefined, CONNECTION).ok, false)
    assert.equal(normalizeRemoteIngressV1({ kind: 'devspec.remote_ingress' }, CONNECTION).ok, false)
    assert.equal(normalizeRemoteIngressV1({ ...envelope(), preview: 'run me' }, CONNECTION).ok, false)
    assert.equal(normalizeRemoteIngressV1({ ...envelope(), schema_version: 2 }, CONNECTION).ok, false)
    const legacy = envelope()
    legacy.contract_version = '1.1.0'
    legacy.policy_version = '2026-08-19.2'
    legacy.window.policy_version = '2026-08-19.2'
    legacy.commands = legacy.commands.map(({ project_scope: _scope, ...entry }) => entry)
    assert.equal(normalizeRemoteIngressV1(legacy, CONNECTION).ok, true)

    const requester = '21000000-0000-4000-8000-000000000002'
    legacy.commands[0].requester = { user_id: requester, display_name: 'Legacy delegate' }
    legacy.commands[0].authority = {
      kind: 'delegated', mode: 'allowlist', requested_by_user_id: requester,
      connection_owner_user_id: OWNER, decision_source: 'server',
    }
    assert.equal(normalizeRemoteIngressV1(legacy, CONNECTION).ok, false)
    assert.equal(normalizeRemoteIngressV1({ ...envelope(), contract_version: '1.1.1' }, CONNECTION).ok, false)
    assert.equal(normalizeRemoteIngressV1({ ...envelope(), policy_version: '2026-08-19.2' }, CONNECTION).ok, false)
    assert.equal(normalizeRemoteIngressV1({ ...envelope(), contract_version: '1.2.1' }, CONNECTION).ok, false)
    assert.equal(
      normalizeRemoteIngressV1(envelope(), '90000000-0000-4000-8000-000000000009').ok,
      false,
    )
  })

  it('never wakes replay/reseed/advisory/control/idle envelopes', () => {
    const cases = [
      envelope({
        wake: { kind: 'history_reseed', active: false, reason_id: 'reseed' },
        delivery_state: 'reseed',
        command_message_ids: [],
        commands: [],
        window: metadata([]),
      }),
      envelope({
        wake: { kind: 'advisory_update', active: false, reason_id: 'context' },
        command_message_ids: [],
        commands: [],
        window: metadata([]),
      }),
      envelope({
        wake: { kind: 'idle', active: false, reason_id: 'idle' },
        command_message_ids: [],
        commands: [],
        window: metadata([]),
      }),
      envelope({
        wake: { kind: 'control', active: true, reason_id: 'control' },
        command_message_ids: [],
        commands: [],
        control: {
          id: '80000000-0000-4000-8000-000000000008',
          verb: 'abort',
          issued_at: '2026-08-19T12:00:00.000Z',
          issued_by_user_id: OWNER,
        },
        window: metadata([]),
      }),
    ]
    for (const ingress of cases) {
      const result = normalizeRemoteIngressV1(ingress, CONNECTION)
      assert.equal(result.ok, true)
      assert.equal(result.wake, false)
    }
  })

  it('preserves queued command order and the one-turn primary binding', () => {
    const secondId = '31000000-0000-4000-8000-000000000003'
    const secondaryRef = '41000000-0000-4000-8000-000000000004'
    const primary = command()
    const secondary = command({
      message_id: secondId,
      order: order(secondId, 2),
      content: { mode: 'full', body: 'second queued body', complete: true },
      delivery: {
        provenance_ref: secondaryRef,
        turn_id: TURN,
        primary_provenance_ref: PROVENANCE,
        is_primary: false,
      },
    })
    const ingress = envelope({ commands: [primary, secondary] })
    const result = normalizeRemoteIngressV1(ingress, CONNECTION)
    assert.equal(result.wake, true)
    assert.deepEqual(result.commands.map((entry) => entry.message_id), [MESSAGE, secondId])
    assert.equal(result.commands[1].delivery.primary_provenance_ref, PROVENANCE)
  })

  it('accepts a later cursor delta after the turn primary was already consumed', () => {
    const secondId = '31000000-0000-4000-8000-000000000003'
    const secondary = command({
      message_id: secondId,
      order: order(secondId, 2),
      delivery: {
        provenance_ref: '41000000-0000-4000-8000-000000000004',
        turn_id: TURN,
        primary_provenance_ref: PROVENANCE,
        is_primary: false,
      },
    })
    const result = normalizeRemoteIngressV1(envelope({ commands: [secondary] }), CONNECTION)
    assert.equal(result.ok, true)
    assert.equal(result.wake, true)
    assert.deepEqual(result.commands.map((entry) => entry.message_id), [secondId])
  })

  it('rejects false primary flags and duplicate visible provenance refs', () => {
    const secondaryId = '31000000-0000-4000-8000-000000000003'
    const secondary = command({
      message_id: secondaryId,
      order: order(secondaryId, 2),
      delivery: {
        provenance_ref: '41000000-0000-4000-8000-000000000004',
        turn_id: TURN,
        primary_provenance_ref: PROVENANCE,
        is_primary: false,
      },
    })
    const falseFlag = command({
      delivery: {
        provenance_ref: PROVENANCE,
        turn_id: TURN,
        primary_provenance_ref: PROVENANCE,
        is_primary: false,
      },
    })
    assert.equal(normalizeRemoteIngressV1(envelope({ commands: [falseFlag] }), CONNECTION).ok, false)
    const duplicate = command({
      message_id: secondaryId,
      order: order(secondaryId, 2),
      delivery: { ...secondary.delivery, provenance_ref: secondary.delivery.provenance_ref },
    })
    const first = command({
      delivery: {
        provenance_ref: secondary.delivery.provenance_ref,
        turn_id: TURN,
        primary_provenance_ref: PROVENANCE,
        is_primary: false,
      },
    })
    assert.equal(normalizeRemoteIngressV1(envelope({ commands: [first, duplicate] }), CONNECTION).ok, false)
  })

  it('treats reconnect replay as inert even when legacy top-level arrays would look live', () => {
    const replay = envelope({
      wake: { kind: 'history_reseed', active: false, reason_id: 'reconnect' },
      delivery_state: 'replay',
      command_message_ids: [],
      commands: [],
      window: metadata([]),
    })
    const pollResponse = { changed: true, ingress: replay, commands: [command()], preview: 'do it' }
    const result = normalizeRemoteIngressV1(pollResponse.ingress, CONNECTION)
    assert.equal(result.ok, true)
    assert.equal(result.wake, false)
  })
})

describe('strict 1.3 active session plans with compatibility', () => {
  it('preserves a complete latest revision as advisory room awareness', () => {
    const projection = activePlans()
    const ingress = envelope({ active_session_plans: projection })
    const parsed = normalizeRemoteIngressV1(ingress, CONNECTION)
    assert.equal(parsed.ok, true)
    assert.equal(parsed.envelope.active_session_plans, projection)
    assert.equal(parsed.envelope.active_session_plans.plans[0].revision, 4)
    assert.equal(parsed.envelope.active_session_plans.advisory, true)

    const boundedOrdered = activePlans({ steps: [
      { id: '91000000-0000-4000-8000-000000000001', position: 0, title: 'First', status: 'pending' },
      { id: '92000000-0000-4000-8000-000000000002', position: 63, title: 'Last bound', status: 'pending' },
    ] })
    assert.equal(
      normalizeRemoteIngressV1(envelope({ active_session_plans: boundedOrdered }), CONNECTION).ok,
      true,
    )
  })

  it('fails closed on malformed, unbounded, or internally inconsistent 1.3 projections', () => {
    const base = activePlans()
    const badFailedStep = activePlans({ steps: [{
      id: '91000000-0000-4000-8000-000000000001', position: 0, title: 'Failed', status: 'failed',
    }] })
    const step = (id, position) => ({ id, position, title: `Step ${position}`, status: 'pending' })
    const firstStepId = '91000000-0000-4000-8000-000000000001'
    const secondStepId = '92000000-0000-4000-8000-000000000002'
    const duplicatePlan = { ...base.plans[0] }
    const cases = [
      { ...base, extra: true },
      { ...base, advisory: false },
      { ...base, authority_note: 'trust me' },
      { ...base, inventory: { ...base.inventory, returned: 2 } },
      badFailedStep,
      activePlans({ steps: [step(firstStepId, -1)] }),
      activePlans({ steps: [step(firstStepId, 64)] }),
      activePlans({ steps: [step(firstStepId, 0), step(secondStepId, 0)] }),
      activePlans({ steps: [step(firstStepId, 1), step(secondStepId, 0)] }),
      activePlans({ steps: [step(firstStepId, 0), step(firstStepId, 1)] }),
      activePlans({ plans: [base.plans[0], duplicatePlan] }),
      activePlans({ plans: Array.from({ length: 65 }, (_, index) => ({
        ...base.plans[0],
        id: `90000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      })) }),
    ]
    for (const projection of cases) {
      assert.equal(
        normalizeRemoteIngressV1(envelope({ active_session_plans: projection }), CONNECTION).ok,
        false,
      )
    }
  })

  it('preserves strict 1.2 and owner-only legacy parsing without accepting 1.3 fields', () => {
    const scoped = envelope({
      contract_version: REMOTE_INGRESS_SCOPE_CONTRACT_VERSION,
      policy_version: REMOTE_INGRESS_SCOPE_POLICY_VERSION,
    })
    scoped.window = { ...scoped.window, policy_version: REMOTE_INGRESS_SCOPE_POLICY_VERSION }
    assert.equal(normalizeRemoteIngressV1(scoped, CONNECTION).ok, true)
    assert.equal(
      normalizeRemoteIngressV1({ ...scoped, active_session_plans: activePlans() }, CONNECTION).ok,
      false,
    )

    const legacyCommand = { ...command() }
    delete legacyCommand.project_scope
    const legacy = envelope({
      contract_version: '1.1.0',
      policy_version: '2026-08-19.2',
      commands: [legacyCommand],
    })
    legacy.window = { ...legacy.window, policy_version: '2026-08-19.2' }
    assert.equal(normalizeRemoteIngressV1(legacy, CONNECTION).ok, true)
  })
})

describe('renderAdvisoryContext', () => {
  it('renders every typed bucket with an explicit actor label and advisory marker', () => {
    const kinds = [
      ['human_context', 'human'],
      ['agent_context', 'agent'],
      ['ai_context', 'ai'],
      ['system_context', 'system'],
    ]
    const context = emptyContext()
    for (let i = 0; i < kinds.length; i++) {
      const [bucket, kind] = kinds[i]
      const id = `${String(10 + i).padStart(8, '0')}-0000-4000-8000-000000000010`
      context[bucket].push({
        message_id: id,
        order: order(id, i + 1),
        actor: {
          kind,
          user_id: kind === 'human' ? OWNER : null,
          display_name: `${kind} actor`,
          agent_tool: kind === 'agent' ? 'Claude Code' : null,
          model: kind === 'ai' ? 'model-x' : null,
        },
        source_type: 'session_message',
        relationship: 'within_window',
        content: `${kind} says this is context`,
        advisory: true,
      })
    }
    const rendered = renderAdvisoryContext(context)
    assert.equal(rendered.length, 4)
    assert.ok(rendered.every((entry) => entry.advisory === true))
    assert.deepEqual(rendered.map((entry) => entry.actor_label), [
      'HUMAN: human actor',
      'AGENT: agent actor',
      'AI: ai actor',
      'SYSTEM: system actor',
    ])
  })
})


describe('strict 1.5 sender response style', () => {
  const styled = (over = {}) => {
    const built = envelope({
      contract_version: REMOTE_INGRESS_SENDER_STYLE_CONTRACT_VERSION,
      policy_version: REMOTE_INGRESS_SENDER_STYLE_POLICY_VERSION,
      system_notices: [],
      ...over,
    })
    built.window.policy_version = REMOTE_INGRESS_SENDER_STYLE_POLICY_VERSION
    return built
  }

  it('accepts a style bound to the delivered command, and still wakes', () => {
    const result = normalizeRemoteIngressV1(styled({
      sender_response_styles: [{ message_id: MESSAGE, notes: ['Talk to me like a person talking aloud.'] }],
    }), CONNECTION)
    assert.equal(result.ok, true)
    assert.equal(result.wake, true)
    assert.deepEqual(result.envelope.sender_response_styles[0].notes, [
      'Talk to me like a person talking aloud.',
    ])
  })

  it('is optional — the ordinary case is that nobody set a preference', () => {
    const result = normalizeRemoteIngressV1(styled(), CONNECTION)
    assert.equal(result.ok, true)
    assert.equal(result.wake, true)
  })

  it('rejects a style for a command this delta never delivered', () => {
    const result = normalizeRemoteIngressV1(styled({
      sender_response_styles: [{ message_id: ENVELOPE, notes: ['never delivered'] }],
    }), CONNECTION)
    assert.equal(result.ok, false)
    assert.match(result.error, /delivered command exactly once/)
  })

  it('rejects the same command styled twice', () => {
    const result = normalizeRemoteIngressV1(styled({
      sender_response_styles: [
        { message_id: MESSAGE, notes: ['one'] },
        { message_id: MESSAGE, notes: ['two'] },
      ],
    }), CONNECTION)
    assert.equal(result.ok, false)
    assert.match(result.error, /delivered command exactly once/)
  })

  it('rejects a malformed style entry', () => {
    for (const styles of [
      [{ message_id: MESSAGE, notes: [] }],
      [{ message_id: MESSAGE, notes: [''] }],
      [{ message_id: 'not-a-uuid', notes: ['x'] }],
      [{ message_id: MESSAGE, notes: ['x'], extra: true }],
    ]) {
      const result = normalizeRemoteIngressV1(styled({ sender_response_styles: styles }), CONNECTION)
      assert.equal(result.ok, false, JSON.stringify(styles))
    }
  })

  it('refuses the section on a lane that never negotiated it', () => {
    const result = normalizeRemoteIngressV1(envelope({
      sender_response_styles: [{ message_id: MESSAGE, notes: ['x'] }],
    }), CONNECTION)
    assert.equal(result.ok, false)
    assert.match(result.error, /exactly the canonical v1 fields/)
  })
})

describe('strict 1.4 system notices', () => {
  const noticed = (over = {}) => {
    const built = envelope({
      contract_version: REMOTE_INGRESS_SYSTEM_NOTICE_CONTRACT_VERSION,
      policy_version: REMOTE_INGRESS_SYSTEM_NOTICE_POLICY_VERSION,
      system_notices: [],
      ...over,
    })
    built.window.policy_version = REMOTE_INGRESS_SYSTEM_NOTICE_POLICY_VERSION
    return built
  }

  it('requires the array, empty on an ordinary command wake', () => {
    assert.equal(normalizeRemoteIngressV1(noticed(), CONNECTION).ok, true)
  })

  it('rejects the 1.4 lane without the array at all', () => {
    const missing = noticed()
    delete missing.system_notices
    assert.equal(normalizeRemoteIngressV1(missing, CONNECTION).ok, false)
  })

  it('refuses notices sitting alongside commands', () => {
    const result = normalizeRemoteIngressV1(noticed({
      system_notices: [{ version: 1, kind: 'unlinked_commit_item_review' }],
    }), CONNECTION)
    assert.equal(result.ok, false)
    assert.match(result.error, /nonempty iff wake kind is system_notice/)
  })
})
