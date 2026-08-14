---
name: devspec-create
description: "Create a new DevSpec action item (bug, feature, improvement, task, or query) from the terminal. Supports --unattended. Use when asked to create, file, or add an action item in DevSpec."
---

Create a new DevSpec action item from inside Antigravity without leaving the terminal. This command calls the `create_action_item` MCP tool; its parameter schema is provided by the `devspec` MCP server.

The `devspec` MCP tools are self-describing — call them by name. Shell Safety rules for any terminal echo are summarized at the end of this skill.

## Detect mode

Check the user's input for `--unattended`, `unattended`, or `no interruptions`. Store as boolean `is_unattended`.

- **Unattended mode** — infer any missing fields from the provided input; never prompt the user. If a required field cannot be inferred, fail with a clear error rather than guessing.
- **Interactive mode** — ask for any field not provided on the command line, one question at a time. Keep prompts terse.

## Gather fields

Collect the following fields for `create_action_item`. Ask in this order; accept the first answer and move on.

### 1. `title` (required)

Extract from the command input if the user wrote the title directly (e.g. `/devspec:create "Fix login timeout on mobile"`). If absent and in interactive mode, ask: `Title:` and read a one-line response. If absent in unattended mode, fail with `✗ --title is required in unattended mode`.

Trim whitespace. Reject empty strings. No length limit enforced client-side — the server rejects titles that are too long.

### 2. `description` (optional)

In interactive mode: `Description (optional, press enter to skip):`. Accept multi-line input ending on a blank line, or a single line. Skip entirely if the user sends no input.

In unattended mode: use the `--description` flag value if present, otherwise leave the field unset (the server defaults to null).

### 3. `type` (optional, defaults to "task")

Enum: `bug`, `feature`, `improvement`, `task`, `query`.

**Inference rules** (apply when the user does not explicitly state a type):
- Title/description mentions "fix", "bug", "broken", "doesn't work", "error" → `bug`
- Title/description mentions "add", "new", "build", "support for", "integrate" → `feature`
- Title/description mentions "improve", "refactor", "clean up", "optimize", "simplify" → `improvement`
- Title/description is a question ("why does…", "how should…", "what about…") → `query`
- Otherwise → `task`

In interactive mode, after inferring, confirm once: `Type: {inferred} — press enter to accept or type a different type (bug/feature/improvement/task/query):`. Accept the inferred value on empty input.

In unattended mode, use the inference without confirmation.

### 4. `suggest_human_only` (optional, defaults to unset)

Any open item can be staged for autopilot or handed to an agent — the act of staging is the readiness decision. The one exception is pure off-platform work no agent could ever do. For those items pass `suggest_human_only: true`; it is a suggestion a human confirms in DevSpec, and confirmed human-only items are never picked up by agents.

**When to pass `suggest_human_only: true`** — the work happens entirely off-platform:
- Calling or emailing an external party (lawyer, vendor, stakeholder)
- Purchasing something (a domain, a license)
- External dashboard work an agent has no access to (Stripe dashboard, DNS records, vendor onboarding)

**Everything else needs no flag** — research queries, ambiguous scope, infrastructure or security-sensitive changes are all stageable; whether an agent runs them is decided when a human stages them.

In interactive mode, ask `Suggest human-only (y/N)?` only when the work looks plainly off-platform. Default to `N` on empty input.

In unattended mode: set to true if `--human-only` is in the input, otherwise leave unset.

## Validate

Before calling the MCP tool:

- `title` must be non-empty after trimming.
- `type` (if set) must be one of the enum values.
- `suggest_human_only` (if set) must be a boolean.

On validation failure, output `✗ Invalid {field}: {reason}` and stop. Do NOT attempt to create a partial or malformed item.

## Resolve the project (account-wide token)

Your DevSpec MCP token is **account-wide** — it is not pinned to one project, so the new item needs an explicit `project_id`. Resolve it from the git remote of the current repo before creating:

- `git remote get-url origin` → `remote_url`.
- Call `list_projects({ git_remote: "<remote_url>" })` and read `remote_match.resolved_project_id` → `project_id`.
  - **Resolved** → use it as `project_id` on the create call below.
  - **No remote, or no match** → if `.devspec/project.json` exists, pass its `project_id` as `pinned_project_id` on the create call instead. **Folder pin — a project with no repo yet.** Whether or not there is a remote, read `.devspec/project.json` in the workspace root if it exists; it holds `{ "project_id": "<uuid>" }`. That is how a folder whose code does not exist yet names its project. Pass it as **`pinned_project_id`**, NEVER as `project_id`: `project_id` is an explicit override that outranks a verified git remote, whereas the pin is only a local assertion the server deliberately ranks BELOW a remote it can verify — so sending it as `project_id` reverses that. Send `git_remote` when you have one, `pinned_project_id` when you have one, both when you have both, and let the server arbitrate. **Never decide precedence locally.**
  - **null with `candidate_project_ids`** (repo tracked by >1 project): in interactive mode, ask the user which project; in unattended mode, fail with `✗ This repo is tracked by multiple DevSpec projects — pass the project explicitly or detach the duplicates.` and stop.
  - **no match** (or no `origin` remote): if the user's account has exactly one project the server resolves it without a hint — call `list_projects()` (no `git_remote`); if it returns exactly one project, use that `project_id`. Otherwise, in interactive mode ask which project; in unattended mode fail with `✗ Cannot resolve which DevSpec project to create the item in.` and stop.

## Create the item

Call `create_action_item` with `project_id` (from the previous step) plus the gathered fields. Pass `suggest_human_only: true` only for plainly off-platform work — omitting the field is the norm.

If the call fails:
- `401 Unauthorized` → output `✗ Authentication failed. Regenerate your token in DevSpec: Settings > Autopilot.` and stop.
- `422 Unprocessable Entity` → output `✗ Create failed: <server error message>` and stop.
- `500 Internal Server Error` → retry once. If it still fails, output `✗ Create failed: server error` and stop.

## Confirm

On success, the tool returns the created item including its `id`. Output:

```
✓ Created: {title} ({type}) [ID: {first 8 chars of id}]
```

If `suggest_human_only` is true, append a second line:

```
→ Suggested as human-only (a human confirms in DevSpec). Agents never pick up confirmed human-only items.
```

Otherwise, append:

```
→ Added as an open item. Stage it in DevSpec when it's ready for an agent to pick up.
```

## Shell Safety

Every shell-adjacent value (title, description) must be sanitized before it is echoed into any shell command:
- Rule 4: before embedding in any command or log line, escape `'` → `'\\''`, strip `$ ` `` ` `` ` # \\ | & < >`, truncate to 500 chars.
- Rule 1: wrap interpolated values in single quotes.
- Never echo unsanitized user input to shell commands.

The MCP tool call itself passes values as structured JSON (no shell interpolation), so the main shell-safety concern is the confirmation output and any echo of the user's title/description back to the terminal.

## Rules

- One question at a time in interactive mode. Do NOT dump a 5-field form; ask one at a time.
- In unattended mode, never prompt the user. Infer or fail cleanly.
- Trim whitespace from every user-provided field.
- Only suggest human-only for plainly off-platform work; everything else needs no flag.
- Confirm in one line. No multi-line success banners.
- If the user interrupts mid-question in interactive mode, exit cleanly without creating a partial item.
