---
name: devspec-link
description: "Link an existing git commit to a DevSpec action item for traceability via add_commit_reference. Use when asked to link or associate a commit (or HEAD) with an action item."
---

Retroactively associate a git commit with a DevSpec action item via the `add_commit_reference` MCP tool. Useful when a commit was made outside the DevSpec workflow (`/devspec:work`, `/devspec:commit`) and you want it to appear on the action item's history page in the DevSpec dashboard.

The `add_commit_reference` MCP tool's parameter schema is provided by the `devspec` MCP server. Follow the **Shell Safety** rules at the end of this skill whenever you build a shell command from user input (SHA, title, etc.) — wrap values in single quotes and validate against the patterns listed there.

## Arguments

Parse the user's input for two values, in any order:

- **commit**: a full git commit SHA, a short SHA, or one of `last` / `latest` / `HEAD` (case-insensitive) to mean the current `HEAD`.
- **action-item**: a full UUID, a partial UUID prefix, or title keywords.

If either value is missing, ask the user for it once.

## Steps

### 1. Resolve the commit SHA

- If the input is `last`, `latest`, or `HEAD` (case-insensitive): run `git rev-parse HEAD` to get the full SHA.
- If the input already matches `^[0-9a-f]{40}$` (40 hex chars): use as-is.
- If the input matches `^[0-9a-f]{7,39}$` (short SHA): run `git rev-parse '{sha}'` to expand to the full SHA. Wrap the SHA in single quotes per Shell Safety Rule 1.
- If the input does not match any of these patterns: output `✗ Invalid commit SHA: {input}` and stop.

If `git rev-parse` fails (commit not found in the current repo): output `✗ Commit not found in this repo: {input}` and stop.

Store the result as `full_sha`.

### 2. Get the commit message

Run `git log -1 --format=%s '{full_sha}'` (single-quoted, Shell Safety Rule 1). Store the subject line as `commit_message`.

If this fails, output `✗ Could not read commit message for {full_sha}` and stop.

### 3. Resolve the action item

- If the input matches `^[0-9a-f-]{36}$` (UUID format, Shell Safety Rule 6): use it directly as `action_item_id`.
- Otherwise, call `get_action_items(status: "all")` and match by ID prefix or by title keywords (case-insensitive substring match against the `title` field).
- **If exactly one match**: use it.
- **If multiple matches**: present a numbered list (showing title, status, and first 8 chars of ID) and ask the user to pick one. Example:
  ```
  Multiple matches for "{input}":
    1. [staged]   Fix login timeout on mobile          (4d753b6a)
    2. [done]     Add login retry logic                (a1b2c3d4)
    3. [open]     Login analytics dashboard            (f9e8d7c6)
  Pick one (1-3):
  ```
- **If no match**: output `✗ No action item found matching: {input}` and stop.

Store the chosen `action_item_id` (complete UUID — never truncate per Shell Safety Rule 6).

### 4. Call `add_commit_reference`

Call with:
- `action_item_id`: the resolved UUID
- `commit_sha`: `full_sha` from Step 1
- `commit_message`: from Step 2

If the call fails with `401 Unauthorized`, output `✗ Authentication failed. Regenerate your token in DevSpec: Settings > Autopilot.` and stop.

If the call fails with `404 Not Found`, output `✗ Action item not found in DevSpec.` and stop.

If the call fails with any other error, output the error and stop.

### 5. Output

```
✓ Linked commit {full_sha[:8]} to: {action_item_title}
  {commit_message}
  (http/https link to the action item if available, else omit)
```

## Rules

- This is a **read-only** workflow apart from the `add_commit_reference` call — do NOT modify the working tree, do NOT create branches, do NOT commit, do NOT claim the item.
- Do NOT change the item's `lifecycle` or `agent_activity` — `/devspec:link` is purely additive (it adds a commit reference to the audit trail).
- Do NOT output filler text before or after the result.
- Follow these Shell Safety rules whenever you interpolate user input (SHA, title, keywords) into shell commands: wrap in single quotes, validate SHA against `^[0-9a-f]{7,40}$`, validate UUIDs against `^[0-9a-f-]{36}$`.
- If the user provides both arguments in a single message, do NOT ask for confirmation — resolve and link in one shot.
