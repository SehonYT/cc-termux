import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isNewer, semverNewer, check, localInfo, findInstaller, selfUpdate, claudeCodeUpToDate } from "../bin/cc-update.mjs";
import zlib from "node:zlib";

function tmpRoot(version, sha) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-upd-"));
  fs.writeFileSync(path.join(root, "cc-termux.json"), JSON.stringify({ version, sha }));
  return root;
}

function fakeFetch(remoteSha, remoteVersion) {
  return async (url) => ({
    ok: true,
    headers: { get: () => null },
    text: async () => "<id>tag:github.com,2008:Grit::Commit/" + remoteSha + "</id>",
    json: async () => ({ version: remoteVersion }),
  });
}

test("version and sha comparison", () => {
  assert.equal(semverNewer("0.2.0", "0.1.9"), true);
  assert.equal(semverNewer("0.1.0", "0.1.0"), false);
  assert.equal(isNewer({ sha: "aaa" }, { sha: "bbb" }), true);
  assert.equal(isNewer({ sha: "aaa" }, { sha: "aaa" }), false);
});

test("check detects a newer commit and caches the result", async () => {
  const oldSha = "a".repeat(40), newSha = "b".repeat(40);
  const root = tmpRoot("0.1.0", oldSha);
  try {
    const first = await check({ root, fetchImpl: fakeFetch(newSha, "0.1.0"), cacheTtlMs: 0 });
    assert.equal(first.available, true);
    assert.equal(first.local.sha, oldSha);
    assert.equal(first.remote.sha, newSha);
    assert.ok(fs.existsSync(path.join(root, "update-check.json")));
    const throwing = async () => { throw new Error("network down"); };
    const cached = await check({ root, fetchImpl: throwing });
    assert.equal(cached.cached, true);
    assert.equal(cached.available, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("localInfo falls back safely when the stamp is missing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-upd-"));
  try { assert.deepEqual(localInfo(root), { version: "0.0.0", sha: null }); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test("findInstaller handles GitHub-style archives with a top-level folder", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cc-upd-arc-"));
  try {
    const nested = path.join(tmp, "cc-termux-main");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, "install.mjs"), "// installer");
    assert.equal(findInstaller(tmp), path.join(nested, "install.mjs"));
    assert.equal(findInstaller(path.join(tmp, "empty")), null);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
test("selfUpdate runs an installer inside a GitHub-style archive", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cc-upd-run-"));
  const tar = await import("node:child_process");
  const stage = path.join(tmp, "stage", "cc-termux-main");
  fs.mkdirSync(stage, { recursive: true });
  const root = path.join(tmp, "root");
  fs.writeFileSync(path.join(stage, "package.json"), JSON.stringify({ version: "9.9.9" }));
  fs.writeFileSync(path.join(stage, "install.mjs"), [
    "import fs from \"node:fs\";",
    "const i = process.argv.indexOf(\"--root\");",
    "const root = i > 0 ? process.argv[i + 1] : \".\";",
    "fs.mkdirSync(root, { recursive: true });",
    "fs.writeFileSync(root + \"/marker\", \"installed\");",
  ].join("\n"));
  const tgz = path.join(tmp, "src.tgz");
  const r = tar.spawnSync("tar", ["-czf", tgz, "-C", path.join(tmp, "stage"), "cc-termux-main"]);
  if (r.status !== 0) { fs.rmSync(tmp, { recursive: true, force: true }); return; }
  try {
    await selfUpdate({ root, archivePath: tgz });
    assert.equal(fs.readFileSync(path.join(root, "marker"), "utf8"), "installed");
    const stamp = JSON.parse(fs.readFileSync(path.join(root, "cc-termux.json"), "utf8"));
    assert.ok(String(stamp.version).startsWith("9.9.9"), "expected build version, got " + stamp.version);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
test("claudeCodeUpToDate compares the installed version with the registry", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-upd-claude-"));
  const registry = (version) => async () => ({ ok: true, json: async () => ({ version }) });
  try {
    fs.mkdirSync(path.join(root, "bin"), { recursive: true });
    fs.writeFileSync(path.join(root, "VERSION"), "2.1.319\n");
    fs.writeFileSync(path.join(root, "bin", "claude.bin"), Buffer.alloc(64));
    const same = await claudeCodeUpToDate({ root, fetchImpl: registry("2.1.319"), minBinaryBytes: 1 });
    assert.equal(same.upToDate, true);
    const newer = await claudeCodeUpToDate({ root, fetchImpl: registry("2.1.320"), minBinaryBytes: 1 });
    assert.equal(newer.upToDate, false);
    fs.unlinkSync(path.join(root, "bin", "claude.bin"));
    const missing = await claudeCodeUpToDate({ root, fetchImpl: registry("2.1.319"), minBinaryBytes: 1 });
    assert.equal(missing.upToDate, false);
    fs.writeFileSync(path.join(root, "bin", "claude.bin"), Buffer.alloc(64));
    const offline = async () => { throw new Error("offline"); };
    const keep = await claudeCodeUpToDate({ root, fetchImpl: offline, minBinaryBytes: 1 });
    assert.equal(keep.upToDate, true);
    assert.match(keep.reason, /registry unreachable/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});