#!/usr/bin/env bash
set -euo pipefail

RUNTIME_DIR="$(cd "$(dirname "$0")" && pwd)"
BINARY="$RUNTIME_DIR/approve-bash"

if [ ! -x "$BINARY" ]; then
  echo "bash-approve: prebuilt runtime is missing" >&2
  exit 1
fi

exec "$BINARY" --pi "$@"
