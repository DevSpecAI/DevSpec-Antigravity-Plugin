---
name: autopilot-history
description: "Show recent DevSpec autopilot execution history (completed and failed items) queried from the DevSpec API. Use when asked what autopilot has done recently."
---

Fetch completed and failed DevSpec action items and display a clean formatted history.

## Steps

1. Call `get_action_items` with `agent_activity: 'completed'` and `get_action_items` with `agent_activity: 'failed'` in parallel.
2. Combine all items, sort by most recent first (use `agent_claimed_at`).
3. Calculate relative timestamps using the `agent_claimed_at` field (ISO 8601 string). Parse with the Date constructor — do NOT use string manipulation or regex. Do NOT produce "NaN" timestamps.
4. Output the formatted history:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ◆  DEVSPEC AUTOPILOT  ▸  HISTORY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  ✓ "Fix login timeout handling"
    autopilot/action-item-a1b2c3d4 · merged · 2h ago

  ✓ "Add input validation to /api/upload"
    autopilot/action-item-e5f6g7h8 · merged · 5h ago

  ✗ "Refactor auth middleware"
    autopilot/action-item-i9j0k1l2 · failed: Merge conflict · 1d ago

  ━━ 3 total · 2 completed · 1 failed
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

## Rules

- Use `✓` for completed, `✗` for failed
- Show branch name, merge status (merged/push-only/failed), and relative time
- For failed items, include the `agent_error` message after "failed:"
- Sort by most recent first
- Show aggregate stats at the bottom
- Do NOT output filler text before or after the banner
