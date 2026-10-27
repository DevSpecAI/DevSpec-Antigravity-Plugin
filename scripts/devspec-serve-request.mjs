#!/usr/bin/env node
/**
 * CLI helper to select which request the current turn serves when multiple
 * people's requests (or terminal + room requests) are carried in one turn.
 *
 * Usage:
 *   node "./scripts/devspec-serve-request.mjs" [serve] --connection-id <uuid> \
 *     (--message-id <uuid> | --request-id <uuid> | --terminal | --none | --unstated)
 */

import fs from 'node:fs'
import {
  appendRequestEvent,
  describeCarried,
  readRequestState,
  serveCommand,
  serveMain,
  servableCarried,
  turnAmbiguity,
  undecidedTurnMessage,
} from './requests.mjs'
import { isEntryPoint } from './entry-point.mjs'

export {
  appendRequestEvent,
  describeCarried,
  readRequestState,
  serveCommand,
  serveMain,
  servableCarried,
  turnAmbiguity,
  undecidedTurnMessage,
}

const isMain = isEntryPoint(import.meta.url)
if (isMain) {
  const result = serveMain(process.argv.slice(2))
  process.stdout.write(`${JSON.stringify(result)}\n`)
  process.exit(result.ok ? 0 : 1)
}
