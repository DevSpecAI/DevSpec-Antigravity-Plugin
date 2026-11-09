# DevSpec for Antigravity CLI

**Build on your team's best thinking.** [DevSpec](https://devspec.ai) is where your team, your shared knowledge, and your coding agents build software together.

Connect [Google Antigravity CLI](https://antigravity.google/product/antigravity-cli) (`agy`) to DevSpec to give your terminal durable project memory, structured task execution, automatic commit provenance, and live remote steering from your phone or browser.

> **Note:** DevSpec connects to **Antigravity CLI** (`agy` in your terminal), not the Antigravity IDE.

## Why DevSpec + Antigravity CLI?

- **Shared team memory with automatic staleness screening** — Antigravity recalls the architectural decisions, conventions, risks, and reference docs that apply to the code it's touching. When you record a new decision or land changes, DevSpec screens your project's records for conflicts, duplicates, and **Possibly outdated** guidance so your team's shared memory stays accurate.
- **Steer `agy` live from your phone or the web** — Run `/devspec-remote` to register your terminal on your project's **Agents** page outside any session room, or pass `--new` or `--session <id>` (or attach from [devspec.ai](https://devspec.ai)) to collaborate in a shared session room, answer structured agent questions and polls, and track multi-phase execution plans in real time. Sitting idle on the **Agents** page uses no tokens — `agy` runs only when you or an authorized teammate asks it to do something, when your project routes a check on a change for it to rule, or when an automation you opted into runs.
- **Tasks, observed verification, and automatic commit provenance** — Claim tasks with full project context. When a single task is claimed in a linked project repository (including Git worktrees) or a `.devspec/project.json`-pinned folder, the plugin tags your commits (`[devspec:<id>]`) automatically, links pull requests, and records observed verification evidence from checks `agy` actually ran against each acceptance criterion.
- **Protected intent, pull-request checks, and Merge when cleared** — Every change is delivered on its own branch via a pull request into the repository's tracking branch wherever pull requests are supported (`core.push-safely` in `devspec://product/implementation-contract`), with DevSpec's Merge when cleared (`record_implementation` with `merge_when_cleared: true`) merging automatically once DevSpec's check and all GitHub checks/approvals pass (or waking the agent with a `pr_ready_to_merge` system notice to merge that cleared commit with the owner's GitHub credentials when the GitHub App installation lacks merge write permissions). DevSpec screens changes against your team's recorded decisions, requirements, and open tasks, holds reversals of someone else's decision and unagreed experiments on their own branch until approved, and publishes its pull-request check on GitHub to reflect pending checks and holds.

## Requirements

- **[Antigravity CLI](https://antigravity.google/download#antigravity-cli)** (`agy`)
- **Node.js 18 or later** (`node --version` — install from [nodejs.org](https://nodejs.org/en/download) if needed) and **`git`** on your `PATH`
- A **[DevSpec](https://devspec.ai)** account. You approve Antigravity in your browser.

Full commit tracking — every commit reported to DevSpec and tagged with its task automatically — needs macOS, Linux, or Windows through WSL. On native Windows, Antigravity falls back to the simpler check that reads the command, which catches single-line commits only, in the project's repositories (an `origin` the project tracks, or a `.devspec/project.json` pin).

## Setup

### 1. Install Antigravity CLI

If you haven't installed Antigravity CLI (`agy`) yet:

**macOS / Linux:**

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash
```

**Windows (PowerShell):**

```powershell
irm https://antigravity.google/cli/install.ps1 | iex
```

### 2. Install the DevSpec plugin

In your terminal (macOS, Linux, or Windows), run:

```bash
agy plugin install https://github.com/DevSpecAI/DevSpec-Antigravity-Plugin
```

The plugin brings everything: DevSpec's tools (it connects Antigravity to `https://api.devspec.ai/api/mcp` itself, so there is no settings file to edit), `rules/AGENTS.md`, the `/devspec-remote`, `/devspec-remote-stop`, `/devspec-project` and `/devspec-login` skills, the status bar (`DevSpec: local (/devspec-remote to connect) · <Project>`), and the hooks that let you steer `agy` from DevSpec.

<details>
<summary>Prefer cloning straight with Git?</summary>

**macOS / Linux:**

```bash
mkdir -p ~/.gemini/config/plugins
git clone https://github.com/DevSpecAI/DevSpec-Antigravity-Plugin.git \
  ~/.gemini/config/plugins/devspec
```

**Windows (PowerShell):**

```powershell
New-Item -ItemType Directory -Force "$HOME\.gemini\config\plugins" | Out-Null
git clone https://github.com/DevSpecAI/DevSpec-Antigravity-Plugin.git "$HOME\.gemini\config\plugins\devspec"
```

</details>

### 3. Approve Antigravity in your browser

Start `agy` and run `/devspec-login` (or approve the DevSpec browser tab that opens automatically at startup):

```text
/devspec-login
```

Click **Allow** on DevSpec's approval page naming **Antigravity**, then restart `agy` so DevSpec's tools, your status bar, and your agent connection load cleanly. Over SSH, or on any machine your browser cannot reach, run `/devspec-login --code` and paste back the code DevSpec's page shows.

One approval covers everything in Antigravity — DevSpec's tools, remote control, commit tracking, and the session hooks — and appears as one **Antigravity** entry on DevSpec's [Agent setup](https://app.devspec.ai/settings/agents) page. You stay signed in across all open Antigravity windows until you sign out or disconnect Antigravity on Agent setup. If your sign-in stops working, the status bar and DevSpec's tools say so plainly and tell you to run `/devspec-login`.

### 4. Optional — recommended for phone and voice control: skip permission prompts

By default, Antigravity CLI pauses in the terminal and waits for your approval before editing files or running commands. When you are driving `agy` remotely from your phone or by voice, starting it with `--dangerously-skip-permissions` keeps work from stalling at your computer while built-in AI safety protections remain in place:

```bash
agy --dangerously-skip-permissions
```

You can also run plain `agy` when working at your desk.

### 5. Start Antigravity CLI and connect to your project

- **Inside a linked repository:** Start `agy` (or `agy --dangerously-skip-permissions`) in the folder where you cloned the Git repository linked to your DevSpec project. It matches that project automatically.
- **In any other folder, or when switching projects:** Start `agy` and run `/devspec-project` to choose which project this conversation belongs to.
- **Remote control from phone or web:** Run `/devspec-remote` inside `agy` to put this terminal on your project's **Agents** page outside any session room, or pass `--new` or `--session <id>` (or attach from [devspec.ai](https://devspec.ai)) to join a session room (and run `/devspec-remote-stop` when you're done).

### Upgrading from a version that used a token

Earlier versions asked you to paste a DevSpec token into Antigravity's settings. The plugin now brings its own connection, so remove the old one or Antigravity lists DevSpec twice:

```bash
agy mcp remove devspec
```

Then restart `agy` and approve Antigravity as in step 3. You can revoke the old token under **Access tokens** on DevSpec's [Agent setup](https://app.devspec.ai/settings/agents) page.

### Machines with no browser

On a CI runner or cloud worker, set `DEVSPEC_MCP_TOKEN` to an access token from Agent setup (and `DEVSPEC_MCP_URL` if it is not `https://api.devspec.ai/api/mcp`). Remote control and commit tracking then use it instead of a browser sign-in. Set it only where there is no browser: while it is set, it takes precedence, and `/devspec-login` tells you how to remove it.

## Commands

Everything in DevSpec can be asked in plain words ("Work on DevSpec task 4f2a", "Work these DevSpec tasks in order: 4f2a, 9c1b", "Create a task for the login redirect bug", "What did we decide about caching?"). The plugin also adds these slash commands in `agy`:

| Command | What it does |
|---|---|
| `/devspec-remote` | Registers this `agy` conversation on the **Agents** page outside any session room so you can steer it from the web or your phone. |
| `/devspec-remote --project "Client Website"` | Connects and selects a project for this conversation without changing the folder default. |
| `/devspec-remote --session <id>` | Connects and joins an existing DevSpec session room. |
| `/devspec-remote --new` | Creates a new shared DevSpec session room and joins it (`--new --private` creates a private session). |
| `/devspec-remote --name "Night Owl"` | Connects using a custom agent codename. |
| `/devspec-remote-stop` | Disconnects this conversation from DevSpec while leaving other `agy` terminals running. |
| `/devspec-project` | Shows the current project and folder default, or lets you `choose`, `remember`, or `forget` a project. |
| `/devspec-login` | Signs Antigravity in to DevSpec through your browser (`--code` on a machine your browser cannot reach, `--status` to check, `--logout` to sign out). |

## Choosing and remembering a project

When a repository belongs to more than one DevSpec project, or you open `agy` in a folder without a Git remote, use `/devspec-project`:

- `/devspec-project` (or `/devspec-project status`) shows the selected project, organization, full project ID, how it was selected, and any folder default.
- `/devspec-project choose` selects a project for this conversation. Switching away from a project you have already been working in starts a fresh `agy` conversation so context from one project never leaks into another.
- `/devspec-project remember` saves the current project to `.devspec/project.json` in the folder after showing the file path and asking for confirmation.
- `/devspec-project forget` removes the `.devspec/project.json` folder default after confirmation without disconnecting active conversations.

## Updating

To update the plugin to the latest version, re-run the install command (or pull in the plugin directory) and start a new `agy` session:

```bash
agy plugin install https://github.com/DevSpecAI/DevSpec-Antigravity-Plugin
```

(Or run `git -C ~/.gemini/config/plugins/devspec pull`.)

Release notes are in [CHANGELOG.md](./CHANGELOG.md).

## License

See [LICENSE](LICENSE).
