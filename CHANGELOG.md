# Changelog

## 0.11.7

The mechanical Connect helper starts optional setup of a generated shared-launcher payload. This runs on first Connect, not an assumed plugin-activation hook, and does not alter credentials or connection responses. Clone/install the complete plugin including `launcher/`; copying only skills is insufficient. Carrying the installer does not add an Antigravity launch target.

## 0.11.6

The Connect skill now uses a narrow mechanical registration/attachment helper that reports the executing plugin version and keeps credentials/private capability metadata out of its output. Internal re-registration also reports the version. No unsupported pre-tool hook was invented; unavailable host versions stay unknown. The Connect skill's script paths now match this package's actual `scripts/` layout.

## 0.11.5

### Delivery evidence stays on action items, out of project memory

The knowledge-capture guidance your agent reads now draws one more line: what shipped, which commit and what passed belong on the action item, not in project memory — and a memory should hold what a future decision needs that the existing record doesn't already preserve. Shared project knowledge stays free of per-task status reports.

## 0.11.4

### DevSpec's renamed settings pages

The README now sends you to **You → Coding agents** → **Create your token** for your DevSpec token; the page used to be called You → Connections. The remote skill's "Account + project instructions" section is now "Personal + project instructions", and it no longer calls the owner's response style by its old name, Chat Response Style. Nothing about how the plugin behaves has changed.

## 0.11.3

### A test catches a DevSpec tool name the server no longer has

A new test reads DevSpec's live tool list from a devspecv2 checkout beside this repo and fails if anything in this plugin names a DevSpec tool the server does not have. A tool renamed or retired on the server is then caught here, before an agent is told to call it in someone's session. With no checkout beside it the test skips; `DEVSPEC_V2_ROOT` names one. Nothing about how the plugin behaves has changed.

## 0.11.2

### Knowledge: the closest match is read, not automatically replaced; open questions are on Review

- Before writing a memory the skill still searches and reads the closest match in full, but no longer tells the agent to supersede it. A similar record may be the same decision, a change to it, a different one, or a disagreement; the agent records, supersedes, links or asks the owner as the comparison warrants.
- The skill names where open questions about records live — the project's Review queue — and the tools to preview a ruling, link related records and read an item's history. Who may rule stays the served contract's decision.

## 0.11.1

### A proposed change is accepted on the Review page

When a write comes back `queued_for_review`, the skill now says a maintainer accepts it on the project's Review page, under Proposed changes. It used to send people to a "Review tab", which no longer exists.

## 0.11.0

### Authority is the served contract's, not this plugin's

The remote skill no longer says a write without a runner stamp carries "interactive
authority". Whether a memory, artifact or rule change commits, is queued as a proposal, or
is refused is decided by DevSpec and served at `devspec://product/implementation-contract`
→ `authority_contract`; the skill points there and keeps its own step: read each write's
`outcome`, and on `queued_for_review` relay the `proposal_id` and the reason, saying a
maintainer has to accept it before it applies.

## 0.10.0

### Playbooks are now Automations

DevSpec has renamed Playbooks to Automations. This plugin now uses the renamed tools
(`claim_automation_run`, `record_automation_run`, `get_automations` and the rest) and reads
the renamed fields in what the server sends it. It needs a DevSpec server that carries the
same rename; against an older server, automation runs are not picked up.

## 0.9.0

### Shared session plans without widening Antigravity's hot surface

- Work-entry, tracking, and plan-threshold authority remains at
  `devspec://product/implementation-contract`; routine investigation stays plan-free.
- Attached connections negotiate a hidden capability for an on-demand,
  schema-complete `manage_plan` bridge with revisioned atomic advance, resume,
  complete/abandon, and explicit authorized adoption mechanics. Already-live
  re-arms rotate first; stale/pre-capability state fails closed, and `--schema`
  emits exact discriminated per-action objects.
- Remote polling now requests ingress, delegated scope, and active-plan projection
  v1, strictly validates canonical 1.3 plan inventories, and retains strict 1.2
  compatibility. All-room plans are advisory read-awareness only.
- Tests cover routine no-plan discovery, plan mechanics, capability negotiation,
  reconnect revisions, orphan adoption inputs, cross-owner reads, and strict wire
  negotiation. The existing two-skill, host-native workflow remains bounded.

## 0.8.0

### MCP-served implementation contract is the runtime authority

- Current public docs and remote work instructions point to
  `devspec://product/implementation-contract` instead of restating mutable item
  lifecycle rules.
- The remote skill keeps only the required multi-item ordering: reserve once in
  requested order, then claim each successfully reserved item in that order.
- Antigravity's host limitation is explicit: there is no verified blocking
  pre-tool hook, so `UserPromptSubmit` remains prompt-mirror/activity transport
  and does not pretend to inject or enforce the contract before mutations.
- Contract-surface tests reject stale lifecycle prose and protect the existing
  mirror-turn hook plus reserve/claim ordering.

## 0.7.0

### Eight skills removed — devspec-remote and devspec-remote-stop remain

`devspec-work`, `-create`, `-commit`, `-link`, `-help`, `-done`, `-brainstorm`
and `-verify-connection` are deleted.

A skill must be a script, not a restatement. Connecting runs a deterministic
setup a model improvises badly and that can be tested; the others were a page of
prose each, telling a model to call one DevSpec MCP tool it could already see.

Nothing was lost: what they taught now lives in the MCP tool schemas server-side,
written once and reaching every host the moment it changes, instead of copied
into six repositories with no way to notice when one drifts.

Say it instead — *"Work on DevSpec action item 4f2a"*, *"Work these in order:
4f2a, 9c1b, 2e7d"*. DevSpec's copy buttons emit exactly those lines, so copying
and typing produce the same thing, and a sentence works in a host with no plugin
at all.

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
