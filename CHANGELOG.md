# Changelog

## 0.18.9

### Agents follow DevSpec's current rules, and nothing is cut short without saying so

- **A refused commit points to a fix that works.** When a commit is refused for having no task, the agent is now told to reuse the task the work belongs to, or create one with a real description and the reason behind it. It used to suggest a deliberately thin task, which DevSpec now refuses, so the agent got stuck mid-commit.
- **Work waiting for someone's OK lands once it has it.** The agent keeps such work on its own branch until the OK arrives, then merges as the notice says, so the task can finish. Before, it was told never to merge that work at all.
- **Accurate tool shapes.** The quick reference the agent works from now matches what DevSpec accepts, including asking someone to confirm, answering a request to confirm, and recording a criterion met by a better route. A self-check now fails if any shape drifts from the server.
- **Every kind of notice is handled.** The agent follows the handling that comes with each notice about its work, including outcomes of work that waited for an OK, answered requests to confirm, and content flagged after it was written.
- **Nothing is cut silently.** Long replies and prompts mirrored into a DevSpec room are posted whole up to what DevSpec accepts, with a note if anything had to be left out. A long reply to a question is refused with the limit instead of being cut. Work steps in the activity list are no longer shortened beyond what DevSpec itself keeps. When a reply's work summary is too big for what Antigravity lets a hook pass on, older steps are left out first, and the summary says how many were left out.
- **Long commit commands are checked too.** A commit command over 8,192 characters used to skip the task-reference check entirely.

## 0.18.7

### Customer-facing setup guide and `remote-control-state.mjs` stop skill

- **Customer-facing `README.md`:** Updated installation, `https://api.devspec.ai/api/mcp` configuration, `agy --dangerously-skip-permissions` remote-control guidance, project selection (`/devspec-project`), and command reference to match the in-app setup flow while keeping runtime work authority pointed at `devspec://product/implementation-contract` in `rules/AGENTS.md` and `skills/devspec-remote/SKILL.md`.
- **State helper in `skills/devspec-remote-stop/SKILL.md`:** Updated step 1 to resolve `connection_id` and `session_id` exclusively through `scripts/remote-control-state.mjs resolve-local` rather than reading files under `~/.devspec/remote-control/` directly.

## 0.18.6

### Task field partitioning guidance in `rules/AGENTS.md`

- **Substantive field partitioning (`rules/AGENTS.md`).** Updated Section 6 (`create_task` / `update_task`) to instruct agents to place *why* the task exists, speaker attribution/quotes, and desired outcome in `intent`; write the complete product behaviour and architectural or technical mechanism in natural English in `description` (since duplicate and reversal screening reads `title`, `intent`, and `description`, never `ai_instructions`); keep `acceptance_criteria` as plain-prose checkable conditions; and place raw file paths, line numbers, code snippets, CSS classes, and file-by-file edit recipes in `ai_instructions`.

## 0.18.5

### Prefer target connection's stored `ls_address`, `csrf_token`, and `local_id` over inherited environment in background listeners

- **Target-connection `agentapi` credentials in `deliverWakeViaAgentApi` and `ensureListenerForConnection` (`scripts/devspec-remote-listen.mjs`, `scripts/remote-control-state.mjs`, `scripts/devspec-remote-connect.test.mjs`).** When a listener is restarted from another Antigravity window or helper script, the spawner's `ANTIGRAVITY_LS_ADDRESS`, `ANTIGRAVITY_CSRF_TOKEN`, and `ANTIGRAVITY_CONVERSATION_ID` previously rode along in `process.env` and overrode the target connection's own `<connectionId>.json` state (`state?.ls_address && !env.ANTIGRAVITY_LS_ADDRESS`). `deliverWakeViaAgentApi` now always prefers `state.ls_address`, `state.csrf_token`, and `state.agentapi_exe` when `state` provides them; `ensureListenerForConnection` strips caller-inherited session environment variables and populates `ANTIGRAVITY_*` from the target connection's stored state (accepting `opts.localId` or `state.local_id` when `opts.conversationId` is omitted); and `devspec-remote-listen.mjs` prefers `state.local_id` over `process.env.ANTIGRAVITY_CONVERSATION_ID` when `--connection-id` is passed.

## 0.18.4

### Local-file handoff (`MAX_INLINE_WAKE_BYTES = 65_536`) for >64 KB remote wakes

- **Threshold-based local-file handoff (`scripts/devspec-remote-listen.mjs`, `scripts/devspec-remote-connect.test.mjs`).** `buildWakeDeliveryMessage` now enforces `MAX_INLINE_WAKE_BYTES = 65_536` (64 KB, half of Linux's 131,072-byte `MAX_ARG_STRLEN`). Wakes at or below 64 KB are delivered inline in a single turn with zero extra tool calls, while any wake exceeding 64 KB writes its complete, uncut readable body to an owner-only (`0600`) local file (`<connDir>/<connectionId>.wake-<wakeId>.txt`) and replaces the inline body section with the handoff file path, byte length, and a required-read instruction alongside the intact canonical JSON metadata lines.

## 0.18.3

### Deduplicate `system_notice`, command, and question-answer wake payloads (`E2BIG` prevention)

- **Single-copy `canonical_system_notices` wakes (`scripts/devspec-remote-wait.mjs`, `scripts/devspec-remote-listen.mjs`).** `buildCanonicalSystemNoticeEvents` no longer embeds the raw `notice` object or repeats full record `text` strings inside `records` metadata when `formatSystemNoticeContent(notice)` already renders them, and `buildWakeDeliveryMessage` omits duplicate `content` from the JSON line when the formatted notice is already emitted in the wake header — reducing multi-notice wake payloads by ~70% (1x instead of 4x) so batched findings do not exceed Linux `MAX_ARG_STRLEN` (`spawn E2BIG`) on `agy agentapi send-message`.
- **Single-copy command and question-answer wakes (`scripts/devspec-remote-wait.mjs`, `scripts/devspec-remote-listen.mjs`).** `buildCanonicalCommandEvents` omits duplicate `content.body`, `project_scope`, and `sender_response_style` inside `message` metadata; `buildWakeDeliveryMessage` passes `includeBody: false` so command bodies are emitted once in the readable header rather than 3 times; and `interaction_answer` wake headers no longer dump unsanitized duplicate `JSON.stringify(entry.event.answer)` outside the `<devspec_question_answer_data>` fence.

## 0.18.1

### Rename plugin and install directory from `autopilot` to `devspec` with legacy directory fallback

- **Plugin identity and install directory (`plugin.json`, `package.json`, `README.md`):** Renamed `plugin.json` `name` from `devspec-autopilot` to `devspec`, removed `"autopilot"` from `package.json` keywords, and updated setup and update instructions to use `~/.gemini/config/plugins/devspec` and the short slash commands (`/devspec-remote`, `/devspec-remote-stop`, `/devspec-project`).
- **Backwards-compatible script path fallback (`rules/AGENTS.md`, `skills/devspec-remote/SKILL.md`, `skills/devspec-remote-stop/SKILL.md`, `skills/devspec-project/SKILL.md`):** Skill and rule commands resolve `$HOME/.gemini/config/plugins/devspec` first and fall back to `$HOME/.gemini/config/plugins/antigravity-devspec-autopilot-extension` so existing installations continue working before the folder is renamed on disk.

## 0.18.0

- Tool-input handling, claim/provenance readers, remote projections and installed rules use Tasks (`Feature`, `Improvement`, `Bug`, `Investigation` and `General`).
- Existing commit-reference IDs and durable records remain intact; session joining and identity binding are unchanged.
- Requires the matching Tasks server. Update the actual installed plugin checkout, including its rules, and restart Antigravity to refresh runtime instructions and tool schemas before resuming work.

## 0.17.7

### Strip stale `.old` self-update suffix in `resolveAgentApiCommand` instead of falling back to the `agentapi` wrapper

- **Strip `.old` self-update suffixes and always invoke `agy agentapi` directly (`scripts/devspec-remote-listen.mjs`, `scripts/devspec-remote-connect.test.mjs`).** When `agy` self-updates in place, it renames the running binary to `agy.<id>.old` (or `agy.exe.<id>.old`) and removes the `.old` binary on the next launch. On Linux, whenever a pre-update `agy` session later runs a `run_command` tool call, `agy` rewrites `~/.gemini/antigravity-cli/bin/agentapi` with `exec "<os.Executable()>" agentapi "$@"` — which resolves via `/proc/self/exe` back to the deleted `agy.<id>.old` path and breaks wake delivery (`exit 127`) for any listener falling back to that wrapper. On Windows, `~/.gemini/antigravity-cli/bin/agentapi.bat` also cannot be executed directly via Node's `execFile` (`ENOENT`). `resolveAgentApiCommand` now drops the `~/.gemini/antigravity-cli/bin/agentapi` wrapper fallback altogether: when `ANTIGRAVITY_AGENTAPI_EXE` / `state.agentapi_exe` no longer exists on disk, it strips any `.\d+.old` / `.old` suffix (`stripSelfUpdateOldSuffix`) to invoke the live `agy` binary directly with `prefixArgs: ['agentapi']`, or falls back to `agy` (`prefixArgs: ['agentapi']`) on `PATH`.

## 0.17.6

### Fix 1-hour idle drop-off, filter connection sidecar state files, and add listener poller self-repair

- **Remove cross-connection poller reaper (`scripts/remote-control-state.mjs`, `scripts/session-start.mjs`).** Opening a new Antigravity window or running `writeConnectionState` / `session-start.mjs` previously ran `reapDeadPollers`, which scanned every `.json` file under `~/.devspec/remote-control/connections/`. Because companion sidecars such as `<connId>.<sessionId>.transcript-state.json` have no `owner_pid`, any session whose transcript sidecar had not been written for over an hour (`STALE_NO_OWNER_REAP_MS = 60m`) had its live `<connId>` poller killed by `stopPollerForConnection(connId)`. `reapDeadPollers` and the `reap` subcommand have been removed; each poller already self-terminates when its own `owner_pid` exits.
- **Strict `<uuid>.json` connection state file filter (`scripts/remote-control-state.mjs`, `scripts/mirror-turn.mjs`).** Added `isConnectionStateFilename` (`CONNECTION_STATE_FILE_RE`) and applied it in `scanConnectionStates`, `listConnectionStates`, and `mirror-turn.mjs` so sidecar files (`.transcript-state.json`, `.read.json`, `.room.json`, `.tiers.json`, `.listener.json`, `.cursor.json`, etc.) are never parsed as connection state records.
- **Exact argv poller matching (`scripts/remote-control-state.mjs`).** `findPollerPidsForConnection` now splits `/proc/<pid>/cmdline` on `\0` and checks `isPollerArgv(argv, connectionId)` rather than matching substrings in a space-joined command line, and exports `pollerRunning(connectionId)`.
- **Automatic poller self-repair in the background listener (`scripts/devspec-remote-listen.mjs`).** While the owning Antigravity process and `devspec-remote-listen.mjs` remain alive and the connection has not been deliberately ended (`local_stop`, `ui`, `owner_gone`), the listener periodically checks `pollerRunning(connectionId)` and automatically re-registers, re-attaches the room session, refreshes `connection_capability`, and respawns the poller (`reconcilePollerStep`, `repairConnectionPoller`) if the poller ever exits unexpectedly.

## 0.17.5

- `agy` makes any decision you could make in DevSpec's Review for you as soon as your request is clear: accepting or declining a proposed change (`decide_proposal`), answering on work that would undo a decision, saying a flagged record is still accurate, or settling a duplicate. It warns you once, up front, only if you seem unaware of a significant consequence, never asks you to confirm again, and tells you what happened and what you can do next. The rules' tool quick-reference lists each of these tools.
- `decide_proposal` now carries who asked for it, like every other change the agent makes for someone.
- Saving a folder's default project happens straight away when you asked for exactly that; otherwise `agy` warns once that the file can be shared.

## 0.17.4

### Single-post directed-question replies, JSON `keep_turn` batching, and `rearm: "already_armed"` on answer/dismissal wakes

- **Answering or asking a directed question no longer triggers a duplicate fallback reply (`scripts/devspec-question.mjs`, `scripts/mirror-turn.mjs`).** `devspec-question.mjs respond` now calls `finishQuestionRespondTurn`, which clears `interaction_continuation`, writes `.explicit-reply`, and clears `.turn`; `devspec-question.mjs use` also writes `.explicit-reply` alongside clearing `.turn` when a pending question ends the turn; and `isSessionReplyToolCall` / `isRemotePlumbingToolCall` in `scripts/mirror-turn.mjs` recognize `devspec-question.mjs` so `PostToolUse` does not re-open `.turn` and `Stop` does not post a second `post_session_message`.
- **`"keep_turn": true` inside JSON `--input` keeps the local turn open for batched questions (`scripts/devspec-question.mjs`).** Passing `"keep_turn": true` in `--input` to `devspec-question.mjs use` now sets `keepTurn = true` for both `directedQuestionToolArguments` and `askTurnBoundaryPlan`, matching the `--keep-turn` CLI flag when asking multiple independent questions in one turn.
- **Directed-question answer and dismissal wakes preserve `rearm: "already_armed"` (`scripts/devspec-remote-wait.mjs`, `scripts/interaction-events.mjs`, `scripts/question-dismissal-events.mjs`).** `formatInboxEntryForStream` now forwards `rearm` to `buildQueuedAnswerEvents`, `buildInteractionAnswerEvents`, and `buildQuestionDismissalEvents` so wakes delivered by the persistent background listener (`devspec-remote-listen.mjs`) report `rearm: "already_armed"` instead of hardcoded `"devspec-remote-wait"`.
- **Aligned CLI flags and instructions (`scripts/devspec-question.mjs`, `scripts/devspec-poll.mjs`, `skills/devspec-remote/SKILL.md`, `rules/AGENTS.md`).** `devspec-question.mjs` and `devspec-poll.mjs` accept `--schema` as an alias for `describe`, and `SKILL.md` / `rules/AGENTS.md` document `describe` / `use` / `respond`, batching questions with `keep_turn: true`, and replying to `question_answer` / `question_dismissal` wakes exclusively via `devspec-question.mjs respond`.

## 0.17.3

### Findings about the agent's own work reach it again

- **The poller asks DevSpec for notice version 2, on `poll_connection` and on the push stream (`scripts/devspec-remote-poll.mjs`, `SYSTEM_NOTICE_CHANNEL_VERSION`).** DevSpec sends what it finds about the agent's own work (a change that would undo someone's decision, duplicates other work or breaks a requirement) and what happened to its pending edits only to a channel that asked for version 2. This version still asked for 1, so these went only to the person's notifications and the Agents page showed the agent as "Not receiving findings". Both notice kinds are read exactly as before: version 2 adds a kind and changes no notice's shape.

## 0.17.2

### Your DevSpec key stays off command lines, out of printed output, and in owner-only files

- **Install no longer puts the key on a command line (`README.md`, `scripts/resolve-mcp-auth.mjs`).** The install step and the "not configured" message told people to run `agy mcp add --header "Authorization: Bearer dvs_…"`, which puts the key in that process's command line (readable by every account on the computer while it runs) and in shell history. Both now say to paste the entry into `~/.gemini/config/mcp_config.json` and keep that file owner-only (`chmod 600`). Measured on agy 1.4.0: headers come only from that file or from `--header`, and `agy mcp add|remove|enable|disable` rewrites the file as a new `0644` file (under the usual umask) whatever mode it had.
- **`--host-token` is gone (`scripts/remote-control-state.mjs`).** Nothing shipped used it. The key is read from Antigravity's MCP config only.
- **No command prints the key.** `resolve-mcp-auth.mjs`, `remote-control-state.mjs resolve-auth` and `remote-control-state.mjs read` report it as `token_fingerprint`, its first twelve characters (what DevSpec shows under Access tokens); `read` reports the CSRF token and connection capability by presence only. Agents had been building `curl -H "Authorization: Bearer …"` command lines out of the printed key. `rules/AGENTS.md` now tells agents never to put the key on a command line or print the files that hold it.
- **Every file holding the key is `0600` in a `0700` folder after every write, including one that already existed looser (`scripts/private-state.mjs`).** Connection state, the legacy pointer and `~/.devspec/auth.json` are written aside and renamed through one helper (`remote-control-state.mjs`, `mirror-turn.mjs` and `resolve-mcp-auth.mjs` wrote some of them in place, so `0600` applied only when a file was first created), and folders are chmodded `0700` up to `~/.devspec` because `mkdir`'s mode applies only to folders it creates. Listener and poller logs are opened owner-only, including logs an earlier version created `0664`.
- **Antigravity's `mcp_config.json` is set back to `0600` and its folder to `0700` at every session start and `/devspec-remote` (`scripts/host-mcp-header.mjs`),** whether or not the plugin header changes; a rewrite is always `0600` instead of keeping the old mode. agy leaves the folder's mode alone, so the `0700` folder keeps other accounts out between one of agy's rewrites and the next pass.
- **SessionStart repairs what earlier versions left in `~/.devspec`:** folders to `0700`, files to `0600`, never following a symlink (`tightenPrivateTree`).
- **Windows:** POSIX modes do not apply and the sweep is skipped. The files sit under `%USERPROFILE%` and inherit the profile folder's default access list: that user, SYSTEM and Administrators.

## 0.17.1

### Close Antigravity (`agy`) in its terminal when ended from DevSpec (`end_reason === "ui"`)

- **Close the owning `agy` process cleanly via `SIGTERM` on UI End (`scripts/close-on-end.mjs`, `scripts/devspec-remote-listen.mjs`, `scripts/devspec-remote-wait.mjs`):** Added `scripts/close-on-end.mjs` (`closeAntigravityOnEnd`, `closeOnEndDecision`, `ownedByAntigravityProcess`, `ownedByAnotherAntigravityProcess`, `antigravityProcessOf`, `processStartTime`). When a connection that the listener served while live (`sawLive === true`) transitions to `end_reason === "ui"`, the listener sends `SIGTERM` to the owning `agy` process (`owner_pid`, verified alive, matching `agy`/`antigravity`, and matching `/proc/<pid>/stat` start time `owner_started`), triggering Bubble Tea's graceful terminal shutdown while keeping the conversation resumable (`agy --resume`). Non-UI ends (`local_stop`, `idle_timeout`, `server_ended`, `owner_gone`), already-ended state files (`sawLive === false`), and other terminals' `agy` processes are never signaled.
- **Immediate SSE `event: ended` teardown and stopped local conversation bonds (`scripts/devspec-remote-poll.mjs`, `scripts/remote-control-state.mjs`):** `openPushChannel` in `scripts/devspec-remote-poll.mjs` now invokes `handlePermanentEnd(evt.endReason)` immediately on SSE `event: ended` frames (`evt.kind === "ended"`) without waiting out the 25–30s long-poll hold, falls back to `closeAntigravityOnEnd` if no listener is armed, and `disableLocalState` calls `markBondsStoppedForConnection` so `~/.devspec/remote-control/local/antigravity/<local_id>.json` is marked `status: "stopped", enabled: false, ended_from_ui, end_reason`. `writeConnectionState` also records `owner_started` alongside `owner_pid` to defeat PID reuse.

## 0.17.0

### Plugin identification header, GitHub identity link at connect, wakes that survive an agy self-update, and Protecting intent wording

- **Every DevSpec MCP request names this plugin and its running version (`x-devspec-plugin: antigravity/<version>`).** The plugin's scripts add it on every request they make (`scripts/mcp-call.mjs`: tool calls, register, poll; the token check in `scripts/resolve-mcp-auth.mjs`; the poller's push channel in `scripts/devspec-remote-poll.mjs`). Antigravity's own MCP client (the model's `mcp_devspec_*` and lazy `call_mcp_tool` calls) sends it from the user's `~/.gemini/config/mcp_config.json`, which `SessionStart` and `/devspec-remote` now keep current (`scripts/host-mcp-header.mjs`): only that one header on the DevSpec entry changes, the token, other headers, other servers and the file's mode are kept, and a file that does not parse is left alone. The version is read once from the loaded `package.json` (`scripts/connection-version.mjs`, `PLUGIN_ID` in `scripts/agent-identity.mjs`). The header identifies the plugin and unlocks nothing.
- **GitHub identity link at connect (`scripts/github-identity.mjs`, `scripts/devspec-remote-connect.mjs`, `scripts/session-start.mjs`).** For a project with GitHub repositories, the connect status block now shows `GitHub: linked as @login`, or `GitHub: NOT LINKED` with the one link DevSpec returns, which the agent gives the person to open (identity only; DevSpec keeps no access to their account).
- **Remote wakes keep arriving after agy updates itself (`scripts/devspec-remote-listen.mjs`).** agy renames its running binary to `agy.<n>.old` when it updates, and a later launch deletes it, while the session's `ANTIGRAVITY_AGENTAPI_EXE` still names it. The listener then failed to deliver every later room message without saying so, and the person had to type at the terminal instead. A named binary that no longer exists is now skipped for the `agentapi` wrapper agy keeps current, and a delivery that fails is logged (`wake_delivery_failed`, then `wake_delivery_recovered`) instead of retried silently.
- **Writes name the request they serve on two more tools.** `record_duplicate_nonmatch` and `resolve_duplicate` now get `request_ref` / `provenance_ref` stamped like every other write (`scripts/request-ref.mjs`), and `scripts/server-tool-names.test.mjs` fails when these sets differ from the server's.
- **System notices tell the agent to tell the person.** A finding, an edit's outcome or an ownership follow-up arriving as a `[DevSpec System Notice: …]` wake now asks the agent to explain it in plain words and quote each labelled record as delivered; a notice record's link may be as long as the server allows (1000 characters) instead of refusing the whole notice past 500.
- **Wording (`rules/AGENTS.md`, `skills/devspec-remote/SKILL.md`).** New "Protecting intent" rules: work whose claim or results carry `waiting_for_ok` ("Waiting for <name>'s OK", "Experiment") is built and pushed on its own branch and never merged into the tracking branch; an item is made an experiment, or loses that label, only on the person's instruction; go ahead / no / "this doesn't undo my decision" are the person's own answer; the decision-capture bar; and authority is the served contract's, never these rules'. The lazy-tool quick reference now uses the parameters the server takes (`lifecycle`, not `status`; `record_implementation`'s `completion_summary`, `completion_note`, `affected_files`, `completion_disposition`; `create_action_item`'s required `intent`).

## 0.16.0

### Explicit `/devspec-remote` connection model and `local (/devspec-remote to connect)` status bar indicator

- **Make `/antigravity-devspec-autopilot-extension:devspec-remote` the explicit remote-control entrypoint (`scripts/session-start.mjs`, `scripts/statusline.mjs`):** Because Antigravity (`agy`) only exposes `ANTIGRAVITY_CSRF_TOKEN`, `ANTIGRAVITY_LS_ADDRESS`, and `ANTIGRAVITY_AGENTAPI_EXE` to child processes of the `run_command` tool (never to `statusLine` or `SessionStart`), connections registered automatically on window open before `/devspec-remote` was run had no `ANTIGRAVITY_CSRF_TOKEN` and could not receive remote wakes via `agentapi`. `connectAtStartupEnabled` in `scripts/session-start.mjs` now defaults to `false` (unless explicitly opted in via `DEVSPEC_CONNECT_AT_STARTUP=1` or `.devspec/project.json` `connect_at_startup: true`), and `renderStatusLine` in `scripts/statusline.mjs` no longer spawns background connections on window open.
- **Clear `local (/devspec-remote to connect)` status bar indicator before connecting (`scripts/statusline.mjs`):** When an Antigravity terminal is opened in a linked DevSpec project or git repository before `/devspec-remote` has been run (`view.state === 'local'`), `readConnectionView` and `formatStatusLine` now display `DevSpec: local (/devspec-remote to connect) · <Project>` (resolving `<Project>` from `.devspec/project.json`, conversation selection, or the most recent connection in that workspace) instead of registering an unwakeable standby connection.
- **Documentation alignment (`README.md`, `skills/devspec-remote/SKILL.md`):** Updated setup and remote-control documentation to clearly state that running `/antigravity-devspec-autopilot-extension:devspec-remote` is the way to connect an Antigravity terminal to DevSpec remote control.

## 0.15.9

### Zombie resurrection prevention on window close, accurate `Working` status upon wake delivery, HTTP LS port discovery, and `PreToolUse` >64 KB trail cap

- **Prevent zombie connection resurrection when closing an ended or disconnected Antigravity window (`scripts/statusline.mjs`, `scripts/session-start.mjs`, `scripts/devspec-remote-poll.mjs`, `scripts/devspec-remote-listen.mjs`):** `readConnectionView` in `scripts/statusline.mjs` now matches an existing `owner_pid` connection even when `enabled === false` or `ended_from_ui === true` (and supports `agy-window:<pid>` standby `local_id` values), so `renderStatusLine` renders the ended/disconnected status instead of falling back to `state: 'local'` and re-triggering `maybeSpawnWindowAutoConnect` during window teardown. `maybeSpawnWindowAutoConnect` never re-spawns when a connection state file already exists for `owner_pid` or while `ownerAlive(ownerPid)` is true, `autoConnectAtStartup` aborts before and after `register_connection` if `ownerPid` has already exited, and `devspec-remote-poll.mjs` / `devspec-remote-listen.mjs` exit immediately at startup when an explicit `--owner-pid` is already dead instead of running forever without an owner anchor.
- **Assert `Working` (`busy: true` / `report_pickup`) only when the wake is actually delivered (`scripts/devspec-remote-poll.mjs`, `scripts/devspec-remote-listen.mjs`, `scripts/devspec-remote-wait.mjs`):** Added `shouldAssertTurnOnPollerInboxWrite` in `scripts/devspec-remote-poll.mjs` so writing an inbound command or event to `.inbox.jsonl` only writes `.turn` immediately when an in-conversation `devspec-remote-wait.mjs` process (`.wait.pid`) is actively armed on a bound conversation. When `devspec-remote-listen.mjs` handles wakes via `agentapi`, `.turn` and `report_pickup` are asserted only after `deliverWakeViaAgentApi` succeeds (`res.ok`), preventing unbonded standby windows or undelivered wakes from getting stuck on `Working`.
- **Match the HTTP language-server port (`HTTP(?!S)`) and cap `PreToolUse` trail size (`scripts/remote-control-state.mjs`, `scripts/devspec-tool-input.mjs`):** Fixed `discoverAntigravityLsAddress` to skip the earlier `for HTTPS` log line and match `for HTTP(?!S)`, and added `capTrailForPreToolHook` in `scripts/devspec-tool-input.mjs` so auto-attached `trail_events` and `work_trail` on `post_session_message` never push `PreToolUse` stdout past Antigravity's 64 KB `bufio.Scanner` token limit.

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

A new test reads DevSpec's live tool list from a server checkout beside this repo and fails if anything in this plugin names a DevSpec tool the server does not have. A tool renamed or retired on the server is then caught here, before an agent is told to call it in someone's session. With no checkout beside it the test skips; `DEVSPEC_V2_ROOT` names one. Nothing about how the plugin behaves has changed.

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

The server retired `get_assignment`, `acknowledge_assignment` and `resolve_assignment`, along with `get_next_work_item`. Nothing dispatches work to an agent, so there was nothing left for them to do: no batch to receive, no receipt to give, nothing to close.

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

- **Removed the 72h idle-disconnect.** The poller no longer stamps `idle_timeout` and exits after three quiet days. A connection lives as long as its Antigravity process, unless you End it or run `devspec-remote-stop`.

## 0.4.0 - 2026-08-11

### The autopilot skills are gone — staged batches arrive at any idle connection

**Migration:** if you used `devspec-autopilot` (or `autopilot-status` / `autopilot-history` / `autopilot-log`), stage the items in DevSpec instead (**Stage for Autopilot** / approve a plan) and keep an ordinary `devspec-remote` session idle — DevSpec hands the batch to it. Status is the Agents page; stop is `devspec-remote-stop`; history is the assignment and item record.

- **The plugin no longer chooses its own work.** The four autopilot skills are deleted, and with them the `get_next_work_item` self-selection path; the server routes a staged batch to a connection and the plugin only works what it was handed.
- **Unattended is a mode, not a command.** The dispatch-protocol section of `devspec-remote` (step 8a) now states the batch contract explicitly: batch rules override conversational rules for the duration of the batch, a member that cannot be done safely is failed loudly with `fail_work_item` (never stalled on a question nobody is there to answer), and the connection returns to ordinary available capacity when the batch resolves.
- No replacement command or flag is created.

## 0.3.6 - 2026-08-04

### Read a memory before superseding it — search now returns a card

DevSpec's `search_memories` changed today: it returns a **card** (title, one-line summary, id, state) instead of the full memory body, because a 15-result search was returning over 600,000 characters. The full text comes from a new `get_memory` tool.

- **The instruction that mattered was the supersede one.** This plugin told the agent to search memories first and supersede the closest match instead of duplicating — a judgement made against full bodies yesterday, and against one-line summaries today. It now says to `get_memory` the match and read it in full first: a card is enough to choose WHICH memory you mean, not enough to justify overwriting an entry in the team's shared decision record.
- **Where the autopilot loop treats memories as hard constraints**, it now reads the binding ones in full. A summary states the decision; the body carries the qualifications and exceptions, and a constraint obeyed without its exceptions is how an unattended loop confidently does the wrong thing.
- **No `allowed-tools:` gate here**, unlike the Claude Code plugin, so `get_memory` was already callable — this release is about the instructions, not about unblocking a refused tool call.

Nothing else needs reinstalling for the DevSpec-side change: MCP tool definitions come from the server, so a reconnect picks up the renamed `body` parameter and the now-required `title` on `record_memory`.

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
- Skills match the DevSpec remote-control delivery contract.

## 0.1.x

- Prior skills, hooks, and remote-control packaging (unversioned tree).
