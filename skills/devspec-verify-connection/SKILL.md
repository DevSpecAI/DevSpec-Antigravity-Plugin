---
name: devspec-verify-connection
description: "Verify the DevSpec connection. Two modes — 'Run the DevSpec connection check' (no ID) pings DevSpec through your token via verify_agent_connection, no git involved; 'Run the DevSpec verify tool with ID <uuid>' pushes a tagged verification commit to each tracked repo's primary branch and reports the per-repo result via report_connection_check."
---

Verify the DevSpec connection. The setup wizard hands the user one of two prompts — pick the mode by whether a verification UUID is present in the request, and never ask for one:

- `Run the DevSpec connection check` (no UUID) → **Ping mode** below. This is the personal wizard's git-free check.
- `Run the DevSpec verify tool with ID <uuid>` → **Commit mode** (the numbered steps). This is the project wizard's repo round-trip: prove that **this agent** can execute a tool, push to GitHub, and have DevSpec receive the webhook — for **every** repo the project tracks.

This is distinct from item verification — it does NOT touch action items and never calls `verify_action_item`.

The `verify_agent_connection`, `list_projects`, `get_project_summary` and `report_connection_check` MCP tools' parameter schemas are provided by the `devspec` MCP server. Follow the **Shell Safety** rules at the end whenever you interpolate a value (verification id, repo path, branch) into a shell command.

## Ping mode (no verification ID)

Call `verify_agent_connection` with no arguments. That single token-authenticated call is the whole proof: DevSpec stamps your token as agent-verified, and the user's wizard step turns green by itself within a few seconds. It needs no project, no repo, and no git — it works during first-time onboarding before any project exists.

Print exactly:

```
✓ DevSpec connection verified
  Connected as: {connected_as from the response, or the token owner}
  Your setup wizard step will turn green automatically.
```

On an error, print `✗ DevSpec connection failed: {error}` and suggest checking that the token in the MCP config is the one just created. Do not fall through to commit mode.

## Commit mode steps

### 0. Resolve the project (account-wide token)

The DevSpec MCP token is **account-wide** — it does not pin a project, so resolve which project this repo belongs to before fetching settings:
- `git remote get-url origin` → `remote_url`. If there is no `origin`, output `✗ No git remote 'origin' — cannot resolve which DevSpec project to verify.` and stop.
- Call `list_projects({ git_remote: "<remote_url>" })` and read `remote_match.resolved_project_id` → `project_id`. If it is null with `candidate_project_ids` (repo tracked by >1 project), ask the user which project to verify. If there is no match — or no remote — but a pin exists, carry on with `pinned_project_id`. Only with neither, output `✗ No DevSpec project tracks this repo, and there is no .devspec/project.json pin.` and stop.

  **Folder pin — a project with no repo yet.** Whether or not there is a remote, read `.devspec/project.json` if it exists — look in the working directory, then each parent up to and including the git repository root, never at or above your home directory (`~/.devspec` is machine state, not project config); nearest wins. It holds `{ "project_id": "<uuid>" }`. That is how a folder whose code does not exist yet names its project. **If there is no pin and no git remote resolved, offer to create one** after the user names the project: with their agreement write `{ "project_id": "<uuid>" }` to `.devspec/project.json` at the git repository root, or at the working directory when there is no repo, so the folder answers for itself next time. Only offer when nothing else resolved — a folder whose remote already matches needs no pin. **Never write it silently**, put nothing but the project id in it (no path, hostname, user or timestamp — that is what makes it safe to commit), and if a pin already names a DIFFERENT project, say which one before replacing it. Pass it as **`pinned_project_id`**, NEVER as `project_id`: `project_id` is an explicit override that outranks a verified git remote, whereas the pin is only a local assertion the server deliberately ranks BELOW a remote it can verify — so sending it as `project_id` reverses that. Send `git_remote` when you have one, `pinned_project_id` when you have one, both when you have both, and let the server arbitrate. **Never decide precedence locally.**

### 1. Fetch the target repos

Call `get_project_summary({ project_id })` (the `project_id` resolved in step 0) and read its `repos` array — `[{ id, full_name, target_branch, default_branch }]`. This is the authoritative per-repo branch map. The branch to push for a repo is `target_branch` if set, else `default_branch`, else `main`. Do not guess branches or ask the user for them.

### 2. Build the verification commit message

Rebuild it from the bare id — do NOT construct your own tag and do NOT use a commit-message generator:

```
chore: verify DevSpec [devspec-verify:<ID>]
```

The `[devspec-verify:<ID>]` marker is what DevSpec matches; it is deliberately different from the `[devspec:<id>]` work-item trailer — never substitute one for the other.

### 3. Find which targets you have locally

For each repo in `repos`, look for a local clone whose `origin` remote matches its `full_name` — check the current directory and any sibling repos. Compare `git -C '{path}' remote get-url origin` case-insensitively, tolerating a trailing `.git` and ssh-vs-https differences (e.g. `git@github.com:Org/Repo.git` and `https://github.com/org/repo` both match `Org/Repo`).

### 4. Push the tagged commit to each local target

In each matched repo's directory:

```bash
git -C '{path}' fetch origin '{branch}'
git -C '{path}' commit --allow-empty -m 'chore: verify DevSpec [devspec-verify:{ID}]'
git -C '{path}' push origin HEAD:'{branch}'
```

Push to the resolved **target branch** (`HEAD:{branch}`), not the checked-out branch. Record the outcome as `pushed` **only if `git push` exits 0**. If the push is rejected (e.g. non-fast-forward) or errors, record it as `skipped` with a short `reason` — never report `pushed` for a push that did not succeed.

### 5. Record repos with no local clone

For each target you could not find locally, record `skipped` with `reason: "not cloned locally"`. Never silently drop a repo.

### 6. Report back

Call `report_connection_check` with:
- `verification_id`: the UUID
- `results`: one entry per target — `{ repo: <full_name>, outcome: "pushed" | "skipped", reason?: <string>, branch?: <branch> }`

### 7. Output

```
✓ DevSpec verify
  Pushed:  {N}  →  {repo @ branch}, ...
  Skipped: {M}  →  {repo} ({reason}), ...
```

## Rules

- Reuse the per-repo branch map from `get_project_summary` — do not invent branches or build a separate fetch.
- The commit tag is `[devspec-verify:<ID>]`, rebuilt from the bare ID — never accept a pre-built message string.
- Only report `pushed` when the push genuinely succeeded (exit 0). A rejected/failed push is a `skipped` with a reason.
- This uses your own git credentials and MCP token — that is the point: it proves the agent's connection, not the human's.
- Distinct from item verification — never call `verify_action_item` or change any item's `lifecycle`/`agent_activity`.
- If `report_connection_check` fails with `401 Unauthorized`, output `✗ Authentication failed. Regenerate your token in DevSpec: Settings > Autopilot.` and stop.
- Follow these Shell Safety rules whenever you interpolate a value (verification id, repo path, branch) into a shell command: wrap in single quotes, validate UUIDs against `^[0-9a-f-]{36}$`, and reject branch/path values containing shell metacharacters.
