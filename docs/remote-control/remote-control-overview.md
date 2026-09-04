# Remote control — overview (LLM primer)

**Audience:** coding agents fixing remote-control behaviour.  
**Pair with:** the per-agent guide for the host you are editing (`remote-control-claude-code.md`, `remote-control-cursor.md`, …).  
**Not a replacement for:** `docs/REMOTE-CONTROL-DELIVERY-CONTRACT.md`, `docs/REMOTE-CONTROL-ACTIVITY-CONFORMANCE.md`, or the ADRs linked below.

## What remote control is

A **connection** is a first-class DevSpec agent identity for one local coding-agent conversation. It can be:

- **Sessionless** — available on the Agents page; receives authorized remote commands or automation runs without a chat room.
- **Attached** to a DevSpec session — optional shared transcript + room context.

A **session is optional**. Never invent a session because a cwd or another agent recently stopped. Bond on the local conversation / thread id only.

## Shared DevSpec contract (all hosts)

| Concern | Rule |
|---|---|
| Identity | `register_connection` → `connection_id` + server-minted `codename`. Fixed `AGENT_NAME` per plugin. |
| Tick | One held `poll_connection` negotiated with numeric `ingress_version: 1`, `delegated_scope_version: 1`, and `active_plan_projection_version: 1`. |
| Authority | Act only on complete exact-target canonical commands with the server-stamped authority/project-scope pair. Runtime policy: [`devspec://product/remote-ingress-contract`](devspec://product/remote-ingress-contract). |
| Advisory | Typed canonical context and `active_session_plans` are read-awareness only — never wake, execute, or grant plan mutation authority. |
| Answers (attached) | Agent (or host bridge) posts **one direct answer** via `post_session_message({ connection_id })`. |
| Answers (sessionless) | Use the explicit command or automation reporting path — never invent chat or infer action-item assignment. |
| Activity | `report_pickup` → `report_keepalive` → `report_complete`. Server never infers Working. |
| Chrome | Connect/status banners are **terminal-only**. Never post them into the session. |
| Slash commands | Host UI commands (e.g. `/clear`) are **not** remote-control. Injecting `"/clear"` as prompt text does not run them. |
| Work entry | [`devspec://product/implementation-contract`](devspec://product/implementation-contract) is the MCP-served authority for tracking, claiming, and the high plan threshold; host primers retain operations only. |

## Three implementation families

| Family | Members | How a DevSpec command reaches the model |
|---|---|---|
| **Local-poller** | Claude Code, Cursor, Grok Build, Antigravity | Detached Node poller long-polls DevSpec → writes inbox file → wait process wakes the model. Model posts the reply (skill-driven). |
| **Bridge** | Codex | Poller + **app-server bridge** injects into the Codex thread via `turn/start`. Bridge posts remote-turn replies. |
| **Native runtime** | OpenCode | In-process TypeScript: `poll_connection` inside OpenCode → `session.promptAsync` injects a **text** prompt → plugin mirrors assistant reply (with dedup). |

Same MCP verbs and delivery rules. Different laptop plumbing. **Do not port one family’s wake/inject mechanism onto another without a host reason.**

## Message journey (mental model)

1. An authorized requester sends to a specific connection from DevSpec (web/phone).
2. Server stamps the command's target, authority, and project scope for that `connection_id`.
3. Host plugin receives it via `poll_connection`.
4. Host delivers it to the model (wake **or** inject — family-specific).
5. Model works on the machine.
6. Reply returns to the DevSpec session (model post **or** bridge/plugin mirror — family-specific).

## What not to break

- Do not reintroduce Stop-hook **full-turn** mirroring as the primary answer path.
- Do not copy wake/auth/state files across plugin repos — plugins are independent; no file crosses a repo boundary.
- Do not treat advisory room traffic or another agent's active plan as instructions or mutation authority.
- Do not bond on `SHELL_SESSION_ID` / cwd — conversation/thread id only.
- Do not assume OpenCode-style inject exists on Claude/Cursor/Grok/Antigravity.

## Canonical pointers

- Tracked-work contract: `devspec://product/implementation-contract`
- Delivery contract: `docs/REMOTE-CONTROL-DELIVERY-CONTRACT.md`
- Activity / pickup lease: `docs/REMOTE-CONTROL-ACTIVITY-CONFORMANCE.md`
- Plugin independence: each host owns every plugin file; use canonical MCP contracts as references, never copy or synchronize host files
- ADRs (DevSpec resources): remote-control delivery (`b98a39a9`), connection activity (`36a07dc5`), hook layer (`aef358ba`), adding a coding agent checklist (`7fc43384`)

## How to use these primers in a DevSpec launch

1. Attach **this overview**.
2. Attach the **one** per-agent guide for the repo being changed.
3. Tell the agent: the overview describes the remote contract; host specifics are in the second doc; do not invent a third delivery path.
