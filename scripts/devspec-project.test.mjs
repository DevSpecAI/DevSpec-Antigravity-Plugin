import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import {
  inheritConversationProject,
  readConversationProject,
  saveConversationProject,
} from './conversation-project.mjs'
import {
  manageProjectDefault,
  prepareFreshConversation,
  resolveActiveConversationProject,
} from './devspec-project.mjs'
import { writeStateFile } from './remote-control-state.mjs'

const A = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Website',
  organization: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Agency' },
}
const B = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Website',
  organization: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Client' },
}
const ENDPOINT = 'https://fixture.invalid/api/mcp'

describe('devspec-project.mjs — status, prepare, remember, forget, and owner_pid resolution', () => {
  let home
  let cwd

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-project-test-'))
    cwd = path.join(home, 'repo')
    fs.mkdirSync(cwd, { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('requires a matching preview before remembering or forgetting .devspec/project.json and preserves conversation selection', () => {
    const state = saveConversationProject('local-conv-1', ENDPOINT, B, 'explicit', { home })
    const statusBefore = manageProjectDefault('status', { cwd, state, home })
    assert.equal(statusBefore.ok, true)
    assert.equal(statusBefore.conversation_project.project.id, B.id)
    assert.equal(statusBefore.folder_default, null)

    const preview = manageProjectDefault('remember', { cwd, state, home })
    assert.equal(preview.confirmation_required, true)
    assert.equal(fs.existsSync(preview.path), false)

    const saved = manageProjectDefault('remember', {
      cwd,
      state,
      home,
      confirm: true,
      expected: preview.expected,
    })
    assert.equal(saved.ok, true)
    assert.deepEqual(JSON.parse(fs.readFileSync(preview.path, 'utf8')), { project_id: B.id })

    const forgetPreview = manageProjectDefault('forget', { cwd, state, home })
    assert.equal(forgetPreview.confirmation_required, true)

    // Mutate file behind preview's back -> must require new confirmation
    fs.writeFileSync(preview.path, JSON.stringify({ project_id: A.id }))
    const staleConfirm = manageProjectDefault('forget', {
      cwd,
      state,
      home,
      confirm: true,
      expected: forgetPreview.expected,
    })
    assert.equal(staleConfirm.confirmation_required, true)
    assert.equal(fs.existsSync(preview.path), true)

    const freshForgetPreview = manageProjectDefault('forget', { cwd, state, home })
    const forgotten = manageProjectDefault('forget', {
      cwd,
      state,
      home,
      confirm: true,
      expected: freshForgetPreview.expected,
    })
    assert.equal(forgotten.ok, true)
    assert.equal(fs.existsSync(preview.path), false)
    assert.equal(readConversationProject('local-conv-1', { endpoint: ENDPOINT, home }).project.id, B.id)
  })

  it('prepares a fresh conversation ID before auto-connect and requires choice on duplicate project names', async () => {
    const call = async (req) => {
      if (req.name === 'list_projects') return { projects: [A, B] }
      return {}
    }
    const resolveAuth = () => ({ ok: true, token: 'dvs_fixture', mcp_url: ENDPOINT })

    const ambiguous = await prepareFreshConversation('Website', {
      cwd,
      home,
      call,
      resolveAuth,
    })
    assert.equal(ambiguous.ok, false)
    assert.equal(ambiguous.code, 'project_choice_required')
    assert.equal(ambiguous.project_selection.candidates.length, 2)

    const prepared = await prepareFreshConversation(B.id, {
      cwd,
      home,
      call,
      resolveAuth,
    })
    assert.equal(prepared.ok, true)
    assert.match(prepared.launch_command, /^DEVSPEC_REMOTE_LOCAL_ID=[0-9a-f-]+ agy chat$/)
    assert.equal(readConversationProject(prepared.local_id, { endpoint: ENDPOINT, home }).project.id, B.id)
  })

  it('resolves conversation_project from the active window owner_pid connection when invoked without --local-id', () => {
    const connDir = path.join(home, '.devspec', 'remote-control', 'connections')
    const connId = '55bf32b1-5e67-4151-b478-cf3fa7a03acc'
    const convId = '64bbe87f-6468-4827-af09-b2bfc7fbf773'
    saveConversationProject(convId, ENDPOINT, A, 'conversation', { home })
    writeStateFile(
      connId,
      {
        enabled: true,
        connection_id: connId,
        agent_name: 'Antigravity',
        local_id: convId,
        owner_pid: process.pid,
        project_id: A.id,
        project_name: A.name,
        mcp_url: ENDPOINT,
      },
      connDir,
    )

    const resolved = resolveActiveConversationProject({
      ownerPid: process.pid,
      endpoint: ENDPOINT,
      home,
      env: {},
    })
    assert.equal(resolved.localId, convId)
    assert.equal(resolved.state?.project?.id, A.id)

    inheritConversationProject(convId, 'resumed-conv', ENDPOINT, { home })
    assert.equal(readConversationProject('resumed-conv', { endpoint: ENDPOINT, home }).project.id, A.id)
  })
})
