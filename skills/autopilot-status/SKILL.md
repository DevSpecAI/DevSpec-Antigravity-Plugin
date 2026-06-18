---
name: autopilot-status
description: "Show the current state of the DevSpec autopilot — queued and in-progress counts plus push/merge settings, as a compact status panel. Use when asked for autopilot status."
---

Fetch current state and output a compact status panel. Make all API calls in parallel.

## Steps

1. Call all three in parallel:
   - `get_project_summary` — for settings
   - `get_action_items` with `agent_ready: true, agent_activity: 'queued', limit: 1` — for the queued count
   - `get_action_items` with `agent_activity: 'in_progress', limit: 1` — for the active count

   For each count, read **`page.total_matching`** from the response — that is the true number of matching items. Do NOT count the returned `items` array: it is a single capped page, so a busy queue would be silently under-reported. `limit: 1` keeps the call cheap because only the count is needed, not the rows.

2. Output:

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
