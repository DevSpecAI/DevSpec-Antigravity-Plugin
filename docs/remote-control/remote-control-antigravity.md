# Remote control — Antigravity (LLM primer)

**Family:** local-poller.  
**Read first:** `docs/remote-control/remote-control-overview.md`.  
**Plugin repo:** `DevSpec-Antigravity-Plugin`

## How a message reaches Antigravity

Tracked work uses the MCP-served [`devspec://product/implementation-contract`](devspec://product/implementation-contract) as its runtime authority; this primer covers remote transport only.

Same transport shape as other local-poller hosts:

1. Authorized owner/delegated dispatch → scope-aware `poll_connection` → connection inbox, preserving the root `project_scope`.
2. Wait wakes the model with the command plus delegated-only server instruction; owner commands receive no project instruction.
3. Model acts; when attached, model `post_session_message({ connection_id })`.
4. Hooks keep busy/heartbeat honest — they do not own the product reply.

Antigravity is **not** OpenCode-native inject and **not** the Codex app-server bridge. Prefer the local-poller mental model when debugging.

## Host specifics

| Topic | Antigravity |
|---|---|
| Invoke remote | Plugin remote command / skill (see repo docs) |
| Bond id | Host conversation / session env — never invent an id that won’t survive the next turn |
| Agent name | `Antigravity` via `agent-identity` (no silent fallback to another host’s name) |
| Scripts | Owned and tested in this plugin; never copied from or synchronized with another host plugin |

## Host limitation

Antigravity exposes no verified blocking pre-tool hook. The plugin therefore cannot enforce the DevSpec mutation boundary immediately before a tool call: connecting alone is not a request to mutate DevSpec, and the user must explicitly request tracked work or another DevSpec write. The existing `UserPromptSubmit` hook remains prompt-mirror/activity transport; it does not inject the contract. For delegated remote commands, the monitor makes the server-owned project instruction model-visible; this is guidance at the host seam, not a blocking filesystem hook. The MCP-served contracts and live tool schemas remain authoritative when work is requested, including [`devspec://product/remote-ingress-contract`](devspec://product/remote-ingress-contract) for mutable remote-ingress policy.

## What not to change lightly

- Replacing Antigravity’s wake path with another host’s transport assumptions.
- Copying another plugin’s scripts or adding cross-repo synchronization.
- Copying OpenCode `promptAsync` injection without a verified Antigravity host capability.
- Hardcoding MCP URLs or agent display names.

## Failure modes

- Live connection with no armed listener.
- Cross-host copying wiping Antigravity-owned auth or state helpers.
- Mis-labelled agent name in the Agents UI.

## Key files

- `DevSpec-Antigravity-Plugin` scripts (poll, wait, state, identity)
- Tracked-work contract: `devspec://product/implementation-contract`
- Remote delivery/activity references in DevSpecV2: `REMOTE-CONTROL-DELIVERY-CONTRACT.md`, `REMOTE-CONTROL-ACTIVITY-CONFORMANCE.md`
