# DevSpec for Antigravity

**Build on your team’s best thinking.**

[DevSpec](https://devspec.ai) is where your team, your knowledge, and your agents build software together — made for AI-native development from the ground up.

Bring DevSpec into [Google Antigravity CLI](https://antigravity.google) (`agy`). Once configured, `agy` connects to your DevSpec projects so you can ground on shared team memory, work tracked tasks end to end, coordinate in shared rooms with plans, polls, and directed questions, and steer your local `agy` session from your browser or phone.

> **No DevSpec Launcher is installed by this plugin.** Use `agy` and its DevSpec connection skills normally. The launcher is a separate, optional browser-launch convenience with its own setup; this plugin does not bundle it, register its URL handler, or start its service. Check your [Agents settings in DevSpec](https://devspec.ai/settings/agents) for supported standalone launch targets and release availability.

---

## What you can do with it

- **⭐ Drive `agy` from your browser or phone (Remote Control).** Run `/antigravity-devspec-autopilot-extension:devspec-remote` in your terminal to connect this `agy` session to the DevSpec Agents page or attach it directly to a shared DevSpec session room. Teammates can follow along and add context in the same thread while server-verified owner and delegated commands drive the agent.
- **Two-sided live transcript.** Your prompts and the agent's answers appear in the DevSpec room, and a turn stays open until any background subagents finish.
- **Work a task end to end — or an ordered batch.** Point `agy` at a task (or a list of items in order). It reserves the requested items, claims them one at a time, implements the change, runs checks, tags commits with `[devspec:<id>]`, and records implementation and criterion verdicts back to DevSpec.
- **Decisions in Review, made for you.** Ask `agy` to make any decision you could make on DevSpec's Review page (accept or decline a proposed change, answer on work that would undo a decision, rule on a flag or a duplicate) and it does it as soon as your request is clear, then tells you what happened and what you can do next. It warns you once, up front, only if you seem unaware of a significant consequence, and never asks you to confirm again. Who may decide what is DevSpec's rule; if you can't, it says who can.
- **Verified commit provenance.** Automatic `PreToolUse` and `PostToolUse` hooks observe new git commits, track `[devspec:<id>]` commit trailers against claimed work items, and guard implementation reporting against unverified commit SHAs.
- **Coordinate in the room with plans, polls, and directed questions:**
  - **Shared session plans (`devspec-plan.mjs`):** For genuinely multi-phase work, `agy` maintains a revisioned session plan visible to everyone in the room and recoverable across context compaction or reconnects.
  - **Room polls (`devspec-poll.mjs`):** Create, update, end, retract, or supersede structured room polls (with optional recommendations and write-ins) without blocking the agent turn.
  - **Directed questions (`devspec-question.mjs`):** Ask a specific person a `text`, `single_select`, or `multi_select` question in the room. When they answer or dismiss it in DevSpec, the poller delivers the canonical interaction or dismissal event and re-opens the exact continuation channel.
- **Automatic project grounding, pin checks & repo-link nudges.** Starting a session grounds `agy` with your project summary, conventions, and active work. Writing a `.devspec/project.json` pin is validated immediately, and adding a new git remote to a pinned greenfield folder nudges you once if the repository isn't linked in DevSpec yet.
- **Live status bar.** A one-line DevSpec status bar shows `DevSpec: local (/devspec-remote to connect) · <Project>` before connecting, and the agent's codename, project, session, current work and model once connected.

---

## Requirements

- **Antigravity CLI (`agy`)**.
- A **[DevSpec](https://devspec.ai)** account with an **MCP token** (`read_write` scope, starting with `dvs_`).
  - Create or reveal your token any time on your [Agents settings page](https://devspec.ai/settings/agents) (**Connect a tool** → **Read & write**).
- **`git`** and **Node.js 18+** on your `PATH`. Node runs the hook scripts, capability bridges, and the zero-token background poller for remote control.

---

## Install (3 steps)

Install once at **user home**, not inside an individual project repository. `agy` resolves which DevSpec project a folder belongs to automatically from `git remote get-url origin` (or `.devspec/project.json`).

### 1. Add your DevSpec MCP token to `mcp_config.json`

Check that Node.js 18+ is installed (`node --version`), then add the `devspec` entry to Antigravity CLI's user-level MCP configuration at `~/.gemini/config/mcp_config.json` (Windows: `%USERPROFILE%\.gemini\config\mcp_config.json`; legacy `~/.gemini/antigravity-cli/mcp_config.json` is also supported). Keep any servers already in the file. The **Connect a tool** step on your [Agents settings page](https://devspec.ai/settings/agents) shows this entry with your token filled in:

```json
{
  "mcpServers": {
    "devspec": {
      "type": "http",
      "serverUrl": "https://devspec.ai/api/mcp",
      "headers": {
        "Authorization": "Bearer dvs_YOUR_DEVSPEC_MCP_TOKEN"
      }
    }
  }
}
```

Then make the file readable only by you (macOS / Linux):

```bash
chmod 700 ~/.gemini/config && chmod 600 ~/.gemini/config/mcp_config.json
```

- Edit the file in an editor and paste the token there. **Don't use `agy mcp add --header "Authorization: Bearer …"`**: that puts your token on a command line, where any other account on the computer can read it while it runs, and in your shell history, and `agy` saves the file readable by every account.
- Replace `dvs_YOUR_DEVSPEC_MCP_TOKEN` with a literal `dvs_...` token string (do not use shell variable interpolation like `${TOKEN}`).
- You don't add anything else. At session start and when you run `/devspec-remote`, the plugin adds one header to this `devspec` entry, `x-devspec-plugin: antigravity/<plugin version>`, and moves it on after an update, so DevSpec can tell which plugin and version each call comes from. It changes nothing else in the file and unlocks nothing; the plugin's own background scripts send the same header themselves.
- On first verified connection, the plugin pins your working token and URL at `~/.devspec/auth.json` (`0600`) so stale or placeholder project files never shadow it.
- **Internal staging / custom endpoint override:** End users default to production (`https://devspec.ai/api/mcp`). For internal testing against staging (`devspecstaging.com`), copy the `mcp_config.json` entry directly from [staging Agents settings](https://app.devspecstaging.com/settings/agents) (which sets `serverUrl` to `https://api.devspecstaging.com/api/mcp`, or `https://devspecstaging.com/api/mcp`) or set `DEVSPEC_MCP_URL=https://api.devspecstaging.com/api/mcp`. Every hook and background poller resolves `serverUrl` from your MCP config (`resolve-mcp-auth.mjs`) so all traffic stays on staging.

#### Where your token is kept

- **In Antigravity's MCP config, and nowhere on a command line.** Antigravity's own MCP client reads the token from `mcp_config.json`; the plugin's scripts read it from the same file and keep it in memory. No plugin command takes the token as an argument, and none prints it: `resolve-mcp-auth.mjs` and `remote-control-state.mjs resolve-auth` / `read` show its first twelve characters, the same identifier DevSpec shows under **Access tokens**.
- **Owner-only files.** The plugin's copies (`~/.devspec/auth.json` and the connection state under `~/.devspec/remote-control/`) are written `0600` inside `0700` folders, and a copy an older version left with a looser mode is replaced or tightened. `agy` itself saves `mcp_config.json` as a new file every time `agy mcp add`, `remove`, `enable` or `disable` runs, readable by every account under the usual `umask` (`0644`), so at every session start and every `/devspec-remote` the plugin sets it back to `0600` and its folder to `0700`. `agy` leaves the folder's mode alone, so the `0700` folder keeps other accounts out in between.
- **Windows.** POSIX modes do not apply. The files sit under `%USERPROFILE%` and inherit the profile folder's default access list: your account, SYSTEM and Administrators. Other standard accounts on the computer cannot open them.

### 2. Clone the plugin globally (Required)

**Installing the plugin is required alongside the MCP server.** Because Antigravity lazy-loads MCP tool schemas on disk and spills tool outputs larger than ~6 KB to step files, the plugin bundles [`rules/AGENTS.md`](rules/AGENTS.md) — which Antigravity automatically loads into `<user_rules>` in every workspace — giving the model the complete DevSpec lazy MCP tool parameter quick-reference, ~6 KB spill & `view_file` handling rules, symmetric session-reply rules, and runtime implementation contract without needing to copy an `AGENTS.md` file into each repository manually. The plugin also provides the lifecycle hooks (`SessionStart`, `PreInvocation`, `PreToolUse`, `PostToolUse`, `PreCompact`, `Stop`) required for local and remote turn admission, request-chain attribution, commit provenance, and two-sided session transcript mirroring.

Clone this repository into `~/.gemini/config/plugins/antigravity-devspec-autopilot-extension`:

**macOS / Linux:**
```bash
mkdir -p ~/.gemini/config/plugins
git clone https://github.com/DevSpecAI/DevSpec-Antigravity-Plugin.git \
  ~/.gemini/config/plugins/antigravity-devspec-autopilot-extension
```

**Windows (PowerShell):**
```powershell
New-Item -ItemType Directory -Force "$HOME\.gemini\config\plugins" | Out-Null
git clone https://github.com/DevSpecAI/DevSpec-Antigravity-Plugin.git "$HOME\.gemini\config\plugins\antigravity-devspec-autopilot-extension"
```

### 3. Start `agy` and run `/antigravity-devspec-autopilot-extension:devspec-remote` when you want remote control

Start `agy` in any project directory. On startup, the plugin automatically:
- Loads `rules/AGENTS.md` into `<user_rules>` so Antigravity has the complete DevSpec lazy MCP tool schemas, ~6 KB spill handling, symmetric session-reply rules, local room-context rules, and implementation-contract rules in every project.
- Configures the DevSpec status bar (`statusLine`) in `~/.gemini/antigravity-cli/settings.json` (if no custom `statusLine` is already set), showing `DevSpec: local (/devspec-remote to connect) · <Project>` until you connect.
- Injects initial project grounding when you start a local conversation in a repository linked to a DevSpec project.
- When you want to connect your terminal to the **Agents page** or a **Session room** in DevSpec so it can receive remote commands, run `/antigravity-devspec-autopilot-extension:devspec-remote` (because `agy` only exposes `ANTIGRAVITY_CSRF_TOKEN` and `ANTIGRAVITY_LS_ADDRESS` to child processes of `/devspec-remote`'s tool execution, running `/devspec-remote` is what arms zero-token background wake delivery via `agentapi`).

> **Updating:** When the Agents page in DevSpec shows an **Update** badge on your Antigravity connection, run `git -C ~/.gemini/config/plugins/antigravity-devspec-autopilot-extension pull` and start a new `agy` session.
>
> **GitHub identity:** when you connect to a project whose repositories are on GitHub and you haven't linked your GitHub account to DevSpec yet, the connect status shows `GitHub: NOT LINKED` with a link. Open it once in your browser: GitHub confirms who you are so your commits and pull requests show as yours, and DevSpec keeps no access to your account.

---

## ⭐ Drive a session from DevSpec (Remote Control)

Remote control lets you run a real `agy` session on your machine and steer it from the **Agents page** or a shared **Session room** in DevSpec — from your browser or phone.

### Connecting and disconnecting

| Skill | What it does |
|---|---|
| `/antigravity-devspec-autopilot-extension:devspec-remote` | Run the one-shot mechanical connect script (`scripts/devspec-remote-connect.mjs`) to register or attach this `agy` conversation, cache instruction rules, start the poller, and arm the persistent background listener (`scripts/devspec-remote-listen.mjs`). |
| `/antigravity-devspec-autopilot-extension:devspec-remote-stop` | Disconnect this `agy` conversation from DevSpec and stop its poller and listener (leaving any other active connections untouched). |

You can connect in three ways using `/antigravity-devspec-autopilot-extension:devspec-remote`:

1. **Standby on the Agents page (bare command):** Run `/antigravity-devspec-autopilot-extension:devspec-remote` in your terminal to register this `agy` conversation on the Agents page with a codename (e.g. `Cosmic Raven`) and arm the background poller + listener so you can attach it to any room from the DevSpec UI.
2. **Attach to an existing DevSpec session:** Copy the connect command from a session's settings panel in DevSpec (or pass the session UUID) and run `/antigravity-devspec-autopilot-extension:devspec-remote --session <session-id>`.
3. **Create and attach a new session:** Run `/antigravity-devspec-autopilot-extension:devspec-remote --new` (with an optional `--title "..."`) to create a fresh shared room and attach immediately.

While waiting for instructions, a lightweight local Node poller (`scripts/devspec-remote-poll.mjs`) holds the long-poll connection to DevSpec, materializes room messages and room state to local files (`<connectionId>.transcript.jsonl`, `<connectionId>.room.json`, `<connectionId>.cursor.json`, `<connectionId>.rules.md`), and the persistent background listener (`scripts/devspec-remote-listen.mjs`) delivers wakes directly into your active `agy` conversation via `agentapi send-message` — **zero LLM tokens are spent while idle**, and room messages are never re-injected across turns unless read on demand (`scripts/room-unread.mjs`).

### Shared session plans, room polls, and directed questions

When connected to a DevSpec session, Antigravity negotiates per-connection capabilities (stored in mode-`0600` private state under `~/.devspec/remote-control/connections/`) and exposes three capability-injected CLI bridges:

- **Shared Session Plans (`scripts/devspec-plan.mjs`):**
  - Routine read-only investigation and quick answers stay plan-free.
  - When work involves material multi-phase execution, the agent discovers the schema on demand (`node scripts/devspec-plan.mjs --schema`) and manages one revisioned room plan (`create`, `advance`, `update`, `complete`, `abandon`, `adopt`).
  - If context is compacted or a session reconnects, `session-start-context.mjs`, `pre-compact.mjs`, and `session-plan-prompts.mjs` automatically inject the active plan state so the agent can resume seamlessly.
- **Room Polls (`scripts/devspec-poll.mjs`):**
  - Non-blocking structured polls for the room (`create`, `list`, `get`, `update`, `end`, `retract`, `supersede`), supporting single or multi-select options, `allow_write_in`, `recommendation_index`, and poll series.
- **Directed Questions (`scripts/devspec-question.mjs`):**
  - Ask a specific room participant a `text`, `single_select`, or `multi_select` question (`create`, `list`, `get`, `cancel`, `status`, `respond`).
  - Unless `--keep-turn` is passed, creating a pending question cleanly ends the current turn while the room waits for the person's response.
  - When the person answers or dismisses the question in DevSpec, the poller validates the canonical v1 interaction or dismissal event (`interaction-events.mjs`, `question-dismissal-events.mjs`), claims the exact continuation attempt, and wakes the agent to finish its reply via `devspec-question.mjs respond`.

### Who can talk to it

Collaboration in a shared DevSpec room is safe by design:

- DevSpec decides on its server who may send this agent a command, and records who asked for each piece of work.
- Room chatter, other agents' messages and active plans are context for the agent, never commands.
- Mutable runtime policy is governed by [`devspec://product/remote-ingress-contract`](devspec://product/remote-ingress-contract).

---

## Working on DevSpec tasks & other workflows

Only `devspec-remote` and `devspec-remote-stop` are packaged as skills because connecting and disconnecting orchestrate local background processes and state files. Every other DevSpec workflow uses the live DevSpec MCP tools directly — just ask in plain English:

```text
Work on DevSpec task 4f2a
Work these DevSpec items in order: 4f2a, 9c1b, 2e7d
Log a DevSpec item for the login redirect bug
I just finished the caching fix — record it
What decisions or memories do we have about authentication?
```

DevSpec's web app emits these exact prompts from its copy buttons:

- **Single item or ordered batch:** When you ask Antigravity to work on one or more tasks, it calls `reserve_work_items` in the requested order, claims each item one at a time with `claim_work_item`, implements and verifies the change, tags commits with `[devspec:<id>]`, and reports completion via `record_implementation` and `record_criterion_verdicts`.
- **Shared memory:** When Antigravity learns a durable architecture fact, convention, decision, or risk, it searches and updates team memory so future sessions and teammates stay grounded.

## Implementation contract

[`devspec://product/implementation-contract`](devspec://product/implementation-contract) is the MCP-served runtime authority for work entry, tracking, claiming, and the high semantic threshold for shared session plans. This package points to that contract instead of copying its lifecycle rules into host documentation. Routine investigation remains host-native and plan-free; when the contract selects a plan, the remote skill exposes the complete `manage_plan` schema on demand through `scripts/devspec-plan.mjs --schema` rather than adding another hot skill.

**Antigravity host limitation:** Antigravity exposes no verified blocking pre-tool hook, so this plugin cannot enforce the DevSpec mutation boundary immediately before a tool call. Connecting MCP alone is not a request to mutate DevSpec; explicitly ask for DevSpec work or another DevSpec write. On that request, use the MCP-served contract and live tool schemas as the runtime authority. Attached remote connections negotiate capability-backed plan access; all active room plans arrive as advisory read-awareness, never implicit mutation authority.

---

## How it finds the right project

You rarely need to pass a project ID manually:

1. **Git remote resolution:** When you open a repository whose `origin` remote is linked to a DevSpec project, the plugin resolves the project automatically.
2. **Folder pin (`.devspec/project.json`):** For greenfield folders without a git remote yet — or when a repository is shared across multiple projects — place a pin file at `.devspec/project.json`:
   ```json
   { "project_id": "<your-project-uuid>" }
   ```
   - **Automatic pin validation (`scripts/pin-check.mjs`):** Whenever a tool writes `.devspec/project.json`, the `PostToolUse` hook validates the JSON shape immediately and tells the model how to fix any malformed key.
   - **Unlinked remote reminder (`scripts/repo-link-nudge.mjs`):** When an agent runs `git remote add origin …` or `gh repo create` inside a pinned folder, the plugin checks whether that remote is linked to the pinned project in DevSpec and nudges once if you need to add it under **Project Settings → Integrations → Repositories**.

---

## Plugin architecture & hooks

All hooks are declared in `hooks.json` (mirrored in `hooks/hooks.json`), validated against Antigravity's strict hook JSON schemas (`scripts/hook-output.mjs`), and executed via dependency-free Node.js ESM scripts in `scripts/`:

| Surface / Hook Event | File / Script | Role |
|---|---|---|
| Plugin Rules | `rules/AGENTS.md` | Automatically loaded into `<user_rules>` when the plugin is installed so `agy` has the complete DevSpec lazy MCP tool parameter quick-reference, ~6 KB spill & `view_file` rules, symmetric session-reply rules, local room-context rules, and implementation-contract rules in every project. |
| `SessionStart` | `scripts/session-start-context.mjs` → `scripts/session-start.mjs` | Auto-configures `statusLine` in `~/.gemini/antigravity-cli/settings.json`, verifies and pins MCP auth (`~/.devspec/auth.json`), auto-registers a standby connection, caches instruction rules (`scripts/instruction-rules.mjs`), starts the background poller, injects initial project grounding (`devspec-scope.mjs`), and restores active session plan instructions (`session-plan-prompts.mjs`). |
| `PreInvocation` (`UserPromptSubmit`) | `scripts/pre-invocation.mjs` → `scripts/mirror-turn.mjs` | Admits local terminal turns (`scripts/local-turn.mjs`), opens a `typed_prompt` request in `<connectionId>.requests.jsonl` (`scripts/requests.mjs`) for request-chain attribution, mirrors the user's prompt to the attached DevSpec session once per turn, surfaces lightweight unread room count / room state changes (`scripts/room-unread.mjs`), and reports connection activity (`report_pickup` / `report_keepalive`). |
| `PreToolUse` | `scripts/pre-tool-dispatch.mjs` → `scripts/devspec-tool-input.mjs` + `scripts/implementation-guard.mjs` | Mechanically stamps `connection_id`, `project_id`, `local_session_id`, `agent_name`, `provenance_ref` / `request_ref`, and local-turn `post_session_message` flags (`local_turn: true, command_turn_unbound: true`), guards multi-requester launches (`launch-guard.mjs`), verifies git commit provenance (`[devspec:<id>]` trailers and repository ancestry), and records active subagent launches (`active-subagents.mjs`). |
| `PostToolUse` | `scripts/post-tool-dispatch.mjs` | Tracks `claim_work_item` / `release_work_item` / `record_implementation` and `claim_automation_run` / `record_automation_run` state (`commit-provenance.mjs`), observes new git commits after `run_command` (`commit-observation.mjs`), validates `.devspec/project.json` edits (`pin-check.mjs`), nudges on unlinked git remotes (`repo-link-nudge.mjs`), surfaces unread room count (`room-unread.mjs`), and marks explicit session replies (`mirror-turn.mjs`). |
| `PreCompact` | `scripts/pre-compact.mjs` | Injects active connection continuity, local `.transcript.jsonl` / `.room.json` / `.rules.md` pointers, and active session plan state before context compaction. |
| `Stop` | `scripts/mirror-turn.mjs` | Holds the turn open (`decision: "block"`) if background subagents are still active or an interaction continuation is pending; otherwise symmetrically mirrors the final assistant response + work trail from `transcript.jsonl` on both remote turns and mirrored local terminal turns, completes the local turn (`local-turn.mjs`), and closes finished requests (`requests.mjs`). |
| `statusLine` | `scripts/statusline.mjs` | Renders the single-line DevSpec status bar (`DevSpec: <Codename> · <Project> · “<Session>” · automation “<name>” · working on “<title>” (<code>) · <model> (<context%>%)`) and records normalized model, effort, token, and context-window telemetry (`<connectionId>.telemetry.json`) for `heartbeat_connection`. |

### Running the test suite

```bash
# Run all unit and contract tests:
node --test scripts/*.test.mjs

# Run with live tool-name verification against a local devspecv2 checkout:
DEVSPEC_V2_ROOT=/path/to/devspecv2 node --test scripts/*.test.mjs
```

---

## How this fits with the other DevSpec plugins

Each supported coding agent has its own independent DevSpec plugin, built for its host, and all of them speak the same served contracts (`devspec://product/implementation-contract`, `devspec://product/remote-ingress-contract`).

---

## License

See [LICENSE](LICENSE).
