#!/usr/bin/env bash
# Legacy shim for OpenCode plugin integration. Production OpenCode integration
# should invoke the prebuilt binary directly with an absolute --config path.

HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
BINARY="$HOOK_DIR/approve-bash"

if [ ! -x "$BINARY" ]; then
    echo "bash-approve: prebuilt runtime is missing; falling back to OpenCode ask flow" >&2
    exit 1
fi

exec "$BINARY" --opencode "$@"
