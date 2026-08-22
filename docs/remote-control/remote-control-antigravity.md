# Remote control — Antigravity (LLM primer)

**Family:** local-poller.  
**Read first:** `docs/remote-control/remote-control-overview.md`.  
**Plugin repo:** `DevSpec-Antigravity-Plugin`

## How a message reaches Antigravity

Work entry, tracking, claiming, and the high session-plan threshold use the MCP-served [`devspec://product/implementation-contract`](devspec://product/implementation-contract) as runtime authority; this primer covers Antigravity operations only.

Same transport shape as other local-poller hosts:

1. `poll_connection` negotiates ingress, delegated scope, and active-plan projection v1; strict canonical 1.3 reaches the connection inbox.
2. Wait wakes only for complete authorized commands. Typed room context and all active plans remain read-only awareness.
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
| Plans | Capability-backed `scripts/devspec-plan.mjs` is discovered on demand; no extra hot skill or broad allowlist |

## Host limitation

Antigravity exposes no verified blocking pre-tool hook. The plugin therefore cannot enforce the DevSpec mutation boundary immediately before a tool call: connecting alone is not a request to mutate DevSpec, and the user must explicitly request tracked work or another DevSpec write. The existing `UserPromptSubmit` hook remains prompt-mirror/activity transport; it does not inject the contract. For delegated remote commands, the monitor makes the server-owned project instruction model-visible; this is guidance at the host seam, not a blocking filesystem hook. The MCP-served contracts and live tool schemas remain authoritative when work is requested, including [`devspec://product/remote-ingress-contract`](devspec://product/remote-ingress-contract) for mutable remote-ingress policy.

## What not to change lightly

- Replacing Antigravity’s wake path with another host’s transport assumptions.
- Copying another plugin’s scripts or adding cross-repo synchronization.
- Copying OpenCode `promptAsync` injection without a verified Antigravity host capability.
- Hardcoding MCP URLs or agent display names.
- Treating projected cross-owner plans as executable, or adopting without explicit `plan_id` and revision.

## Failure modes

- Live connection with no armed listener.
- Cross-host copying wiping Antigravity-owned auth or state helpers.
- Mis-labelled agent name in the Agents UI.

## Key files

- `DevSpec-Antigravity-Plugin` scripts (poll, wait, state, identity)
- Tracked-work contract: `devspec://product/implementation-contract`
- Remote delivery/activity references in DevSpecV2: `REMOTE-CONTROL-DELIVERY-CONTRACT.md`, `REMOTE-CONTROL-ACTIVITY-CONFORMANCE.md`
