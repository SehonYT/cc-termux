import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("setup --help works even when stdin looks like a terminal", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cc-setup-"));
  try {
    const r = spawnSync(process.execPath, [path.join(repo, "bin", "cc-setup.mjs"), "--help"], {
      encoding: "utf8", env: { ...process.env, HOME: home, CC_SETUP_NONINTERACTIVE: "1" },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /usage: modelmesh setup/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});