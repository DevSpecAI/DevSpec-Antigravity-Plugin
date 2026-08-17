# DevSpec Autopilot — MCP Tool Reference

## What is DevSpec?

DevSpec is an AI-native project planning and code intelligence platform. Teams use DevSpec to create, prioritize, and track action items (bugs, features, improvements, tasks). Staged items are dispatched by the server to an idle connection as a batch, or worked directly by name — either way the agent implements them and reports results back to the team.

## What This Plugin Does

This plugin connects Antigravity to DevSpec. When you run `devspec-work` (or a staged batch arrives at a `devspec-remote` connection), Antigravity claims the action item, implements the required changes in an isolated worktree, and reports completion with full audit details.

## MCP Tools

All tools are called via the `devspec` MCP server configured in `mcp_config.json`. Antigravity handles the MCP transport — you invoke tools by name.

**Account-wide token — resolve the project first.** The MCP token is account-wide; it does not pin a project. The server resolves the project per call from the most-specific id available: an `action_item_id` self-locates its project (so item-addressed tools need no `project_id`); otherwise an explicit `project_id` argument; otherwise the account's single project; otherwise it errors. So at startup you resolve WHICH project the run is for (via `list_projects` with the repo's git remote — see below) and thread `project_id` on the project-scoped tools: `get_project_summary`, `send_heartbeat`, `get_action_items`, `search_memories`, `create_action_item`. Do NOT add `project_id` to item-addressed tools (`claim_work_item`, `record_implementation`, `fail_work_item`, `update_action_item`, `add_implementation_note`, `add_commit_reference`, `get_action_item_history`, `get_action_item_siblings`, `generate_commit_message`, `get_session_transcript`, `submit_plan_review`) — they self-resolve from the item id.

---

### list_projects

Resolve which project a run is for from the repo's git remote. Call this at startup, before the first heartbeat.

**Parameters**:
```json
{ "git_remote": "https://github.com/Org/Repo.git" }
```

| Field | Requirements |
|-------|-------------|
| `git_remote` | Optional. The repo's `origin` remote URL (`git remote get-url origin`). When passed, the server matches it against every project's tracked repos and returns the match in `remote_match`. Omit to list all projects the token can see. |

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
| `remote_match.candidate_project_ids` | When `resolved_project_id` is null and this is non-empty, the remote is tracked by **more than one** project — ambiguous. Interactive (`/devspec:work`): ask the user which project. Never guess. |
| (both empty / `resolved_project_id` null with no candidates) | No project tracks this repo — tell the user to connect it in the dashboard. |

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
  "execution": {
    "auto_push": true,
    "auto_merge": true,
    "branch_prefix": "work/action-item-",
    "commit_message_prefix": "",
    "custom_instructions": "...",
    "agent_rules": "...",
    "test_commands": { "unit": "", "e2e": "", "typecheck": "" },
    "protected_paths": []
  },
  "owner_agent_rules": "..."
}
```

Read execution settings from the unified **`execution`** block. For back-compat with older web/MCP versions that don't serve it, fall back to the legacy `local_plugin_settings` object, then the legacy `autopilot` execution fields — both are still populated during rollout but are deprecated. The merge target is NOT a setting: resolve it per-repo from the `repos` array (`target_branch` → `default_branch`).

**Key settings** (all in `execution`):
- `auto_push`: Whether to push feature branches to remote (default **true**)
- `auto_merge`: Whether to merge feature branches into the repo's target branch after push (default **true**; implies auto_push)
- `branch_prefix`: Prefix for feature branches (e.g., "work/action-item-")
- `commit_message_prefix`: Optional prefix prepended to commit messages
- `custom_instructions`: Team **Principles** — engineering philosophy / quality bar. Shapes *how* you build.
- `agent_rules` (execution): Team **Agent Execution Rules** — concrete execution mechanics (run typecheck/build before pushing, never `git stash`, commit only your own files, honour the target branch). Mandatory for a coding agent.
- `owner_agent_rules` (top-level, not in `execution`): The caller's **Personal Agent Rules** — their machine/tooling context. Apply to how you run work locally. Precedence: personal rules govern local working-style; shared-repo-safety rules always hold. Absent on older MCP versions.
- `test_commands`: `{ unit, e2e, typecheck }` — commands to run to verify work; skip when unset (no toolchain assumed)
- `protected_paths`: Glob patterns of files that must not be modified

---

### get_action_items

List action items by filter. Used to find planning-mode work or to resolve a prose-named item the user asked you to work.

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

**Response**: Array of action items (id, title, description, priority, type, lifecycle, agent_activity, tags, affected_files, parent_action_item_id, etc.).

**Usage in this plugin**:
- **Finding work**: resolving a prose-named item the user asked you to work, or listing a brief's open items.

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

### get_session_transcript

Retrieve the full message transcript of a past DevSpec session. In this plugin it is used at **claim time** — to read the human intent and nuance behind an item you are about to implement — and in **review mode**, to read the conversation that produced the plan under review.

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
- **Claim-time intent reading**: when `claim_work_item` returns a `session_context` with `transcript_is_authoritative: true`, call with `session_id = session_context.originating_session_id` before implementing. The item was born in that conversation, which carries the human intent and nuance its fields can lose — read it on every cold pickup, and do NOT gate on whether the fields "look complete". When `transcript_is_authoritative` is `false`, the item's fields are canonical and the transcript is only optional background.
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

**CRITICAL**: Call this immediately after choosing the item to work — before reading the description, thinking about implementation, or taking any other action. The DevSpec dashboard only shows an item as `in_progress` once it is claimed.

**Parameters**:
```json
{
  "action_item_id": "4d753b6a-28d9-4d2d-8f23-af3103af76db",
  "agent_branch": "work/action-item-4d753b6a"
}
```

| Field | Requirements |
|-------|-------------|
| `action_item_id` | The UUID of the item being claimed. Required. |
| `agent_branch` | The feature branch name that will be created for this item (format: `{branch_prefix}{id_first_8}`). Required. |

**Success**: Item transitions from `staged` to `in_progress`.

**Errors**:
- `409 Conflict` — Another runner already claimed this item. This is a normal race condition. Print a message and exit — run again to get the next item.
- `401 Unauthorized` — Token invalid.
- `404 Not Found` — Item does not exist.

**After claiming — fetch brief context if this is a child item:** If the claimed action item has `parent_action_item_id` set (visible in the claim response), call `get_action_item_siblings({ action_item_id: <claimed_id> })` **before starting implementation**. The response contains:

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
- The final commit during `/devspec:work` / dispatched-batch runs (called before `record_implementation` so the reference is written even if completion fails).
- Retroactively attaching commits that were made outside any DevSpec command (via the `/devspec:link` command).

**Parameters**:
```json
{
  "action_item_id": "4d753b6a-28d9-4d2d-8f23-af3103af76db",
  "commit_sha": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
  "commit_message": "fix: Fix login timeout on mobile [devspec:4d753b6a-28d9-4d2d-8f23-af3103af76db]"
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
  "partial_work": "Branch feat/action-item-4d753b6a pushed with partial changes. Timeout configuration added but not integrated due to merge conflict."
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
| `session_id` | Optional. The DevSpec CHAT session this item originates from (e.g. a session handoff gave you one). The item becomes owned by that session — it appears in the session's transcript and "This session" panel. Omit in terminal flows with no live chat session; never pass the runner heartbeat `session_id` or a `source_session_id` you merely read intent from. |

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
  "machine_hostname": "your-machine.local",
  "status": "idle",
  "cycle_count": 1,
  "tasks_completed": 1,
  "current_task_id": "00e036dd-e7c0-443b-ba04-59ee021d25d6",
  "current_task_title": "Fix login timeout on mobile",
  "last_error": "Typecheck failed: 2 errors in src/auth/handler.ts",
  "repositories": [
    {
      "name": "my-app",
      "remote_url": "github.com/your-org/my-app",
      "branch": "main",
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

- Do NOT call `reserve_work_items`, `get_action_items`, `claim_work_item`, or any tool that fetches, reserves or claims work.
- Do NOT attempt to fix the mismatch. NEVER `git checkout` to a different branch, NEVER switch remotes, NEVER modify local git state in any way. The runner is a **read-only observer** of the mismatch — resolution happens via the DevSpec dashboard.
- Do NOT call `fail_work_item` — no item was claimed, so there is nothing to fail.
- Exit with a non-zero-work outcome (the gated messages are the output).

### Expected gated output

Always print both lines. Sanitize `validation_details.message` per Shell Safety Rule 4 before printing.

```
⚠ Runner gated: <validation_details.message>
→ Resolve this in the DevSpec dashboard. The next run (`devspec-work` or a dispatched batch) will proceed automatically once the mismatch is fixed.
```

For `/devspec:work`, the second line reads `… next /devspec:work run will proceed automatically …` instead.

### When the check runs

- **Startup heartbeat (before any work)**: `/devspec:work` runs it in Phase 0 step 3b. This is the gating-enforcement heartbeat.
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
  "project": "<project name or id>",
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

Every entry point that claims and processes an action item (`devspec-work`, or a dispatched batch under `devspec-remote`) must:

1. **At startup** — run the *ensure directories* helper, then the *cleanup* helper (best-effort; ignore errors).
2. **After claiming** — generate one `execId` UUID, capture `startedAt`, append a `status: "running"` JSONL record, and append a `Starting: <title>` line to `<execId>.log`.
3. **At significant milestones during implementation** — append a short status line to `<execId>.log` (e.g. `Implementation complete`, `Tests passed`, `Pushed branch <name>`). Milestone logs are best-effort.
4. **At end (success)** — append a **second** JSONL record with the same `id` containing `lifecycle`, `completedAt`, `duration` (ms), `commitSha`, `commitPushed`, `merged`. Append a final line to `<execId>.log`.
5. **At end (failure)** — same as success but with `status: "failure"` and `error: <reason>`.
6. **Before appending a log line** — run the *rotate* helper for the current `execId` (best-effort).

All file operations are best-effort. If a logging call fails, print a short warning but continue the main workflow — logs must never block the actual implementation of an action item.

### Viewing local logs

`~/.devspec/execution-history.jsonl` holds one JSONL record per run (start and completion, merged by `id`) — inspect it directly; per-item history with outcomes lives server-side on the item and its assignment.

---

## Worktree-Based Isolation

All implementation work runs inside a **git worktree**, not in the main repo working directory. This is an intentional isolation boundary.

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
