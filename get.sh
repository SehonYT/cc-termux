#!/bin/sh
# cc-termux bootstrap installer.
#
# Downloads the repository archive and runs install.mjs. Use it directly or via:
#   curl -fsSL https://raw.githubusercontent.com/SehonYT/cc-termux/main/get.sh | bash
#
# Environment:
#   CC_TERMUX_REPO     GitHub owner/repo (default: SehonYT/cc-termux)
#   CC_TERMUX_REF      branch or tag (default: main)
#   CC_TERMUX_ARCHIVE  use a local .tar.gz instead of downloading (testing/offline)
set -eu

REPO="${CC_TERMUX_REPO:-SehonYT/cc-termux}"
REF="${CC_TERMUX_REF:-main}"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

if [ -n "${CC_TERMUX_ARCHIVE:-}" ]; then
  cp "$CC_TERMUX_ARCHIVE" "$tmp/src.tar.gz"
elif command -v curl >/dev/null 2>&1; then
  curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/heads/$REF" -o "$tmp/src.tar.gz"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$tmp/src.tar.gz" "https://codeload.github.com/$REPO/tar.gz/refs/heads/$REF"
else
  echo "cc-termux: curl or wget is required" >&2; exit 1
fi

mkdir -p "$tmp/src"
tar -xzf "$tmp/src.tar.gz" -C "$tmp/src"
INSTALL=$(find "$tmp/src" -maxdepth 2 -name install.mjs | head -1)
if [ -z "$INSTALL" ]; then echo "cc-termux: install.mjs not found in archive" >&2; exit 1; fi
ENSURE=$(find "$tmp/src" -maxdepth 3 -name ensure-node.sh | head -1)
if [ -n "$ENSURE" ]; then . "$ENSURE"; else . "$(dirname "$INSTALL")/scripts/ensure-node.sh"; fi
ensure_node || exit 1
exec "$NODE" "$INSTALL" "$@"