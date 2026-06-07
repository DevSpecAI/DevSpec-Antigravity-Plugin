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

6. **Save to DevSpec.** Ask: `Save this brainstorm to the action item in DevSpec?`
   - If yes: call `add_implementation_note(action_item_id: <resolved_action_item_id>, content: <compiled summary>)`.
     Use the **full UUID** from `resolved_action_item_id` — never reconstruct or truncate the ID.
     Output:
     ```
     ✓ Brainstorm saved
       Item:  {first 8 chars of id} — {title}
     ```
   - If no: output `↻ Brainstorm not saved — summary is above if you need it later.`

## Rules

- Do NOT output filler text before or after structured output
- Keep questions sharp and specific — no generic prompts
- Never reveal the full question queue in advance
- If the action item already has rich context, focus questions on gaps
- Respect early termination signals from the user
- Questions are asked in rounds of 5 — no hard cap on total questions
