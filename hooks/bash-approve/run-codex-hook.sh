#!/usr/bin/env bash
# Legacy shim for Codex hook integration. It only runs a prebuilt binary.

RUNTIME_DIR="$(cd "$(dirname "$0")" && pwd)"
BINARY="$RUNTIME_DIR/approve-bash"
CONFIG="$RUNTIME_DIR/categories.yaml"

if [ ! -r "$CONFIG" ]; then
    echo "bash-approve: required config is missing; falling back to Codex approval flow" >&2
    exit 0
fi

if [ ! -x "$BINARY" ]; then
    echo "bash-approve: prebuilt runtime is missing; falling back to Codex approval flow" >&2
    exit 0
fi

exec "$BINARY" --codex --config "$CONFIG" "$@"
