---
name: devspec-remote-stop
description: Disconnect DevSpec remote control — mark Agents page offline and clear local state. Use when done remote controlling or before exiting the agent.
---

# DevSpec Remote Control — Stop / Disconnect

Cleanly disconnect **this** local agent / **this** remote-control session so the **Agents page** drops the live indicator immediately.

## Multi-session safety (non-negotiable)

One machine may run **several** remote-control sessions at once (multiple Grok/Claude terminals).

- Stop **only** the session you intend to stop (from `~/.devspec/remote-control/sessions/<uuid>.json` or `--session`).
- **Never** kill every `devspec-remote-poll` process on the machine.
- **Never** call offline heartbeat on any other session UUID.
- Prefer: `node …/remote-control-state.mjs disable --session <uuid>` (session-scoped disable + kill).

## Steps

1. **Resolve session id** (in order):
   - Explicit arg / user-provided UUID
   - Per-session file if known
   - Legacy `~/.devspec/remote-control.json` → `session_id` (may be the *latest* connect only — if multiple remotes, ask which session)

2. **Mark offline on DevSpec** — **only this session_id**:
   ```
   report_remote_agent_heartbeat({
     session_id,
     status: "offline",
     end_reason: "local_stop",
     agent_name: "Grok Build"
   })
   ```

3. **Post disconnect** (best-effort, same session only):
   `post_session_message(session_id, "🔌 **Local agent disconnected**.", agent_name: "Grok Build")`

4. **Disable local state + stop THIS poller only:**
   ```bash
   node "<plugin>/hooks/scripts/remote-control-state.mjs" disable --session '<session_id>'
   ```
   That writes `enabled: false` for that session file and SIGTERMs only pollers whose argv includes this UUID.

5. **Print:**
   ```
   ✓ DevSpec remote control stopped
     Session:  {first 8}…
     Agents page: offline
     Other remotes on this machine: left running
   ```

## Rules

- Always offline **this** session even if post fails.
- Do not delete the DevSpec session — history remains. `end_reason: local_stop` is recoverable **only soon after** (find-reconnect TTL ~30m, same cwd): remote → stop → remote again in the same conversation reuses the channel. A **new** agent chat later must not rejoin this session just because files remain under `~/.devspec`.
- Distinct from Claude's built-in `/remote-control`.
