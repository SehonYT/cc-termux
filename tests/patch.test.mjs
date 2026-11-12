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
  fs.writeFileSync(path.join(root, "bin", process.platform === "win32" ? "claude.exe" : "claude.bin"), bin, { mode: 0o755 });
  return root;
}

function run(root, arg) {
  return spawnSync(process.execPath, [path.join(repo, "bin", "cc-patch.mjs"), arg], {
    env: { ...process.env, MODELMESH_ROOT: root }, encoding: "utf8",
  });
}

test("patcher applies known anchors, is idempotent and skips unknown ones", () => {
  const root = setup("Switch between Claude models");
  try {
    assert.equal(run(root, "--apply").status, 0);
    const patched = fs.readFileSync(path.join(root, "bin", process.platform === "win32" ? "claude.exe" : "claude.bin"), "utf8");
    assert.match(patched, /Switch between AI providers/);
    assert.ok(fs.existsSync(path.join(root, "bin", (process.platform === "win32" ? "claude.exe" : "claude.bin") + ".orig")));
    assert.match(run(root, "--apply").stdout, /nothing to do/);
    assert.equal(run(root, "--revert").status, 0);
    assert.match(fs.readFileSync(path.join(root, "bin", process.platform === "win32" ? "claude.exe" : "claude.bin"), "utf8"), /Switch between Claude models/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("patcher leaves binaries without anchors untouched", () => {
  const root = setup("some unrelated string");
  try {
    const before = fs.readFileSync(path.join(root, "bin", process.platform === "win32" ? "claude.exe" : "claude.bin"));
    const r = run(root, "--apply");
    assert.equal(r.status, 0);
    assert.match(r.stdout, /anchor missing/);
    assert.deepEqual(fs.readFileSync(path.join(root, "bin", process.platform === "win32" ? "claude.exe" : "claude.bin")), before);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test("stale backups are refreshed for a different binary and never reverted onto it", () => {
  const root = setup("Switch between Claude models");
  const bin = path.join(root, "bin", process.platform === "win32" ? "claude.exe" : "claude.bin");
  try {
    assert.equal(run(root, "--apply").status, 0);
    const newer = Buffer.from("brand new binary without any anchors but different length");
    fs.writeFileSync(bin, newer);
    assert.equal(run(root, "--apply").status, 0);
    assert.deepEqual(fs.readFileSync(bin + ".orig"), newer, "backup refreshed to the new binary");
    assert.equal(run(root, "--revert").status, 0);
    assert.deepEqual(fs.readFileSync(bin), newer);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("patcher refreshes a stale backup from an already-patched binary", () => {
  const root = setup("Switch between Claude models");
  const bin = path.join(root, "bin", process.platform === "win32" ? "claude.exe" : "claude.bin");
  try {
    assert.equal(run(root, "--apply").status, 0);
    fs.writeFileSync(bin + ".orig", Buffer.from("tiny stale backup"));
    fs.rmSync(bin + ".orig.json", { force: true });
    const r = run(root, "--apply");
    assert.equal(r.status, 0);
    assert.match(r.stderr, /refreshing it from the installed/);
    const meta = JSON.parse(fs.readFileSync(bin + ".orig.json", "utf8"));
    assert.equal(meta.patched, true);
    assert.equal(run(root, "--revert").status, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test("a successful apply leaves a stamp the launcher can check, revert removes it", () => {
  const root = setup("Switch between Claude models");
  const bin = path.join(root, "bin", process.platform === "win32" ? "claude.exe" : "claude.bin");
  try {
    assert.equal(run(root, "--apply").status, 0);
    const stamp = bin + ".patched";
    assert.ok(fs.existsSync(stamp), "apply must write the patch stamp");
    const meta = JSON.parse(fs.readFileSync(stamp, "utf8"));
    assert.ok(Array.isArray(meta.applied) && meta.applied.length > 0);
    assert.ok(Date.parse(meta.at));
    assert.equal(run(root, "--revert").status, 0);
    assert.equal(fs.existsSync(stamp), false, "revert must remove the patch stamp");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
