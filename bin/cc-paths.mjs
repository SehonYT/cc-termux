// Single source of truth for modelmesh's own directories (XDG on POSIX, APPDATA on Windows).
// Claude Code's ~/.claude is deliberately not resolved here; the CLI must agree with it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const WIN = process.platform === "win32";
const home = () => os.homedir();

function env(environment) { return environment || process.env; }

// The project was called cc-termux until the ModelMesh rename. An install or a shell
// profile from before that still points at the old directories and variables, so every
// resolver reads the old name as a fallback and migrates the data on first use.
const OLD = { root: "CC_TERMUX_ROOT", config: "CC_TERMUX_CONFIG", cache: "CC_TERMUX_CACHE" };
function legacyEnv(e, key) { return e[OLD[key]] || ""; }

// Moves a directory from the old name to the new one, once, and returns the new path.
// An existing destination is merged into rather than skipped: a directory created moments
// earlier by an unrelated path lookup is empty, and treating it as "already migrated"
// leaves the real data behind.
export function migrateDir(from, to) {
  if (!exists(from)) return to;
  if (path.resolve(from) === path.resolve(to)) return to;
  try {
    fs.mkdirSync(to, { recursive: true });
    // Move each entry, keeping anything already at the destination.
    for (const entry of fs.readdirSync(from)) {
      const src = path.join(from, entry);
      const dst = path.join(to, entry);
      if (exists(dst)) continue;
      try { fs.renameSync(src, dst); }
      catch (e) { try { fs.cpSync(src, dst, { recursive: true }); fs.rmSync(src, { recursive: true, force: true }); } catch (e2) { } }
    }
    // Remove the old directory only when it is empty; a partial move keeps the rest.
    try { if (!fs.readdirSync(from).length) fs.rmdirSync(from); } catch (e) { }
    return to;
  } catch (e) { return from; }
}
function localAppData(e) { return e.LOCALAPPDATA || path.join(home(), "AppData", "Local"); }
function appData(e) { return e.APPDATA || path.join(home(), "AppData", "Roaming"); }
function exists(p) { try { return fs.existsSync(p); } catch (e) { return false; } }

/** Install root (code, binary, lib/, patches). */
export function installRoot(environment) {
  const e = env(environment);
  if (e.MODELMESH_ROOT) return e.MODELMESH_ROOT;
  if (legacyEnv(e, "root")) return legacyEnv(e, "root");
  const legacy = migrateDir(path.join(home(), ".local", "share", "cc-termux"), path.join(home(), ".local", "share", "modelmesh"));
  if (!WIN) return legacy;
  const preferred = path.join(localAppData(e), "modelmesh");
  return exists(preferred) || !exists(legacy) ? preferred : legacy;
}

/** config.json path. */
export function configFile(environment) {
  const e = env(environment);
  if (e.MODELMESH_CONFIG) return e.MODELMESH_CONFIG;
  if (legacyEnv(e, "config")) return legacyEnv(e, "config");
  // Move the whole config directory, keys included, once.
  const cfgDir = migrateDir(path.join(home(), ".config", "cc-termux"), path.join(home(), ".config", "modelmesh"));
  const legacy = path.join(cfgDir, "config.json");
  if (!WIN) return legacy;
  const preferred = path.join(appData(e), "modelmesh", "config.json");
  return exists(preferred) || !exists(legacy) ? preferred : legacy;
}

/** Directory beside config.json (keys.json lives there). */
export function configDir(environment) { return path.dirname(configFile(environment)); }

/** Cache directory (logs, status file, sessions, models cache). */
export function cacheDir(environment) {
  const e = env(environment);
  if (e.MODELMESH_CACHE) return e.MODELMESH_CACHE;
  if (legacyEnv(e, "cache")) return legacyEnv(e, "cache");
  const legacy = migrateDir(path.join(home(), ".cache", "cc-termux"), path.join(home(), ".cache", "modelmesh"));
  if (!WIN) return legacy;
  const preferred = path.join(localAppData(e), "modelmesh", "cache");
  return exists(preferred) || !exists(legacy) ? preferred : legacy;
}

/** Claude Code's own config directory (same on every platform). */
export function claudeDir(environment) {
  const e = env(environment);
  return e.CLAUDE_CONFIG_DIR || path.join(home(), ".claude");
}

/** True when the install root uses the Windows layout (useful for messages). */
export const isWindows = WIN;
