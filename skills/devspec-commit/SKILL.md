---
name: devspec-commit
description: "Generate a deployment-tracked commit message with a [devspec:<id>] tag and run git commit on the staged changes. Use when committing work tied to a DevSpec action item so DevSpec can link the commit."
---

Generate a properly formatted commit message with a `[devspec:<id>]` tag for deployment tracking, then automatically execute the git commit.

## Steps

1. **Check for staged changes** — run `git diff --cached --stat`.

2. If nothing is staged, output and stop:
   ```
   ✗ No staged changes. Stage your changes with `git add` first.
   ```

3. **Extract from user input**:
   - `action_item_id`: required — the DevSpec action item ID this commit is for
   - `summary`: required — short summary of what the commit does (under 72 chars)
   - `type`: optional, default `feat` (accept: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `style`, `perf`)
   - `body`: optional — longer description for the commit body

4. If `action_item_id` or `summary` are not provided, ask the user.

5. Call `generate_commit_message` with the parameters.

6. **Shell safety (Rule 1 + Rule 4):** Before running `git commit`, wrap the generated message in **single quotes** and escape any `'` characters inside the value by replacing each `'` with `'\''`. Do NOT use double quotes around the message — `$`, `` ` ``, and `\` inside the message would be expanded by the shell. The MCP endpoint already formats the message, but it contains user-provided text from the action item (title, description) and must still be shell-escaped defensively.
   Run:
   ```
   git commit -m '{generated_message_with_single_quotes_escaped}'
   ```

7. Get the commit SHA: `git rev-parse --short HEAD`

8. Output:
   ```
   ✓ Committed
     SHA:     {short_sha}
     Message: {subject line}
     Tag:     [devspec:{id}]
   ```

## Rules

- Do NOT output filler text before or after the confirmation
- The MCP endpoint generates the message — do not construct it yourself
- The `[devspec:<id>]` tag in the message is what DevSpec uses to link the commit
- Always wrap the commit message in **single quotes** when passing to `git commit -m` — never use double quotes (`$`, `` ` ``, and `\` inside the message would be expanded by the shell)
- Escape any `'` in the message body as `'\''` before passing to the shell
- If the commit fails (e.g., pre-commit hook), show the error and do NOT retry automatically
