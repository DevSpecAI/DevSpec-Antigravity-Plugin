import { readFileSync } from 'node:fs'

function loadedVersion() {
  try {
    const value = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    if (value.name === 'devspec-antigravity-plugin' && typeof value.version === 'string' && /^[A-Za-z0-9][A-Za-z0-9._+\/-]{0,63}$/.test(value.version)) return value.version
  } catch {}
  return undefined
}
export const LOADED_PLUGIN_VERSION = loadedVersion()
export function versionedConnectionArguments(name, args = {}) {
  if (name !== 'register_connection' && name !== 'attach_connection') return args
  const { plugin_version: _plugin, host_version: _host, ...rest } = args
  // This adapter has no reliable native host-version source. Missing is honest.
  return { ...rest, ...(LOADED_PLUGIN_VERSION ? { plugin_version: LOADED_PLUGIN_VERSION } : {}) }
}
