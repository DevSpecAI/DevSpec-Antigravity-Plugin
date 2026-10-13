#!/usr/bin/env node
/**
 * Antigravity PreToolUse hook for DevSpec MCP tools (`mcp_devspec_*`).
 *
 * Stamping & launch-guard entry point (expanded in Parity Item 2).
 */

import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

export async function runDevspecToolInput(_raw = '') {
  return null
}

async function main() {
  const raw = readStdin()
  const out = await runDevspecToolInput(raw)
  if (out) {
    process.stdout.write(JSON.stringify(out) + '\n')
  }
  process.exit(0)
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) main()
