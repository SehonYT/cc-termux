#!/usr/bin/env node
// Mobile / low-end device performance profile.
//
// Enabled automatically on Termux/Android, or manually with `cc-termux tune on`.
// The profile disables expensive UI/IO features Claude Code exposes as env flags
// and turns on reduced motion. Nothing here changes the model or provider.
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

export function isMobileLike({ platform = process.platform, env = process.env, prefix } = {}) {
  if (platform === "android") return true;
  if (platform !== "linux" && platform !== "freebsd") return false;
  if (prefix === undefined) prefix = env.PREFIX || process.env.PREFIX || "";
  if (/termux/i.test(String(prefix || ""))) return true;
  if (env.TERMUX_VERSION) return true;
  return false;
}

export function resolvePerf({ mode = "off", platform = process.platform, env = process.env, prefix = process.env.PREFIX } = {}) {
  const override = String(env.CC_TERMUX_PERF || "").toLowerCase();
  if (override === "1" || override === "on" || override === "mobile") return { enabled: true, mode: "mobile", reason: "CC_TERMUX_PERF" };
  if (override === "0" || override === "off" || override === "normal") return { enabled: false, mode: "off", reason: "CC_TERMUX_PERF" };
  if (mode === "mobile" || mode === "on") return { enabled: true, mode: "mobile", reason: "chosen by you" };
  return { enabled: false, mode: "off", reason: "off" };
}

export function applyPerfEnv(env, resolved) {
  if (!resolved.enabled) return env;
  return { ...env, ...PERF_ENV };
}

export const PERF_PROMPT_LINES = [
  "Speed mode: makes Claude Code smoother on phones and slow computers.",
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
  "You can change this anytime: cc-termux tune on / cc-termux tune off",
];

export function perfDefaultAnswer({ mode } = {}) {
  return mode === "mobile" || mode === "on" ? "yes" : "no";
}

// Ask once per installation: only when no choice has ever been recorded.
export function shouldAskPerf(mode) {
  return !mode || mode === "auto";
}

export async function savePerfMode(cfgPath, mode) {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")); } catch (e) { cfg = {}; }
  cfg.performance = { ...(cfg.performance || {}), mode };
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
}
export function setReducedMotion(home = os.homedir(), enabled = true) {
  const file = path.join(home, ".claude.json");
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { cfg = {}; }
  if (cfg.prefersReducedMotion === enabled) return false;
  cfg.prefersReducedMotion = enabled;
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n"); } catch (e) { return false; }
  return true;
}