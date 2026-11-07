#!/bin/sh
# cross-platform entry point (Linux/macOS/Termux); Windows: install.ps1
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$DIR/scripts/ensure-node.sh"
ensure_node || exit 1
exec "$NODE" "$DIR/install.mjs" "$@"