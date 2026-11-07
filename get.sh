#!/bin/sh
# cc-termux bootstrap installer.
#
# Downloads the repository archive and runs install.mjs. Use it directly or via:
#   curl -fsSL https://raw.githubusercontent.com/SehonYT/cc-termux/main/get.sh | bash
#
# Environment:
#   CC_TERMUX_REPO     GitHub owner/repo (default: SehonYT/cc-termux)
#   CC_TERMUX_REF      branch, tag or commit (default: main)
#   CC_TERMUX_ARCHIVE  use a local .tar.gz instead of downloading (testing/offline)
set -eu

REPO="${CC_TERMUX_REPO:-SehonYT/cc-termux}"
REF="${CC_TERMUX_REF:-main}"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

# Resolve the exact commit for main so the installed provenance matches the code.
SHA=""
DATE=""
if [ -z "${CC_TERMUX_ARCHIVE:-}" ] && [ "$REF" = "main" ]; then
  if command -v curl >/dev/null 2>&1; then ATOM=$(curl -fsSL -m 10 "https://github.com/$REPO/commits/main.atom" 2>/dev/null || true); else ATOM=""; fi
  if [ -n "$ATOM" ]; then
    SHA=$(printf "%s" "$ATOM" | grep -o "Grit::Commit/[0-9a-f]\{40\}" | head -1 | cut -d/ -f2 || true)
    DATE=$(printf "%s" "$ATOM" | sed -n "s/.*<updated>\([^<]*\)<\/updated>.*/\1/p" | head -1 || true)
  fi
fi
[ -n "$SHA" ] && export CC_TERMUX_COMMIT_SHA="$SHA"
[ -n "$DATE" ] && export CC_TERMUX_COMMIT_DATE="$DATE"

URL="https://codeload.github.com/$REPO/tar.gz/${SHA:-$REF}"
if [ -n "${CC_TERMUX_ARCHIVE:-}" ]; then
  cp "$CC_TERMUX_ARCHIVE" "$tmp/src.tar.gz"
elif command -v curl >/dev/null 2>&1; then
  if [ -t 2 ]; then CURL_OPTS="-fL --progress-bar"; else CURL_OPTS="-fsSL"; fi
  curl $CURL_OPTS "$URL" -o "$tmp/src.tar.gz"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$tmp/src.tar.gz" "$URL"
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
set +e
if [ ! -t 0 ] || [ ! -t 1 ]; then
  # curl ... | bash has no terminal on stdin/stdout. Only attach /dev/tty if it can
  # actually be opened; CI/cron/Docker often reports it as readable but has none.
  if (exec </dev/tty) 2>/dev/null; then
    "$NODE" "$INSTALL" "$@" < /dev/tty > /dev/tty 2>&1
  else
    "$NODE" "$INSTALL" "$@"
  fi
else
  "$NODE" "$INSTALL" "$@"
fi
status=$?
set -e
rm -rf "$tmp"
exit $status