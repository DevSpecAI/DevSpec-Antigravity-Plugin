---
name: devspec-brainstorm
description: "Interactively brainstorm on a DevSpec action item to sharpen scope, surface edge cases, and explore approaches, then save the summary back to the item. Use when asked to brainstorm or refine an action item before implementation."
---

Interactively brainstorm on an action item to sharpen its scope, surface edge cases, and explore implementation approaches — then save the results back to DevSpec.

## Steps

1. **Resolve the action item.** Extract an action item identifier from the user's input (ID, partial ID, or title keywords).
   - If an ID (or partial ID) is provided, call `get_action_items(lifecycle: "all")` and match by ID prefix.
   - If keywords are provided instead, call `get_action_items(lifecycle: "all")` and match by title. If ambiguous (multiple matches), present a short numbered list and ask the user to pick one.
   - If nothing is provided, ask the user for an action item name or ID.
   - If no match is found, output: `✗ No action item found matching: {input}`
   - **CRITICAL:** Once resolved, store the **complete UUID** (e.g. `f43c187c-23e0-4764-885f-ef3a733d08df`) as `resolved_action_item_id`. Never truncate, pad, or reconstruct this value — always use the exact string returned by the API.

2. **Load context.** Call in parallel:
   - `get_action_item_history(action_item_id)` — prior notes, commits, lifecycle changes
   - `search_memories(query: "<action item title>")` — related decisions, conventions, risks

3. **Present the item:**
   ```
   ━━━ Brainstorm ━━━
   Title:    {title}
   ID:       {first 8 chars of id}
   Type:     {type}
   Status:   {lifecycle}
   Priority: {priority or "not set"}
   ──────────────────
   {description or "No description"}
   ━━━━━━━━━━━━━━━━━━
   ```
   If there are prior implementation notes or related memories, mention them briefly.

4. **Brainstorming loop.** Ask questions in **rounds of 5**, one at a time, drawn from this taxonomy (pick the most impactful gaps first):

   **Scope & Intent** — What is the core problem? Who benefits? What is out of scope?
   **Approach & Alternatives** — What implementation strategies exist? Existing patterns to follow or avoid?
   **Data & State** — Migrations, new entities, state transitions, side effects?
   **Edge Cases & Failure Modes** — Invalid inputs, concurrency, rate-limit, timeout concerns?
   **Dependencies & Integration** — Other systems, APIs, or action items this depends on? Downstream impact?
   **Acceptance & Verification** — How do we know it's done? What does a tester verify?

   For each question:
   - Provide a recommended answer: `**Suggested:** <proposal> — <1-sentence reasoning>`
   - Ask: `Agree, adjust, or provide your own answer.`
   - Accept on "yes" / "agree" / "suggested". Skip on "skip".

   **After each round of 5 questions:**
   - If all high-impact areas are covered and no meaningful questions remain, end the loop automatically: `All key areas covered — wrapping up brainstorm.`
   - Otherwise, ask: `Continue brainstorming? (y/n)`
     - If **yes**: ask another round of up to 5 questions, covering taxonomy areas not yet explored or diving deeper.
     - If **no**: end the loop.
   - This continues indefinitely until the user declines or all areas are exhausted.

   **Early exit:** If the user signals done at any point ("done", "good", "stop"), end the loop immediately.

5. **Compile brainstorm summary:**
   ```markdown
   ## Brainstorm Summary

   **Scope:** <1-2 sentences>
   **Approach:** <chosen strategy + key tradeoffs>
   **Edge Cases:** <bullet list of identified risks>
   **Acceptance Criteria:** <bullet list of verifiable conditions>
   **Open Questions:** <anything unresolved, if any>
   ```
   Present this summary to the user.

6. **Save to DevSpec.** Ask: `Update the action item in DevSpec with this brainstorm? (y/n)`
   - If yes: call `update_action_item(action_item_id: <resolved_action_item_id>, ...)`, mapping the agreed-upon outcomes onto the item's **own fields** rather than burying them in a note:
     - `intent` ← the sharpened scope / problem statement
     - `acceptance_criteria` ← the verifiable conditions
     - `description` ← the chosen approach, edge cases, and other concrete detail
     - `title` ← only if the brainstorm meaningfully reframed what the item is

     Only pass the fields the brainstorm actually changed. **Preserve existing context:** a `description` (or `title`) write OVERWRITES the stored value, so append to or carefully rewrite the current text — never blindly replace it and wipe out detail the item already carried. Use the **full UUID** from `resolved_action_item_id` — never reconstruct or truncate the ID.
     Output:
     ```
     ✓ Action item updated
       Item:  {first 8 chars of id} — {title}
     ```
   - If no: output `↻ Action item not updated — summary is above if you need it later.`

7. **Persist durable conclusions to DevSpec memory.** If the brainstorm settled something durable about the project beyond this one item — a decision, a convention, an architectural constraint, a risk — record it with `record_memory` so the conclusion isn't lost or kept only in local notes. `search_memories` FIRST and `supersede_memory` the closest existing match rather than duplicating. DevSpec memory is the team's SHARED source of truth; keep personal or machine-specific notes in your own local agent memory instead.

**Is it a memory or a rule?** Not the same question as the one above — a rule is durable and shared too. Judge by what it IS: a decision or fact with a reason someone might revisit is a **memory** (`record_memory`); a standing instruction to act on every time is a **rule** (`write_project_instruction_rule`). "We chose Broadcast over postgres_changes because RLS made client CDC undeliverable" is a memory; "never add client postgres_changes without documenting it" is a rule. A rule filed as a memory is one nobody follows. After writing a rule, report its `outcome` as given — `queued_for_review` means a maintainer has yet to accept it, so it is not in force. Skip this when nothing durable emerged — don't record transient or obvious details.

## Rules

- Do NOT output filler text before or after structured output
- Keep questions sharp and specific — no generic prompts
- Never reveal the full question queue in advance
- If the action item already has rich context, focus questions on gaps
- Respect early termination signals from the user
- Questions are asked in rounds of 5 — no hard cap on total questions
