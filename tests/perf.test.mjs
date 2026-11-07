import test from "node:test";
import assert from "node:assert/strict";
import { resolvePerf, applyPerfEnv, PERF_ENV, shouldAskPerf, perfDefaultAnswer, PERF_PROMPT_LINES } from "../bin/cc-perf.mjs";

test("nothing is enabled unless the user chose it", () => {
  for (const platform of ["android", "linux", "darwin", "win32"]) {
    assert.equal(resolvePerf({ mode: "auto", platform, env: {} }).enabled, false, platform);
    assert.equal(resolvePerf({ mode: "off", platform, env: {} }).enabled, false, platform);
  }
});

test("manual choice works on every OS", () => {
  assert.equal(resolvePerf({ mode: "on", platform: "win32", env: {} }).enabled, true);
  assert.equal(resolvePerf({ mode: "on", platform: "darwin", env: {} }).enabled, true);
  assert.equal(resolvePerf({ mode: "mobile", platform: "android", env: {} }).enabled, true, "legacy mobile still on");
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
test("the prompt is shown once, on any device, and defaults to no", () => {
  assert.equal(shouldAskPerf(""), true);
  assert.equal(shouldAskPerf(undefined), true);
  assert.equal(shouldAskPerf("auto"), true, "legacy auto means no explicit choice");
  assert.equal(shouldAskPerf("off"), false);
  assert.equal(shouldAskPerf("on"), false);
  assert.equal(shouldAskPerf("mobile"), false);
  assert.equal(perfDefaultAnswer({}), "no");
  assert.equal(perfDefaultAnswer({ mode: "local" }), "no");
  assert.equal(perfDefaultAnswer({ mode: "off" }), "no");
  assert.equal(perfDefaultAnswer({ mode: "on" }), "yes");
  assert.equal(perfDefaultAnswer({ mode: "mobile" }), "yes");
});

test("prompt wording explains every disabled feature in plain words", () => {
  const text = PERF_PROMPT_LINES.join(" ").toLowerCase();
  for (const word of ["mouse", "window title", "checkpoints", "background", "scheduled", "git", "animations"]) {
    assert.match(text, new RegExp(word), "missing explanation for " + word);
  }
});