import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const patchSrc = fs.readFileSync(path.join(root, "bin", "cc-patch.mjs"), "utf8");

const patch = await import("../bin/cc-patch.mjs");

// A minimal ELF64 with one PT_INTERP header, the shape the reader expects.
function fakeElf(interp, { programType = 3 } = {}) {
  const buf = Buffer.alloc(512, 0);
  buf[0] = 0x7f; buf[1] = 0x45; buf[2] = 0x4c; buf[3] = 0x46;
  buf[4] = 2;
  buf[5] = 1;
  buf.writeBigUInt64LE(BigInt(64), 0x20);
  buf.writeUInt16LE(56, 0x36);
  buf.writeUInt16LE(1, 0x38);
  buf.writeUInt32LE(programType, 64);
  const strOff = 400;
  buf.writeBigUInt64LE(BigInt(strOff), 64 + 8);
  buf.writeBigUInt64LE(BigInt(interp.length + 1), 64 + 32);
  buf.write(interp, strOff);
  return buf;
}

test("the ELF interpreter is read from the program header", () => {
  const want = "/data/data/com.termux/files/home/.local/share/modelmesh/lib/ld-musl-aarch64.so.1";
  assert.equal(patch.elfInterpreter(fakeElf(want)), want);
});

test("a file that is not an ELF, or has no interpreter, is left alone", () => {
  // A lookalike must never be treated as a binary to rewrite.
  assert.equal(patch.elfInterpreter(Buffer.from("not an elf at all, but long enough")), null);
  assert.equal(patch.elfInterpreter(Buffer.alloc(10)), null, "too short to be an ELF");
  assert.equal(patch.elfInterpreter(fakeElf("/x", { programType: 1 })), null, "no PT_INTERP present");
  assert.equal(patch.elfInterpreter(Buffer.alloc(0)), null);
});

test("a moved install root is detected as a stale interpreter", () => {
  // The rename left the binary asking for a loader under the old directory name, so the
  // kernel answered ENOENT for a file that plainly existed. That is the reported bug.
  const src = patchSrc;
  assert.match(src, /export function staleInterpreter/, "there is a detector");
  const fn = /export function staleInterpreter\(\) \{[\s\S]*?\n\}/.exec(src)[0];
  assert.match(fn, /fs\.existsSync\(interp\)/, "it checks the baked path exists");
  assert.match(fn, /path\.join\(ROOT, "lib", path\.basename\(interp\)\)/, "and looks for the loader beside the install");
  assert.match(fn, /want : null|return fs\.existsSync\(want\)/, "only reports a fix when the replacement exists");
});

test("the interpreter is repointed with patchelf and the marker is restored", () => {
  const src = patchSrc;
  const fn = /export function fixInterpreter\(\) \{[\s\S]*?\n\}/.exec(src)[0];
  assert.match(fn, /\["--set-interpreter", stale\.want, BIN\]/, "it sets the interpreter to the current path");
  assert.match(fn, /pkg", \["install", "-y", "patchelf"\]/, "it can obtain patchelf");
  assert.match(fn, /\.direct-exec/, "and restores the direct-exec marker so the launcher uses it");
  assert.match(fn, /fixed: false, reason:/, "a failure is reported rather than assumed fixed");
  // It must run as part of apply, which is what the launcher invokes.
  const applyFn = /function apply\(\) \{[\s\S]*?\n\}/.exec(src)[0];
  assert.match(applyFn, /fixInterpreter\(\)/, "apply repairs the interpreter before patching content");
});
