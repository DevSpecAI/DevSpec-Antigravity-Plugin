#!/usr/bin/env node
/**
 * Check a folder pin the moment a tool writes one (item fa9b809b).
 *
 * The pin is `.devspec/project.json` containing `{"project_id": "<uuid>"}`, and every
 * reader looks for exactly that key. If the file on disk is not a pin every reader
 * accepts, the model is told what to write instead, with the project id it used when
 * one can be found. A valid pin, or any failure to look, is silence.
 */

import fs from 'node:fs'
import path from 'node:path'
import { gitRoot } from './devspec-scope.mjs'
import { isEntryPoint } from './entry-point.mjs'

const PIN_RELATIVE = path.join('.devspec', 'project.json')
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

/** The pin files this tool call could have written. */
export function candidatePins(input, { root = gitRoot } = {}) {
  const rawTool = String(input?.tool_name || input?.toolName || input?.toolCall?.name || '')
  const tool = rawTool.replace(/^default_api:/, '')
  const toolInput = input?.tool_input ?? input?.toolInput ?? input?.toolCall?.args ?? {}
  const ws = Array.isArray(input?.workspacePaths)
    ? input.workspacePaths[0]
    : Array.isArray(input?.workspace_paths)
      ? input.workspace_paths[0]
      : null
  const cwd =
    typeof input?.cwd === 'string' && input.cwd
      ? input.cwd
      : typeof ws === 'string' && ws
        ? ws
        : typeof toolInput?.Cwd === 'string' && toolInput.Cwd
          ? toolInput.Cwd
          : null
  if (tool === 'Bash' || tool === 'run_command') {
    const cmd = typeof toolInput.command === 'string' ? toolInput.command : toolInput.CommandLine
    if (!cwd || typeof cmd !== 'string' || !cmd.includes(PIN_RELATIVE)) return []
    const repo = root(cwd)
    return [...new Set([path.join(cwd, PIN_RELATIVE), ...(repo ? [path.join(repo, PIN_RELATIVE)] : [])])]
  }
  const file =
    typeof toolInput.file_path === 'string'
      ? toolInput.file_path
      : typeof toolInput.TargetFile === 'string'
        ? toolInput.TargetFile
        : typeof toolInput.path === 'string'
          ? toolInput.path
          : null
  if (!file) return []
  const resolved = path.resolve(cwd ?? process.cwd(), file)
  return resolved.endsWith(path.sep + PIN_RELATIVE) ? [resolved] : []
}

/**
 * What is wrong with this pin text, or null when every reader accepts it. The rule is
 * the readers' own (`readPin` in devspec-scope.mjs): a JSON object whose `project_id`
 * is a non-empty string. Other keys are reported too, because the file is only safe to
 * commit while it holds nothing but the id (ADR dd0c1cff D10) — except the optional,
 * non-authoritative `project_name` Pi's writer may add (item 597c5d49).
 */
const ALLOWED_KEYS = new Set(['project_id', 'project_name'])

export function pinProblem(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return 'it is not valid JSON'
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'it is not a JSON object'
  const id = typeof parsed.project_id === 'string' ? parsed.project_id.trim() : ''
  if (!id) return 'the project id must be under the key "project_id"'
  const extra = Object.keys(parsed).filter((key) => !ALLOWED_KEYS.has(key))
  if (extra.length) return `it may hold only "project_id" (remove ${extra.map((k) => `"${k}"`).join(', ')})`
  return null
}

export function correctionText(file, problem, text) {
  const id = UUID.exec(text ?? '')?.[0]
  const shape = `{"project_id": "${id ?? '<the project id>'}"}`
  return (
    `DevSpec cannot use the pin you just wrote at ${file}: ${problem}. ` +
    `Rewrite the file so it contains exactly ${shape} and nothing else. ` +
    'Until then this folder is not linked to its DevSpec project.'
  )
}

export function checkPinAfterTool(input, deps = {}) {
  const read = deps.readFile ?? ((file) => fs.readFileSync(file, 'utf8'))
  const messages = []
  for (const file of candidatePins(input, deps)) {
    let text
    try {
      text = read(file)
    } catch {
      continue // not written after all, or unreadable: nothing to say
    }
    const problem = pinProblem(text)
    if (problem) messages.push(correctionText(file, problem, text))
  }
  if (!messages.length) return null
  return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: messages.join(' ') } }
}

async function main() {
  let input = {}
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}')
  } catch {
    return
  }
  const out = checkPinAfterTool(input)
  if (out) process.stdout.write(JSON.stringify(out) + '\n')
}

const isMain = isEntryPoint(import.meta.url)

if (isMain) {
  main().catch(() => {})
}
