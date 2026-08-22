import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  MANAGE_PLAN_SCHEMA,
  callManagePlan,
  readPlanState,
  validateManagePlanArguments,
} from './devspec-plan.mjs'

const PLAN = '11111111-1111-4111-8111-111111111111'
const CONNECTION = '22222222-2222-4222-8222-222222222222'
const state = {
  enabled: true,
  bond_verified: true,
  connection_id: CONNECTION,
  session_id: '33333333-3333-4333-8333-333333333333',
  local_id: 'conversation-1',
  agent_name: 'Antigravity',
  token: 'dvs_test',
  mcp_url: 'https://example.test/mcp',
  connection_capability_version: 1,
  connection_capability: 'dvsc_secret',
}

const VALID_BY_ACTION = {
  list: { action: 'list' },
  get: { action: 'get' },
  create: { action: 'create', title: 'Plan', steps: [{ title: 'Step' }] },
  update: { action: 'update', expected_revision: 1, steps: [] },
  start_step: { action: 'start_step', expected_revision: 1, step_id: 'step' },
  complete_step: { action: 'complete_step', expected_revision: 1, step_id: 'step' },
  skip_step: { action: 'skip_step', expected_revision: 1, step_id: 'step' },
  fail_step: { action: 'fail_step', expected_revision: 1, step_id: 'step', reason: '', retryable: false },
  advance: { action: 'advance', expected_revision: 1 },
  complete: { action: 'complete', expected_revision: 1 },
  abandon: { action: 'abandon', expected_revision: 1, reason: 'No longer needed' },
  adopt: { action: 'adopt', plan_id: PLAN, expected_revision: 1 },
}
function schemaBranch(action) {
  return MANAGE_PLAN_SCHEMA.oneOf.find((branch) => branch.properties.action.const === action)
}

describe('schema-complete on-demand manage_plan bridge', () => {
  it('emits one exact discriminated object per runtime action', () => {
    assert.deepEqual(MANAGE_PLAN_SCHEMA.oneOf.map((branch) => branch.properties.action.const), [
      'create', 'list', 'get', 'update', 'start_step', 'complete_step', 'skip_step',
      'fail_step', 'advance', 'complete', 'abandon', 'adopt',
    ])
    for (const branch of MANAGE_PLAN_SCHEMA.oneOf) {
      assert.equal(branch.type, 'object')
      assert.equal(branch.additionalProperties, false)
      assert.deepEqual(branch.required.includes('action'), true)
      if (branch.properties.steps) assert.equal(branch.properties.steps.items.additionalProperties, false)
    }
    assert.equal(Object.hasOwn(MANAGE_PLAN_SCHEMA, 'properties'), false)
  })

  it('keeps schema properties/requirements in parity with runtime acceptance', () => {
    const allProperties = new Set(MANAGE_PLAN_SCHEMA.oneOf.flatMap((branch) => Object.keys(branch.properties)))
    for (const [action, valid] of Object.entries(VALID_BY_ACTION)) {
      const branch = schemaBranch(action)
      assert.ok(branch, action)
      assert.equal(validateManagePlanArguments(valid), null, action)
      assert.deepEqual([...branch.required].sort(), Object.keys(valid).sort(), `${action} required parity`)
      assert.deepEqual(Object.keys(branch.properties).sort(), [
        ...new Set([
          ...Object.keys(valid),
          ...(action === 'get' ? ['plan_id'] : []),
          ...(['update', 'start_step', 'complete_step', 'skip_step', 'fail_step', 'advance', 'complete', 'abandon'].includes(action) ? ['plan_id'] : []),
          ...(action === 'advance' ? ['steps', 'current_step_id', 'next_step_id'] : []),
        ]),
      ].sort(), action)
      if (branch.properties.expected_revision) {
        assert.deepEqual(branch.properties.expected_revision, {
          type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER,
        })
      }
      for (const required of branch.required.filter((key) => key !== 'action')) {
        const missing = { ...valid }
        delete missing[required]
        assert.notEqual(validateManagePlanArguments(missing), null, `${action} requires ${required}`)
      }
      const forbidden = [...allProperties].find((property) => !Object.hasOwn(branch.properties, property))
      assert.ok(forbidden, `${action} has a forbidden sibling property`)
      assert.match(validateManagePlanArguments({ ...valid, [forbidden]: 'extra' }), /unsupported property/)
    }
  })

  it('matches create/update/advance requirements', () => {
    assert.match(validateManagePlanArguments({ action: 'create', title: 'Deliver feature' }), /at least one step/)
    assert.equal(validateManagePlanArguments({ action: 'create', title: 'Deliver feature', steps: [{ title: 'Implement' }] }), null)
    assert.match(validateManagePlanArguments({ action: 'update', expected_revision: 2 }), /requires steps/)
    assert.equal(validateManagePlanArguments({ action: 'update', expected_revision: 2, steps: [] }), null)
    assert.match(validateManagePlanArguments({ action: 'advance' }), /expected_revision/)
    assert.equal(validateManagePlanArguments({ action: 'advance', expected_revision: 4 }), null)
    assert.equal(validateManagePlanArguments({ action: 'advance', expected_revision: 4, steps: [{ id: 'step', title: 'Next' }] }), null)
  })

  it('matches every step/end/adoption requirement', () => {
    for (const action of ['start_step', 'complete_step', 'skip_step']) {
      assert.match(validateManagePlanArguments({ action, expected_revision: 3 }), /step_id/)
      assert.equal(validateManagePlanArguments({ action, expected_revision: 3, step_id: 'step' }), null)
    }
    assert.match(validateManagePlanArguments({ action: 'fail_step', expected_revision: 3, step_id: 'step' }), /reason and retryable/)
    assert.equal(validateManagePlanArguments({ action: 'fail_step', expected_revision: 3, step_id: 'step', reason: '', retryable: false }), null)
    assert.equal(validateManagePlanArguments({ action: 'complete', expected_revision: 5 }), null)
    assert.match(validateManagePlanArguments({ action: 'abandon', expected_revision: 5 }), /reason/)
    assert.equal(validateManagePlanArguments({ action: 'abandon', expected_revision: 5, reason: 'Direction changed' }), null)
    assert.match(validateManagePlanArguments({ action: 'adopt', expected_revision: 7 }), /plan_id/)
    assert.equal(validateManagePlanArguments({ action: 'adopt', plan_id: PLAN, expected_revision: 7 }), null)
  })

  it('rejects identity, provenance, capability, claim, project, runner, irrelevant, and nested extras', () => {
    for (const extra of [
      'connection_id', 'session_id', 'user_id', 'provenance_ref', 'work_claim_ref',
      'connection_capability', 'claim_id', 'claim_ref', 'project_id', 'git_remote',
      'pinned_project_id', 'runner_session_id',
    ]) {
      assert.match(validateManagePlanArguments({ action: 'list', [extra]: 'forbidden' }), /unsupported property/, extra)
    }
    assert.match(validateManagePlanArguments({ action: 'list', expected_revision: 1 }), /unsupported property/)
    assert.match(validateManagePlanArguments({
      action: 'create', title: 'Plan', steps: [{ title: 'Step', connection_id: CONNECTION }],
    }), /unsupported step property/)
  })

  it('requires enabled state whose live local bond matches the selected connection', () => {
    const paths = []
    const good = readPlanState(CONNECTION, {
      readState: (file) => {
        paths.push(file)
        return { ...state, bond_verified: undefined }
      },
      readBond: (file) => {
        paths.push(file)
        return { status: 'live', connection_id: CONNECTION, local_id: state.local_id }
      },
    })
    assert.equal(good.bond_verified, true)
    assert.equal(paths.length, 2)

    for (const over of [
      { enabled: false },
      { local_id: null },
    ]) {
      assert.equal(readPlanState(CONNECTION, {
        readState: () => ({ ...state, ...over }),
        readBond: () => ({ status: 'live', connection_id: CONNECTION }),
      }), null)
    }
    assert.equal(readPlanState(CONNECTION, {
      readState: () => state,
      readBond: () => ({ status: 'live', connection_id: PLAN, local_id: state.local_id }),
    }), null)
    assert.equal(readPlanState(CONNECTION, {
      readState: () => state,
      readBond: () => ({ status: 'stopped', connection_id: CONNECTION, local_id: state.local_id }),
    }), null)
  })

  it('leaves list/get read-only and sends exact allowed arguments with the hidden header', async () => {
    assert.equal(validateManagePlanArguments({ action: 'list' }), null)
    assert.equal(validateManagePlanArguments({ action: 'get', plan_id: PLAN }), null)
    const calls = []
    const result = await callManagePlan({ action: 'get', plan_id: PLAN }, {
      state,
      call: async (request) => { calls.push(request); return { plan: { id: PLAN, revision: 7 } } },
    })
    assert.equal(result.plan.revision, 7)
    assert.equal(calls[0].name, 'manage_plan')
    assert.equal(calls[0].connectionCapability, 'dvsc_secret')
    assert.deepEqual(calls[0].arguments, { action: 'get', plan_id: PLAN })
  })

  it('refuses disabled, mismatched-bond, detached, and pre-capability use', async () => {
    await assert.rejects(callManagePlan({ action: 'list' }, { state: { ...state, enabled: false } }), /enabled connection/)
    await assert.rejects(callManagePlan({ action: 'list' }, { state: { ...state, bond_verified: false } }), /matching live conversation bond/)
    await assert.rejects(callManagePlan({ action: 'list' }, { state: { ...state, session_id: null } }), /attached/)
    await assert.rejects(callManagePlan({ action: 'list' }, {
      state: { ...state, connection_capability: undefined, connection_capability_version: undefined },
    }), /capability/)
  })

  it('fails closed on a server-rejected stale capability without retry or fallback', async () => {
    let calls = 0
    await assert.rejects(callManagePlan({ action: 'list' }, {
      state,
      call: async () => {
        calls++
        throw new Error('connection capability is invalid or stale')
      },
    }), /invalid or stale/)
    assert.equal(calls, 1)
  })
})
