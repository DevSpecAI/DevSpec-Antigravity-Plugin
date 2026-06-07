#!/usr/bin/env bash
#
# Install the DevSpec skills into Antigravity.
#
#   ./scripts/install.sh                  # workspace install -> ./.agents/skills (current dir)
#   ./scripts/install.sh --workspace DIR  # workspace install -> DIR/.agents/skills
#   ./scripts/install.sh --global         # global install   -> ~/.gemini/antigravity/skills
#
# Skills are the *commands*. The MCP connection is configured separately — see README.md.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_SRC="$SCRIPT_DIR/../skills"

MODE="workspace"
WORKSPACE="$(pwd)"

while [ $# -gt 0 ]; do
  case "$1" in
    --global)    MODE="global"; shift ;;
    --workspace) MODE="workspace"; WORKSPACE="${2:?--workspace needs a path}"; shift 2 ;;
    -h|--help)   sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [ "$MODE" = "global" ]; then
  # NOTE: confirm this path for your Antigravity version — global skills live under the
  # Antigravity data dir. Workspace installs (.agents/skills) are the most portable.
  DEST="${HOME}/.gemini/antigravity/skills"
else
  DEST="${WORKSPACE%/}/.agents/skills"
fi

echo "Installing DevSpec skills -> $DEST"
mkdir -p "$DEST"

count=0
for skill in "$SKILLS_SRC"/*/; do
  name="$(basename "$skill")"
  rm -rf "${DEST:?}/$name"
  cp -R "$skill" "$DEST/$name"
  echo "  + $name"
  count=$((count + 1))
done

echo ""
echo "✓ Installed $count DevSpec skills into $DEST"
echo ""
echo "Next: connect the DevSpec MCP server (the skills call it):"
echo "  • Antigravity CLI : merge mcp/devspec.mcp.json into ~/.gemini/antigravity-cli/mcp_config.json"
echo "  • Antigravity app : Settings → MCP → Add server (type: HTTP, serverUrl + Bearer token)"
echo "  Get your token from DevSpec → Settings → Autopilot. Full guide in README.md."
