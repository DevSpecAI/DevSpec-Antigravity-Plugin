# Changelog

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
