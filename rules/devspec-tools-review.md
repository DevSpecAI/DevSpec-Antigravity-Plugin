---
trigger: model_decision
description: "Call shapes for DevSpec's Review decisions (proposals, protected intent, flags, duplicates), goals, discussion points and project summary tools. Read this before you call any of them: it stands in for their schema files."
---

# DevSpec tool shapes: Review, goals and the project

Call these DevSpec tools directly (`ServerName: "devspec_devspec"` on `call_mcp_tool`) with the shapes below, without reading their `.json` schema files.

- `?` marks an optional parameter. Ids that take a UUID or an 8-character short code say so; the rest need the full UUID.
- Never pass what `PreToolUse` stamps: `connection_id`, `project_id`, `local_session_id`, `agent_name`, `request_ref` and `provenance_ref`.
- Most tools also take `git_remote` (your `git remote get-url origin`) and `pinned_project_id` (from `.devspec/project.json`), which say which project when none is stamped. Pass them only when a result asks which project you mean.
- Writes take `work_claim_ref`: pass the one `claim_work_item` returned on a write about that claimed task when you hold more than one claim.
- When a result names a parameter these shapes do not show, read that tool's schema file before calling it again.

## Review decisions (read `get_review_queue` first; pass its ids and revisions verbatim)

- `get_review_queue`: `{ view?: "waiting_on_you"|"raised_by_you"|"all_waiting"|"possibly_outdated", kind?: ["question"|"proposal"], subject?: ["memory"|"artifact"|"task"], record_type?: ["memory"|"artifact"|"task"], involvement?: ["awaiting_me"|"raised_by_me"|"involving_me"|"involving_others"|"can_resolve"], state?: ["waiting"|"declined"|"landed"|"putting_back"|"settled"], person?, search?, key?, limit?, cursor? }` (`key` returns one entry in full and ignores everything else; `cursor` is the previous page's `next_cursor`)
- `decide_proposal`: `{ proposal_id, revision, decision: "accept"|"decline", note? }` (`revision` is the entry's `proposal_revision`)
- `manage_protected_intent`: `{ action: "go_ahead"|"decline"|"not_a_reversal"|"keep"|"undo"|"reopen"|"adopt"|"make_experiment"|"ask_to_land"|"request_confirmation"|"confirm_request"|"decline_request", issue_id?, id?, request_id?, answer?: "go_ahead"|"decline"|"not_a_reversal"|"keep"|"undo", event_ids?: string[], confirmer_user_id?, reason?, note?, record_type?: "task"|"memory"|"artifact", experiment_branch?, instruction_message_id?, session_id?, expected_version?, expected_revision?, idempotency_key }` (full UUIDs and a fresh `idempotency_key`; `issue_id` is the question's id and `id` the experiment's or record's; `decline` needs `reason`; `request_confirmation` needs `answer`; `confirm_request` and `decline_request` need `request_id`; `event_ids` answers only those comparisons; `instruction_message_id` is the command you were given, when you act on one. Keeping work that reverses a decision, convention or requirement needs that record changed first, as `AGENTS.md` rule 2 says: a bare `go_ahead` or `keep` on it is refused with `memory_update_required`.)
- `resolve_memory_flag`: `{ id, signal_type: "possibly_stale", verdict: "not_a_conflict", basis }`
- `resolve_resource_flag`: `{ id, signal_type: "possibly_stale", verdict: "not_a_conflict", note }`
- `resolve_task_flag`: `{ task_id, signal_type: "possibly_stale", verdict: "not_a_conflict", note }`
- `resolve_duplicate`: `{ action: "preview"|"resolve", keep: { type: "task"|"memory"|"artifact", id, version }, duplicate: { type: "task"|"memory"|"artifact", id, version }, preview_id, resolution_id?, note, notice_id? }` (preview first; when you are answering DevSpec's duplicate notice, pass its `notice_id`, exactly as it was delivered, on both the preview and the resolve)
- `record_duplicate_nonmatch`: `{ left: { type: "task"|"memory"|"artifact", id, version }, right: { type: "task"|"memory"|"artifact", id, version }, ruling_id, note }`

## Goals and outcomes (`goal_id` and `outcome_id` are full UUIDs)

- `get_project_goals`: `{}`
- `get_goals`: `{ goal_id?, status?: "current"|"achieved"|"dismissed"|"all", items_offset?, items_limit? }`
- `manage_goals`: `{ action: "create"|"update"|"achieve"|"dismiss"|"reactivate"|"split"|"merge"|"create_outcome"|"update_outcome"|"reorder_outcomes"|"confirm_outcome"|"reopen_outcome"|"drop_outcome"|"delete_outcome"|"link_outcome"|"unlink_outcome"|"restore_outcome_target", goal_id?, goal_ids?: string[], title?, chapter_summary?, description?, success_criteria?, target_date?, sort_order?, depends_on_goal_id?, outcomes?: [{ title, description?, horizon?: "active_now"|"up_next", completion_kind?: "product_shipped"|"human_confirmed" }], outcome_id?, outcome_ids?: string[], horizon?: "active_now"|"up_next", completion_kind?: "product_shipped"|"human_confirmed", target_type?: "task"|"resource"|"discussion_point", target_id?, rationale?, reason?, new_titles?: string[], merged_title?, merged_chapter_summary?, merged_description? }`

## Discussion points and project grounding

- `manage_discussion_point`: `{ action: "add"|"update"|"strike"|"reopen"|"watch"|"unwatch", id?, title?, body?, scope?: "project"|"room", session_id? }` (a full UUID `id` for every action except `add`)
- `get_project_summary`: `{}`
- `get_conventions`: `{ limit?, offset?, flagged?: boolean, signal_type?: "possibly_stale", requested_by?, request_origin?: "human_requested"|"agent_initiative"|"automatic"|"unattributed"|"nobody_asked"|"unrecorded"|"all" }`
- `get_decisions`: `{ limit?, offset?, flagged?: boolean, signal_type?: "possibly_stale", requested_by?, request_origin?: "human_requested"|"agent_initiative"|"automatic"|"unattributed"|"nobody_asked"|"unrecorded"|"all" }`
