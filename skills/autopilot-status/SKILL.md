---
name: autopilot-status
description: "Show the current state of the DevSpec autopilot — queued and in-progress counts plus push/merge settings, as a compact status panel. Use when asked for autopilot status."
---

Fetch current state and output a compact status panel.

## Steps

1. **Resolve the project (account-wide token).** Your DevSpec MCP token is account-wide, so resolve which project this repo belongs to before querying:
   - `git remote get-url origin` → `remote_url`. If there is no `origin`, output `✗ No git remote 'origin' — cannot resolve which DevSpec project this is.` and stop.
   - Call `list_projects({ git_remote: "<remote_url>" })` and read `remote_match.resolved_project_id` → `project_id`. If it is null with `candidate_project_ids`, output `✗ This repo is tracked by multiple DevSpec projects — open the dashboard to see status.` and stop. If there is no match, output `✗ No DevSpec project tracks this repo.` and stop.

2. Call all three in parallel (thread the resolved `project_id` on each):
   - `get_project_summary({ project_id })` — for settings
   - `get_action_items` with `project_id, agent_ready: true, agent_activity: 'queued', limit: 1` — for the queued count
   - `get_action_items` with `project_id, agent_activity: 'in_progress', limit: 1` — for the active count

   For each count, read **`page.total_matching`** from the response — that is the true number of matching items. Do NOT count the returned `items` array: it is a single capped page, so a busy queue would be silently under-reported. `limit: 1` keeps the call cheap because only the count is needed, not the rows.

3. Output:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ◆  DEVSPEC AUTOPILOT  ▸  {ONLINE/OFFLINE}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  push: {on/off}  ·  merge: {on/off}

  queued:       {N} items
  in progress:  {N} items
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

## Rules

- Use `on`/`off` for booleans, not `true`/`false`
- Show ONLINE if there are in-progress items or a recent heartbeat, OFFLINE otherwise
- Do NOT output filler text before or after the banner
