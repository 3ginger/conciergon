#!/usr/bin/env bash
# Shared wrapper: dispatch to src/cli/<script-name>.ts via tsx.
# Called via symlinks: scripts/load-message -> _wrapper.sh, etc.
set -euo pipefail

# Resolve project root: prefer CLAUDE_PROJECT_DIR (set by Claude Code), fall back to symlink parent.
if [[ -n "${CLAUDE_PROJECT_DIR:-}" ]]; then
  ROOT="$CLAUDE_PROJECT_DIR"
else
  # $0 is the symlink path; follow it to the wrapper dir, then up one to project root.
  SCRIPT_PATH="$(cd "$(dirname "$0")" && pwd)"
  ROOT="$(dirname "$SCRIPT_PATH")"
fi

# Name of the CLI script is the invoked basename (e.g. "load-message" from scripts/load-message).
NAME="$(basename "$0")"

cd "$ROOT"
exec node --env-file="$ROOT/.env" --import tsx "$ROOT/src/cli/${NAME}.ts" "$@"
