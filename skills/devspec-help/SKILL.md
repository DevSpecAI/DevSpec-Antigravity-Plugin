---
name: devspec-help
description: "Answer questions about how to use the DevSpec platform, grounded in the official product docs via devspec_help_search. Use when the user asks how to do something in DevSpec, how a feature works, or how to set something up."
---

Answer a question about how to use the DevSpec platform, grounded in DevSpec's official product documentation, via the `devspec_help_search` MCP tool (provided by the `devspec` MCP server).

## Arguments

Treat the user's input as their question about using DevSpec (e.g. "how do I set up autopilot?", "how does billing work?", "how do I connect a database?"). If no question was given, ask what they need help with and stop.

## Steps

1. Call `devspec_help_search` with `query` set to the question. Leave `limit` at its default; pass a higher `limit` (up to 20) only for a broad overview.

2. Answer using ONLY the returned doc sections:
   - Be concise and practical — give the steps or the direct answer.
   - Ground every claim in the returned `content` — do NOT invent features, settings, or steps that aren't in the docs.
   - Cite the docs you drew from using each result's `url` (a `/docs/...` deep link on the DevSpec site).

3. If the results only partially cover the question, say so plainly, answer what you can, and point to the closest doc — never fill gaps with guesses.

4. If `devspec_help_search` returns no results, tell the user you couldn't find it in the DevSpec docs and suggest they rephrase or browse the docs site directly.

## Notes

- This is help for using **DevSpec itself**, not the user's own project. It reads DevSpec's global product-docs corpus, so any DevSpec API token works — a read-only token is fine.
- If `devspec_help_search` isn't available, the connected DevSpec MCP server predates this feature; tell the user to update their DevSpec MCP connection.
