---
name: devspec-create
description: "Create a new DevSpec action item (bug, feature, improvement, task, or query) from the terminal. Use when asked to create, file, or add an action item in DevSpec."
---

Create a new DevSpec action item from inside Antigravity without leaving the terminal. This command calls the `create_action_item` MCP tool; its parameter schema is provided by the `devspec` MCP server.

The `devspec` MCP tools are self-describing — call them by name. Shell Safety rules for any terminal echo are summarized at the end of this skill.

## How much to ask

There is no mode. `--unattended` is gone, along with the attended/unattended split it belonged to: work the input you were given, infer what you can, and ask ONLY for what is genuinely missing — one terse question at a time. A title you were handed is not a question; a title you were not handed is.

If a question has no one to answer it (a scripted or scheduled invocation), the answer is to fail with a clear error rather than guess. That is a property of the situation, not a flag the caller sets.

## Gather fields

Collect the following fields for `create_action_item`. Ask in this order; accept the first answer and move on.

### 1. `title` (required)

Extract from the command input if the user wrote the title directly (e.g. `/devspec:create "Fix login timeout on mobile"`). If absent, ask: `Title:` and read a one-line response — and if nobody answers, fail with `✗ A title is required` rather than inventing one.

Trim whitespace. Reject empty strings. No length limit enforced client-side — the server rejects titles that are too long.

### 2. `description` (optional)

Use the `--description` value if the input carried one. Otherwise ask `Description (optional, press enter to skip):`, accepting multi-line input ending on a blank line or a single line, and leave the field unset if nothing comes back (the server defaults to null).

### 3. `type` (optional, defaults to "task")

Enum: `bug`, `feature`, `improvement`, `task`, `query`.

**Inference rules** (apply when the user does not explicitly state a type):
- Title/description mentions "fix", "bug", "broken", "doesn't work", "error" → `bug`
- Title/description mentions "add", "new", "build", "support for", "integrate" → `feature`
- Title/description mentions "improve", "refactor", "clean up", "optimize", "simplify" → `improvement`
- Title/description is a question ("why does…", "how should…", "what about…") → `query`
- Otherwise → `task`

Confirm the inference once, if there is someone to confirm it: `Type: {inferred} — press enter to accept or type a different type (bug/feature/improvement/task/query):`. Accept the inferred value on empty input, and on no input at all.

### 4. `suggest_human_only` (optional, defaults to unset)

Any open item can be worked by an agent — nothing is staged or handed out, an agent reserves what it was asked to work on. The one exception is pure off-platform work no agent could ever do. For those items pass `suggest_human_only: true`; it is a suggestion a human confirms in DevSpec, and confirmed human-only items are never picked up by agents.

**When to pass `suggest_human_only: true`** — the work happens entirely off-platform:
- Calling or emailing an external party (lawyer, vendor, stakeholder)
- Purchasing something (a domain, a license)
- External dashboard work an agent has no access to (Stripe dashboard, DNS records, vendor onboarding)

**Everything else needs no flag** — research queries, ambiguous scope, infrastructure or security-sensitive changes are all workable by an agent; whether one picks the item up is decided when somebody asks it to.

Set it to true if `--human-only` is in the input. Otherwise ask `Suggest human-only (y/N)?` only when the work looks plainly off-platform, defaulting to `N` on empty or absent input.

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
  - **No remote, or no match** → if `.devspec/project.json` exists, pass its `project_id` as `pinned_project_id` on the create call instead. **Folder pin — a project with no repo yet.** Whether or not there is a remote, read `.devspec/project.json` if it exists — look in the working directory, then each parent up to and including the git repository root, never at or above your home directory (`~/.devspec` is machine state, not project config); nearest wins. It holds `{ "project_id": "<uuid>" }`. That is how a folder whose code does not exist yet names its project. **If there is no pin and no git remote resolved, offer to create one** after the user names the project: with their agreement write `{ "project_id": "<uuid>" }` to `.devspec/project.json` at the git repository root, or at the working directory when there is no repo, so the folder answers for itself next time. Only offer when nothing else resolved — a folder whose remote already matches needs no pin. **Never write it silently**, put nothing but the project id in it (no path, hostname, user or timestamp — that is what makes it safe to commit), and if a pin already names a DIFFERENT project, say which one before replacing it. Pass it as **`pinned_project_id`**, NEVER as `project_id`: `project_id` is an explicit override that outranks a verified git remote, whereas the pin is only a local assertion the server deliberately ranks BELOW a remote it can verify — so sending it as `project_id` reverses that. Send `git_remote` when you have one, `pinned_project_id` when you have one, both when you have both, and let the server arbitrate. **Never decide precedence locally.**
  - **null with `candidate_project_ids`** (repo tracked by >1 project): ask the user which project. With no one to ask, fail with `✗ This repo is tracked by multiple DevSpec projects — pass the project explicitly or detach the duplicates.` and stop.
  - **no match** (or no `origin` remote): if the user's account has exactly one project the server resolves it without a hint — call `list_projects()` (no `git_remote`); if it returns exactly one project, use that `project_id`. Otherwise ask which project, and with no one to ask fail with `✗ Cannot resolve which DevSpec project to create the item in.` and stop.

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
→ Added as an open item. Hand it to an agent when you want it worked — it reserves the item itself.
```

## Shell Safety

Every shell-adjacent value (title, description) must be sanitized before it is echoed into any shell command:
- Rule 4: before embedding in any command or log line, escape `'` → `'\\''`, strip `$ ` `` ` `` ` # \\ | & < >`, truncate to 500 chars.
- Rule 1: wrap interpolated values in single quotes.
- Never echo unsanitized user input to shell commands.

The MCP tool call itself passes values as structured JSON (no shell interpolation), so the main shell-safety concern is the confirmation output and any echo of the user's title/description back to the terminal.

## Rules

- One question at a time. Do NOT dump a 5-field form.
- Ask only for what you could not infer, and never re-ask for something the input already gave you.
- Trim whitespace from every user-provided field.
- Only suggest human-only for plainly off-platform work; everything else needs no flag.
- Confirm in one line. No multi-line success banners.
- If the user interrupts mid-question, exit cleanly without creating a partial item.
