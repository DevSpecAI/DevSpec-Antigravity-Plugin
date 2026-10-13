# DevSpec for Antigravity

**Build on your team’s best thinking.**

[DevSpec](https://devspec.ai) is where your team, your knowledge, and your agents build software together — made for AI-native development from the ground up.

Bring DevSpec into [Google Antigravity CLI](https://antigravity.google) (`agy`). Once configured, `agy` connects to your DevSpec projects so you can ground on shared team memory, work tracked action items end to end, coordinate in shared rooms with plans, polls, and directed questions, and steer your local `agy` session from your browser or phone.

> **No DevSpec Launcher is installed by this plugin.** Use `agy` and its DevSpec connection skills normally. The launcher is a separate, optional browser-launch convenience with its own setup; this plugin does not bundle it, register its URL handler, or start its service. Check your [Agents settings in DevSpec](https://devspec.ai/settings/agents) for supported standalone launch targets and release availability.

---

## What you can do with it

- **⭐ Drive `agy` from your browser or phone (Remote Control).** Starting `agy` automatically registers a standby connection and starts the zero-token background poller, or run `/antigravity-devspec-autopilot-extension:devspec-remote` at any time to attach to a shared DevSpec session room. Teammates can follow along and add context in the same thread while server-verified owner and delegated commands drive the agent.
- **Two-sided live transcript & subagent-aware turns.** Local prompts and final assistant responses are mirrored automatically from Antigravity's native `transcript.jsonl` (`PreInvocation` and `Stop` hooks). When Antigravity spawns background subagents (`invoke_subagent` / `send_message`), the plugin holds the remote turn open until all active subagents finish.
- **Work a task end to end — or an ordered batch.** Point `agy` at an action item (or a list of items in order). It reserves the requested items, claims them one at a time, implements the change, runs checks, tags commits with `[devspec:<id>]`, and records implementation and criterion verdicts back to DevSpec.
- **Verified commit provenance.** Automatic `PreToolUse` and `PostToolUse` hooks observe new git commits, track `[devspec:<id>]` commit trailers against claimed work items, and guard implementation reporting against unverified commit SHAs.
- **Coordinate in the room with plans, polls, and directed questions:**
  - **Shared session plans (`devspec-plan.mjs`):** For genuinely multi-phase work, `agy` maintains a revisioned session plan visible to everyone in the room and recoverable across context compaction or reconnects.
  - **Room polls (`devspec-poll.mjs`):** Create, update, end, retract, or supersede structured room polls (with optional recommendations and write-ins) without blocking the agent turn.
  - **Directed questions (`devspec-question.mjs`):** Ask a specific person a `text`, `single_select`, or `multi_select` question in the room. When they answer or dismiss it in DevSpec, the poller delivers the canonical interaction or dismissal event and re-opens the exact continuation channel.
- **Automatic project grounding, pin checks & repo-link nudges.** Starting a session grounds `agy` with your project summary, conventions, and active work. Writing a `.devspec/project.json` pin is validated immediately, and adding a new git remote to a pinned greenfield folder nudges you once if the repository isn't linked in DevSpec yet.
- **Live status bar & runtime telemetry.** `SessionStart` automatically configures `scripts/statusline.mjs` in `~/.gemini/antigravity-cli/settings.json` to render a concise DevSpec status bar (`DevSpec: <Codename> · <Project> · “<Session>” · working on <item> · <model> (<context%>%)`) and forward model and context-window telemetry on `heartbeat_connection`.

---

## Requirements

- **Antigravity CLI (`agy`)**.
- A **[DevSpec](https://devspec.ai)** account with an **MCP token** (`read_write` scope, starting with `dvs_`).
  - Create or reveal your token any time on your [Agents settings page](https://devspec.ai/settings/agents) (**Connect a tool** → **Read & write**).
- **`git`** and **Node.js 18+** on your `PATH`. Node runs the hook scripts, capability bridges, and the zero-token background poller for remote control.

---

## Install (3 steps)

Install once at **user home**, not inside an individual project repository. `agy` resolves which DevSpec project a folder belongs to automatically from `git remote get-url origin` (or `.devspec/project.json`).

### 1. Add your DevSpec MCP token (`mcp_config.json`)

Check that Node.js 18+ is installed (`node --version`), then add the `devspec` entry to Antigravity CLI's user-level MCP configuration at `~/.gemini/antigravity-cli/mcp_config.json` (Windows: `%USERPROFILE%\.gemini\antigravity-cli\mcp_config.json`):

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

- Replace `dvs_YOUR_DEVSPEC_MCP_TOKEN` with a literal `dvs_...` token string (do not use shell variable interpolation like `${TOKEN}`).
- On first verified connection, the plugin pins your working token and URL at `~/.devspec/auth.json` (`0600`) so stale or placeholder project files never shadow it.

### 2. Clone the plugin globally

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

### 3. Start `agy`

Start `agy` in any project directory. On startup, the plugin's `SessionStart` hook automatically:
- Configures the DevSpec status bar (`statusLine`) in `~/.gemini/antigravity-cli/settings.json` (if no custom `statusLine` is already set).
- Verifies your `dvs_` token against DevSpec, registers this `agy` session on the **Agents page**, and starts the background poller (`DEVSPEC_CONNECT_AT_STARTUP=0` to opt out).
- Injects initial project grounding when the repository matches a DevSpec project.

> **Updating:** When the Agents page in DevSpec shows an **Update** badge on your Antigravity connection, run `git -C ~/.gemini/config/plugins/antigravity-devspec-autopilot-extension pull` and start a new `agy` session.

---

## ⭐ Drive a session from DevSpec (Remote Control)

Remote control lets you run a real `agy` session on your machine and steer it from the **Agents page** or a shared **Session room** in DevSpec — from your browser or phone.

### Connecting and disconnecting

| Skill | What it does |
|---|---|
| `/antigravity-devspec-autopilot-extension:devspec-remote` | Connect or attach this `agy` conversation to DevSpec (registers connection, negotiates capabilities, starts the background poller, and arms the background wait listener). |
| `/antigravity-devspec-autopilot-extension:devspec-remote-stop` | Disconnect this `agy` conversation from DevSpec and stop its poller (leaving any other active connections untouched). |

You can connect in three ways:

1. **Automatic standby on the Agents page:** Starting `agy` with a valid `dvs_` token automatically registers your session on the Agents page with a codename (e.g. `Cosmic Raven`) and starts the background poller. You can also run `/antigravity-devspec-autopilot-extension:devspec-remote` manually at any time.
2. **Attach to an existing DevSpec session:** Copy the connect command from a session's settings panel in DevSpec (or pass the session UUID) and run `/antigravity-devspec-autopilot-extension:devspec-remote --session <session-id>`.
3. **Create and attach a new session:** Run `/antigravity-devspec-autopilot-extension:devspec-remote --new` (with an optional `--title "..."`) to create a fresh shared room and attach immediately.

While waiting for instructions, a lightweight local Node poller (`scripts/devspec-remote-poll.mjs`) holds the long-poll connection to DevSpec and streams wake events through `scripts/devspec-remote-wait.mjs` — **zero LLM tokens are spent while idle**.

### Shared session plans, room polls, and directed questions

When connected to a DevSpec session, Antigravity negotiates per-connection capabilities (stored in mode-`0600` private state under `~/.devspec/remote-control/connections/`) and exposes three capability-injected CLI bridges:

- **Shared Session Plans (`scripts/devspec-plan.mjs`):**
  - Routine read-only investigation and quick answers stay plan-free.
  - When work involves material multi-phase execution, the agent discovers the schema on demand (`node scripts/devspec-plan.mjs --schema`) and manages one revisioned room plan (`create`, `advance`, `update`, `complete`, `abandon`, `adopt`).
  - If context is compacted or a session reconnects, `session-start-context.mjs` and `session-plan-prompts.mjs` automatically inject the active plan state so the agent can resume seamlessly.
- **Room Polls (`scripts/devspec-poll.mjs`):**
  - Non-blocking structured polls for the room (`create`, `list`, `get`, `update`, `end`, `retract`, `supersede`), supporting single or multi-select options, `allow_write_in`, `recommendation_index`, and poll series.
- **Directed Questions (`scripts/devspec-question.mjs`):**
  - Ask a specific room participant a `text`, `single_select`, or `multi_select` question (`create`, `list`, `get`, `cancel`, `status`, `respond`).
  - Unless `--keep-turn` is passed, creating a pending question cleanly ends the current turn while the room waits for the person's response.
  - When the person answers or dismisses the question in DevSpec, the poller validates the canonical v1 interaction or dismissal event (`interaction-events.mjs`, `question-dismissal-events.mjs`), claims the exact continuation attempt, and wakes the agent to finish its reply via `devspec-question.mjs respond`.

### Who can talk to it

Collaboration in a shared DevSpec room is safe by design:

- DevSpec determines owner and delegated command authority and exact `@`-addressing on the server (`ingress_version: 1`, `delegated_scope_version: 1`, `active_plan_projection_version: 1`).
- Delegated commands carry a server-owned project scope object and instruction; owner commands carry `null` scope.
- Room chatter, other agents' messages, and projected active plans arrive as non-executable advisory context (`read-awareness only`), never as implicit commands or mutation authority.
- Mutable runtime policy is governed by [`devspec://product/remote-ingress-contract`](devspec://product/remote-ingress-contract).

---

## Working on DevSpec tasks & other workflows

Only `devspec-remote` and `devspec-remote-stop` are packaged as skills because connecting and disconnecting orchestrate local background processes and state files. Every other DevSpec workflow uses the live DevSpec MCP tools directly — just ask in plain English:

```text
Work on DevSpec action item 4f2a
Work these DevSpec items in order: 4f2a, 9c1b, 2e7d
Log a DevSpec item for the login redirect bug
I just finished the caching fix — record it
What decisions or memories do we have about authentication?
```

DevSpec's web app emits these exact prompts from its copy buttons:

- **Single item or ordered batch:** When you ask Antigravity to work on one or more action items, it calls `reserve_work_items` in the requested order, claims each item one at a time with `claim_work_item`, implements and verifies the change, tags commits with `[devspec:<id>]`, and reports completion via `record_implementation` and `record_criterion_verdicts`.
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

## Plugin architecture & hooks (`v0.14.0`)

All hooks are declared in `hooks/hooks.json` (mirrored in root `hooks.json`) and executed via dependency-free Node.js ESM scripts in `scripts/`:

| Hook Event | Script | Role |
|---|---|---|
| `SessionStart` | `scripts/session-start-context.mjs` → `scripts/session-start.mjs` | Auto-configures `statusLine` in `~/.gemini/antigravity-cli/settings.json`, verifies and pins MCP auth (`~/.devspec/auth.json`), auto-registers a standby connection and starts the background poller, injects initial project grounding (`devspec-scope.mjs`), and restores active session plan instructions (`session-plan-prompts.mjs`) after compaction or resume. |
| `PreInvocation` (`UserPromptSubmit`) | `scripts/pre-invocation.mjs` → `scripts/mirror-turn.mjs` | Mirrors the user's prompt to the attached DevSpec session once per turn and reports connection activity (`report_pickup` / `report_keepalive`). |
| `PreToolUse` | `scripts/pre-tool-dispatch.mjs` → `scripts/implementation-guard.mjs` | Verifies git commit provenance (`[devspec:<id>]` trailers and repository ancestry) before `record_implementation` or `add_commit_reference` calls, and records active subagent launches (`active-subagents.mjs`). |
| `PostToolUse` | `scripts/post-tool-dispatch.mjs` | Tracks `claim_work_item` / `release_work_item` / `record_implementation` state (`commit-provenance.mjs`), observes new git commits after `run_command` (`commit-observation.mjs`), validates `.devspec/project.json` edits (`pin-check.mjs`), nudges on unlinked git remotes (`repo-link-nudge.mjs`), and marks explicit session replies (`mirror-turn.mjs`). |
| `Stop` | `scripts/mirror-turn.mjs` | Holds the turn open if background subagents are still active or an interaction continuation is pending; otherwise mirrors the final assistant response from `transcript.jsonl` and closes the activity turn (`report_complete`). |
| `statusLine` | `scripts/statusline.mjs` | Renders the single-line DevSpec status bar (`DevSpec: not configured` when missing a `dvs_` token) and records normalized model, effort, token, and context-window telemetry (`<connectionId>.telemetry.json`) for `heartbeat_connection`. |

### Running the test suite

```bash
# Run all unit and contract tests:
node --test scripts/*.test.mjs

# Run with live tool-name verification against a local devspecv2 checkout:
DEVSPEC_V2_ROOT=/path/to/devspecv2 node --test scripts/*.test.mjs
```

---

## How this fits with the other DevSpec plugins

Each coding agent has its own independent plugin repository tailored to its host runtime, speaking the same canonical contracts (`devspec://product/implementation-contract`, `devspec://product/remote-ingress-contract`, `devspec://product/interaction-event-contract`, and `devspec://product/question-dismissal-event-contract`):

| Host | Config / Install | Remote Transport Family |
|---|---|---|
| **Antigravity CLI** (`agy`) | `~/.gemini/antigravity-cli/mcp_config.json` + `~/.gemini/config/plugins/antigravity-devspec-autopilot-extension` | Local poller + wait stream + native `transcript.jsonl` hooks |
| **Claude Code** | `/plugin install devspec@devspec` | Local poller + persistent monitor + Claude hooks |
| **Pi** | `pi install git:github.com/DevSpecAI/DevSpec-Pi` | In-process TypeScript extension + embedded MCP transport |
| **Codex CLI** | `~/.codex/config.toml` | Local poller + app-server bridge |
| **Gemini CLI** | `gemini-extension.json` | Local poller + `.toml` commands |

---

## License

See [LICENSE](LICENSE).
