import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("status is friendly before any provider is configured", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cc-status-"));
  try {
    const r = spawnSync(process.execPath, [path.join(repo, "bin", "cc-termux"), "status"], {
      encoding: "utf8",
      timeout: 15000,
      env: { ...process.env, HOME: home, CC_TERMUX_ROOT: repo, CC_TERMUX_CONFIG: path.join(home, "config.json") },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /ENOENT|Cannot read/);
    assert.match(r.stdout, /no providers yet/);
    assert.match(r.stdout, /cc-termux setup/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
