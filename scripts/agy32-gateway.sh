#!/data/data/com.termux/files/usr/bin/bash
# Run the Go Antigravity gateway (arm32) on a 32-bit Termux device.
# Three things block it here; each is handled below, in order.
set -euo pipefail

BIN="${AGY_BIN:-$HOME/agy32/antigravity-gateway-arm32}"
PORT="${AGY_PORT:-28780}"
TOKEN="$HOME/.gemini/antigravity-cli/antigravity-oauth-token"
CREDS="$HOME/.config/modelmesh/antigravity.json"

[ -x "$BIN" ] || { echo "gateway binary not found or not executable: $BIN" >&2; exit 1; }

# 1. The CLI token file expires independently of ours. The gateway reads only that file, so a
#    stale copy makes every request fail with "no valid OAuth token" while our gateway works.
#    Refresh it from modelmesh's live credentials when it is expired or nearly so.
if [ -f "$CREDS" ]; then
  node -e '
    const fs = require("fs");
    const [tokPath, credsPath] = process.argv.slice(1);
    let tok, creds;
    try { tok = JSON.parse(fs.readFileSync(tokPath, "utf8")); } catch (e) { process.exit(0); }
    try { creds = JSON.parse(fs.readFileSync(credsPath, "utf8")); } catch (e) { process.exit(0); }
    if (!tok.token || !creds.access_token) process.exit(0);
    const exp = Date.parse(tok.token.expiry || 0);
    if (exp - Date.now() > 300000) process.exit(0);
    tok.token.access_token = creds.access_token;
    tok.token.refresh_token = creds.refresh_token;
    tok.token.expiry = new Date(Date.now() + 3600e3).toISOString();
    tok.token.expires_in = 3600;
    fs.writeFileSync(tokPath, JSON.stringify(tok));
    console.log("refreshed the CLI token file from modelmesh credentials");
  ' "$TOKEN" "$CREDS" || true
fi

# 2. Go reads /etc/resolv.conf and nothing else. On Termux that path is a read-only symlink to
#    /system/etc, so the pure-Go resolver falls back to [::1]:53 and every DNS lookup is refused.
#    proot binds Termux's real resolv.conf over it for this process only.
RESOLV="${TMPDIR:-/tmp}/agy-resolv.conf"
mkdir -p "$(dirname "$RESOLV")"
printf 'nameserver %s\nnameserver %s\n' "${AGY_DNS1:-8.8.8.8}" "${AGY_DNS2:-8.8.4.4}" > "$RESOLV"
[ -f /data/data/com.termux/files/usr/etc/resolv.conf ] && cp /data/data/com.termux/files/usr/etc/resolv.conf "$RESOLV"

# 3. "start" (daemonize) dies with SIGSYS: Go probes pidfd_open, which needs kernel >= 5.3 and
#    this kernel is 4.9. Termux seccomp answers SIGSYS instead of ENOSYS. So use "run" (foreground)
#    and background it here instead.
echo "starting Antigravity Gateway on http://127.0.0.1:$PORT (proot + foreground mode)"
exec proot -b "$RESOLV:/etc/resolv.conf" "$BIN" run
