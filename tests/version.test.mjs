import test from "node:test";
import assert from "node:assert/strict";
import { buildVersion, buildTag, labelVersion } from "../scripts/version.mjs";

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