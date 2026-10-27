/**
 * Single source of truth for THIS plugin's agent identity.
 *
 * The agent name is a fixed property of the plugin — not runtime state, not an
 * LLM-passed arg, not a copied fallback. Every script (poller, mirror-turn,
 * remote-control-state) imports AGENT_NAME and uses it as THE identity, so a
 * plugin can never mislabel itself (e.g. as "Grok Build") no matter what's in a
 * stale/foreign state file or whether `--agent` was passed. One line to set per
 * plugin; impossible to drift.
 */
export const AGENT_NAME = 'Antigravity'

/**
 * This plugin's id in the `x-devspec-plugin: <id>/<version>` header it sends on
 * every DevSpec MCP request (item 7a01644a; contract on DevSpec item 2295e089). It
 * is DevSpec's provider id for this host, the same token the server's provider enum
 * uses. The header is built in connection-version.mjs, beside the version.
 */
export const PLUGIN_ID = 'antigravity'
