---
name: devspec-remote-stop
description: "Disconnect DevSpec remote control for THIS conversation only — connection offline, stop the matching poller, leave other remotes alone. Use when done remote controlling or before exiting the agent."
---

# DevSpec Remote Control — Stop / Disconnect

Cleanly disconnect **this** conversation's connection so the **Agents page** drops its live indicator immediately.

## Multi-connection safety (non-negotiable)

Multiple remotes may run on one machine (several Antigravity terminals).

- Stop **only** the target `connection_id`.
- **Never** kill all `devspec-remote-poll` processes.
- **Never** offline other connections.

## Steps

1. **Resolve connection id** from arguments, or this conversation's state via
   ```bash
   node "<plugin>/hooks/scripts/remote-control-state.mjs" resolve-local \
     --agent "Antigravity" --local-id "<local_id>"
   ```
   (use its `connection_id`), or `~/.devspec/remote-control/connections/<uuid>.json`, or legacy `~/.devspec/remote-control.json`. If ambiguous, ask the user. Note its `session_id` (may be null = sessionless).

2. **Mark the connection offline (this connection only):**
   - If attached (`session_id` present): `report_remote_agent_heartbeat({ session_id, status: "offline", end_reason: "local_stop", agent_name: "Antigravity" })` (the bond-aware dual-write also ends the connection row), then optionally `detach_connection({ connection_id })`.
   - If sessionless: `heartbeat_connection({ connection_id, status: "offline", end_reason: "local_stop" })`.

3. **Post disconnect** (best-effort, only when attached):
   ```
   post_session_message(session_id, "🔌 **Local agent disconnected**.", agent_name: "Antigravity")
   ```

4. **Disable state + kill only this poller + mark bond stopped:**
   ```bash
   node "<plugin>/hooks/scripts/remote-control-state.mjs" disable \
     --connection-id '<connection_id>' --agent "Antigravity" --local-id "<local_id>"
   ```
   Connection-scoped: writes that connection's state `enabled: false`, marks matching local bonds `stopped` (soft-reconnect only for this conversation within ~30m), and SIGTERMs pollers whose argv includes this connection UUID only.

5. **Print:**
   ```
   ✓ DevSpec remote control stopped
     Connection: {first 8}…
     Agents page: offline
     Other remotes on this machine: left running
   ```

## Rules

- Always offline **this** connection even if the post fails.
- Do not delete the DevSpec session — history remains.
- Soft-reconnect is bond-scoped (same conversation `local_id`), never by cwd/repo: `end_reason: local_stop` is recoverable only soon after (~30m), so remote → stop → remote again in the same conversation resumes the connection. A new agent chat later must not rejoin just because files remain under `~/.devspec`.
- This is DevSpec remote control — distinct from any built-in remote-control feature of your host app.
