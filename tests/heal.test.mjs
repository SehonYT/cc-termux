import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { healEnvironment } from "../bin/cc-heal.mjs";

test("heal repairs settings, foreign claude binaries and sample configs", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cc-heal-"));
  const home = path.join(tmp, "home");
  const root = path.join(tmp, "root");
  const bin = path.join(tmp, "bin");
  const prefix = path.join(tmp, "prefix");
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(home, ".config", "cc-termux"), { recursive: true });
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });

  const settingsPath = path.join(home, ".claude", "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify({
    model: "claude-opus-5-5",
    env: { ANTHROPIC_MODEL: "claude-opus-5-5", ANTHROPIC_BASE_URL: "https://api.anthropic.com" },
  }));

  const foreign = path.join(bin, "claude");
  fs.writeFileSync(foreign, "#!/bin/sh\necho official\n", { mode: 0o755 });

  const cfgPath = path.join(home, ".config", "cc-termux", "config.json");
  fs.writeFileSync(cfgPath, JSON.stringify({
    active: "tokens",
    providers: { tokens: { type: "openai", baseUrl: "https://tokens.bd", model: "deepseek/deepseek-v4.1-flash", modelsById: { "deepseek/deepseek-v4.1-flash": { name: "DeepSeek", contextTokens: 1000000 } } } },
    routing: {},
  }));
  fs.writeFileSync(path.join(home, ".config", "cc-termux", "keys.json"), JSON.stringify({ tokens: "test-key" }));

  const prevPath = process.env.PATH;
  const prevCfg = process.env.CC_TERMUX_CONFIG;
  process.env.PATH = bin + path.delimiter + (prevPath || "");
  process.env.CC_TERMUX_CONFIG = cfgPath;
  try {
    const changes = healEnvironment({ root, home, prefix });
    assert.ok(changes.length >= 3, "expected settings, binary and config changes");
  } finally {
    process.env.PATH = prevPath;
    if (prevCfg === undefined) delete process.env.CC_TERMUX_CONFIG; else process.env.CC_TERMUX_CONFIG = prevCfg;
  }

  const s = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  assert.equal(s.model, "prov/tokens/deepseek/deepseek-v4.1-flash");
  assert.deepEqual(s.env, {});
  assert.ok(fs.existsSync(foreign + ".official-backup"));
  assert.match(fs.readFileSync(foreign, "utf8"), /cc-launcher\.mjs/);
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  assert.ok(cfg.providers.tokens, "configured provider must be preserved");
  assert.ok(cfg.routing["prov/tokens/deepseek/deepseek-v4.1-flash"], "routing must be rebuilt");
  const s2 = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  assert.ok(Array.isArray(s2.modelPicker.options) && s2.modelPicker.options.length >= 2, "picker must be rebuilt");
  assert.ok(fs.existsSync(path.join(prefix, "bin", "cc-termux")), "shim installed into the isolated prefix");

  const again = healEnvironment({ root, home, prefix });
  assert.equal(again.length, 0, "heal must be idempotent");
  fs.rmSync(tmp, { recursive: true, force: true });
});
test("heal never writes prefix shims for a non-canonical install root", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cc-heal-scope-"));
  const home = path.join(tmp, "home");
  const root = path.join(tmp, "root");
  const prefix = path.join(tmp, "fake-prefix");
  fs.mkdirSync(path.join(home, ".config", "cc-termux"), { recursive: true });
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  fs.writeFileSync(path.join(home, ".config", "cc-termux", "config.json"), JSON.stringify({ active: "", providers: {} }));
  const prevPrefix = process.env.PREFIX;
  process.env.PREFIX = prefix;
  try {
    healEnvironment({ root, home });
    assert.equal(fs.existsSync(path.join(prefix, "bin")), false, "must not touch the real prefix for temp roots");
  } finally {
    if (prevPrefix === undefined) delete process.env.PREFIX; else process.env.PREFIX = prevPrefix;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});