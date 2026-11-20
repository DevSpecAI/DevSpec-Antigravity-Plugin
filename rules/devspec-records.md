---
trigger: model_decision
description: "How to write DevSpec records: read before you create or change a task, decision, convention, requirement, document or infrastructure-inventory entry, review a dependency update, or answer an overlap preview or a duplicate."
---

# Writing DevSpec records

Who may change what, and whether a write takes effect at once, waits for its checks or waits for a Maintainer, is the served contract's `authority_contract`: each write's `outcome` says which, so report it as the result says. These are the steps for writing records well. The call shapes are in `devspec-tools-work.md` (tasks) and `devspec-tools-knowledge.md` (memories, requirements, documents, inventory).

## Decisions and intent

- `core.record-decisions-only-on-confirmation`: before recording a decision or convention that meets that bar, ask the person whether it was deliberate and why. Only their answer records it; a "no", or no answer, records nothing.
- `core.write-the-persons-intent`: a task's `intent` is the person's own reason in plain words, never one you invent.

## Requirements are rare and asked for first

`core.ask-before-recording-requirements`: explain what a requirement is and ask. Once the person agrees, record it in one step with `record_requirement`. It is saved at once and governs no work until its own checks are ruled (`core.pending-checks-hold-the-merge`), and whether it is in force or a proposal depends on who agreed: the result's `outcome` says which.

Hold work to the requirements a claim returns, reading every linked document in full first (`core.hold-work-to-claimed-context`). Before recording an implementation, check what the work delivered against them, and link each one you saw met through `requirement_evidence` on `record_criterion_verdicts`; never record a break there (`core.check-deliverables-against-requirements`).

## Overlap previews

`core.prefer-existing-records-on-overlap`: a result of `preview_required`, from creating or materially editing a task, memory, requirement, document or inventory entry, saved nothing. Prefer the record it names: update or supersede that memory (or link a genuine companion), extend that task or brief, and talk a prior rejection through with the person before reviving it. Resend the same call with `preview_ack` set to its `receipt_id` only when a separate record, or this exact edit, is genuinely intended. Search documents before writing a guide or runbook, and update the one already covering it.

## Duplicates

When a check finds that a task you wrote duplicates another, resolve it then and there as the served contract's `core.resolve-duplicates-on-the-spot` says: with `resolve_duplicate` (preview first, then resolve) or `record_duplicate_nonmatch`. When you are answering DevSpec's duplicate notice, pass its `notice_id` on both calls.

## Task fields

- One cohesive deliverable per task; split and connect work with `parent_task_id`, `follow_up_from_task_id` or `link_tasks`.
- *Why* goes in `intent`: the person's own reason and desired outcome in plain words, with the question they would ask aloud beside any feature name, never invented and never go-ahead quotes.
- The full behaviour, in plain English, goes in `description`; checkable conditions in `acceptance_criteria`; paths, line numbers, symbols, snippets and CSS classes in `ai_instructions` (screening ignores it).
- A task for one specific external ticket, GitHub issue or error report carries its link: `external_source` (`"sentry"`, `"better_stack"`, `"github_issue"`, `"jira"`, `"plain"` or `"inbound_pipe"`), `external_id` (such as `owner/repo#42` or the error's issue id), `external_url`, and `source_pipe_id` for an inbound pipe ticket. A task created in a room that was opened from such a ticket inherits the link; pass it yourself for an issue or error you found during ordinary work or an incident.
- A task opened to fix, document or follow up an incident carries `source_incident_id`; one opened from a dependency-bot or incident pull request carries `source_pull_request_id`. `origin_reason` is derived from the source when you leave it out.

## Memory, requirement and document fields

- `summary` says when to reach for the record and what it covers, not how it came about.
- One subject per record; link companions (a runbook and the decision it carries out) through `companion_links`.
- Readable substance and the reasoning go in `body`; paths, symbols, database columns, CSS classes and snippets in `ai_instructions` (screening ignores it).

## Infrastructure inventory and dependency judgements

- An inventory entry records where one of the project's resources lives (a deployed app or site, a store listing or test build, a package, a repository, a database, a server, a provider account), from what the person said or confirmed: never an environment, an address or a provider you inferred from code or configuration. One entry per resource; `host_group` groups entries that share a box.
- Its `purpose` is a short index card: what the resource is for and who owns the account or pays for it. Detailed settings, setup notes and procedures go in a linked document or memory, attached with `companion_links`.
- Never put a credential in an entry.
- A judgement about one dependency is an entry with `resource_type: "dependency"` and the `dependency` object: an update you held back after checking it (`judgement: "held_back"`, with `held_version`) or a security advisory judged not a realistic risk (`"advisory_accepted"`, with `advisories`). Its reason is the `purpose`, `decided_by` is `"agent"` for your own checked judgement and `"person"` only when the person you act for decided it, and it carries at least one condition that would change it, as a fact DevSpec can check (`conditions`).
- When the judgement no longer stands (the update was taken, the advisory fixed), retire it with `revise_inventory_entry` (`lifecycle: "retired"` and the reason as `note`); when it was judged again, revise its `purpose` and `conditions`. `retract_inventory_entry` is only for an entry recorded by mistake.

## Dependency updates

A Dependabot or Renovate pull request that changes only dependency files needs no task. Read the release notes for every version the update skips, check any changed requirements, and run the project's checks on it; then record what you read, ran and saw with `record_dependency_review` on its pull request, naming the commit you reviewed, with `merge_when_cleared: true` to let it merge once DevSpec's check and the other required checks pass. Record again after any push. An update you decide to hold back is not reviewed there: record it as a dependency judgement. When `record_dependency_review` refuses a pull request, its reason says why; one it will not take is ordinary work, tracked with a task like any other change.
