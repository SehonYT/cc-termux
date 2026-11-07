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
    providers: { tokens: { type: "openai", baseUrl: "https://tokens.bd", model: "deepseek/deepseek-v4.1-flash", modelsById: {} } },
  }));

  const prevPath = process.env.PATH;
  const prevCfg = process.env.CC_TERMUX_CONFIG;
  process.env.PATH = bin + path.delimiter + (prevPath || "");
  process.env.CC_TERMUX_CONFIG = cfgPath;
  try {
    const changes = healEnvironment({ root, home });
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
  assert.deepEqual(cfg.providers, {});
  fs.rmSync(tmp, { recursive: true, force: true });
});