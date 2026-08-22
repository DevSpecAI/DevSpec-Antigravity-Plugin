export const FIXTURE_ID = {
  connection: '11111111-1111-4111-8111-111111111111',
  envelope: '22222222-2222-4222-8222-222222222222',
  message: '33333333-3333-4333-8333-333333333333',
  requester: '55555555-5555-4555-8555-555555555555',
  provenance: '66666666-6666-4666-8666-666666666666',
  turn: '77777777-7777-4777-8777-777777777777',
  resource: '88888888-8888-4888-8888-888888888888',
  control: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  playbookRun: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  playbook: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  plan: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  step: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
}

export function fixtureUuid(n) {
  return `${Number(n).toString(16).padStart(8, '0')}-0000-4000-8000-${Number(n).toString(16).padStart(12, '0')}`
}
export function fixtureOrder(sequence, message_id) {
  return {
    sequence,
    created_at: new Date(Date.UTC(2026, 7, 19, 12, 0, 0) + sequence * 1000).toISOString(),
    message_id,
  }
}
export function emptyFixtureContext() {
  return { human_context: [], agent_context: [], ai_context: [], system_context: [] }
}
export function fixtureCommand(body = 'ship it') {
  return {
    message_id: FIXTURE_ID.message,
    order: fixtureOrder(1, FIXTURE_ID.message),
    content: { mode: 'full', body, complete: true },
    attachments: [{
      materialization: 'metadata', filename: 'design.png', mime_type: 'image/png', type: 'image',
      size_bytes: 1234, resource_id: FIXTURE_ID.resource,
    }],
    requester: { user_id: FIXTURE_ID.requester, display_name: 'Owner' },
    authority: {
      kind: 'owner', mode: 'owner', requested_by_user_id: FIXTURE_ID.requester,
      connection_owner_user_id: FIXTURE_ID.requester, decision_source: 'server',
    },
    addressee: {
      connection_id: FIXTURE_ID.connection, agent_name: 'Antigravity', codename: 'Calm Fox',
      label: 'Antigravity · Calm Fox',
    },
    delivery: {
      provenance_ref: FIXTURE_ID.provenance, turn_id: FIXTURE_ID.turn,
      primary_provenance_ref: FIXTURE_ID.provenance, is_primary: true,
    },
    project_scope: null,
  }
}
export function fixtureContextEntry({ sequence = 2, kind = 'ai', content = 'advisory context' } = {}) {
  const message_id = fixtureUuid(sequence + 100)
  return {
    message_id,
    order: fixtureOrder(sequence, message_id),
    actor: {
      kind,
      user_id: kind === 'human' ? FIXTURE_ID.requester : null,
      display_name: kind === 'human' ? 'Owner' : kind === 'system' ? 'DevSpec' : 'Context actor',
      agent_tool: kind === 'agent' || kind === 'ai' ? 'fixture-tool' : null,
      model: kind === 'ai' ? 'fixture-model' : null,
    },
    source_type: 'fixture', relationship: 'within_window', content, advisory: true,
  }
}
export function fixtureActivePlans(over = {}) {
  const plan = {
    id: FIXTURE_ID.plan,
    title: 'Ship shared plans',
    revision: 7,
    status: 'active',
    created_at: '2026-08-21T12:00:00.000Z',
    origin: { kind: 'connection', connection_id: FIXTURE_ID.connection, agent_name: 'Antigravity', codename: 'Calm Fox' },
    steward: { kind: 'connection', connection_id: FIXTURE_ID.connection, agent_name: 'Antigravity', codename: 'Calm Fox' },
    owner: { user_id: FIXTURE_ID.requester, display_name: 'Owner' },
    orphaned: false,
    progress: { terminal: 0, total: 1, completed: 0, skipped: 0 },
    steps: [{ id: FIXTURE_ID.step, position: 0, title: 'Implement projection', status: 'in_progress' }],
  }
  return {
    version: 1,
    advisory: true,
    authority_note: 'Advisory read-awareness only. Presence does not authorize execution or mutation; manage_plan still requires a capability-authenticated caller identity, explicit plan_id for cross-plan work, and expected_revision.',
    inventory: { returned: 1, total_known: 1, truncated: false },
    plans: [{ ...plan, ...over }],
  }
}
export function fixtureWindow(rows, over = {}) {
  const ordered = [...rows].sort((a, b) => a.order.sequence - b.order.sequence)
  return {
    policy_version: '2026-08-21.1',
    returned: ordered.length,
    total_known: ordered.length,
    source_window: ordered.length
      ? { start: ordered[0].order, end: ordered.at(-1).order }
      : { start: null, end: null },
    truncated: false,
    has_more: false,
    next_cursor: null,
    fetch_id: null,
    omission_reason: null,
    ...over,
  }
}
export function fixtureEnvelope({
  body = 'ship it',
  wakeKind = 'conversational_command',
  deliveryState = 'live',
  context = emptyFixtureContext(),
  commands,
  control = null,
  envelopeId = FIXTURE_ID.envelope,
  window: windowOverride,
  activePlans = fixtureActivePlans(),
} = {}) {
  const cmds = commands ?? (wakeKind === 'conversational_command' ? [fixtureCommand(body)] : [])
  const rows = [...cmds, ...Object.values(context).flat()]
  return {
    kind: 'devspec.remote_ingress', schema_version: 1, contract_version: '1.3.0',
    policy_version: '2026-08-21.1', envelope_id: envelopeId,
    connection: {
      connection_id: FIXTURE_ID.connection, agent_name: 'Antigravity', codename: 'Calm Fox',
      label: 'Antigravity · Calm Fox',
    },
    wake: {
      kind: wakeKind,
      active: wakeKind === 'conversational_command' || wakeKind === 'control',
      reason_id: `${wakeKind}_fixture`,
    },
    delivery_state: deliveryState,
    command_message_ids: cmds.map((command) => command.message_id),
    commands: cmds,
    control,
    context,
    ...(activePlans ? { active_session_plans: activePlans } : {}),
    window: windowOverride ?? fixtureWindow(rows),
  }
}
export function fixtureControl(verb = 'compact', args) {
  return {
    id: FIXTURE_ID.control,
    verb,
    issued_at: '2026-08-19T12:00:00.000Z',
    issued_by_user_id: FIXTURE_ID.requester,
    ...(args ? { args } : {}),
  }
}
export function fixturePlaybookDispatch(over = {}) {
  return {
    id: FIXTURE_ID.playbookRun,
    kind: 'playbook_run',
    run_id: FIXTURE_ID.playbookRun,
    playbook_id: FIXTURE_ID.playbook,
    playbook_name: 'Review health',
    instruction: 'Inspect and report.',
    permission: 'look_only',
    requester: { user_id: FIXTURE_ID.requester },
    original_target_connection_id: null,
    delivery_connection_id: FIXTURE_ID.connection,
    queued_at: '2026-08-19T12:00:00.000Z',
    state: 'queued',
    ...over,
  }
}
export function fixturePollResponse({ envelope = fixtureEnvelope(), dispatches = [], over = {} } = {}) {
  return {
    changed: true,
    cursor: FIXTURE_ID.message,
    cursor_v2: 'live-cursor-v2',
    dispatch_cursor: 'dispatch-watermark',
    ingress: envelope,
    dispatches,
    ...over,
  }
}
