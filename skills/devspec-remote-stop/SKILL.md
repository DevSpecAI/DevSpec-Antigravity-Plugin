---
name: devspec-remote-stop
description: "Disconnect DevSpec remote control for THIS conversation only — connection offline, stop the matching poller, leave other remotes alone. Use when done remote controlling or before exiting the agent."
---

# DevSpec Remote Control — Stop / Disconnect

Cleanly disconnect **this** conversation's connection so the **Agents page** drops its live indicator immediately. This skill governs connection teardown only; any tracked work performed while connected uses the MCP-served [`devspec://product/implementation-contract`](devspec://product/implementation-contract) as its runtime authority.

## Multi-connection safety (non-negotiable)

Multiple remotes may run on one machine (several Antigravity terminals).

- Stop **only** the target `connection_id`.
- **Never** kill all `devspec-remote-poll` processes.
- **Never** offline other connections.

## Steps

1. **Resolve connection id** from arguments, or this conversation's state via
   ```bash
   PLUGIN_DIR="$HOME/.gemini/config/plugins/devspec"; [ -d "$PLUGIN_DIR" ] || PLUGIN_DIR="$HOME/.gemini/config/plugins/antigravity-devspec-autopilot-extension"
   node "$PLUGIN_DIR/scripts/remote-control-state.mjs" resolve-local \
     --agent "Antigravity" --local-id "<local_id>"
   ```
   (use its `connection_id` and `session_id` from the helper's redacted output — never read the files under `~/.devspec/remote-control/` directly). If ambiguous, ask the user. Note its `session_id` (may be null = sessionless).

2. **Mark the connection offline (this connection only)**, one path, attached or sessionless:
   ```bash
   PLUGIN_DIR="$HOME/.gemini/config/plugins/devspec"; [ -d "$PLUGIN_DIR" ] || PLUGIN_DIR="$HOME/.gemini/config/plugins/antigravity-devspec-autopilot-extension"
   node "$PLUGIN_DIR/scripts/connection-call.mjs" heartbeat_connection \
     --connection-id "<connection_id>" --status offline --end-reason local_stop
   node "$PLUGIN_DIR/scripts/connection-call.mjs" detach_connection --connection-id "<connection_id>"
   ```
   - **Do not** `post_session_message` disconnect chrome — presence updates via the offline heartbeat / Agents page.

3. **Disable state + kill only this poller + mark bond stopped:**
   ```bash
   PLUGIN_DIR="$HOME/.gemini/config/plugins/devspec"; [ -d "$PLUGIN_DIR" ] || PLUGIN_DIR="$HOME/.gemini/config/plugins/antigravity-devspec-autopilot-extension"
   node "$PLUGIN_DIR/scripts/remote-control-state.mjs" disable \
     --connection-id '<connection_id>' --agent "Antigravity" --local-id "<local_id>"
   ```
   Connection-scoped: writes that connection's state `enabled: false`, marks matching local bonds `stopped` (soft-reconnect only for this conversation within ~30m), and SIGTERMs pollers whose argv includes this connection UUID only.

4. **Print in this local terminal only** (never into the session transcript):
   ```
   ✓ DevSpec remote control stopped
     Connection: {first 8}…
     Agents page: offline
     Other remotes on this machine: left running
   ```

## Rules

- Always offline **this** connection.
- Do not delete the DevSpec session — history remains. Disconnecting does not complete or abandon an active session plan; it remains visible and may become eligible for authorized same-owner adoption.
- Soft-reconnect is bond-scoped (same conversation `local_id`), never by cwd/repo: `end_reason: local_stop` is recoverable only soon after (~30m), so remote → stop → remote again in the same conversation resumes the connection. A new agent chat later must not rejoin just because files remain under `~/.devspec`.
- This is DevSpec remote control — distinct from any built-in remote-control feature of your host app.
