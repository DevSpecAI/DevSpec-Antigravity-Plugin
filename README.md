# DevSpec for Antigravity

Bring [DevSpec](https://devspec.ai) into [Antigravity](https://antigravity.google) — both the
**CLI** (`agy`) and the **desktop app**. This plugin gives Antigravity two things:

1. **A live connection to your DevSpec project** over MCP — action items, project intelligence,
   code search, memories, and commit/deployment tracking.
2. **Remote-control skills** that connect or disconnect this Antigravity conversation from the
   DevSpec Agents page.

It is the Antigravity sibling of the DevSpec plugins for Claude Code, Codex CLI, and Gemini CLI.
**All four talk to the same DevSpec MCP server** — only the per-client packaging differs.

---

## Requirements

- Antigravity CLI (`agy`) **or** the Antigravity desktop app.
- A DevSpec account, with an **account-wide MCP token**. Create one in DevSpec under
  **You → Connections** → **Connect a tool** (pick **Read & write**); it starts with `dvs_`. The
  skills resolve which project a run is for from the repo's git remote (`git remote get-url origin`),
  so one token works across every project in your account.
  - **One token, everywhere:** it's account-wide, so use the *same* token in every tool and on
    every machine — don't mint one per machine. It's now **retrievable** too: reveal and copy it
    again any time at **You → Connections** (no more show-once).
- `git` on your PATH for repo work. **Node.js 18+** is needed for **DevSpec remote control**
  (`devspec-remote`), whose local poller keeps the agent connected to the Agents page without
  burning LLM tokens while waiting for instructions.

---

## Install

This extension is built as a unified **Antigravity Plugin**, containing the skills, MCP configuration, and hooks. 

### 1. Configure your MCP token
Before installing the plugin, edit the `mcp_config.json` file at the root of this plugin directory and insert your DevSpec MCP token. 
Replace `dvs_YOUR_DEVSPEC_MCP_TOKEN` with your **account-wide** token from DevSpec → **You → Connections** → **Connect a tool** (pick **Read & write**). 
One token covers every project in your account.

### 2. Add the plugin to Antigravity
To install the plugin, simply move or copy this entire repository directory into one of Antigravity's plugin directories. Antigravity will automatically load the skills, MCP connection, and hooks.

**Workspace level (recommended)**:
Place this folder inside `.agents/plugins/` at the root of your workspace:
```bash
# E.g.
mkdir -p .agents/plugins
cp -R path/to/antigravity-devspec-autopilot-extension .agents/plugins/
```

**Global level (available in all repos)**:
Place this folder inside `~/.gemini/config/plugins/` (or your OS equivalent):
```bash
mkdir -p ~/.gemini/config/plugins
cp -R path/to/antigravity-devspec-autopilot-extension ~/.gemini/config/plugins/
```

**Marketplace / Agent install**: 
Once published, you can simply tell Antigravity to install the plugin directly from the repository URL. Antigravity will handle placing it in the correct directory.

---

## Skills

Two, and both of them are about the connection rather than the work:

| Skill | What it does |
|---|---|
| `devspec-remote` | Connect this session as a **DevSpec remote-control** target (private Agents-page channel). |
| `devspec-remote-stop` | Disconnect it again. |

**There used to be eight more, and they are gone on purpose.** A skill should be
a script — something a model would improvise badly and that can be tested.
Connecting is: resolve the project, pin the folder, register, arm the poller,
write state. The others were a page of prose each, telling a model to call one
DevSpec MCP tool it could already see.

What they taught now lives in the MCP tool schemas themselves, server-side,
written once and reaching every host the moment it changes — rather than copied
into six repositories with no way to notice when one drifts out of date.

**So ask for it instead.** With the DevSpec MCP server connected:

```
Work on DevSpec action item 4f2a
Work these in order: 4f2a, 9c1b, 2e7d
Log a DevSpec item for the login bug
I just finished the caching fix — record it
Write the commit message for 4f2a
```

DevSpec's web app emits exactly these lines from its copy buttons, so copying
and typing produce the same thing. A sentence also works in a host with no
plugin at all, which a skill name never could.

## Implementation contract

[`devspec://product/implementation-contract`](devspec://product/implementation-contract) is the
MCP-served runtime authority for work entry, tracking, claiming, and the high semantic threshold
for shared session plans. This package points to that contract instead of copying its lifecycle
rules into host documentation. Routine investigation remains host-native and plan-free; when the
contract selects a plan, the remote skill exposes the complete `manage_plan` schema on demand
through `scripts/devspec-plan.mjs --schema` rather than adding another hot skill.

**Antigravity host limitation:** Antigravity exposes no verified blocking pre-tool hook, so this
plugin cannot enforce the DevSpec mutation boundary immediately before a tool call. Connecting MCP
alone is not a request to mutate DevSpec; explicitly ask for DevSpec work or another DevSpec write.
On that request, use the MCP-served contract and live tool schemas as the runtime authority.
Attached remote connections negotiate capability-backed plan access; all active room plans arrive
as advisory read-awareness, never implicit mutation authority.

---

## How this fits with the other DevSpec plugins

DevSpec exposes one MCP server. Each editor/agent gets a thin, native wrapper:

| Client | Config file | URL key | Command format |
|---|---|---|---|
| Claude Code | `.mcp.json` | `url` | skills / slash commands |
| Codex CLI | `~/.codex/config.toml` | `url` (`http_headers`) | prompt commands |
| Gemini CLI | `gemini-extension.json` | `httpUrl` | `.toml` commands |
| **Antigravity** | `mcp_config.json` | `serverUrl` | **`SKILL.md` skills** |

The intelligence lives server-side in DevSpec; each client is just native packaging around the
same tools.

---

## Distribution

This repo is the distributable artifact. Three channels:

1. **Antigravity skill marketplace** — publish so users install with one click (CLI and desktop).
2. **Public GitHub repo** — users `git clone` this repo into `.agents/plugins/`, or ask the agent to
   install the plugin directly from the URL.
3. **Bundled** — drop this entire folder into a project's `.agents/plugins/` and commit it.

The MCP config ships with a token *placeholder*, and `.gitignore` blocks any filled-in
`mcp_config.json` from being committed.

---

## Project resolution (account-wide token)

The MCP token is account-wide and does not pin a project. The remote-control skill resolves the
current project from the repository remote, with `.devspec/project.json` as the documented folder
pin fallback. Project-scoped and item-addressed parameters remain defined by the live MCP tool
schemas. If resolution is ambiguous, the skill asks rather than guessing.

## Notes

- **Provider attribution.** The skills report completed work with `provider: "antigravity"` so
  Antigravity runs show up distinctly in the dashboard. This requires a current DevSpec server.
- **Token in config.** Use a literal token in `mcp_config.json` — the template ships a literal
  placeholder to replace. Avoid env-var interpolation like `${TOKEN}`.

---

## License

See [LICENSE](LICENSE).
