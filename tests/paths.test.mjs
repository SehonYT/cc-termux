import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

const p = await import("../bin/cc-paths.mjs");

test("environment overrides always win", () => {
  assert.equal(p.installRoot({ CC_TERMUX_ROOT: "/custom/root" }), "/custom/root");
  assert.equal(p.configFile({ CC_TERMUX_CONFIG: "/custom/config.json" }), "/custom/config.json");
  assert.equal(p.configDir({ CC_TERMUX_CONFIG: "/custom/config.json" }), "/custom");
  assert.equal(p.cacheDir({ CC_TERMUX_CACHE: "/custom/cache" }), "/custom/cache");
  assert.equal(p.claudeDir({ CLAUDE_CONFIG_DIR: "/custom/claude" }), "/custom/claude");
});

test("paths live under the home directory (POSIX layout)", { skip: process.platform === "win32" }, () => {
  const home = os.homedir();
  assert.equal(p.installRoot({}), path.join(home, ".local", "share", "cc-termux"));
  assert.equal(p.configFile({}), path.join(home, ".config", "cc-termux", "config.json"));
  assert.equal(p.cacheDir({}), path.join(home, ".cache", "cc-termux"));
  assert.equal(p.claudeDir({}), path.join(home, ".claude"));
});

test("windows uses LOCALAPPDATA/APPDATA instead of dot-directories", { skip: process.platform !== "win32" }, () => {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const roaming = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  assert.equal(p.installRoot({}), path.join(local, "cc-termux"));
  assert.equal(p.configFile({}), path.join(roaming, "cc-termux", "config.json"));
  assert.equal(p.cacheDir({}), path.join(local, "cc-termux", "cache"));
  // Claude Code itself is unchanged by platform.
  assert.equal(p.claudeDir({}), path.join(os.homedir(), ".claude"));
  assert.equal(p.isWindows, true);
});

test("claude's own directory is never relocated by cc-termux paths", () => {
  const expected = path.join(os.homedir(), ".claude");
  assert.equal(p.claudeDir({}), expected);
  assert.ok(!p.claudeDir({}).includes("cc-termux"));
});
