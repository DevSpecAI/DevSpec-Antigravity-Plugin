import { readFileSync } from 'node:fs'
import { PLUGIN_ID } from './agent-identity.mjs'

function loadedVersion() {
  try {
    const value = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    if (value.name === 'devspec-antigravity-plugin' && typeof value.version === 'string' && /^[A-Za-z0-9][A-Za-z0-9._+\/-]{0,63}$/.test(value.version)) return value.version
  } catch {}
  return undefined
}
export const LOADED_PLUGIN_VERSION = loadedVersion()

/**
 * DevSpec tells plugins apart by `x-devspec-plugin: <id>/<version>` on every MCP
 * request (ADR "Protecting intent" §14; contract on DevSpec item 2295e089). It names
 * the plugin and unlocks nothing: any agent can read and record its work, and the
 * header drives the no-plugin notice, agent health and "update your plugin".
 *
 * The version is this artifact's own package.json, read once at load like
 * plugin_version below, so the header always names the release that is running
 * (item 7a01644a). An unreadable version sends no header rather than a malformed one,
 * and a version holding `/` would break the one `<id>/<version>` split, so it sends
 * none either.
 */
export const PLUGIN_HEADER = 'x-devspec-plugin'
export function pluginHeaderValue(version = LOADED_PLUGIN_VERSION) {
  if (typeof version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(version)) return undefined
  return `${PLUGIN_ID}/${version}`
}
export function pluginHeaders(version = LOADED_PLUGIN_VERSION) {
  const value = pluginHeaderValue(version)
  return value ? { [PLUGIN_HEADER]: value } : {}
}
export function versionedConnectionArguments(name, args = {}) {
  if (name !== 'register_connection' && name !== 'attach_connection') return args
  const { plugin_version: _plugin, host_version: _host, ...rest } = args
  // This adapter has no reliable native host-version source. Missing is honest.
  return { ...rest, ...(LOADED_PLUGIN_VERSION ? { plugin_version: LOADED_PLUGIN_VERSION } : {}) }
}
