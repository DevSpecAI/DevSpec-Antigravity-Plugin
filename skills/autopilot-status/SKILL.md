---
name: autopilot-status
description: "Show the current state of the DevSpec autopilot — queued and in-progress counts plus push/merge settings, as a compact status panel. Use when asked for autopilot status."
---

Fetch current state and output a compact status panel. Make all API calls in parallel.

## Steps

1. Call all three in parallel:
   - `get_project_summary` — for settings
   - `get_action_items` with `agent_ready: true, agent_activity: 'queued'` — for queue count
   - `get_action_items` with `agent_activity: 'in_progress'` — for active count

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
