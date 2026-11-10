#!/usr/bin/env node
// Claude Code status line. The configured command prints a pre-rendered file directly
// (fast); this script refreshes that file from the Antigravity quota API.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

function configPath() { return process.env.CC_TERMUX_CONFIG || path.join(os.homedir(), ".config", "cc-termux", "config.json"); }
function claudeDir() { return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"); }
function cacheDir() { return process.env.CC_TERMUX_CACHE || path.join(os.homedir(), ".cache", "cc-termux"); }
function statusFile() { return path.join(cacheDir(), "antigravity-status.txt"); }
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return {}; } }
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function rel(iso) {
  const t = Date.parse(iso || "");
  if (!Number.isFinite(t)) return "";
  const ms = t - Date.now();
  if (ms <= 0) return "now";
  const m = Math.round(ms / 60000);
  if (m < 60) return m + "m";
  const h = Math.floor(m / 60), mm = m % 60;
  if (h < 24) return h + "h" + (mm ? mm + "m" : "");
  return Math.floor(h / 24) + "d" + (h % 24 ? h % 24 + "h" : "");
}
export function activeModel(cfg, explicitId, explicitProvider) {
  // A model id alone does not identify its provider: the same id can exist on several
  // providers, so the caller must say which provider it came from.
  if (explicitProvider && cfg.providers && cfg.providers[explicitProvider]) {
    const p = cfg.providers[explicitProvider];
    const id = explicitId || p.model;
    return { provider: explicitProvider, type: p.type, name: (p.modelsById && p.modelsById[id] && p.modelsById[id].name) || id || p.type };
  }
  let key = cfg.active;
  let p = cfg.providers && cfg.providers[key];
  let id = explicitId || (p && p.model);
  if (!explicitId) {
    const settings = readJson(path.join(claudeDir(), "settings.json"));
    const sm = typeof settings.model === "string" ? settings.model : "";
    const m = /^prov\/([^/]+)\/(.+)$/.exec(sm);
    if (m && cfg.providers && cfg.providers[m[1]]) { key = m[1]; p = cfg.providers[key]; id = m[2]; }
    else if (!sm && cfg.override && cfg.override.provider === key && cfg.override.model) id = cfg.override.model;
    else {
      const ps = /^provswitch\/([^/]+)$/.exec(sm);
      if (ps && cfg.providers && cfg.providers[ps[1]]) { key = ps[1]; p = cfg.providers[key]; id = p.model; }
    }
  }
  if (!p) return null;
  return { provider: key, type: p.type, name: (p.modelsById && p.modelsById[id] && p.modelsById[id].name) || id || p.type };
}
function shortGroup(g) { return g.id === "gemini" ? "G" : g.id === "claude" ? "C" : g.id === "argon" ? "A" : (g.label || "?").slice(0, 1).toUpperCase(); }
export function formatUsage(u) {
  if (!u || !Array.isArray(u.groups) || !u.groups.length) return "usage ?";
  const parts = [];
  for (const g of u.groups) {
    const w = g.windows || {};
    const bits = [];
    if (w.session) bits.push("5h " + Math.round(w.session.percent) + "%");
    if (w.weekly) bits.push("7d " + Math.round(w.weekly.percent) + "%");
    if (bits.length) parts.push(shortGroup(g) + " " + bits.join(" "));
  }
  return parts.join(" · ") || "usage ?";
}
function lineFor(usage, model, provider = "antigravity") {
  return provider + " · " + model + (usage ? " · " + formatUsage(usage) : "");
}
export function readStatusLine() {
  try { return fs.readFileSync(statusFile(), "utf8").trim(); } catch (e) { return ""; }
}
function writeStatusLine(line) {
  try {
    fs.mkdirSync(cacheDir(), { recursive: true });
    const tmp = statusFile() + "." + process.pid + ".tmp";
    fs.writeFileSync(tmp, line + "\n", { mode: 0o644 });
    fs.renameSync(tmp, statusFile());
  } catch (e) { }
}
let refreshInFlight = null;
export async function refreshStatusLine({ force = false, modelId = null, provider = null } = {}) {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
  const cfg = readJson(configPath());
  const model = activeModel(cfg, modelId, provider);
  if (!model) { writeStatusLine("cc-termux"); return "cc-termux"; }
  if (model.type !== "antigravity") {
    const line = model.provider + " · " + model.name;
    if (readStatusLine() !== line) writeStatusLine(line);
    return line;
  }
  try {
    const st = fs.statSync(statusFile());
    const currentLine = readStatusLine();
    if (!force && Date.now() - st.mtimeMs < 60000 && currentLine.includes("· " + model.name + " ·")) return currentLine;
  } catch (e) { }
  try {
    const { getAntigravityUsage } = await import("./cc-antigravity.mjs");
    const usage = await getAntigravityUsage({ timeoutMs: 2500 });
    const line = lineFor(usage, model.name, model.provider);
    writeStatusLine(line);
    return line;
  } catch (e) {
    const old = readStatusLine();
    const line = old && old.includes("· " + model.name + " ·") ? old : model.provider + " · " + model.name + " · usage ?";
    writeStatusLine(line);
    return line;
  }
  })().finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}
export function installStatusLine() {
  const settingsFile = path.join(claudeDir(), "settings.json");
  const settings = readJson(settingsFile);
  const current = settings.statusLine;
  const ours = current && typeof current.command === "string" && /cc-termux\s+statusline|antigravity-status\.txt/.test(current.command);
  if (!current || ours) {
    // POSIX shells can cat the pre-rendered line in ~1ms; Windows falls back to the shim.
    const command = process.platform === "win32"
      ? "cc-termux statusline --print"
      : "sh -c 'f=\"${CC_TERMUX_CACHE:-$HOME/.cache/cc-termux}/antigravity-status.txt\"; cat \"$f\" 2>/dev/null || printf cc-termux'";
    settings.statusLine = { type: "command", command };
    writeJson(settingsFile, settings);
  }
  const cmdFile = path.join(claudeDir(), "commands", "antigravity-usage.md");
  try {
    fs.mkdirSync(path.dirname(cmdFile), { recursive: true });
    fs.writeFileSync(cmdFile, [
      "---",
      "description: Show Google Antigravity usage, quota windows and reset times",
      "allowed-tools: Bash(cc-termux antigravity usage)",
      "---",
      "!\`cc-termux antigravity usage\`",
      "",
    ].join("\n"), { mode: 0o644 });
  } catch (e) { }
  return { settingsFile, cmdFile, installed: !current || ours };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--install")) {
    installStatusLine();
    refreshStatusLine({ force: true }).then(() => {
      console.log("status line installed in " + path.join(claudeDir(), "settings.json"));
      console.log("restart Claude Code to see it  \u00b7  full usage: /antigravity-usage");
    }).catch((e) => { console.log("status line installed (usage refresh pending)"); });
  } else if (process.argv.includes("--refresh")) {
    refreshStatusLine({ force: true }).then((l) => console.log(l)).catch(() => { });
  } else {
    const line = readStatusLine();
    if (line) console.log(line);
    else {
      const cfg = readJson(configPath());
      const m = activeModel(cfg);
      console.log(m ? m.provider + " · " + m.name : "cc-termux");
    }
  }
}
