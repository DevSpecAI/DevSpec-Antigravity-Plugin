---
name: devspec-work
description: "Pick up a specific DevSpec action item by name or ID, optionally brainstorm, implement it in an isolated worktree, push/merge per project settings, and record the implementation. Supports --unattended for fire-and-forget. Use when asked to work on or implement a named action item."
---

Pick up a specific action item, optionally brainstorm on it, implement the changes, push/merge based on project settings, and record completion — all in one flow.

Read reference.md in this skill directory for the complete MCP tool reference, parameter schemas, and error handling patterns.

## Implementation Quality Standards

These rules apply throughout Phase 3 (Implement). Every commit passes the pre-commit self-critique before staging; violations must be fixed before committing.

### Reuse Before Build (before writing any code)

1. Read project documentation: any `CLAUDE.md` / `reference.md`, `README`, `CONTRIBUTING`, or architectural notes at the repo root and in the directory you are about to modify. These are project conventions, not suggestions.
2. Search the codebase for existing implementations of what you are about to build. Grep/glob for similar names, adjacent utilities, shared modules, and the established pattern for the kind of problem you are solving.
3. Identify the canonical location for what you are changing. Projects usually have one established place for configurable values, one for shared utilities, and one for each cross-cutting concern. Edit there rather than creating a new location.
4. If you are about to create a parallel implementation of something the codebase already has — a duplicate utility, a second version of a shared component, a reimplementation of an existing flow — **STOP**. Either extend the existing implementation, or (in unattended mode) fail the item with error `"Requires human judgment: would duplicate <existing thing>, extension blocked by <specific reason>"`. In interactive mode, ask the user before proceeding. Never ship a parallel implementation silently.

### Forbidden Patterns

- **Hardcoded values** (timeouts, limits, retry counts, URLs, version/model strings, provider choices, default parameters, feature flags) that an existing config/settings system already owns. If a config exists for this concern, write the value there and read from it — never inline.
- **Silent error suppression**: no catch/except/rescue blocks that swallow the error without logging and without a clear justification. No "just make the test pass" catches. If you must swallow, log and add a one-line comment explaining why.
- **Type, compiler, or linter escape hatches without justification**: disabling type checks, using unsafe casts, ignoring linter rules, suppressing warnings. Always add a one-line comment explaining why the tool is wrong.
- **Placeholder work**: no `TODO: implement later`, no stub functions that only log, no disabled or feature-flagged paths the action item did not request.
- **Duplicating utilities**: if the project has helpers for common concerns (formatting, validation, API access, parsing, state transitions, etc.), use them. Do not re-implement a helper that already exists.

### Pre-Commit Self-Critique (mandatory before the Phase 3 step 15 commit)

Before staging and running `git commit`, read your staged diff end-to-end with `git diff --staged` and ask honestly:

1. Did I reuse the existing pattern, or did I build a parallel one?
2. Is any value I hardcoded also owned by a config/settings system? If so, does the config drive the runtime default, or did I introduce drift?
3. Did I swallow any errors silently? If yes, is there a log and a comment explaining why?
4. Did I use any type, compiler, or linter escape hatches without explaining why?
5. Did I leave TODOs, stubs, or "for now" paths that were not in the action item?
6. If a reviewer with no context saw this diff, what is the first thing they would flag?

Fix real issues before committing. If a fix would expand scope beyond the action item, add an implementation note explaining the trade-off — do not ship broken code. This pass is **not skippable** for "small" changes.

## Phase 0 — Load Settings & Detect Mode

1. **Detect unattended mode.** Check the user's input for `--unattended`, `unattended`, or `no interruptions`. Store as boolean `is_unattended`.

   When `is_unattended` is true:
   - Never stop to ask the user anything — no prompts, no confirmations
   - If a decision requires human judgment, fail the item with a documented error rather than guessing
   - If the action item name matches multiple items, auto-select the highest-priority match

1a. **Resolve your project (account-wide token).** Your DevSpec MCP token is **account-wide** — it is not pinned to a single project, so resolve WHICH project this run is for before loading any project data. Resolution is by git remote:
   - Capture the git remote: `git remote get-url origin` → `remote_url`. If there is no `origin`, tell the user `✗ No git remote 'origin' — DevSpec cannot resolve which project this is for.` and stop.
   - Call `list_projects({ git_remote: "<remote_url>" })`. The response contains `remote_match: { resolved_project_id, candidate_project_ids }` (and each project lists its `repos`). Branch on it:
     - **`resolved_project_id` set** → store as `project_id` for the whole run; thread it on every project-scoped call below.
     - **null with `candidate_project_ids`** (repo tracked by >1 project) → this is interactive, so do NOT guess: list the candidate projects (use the `name`/`repos` in the `list_projects` result) and ask the user which one to work in. Use their pick as `project_id`.
     - **no match** → tell the user `✗ No DevSpec project tracks this repo (<remote_url>). Connect it in the DevSpec dashboard, then re-run.` and stop.
   - Reuse `remote_url` for the `repositories` array in step 3a (no need to re-capture).

2. **Load project settings.** Call `get_project_summary({ project_id })` and read `local_plugin_settings`. Use safe defaults if absent:
   - `auto_push`: false
   - `auto_merge`: false
   - `branch_prefix`: "work/action-item-"
   - `custom_instructions`: ""

   Also store the `repos` array from the same response — `[{ id, full_name, target_branch, default_branch }]`, the branch DevSpec tracks for EACH repo; the source of truth for the merge target (step 18). Do NOT assume one branch for the whole project.

   If `auto_merge` is true, treat `auto_push` as true regardless of its stored value.

3. **Record starting branch.** Run `git branch --show-current` and store as `starting_branch`.

   **Initialize local storage** (see reference.md → *Local Storage*):
   - Ensure directories exist:
     ```
     node -e "const fs=require('fs'),path=require('path'),os=require('os'); fs.mkdirSync(path.join(os.homedir(),'.devspec','logs'),{recursive:true});"
     ```
   - Run the 30-day cleanup helper from reference.md (best-effort — if it errors, warn and continue).

3a. **Collect runner identity and repo info** (for the startup heartbeat in step 3b):
   - Generate a session UUID: `node -e "console.log(require('crypto').randomUUID())"` → `session_id`. Reused in every heartbeat call this run.
   - Capture machine hostname: `node -e "console.log(require('os').hostname())"` → `machine_hostname`.
   - Collect repo info for the current working directory:
     - `remote_url` = the value already captured in step 1a (`git remote get-url origin`)
     - `normalized_url` = lowercase host, strip protocol / auth / port / `.git` suffix (e.g. `https://github.com/Org/Repo.git` → `github.com/org/repo`)
     - `branch` = `git branch --show-current` (already captured as `starting_branch`; reuse)
     - `short_sha` = `git rev-parse --short HEAD`
     - `detached` = `true` if branch is empty, else `false`
   - Store as the `repositories` array for use in every heartbeat call.

3b. **Startup heartbeat with gating check** — send an initial heartbeat and check for runner-gating conditions **before** doing any work. If the runner is gated, exit cleanly without picking up an item.

   1. Call `send_heartbeat` with:
      - `project_id` (from step 1a — the heartbeat's gating check is per-project)
      - `session_id`, `machine_hostname`, `repositories` (from step 3a)
      - `lifecycle: "idle"`, `cycle_count: 0`, `tasks_completed: 0`
      - `runner_type: "ephemeral"`

   2. **Process the response** (see reference.md → *Heartbeat Response Processing & Runner Gating*). Read `validation_state`:

      - **`"aligned"` or `"manual_override"`** — proceed to Phase 1 normally.

      - **`"branch_mismatch"` or `"repo_not_found"`** — the runner is **gated**. The `/devspec:work` flow has no polling loop, so gating means "exit cleanly without fetching or claiming any work." Specifically:
        - Output (sanitize `validation_details.message` per Rule 4):
          ```
          ⚠ Runner gated: <validation_details.message>
          → Resolve this in the DevSpec dashboard. The next /devspec:work run will proceed automatically once the mismatch is fixed.
          ```
        - Do NOT proceed to Phase 1 (no item resolution, no claim, no work). Do NOT attempt to fix the mismatch yourself (NEVER `git checkout`, NEVER switch repos, NEVER modify local git state — resolution happens via the DevSpec dashboard, not via Gemini).
        - Exit cleanly. Do NOT call `fail_work_item` — no item was claimed.

      - **`validation_state` absent, null, or unrecognized** — backwards compatibility. Proceed normally.

   3. If the heartbeat itself fails (network, 401, 500): log a one-line warning and proceed to Phase 1 anyway. Heartbeat failures are best-effort and must NEVER block work. A transient heartbeat failure does NOT imply a gate.

## Phase 1 — Resolve

4. **Resolve the action item.** Extract an identifier from the user's input (strip any `--unattended` flag first).
   - Match by ID prefix or title keywords via `get_action_items({ project_id, lifecycle: "all" })` (thread the `project_id` resolved in Phase 0 — the account-wide token does not pin a project).
   - **Interactive mode:** If ambiguous, present a numbered list and ask the user to pick.
   - **Unattended mode:** If ambiguous, auto-select highest-priority match.
   - If no match found: output `✗ No action item found matching: {input}` and stop.
   - **CRITICAL:** Store the **complete UUID** as `resolved_action_item_id`. Never truncate or reconstruct — always use the exact string from the API in every subsequent call.
   - **Shell safety (Rule 6):** Verify `resolved_action_item_id` matches `^[0-9a-f-]{36}$` before using it in any shell command or file path. If it fails, output `✗ Resolved action_item_id failed UUID validation` and stop.

5. **Load context.** Call in parallel:
   - `get_action_item_history(action_item_id)` — prior notes, commits, lifecycle changes (self-resolves from the item id; no `project_id`)
   - `search_memories({ project_id, query: "<action item title>" })` — related decisions, conventions, risks (project-scoped — thread `project_id`)

   Then read the item's spec fields: `intent` (the WHY — the problem and desired outcome), `acceptance_criteria` (your definition of done — the diff must satisfy it), and `ai_instructions` (constraints). Reading the originating conversation behind the item happens at claim time (Phase 3 step 11), driven by the `session_context` the claim returns — not here.

6. **Present the item:**
   ```
   ━━━ Work ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Title:    {title}
   ID:       {first 8 chars of id}
   Type:     {type}
   Status:   {lifecycle}
   Priority: {priority or "not set"}
   Mode:     {unattended or interactive}
   ─────────────────────────────────────────────────────────
   {description or "No description"}
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   ```
   If there are `ai_instructions`, show them under an `Instructions:` line.

## Phase 2 — Brainstorm (Optional)

7. **Unattended mode:** Skip this phase entirely — go to Phase 3.

8. **Interactive mode:** Ask once: `Brainstorm before starting? (y/n)`

9. **If yes**, run the brainstorm loop in **rounds of 5 questions** from this taxonomy (most impactful gaps first):
   - **Scope & Intent** — Core problem, out of scope?
   - **Approach & Alternatives** — Implementation strategies, existing patterns?
   - **Data & State** — Migrations, state transitions?
   - **Edge Cases & Failure Modes** — Invalid inputs, concurrency, timeouts?
   - **Dependencies & Integration** — Other systems, downstream impact?
   - **Acceptance & Verification** — How do we know it's done?

   For each: provide `**Suggested:** <proposal> — <reasoning>`, ask `Agree, adjust, or provide your own answer.`
   Accept on "yes"/"agree"/"suggested", skip on "skip".

   **After each round of 5 questions:**
   - If all high-impact areas are covered and no meaningful questions remain, end the loop automatically: `All key areas covered — wrapping up brainstorm.`
   - Otherwise, ask: `Continue brainstorming? (y/n)`
     - If **yes**: ask another round of up to 5 questions, covering new taxonomy areas or diving deeper.
     - If **no**: end the loop.
   - This continues indefinitely until the user declines or all areas are exhausted.
   **Early exit:** If the user signals done at any point ("done", "good", "stop"), end immediately.

   Compile the brainstorm outcomes and persist them **onto the action item itself** with `update_action_item` (not `add_implementation_note`): push the refined `title`, `description`, `intent`, and `acceptance_criteria`. Only send a field you actually changed during the brainstorm. **Preserve existing context** — append to or intelligently rewrite the current `description` (and `title`) rather than overwriting it wholesale; the `description` write replaces the stored value, so never discard detail the item already carried. Output: `✓ Brainstorm saved to action item`

10. **If no**, proceed to Phase 3.

## Phase 3 — Implement

11. **Claim the item.** Call `claim_work_item(action_item_id)`. If already claimed (409), output `✗ Item already claimed` and stop.

    **Send a "working" heartbeat** (best-effort) so the dashboard shows the runner actively processing this item rather than sitting idle between the claim and the final heartbeat. Call `send_heartbeat` with:
    - `project_id` (from Phase 0 step 1a)
    - `session_id`, `machine_hostname`, `repositories` (from Phase 0 step 3a)
    - `lifecycle: "working"`, `cycle_count: 1`, `tasks_completed: 0`
    - `current_task_id: <action_item_id>`
    - `current_task_title: <action item title>` (sanitize per Rule 4 before sending)
    - `runner_type: "ephemeral"`

    Wrap in try/catch. If the call fails, log a one-line warning and continue — a failed working-heartbeat MUST NOT block implementation. Do NOT process the response for gating here; the Phase 0 step 3b startup heartbeat is the authoritative gating check.

    **Record the start in local storage** (see reference.md → *Local Storage*, best-effort):
    1. Generate `exec_id` once: `node -e "console.log(require('crypto').randomUUID())"`. Reuse for all logging calls in this run.
    2. Capture `started_at` ISO timestamp.
    3. Append a starting JSONL record with `triggeredBy: "work"`:
       ```
       node -e "const fs=require('fs'),path=require('path'),os=require('os'); const file=path.join(os.homedir(),'.devspec','execution-history.jsonl'); fs.mkdirSync(path.dirname(file),{recursive:true}); fs.appendFileSync(file,process.argv[1]+'\n');" '{"id":"<exec_id>","actionItemId":"<action_item_id>","actionItemTitle":"<title>","project":"DevSpec","startedAt":"<started_at>","lifecycle":"running","triggeredBy":"work","agentBranch":"<branch_name>"}'
       ```
       **Shell safety (Rule 1 + Rule 4):** sanitize `<title>` — escape `'` as `'\''` and `"` as `\"`, strip `$ ` `` ` `` ` \\`, truncate to 500 chars.
    4. Write the first line to `~/.devspec/logs/<exec_id>.log` using the helper from reference.md.
    5. Skip all logging steps if the item was already claimed by this agent in a prior session (i.e. we are returning to address verification feedback) — start a new `exec_id` and record as normal.

    **Read the originating conversation before implementing.** The `claim_work_item` response returns a `session_context` object (`{ originating_session_id, originating_session_number, transcript_is_authoritative, instruction }`, or `null` for manual/background-origin items). If `session_context.transcript_is_authoritative` is `true` — the item was born in that session, which holds the human intent and nuance behind it — **and you have not already read that conversation** (a cold pickup, or you are not continuing that same session), call `get_session_transcript({ session_id: session_context.originating_session_id })` before implementing. Do NOT gate this on whether the item's fields look complete. If `transcript_is_authoritative` is `false` (filed externally, then attributed), the item's fields are canonical — pull the transcript only as optional background. When the transcript reveals intent or acceptance criteria the item lacks, persist it back via `update_action_item({ action_item_id, intent, acceptance_criteria })`.

12. **Create an isolated worktree (not a branch-in-place).**
    All implementation work happens inside a git worktree — a sibling directory with its own working tree but sharing the main repo's object database. This keeps the main repo clean: if anything fails mid-way, the main repo working directory is still on the original branch and nothing is left uncommitted in the user's workspace.

    a. **Record the main repo path**: `node -e "console.log(process.cwd())"` → `main_repo`. Used for every subsequent path interpolation.

    b. **Compute `branch_name`** = `{branch_prefix}{id_first_8_chars}`. If `branch_prefix` is empty, fall back to `work/action-item-`.
    **Shell safety (Rule 2):** Verify `branch_name` matches `^[a-zA-Z0-9/_.-]+$`. If `branch_prefix` from settings contains unsafe characters, fail the item with error `"Invalid branch_prefix — contains unsafe characters"` and stop.

    c. **Compute `worktree_path`** as a hidden sibling directory:
    ```
    worktree_path = <parent_of_main_repo>/.<basename(main_repo)>-worktrees/task-<first_8_chars_of_id>-<unix_timestamp>
    ```
    Via a single cross-platform node one-liner:
    ```
    node -e "const p=require('path'); const main=process.argv[1]; const ts=Math.floor(Date.now()/1000); console.log(p.join(p.dirname(main),'.'+p.basename(main)+'-worktrees','task-'+process.argv[2]+'-'+ts));" '<main_repo>' '<first_8_chars_of_id>'
    ```

    d. **Create the worktree atomically** (wrap both arguments in single quotes — Rule 1):
    ```
    git worktree add '<worktree_path>' -b '<branch_name>'
    ```
    If this fails (branch already exists, path already exists), go straight to Failure Handling — do not attempt to force-overwrite.

    e. **Link `node_modules` into the worktree** (cross-platform, no `ln`/`mklink` shelling):
    ```
    node -e "require('fs').symlinkSync(require('path').join(process.argv[1],'node_modules'), require('path').join(process.argv[2],'node_modules'), 'junction');" '<main_repo>' '<worktree_path>'
    ```
    On Windows this creates a directory junction (no admin); on Unix/macOS it creates a symlink. If it throws (no `node_modules`, permission denied, cross-device link), log a warning, note in the final implementation note that tests needing `node_modules` may be skipped, and continue. Do NOT spiral into `npm install`.

    f. **Change working directory into the worktree** for all subsequent implementation, testing, and commit steps:
    ```
    cd '<worktree_path>'
    ```
    Every `git diff`, `git add`, `git commit`, `git push`, and test-runner call from here through the push step (step 16) runs with `cwd = worktree_path`.

13. **Implement the changes.** Follow the action item description and any `ai_instructions`. Read existing files before editing. Follow code conventions. Read from the worktree path — the worktree is the correct working copy for this branch.

    **Custom Instructions:** If `custom_instructions` is set, follow them as mandatory requirements throughout implementation.

    Call `add_implementation_note` at significant milestones to keep a running log on DevSpec. Also append a short line to `~/.devspec/logs/<exec_id>.log` at each milestone (e.g. `Branch created`, `Files modified: N`, `Tests passed`, `Committed <short_sha>`, `Pushed to origin`, `Merged into <target>`) using the per-task log helper from reference.md. Run the *rotate* helper before each log append. All local log calls are best-effort.

    **Database migrations (if this item adds or edits a DB migration).** Do NOT assume which database to apply it to — applying to the wrong one is a real, destructive failure. The `get_project_summary` response you loaded in Phase 0 includes a `database_targets` array: each connected database with its non-secret `identity` (for Supabase, `identity.externalId` is the project ref), declared `environment`, and the `branch_name` whose migrations target it.
    - **(a)** Pick the target whose `branch_name` matches the merge target you resolved for the repo (its `target_branch`), or one with `branch_name: null` (applies to all branches).
    - **(b)** Apply the migration with your OWN database tooling pointed at that target's `identity` — for Supabase, ensure your Supabase tooling targets that exact project ref, not whatever it defaults to. DevSpec does not apply migrations for you and never hands you the credential.
    - **(c)** Never select the target by `name` (it can be misleading — that is the bug this prevents). If the matching target has `needs_reconnect: true` / a null `identity`, or your tooling cannot reach it, STOP and fail the item (`"Requires human judgment: cannot reach migration target <identity.externalId>"`) rather than applying to a different or default database. Be especially careful when `environment` is `production`.

14. **Test.** After implementation:
    - Run `npm run lint` if available (continue on failure but note it)
    - Run `npm test` if available (continue on failure but note it)
    - Run any test commands mentioned in `ai_instructions`

15. **Commit.** Stage only the files you changed — never use `git add -A`:
    ```
    git diff --name-only
    ```
    **Shell safety (Rule 3):** For every file path listed, verify it matches `^[a-zA-Z0-9/_. ~-]+$` and contains none of `;` `|` `&` `$` `` ` `` `\` `(` `)` `{` `}` `<` `>` `!` `#`. If any path fails validation, fail the item — do not stage it.
    Wrap each validated path in single quotes when staging (Rule 1):
    ```
    git add '<file1>' '<file2>' ...
    ```
    Call `generate_commit_message` with:
    - `action_item_id`: the action item ID
    - `summary`: short summary under 72 chars
    - `type`: infer from the work (`feat`, `fix`, `refactor`, etc.)

    Use the returned message (which includes the `[devspec:<id>]` tracking tag) to commit. **Shell safety (Rule 1 + Rule 4):** wrap the full message in single quotes and escape any `'` inside it as `'\''`:
    ```
    git commit -m '{generated_message}'
    ```
    Do NOT construct the message yourself — the `[devspec:<id>]` tag is what the deployment webhook uses.

16. **Integrate the fresh target, then push** (if auto_push enabled or implied by auto_merge).

    When auto_merge is enabled, first integrate the target branch into your work branch **in the worktree** — another session or a parallel autopilot runner may have landed work since you branched (resolve `{merge_target}` per step 18):
    ```
    git fetch origin '{merge_target}'
    git merge 'origin/{merge_target}' --no-edit
    ```
    - Conflicts here are normal, not an error: resolve them yourself on the work branch — read both sides, produce the correct combined code (never resolve by discarding the other side's changes), `git add` the resolved files and `git commit`. If you cannot produce a confident resolution, `git merge --abort` and go to Failure Handling.
    - If the merge brought in any new commits, re-run the step-14 checks against the combined state before pushing.

    Then push:
    ```
    git push -u origin '{branch_name}'
    ```

17. **Return to the main repo before merging:**
    ```
    cd '<main_repo>'
    ```
    The worktree has `<branch_name>` checked out, so merging into the target branch from there would conflict with the worktree's own checkout. **Always merge from the main repo.**

18. **Merge** (if auto_merge enabled):
    Resolve the merge target **for the repo you are pushing** from the `repos` array: the `target_branch` of the entry whose `full_name` matches this repo's `origin` remote; fall back to that entry's `default_branch`, then `starting_branch`. A multi-repo item pushes each repo to its OWN resolved branch — never one project-wide branch.
    **Shell safety (Rule 2):** Verify `merge_target` matches `^[a-zA-Z0-9/_.-]+$` before using it. If it fails, fail the item (Failure Handling will clean up the worktree).
    Merges serialize git-natively against concurrent sessions and parallel runners: **push atomicity is the lock**. Sync the local target exactly to the remote, merge, push:
    ```
    git fetch origin '<merge_target>'
    git checkout '<merge_target>'
    git merge --ff-only 'origin/<merge_target>'
    git merge '<branch_name>' --no-ff --no-edit
    git push origin '<merge_target>'
    ```
    - If the `--ff-only` sync fails, the LOCAL target has commits the remote doesn't. If they are your own leftover from a rejected attempt of THIS item, discard with `git reset --hard 'origin/<merge_target>'`; anything else (e.g. the developer's local work) must NOT be discarded — go to Failure Handling and say so.
    - The `'<branch_name>'` merge must be CLEAN — conflict resolution happened on the work branch in step 16. If it conflicts anyway, the target moved again: `git merge --abort`, repeat step 16's integrate (in the worktree — BEFORE removing it), then retry here.
    - **Push rejected (non-fast-forward)?** Someone landed between your fetch and push — normal. Retry, bounded at 3 attempts: repeat step 16's integrate (new commits → resolve → re-run checks → re-push branch), then this step. After the third rejection, go to Failure Handling — the branch is already pushed, so the developer can resolve it manually.

19. **Cleanup the worktree** — MANDATORY on every successful path (and also on failure, via Failure Handling):
    ```
    git worktree remove '<worktree_path>' --force
    ```
    Run this from `main_repo` (you already `cd`'d back in step 17). If removal fails (file lock from a just-finished process, common on Windows), wait briefly and retry once:
    ```
    node -e "setTimeout(()=>{},500)"
    git worktree remove '<worktree_path>' --force
    ```
    If the retry also fails, log a warning but do **not** block completion. `git worktree prune` can reap stale entries later.

## Phase 4 — Done

18. **Report completion.** Call in order:

    **a)** `add_implementation_note` — final summary: which files changed, what they do, decisions made.

    **b)** `add_commit_reference` — commit SHA and message.

    **c)** `record_implementation` with ALL fields (never skip any):
      - `action_item_id`
      - `commit_sha`: the final commit SHA
      - `agent_merged`: true if auto_merge was performed, false otherwise
      - `affected_files`: from `git diff --name-only`
      - `completion_note`: technical summary, 2-3 paragraphs minimum. What changed, why, decisions made. No placeholder text.
      - `completion_summary`: 2-4 sentences for non-technical stakeholders. What changed and why it matters.
      - `testing_notes`: Numbered steps a tester can follow. At least 3 steps. Reference exact URLs, UI elements, expected outcomes. For non-user-facing changes, describe how to verify correctness.
      - `usage_notes`: Where to find the feature in the UI. Empty string for non-user-facing work.
      - `verification_report`:
        - `verification_type`: `"automated"` / `"human_required"` / `"partial"`
        - `automated_checks_passed`: array of passing check names
        - `human_review_needed`: array of areas needing manual review with reasons
        - `confidence`: 0.0–1.0
      - `provider`: always pass `"antigravity"`

    **d)** `record_memory` — *only if this work surfaced something durable about the project* (a decision made, a convention followed or established, an architecture fact, a risk). `search_memories` FIRST for the closest existing match and `supersede_memory`/`retract_memory` it rather than recording a duplicate. Record only SHARED project knowledge the whole team should inherit — DevSpec memory is the team's source of truth and the in-app DevSpec assistant reads it every turn — never transient or obvious details, and never personal or machine-specific notes, which belong in your OWN local agent memory (e.g. `AGENTS.md`), not DevSpec. Skip this step entirely when nothing durable was learned.

    **e)** Write completion to local storage (see reference.md → *Local Storage*, best-effort):
    - Capture `completed_at` and compute `duration` (ms from `started_at`).
    - Append a second JSONL record with the **same `id`** as the start record: `{"id":"<exec_id>","completedAt":"<iso>","lifecycle":"success","duration":<ms>,"commitSha":"<full_sha>","commitPushed":<bool>,"merged":<bool>}` via the JSONL helper from reference.md.
    - Append a final line to `~/.devspec/logs/<exec_id>.log`: `Completed: success, commit <short_sha>, merged=<bool>`.

19. **Output the result:**
    ```
    ━━━ Done ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    ✓ {title}
      {id (first 8)} · {type} · {priority}
      {N} files changed · branch: {branch}
      completion, testing notes, and usage notes recorded
      ─────────────────────────────────────────────────────
      {✓ or ✗} Push: {pushed to origin | off}
      {✓ or ✗} Merge: {merged to {branch} | off}
    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    ```

## Failure Handling

Failure handling runs as a "finally" block — it MUST execute regardless of which step in Phase 3 or 4 blew up. The order matters: abort in-flight git operations, clean up the worktree so the main repo is safe, THEN record the failure.

1. **Abort any in-flight git operations** (best-effort — ignore errors from these calls):
   ```
   cd '<main_repo>'
   git merge --abort
   git rebase --abort
   ```
   These calls fail harmlessly if there is nothing to abort. They protect the main repo from being stuck mid-merge if the failure occurred mid-merge.

2. **Cleanup the worktree** (MANDATORY, best-effort at the edges):
   - `cd '<main_repo>'` first — if we are still inside the worktree, `git worktree remove` will refuse.
   - `git worktree remove '<worktree_path>' --force`. If it fails, wait briefly (`node -e "setTimeout(()=>{},500)"`) and retry once.
   - If the retry also fails, log a warning and continue — do not block the failure report on disk cleanup.
   - If the worktree was never created (failure happened during Phase 3 step 12 before the worktree was added), skip this step silently.

3. **Call `add_implementation_note`** documenting what was attempted and why it failed (including which step failed and whether the worktree was cleaned up).

4. **Call `update_action_item`** with `agent_activity: 'failed'`, `agent_error: <description>`.

5. **Write a failure record to local storage** (best-effort): append a second JSONL line with the same `exec_id`, `lifecycle: "failure"`, `duration`, and a sanitized `error` (escape `'` as `'\''`, strip `$ ` `` ` `` ` # \\`, truncate to 500 chars). Append a final line to `~/.devspec/logs/<exec_id>.log`: `Completed: failure — <reason>`.

6. **Output**: `✗ Failed: {reason}`

## Shell Safety

Every shell command built from an API value (title, description, branch name, file path, commit message, `action_item_id`) must follow the **Shell Safety** rules in reference.md. Summary:

1. Wrap all interpolated values in single quotes.
2. Validate branch names against `^[a-zA-Z0-9/_.-]+$`.
3. Validate file paths against `^[a-zA-Z0-9/_. ~-]+$` and reject shell metacharacters.
4. Sanitize commit-message text: escape `'` → `'\''`, strip `$ ` `` ` `` ` # \\ | & < >`, truncate to 500 chars.
5. Never interpolate raw API responses — validate first; fail the item on validation failure.
6. Validate UUIDs against `^[0-9a-f-]{36}$` before using in commands or paths.

On any validation failure, fail the item via Failure Handling — do not strip characters silently.

## Rules

- Do NOT output filler text between steps
- Do NOT ask the user to confirm or review completion fields — infer everything from git and the action item
- **Interactive mode:** Only user interactions are picking the action item (if ambiguous) and the brainstorm phase
- **Unattended mode:** Zero prompts, zero confirmations
- Always read a file before editing it
- Stage specific files only — never `git add -A` or `git add .`
- Follow the Shell Safety rules above for every shell command built from API values
- Write title and description as requirements (imperative tense), not past-tense summaries
- `completion_summary` is for end users, not developers
- `testing_notes` MUST be numbered step-by-step instructions a non-developer can follow
- `record_implementation` lands the item at `implemented`, NOT `done`. NEVER offer to verify or "mark it done", and never call `verify_action_item` — reaching `done` is a separate decision a present human makes. Report the item as implemented (plus its check status) and stop. In `--unattended` mode you never verify under any circumstances.
- ALL completion fields are required — never skip any
- If the action item is too vague or requires human judgment, fail it with error "Requires human judgment"
