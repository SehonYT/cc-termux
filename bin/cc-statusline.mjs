#!/usr/bin/env node
// Claude Code status line: shows the active provider model plus Antigravity quota.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAntigravityUsage, readUsageCache } from "./cc-antigravity.mjs";

function configPath() {
  return process.env.CC_TERMUX_CONFIG || path.join(os.homedir(), ".config", "cc-termux", "config.json");
}
function claudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}
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
function shortGroup(g) {
  if (g.id === "gemini") return "G";
  if (g.id === "claude") return "C";
  if (g.id === "argon") return "A";
  return (g.label || "?").slice(0, 1).toUpperCase();
}
function formatUsage(u) {
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
async function currentUsage() {
  const cached = readUsageCache();
  if (cached && cached.fetchedAt && Date.now() - cached.fetchedAt < 120000) return cached;
  try {
    return await Promise.race([
      getAntigravityUsage({ timeoutMs: 1500 }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 2200)),
    ]);
  } catch (e) { return cached || null; }
}
export function installStatusLine() {
  const settingsFile = path.join(claudeDir(), "settings.json");
  const settings = readJson(settingsFile);
  const current = settings.statusLine;
  const ours = current && typeof current.command === "string" && /cc-termux\s+statusline/.test(current.command);
  if (!current || ours) {
    settings.statusLine = { type: "command", command: "cc-termux statusline" };
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

async function main() {
  const cfg = readJson(configPath());
  const active = cfg.providers && cfg.providers[cfg.active];
  if (!active) { console.log("cc-termux"); return; }
  const model = (active.modelsById && active.modelsById[active.model] && active.modelsById[active.model].name) || active.model || active.type;
  if (active.type !== "antigravity") {
    console.log("cc-termux · " + (cfg.active || "provider") + " · " + model);
    return;
  }
  const usage = await currentUsage();
  console.log("antigravity · " + model + " · " + formatUsage(usage));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--install")) {
    const r = installStatusLine();
    console.log(r.installed ? "status line installed in " + r.settingsFile : "existing custom status line kept (" + r.settingsFile + ")");
    console.log("full usage: /antigravity-usage");
  } else {
    main().catch((e) => { console.log("cc-termux · usage unavailable"); });
  }
}
