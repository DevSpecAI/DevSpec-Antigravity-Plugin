# Changelog

## 0.6.0 - 2026-08-17

### An agent reserves its work — nothing is dispatched to it any more

The server retired `get_assignment`, `acknowledge_assignment` and `resolve_assignment`, along with `get_next_work_item` (DevSpec item 1e455001). Nothing dispatches work to an agent, so there was nothing left for them to do: no batch to receive, no receipt to give, nothing to close.

One verb replaces them. **`reserve_work_items({ action_item_ids, connection_id })`** holds the ordered set you are about to work so no other agent takes one mid-run; then `claim_work_item` per item as you reach it. The batch closes itself when its last member is recorded, failed or released.

**`devspec-work` now reserves up front when handed several ids**, and **`skipped`** must be read and reported: an item another agent already holds comes back with a reason naming the holder rather than failing the call.

### Only the agent holding an item can release or fail it

`release_work_item` and `fail_work_item` had no ownership check at all, and `claim_work_item`'s compared USERS — which cannot tell two of your own agents apart, because a DevSpec token is account-wide. On 2026-08-16 a sibling connection released work another agent was actively on, leaving the item unclaimed while its reservation still said claimed.

All three now check the reservation against the `connection_id` you pass, server-side, so pass it. A stale hold is still always releasable with `force` and a reason — recorded as a takeover naming who did it.

## 0.5.0 - 2026-08-17

### `--unattended` is gone, and nothing replaced it

`devspec-work` took a flag that installed a mode for the whole run: never ask, never wait, auto-select the highest-priority match when a name was ambiguous. It read as a safety feature and was really a licence to guess.

Deleted: the flag, the `Mode:` line in the item header, every per-step "interactive mode / unattended mode" fork, and the two mode-specific contract resources — the served contract is now one document at `devspec://product/implementation-contract`. `devspec-remote`'s "batch mode overrides conversation mode" section goes too: working a batch never installed different rules, so resolving one clears nothing.

Nothing takes its place — no timeout, no patience window, no ask-policy. **Ask only what is not yours to decide** (never a detail the item's intent and criteria already settle), and **do not assume someone is waiting to answer** (before a claim, say what you need and stop; after a claim, fail the item with a precise reason). Neither depends on knowing whether a human is watching, which is what the mode was pretending to know.

Brainstorm no longer asks whether you want it: it runs when the invocation asked for it, and a plain work run skips it.

## 0.4.1 - 2026-08-14

### A quiet connection stays up while the host process is alive

- **Removed the 72h idle-disconnect.** The poller no longer stamps `idle_timeout` and exits after three quiet days. A connection lives as long as its Antigravity process, unless you End it or run `devspec-remote-stop`. Item `ce1758a3`.

## 0.4.0 - 2026-08-11

### The autopilot skills are gone — staged batches arrive at any idle connection

**Migration:** if you used `devspec-autopilot` (or `autopilot-status` / `autopilot-history` / `autopilot-log`), stage the items in DevSpec instead (**Stage for Autopilot** / approve a plan) and keep an ordinary `devspec-remote` session idle — DevSpec hands the batch to it. Status is the Agents page; stop is `devspec-remote-stop`; history is the assignment and item record.

- **The plugin no longer chooses its own work.** The four autopilot skills are deleted, and with them the `get_next_work_item` self-selection path; the server routes a staged batch to a connection and the plugin only works what it was handed.
- **Unattended is a mode, not a command.** The dispatch-protocol section of `devspec-remote` (step 8a) now states the batch contract explicitly: batch rules override conversational rules for the duration of the batch, a member that cannot be done safely is failed loudly with `fail_work_item` (never stalled on a question nobody is there to answer), and the connection returns to ordinary available capacity when the batch resolves.
- No replacement command or flag is created. Same deletion across the Claude Code, Cursor, OpenCode, Grok and Codex plugins under the same item (`3f2f390c`).

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
