import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isNewer, semverNewer, check, localInfo } from "../bin/cc-update.mjs";

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