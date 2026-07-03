# DevSpec Autopilot — MCP Tool Reference

## What is DevSpec?

DevSpec is an AI-native project planning and code intelligence platform. Teams use DevSpec to create, prioritize, and track action items (bugs, features, improvements, tasks). The autopilot system enables AI agents to autonomously pick up staged action items, implement them, and report results back to the team.

## What This Plugin Does

This plugin connects Antigravity to DevSpec's autopilot system. When you run `/autopilot:process`, Antigravity fetches the next staged action item, claims it, implements the required changes, and reports completion with full audit details.

## MCP Tools

All tools are called via the `devspec` MCP server configured in `mcp_config.json`. Antigravity handles the MCP transport — you invoke tools by name.

**Account-wide token — resolve the project first.** The MCP token is account-wide; it does not pin a project. The server resolves the project per call from the most-specific id available: an `action_item_id` self-locates its project (so item-addressed tools need no `project_id`); otherwise an explicit `project_id` argument; otherwise the account's single project; otherwise it errors. So at startup you resolve WHICH project the run is for (via `list_projects` with the repo's git remote — see below) and thread `project_id` on the project-scoped tools: `get_project_summary`, `get_next_work_item`, `send_heartbeat`, `get_action_items`, `search_memories`, `create_action_item`. Do NOT add `project_id` to item-addressed tools (`claim_work_item`, `record_implementation`, `fail_work_item`, `update_action_item`, `add_implementation_note`, `add_commit_reference`, `get_action_item_siblings`, `submit_plan_review`, `spin_off_action_item`, `send_agent_message`) — they self-resolve from the item id.

---

### list_projects

Resolve which project a run is for from the repo's git remote. Call this at startup, before the first heartbeat.

**Parameters**:
```json
{ "git_remote": "https://github.com/Org/Repo.git" }
```

| Field | Requirements |
|-------|-------------|
| `git_remote` | Optional. The repo's `origin` remote URL (`git remote get-url origin`). When passed, the server matches it against every project's tracked repos and returns the match in `remote_match`. Omit to list all projects the token can see (no remote match). |

**Response** (relevant fields):
```json
{
  "projects": [ { "id": "…", "name": "…", "repos": [ { "full_name": "Org/Repo" } ] } ],
  "remote_match": {
    "resolved_project_id": "4d753b6a-28d9-4d2d-8f23-af3103af76db",
    "candidate_project_ids": []
  }
}
```

| Field | Meaning |
|-------|---------|
| `remote_match.resolved_project_id` | The single project that tracks this remote — use it as `project_id` for the whole run. |
| `remote_match.candidate_project_ids` | When `resolved_project_id` is null and this is non-empty, the remote is tracked by **more than one** project — ambiguous. An unattended runner must fail naming the candidates; never guess. |
| (both empty / `resolved_project_id` null with no candidates) | No project tracks this repo — fail with "no DevSpec project for this repo". |

**Errors**:
- `401 Unauthorized` — Token invalid or expired.
- `500 Internal Server Error` — Retry once.

---

### get_project_summary

Get project settings including autopilot configuration. Call this at startup to determine push/merge behavior.

**Parameters**:
```json
{ "project_id": "4d753b6a-28d9-4d2d-8f23-af3103af76db" }
```

| Field | Requirements |
|-------|-------------|
| `project_id` | The project resolved from `list_projects` at startup. Required when the account has more than one project (the account-wide token does not pin a project); optional only when the account has exactly one project. |

**Response** (relevant fields):
```json
{
  "local_plugin_settings": {
    "auto_push": true,
    "auto_merge": true,
    "target_branch": "staging",
    "branch_prefix": "work/action-item-",
    "custom_instructions": "..."
  }
}
```

**Key settings**:
- `auto_push`: Whether to push feature branches to remote
- `auto_merge`: Whether to merge feature branches into target_branch after push
- `target_branch`: Branch to merge into (e.g., "staging", "main")
- `branch_prefix`: Prefix for feature branches (e.g., "work/action-item-")
- `custom_instructions`: Additional instructions to follow during processing

---

### get_next_work_item

Fetch the next highest-priority staged action item with full context.

**Parameters**:
```json
{ "project_id": "4d753b6a-28d9-4d2d-8f23-af3103af76db" }
```

| Field | Requirements |
|-------|-------------|
| `project_id` | The project resolved from `list_projects` at startup. Required when the account has more than one project; optional for single-project accounts. |

**Success Response**:
```json
{
  "id": "4d753b6a-28d9-4d2d-8f23-af3103af76db",
  "title": "Fix login timeout on mobile",
  "description": "## Context\nThe login flow times out after 5 seconds on cellular connections...",
  "priority": "high",
  "type": "bug",
  "lifecycle": "open",
  "agent_activity": "staged",
  "tags": ["auth", "mobile"],
  "affected_files": ["src/auth/login.ts", "src/auth/timeout.ts"],
  "parent_action_item_id": null
}
```

**Empty Queue**: Returns empty/null response — no items available.

**Errors**:
- `401 Unauthorized` — Token invalid or expired. Regenerate in DevSpec UI: Settings > Autopilot.
- `500 Internal Server Error` — Server-side failure. Retry once.

---

### get_action_items

List action items by filter. In this plugin it is used exclusively to detect **planning-mode work** after `get_next_work_item` reports no staged work.

**Parameters** (`project_id` required for multi-project accounts; the rest optional):
```json
{
  "project_id": "4d753b6a-28d9-4d2d-8f23-af3103af76db",
  "agent_activity": "idle",
  "lifecycle": "open",
  "limit": 1
}
```

| Field | Requirements |
|-------|-------------|
| `project_id` | The project resolved from `list_projects` at startup. Required when the account has more than one project; optional for single-project accounts. |
| `agent_activity` | One of `idle`, `staged`, `implementing`, `reporting`, `finished`, `failed`. Use `idle` to find planning items, `reporting` to find items pending plan review. |
| `lifecycle` | One of `open`, `in_progress`, `done`, `dismissed`, `deferred`, `blocked`, `all`. Defaults to `open`. (`deferred` = consciously parked; counts as resolved, reversible via `update_action_item(lifecycle: 'open')`.) |
| `limit` | Max results. Defaults to 20. Use `1` when you only need the next item to process. |
| `assigned_to` | Optional user UUID or `"me"` to restrict to a specific assignee. Omit to include unassigned items. |

**Response**: Array of action items. Each has the same shape as the object returned by `get_next_work_item` (id, title, description, priority, type, lifecycle, agent_activity, tags, affected_files, parent_action_item_id, etc.).

**Usage in this plugin**:
- **Stale-claim recovery**: `get_action_items({ agent_activity: 'implementing', lifecycle: 'open', limit: 20 })` — fetch currently claimed items so the runner can reset ones that have been stuck longer than `stale_claim_timeout_minutes`. Called in parallel with `get_next_work_item` at the start of every cycle. See `## Stale Claim Recovery` below.
- **Review-mode detection**: `get_action_items({ agent_activity: 'reporting', lifecycle: 'open', limit: 1 })` — fetch the next pending review item after `get_next_work_item` returns empty. Review items take priority over planning items.
- **Planning-mode detection**: `get_action_items({ agent_activity: 'idle', lifecycle: 'open', limit: 1 })` — fetch the next pending planning item after both the staged and review pools are empty.

**Errors**:
- `401 Unauthorized` — Token invalid.
- `500 Internal Server Error` — Server-side failure. Treat the same as an empty response (exit cleanly for planning/review detection; skip stale recovery for this cycle).

---

### update_action_item

Update an action item's lifecycle state. In this plugin it is used **only** for stale-claim recovery (resetting in-progress items claimed by crashed runners). All other lifecycle transitions happen through the dedicated tools (`claim_work_item`, `record_implementation`, `fail_work_item`, `submit_plan_review`) — do NOT use `update_action_item` for those.

**Parameters** (only the stale-recovery fields shown — see DevSpec docs for the full schema):
```json
{
  "action_item_id": "4d753b6a-28d9-4d2d-8f23-af3103af76db",
  "agent_activity": "failed",
  "agent_error": "Stale claim: process may have crashed or timed out"
}
```

| Field | Requirements |
|-------|-------------|
| `action_item_id` | The UUID of the stale item. Validate against `^[0-9a-f-]{36}$` (Rule 6) before passing. Required. |
| `agent_activity` | Pass `"failed"` for stale recovery. Do not use this tool to set other statuses in this plugin. Required. |
| `agent_error` | Always `"Stale claim: process may have crashed or timed out"` for stale recovery, so stale resets are greppable in the dashboard. Required. |

**Usage in this plugin**:
- **Stale-claim reset**: called once per stale in-progress item found during Step 1. Never called for any other purpose.

**Absolute forbiddens**:
- Do NOT use `update_action_item` to manually set `agent_activity: 'finished'` — use `record_implementation`.
- Do NOT use it to fail an item you claimed and worked on — use `fail_work_item`.
- Do NOT use it to submit a review — use `submit_plan_review`.
- Do NOT use it to reset a non-stale item (age ≤ `stale_claim_timeout_minutes`) — that would clobber active work.

**Errors**:
- `401 Unauthorized` — Token invalid.
- `404 Not Found` — Item not found (already deleted or out of scope). Log and continue.
- `409 Conflict` — Item state changed between fetch and update (e.g. the original runner finished naturally). Log as informational, not an error — this is a benign race and stale recovery should simply skip it.

---

### spin_off_action_item

Extract a brief CHILD into a standalone follow-up item, detaching it from its parent brief and recording a `derived_from` provenance link back to the original. Defaults to parking the new item as `deferred`. Use this instead of simply deferring when the parked work is genuinely SEPARATE future work rather than something to resume on the same brief.

**Parameters**:
```json
{
  "action_item_id": "4d753b6a-28d9-4d2d-8f23-af3103af76db",
  "defer": true
}
```

| Field | Requirements |
|-------|-------------|
| `action_item_id` | The UUID of the brief child to spin off. Required. |
| `defer` | Optional boolean. When `true` (the default) the spun-off item is parked as `deferred`; pass `false` to leave it `open`. |

**Server-side effect**: The child is detached from its parent brief and re-created (or re-parented) as a standalone item with a `derived_from` link to the original. Detaching a child lets the parent brief auto-complete once its remaining children are all verified, dismissed, or deferred.

**Errors**:
- `401 Unauthorized` — Token invalid.
- `404 Not Found` — Item not found.

---

### get_session_transcript

Retrieve the full message transcript of a past DevSpec session. In this plugin it is used only in **review mode** to read the conversation that produced the plan under review.

**Parameters**:
```json
{
  "session_id": "376eb0c7-0ff3-4f9f-8923-3ba3e4fbf393"
}
```

| Field | Requirements |
|-------|-------------|
| `session_id` | UUID of the session to retrieve. Usually comes from the action item's `source_session_id` field. Required. |

**Response**: The session's message transcript, including user messages, AI responses, and tool call results. Exact shape is session-specific — consume the natural-language content rather than binding to a rigid schema.

**Usage in this plugin**:
- **Review-mode transcript reading**: After detecting a review item, call with `session_id = <review_item.source_session_id>` to read the discussion that led to the plan. Skipping this call produces shallow reviews — the transcript often contains the rationale behind key decisions and rejected alternatives.

**Errors**:
- `401 Unauthorized` — Token invalid.
- `404 Not Found` — Session not found or access denied. Log a warning and proceed with description-only review.

---

### submit_plan_review

Submit structured feedback on a plan (an action item in `under_human_review` state). This is the review-mode counterpart to `add_implementation_note` — it is the only way to record a review, and it is the only way to transition the item's `agent_activity` out of `under_human_review`. After a successful submit, the item's `agent_activity` becomes NULL and the feedback is injected into the originating session for team discussion.

**Parameters**:
```json
{
  "action_item_id": "f5802208-67a2-4c1e-bddb-da38bde2245a",
  "summary": "The plan addresses the core flow but the migration strategy ignores concurrent writers. Biggest risk: a 2-minute write-blocking window during the index rebuild on the accounts table.",
  "recommendations": [
    "In `lib/db/migrations/0042.ts`, use `CREATE INDEX CONCURRENTLY` instead of `CREATE INDEX` to avoid an exclusive lock on `accounts`.",
    "Extract the balance-recalculation logic in `lib/accounts/balance.ts::recalculate()` into a dedicated service — the plan's inline approach duplicates the rule that already exists in `lib/billing/ledger.ts`."
  ],
  "questions": [
    "Blocks: migration ordering — does this migration need to run before or after `0041_add_account_flags` to avoid a transient schema conflict?",
    "Blocks: rollout — is there a feature flag controlling the new balance path, or does rollout depend purely on the migration landing?"
  ]
}
```

| Field | Requirements |
|-------|-------------|
| `action_item_id` | The UUID of the action item being reviewed. Must be in `agent_activity: 'under_human_review'`. Required. |
| `summary` | One paragraph overall assessment. Must state whether the plan is sound and name the single biggest risk. Not generic, not optimistic. Required. |
| `recommendations` | Array of strings. **Every recommendation MUST reference a specific file, function, or design decision.** Vague recommendations are rejected by the review contract. Required (may be empty array only if truly nothing to recommend, which is rare). |
| `questions` | Array of strings. **Every question MUST name what it blocks** (e.g. `"Blocks: migration design"`, not `"What about X?"`). Required (may be empty only if the plan is unambiguous, which is rare). |

**Review contract — absolute rules**:
- Do NOT rewrite the plan. Your job is to validate, flag risks, and identify gaps. DevSpec rewrites plans; reviewers review them.
- Every recommendation cites a specific code location.
- Every question names the blocker it represents.

**Server-side effect**: On success, the item's `agent_activity` transitions from `under_human_review` to NULL, the review is attached to the originating session, and the team is notified.

**Errors**:
- `401 Unauthorized` — Token invalid.
- `404 Not Found` — Item not found.
- `409 Conflict` — Item is not in `under_human_review` state (e.g. someone changed it between fetch and submit). Log and exit the review without retrying — the state change means a human is already handling it.
- `422 Unprocessable Entity` — Missing required fields or malformed payload.

---

### claim_work_item

Atomically mark an action item as in_progress. Only one runner can claim a given item — this prevents race conditions when multiple runners are active.

**CRITICAL**: Call this immediately after `get_next_work_item` succeeds — before reading the description, thinking about implementation, or taking any other action. The DevSpec dashboard only shows an item as `in_progress` once it is claimed.

**Parameters**:
```json
{
  "action_item_id": "4d753b6a-28d9-4d2d-8f23-af3103af76db",
  "agent_branch": "work/action-item-4d753b6a"
}
```

| Field | Requirements |
|-------|-------------|
| `action_item_id` | The UUID of the item returned by `get_next_work_item`. Required. |
| `agent_branch` | The feature branch name that will be created for this item (format: `{branch_prefix}{id_first_8}`). Required. |

**Success**: Item transitions from `staged` to `in_progress`.

**Errors**:
- `409 Conflict` — Another runner already claimed this item. This is a normal race condition. Print a message and exit — run again to get the next item.
- `401 Unauthorized` — Token invalid.
- `404 Not Found` — Item does not exist.

**After claiming — fetch brief context if this is a child item:** If the claimed action item has `parent_action_item_id` set (visible in the `get_next_work_item` response shape — see `## get_next_work_item` above), call `get_action_item_siblings({ action_item_id: <claimed_id> })` **before starting implementation**. The response contains:

- `parent`: the brief's title, description, and status. The description is the feature-level context the user wrote.
- `siblings`: every other child under the same brief, each with title, description, status, agent_activity, completion_summary, and (if completed) completion_note.

Read both. Use them to understand the full feature before editing code — specifically to spot files or concerns an in-progress sibling is already handling, so your changes don't conflict with sibling work. If `parent` is null (the item was flat), skip this step.

---

### get_action_item_siblings

Return the parent brief and all sibling children for an action item that belongs to a brief. Use this after claiming to get full feature context.

**Parameters**:
```json
{
  "action_item_id": "4d753b6a-28d9-4d2d-8f23-af3103af76db"
}
```

**Response**:
```json
{
  "parent": {
    "id": "…",
    "title": "Briefs system",
    "description": "Lets users group related action items under a single brief parent that acts as a feature/epic container. Done when: (a)…",
    "lifecycle": "open",
    "agent_activity": "idle"
  },
  "siblings": [
    { "id": "…", "title": "Brief list UI", "lifecycle": "open", "agent_activity": "staged", "completion_summary": null },
    { "id": "…", "title": "Brief detail page", "lifecycle": "done", "agent_activity": "finished", "completion_summary": "Shows parent header + children checklist" }
  ]
}
```

Returns `{ parent: null, siblings: [] }` when the item has no `parent_action_item_id`. Siblings exclude the item itself.

---

### add_implementation_note

Record implementation decisions and progress for the audit trail. The project owner reviews these notes in the DevSpec dashboard to understand what was done and why.

**Parameters**:
```json
{
  "action_item_id": "4d753b6a-28d9-4d2d-8f23-af3103af76db",
  "content": "## Changes\n\nModified the login timeout from 5s to 30s for mobile clients..."
}
```

| Field | Requirements |
|-------|-------------|
| `action_item_id` | The UUID of the action item. Required. |
| `content` | Markdown string describing what was changed and why. Write substantively — not placeholder text. Required. |

**When to call**:
1. **During implementation** (best-effort): After making significant changes, before testing. If this call fails, log the error and continue — do not fail the item.
2. **Before `record_implementation`** (mandatory): A final summary of all changes made. This call is required — if it fails, note the error but still proceed to `record_implementation`.

**Errors**:
- `401 Unauthorized` — Token invalid.
- `404 Not Found` — Item not found.

---

### add_commit_reference

Link a git commit SHA to an action item. This populates the commit history visible on the action item detail page in DevSpec.

This is **separate from** the automatic commit reference that `record_implementation` records — use `add_commit_reference` for:
- The final commit during autopilot / `/devspec:work` runs (called before `record_implementation` so the reference is written even if completion fails).
- Retroactively attaching commits that were made outside any DevSpec command (via the `/devspec:link` command).

**Parameters**:
```json
{
  "action_item_id": "4d753b6a-28d9-4d2d-8f23-af3103af76db",
  "commit_sha": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
  "commit_message": "[autopilot] Fix login timeout on mobile [devspec:4d753b6a-28d9-4d2d-8f23-af3103af76db]"
}
```

| Field | Requirements |
|-------|-------------|
| `action_item_id` | The UUID of the action item. Required. |
| `commit_sha` | The full git commit SHA (40 hex chars). Required. |
| `commit_message` | The full commit message (subject line is sufficient; the body is optional). Required. |

**When to call**:
- **Autopilot / work flow**: After committing, before `record_implementation`. If this call fails, note the error and still proceed to `record_implementation`.
- **Retroactive linking (`/devspec:link`)**: Any time a commit exists in the repo that should be associated with an action item but isn't yet. This is purely additive — it does not change item status.

**Errors**:
- `401 Unauthorized` — Token invalid.
- `404 Not Found` — Item not found.

---

### record_implementation

Mark an action item as completed with a full report. **All fields become part of the action item's permanent record visible to the entire team.** Write substantive content, not placeholders.

**Parameters**:
```json
{
  "action_item_id": "4d753b6a-28d9-4d2d-8f23-af3103af76db",
  "commit_sha": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
  "affected_files": [
    "src/auth/login.ts",
    "src/auth/timeout.ts",
    "tests/auth/login.test.ts"
  ],
  "completion_note": "## Changes\n\nIncreased the login timeout from 5 seconds to 30 seconds for mobile clients. The previous timeout was too aggressive for cellular connections where DNS resolution alone can take 3-5 seconds.\n\n## Approach\n\nModified the `createAuthClient` factory to accept a platform-specific timeout configuration. Mobile clients now use a dedicated timeout profile that accounts for higher-latency networks. Added a unit test verifying the mobile timeout is applied correctly.\n\n## Decisions\n\nChose to make timeout configurable per-platform rather than a global increase, since desktop clients benefit from the shorter timeout for faster failure detection.",
  "completion_summary": "Fixed login timeout on mobile by increasing the timeout from 5s to 30s for cellular connections. Mobile clients now use a platform-specific timeout profile that accounts for high-latency networks.",
  "testing_notes": "1. Open the app on a mobile device or mobile emulator\n2. Ensure the device is on a cellular connection (not WiFi)\n3. Attempt to log in with valid credentials\n4. Verify login completes successfully without timeout\n5. Verify desktop login still uses the original 5s timeout",
  "usage_notes": "Navigate to the login screen on a mobile device to observe the fix. Leave empty for non-user-facing changes.",
  "verification_report": {
    "verification_type": "partial",
    "automated_checks_passed": ["typecheck", "unit-tests"],
    "confidence": 0.85,
    "human_review_needed": ["Manual mobile device testing on cellular network"]
  }
}
```

**Field Quality Requirements**:

| Field | Requirements |
|-------|-------------|
| `commit_sha` | The actual git commit SHA. Required. |
| `agent_merged` | Boolean. `true` if the feature branch was merged into the target branch, `false` otherwise. Required. |
| `affected_files` | Array of file paths that were changed (from `git diff --name-only`). Required. |
| `completion_note` | **Multi-paragraph markdown.** Must describe: what changed, why, and any decisions made. 2-3 paragraphs minimum. Do NOT write generic placeholder text. |
| `completion_summary` | **2-4 sentences.** User-facing changelog entry suitable for non-technical stakeholders. |
| `testing_notes` | **Numbered steps.** At least 3 steps describing how to verify the change works correctly. |
| `usage_notes` | Where users can find this feature in the UI (e.g., "Navigate to Settings → Integrations"). Set to empty string `""` for non-user-facing work (refactors, infra, invisible bug fixes). |
| `verification_report.verification_type` | One of: `automated` (all checks passed), `human_required` (needs manual review), `partial` (some automated, some manual). |
| `verification_report.automated_checks_passed` | Array of check names that passed (e.g., `["typecheck", "unit-tests", "lint"]`). |
| `verification_report.confidence` | Float 0.0–1.0. How confident you are the change is correct. |
| `verification_report.human_review_needed` | Array of areas needing manual review (optional). |

**Errors**:
- `401 Unauthorized` — Token invalid.
- `404 Not Found` — Item not found or not in `in_progress` state.
- `422 Unprocessable Entity` — Missing required fields.

---

### fail_work_item

Mark an action item as failed. Use this when you cannot complete the work — merge conflicts, persistent test failures, missing dependencies, etc.

**Parameters**:
```json
{
  "action_item_id": "4d753b6a-28d9-4d2d-8f23-af3103af76db",
  "error": "Merge conflict in src/auth/login.ts — upstream changes conflict with the timeout modification. Manual resolution required.",
  "partial_work": "Branch autopilot/action-item-4d753b6a pushed with partial changes. Timeout configuration added but not integrated due to merge conflict."
}
```

| Field | Requirements |
|-------|-------------|
| `error` | Clear description of what went wrong. Required. |
| `partial_work` | Notes on any work completed before failure — branch names, partial commits, etc. Optional but helpful. |

**Errors**:
- `401 Unauthorized` — Token invalid.
- `404 Not Found` — Item not found.

---

### create_action_item

Create a new action item in the project. Used by `/devspec:create` to let developers file bugs, features, and tasks from the terminal without opening the DevSpec UI.

**Parameters**:
```json
{
  "project_id": "4d753b6a-28d9-4d2d-8f23-af3103af76db",
  "title": "Fix login timeout on mobile",
  "description": "## Context\nThe login flow times out after 5 seconds on cellular connections...",
  "type": "bug"
}
```

| Field | Requirements |
|-------|-------------|
| `project_id` | The project the item belongs to (resolved from `list_projects` via the git remote). Required when the account has more than one project; optional for single-project accounts. |
| `title` | Required. Non-empty after trimming. The server rejects titles that are too long — do not pre-enforce a length limit client-side, let the server's 422 response drive the failure. |
| `description` | Optional. The WHAT and HOW (the concrete change). Markdown supported. Keep intent and acceptance_criteria in their own fields rather than dumping everything here. |
| `intent` | Optional. The WHY — the problem being solved and desired outcome. What an agent picking the item up later needs to understand the real goal. Distinct from description. |
| `acceptance_criteria` | Optional. The definition of done — the conditions the work must satisfy to be done and correct. Concrete, checkable points. Markdown OK. |
| `ai_instructions` | Optional. Approach guidance or constraints that aren't obvious from the code. |
| `type` | Optional enum: `"bug"`, `"feature"`, `"improvement"`, `"task"`, `"query"`. Defaults to `"task"` server-side. |
| `suggest_human_only` | Optional boolean. Pass `true` only for plainly off-platform work no agent could ever do (see below). It is a suggestion — a human confirms it in DevSpec. |
| `assigned_to` | Optional user UUID. Omit for unassigned items. |
| `parent_action_item_id` | Optional. Pass the UUID of a parent item to create this as a sub-task. Max depth 1 (no grandchildren). |
| `session_id` | Optional. The DevSpec CHAT session this item originates from (e.g. a session handoff gave you one). The item becomes owned by that session — it appears in the session's transcript and "This session" panel. Omit in autopilot/terminal flows with no live chat session; never pass the runner heartbeat `session_id` or a `source_session_id` you merely read intent from. |

**Response**: The created action item object. Includes `id` (UUID assigned by the server), plus the fields you passed and defaults applied server-side (`lifecycle: "open"`, etc.). Item payloads carry `human_only`, which becomes true only once a human confirms the suggestion in DevSpec.

**When to pass `suggest_human_only: true`** — the work is pure off-platform work no agent could ever do:
- Calling or emailing an external party (lawyer, vendor, stakeholder)
- Purchasing something (a domain, a license)
- External dashboard work an agent has no access to (Stripe dashboard, DNS records, vendor onboarding)

**Everything else needs no flag** — any open item can be staged for autopilot or handed to an agent; the act of staging is the readiness decision. Research queries, ambiguous scope, and security-sensitive changes simply stay unstaged until a human decides an agent should run them.

**Errors**:
- `401 Unauthorized` — Token invalid.
- `422 Unprocessable Entity` — Missing required fields, invalid enum value, or payload too large. Server error message is usable directly.
- `500 Internal Server Error` — Transient. Retry once, then fail cleanly.

---

### send_heartbeat

Report runner presence to the DevSpec dashboard. Call on empty queue (idle) and after processing (success or failure). This is best-effort — if it fails, do not block the overall workflow.

Generate a `session_id` UUID once at startup:
```bash
node -e "console.log(require('crypto').randomUUID())"
```

**Parameters**:
```json
{
  "project_id": "4d753b6a-28d9-4d2d-8f23-af3103af76db",
  "session_id": "fdd1a2b3-c4d5-e6f7-8901-234567890abc",
  "machine_hostname": "brandons-macbook.local",
  "status": "idle",
  "cycle_count": 1,
  "tasks_completed": 1,
  "current_task_id": "00e036dd-e7c0-443b-ba04-59ee021d25d6",
  "current_task_title": "Fix login timeout on mobile",
  "last_error": "Typecheck failed: 2 errors in src/auth/handler.ts",
  "repositories": [
    {
      "name": "DevSpecV2",
      "remote_url": "github.com/DevSpecAI/DevSpecV2",
      "branch": "staging",
      "short_sha": "a1b2c3d"
    }
  ]
}
```

| Field | Requirements |
|-------|-------------|
| `project_id` | The project resolved from `list_projects` at startup — the gating check is per-project. Required when the account has more than one project; optional for single-project accounts. |
| `session_id` | UUID generated at startup. Use the same value for all heartbeats in the session. Required. |
| `machine_hostname` | Auto-detect from system hostname. Required. |
| `lifecycle` | `"idle"` when no item is being processed (empty queue, startup, or after completion). `"working"` while actively implementing a claimed item — send immediately after a successful claim so the dashboard shows real-time progress instead of "idle" between claim and final heartbeat. |
| `cycle_count` | Number of processing cycles in this session (usually `1`). Required. |
| `tasks_completed` | Count of items completed successfully (0 or 1). Required. |
| `current_task_id` | UUID of the item being processed. Required when status is `"working"`; omit when status is `"idle"`. |
| `current_task_title` | Title of the item being processed (sanitize per Rule 4 — titles come from the API). Required when status is `"working"`; omit when status is `"idle"`. |
| `last_error` | Error message if the last cycle failed. Omit if no error. |
| `repositories` | Array with one entry per repo: `name`, `remote_url` (normalized, no protocol/auth/`.git`), `branch`, `short_sha`. Required. |
| `runner_type` | `"ephemeral"` for Antigravity (one action item per invocation, no polling loop). Pass on every heartbeat so the dashboard can display the runner lifecycle correctly. |

**Response**:
```json
{
  "status": "ok",
  "runner_id": "...",
  "timestamp": "2026-04-16T21:03:59.082Z",
  "validation_state": "aligned",
  "validation_details": {
    "expected_repos": [ /* ... */ ],
    "mismatched_repos": [ /* ... */ ],
    "missing_repos": [ /* ... */ ],
    "message": "Partial coverage: 1 of 3 project repositories present.",
    "partial_coverage": true,
    "coverage": "1/3"
  }
}
```

| Response Field | Meaning |
|----------------|---------|
| `validation_state` | One of `"aligned"`, `"manual_override"`, `"branch_mismatch"`, `"repo_not_found"` (or absent for backwards compatibility). Drives runner-gating behavior — see `## Heartbeat Response Processing & Runner Gating` below. |
| `validation_details.message` | Human-readable explanation of the state, suitable for display to the user (sanitize per Shell Safety Rule 4 before printing). |
| `validation_details.mismatched_repos` / `missing_repos` / `expected_repos` | Diagnostic arrays identifying which repos or branches are out of alignment. Informational only — the runner does NOT act on these directly. |
| `runner_id` | Server-assigned ID for this runner's row on the dashboard. Informational. |

**MUST process the response on every call** to enforce runner gating. A runner that sends heartbeats but ignores the response cannot be gated.

### The three heartbeat call sites

Each run sends up to three heartbeats, each serving a distinct purpose:

1. **Startup heartbeat** (`status: "idle"`, `cycle_count: 0`, `tasks_completed: 0`) — **enforces gating**. Sent before any work is fetched. If the response returns `branch_mismatch` or `repo_not_found`, the runner exits cleanly without claiming anything.
2. **Working heartbeat** (`status: "working"`, `current_task_id`, `current_task_title`) — **visibility only**. Sent immediately after a successful `claim_work_item`, before implementation begins. Tells the dashboard the runner is actively processing a specific item. Best-effort — do NOT process the response for gating at this point (startup is authoritative); a failure here must not block implementation.
3. **Final heartbeat** (`status: "idle"`, `cycle_count: 1`, `tasks_completed: 0` or `1`, optional `last_error`) — **informational**. Sent after completion or failure. Processes the response for logging but gating enforcement happens on the next run's startup heartbeat, not this one — the current cycle's work is already durable by the time the final heartbeat is sent.

**Errors**:
- `401 Unauthorized` — Token invalid.

---

## Heartbeat Response Processing & Runner Gating

Every `send_heartbeat` call returns a response whose `validation_state` tells the runner whether it is allowed to process work. The runner MUST read this field and branch on it — heartbeats without response processing defeat the entire gating mechanism.

### The four validation states

| State | Meaning | Action |
|-------|---------|--------|
| `"aligned"` | Repo(s), branch, and ownership all match project expectations. | Proceed normally. Clear any previous gate state. |
| `"manual_override"` | An admin has explicitly overridden the gate (e.g. for ad-hoc diagnostics). | Proceed normally. Clear any previous gate state. |
| `"branch_mismatch"` | The runner's current branch doesn't match the project's expected branch (e.g. runner is on `feature-x`, project expects `staging`). | **Gate the runner.** Output the gated messages and exit cleanly without processing work. |
| `"repo_not_found"` | The runner's repo URL is not recognized as a project repo (e.g. wrong remote, or repo was recently deleted/renamed on the server). | **Gate the runner.** Output the gated messages and exit cleanly without processing work. |

**Absent, null, or unrecognized `validation_state`**: treat as a no-op (backwards compatibility with older servers). Proceed normally — the gate is only asserted when the server explicitly returns a known mismatch state.

### What gating means in this plugin

Because the Antigravity plugin is **ephemeral** — one action item per invocation, no polling loop — gating means **"exit cleanly without processing work this invocation."** Specifically:

- Do NOT call `get_next_work_item`, `get_action_items`, `claim_work_item`, or any tool that fetches or claims work.
- Do NOT attempt to fix the mismatch. NEVER `git checkout` to a different branch, NEVER switch remotes, NEVER modify local git state in any way. The runner is a **read-only observer** of the mismatch — resolution happens via the DevSpec dashboard.
- Do NOT call `fail_work_item` — no item was claimed, so there is nothing to fail.
- Exit with a non-zero-work outcome (the gated messages are the output).

### Expected gated output

Always print both lines. Sanitize `validation_details.message` per Shell Safety Rule 4 before printing.

```
⚠ Runner gated: <validation_details.message>
→ Resolve this in the DevSpec dashboard. The next /autopilot:process run will pick up automatically once the mismatch is fixed.
```

For `/devspec:work`, the second line reads `… next /devspec:work run will proceed automatically …` instead.

### When the check runs

- **Startup heartbeat (before any work)**: `/autopilot:process` runs the check in Step 0b; `/devspec:work` runs it in Phase 0 step 3b. This is the gating-enforcement heartbeat.
- **Final heartbeat (after work)**: also processes the response, but gating at this point is informational — the cycle's work has already been pushed/reported. The next invocation's startup heartbeat will enforce the gate.

### Heartbeat transient failures

If `send_heartbeat` itself fails (401, 500, network, timeout): log a one-line warning and proceed normally. A transient heartbeat failure does NOT imply a gate — gating requires an explicit `"branch_mismatch"` or `"repo_not_found"` response from the server. If the server is unreachable, we cannot know whether a gate applies; fall back to normal behavior rather than blocking the user.

### What the runner MUST NOT do

- Do NOT run `git checkout <expected_branch>` to try to fix a `branch_mismatch`. The runner is not authorized to rewrite the user's git state. The user may be on a feature branch intentionally (with in-flight work), and silently switching would destroy their state.
- Do NOT change remotes, fetch new repos, or modify `.git/config` to fix a `repo_not_found`. Same reason.
- Do NOT retry the heartbeat with different repo info hoping to get a different answer.
- Do NOT fall through to work processing when gated — that would process a claim while the server's view of the runner's environment is wrong, likely creating an incorrect commit or pushing to the wrong branch.

---

## Local Storage

This plugin persists execution history and per-task logs under `~/.devspec/` so there is a local audit trail even when the DevSpec API is unavailable. All file operations go through `node` (already an Antigravity dependency) so the same commands work on Windows, macOS, and Linux without relying on `mkdir -p`, `find -mtime`, or `stat -f%z`.

### Locations

| Path | Purpose |
|------|---------|
| `~/.devspec/execution-history.jsonl` | Append-only JSONL. One JSON object per line. Start and completion are **separate lines with the same `id`** — the viewer merges them. |
| `~/.devspec/logs/<execId>.log` | Per-task detailed log. Timestamped lines: `[<ISO>] <message>\n`. Rotated at 10 MB (renamed to `<execId>.log.1`). |

### Execution record schema

Every field is a string unless noted. Missing fields default to `null`/absent (viewers tolerate absent fields).

```json
{
  "id": "<uuid>",
  "actionItemId": "<uuid>",
  "actionItemTitle": "<string>",
  "project": "DevSpec",
  "startedAt": "<ISO-8601>",
  "status": "running",
  "triggeredBy": "autopilot",
  "agentBranch": "<string>",
  "completedAt": "<ISO-8601>",
  "duration": 1234,
  "commitSha": "<string>",
  "commitPushed": true,
  "merged": true,
  "error": "<string>"
}
```

- `lifecycle`: `"running"` | `"success"` | `"failure"` | `"timeout"` | `"skipped"`
- `triggeredBy`: `"autopilot"` | `"work"`
- `duration`: milliseconds, present only on completion records

### Node helper patterns (cross-platform)

Use these patterns whenever the plugin needs to read, write, or maintain the local storage. Generate each UUID once per execution and reuse it across all logging calls. **All user-provided values (title, id, message) must be passed as separate `process.argv` arguments — never string-concatenated into the `-e` script.** This keeps the node script fixed and avoids shell injection via the content.

**Ensure directories exist (call once at startup):**
```
node -e "const fs=require('fs'),path=require('path'),os=require('os'); fs.mkdirSync(path.join(os.homedir(),'.devspec','logs'),{recursive:true});"
```

**Generate a UUID:**
```
node -e "console.log(require('crypto').randomUUID())"
```

**Current ISO timestamp:**
```
node -e "console.log(new Date().toISOString())"
```

**Append a JSONL record (pass the JSON as the single argument):**
```
node -e "const fs=require('fs'),path=require('path'),os=require('os'); const file=path.join(os.homedir(),'.devspec','execution-history.jsonl'); fs.mkdirSync(path.dirname(file),{recursive:true}); fs.appendFileSync(file,process.argv[1]+'\n');" '<one-line-json>'
```

The `<one-line-json>` must be valid JSON on a single line. Wrap the whole argument in single quotes per Shell Safety Rule 1.

**Append a line to a per-task log:**
```
node -e "const fs=require('fs'),path=require('path'),os=require('os'); const file=path.join(os.homedir(),'.devspec','logs',process.argv[1]+'.log'); fs.mkdirSync(path.dirname(file),{recursive:true}); fs.appendFileSync(file,'['+new Date().toISOString()+'] '+process.argv[2]+'\n');" '<execId>' '<message>'
```

**Rotate a task log if it exceeds 10 MB:**
```
node -e "const fs=require('fs'),path=require('path'),os=require('os'); const file=path.join(os.homedir(),'.devspec','logs',process.argv[1]+'.log'); if(!fs.existsSync(file))process.exit(0); if(fs.statSync(file).size>10485760){const bak=file+'.1'; if(fs.existsSync(bak))fs.unlinkSync(bak); fs.renameSync(file,bak);}" '<execId>'
```

**Clean up entries older than 30 days (best-effort, errors ignored):**
```
node -e "const fs=require('fs'),path=require('path'),os=require('os'); const cutoff=Date.now()-30*86400000; const dir=path.join(os.homedir(),'.devspec','logs'); if(fs.existsSync(dir)){for(const f of fs.readdirSync(dir)){const p=path.join(dir,f); try{if(fs.statSync(p).mtimeMs<cutoff)fs.unlinkSync(p);}catch{}}} const hist=path.join(os.homedir(),'.devspec','execution-history.jsonl'); if(fs.existsSync(hist)){const lines=fs.readFileSync(hist,'utf8').split('\n').filter(Boolean); const kept=lines.filter(l=>{try{const r=JSON.parse(l); return new Date(r.startedAt||r.completedAt||0).getTime()>=cutoff;}catch{return false;}}); fs.writeFileSync(hist,kept.join('\n')+(kept.length?'\n':''));}"
```

### When to log

Every entry point that claims and processes an action item (currently `/autopilot:process` and `/devspec:work`) must:

1. **At startup** — run the *ensure directories* helper, then the *cleanup* helper (best-effort; ignore errors).
2. **After claiming** — generate one `execId` UUID, capture `startedAt`, append a `status: "running"` JSONL record, and append a `Starting: <title>` line to `<execId>.log`.
3. **At significant milestones during implementation** — append a short status line to `<execId>.log` (e.g. `Implementation complete`, `Tests passed`, `Pushed branch <name>`). Milestone logs are best-effort.
4. **At end (success)** — append a **second** JSONL record with the same `id` containing `lifecycle`, `completedAt`, `duration` (ms), `commitSha`, `commitPushed`, `merged`. Append a final line to `<execId>.log`.
5. **At end (failure)** — same as success but with `status: "failure"` and `error: <reason>`.
6. **Before appending a log line** — run the *rotate* helper for the current `execId` (best-effort).

All file operations are best-effort. If a logging call fails, print a short warning but continue the main workflow — logs must never block the actual implementation of an action item.

### Viewing local logs

`/autopilot:log` reads `~/.devspec/execution-history.jsonl`, merges start/completion records by `id`, applies optional `--status` and `--limit` filters, and prints a formatted list. This is distinct from `/autopilot:history`, which queries the DevSpec API.

---

## Worktree-Based Isolation

All implementation work — both `/autopilot:process` and `/devspec:work` — runs inside a **git worktree**, not in the main repo working directory. This is an intentional isolation boundary.

### Why worktrees

Branching in place (`git checkout -b …` in the main repo) has a sharp failure mode: if anything crashes mid-way — a test hangs, the machine reboots, the user hits Ctrl-C — the main repo is left on a random feature branch with uncommitted changes sitting in the working tree. Recovering requires the user to manually stash or discard, understand what happened, and return to their original branch. That is hostile to anyone whose main repo is an active workspace.

A worktree gives the implementation its own isolated working tree, sharing the main repo's object database. Every commit, merge, and git operation during implementation happens there. The main repo never switches branches, never has uncommitted changes written to it, and never needs to be cleaned up by the user. If a cycle fails, the main repo is **exactly** as it was when the cycle started, and cleanup is a single `git worktree remove --force`.

Three concrete wins:

1. **Clean main repo** — the user's workspace is untouched during automation.
2. **Safe failure recovery** — a crashed cycle leaves an orphan worktree, but the main repo is pristine. `git worktree prune` reaps orphans at the user's convenience.
3. **Parallel execution** — multiple runners can operate against the same repo simultaneously because each has its own worktree. (Not something this plugin exploits today, but it is a prerequisite.)

### Worktree path convention

```
worktree_path = <parent_of_main_repo>/.<basename(main_repo)>-worktrees/task-<first_8_chars_of_id>-<unix_timestamp>
```

Example: for a main repo at `/home/user/projects/my-repo` and action item id `a1b2c3d4-…`, the worktree path is:
```
/home/user/projects/.my-repo-worktrees/task-a1b2c3d4-1718284800
```

- **Hidden sibling directory** (`.<name>-worktrees`) — keeps the user's project listing clean. Most shells and file browsers hide dot-directories by default.
- **Unix timestamp suffix** — allows concurrent cycles on the same action item (retries, crash recovery) without path collisions.
- **First 8 chars of the action item id** — human-scannable; enough uniqueness given the timestamp suffix.

Construct with a single `path.join(...)` node one-liner rather than shelling to `dirname`/`basename` — that way the same code works identically on Unix and Windows.

### `node_modules` linking

Worktrees do **not** get their own `node_modules` — that would require `npm install` on every cycle (slow, disk-hungry, and often different resolution than the main repo). Instead, the runner creates a link from the worktree's `node_modules` path to the main repo's `node_modules` directory:

- **Unix/macOS**: symlink.
- **Windows**: NTFS directory junction (no admin required, unlike symlinks on Windows).

The `'junction'` argument to `fs.symlinkSync` covers both cases — it maps to a symlink on Unix and a junction on Windows. Use this **one-liner** instead of shelling to `ln -s` or `cmd /c mklink /J`:

```
node -e "require('fs').symlinkSync(require('path').join(process.argv[1],'node_modules'), require('path').join(process.argv[2],'node_modules'), 'junction');" '<main_repo>' '<worktree_path>'
```

Failure handling for the link step:
- If the main repo has no `node_modules`, the symlink call throws — log a warning, mark in the implementation note that tests needing `node_modules` were skipped, and continue. Do NOT run `npm install` as a fallback — that is out of scope for an autopilot cycle.
- Cross-device link errors (rare, but possible if the worktree and main repo are on different filesystems) — same policy: log and continue.
- Permission denied — same policy: log and continue.

### Where git operations run

Implementation, testing, staging, committing, and pushing the feature branch all happen **inside the worktree** (`cd '<worktree_path>'` once after creation).

Merging and pushing the target branch happen **from the main repo** (`cd '<main_repo>'` before the merge). This is not optional — the worktree has the feature branch checked out, so attempting to check out the target branch from inside the worktree would fail with "already checked out in another worktree".

Execution order summary:

| Step | Where |
|------|-------|
| Create worktree | main_repo |
| Link node_modules | main_repo (links INTO the worktree) |
| Implement, test, commit, push (feature branch) | worktree |
| Return to main repo before merge | main_repo |
| Merge feature branch → target, push target | main_repo |
| Remove worktree | main_repo |

### Cleanup and retry behavior

Cleanup MUST run on every path — success, failure, early return. The command is:

```
git worktree remove '<worktree_path>' --force
```

On Windows, file locks from just-finished processes can cause removal to fail with `EBUSY` or similar. Handle this with a brief wait and a single retry:

```
node -e "setTimeout(()=>{},500)"
git worktree remove '<worktree_path>' --force
```

If the retry also fails, log a warning and continue. Do **not** block completion on disk cleanup — the audit trail (commit, push, merge, implementation note) matters more than the orphan worktree. `git worktree prune` will reap it later.

### Failure handling is a "finally"

The failure path MUST attempt worktree cleanup before calling `fail_work_item` / `update_action_item`. The order is:

1. `cd '<main_repo>'` (so we are not inside the worktree when we try to remove it).
2. `git merge --abort` and `git rebase --abort` (best-effort — harmless if nothing is in progress).
3. `git worktree remove '<worktree_path>' --force` with one retry.
4. Then record the failure in DevSpec.

This guarantees the main repo is safe and clean even if the cycle is killed mid-execution. Think of it as `try { implement(); } finally { cleanup_worktree(); }` — the cleanup runs even if implementation throws.

---

## Stale Claim Recovery

Every `/autopilot:process` cycle begins with a **stale-claim recovery** pass that resets `in_progress` items whose claim is older than `stale_claim_timeout_minutes`. This prevents items from staying stuck forever when a runner crashes mid-execution.

### Why it exists

Runners can die unexpectedly: the Antigravity process is killed, the machine reboots, network drops cause the final `record_implementation` or `fail_work_item` to never land. Without stale recovery, those items sit in `in_progress` until a human manually resets them, blocking re-work. Stale recovery automates the cleanup using a simple age heuristic.

### The `stale_claim_timeout_minutes` setting

Read during Step 0 from `get_project_summary`. Default is **30 minutes**. A larger value is appropriate when action items routinely run long (complex migrations, large refactors); a smaller value makes recovery more aggressive at the cost of occasionally resetting a healthy runner that is merely slow.

The setting MUST be a positive integer. Non-numeric, missing, or ≤ 0 values fall back to 30.

### When it runs

Stale recovery runs **on every cycle, alongside the normal fetch** — not as a separate step, not as a user-visible command. Specifically, at the top of Step 1, `get_next_work_item` and `get_action_items({ agent_activity: 'implementing', lifecycle: 'open', limit: 20 })` are called in parallel. The in-progress list is scanned for stale claims before the runner acts on the staged result.

A failure of the in-progress fetch (401, 500, network error) skips recovery for this cycle only — it does NOT block the normal fetch. Stale recovery is best-effort.

### How to compute the age

Always use the `Date` constructor for timestamp parsing. **Never regex** — ISO-8601 timestamps from Supabase can include timezone offsets, fractional seconds, or `Z` suffixes that regex handles poorly.

```
# Capture current time once per cycle
NOW_MS=$(node -e "console.log(Date.now())")

# Parse each agent_claimed_at
CLAIMED_MS=$(node -e "console.log(new Date(process.argv[1]).getTime())" '<agent_claimed_at>')

# Decision
AGE_MIN=$(( (NOW_MS - CLAIMED_MS) / 60000 ))
# if AGE_MIN > stale_claim_timeout_minutes → reset
```

If `new Date(...).getTime()` returns `NaN` (bad input), skip the item and log a warning. Do not attempt to salvage a malformed timestamp.

### Ownership rule — never reset an item you own

The Antigravity plugin runs **ephemerally** (one action item per invocation), so at the moment stale recovery runs you have NOT yet claimed anything this run. Any item in the in-progress list was claimed by a different runner or a past invocation.

The **age check is the ownership check**: a claim older than `stale_claim_timeout_minutes` belongs to a crashed/abandoned runner (by definition — a healthy runner with heartbeats does not exceed this threshold for tasks of typical size). Do NOT add other ownership heuristics on top — specifically:

- Do NOT check the runner hostname or session — Antigravity runs have no persistent identity.
- Do NOT assume any in-progress item is yours. If you haven't claimed anything this run (you haven't — Step 2 is after Step 1), the item is somebody else's.
- Do NOT skip the reset because the item looks like it might still be active. That is what the age check is for.

Equally important: **never reset a non-stale item**. If `age_min ≤ stale_claim_timeout_minutes`, leave it alone. Clobbering a slow-but-healthy runner's claim would destroy in-flight work.

### The reset call

For each stale item, call:
```json
{
  "action_item_id": "<validated UUID>",
  "agent_activity": "failed",
  "agent_error": "Stale claim: process may have crashed or timed out"
}
```

via `update_action_item`. The exact `agent_error` string is deliberate — it makes stale resets greppable in the DevSpec dashboard and log queries, distinguishing them from other failures.

### Output and logging

For each successful reset, output:
```
⚠ Reset stale item: <title> (claimed <age_min> minutes ago)
```

`<title>` must be sanitized per Rule 4 before printing (titles come from the DevSpec API — untrusted content).

Best-effort log line to `~/.devspec/logs/stale-recovery-<YYYY-MM-DD>.log` (or the current `exec_id.log` if already generated):
```
[<ISO timestamp>] Reset stale claim <id> (age <age_min>m, was <title>)
```

Log failures must never block recovery.

### What not to do

- Do NOT call `fail_work_item` for stale recovery — that tool is for items the current runner claimed and then could not complete. Stale recovery uses `update_action_item` because the stale item belongs to a different (crashed) runner.
- Do NOT emit a heartbeat specifically for stale recovery — heartbeats are sent at the end of the normal cycle.
- Do NOT block the staged-work path on stale recovery. If stale resets fail or time out, continue with normal processing.

---

## Review Mode

The autopilot supports a read-only **review mode** that submits structured feedback on plans awaiting human review. This runs automatically when nothing is staged but items exist with `agent_activity: 'under_human_review'`. Review mode sits between staged and planning in priority — it never blocks on planning items.

### When Review Mode Activates

`/autopilot:process` resolves item selection in this priority order:

1. **Staged** — `get_next_work_item` returns an item → full implementation workflow.
2. **Review** — `get_next_work_item` empty AND `get_action_items({ agent_activity: 'reporting', lifecycle: 'open', limit: 1 })` returns an item → review-mode workflow (Step 9 of `process.toml`).
3. **Planning** — staged empty AND review empty AND a `planning` item exists → planning-mode workflow.
4. **Empty** — all queries empty → idle heartbeat and exit.

Review mode is only reached when nothing is staged. It always takes priority over planning.

### MCP Tools Used

Review mode uses three MCP tools for the core workflow:

- `get_action_items({ agent_activity: 'reporting', lifecycle: 'open', limit: 1 })` — fetch the next review item.
- `get_session_transcript({ session_id: <source_session_id> })` — read the conversation that produced the plan. Skipping this produces shallow reviews.
- `submit_plan_review` — record structured feedback (`summary`, `recommendations`, `questions`). This is the only MCP call that records a review and the only call that transitions the item out of `under_human_review`.

And for runner-presence reporting:

- `send_heartbeat` — idle heartbeat at the end of the run.

**Explicitly NOT used in review mode:**

- `claim_work_item` — review items are never claimed. They stay in `under_human_review` until `submit_plan_review` succeeds, which transitions `agent_activity` to NULL server-side.
- `record_implementation`, `fail_work_item`, `update_action_item` — no manual lifecycle transitions. `submit_plan_review` owns the state transition.
- `add_implementation_note` — reviews are recorded via `submit_plan_review`, NOT as implementation notes. Writing an implementation note in review mode bypasses the review contract and is a bug.
- `add_commit_reference` — no commit is produced.
- `git` commands of any kind — no branch, no staging, no commit, no push, no merge.

### Explicitly Forbidden

Review mode is strictly read-only with respect to the codebase and strictly non-authoring with respect to the plan. In review mode the runner MUST NOT:

- Create a git branch or mutate local git state.
- Modify, create, or delete any file in the repo.
- Run `git commit`, `git push`, or `git merge`.
- Call `claim_work_item`, `record_implementation`, `fail_work_item`, `update_action_item`, or `add_implementation_note`.
- Change the item's `agent_activity` manually — `submit_plan_review` performs that transition server-side.
- **Rewrite the plan.** The reviewer's contract is to validate, flag risks, and identify gaps. DevSpec rewrites plans; reviewers review them. Producing a better plan in the review is a contract violation.

### Review Contract

Every review submitted via `submit_plan_review` must satisfy:

- **Every recommendation cites a specific code location** — a file path, a function name, or a named design decision. Vague recommendations (`"Consider adding tests"`) are rejected. Specific recommendations (`"Add a test in tests/auth/timeout.test.ts covering the mobile 30s cutoff path"`) are accepted.
- **Every question names what it blocks.** Format: `"Blocks: <decision> — <question>"` (e.g. `"Blocks: migration ordering — does 0042 need to run before or after 0041?"`). Open-ended questions without a named blocker (`"What about edge cases?"`) are rejected.
- **The summary states whether the plan is sound and names the single biggest risk.** A summary that says "Looks good!" and nothing else fails the contract.

### Expected Output

**Success**:
```
🔍 Review complete for: <action item title>
  Review feedback submitted — item agent_activity transitioned to NULL.
  Feedback is injected into source session #<source_session_id (first 8 chars)> for team discussion.
  Log: ~/.devspec/logs/<exec_id>.log
```

**Failure** (item stays in `under_human_review` — do NOT call `fail_work_item`):
```
✗ Review failed: <brief reason> — item left in under_human_review state for retry
```

### Local Storage in Review Mode

Review-mode runs follow the same JSONL logging schema as implementation runs (see *Local Storage* below), with the same conventions as planning mode:

- `agentBranch: ""` in the start record (no branch).
- On completion, `commitSha: ""`, `commitPushed: false`, `merged: false` (no commit).
- `triggeredBy: "autopilot"` — review mode is a sub-mode of the autopilot runner.

---

## Planning Mode

The autopilot supports a read-only **planning mode** that generates implementation plans for action items without changing any code. This runs automatically when no staged work exists but items exist with `agent_activity: 'planning'`.

### When Planning Mode Activates

`/autopilot:process` resolves item selection in this priority order:

1. **Staged** — `get_next_work_item` returns an item → full implementation workflow (Steps 2–7 of `process.toml`).
2. **Review** — `get_next_work_item` empty AND `get_action_items({ agent_activity: 'reporting', lifecycle: 'open', limit: 1 })` returns an item → review-mode workflow (Step 9 of `process.toml`). See `## Review Mode` below.
3. **Planning** — `get_next_work_item` empty AND review empty AND `get_action_items({ agent_activity: 'idle', lifecycle: 'open', limit: 1 })` returns one or more items → planning-mode workflow (Step 8 of `process.toml`).
4. **Empty** — all three queries empty → idle heartbeat and exit.

Staged items **always** take precedence, then review, then planning. Planning mode is only reached when staged and review work are both fully drained.

### MCP Tools Used

Planning mode uses exactly two MCP tools:

- `get_action_items({ agent_activity: 'idle', lifecycle: 'open', limit: 1 })` — fetch the next pending planning item.
- `add_implementation_note(action_item_id, content)` — record the generated plan as a markdown note on the action item.

And for runner-presence reporting:

- `send_heartbeat` — idle heartbeat at the end of the run (same semantics as the implementation path).

**Explicitly NOT used in planning mode:**

- `claim_work_item` — planning items are never claimed. They stay in `planning` state, visible to the whole team, so any runner or human can take the next step.
- `record_implementation`, `fail_work_item`, `update_action_item` — no lifecycle transitions.
- `add_commit_reference` — no commit is produced.
- `git` commands of any kind — no branch, no staging, no commit, no push, no merge.

### Explicitly Forbidden

Planning mode is strictly read-only with respect to the codebase and the action item lifecycle. In planning mode the runner MUST NOT:

- Create a git branch or otherwise mutate local git state.
- Modify, create, or delete any file in the repo.
- Run `git commit`, `git push`, or `git merge`.
- Change the item's `agent_activity` — it must remain `planning` so a human can approve or reject the plan.
- Call `claim_work_item`, `record_implementation`, `fail_work_item`, or `update_action_item`.

A planning runner that violates any of these rules is broken — the whole point is that the plan is a proposal awaiting human approval, not a fait accompli.

### Expected Output

**Success**:
```
📋 Planning complete for: <action item title>
  Item stays in `planning` state — awaiting human approval.
  Log: ~/.devspec/logs/<exec_id>.log
```

**Failure** (item stays in planning state — do NOT call `fail_work_item`):
```
✗ Planning failed: <brief reason> — item left in planning state for retry
```

### Plan Content Expectations

The plan written via `add_implementation_note` must be substantive markdown covering at minimum:

- **Scope** — which files need modification or creation, and what the changes do
- **Approach** — the proposed implementation strategy, with alternatives considered
- **Risks** — edge cases, error paths, concurrency, migration safety
- **Testing strategy** — how to validate the change (unit, integration, manual)

Use clear headings (`## Scope`, `## Approach`, `## Risks`, `## Testing`) and reference files, functions, and decisions by name. The plan becomes part of the action item's permanent record and is reviewed by a human before the item is either approved (promoted to `staged` for implementation) or rejected. Vague plans are not useful — write what you would want to read if you were the reviewer.

### Local Storage in Planning Mode

Planning-mode runs follow the same JSONL logging schema as implementation runs (see *Local Storage* below), with two conventions:

- `agentBranch` in the start record is the empty string `""` (no branch is created).
- On completion, `commitSha: ""`, `commitPushed: false`, `merged: false` (no commit is produced).

`triggeredBy` remains `"autopilot"` — planning mode is a sub-mode of the autopilot runner, not a separate triggering context.

---

## Shell Safety

Action item titles, descriptions, branch names, and file paths arrive from the DevSpec API as untrusted content. Interpolating them into shell commands without sanitization is a shell-injection risk — a malicious string like `"; rm -rf / #` in a commit message or a title could execute arbitrary commands. These rules are mandatory whenever you construct a shell command from any API-returned value.

### 1. Quote all variable interpolations

When an API value (title, description, branch name, file path, commit message, etc.) is inserted into a shell command, **always wrap it in single quotes**. Single quotes prevent all expansion and interpretation by the shell.

- ✓ Correct:   `git commit -m '${title}'`
- ✗ Wrong:     `git commit -m ${title}`
- ✓ Correct:   `git add '${file_path}'`
- ✗ Wrong:     `git add ${file_path}`

Single quotes inside the value must be escaped by ending the quote, inserting an escaped quote, and reopening. Replace each `'` with `'\''`. Example: `it's` becomes `'it'\''s'`.

### 2. Validate branch names

Before using any branch name in a shell command, verify it matches the regex `^[a-zA-Z0-9/_.-]+$`. If the branch name contains any character outside this set, **fail the item** with an error rather than executing the command. This pattern covers standard git refs like `work/action-item-abc123` and rejects shell metacharacters.

### 3. Validate file paths

Before using any file path in `git add`, `git diff`, or other shell commands, verify it does not contain any of these shell metacharacters: `;` `|` `&` `$` `` ` `` `\` `(` `)` `{` `}` `<` `>` `!` `#`. If a path fails this check, **reject it** — do not stage or include it. Fail the item if all affected files fail validation.

A safe-path regex you can use: `^[a-zA-Z0-9/_. ~-]+$`.

### 4. Sanitize text used in commit messages

Before embedding any API text (titles, descriptions, summaries) inside a git commit message:

1. Replace every `'` with `'\''` (so single-quoted wrapping remains closed).
2. Strip or replace these metacharacters: `$` `` ` `` `#` `\` `|` `&` `<` `>` (they can break argument parsing or trigger expansion even inside escaped contexts on some shells).
3. Collapse newlines in the subject line to spaces.
4. Truncate the subject line to **500 characters** maximum.

When the `generate_commit_message` MCP tool returns a message, the MCP server has already formatted it — but the value you wrap in shell quotes still needs escape rule (1) applied defensively, because the message contains user-provided text from the action item.

### 5. Never interpolate raw API responses into shell commands

Always run the value through the relevant validation step above before using it in a shell command. If the value fails validation, **fail the action item** with a descriptive error — do not fall through to running a partially-sanitized command and hope for the best.

### 6. Validate UUIDs before using them in paths or commands

Before using any `action_item_id` or similar UUID in a shell command or a file path (e.g., per-task log files named `<id>.log`), verify it matches `^[0-9a-f-]{36}$` (36 chars, lowercase hex and hyphens only). Never construct a filesystem path from an unvalidated ID — a malicious ID could contain path-traversal segments like `../../etc/passwd`.

### Quick reference — validation patterns

| Value | Pattern |
|-------|---------|
| Git ref / branch name | `^[a-zA-Z0-9/_.-]+$` |
| Git remote name | `^[a-zA-Z0-9_.-]+$` |
| File path | `^[a-zA-Z0-9/_. ~-]+$` |
| UUID | `^[0-9a-f-]{36}$` |

### What to do on a validation failure

Call `fail_work_item` (in autopilot) or `update_action_item` with `agent_activity: 'failed'` (in interactive `devspec:work` flow). Include the unsafe value (truncated and quoted) and which rule it failed in the error. Do not attempt to auto-correct or strip characters silently — that masks the problem and the original content is still in DevSpec for the operator to inspect.

---

## Shell Compatibility

You may be running on Windows with PowerShell. **Do not use `&&` to chain shell commands** — it is not a valid statement separator in PowerShell. Use `;` instead (e.g., `git branch --show-current; hostname`).

**Windows npm/.bin fallback**: If `npm run <command>` or `npx` fails with "not recognized", "not found", or similar PATH errors (common when `node_modules/.bin` shims don't resolve through junctions), retry once using the direct node path:

- `tsc` → `node ./node_modules/typescript/bin/tsc --noEmit`
- Other binaries → `node ./node_modules/.bin/<command>` or `node ./node_modules/<package>/bin/<command>`

Do not retry more than once per command. If the direct path also fails, treat it as a real test failure.

## Error Handling Patterns

| Scenario | What To Do |
|----------|-----------|
| **Nothing staged** (get_next_work_item returns null) | Print "No items staged — nothing to process." and exit cleanly. |
| **401 Unauthorized** (any tool) | Print error: "Authentication failed. Regenerate your token in DevSpec: Settings > Autopilot." Exit. |
| **409 Conflict** (claim_work_item) | Print: "Item already claimed by another runner. Run again to pick up the next item." Exit cleanly. |
| **Protected path violation** (before commit) | Call `fail_work_item` listing which files matched protected patterns. Do not commit. |
| **API timeout** (any tool) | If item was claimed, call `fail_work_item` with timeout details. Otherwise, exit with timeout error. |
| **Test failures** (during implementation) | Attempt to fix once. If still failing, call `fail_work_item` with test failure details. |
| **npm/.bin shim failure** (Windows) | Retry once with direct `node ./node_modules/...` path. If still failing, treat as test failure. |
| **Merge conflicts** (during git push) | Call `fail_work_item` with conflict file list and branch name for manual resolution. |
| **500 Server Error** (any tool) | Retry once. If still failing, treat as timeout scenario above. |
