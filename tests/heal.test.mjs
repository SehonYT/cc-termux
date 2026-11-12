import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { healEnvironment } from "../bin/cc-heal.mjs";

test("heal repairs settings, foreign claude binaries and sample configs", { skip: process.platform === "win32" }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cc-heal-"));
  const home = path.join(tmp, "home");
  const root = path.join(home, ".local", "share", "modelmesh");
  const bin = path.join(tmp, "bin");
  const prefix = path.join(tmp, "prefix");
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(home, ".config", "modelmesh"), { recursive: true });
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  fs.writeFileSync(path.join(root, "bin", "claude.bin"), Buffer.from("fake"));
  fs.writeFileSync(path.join(home, ".bashrc"), "# shell\n");
  fs.mkdirSync(bin, { recursive: true });

  const settingsPath = path.join(home, ".claude", "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify({
    model: "claude-opus-5-5",
    env: { ANTHROPIC_MODEL: "claude-opus-5-5", ANTHROPIC_BASE_URL: "https://api.anthropic.com" },
  }));

  const foreign = path.join(bin, "claude");
  fs.writeFileSync(foreign, "#!/bin/sh\necho official\n", { mode: 0o755 });

  const cfgPath = path.join(home, ".config", "modelmesh", "config.json");
  fs.writeFileSync(cfgPath, JSON.stringify({
    active: "tokens",
    providers: { tokens: { type: "openai", baseUrl: "https://tokens.bd", model: "deepseek/deepseek-v4.1-flash", modelsById: { "deepseek/deepseek-v4.1-flash": { name: "DeepSeek", contextTokens: 1000000 } } }, sample: { type: "openai", baseUrl: "https://example.invalid/v1", model: "m", modelsById: {} } },
    routing: {},
  }));
  fs.writeFileSync(path.join(home, ".config", "modelmesh", "keys.json"), JSON.stringify({ tokens: "test-key" }));

  const prevPath = process.env.PATH;
  const prevCfg = process.env.MODELMESH_CONFIG;
  process.env.PATH = bin + path.delimiter + (prevPath || "");
  process.env.MODELMESH_CONFIG = cfgPath;
  try {
    const changes = healEnvironment({ root, home, prefix, searchPath: bin });
    assert.ok(changes.length >= 3, "expected settings, binary and config changes");
  } finally {
    process.env.PATH = prevPath;
    if (prevCfg === undefined) delete process.env.MODELMESH_CONFIG; else process.env.MODELMESH_CONFIG = prevCfg;
  }

  const s = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  assert.equal(s.model, "prov/tokens/deepseek/deepseek-v4.1-flash");
  assert.deepEqual(s.env, {});
  assert.ok(fs.existsSync(foreign + ".official-backup"));
  assert.match(fs.readFileSync(foreign, "utf8"), /cc-launcher\.mjs/);
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  assert.ok(cfg.providers.tokens, "configured provider must be preserved");
  assert.equal(cfg.providers.sample, undefined, "sample provider must be removed");
  assert.ok(cfg.routing["prov/tokens/deepseek/deepseek-v4.1-flash"], "routing must be rebuilt");
  const s2 = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  assert.ok(Array.isArray(s2.modelPicker.options) && s2.modelPicker.options.length >= 2, "picker must be rebuilt");
  assert.ok(fs.existsSync(path.join(prefix, "bin", "modelmesh")), "modelmesh shim installed into the isolated prefix");
  const link = path.join(home, ".local", "bin", "claude");
  assert.ok(fs.lstatSync(link).isSymbolicLink(), "native ~/.local/bin/claude symlink created");
  assert.match(fs.readFileSync(link, "utf8"), /cc-launcher\.mjs/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf8")).installMethod, "native");
  assert.match(fs.readFileSync(path.join(home, ".bashrc"), "utf8"), /# modelmesh PATH/);

  const again = healEnvironment({ root, home, prefix, searchPath: bin });
  assert.equal(again.length, 0, "heal must be idempotent");
  fs.rmSync(tmp, { recursive: true, force: true });
});
test("heal never writes prefix shims for a non-canonical install root", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cc-heal-scope-"));
  const home = path.join(tmp, "home");
  const root = path.join(tmp, "root");
  const prefix = path.join(tmp, "fake-prefix");
  fs.mkdirSync(path.join(home, ".config", "modelmesh"), { recursive: true });
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  fs.writeFileSync(path.join(home, ".config", "modelmesh", "config.json"), JSON.stringify({ active: "", providers: {} }));
  const prevPrefix = process.env.PREFIX;
  process.env.PREFIX = prefix;
  try {
    healEnvironment({ root, home, searchPath: "" });
    assert.equal(fs.existsSync(path.join(prefix, "bin")), false, "must not touch the real prefix for temp roots");
  } finally {
    if (prevPrefix === undefined) delete process.env.PREFIX; else process.env.PREFIX = prevPrefix;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
test("heal preserves the model selected in Claude settings", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cc-heal-model-"));
  const home = path.join(tmp, "home");
  const root = path.join(tmp, "root");
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(home, ".config", "modelmesh"), { recursive: true });
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  fs.writeFileSync(path.join(root, "bin", "claude.bin"), Buffer.from("fake"));
  const cfgPath = path.join(home, ".config", "modelmesh", "config.json");
  fs.writeFileSync(cfgPath, JSON.stringify({
    active: "antigravity",
    override: { provider: "antigravity", model: "gemini-3.8-flash-high" },
    providers: { antigravity: { type: "antigravity", baseUrl: "https://example.invalid", path: "/x", model: "gemini-3.8-flash-high", modelsById: {
      "gemini-3.8-flash-high": { name: "Gemini 3.8 Flash (High)" },
      "claude-sonnet-4-6": { name: "Claude Sonnet 4.6" },
    } } },
    routing: {},
  }));
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ model: "prov/antigravity/claude-sonnet-4-6" }));
  const prevCfg = process.env.MODELMESH_CONFIG;
  process.env.MODELMESH_CONFIG = cfgPath;
  try {
    healEnvironment({ root, home, prefix: path.join(tmp, "prefix"), searchPath: path.join(tmp, "empty-bin"), installPrefix: false });
  } finally {
    if (prevCfg === undefined) delete process.env.MODELMESH_CONFIG; else process.env.MODELMESH_CONFIG = prevCfg;
  }
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  assert.equal(cfg.override.model, "claude-sonnet-4-6");
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8")).model, "prov/antigravity/claude-sonnet-4-6");
  fs.rmSync(tmp, { recursive: true, force: true });
});