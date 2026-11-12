import test from "node:test";
import assert from "node:assert/strict";
import { bar, formatBytes, progressLine, createProgress, banner } from "../bin/cc-ui.mjs";

function fakeStream(tty) {
  const chunks = [];
  return { isTTY: tty, write: (s) => chunks.push(s), text: () => chunks.join("") };
}

test("bar and byte formatting", () => {
  assert.equal(bar(0, 100, 10), "----------");
  assert.equal(bar(50, 100, 10), "#####-----");
  assert.equal(bar(100, 100, 10), "##########");
  assert.equal(formatBytes(1536), "1.5 kB");
  assert.equal(formatBytes(151 * 1024 * 1024), "158.3 MB");
});

test("progress line includes percent, sizes and speed", () => {
  const line = progressLine("Claude Code", 50e6, 100e6, 5000);
  assert.match(line, /50%/);
  assert.match(line, /100\.0 MB/);
  assert.match(line, /MB\/s/);
  assert.match(line, /\[/);
});

test("non-TTY progress prints milestones and a final ok line", () => {
  const s = fakeStream(false);
  const p = createProgress("download", { stream: s, tty: false });
  p.update(30, 100);
  p.update(60, 100);
  p.done({ ok: true, message: "done" });
  assert.match(s.text(), /download: 30%/);
  assert.match(s.text(), /\[ok\] download - done/);
});

test("banner works without ANSI codes in plain mode", () => {
  const s = fakeStream(false);
  banner(["modelmesh installer", "downloaded from Anthropic"], { stream: s, tty: false });
  assert.equal(s.text(), "modelmesh installer\ndownloaded from Anthropic\n");
});
test("TTY banner lines align", () => {
  const s = fakeStream(true);
  banner(["short", "a much longer banner line"], { stream: s, tty: true });
  const lines = s.text().split("\n").filter(Boolean);
  assert.equal(new Set(lines.map((l) => l.length)).size, 1, "all banner lines same width");
});

test("TTY progress with unknown total renders a spinner", () => {
  const s = fakeStream(true);
  const p = createProgress("archive", { stream: s, tty: true });
  p.update(1024, 0);
  p.update(2048, 0);
  p.done({ ok: true });
  assert.match(s.text(), /\[[|/\\-]\]/);
  assert.match(s.text(), /archive/);
});