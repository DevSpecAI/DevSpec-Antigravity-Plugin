# DevSpec for Antigravity CLI

Connect [Google Antigravity CLI](https://antigravity.google/product/antigravity-cli) (`agy`) to [DevSpec](https://devspec.ai). Once configured, `agy` connects to your DevSpec project so you can work from your project's tasks, decisions, and documents, coordinate in shared session rooms, and steer your local `agy` terminal from your phone or the web.

> **Note:** DevSpec connects to **Antigravity CLI** (`agy` in your terminal), not the Antigravity IDE.

## Requirements

- **[Antigravity CLI](https://antigravity.google/download#antigravity-cli)** (`agy`)
- **Node.js 18 or later** (`node --version` — install from [nodejs.org](https://nodejs.org/en/download) if needed) and **`git`** on your `PATH`
- A **[DevSpec](https://devspec.ai)** access token (`dvs_…`) with **Read & write** access from your [Agent setup](https://app.devspec.ai/settings/agents) page

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

### 2. Add your DevSpec token to `mcp_config.json`

Open `~/.gemini/config/mcp_config.json` (`%USERPROFILE%\.gemini\config\mcp_config.json` on Windows) in a text editor and merge in the `devspec` entry with your `dvs_…` token from [Agent setup](https://app.devspec.ai/settings/agents):

```json
{
  "mcpServers": {
    "devspec": {
      "type": "http",
      "serverUrl": "https://api.devspec.ai/api/mcp",
      "headers": {
        "Authorization": "Bearer dvs_YOUR_DEVSPEC_MCP_TOKEN"
      }
    }
  }
}
```

On macOS and Linux, make the folder and file readable only by you:

```bash
chmod 700 ~/.gemini/config && chmod 600 ~/.gemini/config/mcp_config.json
```

> Do not use `agy mcp add --header "Authorization: Bearer …"` — passing your token on a command line exposes it to other accounts on the machine and records it in shell history.

### 3. Install the DevSpec plugin

**Installing the plugin is required alongside the MCP server.** It supplies `rules/AGENTS.md`, the `/devspec-remote`, `/devspec-remote-stop`, and `/devspec-project` skills, the status bar (`DevSpec: local (/devspec-remote to connect) · <Project>`), and the connection hooks that let you steer `agy` from DevSpec.

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

### 4. Optional — recommended for phone and voice control: skip permission prompts

By default, Antigravity CLI pauses in the terminal and waits for your approval before editing files or running commands. When you are driving `agy` remotely from your phone or by voice, starting it with `--dangerously-skip-permissions` keeps work from stalling at your computer while built-in AI safety protections remain in place:

```bash
agy --dangerously-skip-permissions
```

You can also run plain `agy` when working at your desk.

### 5. Start Antigravity CLI and connect to your project

- **Inside a linked repository:** Start `agy` (or `agy --dangerously-skip-permissions`) in the folder where you cloned the Git repository linked to your DevSpec project. It matches that project automatically.
- **In any other folder, or when switching projects:** Start `agy` and run `/devspec-project` to choose which project this conversation belongs to.
- **Remote control from phone or web:** Run `/devspec-remote` inside `agy` to put this terminal on your project's **Agents** page or attach it to a session room (and run `/devspec-remote-stop` when you're done).

## Commands

Everything in DevSpec can be asked in plain words ("Work on DevSpec task 4f2a", "Work these DevSpec tasks in order: 4f2a, 9c1b", "Create a task for the login redirect bug", "What did we decide about caching?"). The plugin also adds three slash commands in `agy`:

| Command | What it does |
|---|---|
| `/devspec-remote` | Registers this `agy` conversation on the **Agents** page so you can steer it from the web or your phone. |
| `/devspec-remote --project "Client Website"` | Connects and selects a project for this conversation without changing the folder default. |
| `/devspec-remote --session <id>` | Connects and joins an existing DevSpec session. |
| `/devspec-remote --new` | Creates a new shared DevSpec session and joins it (`--new --private` creates a private session). |
| `/devspec-remote-stop` | Disconnects this conversation from DevSpec while leaving other `agy` terminals running. |
| `/devspec-project` | Shows the current project and folder default, or lets you `choose`, `remember`, or `forget` a project. |

## Choosing and remembering a project

When a repository belongs to more than one DevSpec project, or you open `agy` in a folder without a Git remote, use `/devspec-project`:

- `/devspec-project` (or `/devspec-project status`) shows the selected project, organization, full project ID, how it was selected, and any folder default.
- `/devspec-project choose` selects a project for this conversation. Switching away from a project you have already been working in starts a fresh `agy` conversation so context from one project never leaks into another.
- `/devspec-project remember` saves the current project to `.devspec/project.json` in the folder after showing the file path and asking for confirmation.
- `/devspec-project forget` removes the `.devspec/project.json` folder default after confirmation without disconnecting active conversations.

## Updating

To update the plugin to the latest version, pull in the plugin directory and start a new `agy` session:

```bash
git -C ~/.gemini/config/plugins/devspec pull
```

Release notes are in [CHANGELOG.md](./CHANGELOG.md).

## License

See [LICENSE](LICENSE).
