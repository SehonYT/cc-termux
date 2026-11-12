#!/bin/sh
# modelmesh bootstrap installer. Env: MODELMESH_REPO, MODELMESH_REF, MODELMESH_ARCHIVE.
#   curl -fsSL https://raw.githubusercontent.com/SehonYT/modelmesh/main/get.sh | bash
set -eu

REPO="${MODELMESH_REPO:-SehonYT/modelmesh}"
REF="${MODELMESH_REF:-main}"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

# Resolve the exact commit so the installed provenance matches the code.
SHA=""
DATE=""
fetch_text() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL -m 15 "$1" 2>/dev/null || true
  elif command -v wget >/dev/null 2>&1; then wget -qO- --timeout=15 "$1" 2>/dev/null || true
  fi
}
if [ -z "${MODELMESH_ARCHIVE:-}" ]; then
  if [ "$REF" = "main" ]; then
    # Resolve the newest commit whose tests passed, not the tip of main. A commit that
    # failed ci must never be installed by default; MODELMESH_REF=main opts into bleeding edge.
    VERIFIED=$(fetch_text "https://github.com/$REPO/commits/verified.atom")
    SHA=$(printf "%s" "$VERIFIED" | grep -o "Grit::Commit/[0-9a-f]\{40\}" | head -1 | cut -d/ -f2 || true)
    DATE=$(printf "%s" "$VERIFIED" | sed -n "s/.*<updated>\([^<]*\)<\/updated>.*/\1/p" | head -1 || true)
    if [ -z "$SHA" ]; then
      printf '%s\n' "modelmesh: no verified commit yet; falling back to main (untested)" >&2
      ATOM=$(fetch_text "https://github.com/$REPO/commits/main.atom")
      SHA=$(printf "%s" "$ATOM" | grep -o "Grit::Commit/[0-9a-f]\{40\}" | head -1 | cut -d/ -f2 || true)
      DATE=$(printf "%s" "$ATOM" | sed -n "s/.*<updated>\([^<]*\)<\/updated>.*/\1/p" | head -1 || true)
    fi
  else
    API=$(fetch_text "https://api.github.com/repos/$REPO/commits/$REF")
    SHA=$(printf "%s" "$API" | sed -n 's/.*"sha"[[:space:]]*:[[:space:]]*"\([0-9a-f]\{40\}\)".*/\1/p' | head -1 || true)
    DATE=$(printf "%s" "$API" | sed -n 's/.*"date"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1 || true)
  fi
fi
[ -n "$SHA" ] && export MODELMESH_COMMIT_SHA="$SHA"
[ -n "$DATE" ] && export MODELMESH_COMMIT_DATE="$DATE"

URL="https://codeload.github.com/$REPO/tar.gz/${SHA:-$REF}"
if [ -n "${MODELMESH_ARCHIVE:-}" ]; then
  cp "$MODELMESH_ARCHIVE" "$tmp/src.tar.gz"
elif command -v curl >/dev/null 2>&1; then
  if [ -t 2 ]; then CURL_OPTS="-fL --progress-bar --retry 3 --retry-delay 2 --retry-connrefused"; else CURL_OPTS="-fsSL --retry 3 --retry-delay 2 --retry-connrefused"; fi
  curl $CURL_OPTS "$URL" -o "$tmp/src.tar.gz"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$tmp/src.tar.gz" --tries=3 --timeout=30 "$URL"
else
  echo "modelmesh: curl or wget is required" >&2; exit 1
fi

mkdir -p "$tmp/src"
tar -xzf "$tmp/src.tar.gz" -C "$tmp/src"
INSTALL=$(find "$tmp/src" -maxdepth 2 -name install.mjs | head -1)
if [ -z "$INSTALL" ]; then echo "modelmesh: install.mjs not found in archive" >&2; exit 1; fi
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