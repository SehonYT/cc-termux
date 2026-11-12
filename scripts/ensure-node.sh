#!/bin/sh
# Ensure a usable Node.js (>= 18) without requiring the user to install it.
# Sets NODE to an executable path. CC_NODE_DRY_RUN=1 only prints the plan.

cc_node_version_ok() {
  "$1" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' >/dev/null 2>&1
}

ensure_node() {
  if command -v node >/dev/null 2>&1 && cc_node_version_ok node; then
    NODE=$(command -v node); export NODE
    echo "modelmesh: using node $("$NODE" -p "process.versions.node")" >&2
    return 0
  fi

  # Termux/Android: official Node builds are glibc and will not run on bionic.
  is_termux=0
  case "${PREFIX:-}" in *com.termux*) is_termux=1 ;; esac
  if [ "$(uname -s 2>/dev/null)" = "Linux" ] && [ -d /data/data/com.termux/files/usr ]; then is_termux=1; fi
  if [ "$is_termux" = "1" ]; then
    if [ "${CC_NODE_DRY_RUN:-0}" = "1" ]; then echo "modelmesh: would install Node.js via pkg (Termux)" >&2; NODE=node; export NODE; return 0; fi
    if command -v pkg >/dev/null 2>&1; then
      echo "modelmesh: installing Node.js via pkg" >&2
      pkg install -y nodejs-lts >&2 2>&1 || pkg install -y nodejs >&2 2>&1 || true
      if command -v node >/dev/null 2>&1 && cc_node_version_ok node; then NODE=$(command -v node); export NODE; return 0; fi
    fi
    echo "modelmesh: Node.js 18+ is required on Termux; run: pkg install nodejs-lts" >&2
    return 1
  fi

  os=$(uname -s 2>/dev/null || echo unknown)
  arch=$(uname -m 2>/dev/null || echo unknown)
  case "$os" in
    Linux)
      case "$arch" in
        x86_64|amd64) plat=linux-x64 ;;
        aarch64|arm64) plat=linux-arm64 ;;
        armv7l|armv6l) plat=linux-armv7l ;;
        ppc64le) plat=linux-ppc64le ;;
        s390x) plat=linux-s390x ;;
        *) plat= ;;
      esac ;;
    Darwin)
      case "$arch" in
        x86_64) plat=darwin-x64 ;;
        arm64) plat=darwin-arm64 ;;
        *) plat= ;;
      esac ;;
    *) plat= ;;
  esac

  if [ -z "$plat" ]; then
    echo "modelmesh: Node.js 18+ is required and no automatic download is available for $os/$arch" >&2
    return 1
  fi

  ver="${CC_NODE_VERSION:-v22.14.0}"
  dir="${MODELMESH_ROOT:-$HOME/.local/share/modelmesh}/runtime"
  name="node-$ver-$plat"
  NODE="$dir/$name/bin/node"

  # Reuse an earlier download.
  if [ -x "$NODE" ] && cc_node_version_ok "$NODE"; then
    echo "modelmesh: using cached node $("$NODE" -p "process.versions.node")" >&2; export NODE; return 0
  fi

  # musl distros cannot run the official glibc Node build.
  if [ -e /lib/ld-musl-x86_64.so.1 ] || [ -e /lib/ld-musl-aarch64.so.1 ]; then
    if command -v apk >/dev/null 2>&1; then
      echo "modelmesh: installing nodejs via apk" >&2
      apk add --no-cache nodejs >&2 2>&1 || true
      if command -v node >/dev/null 2>&1 && cc_node_version_ok node; then NODE=$(command -v node); export NODE; return 0; fi
    fi
    echo "modelmesh: install Node.js 18+ with your package manager (official builds need glibc)" >&2
    return 1
  fi

  url="https://nodejs.org/dist/$ver/$name.tar.gz"
  if [ "${CC_NODE_DRY_RUN:-0}" = "1" ]; then
    echo "modelmesh: would download $url into $dir" >&2; export NODE; return 0
  fi
  mkdir -p "$dir" || return 1
  tmp="$dir/.download.$$"
  if command -v curl >/dev/null 2>&1; then
    if [ -t 2 ]; then curl -fL --progress-bar --connect-timeout 15 --max-time 600 "$url" -o "$tmp.tar.gz" || return 1; else curl -fsSL --connect-timeout 15 --max-time 600 "$url" -o "$tmp.tar.gz" || return 1; fi
  elif command -v wget >/dev/null 2>&1; then wget -q --timeout=30 --tries=3 -O "$tmp.tar.gz" "$url" || return 1
  else echo "modelmesh: curl or wget is required to download Node.js" >&2; return 1; fi
  if ! command -v tar >/dev/null 2>&1; then echo "modelmesh: tar is required to unpack Node.js" >&2; return 1; fi
  # Verify against the official SHASUMS256.txt when a sha256 tool is available.
  SUM=""
  if command -v sha256sum >/dev/null 2>&1; then SUM=$(sha256sum "$tmp.tar.gz" | cut -d" " -f1)
  elif command -v shasum >/dev/null 2>&1; then SUM=$(shasum -a 256 "$tmp.tar.gz" | cut -d" " -f1); fi
  if [ -n "$SUM" ]; then
    if command -v curl >/dev/null 2>&1; then EXPECTED=$(curl -fsSL --max-time 30 "https://nodejs.org/dist/$ver/SHASUMS256.txt" 2>/dev/null | grep " $name.tar.gz" | cut -d" " -f1 || true)
    elif command -v wget >/dev/null 2>&1; then EXPECTED=$(wget -qO- --timeout=30 "https://nodejs.org/dist/$ver/SHASUMS256.txt" 2>/dev/null | grep " $name.tar.gz" | cut -d" " -f1 || true); fi
    if [ -n "$EXPECTED" ] && [ "$EXPECTED" != "$SUM" ]; then echo "modelmesh: Node.js checksum mismatch" >&2; return 1; fi
  fi
  tar -xzf "$tmp.tar.gz" -C "$dir" || return 1
  rm -f "$tmp.tar.gz"
  chmod +x "$NODE" 2>/dev/null || true
  if [ ! -x "$NODE" ] || ! cc_node_version_ok "$NODE"; then
    echo "modelmesh: downloaded Node.js cannot run on this system ($os/$arch)" >&2
    return 1
  fi
  echo "modelmesh: downloaded node $("$NODE" -p "process.versions.node")" >&2
  export NODE
}