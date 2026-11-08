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
