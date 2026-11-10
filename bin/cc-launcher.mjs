#!/usr/bin/env node
// Claude Code launcher. Starts the gateway when needed, prepares the environment and
// execs the installed Claude Code binary for the current platform.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const ROOT = process.env.CC_TERMUX_ROOT || path.join(os.homedir(), ".local", "share", "cc-termux");
const CFG = process.env.CC_TERMUX_CONFIG || path.join(os.homedir(), ".config", "cc-termux", "config.json");
const CACHE = path.join(os.homedir(), ".cache", "cc-termux");
fs.mkdirSync(CACHE, { recursive: true });

function loadConfig() { try { return JSON.parse(fs.readFileSync(CFG, "utf8")); } catch { return { listen: { port: 8788 }, providers: {}, active: "" }; } }
const cfg = loadConfig();
const port = (cfg.listen && cfg.listen.port) || 8788;
const base = "http://127.0.0.1:" + port;
const SESSIONS = path.join(CACHE, "sessions");
const GATEWAY_TOKEN = process.env.CC_TERMUX_GATEWAY_TOKEN || "cc-termux-local";
fs.mkdirSync(SESSIONS, { recursive: true });
const sessionFile = path.join(SESSIONS, process.pid + ".session");
let sessionRegistered = false;
let gwLog = null;
try { gwLog = fs.openSync(path.join(CACHE, "gateway.log"), "a"); } catch {}

async function healthy() {
  try { const r = await fetch(base + "/health", { signal: AbortSignal.timeout(1000) }); return r.ok; } catch { return false; }
}

function isOurGateway(pid) {
  try {
    const env = fs.readFileSync("/proc/" + pid + "/environ", "utf8").split("\0");
    const want = "CC_TERMUX_CONFIG=" + path.resolve(CFG);
    if (env.includes(want)) return true;
    if (!env.some((e) => e.startsWith("CC_TERMUX_CONFIG=")) && path.resolve(CFG) === path.join(os.homedir(), ".config", "cc-termux", "config.json")) return true;
    return false;
  } catch (e) { return false; }
}

function gatewayPids() {
  if (process.platform !== "linux") {
    try { const pid = Number(fs.readFileSync(path.join(CACHE, "gateway.pid"), "utf8").trim()) || 0; if (pid > 0) return [pid]; } catch (e) { }
    return [];
  }
  const out = [];
  try {
    for (const d of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(d)) continue;
      try {
        const cmd = fs.readFileSync("/proc/" + d + "/cmdline", "utf8");
        const parts = cmd.split("\0");
        const pid = Number(d);
        if (pid !== process.pid && pid !== process.ppid && parts.includes(path.join(ROOT, "proxy", "server.mjs")) && isOurGateway(pid)) out.push(pid);
      } catch {}
    }
  } catch {}
  return out;
}

function stopGateway() {
  try {
    const pid = Number(fs.readFileSync(path.join(CACHE, "gateway.pid"), "utf8").trim());
    if (pid && pid !== process.pid) {
      const cmd = fs.readFileSync("/proc/" + pid + "/cmdline", "utf8");
      if (cmd.split("\0").includes(path.join(ROOT, "proxy", "server.mjs")) && isOurGateway(pid)) process.kill(pid, "SIGTERM");
    }
  } catch {}
  for (const pid of gatewayPids()) { try { process.kill(pid, "SIGTERM"); } catch {} }
  try { fs.unlinkSync(path.join(CACHE, "gateway.pid")); } catch {}
}

function hasLiveSessions() {
  try {
    return fs.readdirSync(SESSIONS).some((f) => {
      if (!f.endsWith(".session")) return false;
      try {
        const pid = Number(fs.readFileSync(path.join(SESSIONS, f), "utf8").trim()) || 0;
        if (pid <= 0) throw new Error("empty session");
        process.kill(pid, 0);
        return true;
      } catch { try { fs.unlinkSync(path.join(SESSIONS, f)); } catch {} ; return false; }
    });
  } catch { return false; }
}

async function ensureGateway() {
  if (await healthy()) return;
  const lockFile = path.join(CACHE, "gateway.lock");
  let locked = false;
  try { fs.mkdirSync(CACHE, { recursive: true }); fs.writeFileSync(lockFile, String(process.pid), { flag: "wx", mode: 0o600 }); locked = true; } catch (e) {
    for (let i = 0; i < 100; i++) { if (await healthy()) return; await new Promise((r) => setTimeout(r, 100)); }
    try { fs.unlinkSync(lockFile); fs.writeFileSync(lockFile, String(process.pid), { flag: "wx", mode: 0o600 }); locked = true; } catch (e2) { }
  }
  const releaseLock = () => { if (locked) { try { fs.unlinkSync(lockFile); } catch (e) { } } };
  // remove stale instances so a fresh one can bind the port
  for (const pid of gatewayPids()) { try { process.kill(pid, "SIGKILL"); } catch {} }
  const server = path.join(ROOT, "proxy", "server.mjs");
  if (!fs.existsSync(server)) { console.error("cc-launcher: gateway missing at " + server); process.exit(1); }
  const child = spawn(process.execPath, [server], {
    detached: true, stdio: ["ignore", gwLog ?? "ignore", gwLog ?? "ignore"],
    env: { ...process.env, CC_TERMUX_CONFIG: CFG, CC_TERMUX_MANAGED: "1", CC_TERMUX_GATEWAY_TOKEN: GATEWAY_TOKEN },
  });
  child.unref();
  try { fs.writeFileSync(path.join(CACHE, "gateway.pid"), String(child.pid)); } catch {}
  for (let i = 0; i < 300; i++) { if (await healthy()) { releaseLock(); return; } await new Promise((r) => setTimeout(r, 100)); }
  releaseLock();
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
  const target = p && p.model ? "prov/" + (cfg.active || p.name || "") + "/" + p.model : "";
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

async function envForChild() {
  const env = { ...process.env };
  env.ANTHROPIC_BASE_URL = base;
  env.ANTHROPIC_AUTH_TOKEN = GATEWAY_TOKEN;
  // Claude Code refuses its default cross-session messaging socket under a user
  // namespace without a uid map (some Termux/proot devices). Give it an explicit
  // socket path inside our private cache directory instead; the directory is 0700.
  if (!env.CLAUDE_CODE_MESSAGING_SOCKET) {
    try {
      const messagingDir = path.join(CACHE, "messaging");
      fs.mkdirSync(messagingDir, { recursive: true, mode: 0o700 });
      try { fs.chmodSync(messagingDir, 0o700); } catch (e) { }
      env.CLAUDE_CODE_MESSAGING_SOCKET = path.join(messagingDir, "messaging.sock");
    } catch (e) { }
  }
  env.CC_TERMUX_GATEWAY_TOKEN = GATEWAY_TOKEN;
  env.ANTHROPIC_API_KEY = GATEWAY_TOKEN;
  let p = (cfg.providers || {})[cfg.active] || {};
  try { sanitizeSettings(p); } catch (e) { }
  let settingsModel = "";
  try {
    const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    settingsModel = settings.model || "";
    // /model picker can persist a provider-switch marker. Claude Code then treats
    // that literal string as the model (and auto-mode's safety classifier names it).
    // Normalize it to the provider's real model before starting the session.
    const marker = /^provswitch\/([^/]+)$/.exec(settingsModel);
    if (marker && cfg.providers && cfg.providers[marker[1]]) {
      const target = cfg.providers[marker[1]];
      const real = (cfg.override && cfg.override.provider === marker[1] && cfg.override.model) || target.model || target.defaultModel;
      if (real) {
        settingsModel = "prov/" + marker[1] + "/" + real;
        settings.model = settingsModel;
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
      }
    }
  } catch {}
  const bareAnthropic = /^claude-(opus|sonnet|haiku)-[0-9]/.test(settingsModel) && !settingsModel.startsWith("prov/");
  let selectedProvider = "";
  let selectedId = "";
  const selectedMatch = /^prov\/([^/]+)\/(.+)$/.exec(settingsModel || "");
  if (selectedMatch && cfg.providers && cfg.providers[selectedMatch[1]]) {
    selectedProvider = selectedMatch[1];
    selectedId = selectedMatch[2];
  }
  let selectedContext = null;
  if (selectedProvider && selectedId) {
    const sp = cfg.providers[selectedProvider];
    const info = sp.modelsById && sp.modelsById[selectedId];
    if (info && info.contextTokens) selectedContext = info.contextTokens;
    // A /model row belongs to its own provider. Selecting one makes that provider active,
    // so the gateway, the status line and the quota display all follow the model in use.
    const stale = cfg.active !== selectedProvider || !cfg.override
      || cfg.override.provider !== selectedProvider || cfg.override.model !== selectedId;
    if (stale) {
      cfg.active = selectedProvider;
      cfg.override = { provider: selectedProvider, model: selectedId };
      try { fs.writeFileSync(CFG, JSON.stringify(cfg, null, 2) + "\n"); } catch (e) { }
      p = cfg.providers[cfg.active] || p;
    }
  }
  const model = p.model || p.defaultModel;
  const a = p.aliases || {};
  const composite = (id) => (String(id).startsWith("prov/") || !cfg.active ? id : "prov/" + cfg.active + "/" + id);
  delete env.ANTHROPIC_MODEL;
  for (const k of ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "ANTHROPIC_CUSTOM_HEADERS", "ANTHROPIC_BEDROCK_BASE_URL", "ANTHROPIC_VERTEX_BASE_URL"]) delete env[k];
  if (model) {
    // Auto mode's safety classifier is an extra Claude call. Pin it to a usable
    // Claude model (bare id - provider-qualified aliases are rejected) from the
    // active provider, or from another configured provider that has a key.
    try {
      if (!env.CLAUDE_CODE_AUTO_MODE_MODEL && cfg.active) {
        let keys = {};
        try { keys = JSON.parse(fs.readFileSync(path.join(path.dirname(CFG), "keys.json"), "utf8")); } catch (e) { }
        const usable = (name, q) => name === cfg.active || keys[name] || q.noKey || q.apiKeyEnv;
        const allowed = (id) => typeof id === "string" && id.startsWith("claude-") && !/5-5|opus-5/.test(id);
        const candidates = [cfg.active, ...Object.keys(cfg.providers || {}).filter((n) => n !== cfg.active && !cfg.providers[n].hidden)];
        let pick = "", pickProvider = "";
        for (const name of candidates) {
          const q = cfg.providers[name];
          if (!q || !usable(name, q)) continue;
          const ids = Object.keys(q.modelsById || {}).filter(allowed);
          const id = ids.find((x) => /^claude-sonnet-4-6$/.test(x)) || ids.find((x) => /^claude-opus-4-6/.test(x)) || ids[0];
          if (id) { pick = id; pickProvider = name; break; }
        }
        if (pick) {
          env.CLAUDE_CODE_AUTO_MODE_MODEL = pick;
          if (!env.CLAUDE_CODE_BG_CLASSIFIER_MODEL) env.CLAUDE_CODE_BG_CLASSIFIER_MODEL = pick;
          if (pickProvider !== cfg.active) {
            cfg.routing = cfg.routing || {};
            if (cfg.routing[pick] !== pickProvider + "::" + pick) {
              cfg.routing[pick] = pickProvider + "::" + pick;
              try { fs.writeFileSync(CFG, JSON.stringify(cfg, null, 2) + "\n"); } catch (e) { }
            }
          }
        }
      }
    } catch (e) { }
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
    const perfMod = await import("file://" + path.join(ROOT, "bin", "cc-perf.mjs"));
    const resolved = perfMod.resolvePerf({ mode: (cfg.performance && cfg.performance.mode) || "off" });
    if (resolved.enabled) {
      Object.assign(env, perfMod.applyPerfEnv({}, resolved));
      try { perfMod.setReducedMotion(os.homedir(), true); } catch (e) { }
      if (process.env.CC_TERMUX_PERF_VERBOSE === "1") process.stderr.write("cc-termux: performance profile: on\n");
    }
  } catch (e) { }
  const ctx = selectedContext || p.contextWindow;
  if (ctx) env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(ctx);
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
  if (!trivial) {
    try { fs.writeFileSync(sessionFile, String(process.pid)); sessionRegistered = true; } catch {}
    await ensureGateway();
  }
  const env = await envForChild();
  if (!trivial) {
    // Replace a stale status line left by a previous session/provider.
    try { spawn(process.execPath, [path.join(ROOT, "bin", "cc-statusline.mjs"), "--refresh"], { stdio: "ignore", detached: true, env }).unref(); } catch (e) { }
  }
  const isWin = process.platform === "win32";
  const bin = path.join(ROOT, "bin", isWin ? "claude.exe" : "claude.bin");
  const jsCli = path.join(ROOT, "js", "cli.js");
  let installedVersion = "";
  try { installedVersion = fs.readFileSync(path.join(ROOT, "VERSION"), "utf8").trim(); } catch {}
  const jsMode = fs.existsSync(jsCli) && (installedVersion.endsWith("-js") || !fs.existsSync(bin));
  let cmd;
  let args;
  if (jsMode) {
    cmd = process.execPath;
    args = [jsCli, ...process.argv.slice(2)];
  } else {
    cmd = bin;
    args = process.argv.slice(2);
    if (!fs.existsSync(bin)) { console.error("cc-launcher: Claude Code binary not installed at " + bin); process.exit(1); }
    if (process.platform === "android" && !fs.existsSync(path.join(ROOT, ".direct-exec"))) {
      try {
        const loader = fs.readdirSync(path.join(ROOT, "lib")).find((f) => f.startsWith("ld-musl-"));
        if (loader) { args = [bin, ...args]; cmd = path.join(ROOT, "lib", loader); }
      } catch {}
    }
  }
  let child = null;
  const cleanup = () => {
    if (!sessionRegistered) return;
    try { fs.unlinkSync(sessionFile); } catch {}
    if (!hasLiveSessions()) stopGateway();
  };
  process.on("exit", cleanup);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => { if (child) { try { child.kill(sig); } catch { cleanup(); process.exit(130); } } else { cleanup(); process.exit(130); } });
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
  child = spawn(cmd, args, { stdio: "inherit", env });
  child.on("exit", (code, signal) => { cleanup(); process.exit(signal ? 1 : code ?? 0); });
  child.on("error", (e) => { console.error("cc-launcher: " + e.message); cleanup(); process.exit(1); });
})();