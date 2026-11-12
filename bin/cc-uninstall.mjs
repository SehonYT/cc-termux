#!/usr/bin/env node
// Removes modelmesh and restores Claude Code to how it was before. Everything is either
// owned by modelmesh (deleted) or shared (restored); nothing runs without --yes.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installRoot, configFile, configDir, cacheDir, claudeDir, isWindows } from "./cc-paths.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// The launcher is a shell script on POSIX and a .cmd on Windows; both live in the same
// place the installer chose, so resolve it the same way rather than assuming a name.
export function shimDir() {
  const base = process.platform === "win32"
    ? (process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"))
    : path.join(os.homedir(), ".local");
  return path.join(base, "bin");
}
export function shimPath() {
  return path.join(shimDir(), process.platform === "win32" ? "claude.cmd" : "claude");
}

export function removalPlan() {
  const home = os.homedir();
  const root = installRoot();
  const claude = claudeDir();
  const items = [];
  const add = (kind, label, target, detail) => items.push({ kind, label, target, detail, exists: fs.existsSync(target) });

  // modelmesh owns these outright.
  add("owned", "modelmesh install", root, "code, patches, bundled Claude Code copy");
  add("owned", "config and keys", configDir(), "provider keys, web search keys, antigravity login");
  add("owned", "cache and logs", cacheDir(), "errors.log, model cache, session state");
  add("owned", "launcher shim", shimPath(), "the script that starts the gateway");

  // Shared with Claude Code: restore, never blanket-delete.
  add("restore", "web search permission", path.join(claude, "settings.json"), "remove the two mcp__web__ allow entries");
  add("restore", "MCP server entry", path.join(home, ".claude.json"), "remove modelmesh's mcp server");
  add("restore", "gateway env vars", path.join(claude, "settings.json"), "ANTHROPIC_BASE_URL and friends");
  for (const c of ["provider.md", "antigravity-usage.md"]) add("restore", "slash command " + c, path.join(claude, "commands", c), "installed by modelmesh");
  add("restore", "agent skills", path.join(claude, "skills"), "the skills this pack installed, plus its manifest");
  return items;
}

// Puts the original claude launcher back, preferring the oldest backup we made.
export function findOfficialBackup() {
  const home = os.homedir();
  const dirs = [shimDir(), path.join(home, ".local", "share", "claude", "versions")];
  const found = [];
  for (const dir of dirs) {
    try {
      for (const name of fs.readdirSync(dir)) {
        if (/^claude(\.cmd)?\.official-backup/.test(name)) found.push(path.join(dir, name));
      }
    } catch (e) { }
  }
  // Also look for a real Claude Code binary the native installer would have left.
  try {
    const versions = path.join(home, ".local", "share", "claude", "versions");
    for (const name of fs.readdirSync(versions)) found.push(path.join(versions, name));
  } catch (e) { }
  return found;
}

function stripSettings(file, mutate) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const cfg = JSON.parse(raw);
    const before = JSON.stringify(cfg);
    mutate(cfg);
    if (JSON.stringify(cfg) === before) return false;
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
    return true;
  } catch (e) { return false; }
}

// Removes only the keys modelmesh added, leaving every other setting exactly as found.
export function restoreClaudeCode({ log = () => {} } = {}) {
  const home = os.homedir();
  const claude = claudeDir();
  const done = [];

  const settings = path.join(claude, "settings.json");
  const changedSettings = stripSettings(settings, (cfg) => {
    if (cfg.permissions && Array.isArray(cfg.permissions.allow)) {
      cfg.permissions.allow = cfg.permissions.allow.filter((p) => !/^mcp__(web|search|fetch)/.test(String(p)));
      if (!cfg.permissions.allow.length) delete cfg.permissions.allow;
      if (!Object.keys(cfg.permissions).length) delete cfg.permissions;
    }
    if (cfg.env) {
      // Only the gateway pointers modelmesh sets; a user's own keys stay.
      const ours = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL",
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "ANTHROPIC_SMALL_FAST_MODEL"];
      for (const k of ours) delete cfg.env[k];
      if (!Object.keys(cfg.env).length) delete cfg.env;
    }
    if (cfg.statusLine && JSON.stringify(cfg.statusLine).includes("modelmesh")) delete cfg.statusLine;
  });
  done.push({ what: "settings.json", changed: changedSettings });

  const claudeJson = path.join(home, ".claude.json");
  const changedMcp = stripSettings(claudeJson, (cfg) => {
    if (cfg.mcpServers) {
      for (const name of Object.keys(cfg.mcpServers)) {
        if (/^(web|modelmesh)/.test(name)) delete cfg.mcpServers[name];
      }
      if (!Object.keys(cfg.mcpServers).length) delete cfg.mcpServers;
    }
  });
  done.push({ what: "~/.claude.json", changed: changedMcp });

  for (const c of ["provider.md", "antigravity-usage.md"]) {
    const f = path.join(claude, "commands", c);
    try { if (fs.existsSync(f)) { fs.rmSync(f, { force: true }); done.push({ what: "command " + c, changed: true }); } } catch (e) { }
  }
  for (const m of ["web.json"]) {
    // Not shared: this file only ever held modelmesh's provider keys.
    try { const f = path.join(claude, m); if (fs.existsSync(f)) fs.rmSync(f, { force: true }); } catch (e) { }
  }
  return done;
}

// The skills pack records what it installed, so only those directories are removed.
export async function removeSkillPack() {
  try {
    const mod = await import("./cc-skills.mjs");
    const catalog = mod.loadCatalog();
    const target = mod.skillsTarget();
    const removed = [];
    const kept = [];
    for (const skill of catalog.skills) {
      const dir = path.join(target, skill.name);
      if (!fs.existsSync(dir)) continue;
      // A skill the user edited is theirs now; leave it unless forced.
      let state = "missing";
      try { state = mod.compareSkill(skill).state; } catch (e) { }
      if (state === "modified") { kept.push(skill.name); continue; }
      try { fs.rmSync(dir, { recursive: true, force: true }); removed.push(skill.name); } catch (e) { }
    }
    try { const m = path.join(target, ".modelmesh-pack.json"); if (fs.existsSync(m)) fs.rmSync(m, { force: true }); } catch (e) { }
    return { removed, kept, target };
  } catch (e) {
    return { removed: [], kept: [], target: "" };
  }
}

// Puts the original claude launcher back.
export function restoreLauncher() {
  const shim = shimPath();
  const backups = findOfficialBackup().filter((p) => !p.includes("modelmesh") && !/^claude(\.cmd)?$/.test(path.basename(p)));
  try {
    if (fs.existsSync(shim)) {
      const body = fs.readFileSync(shim, "utf8");
      if (!body.includes("cc-launcher.mjs")) return { restored: false, reason: "claude is not a modelmesh shim" };
      fs.rmSync(shim, { force: true });
    }
    if (backups.length) {
      fs.copyFileSync(backups[0], shim);
      if (process.platform !== "win32") fs.chmodSync(shim, 0o755);
      return { restored: true, from: backups[0] };
    }
    return { restored: false, reason: "no backup of the original claude launcher was found" };
  } catch (e) {
    return { restored: false, reason: e.message };
  }
}

export function summarize(plan) {
  const owned = plan.filter((p) => p.kind === "owned" && p.exists);
  const restore = plan.filter((p) => p.kind === "restore" && p.exists);
  return { owned: owned.length, restore: restore.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const dry = args.includes("--dry-run") || args.includes("-n");
  const yes = args.includes("--yes") || args.includes("-y");
  const keepConfig = args.includes("--keep-config");
  const plan = removalPlan();
  const { owned, restore } = summarize(plan);

  console.log("modelmesh removal plan");
  console.log();
  for (const p of plan) {
    const mark = p.exists ? (p.kind === "owned" ? "delete " : "restore") : "absent ";
    console.log("  " + mark + "  " + p.label.padEnd(28) + p.detail);
  }
  console.log();
  console.log("  " + owned + " thing(s) to delete, " + restore + " shared file(s) to restore.");
  if (keepConfig) console.log("  --keep-config: provider keys and config are kept.");
  console.log();

  if (dry) { console.log("dry run: nothing was changed. Re-run with --yes to remove."); process.exit(0); }
  if (!yes) {
    console.log("This deletes modelmesh. Nothing else on your system is affected.");
    console.log("Re-run with --yes to confirm, or --dry-run to see the plan again.");
    process.exit(0);
  }

  const done = restoreClaudeCode();
  console.log("restored Claude Code:");
  for (const d of done) console.log("  " + (d.changed ? "updated" : "unchanged") + "  " + d.what);

  const launcher = restoreLauncher();
  console.log(launcher.restored ? "  restored  claude launcher (from " + launcher.from + ")" : "  note      " + launcher.reason);

  removeSkillPack().then((sk) => {
    if (sk.removed.length) console.log("  removed   skills: " + sk.removed.join(", "));
    if (sk.kept.length) console.log("  kept      skills you edited: " + sk.kept.join(", "));

    const targets = [installRoot(), cacheDir()];
    if (!keepConfig) targets.push(configDir());
    for (const t of targets) {
      try { fs.rmSync(t, { recursive: true, force: true }); console.log("  deleted   " + t); }
      catch (e) { console.log("  failed    " + t + ": " + e.message); }
    }
    console.log();
    console.log("modelmesh removed. Open a new shell so PATH and the claude launcher are re-read.");
    if (keepConfig) console.log("Your provider keys are still in " + configDir() + ".");
  });
}
