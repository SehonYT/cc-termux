#!/bin/sh
# cross-platform entry point (Linux/macOS/Termux); Windows: install.ps1
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$DIR/install.mjs" "$@"