#!/bin/sh
# Ensure a usable Node.js (>= 18) without requiring the user to install it.
#
# Order: existing node -> Termux pkg -> official Node tarball into the install root.
# Sets NODE to an executable path. Set CC_NODE_DRY_RUN=1 to only print the plan.

cc_node_version_ok() {
  "$1" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' >/dev/null 2>&1
}

ensure_node() {
  if command -v node >/dev/null 2>&1 && cc_node_version_ok node; then
    NODE=$(command -v node)
    export NODE
    echo "cc-termux: using node $("$NODE" -p "process.versions.node")" >&2
    return 0
  fi

  if command -v pkg >/dev/null 2>&1 && [ -n "${PREFIX:-}" ]; then
    echo "cc-termux: installing Node.js via pkg" >&2
    pkg install -y nodejs-lts >&2 2>&1 || pkg install -y nodejs >&2 2>&1 || true
    if command -v node >/dev/null 2>&1 && cc_node_version_ok node; then
      NODE=$(command -v node); export NODE; return 0
    fi
  fi

  os=$(uname -s 2>/dev/null || echo unknown)
  arch=$(uname -m 2>/dev/null || echo unknown)
  case "$os" in
    Linux)
      case "$arch" in
        x86_64|amd64) plat=linux-x64 ;;
        aarch64|arm64) plat=linux-arm64 ;;
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
    echo "cc-termux: Node.js 18+ is required and no automatic download is available for $os/$arch" >&2
    return 1
  fi

  ver="${CC_NODE_VERSION:-v22.14.0}"
  dir="${CC_TERMUX_ROOT:-$HOME/.local/share/cc-termux}/runtime"
  name="node-$ver-$plat"
  url="https://nodejs.org/dist/$ver/$name.tar.gz"

  if [ "${CC_NODE_DRY_RUN:-0}" = "1" ]; then
    echo "cc-termux: would download $url into $dir" >&2
    NODE=$dir/$name/bin/node; export NODE; return 0
  fi

  mkdir -p "$dir" || return 1
  tmp="$dir/.download.$$"
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$url" -o "$tmp.tar.gz" || return 1;
  elif command -v wget >/dev/null 2>&1; then wget -qO "$tmp.tar.gz" "$url" || return 1;
  else echo "cc-termux: curl or wget is required to download Node.js" >&2; return 1; fi
  if command -v tar >/dev/null 2>&1; then
    tar -xzf "$tmp.tar.gz" -C "$dir" || return 1
  else
    echo "cc-termux: tar is required to unpack Node.js" >&2; return 1
  fi
  rm -f "$tmp.tar.gz"
  NODE="$dir/$name/bin/node"
  chmod +x "$NODE" 2>/dev/null || true
  if [ ! -x "$NODE" ]; then echo "cc-termux: Node.js download incomplete ($NODE)" >&2; return 1; fi
  echo "cc-termux: downloaded node $("$NODE" -p "process.versions.node")" >&2
  export NODE
}