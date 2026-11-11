// Single source of truth for cc-termux's own directories (XDG on POSIX, APPDATA on Windows).
// Claude Code's ~/.claude is deliberately not resolved here; the CLI must agree with it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const WIN = process.platform === "win32";
const home = () => os.homedir();

function env(environment) { return environment || process.env; }
function localAppData(e) { return e.LOCALAPPDATA || path.join(home(), "AppData", "Local"); }
function appData(e) { return e.APPDATA || path.join(home(), "AppData", "Roaming"); }
function exists(p) { try { return fs.existsSync(p); } catch (e) { return false; } }

/** Install root (code, binary, lib/, patches). */
export function installRoot(environment) {
  const e = env(environment);
  if (e.CC_TERMUX_ROOT) return e.CC_TERMUX_ROOT;
  const legacy = path.join(home(), ".local", "share", "cc-termux");
  if (!WIN) return legacy;
  const preferred = path.join(localAppData(e), "cc-termux");
  return exists(preferred) || !exists(legacy) ? preferred : legacy;
}

/** config.json path. */
export function configFile(environment) {
  const e = env(environment);
  if (e.CC_TERMUX_CONFIG) return e.CC_TERMUX_CONFIG;
  const legacy = path.join(home(), ".config", "cc-termux", "config.json");
  if (!WIN) return legacy;
  const preferred = path.join(appData(e), "cc-termux", "config.json");
  return exists(preferred) || !exists(legacy) ? preferred : legacy;
}

/** Directory beside config.json (keys.json lives there). */
export function configDir(environment) { return path.dirname(configFile(environment)); }

/** Cache directory (logs, status file, sessions, models cache). */
export function cacheDir(environment) {
  const e = env(environment);
  if (e.CC_TERMUX_CACHE) return e.CC_TERMUX_CACHE;
  const legacy = path.join(home(), ".cache", "cc-termux");
  if (!WIN) return legacy;
  const preferred = path.join(localAppData(e), "cc-termux", "cache");
  return exists(preferred) || !exists(legacy) ? preferred : legacy;
}

/** Claude Code's own config directory (same on every platform). */
export function claudeDir(environment) {
  const e = env(environment);
  return e.CLAUDE_CONFIG_DIR || path.join(home(), ".claude");
}

/** True when the install root uses the Windows layout (useful for messages). */
export const isWindows = WIN;
