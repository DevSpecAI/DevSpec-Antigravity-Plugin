---
name: autopilot-history
description: "Show recent DevSpec autopilot execution history (completed and failed items) queried from the DevSpec API. Use when asked what autopilot has done recently."
---

Fetch completed and failed DevSpec action items and display a clean formatted history.

## Steps

1. **Resolve the project (account-wide token).** Your DevSpec MCP token is account-wide, so resolve which project this repo belongs to first:
   - `git remote get-url origin` → `remote_url`. If there is no `origin`, output `✗ No git remote 'origin' — cannot resolve which DevSpec project this is.` and stop.
   - Call `list_projects({ git_remote: "<remote_url>" })` and read `remote_match.resolved_project_id` → `project_id`. If it is null with `candidate_project_ids`, output `✗ This repo is tracked by multiple DevSpec projects — open the dashboard to see history.` and stop. If there is no match, output `✗ No DevSpec project tracks this repo.` and stop.
2. Call `get_action_items` with `project_id, agent_activity: 'completed'` and `get_action_items` with `project_id, agent_activity: 'failed'` in parallel (thread the resolved `project_id` on both).
3. Combine all items, sort by most recent first (use `agent_claimed_at`).
4. Calculate relative timestamps using the `agent_claimed_at` field (ISO 8601 string). Parse with the Date constructor — do NOT use string manipulation or regex. Do NOT produce "NaN" timestamps.
5. Output the formatted history:

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
