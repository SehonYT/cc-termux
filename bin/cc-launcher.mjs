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
let gwLog = null;
try { gwLog = fs.openSync(path.join(CACHE, "gateway.log"), "a"); } catch {}

async function healthy() {
  try { const r = await fetch(base + "/health", { signal: AbortSignal.timeout(1000) }); return r.ok; } catch { return false; }
}

async function ensureGateway() {
  if (await healthy()) return;
  const server = path.join(ROOT, "proxy", "server.mjs");
  if (!fs.existsSync(server)) { console.error("cc-launcher: gateway missing at " + server); process.exit(1); }
  const child = spawn(process.execPath, [server], {
    detached: true, stdio: ["ignore", gwLog ?? "ignore", gwLog ?? "ignore"],
    env: { ...process.env, CC_TERMUX_CONFIG: CFG },
  });
  child.unref();
  try { fs.writeFileSync(path.join(CACHE, "gateway.pid"), String(child.pid)); } catch {}
  for (let i = 0; i < 100; i++) { if (await healthy()) return; await new Promise((r) => setTimeout(r, 100)); }
  console.error("cc-launcher: gateway failed to start, see " + path.join(CACHE, "gateway.log"));
  process.exit(1);
}

function envForChild() {
  const env = { ...process.env };
  env.ANTHROPIC_BASE_URL = base;
  env.ANTHROPIC_AUTH_TOKEN = env.ANTHROPIC_AUTH_TOKEN || "cc-termux-local";
  delete env.ANTHROPIC_API_KEY;
  const p = (cfg.providers || {})[cfg.active] || {};
  const model = p.model || p.defaultModel;
  const a = p.aliases || {};
  const composite = (id) => (p && p.name ? id : id);
  if (model) {
    env.ANTHROPIC_MODEL = "";
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = composite(a.opus || model);
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = composite(a.sonnet || model);
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = composite(a.haiku || model);
    env.CLAUDE_CODE_SUBAGENT_MODEL = composite(a.subagent || model);
    delete env.ANTHROPIC_MODEL;
  }
  if (p.contextWindow) env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(p.contextWindow);
  env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = "1";
  env.TMPDIR = env.TMPDIR || os.tmpdir();
  env.CLAUDE_CODE_TMPDIR = env.CLAUDE_CODE_TMPDIR || env.TMPDIR;
  env.DISABLE_AUTOUPDATER = "1";
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  env.CLAUDE_CODE_DISABLE_MOUSE = env.CLAUDE_CODE_DISABLE_MOUSE || "1";
  if (process.platform === "android") env.BROWSER = env.BROWSER || "termux-open-url";
  return env;
}

(async () => {
  await ensureGateway();
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
  const child = spawn(cmd, args, { stdio: "inherit", env });
  child.on("exit", (code, signal) => process.exit(signal ? 1 : code ?? 0));
  child.on("error", (e) => { console.error("cc-launcher: " + e.message); process.exit(1); });
})();