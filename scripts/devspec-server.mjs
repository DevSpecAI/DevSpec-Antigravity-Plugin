#!/usr/bin/env node
/**
 * Which DevSpec server this install of the plugin talks to, the Antigravity sign-in
 * app for it, and how Antigravity names it.
 *
 * ONE SETTING FOR ALL OF ANTIGRAVITY. The plugin bundles its own DevSpec connection in
 * its root `mcp_config.json`, running `scripts/mcp-bridge.mjs` with the target DevSpec
 * server address. Both DevSpec's tools (through `mcp-bridge.mjs`) and the background
 * features (remote control, commit tracking, the hooks) read that same file for the
 * server they sign in to, and share one browser login in `~/.devspec/antigravity/auth.json`
 * renewed under a cross-process lock. Nobody edits Antigravity's global settings file.
 *
 * Antigravity expands no variables in a bundled `mcp_config.json` (measured on agy
 * 1.5.3: a `${VAR}` server address is used literally), so an install is pointed at
 * another server by rewriting the plugin's own file:
 *
 *   node scripts/devspec-server.mjs                # show the server this install uses
 *   node scripts/devspec-server.mjs staging        # point this install at staging
 *   node scripts/devspec-server.mjs production     # back to the shipped file
 *   node scripts/devspec-server.mjs <https://…/api/mcp>   # any other DevSpec
 *
 * The sign-in app always follows the server (staging and production are different
 * Clerk instances), so the two are written together and never drift apart.
 *
 * HOW ANTIGRAVITY NAMES THE SERVER. A plugin's MCP servers are namespaced
 * `<plugin folder>_<server>`, so the bundled `devspec` server is `devspec_devspec`
 * in a standard install (measured on agy 1.5.3). Hooks recognize DevSpec's tools
 * under that name and under a plain `devspec` entry someone configured by hand.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isEntryPoint } from './entry-point.mjs'
import { discoverSignIn, normalizeResource, SignInError } from './oauth.mjs'

export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const SERVER_KEY = 'devspec'
export const BRIDGE_SCRIPT_ARG = '${PLUGIN_ROOT}/scripts/mcp-bridge.mjs'
export const PRODUCTION_MCP_URL = 'https://api.devspec.ai/api/mcp'
export const STAGING_MCP_URL = 'https://api.devspecstaging.com/api/mcp'

const PRODUCTION_ISSUER = 'https://clerk.devspec.ai'
const DEVELOPMENT_ISSUER = 'https://apt-hare-75.clerk.accounts.dev'

/**
 * Antigravity's own sign-in app on each DevSpec Clerk instance, by issuer. Keyed by
 * the authorization server rather than the DevSpec address, so a local DevSpec on
 * the Development instance signs in exactly like staging does. Antigravity's
 * built-in MCP sign-in and the background features both use it, so the approval page
 * names Antigravity and the Agent setup page lists Antigravity once.
 */
export const ANTIGRAVITY_CLIENT_IDS = Object.freeze({
  [PRODUCTION_ISSUER]: 'Gmbtf7QgaoSw7WJ0',
  [DEVELOPMENT_ISSUER]: 'TucS1MNZZlWpOUc7',
})

const KNOWN_SERVERS = Object.freeze({
  production: { mcpUrl: PRODUCTION_MCP_URL, issuer: PRODUCTION_ISSUER, app: 'https://app.devspec.ai' },
  staging: { mcpUrl: STAGING_MCP_URL, issuer: DEVELOPMENT_ISSUER, app: 'https://app.devspecstaging.com' },
})

const UPDATE_PLUGIN = 'agy plugin install https://github.com/DevSpecAI/DevSpec-Antigravity-Plugin'

export function mcpConfigPath(pluginRoot = PLUGIN_ROOT) {
  return path.join(pluginRoot, 'mcp_config.json')
}

function knownByUrl(url) {
  let key
  try {
    key = normalizeResource(url)
  } catch {
    return null
  }
  return Object.values(KNOWN_SERVERS).find((s) => s.mcpUrl === key) ?? null
}

/** The DevSpec entry of the plugin's own mcp_config.json, or null. */
export function readBundledEntry(pluginRoot = PLUGIN_ROOT) {
  try {
    const parsed = JSON.parse(fs.readFileSync(mcpConfigPath(pluginRoot), 'utf8'))
    const entry = parsed?.mcpServers?.[SERVER_KEY]
    return entry && typeof entry === 'object' ? entry : null
  } catch {
    return null
  }
}

/**
 * The DevSpec tool endpoint this install talks to, normalized: the server named in
 * the plugin's own mcp_config.json, or production when the file is missing.
 */
export function configuredServer({ pluginRoot = PLUGIN_ROOT } = {}) {
  const entry = readBundledEntry(pluginRoot)
  const argUrl = Array.isArray(entry?.args)
    ? entry.args.find((a) => typeof a === 'string' && /^https?:\/\//i.test(a.trim()))
    : null
  const url =
    typeof argUrl === 'string'
      ? argUrl
      : typeof entry?.url === 'string'
        ? entry.url
        : typeof entry?.serverUrl === 'string'
          ? entry.serverUrl
          : null
  if (url) {
    try {
      return normalizeResource(url)
    } catch {
      /* an unparseable address falls back to the shipped default */
    }
  }
  return PRODUCTION_MCP_URL
}

/** "production", "staging", or the address itself for any other DevSpec. */
export function serverLabel(url) {
  const known = knownByUrl(url)
  if (known === KNOWN_SERVERS.production) return 'production'
  if (known === KNOWN_SERVERS.staging) return 'staging'
  try {
    return new URL(url).origin
  } catch {
    return String(url)
  }
}

function appOrigin(url) {
  const known = knownByUrl(url)
  if (known) return known.app
  // A DevSpec run locally serves the app and the API from one origin.
  return new URL(url).origin
}

/** DevSpec's "copy this code" page for a sign-in on a machine the browser cannot reach. */
export function signInCodePageUrl(url) {
  return `${appOrigin(url)}/oauth-code`
}

/** Where a person disconnects or reconnects Antigravity in DevSpec. */
export function agentsSettingsUrl(url) {
  return `${appOrigin(url)}/settings/agents`
}

export function clientIdForIssuer(issuer) {
  const clientId = ANTIGRAVITY_CLIENT_IDS[String(issuer ?? '').replace(/\/+$/, '')]
  if (!clientId) {
    throw new SignInError(
      `This version of the DevSpec plugin for Antigravity does not know how to sign in to ${issuer}. Update it with \`${UPDATE_PLUGIN}\`.`,
    )
  }
  return clientId
}

/** The plugin's own mcp_config.json for a server: local stdio bridge and server address. */
export function bundledMcpConfig({ mcpUrl = PRODUCTION_MCP_URL } = {}) {
  return {
    mcpServers: {
      [SERVER_KEY]: {
        command: 'node',
        args: [BRIDGE_SCRIPT_ARG, mcpUrl],
      },
    },
  }
}

/** The sign-in app for a server: from the known servers, else discovered from the server itself. */
async function clientIdForServer(mcpUrl, fetchImpl) {
  const known = knownByUrl(mcpUrl)
  if (known) return clientIdForIssuer(known.issuer)
  const discovery = await discoverSignIn(mcpUrl, fetchImpl)
  return clientIdForIssuer(discovery.issuer)
}

/** Resolve `production`, `staging` or an https address to a tool endpoint. */
export function targetServer(target) {
  const named = KNOWN_SERVERS[String(target ?? '').trim().toLowerCase()]
  if (named) return named.mcpUrl
  let url
  try {
    url = new URL(String(target))
  } catch {
    throw new Error(`"${target}" is not a DevSpec server. Use production, staging, or the server's https address ending in /api/mcp.`)
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new Error('A DevSpec server address must start with https:// (http:// only for localhost).')
  }
  return normalizeResource(url.toString())
}

/**
 * Point this install at a server: rewrite the plugin's own mcp_config.json with the
 * server's address and the Antigravity sign-in app for it, together.
 */
export async function pointInstallAt(target, { pluginRoot = PLUGIN_ROOT, fetchImpl = fetch } = {}) {
  const mcpUrl = targetServer(target)
  const clientId = await clientIdForServer(mcpUrl, fetchImpl)
  const file = mcpConfigPath(pluginRoot)
  const text = `${JSON.stringify(bundledMcpConfig({ mcpUrl, clientId }), null, 2)}\n`
  let before = null
  try {
    before = fs.readFileSync(file, 'utf8')
  } catch {
    /* no file yet */
  }
  if (before !== text) {
    const temp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(temp, text)
    fs.renameSync(temp, file)
  }
  return { mcpUrl, clientId, changed: before !== text, file }
}

/**
 * Whether a server name Antigravity reports belongs to DevSpec: the plugin's bundled
 * server (`<plugin folder>_devspec`, e.g. `devspec_devspec`) or a hand-made `devspec`.
 */
export function isDevspecServerName(name) {
  return /^(?:[a-z0-9.-]+_)?devspec$/i.test(String(name ?? '').trim())
}

const DEVSPEC_TOOL_NAME = /^(?:mcp__(?:plugin_devspec_)?devspec__|mcp_(?:[a-z0-9.-]+_)?devspec_|devspec__)([a-z0-9_]+)$/

/**
 * The DevSpec tool a flattened tool name calls (`mcp_devspec_devspec_get_task`,
 * `mcp_devspec_get_task`, `mcp__devspec__get_task`), or null.
 */
export function devspecToolFromName(name) {
  const match = DEVSPEC_TOOL_NAME.exec(String(name ?? ''))
  return match ? match[1] : null
}

function isGitCheckout(pluginRoot) {
  try {
    return fs.existsSync(path.join(pluginRoot, '.git'))
  } catch {
    return false
  }
}

async function main() {
  const [target] = process.argv.slice(2)
  if (target === '--help' || target === '-h') {
    process.stdout.write(
      'Usage: node scripts/devspec-server.mjs [production | staging | <https://…/api/mcp>]\n' +
        'With no argument, shows which DevSpec server this install of the plugin connects Antigravity to.\n',
    )
    return 0
  }
  if (!target) {
    const url = configuredServer()
    process.stdout.write(`This install connects Antigravity to DevSpec ${serverLabel(url)} (${url}).\n`)
    return 0
  }
  try {
    const result = await pointInstallAt(target)
    const label = serverLabel(result.mcpUrl)
    const lines = [
      result.changed
        ? `This install now connects Antigravity to DevSpec ${label} (${result.mcpUrl}), signing in as Antigravity.`
        : `This install already connects Antigravity to DevSpec ${label} (${result.mcpUrl}).`,
      'Restart agy to use it. Run /devspec-login if you have not signed in to that server yet.',
    ]
    if (result.changed && isGitCheckout(PLUGIN_ROOT) && label !== 'production') {
      lines.push(
        'This install is a git checkout, so mcp_config.json now differs from the shipped file. Before pulling an update, run `node scripts/devspec-server.mjs production`; switch back after.',
      )
    }
    process.stdout.write(`${lines.join('\n')}\n`)
    return 0
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
}

if (isEntryPoint(import.meta.url)) {
  main().then((code) => process.exit(code))
}
