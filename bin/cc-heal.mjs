#!/usr/bin/env node
// Environment self-heal: repairs settings, PATH shims, config, picker and stale sessions.
// Run by install.mjs after every install/update, and on demand as `modelmesh heal`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { installRoot, configFile, cacheDir, claudeDir } from "./cc-paths.mjs";

const SHIM_MARK = "cc-launcher.mjs";
// Termux installs every package under this prefix (and exports PREFIX to match).
const TERMUX_PREFIX = "/data/data/com.termux/files/usr";
// Homebrew's documented default prefix on Apple Silicon; Intel Macs use /usr/local.
const HOMEBREW_ARM_PREFIX = "/opt/homebrew";
// Shell rc files that make ~/.local/bin visible: bash reads .bashrc/.profile,
// zsh reads .zprofile (login shells) and .zshrc (interactive shells).
const SHELL_RC_FILES = [".bashrc", ".profile", ".zprofile", ".zshrc"];
const PATH_MARKER = "# modelmesh PATH";
const PATH_LINE = 'export PATH="$HOME/.local/bin:$PATH"';

export function shellRcFiles(home) {
  return SHELL_RC_FILES.map((f) => path.join(home, f));
}
// Idempotently append the ~/.local/bin PATH entry to every rc file either shell reads.
export function ensurePathInRcFiles(home) {
  const added = [];
  for (const rc of shellRcFiles(home)) {
    try {
      const text = fs.existsSync(rc) ? fs.readFileSync(rc, "utf8") : "";
      if (text.includes(PATH_MARKER)) continue;
      fs.appendFileSync(rc, "\n" + PATH_MARKER + "\n" + PATH_LINE + "\n");
      added.push(path.basename(rc));
    } catch (e) { }
  }
  return added;
}
// Resolve the prefix whose bin/ holds the user-facing launchers: PREFIX wins, then Termux,
// Homebrew on Apple Silicon, /usr/local, and %LOCALAPPDATA% on Windows where /usr/local is absent.
export function resolvePrefix({ platform = process.platform, env = process.env, exists = fs.existsSync, home = os.homedir() } = {}) {
  try {
    if (env && env.PREFIX) return env.PREFIX;
    if (platform === "android") return TERMUX_PREFIX;
    if (platform === "win32") {
      return (env && (env.LOCALAPPDATA || env.APPDATA)) || path.join(home, "AppData", "Local");
    }
    if (platform === "darwin") {
      if (env && env.HOMEBREW_PREFIX) return env.HOMEBREW_PREFIX;
      if (exists(path.join(HOMEBREW_ARM_PREFIX, "bin"))) return HOMEBREW_ARM_PREFIX;
    }
    // Linux and macOS: the system bin when present, otherwise the user's own bin.
    if (exists("/usr/local/bin")) return "/usr/local";
    return path.join(home, ".local");
  } catch (e) { }
  return path.join(home, ".local");
}
export function prefixBinDir(opts) {
  return path.join(resolvePrefix(opts), "bin");
}

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function saveJson(file, value, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", mode ? { mode } : undefined);
}
function isOurShim(p) {
  try {
    const fd = fs.openSync(p, "r");
    const b = Buffer.alloc(4096);
    const n = fs.readSync(fd, b, 0, b.length, 0);
    fs.closeSync(fd);
    return /(cc-launcher\.mjs|bin\/modelmesh|mm\.mjs)/.test(b.subarray(0, n).toString("utf8"));
  } catch { return false; }
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
function findClaudeBinaries(searchPath) {
  const name = process.platform === "win32" ? "claude.cmd" : "claude";
  const out = [];
  for (const dir of String(searchPath === undefined ? process.env.PATH || "" : searchPath).split(path.delimiter).filter(Boolean)) {
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

export function healEnvironment({ root, home = os.homedir(), prefix, killGateways = true, installPrefix, searchPath, platform = process.platform, exists = fs.existsSync } = {}) {
  if (!root) root = installRoot();
  if (!root) throw new Error("install root is required");
  const changes = [];
  // Production passes the real home, so the shared resolver decides config/cache paths.
  // Tests passing an explicit home keep the home-relative layout and stay self-contained.
  const nativeHome = home === os.homedir();
  const cfgDefault = nativeHome ? configFile() : path.join(home, ".config", "modelmesh", "config.json");
  const cfgPath = process.env.MODELMESH_CONFIG || cfgDefault;
  const keysPath = path.join(path.dirname(cfgPath), "keys.json");
  const settingsPath = nativeHome ? path.join(claudeDir(), "settings.json") : path.join(home, ".claude", "settings.json");
  const cache = nativeHome ? cacheDir() : path.join(home, ".cache", "modelmesh");
  const cfg = loadJson(cfgPath, null);
  const keys = loadJson(keysPath, {});

  // Respect the model Claude Code currently has selected (settings.model).
  const earlySettings = loadJson(settingsPath, null);
  let selectedProvider = "", selectedModel = "";
  try {
    const m = /^prov\/([^/]+)\/(.+)$/.exec(String((earlySettings && earlySettings.model) || ""));
    if (m) { selectedProvider = m[1]; selectedModel = m[2]; }
  } catch (e) { }

  // 1. config sanity: active/override/routing/sample entries
  if (cfg && cfg.providers) {
    let dirty = false;
    const visible = () => Object.entries(cfg.providers).filter(([, p]) => !p.hidden);
    for (const [name, p] of visible()) {
      const sample = (p.sample === true || /^(sample|example)(-|$)/i.test(name)) && !keys[name] && !p.apiKey && !p.apiKeyEnv && !Object.keys(p.modelsById || {}).length;
      if (sample) { delete cfg.providers[name]; dirty = true; changes.push("config: removed sample provider " + name); }
    }
    if (!cfg.providers[cfg.active]) {
      const next = visible()[0] ? visible()[0][0] : "";
      if (next !== cfg.active) { cfg.active = next; dirty = true; changes.push("config: active provider -> " + (next || "(none)")); }
    }
    if (cfg.override) {
      const p = cfg.providers[cfg.override.provider];
      if (!p) { delete cfg.override; dirty = true; changes.push("config: removed stale override"); }
      else {
        const chosen = (selectedProvider === cfg.override.provider && selectedModel) ? selectedModel : p.model;
        if (cfg.override.model && chosen && cfg.override.model !== chosen) { cfg.override.model = chosen; dirty = true; changes.push("config: override model -> " + chosen); }
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
  const wantModel = (selectedProvider === cfg.active && selectedModel) ? composite(cfg.active, selectedModel) : (provider && provider.model ? composite(cfg.active, provider.model) : "");
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
          const isActive = name === cfg.active && id === ((name === selectedProvider && selectedModel) ? selectedModel : p.model);
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
    const DENY = [
      "Read(~/.config/modelmesh/keys.json)",
      "Read(~/.config/modelmesh/config.json)",
      "Read(~/.claude.json)",
      "Read(~/.claude/settings.json)",
      "Read(~/.cache/modelmesh/errors.log)",
      "Read(~/.ssh/*)",
    ];
    settings.permissions = settings.permissions || {};
    const deny = Array.isArray(settings.permissions.deny) ? settings.permissions.deny : [];
    const before = deny.length;
    for (const rule of DENY) if (!deny.includes(rule)) deny.push(rule);
    if (deny.length !== before) { settings.permissions.deny = deny; changed = true; }
    if (changed) {
      try {
        fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
        if (fs.existsSync(settingsPath)) fs.copyFileSync(settingsPath, settingsPath + ".modelmesh-backup");
        saveJson(settingsPath, settings);
        changes.push("settings.json: repaired");
      } catch (e) { changes.push("settings.json: could not write (" + e.code + ")"); }
    }
  }

  // 3. foreign claude binaries on PATH
  for (const p of findClaudeBinaries(searchPath)) {
    if (isOurShim(p)) continue;
    try { const b = backup(p); writeShim(p, root); changes.push("claude binary: " + p + " -> shim (backup " + b + ")"); }
    catch (e) { changes.push("claude binary: could not replace " + p + " (" + e.code + ")"); }
  }

  // 4. launcher layout: native-style ~/.local/bin/claude + modelmesh/mm in the prefix.
  // Canonical means the platform default root, so a MODELMESH_ROOT override is ignored here.
  const canonicalRoot = nativeHome ? installRoot({ ...process.env, MODELMESH_ROOT: "" }) : path.join(home, ".local", "share", "modelmesh");
  const isCanonical = path.resolve(root) === path.resolve(canonicalRoot);
  if (isCanonical && installPrefix !== false && process.platform === "win32") {
    // Windows has no ~/.local/bin: install .cmd shims next to the other user tools so a
    // fresh PowerShell/cmd can find claude and modelmesh.
    const dirs = [
      path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "npm"),
      path.join(home, "AppData", "Local", "Microsoft", "WindowsApps"),
    ];
    const node = process.execPath;
    const scripts = { claude: path.join(root, "bin", "cc-launcher.mjs"), "modelmesh": path.join(root, "bin", "modelmesh"), mm: path.join(root, "bin", "mm.mjs") };
    for (const dir of dirs) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.accessSync(dir, fs.constants.W_OK);
        for (const [name, target] of Object.entries(scripts)) {
          fs.writeFileSync(path.join(dir, name + ".cmd"), "@echo off\r\n\"" + node + "\" \"" + target + "\" %*\r\n");
        }
        changes.push("shims: " + dir);
        break;
      } catch (e) { }
    }
  } else if (isCanonical && installPrefix !== false) {
    const homeBin = path.join(home, ".local", "bin");
    try { fs.mkdirSync(homeBin, { recursive: true }); } catch (e) { changes.push("shims: cannot write " + homeBin + " (" + e.code + ")"); }
    const prefixBin = prefix ? path.join(prefix, "bin") : prefixBinDir({ platform, exists });
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
      let ver = "modelmesh";
      try { ver = fs.readFileSync(path.join(root, "VERSION"), "utf8").trim().split("-")[0] || "modelmesh"; } catch (e) { }
      const versionsDir = path.join(home, ".local", "share", "claude", "versions");
      fs.mkdirSync(versionsDir, { recursive: true });
      let targetFile = path.join(versionsDir, ver);
      // Never overwrite a real Claude native binary with our shim.
      try { if (fs.existsSync(targetFile) && !isOurShim(targetFile)) targetFile = path.join(versionsDir, "modelmesh-" + ver); } catch (e) { }
      if (writeLauncherShim(targetFile, path.join(root, "bin", "cc-launcher.mjs"))) changes.push("shim: " + targetFile);
      const link = path.join(homeBin, "claude");
      let linkOk = false;
      try { linkOk = fs.lstatSync(link).isSymbolicLink() && fs.readlinkSync(link) === targetFile; } catch (e) { }
      if (!linkOk) {
        try { if (fs.existsSync(link) && !isOurShim(link)) backup(link); } catch (e) { }
        try { fs.rmSync(link, { force: true }); } catch (e) { }
        fs.symlinkSync(targetFile, link);
        changes.push("shim: " + link + " -> " + targetFile);
      }
    } catch (e) { changes.push("shim: could not write ~/.local/bin/claude (" + e.code + ")"); }
    // /usr/local/bin is not writable for a normal user on Linux/macOS; never abort heal.
    try { fs.mkdirSync(prefixBin, { recursive: true }); } catch (e) { changes.push("shims: cannot write " + prefixBin + " (" + e.code + ")"); }
    for (const name of ["modelmesh", "mm"]) {
      const target = path.join(prefixBin, name);
      const script = path.join(root, "bin", name === "mm" ? "mm.mjs" : "modelmesh");
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
    // make sure login shells find ~/.local/bin, using the same rc files as the installer
    for (const rc of ensurePathInRcFiles(home)) changes.push("path: added ~/.local/bin to " + rc);
    // mark the install as native for Claude Code diagnostics
    try {
      const cj = path.join(home, ".claude.json");
      let cfg = null;
      if (!fs.existsSync(cj)) cfg = {};
      else { try { cfg = JSON.parse(fs.readFileSync(cj, "utf8")); } catch (e) { cfg = null; } }
      const nativeBin = path.join(root, "bin", process.platform === "win32" ? "claude.exe" : "claude.bin");
      if (cfg && fs.existsSync(nativeBin) && cfg.installMethod !== "native") { cfg.installMethod = "native"; saveJson(cj, cfg); changes.push("config: installMethod=native"); }
    } catch (e) { }
    // remove a leftover npm global package if present
    try {
      const npmPrefix = path.dirname(prefixBin);
      const realPrefix = resolvePrefix({ platform, exists });
      const npmPkg = path.join(npmPrefix, "lib", "node_modules", "@anthropic-ai", "claude-code");
      // Only touch npm when operating on the real global prefix (never for temp/isolated roots).
      if (path.resolve(npmPrefix) === path.resolve(realPrefix) && fs.existsSync(npmPkg)) {
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
          try {
            const c = fs.readFileSync("/proc/" + d + "/cmdline", "utf8");
            const pid = Number(d);
            if (pid !== process.pid && pid !== process.ppid && c.split("\0").includes(path.join(root, "proxy", "server.mjs"))) pids.push(pid);
          } catch { }
        }
      } catch { }
      if (pids.length && killGateways) {
        for (const pid of pids) { try { process.kill(pid, "SIGTERM"); } catch { } }
        changes.push("gateway: stopped " + pids.length + " idle instance(s)");
      } else if (pids.length > 1) changes.push("gateway: " + pids.length + " instances running (modelmesh restart)");
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
  const root = i > 0 ? process.argv[i + 1] : installRoot();
  try {
    const changes = healEnvironment({ root });
    for (const c of changes) console.log("heal: " + c);
    console.log("heal: " + (changes.length ? changes.length + " change(s)" : "nothing to fix"));
  } catch (e) { console.error("heal: " + e.message); process.exit(1); }
}