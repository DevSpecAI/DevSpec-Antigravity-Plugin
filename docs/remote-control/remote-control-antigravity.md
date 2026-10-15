# Remote control — Antigravity (LLM primer)

**Family:** local-poller.  
**Read first:** `docs/remote-control/remote-control-overview.md`.  
**Plugin repo:** `DevSpec-Antigravity-Plugin`

## How a message reaches Antigravity

Work entry, tracking, claiming, and the high session-plan threshold use the MCP-served [`devspec://product/implementation-contract`](devspec://product/implementation-contract) as runtime authority; this primer covers Antigravity operations only.

Same transport shape as other local-poller hosts:

1. `poll_connection` negotiates ingress, delegated scope, active-plan projection, interaction-event, and question-dismissal-event v1; strict canonical 1.3 and validated interaction/dismissal events reach the connection inbox while room messages, participants, plans, polls, and directed questions are materialized to `<connectionId>.transcript.jsonl`, `<connectionId>.room.json`, and `<connectionId>.cursor.json` (`scripts/room-transcript.mjs`).
2. `scripts/devspec-remote-wait.mjs` wakes only for complete authorized commands or validated directed-question answer/dismissal continuations, attaching compact `unread` counts, `room_state_changed` categories, and local `transcript` / `room_state` / `rules_file` paths (never carrying raw `room_context` arrays across turns).
3. Model acts; when `unread > 0` or `room_state_changed` is present, model reads unread room messages on demand with `scripts/room-unread.mjs read`. When attached, model posts via `post_session_message({ connection_id })` (or `scripts/devspec-question.mjs respond` when completing an answered/dismissed question continuation).
4. Hooks (`SessionStart`, `PreInvocation`, `PreToolUse`, `PostToolUse`, `PreCompact`, `Stop`) validate their JSON output against Antigravity's strict hook schemas (`scripts/hook-output.mjs`) and keep busy/heartbeat, subagent wait-hold, unread room indicators, and commit provenance honest — they do not own the product reply.

Antigravity is **not** OpenCode-native inject and **not** the Codex app-server bridge. Prefer the local-poller mental model when debugging.

## Host specifics

| Topic | Antigravity |
|---|---|
| Invoke remote | One-shot `scripts/devspec-remote-connect.mjs` + background `scripts/devspec-remote-wait.mjs` via `devspec-remote` / `devspec-remote-stop` skills |
| Plugin rules | `rules/AGENTS.md` loaded automatically by `agy` when the plugin is enabled; personal + project rules cached to `<connectionId>.rules.md` (`scripts/instruction-rules.mjs`) |
| Bond id | Host conversation / session env or native hook stdin (`conversation_id` / `session_id`) — never invent an id that won’t survive the next turn |
| Agent name | `Antigravity` via `agent-identity` (no silent fallback to another host’s name) |
| Local room state | `<connectionId>.transcript.jsonl`, `<connectionId>.room.json`, `<connectionId>.cursor.json` read on demand via `scripts/room-unread.mjs` |
| Scripts | Owned and tested in this plugin; never copied from or synchronized with another host plugin |
| Plans, Polls & Questions | Capability-backed `scripts/devspec-plan.mjs`, `scripts/devspec-poll.mjs`, and `scripts/devspec-question.mjs` are discovered on demand; no extra hot skill or broad allowlist |
| Status & Telemetry | `scripts/statusline.mjs` + `scripts/session-title.mjs` render status bar (codename, project, refreshed session title, active automation, claimed action item title + short code, model + context%) and record `<connectionId>.telemetry.json` attached to `heartbeat_connection` |

## Host limitation

Antigravity exposes no verified blocking pre-tool hook. The plugin therefore cannot enforce the DevSpec mutation boundary immediately before a tool call: connecting alone is not a request to mutate DevSpec, and the user must explicitly request tracked work or another DevSpec write. The `PreInvocation` (`UserPromptSubmit`) hook remains prompt-mirror/activity transport; it does not inject the contract. For delegated remote commands, the monitor makes the server-owned project instruction model-visible; this is guidance at the host seam, not a blocking filesystem hook. The MCP-served contracts and live tool schemas remain authoritative when work is requested, including [`devspec://product/remote-ingress-contract`](devspec://product/remote-ingress-contract) for mutable remote-ingress policy.

## What not to change lightly

- Replacing Antigravity’s wake path with another host’s transport assumptions.
- Re-introducing cross-turn `room_context` carry instead of materialized local `.transcript.jsonl` / `.room.json` files.
- Emitting unvalidated hook JSON fields that violate Antigravity's `additionalProperties: false` hook schema (`scripts/hook-output.mjs`).
- Copying another plugin’s scripts or adding cross-repo synchronization.
- Copying OpenCode `promptAsync` injection without a verified Antigravity host capability.
- Hardcoding MCP URLs or agent display names.
- Treating projected cross-owner plans as executable, or adopting without explicit `plan_id` and revision.

## Failure modes

- Live connection with no armed listener.
- Cross-host copying wiping Antigravity-owned auth or state helpers.
- Mis-labelled agent name in the Agents UI.

## Key files

- `DevSpec-Antigravity-Plugin` scripts (`devspec-remote-connect.mjs`, `devspec-remote-poll.mjs`, `devspec-remote-wait.mjs`, `remote-control-state.mjs`, `room-transcript.mjs`, `room-unread.mjs`, `instruction-rules.mjs`, `hook-output.mjs`, `session-title.mjs`, `statusline.mjs`, `commit-provenance.mjs`, `devspec-plan.mjs`, `devspec-poll.mjs`, `devspec-question.mjs`) and `rules/AGENTS.md`
- Tracked-work contract: `devspec://product/implementation-contract`
- Remote delivery/activity references in DevSpecV2: `REMOTE-CONTROL-DELIVERY-CONTRACT.md`, `REMOTE-CONTROL-ACTIVITY-CONFORMANCE.md`
