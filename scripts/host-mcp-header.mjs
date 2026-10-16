/**
 * Keep `x-devspec-plugin` on the DevSpec entry of Antigravity's own MCP config
 * (item 7a01644a; contract on DevSpec item 2295e089).
 *
 * The plugin's scripts send the header themselves (mcp-call.mjs). Antigravity's own
 * MCP client is the other half of "every MCP call": the model's `mcp_devspec_*` and
 * lazy `call_mcp_tool` calls go out with whatever headers the user's
 * `mcp_config.json` names for the `devspec` server, and that file is the person's,
 * written by `agy mcp add` or by hand. A plugin-bundled `mcp_config.json` cannot carry
 * it, because it would need the person's token and its server name would collide
 * with theirs.
 *
 * So SessionStart and the connect script write the one header into the user-level
 * entry, naming the running version, and move it on after an update. Nothing else in
 * the file changes: the token, other headers, other servers and the file's mode are
 * kept, a file that does not parse is left alone, and the write is atomic. Antigravity
 * reads the change the next time it loads its MCP config; until then its own calls
 * name the version it loaded.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PLUGIN_HEADER, pluginHeaderValue } from './connection-version.mjs'

/** The DevSpec entry names resolve-mcp-auth.mjs reads the token from. */
const DEVSPEC_ENTRY_KEYS = ['devspec', 'DevSpec', 'devspec-mcp']

/**
 * The user-level Antigravity MCP configs (the same two resolve-mcp-auth.mjs reads
 * first). Project-level `<cwd>/.gemini/...` copies are left alone: they live in
 * someone's repository, and rewriting them would leave a diff in it.
 */
export function hostMcpConfigFiles(home = os.homedir()) {
  return [
    path.join(home, '.gemini', 'config', 'mcp_config.json'),
    path.join(home, '.gemini', 'antigravity-cli', 'mcp_config.json'),
  ]
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Put `value` on every HTTP DevSpec entry in a parsed config, replacing any other
 * spelling of the header. Returns whether anything changed; mutates `config`.
 */
export function applyPluginHeader(config, value) {
  if (!value || !plainObject(config) || !plainObject(config.mcpServers)) return false
  let changed = false
  for (const key of DEVSPEC_ENTRY_KEYS) {
    const entry = config.mcpServers[key]
    if (!plainObject(entry)) continue
    // Only a remote entry sends HTTP headers; a stdio bridge has none to carry it.
    if (!(entry.url || entry.serverUrl || entry.server_url)) continue
    const headers = plainObject(entry.headers) ? entry.headers : {}
    const spellings = Object.keys(headers).filter((name) => name.toLowerCase() === PLUGIN_HEADER)
    if (spellings.length === 1 && spellings[0] === PLUGIN_HEADER && headers[PLUGIN_HEADER] === value) continue
    const next = {}
    for (const [name, headerValue] of Object.entries(headers)) {
      if (name.toLowerCase() !== PLUGIN_HEADER) next[name] = headerValue
    }
    next[PLUGIN_HEADER] = value
    entry.headers = next
    changed = true
  }
  return changed
}

function indentOf(raw) {
  const match = raw.match(/\n([ \t]+)\S/)
  return match ? match[1] : 2
}

function writeAtomic(file, text, mode) {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`)
  try {
    fs.writeFileSync(temp, text, { mode })
    fs.chmodSync(temp, mode)
    fs.renameSync(temp, file)
  } catch (error) {
    fs.rmSync(temp, { force: true })
    throw error
  }
}

/**
 * Bring the header on the user's DevSpec MCP entries to `value` (default: this
 * running version). Returns `{ value, updated: [files], unchanged: [files] }`;
 * never throws for a missing or unreadable file.
 */
export function ensureHostPluginHeader({
  home = os.homedir(),
  files = hostMcpConfigFiles(home),
  value = pluginHeaderValue(),
} = {}) {
  const updated = []
  const unchanged = []
  if (!value) return { value: null, updated, unchanged }
  for (const file of files) {
    let raw
    let stat
    try {
      stat = fs.statSync(file)
      if (!stat.isFile()) continue
      raw = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    let config
    try {
      config = JSON.parse(raw)
    } catch {
      continue // never rewrite a file we cannot read faithfully
    }
    if (!applyPluginHeader(config, value)) {
      unchanged.push(file)
      continue
    }
    try {
      writeAtomic(file, JSON.stringify(config, null, indentOf(raw)) + (raw.endsWith('\n') ? '\n' : ''), stat.mode & 0o777)
      updated.push(file)
    } catch {
      /* non-fatal: the scripts still send the header themselves */
    }
  }
  return { value, updated, unchanged }
}
