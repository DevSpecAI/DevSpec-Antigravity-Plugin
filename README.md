# DevSpec for Antigravity

Bring [DevSpec](https://devspec.ai) into [Antigravity](https://antigravity.google) — both the
**CLI** (`agy`) and the **desktop app**. This plugin gives Antigravity two things:

1. **A live connection to your DevSpec project** over MCP — action items, the autopilot queue,
   project intelligence, code search, memories, and commit/deployment tracking.
2. **Ten skills** that turn that connection into one-shot workflows: run the autopilot queue,
   pick up and implement an action item, log finished work, create items, commit with deployment
   tracking, and more.

It is the Antigravity sibling of the DevSpec plugins for Claude Code, Codex CLI, and Gemini CLI.
**All four talk to the same DevSpec MCP server** — only the per-client packaging differs.

---

## Requirements

- Antigravity CLI (`agy`) **or** the Antigravity desktop app.
- A DevSpec account and project, with an MCP/autopilot token (DevSpec → **Settings → Autopilot**).
- `git` and `node` on your PATH (the autopilot/work skills use `git` worktrees and small
  cross-platform `node` one-liners for logging).

---

## Install

There are **two independent pieces**: the MCP connection (required) and the skills (the commands).

### 1. Connect the DevSpec MCP server  *(required)*

The skills are thin wrappers — they call DevSpec MCP tools. Without the server connected, nothing
works. Antigravity uses the `serverUrl` key (note: Claude Code and Codex use `url`/`http_headers`
instead — same server, different client schema).

Start from [`mcp/devspec.mcp.json`](mcp/devspec.mcp.json):

```json
{
  "mcpServers": {
    "devspec": {
      "type": "http",
      "serverUrl": "https://devspec.ai/api/mcp",
      "headers": { "Authorization": "Bearer dvs_YOUR_DEVSPEC_MCP_TOKEN" }
    }
  }
}
```

- Replace `dvs_YOUR_DEVSPEC_MCP_TOKEN` with your token from DevSpec → **Settings → Autopilot**.
- Replace the host if your DevSpec instance lives elsewhere.

**Antigravity CLI** — merge that `devspec` block into `~/.gemini/antigravity-cli/mcp_config.json`,
then run `/mcp` to confirm it connected.

**Antigravity desktop app** — **Settings → MCP → Add server**, choose HTTP, paste the `serverUrl`
and the `Authorization: Bearer …` header.

### 2. Install the skills

**Workspace** (recommended — scoped to one repo, travels with it):

```bash
./scripts/install.sh                  # installs into ./.agents/skills
./scripts/install.sh --workspace /path/to/repo
```
```powershell
./scripts/install.ps1                 # Windows
```

This copies each skill into `.agents/skills/<name>/`. Antigravity (CLI and desktop) discovers
`SKILL.md` skills there automatically.

**Global** (available in every repo):

```bash
./scripts/install.sh --global         # ~/.gemini/antigravity/skills
```

**Marketplace / agent install** — Antigravity has a built-in skill marketplace, and the agent can
install skills straight from a public repo. Once this repo is published you can simply tell
Antigravity: *"Install the DevSpec skills from `<repo-url>`."* See **Distribution** below.

---

## Skills

| Skill | What it does |
|---|---|
| `devspec-autopilot` | Autonomously process the queue: claim → implement in an isolated worktree → push/merge → report. Handles queued, review, and planning items. |
| `devspec-work` | Pick up a named/ID'd item, optionally brainstorm, implement, push/merge, record the implementation. `--unattended` for fire-and-forget. |
| `devspec-done` | Log work you already finished — infers title, summary, testing notes, and commits from git history. |
| `devspec-commit` | Generate a `[devspec:<id>]` deployment-tracked commit message and commit staged changes. |
| `devspec-create` | Create an action item (bug/feature/improvement/task/query) from the terminal. |
| `devspec-brainstorm` | Interactively refine an item's scope, edge cases, and approach, then save the summary. |
| `devspec-link` | Link an existing commit (or `HEAD`) to an action item for traceability. |
| `devspec-verify-connection` | Prove the setup connection loop: push a tagged `[devspec-verify:<id>]` commit to each tracked repo's primary branch and report per-repo via `report_connection_check`. |
| `autopilot-status` | Compact panel: queued / in-progress counts and push/merge settings. |
| `autopilot-history` | Recent completed/failed items from the DevSpec API. |
| `autopilot-log` | Local run log from `~/.devspec/execution-history.jsonl` (offline; written by autopilot/work). |

`devspec-autopilot` and `devspec-work` bundle a `reference.md` (the full DevSpec MCP tool reference,
shell-safety rules, local-storage schema, and worktree details) loaded on demand. The other eight
are self-contained.

---

## How this fits with the other DevSpec plugins

DevSpec exposes one MCP server. Each editor/agent gets a thin, native wrapper:

| Client | Config file | URL key | Command format |
|---|---|---|---|
| Claude Code | `.mcp.json` | `url` | skills / slash commands |
| Codex CLI | `~/.codex/config.toml` | `url` (`http_headers`) | prompt commands |
| Gemini CLI | `gemini-extension.json` | `httpUrl` | `.toml` commands |
| **Antigravity** | `mcp_config.json` | `serverUrl` | **`SKILL.md` skills** |

The intelligence lives server-side in DevSpec. This repo is just the Antigravity packaging, so it
stays small and tracks the others' behaviour.

---

## Distribution

This repo is the distributable artifact. Three channels:

1. **Antigravity skill marketplace** — publish so users install with one click (CLI and desktop).
2. **Public GitHub repo** — users `git clone` + run `scripts/install.sh`, or ask the agent to
   install directly from the URL.
3. **Bundled** — drop the `skills/` folder into a project's `.agents/skills/` and commit it.

The repo contains **no secrets**: the MCP config ships with a token *placeholder*, and `.gitignore`
blocks any filled-in `mcp_config.json` from being committed.

---

## Known follow-ups

- **Provider attribution.** The skills report completed work with `provider: "antigravity"` so
  Antigravity runs show up distinctly in the dashboard. That value must exist in the DevSpec MCP
  server's provider enum (`lib/mcp/tool-definitions.ts`) — make sure the running server is on a
  build that includes it, or completion calls will fail validation.
- **Env-var interpolation** (`${TOKEN}`) in Antigravity's `mcp_config.json` is unverified — the
  template uses a literal token placeholder, which always works.

---

## License

See [LICENSE](LICENSE).
