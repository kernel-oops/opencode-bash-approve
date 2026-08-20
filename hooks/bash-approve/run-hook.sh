#!/usr/bin/env bash
# Shim script for Claude Code hook.
# Runs a prebuilt binary. It never downloads or builds code at hook runtime.
#
# Configure in ~/.claude/settings.json:
#   "hooks": {
#     "PreToolUse": [
#       {
#         "matcher": "Bash",
#         "hooks": [{"type": "command", "command": "~/.claude/hooks/bash-approve/run-hook.sh"}]
#       },
#       {
#         "matcher": "Read|Grep",
#         "hooks": [{"type": "command", "command": "~/.claude/hooks/bash-approve/run-hook.sh"}]
#       }
#     ]
#   }

HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
BINARY="$HOOK_DIR/approve-bash"
CONFIG="$HOOK_DIR/categories.yaml"

if [ ! -r "$CONFIG" ]; then
    echo "bash-approve: required config is missing; falling through to manual approval" >&2
    exit 0
fi

if [ ! -x "$BINARY" ]; then
    echo "bash-approve: prebuilt runtime is missing; falling through to manual approval" >&2
    exit 0
fi

exec "$BINARY" --config "$CONFIG" "$@"
