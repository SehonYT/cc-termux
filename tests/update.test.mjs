import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isNewer, semverNewer, check, localInfo, findInstaller, selfUpdate, claudeCodeUpToDate, cmpVersions } from "../bin/cc-update.mjs";
import zlib from "node:zlib";

function tmpRoot(version, sha) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-upd-"));
  fs.writeFileSync(path.join(root, "modelmesh.json"), JSON.stringify({ version, sha }));
  return root;
}

function fakeFetch(remoteSha, remoteVersion) {
  return async (url) => ({
    ok: true,
    headers: { get: () => null },
    text: async () => "<entry><id>tag:github.com,2008:Grit::Commit/" + remoteSha + "</id><updated>2026-01-02T00:00:00Z</updated></entry>",
    json: async () => ({ version: remoteVersion }),
  });
}

test("version, sha and commit-date comparison", () => {
  assert.equal(semverNewer("0.2.0", "0.1.9"), true);
  assert.equal(semverNewer("0.1.0", "0.1.0"), false);
  assert.equal(isNewer({ sha: "aaa", updatedAt: "2026-01-01T00:00:00Z" }, { sha: "bbb", updatedAt: "2026-01-02T00:00:00Z" }), true);
  assert.equal(isNewer({ sha: "bbb", updatedAt: "2026-01-02T00:00:00Z" }, { sha: "aaa", updatedAt: "2026-01-01T00:00:00Z" }), false, "older remote must not look newer");
  assert.equal(isNewer({ sha: "aaa" }, { sha: "bbb" }), true, "legacy fallback");
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
    const nested = path.join(tmp, "modelmesh-main");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, "install.mjs"), "// installer");
    assert.equal(findInstaller(tmp), path.join(nested, "install.mjs"));
    assert.equal(findInstaller(path.join(tmp, "empty")), null);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
test("selfUpdate runs an installer inside a GitHub-style archive", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cc-upd-run-"));
  const tar = await import("node:child_process");
  const stage = path.join(tmp, "stage", "modelmesh-main");
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
  const r = tar.spawnSync("tar", ["-czf", tgz, "-C", path.join(tmp, "stage"), "modelmesh-main"]);
  if (r.status !== 0) { fs.rmSync(tmp, { recursive: true, force: true }); return; }
  try {
    await selfUpdate({ root, archivePath: tgz });
    assert.equal(fs.readFileSync(path.join(root, "marker"), "utf8"), "installed");
    const stamp = JSON.parse(fs.readFileSync(path.join(root, "modelmesh.json"), "utf8"));
    assert.ok(String(stamp.version).startsWith("9.9.9"), "expected build version, got " + stamp.version);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
test("claudeCodeUpToDate compares the installed version with the registry", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-upd-claude-"));
  const registry = (version) => async () => ({ ok: true, json: async () => ({ version }) });
  try {
    fs.mkdirSync(path.join(root, "bin"), { recursive: true });
    fs.mkdirSync(path.join(root, "lib"), { recursive: true });
    if (process.platform === "android") fs.writeFileSync(path.join(root, "lib", "ld-musl-aarch64.so.1"), "loader");
    fs.writeFileSync(path.join(root, "VERSION"), "2.1.319\n");
    fs.writeFileSync(path.join(root, "bin", process.platform === "win32" ? "claude.exe" : "claude.bin"), Buffer.alloc(64));
    const same = await claudeCodeUpToDate({ root, fetchImpl: registry("2.1.319"), minBinaryBytes: 1 });
    assert.equal(same.upToDate, true);
    const newer = await claudeCodeUpToDate({ root, fetchImpl: registry("2.1.320"), minBinaryBytes: 1 });
    assert.equal(newer.upToDate, false);
    fs.unlinkSync(path.join(root, "bin", process.platform === "win32" ? "claude.exe" : "claude.bin"));
    const missing = await claudeCodeUpToDate({ root, fetchImpl: registry("2.1.319"), minBinaryBytes: 1 });
    assert.equal(missing.upToDate, false);
    fs.writeFileSync(path.join(root, "bin", process.platform === "win32" ? "claude.exe" : "claude.bin"), Buffer.alloc(64));
    const offline = async () => { throw new Error("offline"); };
    const keep = await claudeCodeUpToDate({ root, fetchImpl: offline, minBinaryBytes: 1 });
    assert.equal(keep.upToDate, true);
    assert.match(keep.reason, /registry unreachable/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test("selfUpdate pins the download to the resolved commit and stamps it", async () => {
  const os = await import("node:os");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cc-upd-pin-"));
  const stage = path.join(tmp, "stage", "modelmesh-main");
  fs.mkdirSync(stage, { recursive: true });
  fs.writeFileSync(path.join(stage, "package.json"), JSON.stringify({ version: "9.9.9" }));
  fs.writeFileSync(path.join(stage, "install.mjs"), [
    "import fs from \"node:fs\";",
    "const i = process.argv.indexOf(\"--root\");",
    "const root = i > 0 ? process.argv[i + 1] : \".\";",
    "fs.mkdirSync(root, { recursive: true });",
    "fs.writeFileSync(root + \"/marker\", process.env.MODELMESH_COMMIT_SHA || \"none\");",
  ].join("\n"));
  const tgzPath = path.join(tmp, "src.tgz");
  const tar = await import("node:child_process");
  const packed = tar.spawnSync("tar", ["-czf", tgzPath, "-C", path.join(tmp, "stage"), "modelmesh-main"]);
  if (packed.status !== 0) { fs.rmSync(tmp, { recursive: true, force: true }); return; }
  const buf = fs.readFileSync(tgzPath);
  const sha = "c".repeat(40);
  const fetchImpl = async (url) => {
    if (url.includes("commits/main.atom")) return { ok: true, text: async () => "<entry><id>Grit::Commit/" + sha + "</id><updated>2026-01-02T00:00:00Z</updated></entry>", json: async () => ({}) };
    if (url.includes("package.json")) return { ok: true, json: async () => ({ version: "9.9.9" }) };
    if (url.includes("/tar.gz/" + sha)) return { ok: true, headers: { get: () => String(buf.length) }, body: (async function* () { yield buf; })() };
    throw new Error("unexpected url " + url);
  };
  const root = path.join(tmp, "root");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "update-check.json"), "{}");
  try {
    await selfUpdate({ root, fetchImpl });
    assert.equal(fs.readFileSync(path.join(root, "marker"), "utf8"), sha, "installer got the pinned sha");
    const stamp = JSON.parse(fs.readFileSync(path.join(root, "modelmesh.json"), "utf8"));
    assert.equal(stamp.sha, sha);
    assert.equal(stamp.version, "9.9.9+" + sha.slice(0, 7));
    assert.equal(stamp.updatedAt, "2026-01-02T00:00:00Z");
    assert.equal(fs.existsSync(path.join(root, "update-check.json")), false, "stale update cache cleared");
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
test("selfUpdate refuses an older remote feed instead of downgrading", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cc-upd-stale-"));
  const root = path.join(tmp, "root");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "modelmesh.json"), JSON.stringify({ version: "9.9.9+newer", sha: "d".repeat(40), updatedAt: "2026-02-01T00:00:00Z" }));
  const staleSha = "e".repeat(40);
  const fetchImpl = async (url) => {
    if (url.includes("commits/main.atom")) return { ok: true, text: async () => "<entry><id>Grit::Commit/" + staleSha + "</id><updated>2026-01-01T00:00:00Z</updated></entry>", json: async () => ({}) };
    if (url.includes("package.json")) return { ok: true, json: async () => ({ version: "9.9.9" }) };
    throw new Error("should not download: " + url);
  };
  try {
    const ok = await selfUpdate({ root, fetchImpl });
    assert.equal(ok, false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, "modelmesh.json"), "utf8")).sha, "d".repeat(40));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
test("check ignores caches without a commit date (legacy false positives)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-upd-cache-"));
  try {
    fs.writeFileSync(path.join(root, "modelmesh.json"), JSON.stringify({ version: "0.2.0+x", sha: "f".repeat(40), updatedAt: "2026-02-01T00:00:00Z" }));
    fs.writeFileSync(path.join(root, "update-check.json"), JSON.stringify({ at: new Date().toISOString(), remote: { sha: "e".repeat(40), version: "0.1.0" } }));
    const fresh = "a".repeat(40);
    const fetchImpl = async (url) => {
      if (url.includes("commits/main.atom")) return { ok: true, text: async () => "<entry><id>Grit::Commit/" + fresh + "</id><updated>2026-03-01T00:00:00Z</updated></entry>" };
      if (url.includes("package.json")) return { ok: true, json: async () => ({ version: "0.2.0" }) };
      throw new Error("unexpected " + url);
    };
    const r = await check({ root, fetchImpl, cacheTtlMs: 3600 * 1000 });
    assert.equal(r.cached, false);
    assert.equal(r.remote.sha, fresh);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test("cmpVersions orders builds and ignores metadata", () => {
  assert.equal(cmpVersions("2.1.320", "2.1.319"), 1);
  assert.equal(cmpVersions("2.1.319", "2.1.319"), 0);
  assert.equal(cmpVersions("2.1.319", "2.1.320"), -1);
  assert.equal(cmpVersions("0.2.0+abc", "0.2.0+def"), 0);
});

test("missing local provenance is treated as updateable", () => {
  assert.equal(isNewer({ version: "0.2.0", sha: null }, { sha: "a".repeat(40), version: "0.2.0", updatedAt: "2026-01-01T00:00:00Z" }), true);
  assert.equal(isNewer({ version: "0.2.0", sha: null }, { version: "0.2.0" }), false);
});

test("offline update checks throw instead of claiming up to date", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-upd-off-"));
  try {
    const offline = async () => { throw new Error("offline"); };
    await assert.rejects(() => check({ root, fetchImpl: offline, cacheTtlMs: 0 }), /could not reach GitHub/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});