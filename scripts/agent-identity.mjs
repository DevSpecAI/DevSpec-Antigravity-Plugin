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
