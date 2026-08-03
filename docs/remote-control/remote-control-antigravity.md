# Remote control — Antigravity (LLM primer)

**Family:** local-poller.  
**Read first:** `docs/remote-control/remote-control-overview.md`.  
**Plugin repo:** `DevSpec-Antigravity-Plugin`

## How a message reaches Antigravity

Same spine as Claude / Cursor / Grok:

1. Owner dispatch → `poll_connection` → connection inbox.
2. Wait (or host-equivalent) wakes the model with owner command text.
3. Model acts; when attached, model `post_session_message({ connection_id })`.
4. Hooks keep busy/heartbeat honest — they do not own the product reply.

Antigravity is **not** OpenCode-native inject and **not** the Codex app-server bridge. Prefer the local-poller mental model when debugging.

## Host specifics

| Topic | Antigravity |
|---|---|
| Invoke remote | Plugin remote command / skill (see repo docs) |
| Bond id | Host conversation / session env — never invent an id that won’t survive the next turn |
| Agent name | `Antigravity` via `agent-identity` (no silent fallback to another host’s name) |
| Scripts | May share Claude spine files; check this plugin’s `owns` / sync list before overwriting |

## What not to change lightly

- Syncing Claude defaults that assume Monitor+`--stream` if Antigravity’s wake path is one-shot (or vice versa).
- Copying OpenCode `promptAsync` inject “for elegance.”
- Hardcoding MCP URLs or agent display names.

## Failure modes

- Live connection with no armed listener.
- Cross-host script sync wiping Antigravity-owned auth or state helpers.
- Mis-labelled agent name in the Agents UI.

## Key files

- `DevSpec-Antigravity-Plugin` hooks/scripts (poll, wait, state, identity)
- Shared contract docs in DevSpecV2: `REMOTE-CONTROL-DELIVERY-CONTRACT.md`, `REMOTE-CONTROL-ACTIVITY-CONFORMANCE.md`
