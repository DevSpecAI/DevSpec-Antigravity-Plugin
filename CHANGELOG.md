# Changelog

## 0.15.8

### Window-open standby auto-connect (`agy-window:<owner_pid>`), `SessionStart` capability capture & 3-line instruction pointer, `/devspec-project` skill, and Pi-style live mid-turn trail streaming

- **Window-open standby auto-connect and in-place conversation `local_id` upgrade (`scripts/launch-guard.mjs`, `scripts/remote-control-state.mjs`, `scripts/session-start.mjs`, `scripts/devspec-remote-connect.mjs`):** `statusLine` now auto-connects at window open even before a conversation `session_id` exists by synthesizing a deterministic window standby bond `agy-window:<owner_pid>`. When the first conversation hook (`SessionStart`, `PreInvocation`) or `/devspec-remote` runs in that window with a real conversation ID, `findStandbyWindowStateForPid`, `upgradeStandbyStateLocalId`, and `resolveLocalAction` upgrade the existing connection in place without minting a second connection row.
- **`SessionStart` `connection_capability` capture via `onResultMeta` and compact 3-line instruction pointer (`scripts/session-start.mjs`, `scripts/instruction-tiers.mjs`, `scripts/devspec-remote-connect.mjs`):** `autoConnectAtStartup` in `scripts/session-start.mjs` now captures `_meta.devspec.connection_capability` via `onResultMeta` and persists `connection_capability` to `<connectionId>.json` so `/devspec-remote` reuses the startup connection directly. `formatTiersForStartup` now emits the compact 3-line instruction-tier pointer to `~/.devspec/remote-control/connections/.tiers-<hash>.txt` instead of injecting ~23 KB of inline markdown on `SessionStart`.
- **`/devspec-project` skill and `scripts/devspec-project.mjs` parity (`scripts/devspec-project.mjs`, `skills/devspec-project/SKILL.md`, `scripts/conversation-project.mjs`):** Added `scripts/devspec-project.mjs` (`status`, `choose`, `remember`, `forget`) and `skills/devspec-project/SKILL.md` matching Claude Code, plus `inheritConversationProject` in `scripts/conversation-project.mjs` to carry a pre-conversation window project selection (`agy-window:<owner_pid>`) over to the real conversation ID on upgrade.
- **Pi-style mid-turn thinking and tool trail streaming (`phase: "trail"`) without command obfuscation (`scripts/mirror-turn.mjs`, `scripts/post-tool-dispatch.mjs`):** `extractAntigravityTrailFromTranscript` now produces `@devspec/core/messages/trail-events`-compliant `thinking` (`.text`), `tool` (`.name`, `.status`, `.args`, `.result`), `domain` (`.domain`, `.action`, `.name`, `.status`), and `subagent` (`.name`, `.status`, `.children`) events and `work_trail` markdown without command obfuscation (applying only secret token redaction). `PostToolUse` streams `phase: "trail"` mid-turn via `streamTurnTrailIfChanged`, and `Stop` finalizes any streamed trail cleanly (`complete_turn: true`) so turns never leave `"No response"` bubbles.

## 0.15.7

### Background listener `agentapi` wake delivery (`wake: ALREADY ARMED`) and unread-watermark deduplication

- **Zero-model-management `agentapi` wake delivery (`scripts/devspec-remote-listen.mjs`, `scripts/devspec-remote-wait.mjs`, `scripts/devspec-remote-connect.mjs`, `scripts/remote-control-state.mjs`):** `deliverWakeViaAgentApi` now invokes `ANTIGRAVITY_AGENTAPI_EXE` (`agy agentapi send-message <conversationId> <message>`) when present, falls back to `~/.gemini/antigravity-cli/bin/agentapi` or `agentapi`, and checks JSON stdout for an `error` field (since `agy agentapi` exits `0` even on error). `buildWakeDeliveryMessage` now embeds the full canonical wake JSON lines (`formatInboxEntryForStream` with `rearm: "already_armed"`), and `devspec-remote-connect.mjs` reports `wake: ALREADY ARMED (listener pid <pid>)` when the background listener and `agentapi` credentials (`ls_address` + `csrf_token`) are active so the model no longer spawns or re-arms `devspec-remote-wait.mjs` on every turn.
- **Unread-watermark deduplication for mirrored local terminal prompts and delivered command wakes (`scripts/room-unread.mjs`, `scripts/mirror-turn.mjs`, `scripts/devspec-remote-wait.mjs`):** Added `recordMirroredLocalPrompt` in `scripts/room-unread.mjs` and called it from `handleMirrorTurn` (`PreInvocation`) when mirroring a local terminal prompt to an attached session so `PostInvocation`, `PostToolUse`, and `prePostHold` do not self-nudge on the user's own terminal prompt. Updated `wakeNotice` to mark delivered command messages read in `<conn>.<session>.read.json` and return `null` when no other unread room messages exist, preventing redundant `room-unread.mjs read` calls on single-command wakes.

## 0.15.6

### Local terminal turn admission, request-chain attribution, symmetric session reply mirroring, and complete lazy MCP tool schemas

- **Local terminal turn admission and `typed_prompt` request-chain attribution (`scripts/local-turn.mjs`, `scripts/requests.mjs`, `scripts/mirror-turn.mjs`):** Added `scripts/local-turn.mjs` (`startLocalTurn`, `localTurnToComplete`, `attachmentFromPoll`, `localTurnScope`) and expanded `scripts/requests.mjs` (`promptArrival`, `commandRequestsInWake`, `requestForWake`, `recordDeliveredBatchRequests`, `absentLaunches`). On `PreInvocation` for a local terminal prompt, `handleMirrorTurn` now sets `op: 'current'` (`promptArrival`), admits the local turn via `report_pickup` (`local_turn: true, local_activity_version: 1`), and opens a server-backed `typed_prompt` request via `report_request` so `<connectionId>.requests.jsonl` carries an active `request_ref` and `PreToolUse` stamps `request_ref` onto knowledge/document mutations (`supersede_memory`, `update_memory`, `update_resource`, etc.) without failing `knowledge_approval_required`.
- **Background wake `op: 'current'` recording (`scripts/devspec-remote-wait.mjs`, `scripts/devspec-remote-listen.mjs`, `scripts/requests.mjs`):** `devspec-remote-wait.mjs` and `devspec-remote-listen.mjs` now call `recordDeliveredBatchRequests` when delivering a command or automation wake so `<connectionId>.requests.jsonl` records `op: 'current'` even when Antigravity wakes via background task completion without running `PreInvocation`.
- **Symmetric session reply mirroring and local-turn `post_session_message` stamping (`scripts/mirror-turn.mjs`, `scripts/devspec-tool-input.mjs`):** `Stop` in `scripts/mirror-turn.mjs` now posts the fallback assistant reply + work trail to the attached session not only on remote turns (`marker.remoteTurn`), but also on mirrored local terminal turns (`marker.localPromptMirrored || marker.localTurn || state.local_turn`) with `command_turn_unbound: true, local_turn: true, complete_turn: true`, and closes both the local turn (`report_complete`) and finished requests (`closeRequest`). `PreToolUse` (`scripts/devspec-tool-input.mjs`) strips any invalid `provenance_ref` on `post_session_message` and automatically stamps `command_turn_unbound: true, local_turn: true` on explicit session replies during local terminal turns.
- **Complete lazy MCP tool quick-reference, ~6 KB spill handling, and required plugin setup docs (`rules/AGENTS.md`, `skills/devspec-remote/SKILL.md`, `README.md`):** Expanded `rules/AGENTS.md` with complete parameter schemas for memory (`get_memory`, `search_memories`, `record_memory`, `supersede_memory`, `update_memory`), resource (`get_resource`, `search_resources`, `create_resource`, `update_resource`), action-item (`create_action_item`, `update_action_item`), discussion-point (`manage_discussion_point`), and project-grounding tools, top-level response shape notes, and accurate ~6 KB spill handling (`view_file` up to 46 KB vs `run_command` ~8 KB top-truncation), and documented in `README.md` why installing the plugin (`rules/AGENTS.md` + hooks) is required.

## 0.15.5

### Antigravity status line action item title and automation name resolution

- **Resolve action item titles, `work_claim_ref`, and automation names when `PostToolUse` omits `tool_response` (`scripts/commit-provenance.mjs`, `scripts/statusline.mjs`):** Antigravity's `PostToolUse` hook payload does not include `tool_response`, which previously caused `parseClaimResponse` to fall back to `title: null` (rendering only the 8-char item ID on the status line) and `parseAutomationClaimResponse` to return `null` (never writing `<digest>.automation.json`). Added `collectAntigravityStepTexts`, `resolveLocalItemDetails`, `resolveLocalAutomationDetails`, `backfillClaimedItemDetails`, and `backfillAutomationDetails` to resolve and backfill action item titles, `work_claim_ref`, and automation names from Antigravity's `.system_generated/steps/<N>/output.txt`, `transcript_full.jsonl` / `transcript.jsonl`, `.room.json` (`session_activity.items`), and `.inbox.jsonl` (`automation_run` dispatches), and kept active work/automation visible on the status line even when remote control is disconnected.

## 0.15.4

### Mechanical runtime model stamping on session posts and effort-suffix normalization

- **Normalize Antigravity statusLine model IDs (`scripts/statusline.mjs`):** `normalizeStatuslineTelemetryInput` and `parseTelemetryRecord` now strip redundant trailing effort suffixes such as `(High)`, `(Medium)`, `(Low)`, and `(Max)` from `model.id` while preserving `thinkingLevel`, recording `Gemini 4 Argon` rather than `Gemini 4 Argon (High)`.
- **Stamp live host telemetry model onto `post_session_message` (`scripts/devspec-tool-input.mjs`, `scripts/mirror-turn.mjs`):** `PreToolUse` on `post_session_message` answer/error calls (and the `Stop` fallback reply) now attaches `agent_stats` and overrides `model` (`{ providerID, modelID }`) from the connection's live telemetry so LLM-guessed model names (such as `gemini-3.1-pro-preview`) never override the host-reported runtime model (`Gemini 4 Argon`).

## 0.15.3

### Preserve Working state across mid-turn posts and long turns, and format system_notices in listen

- **Mid-turn `post_session_message` and `>10m` turn `Working` continuity (`scripts/post-tool-dispatch.mjs`, `scripts/devspec-remote-poll.mjs`):** Re-assert `.turn` after mid-turn `post_session_message` progress replies and keep long turns active via `lastToolAt`.
- **Sessionless `server_notice` formatting (`scripts/devspec-remote-listen.mjs`):** Format `canonical_system_notices` in `buildWakeDeliveryMessage` for `agentapi` wake delivery.

## 0.15.2

### Antigravity (`agy`) host latency and token-footprint optimizations

- **Direct `SessionStart` instruction-tier injection and single-round-trip startup connect (`scripts/instruction-tiers.mjs`, `scripts/session-start.mjs`):** `autoConnectAtStartup` now uses the resolved single/pinned MCP token directly for `register_connection` without a redundant `verify_agent_connection` pre-call, and `formatTiersForStartup` injects the full rendered 4-tier instructions directly in the `SessionStart` `systemMessage` (alongside the saved `.tiers-<hash>.txt` path for post-compaction recovery) so `/devspec-remote` does not require a separate `view_file` turn.
- **Fresh startup registration reuse on `/devspec-remote` (`scripts/devspec-remote-connect.mjs`):** Bare `/devspec-remote` now reuses a fresh (`<60s`) sessionless registration created by `SessionStart` for the same conversation/`owner_pid`, avoiding a duplicate `register_connection` HTTP round-trip.
- **Antigravity-safe `room-unread.mjs` pagination (`READER_PAGE_CHARS = 6000`), footer repetition, and `response_style` deduplication (`scripts/room-unread.mjs`):** Tuned the unread page budget to fit within Antigravity `run_command`'s ~7.5 KB stdout limit (which top-truncates long outputs), repeated `room_messages_footer` at the end of stdout when `remaining > 0`, and deduplicated identical `delivered_as_command.response_style` arrays across earlier commands in the same page.
- **Compact single-line array rows in `.room.json` (`scripts/devspec-remote-poll.mjs`):** Added `formatRoomStateJson` so array rows (`session_activity.items`, `session_activity.events`, `still_to_discuss.rows`) are formatted one-per-line (~240 lines instead of 1,680+ lines) while remaining 100% `JSON.parse`-identical, fitting inside a single Antigravity `view_file` call (800-line cap).
- **Lazy MCP tool quick-reference and spilled output guidance (`rules/AGENTS.md`, `skills/devspec-remote/SKILL.md`):** Added compact parameter signatures for core lazy DevSpec MCP tools (`post_session_message`, `get_action_item`, `get_action_items`, `get_action_item_siblings`, `search_action_items`, `reserve_work_items`, `claim_work_item`, `record_implementation`, `record_criterion_verdicts`) and guidance against multi-page `view_file` reads on spilled `output.txt` files.

## 0.15.1

### Canonical remote-ingress 1.6.0 wire validation, transcript store parity, and connection reuse

- **Canonical 1.6.0 ingress validator (`scripts/remote-ingress-v1.mjs`):** Aligned the 1.5.0/1.6.0 policy versions (`2026-09-18.1` / `2026-09-24.1`) and `room_context`, `session_activity`, `session_events`, `session_polls`, and `still_to_discuss` schemas with the server's `devspec://product/remote-ingress-contract` so live 1.6.0 poll responses validate and wake immediately.
- **Canonical room transcript and command-offer negotiation (`scripts/room-transcript.mjs`, `scripts/command-offer.mjs`):** Fixed `room_deletions_seen` wire shape (`null` or `{ through, total }`), `store.rows` transcript map, `.transcript.jsonl` sequence records (`seq`/`from`/`to`/`text` for `room-unread.mjs`), and singular `command_offer` parsing.
- **MCP `_meta.devspec.connection_capability` and window `owner_pid` connection reuse (`scripts/mcp-call.mjs`, `scripts/remote-control-state.mjs`, `scripts/devspec-remote-connect.mjs`):** Added `onResultMeta`, `readServerFailure`, `isRetryableHttpFailure`, and `McpToolRefusalError` to `scripts/mcp-call.mjs`, and updated `resolveLocalAction` and `devspec-remote-connect.mjs` to reuse the current window's `owner_pid` connection and `local_id` when invoked from a shell without `ANTIGRAVITY_CONVERSATION_ID`.

## 0.15.0

### Full Antigravity CLI (`agy`) parity with Claude Code and Pi

- **One-shot zero-token connect and cached instruction rules:** Added `scripts/devspec-remote-connect.mjs` and `scripts/instruction-rules.mjs` so `/antigravity-devspec-autopilot-extension:devspec-remote` completes preflight, project resolution, conversation bonding, `register_connection`, optional `create_session` / `attach_connection`, capability v1 rotation, instruction-tier caching (`<connectionId>.rules.md`), and poller startup in a single command before arming `scripts/devspec-remote-wait.mjs`.
- **Strict Antigravity hook JSON validation and payload normalization:** Added `scripts/hook-output.mjs` (`validateHookOutput`, `emitHookJson`, `normalizeToolHookPayload`) to validate all `SessionStart`, `UserPromptSubmit` (`PreInvocation`), `PreToolUse`, `PostToolUse`, `PreCompact`, and `Stop` hook outputs against Antigravity's strict schemas (`additionalProperties: false` on `hookSpecificOutput`) and normalize both native `call_mcp_tool` / `run_command` and standard MCP tool events.
- **Materialized local room transcript, room state, and on-demand unread reader:** Added `scripts/room-transcript.mjs` and updated `scripts/devspec-remote-poll.mjs`, `scripts/devspec-remote-wait.mjs`, and `scripts/room-unread.mjs` to materialize room messages and room state to `<connectionId>.transcript.jsonl`, `<connectionId>.room.json`, and `<connectionId>.cursor.json` with no cross-turn `room_context` carry, surfacing compact unread counts and `room_state_changed` indicators for on-demand `room-unread.mjs read`.
- **Live session-title refresh and richer status bar:** Added `scripts/session-title.mjs` (`UNTITLED_RETRY_MS = 60_000`) and updated `scripts/statusline.mjs` and `scripts/commit-provenance.mjs` so the status bar refreshes `"Untitled session"` titles automatically and displays active automation runs (`automation “<name>”`) and claimed action item titles (`working on “<title>” (<code>)`).
- **Bundled `rules/AGENTS.md` and `agy mcp add` / `~/.gemini/config/mcp_config.json` setup:** Added `rules/AGENTS.md` so Antigravity automatically loads DevSpec remote-control, local room-context, and implementation-contract rules when the plugin is enabled, and updated all setup/update documentation to use `~/.gemini/config/mcp_config.json` and `agy mcp add`.

## 0.14.0

### Antigravity CLI (`agy`) 3-step setup, verified token pinning, and auto-started remote listener

- **Verified token pinning (`~/.devspec/auth.json`) and placeholder filtering:** `scripts/resolve-mcp-auth.mjs` now validates `dvs_` tokens, ignores placeholder strings (`dvs_YOUR_...`) and unexpanded `${...}` templates, falls back to `https://devspec.ai/api/mcp` when no `serverUrl` is specified, and pins verified working tokens to `~/.devspec/auth.json` (`0600`) after `verify_agent_connection` so stale local project configs cannot shadow a working token.
- **Automatic `statusLine` setup and startup connection:** `scripts/session-start.mjs` now non-destructively configures `statusLine` in `~/.gemini/antigravity-cli/settings.json` when unset, automatically registers the `agy` session and starts the background poller when a valid token is present (`DEVSPEC_CONNECT_AT_STARTUP=0` to disable), and surfaces a deterministic remediation message (plus `DevSpec: not configured` in `scripts/statusline.mjs`) when no `dvs_` token is configured, governed by `devspec://product/implementation-contract`.
- **Streamlined `agy` CLI documentation and background wait guidance:** `README.md` and `skills/devspec-remote/SKILL.md` now focus exclusively on Antigravity CLI (`agy`) with a 3-step cross-platform install (`~/.gemini/config/plugins/antigravity-devspec-autopilot-extension`) and background `devspec-remote-wait.mjs` execution (`WaitMsBeforeAsync: 500`, `--pending` on re-arm).

## 0.13.0

### Antigravity parity with Claude Code and Pi plugins

- **SSE push channel and live trail streaming:** `scripts/devspec-remote-poll.mjs` now opens `scripts/remote-push-client.mjs` (`/api/mcp/remote-events`) for sub-second wake notifications with graceful fallback to held `poll_connection`, and streams live turn activity trails (`scripts/turn-trail.mjs`) while a turn is active.
- **Session lifecycle, compaction, and room awareness hooks:** Added `scripts/session-start-context.mjs`, `scripts/pre-compact.mjs`, `scripts/room-unread.mjs`, and `scripts/post-tool-dispatch.mjs` to surface remote session continuity, unread room messages, and background launch correlation (`scripts/requests.mjs`).
- **Commit provenance, observation, and session coordination bridges:** Added `scripts/commit-provenance.mjs`, `scripts/commit-observation.mjs`, `scripts/devspec-scope.mjs`, `scripts/pin-check.mjs`, `scripts/repo-link-nudge.mjs`, `scripts/statusline.mjs`, `scripts/devspec-poll.mjs` (`manage_poll`), `scripts/devspec-question.mjs` (`manage_directed_question`), `scripts/interaction-events.mjs`, and `scripts/question-dismissal-events.mjs`, governed by `devspec://product/implementation-contract`.

## 0.12.2

### DevSpec decides when work was unattended

DevSpec now works out for itself whether an agent's work was unattended, so the remote-control guidance no longer tells Antigravity to leave out a setting that no longer exists. Update the extension to pick this up.

## 0.12.1

### An @mention reaches a person

The remote-control skill now tells Antigravity that writing @ and a person's name in an answer in a DevSpec room notifies that person, if they are in the room or on the project. Update the plugin to load this version.

## 0.12.0

### DevSpec lists Antigravity's model tools only

DevSpec now shows a model only the DevSpec tools it should call. The connection plumbing (registering, polling, keep-alives, pickup and completion reports) no longer appears in Antigravity's tool list, and Antigravity's model no longer needs any of it: `/devspec-remote-stop` now marks the connection offline and detaches through `scripts/connection-call.mjs`, the same mechanical caller Connect already uses for registering and attaching. The stop skill's script paths now point at `scripts/`, where they actually are. The remote-control skill drops its in-chat keep-alive and poll fallback for a missing poller, which ships with the plugin. Your MCP config does not change. Update the plugin to load this version.

## 0.11.11

### Links to DevSpec's Agents settings page

DevSpec's Coding agents settings page is now called Agents, at `/settings/agents`. The README no longer gives directions like You → Coding agents: wherever it sends you to create or reveal your DevSpec token, or to check standalone launch targets, it links straight to [your Agents settings page](https://app.devspec.ai/settings/agents). Nothing about how the plugin behaves has changed.

## 0.11.10

- Remove the shared launcher payload and installation/pairing side effect from Connect. The mechanical Antigravity connection helper still owns normal authentication and registration.
- Explain that the standalone launcher is optional and independently installed.

## 0.11.8

Bundle launcher 0.3.1 to find npm-installed Pi from desktop services and avoid duplicate loopback error tabs. Update the plugin and run Connect to run its shared update check.

## 0.11.7

The mechanical Connect helper starts optional setup of a generated shared-launcher payload. This runs on first Connect, not an assumed plugin-activation hook, and does not alter credentials or connection responses. Clone/install the complete plugin including `launcher/`; copying only skills is insufficient. Carrying the installer does not add an Antigravity launch target.

## 0.11.6

The Connect skill now uses a narrow mechanical registration/attachment helper that reports the executing plugin version and keeps credentials/private capability metadata out of its output. Internal re-registration also reports the version. No unsupported pre-tool hook was invented; unavailable host versions stay unknown. The Connect skill's script paths now match this package's actual `scripts/` layout.

## 0.11.5

### Delivery evidence stays on action items, out of project memory

The knowledge-capture guidance your agent reads now draws one more line: what shipped, which commit and what passed belong on the action item, not in project memory — and a memory should hold what a future decision needs that the existing record doesn't already preserve. Shared project knowledge stays free of per-task status reports.

## 0.11.4

### DevSpec's renamed settings pages

The README now sends you to **You → Coding agents** → **Create your token** for your DevSpec token; the page used to be called You → Connections. The remote skill's "Account + project instructions" section is now "Personal + project instructions", and it no longer calls the owner's response style by its old name, Chat Response Style. Nothing about how the plugin behaves has changed.

## 0.11.3

### A test catches a DevSpec tool name the server no longer has

A new test reads DevSpec's live tool list from a devspecv2 checkout beside this repo and fails if anything in this plugin names a DevSpec tool the server does not have. A tool renamed or retired on the server is then caught here, before an agent is told to call it in someone's session. With no checkout beside it the test skips; `DEVSPEC_V2_ROOT` names one. Nothing about how the plugin behaves has changed.

## 0.11.2

### Knowledge: the closest match is read, not automatically replaced; open questions are on Review

- Before writing a memory the skill still searches and reads the closest match in full, but no longer tells the agent to supersede it. A similar record may be the same decision, a change to it, a different one, or a disagreement; the agent records, supersedes, links or asks the owner as the comparison warrants.
- The skill names where open questions about records live — the project's Review queue — and the tools to preview a ruling, link related records and read an item's history. Who may rule stays the served contract's decision.

## 0.11.1

### A proposed change is accepted on the Review page

When a write comes back `queued_for_review`, the skill now says a maintainer accepts it on the project's Review page, under Proposed changes. It used to send people to a "Review tab", which no longer exists.

## 0.11.0

### Authority is the served contract's, not this plugin's

The remote skill no longer says a write without a runner stamp carries "interactive
authority". Whether a memory, artifact or rule change commits, is queued as a proposal, or
is refused is decided by DevSpec and served at `devspec://product/implementation-contract`
→ `authority_contract`; the skill points there and keeps its own step: read each write's
`outcome`, and on `queued_for_review` relay the `proposal_id` and the reason, saying a
maintainer has to accept it before it applies.

## 0.10.0

### Playbooks are now Automations

DevSpec has renamed Playbooks to Automations. This plugin now uses the renamed tools
(`claim_automation_run`, `record_automation_run`, `get_automations` and the rest) and reads
the renamed fields in what the server sends it. It needs a DevSpec server that carries the
same rename; against an older server, automation runs are not picked up.

## 0.9.0

### Shared session plans without widening Antigravity's hot surface

- Work-entry, tracking, and plan-threshold authority remains at
  `devspec://product/implementation-contract`; routine investigation stays plan-free.
- Attached connections negotiate a hidden capability for an on-demand,
  schema-complete `manage_plan` bridge with revisioned atomic advance, resume,
  complete/abandon, and explicit authorized adoption mechanics. Already-live
  re-arms rotate first; stale/pre-capability state fails closed, and `--schema`
  emits exact discriminated per-action objects.
- Remote polling now requests ingress, delegated scope, and active-plan projection
  v1, strictly validates canonical 1.3 plan inventories, and retains strict 1.2
  compatibility. All-room plans are advisory read-awareness only.
- Tests cover routine no-plan discovery, plan mechanics, capability negotiation,
  reconnect revisions, orphan adoption inputs, cross-owner reads, and strict wire
  negotiation. The existing two-skill, host-native workflow remains bounded.

## 0.8.0

### MCP-served implementation contract is the runtime authority

- Current public docs and remote work instructions point to
  `devspec://product/implementation-contract` instead of restating mutable item
  lifecycle rules.
- The remote skill keeps only the required multi-item ordering: reserve once in
  requested order, then claim each successfully reserved item in that order.
- Antigravity's host limitation is explicit: there is no verified blocking
  pre-tool hook, so `UserPromptSubmit` remains prompt-mirror/activity transport
  and does not pretend to inject or enforce the contract before mutations.
- Contract-surface tests reject stale lifecycle prose and protect the existing
  mirror-turn hook plus reserve/claim ordering.

## 0.7.0

### Eight skills removed — devspec-remote and devspec-remote-stop remain

`devspec-work`, `-create`, `-commit`, `-link`, `-help`, `-done`, `-brainstorm`
and `-verify-connection` are deleted.

A skill must be a script, not a restatement. Connecting runs a deterministic
setup a model improvises badly and that can be tested; the others were a page of
prose each, telling a model to call one DevSpec MCP tool it could already see.

Nothing was lost: what they taught now lives in the MCP tool schemas server-side,
written once and reaching every host the moment it changes, instead of copied
into six repositories with no way to notice when one drifts.

Say it instead — *"Work on DevSpec action item 4f2a"*, *"Work these in order:
4f2a, 9c1b, 2e7d"*. DevSpec's copy buttons emit exactly those lines, so copying
and typing produce the same thing, and a sentence works in a host with no plugin
at all.

## 0.6.0 - 2026-08-17

### An agent reserves its work — nothing is dispatched to it any more

The server retired `get_assignment`, `acknowledge_assignment` and `resolve_assignment`, along with `get_next_work_item` (DevSpec item 1e455001). Nothing dispatches work to an agent, so there was nothing left for them to do: no batch to receive, no receipt to give, nothing to close.

One verb replaces them. **`reserve_work_items({ action_item_ids, connection_id })`** holds the ordered set you are about to work so no other agent takes one mid-run; then `claim_work_item` per item as you reach it. The batch closes itself when its last member is recorded, failed or released.

**`devspec-work` now reserves up front when handed several ids**, and **`skipped`** must be read and reported: an item another agent already holds comes back with a reason naming the holder rather than failing the call.

### Only the agent holding an item can release or fail it

`release_work_item` and `fail_work_item` had no ownership check at all, and `claim_work_item`'s compared USERS — which cannot tell two of your own agents apart, because a DevSpec token is account-wide. On 2026-08-16 a sibling connection released work another agent was actively on, leaving the item unclaimed while its reservation still said claimed.

All three now check the reservation against the `connection_id` you pass, server-side, so pass it. A stale hold is still always releasable with `force` and a reason — recorded as a takeover naming who did it.

## 0.5.0 - 2026-08-17

### `--unattended` is gone, and nothing replaced it

`devspec-work` took a flag that installed a mode for the whole run: never ask, never wait, auto-select the highest-priority match when a name was ambiguous. It read as a safety feature and was really a licence to guess.

Deleted: the flag, the `Mode:` line in the item header, every per-step "interactive mode / unattended mode" fork, and the two mode-specific contract resources — the served contract is now one document at `devspec://product/implementation-contract`. `devspec-remote`'s "batch mode overrides conversation mode" section goes too: working a batch never installed different rules, so resolving one clears nothing.

Nothing takes its place — no timeout, no patience window, no ask-policy. **Ask only what is not yours to decide** (never a detail the item's intent and criteria already settle), and **do not assume someone is waiting to answer** (before a claim, say what you need and stop; after a claim, fail the item with a precise reason). Neither depends on knowing whether a human is watching, which is what the mode was pretending to know.

Brainstorm no longer asks whether you want it: it runs when the invocation asked for it, and a plain work run skips it.

## 0.4.1 - 2026-08-14

### A quiet connection stays up while the host process is alive

- **Removed the 72h idle-disconnect.** The poller no longer stamps `idle_timeout` and exits after three quiet days. A connection lives as long as its Antigravity process, unless you End it or run `devspec-remote-stop`. Item `ce1758a3`.

## 0.4.0 - 2026-08-11

### The autopilot skills are gone — staged batches arrive at any idle connection

**Migration:** if you used `devspec-autopilot` (or `autopilot-status` / `autopilot-history` / `autopilot-log`), stage the items in DevSpec instead (**Stage for Autopilot** / approve a plan) and keep an ordinary `devspec-remote` session idle — DevSpec hands the batch to it. Status is the Agents page; stop is `devspec-remote-stop`; history is the assignment and item record.

- **The plugin no longer chooses its own work.** The four autopilot skills are deleted, and with them the `get_next_work_item` self-selection path; the server routes a staged batch to a connection and the plugin only works what it was handed.
- **Unattended is a mode, not a command.** The dispatch-protocol section of `devspec-remote` (step 8a) now states the batch contract explicitly: batch rules override conversational rules for the duration of the batch, a member that cannot be done safely is failed loudly with `fail_work_item` (never stalled on a question nobody is there to answer), and the connection returns to ordinary available capacity when the batch resolves.
- No replacement command or flag is created. Same deletion across the Claude Code, Cursor, OpenCode, Grok and Codex plugins under the same item (`3f2f390c`).

## 0.3.6 - 2026-08-04

### Read a memory before superseding it — search now returns a card

DevSpec's `search_memories` changed today: it returns a **card** (title, one-line summary, id, state) instead of the full memory body, because a 15-result search was returning over 600,000 characters. The full text comes from a new `get_memory` tool.

- **The instruction that mattered was the supersede one.** This plugin told the agent to search memories first and supersede the closest match instead of duplicating — a judgement made against full bodies yesterday, and against one-line summaries today. It now says to `get_memory` the match and read it in full first: a card is enough to choose WHICH memory you mean, not enough to justify overwriting an entry in the team's shared decision record.
- **Where the autopilot loop treats memories as hard constraints**, it now reads the binding ones in full. A summary states the decision; the body carries the qualifications and exceptions, and a constraint obeyed without its exceptions is how an unattended loop confidently does the wrong thing.
- **No `allowed-tools:` gate here**, unlike the Claude Code plugin, so `get_memory` was already callable — this release is about the instructions, not about unblocking a refused tool call.

Nothing else needs reinstalling for the DevSpec-side change: MCP tool definitions come from the server, so a reconnect picks up the renamed `body` parameter and the now-required `title` on `record_memory`.

Item `93a851b5`.

## 0.3.0 - 2026-07-25

### Remote control — long-poll transport, and the room arrives with the command

- **The polling interval is gone.** One held `poll_connection` call replaces the old three-call tick (`heartbeat_connection` + `get_connection_dispatch` + `get_session_transcript`). The server holds the request open (~25s) and answers the instant something lands: **~2 requests/min instead of 8, and ~0 delivery latency instead of up to 15s.** Fixed intervals survive only as error/empty-turn backoff.
- **Room context is now delivered WITH the command.** A wake payload begins with a labelled `room_context` event — `owner_ambient` (your owner talking in the room, but not to you) and `room_context` (teammates, Dev, other agents) — followed by the command last. Previously advisory was written to a side file and reading it was an instruction the model had to remember; an agent could hold "1", "2", "3" on disk and still fail to answer "what's the next number?". Because a long-poll returns the instant anything arrives, the poller carries advisory forward since the last command so it is genuinely there when the command lands.
- **Reconnect arrives oriented.** A cold launch or a server-side reattach asks for the bounded catch-up window, writes it as advisory and seeds the carry buffer — so the first command after reconnecting already has the room. Already-answered history is still filtered out of the commands, so reconnecting never re-wakes a finished turn.
- **Commands state their addressee.** Every delivered command carries `addressed_to` (agent name · codename · connection id) and an `authority` stamp, and the poller **refuses** anything not addressed to it. Two of your agents in one room can no longer be confused for each other, and a misroute is visible instead of silent.
- Teardown is faster: a held request is aborted the moment the owning agent process dies, and every request now has a hard client-side timeout, so a dropped network can no longer wedge a poller with no heartbeat.
- Also picks up the Windows owner-pid resolution the shared layer gained in the previous release.


## 0.2.1 - 2026-07-24

### Remote control — never drop owner mail that arrives mid-turn

- `devspec-remote-wait` **defaults to resuming from `inbox_byte_offset`** (not EOF).
- Skill: **re-arm with `--pending`** after every wake. `--from-end` is first-connect only.
- Live bug: re-arming with `--from-end` after a wake skipped owner commands the poller had already written while the agent was mid-turn.

## 0.2.0 - 2026-07-24

### Remote control — agent-canonical, connection-scoped, session optional

- **Answers:** when attached, post via `post_session_message({ connection_id })`. Sessionless: assignment / `report_progress` only — never invent a room.
- **Stop hooks:** busy/heartbeat + optional local_prompt only — **no** full assistant mirror.
- **`devspec-work --remote`:** defaults **sessionless**; optional `--session` / `--new` for a transcript.
- Skills match DevSpecV2 delivery contract (ADR b98a39a9).

## 0.1.x

- Prior skills, hooks, and remote-control packaging (unversioned tree).
