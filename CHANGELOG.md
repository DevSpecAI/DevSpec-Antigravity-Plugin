# Changelog

## 0.3.6 - 2026-08-04

### Read a memory before superseding it — search now returns a card

DevSpec's `search_memories` changed today: it returns a **card** (title, one-line summary, id, state) instead of the full memory body, because a 15-result search was returning over 600,000 characters. The full text comes from a new `get_memory` tool.

- **The instruction that mattered was the supersede one.** This plugin told the agent to search memories first and supersede the closest match instead of duplicating — a judgement made against full bodies yesterday, and against one-line summaries today. It now says to `get_memory` the match and read it in full first: a card is enough to choose WHICH memory you mean, not enough to justify overwriting an entry in the team's shared decision record.
- **Where the autopilot loop treats memories as hard constraints**, it now reads the binding ones in full. A summary states the decision; the body carries the qualifications and exceptions, and a constraint obeyed without its exceptions is how an unattended loop confidently does the wrong thing.
- **No `allowed-tools:` gate here**, unlike the Claude Code plugin, so `get_memory` was already callable — this release is about the instructions, not about unblocking a refused tool call.

Nothing else needs reinstalling for the DevSpec-side change: MCP tool definitions come from the server, so a reconnect picks up the renamed `body` parameter and the now-required `title` on `record_memory`.

Item `93a851b5`.

## 0.3.0 - 2026-07-25

### Remote control — long-poll transport, and the room arrives with the command

- **The polling interval is gone.** One held `poll_connection` call replaces the old three-call tick (`heartbeat_connection` + `get_connection_dispatch` + `get_session_transcript`). The server holds the request open (~25s) and answers the instant something lands: **~2 requests/min instead of 8, and ~0 delivery latency instead of up to 15s.** Fixed intervals survive only as error/empty-turn backoff.
- **Room context is now delivered WITH the command.** A wake payload begins with a labelled `room_context` event — `owner_ambient` (your owner talking in the room, but not to you) and `room_context` (teammates, Dev, other agents) — followed by the command last. Previously advisory was written to a side file and reading it was an instruction the model had to remember; an agent could hold "1", "2", "3" on disk and still fail to answer "what's the next number?". Because a long-poll returns the instant anything arrives, the poller carries advisory forward since the last command so it is genuinely there when the command lands.
- **Reconnect arrives oriented.** A cold launch or a server-side reattach asks for the bounded catch-up window, writes it as advisory and seeds the carry buffer — so the first command after reconnecting already has the room. Already-answered history is still filtered out of the commands, so reconnecting never re-wakes a finished turn.
- **Commands state their addressee.** Every delivered command carries `addressed_to` (agent name · codename · connection id) and an `authority` stamp, and the poller **refuses** anything not addressed to it. Two of your agents in one room can no longer be confused for each other, and a misroute is visible instead of silent.
- Teardown is faster: a held request is aborted the moment the owning agent process dies, and every request now has a hard client-side timeout, so a dropped network can no longer wedge a poller with no heartbeat.
- Also picks up the Windows owner-pid resolution the shared layer gained in the previous release.


## 0.2.1 - 2026-07-24

### Remote control — never drop owner mail that arrives mid-turn

- `devspec-remote-wait` **defaults to resuming from `inbox_byte_offset`** (not EOF).
- Skill: **re-arm with `--pending`** after every wake. `--from-end` is first-connect only.
- Live bug: re-arming with `--from-end` after a wake skipped owner commands the poller had already written while the agent was mid-turn.

## 0.2.0 - 2026-07-24

### Remote control — agent-canonical, connection-scoped, session optional

- **Answers:** when attached, post via `post_session_message({ connection_id })`. Sessionless: assignment / `report_progress` only — never invent a room.
- **Stop hooks:** busy/heartbeat + optional local_prompt only — **no** full assistant mirror.
- **`devspec-work --remote`:** defaults **sessionless**; optional `--session` / `--new` for a transcript.
- Skills match DevSpecV2 delivery contract (ADR b98a39a9).

## 0.1.x

- Prior skills, hooks, and remote-control packaging (unversioned tree).
