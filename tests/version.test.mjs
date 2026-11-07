import test from "node:test";
import assert from "node:assert/strict";
import { buildVersion, buildTag, labelVersion } from "../scripts/version.mjs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("build version and tag derive from commit", () => {
  assert.equal(buildVersion("0.2.0", "abcdef1234567"), "0.2.0+abcdef1");
  assert.equal(buildTag("0.2.0", "abcdef1234567"), "v0.2.0-abcdef1");
  assert.equal(buildVersion("0.2.0", ""), "0.2.0");
});

test("labelVersion keeps base and appends the short sha", () => {
  assert.equal(labelVersion("0.2.0", "abcdef1234567"), "0.2.0+abcdef1");
  assert.equal(labelVersion("0.2.0+oldsha1", "abcdef1234567"), "0.2.0+abcdef1");
  assert.equal(labelVersion("0.2.0", null), "0.2.0");
});
test("--sha beats GITHUB_SHA when tagging", () => {
  const r = spawnSync(process.execPath, [path.join(repo, "scripts", "version.mjs"), "--tag", "--sha", "a".repeat(40)], {
    encoding: "utf8", env: { ...process.env, GITHUB_SHA: "b".repeat(40) },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim().endsWith("-aaaaaaa"), true, r.stdout);
});