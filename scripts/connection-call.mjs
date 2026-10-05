#!/usr/bin/env node
// Antigravity has no verified input-rewriting hook. Its Connect and Stop skills use
// this narrow mechanical lifecycle caller instead of asking the model to report a
// version, so its model calls no connection plumbing itself: DevSpec lists only model
// tools to a host that declares none.
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { hostname } from 'node:os'
import { AGENT_NAME } from './agent-identity.mjs'
import { resolveDevspecMcpAuth } from './resolve-mcp-auth.mjs'
import { mcpToolsCall } from './mcp-call.mjs'
import { versionedConnectionArguments } from './connection-version.mjs'

const LIFECYCLE_CALLS = ['register_connection', 'attach_connection', 'heartbeat_connection', 'detach_connection']
const fields = new Map([['--project-id', 'project_id'], ['--local-id', 'local_id'], ['--connection-id', 'connection_id'], ['--session', 'session_id'], ['--cwd', 'cwd'], ['--name', 'name'], ['--git-remote', 'git_remote'], ['--pinned-project-id', 'pinned_project_id'], ['--status', 'status'], ['--end-reason', 'end_reason']])
export function parseConnectionCall(argv) {
  const [name, ...rest] = argv
  if (!LIFECYCLE_CALLS.includes(name)) throw new Error(`Choose one of ${LIFECYCLE_CALLS.join(', ')}`)
  const args = {}
  for (let i = 0; i < rest.length; i += 2) {
    const field = fields.get(rest[i])
    if (!field || typeof rest[i + 1] !== 'string' || rest[i + 1].startsWith('--')) throw new Error('Invalid connection option or missing value')
    args[field] = rest[i + 1]
  }
  if (name === 'register_connection' && !args.local_id) throw new Error('Registration needs --local-id')
  if (name === 'attach_connection' && (!args.connection_id || !args.session_id)) throw new Error('Attachment needs --connection-id and --session')
  if (name === 'heartbeat_connection' && (!args.connection_id || !args.status)) throw new Error('A heartbeat needs --connection-id and --status')
  if (name === 'detach_connection' && !args.connection_id) throw new Error('Detaching needs --connection-id')
  return { name, args }
}

export function publicConnectionResult(value, token = '') {
  if (typeof value === 'string') return (token ? value.split(token).join('[REDACTED]') : value).replace(/dvsc_[A-Za-z0-9_-]+/g, '[REDACTED_CONNECTION_CAPABILITY]')
  if (Array.isArray(value)) return value.map(item => publicConnectionResult(item, token))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).filter(([key]) => !['_meta', 'metadata', 'connection_capability', 'connectionCapability'].includes(key)).map(([key, item]) => [key, publicConnectionResult(item, token)]))
}

export async function runConnectionCall(name, args, { resolveAuth = resolveDevspecMcpAuth, call = mcpToolsCall } = {}) {
  if (!LIFECYCLE_CALLS.includes(name)) throw new Error('Unsupported lifecycle call')
  const cwd = args.cwd || process.cwd()
  let auth
  try { auth = resolveAuth(cwd) } catch { throw new Error('DevSpec authentication is unavailable; use the existing connection setup') }
  if (!auth?.ok || !auth.token || !auth.mcp_url) throw new Error('DevSpec authentication is unavailable; use the existing connection setup')
  try {
    const result = await call({ mcpUrl: auth.mcp_url, token: auth.token, name,
      arguments: versionedConnectionArguments(name, { ...args, ...(name === 'register_connection' ? { agent_name: AGENT_NAME, machine_hostname: hostname(), cwd } : {}) }),
      timeoutMs: 15000,
    })
    return publicConnectionResult(result, auth.token)
  } catch (error) { throw new Error(publicConnectionResult(error instanceof Error ? error.message : String(error), auth.token)) }
}

let main = false
try { main = !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)) } catch {}
if (main) {
  try {
    const { name, args } = parseConnectionCall(process.argv.slice(2))
    process.stdout.write(JSON.stringify(await runConnectionCall(name, args)) + '\n')
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : 'Connection call failed') + '\n')
    process.exitCode = 1
  }
}
