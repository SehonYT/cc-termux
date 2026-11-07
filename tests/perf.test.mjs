import test from "node:test";
import assert from "node:assert/strict";
import { isMobileLike, resolvePerf, applyPerfEnv, PERF_ENV } from "../bin/cc-perf.mjs";

test("mobile detection covers Android and Termux", () => {
  assert.equal(isMobileLike({ platform: "android", env: {} }), true);
  assert.equal(isMobileLike({ platform: "linux", prefix: "/data/data/com.termux/files/usr", env: {} }), true);
  assert.equal(isMobileLike({ platform: "linux", prefix: "/usr", env: {} }), false);
  assert.equal(isMobileLike({ platform: "win32", env: {} }), false);
  assert.equal(isMobileLike({ platform: "darwin", env: {} }), false);
});

test("auto mode enables on mobile and stays off on desktop", () => {
  assert.equal(resolvePerf({ mode: "auto", platform: "android", env: {} }).enabled, true);
  assert.equal(resolvePerf({ mode: "auto", platform: "darwin", prefix: "/usr/local", env: {} }).enabled, false);
});

test("manual override works in both directions", () => {
  assert.equal(resolvePerf({ mode: "mobile", platform: "win32", env: {} }).enabled, true);
  assert.equal(resolvePerf({ mode: "off", platform: "android", env: {} }).enabled, false);
  assert.equal(resolvePerf({ mode: "auto", platform: "android", env: { CC_TERMUX_PERF: "0" } }).enabled, false);
  assert.equal(resolvePerf({ mode: "auto", platform: "linux", env: { CC_TERMUX_PERF: "1" } }).enabled, true);
});

test("perf env disables heavy UI/IO features only when enabled", () => {
  const off = applyPerfEnv({ A: "1" }, { enabled: false });
  assert.deepEqual(off, { A: "1" });
  const on = applyPerfEnv({ A: "1" }, { enabled: true });
  assert.equal(on.A, "1");
  for (const key of Object.keys(PERF_ENV)) assert.equal(on[key], "1", key + " missing");
  assert.equal(on.CLAUDE_CODE_DISABLE_MOUSE, "1");
  assert.equal(on.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING, "1");
});