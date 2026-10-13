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
import { fileURLToPath } from 'node:url'
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

let isMain = false
try {
  isMain = Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
} catch {
  /* imported */
}
if (isMain) {
  const result = serveMain(process.argv.slice(2))
  process.stdout.write(`${JSON.stringify(result)}\n`)
  process.exit(result.ok ? 0 : 1)
}
