#!/usr/bin/env node
// Environment self-heal: makes an install usable without manual steps.
//
// Fixes:
//   - ~/.claude/settings.json env overrides (ANTHROPIC_*) and stale model values
//   - foreign `claude` binaries earlier in PATH (official installs)
//   - sample provider entries left by older releases (no key, no models)
//
// Used by install.mjs after every install/update; also available as `cc-termux heal`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SHIM_MARK = "cc-launcher.mjs";

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

function isOurShim(p) {
  try { return fs.readFileSync(p, "utf8").includes(SHIM_MARK); } catch { return false; }
}

function writeShim(file, root) {
  const node = process.execPath;
  const target = path.join(root, "bin", "cc-launcher.mjs");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (process.platform === "win32") {
    fs.writeFileSync(file, "@echo off\r\n\"" + node + "\" \"" + target + "\" %*\r\n");
  } else {
    fs.writeFileSync(file, "#!/bin/sh\nexec \"" + node + "\" \"" + target + "\" \"$@\"\n");
    fs.chmodSync(file, 0o755);
  }
}

function findClaudeBinaries() {
  const name = process.platform === "win32" ? "claude.cmd" : "claude";
  const out = [];
  for (const dir of String(process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
    const p = path.join(dir, name);
    try { if (fs.existsSync(p) && !out.includes(p)) out.push(p); } catch {}
  }
  return out;
}

function backup(file) {
  let dst = file + ".official-backup";
  if (fs.existsSync(dst)) dst = file + ".official-backup." + Date.now();
  fs.renameSync(file, dst);
  return dst;
}

export function healEnvironment({ root = process.env.CC_TERMUX_ROOT, home = os.homedir() } = {}) {
  const changes = [];
  if (!root) throw new Error("install root is required");

  // 1. settings.json: drop env overrides and repair a stale model
  const cfgPath = process.env.CC_TERMUX_CONFIG || path.join(home, ".config", "cc-termux", "config.json");
  const cfg = loadJson(cfgPath, null);
  const provider = cfg && cfg.providers && cfg.providers[cfg.active];
  const wantModel = provider && provider.model ? "prov/" + cfg.active + "/" + provider.model : "";
  const settingsPath = path.join(home, ".claude", "settings.json");
  const settings = loadJson(settingsPath, null);
  if (settings) {
    let changed = false;
    if (settings.env && typeof settings.env === "object") {
      for (const k of Object.keys(settings.env)) {
        if (/^ANTHROPIC_/.test(k) || k === "CLAUDE_CODE_MAX_CONTEXT_TOKENS" || k === "CLAUDE_CODE_SUBAGENT_MODEL") {
          delete settings.env[k]; changed = true;
        }
      }
    }
    const sm = typeof settings.model === "string" ? settings.model : "";
    const stale = !sm || sm === "default" || /^(opus|sonnet|haiku)$/.test(sm) || (/^claude-(opus|sonnet|haiku)-[0-9]/.test(sm) && !sm.startsWith("prov/"));
    if (stale && wantModel) { settings.model = wantModel; changed = true; }
    if (changed) {
      try {
        fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
        fs.copyFileSync(settingsPath, settingsPath + ".cc-termux-backup");
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
        changes.push("settings.json: repaired" + (wantModel ? " (model=" + wantModel + ")" : ""));
      } catch (e) { }
    }
  }

  // 2. foreign claude binaries on PATH
  for (const p of findClaudeBinaries()) {
    if (isOurShim(p)) continue;
    try {
      const moved = backup(p);
      writeShim(p, root);
      changes.push("claude binary: " + p + " -> shim (backup " + path.basename(moved) + ")");
    } catch (e) {
      changes.push("claude binary: could not replace " + p + " (" + e.code + ")");
    }
  }

  // 3. sample provider entries from older installs (no key, no catalog)
  if (cfg && cfg.providers) {
    const keys = loadJson(path.join(path.dirname(cfgPath), "keys.json"), {});
    const isSample = ([name, p]) => !p.hidden && !keys[name] && !p.apiKeyEnv && !Object.keys(p.modelsById || {}).length;
    const visible = Object.entries(cfg.providers).filter(([, p]) => !p.hidden);
    if (visible.length && visible.every(isSample)) {
      for (const [name] of visible) delete cfg.providers[name];
      cfg.active = ""; delete cfg.override;
      try { fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 }); changes.push("config: removed " + visible.length + " sample provider entries"); } catch (e) { }
    }
  }

  return changes;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rootArgIdx = process.argv.indexOf("--root");
  const root = rootArgIdx > 0 ? process.argv[rootArgIdx + 1] : process.env.CC_TERMUX_ROOT;
  try {
    const changes = healEnvironment({ root });
    for (const c of changes) console.log("heal: " + c);
    if (!changes.length) console.log("heal: nothing to fix");
  } catch (e) {
    console.error("heal: " + e.message);
    process.exit(1);
  }
}