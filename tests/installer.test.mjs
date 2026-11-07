import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("installer --check prints a plan without touching the system", () => {
  const r = spawnSync(process.execPath, [path.join(root, "install.mjs"), "--check"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /install plan/);
  assert.match(r.stdout, /platform\s*:/);
  assert.match(r.stdout, /mode\s*:/);
});