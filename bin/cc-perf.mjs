#!/usr/bin/env node
// Mobile / low-end performance profile, opt-in via `modelmesh tune on` or MODELMESH_PERF=1.
// Turns off expensive UI/IO features; never changes the model or provider.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PERF_ENV = {
  CLAUDE_CODE_DISABLE_MOUSE: "1",
  CLAUDE_CODE_DISABLE_MOUSE_CLICKS: "1",
  CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1",
  CLAUDE_CODE_DISABLE_WORKING_SYNC_WATCH: "1",
  CLAUDE_CODE_DISABLE_STARTUP_WORK_GATE: "1",
  CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: "1",
  CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING: "1",
  CLAUDE_CODE_DISABLE_AGENT_VIEW: "1",
  CLAUDE_CODE_DISABLE_CRON: "1",
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
};

export function resolvePerf({ mode = "off", platform = process.platform, env = process.env, prefix = process.env.PREFIX } = {}) {
  const override = String(env.MODELMESH_PERF || "").toLowerCase();
  if (override === "1" || override === "on" || override === "mobile") return { enabled: true, mode: "on", reason: "MODELMESH_PERF" };
  if (override === "0" || override === "off" || override === "normal") return { enabled: false, mode: "off", reason: "MODELMESH_PERF" };
  if (mode === "mobile" || mode === "on") return { enabled: true, mode: "on", reason: "chosen by you" };
  return { enabled: false, mode: "off", reason: "off" };
}

export function applyPerfEnv(env, resolved) {
  if (!resolved.enabled) return env;
  return { ...env, ...PERF_ENV };
}

export const PERF_PROMPT_LINES = [
  "Performance mode: makes Claude Code smoother on phones and slow computers.",
  "",
  "If you turn it on, these things will be turned OFF:",
  "  - clicking with the mouse",
  "  - fancy window title updates",
  "  - undo checkpoints (rewinding a file)",
  "  - work that runs in the background",
  "  - scheduled tasks",
  "  - extra git text added to prompts",
  "  - animations",
  "",
  "You can change this anytime: modelmesh tune on / modelmesh tune off",
];

export function perfDefaultAnswer({ mode } = {}) {
  return mode === "mobile" || mode === "on" ? "yes" : "no";
}

// Ask once per installation: only when no choice has ever been recorded.
export function shouldAskPerf(mode) {
  return !mode || mode === "auto";
}

export async function savePerfMode(cfgPath, mode) {
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")); }
  catch (e) {
    if (fs.existsSync(cfgPath)) { console.error("modelmesh: config is not valid JSON; leaving it untouched: " + cfgPath); return false; }
    cfg = {};
  }
  cfg.performance = { ...(cfg.performance || {}), mode };
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  const tmp = cfgPath + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, cfgPath);
  try { fs.chmodSync(cfgPath, 0o600); } catch (e) { }
}
export function setReducedMotion(home = os.homedir(), enabled = true) {
  const file = path.join(home, ".claude.json");
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) {
    if (fs.existsSync(file)) return false; // never overwrite a corrupt user config
    cfg = {};
  }
  if (cfg.prefersReducedMotion === enabled) return false;
  cfg.prefersReducedMotion = enabled;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + "." + process.pid + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n");
    fs.renameSync(tmp, file);
  } catch (e) { return false; }
  return true;
}