#!/usr/bin/env node
// Claude Code launcher. Starts the gateway when needed, prepares the environment and
// execs the installed Claude Code binary for the current platform.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { resolvePerf, applyPerfEnv, setReducedMotion } from "./cc-perf.mjs";

const ROOT = process.env.CC_TERMUX_ROOT || path.join(os.homedir(), ".local", "share", "cc-termux");
const CFG = process.env.CC_TERMUX_CONFIG || path.join(os.homedir(), ".config", "cc-termux", "config.json");
const CACHE = path.join(os.homedir(), ".cache", "cc-termux");
fs.mkdirSync(CACHE, { recursive: true });

function loadConfig() { try { return JSON.parse(fs.readFileSync(CFG, "utf8")); } catch { return { listen: { port: 8788 }, providers: {}, active: "" }; } }
const cfg = loadConfig();
const port = (cfg.listen && cfg.listen.port) || 8788;
const base = "http://127.0.0.1:" + port;
const SESSIONS = path.join(CACHE, "sessions");
fs.mkdirSync(SESSIONS, { recursive: true });
const sessionFile = path.join(SESSIONS, process.pid + ".session");
let sessionRegistered = false;
let gwLog = null;
try { gwLog = fs.openSync(path.join(CACHE, "gateway.log"), "a"); } catch {}

async function healthy() {
  try { const r = await fetch(base + "/health", { signal: AbortSignal.timeout(1000) }); return r.ok; } catch { return false; }
}

function gatewayPids() {
  const out = [];
  try {
    for (const d of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(d)) continue;
      try {
        const cmd = fs.readFileSync("/proc/" + d + "/cmdline", "utf8");
        if (cmd.includes("proxy/server.mjs") && Number(d) !== process.pid) out.push(Number(d));
      } catch {}
    }
  } catch {}
  return out;
}

function stopGateway() {
  try { const pid = Number(fs.readFileSync(path.join(CACHE, "gateway.pid"), "utf8").trim()); process.kill(pid, "SIGTERM"); } catch {}
  for (const pid of gatewayPids()) { try { process.kill(pid, "SIGTERM"); } catch {} }
  try { fs.unlinkSync(path.join(CACHE, "gateway.pid")); } catch {}
}

function hasLiveSessions() {
  try {
    return fs.readdirSync(SESSIONS).some((f) => {
      if (!f.endsWith(".session")) return false;
      try {
        const pid = Number(fs.readFileSync(path.join(SESSIONS, f), "utf8").trim());
        process.kill(pid, 0);
        return true;
      } catch { try { fs.unlinkSync(path.join(SESSIONS, f)); } catch {} ; return false; }
    });
  } catch { return false; }
}

async function ensureGateway() {
  if (await healthy()) return;
  // remove stale instances so a fresh one can bind the port
  for (const pid of gatewayPids()) { try { process.kill(pid, "SIGKILL"); } catch {} }
  const server = path.join(ROOT, "proxy", "server.mjs");
  if (!fs.existsSync(server)) { console.error("cc-launcher: gateway missing at " + server); process.exit(1); }
  fs.writeFileSync(sessionFile, String(process.pid));
  sessionRegistered = true;
  const child = spawn(process.execPath, [server], {
    detached: true, stdio: ["ignore", gwLog ?? "ignore", gwLog ?? "ignore"],
    env: { ...process.env, CC_TERMUX_CONFIG: CFG, CC_TERMUX_MANAGED: "1" },
  });
  child.unref();
  try { fs.writeFileSync(path.join(CACHE, "gateway.pid"), String(child.pid)); } catch {}
  for (let i = 0; i < 300; i++) { if (await healthy()) return; await new Promise((r) => setTimeout(r, 100)); }
  const logFile = path.join(CACHE, "gateway.log");
  console.error("cc-launcher: gateway failed to start");
  try {
    const tail = fs.readFileSync(logFile, "utf8").trim().split("\n").slice(-15).join("\n");
    if (tail) console.error("--- gateway.log ---\n" + tail + "\n-----------------");
  } catch {}
  console.error("check: cc-termux doctor | curl http://127.0.0.1:" + port + "/health");
  process.exit(1);
}

function sanitizeSettings(p) {
  const file = path.join(os.homedir(), ".claude", "settings.json");
  let s;
  try { s = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return; }
  let changed = false;
  const removed = [];
  if (s.env && typeof s.env === "object") {
    for (const k of Object.keys(s.env)) {
      if (/^ANTHROPIC_/.test(k) || k === "CLAUDE_CODE_MAX_CONTEXT_TOKENS" || k === "CLAUDE_CODE_SUBAGENT_MODEL") {
        delete s.env[k];
        removed.push(k);
        changed = true;
      }
    }
  }
  const sm = typeof s.model === "string" ? s.model : "";
  const stale = !sm || sm === "default" || /^(opus|sonnet|haiku)$/.test(sm) || (/^claude-(opus|sonnet|haiku)-[0-9]/.test(sm) && !sm.startsWith("prov/"));
  const target = p && p.model ? "prov/" + (p.name || "") + "/" + p.model : "";
  if (stale && target) { s.model = target; changed = true; }
  if (changed) {
    try {
      fs.copyFileSync(file, file + ".cc-termux-backup");
      fs.writeFileSync(file, JSON.stringify(s, null, 2) + "\n");
      fs.appendFileSync(path.join(CACHE, "errors.log"), JSON.stringify({
        at: new Date().toISOString(), kind: "config", provider: p && p.name || null, model: target || null,
        status: null, message: "repaired settings.json" + (removed.length ? " (removed env: " + removed.join(",") + ")" : "") + (stale ? " (model set)" : ""),
      }) + "\n");
    } catch (e) { }
  }
}

function envForChild() {
  const env = { ...process.env };
  env.ANTHROPIC_BASE_URL = base;
  env.ANTHROPIC_AUTH_TOKEN = env.ANTHROPIC_AUTH_TOKEN || "cc-termux-local";
  delete env.ANTHROPIC_API_KEY;
  const p = (cfg.providers || {})[cfg.active] || {};
  try { sanitizeSettings(p); } catch (e) { }
  let settingsModel = "";
  try { settingsModel = (JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude", "settings.json"), "utf8")).model) || ""; } catch {}
  const bareAnthropic = /^claude-(opus|sonnet|haiku)-[0-9]/.test(settingsModel) && !settingsModel.startsWith("prov/");
  const model = p.model || p.defaultModel;
  const a = p.aliases || {};
  const composite = (id) => (p && p.name ? id : id);
  delete env.ANTHROPIC_MODEL;
  if (model) {
    if (!settingsModel || bareAnthropic) {
      // Stale/absent settings.model: pin the provider model so the session does not
      // fall back to Anthropic's built-in default (Opus). Mid-session picker changes
      // still work because only the stale cases are pinned.
      env.ANTHROPIC_MODEL = cfg.active && p.model ? "prov/" + cfg.active + "/" + p.model : model;
    }
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = composite(a.opus || model);
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = composite(a.sonnet || model);
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = composite(a.haiku || model);
    env.CLAUDE_CODE_SUBAGENT_MODEL = composite(a.subagent || model);
  }
  try {
    const resolved = resolvePerf({ mode: (cfg.performance && cfg.performance.mode) || "auto" });
    if (resolved.enabled) {
      Object.assign(env, applyPerfEnv({}, resolved));
      try { setReducedMotion(os.homedir(), true); } catch (e) { }
      if (process.env.CC_TERMUX_PERF_VERBOSE === "1") process.stderr.write("cc-termux: performance profile: " + resolved.reason + "\n");
    }
  } catch (e) { }
  if (p.contextWindow) env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(p.contextWindow);
  env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = "1";
  env.TMPDIR = env.TMPDIR || os.tmpdir();
  env.CLAUDE_CODE_TMPDIR = env.CLAUDE_CODE_TMPDIR || env.TMPDIR;
  env.DISABLE_AUTOUPDATER = "1";
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  env.CLAUDE_CODE_DISABLE_MOUSE = env.CLAUDE_CODE_DISABLE_MOUSE || "1";
  if (process.platform === "android") {
    env.BROWSER = env.BROWSER || "termux-open-url";
    // libtermux-exec is a bionic library; the musl loader cannot relocate it.
    delete env.LD_PRELOAD;
    delete env.LD_LIBRARY_PATH;
  }
  return env;
}

(async () => {
  const argv = process.argv.slice(2);
  const trivial = argv.some((a) => a === "--version" || a === "-v" || a === "--help" || a === "-h");
  if (!trivial) await ensureGateway();
  const env = envForChild();
  const isWin = process.platform === "win32";
  const bin = path.join(ROOT, "bin", isWin ? "claude.exe" : "claude.bin");
  let cmd = bin;
  let args = process.argv.slice(2);
  if (!fs.existsSync(bin)) { console.error("cc-launcher: Claude Code binary not installed at " + bin); process.exit(1); }
  if (process.platform === "android" && !fs.existsSync(path.join(ROOT, ".direct-exec"))) {
    try {
      const loader = fs.readdirSync(path.join(ROOT, "lib")).find((f) => f.startsWith("ld-musl-"));
      if (loader) { args = [bin, ...args]; cmd = path.join(ROOT, "lib", loader); }
    } catch {}
  }
  const cleanup = () => {
    if (!sessionRegistered) return;
    try { fs.unlinkSync(sessionFile); } catch {}
    if (!hasLiveSessions()) stopGateway();
  };
  process.on("exit", cleanup);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => { cleanup(); process.exit(130); });
  if (!trivial && process.stderr.isTTY) {
    try {
      const mod = await import("file://" + path.join(ROOT, "bin", "cc-update.mjs"));
      const info = await Promise.race([
        mod.check({ root: ROOT, cacheTtlMs: 24 * 3600 * 1000 }),
        new Promise((r) => setTimeout(() => r(null), 2500)),
      ]);
      if (info && info.available) {
        const { labelVersion } = await import("file://" + path.join(ROOT, "scripts", "version.mjs"));
        console.error("cc-termux: update available (" + labelVersion(info.local.version, info.local.sha) + " -> " + labelVersion(info.remote.version, info.remote.sha) + ") - run: cc-termux update");
      }
    } catch (e) { }
  }
  const child = spawn(cmd, args, { stdio: "inherit", env });
  child.on("exit", (code, signal) => { cleanup(); process.exit(signal ? 1 : code ?? 0); });
  child.on("error", (e) => { console.error("cc-launcher: " + e.message); cleanup(); process.exit(1); });
})();