import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("status line installer preserves custom lines and is idempotent", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cc-statusline-"));
  const old = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = tmp;
  try {
    const mod = await import("../bin/cc-statusline.mjs?t=" + Date.now());
    const settingsFile = path.join(tmp, "settings.json");
    const r1 = mod.installStatusLine();
    assert.equal(r1.installed, true);
    const first = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    assert.ok(/antigravity-status\.txt|statusline/.test(first.statusLine.command));
    assert.ok(fs.existsSync(path.join(tmp, "commands", "antigravity-usage.md")));
    const r2 = mod.installStatusLine();
    assert.equal(r2.installed, true);
    const second = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    assert.deepEqual(second.statusLine, first.statusLine);
    second.statusLine = { type: "command", command: "my-custom" };
    fs.writeFileSync(settingsFile, JSON.stringify(second));
    const r3 = mod.installStatusLine();
    assert.equal(r3.installed, false);
    assert.equal(JSON.parse(fs.readFileSync(settingsFile, "utf8")).statusLine.command, "my-custom");
  } finally {
    if (old === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = old;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("status line model follows Claude settings.model, not the provider default", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cc-statusline-model-"));
  const old = { CC_TERMUX_CONFIG: process.env.CC_TERMUX_CONFIG, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  process.env.CC_TERMUX_CONFIG = path.join(tmp, "config.json");
  process.env.CLAUDE_CONFIG_DIR = tmp;
  try {
    fs.writeFileSync(path.join(tmp, "config.json"), JSON.stringify({ active: "antigravity", providers: { antigravity: { type: "antigravity", model: "gemini-3.8-flash-high", modelsById: {
      "gemini-3.8-flash-high": { name: "Gemini 3.8 Flash (High)" },
      "claude-sonnet-4-6": { name: "Claude Sonnet 4.6 (Thinking)" },
    } } } }));
    fs.writeFileSync(path.join(tmp, "settings.json"), JSON.stringify({ model: "prov/antigravity/claude-sonnet-4-6" }));
    const mod = await import("../bin/cc-statusline.mjs?t=" + Date.now());
    const cfg = JSON.parse(fs.readFileSync(path.join(tmp, "config.json"), "utf8"));
    const m = mod.activeModel(cfg);
    assert.equal(m.name, "Claude Sonnet 4.6 (Thinking)");
  } finally {
    if (old.CC_TERMUX_CONFIG === undefined) delete process.env.CC_TERMUX_CONFIG; else process.env.CC_TERMUX_CONFIG = old.CC_TERMUX_CONFIG;
    if (old.CLAUDE_CONFIG_DIR === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = old.CLAUDE_CONFIG_DIR;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
test("status line shows the selected non-Antigravity provider and model, never 'antigravity'", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cc-statusline-other-"));
  const old = { CC_TERMUX_CONFIG: process.env.CC_TERMUX_CONFIG, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CC_TERMUX_CACHE: process.env.CC_TERMUX_CACHE };
  process.env.CC_TERMUX_CONFIG = path.join(tmp, "config.json");
  process.env.CLAUDE_CONFIG_DIR = tmp;
  process.env.CC_TERMUX_CACHE = path.join(tmp, "cache");
  try {
    fs.writeFileSync(path.join(tmp, "config.json"), JSON.stringify({ active: "antigravity", providers: {
      antigravity: { type: "antigravity", model: "gemini-3.8-flash-high", modelsById: { "gemini-3.8-flash-high": { name: "Gemini 3.8 Flash (High)" } } },
      tokens: { type: "openai", model: "deepseek/deepseek-v4.1-flash", modelsById: { "deepseek/deepseek-v4.1-flash": { name: "DeepSeek V4.1 Flash" } } },
    } }));
    fs.writeFileSync(path.join(tmp, "settings.json"), JSON.stringify({ model: "prov/tokens/deepseek/deepseek-v4.1-flash" }));
    fs.mkdirSync(path.join(tmp, "cache"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "cache", "antigravity-status.txt"), "antigravity · Gemini 3.8 Flash (High) · G 5h 100% 7d 96%\n");
    const mod = await import("../bin/cc-statusline.mjs?t=" + Date.now());
    const line = await mod.refreshStatusLine({ force: true });
    assert.equal(line, "tokens · DeepSeek V4.1 Flash");
    assert.equal(mod.readStatusLine(), "tokens · DeepSeek V4.1 Flash");
  } finally {
    for (const k of Object.keys(old)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("a model id is resolved against the provider it came from, not the active one", async () => {
  const mod = await import("../bin/cc-statusline.mjs?t=" + Date.now());
  const cfg = { active: "tokens", providers: {
    tokens: { type: "openai", model: "deepseek/deepseek-v4.1-flash", modelsById: { "deepseek/deepseek-v4.1-flash": { name: "DeepSeek V4.1 Flash" } } },
    antigravity: { type: "antigravity", model: "gemini-3.8-flash-high", modelsById: { "gemini-3.8-flash-high": { name: "Gemini 3.8 Flash (High)" } } },
  } };
  const wrong = mod.activeModel(cfg, "gemini-3.8-flash-high");
  assert.equal(wrong.type, "openai", "id alone falls back to the active provider (old bug)");
  const right = mod.activeModel(cfg, "gemini-3.8-flash-high", "antigravity");
  assert.equal(right.provider, "antigravity");
  assert.equal(right.type, "antigravity");
  assert.equal(right.name, "Gemini 3.8 Flash (High)");
});

test("status line install reports a read-only Claude dir instead of throwing", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cc-statusline-ro-"));
  const rc = path.join(tmp, "claude");
  fs.mkdirSync(rc, { recursive: true });
  const old = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CC_TERMUX_CACHE: process.env.CC_TERMUX_CACHE };
  process.env.CLAUDE_CONFIG_DIR = rc;
  process.env.CC_TERMUX_CACHE = path.join(tmp, "cache");
  try {
    try { fs.chmodSync(rc, 0o500); } catch (e) { }
    const mod = await import("../bin/cc-statusline.mjs?ro=" + Date.now());
    let res;
    assert.doesNotThrow(() => { res = mod.installStatusLine(); });
    // Running as root (some CI containers) can still write; then the install legitimately works.
    if (res.installed === false) assert.equal(fs.existsSync(path.join(rc, "settings.json")), false);
  } finally {
    try { fs.chmodSync(rc, 0o700); } catch (e) { }
    if (old.CLAUDE_CONFIG_DIR === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = old.CLAUDE_CONFIG_DIR;
    if (old.CC_TERMUX_CACHE === undefined) delete process.env.CC_TERMUX_CACHE; else process.env.CC_TERMUX_CACHE = old.CC_TERMUX_CACHE;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
