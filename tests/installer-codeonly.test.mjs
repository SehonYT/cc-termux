import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("installer --code-only updates assets but keeps the Claude Code binary", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cc-codeonly-"));
  const home = path.join(tmp, "home");
  const root = path.join(home, ".local", "share", "cc-termux");
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  fs.mkdirSync(path.join(home, ".config", "cc-termux"), { recursive: true });
  const binPath = path.join(root, "bin", process.platform === "win32" ? "claude.exe" : "claude.bin");
  const original = Buffer.from("fake-claude-binary-" + Date.now());
  fs.writeFileSync(binPath, original);
  fs.writeFileSync(path.join(root, "VERSION"), "9.9.9\n");
  try {
    const r = spawnSync(process.execPath, [path.join(repo, "install.mjs"), "--code-only", "--root", root, "--no-setup"], {
      cwd: repo, encoding: "utf8",
      env: { ...process.env, HOME: home, PREFIX: path.join(tmp, "prefix"), CC_TERMUX_CONFIG: path.join(home, ".config", "cc-termux", "config.json"), CC_TERMUX_REPO: "SehonYT/cc-termux" },
    });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.deepEqual(fs.readFileSync(binPath), original, "binary must not be replaced");
    assert.equal(fs.readFileSync(path.join(root, "VERSION"), "utf8").trim(), "9.9.9");
    assert.ok(fs.existsSync(path.join(root, "bin", "cc-update.mjs")), "assets must be refreshed");
    assert.ok(fs.existsSync(path.join(root, "bin", "cc-launcher.mjs")));
    assert.ok(fs.existsSync(path.join(home, ".local", "bin", "claude")), "native claude shim");
    assert.ok(fs.existsSync(path.join(tmp, "prefix", "bin", "cc-termux")), "cc-termux shim in isolated prefix");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});