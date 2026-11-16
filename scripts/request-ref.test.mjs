#!/usr/bin/env node
/**
 * What PreToolUse says about who asked, tool by tool (`stampRequest`).
 *
 * A write that takes `request_ref` carries the request and never the command
 * beside it: DevSpec reads the command first and refuses the write when that
 * command has closed, although the request beside it says who asked and answers
 * for its work after its command closes. The few tools that take the command and
 * no request still carry the command.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import {
  PROVENANCE_REF_TOOLS,
  REQUEST_REF_TOOLS,
  stampRequest,
  stampsCommand,
} from './request-ref.mjs'
import { appendRequestEvent } from './requests.mjs'

const CONN = '11111111-2222-4333-8444-555555555555'
const REQ = 'f1111111-1111-4111-8111-111111111111'
const PROV = 'c1111111-1111-4111-8111-111111111111'
const REMEMBERED = 'c9999999-9999-4999-8999-999999999999'
const NAMED = 'c7777777-7777-4777-8777-777777777777'
const CLAIM = 'e1111111-1111-4111-8111-111111111111'
const MSG = 'd1111111-1111-4111-8111-111111111111'
const USER = 'a1111111-1111-4111-8111-111111111111'
const TASK = '98788aaf-9ce0-4299-a91c-ef4507bd2df0'

/** The tools that take the command and no request. */
const COMMAND_ONLY = [
  'claim_work_item',
  'manage_directed_question',
  'preview_supersession',
  'report_request',
  'reserve_work_items',
]

function fixture({ command = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-agy-request-ref-'))
  const dir = path.join(home, '.devspec', 'remote-control', 'connections')
  fs.mkdirSync(dir, { recursive: true })
  if (command) {
    appendRequestEvent(
      CONN,
      { op: 'open', id: REQ, kind: 'command', message_id: MSG, provenance_ref: PROV, requested_by: USER },
      { dir }
    )
    appendRequestEvent(CONN, { op: 'current', ref: REQ }, { dir })
  }
  return { home, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) }
}

describe('who asked, as PreToolUse stamps it', () => {
  it('sends the request and never the command on every tool that takes the request', () => {
    const fx = fixture()
    try {
      for (const tool of REQUEST_REF_TOOLS) {
        const { args, deny } = stampRequest(tool, { task_id: TASK }, CONN, null, {
          home: fx.home,
          // The connection's remembered command is not a way back in.
          connectionState: { provenance_ref: REMEMBERED },
        })
        assert.equal(deny, undefined, tool)
        assert.equal(args.request_ref, REQ, `${tool} names its request`)
        assert.equal(Object.hasOwn(args, 'provenance_ref'), false, `${tool} carries no command`)
        assert.equal(args.connection_id, CONN, `${tool} names the connection that carries the request`)
      }
    } finally {
      fx.cleanup()
    }
  })

  it('sends neither when no request is known, even with a remembered command', () => {
    const fx = fixture({ command: false })
    try {
      for (const tool of ['create_task', 'update_task', 'record_memory', 'record_implementation']) {
        const { args, deny } = stampRequest(tool, { task_id: TASK }, CONN, null, {
          home: fx.home,
          connectionState: { provenance_ref: REMEMBERED },
        })
        assert.equal(deny, undefined, tool)
        assert.deepEqual(args, { task_id: TASK }, `${tool} is left for DevSpec to work out from the connection`)
      }
    } finally {
      fx.cleanup()
    }
  })

  it('passes through a command or a claim the agent names itself', () => {
    const fx = fixture()
    try {
      const named = stampRequest('update_task', { task_id: TASK, provenance_ref: NAMED }, CONN, null, {
        home: fx.home,
      })
      assert.equal(named.args.provenance_ref, NAMED)
      assert.equal(named.args.request_ref, REQ)

      const claimed = stampRequest('add_implementation_note', { task_id: TASK, work_claim_ref: CLAIM }, CONN, null, {
        home: fx.home,
      })
      assert.equal(claimed.args.work_claim_ref, CLAIM)
      assert.equal(Object.hasOwn(claimed.args, 'provenance_ref'), false)

      const namedOnCommandOnly = stampRequest('claim_work_item', { task_id: TASK, provenance_ref: NAMED }, CONN, null, {
        home: fx.home,
      })
      assert.equal(namedOnCommandOnly.args.provenance_ref, NAMED)
    } finally {
      fx.cleanup()
    }
  })

  it('still sends the command on the tools that take it and no request', () => {
    assert.deepEqual(
      [...PROVENANCE_REF_TOOLS].filter((tool) => stampsCommand(tool)).sort(),
      [...COMMAND_ONLY].sort(),
      'reserving, claiming, a directed question, a replacement preview and a request report'
    )
    const fx = fixture()
    try {
      for (const tool of COMMAND_ONLY.filter((name) => name !== 'report_request')) {
        const { args, deny } = stampRequest(tool, { task_id: TASK }, CONN, null, { home: fx.home })
        assert.equal(deny, undefined, tool)
        assert.equal(args.provenance_ref, PROV, `${tool} carries the command`)
        assert.equal(Object.hasOwn(args, 'request_ref'), false, `${tool} takes no request`)
      }
      // A request report is about the connection itself, so PreToolUse leaves it as
      // written: the listener sends it with the command it is opening a request for.
      const report = { kind: 'command', provenance_ref: PROV, message_id: MSG }
      assert.deepEqual(stampRequest('report_request', report, CONN, null, { home: fx.home }).args, report)
    } finally {
      fx.cleanup()
    }
  })

  it('falls back to the remembered command on a command-only tool when no request is known', () => {
    const fx = fixture({ command: false })
    try {
      const { args } = stampRequest('reserve_work_items', { task_ids: [TASK] }, CONN, null, {
        home: fx.home,
        connectionState: { provenance_ref: REMEMBERED },
      })
      assert.equal(args.provenance_ref, REMEMBERED)
    } finally {
      fx.cleanup()
    }
  })
})
