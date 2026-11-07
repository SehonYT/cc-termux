import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function setup(anchor) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-patch-"));
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  fs.copyFileSync(path.join(repo, "patches.json"), path.join(root, "patches.json"));
  const bin = Buffer.from("prefix |" + anchor + "| suffix");
  fs.writeFileSync(path.join(root, "bin", "claude.bin"), bin, { mode: 0o755 });
  return root;
}

function run(root, arg) {
  return spawnSync(process.execPath, [path.join(repo, "bin", "cc-patch.mjs"), arg], {
    env: { ...process.env, CC_TERMUX_ROOT: root }, encoding: "utf8",
  });
}

test("patcher applies known anchors, is idempotent and skips unknown ones", () => {
  const root = setup("Switch between Claude models");
  try {
    assert.equal(run(root, "--apply").status, 0);
    const patched = fs.readFileSync(path.join(root, "bin", "claude.bin"), "utf8");
    assert.match(patched, /Switch between AI providers/);
    assert.ok(fs.existsSync(path.join(root, "bin", "claude.bin.orig")));
    assert.match(run(root, "--apply").stdout, /nothing to do/);
    assert.equal(run(root, "--revert").status, 0);
    assert.match(fs.readFileSync(path.join(root, "bin", "claude.bin"), "utf8"), /Switch between Claude models/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("patcher leaves binaries without anchors untouched", () => {
  const root = setup("some unrelated string");
  try {
    const before = fs.readFileSync(path.join(root, "bin", "claude.bin"));
    const r = run(root, "--apply");
    assert.equal(r.status, 0);
    assert.match(r.stdout, /anchor missing/);
    assert.deepEqual(fs.readFileSync(path.join(root, "bin", "claude.bin")), before);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});