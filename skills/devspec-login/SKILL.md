---
name: devspec-login
description: "Sign DevSpec remote control and commit tracking in through the browser, as Antigravity (one approval), check that sign-in, or sign out of it. Use when asked to sign in or log in to DevSpec, when a DevSpec message says to run /devspec-login, or for /devspec-login."
---

# DevSpec sign-in for remote control and commit tracking

DevSpec's tools sign in through Antigravity itself (the DevSpec server in `/mcp`). Remote control, commit tracking and the plugin's hooks run outside Antigravity's sign-in, so they have one approval of their own, on DevSpec's page, naming Antigravity. This skill starts, checks or ends that one.

Never ask the person for a token, never open the link or approve anything for them, and never read the files under `~/.devspec/`: the script handles all of it.

Resolve the plugin folder first:

```bash
PLUGIN_DIR="$HOME/.gemini/config/plugins/devspec"; [ -d "$PLUGIN_DIR" ] || PLUGIN_DIR="$HOME/.gemini/config/plugins/antigravity-devspec-autopilot-extension"
```

## Sign in (the default)

```bash
node "$PLUGIN_DIR/scripts/devspec-login.mjs" --start
```

It opens DevSpec's approval page in the person's browser and returns at once. Show the person the text it prints, including the link (it is for them to open if no tab appeared). Once they approve, remote control and commit tracking are ready; there is nothing to wait for or run afterwards.

## Sign in with a code (`/devspec-login --code`)

For a machine the browser cannot reach (an SSH session, a remote box), or when the text from `--start` says to:

1. Run `node "$PLUGIN_DIR/scripts/devspec-login.mjs" --code` and show the person the link it prints. They open it, approve Antigravity, and DevSpec's page shows a code.
2. When they paste that code to you, run `node "$PLUGIN_DIR/scripts/devspec-login.mjs" --code "<the code exactly as pasted>"` and show them what it prints.

## Check (`/devspec-login --status`)

```bash
node "$PLUGIN_DIR/scripts/devspec-login.mjs" --status
```

## Sign out (`/devspec-login --logout`)

```bash
node "$PLUGIN_DIR/scripts/devspec-login.mjs" --logout
```

This signs out remote control and commit tracking only. To disconnect Antigravity from DevSpec entirely, the person uses Agent setup in their DevSpec settings.

If any of these prints that `DEVSPEC_MCP_TOKEN` is set, show that text: the token takes precedence, and the text says how to remove it.
