import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function runLauncher({ root: rt, home, cfgFile, cache }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(rt, "bin", "cc-launcher.mjs"), "-e", "0"], {
      env: { ...process.env, HOME: home, USERPROFILE: home, CC_TERMUX_ROOT: rt, CC_TERMUX_CONFIG: cfgFile, CC_TERMUX_CACHE: cache },
      stdio: "ignore",
    });
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} resolve(); }, 25000);
    child.on("exit", () => { clearTimeout(timer); resolve(); });
  });
}

function makeRoot(tmp) {
  const rt = path.join(tmp, "root");
  fs.mkdirSync(path.join(rt, "bin"), { recursive: true });
  for (const f of fs.readdirSync(path.join(root, "bin"))) {
    if (f.endsWith(".mjs")) fs.copyFileSync(path.join(root, "bin", f), path.join(rt, "bin", f));
  }
  fs.cpSync(path.join(root, "proxy"), path.join(rt, "proxy"), { recursive: true });
  // A stand-in for the 300MB Claude binary: the launcher only needs to exec something.
  // Copying the running Node binary keeps this portable (a shell script is not execable
  // on Windows) and makes it exit immediately.
  const stub = path.join(rt, "bin", process.platform === "win32" ? "claude.exe" : "claude.bin");
  fs.copyFileSync(process.execPath, stub);
  try { fs.chmodSync(stub, 0o755); } catch (e) { }
  fs.writeFileSync(path.join(rt, ".direct-exec"), "");
  fs.writeFileSync(path.join(rt, "VERSION"), "9.9.9");
  return rt;
}

test("picking a model row switches the active provider so status line and quotas follow it", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cc-launcher-"));
  const home = path.join(tmp, "home");
  const cache = path.join(home, ".cache", "cc-termux");
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.mkdirSync(cache, { recursive: true });
  const rt = makeRoot(tmp);
  const port = 18500 + Math.floor(Math.random() * 400);
  const cfgFile = path.join(tmp, "config.json");
  fs.writeFileSync(cfgFile, JSON.stringify({
    listen: { host: "127.0.0.1", port },
    active: "tokens",
    override: { provider: "tokens", model: "deepseek/deepseek-v4.1-flash" },
    providers: {
      tokens: { type: "openai", noKey: true, model: "deepseek/deepseek-v4.1-flash", defaultModel: "deepseek/deepseek-v4.1-flash", modelsById: { "deepseek/deepseek-v4.1-flash": { name: "DeepSeek V4.1 Flash", contextTokens: 1000000 } } },
      antigravity: { type: "antigravity", noKey: true, model: "gemini-3.8-flash-high", modelsById: { "gemini-3.8-flash-high": { name: "Gemini 3.8 Flash (High)", contextTokens: 1000000 } } },
    },
  }, null, 2));
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ model: "prov/antigravity/gemini-3.8-flash-high" }));
  try {
    await runLauncher({ root: rt, home, cfgFile, cache });
    const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
    assert.equal(cfg.active, "antigravity", "selecting an antigravity model must make antigravity active");
    assert.deepEqual(cfg.override, { provider: "antigravity", model: "gemini-3.8-flash-high" });
  } finally {
    // The launcher leaves a detached status-line refresh and a gateway behind for a
    // moment; retry so cleanup cannot race their last write.
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch (e) { }
  }
});

test("the launcher forces the local auto-mode classifier and pins a Claude-capable model", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cc-launcher-env-"));
  const home = path.join(tmp, "home");
  const cache = path.join(home, ".cache", "cc-termux");
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.mkdirSync(cache, { recursive: true });
  const rt = makeRoot(tmp);
  const port = 18900 + Math.floor(Math.random() * 300);
  const cfgFile = path.join(tmp, "config.json");
  fs.writeFileSync(cfgFile, JSON.stringify({
    listen: { host: "127.0.0.1", port },
    active: "antigravity",
    override: { provider: "antigravity", model: "gemini-3.8-flash-high" },
    providers: {
      antigravity: { type: "antigravity", noKey: true, model: "gemini-3.8-flash-high",
        modelsById: { "gemini-3.8-flash-high": { name: "Gemini 3.8 Flash (High)" }, "claude-sonnet-4-6": { name: "Claude Sonnet 4.6" } } },
    },
  }, null, 2));
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ model: "prov/antigravity/gemini-3.8-flash-high" }));
  const dump = path.join(tmp, "env.json");
  try {
    await new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(rt, "bin", "cc-launcher.mjs"), "-e",
        "require('fs').writeFileSync(process.env.CC_ENV_DUMP, JSON.stringify(process.env))"], {
        env: { ...process.env, HOME: home, USERPROFILE: home, CC_TERMUX_ROOT: rt, CC_TERMUX_CONFIG: cfgFile, CC_TERMUX_CACHE: cache, CC_ENV_DUMP: dump, ANTHROPIC_AUTH_TOKEN: "inherited-should-be-dropped" },
        stdio: "ignore",
      });
      const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} resolve(); }, 25000);
      child.on("exit", () => { clearTimeout(timer); resolve(); });
    });
    const env = JSON.parse(fs.readFileSync(dump, "utf8"));
    assert.equal(env.CLAUDE_CODE_AUTO_MODE_SERVER, "0", "server-side classifier must be disabled behind the gateway");
    assert.match(env.CLAUDE_CODE_AUTO_MODE_MODEL || "", /^claude-/, "classifier must be a Claude-capable model");
    // Claude Code warns (and may pick the wrong header) when both are set.
    assert.equal(env.ANTHROPIC_API_KEY, "cc-termux-local", "gateway token must be the API key");
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined, "ANTHROPIC_AUTH_TOKEN must not be set too");
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch (e) { }
  }
});
