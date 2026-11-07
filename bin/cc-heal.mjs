#!/usr/bin/env node
// Environment self-heal: makes an install usable without manual steps.
//
// Repair list:
//   - ~/.claude/settings.json env overrides + stale model
//   - foreign claude binaries earlier in PATH
//   - sample provider entries from older releases
//   - config sanity: active/override/routing, file permissions
//   - /model picker regeneration
//   - missing launcher shims in the prefix bin directory
//   - stale session files and duplicate gateway processes
//   - oversized logs
//
// Used by install.mjs after every install/update and available as `cc-termux heal`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const SHIM_MARK = "cc-launcher.mjs";

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function saveJson(file, value, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", mode ? { mode } : undefined);
}
function isOurShim(p) {
  try { return /(cc-launcher\.mjs|bin\/cc-termux|ccp\.mjs)/.test(fs.readFileSync(p, "utf8")); } catch { return false; }
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
    try { if (fs.existsSync(p) && out.indexOf(p) < 0) out.push(p); } catch { }
  }
  return out;
}
function backup(file) {
  let dst = file + ".official-backup";
  if (fs.existsSync(dst)) dst = file + ".official-backup." + Date.now();
  fs.renameSync(file, dst);
  return path.basename(dst);
}

const composite = (p, id) => (id ? "prov/" + p + "/" + id : id);

export function healEnvironment({ root = process.env.CC_TERMUX_ROOT, home = os.homedir(), prefix, killGateways = true, installPrefix } = {}) {
  if (!root) throw new Error("install root is required");
  const changes = [];
  const cfgPath = process.env.CC_TERMUX_CONFIG || path.join(home, ".config", "cc-termux", "config.json");
  const keysPath = path.join(path.dirname(cfgPath), "keys.json");
  const settingsPath = path.join(home, ".claude", "settings.json");
  const cache = path.join(home, ".cache", "cc-termux");
  const cfg = loadJson(cfgPath, null);
  const keys = loadJson(keysPath, {});

  // 1. config sanity: active/override/routing/sample entries
  if (cfg && cfg.providers) {
    let dirty = false;
    const visible = () => Object.entries(cfg.providers).filter(([, p]) => !p.hidden);
    for (const [name, p] of visible()) {
      const sample = !keys[name] && !p.apiKeyEnv && !Object.keys(p.modelsById || {}).length;
      if (sample) { delete cfg.providers[name]; dirty = true; changes.push("config: removed sample provider " + name); }
    }
    if (!cfg.providers[cfg.active]) {
      cfg.active = visible()[0] ? visible()[0][0] : "";
      dirty = true;
      changes.push("config: active provider -> " + (cfg.active || "(none)"));
    }
    if (cfg.override) {
      const p = cfg.providers[cfg.override.provider];
      if (!p) { delete cfg.override; dirty = true; changes.push("config: removed stale override"); }
      else if (cfg.override.model && p.model && cfg.override.model !== p.model) {
        cfg.override.model = p.model; dirty = true; changes.push("config: override model -> " + p.model);
      }
    }
    const routing = {};
    for (const [name, p] of visible()) {
      for (const id of Object.keys(p.modelsById || {})) {
        const native = id.startsWith("claude-") || id.startsWith("anthropic/");
        routing[composite(name, id)] = (native && cfg.providers[name + "~native"] ? name + "~native" : name) + "::" + id;
      }
    }
    if (JSON.stringify(routing) !== JSON.stringify(cfg.routing || {})) { cfg.routing = routing; dirty = true; changes.push("config: routing rebuilt (" + Object.keys(routing).length + " entries)"); }
    if (dirty) { try { saveJson(cfgPath, cfg, 0o600); } catch (e) { changes.push("config: could not save (" + e.code + ")"); } }
  }
  try { if (fs.existsSync(cfgPath)) fs.chmodSync(cfgPath, 0o600); if (fs.existsSync(keysPath)) fs.chmodSync(keysPath, 0o600); } catch (e) { }

  // 2. settings.json: env overrides, stale model, picker sync
  const settings = loadJson(settingsPath, null);
  const provider = cfg && cfg.providers && cfg.providers[cfg.active];
  const wantModel = provider && provider.model ? composite(cfg.active, provider.model) : "";
  if (settings) {
    let changed = false;
    if (settings.env && typeof settings.env === "object") {
      for (const k of Object.keys(settings.env)) {
        if (/^ANTHROPIC_/.test(k) || k === "CLAUDE_CODE_MAX_CONTEXT_TOKENS" || k === "CLAUDE_CODE_SUBAGENT_MODEL") { delete settings.env[k]; changed = true; }
      }
    }
    const sm = typeof settings.model === "string" ? settings.model : "";
    const stale = !sm || sm === "default" || /^(opus|sonnet|haiku)$/.test(sm) || (/^claude-(opus|sonnet|haiku)-[0-9]/.test(sm) && !sm.startsWith("prov/"));
    if (stale && wantModel) { settings.model = wantModel; changed = true; }

    if (cfg && cfg.providers) {
      const switchRows = Object.entries(cfg.providers).filter(([, p]) => !p.hidden).map(([name, p]) => ({
        model: "provswitch/" + name,
        label: "\u21c4  Switch to " + name,
        description: "use " + (p.model || "default") + " \u00b7 " + p.type + (name === cfg.active ? " \u00b7 current" : ""),
      }));
      const rows = [];
      for (const [name, p] of Object.entries(cfg.providers).filter(([, q]) => !q.hidden)) {
        for (const [id, info] of Object.entries(p.modelsById || {})) {
          const isActive = name === cfg.active && id === p.model;
          rows.push({
            model: composite(name, id),
            label: (info.name && info.name !== id ? info.name : id) + "  [" + name + "]",
            description: (info.contextTokens ? (info.contextTokens >= 1e6 ? (info.contextTokens / 1e6) + "M" : Math.round(info.contextTokens / 1e3) + "K") + " ctx" : "ctx unknown") +
              (info.inUsd == null ? "" : " - $" + info.inUsd + " in / $" + info.outUsd + " out per Mtok") + (isActive ? " - current" : ""),
          });
        }
      }
      const picker = { replaceBuiltInOptions: true, options: [...switchRows, ...rows] };
      if (JSON.stringify(settings.modelPicker) !== JSON.stringify(picker)) { settings.modelPicker = picker; changed = true; }
    }
    if (changed) {
      try {
        fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
        if (fs.existsSync(settingsPath)) fs.copyFileSync(settingsPath, settingsPath + ".cc-termux-backup");
        saveJson(settingsPath, settings);
        changes.push("settings.json: repaired");
      } catch (e) { changes.push("settings.json: could not write (" + e.code + ")"); }
    }
  }

  // 3. foreign claude binaries on PATH
  for (const p of findClaudeBinaries()) {
    if (isOurShim(p)) continue;
    try { const b = backup(p); writeShim(p, root); changes.push("claude binary: " + p + " -> shim (backup " + b + ")"); }
    catch (e) { changes.push("claude binary: could not replace " + p + " (" + e.code + ")"); }
  }

  // 4. launcher layout: native-style ~/.local/bin/claude + cc-termux/ccp in the prefix
  const canonicalRoot = path.join(home, ".local", "share", "cc-termux");
  const isCanonical = path.resolve(root) === path.resolve(canonicalRoot);
  if (isCanonical && installPrefix !== false && process.platform !== "win32") {
    const homeBin = path.join(home, ".local", "bin");
    fs.mkdirSync(homeBin, { recursive: true });
    const prefixBin = path.join(prefix || process.env.PREFIX || (process.platform === "android" ? "/data/data/com.termux/files/usr" : "/usr/local"), "bin");
    const node = process.execPath;
    const shimBody = (target) => "#!/bin/sh\nexec \"" + node + "\" \"" + target + "\" \"$@\"\n";
    const writeLauncherShim = (file, target) => {
      const body = shimBody(target);
      try { if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === body) return false; } catch (e) { }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (fs.existsSync(file) && !isOurShim(file)) backup(file);
      try { fs.rmSync(file, { force: true }); } catch (e) { }
      fs.writeFileSync(file, body);
      fs.chmodSync(file, 0o755);
      return true;
    };
    try {
      // Native-style layout: ~/.local/bin/claude -> ~/.local/share/claude/versions/<version>
      let ver = "cc-termux";
      try { ver = fs.readFileSync(path.join(root, "VERSION"), "utf8").trim().split("-")[0] || "cc-termux"; } catch (e) { }
      const versionsDir = path.join(home, ".local", "share", "claude", "versions");
      fs.mkdirSync(versionsDir, { recursive: true });
      const targetFile = path.join(versionsDir, ver);
      if (writeLauncherShim(targetFile, path.join(root, "bin", "cc-launcher.mjs"))) changes.push("shim: " + targetFile);
      const link = path.join(homeBin, "claude");
      let linkOk = false;
      try { linkOk = fs.lstatSync(link).isSymbolicLink() && fs.readlinkSync(link) === targetFile; } catch (e) { }
      if (!linkOk) {
        try { if (fs.existsSync(link) && !fs.lstatSync(link).isSymbolicLink()) backup(link); } catch (e) { }
        try { fs.rmSync(link, { force: true }); } catch (e) { }
        fs.symlinkSync(targetFile, link);
        changes.push("shim: " + link + " -> " + targetFile);
      }
    } catch (e) { changes.push("shim: could not write ~/.local/bin/claude (" + e.code + ")"); }
    fs.mkdirSync(prefixBin, { recursive: true });
    for (const name of ["cc-termux", "ccp"]) {
      const target = path.join(prefixBin, name);
      const script = path.join(root, "bin", name === "ccp" ? "ccp.mjs" : "cc-termux");
      try {
        const body = shimBody(script);
        let same = false;
        try { same = fs.existsSync(target) && fs.readFileSync(target, "utf8") === body; } catch (e) { }
        if (!same) {
          if (fs.existsSync(target) && !isOurShim(target)) backup(target);
          try { fs.rmSync(target, { force: true }); } catch (e) { }
          fs.writeFileSync(target, body);
          fs.chmodSync(target, 0o755);
          changes.push("shim: " + target);
        }
      } catch (e) { changes.push("shim: could not write " + target + " (" + e.code + ")"); }
    }
    // remove the old prefix claude so Claude Code does not report an npm leftover
    const oldClaude = path.join(prefixBin, "claude");
    if (fs.existsSync(oldClaude)) {
      try { backup(oldClaude); changes.push("shim: moved " + oldClaude + " aside"); } catch (e) { }
    }
    // make sure login shells find ~/.local/bin
    for (const rc of [path.join(home, ".bashrc"), path.join(home, ".profile")]) {
      try {
        if (!fs.existsSync(rc)) continue;
        const text = fs.readFileSync(rc, "utf8");
        if (text.includes("# cc-termux PATH")) continue;
        fs.appendFileSync(rc, "\n# cc-termux PATH\nexport PATH=\"$HOME/.local/bin:$PATH\"\n");
        changes.push("path: added ~/.local/bin to " + path.basename(rc));
      } catch (e) { }
    }
    // mark the install as native for Claude Code diagnostics
    try {
      const cj = path.join(home, ".claude.json");
      let cfg = {};
      try { cfg = JSON.parse(fs.readFileSync(cj, "utf8")); } catch (e) { cfg = {}; }
      if (cfg.installMethod !== "native") { cfg.installMethod = "native"; saveJson(cj, cfg); changes.push("config: installMethod=native"); }
    } catch (e) { }
    // remove a leftover npm global package if present
    try {
      const npmPkg = path.join(process.env.PREFIX || (process.platform === "android" ? "/data/data/com.termux/files/usr" : "/usr/local"), "lib", "node_modules", "@anthropic-ai", "claude-code");
      if (fs.existsSync(npmPkg)) {
        const r = spawnSync("npm", ["-g", "uninstall", "@anthropic-ai/claude-code"], { stdio: "ignore" });
        if (r.status === 0) changes.push("npm: removed leftover global claude-code package");
      }
    } catch (e) { }
  }
  // 5. sessions, duplicate gateways, log size
  try {
    const sessions = path.join(cache, "sessions");
    let live = 0;
    if (fs.existsSync(sessions)) {
      for (const f of fs.readdirSync(sessions)) {
        if (!f.endsWith(".session")) continue;
        try { process.kill(Number(fs.readFileSync(path.join(sessions, f), "utf8").trim()), 0); live++; }
        catch { try { fs.unlinkSync(path.join(sessions, f)); } catch { } }
      }
    }
    if (live === 0) {
      const pids = [];
      try {
        for (const d of fs.readdirSync("/proc")) {
          if (!/^\d+$/.test(d)) continue;
          try { const c = fs.readFileSync("/proc/" + d + "/cmdline", "utf8"); if (c.includes("proxy/server.mjs") && Number(d) !== process.pid) pids.push(Number(d)); } catch { }
        }
      } catch { }
      if (pids.length && killGateways) {
        for (const pid of pids) { try { process.kill(pid, "SIGTERM"); } catch { } }
        changes.push("gateway: stopped " + pids.length + " idle instance(s)");
      } else if (pids.length > 1) changes.push("gateway: " + pids.length + " instances running (cc-termux restart)");
    }
  } catch (e) { }
  for (const f of ["gateway.log", "errors.log"]) {
    const p = path.join(cache, f);
    try {
      const st = fs.statSync(p);
      if (st.size > 5 * 1024 * 1024) {
        const lines = fs.readFileSync(p, "utf8").trim().split("\n").slice(-500);
        fs.writeFileSync(p, lines.join("\n") + "\n");
        changes.push("log: rotated " + f);
      }
    } catch (e) { }
  }

  // 6. /provider command file
  try {
    const src = path.join(root, "commands", "provider.md");
    const dst = path.join(home, ".claude", "commands", "provider.md");
    if (fs.existsSync(src) && !fs.existsSync(dst)) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); changes.push("commands: provider.md restored"); }
  } catch (e) { }

  return changes;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--root");
  const root = i > 0 ? process.argv[i + 1] : process.env.CC_TERMUX_ROOT;
  try {
    const changes = healEnvironment({ root });
    for (const c of changes) console.log("heal: " + c);
    console.log("heal: " + (changes.length ? changes.length + " change(s)" : "nothing to fix"));
  } catch (e) { console.error("heal: " + e.message); process.exit(1); }
}